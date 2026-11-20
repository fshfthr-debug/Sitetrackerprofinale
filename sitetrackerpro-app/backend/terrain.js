'use strict';
/**
 * DEM / terrain module.
 *
 * A GeoTIFF is uploaded, validated (signature, GeoTIFF metadata, CRS, dimensions), scanned in
 * windows for statistics, and reduced to a preview grid for the Three.js viewer. The original
 * file is kept on the uploads volume; only metadata and the preview grid file are derived.
 * Nothing here guesses a CRS, a vertical datum or an elevation scaling: unsupported or missing
 * CRS is an error the user sees.
 *
 * Derivatives (hillshade, slope, aspect, contours) are computed from the preview grid and are
 * labelled as preview-derived. They are visualization aids, never engineering surfaces.
 *
 * Mounted by backend-v3-enhanced.js:
 *   createTerrainModule({ app, pool, verifyToken, requireProjectAccess, uploadDir })
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { PNG } = require('pngjs');
const proj4 = require('proj4');
const { fromFile } = require('geotiff');

// ---------------------------------------------------------------------------
// Limits. Everything a request can cost is bounded.
// ---------------------------------------------------------------------------
const LIMITS = {
  maxFileBytes: Number(process.env.TERRAIN_MAX_MB || 200) * 1024 * 1024,
  maxDimension: 30000,
  maxPixels: 100000000, // 100 megapixels
  previewMax: 512,
  statsTile: 512,
  maxContourPoints: 120000,
  maxContourFeatures: 4000
};

// CRS policy: geographic WGS 84 and WGS 84 UTM zones. Everything else is refused explicitly,
// because a DEM in an unknown datum cannot be compared with survey benchmarks safely.
const SUPPORTED_CRS_NOTE = 'Supported CRS: EPSG:4326 (WGS 84) and WGS 84 / UTM zones 32601–32660 (north) and 32701–32760 (south).';

function crsDefinition(code) {
  const numeric = Number(code);
  if (!Number.isFinite(numeric)) return null;
  if (numeric === 4326) return { epsg: 4326, name: 'WGS 84 geographic', units: 'degrees' };
  if (numeric >= 32601 && numeric <= 32660) {
    return { epsg: numeric, name: `WGS 84 / UTM zone ${numeric - 32600}N`, units: 'metres', def: `+proj=utm +zone=${numeric - 32600} +datum=WGS84 +units=m +no_defs` };
  }
  if (numeric >= 32701 && numeric <= 32760) {
    return { epsg: numeric, name: `WGS 84 / UTM zone ${numeric - 32700}S`, units: 'metres', def: `+proj=utm +zone=${numeric - 32700} +south +datum=WGS84 +units=m +no_defs` };
  }
  return null;
}

function transformWgs84To(code, lon, lat) {
  const target = crsDefinition(code);
  if (!target) throw new Error(`Unsupported CRS EPSG:${code}.`);
  if (target.epsg === 4326) return [lon, lat];
  const result = proj4('+proj=longlat +datum=WGS84 +no_defs', target.def, [lon, lat]);
  return [Number(result[0]), Number(result[1])];
}

const isNoData = (value, noData) => Number.isNaN(value) || (noData !== null && value === noData);

function haversineMetres(lat1, lon1, lat2, lon2) {
  const R = 6371008.8;
  const toRad = value => (value * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ---------------------------------------------------------------------------
// Storage adapter. This is the only code that knows where bytes live. Replacing it with an
// S3-compatible driver later does not touch routes, metadata or the database.
// ---------------------------------------------------------------------------
function createLocalVolumeStorage(rootDir) {
  const root = path.resolve(rootDir);

  const absolute = key => {
    const resolved = path.resolve(root, key);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error('Storage key escapes the uploads volume.');
    }
    return resolved;
  };

  return {
    driver: 'local-volume',
    root,
    absolute,
    async putFromTemp(tempPath, key) {
      const destination = absolute(key);
      await fs.promises.mkdir(path.dirname(destination), { recursive: true });
      await fs.promises.rename(tempPath, destination);
      return key;
    },
    async writeBuffer(buffer, key) {
      const destination = absolute(key);
      await fs.promises.mkdir(path.dirname(destination), { recursive: true });
      await fs.promises.writeFile(destination, buffer);
      return key;
    },
    async readBuffer(key) {
      return fs.promises.readFile(absolute(key));
    },
    async size(key) {
      return (await fs.promises.stat(absolute(key))).size;
    },
    async sha256(key) {
      return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        fs.createReadStream(absolute(key))
          .on('data', chunk => hash.update(chunk))
          .on('end', () => resolve(hash.digest('hex')))
          .on('error', reject);
      });
    },
    async remove(key) {
      try {
        await fs.promises.unlink(absolute(key));
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
  };
}

// TIFF signatures: classic little/big endian and BigTIFF.
function isTiffSignature(buffer) {
  if (!buffer || buffer.length < 4) return false;
  const [b0, b1, b2, b3] = buffer;
  return (b0 === 0x49 && b1 === 0x49 && b2 === 0x2a && b3 === 0x00)
    || (b0 === 0x4d && b1 === 0x4d && b2 === 0x00 && b3 === 0x2a)
    || (b0 === 0x49 && b1 === 0x49 && b2 === 0x2b && b3 === 0x00)
    || (b0 === 0x4d && b1 === 0x4d && b2 === 0x00 && b3 === 0x2b);
}

// ---------------------------------------------------------------------------
// Preview-grade derivatives. All of them work on the <=512 preview grid.
// ---------------------------------------------------------------------------
function pixelSizesMetres(bounds, crs, width, height, pixelSizeX, pixelSizeY) {
  if (crs.epsg !== 4326) {
    return {
      dx: Math.abs((bounds[2] - bounds[0]) / Math.max(1, width - 1)),
      dy: Math.abs((bounds[3] - bounds[1]) / Math.max(1, height - 1))
    };
  }
  // Geographic degrees: convert at the centre latitude, and say so in the response.
  const midLat = (bounds[1] + bounds[3]) / 2;
  return {
    dx: Math.abs(pixelSizeX) * 111320 * Math.cos((midLat * Math.PI) / 180),
    dy: Math.abs(pixelSizeY) * 110540,
    approximated: true
  };
}

function buildHillshade(grid, width, height, noData, dx, dy, { azimuth = 315, altitude = 45 } = {}) {
  const png = new PNG({ width, height });
  const az = ((90 - azimuth) * Math.PI) / 180;
  const alt = (altitude * Math.PI) / 180;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const z = grid[y * width + x];
      if (Number.isNaN(z)) {
        png.data[index + 3] = 0;
        continue;
      }

      const left = grid[y * width + Math.max(0, x - 1)];
      const right = grid[y * width + Math.min(width - 1, x + 1)];
      const up = grid[Math.max(0, y - 1) * width + x];
      const down = grid[Math.min(height - 1, y + 1) * width + x];
      if ([left, right, up, down].some(Number.isNaN)) {
        png.data[index + 3] = 0;
        continue;
      }

      const dzdx = (right - left) / (2 * dx);
      const dzdy = (up - down) / (2 * dy); // grid row 0 is north
      const slope = Math.atan(Math.hypot(dzdx, dzdy));
      const aspect = Math.atan2(-dzdx, dzdy);
      const shade = Math.max(0, Math.sin(alt) * Math.cos(slope) + Math.cos(alt) * Math.sin(slope) * Math.cos(az - aspect));

      const value = Math.round(shade * 255);
      png.data[index] = value;
      png.data[index + 1] = value;
      png.data[index + 2] = value;
      png.data[index + 3] = 255;
    }
  }

  return PNG.sync.write(png);
}

function buildSlopeOrAspect(grid, width, height, dx, dy, kind) {
  const png = new PNG({ width, height });

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const left = grid[y * width + Math.max(0, x - 1)];
      const right = grid[y * width + Math.min(width - 1, x + 1)];
      const up = grid[Math.max(0, y - 1) * width + x];
      const down = grid[Math.min(height - 1, y + 1) * width + x];
      if ([left, right, up, down].some(Number.isNaN)) {
        png.data[index + 3] = 0;
        continue;
      }

      const dzdx = (right - left) / (2 * dx);
      const dzdy = (up - down) / (2 * dy);

      let value;
      if (kind === 'slope') {
        const degrees = (Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI;
        value = Math.round((degrees / 90) * 255);
      } else {
        const degrees = ((Math.atan2(-dzdx, dzdy) * 180) / Math.PI + 360) % 360; // 0 = north, clockwise
        value = Math.round((degrees / 360) * 255);
      }

      png.data[index] = value;
      png.data[index + 1] = value;
      png.data[index + 2] = value;
      png.data[index + 3] = 255;
    }
  }

  return PNG.sync.write(png);
}

// Marching squares on the preview grid. Segments are not merged: this is a visual overlay,
// and each segment carries its elevation property.
function buildContours(grid, width, height, interval, bounds, crs) {
  const featureLines = [];
  let points = 0;
  const xs = index => bounds[0] + ((bounds[2] - bounds[0]) * index) / Math.max(1, width - 1);
  const ys = index => bounds[3] - ((bounds[3] - bounds[1]) * index) / Math.max(1, height - 1);

  // Accumulate rather than Math.min(...array): spreading a 512 x 512 grid overflows the stack.
  let zMin = Infinity;
  let zMax = -Infinity;
  let validCells = 0;
  for (let i = 0; i < grid.length; i += 1) {
    const value = grid[i];
    if (Number.isNaN(value)) continue;
    validCells += 1;
    if (value < zMin) zMin = value;
    if (value > zMax) zMax = value;
  }
  if (validCells === 0) return { type: 'FeatureCollection', features: [], metadata: { previewDerived: true, source: 'preview grid (max 512 px)' } };
  const step = interval > 0 ? interval : Math.max(0.5, Math.round((zMax - zMin) / 20 * 10) / 10);
  const first = Math.ceil(zMin / step) * step;

  for (let level = first; level < zMax && featureLines.length < LIMITS.maxContourFeatures; level += step) {
    for (let y = 0; y < height - 1 && featureLines.length < LIMITS.maxContourFeatures; y += 1) {
      for (let x = 0; x < width - 1 && featureLines.length < LIMITS.maxContourFeatures; x += 1) {
        const z00 = grid[y * width + x];
        const z10 = grid[y * width + x + 1];
        const z01 = grid[(y + 1) * width + x];
        const z11 = grid[(y + 1) * width + x + 1];
        if ([z00, z10, z01, z11].some(Number.isNaN)) continue;

        const corners = [[z00, x, y], [z10, x + 1, y], [z11, x + 1, y + 1], [z01, x, y + 1]];
        const crossings = [];
        // Threshold classification (>= level) rather than strict multiplication: quantized DEMs
        // contain many cells exactly equal to a contour level, and those still form an edge.
        for (let i = 0; i < 4; i += 1) {
          const [za, xa, ya] = corners[i];
          const [zb, xb, yb] = corners[(i + 1) % 4];
          if ((za >= level) !== (zb >= level) && za !== zb) {
            const t = Math.min(1, Math.max(0, (level - za) / (zb - za)));
            crossings.push([xa + (xb - xa) * t, ya + (yb - ya) * t]);
          }
        }

        // Two crossings = one segment; four = ambiguous saddle, emit two segments.
        for (let i = 0; i + 1 < crossings.length; i += 2) {
          const a = crossings[i];
          const b = crossings[i + 1];
          featureLines.push({
            type: 'Feature',
            geometry: {
              type: 'LineString',
              coordinates: [[xs(a[0]), ys(a[1])], [xs(b[0]), ys(b[1])]]
            },
            properties: { elevation: Number(level.toFixed(3)), crs: `EPSG:${crs.epsg}` }
          });
          points += 2;
          if (points >= LIMITS.maxContourPoints) break;
        }
      }
    }
  }

  return {
    type: 'FeatureCollection',
    features: featureLines,
    metadata: {
      interval: step,
      crs: `EPSG:${crs.epsg}`,
      source: 'preview grid (max 512 px)',
      previewDerived: true,
      note: 'Contours are generated from the visualization preview, not the full-resolution DEM. Do not use them for engineering earthwork quantities.',
      truncated: points >= LIMITS.maxContourPoints || featureLines.length >= LIMITS.maxContourFeatures
    }
  };
}

// Bilinear sample of the preview grid at a CRS coordinate (used only as a fallback; benchmarks
// are sampled from the full raster where possible).
function sampleGrid(grid, width, height, fx, fy) {
  if (fx < 0 || fy < 0 || fx > width - 1 || fy > height - 1) return null;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const wx = fx - x0;
  const wy = fy - y0;
  const corners = [grid[y0 * width + x0], grid[y0 * width + x1], grid[y1 * width + x0], grid[y1 * width + x1]];
  if (corners.some(Number.isNaN)) return null;
  return corners[0] * (1 - wx) * (1 - wy) + corners[1] * wx * (1 - wy) + corners[2] * (1 - wx) * wy + corners[3] * wx * wy;
}

// ---------------------------------------------------------------------------

module.exports = function createTerrainModule({
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
  const storage = createLocalVolumeStorage(uploadDir || path.join(__dirname, 'uploads'));

  const tempDir = path.join(storage.root, 'terrain', 'tmp');
  fs.mkdirSync(tempDir, { recursive: true });

  const terrainUpload = multer({
    dest: tempDir,
    limits: { fileSize: LIMITS.maxFileBytes }
  });

  async function ensureTerrainSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS terrain_surveys (
        id SERIAL PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        original_name VARCHAR(255) NOT NULL,
        storage_key VARCHAR(512) NOT NULL,
        preview_key VARCHAR(512),
        file_bytes BIGINT,
        sha256 VARCHAR(64),
        crs VARCHAR(40),
        epsg INTEGER,
        vertical_datum VARCHAR(80),
        width INTEGER,
        height INTEGER,
        pixel_size_x NUMERIC(18,10),
        pixel_size_y NUMERIC(18,10),
        bounds JSONB,
        band_count INTEGER,
        data_type VARCHAR(40),
        no_data_value DOUBLE PRECISION,
        z_min DOUBLE PRECISION,
        z_max DOUBLE PRECISION,
        z_mean DOUBLE PRECISION,
        preview_width INTEGER,
        preview_height INTEGER,
        status VARCHAR(20) NOT NULL DEFAULT 'processing',
        error_message TEXT,
        source VARCHAR(120),
        licence VARCHAR(120),
        attribution TEXT,
        processing_history JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_terrain_project ON terrain_surveys(project_id)');
  }

  const summary = row => ({
    id: row.id,
    projectId: row.project_id,
    originalName: row.original_name,
    storageDriver: storage.driver,
    fileBytes: toNum(row.file_bytes),
    crs: row.crs,
    epsg: row.epsg,
    crsName: row.epsg ? (crsDefinition(row.epsg) || {}).name || null : null,
    verticalDatum: row.vertical_datum,
    width: row.width,
    height: row.height,
    pixelSize: {
      x: row.pixel_size_x === null ? null : toNum(row.pixel_size_x),
      y: row.pixel_size_y === null ? null : toNum(row.pixel_size_y)
    },
    bounds: row.bounds,
    bandCount: row.band_count,
    dataType: row.data_type,
    noDataValue: row.no_data_value,
    statistics: {
      min: row.z_min === null ? null : toNum(row.z_min),
      max: row.z_max === null ? null : toNum(row.z_max),
      mean: row.z_mean === null ? null : toNum(row.z_mean)
    },
    preview: row.preview_width ? { width: row.preview_width, height: row.preview_height } : null,
    previewDerived: true,
    status: row.status,
    error: row.error_message,
    source: row.source,
    licence: row.licence,
    attribution: row.attribution,
    processingHistory: row.processing_history,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sha256: row.sha256
  });

  async function loadSurvey(projectId, surveyId) {
    const result = await pool.query('SELECT * FROM terrain_surveys WHERE project_id = $1 AND id = $2', [projectId, surveyId]);
    if (result.rows.length === 0) return null;
    return result.rows[0];
  }

  // -------------------------------------------------------------------------
  // Upload and processing
  // -------------------------------------------------------------------------
  app.post('/api/terrain/:projectId/upload', verifyToken, requireProjectAccess(req => req.params.projectId), terrainUpload.single('file'), asyncHandler(async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded (send the GeoTIFF as the "file" field).' });
    }

    const tempPath = req.file.path;
    const projectId = Number(req.projectId);
    const originalName = String(req.file.originalname || 'dem.tif').slice(0, 255);
    const key = `terrain/${projectId}/${crypto.randomUUID()}.tif`;
    const previewKey = key.replace(/\.tif$/, '.preview.f32');

    let created = null;

    const fail = async (status, message) => {
      await storage.remove(key).catch(() => {});
      await storage.remove(previewKey).catch(() => {});
      await fs.promises.unlink(tempPath).catch(() => {});

      if (created) {
        const history = [{ at: new Date().toISOString(), action: 'failed', error: message }];
        await pool.query(
          `UPDATE terrain_surveys
              SET status = 'failed', error_message = $2, processing_history = $3, updated_at = CURRENT_TIMESTAMP
            WHERE id = $1`,
          [created.id, String(message).slice(0, 2000), JSON.stringify(history)]
        ).catch(() => {});
        return res.status(status).json({
          error: message,
          survey: { id: created.id, status: 'failed', originalName }
        });
      }

      return res.status(status).json({ error: message });
    };

    try {
      // Signature check before anything else: an extension means nothing.
      const header = Buffer.alloc(4);
      const handle = await fs.promises.open(tempPath, 'r');
      try {
        await handle.read(header, 0, 4, 0);
      } finally {
        await handle.close();
      }
      if (!isTiffSignature(header)) {
        return fail(422, 'That file is not a TIFF/GeoTIFF (the file signature does not match). Export it as GeoTIFF and try again.');
      }

      const size = (await fs.promises.stat(tempPath)).size;
      if (size === 0) return fail(422, 'The uploaded file is empty.');

      created = (await pool.query(
        `INSERT INTO terrain_surveys (project_id, original_name, storage_key, preview_key, file_bytes, status, source, processing_history)
         VALUES ($1, $2, $3, $4, $5, 'processing', 'GeoTIFF upload', $6)
         RETURNING *`,
        [projectId, originalName, key, previewKey, size, JSON.stringify([{ at: new Date().toISOString(), action: 'upload', fileBytes: size }])]
      )).rows[0];

      await storage.putFromTemp(tempPath, key);

      let tiff;
      try {
        tiff = await fromFile(storage.absolute(key));
      } catch (err) {
        return fail(422, `The GeoTIFF could not be read: ${err.message}`);
      }

      const image = await tiff.getImage();
      const width = image.getWidth();
      const height = image.getHeight();

      if (!Number.isFinite(width) || !Number.isFinite(height) || width < 2 || height < 2) {
        return fail(422, `The raster is ${width} × ${height}; at least 2 × 2 cells are required.`);
      }
      if (width > LIMITS.maxDimension || height > LIMITS.maxDimension) {
        return fail(422, `The raster is ${width} × ${height}; the limit is ${LIMITS.maxDimension} px per side. Resample or tile the DEM first.`);
      }
      if (width * height > LIMITS.maxPixels) {
        return fail(422, `The raster has ${Math.round(width * height / 1e6)} megapixels; the limit is ${LIMITS.maxPixels / 1e6}.`);
      }

      const geoKeys = image.getGeoKeys() || {};
      const projected = Number(geoKeys.ProjectedCSTypeGeoKey);
      const geographic = Number(geoKeys.GeographicTypeGeoKey);
      const epsg = Number.isFinite(projected) && projected > 0 ? projected : (Number.isFinite(geographic) && geographic > 0 ? geographic : null);

      if (epsg === null) {
        return fail(422, 'This GeoTIFF has no CRS recorded (no projection GeoKey). It is refused rather than assigned a guessed CRS; georeference it in QGIS/GDAL and upload it again.');
      }
      if (epsg === 32767) {
        return fail(422, 'This GeoTIFF uses a user-defined CRS (EPSG:32767), which cannot be interpreted safely. Save it with a standard EPSG code and upload it again.');
      }

      const crs = crsDefinition(epsg);
      if (!crs) {
        return fail(422, `The GeoTIFF declares EPSG:${epsg}, which this module does not support. ${SUPPORTED_CRS_NOTE}`);
      }
      if (crs.units === 'metres' && geoKeys.ProjLinearUnitsGeoKey !== undefined && Number(geoKeys.ProjLinearUnitsGeoKey) !== 9001) {
        return fail(422, `The raster declares linear units ${geoKeys.ProjLinearUnitsGeoKey}; only metres (9001) are supported for projected CRS.`);
      }

      const fileDirectory = image.fileDirectory || {};
      const pixelScale = fileDirectory.ModelPixelScale;
      const tiepoint = fileDirectory.ModelTiepoint;
      // geotiff.js returns typed arrays here, so accept any array-like with enough entries.
      if (!pixelScale || !tiepoint || pixelScale.length < 2 || tiepoint.length < 6) {
        return fail(422, 'This GeoTIFF has no usable georeferencing (ModelPixelScale/ModelTiepoint are missing), so its cell positions cannot be placed on the map.');
      }

      const scaleX = Number(pixelScale[0]);
      const scaleY = Number(pixelScale[1]);
      const originX = Number(tiepoint[3]) - Number(tiepoint[0]) * scaleX;
      const originY = Number(tiepoint[4]) + Number(tiepoint[1]) * scaleY;
      const bounds = [originX, originY - height * scaleY, originX + width * scaleX, originY];

      const noDataRaw = image.getGDALNoData();
      const noData = noDataRaw === null || noDataRaw === undefined || Number.isNaN(Number(noDataRaw)) ? null : Number(noDataRaw);
      const bandCount = image.getSamplesPerPixel();
      const bits = image.getBitsPerSample();
      const sampleFormat = image.getSampleFormat() || 1;
      const formatNames = { 1: 'unsigned integer', 2: 'signed integer', 3: 'float' };
      const dataType = `${formatNames[sampleFormat] || 'unknown'} ${bits}-bit`;

      // Windowed statistics: the raster is never read whole.
      let count = 0;
      let sum = 0;
      let min = Infinity;
      let max = -Infinity;

      for (let y = 0; y < height; y += LIMITS.statsTile) {
        for (let x = 0; x < width; x += LIMITS.statsTile) {
          const w = Math.min(LIMITS.statsTile, width - x);
          const h = Math.min(LIMITS.statsTile, height - y);
          const rasters = await image.readRasters({ window: [x, y, x + w, y + h], samples: [0], interleave: false });
          const band = rasters[0];
          for (let i = 0; i < band.length; i += 1) {
            const value = band[i];
            if (isNoData(value, noData)) continue;
            count += 1;
            sum += value;
            if (value < min) min = value;
            if (value > max) max = value;
          }
        }
      }

      if (count === 0) {
        return fail(422, 'Every cell in this raster is NoData, so there is no elevation to display.');
      }

      const zMin = min;
      const zMax = max;
      const zMean = sum / count;

      // Preview grid: <= 512 px per side, nearest-neighbour so no elevation is invented.
      const factor = Math.min(1, LIMITS.previewMax / Math.max(width, height));
      const previewWidth = Math.max(2, Math.round(width * factor));
      const previewHeight = Math.max(2, Math.round(height * factor));
      const previewRasters = await image.readRasters({
        width: previewWidth,
        height: previewHeight,
        samples: [0],
        interleave: false,
        resampleMethod: 'nearest'
      });
      const source = previewRasters[0];
      const grid = new Float32Array(previewWidth * previewHeight);
      for (let i = 0; i < grid.length; i += 1) {
        const value = Number(source[i]);
        grid[i] = isNoData(value, noData) ? Number.NaN : value;
      }

      const previewBuffer = Buffer.alloc(grid.length * 4);
      for (let i = 0; i < grid.length; i += 1) previewBuffer.writeFloatLE(grid[i], i * 4);
      await storage.writeBuffer(previewBuffer, previewKey);

      const sha256 = await storage.sha256(key);
      const history = [
        { at: new Date().toISOString(), action: 'upload', fileBytes: size },
        {
          at: new Date().toISOString(),
          action: 'processed',
          crs: `EPSG:${epsg}`,
          dimensions: `${width}×${height}`,
          validCells: count,
          preview: `${previewWidth}×${previewHeight}`,
          note: 'Statistics computed from the full raster in windows; preview decimated with nearest-neighbour.'
        }
      ];

      const updated = await pool.query(
        `UPDATE terrain_surveys
            SET sha256 = $2, crs = $3, epsg = $4, vertical_datum = $5, width = $6, height = $7,
                pixel_size_x = $8, pixel_size_y = $9, bounds = $10, band_count = $11, data_type = $12,
                no_data_value = $13, z_min = $14, z_max = $15, z_mean = $16,
                preview_width = $17, preview_height = $18, status = 'ready', error_message = NULL,
                processing_history = $19, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
          RETURNING *`,
        [
          created.id, sha256, `EPSG:${epsg}`, epsg,
          req.body.verticalDatum ? String(req.body.verticalDatum).slice(0, 80) : null,
          width, height, Math.abs(scaleX), Math.abs(scaleY), JSON.stringify(bounds),
          bandCount, dataType, noData, zMin, zMax, zMean,
          previewWidth, previewHeight, JSON.stringify(history)
        ]
      );

      res.status(201).json({
        success: true,
        survey: summary(updated.rows[0]),
        note: 'The preview grid is for visualization only; it is not the authoritative source for earthwork quantities.'
      });
    } catch (err) {
      const message = /invalid|corrupt|unexpected|TIFF/i.test(err.message || '')
        ? `The GeoTIFF could not be processed: ${err.message}`
        : err.message;
      return fail(422, message);
    }
  }));

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------
  app.get('/api/terrain/:projectId', verifyToken, requireProjectAccess(req => req.params.projectId), asyncHandler(async (req, res) => {
    const result = await pool.query('SELECT * FROM terrain_surveys WHERE project_id = $1 ORDER BY created_at DESC', [req.projectId]);
    res.json(result.rows.map(summary));
  }));

  app.get('/api/terrain/:projectId/:surveyId', verifyToken, requireProjectAccess(req => req.params.projectId), asyncHandler(async (req, res) => {
    const row = await loadSurvey(req.projectId, req.params.surveyId);
    if (!row) return res.status(404).json({ error: 'Terrain survey not found for this project.' });
    res.json(summary(row));
  }));

  app.get('/api/terrain/:projectId/:surveyId/preview', verifyToken, requireProjectAccess(req => req.params.projectId), asyncHandler(async (req, res) => {
    const row = await loadSurvey(req.projectId, req.params.surveyId);
    if (!row) return res.status(404).json({ error: 'Terrain survey not found for this project.' });
    if (row.status !== 'ready') return res.status(409).json({ error: `This survey is ${row.status}: ${row.error_message || 'not processed yet'}` });

    const crs = crsDefinition(row.epsg);
    const meters = pixelSizesMetres(row.bounds, crs || { epsg: 0 }, row.width, row.height, toNum(row.pixel_size_x), toNum(row.pixel_size_y));

    res.json({
      surveyId: row.id,
      projectId: row.project_id,
      crs: row.crs,
      crsName: crs ? crs.name : null,
      verticalDatum: row.vertical_datum,
      bounds: row.bounds,
      fullResolution: { width: row.width, height: row.height, pixelSize: { x: toNum(row.pixel_size_x), y: toNum(row.pixel_size_y) } },
      preview: {
        width: row.preview_width,
        height: row.preview_height,
        encoding: 'float32-le',
        noData: 'NaN',
        url: `/api/terrain/${row.project_id}/${row.id}/preview.bin`
      },
      cellSizeMetres: { x: meters.dx, y: meters.dy, approximated: Boolean(meters.approximated) },
      statistics: {
        min: toNum(row.z_min),
        max: toNum(row.z_max),
        mean: toNum(row.z_mean),
        range: toNum(row.z_max) - toNum(row.z_min)
      },
      note: 'Preview grid only (max 512 px). Visualization, not an engineering surface.'
    });
  }));

  app.get('/api/terrain/:projectId/:surveyId/preview.bin', verifyToken, requireProjectAccess(req => req.params.projectId), asyncHandler(async (req, res) => {
    const row = await loadSurvey(req.projectId, req.params.surveyId);
    if (!row) return res.status(404).json({ error: 'Terrain survey not found for this project.' });
    if (row.status !== 'ready' || !row.preview_key) return res.status(409).json({ error: `This survey is ${row.status}.` });

    const buffer = await storage.readBuffer(row.preview_key);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Preview-Width', String(row.preview_width));
    res.setHeader('X-Preview-Height', String(row.preview_height));
    res.setHeader('X-No-Data', 'NaN');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(buffer);
  }));

  async function derivativeImage(req, res, kind) {
    const row = await loadSurvey(req.projectId, req.params.surveyId);
    if (!row) return res.status(404).json({ error: 'Terrain survey not found for this project.' });
    if (row.status !== 'ready') return res.status(409).json({ error: `This survey is ${row.status}.` });

    const buffer = await storage.readBuffer(row.preview_key);
    const width = row.preview_width;
    const height = row.preview_height;
    const grid = new Float32Array(width * height);
    for (let i = 0; i < grid.length; i += 1) grid[i] = buffer.readFloatLE(i * 4);

    const crs = crsDefinition(row.epsg);
    const meters = pixelSizesMetres(row.bounds, crs, row.width, row.height, toNum(row.pixel_size_x), toNum(row.pixel_size_y));

    let png;
    if (kind === 'hillshade') {
      png = buildHillshade(grid, width, height, row.no_data_value, meters.dx, meters.dy, {
        azimuth: req.query.azimuth ? Number(req.query.azimuth) : 315,
        altitude: req.query.altitude ? Number(req.query.altitude) : 45
      });
    } else {
      png = buildSlopeOrAspect(grid, width, height, meters.dx, meters.dy, kind);
    }

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('X-Terrain-Source', 'preview-grid');
    res.setHeader('X-Preview-Width', String(width));
    res.setHeader('X-Preview-Height', String(height));
    res.send(png);
  }

  app.get('/api/terrain/:projectId/:surveyId/hillshade.png', verifyToken, requireProjectAccess(req => req.params.projectId), asyncHandler((req, res) => derivativeImage(req, res, 'hillshade')));
  app.get('/api/terrain/:projectId/:surveyId/slope.png', verifyToken, requireProjectAccess(req => req.params.projectId), asyncHandler((req, res) => derivativeImage(req, res, 'slope')));
  app.get('/api/terrain/:projectId/:surveyId/aspect.png', verifyToken, requireProjectAccess(req => req.params.projectId), asyncHandler((req, res) => derivativeImage(req, res, 'aspect')));

  app.get('/api/terrain/:projectId/:surveyId/contours', verifyToken, requireProjectAccess(req => req.params.projectId), asyncHandler(async (req, res) => {
    const row = await loadSurvey(req.projectId, req.params.surveyId);
    if (!row) return res.status(404).json({ error: 'Terrain survey not found for this project.' });
    if (row.status !== 'ready') return res.status(409).json({ error: `This survey is ${row.status}.` });

    const buffer = await storage.readBuffer(row.preview_key);
    const width = row.preview_width;
    const height = row.preview_height;
    const grid = new Float32Array(width * height);
    for (let i = 0; i < grid.length; i += 1) grid[i] = buffer.readFloatLE(i * 4);

    const interval = req.query.interval ? Number(req.query.interval) : 0;
    res.json(buildContours(grid, width, height, interval, row.bounds, crsDefinition(row.epsg)));
  }));

  // DEM vs survey benchmarks. Differences are reported, never applied.
  app.get('/api/terrain/:projectId/:surveyId/benchmarks', verifyToken, requireProjectAccess(req => req.params.projectId), asyncHandler(async (req, res) => {
    const row = await loadSurvey(req.projectId, req.params.surveyId);
    if (!row) return res.status(404).json({ error: 'Terrain survey not found for this project.' });
    if (row.status !== 'ready') return res.status(409).json({ error: `This survey is ${row.status}.` });

    const points = await pool.query(
      'SELECT * FROM surveying_control_points WHERE project_id = $1 AND latitude IS NOT NULL AND longitude IS NOT NULL ORDER BY id',
      [req.projectId]
    );

    const noData = row.no_data_value;
    const results = [];

    if (points.rows.length > 0) {
      const tiff = await fromFile(storage.absolute(row.storage_key));
      const image = await tiff.getImage();

      for (const point of points.rows) {
        const lon = toNum(point.longitude);
        const lat = toNum(point.latitude);
        let projected;
        try {
          projected = transformWgs84To(row.epsg, lon, lat);
        } catch (err) {
          results.push({ pointId: point.id, status: 'error', error: err.message });
          continue;
        }

        const fx = (projected[0] - row.bounds[0]) / toNum(row.pixel_size_x);
        const fy = (row.bounds[3] - projected[1]) / toNum(row.pixel_size_y);
        const px = Math.floor(fx);
        const py = Math.floor(fy);

        const benchmark = point.benchmark_elevation === null ? null : toNum(point.benchmark_elevation);
        if (px < 0 || py < 0 || px >= row.width || py >= row.height) {
          results.push({
            pointId: point.id,
            latitude: lat,
            longitude: lon,
            benchmarkElevation: benchmark,
            status: 'outside',
            note: 'This control point lies outside the DEM extent.'
          });
          continue;
        }

        const [band] = await image.readRasters({ window: [px, py, px + 1, py + 1], samples: [0], interleave: false });
        const demElevation = Number(band[0]);

        if (isNoData(demElevation, noData)) {
          results.push({
            pointId: point.id, latitude: lat, longitude: lon, benchmarkElevation: benchmark,
            status: 'nodata', note: 'The DEM cell at this point is NoData.'
          });
          continue;
        }

        results.push({
          pointId: point.id,
          latitude: lat,
          longitude: lon,
          projected: { x: projected[0], y: projected[1], crs: row.crs },
          demElevation,
          benchmarkElevation: benchmark,
          difference: benchmark === null ? null : Number((benchmark - demElevation).toFixed(3)),
          status: benchmark === null ? 'no-benchmark' : 'compared',
          note: benchmark === null
            ? 'This control point has no benchmark elevation recorded.'
            : 'difference = benchmark − DEM. Nothing has been shifted or corrected.'
        });
      }
    }

    const compared = results.filter(item => item.status === 'compared');
    const differences = compared.map(item => item.difference);

    res.json({
      surveyId: row.id,
      projectId: row.project_id,
      crs: row.crs,
      verticalDatum: row.vertical_datum,
      verticalDatumNote: row.vertical_datum
        ? `The DEM states vertical datum “${row.vertical_datum}”; the surveying table records no datum. A large offset may be a datum difference.`
        : 'No vertical datum is recorded for this DEM, and the surveying table records none either. Elevations are compared as stored.',
      results,
      summary: compared.length > 0 ? {
        compared: compared.length,
        meanDifference: Number((differences.reduce((a, b) => a + b, 0) / differences.length).toFixed(3)),
        minDifference: Number(Math.min(...differences).toFixed(3)),
        maxDifference: Number(Math.max(...differences).toFixed(3)),
        spread: Number((Math.max(...differences) - Math.min(...differences)).toFixed(3))
      } : null,
      note: 'Reported for engineering review only. The DEM and the benchmarks have not been adjusted.'
    });
  }));

  app.delete('/api/terrain/:projectId/:surveyId', verifyToken, requireProjectAccess(req => req.params.projectId), asyncHandler(async (req, res) => {
    const row = await loadSurvey(req.projectId, req.params.surveyId);
    if (!row) return res.status(404).json({ error: 'Terrain survey not found for this project.' });

    await storage.remove(row.storage_key);
    if (row.preview_key) await storage.remove(row.preview_key);
    await pool.query('DELETE FROM terrain_surveys WHERE id = $1 AND project_id = $2', [row.id, req.projectId]);

    res.json({ success: true, deleted: 1 });
  }));

  // Registered last so it sees errors from every terrain route (including multer).
  app.use('/api/terrain', (err, req, res, next) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `The DEM is larger than the ${Math.round(LIMITS.maxFileBytes / 1024 / 1024)} MB upload limit.` });
    }
    if (err && err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({ error: 'Send exactly one GeoTIFF in the "file" field.' });
    }
    return next(err);
  });

  return { ensureTerrainSchema, storage, LIMITS };
};

module.exports.createLocalVolumeStorage = createLocalVolumeStorage;
module.exports.isTiffSignature = isTiffSignature;
module.exports.crsDefinition = crsDefinition;
module.exports.pixelSizesMetres = pixelSizesMetres;
module.exports.buildContours = buildContours;
module.exports.buildHillshade = buildHillshade;
module.exports.buildSlopeOrAspect = buildSlopeOrAspect;
module.exports.sampleGrid = sampleGrid;
module.exports.LIMITS = LIMITS;
