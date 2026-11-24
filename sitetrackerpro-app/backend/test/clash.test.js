'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  detectClearanceClashes,
  slopeGrid,
  sampleGridBilinear,
  slopeHazards
} = require('../clash');

// Squares in a metre CRS, [x, y].
const squareFeature = (x0, y0, size, properties = {}) => ({
  type: 'Feature',
  properties,
  geometry: {
    type: 'Polygon',
    coordinates: [[
      [x0, y0],
      [x0 + size, y0],
      [x0 + size, y0 + size],
      [x0, y0 + size],
      [x0, y0]
    ]]
  }
});

test('features inside the clearance distance are reported with their gap', () => {
  const result = detectClearanceClashes({
    layerFeatures: [squareFeature(0, 0, 10, { name: 'Pipeline' })],
    obstacleFeatures: [squareFeature(20, 0, 10, { name: 'Road corridor' })],
    clearanceMetres: 15
  });

  assert.equal(result.clashes.length, 1);
  assert.equal(result.clashes[0].distanceM, 10);
  assert.equal(result.clashes[0].overlap, false);
  assert.equal(result.clashes[0].severity, 'clearance');
  assert.equal(result.clashes[0].layerLabel, 'Pipeline');
  assert.equal(result.clashes[0].obstacleLabel, 'Road corridor');
  assert.ok(result.clashes[0].geometry, 'a highlight zone is returned');
});

test('features beyond the clearance distance are ignored', () => {
  const result = detectClearanceClashes({
    layerFeatures: [squareFeature(0, 0, 10)],
    obstacleFeatures: [squareFeature(20, 0, 10)],
    clearanceMetres: 5
  });
  assert.equal(result.clashes.length, 0);
  assert.equal(result.testedPairs, 1);
});

test('touching or intersecting features are overlaps at distance zero', () => {
  const result = detectClearanceClashes({
    layerFeatures: [squareFeature(0, 0, 10)],
    obstacleFeatures: [squareFeature(5, 5, 10)],
    clearanceMetres: 0
  });
  assert.equal(result.clashes.length, 1);
  assert.equal(result.clashes[0].distanceM, 0);
  assert.equal(result.clashes[0].overlap, true);
  assert.equal(result.clashes[0].severity, 'overlap');
});

test('pair testing is capped and the response says so', () => {
  const many = Array.from({ length: 10 }, (_, index) => squareFeature(index * 2, 0, 10));
  const result = detectClearanceClashes({
    layerFeatures: many,
    obstacleFeatures: many,
    clearanceMetres: 1,
    maxClashes: 5
  });
  assert.equal(result.clashes.length, 5);
  assert.equal(result.truncated, true);
});

test('missing or broken geometry is skipped, not fatal', () => {
  const result = detectClearanceClashes({
    layerFeatures: [squareFeature(0, 0, 10), { geometry: null }, { geometry: { type: 'Polygon', coordinates: [] } }],
    obstacleFeatures: [squareFeature(5, 5, 10)],
    clearanceMetres: 1
  });
  assert.equal(result.layerFeatureCount, 1);
  assert.equal(result.clashes.length, 1);
});

test('clearance must be a non-negative number', () => {
  assert.throws(() => detectClearanceClashes({ clearanceMetres: -1 }), RangeError);
  assert.throws(() => detectClearanceClashes({ clearanceMetres: 'wide' }), RangeError);
});

test('a flat grid has no slope and a 1:1 ramp is 45 degrees', () => {
  const flat = new Float32Array([5, 5, 5, 5, 5, 5, 5, 5, 5]);
  const flatSlope = slopeGrid({ grid: flat, width: 3, height: 3, dx: 1, dy: 1 });
  assert.ok(flatSlope.every(value => Math.abs(value) < 1e-6));

  // One metre of rise per metre east: 45 degrees.
  const ramp = new Float32Array([0, 1, 2, 0, 1, 2, 0, 1, 2]);
  const rampSlope = slopeGrid({ grid: ramp, width: 3, height: 3, dx: 1, dy: 1 });
  assert.ok(Math.abs(rampSlope[4] - 45) < 0.001);
});

test('bilinear sampling interpolates and returns NaN outside the grid', () => {
  const grid = new Float32Array([0, 10, 0, 10]);
  assert.equal(sampleGridBilinear(grid, 2, 2, 0.5, 0.5), 5);
  assert.ok(Number.isNaN(sampleGridBilinear(grid, 2, 2, 40, 40)));
});

test('slope hazards flag only features on terrain steeper than the threshold', () => {
  // 4 x 2 grid, 1 m cells, 1 m rise per metre east: 45 degrees everywhere.
  const ramp = new Float32Array([0, 1, 2, 3, 0, 1, 2, 3]);
  const slope = slopeGrid({ grid: ramp, width: 4, height: 2, dx: 1, dy: 1 });

  const features = [
    { properties: { name: 'Steep asset' }, geometry: squareFeature(1, 0, 1).geometry },
    { properties: { name: 'Flat asset' }, geometry: squareFeature(99, 99, 1).geometry }
  ];

  const result = slopeHazards({
    features,
    crsBounds: [0, 0, 4, 2],
    slope,
    width: 4,
    height: 2,
    thresholdDegrees: 30
  });

  assert.equal(result.clashes.length, 1);
  assert.equal(result.clashes[0].layerLabel, 'Steep asset');
  assert.equal(result.clashes[0].severity, 'slope');
  assert.equal(result.clashes[0].thresholdDeg, 30);
  assert.ok(result.clashes[0].slopeDeg > 30);
});

test('a threshold above the terrain flags nothing', () => {
  const flat = new Float32Array([1, 1, 1, 1, 1, 1, 1, 1]);
  const slope = slopeGrid({ grid: flat, width: 4, height: 2, dx: 1, dy: 1 });
  const result = slopeHazards({
    features: [{ properties: {}, geometry: squareFeature(1, 0, 1).geometry }],
    crsBounds: [0, 0, 4, 2],
    slope,
    width: 4,
    height: 2,
    thresholdDegrees: 5
  });
  assert.equal(result.clashes.length, 0);
});
