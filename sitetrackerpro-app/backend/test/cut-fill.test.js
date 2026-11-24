'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ringContains,
  polygonContains,
  polygonsFrom,
  polygonArea,
  computeCutFill
} = require('../cut-fill');

const square = (x0, y0, size) => [[
  [x0, y0],
  [x0 + size, y0],
  [x0 + size, y0 + size],
  [x0, y0 + size],
  [x0, y0]
]];

test('ray casting handles the inside, the outside and the edges', () => {
  const ring = square(0, 0, 10)[0];
  assert.equal(ringContains(ring, 5, 5), true);
  assert.equal(ringContains(ring, -1, 5), false);
  assert.equal(ringContains(ring, 11, 5), false);
  assert.equal(ringContains(ring, 5, 12), false);
});

test('a hole is excluded from its polygon', () => {
  const polygon = [
    square(0, 0, 10)[0],
    square(3, 3, 4)[0]
  ];
  assert.equal(polygonContains(polygon, 1, 1), true);
  assert.equal(polygonContains(polygon, 5, 5), false);
});

test('polygons are read from polygons, features and collections', () => {
  const geometry = { type: 'Polygon', coordinates: square(0, 0, 2) };
  assert.equal(polygonsFrom(geometry).length, 1);
  assert.equal(polygonsFrom({ type: 'Feature', geometry }).length, 1);
  assert.equal(
    polygonsFrom({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry }, { type: 'Feature', geometry }] }).length,
    2
  );
  assert.equal(polygonsFrom({ type: 'LineString', coordinates: [] }).length, 0);
});

test('polygon area is outer ring minus holes', () => {
  const polygon = [
    square(0, 0, 10)[0],
    square(4, 4, 2)[0]
  ];
  assert.equal(polygonArea(polygon), 96);
});

test('every cell above design is cut and none is fill', () => {
  const result = computeCutFill({
    existing: [11, 12, 13, 14],
    design: [10, 10, 10, 10],
    cellArea: 100
  });
  assert.equal(result.cutVolumeM3, 1000);
  assert.equal(result.fillVolumeM3, 0);
  assert.equal(result.netVolumeM3, 1000);
  assert.equal(result.surfaceAreaM2, 400);
});

test('a mixed surface reports cut, fill, net and elevation statistics', () => {
  const result = computeCutFill({
    existing: [12, 8, 10, 10],
    design: [10, 10, 10, 10],
    cellArea: 25
  });
  assert.equal(result.cutVolumeM3, 50);   // 2 m over one 25 m² cell
  assert.equal(result.fillVolumeM3, 50);  // 2 m under one 25 m² cell
  assert.equal(result.netVolumeM3, 0);
  assert.equal(result.surfaceAreaM2, 100);
  assert.equal(result.minElevation, 8);
  assert.equal(result.maxElevation, 12);
  assert.equal(result.meanElevation, 10);
  assert.equal(result.cellCount, 4);
});

test('NoData cells are skipped rather than counted as zero', () => {
  const result = computeCutFill({
    existing: [11, NaN, Infinity, 9],
    design: [10, 10, 10, 10],
    cellArea: 10
  });
  assert.equal(result.cellCount, 2);
  assert.equal(result.cutVolumeM3, 10);
  assert.equal(result.fillVolumeM3, 10);
  assert.equal(result.surfaceAreaM2, 20);
});

test('nothing valid inside the polygon is an empty, not a zero, result', () => {
  const result = computeCutFill({ existing: [NaN], design: [10], cellArea: 10 });
  assert.equal(result.cellCount, 0);
  assert.equal(result.minElevation, null);
  assert.equal(result.cutVolumeM3, 0);
});

test('bad inputs are refused', () => {
  assert.throws(() => computeCutFill({ existing: [1], design: [], cellArea: 1 }), RangeError);
  assert.throws(() => computeCutFill({ existing: [1], design: [1], cellArea: 0 }), RangeError);
  assert.throws(() => computeCutFill({ existing: null, design: null, cellArea: 1 }), TypeError);
});
