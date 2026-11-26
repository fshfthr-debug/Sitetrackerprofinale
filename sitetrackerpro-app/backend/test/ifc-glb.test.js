'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const { writeGlb, convertIfcBuffer } = require('../ifc-glb');
const createBimConvertModule = require('../bim-convert');

const WALL_IFC = path.join(__dirname, 'fixtures', 'wall.ifc');
const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

function readGlb(buffer) {
  assert.equal(buffer.readUInt32LE(0), GLB_MAGIC, 'GLB magic');
  assert.equal(buffer.readUInt32LE(4), 2, 'glTF version 2');
  assert.equal(buffer.readUInt32LE(8), buffer.length, 'declared length matches the file');

  const jsonLength = buffer.readUInt32LE(12);
  assert.equal(buffer.readUInt32LE(16), JSON_CHUNK, 'first chunk is JSON');
  const json = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8'));

  const binHeader = 20 + jsonLength;
  assert.equal(buffer.readUInt32LE(binHeader + 4), BIN_CHUNK, 'second chunk is BIN');
  const binLength = buffer.readUInt32LE(binHeader);
  const bin = buffer.subarray(binHeader + 8, binHeader + 8 + binLength);

  return { json, bin };
}

test('writeGlb builds a readable glTF 2.0 binary container', () => {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 2, 0]);
  const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const indices = new Uint32Array([0, 1, 2]);

  const glb = writeGlb([{ name: 'IfcWall', positions, normals, indices }]);
  const { json, bin } = readGlb(glb);

  assert.equal(json.asset.version, '2.0');
  assert.equal(json.meshes.length, 1);
  assert.equal(json.meshes[0].primitives.length, 1);
  assert.equal(json.materials[0].name, 'IfcWall');
  assert.equal(json.materials[0].pbrMetallicRoughness.baseColorFactor.length, 4);

  const primitive = json.meshes[0].primitives[0];
  const positionAccessor = json.accessors[primitive.attributes.POSITION];
  assert.equal(positionAccessor.count, 3);
  assert.equal(positionAccessor.type, 'VEC3');
  assert.deepEqual(positionAccessor.min, [0, 0, 0]);
  assert.deepEqual(positionAccessor.max, [1, 2, 0]);

  const indexAccessor = json.accessors[primitive.indices];
  assert.equal(indexAccessor.count, 3);
  assert.equal(indexAccessor.componentType, 5125);

  // Every buffer view must fit inside the binary chunk it points at.
  json.bufferViews.forEach((view) => {
    assert.ok(view.byteOffset + view.byteLength <= bin.length, 'buffer view fits the BIN chunk');
    assert.equal(view.byteOffset % 4, 0, 'buffer view is 4-byte aligned');
  });
  assert.equal(json.buffers[0].byteLength, bin.length);
});

test('writeGlb colours each IFC class once and skips empty primitives', () => {
  const triangle = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) };
  const glb = writeGlb([
    { name: 'IfcWall', ...triangle },
    { name: 'IfcSlab', ...triangle },
    { name: 'IfcBeam', positions: new Float32Array(), indices: new Uint32Array() }
  ]);
  const { json } = readGlb(glb);

  assert.equal(json.materials.length, 2);
  assert.deepEqual(json.materials.map((material) => material.name), ['IfcWall', 'IfcSlab']);
  assert.notDeepEqual(
    json.materials[0].pbrMetallicRoughness.baseColorFactor,
    json.materials[1].pbrMetallicRoughness.baseColorFactor
  );
  // A missing normal attribute is allowed: the reader computes normals.
  assert.equal(json.meshes[0].primitives[0].attributes.NORMAL, undefined);
});

test('writeGlb refuses a model with no triangles instead of writing an empty stage', () => {
  assert.throws(() => writeGlb([]), /no triangles/i);
  assert.throws(() => writeGlb([{ positions: new Float32Array([0, 0, 0]), indices: new Uint32Array([0]) }]), /no triangles/i);
});

test('convertIfcBuffer turns a wall IFC into a Y-up GLB', async () => {
  const ifc = await fs.promises.readFile(WALL_IFC);
  const result = await convertIfcBuffer(ifc);

  assert.equal(result.elements, 1, 'one IFC class is drawn');
  assert.ok(result.triangles >= 12, `the wall has triangles (${result.triangles})`);
  assert.ok(result.glb.length > 0);

  const { json } = readGlb(result.glb);
  assert.equal(json.materials[0].name, 'IfcWall');

  const position = json.accessors[json.meshes[0].primitives[0].attributes.POSITION];
  // The wall is 4 m long, 0.2 m thick and 3 m high. web-ifc's flat geometry is Y-up, so the
  // height must be the Y extent and the thickness the Z extent.
  assert.equal(Math.round(position.max[0] - position.min[0]), 4);
  assert.equal(Math.round(position.max[1] - position.min[1]), 3, 'height is on Y');
  assert.equal(Math.round((position.max[2] - position.min[2]) * 10) / 10, 0.2, 'thickness is on Z');
});

test('convertIfcBuffer explains an empty or unreadable file', async () => {
  await assert.rejects(() => convertIfcBuffer(Buffer.alloc(0)), /empty/i);
  await assert.rejects(() => convertIfcBuffer(Buffer.from('this is not an IFC file')), /could not read|no drawable geometry/i);
});

test('a conversion job reads the stored IFC, writes a GLB beside it and records the result', async () => {
  // The worker, the temp files, the storage write and the recorded status, without a database
  // or an HTTP request: exactly the path a request can hand off to.
  const records = new Map();
  const stored = new Map();
  const pool = {
    async query(sql, params = []) {
      if (/INSERT INTO bim_model_conversions/i.test(sql)) {
        records.set(params[0], {
          model_id: params[0], project_id: params[1], status: params[2], glb_key: params[3],
          bytes: params[4], elements: params[5], meshes: params[6], triangles: params[7], error: params[8]
        });
      }
      return { rows: [] };
    }
  };
  const storage = {
    async createReadStream() { return fs.createReadStream(WALL_IFC); },
    async size() { return (await fs.promises.stat(WALL_IFC)).size; },
    async putFromTemp(tempPath, key) { stored.set(key, await fs.promises.readFile(tempPath)); return key; }
  };

  const module = createBimConvertModule({
    app: express(), pool, verifyToken: (req, res, next) => next(),
    requireProjectAccess: () => (req, res, next) => next(), storage
  });

  await module.startConversion(4, 9, {
    id: 9, file_name: 'wall.ifc', file_path: 'projects/4/models/abc-wall.ifc'
  });

  const record = records.get(9);
  assert.equal(record.status, 'ready', record.error || 'no error');
  assert.equal(record.error, null);
  assert.equal(record.glb_key, 'projects/4/models/abc-wall.ifc.glb');
  assert.ok(record.bytes > 0);
  assert.equal(record.elements, 1);

  const glb = stored.get('projects/4/models/abc-wall.ifc.glb');
  assert.ok(glb && glb.length > 0, 'the GLB is written to storage');
  assert.equal(glb.readUInt32LE(0), GLB_MAGIC);
});

test('the conversion module registers its three routes', () => {
  const app = express();
  const module = createBimConvertModule({
    app,
    pool: { query: async () => ({ rows: [] }) },
    verifyToken: (req, res, next) => next(),
    requireProjectAccess: () => (req, res, next) => next(),
    storage: {}
  });

  const routes = app._router.stack
    .filter((layer) => layer.route)
    .map((layer) => `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`);

  assert.ok(routes.includes('POST /api/bim/:projectId/models/:modelId/convert'), routes.join(', '));
  assert.ok(routes.includes('GET /api/bim/:projectId/models/:modelId/convert'), routes.join(', '));
  assert.ok(routes.includes('GET /api/bim/:projectId/models/:modelId/glb'), routes.join(', '));
  assert.equal(typeof module.ensureConversionSchema, 'function');
  assert.ok(module.LIMITS.maxBytes > 25 * 1024 * 1024, 'the converter accepts models above the browser limit');
});
