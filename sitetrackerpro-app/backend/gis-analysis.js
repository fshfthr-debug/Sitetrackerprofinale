'use strict';
/**
 * GIS spatial analysis (Phase 3).
 *
 * Buffer, clip, intersect and dissolve are geometric operations, so they are computed in a
 * caller-chosen projected CRS (metres), then the result is transformed back to EPSG:4326 and
 * saved as a normal gis_dataset. Area and length are measured on the same projected geometry;
 * degrees are never used for a distance or an area.
 *
 * The JSTS npm package ships an ESM bundle only. backend-v3-enhanced.js is CommonJS, so the UMD
 * build is evaluated with a module shim rather than changing the backend's module system.
 *
 * Mounted by backend-v3-enhanced.js:
 *   createGisAnalysisModule({ app, pool, verifyToken, requireProjectAccess })
 */

const fs = require('fs');
const path = require('path');
const {
  crsDefinition,
  transformFeatureCollection
} = require('./gis-crs');
const {
  detectClearanceClashes,
  slopeGrid,
  slopeHazards,
  writeGeometry: geometryToGeoJson
} = require('./clash');
const { pixelSizesMetres } = require('./terrain');

const OPERATIONS = new Set(['buffer', 'clip', 'intersect', 'dissolve', 'measure']);
const MAX_INPUT_FEATURES = 3000;
const MAX_OUTPUT_FEATURES = 5000;
const MAX_BUFFER_METRES = 50000;

function loadJsts() {
  const file = require.resolve('jsts/dist/jsts.min.js');
  const source = fs.readFileSync(file, 'utf8');
  const shim = { exports: {} };
  // The UMD wrapper checks `exports`/`module`, so these are enough for it to populate the shim.
  new Function('exports', 'module', 'require', '__filename', '__dirname', source)(
    shim.exports,
    shim,
    require,
    file,
    path.dirname(file)
  );
  return shim.exports;
}

const jsts = loadJsts();
const reader = new jsts.io.GeoJSONReader();
const writer = new jsts.io.GeoJSONWriter();

function writeGeometry(geometry) {
  if (!geometry || geometry.isEmpty()) return null;
  const output = writer.write(geometry);
  return output && output.coordinates && output.coordinates.length > 0 ? output : null;
}

// JSTS results can be a GeometryCollection; the map's layer style understands single geometries,
// so collections are exploded into one feature per component.
function explodeGeometry(geometry) {
  if (!geometry || geometry.isEmpty()) return [];
  if (geometry.getGeometryType() === 'GeometryCollection') {
    const parts = [];
    for (let index = 0; index < geometry.getNumGeometries(); index += 1) {
      parts.push(...explodeGeometry(geometry.getGeometryN(index)));
    }
    return parts;
  }
  const written = writeGeometry(geometry);
  return written ? [written] : [];
}

// This JSTS build does not expose a working static UnaryUnionOp entry point, so geometries are
// unioned pairwise. Inputs are capped at 3,000 features, which keeps this bounded.
function unionAll(geometries) {
  if (!geometries || geometries.length === 0) return null;
  return geometries.slice(1).reduce((accumulator, geometry) => accumulator.union(geometry), geometries[0]);
}

function measureGeometry(geometry) {
  // Measurement runs on JSTS geometry in the projected CRS, so getArea()/getLength() return
  // square metres and metres for a metre-based CRS.
  const type = geometry.getGeometryType();
  if (type === 'Polygon' || type === 'MultiPolygon') {
    return { areaM2: geometry.getArea(), perimeterM: geometry.getLength(), lengthM: 0 };
  }
  if (type === 'LineString' || type === 'MultiLineString') {
    return { areaM2: 0, perimeterM: 0, lengthM: geometry.getLength() };
  }
  return { areaM2: 0, perimeterM: 0, lengthM: 0 };
}

function collectionBbox(featureCollection) {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  const walk = value => {
    if (!Array.isArray(value)) return;
    if (typeof value[0] === 'number' && typeof value[1] === 'number') {
      west = Math.min(west, value[0]); east = Math.max(east, value[0]);
      south = Math.min(south, value[1]); north = Math.max(north, value[1]);
      return;
    }
    value.forEach(walk);
  };
  (featureCollection.features || []).forEach(feature => {
    if (feature.geometry && feature.geometry.coordinates) walk(feature.geometry.coordinates);
  });
  return Number.isFinite(west) ? [west, south, east, north] : null;
}

function geometryKind(featureCollection) {
  const kinds = new Set((featureCollection.features || []).map(feature => feature.geometry && feature.geometry.type).filter(Boolean));
  for (const kind of ['Polygon', 'MultiPolygon', 'LineString', 'MultiLineString', 'Point', 'MultiPoint']) {
    if (kinds.has(kind)) return kind;
  }
  return 'Unknown';
}

const round = (value, digits = 3) => Number(Number(value).toFixed(digits));

module.exports = function createGisAnalysisModule({
  app,
  pool,
  verifyToken,
  requireProjectAccess,
  uploadDir,
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

  function datasetSummary(row) {
    return {
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      source: row.source,
      licence: row.licence,
      attribution: row.attribution,
      crs: row.crs,
      geometryType: row.geometry_type,
      featureCount: toNum(row.feature_count),
      bbox: row.bbox,
      sourceQuery: row.source_query,
      processingHistory: row.processing_history,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  async function loadDataset(projectId, datasetId) {
    const result = await pool.query(
      'SELECT * FROM gis_datasets WHERE project_id = $1 AND id = $2',
      [projectId, datasetId]
    );
    return result.rows[0] || null;
  }

  function projectedCrs(code) {
    const definition = crsDefinition(code);
    if (!definition) return { error: `Unsupported CRS ${code}. Choose one from GET /api/gis/crs.` };
    if (definition.units !== 'metres') {
      return { error: `${definition.code} is geographic. Spatial analysis needs a projected CRS in metres, such as EPSG:32637.` };
    }
    // Web Mercator distances are scale-distorted away from the standard parallels; allow the UTM
    // zones the CRS registry offers instead of silently producing wrong areas.
    if (definition.code === 'EPSG:3857') {
      return { error: 'EPSG:3857 is a display projection and distorts distance and area. Choose a UTM zone such as EPSG:32637.' };
    }
    return { definition };
  }

  function readFeatures(row, crsCode) {
    const storedCrs = crsDefinition(row.crs) ? row.crs : 'EPSG:4326';
    const projected = transformFeatureCollection(row.geojson, storedCrs, crsCode);
    const features = projected.features || [];
    if (features.length === 0) throw new Error('The input dataset has no features.');
    if (features.length > MAX_INPUT_FEATURES) throw new Error(`Analysis is limited to ${MAX_INPUT_FEATURES} input features.`);

    return features.map((feature, index) => {
      if (!feature.geometry || !feature.geometry.coordinates) {
        throw new Error(`Feature ${index + 1} has no geometry.`);
      }
      let geometry;
      try {
        geometry = reader.read(feature.geometry);
      } catch (err) {
        throw new Error(`Feature ${index + 1} is not valid: ${err.message}`);
      }
      return { geometry, properties: feature.properties || {} };
    });
  }

  async function saveResult({ projectId, name, operation, crs, inputRows, parameters, features, metrics }) {
    if (features.length === 0) throw new Error('The operation produced no features. Check the inputs and parameters.');
    if (features.length > MAX_OUTPUT_FEATURES) {
      throw new Error(`The result has ${features.length} features; the limit is ${MAX_OUTPUT_FEATURES}. Use a smaller input or clip first.`);
    }

    const featureCollection = { type: 'FeatureCollection', features };
    const bbox = collectionBbox(featureCollection);
    const history = [{
      at: new Date().toISOString(),
      action: 'analysis',
      operation,
      inputs: inputRows.map(row => ({ id: row.id, name: row.name, crs: row.crs })),
      computationCrs: crs,
      parameters,
      featureCount: features.length,
      metrics: metrics || null,
      note: `Spatial analysis (${operation}) computed in ${crs}; result stored as EPSG:4326. No datum grid shift was applied.`
    }];

    const result = await pool.query(
      `INSERT INTO gis_datasets
         (project_id, name, source, source_query, licence, attribution, crs, geometry_type,
          feature_count, bbox, geojson, processing_history)
       VALUES ($1, $2, $3, $4, $5, $6, 'EPSG:4326', $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        projectId,
        name,
        `Spatial analysis (${operation})`,
        JSON.stringify({ operation, computationCrs: crs, parameters, inputs: inputRows.map(row => row.id) }),
        'Derived from project datasets',
        inputRows.map(row => row.attribution).filter(Boolean).join(' / ').slice(0, 500),
        geometryKind(featureCollection),
        features.length,
        JSON.stringify(bbox),
        JSON.stringify(featureCollection),
        JSON.stringify(history)
      ]
    );

    return result.rows[0];
  }

  app.post('/api/gis/analysis/:projectId', verifyToken, requireProjectAccess(req => req.params.projectId), asyncHandler(async (req, res) => {
    const projectId = Number(req.projectId);
    const operation = String(req.body.operation || '').toLowerCase();
    if (!OPERATIONS.has(operation)) {
      return res.status(400).json({ error: `operation must be one of: ${[...OPERATIONS].join(', ')}.` });
    }

    const crs = projectedCrs(req.body.crs);
    if (crs.error) return res.status(400).json({ error: crs.error });

    const inputId = Number(req.body.inputDatasetId);
    if (!Number.isFinite(inputId)) return res.status(400).json({ error: 'inputDatasetId is required.' });
    const input = await loadDataset(projectId, inputId);
    if (!input) return res.status(404).json({ error: 'Input dataset not found for this project.' });

    let overlay = null;
    if (['clip', 'intersect'].includes(operation)) {
      const overlayId = Number(req.body.overlayDatasetId);
      if (!Number.isFinite(overlayId)) {
        return res.status(400).json({ error: `${operation} needs overlayDatasetId (the clip/mask dataset).` });
      }
      overlay = await loadDataset(projectId, overlayId);
      if (!overlay) return res.status(404).json({ error: 'Overlay dataset not found for this project.' });
    }

    let inputFeatures;
    let overlayFeatures = null;
    try {
      inputFeatures = readFeatures(input, crs.definition.code);
      if (overlay) overlayFeatures = readFeatures(overlay, crs.definition.code);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    const parameters = { crs: crs.definition.code };
    let resultFeatures = [];
    let metrics = null;

    try {
      if (operation === 'buffer') {
        const distance = Number(req.body.distance);
        if (!Number.isFinite(distance) || distance <= 0) {
          return res.status(400).json({ error: 'Buffer distance must be a positive number of metres.' });
        }
        if (distance > MAX_BUFFER_METRES) {
          return res.status(400).json({ error: `Buffer distance is limited to ${MAX_BUFFER_METRES} metres.` });
        }
        parameters.distanceMetres = distance;

        inputFeatures.forEach(({ geometry, properties }) => {
          if (geometry.isEmpty()) return;
          const buffered = geometry.buffer(distance);
          explodeGeometry(buffered).forEach(part => {
            resultFeatures.push({
              type: 'Feature',
              properties: { ...properties, buffer_m: distance },
              geometry: part
            });
          });
        });
      } else if (operation === 'clip' || operation === 'intersect') {
        if (!overlayFeatures || overlayFeatures.length === 0) throw new Error('The overlay dataset has no usable features.');

        const overlayGeometries = overlayFeatures.map(feature => feature.geometry);
        if (!overlayGeometries.every(geometry => ['Polygon', 'MultiPolygon'].includes(geometry.getGeometryType()))) {
          return res.status(400).json({ error: `${operation} needs an overlay of polygons (a boundary, parcel or study-area mask).` });
        }

        const mask = unionAll(overlayGeometries);
        parameters.overlayDatasetId = overlay.id;

        if (operation === 'clip') {
          inputFeatures.forEach(({ geometry, properties }) => {
            const clipped = geometry.intersection(mask);
            explodeGeometry(clipped).forEach(part => {
              resultFeatures.push({
                type: 'Feature',
                properties: { ...properties },
                geometry: part
              });
            });
          });
        } else {
          inputFeatures.forEach(({ geometry, properties }) => {
            overlayFeatures.forEach(({ geometry: overlayGeometry, properties: overlayProperties }) => {
              const intersection = geometry.intersection(overlayGeometry);
              explodeGeometry(intersection).forEach(part => {
                resultFeatures.push({
                  type: 'Feature',
                  properties: { ...properties, ...overlayProperties },
                  geometry: part
                });
              });
            });
          });
        }
      } else if (operation === 'dissolve') {
        const by = req.body.dissolveBy ? String(req.body.dissolveBy) : '';
        if (by) parameters.dissolveBy = by;
        const groups = new Map();

        inputFeatures.forEach(({ geometry, properties }) => {
          if (!['Polygon', 'MultiPolygon'].includes(geometry.getGeometryType())) return;
          const key = by ? String(properties[by] === undefined || properties[by] === null ? '' : properties[by]) : '__all__';
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(geometry);
        });

        if (groups.size === 0) {
          return res.status(400).json({ error: 'dissolve needs polygon features; this dataset has none.' });
        }

        groups.forEach((geometries, key) => {
          const dissolved = unionAll(geometries);
          explodeGeometry(dissolved).forEach(part => {
            resultFeatures.push({
              type: 'Feature',
              properties: by ? { [by]: key, feature_count: geometries.length } : { dissolved: true, feature_count: geometries.length },
              geometry: part
            });
          });
        });
      } else {
        // measure: keep one feature per input, with planar metrics computed in the projected CRS.
        const totals = { areaM2: 0, perimeterM: 0, lengthM: 0 };
        const perFeature = [];
        inputFeatures.forEach(({ geometry, properties }, index) => {
          const measured = measureGeometry(geometry);
          totals.areaM2 += measured.areaM2;
          totals.perimeterM += measured.perimeterM;
          totals.lengthM += measured.lengthM;
          perFeature.push({
            index: index + 1,
            properties,
            areaM2: round(measured.areaM2),
            perimeterM: round(measured.perimeterM),
            lengthM: round(measured.lengthM)
          });

          const written = writeGeometry(geometry);
          if (written) {
            resultFeatures.push({
              type: 'Feature',
              properties: {
                ...properties,
                area_m2: round(measured.areaM2),
                perimeter_m: round(measured.perimeterM),
                length_m: round(measured.lengthM)
              },
              geometry: written
            });
          }
        });
        metrics = {
          areaM2: round(totals.areaM2),
          perimeterM: round(totals.perimeterM),
          lengthM: round(totals.lengthM),
          features: perFeature.slice(0, 100)
        };
        parameters.measure = 'area and length in projected metres';
      }
    } catch (err) {
      return res.status(400).json({ error: `Analysis failed: ${err.message}` });
    }

    if (resultFeatures.length === 0) {
      return res.status(400).json({ error: 'The operation produced no features. Check the inputs and parameters.' });
    }

    let stored;
    try {
      const transformed = transformFeatureCollection(
        { type: 'FeatureCollection', features: resultFeatures },
        crs.definition.code,
        'EPSG:4326'
      );
      const defaultLabel = {
        buffer: `Buffer ${parameters.distanceMetres} m`,
        clip: 'Clip',
        intersect: 'Intersect',
        dissolve: 'Dissolve',
        measure: 'Measurements'
      }[operation];
      const name = String(req.body.name || `${defaultLabel} — ${input.name}`).trim().slice(0, 200)
        || `${defaultLabel} — ${input.name}`;

      stored = await saveResult({
        projectId,
        name,
        operation,
        crs: crs.definition.code,
        inputRows: overlay ? [input, overlay] : [input],
        parameters,
        features: transformed.features,
        metrics
      });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    res.status(201).json({
      operation,
      computationCrs: crs.definition.code,
      outputFeatureCount: resultFeatures.length,
      metrics,
      dataset: datasetSummary(stored)
    });
  }));

  // ---------------------------------------------------------------------------
  // Clash and encroachment check.
  //
  // Clearance mode compares every feature of one dataset with every feature of another in a
  // metre CRS and reports the pairs within the clearance distance. Slope mode samples the
  // survey's preview DEM and flags features standing on terrain steeper than a threshold.
  // Both return warning-zone geometries in EPSG:4326 for the map to highlight.
  // ---------------------------------------------------------------------------
  app.post('/api/projects/:id/analysis/clash-check', verifyToken, requireProjectAccess(req => req.params.id), asyncHandler(async (req, res) => {
    const projectId = Number(req.projectId);
    const layerId = Number(req.body.layerDatasetId);
    if (!Number.isFinite(layerId)) {
      return res.status(400).json({ error: 'layerDatasetId is required (the layer being checked).' });
    }
    const layer = await loadDataset(projectId, layerId);
    if (!layer) return res.status(404).json({ error: 'Layer dataset not found for this project.' });

    const slopeSurveyId = req.body.terrainSurveyId === undefined || req.body.terrainSurveyId === null || req.body.terrainSurveyId === ''
      ? null
      : Number(req.body.terrainSurveyId);

    let workingCrs;
    let clashInput;

    if (slopeSurveyId !== null) {
      // Slope hazards are measured on the DEM, so the working CRS is the survey's own CRS.
      if (!Number.isFinite(slopeSurveyId)) return res.status(400).json({ error: 'terrainSurveyId must be a survey id.' });
      const threshold = Number(req.body.slopeThresholdDegrees);
      if (!Number.isFinite(threshold) || threshold <= 0 || threshold >= 90) {
        return res.status(400).json({ error: 'slopeThresholdDegrees must be between 0 and 90.' });
      }

      const surveyResult = await pool.query(
        'SELECT * FROM terrain_surveys WHERE id = $1 AND project_id = $2',
        [slopeSurveyId, projectId]
      );
      const survey = surveyResult.rows[0];
      if (!survey) return res.status(404).json({ error: 'Terrain survey not found for this project.' });
      if (survey.status !== 'ready' || !survey.preview_key) {
        return res.status(409).json({ error: `This survey is ${survey.status}.` });
      }

      const surveyCrs = crsDefinition(survey.crs);
      if (!surveyCrs || surveyCrs.units !== 'metres') {
        return res.status(400).json({ error: 'This survey is not in a metre CRS, so slope cannot be measured.' });
      }
      workingCrs = surveyCrs;

      const previewPath = path.join(uploadDir || path.join(__dirname, 'uploads'), survey.preview_key);
      let buffer;
      try {
        buffer = await fs.promises.readFile(previewPath);
      } catch (err) {
        return res.status(409).json({ error: 'The survey preview grid is not available on this server.' });
      }
      const width = Number(survey.preview_width);
      const height = Number(survey.preview_height);
      const grid = new Float32Array(width * height);
      for (let i = 0; i < grid.length; i += 1) grid[i] = buffer.readFloatLE(i * 4);

      const metres = pixelSizesMetres(
        survey.bounds,
        surveyCrs,
        Number(survey.width),
        Number(survey.height),
        Number(survey.pixel_size_x),
        Number(survey.pixel_size_y)
      );
      const dx = (metres.dx * Number(survey.width)) / width;
      const dy = (metres.dy * Number(survey.height)) / height;
      const slope = slopeGrid({ grid, width, height, dx, dy });

      let features;
      try {
        features = readFeatures(layer, surveyCrs.code || survey.crs)
          .map(item => ({ properties: item.properties, geometry: geometryToGeoJson(item.geometry) }))
          .filter(item => item.geometry);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }

      let hazards;
      try {
        hazards = slopeHazards({
          features,
          crsBounds: survey.bounds,
          slope,
          width,
          height,
          thresholdDegrees: threshold
        });
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }

      clashInput = {
        mode: 'slope',
        threshold,
        surveyId: survey.id,
        clashes: hazards.clashes,
        testedPairs: hazards.testedPairs,
        truncated: hazards.truncated
      };
    } else {
      const clearance = Number(req.body.clearanceMetres);
      if (!Number.isFinite(clearance) || clearance < 0) {
        return res.status(400).json({ error: 'clearanceMetres is required (0 or more metres).' });
      }
      const obstacleId = Number(req.body.obstacleDatasetId);
      if (!Number.isFinite(obstacleId)) {
        return res.status(400).json({ error: 'obstacleDatasetId is required (the corridor or asset layer).' });
      }
      const obstacle = await loadDataset(projectId, obstacleId);
      if (!obstacle) return res.status(404).json({ error: 'Obstacle dataset not found for this project.' });

      const crs = projectedCrs(req.body.crs || 'EPSG:32637');
      if (crs.error) return res.status(400).json({ error: crs.error });
      workingCrs = crs.definition;

      let layerFeatures;
      let obstacleFeatures;
      try {
        layerFeatures = readFeatures(layer, workingCrs.code).map(item => ({
          properties: item.properties,
          geometry: geometryToGeoJson(item.geometry)
        })).filter(item => item.geometry);
        obstacleFeatures = readFeatures(obstacle, workingCrs.code).map(item => ({
          properties: item.properties,
          geometry: geometryToGeoJson(item.geometry)
        })).filter(item => item.geometry);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }

      let found;
      try {
        found = detectClearanceClashes({
          layerFeatures,
          obstacleFeatures,
          clearanceMetres: clearance
        });
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }

      clashInput = {
        mode: 'clearance',
        clearance,
        obstacleId: obstacle.id,
        obstacleName: obstacle.name,
        clashes: found.clashes,
        testedPairs: found.testedPairs,
        truncated: found.truncated
      };
    }

    // Warning zones go back to WGS 84 so the map can render them without reprojecting.
    let clashes = clashInput.clashes;
    try {
      const zones = clashes.filter(clash => clash.geometry).map(clash => ({
        type: 'Feature',
        properties: {
          clash_id: clash.id,
          severity: clash.severity,
          layer_label: clash.layerLabel,
          obstacle_label: clash.obstacleLabel,
          distance_m: clash.distanceM,
          slope_deg: clash.slopeDeg || null
        },
        geometry: clash.geometry
      }));
      if (zones.length > 0) {
        const transformed = transformFeatureCollection(
          { type: 'FeatureCollection', features: zones },
          workingCrs.code,
          'EPSG:4326'
        );
        const byId = new Map(transformed.features.map(feature => [feature.properties.clash_id, feature.geometry]));
        clashes = clashes.map(clash => ({ ...clash, geometry: byId.get(clash.id) || null }));
      }
    } catch (err) {
      return res.status(400).json({ error: `The clash zones could not be reprojected: ${err.message}` });
    }

    res.json({
      mode: clashInput.mode,
      crs: workingCrs.code,
      clearanceMetres: clashInput.mode === 'clearance' ? clashInput.clearance : null,
      slopeThresholdDegrees: clashInput.mode === 'slope' ? clashInput.threshold : null,
      terrainSurveyId: clashInput.surveyId || null,
      layer: { id: layer.id, name: layer.name },
      obstacle: clashInput.obstacleId ? { id: clashInput.obstacleId, name: clashInput.obstacleName } : null,
      clashCount: clashes.length,
      testedPairs: clashInput.testedPairs,
      truncated: Boolean(clashInput.truncated),
      clashes,
      checkedAt: new Date().toISOString(),
      note: 'Clearance is measured edge to edge between features in ' + workingCrs.code + '. Slope is sampled from the survey preview grid, which is a visualisation aid; verify steep areas against the survey before acting.'
    });
  }));
};
