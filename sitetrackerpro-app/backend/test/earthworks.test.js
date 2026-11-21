'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateEarthworksVolumes } = require('../earthworks');

test('a floor above ground produces fill and a net export', () => {
  const result = calculateEarthworksVolumes({
    buildingFootprint: 1200,
    foundationDepth: 2.5,
    fillDepth: 0.7
  });

  assert.deepEqual(result, {
    cutVolume: 3000,
    fillVolume: 840,
    netVolume: -2160
  });
});

test('a floor below ground adds cut instead of producing negative fill', () => {
  const result = calculateEarthworksVolumes({
    buildingFootprint: 1000,
    foundationDepth: 2,
    fillDepth: -0.5
  });

  assert.deepEqual(result, {
    cutVolume: 2500,
    fillVolume: 0,
    netVolume: -2500
  });
});

test('a floor at ground level needs foundation cut only', () => {
  const result = calculateEarthworksVolumes({
    buildingFootprint: 1000,
    foundationDepth: 2,
    fillDepth: 0
  });

  assert.deepEqual(result, {
    cutVolume: 2000,
    fillVolume: 0,
    netVolume: -2000
  });
});

test('amounts are rounded to two decimals at the boundary', () => {
  const result = calculateEarthworksVolumes({
    buildingFootprint: 3.333,
    foundationDepth: 1.111,
    fillDepth: 0.222
  });

  assert.equal(result.cutVolume, 3.7);
  assert.equal(result.fillVolume, 0.74);
  assert.equal(result.netVolume, -2.96);
});

test('invalid inputs are rejected rather than stored as NaN', () => {
  assert.throws(() => calculateEarthworksVolumes({
    buildingFootprint: 0,
    foundationDepth: 2,
    fillDepth: 1
  }), /buildingFootprint/);

  assert.throws(() => calculateEarthworksVolumes({
    buildingFootprint: 100,
    foundationDepth: -1,
    fillDepth: 1
  }), /foundationDepth/);

  assert.throws(() => calculateEarthworksVolumes({
    buildingFootprint: 100,
    foundationDepth: 1,
    fillDepth: NaN
  }), /fillDepth/);
});
