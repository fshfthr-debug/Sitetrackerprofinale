'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { transformPoint } = require('../gis-crs');
const {
  ANCHOR_ORIGIN_TOLERANCE_M,
  IFC_BROWSER_LIMIT_BYTES,
  convergenceDegrees,
  describeModelForMap,
  initialBearingDegrees,
  resolvePlacement
} = require('../gis-placement');

const CRS = 'EPSG:32637';
const ORIGIN_LNGLAT = [38.806, 9.117];

// The same transform the saved fit and the preview use: survey = anchor + R(rot)·scale·(model − origin).
const origin = (() => {
  const projected = transformPoint(ORIGIN_LNGLAT, 'EPSG:4326', CRS);
  return { east: projected[0], north: projected[1] };
})();

const georef = (overrides = {}) => ({
  crs: CRS,
  vertical_datum: 'Project benchmark',
  anchor_lat: ORIGIN_LNGLAT[1],
  anchor_lon: ORIGIN_LNGLAT[0],
  anchor_elevation: 2360.5,
  model_origin_east: origin.east,
  model_origin_north: origin.north,
  model_origin_up: 0,
  rotation_deg: 0,
  scale: 1,
  z_offset: 0,
  north_reference: 'grid',
  ...overrides
});

// A model drawn in local coordinates near (0,0): its origin is 0,0 and the anchor is the map
// position of that origin. This is the normal case in the plan (§2.3).
const localGeoref = (overrides = {}) => georef({
  model_origin_east: 0,
  model_origin_north: 0,
  ...overrides
});

const pairAt = (modelEast, modelNorth, { offsetEast = 0, offsetNorth = 0, name = 'CP' } = {}) => {
  const east = origin.east + modelEast + offsetEast;
  const north = origin.north + modelNorth + offsetNorth;
  const lngLat = transformPoint([east, north], CRS, 'EPSG:4326');
  return {
    model_east: modelEast,
    model_north: modelNorth,
    model_up: 0,
    latitude: lngLat[1],
    longitude: lngLat[0],
    name
  };
};

test('convergence is zero on a UTM central meridian', () => {
  const { convergenceDeg } = convergenceDegrees({ code: CRS }, 500000, 1000000);
  assert.ok(Math.abs(convergenceDeg) < 1e-6, `expected 0, got ${convergenceDeg}`);
});

test('convergence matches the analytic value away from the central meridian', () => {
  // UTM 37N is centred on 39°E; the site is at 38.806°E, 0.194° west of it.
  const { convergenceDeg } = convergenceDegrees({ code: CRS }, origin.east, origin.north);
  const analytic = (ORIGIN_LNGLAT[0] - 39) * Math.sin((ORIGIN_LNGLAT[1] * Math.PI) / 180);
  assert.ok(Math.abs(convergenceDeg - analytic) < Math.abs(analytic) * 0.1 + 0.01,
    `numeric ${convergenceDeg}° vs analytic ${analytic.toFixed(6)}°`);
  assert.ok(Math.abs(convergenceDeg) > 0.01, 'a site 0.2° from the central meridian has a non-zero convergence');
});

test('initial bearing is 0 for a point due north and 90 for due east', () => {
  assert.ok(Math.abs(initialBearingDegrees(9, 38.8, 9.1, 38.8)) < 1e-9);
  assert.ok(Math.abs(initialBearingDegrees(9, 38.8, 9, 38.9) - 90) < 1);
});

test('resolves a placement from a consistent anchor and origin', () => {
  const placement = resolvePlacement(georef(), { pairs: [], model: null });
  assert.equal(placement.configured, true);
  assert.equal(placement.crs, CRS);
  assert.ok(Math.abs(placement.anchor.lon - ORIGIN_LNGLAT[0]) < 1e-7);
  assert.ok(Math.abs(placement.anchor.lat - ORIGIN_LNGLAT[1]) < 1e-7);
  assert.equal(placement.anchor.height, 2360.5);
  assert.equal(placement.northReference, 'grid');
  assert.equal(placement.rotationDeg, 0);
  assert.equal(placement.renderRotationDeg, 0);
  assert.ok(placement.checks.anchorOriginDiscrepancyM <= ANCHOR_ORIGIN_TOLERANCE_M);
  assert.equal(placement.bbox, null);
  assert.ok(placement.checks.warnings.some(w => /no alignment pairs/i.test(w)));
});

test('derives the anchor when only the model origin is saved', () => {
  const placement = resolvePlacement(georef({ anchor_lat: null, anchor_lon: null }), {});
  const expected = transformPoint([origin.east, origin.north], CRS, 'EPSG:4326');
  assert.ok(Math.abs(placement.anchor.lon - expected[0]) < 1e-6);
  assert.ok(Math.abs(placement.anchor.lat - expected[1]) < 1e-6);
  assert.equal(placement.checks.anchorOriginDiscrepancyM, null);
});

test('derives the model origin when only the anchor is saved', () => {
  const placement = resolvePlacement(georef({ model_origin_east: null, model_origin_north: null }), {});
  assert.ok(Math.abs(placement.modelOrigin.east - origin.east) < 0.01);
  assert.ok(Math.abs(placement.modelOrigin.north - origin.north) < 0.01);
});

test('refuses an anchor and origin that disagree by more than the tolerance', () => {
  const moved = transformPoint([origin.east + 3.2, origin.north], CRS, 'EPSG:4326');
  assert.throws(
    () => resolvePlacement(georef({ anchor_lat: moved[1], anchor_lon: moved[0] }), {}),
    (err) => {
      assert.equal(err.status, 400);
      assert.match(err.message, /disagree by 3\.2\d* m/);
      assert.equal(err.details.discrepancyMetres, 3.2);
      assert.equal(err.details.limitMetres, ANCHOR_ORIGIN_TOLERANCE_M);
      return true;
    }
  );
});

test('accepts an anchor and origin within the tolerance', () => {
  const moved = transformPoint([origin.east + 0.2, origin.north], CRS, 'EPSG:4326');
  const placement = resolvePlacement(georef({ anchor_lat: moved[1], anchor_lon: moved[0] }), {});
  assert.ok(placement.checks.anchorOriginDiscrepancyM <= ANCHOR_ORIGIN_TOLERANCE_M);
});

test('takes the convergence at the anchor, not at a local model origin', () => {
  const local = resolvePlacement(localGeoref(), {});
  const site = convergenceDegrees({ code: CRS }, origin.east, origin.north).convergenceDeg;
  assert.ok(Math.abs(local.convergenceDeg - site) < 1e-6,
    `local model convergence ${local.convergenceDeg}° should equal the site's ${site}°`);
  assert.ok(Math.abs(local.convergenceDeg) > 0.01, 'the site is 0.2° off the central meridian');
});

test('removes meridian convergence only when the north reference is true north', () => {
  const grid = resolvePlacement(georef({ rotation_deg: 12 }), {});
  const truth = resolvePlacement(georef({ rotation_deg: 12, north_reference: 'true' }), {});
  assert.equal(grid.renderRotationDeg, 12);
  assert.ok(Math.abs(truth.renderRotationDeg - (12 - truth.convergenceDeg)) < 1e-6);
  assert.notEqual(truth.renderRotationDeg, 12);
});

test('requires a rotation and a scale before placing a model', () => {
  assert.throws(() => resolvePlacement(georef({ rotation_deg: null }), {}), /rotation/i);
  assert.throws(() => resolvePlacement(georef({ scale: null }), {}), /scale/i);
});

test('refuses a geographic CRS for model coordinates', () => {
  assert.throws(() => resolvePlacement(georef({ crs: 'EPSG:4326' }), {}), /projected CRS/i);
});

test('checks the placement against the alignment pairs and reports residuals in millimetres', () => {
  const pairs = [
    pairAt(0, 0, { name: 'BM-01' }),
    pairAt(40, 0, { name: 'BM-02' }),
    pairAt(0, 40, { name: 'BM-03' })
  ];
  const placement = resolvePlacement(localGeoref(), { pairs });
  assert.ok(placement.checks.residualMaxMm < 20, `exact pairs should be near zero, got ${placement.checks.residualMaxMm}`);
  assert.equal(placement.checks.pairCount, 3);
  assert.ok(placement.bbox);
  assert.ok(Math.abs(placement.bbox.maxE - 40) < 1e-6);
  assert.ok(placement.checks.distanceFromAnchorM > 40 && placement.checks.distanceFromAnchorM < 60);
});

test('warns when a control point is missed by more than 50 mm', () => {
  const pairs = [
    pairAt(0, 0, { name: 'BM-01' }),
    pairAt(40, 0, { name: 'BM-02', offsetEast: 0.2 }),
    pairAt(0, 40, { name: 'BM-03' })
  ];
  const placement = resolvePlacement(localGeoref(), { pairs });
  assert.ok(placement.checks.residualMaxMm >= 190, `expected ~200 mm, got ${placement.checks.residualMaxMm}`);
  assert.ok(placement.checks.warnings.some(w => /misses a survey control point/i.test(w)));
});

test('warns when the model reaches beyond 5 km from its anchor', () => {
  const pairs = [
    pairAt(0, 0, { name: 'BM-01' }),
    pairAt(6000, 0, { name: 'BM-02' }),
    pairAt(0, 100, { name: 'BM-03' })
  ];
  const placement = resolvePlacement(localGeoref(), { pairs });
  assert.ok(placement.checks.distanceFromAnchorM > 5000);
  assert.ok(placement.checks.warnings.some(w => /single rotation/i.test(w)));
});

test('passes the model record through for the renderer', () => {
  const model = { id: 7, fileName: 'block-a.glb', fileType: 'model/gltf-binary', fileUrl: '/api/gis/georeferencing/1/model/7/file' };
  const placement = resolvePlacement(georef(), { model });
  assert.equal(placement.model.id, model.id);
  assert.equal(placement.model.fileUrl, model.fileUrl);
  assert.equal(placement.model.mapSupport.renderer, 'gltf');
});

test('draws a GLB or glTF without a size limit', () => {
  for (const fileName of ['block.glb', 'block.gltf']) {
    const support = describeModelForMap({ fileName, sizeBytes: 900 * 1024 * 1024 });
    assert.equal(support.drawable, true);
    assert.equal(support.renderer, 'gltf');
    assert.equal(support.limitBytes, null);
  }
});

test('reads an IFC in the browser up to and including 25 MB', () => {
  const atLimit = describeModelForMap({ fileName: 'small.ifc', sizeBytes: IFC_BROWSER_LIMIT_BYTES });
  assert.equal(atLimit.drawable, true);
  assert.equal(atLimit.renderer, 'ifc');
  assert.equal(atLimit.format, 'ifc');
  assert.equal(atLimit.reason, null);
});

test('refuses an IFC over 25 MB and names the server conversion path', () => {
  const support = describeModelForMap({ fileName: 'big.IFC', sizeBytes: IFC_BROWSER_LIMIT_BYTES + 1 });
  assert.equal(support.drawable, false);
  assert.equal(support.renderer, 'ifc');
  assert.equal(support.limitBytes, IFC_BROWSER_LIMIT_BYTES);
  assert.match(support.reason, /25 MB/);
  assert.match(support.reason, /server-side conversion stage/);
  assert.match(support.reason, /GLB/);
});

test('an IFC of unknown size is offered to the browser reader with a caveat', () => {
  const support = describeModelForMap({ fileName: 'unknown-size.ifc' });
  assert.equal(support.drawable, true);
  assert.equal(support.sizeBytes, null);
  assert.match(support.reason, /size is unknown/i);
});

test('refuses a file the map cannot draw, and says which formats it can', () => {
  for (const fileName of ['takeoff.csv', 'drawing.dwg', 'no-extension']) {
    const support = describeModelForMap({ fileName, sizeBytes: 1024 });
    assert.equal(support.drawable, false);
    assert.equal(support.renderer, null);
    assert.match(support.reason, /IFC, GLB and glTF/);
  }
});

test('no model means no map support to describe', () => {
  assert.equal(describeModelForMap(null), null);
  assert.equal(resolvePlacement(georef(), {}).model, null);
});

test('flags a large rotation as a likely swapped easting/northing', () => {
  const placement = resolvePlacement(georef({ rotation_deg: 90 }), {});
  assert.ok(placement.checks.warnings.some(w => /swapped easting/i.test(w)));
});
