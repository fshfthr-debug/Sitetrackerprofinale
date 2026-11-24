// ============================================================================
// Basemap catalogue
//
// Two tiers, chosen at runtime:
//
//   Vector (preferred)  MapTiler styles, used when GET /api/config reports a
//                       MAPTILER_KEY. The key is read from the server's
//                       environment, so it can be rotated without rebuilding.
//   Raster (fallback)   Esri World Street Map / World Imagery / World Topo /
//                       Dark Gray / Light Gray. No key, and no dependency on
//                       tile.openstreetmap.org (whose public tiles block
//                       datacentre traffic) or CARTO (which watermarks keyless
//                       requests).
//
// Adding a basemap:
//   1. drop an entry in BASEMAP_CHOICES with an absolute https tile template,
//   2. allow the tile host in the backend Content-Security-Policy (TILE_HOSTS
//      in backend-v3-enhanced.js) or the browser blocks the images,
//   3. nothing else - rasterBasemap() picks it up from the id.
//
// `local` is not a tile service: it draws the shipped Addis extract and is kept
// as the offline fallback when no tile host is reachable.
// ============================================================================

// Layer id -> MapTiler v2 style slug. Keep in step with backend/maptiler.js.
export const MAPTILER_STYLE_IDS = {
  street: 'streets-v2',
  satellite: 'hybrid',
  terrain: 'outdoor-v2',
  dark: 'streets-v2-dark',
  light: 'streets-v2-light'
};

// A style URL for MapTiler, or null when there is no key or no vector style for
// this id. Callers fall back to the raster catalogue when this returns null.
export function maptilerStyleUrl(id, key) {
  const style = MAPTILER_STYLE_IDS[id];
  if (!style || !key) return null;
  return `https://api.maptiler.com/maps/${style}/style.json?key=${encodeURIComponent(key)}`;
}

export const BASEMAP_CHOICES = [
  {
    id: 'street',
    label: 'Street',
    // Esri World Street Map: keyless and global. CARTO's keyless endpoints now watermark
    // every request with "API KEY REQUIRED", so they are not a usable fallback.
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}'],
    maxZoom: 19,
    attribution: '© Esri, HERE, Garmin, OpenStreetMap contributors'
  },
  {
    id: 'satellite',
    label: 'Satellite',
    // Esri's public World Imagery service uses the {z}/{y}/{x} order, not {z}/{x}/{y}.
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
    maxZoom: 19,
    attribution: 'Imagery © Esri, Maxar, Earthstar Geographics'
  },
  {
    id: 'terrain',
    label: 'Terrain',
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}'],
    maxZoom: 19,
    attribution: '© Esri, HERE, Garmin, OpenStreetMap contributors'
  },
  {
    id: 'dark',
    label: 'Dark GIS',
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}'],
    maxZoom: 16,
    attribution: '© Esri, HERE, Garmin, OpenStreetMap contributors'
  },
  {
    id: 'light',
    label: 'Light GIS',
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}'],
    maxZoom: 16,
    attribution: '© Esri, HERE, Garmin, OpenStreetMap contributors'
  },
  {
    id: 'local',
    label: 'Local extract',
    local: true,
    maxZoom: 22,
    attribution: '© OpenStreetMap contributors'
  }
];

export const DEFAULT_BASEMAP = 'street';

export function basemapChoice(id) {
  return BASEMAP_CHOICES.find(choice => choice.id === id) || BASEMAP_CHOICES[0];
}

// The raster source/layer for a basemap id, or null when the id means "draw the
// local extract instead" / is unknown. Kept as plain data so basemapStyle() can
// assemble a whole style without touching the map instance.
export function rasterBasemap(id) {
  const choice = BASEMAP_CHOICES.find(item => item.id === id);
  if (!choice || !Array.isArray(choice.tiles)) return null;
  return {
    id: choice.id,
    tiles: choice.tiles,
    maxZoom: choice.maxZoom,
    attribution: choice.attribution,
    // Clouds and blank ocean in imagery read better over a mid tone than white.
    background: choice.id === 'satellite' ? '#0f1720' : choice.id === 'dark' ? '#0d1117' : '#f5f2ea'
  };
}
