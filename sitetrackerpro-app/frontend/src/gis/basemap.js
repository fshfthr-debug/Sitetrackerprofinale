import maplibregl from 'maplibre-gl';

export const DEFAULT_CENTER = [38.78, 9.02];
export const SITE_ATTRIBUTION = '© OpenStreetMap contributors';

const ROAD_COLOURS = {
  motorway: '#f2b24a', trunk: '#f2b24a', primary: '#f8d28a', secondary: '#fbe4b6',
  tertiary: '#ffffff', residential: '#ffffff', unclassified: '#ffffff', living_street: '#ffffff'
};

function roadClassWidths(motorway, primary, secondary, tertiary, other) {
  return ['match', ['get', 'class'],
    ['motorway', 'trunk'], motorway,
    'primary', primary,
    'secondary', secondary,
    'tertiary', tertiary,
    other];
}

// The style spec only allows `zoom` as the input of a top-level interpolate/step, so the width
// expression stays a single interpolate whose stops are per-class matches.
function roadWidth(extra = 0) {
  const withExtra = value => (extra ? ['+', value, extra] : value);
  return ['interpolate', ['linear'], ['zoom'],
    10, withExtra(roadClassWidths(2.4, 2.2, 1.8, 1.4, 1.0)),
    14, withExtra(roadClassWidths(9, 8, 6, 4, 2.8)),
    18, withExtra(roadClassWidths(26, 22, 16, 10, 7))
  ];
}

export function basemapStyle(basemap) {
  const sources = {};
  const layers = [{ id: 'background', type: 'background', paint: { 'background-color': '#f5f2ea' } }];

  if (basemap && Array.isArray(basemap.features)) {
    sources.basemap = { type: 'geojson', data: basemap, tolerance: 0.4 };

    layers.push(
      {
        id: 'basemap-landuse', type: 'fill', source: 'basemap',
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: { 'fill-color': '#e9e4d6', 'fill-opacity': 0.7 }
      },
      {
        id: 'basemap-water', type: 'fill', source: 'basemap',
        filter: ['all', ['==', ['geometry-type'], 'Polygon'], ['==', ['get', 'kind'], 'water']],
        paint: { 'fill-color': '#a9c9e6' }
      },
      {
        id: 'basemap-waterway', type: 'line', source: 'basemap',
        filter: ['==', ['get', 'kind'], 'waterway'],
        paint: { 'line-color': '#8db8dc', 'line-width': 1.4 }
      },
      {
        id: 'basemap-park', type: 'fill', source: 'basemap',
        filter: ['all', ['==', ['geometry-type'], 'Polygon'], ['==', ['get', 'kind'], 'park']],
        paint: { 'fill-color': '#cfe3c4', 'fill-opacity': 0.9 }
      },
      {
        id: 'basemap-road-casing', type: 'line', source: 'basemap',
        filter: ['==', ['get', 'kind'], 'road'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#d8d1c3', 'line-width': roadWidth(1.8) }
      },
      {
        id: 'basemap-road', type: 'line', source: 'basemap',
        filter: ['==', ['get', 'kind'], 'road'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['match', ['get', 'class'],
            ['motorway', 'trunk'], ROAD_COLOURS.motorway,
            'primary', ROAD_COLOURS.primary,
            'secondary', ROAD_COLOURS.secondary,
            '#ffffff'],
          'line-width': roadWidth()
        }
      },
      {
        id: 'basemap-rail', type: 'line', source: 'basemap',
        filter: ['==', ['get', 'kind'], 'rail'],
        paint: { 'line-color': '#8d8d8d', 'line-width': 1.4, 'line-dasharray': [3, 2] }
      }
    );
  }

  return { version: 8, name: 'SiteTrackerPro local basemap', sources, layers };
}

export function addPlaceLabels(map, basemap) {
  if (!basemap || !Array.isArray(basemap.places)) return [];
  const markers = [];
  basemap.places
    .filter(place => ['city', 'town', 'suburb', 'neighbourhood'].includes(place.place))
    .slice(0, 70)
    .forEach(place => {
      const element = document.createElement('div');
      element.textContent = place.name;
      element.style.fontFamily = 'Calibri, sans-serif';
      element.style.fontSize = place.place === 'city' ? '14px' : '11px';
      element.style.fontWeight = place.place === 'city' ? 'bold' : 'normal';
      element.style.color = '#3f4b58';
      element.style.textShadow = '0 1px 2px #fff, 0 0 3px #fff';
      element.style.pointerEvents = 'none';
      element.style.whiteSpace = 'nowrap';
      markers.push(new maplibregl.Marker({ element, anchor: 'center' }).setLngLat([place.lon, place.lat]).addTo(map));
    });
  return markers;
}
