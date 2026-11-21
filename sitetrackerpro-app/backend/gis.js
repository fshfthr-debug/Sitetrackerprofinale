'use strict';
/**
 * GIS & Geospatial Intelligence module.
 *
 * OpenStreetMap features are fetched from Overpass, converted to GeoJSON and stored per
 * project with their provenance (source, licence, attribution, CRS, geometry type, import
 * date and processing history). Coordinates are only transformed between CRSs the caller
 * names explicitly — nothing here guesses a zone, a unit or a vertical datum.
 *
 * Mounted by backend-v3-enhanced.js:
 *   createGisModule({ app, pool, verifyToken, requireProjectAccess, serverError, toNum })
 */

const crypto = require('crypto');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const {
  crsDefinition,
  listCrs,
  isGeographic,
  transformPoint,
  transformFeatureCollection
} = require('./gis-crs');

// ---------------------------------------------------------------------------
// Attribution and sources. OSM data is ODbL 1.0: it must be attributed wherever shown,
// and derivative databases carry the same licence.
// ---------------------------------------------------------------------------
const OSM_ATTRIBUTION = '© OpenStreetMap contributors';
const OSM_LICENCE = 'ODbL 1.0 (OpenStreetMap)';
const OSM_SOURCE = 'OpenStreetMap (via Overpass API)';

const DEFAULTS = {
  overpassUrl: process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter',
  // Public Overpass instances are individually overloaded at times; a query falls through
  // this list rather than failing the user's import.
  // An explicitly empty OVERPASS_FALLBACKS disables the public mirrors (useful when the
  // installation runs its own Overpass and must not call anyone else's).
  overpassFallbacks: (process.env.OVERPASS_FALLBACKS !== undefined
    ? process.env.OVERPASS_FALLBACKS
    : 'https://overpass.kumi.systems/api/interpreter,https://overpass.private.coffee/api/interpreter')
    .split(',').map(value => value.trim()).filter(Boolean),
  nominatimUrl: process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org',
  userAgent: process.env.OSM_USER_AGENT || 'SiteTrackerPro/3.0 GIS (+https://sitetrackerpro.app)',
  // Public Overpass instances are shared infrastructure: cap the work one request can cause.
  maxAreaDeg2: Number(process.env.GIS_MAX_AREA_DEG2 || 0.02),
  maxFeatures: Number(process.env.GIS_MAX_FEATURES || 3000),
  requestTimeoutMs: Number(process.env.GIS_OVERPASS_TIMEOUT_MS || 45000),
  cacheHours: Number(process.env.GIS_CACHE_HOURS || 24),
  // OSM's public tile servers are not for heavy commercial use; the frontend uses this
  // URL and shows the attribution. Point it at your own tiles or a paid provider to scale.
  tileUrl: process.env.GIS_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
};

// OSM tags per import category. Deliberately a fixed, documented list: an arbitrary tag
// query would let one request pull an unbounded slice of the planet.
const CATEGORIES = [
  { key: 'roads', label: 'Roads and streets', filters: [{ k: 'highway' }], geometry: 'LineString' },
  { key: 'railways', label: 'Railways', filters: [{ k: 'railway' }], geometry: 'LineString' },
  { key: 'buildings', label: 'Buildings and footprints', filters: [{ k: 'building' }], geometry: 'Polygon' },
  { key: 'waterways', label: 'Rivers and streams', filters: [{ k: 'waterway' }], geometry: 'LineString' },
  { key: 'water', label: 'Lakes and reservoirs', filters: [{ k: 'natural', v: 'water' }], geometry: 'Polygon' },
  {
    key: 'bridges',
    label: 'Bridges and infrastructure',
    filters: [{ k: 'bridge' }, { k: 'man_made', v: 'bridge' }, { k: 'tunnel' }],
    geometry: 'LineString'
  },
  { key: 'landuse', label: 'Land use', filters: [{ k: 'landuse' }], geometry: 'Polygon' },
  { key: 'power', label: 'Power lines and towers', filters: [{ k: 'power' }], geometry: 'LineString' }
];

const CATEGORY_BY_KEY = new Map(CATEGORIES.map(category => [category.key, category]));

// ---------------------------------------------------------------------------
// Geometry helpers (no PostGIS: the database has no geometry columns and adding it would
// mean a GPL server extension; GeoJSON is stored as JSONB instead).
// ---------------------------------------------------------------------------
const haversineMetres = (lat1, lon1, lat2, lon2) => {
  const R = 6371008.8;
  const toRad = value => (value * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
};

function bboxOfGeometry(geometry) {
  const coords = [];
  const walk = value => {
    if (typeof value[0] === 'number') { coords.push(value); return; }
    value.forEach(walk);
  };
  if (!geometry || !geometry.coordinates) return null;
  walk(geometry.coordinates);
  if (coords.length === 0) return null;

  const lons = coords.map(pair => pair[0]);
  const lats = coords.map(pair => pair[1]);
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
}

function mergeBbox(target, bbox) {
  if (!bbox) return target;
  if (!target) return [...bbox];
  return [
    Math.min(target[0], bbox[0]),
    Math.min(target[1], bbox[1]),
    Math.max(target[2], bbox[2]),
    Math.max(target[3], bbox[3])
  ];
}

// Area in square degrees; good enough to refuse an accidental continent-sized request.
const areaDeg2 = ([west, south, east, north]) =>
  Math.abs((east - west) * (north - south));

// ---------------------------------------------------------------------------
// Overpass query building and OSM -> GeoJSON conversion.
// ---------------------------------------------------------------------------
function buildOverpassQuery(categories, bbox, maxFeatures) {
  const [west, south, east, north] = bbox;
  const box = `${south},${west},${north},${east}`;
  const parts = [];

  categories.forEach(key => {
    const category = CATEGORY_BY_KEY.get(key);
    if (!category) return;
    category.filters.forEach(filter => {
      const selector = filter.v ? `["${filter.k}"="${filter.v}"]` : `["${filter.k}"]`;
      // nwr = nodes, ways and relations. Nodes matter (a power tower, a river gauging
      // point), and relations carry multipolygon buildings/landuse that a way-only query
      // silently loses.
      parts.push(`nwr${selector}(${box});`);
    });
  });

  return [
    `[out:json][timeout:${Math.round(DEFAULTS.requestTimeoutMs / 1000)}];`,
    '(',
    ...parts,
    ');',
    `out tags geom ${maxFeatures};`
  ].join('\n');
}

// A closed way is only a polygon when its own tags say it is an area. A closed footway,
// a roundabout or a circular service road are closed and are still lines; the previous
// version used "any selected category is polygonal", which turned loops into buildings.
const AREA_TAGS = ['building', 'building:part', 'landuse', 'leisure', 'amenity', 'shop', 'tourism', 'boundary', 'place', 'area:highway'];
const AREA_NATURAL = new Set(['water', 'wood', 'scrub', 'wetland', 'beach', 'sand', 'bare_rock', 'grassland']);

function isClosedRing(coordinates) {
  if (!Array.isArray(coordinates) || coordinates.length < 4) return false;
  const first = coordinates[0];
  const last = coordinates[coordinates.length - 1];
  return first[0] === last[0] && first[1] === last[1];
}

function isAreaGeometry(tags, closed) {
  if (!closed) return false;
  if (tags.area === 'no') return false;
  if (tags.area === 'yes') return true;
  if (AREA_TAGS.some(key => tags[key] !== undefined)) return true;
  if (tags.natural !== undefined && AREA_NATURAL.has(tags.natural)) return true;
  return false;
}

const baseProperties = (element, type) => ({
  ...(element.tags || {}),
  osm_type: type,
  osm_id: element.id,
  source: OSM_SOURCE,
  licence: OSM_LICENCE
});

function osmNodeToGeoJson(element) {
  if (!Number.isFinite(Number(element.lat)) || !Number.isFinite(Number(element.lon))) return null;
  return {
    type: 'Feature',
    id: `node/${element.id}`,
    geometry: { type: 'Point', coordinates: [Number(element.lon), Number(element.lat)] },
    properties: baseProperties(element, 'node')
  };
}

function osmWayToGeoJson(element) {
  const geometry = element.geometry || [];
  if (geometry.length < 2) return null;

  const coordinates = geometry.map(point => [Number(point.lon), Number(point.lat)]);
  const closed = isClosedRing(coordinates);
  const area = isAreaGeometry(element.tags || {}, closed);

  return {
    type: 'Feature',
    id: `way/${element.id}`,
    geometry: area
      ? { type: 'Polygon', coordinates: [coordinates] }
      : { type: 'LineString', coordinates },
    properties: baseProperties(element, 'way')
  };
}

function ringContainsPoint(point, ring) {
  // Ray casting; enough to assign an inner ring to its outer ring.
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects = (yi > point[1]) !== (yj > point[1])
      && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi || Number.EPSILON) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

// Multipolygon relations (buildings, landuse, water) are assembled from their member ways.
// Unclosed members cannot form a ring, so they are counted as skipped rather than guessed at.
function osmRelationToGeoJson(element) {
  const members = Array.isArray(element.members) ? element.members : [];
  const outer = [];
  const inner = [];
  let unclosed = 0;

  members.forEach(member => {
    if (member.type !== 'way' || !Array.isArray(member.geometry) || member.geometry.length < 2) return;
    const coordinates = member.geometry.map(point => [Number(point.lon), Number(point.lat)]);
    if (!isClosedRing(coordinates)) { unclosed += 1; return; }
    (member.role === 'inner' ? inner : outer).push(coordinates);
  });

  if (outer.length === 0) return { feature: null, unclosed };

  const polygons = outer.map(ring => [ring]);
  inner.forEach(ring => {
    const target = polygons.find(polygon => ringContainsPoint(ring[0], polygon[0]));
    if (target) target.push(ring);
    else polygons.push([ring]); // an inner ring without an outer is still geometry, not a hole
  });

  return {
    feature: {
      type: 'Feature',
      id: `relation/${element.id}`,
      geometry: { type: 'MultiPolygon', coordinates: polygons },
      properties: baseProperties(element, 'relation')
    },
    unclosed
  };
}

function osmToFeatureCollection(elements, categories) {
  const features = [];
  const stats = { nodes: 0, ways: 0, relations: 0, skippedRelations: 0, skippedElements: 0 };

  (elements || []).forEach(element => {
    if (element.type === 'node') {
      const feature = osmNodeToGeoJson(element);
      if (feature) { features.push(feature); stats.nodes += 1; }
      return;
    }

    if (element.type === 'way') {
      const feature = osmWayToGeoJson(element);
      if (feature) { features.push(feature); stats.ways += 1; } else stats.skippedElements += 1;
      return;
    }

    if (element.type === 'relation') {
      const { feature, unclosed } = osmRelationToGeoJson(element);
      if (feature) { features.push(feature); stats.relations += 1; } else { stats.skippedRelations += 1; stats.skippedElements += unclosed; }
    }
  });

  return { featureCollection: { type: 'FeatureCollection', features }, stats };
}

function geometryKind(featureCollection) {
  const kinds = new Set((featureCollection.features || []).map(feature => feature.geometry?.type).filter(Boolean));
  const order = ['Polygon', 'LineString', 'Point', 'MultiPolygon', 'MultiLineString'];
  for (const kind of order) if (kinds.has(kind)) return kind;
  return 'Unknown';
}

function collectionBbox(featureCollection) {
  let bbox = null;
  (featureCollection.features || []).forEach(feature => { bbox = mergeBbox(bbox, bboxOfGeometry(feature.geometry)); });
  return bbox;
}

// One Overpass request at a time, with a minimum gap: the public instance is shared.
let overpassQueue = Promise.resolve();
let lastOverpassAt = 0;
const OVERPASS_MIN_GAP_MS = 2000;

function scheduleOverpass(task) {
  const run = async () => {
    const wait = Math.max(0, OVERPASS_MIN_GAP_MS - (Date.now() - lastOverpassAt));
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    try {
      return await task();
    } finally {
      lastOverpassAt = Date.now();
    }
  };

  const next = overpassQueue.then(run, run);
  overpassQueue = next.catch(() => {});
  return next;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchOverpassOnce(endpoint, query) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': DEFAULTS.userAgent,
      Accept: 'application/json'
    },
    body: new URLSearchParams({ data: query }),
    signal: AbortSignal.timeout(DEFAULTS.requestTimeoutMs)
  });

  if (!response.ok) {
    const text = (await response.text()).replace(/\s+/g, ' ').slice(0, 200);
    throw new Error(`Overpass answered ${response.status}. ${text}`);
  }

  return response.json();
}

// Try the configured endpoint, retry a busy one once, then fall through the mirrors. A 400
// (bad query) is not retried: it would fail the same way everywhere.
async function fetchOverpass(query, { attemptsPerEndpoint = 2 } = {}) {
  const endpoints = [DEFAULTS.overpassUrl, ...DEFAULTS.overpassFallbacks];
  const failures = [];

  for (const endpoint of endpoints) {
    for (let attempt = 1; attempt <= attemptsPerEndpoint; attempt += 1) {
      try {
        return await fetchOverpassOnce(endpoint, query);
      } catch (err) {
        failures.push(`${endpoint} (attempt ${attempt}): ${String(err.message).slice(0, 160)}`);
        const retryable = err.name === 'TimeoutError'
          || /fetch failed|ECONNRESET|ENOTFOUND|socket hang up/i.test(err.message)
          || /Overpass answered (429|502|503|504)/.test(err.message);
        if (!retryable) break;
        await sleep(1000 * attempt);
      }
    }
  }

  throw new Error(`Every Overpass endpoint failed. The public servers may be busy; try again shortly or set OVERPASS_URL to your own instance. ${failures.join(' | ')}`);
}

// ---------------------------------------------------------------------------
// Database-backed cache so a preview and the following import do not query twice, and a
// reopened project does not re-hit the public API.
// ---------------------------------------------------------------------------
const normaliseBbox = bbox => bbox.map(value => Number(Number(value).toFixed(6)));
const queryHash = (categories, bbox) => crypto
  .createHash('sha256')
  // v2: the payload shape changed (stats, geometryTypes, tag-based classification), so old
  // cached responses must not be served to the new code.
  .update(JSON.stringify({ categories: [...categories].sort(), bbox: normaliseBbox(bbox), v: 2 }))
  .digest('hex');

// Returns {bbox} or {error}. Nothing is swapped or clamped: a caller that sends north/south
// the wrong way gets told, because silently reordering boundaries can import the wrong area.
function parseBbox(input) {
  if (!Array.isArray(input) || input.length !== 4) {
    return { error: 'bbox must be [west, south, east, north] in decimal degrees.' };
  }

  const values = input.map(Number);
  if (!values.every(Number.isFinite)) {
    return { error: 'bbox values must be numbers in decimal degrees.' };
  }

  const [west, south, east, north] = values;
  if (west < -180 || east > 180 || south < -90 || north > 90) {
    return { error: 'bbox is outside the valid range: longitude -180..180, latitude -90..90.' };
  }
  if (west >= east) {
    return { error: `bbox west (${west}) must be less than east (${east}). Areas crossing the antimeridian are not supported; split the request.` };
  }
  if (south >= north) {
    return { error: `bbox south (${south}) must be less than north (${north}).` };
  }
  // The public Overpass instances should not be asked for polar tiles through Web Mercator.
  if (south < -85 || north > 85) {
    return { error: 'bbox latitude is limited to -85..85 for OpenStreetMap imports.' };
  }

  return { bbox: [west, south, east, north] };
}

// Rough ground area, so the error message can show km² as well as square degrees.
function areaKm2([west, south, east, north]) {
  const midLat = ((south + north) / 2) * Math.PI / 180;
  return areaDeg2([west, south, east, north]) * 111.32 * 111.32 * Math.cos(midLat);
}

// Confirms every coordinate looks geographic. Returns the offending position when not.
function validateGeographic(featureCollection) {
  let bad = null;
  const walk = value => {
    if (bad || !Array.isArray(value)) return;
    if (typeof value[0] === 'number') {
      const [x, y] = value;
      if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 180 || Math.abs(y) > 90) {
        bad = [x, y];
      }
      return;
    }
    value.forEach(walk);
  };

  (featureCollection.features || []).forEach(feature => walk(feature.geometry?.coordinates));
  return bad ? { ok: false, message: `coordinate ${JSON.stringify(bad)} is outside -180..180 / -90..90` } : { ok: true };
}

// ---------------------------------------------------------------------------
// File import/export helpers (GeoJSON and CSV). Files are parsed in memory; the same feature
// limit as Overpass imports applies, and a CRS must be named explicitly.
// ---------------------------------------------------------------------------
const IMPORT_FORMATS = new Set(['geojson', 'csv']);
const GEOMETRY_TYPES = new Set(['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon']);

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else field += char;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === ',') { row.push(field); field = ''; continue; }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field); field = '';
      if (row.some(cell => cell.trim() !== '')) rows.push(row);
      row = [];
      continue;
    }
    field += char;
  }
  row.push(field);
  if (row.some(cell => cell.trim() !== '')) rows.push(row);

  if (rows.length === 0) return { error: 'The CSV file is empty.' };
  const headers = rows[0].map(header => header.trim().replace(/^\ufeff/, ''));
  if (headers.some(header => !header)) return { error: 'Every CSV column needs a header.' };
  if (rows.length === 1) return { error: 'The CSV file has a header but no data rows.' };
  return { headers, records: rows.slice(1).map(cells => Object.fromEntries(headers.map((header, index) => [header, cells[index] === undefined ? '' : cells[index]]))) };
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function firstCoordinate(geometry) {
  let found = null;
  const walk = value => {
    if (found || !Array.isArray(value)) return;
    if (typeof value[0] === 'number' && typeof value[1] === 'number') { found = value; return; }
    value.forEach(walk);
  };
  if (geometry) walk(geometry.coordinates);
  return found;
}

function validateFeatureCollection(featureCollection, sourceCrs) {
  if (featureCollection.features.length === 0) return 'The file has no features.';
  if (featureCollection.features.length > DEFAULTS.maxFeatures) {
    return `A dataset is limited to ${DEFAULTS.maxFeatures} features; this file has ${featureCollection.features.length}.`;
  }
  for (let index = 0; index < featureCollection.features.length; index += 1) {
    const geometry = featureCollection.features[index].geometry;
    if (!geometry || !GEOMETRY_TYPES.has(geometry.type) || !Array.isArray(geometry.coordinates)) {
      return `Feature ${index + 1} has no supported geometry.`;
    }
    const first = firstCoordinate(geometry);
    if (!first) return `Feature ${index + 1} has empty coordinates.`;
    try {
      // For a geographic CRS this also checks longitude/latitude ranges; for a projected CRS it
      // only checks that the pair is numeric.
      transformPoint(first, sourceCrs, sourceCrs);
    } catch (err) {
      return `Feature ${index + 1}: ${err.message}`;
    }
  }
  return null;
}

function featureCollectionFromCsv(parsed, sourceCrs) {
  const definition = crsDefinition(sourceCrs);
  const headers = parsed.headers;
  const lower = new Map(headers.map(header => [header.toLowerCase(), header]));
  const pick = candidates => candidates.map(name => lower.get(name)).find(Boolean);
  const xKey = pick(isGeographic(definition)
    ? ['lon', 'lng', 'long', 'longitude', 'x']
    : ['easting', 'east', 'x', 'lon', 'longitude']);
  const yKey = pick(isGeographic(definition)
    ? ['lat', 'latitude', 'y']
    : ['northing', 'north', 'y', 'lat', 'latitude']);
  if (!xKey || !yKey) {
    return {
      error: `CSV needs ${isGeographic(definition) ? 'longitude and latitude' : 'easting and northing'} columns. Found: ${headers.join(', ')}.`
    };
  }

  const coordinateKeys = new Set([xKey, yKey]);
  const propertyKeys = headers.filter(header => !coordinateKeys.has(header));
  const features = [];

  for (let index = 0; index < parsed.records.length; index += 1) {
    const record = parsed.records[index];
    const x = Number(record[xKey]);
    const y = Number(record[yKey]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { error: `Row ${index + 2}: ${xKey}/${yKey} are not numbers.` };
    }
    try {
      transformPoint([x, y], sourceCrs, sourceCrs);
    } catch (err) {
      return { error: `Row ${index + 2}: ${err.message}` };
    }
    const properties = {};
    propertyKeys.forEach(key => { properties[key] = record[key]; });
    features.push({ type: 'Feature', properties, geometry: { type: 'Point', coordinates: [x, y] } });
  }

  return { featureCollection: { type: 'FeatureCollection', features } };
}

// ---------------------------------------------------------------------------

module.exports = function createGisModule({
  app,
  pool,
  verifyToken,
  requireProjectAccess,
  // Defaults keep integration into an existing backend small: only the four arguments
  // above are required. An installation that has its own helpers can pass them in.
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
  // Uploads are parsed in memory: the features are validated and stored as JSONB, and the
  // original file is not kept on disk.
  const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } }).single('file');

  // Per-user limits in front of shared public services. The Overpass limiter also protects
  // the server's own outbound capacity; the serialised queue keeps one user's import from
  // exhausting it.
  const limiter = (name, limit, message) => rateLimit({
    windowMs: 60 * 1000,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: req => `${name}:${req.userId || req.ip}`,
    message: { error: message }
  });

  const overpassLimiter = limiter('gis-overpass', 12, 'Too many OpenStreetMap lookups in a minute. Wait a moment before trying again.');
  const placeLimiter = limiter('gis-place', 30, 'Too many place searches in a minute. Wait a moment before trying again.');

  async function ensureGisSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS gis_datasets (
        id SERIAL PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id),
        name VARCHAR(200) NOT NULL,
        source VARCHAR(120) NOT NULL,
        source_query JSONB,
        licence VARCHAR(120),
        attribution TEXT,
        crs VARCHAR(40) NOT NULL DEFAULT 'EPSG:4326',
        geometry_type VARCHAR(60),
        feature_count INTEGER,
        bbox JSONB,
        geojson JSONB NOT NULL,
        processing_history JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS gis_georeferencing (
        project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        crs VARCHAR(40),
        vertical_datum VARCHAR(80),
        anchor_lat NUMERIC(10,8),
        anchor_lon NUMERIC(11,8),
        anchor_elevation NUMERIC(12,3),
        model_origin_east NUMERIC(15,4),
        model_origin_north NUMERIC(15,4),
        model_origin_up NUMERIC(12,4),
        rotation_deg NUMERIC(9,4),
        scale NUMERIC(12,8),
        z_offset NUMERIC(12,4),
        notes TEXT,
        verified_by VARCHAR(160),
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS gis_osm_cache (
        query_hash VARCHAR(64) PRIMARY KEY,
        payload JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP NOT NULL
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS gis_saved_queries (
        id SERIAL PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name VARCHAR(160) NOT NULL,
        categories JSONB NOT NULL,
        bbox JSONB NOT NULL,
        created_by INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // Additive survey-GIS columns: existing points keep working unchanged.
    await pool.query('ALTER TABLE IF EXISTS surveying_control_points ADD COLUMN IF NOT EXISTS name VARCHAR(120)');
    await pool.query('ALTER TABLE IF EXISTS surveying_control_points ADD COLUMN IF NOT EXISTS is_benchmark BOOLEAN DEFAULT FALSE');
    await pool.query('ALTER TABLE IF EXISTS surveying_control_points ADD COLUMN IF NOT EXISTS vertical_datum VARCHAR(80)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_gis_datasets_project ON gis_datasets(project_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_gis_cache_expiry ON gis_osm_cache(expires_at)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_gis_saved_queries_project ON gis_saved_queries(project_id)');
  }

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

  // ------------------------------ catalogue --------------------------------
  app.get('/api/gis/catalogue', verifyToken, (req, res) => {
    res.json({
      categories: CATEGORIES.map(category => ({
        key: category.key,
        label: category.label,
        geometry: category.geometry,
        osmTags: category.filters.map(filter => (filter.v ? `${filter.k}=${filter.v}` : filter.k))
      })),
      source: OSM_SOURCE,
      licence: OSM_LICENCE,
      attribution: OSM_ATTRIBUTION,
      tileUrl: DEFAULTS.tileUrl,
      limits: {
        maxAreaDeg2: DEFAULTS.maxAreaDeg2,
        maxFeatures: DEFAULTS.maxFeatures,
        cacheHours: DEFAULTS.cacheHours
      },
      crs: listCrs(),
      note: 'OpenStreetMap features are contextual: they are not survey measurements and must not be used as verified construction dimensions.'
    });
  });

  // ------------------------------ saved OSM queries -------------------------
  // A saved query stores the category selection and area, not results. Running it goes
  // through the same preview endpoint, cache and rate limits as an unsaved query.
  const savedQueryJson = row => ({
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    categories: row.categories,
    bbox: row.bbox,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });

  app.get('/api/gis/queries/:projectId', verifyToken, requireProjectAccess(req => req.params.projectId), asyncHandler(async (req, res) => {
    const result = await pool.query(
      'SELECT * FROM gis_saved_queries WHERE project_id = $1 ORDER BY updated_at DESC, id DESC',
      [req.projectId]
    );
    res.json({ queries: result.rows.map(savedQueryJson), count: result.rows.length });
  }));

  app.post('/api/gis/queries/:projectId', verifyToken, requireProjectAccess(req => req.params.projectId), asyncHandler(async (req, res) => {
    const name = String(req.body.name || '').trim().slice(0, 160);
    if (!name) return res.status(400).json({ error: 'Give the saved query a name.' });

    const requested = Array.isArray(req.body.categories) ? req.body.categories : [];
    const categories = requested.filter(key => CATEGORY_BY_KEY.has(key));
    if (categories.length === 0) {
      return res.status(400).json({ error: 'Select at least one feature category.', available: CATEGORIES.map(c => c.key) });
    }

    const parsed = parseBbox(req.body.bbox);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const count = await pool.query('SELECT COUNT(*)::int AS count FROM gis_saved_queries WHERE project_id = $1', [req.projectId]);
    if (count.rows[0].count >= 100) {
      return res.status(400).json({ error: 'This project already has 100 saved queries. Delete one before saving another.' });
    }

    const result = await pool.query(
      `INSERT INTO gis_saved_queries (project_id, name, categories, bbox, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.projectId, name, JSON.stringify(categories), JSON.stringify(parsed.bbox), req.user?.id || null]
    );
    res.status(201).json(savedQueryJson(result.rows[0]));
  }));

  app.delete('/api/gis/queries/:projectId/:queryId', verifyToken, requireProjectAccess(req => req.params.projectId), asyncHandler(async (req, res) => {
    const result = await pool.query(
      'DELETE FROM gis_saved_queries WHERE project_id = $1 AND id = $2',
      [req.projectId, req.params.queryId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Saved query not found for this project.' });
    res.json({ success: true, deleted: result.rowCount });
  }));

  // ------------------------------ place search ------------------------------
  // Nominatim proxy. Only called on an explicit search, min length 3, max 5 results, with a
  // proper User-Agent and the required attribution in every result.
  app.get('/api/gis/place-search', verifyToken, placeLimiter, asyncHandler(async (req, res) => {
    const query = String(req.query.q || '').trim();
    if (query.length < 3) return res.status(400).json({ error: 'Type at least 3 characters to search.' });

    const hash = `place:${query.toLowerCase()}`;
    const cached = await pool.query(
      'SELECT payload FROM gis_osm_cache WHERE query_hash = $1 AND expires_at > NOW()',
      [hash]
    );
    if (cached.rows.length > 0) {
      return res.json({ ...cached.rows[0].payload, cached: true });
    }

    const url = new URL('/search', DEFAULTS.nominatimUrl);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', '5');
    url.searchParams.set('addressdetails', '0');

    const response = await fetch(url, {
      headers: { 'User-Agent': DEFAULTS.userAgent, Accept: 'application/json' },
      signal: AbortSignal.timeout(20000)
    });

    if (!response.ok) {
      return res.status(502).json({ error: `Place search is unavailable right now (OSM Nominatim answered ${response.status}).` });
    }

    const results = await response.json();
    const payload = {
      results: (Array.isArray(results) ? results : []).slice(0, 5).map(item => ({
        name: item.display_name,
        lat: Number(item.lat),
        lon: Number(item.lon),
        type: item.type,
        category: item.category,
        bbox: item.boundingbox ? item.boundingbox.map(Number) : null,
        attribution: OSM_ATTRIBUTION,
        licence: OSM_LICENCE
      })),
      attribution: OSM_ATTRIBUTION,
      licence: OSM_LICENCE,
      cached: false
    };

    await pool.query(
      `INSERT INTO gis_osm_cache (query_hash, payload, expires_at)
       VALUES ($1, $2, NOW() + ($3 || ' hours')::interval)
       ON CONFLICT (query_hash) DO UPDATE SET payload = EXCLUDED.payload, created_at = NOW(), expires_at = EXCLUDED.expires_at`,
      [hash, payload, String(DEFAULTS.cacheHours)]
    );

    res.json(payload);
  }));

  // ------------------------------ preview / fetch ---------------------------
  // Rate limit: each preview can cost a public Overpass server a lot of work.
  app.post('/api/gis/overpass/preview', verifyToken, overpassLimiter, asyncHandler(async (req, res) => {
    const parsed = parseBbox(req.body.bbox);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const bbox = parsed.bbox;

    const requested = Array.isArray(req.body.categories) ? req.body.categories : [];
    const categories = requested.filter(key => CATEGORY_BY_KEY.has(key));
    if (categories.length === 0) {
      return res.status(400).json({ error: 'Select at least one feature category.', available: CATEGORIES.map(c => c.key) });
    }

    const area = areaDeg2(bbox);
    if (area > DEFAULTS.maxAreaDeg2) {
      return res.status(400).json({
        error: `That area is ${area.toFixed(4)} square degrees (about ${Math.round(areaKm2(bbox))} km²); the limit is ${DEFAULTS.maxAreaDeg2} square degrees. Draw a smaller area or import it in several pieces.`,
        areaDeg2: area,
        areaKm2: Math.round(areaKm2(bbox)),
        limitDeg2: DEFAULTS.maxAreaDeg2
      });
    }

    const hash = queryHash(categories, bbox);
    const cached = await pool.query(
      'SELECT payload FROM gis_osm_cache WHERE query_hash = $1 AND expires_at > NOW()',
      [hash]
    );

    if (cached.rows.length > 0) {
      const payload = cached.rows[0].payload;
      return res.json({
        ...payload,
        counts: payload.counts || countByCategory(payload.geojson?.features || [], categories),
        cached: true
      });
    }

    const query = buildOverpassQuery(categories, bbox, DEFAULTS.maxFeatures);
    let data;
    try {
      data = await scheduleOverpass(() => fetchOverpass(query));
    } catch (err) {
      // A busy public API is not an internal fault: say so, and do not cache the failure.
      console.error('Overpass preview failed:', err.message);
      return res.status(503).json({
        error: err.message,
        retryable: true,
        hint: 'OpenStreetMap\'s public Overpass servers are busy or unreachable. Try again in a minute, or set OVERPASS_URL to your own instance.'
      });
    }

    const { featureCollection, stats } = osmToFeatureCollection(data.elements, categories);

    if (featureCollection.features.length === 0) {
      return res.status(404).json({
        error: 'OpenStreetMap has no features in that area for the selected categories. Try a larger area or other categories.',
        bbox,
        categories,
        stats
      });
    }

    const payload = {
      geojson: featureCollection,
      counts: countByCategory(featureCollection.features, categories),
      geometryTypes: countGeometryTypes(featureCollection.features),
      stats,
      bbox,
      categories,
      source: OSM_SOURCE,
      licence: OSM_LICENCE,
      attribution: OSM_ATTRIBUTION,
      query,
      osmTimestamp: data.osm3s?.timestamp_osm_base || null,
      truncated: featureCollection.features.length >= DEFAULTS.maxFeatures,
      notes: [
        'OpenStreetMap data is contextual: it is not a survey measurement.',
        stats.skippedRelations > 0
          ? `${stats.skippedRelations} multipolygon relation(s) had no closed outer ring and were skipped.`
          : null
      ].filter(Boolean)
    };

    await pool.query(
      `INSERT INTO gis_osm_cache (query_hash, payload, expires_at)
       VALUES ($1, $2, NOW() + ($3 || ' hours')::interval)
       ON CONFLICT (query_hash) DO UPDATE SET payload = EXCLUDED.payload, created_at = NOW(), expires_at = EXCLUDED.expires_at`,
      [hash, payload, String(DEFAULTS.cacheHours)]
    );
    await pool.query('DELETE FROM gis_osm_cache WHERE expires_at < NOW()');

    res.json({ ...payload, cached: false });
  }));

  function countGeometryTypes(features) {
    const types = {};
    features.forEach(feature => {
      const type = feature.geometry?.type || 'Unknown';
      types[type] = (types[type] || 0) + 1;
    });
    return types;
  }

  function countByCategory(features, categories) {
    const counts = {};
    categories.forEach(key => { counts[key] = 0; });

    features.forEach(feature => {
      const tags = feature.properties || {};
      categories.forEach(key => {
        const category = CATEGORY_BY_KEY.get(key);
        if (!category) return;
        const match = category.filters.some(filter =>
          filter.v ? tags[filter.k] === filter.v : tags[filter.k] !== undefined
        );
        if (match) counts[key] += 1;
      });
    });

    return counts;
  }

  // ------------------------------ datasets ---------------------------------
  app.get('/api/gis/datasets/:projectId', verifyToken, requireProjectAccess(req => req.params.projectId), asyncHandler(async (req, res) => {
    const result = await pool.query(
      'SELECT * FROM gis_datasets WHERE project_id = $1 ORDER BY created_at DESC',
      [req.projectId]
    );
    res.json(result.rows.map(datasetSummary));
  }));

  app.get('/api/gis/datasets/:projectId/:datasetId', verifyToken, requireProjectAccess(req => req.params.projectId), asyncHandler(async (req, res) => {
    const result = await pool.query(
      'SELECT * FROM gis_datasets WHERE project_id = $1 AND id = $2',
      [req.projectId, req.params.datasetId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Dataset not found for this project.' });

    const row = result.rows[0];
    const storedCrs = crsDefinition(row.crs) ? row.crs : 'EPSG:4326';

    // Storage keeps the dataset's own CRS. The map asks for EPSG:4326 so every stored dataset can
    // be drawn on one Web Mercator canvas without assuming its coordinates are already geographic.
    let geojson = row.geojson;
    let bbox = row.bbox;
    let displayCrs = storedCrs;
    if (req.query.crs !== undefined) {
      const target = crsDefinition(req.query.crs);
      if (!target) return res.status(400).json({ error: `Unsupported CRS ${req.query.crs}. Choose one from GET /api/gis/crs.` });
      displayCrs = target.code;
      if (target.code !== storedCrs) {
        try {
          geojson = transformFeatureCollection(row.geojson, storedCrs, target.code);
        } catch (err) {
          return res.status(400).json({ error: err.message });
        }
        bbox = collectionBbox(geojson);
      }
    }

    res.json({ ...datasetSummary(row), bbox, displayCrs, geojson });
  }));

  app.post('/api/gis/datasets/:projectId', verifyToken, requireProjectAccess(req => req.params.projectId), asyncHandler(async (req, res) => {
    const geojson = req.body.geojson;
    if (!geojson || geojson.type !== 'FeatureCollection' || !Array.isArray(geojson.features)) {
      return res.status(400).json({ error: 'geojson must be a GeoJSON FeatureCollection.' });
    }
    if (geojson.features.length === 0) {
      return res.status(400).json({ error: 'The dataset has no features to save.' });
    }
    if (geojson.features.length > DEFAULTS.maxFeatures) {
      return res.status(400).json({ error: `A dataset is limited to ${DEFAULTS.maxFeatures} features.` });
    }

    // Datasets are stored as EPSG:4326. Projected coordinates posted by mistake would be
    // labelled geographic and land thousands of kilometres away, so they are refused.
    const bounds = validateGeographic(geojson);
    if (!bounds.ok) {
      return res.status(400).json({
        error: `The dataset is not valid EPSG:4326: ${bounds.message}. Transform projected coordinates to longitude/latitude before saving.`
      });
    }

    const name = String(req.body.name || 'OSM import').trim().slice(0, 200) || 'OSM import';
    // The caller's bbox is validated, never silently reordered; without one the extent is
    // derived from the geometry itself.
    let bbox = collectionBbox(geojson);
    if (req.body.bbox !== undefined && req.body.bbox !== null) {
      const parsedBbox = parseBbox(req.body.bbox);
      if (parsedBbox.error) return res.status(400).json({ error: parsedBbox.error });
      bbox = parsedBbox.bbox;
    }
    const history = [{
      at: new Date().toISOString(),
      action: 'import',
      source: OSM_SOURCE,
      categories: Array.isArray(req.body.categories) ? req.body.categories : [],
      featureCount: geojson.features.length,
      note: 'Imported from OpenStreetMap through Overpass; coordinates stored as received (EPSG:4326).'
    }];

    const result = await pool.query(
      `INSERT INTO gis_datasets
         (project_id, name, source, source_query, licence, attribution, crs, geometry_type,
          feature_count, bbox, geojson, processing_history)
       VALUES ($1, $2, $3, $4, $5, $6, 'EPSG:4326', $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        req.projectId,
        name,
        OSM_SOURCE,
        JSON.stringify({ bbox, categories: req.body.categories || [] }),
        OSM_LICENCE,
        OSM_ATTRIBUTION,
        geometryKind(geojson),
        geojson.features.length,
        JSON.stringify(bbox),
        JSON.stringify(geojson),
        JSON.stringify(history)
      ]
    );

    res.status(201).json(datasetSummary(result.rows[0]));
  }));

  // Import GeoJSON or CSV. The caller states the file's CRS; the stored dataset keeps that CRS and
  // the map requests a 4326 view when it draws the layer.
  app.post('/api/gis/datasets/:projectId/import', verifyToken, requireProjectAccess(req => req.params.projectId), (req, res, next) => {
    importUpload(req, res, err => {
      if (err) {
        const message = err.code === 'LIMIT_FILE_SIZE'
          ? 'The file is larger than 20 MB.'
          : `The upload could not be read: ${err.message}`;
        return res.status(400).json({ error: message });
      }
      next();
    });
  }, asyncHandler(async (req, res) => {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'Attach a GeoJSON or CSV file in the "file" field.' });
    }

    const sourceCrs = crsDefinition(req.body.crs);
    if (!sourceCrs) {
      return res.status(400).json({ error: 'crs is required and must be an EPSG code from GET /api/gis/crs; nothing is inferred from coordinates.' });
    }

    const text = req.file.buffer.toString('utf8').replace(/^\uFEFF/, '');
    const requestedFormat = String(req.body.format || '').toLowerCase();
    if (requestedFormat && !IMPORT_FORMATS.has(requestedFormat)) {
      return res.status(400).json({ error: 'format must be geojson or csv.' });
    }
    const looksLikeJson = /^[\s\[{]/.test(text);
    const format = requestedFormat || (looksLikeJson ? 'geojson' : 'csv');

    let featureCollection;
    if (format === 'geojson') {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        return res.status(400).json({ error: `The GeoJSON could not be parsed: ${err.message}` });
      }
      featureCollection = parsed.type === 'Feature'
        ? { type: 'FeatureCollection', features: [parsed] }
        : parsed;
      if (!featureCollection || featureCollection.type !== 'FeatureCollection' || !Array.isArray(featureCollection.features)) {
        return res.status(400).json({ error: 'GeoJSON must be a Feature or FeatureCollection.' });
      }
      const problem = validateFeatureCollection(featureCollection, sourceCrs.code);
      if (problem) return res.status(400).json({ error: problem });
    } else {
      const parsed = parseCsv(text);
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      const built = featureCollectionFromCsv(parsed, sourceCrs.code);
      if (built.error) return res.status(400).json({ error: built.error });
      featureCollection = built.featureCollection;
    }

    const name = String(req.body.name || req.file.originalname.replace(/\.[^.]+$/, '') || 'Imported dataset').trim().slice(0, 200)
      || 'Imported dataset';
    const bbox = collectionBbox(featureCollection);
    const source = `File import (${format === 'geojson' ? 'GeoJSON' : 'CSV'})`;
    const history = [{
      at: new Date().toISOString(),
      action: 'import',
      source,
      fileName: req.file.originalname,
      crs: sourceCrs.code,
      featureCount: featureCollection.features.length,
      note: `Imported from ${req.file.originalname} in ${sourceCrs.code}. Coordinates stored as declared; the map transforms them to EPSG:4326 for display.`
    }];

    const result = await pool.query(
      `INSERT INTO gis_datasets
         (project_id, name, source, source_query, licence, attribution, crs, geometry_type,
          feature_count, bbox, geojson, processing_history)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        req.projectId,
        name,
        source,
        JSON.stringify({ fileName: req.file.originalname, format, crs: sourceCrs.code }),
        'Not stated by importer',
        '',
        sourceCrs.code,
        geometryKind(featureCollection),
        featureCollection.features.length,
        JSON.stringify(bbox),
        JSON.stringify(featureCollection),
        JSON.stringify(history)
      ]
    );

    res.status(201).json(datasetSummary(result.rows[0]));
  }));

  // Reproject stored coordinates into another supported CRS. This changes the dataset in place;
  // the workspace client asks for an EPSG:4326 view, so open layers keep rendering correctly.
  app.post('/api/gis/datasets/:projectId/:datasetId/reproject', verifyToken, requireProjectAccess(req => req.params.projectId), asyncHandler(async (req, res) => {
    const target = crsDefinition(req.body.targetCrs);
    if (!target) {
      return res.status(400).json({ error: 'targetCrs is required and must be an EPSG code from GET /api/gis/crs.' });
    }
    const result = await pool.query(
      'SELECT * FROM gis_datasets WHERE project_id = $1 AND id = $2',
      [req.projectId, req.params.datasetId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Dataset not found for this project.' });

    const row = result.rows[0];
    const sourceCrs = crsDefinition(row.crs);
    if (!sourceCrs) {
      return res.status(400).json({ error: `The dataset's stored CRS ${row.crs} is not in the supported registry.` });
    }
    if (sourceCrs.code === target.code) {
      return res.status(400).json({ error: `The dataset is already stored in ${target.code}.` });
    }

    let geojson;
    try {
      geojson = transformFeatureCollection(row.geojson, sourceCrs.code, target.code);
    } catch (err) {
      return res.status(400).json({ error: `Reprojection failed: ${err.message}` });
    }
    const bbox = collectionBbox(geojson);
    const history = Array.isArray(row.processing_history) ? row.processing_history : [];
    history.push({
      at: new Date().toISOString(),
      action: 'reproject',
      from: sourceCrs.code,
      to: target.code,
      featureCount: toNum(row.feature_count),
      note: 'Stored coordinates transformed with proj4js; no datum grid shift was applied.'
    });

    const updated = await pool.query(
      `UPDATE gis_datasets
          SET crs = $3, bbox = $4, geojson = $5, processing_history = $6, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND project_id = $2
        RETURNING *`,
      [row.id, req.projectId, target.code, JSON.stringify(bbox), JSON.stringify(geojson), JSON.stringify(history)]
    );

    res.json({ ...datasetSummary(updated.rows[0]), previousCrs: sourceCrs.code });
  }));

  // Export as GeoJSON or CSV, in the stored CRS or a requested one. The provenance is written
  // into the GeoJSON file; CSV carries the coordinate columns and the feature properties.
  app.get('/api/gis/datasets/:projectId/:datasetId/export', verifyToken, requireProjectAccess(req => req.params.projectId), asyncHandler(async (req, res) => {
    const format = String(req.query.format || 'geojson').toLowerCase();
    if (!['geojson', 'csv'].includes(format)) {
      return res.status(400).json({ error: 'format must be geojson or csv.' });
    }

    const result = await pool.query(
      'SELECT * FROM gis_datasets WHERE project_id = $1 AND id = $2',
      [req.projectId, req.params.datasetId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Dataset not found for this project.' });

    const row = result.rows[0];
    const storedCrs = crsDefinition(row.crs) ? row.crs : 'EPSG:4326';
    let targetCrs = storedCrs;
    if (req.query.crs !== undefined) {
      const target = crsDefinition(req.query.crs);
      if (!target) return res.status(400).json({ error: `Unsupported CRS ${req.query.crs}. Choose one from GET /api/gis/crs.` });
      targetCrs = target.code;
    }

    let geojson = row.geojson;
    if (targetCrs !== storedCrs) {
      try {
        geojson = transformFeatureCollection(row.geojson, storedCrs, targetCrs);
      } catch (err) {
        return res.status(400).json({ error: `Export transform failed: ${err.message}` });
      }
    }

    const fileName = `${row.name.replace(/[^a-z0-9._-]+/gi, '-').toLowerCase() || 'dataset'}`;

    if (format === 'csv') {
      const propertyKeys = [];
      (geojson.features || []).forEach(feature => {
        Object.keys(feature.properties || {}).forEach(key => {
          if (!propertyKeys.includes(key)) propertyKeys.push(key);
        });
      });
      const header = ['geometry_type', 'x', 'y', ...propertyKeys];
      const lines = [header.map(csvCell).join(',')];
      (geojson.features || []).forEach(feature => {
        const coordinate = firstCoordinate(feature.geometry) || [];
        lines.push([
          feature.geometry?.type || '',
          coordinate[0] === undefined ? '' : coordinate[0],
          coordinate[1] === undefined ? '' : coordinate[1],
          ...propertyKeys.map(key => feature.properties ? feature.properties[key] : '')
        ].map(csvCell).join(','));
      });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}.csv"`);
      return res.send(`${lines.join('\r\n')}\r\n`);
    }

    const exported = {
      ...geojson,
      name: row.name,
      crs: targetCrs,
      metadata: {
        source: row.source,
        licence: row.licence,
        attribution: row.attribution,
        importedAt: row.created_at,
        updatedAt: row.updated_at,
        projectId: row.project_id,
        featureCount: toNum(row.feature_count),
        storedCrs,
        exportCrs: targetCrs,
        coordinateNote: 'x/y are longitude/latitude in EPSG:4326 and easting/northing in projected CRSs.'
      }
    };

    res.setHeader('Content-Type', 'application/geo+json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}.geojson"`);
    res.send(JSON.stringify(exported, null, 2));
  }));

  // Refresh: re-run the stored query and replace the features, keeping the history.
  app.post('/api/gis/datasets/:projectId/:datasetId/refresh', verifyToken, requireProjectAccess(req => req.params.projectId), asyncHandler(async (req, res) => {
    const existing = await pool.query(
      'SELECT * FROM gis_datasets WHERE project_id = $1 AND id = $2',
      [req.projectId, req.params.datasetId]
    );
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Dataset not found for this project.' });

    const row = existing.rows[0];
    const query = row.source_query || {};
    if (row.source !== OSM_SOURCE || !Array.isArray(query.categories) || !query.bbox) {
      return res.status(400).json({ error: 'This dataset has no stored OpenStreetMap query, so it cannot be refreshed automatically.' });
    }

    const parsed = parseBbox(query.bbox);
    if (parsed.error) {
      return res.status(400).json({ error: `The stored area is no longer valid: ${parsed.error} Import the area again instead.` });
    }
    const bbox = parsed.bbox;
    const categories = query.categories.filter(key => CATEGORY_BY_KEY.has(key));
    if (categories.length === 0) {
      return res.status(400).json({ error: 'The stored query has no known categories; import the area again instead.' });
    }

    const overpassQuery = buildOverpassQuery(categories, bbox, DEFAULTS.maxFeatures);
    let data;
    try {
      data = await scheduleOverpass(() => fetchOverpass(overpassQuery));
    } catch (err) {
      console.error('Overpass refresh failed:', err.message);
      return res.status(503).json({ error: err.message, retryable: true });
    }

    const { featureCollection: geojson, stats } = osmToFeatureCollection(data.elements, categories);

    if (geojson.features.length === 0) {
      return res.status(409).json({ error: 'OpenStreetMap now returns no features for that area; the dataset was left unchanged.' });
    }

    const history = Array.isArray(row.processing_history) ? [...row.processing_history] : [];
    history.push({
      at: new Date().toISOString(),
      action: 'refresh',
      note: 'Re-queried Overpass with the stored area and categories.',
      previousCount: toNum(row.feature_count),
      featureCount: geojson.features.length,
      stats,
      osmTimestamp: data.osm3s?.timestamp_osm_base || null
    });

    const updated = await pool.query(
      `UPDATE gis_datasets
          SET geojson = $3, feature_count = $4, geometry_type = $5, bbox = $6,
              processing_history = $7, updated_at = CURRENT_TIMESTAMP
        WHERE project_id = $1 AND id = $2
        RETURNING *`,
      [
        req.projectId,
        req.params.datasetId,
        JSON.stringify(geojson),
        geojson.features.length,
        geometryKind(geojson),
        JSON.stringify(collectionBbox(geojson)),
        JSON.stringify(history)
      ]
    );

    res.json(datasetSummary(updated.rows[0]));
  }));

  app.delete('/api/gis/datasets/:projectId/:datasetId', verifyToken, requireProjectAccess(req => req.params.projectId), asyncHandler(async (req, res) => {
    const result = await pool.query(
      'DELETE FROM gis_datasets WHERE project_id = $1 AND id = $2',
      [req.projectId, req.params.datasetId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Dataset not found for this project.' });
    res.json({ success: true, deleted: result.rowCount });
  }));

  // ------------------------------ surveying overlays -----------------------
  // GNSS / control points as a GeoJSON layer, with the CRS the data actually has.
  app.get('/api/gis/survey-points/:projectId', verifyToken, requireProjectAccess(req => req.params.projectId), asyncHandler(async (req, res) => {
    const result = await pool.query(
      'SELECT * FROM surveying_control_points WHERE project_id = $1 ORDER BY id',
      [req.projectId]
    );

    const features = result.rows
      .filter(row => row.latitude !== null && row.longitude !== null)
      .map(row => ({
        type: 'Feature',
        id: `survey/${row.id}`,
        geometry: { type: 'Point', coordinates: [toNum(row.longitude), toNum(row.latitude)] },
        properties: {
          pointId: `CP-${row.id}`,
          name: row.name || `CP-${row.id}`,
          latitude: toNum(row.latitude),
          longitude: toNum(row.longitude),
          benchmarkElevation: row.benchmark_elevation === null ? null : toNum(row.benchmark_elevation),
          groundLevel: row.ground_level === null ? null : toNum(row.ground_level),
          floorLevel: row.floor_level === null ? null : toNum(row.floor_level),
          foundationDepth: row.foundation_depth === null ? null : toNum(row.foundation_depth),
          isBenchmark: Boolean(row.is_benchmark),
          verticalDatum: row.vertical_datum || null,
          recordedAt: row.created_at,
          dataClass: 'survey'
        }
      }));

    res.json({
      type: 'FeatureCollection',
      features,
      crs: 'EPSG:4326',
      crsNote: 'The surveying table stores latitude/longitude columns; no other CRS is recorded for these points.',
      verticalDatum: null,
      verticalDatumNote: 'Vertical datums are stored per point where known; elevations are shown as recorded and are never converted.',
      benchmarkCount: features.filter(feature => feature.properties.isBenchmark).length,
      controlCount: features.filter(feature => !feature.properties.isBenchmark).length,
      count: features.length
    });
  }));

  // CSV import for survey control points. Accepts geographic lon/lat or projected
  // easting/northing in any supported CRS; every point is transformed to EPSG:4326 for
  // storage, and the source CRS is reported back rather than assumed.
  app.post('/api/gis/survey-points/:projectId/import', verifyToken, requireProjectAccess(req => req.params.projectId), importUpload, asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Choose a CSV file to import.' });

    const crsCode = String(req.body.crs || 'EPSG:4326').trim().toUpperCase();
    const definition = crsDefinition(crsCode);
    if (!definition) {
      return res.status(400).json({ error: `Unknown CRS “${crsCode}”. Use one of the CRS codes offered by the workspace.` });
    }

    const verticalDatum = String(req.body.verticalDatum || '').trim().slice(0, 80) || null;
    const parsed = parseCsv(req.file.buffer.toString('utf8'));
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    if (parsed.records.length > 2000) {
      return res.status(400).json({ error: `This file has ${parsed.records.length} rows; import at most 2,000 control points at a time.` });
    }

    const headerMap = new Map(parsed.headers.map(header => [header.toLowerCase().replace(/[\s-]+/g, '_'), header]));
    const pick = (...names) => names.map(name => headerMap.get(name)).find(Boolean);
    const nameKey = pick('name', 'point_name', 'point_id', 'point', 'control_point', 'id');
    const elevationKey = pick('elevation', 'benchmark_elevation', 'elevation_m', 'z', 'height', 'level');
    const benchmarkKey = pick('benchmark', 'is_benchmark', 'point_type', 'type');
    const datumKey = pick('vertical_datum', 'datum');
    const xKey = isGeographic(definition)
      ? pick('longitude', 'lon', 'long', 'x')
      : pick('easting', 'east', 'x');
    const yKey = isGeographic(definition)
      ? pick('latitude', 'lat', 'y')
      : pick('northing', 'north', 'y');

    if (!xKey || !yKey) {
      return res.status(400).json({
        error: isGeographic(definition)
          ? 'CSV needs longitude and latitude columns (or lon/lat, x/y).'
          : `CSV for ${crsCode} needs easting and northing columns (or x/y).`,
        example: isGeographic(definition)
          ? 'name,longitude,latitude,elevation,benchmark'
          : 'name,easting,northing,elevation,benchmark'
      });
    }

    const points = [];
    for (let index = 0; index < parsed.records.length; index += 1) {
      const record = parsed.records[index];
      const rowNumber = index + 2;
      const x = Number(record[xKey]);
      const y = Number(record[yKey]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return res.status(400).json({ error: `Row ${rowNumber}: ${xKey}/${yKey} are not numbers.` });
      }
      let coordinate;
      try {
        coordinate = transformPoint([x, y], crsCode, 'EPSG:4326');
      } catch (err) {
        return res.status(400).json({ error: `Row ${rowNumber}: ${err.message}` });
      }
      const [lon, lat] = coordinate;
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        return res.status(400).json({ error: `Row ${rowNumber}: coordinates are outside the valid latitude/longitude range.` });
      }

      const rawElevation = elevationKey ? String(record[elevationKey] ?? '').trim() : '';
      const elevation = rawElevation === '' ? null : Number(rawElevation);
      if (elevation !== null && !Number.isFinite(elevation)) {
        return res.status(400).json({ error: `Row ${rowNumber}: elevation “${rawElevation}” is not a number.` });
      }

      const benchmarkValue = benchmarkKey ? String(record[benchmarkKey] ?? '').trim() : '';
      points.push({
        name: String((nameKey ? record[nameKey] : '') || `CP-${index + 1}`).trim().slice(0, 120) || `CP-${index + 1}`,
        lon,
        lat,
        elevation,
        isBenchmark: /^(1|true|yes|y|bm|benchmark)$/i.test(benchmarkValue),
        verticalDatum: datumKey && String(record[datumKey] || '').trim()
          ? String(record[datumKey]).trim().slice(0, 80)
          : verticalDatum
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = [];
      for (const point of points) {
        const result = await client.query(
          `INSERT INTO surveying_control_points
             (project_id, name, latitude, longitude, benchmark_elevation, is_benchmark, vertical_datum)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, name, latitude, longitude, benchmark_elevation, is_benchmark, vertical_datum`,
          [req.projectId, point.name, point.lat, point.lon, point.elevation, point.isBenchmark, point.verticalDatum]
        );
        inserted.push(result.rows[0]);
      }
      await client.query('COMMIT');
      const datums = [...new Set(inserted.map(row => row.vertical_datum).filter(Boolean))];
      res.status(201).json({
        imported: inserted.length,
        sourceCrs: crsCode,
        storedCrs: 'EPSG:4326',
        verticalDatum: verticalDatum || (datums.length === 1 ? datums[0] : null),
        verticalDatums: datums,
        benchmarkCount: inserted.filter(row => row.is_benchmark).length,
        points: inserted.map(row => ({
          pointId: `CP-${row.id}`,
          id: row.id,
          name: row.name,
          latitude: toNum(row.latitude),
          longitude: toNum(row.longitude),
          benchmarkElevation: row.benchmark_elevation === null ? null : toNum(row.benchmark_elevation),
          isBenchmark: Boolean(row.is_benchmark),
          verticalDatum: row.vertical_datum || null
        })),
        note: datums.length > 0
          ? `Elevations are stored as recorded in ${datums.map(datum => `“${datum}”`).join(', ')}; they were not converted.`
          : 'No vertical datum was supplied; elevations are stored as recorded, not converted.'
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }));

  // ------------------------------ georeferencing ---------------------------
  app.get('/api/gis/georeferencing/:projectId', verifyToken, requireProjectAccess(req => req.params.projectId), asyncHandler(async (req, res) => {
    const result = await pool.query('SELECT * FROM gis_georeferencing WHERE project_id = $1', [req.projectId]);
    if (result.rows.length === 0) {
      return res.json({ projectId: Number(req.projectId), configured: false });
    }

    const row = result.rows[0];
    const definition = crsDefinition(row.crs);
    res.json({
      projectId: row.project_id,
      configured: true,
      crs: row.crs,
      crsName: definition ? definition.name : null,
      crsKnown: Boolean(definition),
      verticalDatum: row.vertical_datum,
      anchor: {
        lat: row.anchor_lat === null ? null : toNum(row.anchor_lat),
        lon: row.anchor_lon === null ? null : toNum(row.anchor_lon),
        elevation: row.anchor_elevation === null ? null : toNum(row.anchor_elevation)
      },
      modelOrigin: {
        east: row.model_origin_east === null ? null : toNum(row.model_origin_east),
        north: row.model_origin_north === null ? null : toNum(row.model_origin_north),
        up: row.model_origin_up === null ? null : toNum(row.model_origin_up)
      },
      rotationDeg: row.rotation_deg === null ? null : toNum(row.rotation_deg),
      scale: row.scale === null ? null : toNum(row.scale),
      zOffset: row.z_offset === null ? null : toNum(row.z_offset),
      notes: row.notes,
      verifiedBy: row.verified_by,
      updatedAt: row.updated_at
    });
  }));

  app.put('/api/gis/georeferencing/:projectId', verifyToken, requireProjectAccess(req => req.params.projectId), asyncHandler(async (req, res) => {
    const body = req.body || {};
    const problems = [];

    const numberOrNull = (value, label, { min = -Infinity, max = Infinity } = {}) => {
      if (value === null || value === undefined || value === '') return null;
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
        problems.push(`${label} must be a number${Number.isFinite(min) || Number.isFinite(max) ? ` between ${min} and ${max}` : ''}.`);
        return null;
      }
      return parsed;
    };

    const crs = body.crs ? String(body.crs).trim() : null;
    if (crs && !crsDefinition(crs)) {
      problems.push(`CRS ${crs} is not supported. Choose one from GET /api/gis/crs, or leave the CRS empty and record it before setting coordinates.`);
    }

    const lat = numberOrNull(body.anchor?.lat, 'Anchor latitude', { min: -90, max: 90 });
    const lon = numberOrNull(body.anchor?.lon, 'Anchor longitude', { min: -180, max: 180 });
    const elevation = numberOrNull(body.anchor?.elevation, 'Anchor elevation');
    if ((lat === null) !== (lon === null)) problems.push('Provide both anchor latitude and longitude, or neither.');

    const east = numberOrNull(body.modelOrigin?.east, 'Model origin easting');
    const north = numberOrNull(body.modelOrigin?.north, 'Model origin northing');
    const up = numberOrNull(body.modelOrigin?.up, 'Model origin height');
    if (!crs && (east !== null || north !== null)) {
      problems.push('A model origin in projected coordinates needs the CRS those coordinates are in.');
    }

    const rotation = numberOrNull(body.rotationDeg, 'Rotation', { min: -360, max: 360 });
    const scale = numberOrNull(body.scale, 'Scale', { min: 0.000001, max: 1000 });
    const zOffset = numberOrNull(body.zOffset, 'Height offset');

    if (problems.length > 0) {
      return res.status(400).json({ error: `Check the georeferencing values: ${problems.join(' ')}`, problems });
    }

    const result = await pool.query(
      `INSERT INTO gis_georeferencing
         (project_id, crs, vertical_datum, anchor_lat, anchor_lon, anchor_elevation,
          model_origin_east, model_origin_north, model_origin_up, rotation_deg, scale, z_offset,
          notes, verified_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,CURRENT_TIMESTAMP)
       ON CONFLICT (project_id) DO UPDATE SET
         crs = EXCLUDED.crs, vertical_datum = EXCLUDED.vertical_datum,
         anchor_lat = EXCLUDED.anchor_lat, anchor_lon = EXCLUDED.anchor_lon,
         anchor_elevation = EXCLUDED.anchor_elevation,
         model_origin_east = EXCLUDED.model_origin_east, model_origin_north = EXCLUDED.model_origin_north,
         model_origin_up = EXCLUDED.model_origin_up, rotation_deg = EXCLUDED.rotation_deg,
         scale = EXCLUDED.scale, z_offset = EXCLUDED.z_offset, notes = EXCLUDED.notes,
         verified_by = EXCLUDED.verified_by, updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [
        req.projectId, crs, body.verticalDatum ? String(body.verticalDatum).slice(0, 80) : null,
        lat, lon, elevation, east, north, up, rotation, scale, zOffset,
        body.notes ? String(body.notes).slice(0, 2000) : null,
        body.verifiedBy ? String(body.verifiedBy).slice(0, 160) : null
      ]
    );

    res.json({ success: true, georeferencing: result.rows[0] });
  }));

  // Alignment report: compares what is recorded and names every gap instead of assuming.
  app.get('/api/gis/alignment/:projectId', verifyToken, requireProjectAccess(req => req.params.projectId), asyncHandler(async (req, res) => {
    const projectId = req.projectId;
    const [geo, survey, datasets] = await Promise.all([
      pool.query('SELECT * FROM gis_georeferencing WHERE project_id = $1', [projectId]),
      pool.query('SELECT * FROM surveying_control_points WHERE project_id = $1', [projectId]),
      pool.query('SELECT COUNT(*) AS count FROM gis_datasets WHERE project_id = $1', [projectId])
    ]);

    const findings = [];
    const add = (severity, message, value) => findings.push({ severity, message, value: value === undefined ? null : value });

    if (geo.rows.length === 0) {
      add('warning', 'No georeferencing is saved for this project, so a BIM/CAD model cannot be placed on the map.');
    }

    if (datasets.rows[0] && toNum(datasets.rows[0].count) > 0) {
      add('info', `${toNum(datasets.rows[0].count)} imported OSM dataset(s) are available as context; they are not verified measurements.`);
    }

    const georef = geo.rows[0] || null;
    let anchor = null;
    let crsKnown = null;

    if (georef && georef.anchor_lat !== null && georef.anchor_lon !== null) {
      anchor = { lat: toNum(georef.anchor_lat), lon: toNum(georef.anchor_lon) };
    }

    if (georef) {
      crsKnown = georef.crs ? Boolean(crsDefinition(georef.crs)) : false;
      if (!georef.crs) {
        add('warning', 'No CRS is recorded for the model coordinates. Set one explicitly; local model coordinates are not geographic coordinates.');
      } else if (!crsKnown) {
        add('error', `The recorded CRS ${georef.crs} has no definition in this system, so no transform can be checked.`);
      }
      if (!georef.vertical_datum) {
        add('info', 'No vertical datum is recorded; heights are shown as entered, with no conversion.');
      }
    }

    // Model origin, if it is expressed in a CRS we can project.
    let modelOriginOnMap = null;
    if (georef && georef.model_origin_east !== null && georef.model_origin_north !== null) {
      if (georef.crs && crsKnown) {
        try {
          const definition = crsDefinition(georef.crs);
          const transformed = definition.units === 'degrees'
            ? [toNum(georef.model_origin_east), toNum(georef.model_origin_north)]
            : transformPoint([toNum(georef.model_origin_east), toNum(georef.model_origin_north)], georef.crs, 'EPSG:4326');
          modelOriginOnMap = { lat: transformed[1], lon: transformed[0] };

          if (anchor) {
            const distance = haversineMetres(anchor.lat, anchor.lon, modelOriginOnMap.lat, modelOriginOnMap.lon);
            add(
              distance > 25 ? 'warning' : 'ok',
              `Model origin sits ${distance.toFixed(1)} m from the recorded anchor.`,
              { distanceMetres: Number(distance.toFixed(2)) }
            );
          } else {
            add('info', 'The model origin projects to a map position, but no anchor is recorded to compare it with.', modelOriginOnMap);
          }
        } catch (err) {
          add('error', `The model origin could not be projected: ${err.message}`);
        }
      } else {
        add('warning', 'The model origin is recorded but cannot be placed because the CRS is missing or unknown.', {
          east: toNum(georef.model_origin_east),
          north: toNum(georef.model_origin_north)
        });
      }
    }

    const surveyPoints = survey.rows.filter(row => row.latitude !== null && row.longitude !== null);
    if (surveyPoints.length === 0) {
      add('info', 'No GNSS/control points are recorded for this project, so there is nothing to align a model against.');
    } else {
      add('ok', `${surveyPoints.length} survey control point(s) are recorded (EPSG:4326, no vertical datum).`);

      if (anchor) {
        const distances = surveyPoints.map(row => haversineMetres(
          anchor.lat, anchor.lon, toNum(row.latitude), toNum(row.longitude)
        ));
        const nearest = Math.min(...distances);
        add(
          nearest <= 500 ? 'ok' : 'warning',
          `Nearest control point is ${nearest.toFixed(1)} m from the anchor.`,
          { nearestMetres: Number(nearest.toFixed(2)) }
        );
      }
    }

    res.json({
      projectId: Number(projectId),
      georeferencing: georef ? {
        crs: georef.crs,
        anchor,
        modelOriginOnMap,
        verticalDatum: georef.vertical_datum,
        rotationDeg: georef.rotation_deg === null ? null : toNum(georef.rotation_deg),
        scale: georef.scale === null ? null : toNum(georef.scale),
        zOffset: georef.z_offset === null ? null : toNum(georef.z_offset),
        verifiedBy: georef.verified_by
      } : null,
      findings,
      note: 'A model without a recorded CRS and anchor is not georeferenced: local BIM coordinates are not geographic coordinates.'
    });
  }));

  // ------------------------------ CRS + transform --------------------------
  app.get('/api/gis/crs', verifyToken, (req, res) => {
    res.json({
      crs: listCrs(),
      note: 'Only the systems listed here (and UTM zones named by an explicit EPSG code) are supported. Nothing is inferred from coordinates.'
    });
  });

  app.post('/api/gis/transform', verifyToken, asyncHandler(async (req, res) => {
    const { coordinates, fromCrs, toCrs } = req.body || {};
    if (!Array.isArray(coordinates) || coordinates.length !== 2 || !coordinates.every(value => Number.isFinite(Number(value)))) {
      return res.status(400).json({ error: 'coordinates must be [easting, northing] or [longitude, latitude].' });
    }
    if (!fromCrs || !toCrs) {
      return res.status(400).json({ error: 'fromCrs and toCrs are required; this system never guesses a CRS.' });
    }

    try {
      const output = transformPoint(coordinates, fromCrs, toCrs);
      res.json({ fromCrs, toCrs, input: coordinates.map(Number), output });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }));

  // Called once from the backend's startup schema preparation.
  app.locals.ensureGisSchema = ensureGisSchema;
  app.locals.gisDefaults = DEFAULTS;

  return { ensureGisSchema, CRS: listCrs(), DEFAULTS };
};

module.exports.transformPoint = transformPoint;
module.exports.crsDefinition = crsDefinition;
module.exports.bboxOfGeometry = bboxOfGeometry;
module.exports.haversineMetres = haversineMetres;
module.exports.buildOverpassQuery = buildOverpassQuery;
module.exports.osmToFeatureCollection = osmToFeatureCollection;
module.exports.osmNodeToGeoJson = osmNodeToGeoJson;
module.exports.osmWayToGeoJson = osmWayToGeoJson;
module.exports.osmRelationToGeoJson = osmRelationToGeoJson;
module.exports.isAreaGeometry = isAreaGeometry;
module.exports.parseBbox = parseBbox;
module.exports.validateGeographic = validateGeographic;
module.exports.ATTRIBUTION = OSM_ATTRIBUTION;
