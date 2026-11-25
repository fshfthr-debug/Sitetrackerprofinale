import * as THREE from 'three';

// Web Mercator sphere used by MapLibre. 2πR metres around the equator equals 1 mercator unit.
const MERCATOR_RADIUS = 6378137;
const EQUATOR_CIRCUMFERENCE = 2 * Math.PI * MERCATOR_RADIUS;

/**
 * The same numbers MapLibre's `MercatorCoordinate.fromLngLat(lngLat, altitude)` produces.
 * Reproduced here so the transform has no dependency on a map instance and can be checked
 * against MapLibre directly (the stage-0 spike and the stage-1 harness both do).
 */
export function mercatorFromLngLat(lng, lat, heightMetres = 0) {
  const x = (180 + lng) / 360;
  const sin = Math.sin((lat * Math.PI) / 180);
  const y = 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
  const metresPerMercatorUnit = EQUATOR_CIRCUMFERENCE * Math.cos((lat * Math.PI) / 180);
  return {
    x,
    y,
    z: heightMetres / metresPerMercatorUnit,
    metreInMercatorCoordinateUnits: 1 / metresPerMercatorUnit
  };
}

/**
 * modelMatrix for a placement from GET /api/gis/georeferencing/:projectId/placement.
 *
 * Model coordinates are (east, north, up) in metres, the same axes a surveyor uses. Mercator
 * y grows southwards, hence the negative y scale, and the rotation is applied in model axes
 * before that flip so a counter-clockwise rotation in model space stays counter-clockwise on
 * the ground.
 *
 * Callers pass geometry rebased so its origin is the anchor (or use the optional rebase offset,
 * subtracted after rotation and scale).
 */
/**
 * WGS84 radii of curvature at a latitude, in metres: the meridional radius M (north-south) and
 * the prime vertical radius N (east-west).
 *
 * They matter because MapLibre's world is spherical Web Mercator: the sphere's radius is used for
 * metres per mercator unit, while the survey coordinates are on the WGS84 ellipsoid. At 9° N the
 * two differ by 0.7% north-south, so a single isotropic metre scale puts a 24 m building 16 cm off
 * and a 1 km model 7 m off. Splitting the scale by axis removes that error.
 */
export function wgs84Radii(latDeg) {
  const a = 6378137;
  const e2 = 0.00669437999014;
  const sin = Math.sin((latDeg * Math.PI) / 180);
  const w = Math.sqrt(1 - e2 * sin * sin);
  return {
    meridional: (a * (1 - e2)) / (w * w * w),
    primeVertical: a / w
  };
}

export function buildModelMatrix(placement, rebase = null) {
  if (!placement || !placement.anchor) throw new Error('A placement with an anchor is required.');
  const anchor = mercatorFromLngLat(
    placement.anchor.lon,
    placement.anchor.lat,
    placement.anchor.height || 0
  );
  const metre = anchor.metreInMercatorCoordinateUnits;
  const radii = wgs84Radii(placement.anchor.lat);
  const sphere = 6378137;
  const metreEast = metre * (sphere / radii.primeVertical);
  const metreNorth = metre * (sphere / radii.meridional);
  const rotation = THREE.MathUtils.degToRad(placement.renderRotationDeg ?? placement.rotationDeg ?? 0);
  const scale = placement.scale ?? 1;

  const matrix = new THREE.Matrix4()
    .makeTranslation(anchor.x, anchor.y, anchor.z)
    .scale(new THREE.Vector3(metreEast, -metreNorth, metre))
    .multiply(new THREE.Matrix4().makeRotationZ(rotation))
    .scale(new THREE.Vector3(scale, scale, scale));

  if (rebase) {
    matrix.multiply(new THREE.Matrix4().makeTranslation(-rebase.x, -rebase.y, -rebase.z));
  }
  return matrix;
}

/**
 * Where a model-space point lands on the map. Used for labels and to convert a picked point
 * back to site coordinates; the GPU does the same transform for the geometry itself.
 */
export function modelPointToLngLat(placement, point) {
  const anchor = mercatorFromLngLat(placement.anchor.lon, placement.anchor.lat, placement.anchor.height || 0);
  const origin = placement.modelOrigin;
  const matrix = buildModelMatrix(
    placement,
    origin ? { x: Number(origin.east) || 0, y: Number(origin.north) || 0, z: Number(origin.up) || 0 } : null
  );
  const mercator = new THREE.Vector4(point.east, point.north, point.up || 0, 1).applyMatrix4(matrix);
  const lng = (mercator.x * 360) - 180;
  const n = Math.PI - (2 * Math.PI * mercator.y);
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  const groundZ = anchor.z;
  const height = (mercator.z - groundZ) / anchor.metreInMercatorCoordinateUnits;
  return { lng, lat, height };
}
