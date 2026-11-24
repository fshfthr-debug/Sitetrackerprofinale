// ============================================================================
// Basemap catalogue
//
// The map used to have exactly one basemap: a GeoJSON extract of Addis Ababa
// that ships with the backend. That is why coverage stopped at the city edge
// and why zoom levels above the extract's detail looked empty. Everything here
// is a standard raster tile service, so coverage is global and zoom goes to the
// depth each provider publishes.
//
// Adding a basemap:
//   1. drop an entry in BASEMAP_CHOICES with an absolute https tile template,
//   2. allow the tile host in the backend Content-Security-Policy (imgSrc and
//      connectSrc in backend-v3-enhanced.js) or the browser blocks the images,
//   3. nothing else - basemapStyle() picks it up from the id.
//
// `local` is not a tile service: it draws the shipped Addis extract and is kept
// as the offline fallback when no tile host is reachable.
// ============================================================================

export const BASEMAP_CHOICES = [
  {
    id: 'street',
    label: 'Street',
    tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
    maxZoom: 19,
    attribution: '© OpenStreetMap contributors'
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
    tiles: [
      'https://a.tile.opentopomap.org/{z}/{x}/{y}.png',
      'https://b.tile.opentopomap.org/{z}/{x}/{y}.png',
      'https://c.tile.opentopomap.org/{z}/{x}/{y}.png'
    ],
    maxZoom: 17,
    attribution: '© OpenTopoMap (CC-BY-SA), © OpenStreetMap contributors'
  },
  {
    id: 'dark',
    label: 'Dark GIS',
    tiles: ['https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png'],
    maxZoom: 20,
    attribution: '© CARTO, © OpenStreetMap contributors'
  },
  {
    id: 'light',
    label: 'Light GIS',
    tiles: ['https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png'],
    maxZoom: 20,
    attribution: '© CARTO, © OpenStreetMap contributors'
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
