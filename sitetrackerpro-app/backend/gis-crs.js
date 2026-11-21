'use strict';
/**
 * Shared CRS helpers for the GIS module.
 *
 * Only systems with an explicit definition here are supported, plus WGS 84 UTM zones named by
 * their full EPSG code (the zone is read from the code, never inferred from coordinates). Every
 * transform names both systems; a missing definition is an error, not a guess.
 *
 * proj4js has no datum grids, so this is suitable for display and UTM/Web Mercator conversion,
 * not for a survey-grade datum shift.
 */

const proj4 = require('proj4');

const CRS_DEFINITIONS = {
  'EPSG:4326': { def: '+proj=longlat +datum=WGS84 +no_defs', name: 'WGS 84 geographic', units: 'degrees', axis: 'latitude / longitude' },
  // EPSG:4979 is deliberately not offered: proj4js transforms x/y only, so listing a 3D
  // system here would imply the ellipsoidal height is handled, and it is not.
  'EPSG:3857': {
    def: '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs',
    name: 'Web Mercator (map display only)',
    units: 'metres',
    axis: 'easting / northing'
  }
};

function utmDefinition(epsg) {
  const code = Number(epsg);
  // 32601-32660: WGS 84 / UTM northern hemisphere; 32701-32760: southern hemisphere.
  const isNorth = code >= 32601 && code <= 32660;
  const isSouth = code >= 32701 && code <= 32760;
  if (!isNorth && !isSouth) return null;

  const zone = code - (isNorth ? 32600 : 32700);
  const south = isSouth ? ' +south' : '';
  const def = `+proj=utm +zone=${zone}${south} +datum=WGS84 +units=m +no_defs`;
  return { def, name: `WGS 84 / UTM zone ${zone}${isSouth ? 'S' : 'N'}`, units: 'metres', axis: 'easting / northing' };
}

function normalizeCrs(code) {
  return String(code || '').trim().toUpperCase().replace(/^EPSG::/, 'EPSG:');
}

function crsDefinition(code) {
  if (!code) return null;
  const key = normalizeCrs(code);
  if (CRS_DEFINITIONS[key]) return { code: key, ...CRS_DEFINITIONS[key] };

  const match = /^EPSG:(32[67]\d{2})$/.exec(key);
  if (match) {
    const utm = utmDefinition(match[1]);
    if (utm) return { code: key, ...utm };
  }

  return null;
}

function listCrs() {
  const list = Object.entries(CRS_DEFINITIONS).map(([code, value]) => ({ code, ...value }));
  // Ethiopian project areas sit in UTM zones 36N, 37N and 38N; the southern zones are listed
  // too so a dataset south of the equator can name its own system.
  [32636, 32637, 32638, 32736, 32737, 32738].forEach(zone => {
    const utm = utmDefinition(zone);
    if (utm) list.push({ code: `EPSG:${zone}`, ...utm });
  });
  return list;
}

const isGeographic = definition => definition && definition.units === 'degrees';

// Transform a single [x, y] pair (or [lon, lat] for geographic input). Returns numbers; a
// definition proj4 cannot build throws, and the caller turns that into a 400.
function transformPoint(coordinates, fromCrs, toCrs) {
  const from = crsDefinition(fromCrs);
  const to = crsDefinition(toCrs);
  if (!from) throw new Error(`Unsupported source CRS ${fromCrs}. Choose one from GET /api/gis/crs.`);
  if (!to) throw new Error(`Unsupported target CRS ${toCrs}. Choose one from GET /api/gis/crs.`);
  const x = Number(coordinates[0]);
  const y = Number(coordinates[1]);

  // GeoJSON and this API use [longitude, latitude] for geographic systems. A latitude of 38
  // would silently transform to the wrong place, so it is refused instead.
  if (from.units === 'degrees') {
    if (Math.abs(x) > 180 || Math.abs(y) > 90) {
      throw new Error(`${from.code} coordinates are [longitude, latitude]; ${JSON.stringify([x, y])} is out of range. No swap is attempted automatically.`);
    }
  }

  if (from.code === to.code) return [x, y];

  const result = proj4(from.def, to.def, [x, y]);
  return [Number(result[0].toFixed(9)), Number(result[1].toFixed(9))];
}

// Recursively transform a GeoJSON coordinate tree. Z values (if any) are preserved untouched:
// this is a horizontal transform only.
function transformCoordinates(coordinates, fromCrs, toCrs) {
  if (!Array.isArray(coordinates)) return coordinates;
  if (coordinates.length >= 2 && typeof coordinates[0] === 'number' && typeof coordinates[1] === 'number') {
    const transformed = transformPoint(coordinates, fromCrs, toCrs);
    return coordinates.length > 2 ? [transformed[0], transformed[1], ...coordinates.slice(2)] : transformed;
  }
  return coordinates.map(value => transformCoordinates(value, fromCrs, toCrs));
}

function transformGeometry(geometry, fromCrs, toCrs) {
  if (!geometry || !geometry.coordinates) return geometry;
  return { ...geometry, coordinates: transformCoordinates(geometry.coordinates, fromCrs, toCrs) };
}

function transformFeatureCollection(featureCollection, fromCrs, toCrs) {
  if (!featureCollection || !Array.isArray(featureCollection.features)) return featureCollection;
  return {
    ...featureCollection,
    features: featureCollection.features.map(feature => ({
      ...feature,
      geometry: transformGeometry(feature.geometry, fromCrs, toCrs)
    }))
  };
}

module.exports = {
  CRS_DEFINITIONS,
  crsDefinition,
  listCrs,
  isGeographic,
  transformPoint,
  transformCoordinates,
  transformGeometry,
  transformFeatureCollection
};
