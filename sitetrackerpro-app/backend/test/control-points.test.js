'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateControlPointRows } = require('../control-points');

const row = (overrides = {}) => ({
  row: 2,
  name: 'BM-01',
  latitude: '9.055607',
  longitude: '38.972702',
  benchmarkElevation: '2361.24',
  verticalDatum: 'Project benchmark',
  status: 'submitted',
  isBenchmark: 'yes',
  ...overrides
});

test('accepts a complete control point and normalises numeric values', () => {
  const result = validateControlPointRows([row()]);
  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.points[0], {
    row: 2,
    name: 'BM-01',
    latitude: 9.055607,
    longitude: 38.972702,
    benchmarkElevation: 2361.24,
    verticalDatum: 'Project benchmark',
    status: 'submitted',
    isBenchmark: true
  });
});

test('applies import defaults for datum and status', () => {
  const result = validateControlPointRows([
    row({ verticalDatum: '', status: '', isBenchmark: '' })
  ], { defaultVerticalDatum: 'MSL', defaultStatus: 'draft' });

  assert.equal(result.errors.length, 0);
  assert.equal(result.points[0].verticalDatum, 'MSL');
  assert.equal(result.points[0].status, 'draft');
  assert.equal(result.points[0].isBenchmark, false);
});

test('rejects coordinates outside the earth range', () => {
  const result = validateControlPointRows([
    row({ latitude: '91' }),
    row({ row: 3, name: 'BM-02', longitude: '181' })
  ]);

  assert.equal(result.points.length, 0);
  assert.equal(result.errors.length, 2);
  assert.match(result.errors[0].message, /Latitude/);
  assert.match(result.errors[1].message, /Longitude/);
});

test('rejects unknown statuses and missing vertical datum', () => {
  const result = validateControlPointRows([
    row({ status: 'approved' }),
    row({ row: 3, name: 'BM-02', verticalDatum: '' })
  ], { defaultVerticalDatum: '' });

  assert.equal(result.points.length, 0);
  assert.match(result.errors[0].message, /Unknown status/);
  assert.match(result.errors[1].message, /Vertical datum/);
});

test('rejects duplicate names in the file and in the project', () => {
  const result = validateControlPointRows([
    row(),
    row({ row: 3, latitude: '9.1' }),
    row({ row: 4, name: 'CP-05' })
  ], { existingNames: ['CP-05'] });

  assert.equal(result.points.length, 1);
  assert.equal(result.errors.length, 2);
  assert.match(result.errors[0].message, /already exists/);
  assert.match(result.errors[1].message, /already exists/);
});

test('accepts a valid point even when another row is invalid', () => {
  const result = validateControlPointRows([
    row({ name: '' }),
    row({ row: 3, name: 'BM-02' })
  ]);

  assert.equal(result.points.length, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.points[0].name, 'BM-02');
});
