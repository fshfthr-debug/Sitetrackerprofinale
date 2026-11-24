'use strict';
/**
 * Cut-and-fill volume maths.
 *
 * Kept free of database, raster and Express code so the arithmetic can be tested on its own:
 * the route in terrain.js reads DEM cells and passes aligned elevation arrays here.
 *
 * Sign convention matches earthworks.js: cut is material removed (existing above design),
 * fill is material placed (existing below design), net = cut - fill.
 */

const round = (value, digits) => Number(Number(value).toFixed(digits));

// Ray casting on one linear ring. Coordinates are [x, y] in the same projected CRS.
function ringContains(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const xi = Number(ring[i][0]);
    const yi = Number(ring[i][1]);
    const xj = Number(ring[j][0]);
    const yj = Number(ring[j][1]);
    if (![xi, yi, xj, yj].every(Number.isFinite)) continue;
    const intersects = (yi > y) !== (yj > y)
      && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

// A polygon is [outerRing, ...holes].
function polygonContains(polygon, x, y) {
  if (!Array.isArray(polygon) || polygon.length === 0) return false;
  if (!ringContains(polygon[0], x, y)) return false;
  for (let hole = 1; hole < polygon.length; hole += 1) {
    if (ringContains(polygon[hole], x, y)) return false;
  }
  return true;
}

function polygonsOf(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}

// Accepts a Polygon, MultiPolygon, Feature or FeatureCollection; returns polygons.
function polygonsFrom(geojson) {
  if (!geojson) return [];
  if (geojson.type === 'FeatureCollection') {
    return (geojson.features || []).flatMap(feature => polygonsFrom(feature));
  }
  if (geojson.type === 'Feature') return polygonsOf(geojson.geometry);
  return polygonsOf(geojson);
}

function anyPolygonContains(polygons, x, y) {
  for (let i = 0; i < polygons.length; i += 1) {
    if (polygonContains(polygons[i], x, y)) return true;
  }
  return false;
}

// Shoelace area of a polygon (outer minus holes), absolute square units.
function ringArea(ring) {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    sum += Number(ring[j][0]) * Number(ring[i][1]) - Number(ring[i][0]) * Number(ring[j][1]);
  }
  return Math.abs(sum / 2);
}

function polygonArea(polygon) {
  if (!Array.isArray(polygon) || polygon.length === 0) return 0;
  return Math.max(0, ringArea(polygon[0]) - polygon.slice(1).reduce((sum, hole) => sum + ringArea(hole), 0));
}

/**
 * Volume summary.
 *
 * @param {number[]} existing  DEM elevation at each sampled cell centre (NaN allowed).
 * @param {number[]} design    Design elevation at the same cell (one per existing value).
 * @param {number}   cellArea  Cell area in square metres.
 */
function computeCutFill({ existing, design, cellArea }) {
  if (!Array.isArray(existing) || !Array.isArray(design)) {
    throw new TypeError('existing and design must be arrays.');
  }
  if (existing.length !== design.length) {
    throw new RangeError('existing and design must be the same length.');
  }
  const area = Number(cellArea);
  if (!Number.isFinite(area) || area <= 0) {
    throw new RangeError('cellArea must be a positive number of square metres.');
  }

  let cutVolume = 0;
  let fillVolume = 0;
  let cells = 0;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;

  for (let i = 0; i < existing.length; i += 1) {
    const z = Number(existing[i]);
    const d = Number(design[i]);
    if (!Number.isFinite(z) || !Number.isFinite(d)) continue;

    const delta = z - d; // positive: above design, so cut
    if (delta > 0) cutVolume += delta * area;
    else fillVolume += -delta * area;

    cells += 1;
    sum += z;
    if (z < min) min = z;
    if (z > max) max = z;
  }

  const surfaceAreaM2 = cells * area;

  return {
    cutVolumeM3: round(cutVolume, 2),
    fillVolumeM3: round(fillVolume, 2),
    netVolumeM3: round(cutVolume - fillVolume, 2),
    surfaceAreaM2: round(surfaceAreaM2, 2),
    cellCount: cells,
    cellAreaM2: round(area, 4),
    minElevation: cells ? round(min, 3) : null,
    maxElevation: cells ? round(max, 3) : null,
    meanElevation: cells ? round(sum / cells, 3) : null
  };
}

module.exports = {
  ringContains,
  polygonContains,
  polygonsOf,
  polygonsFrom,
  anyPolygonContains,
  polygonArea,
  computeCutFill,
  round
};
