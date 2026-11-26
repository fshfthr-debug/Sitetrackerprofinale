'use strict';
/**
 * IFC -> GLB, on the server, for models too large to read in a browser tab.
 *
 * The browser refuses an IFC over 25 MB because web-ifc tessellates the whole file on the main
 * thread; on a site laptop a 100 MB model freezes the tab and then runs out of memory. The same
 * extraction can run in a worker on the server, once, and the result is a GLB: no property sets,
 * no relationships, no text — just triangles and one colour per IFC class. A GLB produced here is
 * read by the same three.js loader as any other model in the app.
 *
 * Coordinates: web-ifc's flat representation already carries the file's Z-up into the Y-up frame
 * its geometry is read in (the BIM viewer draws those triangles as they arrive), so no axis
 * rotation is applied here. COORDINATE_TO_ORIGIN keeps the numbers small. The GLB is therefore
 * directly readable by the same three.js loader the app uses for every other model.
 *
 * Nothing is guessed: a file with no drawable geometry is an error the caller reports.
 */

// IFC classes that are voids or empty volumes, matching the browser reader (src/bim/ifcGeometry.js).
const SKIPPED = ['IFCOPENINGELEMENT', 'IFCSPACE'];

const align4 = (value) => (value + 3) & ~3;

// Stable colour per IFC class: same hue formula as the app, so a class keeps its colour wherever
// it is drawn. Returned as linear-ish sRGB floats for glTF.
function colourForType(type) {
  let hash = 0;
  for (let i = 0; i < type.length; i++) hash = (hash * 31 + type.charCodeAt(i)) % 360;
  const hue = hash / 360;
  const saturation = 0.45;
  const lightness = 0.62;
  const q = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;
  const channel = (t) => {
    let temp = t;
    if (temp < 0) temp += 1;
    if (temp > 1) temp -= 1;
    if (temp < 1 / 6) return p + (q - p) * 6 * temp;
    if (temp < 1 / 2) return q;
    if (temp < 2 / 3) return p + (q - p) * (2 / 3 - temp) * 6;
    return p;
  };
  return [channel(hue + 1 / 3), channel(hue), channel(hue - 1 / 3)];
}

/** A growable typed array, so a large model does not fill the heap with boxed numbers. */
class Growable {
  constructor(ArrayType, initial = 4096) {
    this.ArrayType = ArrayType;
    this.data = new ArrayType(initial);
    this.length = 0;
  }

  reserve(extra) {
    const needed = this.length + extra;
    if (needed <= this.data.length) return;
    let size = this.data.length || 1024;
    while (size < needed) size *= 2;
    const next = new this.ArrayType(size);
    next.set(this.data.subarray(0, this.length));
    this.data = next;
  }

  push3(a, b, c) {
    this.reserve(3);
    this.data[this.length++] = a;
    this.data[this.length++] = b;
    this.data[this.length++] = c;
  }

  push(value) {
    this.reserve(1);
    this.data[this.length++] = value;
  }

  toTypedArray() {
    return this.data.slice(0, this.length);
  }
}

/**
 * A glTF 2.0 binary file with one mesh, one primitive per IFC class and one buffer.
 *
 * primitives: [{ name, positions: Float32Array, normals: Float32Array, indices: Uint32Array }]
 */
function writeGlb(primitives, { generator = 'SiteTrackerPro' } = {}) {
  const accessors = [];
  const bufferViews = [];
  const materials = [];
  const glPrimitives = [];
  const chunks = [];
  let byteLength = 0;

  const append = (typed) => {
    const bytes = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
    const offset = byteLength;
    chunks.push(bytes);
    byteLength += bytes.length;
    return offset;
  };

  (primitives || []).forEach((primitive) => {
    const { positions, normals, indices } = primitive || {};
    if (!positions || positions.length < 9 || !indices || indices.length < 3) return;

    const positionOffset = append(positions);
    bufferViews.push({ buffer: 0, byteOffset: positionOffset, byteLength: positions.byteLength, target: 34962 });
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) {
      for (let axis = 0; axis < 3; axis += 1) {
        const value = positions[i + axis];
        if (value < min[axis]) min[axis] = value;
        if (value > max[axis]) max[axis] = value;
      }
    }
    accessors.push({
      bufferView: bufferViews.length - 1,
      componentType: 5126,
      count: positions.length / 3,
      type: 'VEC3',
      min: min.map((value) => Math.round(value * 1e6) / 1e6),
      max: max.map((value) => Math.round(value * 1e6) / 1e6)
    });
    const positionAccessor = accessors.length - 1;

    let normalAccessor;
    if (normals && normals.length === positions.length) {
      const normalOffset = append(normals);
      bufferViews.push({ buffer: 0, byteOffset: normalOffset, byteLength: normals.byteLength, target: 34962 });
      accessors.push({
        bufferView: bufferViews.length - 1,
        componentType: 5126,
        count: normals.length / 3,
        type: 'VEC3'
      });
      normalAccessor = accessors.length - 1;
    }

    const indexOffset = append(indices);
    bufferViews.push({ buffer: 0, byteOffset: indexOffset, byteLength: indices.byteLength, target: 34963 });
    accessors.push({
      bufferView: bufferViews.length - 1,
      componentType: 5125,
      count: indices.length,
      type: 'SCALAR'
    });
    const indexAccessor = accessors.length - 1;

    const colour = colourForType(String(primitive.name || 'IfcElement'));
    materials.push({
      name: String(primitive.name || 'IfcElement'),
      doubleSided: true,
      pbrMetallicRoughness: {
        baseColorFactor: [colour[0], colour[1], colour[2], 1],
        metallicFactor: 0,
        roughnessFactor: 0.85
      }
    });

    glPrimitives.push({
      attributes: {
        POSITION: positionAccessor,
        ...(normalAccessor === undefined ? {} : { NORMAL: normalAccessor })
      },
      indices: indexAccessor,
      material: materials.length - 1,
      mode: 4
    });
  });

  if (glPrimitives.length === 0) {
    throw new Error('Nothing to write: the model produced no triangles.');
  }

  const binary = Buffer.concat(chunks);
  const json = {
    asset: { version: '2.0', generator },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'IFC model' }],
    meshes: [{ name: 'IFC model', primitives: glPrimitives }],
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: binary.length }]
  };

  let jsonChunk = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPadding = align4(jsonChunk.length) - jsonChunk.length;
  if (jsonPadding) jsonChunk = Buffer.concat([jsonChunk, Buffer.alloc(jsonPadding, 0x20)]);

  const binaryPadding = align4(binary.length) - binary.length;
  const binaryChunk = binaryPadding ? Buffer.concat([binary, Buffer.alloc(binaryPadding)]) : binary;

  const total = 12 + 8 + jsonChunk.length + 8 + binaryChunk.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); // 'glTF'
  header.writeUInt32LE(2, 4);          // version 2
  header.writeUInt32LE(total, 8);

  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonChunk.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4); // 'JSON'

  const binaryHeader = Buffer.alloc(8);
  binaryHeader.writeUInt32LE(binaryChunk.length, 0);
  binaryHeader.writeUInt32LE(0x004e4942, 4); // 'BIN'

  return Buffer.concat([header, jsonHeader, jsonChunk, binaryHeader, binaryChunk]);
}

/**
 * Read an IFC from memory and return { glb, elements, meshes, triangles }.
 * Throws with a readable message for an empty file, an unreadable file or a model with no geometry.
 */
async function convertIfcBuffer(buffer, { onProgress } = {}) {
  if (!buffer || buffer.byteLength === 0) throw new Error('The IFC file is empty.');

  const { IfcAPI } = require('web-ifc');
  const api = new IfcAPI();
  await api.Init();

  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let modelID;
  try {
    modelID = api.OpenModel(bytes, { COORDINATE_TO_ORIGIN: true });
  } catch (err) {
    throw new Error(`web-ifc could not read this file: ${err.message}`);
  }

  const skipped = new Set(SKIPPED.map((name) => api.GetTypeCodeFromName(name)));
  const buckets = new Map();
  let meshes = 0;
  let triangles = 0;

  try {
    api.StreamAllMeshes(modelID, (flatMesh) => {
      const typeCode = api.GetLineType(modelID, flatMesh.expressID);
      if (skipped.has(typeCode)) return;
      const type = api.GetNameFromTypeCode(typeCode) || 'IfcElement';
      let bucket = buckets.get(type);
      if (!bucket) {
        bucket = {
          positions: new Growable(Float32Array),
          normals: new Growable(Float32Array),
          indices: new Growable(Uint32Array),
          vertexCount: 0
        };
        buckets.set(type, bucket);
      }

      for (let i = 0; i < flatMesh.geometries.size(); i += 1) {
        const placed = flatMesh.geometries.get(i);
        const geometry = api.GetGeometry(modelID, placed.geometryExpressID);
        try {
          const vertices = api.GetVertexArray(geometry.GetVertexData(), geometry.GetVertexDataSize());
          const indices = api.GetIndexArray(geometry.GetIndexData(), geometry.GetIndexDataSize());
          const matrix = placed.flatTransformation;
          const base = bucket.vertexCount;

          for (let v = 0; v < vertices.length; v += 6) {
            const x = vertices[v];
            const y = vertices[v + 1];
            const z = vertices[v + 2];
            const nx = vertices[v + 3];
            const ny = vertices[v + 4];
            const nz = vertices[v + 5];

            const wx = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
            const wy = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
            const wz = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];

            bucket.positions.push3(wx, wy, wz);

            let vx = matrix[0] * nx + matrix[4] * ny + matrix[8] * nz;
            let vy = matrix[1] * nx + matrix[5] * ny + matrix[9] * nz;
            let vz = matrix[2] * nx + matrix[6] * ny + matrix[10] * nz;
            const length = Math.hypot(vx, vy, vz);
            if (length > 0) { vx /= length; vy /= length; vz /= length; }
            bucket.normals.push3(vx, vy, vz);
            bucket.vertexCount += 1;
          }

          for (let k = 0; k < indices.length; k += 1) bucket.indices.push(base + indices[k]);
          triangles += indices.length / 3;
          meshes += 1;
        } finally {
          geometry.delete();
        }
      }
    });
  } finally {
    try { api.CloseModel(modelID); } catch (err) { /* already closed */ }
  }

  const primitives = [];
  for (const [name, bucket] of buckets) {
    if (bucket.indices.length === 0) continue;
    primitives.push({
      name,
      positions: bucket.positions.toTypedArray(),
      normals: bucket.normals.toTypedArray(),
      indices: bucket.indices.toTypedArray()
    });
  }

  if (primitives.length === 0) {
    throw new Error('This IFC has no drawable geometry. It may be a coordination or property-only model.');
  }
  if (onProgress) onProgress({ meshes, triangles, elements: buckets.size });

  return { glb: writeGlb(primitives), elements: buckets.size, meshes, triangles };
}

module.exports = { convertIfcBuffer, writeGlb, colourForType };
