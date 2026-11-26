'use strict';
/**
 * Large-IFC conversion for the Digital Twin.
 *
 * The browser reads IFCs up to 25 MB. Above that the twin asks this module to convert the model
 * once, on the server, into a GLB it can draw; the GLB is cached in the project's storage, so the
 * second visit is instant and a restart does not throw the work away.
 *
 * Conversion state lives in its own small table (bim_model_conversions), never in bim_models, so
 * nothing here changes a row the rest of the app reads. Jobs run one at a time in a worker thread:
 * conversion is CPU- and memory-heavy, and two at once on a small instance would starve the API.
 *
 * Mounted by backend-v3-enhanced.js:
 *   createBimConvertModule({ app, pool, verifyToken, requireProjectAccess, storage, serverError })
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Worker } = require('node:worker_threads');

const IFC_EXTENSION = /\.ifc$/i;

const LIMITS = {
  // Above this the converter needs more memory than the service normally has; the call is refused
  // with a message instead of an out-of-memory crash. Raise it only alongside the instance size.
  maxBytes: Math.max(1, Number(process.env.IFC_CONVERT_MAX_MB || 60)) * 1024 * 1024,
  timeoutMs: Math.max(30, Number(process.env.IFC_CONVERT_TIMEOUT_SECONDS || 300)) * 1000,
  workerHeapMb: Math.max(64, Number(process.env.IFC_CONVERT_MEMORY_MB || 256))
};

const megabytes = (bytes) => {
  const value = Number(bytes) / (1024 * 1024);
  return `${value.toFixed(value < 10 ? 1 : 0)} MB`;
};

function tooLargeMessage(bytes) {
  return `This IFC is ${megabytes(bytes)}. The server converts models up to ${Math.round(LIMITS.maxBytes / 1024 / 1024)} MB, `
    + 'because a larger one needs more memory than this service has. Export a GLB from your BIM tool, '
    + 'or split the model by storey or discipline and import the parts.';
}

function createBimConvertModule({
  app,
  pool,
  verifyToken,
  requireProjectAccess,
  storage,
  serverError = (res, where, err) => {
    console.error(`[${new Date().toISOString()}] ${where} failed:`, err && err.message ? err.message : err);
    if (!res.headersSent) res.status(500).json({ error: 'The request could not be completed. Please try again.' });
  }
}) {
  const asyncHandler = (fn) => (req, res) => fn(req, res).catch((err) => serverError(res, `${req.method} ${req.path}`, err));

  // One conversion at a time; the rest wait in this chain.
  const running = new Map();
  let queue = Promise.resolve();

  async function ensureConversionSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bim_model_conversions (
        model_id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL,
        status TEXT NOT NULL,
        glb_key TEXT,
        bytes BIGINT,
        elements INTEGER,
        meshes INTEGER,
        triangles BIGINT,
        error TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // A conversion cannot survive a restart: the worker is gone with the process.
    await pool.query(`
      UPDATE bim_model_conversions
         SET status = 'failed',
             error = 'The conversion was interrupted by a server restart. Start it again.',
             updated_at = NOW()
       WHERE status IN ('queued', 'converting')
    `);
  }

  async function modelRow(projectId, modelId) {
    const result = await pool.query(
      'SELECT id, file_name, file_type, file_path FROM bim_models WHERE id = $1 AND project_id = $2',
      [modelId, projectId]
    );
    return result.rows[0] || null;
  }

  async function conversionRow(projectId, modelId) {
    const result = await pool.query(
      'SELECT * FROM bim_model_conversions WHERE model_id = $1 AND project_id = $2',
      [modelId, projectId]
    );
    return result.rows[0] || null;
  }

  async function record(modelId, projectId, fields) {
    await pool.query(
      `INSERT INTO bim_model_conversions (model_id, project_id, status, glb_key, bytes, elements, meshes, triangles, error, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
       ON CONFLICT (model_id) DO UPDATE SET
         status = EXCLUDED.status,
         glb_key = COALESCE(EXCLUDED.glb_key, bim_model_conversions.glb_key),
         bytes = COALESCE(EXCLUDED.bytes, bim_model_conversions.bytes),
         elements = COALESCE(EXCLUDED.elements, bim_model_conversions.elements),
         meshes = COALESCE(EXCLUDED.meshes, bim_model_conversions.meshes),
         triangles = COALESCE(EXCLUDED.triangles, bim_model_conversions.triangles),
         error = EXCLUDED.error,
         updated_at = NOW()`,
      [
        modelId,
        projectId,
        fields.status,
        fields.glbKey || null,
        fields.bytes || null,
        fields.elements || null,
        fields.meshes || null,
        fields.triangles || null,
        fields.error || null
      ]
    );
  }

  /** Where the converted GLB lives: beside the source file, so it follows the model's lifetime. */
  function cacheTarget(row) {
    const stored = String(row.file_path || '');
    if (!stored) return null;
    return {
      kind: path.isAbsolute(stored) ? 'file' : 'storage',
      key: `${stored}.glb`
    };
  }

  /**
   * The IFC to convert, as a path on disk. Object storage has to be downloaded first; the copy is
   * made in the worker's temp folder and removed by the caller.
   */
  async function downloadSource(row, dir) {
    const stored = String(row.file_path || '');
    if (!stored) throw new Error('The stored model has no file.');

    if (path.isAbsolute(stored)) {
      const stats = await fs.promises.stat(stored).catch(() => null);
      if (!stats || !stats.isFile()) throw new Error('The stored model file is no longer on disk. Import it again.');
      return { path: stored, bytes: stats.size, cleanup: async () => {} };
    }

    const local = path.join(dir, 'model.ifc');
    const stream = await storage.createReadStream(stored);
    await pipeline(stream, fs.createWriteStream(local));
    const stats = await fs.promises.stat(local);
    return { path: local, bytes: stats.size, cleanup: async () => { await fs.promises.unlink(local).catch(() => {}); } };
  }

  function runWorker({ inputPath, outputPath }) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, 'ifc-convert-worker.js'), {
        workerData: { inputPath, outputPath },
        resourceLimits: { maxOldGenerationSizeMb: LIMITS.workerHeapMb }
      });

      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.terminate().catch(() => {});
        fn(value);
      };

      const timer = setTimeout(() => {
        finish(reject, new Error(`Converting took longer than ${Math.round(LIMITS.timeoutMs / 1000)} seconds and was stopped. `
          + 'Export a GLB from your BIM tool, or split the model by storey.'));
      }, LIMITS.timeoutMs);

      worker.once('message', (message) => {
        if (message && message.ok) finish(resolve, message);
        else finish(reject, new Error((message && message.error) || 'The converter stopped without a result.'));
      });
      worker.once('error', (err) => finish(reject, new Error(`The converter stopped: ${err.message}`)));
      worker.once('exit', (code) => {
        if (code !== 0) finish(reject, new Error(`The converter ran out of memory or crashed (exit code ${code}). `
          + 'This model is too large for the server; export a GLB instead.'));
      });
    });
  }

  async function convertOne(projectId, modelId, row) {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ifc-convert-'));
    try {
      await record(modelId, projectId, { status: 'converting' });

      const source = await downloadSource(row, dir);
      try {
        if (source.bytes > LIMITS.maxBytes) {
          const message = tooLargeMessage(source.bytes);
          await record(modelId, projectId, { status: 'failed', error: message });
          return;
        }

        const output = path.join(dir, 'model.glb');
        const result = await runWorker({ inputPath: source.path, outputPath: output });

        const target = cacheTarget(row);
        if (!target) throw new Error('The stored model has no file to convert.');

        if (target.kind === 'file') {
          await fs.promises.rename(output, target.key);
        } else {
          await storage.putFromTemp(output, target.key, { contentType: 'model/gltf-binary' });
        }

        await record(modelId, projectId, {
          status: 'ready',
          glbKey: target.key,
          bytes: result.bytes,
          elements: result.elements,
          meshes: result.meshes,
          triangles: result.triangles
        });
        console.log(`🧱 Converted IFC model ${modelId} (project ${projectId}): ${megabytes(result.bytes)}, `
          + `${result.elements} classes, ${result.triangles} triangles`);
      } finally {
        await source.cleanup();
      }
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      console.warn(`IFC conversion for model ${modelId} failed: ${message}`);
      await record(modelId, projectId, { status: 'failed', error: message }).catch(() => {});
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  function startConversion(projectId, modelId, row) {
    const key = `${projectId}:${modelId}`;
    if (running.has(key)) return running.get(key);

    const job = queue.then(() => convertOne(projectId, modelId, row)).finally(() => {
      running.delete(key);
    });
    queue = job.catch(() => {});
    running.set(key, job);
    return job;
  }

  function publicStatus(row, projectId, modelId) {
    if (!row) return { status: 'none' };
    return {
      status: row.status,
      bytes: row.bytes === null || row.bytes === undefined ? null : Number(row.bytes),
      elements: row.elements === null || row.elements === undefined ? null : Number(row.elements),
      meshes: row.meshes === null || row.meshes === undefined ? null : Number(row.meshes),
      triangles: row.triangles === null || row.triangles === undefined ? null : Number(row.triangles),
      error: row.error || null,
      updatedAt: row.updated_at,
      fileUrl: row.status === 'ready' ? `/api/bim/${projectId}/models/${modelId}/glb` : null
    };
  }

  const validId = (value) => {
    const id = Number(value);
    return Number.isInteger(id) && id > 0 ? id : null;
  };

  // --- Ask for a conversion, or read its state -------------------------------------------------
  app.get('/api/bim/:projectId/models/:modelId/convert',
    verifyToken,
    requireProjectAccess((req) => req.params.projectId),
    asyncHandler(async (req, res) => {
      const modelId = validId(req.params.modelId);
      if (!modelId) return res.status(400).json({ error: 'modelId must be a model id.' });

      const row = await conversionRow(req.projectId, modelId);
      res.json(publicStatus(row, req.projectId, modelId));
    }));

  app.post('/api/bim/:projectId/models/:modelId/convert',
    verifyToken,
    requireProjectAccess((req) => req.params.projectId),
    asyncHandler(async (req, res) => {
      const modelId = validId(req.params.modelId);
      if (!modelId) return res.status(400).json({ error: 'modelId must be a model id.' });

      const model = await modelRow(req.projectId, modelId);
      if (!model) return res.status(404).json({ error: 'BIM model not found in this project.' });
      if (!IFC_EXTENSION.test(String(model.file_name || model.file_path || ''))) {
        return res.status(415).json({ error: 'Only an IFC needs converting. GLB and glTF models are read directly.' });
      }

      const existing = await conversionRow(req.projectId, modelId);
      if (existing && existing.status === 'ready') {
        return res.json(publicStatus(existing, req.projectId, modelId));
      }
      if (existing && existing.status === 'converting' && running.has(`${req.projectId}:${modelId}`)) {
        return res.status(202).json(publicStatus(existing, req.projectId, modelId));
      }

      // Refuse a model that is already above the converter's ceiling before spending a download.
      try {
        const bytes = path.isAbsolute(String(model.file_path || ''))
          ? (await fs.promises.stat(model.file_path)).size
          : await storage.size(model.file_path);
        if (bytes > LIMITS.maxBytes) {
          const message = tooLargeMessage(bytes);
          await record(modelId, req.projectId, { status: 'failed', error: message });
          return res.status(413).json({ error: message, status: 'failed' });
        }
      } catch (err) {
        // A missing object is reported by the conversion itself; nothing to decide here.
      }

      await record(modelId, req.projectId, { status: 'queued' });
      startConversion(req.projectId, modelId, model);
      res.status(202).json({ status: 'queued' });
    }));

  // --- The converted file ----------------------------------------------------------------------
  app.get('/api/bim/:projectId/models/:modelId/glb',
    verifyToken,
    requireProjectAccess((req) => req.params.projectId),
    asyncHandler(async (req, res) => {
      const modelId = validId(req.params.modelId);
      if (!modelId) return res.status(400).json({ error: 'modelId must be a model id.' });

      const conversion = await conversionRow(req.projectId, modelId);
      if (!conversion || conversion.status !== 'ready' || !conversion.glb_key) {
        return res.status(409).json({ error: 'This model has not been converted yet.' });
      }

      const key = String(conversion.glb_key);
      res.setHeader('Content-Type', 'model/gltf-binary');
      res.setHeader('Content-Disposition', `inline; filename="model-${modelId}.glb"`);
      res.setHeader('Cache-Control', 'private, max-age=300');

      if (path.isAbsolute(key)) {
        const stats = await fs.promises.stat(key).catch(() => null);
        if (!stats || !stats.isFile()) {
          await record(modelId, req.projectId, { status: 'failed', error: 'The converted model file is missing. Start the conversion again.' });
          return res.status(404).json({ error: 'The converted model file is missing. Start the conversion again.' });
        }
        res.setHeader('Content-Length', stats.size);
        await pipeline(fs.createReadStream(key), res);
        return;
      }

      const size = await storage.size(key).catch(() => null);
      if (size !== null) res.setHeader('Content-Length', size);
      const body = await storage.createReadStream(key);
      await pipeline(body, res);
    }));

  return { ensureConversionSchema, startConversion, LIMITS };
}

module.exports = createBimConvertModule;
module.exports.LIMITS = LIMITS;
module.exports.tooLargeMessage = tooLargeMessage;
