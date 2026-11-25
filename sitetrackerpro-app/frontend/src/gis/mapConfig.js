// ============================================================================
// Runtime map configuration
//
// MAPTILER_KEY lives in the server environment and arrives through
// GET /api/config, so rotating it on Render takes effect on the next page load
// without rebuilding this bundle. The request is made once per page load and
// shared by every map in the app.
// ============================================================================

import axios from 'axios';

const API_URL = process.env.REACT_APP_API_URL || '';

const EMPTY = {
  maptiler: { enabled: false, key: '', styleIds: {}, attribution: '' },
  basemaps: { vector: false, fallback: 'carto-esri' }
};

// The server reports whatever MAPTILER_KEY it holds, but only MapTiler can say whether
// that key is allowed to serve this origin. A key with an origin or user-agent
// restriction answers 403 "Key usage restricted", and if the map trusted the server
// blindly the basemap would come up empty. One probe of the style document settles it,
// and a rejected key is treated exactly like no key: raster fallback.
const PROBE_STYLE = 'streets-v2';

async function keyServesTiles(key) {
  if (!key) return false;
  if (typeof fetch !== 'function' || typeof AbortController !== 'function') return true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(
      `https://api.maptiler.com/maps/${PROBE_STYLE}/style.json?key=${encodeURIComponent(key)}`,
      { mode: 'cors', cache: 'no-store', signal: controller.signal }
    );
    return response.ok;
  } catch (err) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

let config = null;
let pending = null;

export async function loadMapConfig() {
  if (config) return config;
  if (!pending) {
    pending = axios.get(`${API_URL}/api/config`, { timeout: 8000 })
      .then(async response => {
        const data = response.data && response.data.maptiler ? response.data : EMPTY;
        const key = data.maptiler && data.maptiler.key;
        if (data.maptiler && data.maptiler.enabled && key && !(await keyServesTiles(key))) {
          // Keep the key out of the client config so nothing tries the vector style again.
          // eslint-disable-next-line no-console
          console.warn('MapTiler key rejected (usage restricted); using raster basemaps.');
          config = {
            ...data,
            maptiler: { ...data.maptiler, enabled: false, key: '', reason: 'key-rejected' },
            basemaps: { ...data.basemaps, vector: false, fallback: 'esri' }
          };
          return config;
        }
        config = data;
        return config;
      })
      .catch(() => {
        // A configuration failure must not break the map: raster basemaps need no key.
        config = EMPTY;
        return config;
      });
  }
  return pending;
}

// Synchronous read for code that runs after loadMapConfig() has resolved.
export function cachedMapConfig() {
  return config || EMPTY;
}

export function maptilerKey() {
  const value = cachedMapConfig();
  return (value.maptiler && value.maptiler.key) || '';
}
