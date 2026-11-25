'use strict';
/**
 * Copies BIM models that were uploaded before object storage existed onto the object store and
 * repoints their database rows at the new object keys.
 *
 * The pre-storage rows hold an absolute path on the uploads volume (`/opt/render/.../uploads/…`).
 * Those files are invisible to the S3 driver, so they must be uploaded and their `file_path`
 * replaced by the key `storage.objectKey()` returns — the same shape new imports now write.
 *
 * Nothing is written unless `apply` is true: the default is a dry run that lists what would move,
 * because this touches real records and real bytes in a production database.
 *
 * A row is only repointed after the object is uploaded *and* its stored size matches the file on
 * disk; the local file is deleted only after the update succeeds. A failure at any step leaves the
 * row pointing at the file that still exists, so the model keeps working.
 */

const fs = require('fs');
const path = require('path');

const CONTENT_TYPES = {
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.ifc': 'application/x-step',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values'
};

/** The type stored with the object; the extension decides, as it does when a model is served. */
function contentTypeFor(fileName) {
  return CONTENT_TYPES[path.extname(String(fileName || '')).toLowerCase()] || 'application/octet-stream';
}

function legacyRowsSql(projectId) {
  const where = ["file_path LIKE '/%'"];
  if (projectId) where.push('project_id = $1');
  return `
    SELECT id, project_id, file_name, file_path
    FROM bim_models
    WHERE ${where.join(' AND ')}
    ORDER BY id`;
}

/** Human-readable size for the log line. */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '?';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Runs the migration.
 *
 * @param {object}   options
 * @param {object}   options.pool        pg Pool (or anything with `query`).
 * @param {object}   options.storage     A storage driver from storage.js; must be remote.
 * @param {string}   options.uploadRoot  The uploads volume the absolute paths live under.
 * @param {boolean}  options.apply       false = dry run.
 * @param {boolean}  options.keepLocal   Leave the local file in place after a successful move.
 * @param {number}   options.projectId   Limit to one project.
 * @param {function} options.log         Receives one line per row and a summary.
 */
async function migrateLocalModels({
  pool,
  storage,
  uploadRoot,
  apply = false,
  keepLocal = false,
  projectId = null,
  log = () => {}
} = {}) {
  if (!pool || typeof pool.query !== 'function') throw new Error('A database pool is required.');
  if (!storage) throw new Error('A storage driver is required.');
  if (!storage.isRemote) {
    throw new Error(
      'The configured storage is the local uploads volume, so there is nothing to copy. ' +
      'Set S3_BUCKET and the S3 credentials, redeploy, and run this again.'
    );
  }

  const root = path.resolve(uploadRoot || process.env.UPLOAD_DIR || path.join(__dirname, 'uploads'));
  const summary = {
    apply,
    keepLocal,
    uploadRoot: root,
    storage: typeof storage.describe === 'function' ? storage.describe() : storage.driver,
    scanned: 0,
    moved: 0,
    planned: 0,
    missing: 0,
    outside: 0,
    failed: 0,
    changed: 0,
    bytes: 0,
    rows: []
  };

  const { rows } = await pool.query(legacyRowsSql(projectId), projectId ? [projectId] : []);
  summary.scanned = rows.length;

  for (const row of rows) {
    const stored = String(row.file_path || '');
    const absolute = path.resolve(stored);
    const label = `#${row.id} project ${row.project_id} ${row.file_name || path.basename(absolute)}`;

    // The same guard the model-file route applies: never read outside the uploads volume.
    if (absolute !== root && !absolute.startsWith(root + path.sep)) {
      summary.outside += 1;
      summary.rows.push({ id: row.id, status: 'outside', file: stored });
      log(`   ${label} — skipped: ${stored} is outside ${root}`);
      continue;
    }

    let stats;
    try {
      stats = await fs.promises.stat(absolute);
    } catch (err) {
      summary.missing += 1;
      summary.rows.push({ id: row.id, status: 'missing', file: stored });
      log(`   ${label} — skipped: the file is no longer on disk (${stored})`);
      continue;
    }
    if (!stats.isFile()) {
      summary.missing += 1;
      summary.rows.push({ id: row.id, status: 'missing', file: stored });
      log(`   ${label} — skipped: ${stored} is not a file`);
      continue;
    }

    const key = storage.objectKey({
      projectId: row.project_id,
      category: 'models',
      filename: row.file_name || path.basename(absolute)
    });

    if (!apply) {
      summary.planned += 1;
      summary.bytes += stats.size;
      summary.rows.push({ id: row.id, status: 'would-move', from: stored, to: key, bytes: stats.size });
      log(`   ${label} ${formatBytes(stats.size)} → ${key}`);
      continue;
    }

    try {
      await storage.putFromTemp(absolute, key, { contentType: contentTypeFor(row.file_name || absolute) });
      const uploaded = await storage.size(key);
      if (uploaded !== stats.size) {
        await storage.remove(key).catch(() => {});
        throw new Error(`uploaded ${uploaded} bytes but the file is ${stats.size}`);
      }

      const updated = await pool.query(
        'UPDATE bim_models SET file_path = $1 WHERE id = $2 AND file_path = $3',
        [key, row.id, stored]
      );
      if (updated.rowCount !== 1) {
        // The row moved on (re-imported or edited) while this ran; the new object is unused.
        await storage.remove(key).catch(() => {});
        summary.changed += 1;
        summary.rows.push({ id: row.id, status: 'changed', from: stored, to: key });
        log(`   ${label} — skipped: the record changed while copying, the object was removed again`);
        continue;
      }

      if (!keepLocal) await fs.promises.unlink(absolute).catch(() => {});

      summary.moved += 1;
      summary.bytes += stats.size;
      summary.rows.push({ id: row.id, status: 'moved', from: stored, to: key, bytes: stats.size });
      log(`   ${label} ${formatBytes(stats.size)} → ${key}${keepLocal ? ' (local file kept)' : ''}`);
    } catch (err) {
      summary.failed += 1;
      summary.rows.push({ id: row.id, status: 'failed', from: stored, to: key, error: err.message });
      log(`   ${label} — failed: ${err.message}`);
    }
  }

  return summary;
}

module.exports = { migrateLocalModels, contentTypeFor, legacyRowsSql, formatBytes, CONTENT_TYPES };
