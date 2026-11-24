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

let config = null;
let pending = null;

export async function loadMapConfig() {
  if (config) return config;
  if (!pending) {
    pending = axios.get(`${API_URL}/api/config`, { timeout: 8000 })
      .then(response => {
        config = response.data && response.data.maptiler ? response.data : EMPTY;
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
