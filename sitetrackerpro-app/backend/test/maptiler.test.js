'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { maptilerConfig, mapTilerStyleUrl, normaliseKey, MAPTILER_STYLE_IDS } = require('../maptiler');

test('an empty environment disables vector basemaps', () => {
  const config = maptilerConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.key, '');
});

test('a configured key enables vector basemaps and is returned for the client', () => {
  const config = maptilerConfig({ MAPTILER_KEY: 'AbCdEf1234567890' });
  assert.equal(config.enabled, true);
  assert.equal(config.key, 'AbCdEf1234567890');
  assert.equal(config.styleIds.street, 'streets-v2');
  assert.equal(config.styleIds.satellite, 'hybrid');
  assert.equal(config.styleIds.terrain, 'outdoor-v2');
  assert.equal(config.styleIds.dark, 'streets-v2-dark');
});

test('placeholders and malformed keys fall back instead of shipping a broken style URL', () => {
  assert.equal(normaliseKey(''), '');
  assert.equal(normaliseKey('   '), '');
  assert.equal(normaliseKey('your-key'), '');
  assert.equal(normaliseKey('changeme'), '');
  assert.equal(normaliseKey('has spaces in it'), '');
  assert.equal(normaliseKey('https://api.maptiler.com/key'), '');
  assert.equal(normaliseKey('short'), '');
  assert.equal(normaliseKey('AbCdEf1234567890'), 'AbCdEf1234567890');
});

test('style URLs use the MapTiler v2 slugs and the configured key', () => {
  assert.equal(
    mapTilerStyleUrl('street', 'AbCdEf1234567890'),
    'https://api.maptiler.com/maps/streets-v2/style.json?key=AbCdEf1234567890'
  );
  assert.equal(
    mapTilerStyleUrl('satellite', 'AbCdEf1234567890'),
    'https://api.maptiler.com/maps/hybrid/style.json?key=AbCdEf1234567890'
  );
  assert.equal(
    mapTilerStyleUrl('dark', 'AbCdEf1234567890'),
    'https://api.maptiler.com/maps/streets-v2-dark/style.json?key=AbCdEf1234567890'
  );
});

test('no key or an unknown layer id yields no style URL, so the raster fallback is used', () => {
  assert.equal(mapTilerStyleUrl('street', ''), null);
  assert.equal(mapTilerStyleUrl('street', 'your-key'), null);
  assert.equal(mapTilerStyleUrl('street', 'AbCdEf1234567890'), mapTilerStyleUrl('street', 'AbCdEf1234567890'));
  assert.equal(mapTilerStyleUrl('local', 'AbCdEf1234567890'), null);
  assert.equal(mapTilerStyleUrl('nope', 'AbCdEf1234567890'), null);
});

test('the style catalogue is a fixed allow-list', () => {
  assert.deepEqual(Object.keys(MAPTILER_STYLE_IDS).sort(), ['dark', 'light', 'satellite', 'street', 'terrain']);
});
