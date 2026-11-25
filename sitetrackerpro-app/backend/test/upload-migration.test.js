'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { migrateLocalModels, contentTypeFor } = require('../upload-migration');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function volume() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stp-migrate-'));
  const write = (name, contents) => {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
    return target;
  };
  return { root, write };
}

/** A remote storage driver that keeps objects in memory instead of a bucket. */
function memoryStorage({ corruptSizeFor } = {}) {
  const objects = new Map();
  return {
    driver: 's3',
    isRemote: true,
    describe: () => 'in-memory object store',
    objectKey: ({ projectId, category, filename }) => `projects/${projectId}/${category}/x-${filename}`,
    localPath: () => null,
    objects,
    async putFromTemp(file, key, { contentType } = {}) {
      objects.set(key, { bytes: fs.readFileSync(file), contentType });
      return key;
    },
    async size(key) {
      if (corruptSizeFor && key.includes(corruptSizeFor)) return 1;
      const object = objects.get(key);
      if (!object) throw new Error('missing object');
      return object.bytes.length;
    },
    async remove(key) {
      objects.delete(key);
      return true;
    }
  };
}

function poolWith(rows, { updateRowCount = 1 } = {}) {
  const queries = [];
  return {
    queries,
    updates: () => queries.filter(q => /^\s*UPDATE/i.test(q.sql)),
    async query(sql, params) {
      queries.push({ sql, params });
      if (/^\s*UPDATE/i.test(sql)) return { rowCount: updateRowCount, rows: [] };
      return { rowCount: rows.length, rows };
    }
  };
}

const silent = () => {};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('content types follow the extension the model route uses', () => {
  assert.equal(contentTypeFor('tower.ifc'), 'application/x-step');
  assert.equal(contentTypeFor('tower.GLB'), 'model/gltf-binary');
  assert.equal(contentTypeFor('takeoff.csv'), 'text/csv');
  assert.equal(contentTypeFor('mystery'), 'application/octet-stream');
});

test('a dry run reports what would move without touching storage, disk or database', async () => {
  const { root, write } = volume();
  const file = write('projects/3/models/tower.ifc', 'IFC-DATA');
  const storage = memoryStorage();
  const pool = poolWith([{ id: 12, project_id: 3, file_name: 'tower.ifc', file_path: file }]);

  const summary = await migrateLocalModels({ pool, storage, uploadRoot: root, log: silent });

  assert.equal(summary.scanned, 1);
  assert.equal(summary.planned, 1);
  assert.equal(summary.moved, 0);
  assert.equal(summary.bytes, 8);
  assert.equal(storage.objects.size, 0);
  assert.equal(pool.updates().length, 0);
  assert.ok(fs.existsSync(file), 'the local file is untouched by a dry run');
  assert.equal(summary.rows[0].status, 'would-move');
  assert.equal(summary.rows[0].to, 'projects/3/models/x-tower.ifc');
});

test('applying uploads the file, repoints the row and deletes the local copy', async () => {
  const { root, write } = volume();
  const file = write('projects/3/models/tower.ifc', 'IFC-DATA');
  const storage = memoryStorage();
  const pool = poolWith([{ id: 12, project_id: 3, file_name: 'tower.ifc', file_path: file }]);

  const summary = await migrateLocalModels({ pool, storage, uploadRoot: root, apply: true, log: silent });

  assert.equal(summary.moved, 1);
  assert.equal(summary.failed, 0);

  const object = storage.objects.get('projects/3/models/x-tower.ifc');
  assert.ok(object, 'the object exists in the bucket');
  assert.equal(object.bytes.toString(), 'IFC-DATA');
  assert.equal(object.contentType, 'application/x-step');

  const [update] = pool.updates();
  assert.deepEqual(update.params, ['projects/3/models/x-tower.ifc', 12, file]);
  assert.match(update.sql, /WHERE id = \$2 AND file_path = \$3/);

  assert.equal(fs.existsSync(file), false, 'the local file is gone after a successful move');
});

test('--keep-local leaves the file on the volume', async () => {
  const { root, write } = volume();
  const file = write('projects/3/models/tower.ifc', 'IFC-DATA');
  const storage = memoryStorage();
  const pool = poolWith([{ id: 12, project_id: 3, file_name: 'tower.ifc', file_path: file }]);

  const summary = await migrateLocalModels({ pool, storage, uploadRoot: root, apply: true, keepLocal: true, log: silent });

  assert.equal(summary.moved, 1);
  assert.ok(fs.existsSync(file));
  assert.equal(pool.updates().length, 1);
});

test('a file missing from disk is skipped and its row is left alone', async () => {
  const { root } = volume();
  const storage = memoryStorage();
  const missing = path.join(root, 'projects/3/models/gone.ifc');
  const pool = poolWith([{ id: 13, project_id: 3, file_name: 'gone.ifc', file_path: missing }]);

  const summary = await migrateLocalModels({ pool, storage, uploadRoot: root, apply: true, log: silent });

  assert.equal(summary.missing, 1);
  assert.equal(summary.moved, 0);
  assert.equal(summary.failed, 0);
  assert.equal(pool.updates().length, 0);
  assert.equal(storage.objects.size, 0);
});

test('a path outside the uploads volume is refused, as the model route refuses it', async () => {
  const { root } = volume();
  const outside = path.join(os.tmpdir(), 'stp-migrate-outside.ifc');
  fs.writeFileSync(outside, 'NOT-OURS');
  const storage = memoryStorage();
  const pool = poolWith([{ id: 14, project_id: 3, file_name: 'outside.ifc', file_path: outside }]);

  try {
    const summary = await migrateLocalModels({ pool, storage, uploadRoot: root, apply: true, log: silent });

    assert.equal(summary.outside, 1);
    assert.equal(summary.moved, 0);
    assert.equal(storage.objects.size, 0);
    assert.equal(pool.updates().length, 0);
    assert.ok(fs.existsSync(outside), 'the refused file is not deleted');
  } finally {
    fs.rmSync(outside, { force: true });
  }
});

test('a size mismatch removes the object and leaves the record and the file in place', async () => {
  const { root, write } = volume();
  const file = write('projects/3/models/tower.ifc', 'IFC-DATA');
  const storage = memoryStorage({ corruptSizeFor: 'tower.ifc' });
  const pool = poolWith([{ id: 12, project_id: 3, file_name: 'tower.ifc', file_path: file }]);

  const summary = await migrateLocalModels({ pool, storage, uploadRoot: root, apply: true, log: silent });

  assert.equal(summary.failed, 1);
  assert.equal(summary.moved, 0);
  assert.equal(pool.updates().length, 0);
  assert.equal(storage.objects.size, 0, 'the half-trusted object was deleted again');
  assert.ok(fs.existsSync(file), 'the file is still there for a retry');
  assert.match(summary.rows[0].error, /uploaded 1 bytes but the file is 8/);
});

test('a record that changes while copying is reported and the unused object is removed', async () => {
  const { root, write } = volume();
  const file = write('projects/3/models/tower.ifc', 'IFC-DATA');
  const storage = memoryStorage();
  const pool = poolWith(
    [{ id: 12, project_id: 3, file_name: 'tower.ifc', file_path: file }],
    { updateRowCount: 0 }
  );

  const summary = await migrateLocalModels({ pool, storage, uploadRoot: root, apply: true, log: silent });

  assert.equal(summary.changed, 1);
  assert.equal(summary.moved, 0);
  assert.equal(storage.objects.size, 0);
  assert.ok(fs.existsSync(file), 'nothing is deleted when the row did not take the new path');
});

test('a local storage driver is refused: there is no destination to copy to', async () => {
  const pool = poolWith([]);
  const local = { driver: 'local-volume', isRemote: false };

  await assert.rejects(
    () => migrateLocalModels({ pool, storage: local }),
    /nothing to copy/i
  );
});

test('--project limits the query to that project', async () => {
  const { root } = volume();
  const storage = memoryStorage();
  const pool = poolWith([]);

  await migrateLocalModels({ pool, storage, uploadRoot: root, projectId: 7, log: silent });

  const [select] = pool.queries;
  assert.match(select.sql, /project_id = \$1/);
  assert.deepEqual(select.params, [7]);
});

test('only absolute paths are selected, so already-migrated rows are left alone', async () => {
  const { root } = volume();
  const storage = memoryStorage();
  const pool = poolWith([]);

  await migrateLocalModels({ pool, storage, uploadRoot: root, log: silent });

  assert.match(pool.queries[0].sql, /file_path LIKE '\/%'/);
  assert.match(pool.queries[0].sql, /FROM bim_models/);
});
