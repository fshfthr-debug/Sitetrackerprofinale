'use strict';
/**
 * GIS workspaces and layers (Phase 1).
 *
 * A GIS workspace is a saved map view inside a SiteTrackerPro project: working CRS, basemap and an
 * ordered layer stack that references datasets, DEM surveys or the project's survey control points.
 * It is deliberately a separate module from gis.js so the map workspace can evolve without touching
 * the OSM/CRS/dataset endpoints.
 *
 * Mounted by backend-v3-enhanced.js:
 *   createGisWorkspaceModule({ app, pool, verifyToken, requireProjectAccess })
 */

const MAX_LAYERS = 50;
const MAX_VIEW_BYTES = 20000;
const MAX_STYLE_BYTES = 8000;

const LAYER_KINDS = new Set(['dataset', 'terrain', 'survey']);
const KINDS_REQUIRING_DATASET = new Set(['dataset']);
const KINDS_REQUIRING_TERRAIN = new Set(['terrain']);

module.exports = function createGisWorkspaceModule({
  app,
  pool,
  verifyToken,
  requireProjectAccess,
  serverError = (res, where, err) => {
    console.error(`${where} failed:`, err.message || err);
    if (!res.headersSent) res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
  },
  toNum = (value, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
}) {
  const asyncHandler = fn => (req, res) => fn(req, res).catch(err => serverError(res, `${req.method} ${req.path}`, err));

  async function ensureGisWorkspaceSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS gis_projects (
        id SERIAL PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name VARCHAR(160) NOT NULL,
        description TEXT,
        working_crs VARCHAR(40) NOT NULL DEFAULT 'EPSG:4326',
        vertical_datum VARCHAR(80),
        view_state JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_by INTEGER REFERENCES users(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS gis_layers (
        id SERIAL PRIMARY KEY,
        gis_project_id INTEGER NOT NULL REFERENCES gis_projects(id) ON DELETE CASCADE,
        name VARCHAR(160) NOT NULL,
        kind VARCHAR(24) NOT NULL,
        dataset_id INTEGER REFERENCES gis_datasets(id) ON DELETE SET NULL,
        terrain_id INTEGER REFERENCES terrain_surveys(id) ON DELETE SET NULL,
        source_ref JSONB,
        style JSONB NOT NULL DEFAULT '{}'::jsonb,
        opacity NUMERIC(4,3) NOT NULL DEFAULT 1,
        visible BOOLEAN NOT NULL DEFAULT TRUE,
        z_index INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_gis_projects_project ON gis_projects(project_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_gis_layers_workspace ON gis_layers(gis_project_id, z_index)');
  }

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------
  function cleanName(value, fallback) {
    const name = String(value === undefined || value === null ? fallback : value).trim();
    return name.slice(0, 160);
  }

  function parseCrs(value) {
    const crs = String(value || 'EPSG:4326').trim().toUpperCase();
    if (!/^EPSG:\d{4,6}$/.test(crs)) return null;
    return crs;
  }

  // The view state is small and must stay small: no arbitrary blobs in the database.
  function cleanViewState(value) {
    if (value === undefined || value === null) return {};
    if (typeof value !== 'object' || Array.isArray(value)) throw new Error('viewState must be an object.');
    const encoded = JSON.stringify(value);
    if (encoded.length > MAX_VIEW_BYTES) throw new Error('viewState is too large.');

    const state = {};
    if (Array.isArray(value.center) && value.center.length === 2
      && value.center.every(number => Number.isFinite(Number(number)))) {
      const lon = Number(value.center[0]);
      const lat = Number(value.center[1]);
      if (lon < -180 || lon > 180 || lat < -90 || lat > 90) throw new Error('viewState.center is outside longitude/latitude bounds.');
      state.center = [lon, lat];
    }
    if (value.zoom !== undefined) {
      const zoom = Number(value.zoom);
      if (!Number.isFinite(zoom) || zoom < 0 || zoom > 22) throw new Error('viewState.zoom must be between 0 and 22.');
      state.zoom = zoom;
    }
    if (value.bearing !== undefined) state.bearing = ((toNum(value.bearing) % 360) + 360) % 360;
    if (value.pitch !== undefined) state.pitch = Math.min(85, Math.max(0, toNum(value.pitch)));
    if (value.basemap !== undefined) state.basemap = String(value.basemap).slice(0, 80);
    return state;
  }

  function cleanStyle(value) {
    if (value === undefined || value === null) return {};
    if (typeof value !== 'object' || Array.isArray(value)) throw new Error('style must be an object.');
    const encoded = JSON.stringify(value);
    if (encoded.length > MAX_STYLE_BYTES) throw new Error('style is too large.');
    const style = {};
    if (value.color !== undefined) {
      const colour = String(value.color);
      if (!/^#[0-9a-fA-F]{3,8}$/.test(colour)) throw new Error('style.color must be a hex colour.');
      style.color = colour;
    }
    if (value.lineWidth !== undefined) style.lineWidth = Math.min(20, Math.max(0.5, toNum(value.lineWidth, 1)));
    if (value.fillOpacity !== undefined) style.fillOpacity = Math.min(1, Math.max(0, toNum(value.fillOpacity, 0.28)));
    if (value.pointSize !== undefined) style.pointSize = Math.min(30, Math.max(2, toNum(value.pointSize, 5)));
    return style;
  }

  const summary = row => ({
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description,
    workingCrs: row.working_crs,
    verticalDatum: row.vertical_datum,
    viewState: row.view_state || {},
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    layerCount: row.layer_count === undefined ? undefined : toNum(row.layer_count)
  });

  const layerSummary = row => ({
    id: row.id,
    workspaceId: row.gis_project_id,
    name: row.name,
    kind: row.kind,
    datasetId: row.dataset_id,
    terrainId: row.terrain_id,
    sourceRef: row.source_ref,
    style: row.style || {},
    opacity: row.opacity === null ? 1 : toNum(row.opacity, 1),
    visible: row.visible,
    zIndex: row.z_index,
    createdAt: row.created_at
  });

  async function loadWorkspace(projectId, workspaceId) {
    const result = await pool.query('SELECT * FROM gis_projects WHERE project_id = $1 AND id = $2', [projectId, workspaceId]);
    return result.rows[0] || null;
  }

  async function workspacePayload(workspace) {
    const layers = await pool.query(
      'SELECT * FROM gis_layers WHERE gis_project_id = $1 ORDER BY z_index ASC, id ASC',
      [workspace.id]
    );
    return { ...summary(workspace), layers: layers.rows.map(layerSummary) };
  }

  async function validateLayerReferences(projectId, body) {
    if (body.datasetId !== undefined && body.datasetId !== null) {
      const dataset = await pool.query('SELECT id FROM gis_datasets WHERE id = $1 AND project_id = $2', [body.datasetId, projectId]);
      if (dataset.rows.length === 0) return { error: 'Dataset not found for this project.' };
    }
    if (body.terrainId !== undefined && body.terrainId !== null) {
      const terrain = await pool.query('SELECT id FROM terrain_surveys WHERE id = $1 AND project_id = $2', [body.terrainId, projectId]);
      if (terrain.rows.length === 0) return { error: 'Terrain survey not found for this project.' };
    }
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // Workspaces
  // ---------------------------------------------------------------------------
  app.get('/api/gis/workspaces/:projectId', verifyToken, requireProjectAccess(req => req.params.projectId), asyncHandler(async (req, res) => {
    const result = await pool.query(
      `SELECT w.*, (SELECT COUNT(*) FROM gis_layers l WHERE l.gis_project_id = w.id) AS layer_count
         FROM gis_projects w
        WHERE w.project_id = $1
        ORDER BY w.updated_at DESC, w.id DESC`,
      [req.projectId]
    );
    res.json(result.rows.map(summary));
  }));

  app.post('/api/gis/workspaces/:projectId', verifyToken, requireProjectAccess(req => req.params.projectId), asyncHandler(async (req, res) => {
    const name = cleanName(req.body.name, '');
    if (!name) return res.status(400).json({ error: 'A workspace name is required.' });

    const workingCrs = parseCrs(req.body.workingCrs);
    if (!workingCrs) return res.status(400).json({ error: 'workingCrs must be an EPSG code such as EPSG:4326.' });

    let viewState;
    try {
      viewState = cleanViewState(req.body.viewState);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    const result = await pool.query(
      `INSERT INTO gis_projects (project_id, name, description, working_crs, vertical_datum, view_state, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        req.projectId,
        name,
        req.body.description ? String(req.body.description).slice(0, 2000) : null,
        workingCrs,
        req.body.verticalDatum ? String(req.body.verticalDatum).slice(0, 80) : null,
        JSON.stringify(viewState),
        req.userId
      ]
    );

    res.status(201).json(await workspacePayload(result.rows[0]));
  }));

  app.get('/api/gis/workspaces/:projectId/:workspaceId', verifyToken, requireProjectAccess(req => req.params.projectId), asyncHandler(async (req, res) => {
    const workspace = await loadWorkspace(req.projectId, req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'GIS workspace not found for this project.' });
    res.json(await workspacePayload(workspace));
  }));

  app.put('/api/gis/workspaces/:projectId/:workspaceId', verifyToken, requireProjectAccess(req => req.params.projectId), asyncHandler(async (req, res) => {
    const workspace = await loadWorkspace(req.projectId, req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'GIS workspace not found for this project.' });

    let viewState = workspace.view_state || {};
    try {
      if (req.body.viewState !== undefined) viewState = cleanViewState(req.body.viewState);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    const workingCrs = req.body.workingCrs === undefined ? workspace.working_crs : parseCrs(req.body.workingCrs);
    if (!workingCrs) return res.status(400).json({ error: 'workingCrs must be an EPSG code such as EPSG:4326.' });

    const result = await pool.query(
      `UPDATE gis_projects
          SET name = $3, description = $4, working_crs = $5, vertical_datum = $6, view_state = $7,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND project_id = $2
        RETURNING *`,
      [
        workspace.id,
        req.projectId,
        req.body.name === undefined ? workspace.name : (cleanName(req.body.name, workspace.name) || workspace.name),
        req.body.description === undefined ? workspace.description : String(req.body.description).slice(0, 2000),
        workingCrs,
        req.body.verticalDatum === undefined ? workspace.vertical_datum : String(req.body.verticalDatum).slice(0, 80),
        JSON.stringify(viewState)
      ]
    );

    res.json(await workspacePayload(result.rows[0]));
  }));

  app.delete('/api/gis/workspaces/:projectId/:workspaceId', verifyToken, requireProjectAccess(req => req.params.projectId), asyncHandler(async (req, res) => {
    const result = await pool.query('DELETE FROM gis_projects WHERE id = $1 AND project_id = $2', [req.params.workspaceId, req.projectId]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'GIS workspace not found for this project.' });
    res.json({ success: true, deleted: 1 });
  }));

  // ---------------------------------------------------------------------------
  // Layers. `/layers/order` is registered before `/:layerId` so it is not read as an id.
  // ---------------------------------------------------------------------------
  app.put('/api/gis/workspaces/:projectId/:workspaceId/layers/order', verifyToken, requireProjectAccess(req => req.params.projectId), asyncHandler(async (req, res) => {
    const workspace = await loadWorkspace(req.projectId, req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'GIS workspace not found for this project.' });

    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(id => Number(id)).filter(Number.isFinite) : null;
    if (!ids || ids.length === 0) return res.status(400).json({ error: 'ids must be a non-empty array of layer ids.' });

    const owned = await pool.query('SELECT id FROM gis_layers WHERE gis_project_id = $1', [workspace.id]);
    const ownedIds = new Set(owned.rows.map(row => row.id));
    if (ids.length !== ownedIds.size || ids.some(id => !ownedIds.has(id))) {
      return res.status(400).json({ error: 'The order must contain every layer of this workspace exactly once.' });
    }

    // One client for the whole transaction: a pool may hand each query a different connection.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (let index = 0; index < ids.length; index += 1) {
        await client.query('UPDATE gis_layers SET z_index = $1 WHERE id = $2 AND gis_project_id = $3', [index, ids[index], workspace.id]);
      }
      await client.query('UPDATE gis_projects SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [workspace.id]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    res.json(await workspacePayload(workspace));
  }));

  app.post('/api/gis/workspaces/:projectId/:workspaceId/layers', verifyToken, requireProjectAccess(req => req.params.projectId), asyncHandler(async (req, res) => {
    const workspace = await loadWorkspace(req.projectId, req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'GIS workspace not found for this project.' });

    const kind = String(req.body.kind || '').toLowerCase();
    if (!LAYER_KINDS.has(kind)) {
      return res.status(400).json({ error: `kind must be one of: ${[...LAYER_KINDS].join(', ')}.` });
    }
    if (KINDS_REQUIRING_DATASET.has(kind) && !req.body.datasetId) {
      return res.status(400).json({ error: 'A dataset layer needs a datasetId.' });
    }
    if (KINDS_REQUIRING_TERRAIN.has(kind) && !req.body.terrainId) {
      return res.status(400).json({ error: 'A terrain layer needs a terrainId.' });
    }

    const count = await pool.query('SELECT COUNT(*)::int AS count FROM gis_layers WHERE gis_project_id = $1', [workspace.id]);
    if (toNum(count.rows[0].count) >= MAX_LAYERS) {
      return res.status(400).json({ error: `A workspace is limited to ${MAX_LAYERS} layers.` });
    }

    const references = await validateLayerReferences(req.projectId, req.body);
    if (references.error) return res.status(404).json({ error: references.error });

    let style;
    try {
      style = cleanStyle(req.body.style);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    const nextIndex = await pool.query('SELECT COALESCE(MAX(z_index), -1) + 1 AS next FROM gis_layers WHERE gis_project_id = $1', [workspace.id]);

    const result = await pool.query(
      `INSERT INTO gis_layers (gis_project_id, name, kind, dataset_id, terrain_id, source_ref, style, opacity, visible, z_index)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        workspace.id,
        cleanName(req.body.name, kind === 'survey' ? 'Survey control points' : kind === 'terrain' ? 'DEM hillshade' : 'Dataset'),
        kind,
        req.body.datasetId || null,
        req.body.terrainId || null,
        req.body.sourceRef ? JSON.stringify(req.body.sourceRef) : null,
        JSON.stringify(style),
        Math.min(1, Math.max(0, toNum(req.body.opacity, 1))),
        req.body.visible === undefined ? true : Boolean(req.body.visible),
        toNum(nextIndex.rows[0].next)
      ]
    );

    await pool.query('UPDATE gis_projects SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [workspace.id]);
    res.status(201).json(layerSummary(result.rows[0]));
  }));

  app.put('/api/gis/workspaces/:projectId/:workspaceId/layers/:layerId', verifyToken, requireProjectAccess(req => req.params.projectId), asyncHandler(async (req, res) => {
    const workspace = await loadWorkspace(req.projectId, req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'GIS workspace not found for this project.' });

    const current = await pool.query('SELECT * FROM gis_layers WHERE id = $1 AND gis_project_id = $2', [req.params.layerId, workspace.id]);
    if (current.rows.length === 0) return res.status(404).json({ error: 'Layer not found in this workspace.' });
    const layer = current.rows[0];

    let style = layer.style || {};
    if (req.body.style !== undefined) {
      try {
        style = cleanStyle(req.body.style);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
    }

    const result = await pool.query(
      `UPDATE gis_layers
          SET name = $3, style = $4, opacity = $5, visible = $6, z_index = $7
        WHERE id = $1 AND gis_project_id = $2
        RETURNING *`,
      [
        layer.id,
        workspace.id,
        req.body.name === undefined ? layer.name : (cleanName(req.body.name, layer.name) || layer.name),
        JSON.stringify(style),
        req.body.opacity === undefined ? layer.opacity : Math.min(1, Math.max(0, toNum(req.body.opacity, 1))),
        req.body.visible === undefined ? layer.visible : Boolean(req.body.visible),
        req.body.zIndex === undefined ? layer.z_index : toNum(req.body.zIndex, layer.z_index)
      ]
    );

    await pool.query('UPDATE gis_projects SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [workspace.id]);
    res.json(layerSummary(result.rows[0]));
  }));

  app.delete('/api/gis/workspaces/:projectId/:workspaceId/layers/:layerId', verifyToken, requireProjectAccess(req => req.params.projectId), asyncHandler(async (req, res) => {
    const workspace = await loadWorkspace(req.projectId, req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'GIS workspace not found for this project.' });

    const result = await pool.query('DELETE FROM gis_layers WHERE id = $1 AND gis_project_id = $2', [req.params.layerId, workspace.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Layer not found in this workspace.' });

    await pool.query('UPDATE gis_projects SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [workspace.id]);
    res.json({ success: true, deleted: 1 });
  }));

  return { ensureGisWorkspaceSchema, MAX_LAYERS };
};

module.exports.LAYER_KINDS = LAYER_KINDS;
module.exports.MAX_LAYERS = MAX_LAYERS;
