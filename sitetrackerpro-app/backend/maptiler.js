'use strict';
/**
 * MapTiler basemap configuration.
 *
 * The key is read from the process environment at request time and handed to the frontend by
 * GET /api/config, so rotating it only needs a Render environment change and a restart - the
 * frontend bundle is not rebuilt. A MapTiler browser key is a public identifier (it is visible
 * in every tile URL), so exposing it through the config endpoint adds no secret; server keys
 * must not be pasted here.
 *
 * An empty or obviously malformed key disables vector basemaps and the frontend falls back to
 * Esri raster tiles, which need no key at all.
 */

// Layer id used by the frontend -> MapTiler style slug.
const MAPTILER_STYLE_IDS = {
  street: 'streets-v2',
  satellite: 'hybrid',
  terrain: 'outdoor-v2',
  dark: 'streets-v2-dark',
  light: 'streets-v2-light'
};

const PLACEHOLDER_VALUES = new Set(['', 'your-key', 'maptiler_key', 'changeme', 'none', 'null', 'undefined']);

function normaliseKey(value) {
  const raw = String(value || '').trim();
  if (PLACEHOLDER_VALUES.has(raw.toLowerCase())) return '';
  // MapTiler keys are URL-safe tokens; anything with spaces or slashes is a paste mistake,
  // and shipping it would produce a broken style URL instead of a clean fallback.
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(raw)) return '';
  return raw;
}

function maptilerConfig(env = process.env) {
  const key = normaliseKey(env.MAPTILER_KEY);
  return {
    enabled: Boolean(key),
    key,
    styleIds: { ...MAPTILER_STYLE_IDS },
    styleUrlTemplate: 'https://api.maptiler.com/maps/{style}/style.json?key={key}',
    attribution: '© MapTiler © OpenStreetMap contributors'
  };
}

function mapTilerStyleUrl(id, key) {
  const normalised = normaliseKey(key);
  const style = MAPTILER_STYLE_IDS[id];
  if (!normalised || !style) return null;
  return `https://api.maptiler.com/maps/${style}/style.json?key=${encodeURIComponent(normalised)}`;
}

module.exports = {
  MAPTILER_STYLE_IDS,
  maptilerConfig,
  mapTilerStyleUrl,
  normaliseKey
};
