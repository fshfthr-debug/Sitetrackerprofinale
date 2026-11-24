'use strict';
/**
 * Spatial clash and encroachment detection.
 *
 * Pure geometry helpers over JSTS, kept separate from Express and the database so they can be
 * unit-tested with synthetic squares. Two checks are provided:
 *
 *   detectClearanceClashes  pairs of features from two layers closer than a clearance distance
 *   slopeHazards            features standing on terrain steeper than a threshold
 *
 * Every distance and area is computed in a metre-based projected CRS. The route converts
 * inputs and outputs; nothing here ever measures in degrees.
 */

const fs = require('fs');
const path = require('path');

function loadJsts() {
  const file = require.resolve('jsts/dist/jsts.min.js');
  const source = fs.readFileSync(file, 'utf8');
  const shim = { exports: {} };
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

const round = (value, digits = 3) => Number(Number(value).toFixed(digits));

function readGeometry(geojson) {
  if (!geojson) return null;
  try {
    const geometry = reader.read(geojson);
    return geometry && !geometry.isEmpty() ? geometry : null;
  } catch (err) {
    return null;
  }
}

function writeGeometry(geometry) {
  if (!geometry || geometry.isEmpty()) return null;
  try {
    const output = writer.write(geometry);
    return output && Array.isArray(output.coordinates) && output.coordinates.length > 0 ? output : null;
  } catch (err) {
    return null;
  }
}

function explode(geometry) {
  if (!geometry || geometry.isEmpty()) return [];
  if (geometry.getGeometryType() === 'GeometryCollection') {
    const parts = [];
    for (let index = 0; index < geometry.getNumGeometries(); index += 1) {
      parts.push(...explode(geometry.getGeometryN(index)));
    }
    return parts;
  }
  return [geometry];
}

// A compact label from the feature's own properties, for the clash inspector list.
function labelFor(properties, index) {
  if (!properties) return `Feature ${index + 1}`;
  for (const key of ['name', 'Name', 'NAME', 'label', 'id', 'ID', 'asset_id', 'assetId']) {
    const value = properties[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value).slice(0, 120);
    }
  }
  return `Feature ${index + 1}`;
}

/**
 * @param {Array<{geometry: object, properties?: object}>} layerFeatures
 * @param {Array<{geometry: object, properties?: object}>} obstacleFeatures
 * @param {number} clearanceMetres
 * @param {{maxClashes?: number, maxPairs?: number}} options
 */
function detectClearanceClashes({
  layerFeatures = [],
  obstacleFeatures = [],
  clearanceMetres,
  maxClashes = 300,
  maxPairs = 200000
} = {}) {
  const clearance = Number(clearanceMetres);
  if (!Number.isFinite(clearance) || clearance < 0) {
    throw new RangeError('clearanceMetres must be zero or more.');
  }

  const layer = layerFeatures
    .map((feature, index) => ({ index, properties: feature.properties || {}, geometry: readGeometry(feature.geometry) }))
    .filter(item => item.geometry);
  const obstacles = obstacleFeatures
    .map((feature, index) => ({ index, properties: feature.properties || {}, geometry: readGeometry(feature.geometry) }))
    .filter(item => item.geometry);

  const clashes = [];
  let testedPairs = 0;
  let truncated = false;

  for (const item of layer) {
    if (clashes.length >= maxClashes) { truncated = true; break; }

    const layerBounds = item.geometry.getEnvelopeInternal();
    for (const obstacle of obstacles) {
      if (clashes.length >= maxClashes) { truncated = true; break; }
      if (testedPairs >= maxPairs) { truncated = true; break; }
      testedPairs += 1;

      // Cheap bounding-box rejection before the exact distance.
      const obstacleBounds = obstacle.geometry.getEnvelopeInternal();
      if (layerBounds.getMinX() - clearance > obstacleBounds.getMaxX()
        || layerBounds.getMaxX() + clearance < obstacleBounds.getMinX()
        || layerBounds.getMinY() - clearance > obstacleBounds.getMaxY()
        || layerBounds.getMaxY() + clearance < obstacleBounds.getMinY()) {
        continue;
      }

      const distance = item.geometry.distance(obstacle.geometry);
      if (!(distance <= clearance)) continue;

      // The warning zone is the part of the layer feature that falls inside the corridor,
      // so the map highlights the conflict itself rather than the whole obstacle.
      let zone = writeGeometry(item.geometry.intersection(obstacle.geometry.buffer(clearance)));
      if (!zone) zone = writeGeometry(obstacle.geometry.buffer(clearance));

      clashes.push({
        id: `${item.index + 1}-${obstacle.index + 1}`,
        layerFeatureIndex: item.index,
        obstacleFeatureIndex: obstacle.index,
        layerLabel: labelFor(item.properties, item.index),
        obstacleLabel: labelFor(obstacle.properties, obstacle.index),
        distanceM: round(distance, 2),
        overlap: distance === 0,
        severity: distance === 0 ? 'overlap' : 'clearance',
        geometry: zone
      });
    }
  }

  return {
    clashes,
    testedPairs,
    layerFeatureCount: layer.length,
    obstacleFeatureCount: obstacles.length,
    truncated
  };
}

// Slope in degrees from a regular elevation grid. Node (x, y) is the cell centre.
function slopeGrid({ grid, width, height, dx, dy }) {
  const output = new Float32Array(width * height);
  const at = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return NaN;
    const value = grid[y * width + x];
    return Number.isFinite(value) ? value : NaN;
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const z = at(x, y);
      if (!Number.isFinite(z)) { output[y * width + x] = NaN; continue; }

      const left = at(x - 1, y);
      const right = at(x + 1, y);
      const up = at(x, y - 1);
      const down = at(x, y + 1);

      // One-sided differences at the edges, central differences inside.
      const dzdEast = Number.isFinite(right) && Number.isFinite(left)
        ? (right - left) / (2 * dx)
        : Number.isFinite(right) ? (right - z) / dx : Number.isFinite(left) ? (z - left) / dx : 0;
      const dzdNorth = Number.isFinite(down) && Number.isFinite(up)
        ? (down - up) / (2 * dy)
        : Number.isFinite(down) ? (down - z) / dy : Number.isFinite(up) ? (z - up) / dy : 0;

      output[y * width + x] = (Math.atan(Math.hypot(dzdEast, dzdNorth)) * 180) / Math.PI;
    }
  }
  return output;
}

function sampleGridBilinear(grid, width, height, fx, fy) {
  if (!Number.isFinite(fx) || !Number.isFinite(fy)) return NaN;
  // Outside the DEM is NoData, never the nearest edge value: a feature beyond the survey
  // must not inherit the terrain of the boundary cell.
  if (fx < 0 || fy < 0 || fx > width - 1 || fy > height - 1) return NaN;

  const x0 = Math.min(width - 2, Math.max(0, Math.floor(fx)));
  const y0 = Math.min(height - 2, Math.max(0, Math.floor(fy)));
  const tx = fx - x0;
  const ty = fy - y0;
  const v00 = grid[y0 * width + x0];
  const v10 = grid[y0 * width + x0 + 1];
  const v01 = grid[(y0 + 1) * width + x0];
  const v11 = grid[(y0 + 1) * width + x0 + 1];
  if (![v00, v10, v01, v11].every(Number.isFinite)) return NaN;
  const top = v00 * (1 - tx) + v10 * tx;
  const bottom = v01 * (1 - tx) + v11 * tx;
  return top * (1 - ty) + bottom * ty;
}

/**
 * Flags features whose centre sits on a slope above the threshold.
 *
 * @param {Array<{geometry: object, properties?: object}>} features  projected features
 * @param {{crsBounds: number[], slope: Float32Array, width: number, height: number}} raster
 */
function slopeHazards({ features = [], crsBounds, slope, width, height, thresholdDegrees, maxClashes = 300 }) {
  const threshold = Number(thresholdDegrees);
  if (!Number.isFinite(threshold) || threshold <= 0) {
    throw new RangeError('thresholdDegrees must be a positive number.');
  }
  if (!Array.isArray(crsBounds) || crsBounds.length !== 4 || !width || !height) {
    throw new RangeError('A raster bounds, width and height are required.');
  }

  const [minX, minY, maxX, maxY] = crsBounds;
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const hazards = [];

  features.forEach((feature, index) => {
    if (hazards.length >= maxClashes) return;
    const geometry = readGeometry(feature.geometry);
    if (!geometry) return;
    const bounds = geometry.getEnvelopeInternal();
    const cx = (bounds.getMinX() + bounds.getMaxX()) / 2;
    const cy = (bounds.getMinY() + bounds.getMaxY()) / 2;
    const fx = ((cx - minX) / spanX) * (width - 1);
    const fy = ((maxY - cy) / spanY) * (height - 1);

    // The steepest of the centre and the four envelope corners is the conservative reading.
    const samples = [
      sampleGridBilinear(slope, width, height, fx, fy),
      sampleGridBilinear(slope, width, height, fx - 1, fy),
      sampleGridBilinear(slope, width, height, fx + 1, fy),
      sampleGridBilinear(slope, width, height, fx, fy - 1),
      sampleGridBilinear(slope, width, height, fx, fy + 1)
    ].filter(Number.isFinite);
    if (samples.length === 0) return;

    const peak = Math.max(...samples);
    if (peak < threshold) return;

    hazards.push({
      id: `slope-${index + 1}`,
      layerFeatureIndex: index,
      layerLabel: labelFor(feature.properties, index),
      obstacleLabel: 'Terrain slope',
      slopeDeg: round(peak, 1),
      thresholdDeg: threshold,
      severity: 'slope',
      distanceM: null,
      overlap: false,
      geometry: writeGeometry(geometry)
    });
  });

  return { clashes: hazards, testedPairs: features.length, truncated: hazards.length >= maxClashes };
}

module.exports = {
  detectClearanceClashes,
  slopeGrid,
  sampleGridBilinear,
  slopeHazards,
  readGeometry,
  writeGeometry,
  explode
};
