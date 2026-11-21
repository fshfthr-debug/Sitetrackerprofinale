import React, { useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import maplibregl from 'maplibre-gl';
import proj4 from 'proj4';
import 'maplibre-gl/dist/maplibre-gl.css';
import OsmExplorer from './OsmExplorer';
import SurveyGis from './SurveyGis';
import MapPrintLayout, { niceDistance, formatDistance } from './MapPrintLayout';

const API_URL = process.env.REACT_APP_API_URL || '';
const DEFAULT_CENTER = [38.78, 9.02];
const SITE_ATTRIBUTION = '© OpenStreetMap contributors';

const styles = {
  page: { padding: '0 0 24px' },
  header: { display: 'flex', flexWrap: 'wrap', gap: '14px', alignItems: 'flex-end', marginBottom: '14px' },
  card: { background: 'white', border: '1px solid #ddd', borderRadius: '8px', padding: '16px', boxShadow: '0 2px 4px rgba(0,0,0,0.06)' },
  input: { padding: '9px 10px', border: '1px solid #ccc', borderRadius: '5px', fontSize: '14px', fontFamily: 'Calibri', minWidth: '140px' },
  button: { padding: '9px 12px', background: '#FF6B35', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer', fontWeight: 'bold', fontSize: '13px' },
  buttonSmall: { padding: '5px 8px', background: 'white', border: '1px solid #ddd', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' },
  helper: { color: '#5b6773', fontSize: '13px', lineHeight: 1.45, margin: '6px 0' },
  error: { background: '#fff3f0', border: '1px solid #f3b7a6', color: '#8a2b12', padding: '10px 12px', borderRadius: '6px', fontSize: '13px', marginBottom: '10px' },
  notice: { background: '#eef7ee', border: '1px solid #b7d9b7', color: '#235b2c', padding: '8px 12px', borderRadius: '6px', fontSize: '13px', marginBottom: '10px' },
  grid: { display: 'grid', gridTemplateColumns: 'minmax(300px, 360px) minmax(0, 1fr)', gap: '14px', alignItems: 'start' },
  map: { height: '660px', borderRadius: '10px', overflow: 'hidden', border: '1px solid #cfd8e3', background: '#eef2f7' },
  layerRow: { borderTop: '1px solid #eee', padding: '8px 0' },
  badge: { display: 'inline-block', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.04em', background: '#eef2f7', color: '#425466', borderRadius: '3px', padding: '1px 5px', marginLeft: '6px' },
  inspector: { position: 'absolute', left: '12px', bottom: '12px', maxWidth: '340px', background: 'rgba(255,255,255,0.97)', border: '1px solid #cfd8e3', borderRadius: '8px', padding: '10px 12px', fontSize: '12px', boxShadow: '0 4px 14px rgba(0,0,0,0.14)' }
};

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

function basemapStyle(basemap) {
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

function addPlaceLabels(map, basemap) {
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

function geometryCenter(geometry) {
  if (!geometry || !geometry.coordinates) return null;
  if (geometry.type === 'Point') return geometry.coordinates;
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  const walk = value => {
    if (!Array.isArray(value)) return;
    if (typeof value[0] === 'number' && typeof value[1] === 'number') {
      west = Math.min(west, value[0]); east = Math.max(east, value[0]);
      south = Math.min(south, value[1]); north = Math.max(north, value[1]);
      return;
    }
    value.forEach(walk);
  };
  walk(geometry.coordinates);
  if (!Number.isFinite(west)) return null;
  return [(west + east) / 2, (south + north) / 2];
}

const fileSlug = name => String(name || 'dataset').replace(/[^a-z0-9._-]+/gi, '-').toLowerCase();

function formatCursor(lngLat, crs, crsList) {
  if (!lngLat) return null;
  const wgs84 = crsList.find(item => item.code === 'EPSG:4326');
  const target = crsList.find(item => item.code === crs);
  if (!wgs84 || !target) return null;
  if (target.code === 'EPSG:4326') {
    return `${lngLat.lat.toFixed(6)}, ${lngLat.lng.toFixed(6)}`;
  }
  try {
    const [x, y] = proj4(wgs84.def, target.def, [lngLat.lng, lngLat.lat]);
    return `${x.toFixed(2)}, ${y.toFixed(2)} ${target.units === 'metres' ? 'm' : ''}`.trim();
  } catch (err) {
    return null;
  }
}

export default function GisWorkspace({ token, projects }) {
  const [projectId, setProjectId] = useState('');
  const [workspaces, setWorkspaces] = useState([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [workspace, setWorkspace] = useState(null);
  const [datasets, setDatasets] = useState([]);
  const [terrains, setTerrains] = useState([]);
  const [surveyCount, setSurveyCount] = useState(0);
  const [survey, setSurvey] = useState(null);
  const [view, setView] = useState('workspace');
  const [osmPreview, setOsmPreview] = useState(null);
  const [payloads, setPayloads] = useState({});
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [mapReady, setMapReady] = useState(false);
  const [styleVersion, setStyleVersion] = useState(0);
  const [basemapError, setBasemapError] = useState(false);
  const [selected, setSelected] = useState(null);
  const [savingView, setSavingView] = useState(false);
  const [crsList, setCrsList] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [dataVersion, setDataVersion] = useState(0);
  const [importFile, setImportFile] = useState(null);
  const [importName, setImportName] = useState('');
  const [importCrs, setImportCrs] = useState('EPSG:4326');
  const [importing, setImporting] = useState(false);
  const [reprojectDatasetId, setReprojectDatasetId] = useState('');
  const [reprojectCrs, setReprojectCrs] = useState('EPSG:32637');
  const [reprojecting, setReprojecting] = useState(false);
  const [analysis, setAnalysis] = useState({
    operation: 'buffer',
    inputId: '',
    overlayId: '',
    distance: 100,
    crs: 'EPSG:32637',
    dissolveBy: '',
    name: ''
  });
  const [analysisResult, setAnalysisResult] = useState(null);
  const [analysing, setAnalysing] = useState(false);
  const [tableLayerId, setTableLayerId] = useState('');
  const [tableFilter, setTableFilter] = useState('');
  const [tableSort, setTableSort] = useState({ key: null, direction: 'asc' });
  const [styleLayerId, setStyleLayerId] = useState('');
  const [printSnapshot, setPrintSnapshot] = useState(null);
  const [printSettings, setPrintSettings] = useState({
    title: '', subtitle: '', paper: 'A4', orientation: 'landscape',
    legend: true, scaleBar: true, northArrow: true, attribution: true
  });
  const [narrow, setNarrow] = useState(typeof window !== 'undefined' && window.innerWidth < 900);

  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 900);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const mapContainer = useRef(null);
  const mapRef = useRef(null);
  const fittedRef = useRef(null);
  const markersRef = useRef([]);
  const opacityTimers = useRef({});
  const styleTimers = useRef({});
  const styleDraftRef = useRef({});
  const fileInputRef = useRef(null);

  const authHeaders = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);

  // ---------------------------------------------------------------------------
  // Map lifecycle. The style is built from a locally served OSM extract, so no request leaves
  // the origin and the strict connect-src policy stays in place.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    if (!mapContainer.current) return;

    const map = new maplibregl.Map({
      container: mapContainer.current,
      style: basemapStyle(null),
      center: DEFAULT_CENTER,
      zoom: 11,
      attributionControl: false,
      // MapLibre 5 reads this from canvasContextAttributes; it lets the print layout capture
      // the rendered map canvas as a PNG.
      canvasContextAttributes: { preserveDrawingBuffer: true }
    });
    mapRef.current = map;
    if (typeof window !== 'undefined') window.__gisMap = map;

    map.on('error', event => console.warn('Map error:', event && event.error ? event.error.message : event));
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    map.addControl(new maplibregl.AttributionControl({ customAttribution: SITE_ATTRIBUTION }), 'bottom-right');

    map.on('load', () => setMapReady(true));
    // Every setStyle replaces the layer lists, so managed layers are re-applied after a style load.
    map.on('style.load', () => setStyleVersion(version => version + 1));

    map.on('click', event => {
      const features = map.queryRenderedFeatures(event.point).filter(feature =>
        String(feature.layer.id).startsWith('gislayer-') && feature.properties
      );
      if (features.length === 0) { setSelected(null); return; }
      const feature = features[0];
      setSelected({
        layerId: feature.layer.id,
        properties: feature.properties,
        geometryType: feature.geometry && feature.geometry.type
      });
    });

    map.on('mousemove', event => setCursor({ lng: event.lngLat.lng, lat: event.lngLat.lat }));
    map.on('mouseout', () => setCursor(null));

    // The local OSM extract is applied separately: a 12 MB style object is more reliably attached
    // after the map shell already exists.
    (async () => {
      try {
        const response = await axios.get(`${API_URL}/basemaps/addis-osm.json`);
        if (cancelled) return;
        markersRef.current = addPlaceLabels(map, response.data);
        map.setStyle(basemapStyle(response.data));
      } catch (err) {
        if (!cancelled) setBasemapError(true);
      }
    })();

    return () => {
      cancelled = true;
      markersRef.current.forEach(marker => marker.remove());
      markersRef.current = [];
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
      setMapReady(false);
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Project data
  // ---------------------------------------------------------------------------
  useEffect(() => {
    setWorkspaces([]);
    setWorkspaceId('');
    setWorkspace(null);
    setPayloads({});
    setSelected(null);
    setError('');
    setNotice('');
    fittedRef.current = null;
    if (!projectId) return;

    (async () => {
      setBusy('Loading GIS workspaces…');
      try {
        const [workspaceResponse, datasetResponse, terrainResponse, surveyResponse, crsResponse] = await Promise.all([
          axios.get(`${API_URL}/api/gis/workspaces/${projectId}`, { headers: authHeaders }),
          axios.get(`${API_URL}/api/gis/datasets/${projectId}`, { headers: authHeaders }),
          axios.get(`${API_URL}/api/terrain/${projectId}`, { headers: authHeaders }),
          axios.get(`${API_URL}/api/gis/survey-points/${projectId}`, { headers: authHeaders }),
          axios.get(`${API_URL}/api/gis/crs`, { headers: authHeaders })
        ]);
        setWorkspaces(workspaceResponse.data);
        setDatasets(datasetResponse.data);
        setTerrains(terrainResponse.data);
        setSurvey(surveyResponse.data);
        setSurveyCount(surveyResponse.data.count || 0);
        setCrsList(crsResponse.data.crs || []);
        if (workspaceResponse.data.length > 0) setWorkspaceId(String(workspaceResponse.data[0].id));
      } catch (err) {
        setError(err.response?.data?.error || err.message);
      } finally {
        setBusy('');
      }
    })();
  }, [projectId, authHeaders]);

  useEffect(() => {
    if (datasets.length === 0) return;
    setAnalysis(current => ({
      ...current,
      inputId: current.inputId || String(datasets[0].id),
      overlayId: current.overlayId || (datasets[1] ? String(datasets[1].id) : '')
    }));
  }, [datasets]);

  const loadWorkspace = async id => {
    if (!id) { setWorkspace(null); return; }
    setBusy('Loading workspace…');
    setError('');
    try {
      const response = await axios.get(`${API_URL}/api/gis/workspaces/${projectId}/${id}`, { headers: authHeaders });
      setWorkspace(response.data);
      fittedRef.current = null;
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusy('');
    }
  };

  useEffect(() => {
    if (workspaceId) loadWorkspace(workspaceId);
    else setWorkspace(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  const refreshWorkspace = async () => {
    if (!workspaceId) return null;
    const response = await axios.get(`${API_URL}/api/gis/workspaces/${projectId}/${workspaceId}`, { headers: authHeaders });
    setWorkspace(response.data);
    return response.data;
  };

  const refreshWorkspaceList = async () => {
    const response = await axios.get(`${API_URL}/api/gis/workspaces/${projectId}`, { headers: authHeaders });
    setWorkspaces(response.data);
    return response.data;
  };

  const refreshSurvey = async () => {
    if (!projectId) return null;
    const response = await axios.get(`${API_URL}/api/gis/survey-points/${projectId}`, { headers: authHeaders });
    setSurvey(response.data);
    setSurveyCount(response.data.count || 0);
    setDataVersion(version => version + 1);
    return response.data;
  };


  // ---------------------------------------------------------------------------
  // Layer payloads (GeoJSON, survey points, DEM image)
  // ---------------------------------------------------------------------------
  // Depend on the layer identity, not the whole workspace: changing opacity or visibility must not
  // refetch every dataset and hillshade image.
  const layerSignature = workspace
    ? `${workspace.id}:${dataVersion}:` + workspace.layers.map(layer => `${layer.id}:${layer.kind}:${layer.datasetId || ''}:${layer.terrainId || ''}`).join('|')
    : '';

  useEffect(() => {
    if (!workspace || !projectId) { setPayloads({}); return; }
    let cancelled = false;

    (async () => {
      const next = {};
      for (const layer of workspace.layers) {
        try {
          if (layer.kind === 'dataset' && layer.datasetId) {
            // The map canvas works in longitude/latitude; storage keeps each dataset's own CRS.
            const response = await axios.get(`${API_URL}/api/gis/datasets/${projectId}/${layer.datasetId}?crs=EPSG:4326`, { headers: authHeaders });
            next[layer.id] = { geojson: response.data.geojson, meta: response.data };
          } else if (layer.kind === 'survey') {
            const response = await axios.get(`${API_URL}/api/gis/survey-points/${projectId}`, { headers: authHeaders });
            next[layer.id] = { geojson: response.data, meta: { name: 'Survey control points' } };
          } else if (layer.kind === 'terrain' && layer.terrainId) {
            const metadata = await axios.get(`${API_URL}/api/terrain/${projectId}/${layer.terrainId}/preview`, { headers: authHeaders });
            const image = await axios.get(`${API_URL}/api/terrain/${projectId}/${layer.terrainId}/hillshade.png`, {
              headers: authHeaders,
              responseType: 'blob'
            });
            const imageUrl = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result));
              reader.onerror = () => reject(reader.error || new Error('Could not read the hillshade image.'));
              reader.readAsDataURL(image.data);
            });
            next[layer.id] = { imageUrl, boundsWgs84: metadata.data.boundsWgs84, meta: metadata.data };
          }
        } catch (err) {
          next[layer.id] = { error: err.response?.data?.error || err.message };
        }
      }
      if (!cancelled) setPayloads(next);
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layerSignature, projectId, authHeaders]);

  // ---------------------------------------------------------------------------
  // Draw managed layers. Everything is namespaced `gislayer-` so it can be replaced without
  // touching the basemap style.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!mapReady || !workspace) return;
    const map = mapRef.current;
    if (!map) return;

    const style = map.getStyle();
    style.layers
      .filter(layer => layer.id.startsWith('gislayer-'))
      .forEach(layer => { if (map.getLayer(layer.id)) map.removeLayer(layer.id); });
    Object.keys(style.sources)
      .filter(sourceId => sourceId.startsWith('gislayer-'))
      .forEach(sourceId => { if (map.getSource(sourceId)) map.removeSource(sourceId); });

    [...workspace.layers].sort((a, b) => a.zIndex - b.zIndex).forEach(layer => {
      const payload = payloads[layer.id];
      if (!payload || payload.error) return;
      const sourceId = `gislayer-${layer.id}`;
      const visibility = layer.visible ? 'visible' : 'none';
      const colour = (layer.style && layer.style.color) || (layer.kind === 'survey' ? '#0b7285' : '#d9480f');
      const fillOpacity = Number.isFinite(Number(layer.style?.fillOpacity)) ? Number(layer.style.fillOpacity) : 0.28;
      const lineWidth = Number.isFinite(Number(layer.style?.lineWidth)) ? Number(layer.style.lineWidth) : 2;
      const pointSize = Number.isFinite(Number(layer.style?.pointSize)) ? Number(layer.style.pointSize) : 5;

      if (payload.geojson) {
        map.addSource(sourceId, { type: 'geojson', data: payload.geojson });
        const geometryFilters = {
          point: ['==', ['geometry-type'], 'Point'],
          line: ['==', ['geometry-type'], 'LineString'],
          polygon: ['==', ['geometry-type'], 'Polygon']
        };
        map.addLayer({
          id: `${sourceId}-fill`, type: 'fill', source: sourceId, filter: geometryFilters.polygon,
          layout: { visibility },
          paint: { 'fill-color': colour, 'fill-opacity': fillOpacity * layer.opacity }
        });
        map.addLayer({
          id: `${sourceId}-line`, type: 'line', source: sourceId, filter: geometryFilters.line,
          layout: { visibility, 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': colour, 'line-width': lineWidth, 'line-opacity': layer.opacity }
        });
        map.addLayer({
          id: `${sourceId}-circle`, type: 'circle', source: sourceId, filter: geometryFilters.point,
          layout: { visibility },
          paint: {
            'circle-color': layer.kind === 'survey'
              ? ['case', ['==', ['get', 'isBenchmark'], true], '#c92a2a', colour]
              : colour,
            'circle-radius': layer.kind === 'survey'
              ? ['case', ['==', ['get', 'isBenchmark'], true], pointSize + 2, pointSize]
              : pointSize,
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': layer.kind === 'survey'
              ? ['case', ['==', ['get', 'isBenchmark'], true], 2, 1.5]
              : 1.5,
            'circle-opacity': layer.opacity
          }
        });
      } else if (payload.imageUrl && Array.isArray(payload.boundsWgs84)) {
        const [west, south, east, north] = payload.boundsWgs84;
        map.addSource(sourceId, {
          type: 'image',
          url: payload.imageUrl,
          coordinates: [[west, north], [east, north], [east, south], [west, south]]
        });
        map.addLayer({
          id: `${sourceId}-raster`, type: 'raster', source: sourceId,
          layout: { visibility },
          paint: { 'raster-opacity': 0.8 * layer.opacity, 'raster-fade-duration': 0 }
        });
      }
    });
  }, [mapReady, styleVersion, workspace, payloads]);

  // Ephemeral OSM preview. It is deliberately not a workspace layer until it is saved as a
  // dataset, so previewing never changes the project by itself.
  useEffect(() => {
    if (!mapReady) return;
    const map = mapRef.current;
    if (!map) return;
    ['fill', 'line', 'circle'].forEach(suffix => {
      if (map.getLayer(`gism-osm-${suffix}`)) map.removeLayer(`gism-osm-${suffix}`);
    });
    if (map.getSource('gism-osm')) map.removeSource('gism-osm');
    if (!osmPreview || !Array.isArray(osmPreview.features) || osmPreview.features.length === 0) return;

    map.addSource('gism-osm', { type: 'geojson', data: osmPreview });
    map.addLayer({
      id: 'gism-osm-fill', type: 'fill', source: 'gism-osm',
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: { 'fill-color': '#2b8a3e', 'fill-opacity': 0.25 }
    });
    map.addLayer({
      id: 'gism-osm-line', type: 'line', source: 'gism-osm',
      filter: ['==', ['geometry-type'], 'LineString'],
      paint: { 'line-color': '#2b8a3e', 'line-width': 2 }
    });
    map.addLayer({
      id: 'gism-osm-circle', type: 'circle', source: 'gism-osm',
      filter: ['==', ['geometry-type'], 'Point'],
      paint: { 'circle-color': '#2b8a3e', 'circle-radius': 4, 'circle-stroke-color': '#fff', 'circle-stroke-width': 1 }
    });

    let west = Infinity; let south = Infinity; let east = -Infinity; let north = -Infinity;
    const walk = value => {
      if (!Array.isArray(value)) return;
      if (typeof value[0] === 'number' && typeof value[1] === 'number') {
        west = Math.min(west, value[0]); east = Math.max(east, value[0]);
        south = Math.min(south, value[1]); north = Math.max(north, value[1]);
        return;
      }
      value.forEach(walk);
    };
    osmPreview.features.forEach(feature => feature.geometry && walk(feature.geometry.coordinates));
    if ([west, south, east, north].every(Number.isFinite)) {
      map.fitBounds([[west, south], [east, north]], { padding: 40, duration: 500, maxZoom: 16 });
    }
  }, [mapReady, styleVersion, osmPreview]);

  // Restore the saved view once per workspace, after its layers exist.
  useEffect(() => {
    if (!mapReady || !workspace || fittedRef.current === workspace.id) return;
    const map = mapRef.current;
    if (!map) return;

    const view = workspace.viewState || {};
    if (Array.isArray(view.center) && view.center.length === 2 && Number.isFinite(Number(view.zoom))) {
      map.jumpTo({ center: view.center, zoom: Number(view.zoom), bearing: Number(view.bearing || 0), pitch: Number(view.pitch || 0) });
      fittedRef.current = workspace.id;
      return;
    }

    const boxes = Object.values(payloads)
      .map(payload => payload.geojson && payload.meta && payload.meta.bbox)
      .filter(box => Array.isArray(box) && box.length === 4);
    if (boxes.length > 0) {
      const [west, south, east, north] = boxes.reduce((acc, box) => [
        Math.min(acc[0], box[0]), Math.min(acc[1], box[1]),
        Math.max(acc[2], box[2]), Math.max(acc[3], box[3])
      ], [Infinity, Infinity, -Infinity, -Infinity]);
      map.fitBounds([[west, south], [east, north]], { padding: 60, duration: 0, maxZoom: 16 });
    }
    fittedRef.current = workspace.id;
  }, [mapReady, workspace, payloads]);

  // ---------------------------------------------------------------------------
  // Workspace actions
  // ---------------------------------------------------------------------------
  const createWorkspace = async () => {
    const name = newName.trim() || 'GIS workspace';
    setBusy('Creating workspace…');
    setError('');
    try {
      const center = mapRef.current ? mapRef.current.getCenter() : { lng: DEFAULT_CENTER[0], lat: DEFAULT_CENTER[1] };
      const zoom = mapRef.current ? mapRef.current.getZoom() : 11;
      const response = await axios.post(`${API_URL}/api/gis/workspaces/${projectId}`, {
        name,
        workingCrs: 'EPSG:4326',
        viewState: { center: [center.lng, center.lat], zoom }
      }, { headers: authHeaders });
      setNewName('');
      await refreshWorkspaceList();
      setWorkspaceId(String(response.data.id));
      setNotice(`Workspace “${response.data.name}” created.`);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusy('');
    }
  };

  const deleteWorkspace = async () => {
    if (!workspaceId) return;
    if (!window.confirm('Delete this GIS workspace and its layer stack? Datasets and DEMs are kept.')) return;
    setBusy('Deleting workspace…');
    try {
      await axios.delete(`${API_URL}/api/gis/workspaces/${projectId}/${workspaceId}`, { headers: authHeaders });
      setWorkspaceId('');
      setWorkspace(null);
      await refreshWorkspaceList();
      setNotice('Workspace deleted.');
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusy('');
    }
  };

  const saveView = async () => {
    if (!workspace || !mapRef.current) return;
    setSavingView(true);
    setError('');
    try {
      const map = mapRef.current;
      const center = map.getCenter();
      const response = await axios.put(`${API_URL}/api/gis/workspaces/${projectId}/${workspace.id}`, {
        viewState: {
          center: [center.lng, center.lat],
          zoom: map.getZoom(),
          bearing: map.getBearing(),
          pitch: map.getPitch()
        }
      }, { headers: authHeaders });
      setWorkspace(response.data);
      await refreshWorkspaceList();
      setNotice('View saved to this workspace.');
      setTimeout(() => setNotice(''), 2500);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setSavingView(false);
    }
  };

  const openPrintLayout = async () => {
    const map = mapRef.current;
    if (!map || !workspace) {
      setError('Choose a workspace before opening the print layout.');
      return;
    }
    setError('');
    try {
      map.triggerRepaint();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const canvas = map.getCanvas();
      const image = canvas.toDataURL('image/png');
      if (!image || image.length < 1000) throw new Error('The map image could not be captured.');
      const centre = map.getCenter();
      const metresPerPixel = 156543.03392 * Math.cos(centre.lat * Math.PI / 180) / Math.pow(2, map.getZoom());
      const widthMetres = metresPerPixel * canvas.width;
      const distance = niceDistance(widthMetres * 0.24);
      const legend = [...workspace.layers]
        .filter(item => item.visible)
        .sort((a, b) => b.zIndex - a.zIndex)
        .flatMap(item => {
          if (item.kind === 'survey') {
            return [
              { label: `${item.name} — benchmark`, color: '#c92a2a', round: true },
              { label: `${item.name} — control`, color: item.style?.color || '#0b7285', round: true }
            ];
          }
          if (item.kind === 'terrain') return [{ label: item.name, gradient: true }];
          return [{ label: item.name, color: item.style?.color || '#d9480f' }];
        })
        .filter((item, index, all) => all.findIndex(other =>
          other.label === item.label && other.color === item.color && other.gradient === item.gradient
        ) === index);
      setPrintSnapshot({
        image,
        width: canvas.width,
        height: canvas.height,
        bearing: map.getBearing(),
        workspaceName: workspace.name,
        crs: workspace.workingCrs,
        scale: { label: formatDistance(distance), percent: (distance / widthMetres) * 100 },
        legend
      });
      setPrintSettings(current => ({
        ...current,
        title: workspace.name,
        subtitle: `${project ? `${project.name} · ` : ''}${workspace.workingCrs}`
      }));
    } catch (err) {
      setError(`Could not prepare the print layout: ${err.message}`);
    }
  };

  const addLayer = async (body) => {
    if (!workspaceId) return;
    setBusy('Adding layer…');
    setError('');
    try {
      await axios.post(`${API_URL}/api/gis/workspaces/${projectId}/${workspaceId}/layers`, body, { headers: authHeaders });
      const refreshed = await refreshWorkspace();
      await refreshWorkspaceList();
      if (refreshed && mapRef.current) {
        fittedRef.current = null;
      }
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusy('');
    }
  };

  const patchLayer = async (layer, patch) => {
    setWorkspace(current => current && ({
      ...current,
      layers: current.layers.map(item => item.id === layer.id ? { ...item, ...patch } : item)
    }));
    try {
      await axios.put(`${API_URL}/api/gis/workspaces/${projectId}/${workspaceId}/layers/${layer.id}`, patch, { headers: authHeaders });
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const setLayerStyle = (layer, patch) => {
    const base = styleDraftRef.current[layer.id] || layer.style || {};
    const style = { ...base, ...patch };
    styleDraftRef.current[layer.id] = style;
    setWorkspace(current => current && ({
      ...current,
      layers: current.layers.map(item => item.id === layer.id ? { ...item, style } : item)
    }));
    clearTimeout(styleTimers.current[layer.id]);
    styleTimers.current[layer.id] = setTimeout(() => {
      axios.put(`${API_URL}/api/gis/workspaces/${projectId}/${workspaceId}/layers/${layer.id}`, { style }, { headers: authHeaders })
        .then(() => { delete styleDraftRef.current[layer.id]; })
        .catch(err => setError(err.response?.data?.error || err.message));
    }, 350);
  };

  const resetLayerStyle = layer => {
    styleDraftRef.current[layer.id] = {};
    setWorkspace(current => current && ({
      ...current,
      layers: current.layers.map(item => item.id === layer.id ? { ...item, style: {} } : item)
    }));
    clearTimeout(styleTimers.current[layer.id]);
    axios.put(`${API_URL}/api/gis/workspaces/${projectId}/${workspaceId}/layers/${layer.id}`, { style: {} }, { headers: authHeaders })
      .then(() => { delete styleDraftRef.current[layer.id]; })
      .catch(err => setError(err.response?.data?.error || err.message));
  };

  const setLayerOpacity = (layer, opacity) => {
    setWorkspace(current => current && ({
      ...current,
      layers: current.layers.map(item => item.id === layer.id ? { ...item, opacity } : item)
    }));
    clearTimeout(opacityTimers.current[layer.id]);
    opacityTimers.current[layer.id] = setTimeout(() => {
      axios.put(`${API_URL}/api/gis/workspaces/${projectId}/${workspaceId}/layers/${layer.id}`, { opacity }, { headers: authHeaders })
        .catch(err => setError(err.response?.data?.error || err.message));
    }, 400);
  };

  const removeLayer = async layer => {
    setBusy('Removing layer…');
    try {
      await axios.delete(`${API_URL}/api/gis/workspaces/${projectId}/${workspaceId}/layers/${layer.id}`, { headers: authHeaders });
      await refreshWorkspace();
      await refreshWorkspaceList();
      setSelected(null);
      if (String(tableLayerId) === String(layer.id)) setTableLayerId('');
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusy('');
    }
  };

  const zoomToLayer = layer => {
    const payload = payloads[layer.id];
    if (!payload || !mapRef.current) return;
    const bounds = payload.geojson ? payload.meta?.bbox : payload.boundsWgs84;
    if (Array.isArray(bounds) && bounds.length === 4) {
      mapRef.current.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], { padding: 70, maxZoom: 17 });
    }
  };

  // ---------------------------------------------------------------------------
  // CRS, import, export and attribute table actions
  // ---------------------------------------------------------------------------
  const changeWorkingCrs = async code => {
    if (!workspace) return;
    const previous = workspace.workingCrs;
    setWorkspace({ ...workspace, workingCrs: code });
    try {
      const response = await axios.put(`${API_URL}/api/gis/workspaces/${projectId}/${workspace.id}`, { workingCrs: code }, { headers: authHeaders });
      setWorkspace(response.data);
      setNotice(`Working CRS changed to ${code}. Coordinates are unchanged; this only changes the readout.`);
      setTimeout(() => setNotice(''), 3000);
    } catch (err) {
      setWorkspace(current => current && ({ ...current, workingCrs: previous }));
      setError(err.response?.data?.error || err.message);
    }
  };

  const refreshDatasets = async () => {
    const response = await axios.get(`${API_URL}/api/gis/datasets/${projectId}`, { headers: authHeaders });
    setDatasets(response.data);
    return response.data;
  };

  const importDataset = async () => {
    if (!importFile) {
      setError('Choose a GeoJSON or CSV file to import.');
      return;
    }
    setImporting(true);
    setError('');
    setNotice('');
    try {
      const form = new FormData();
      form.append('file', importFile);
      form.append('crs', importCrs);
      if (importName.trim()) form.append('name', importName.trim());
      const response = await axios.post(`${API_URL}/api/gis/datasets/${projectId}/import`, form, { headers: authHeaders });
      const imported = response.data;
      await refreshDatasets();
      setDataVersion(version => version + 1);
      if (workspaceId) {
        await addLayer({ kind: 'dataset', datasetId: imported.id, name: imported.name });
      }
      setNotice(`Imported “${imported.name}” (${imported.featureCount} features, stored as ${imported.crs}).`);
      setImportFile(null);
      setImportName('');
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setImporting(false);
    }
  };

  const exportDataset = async (dataset, format) => {
    if (!dataset) return;
    setError('');
    try {
      const response = await axios.get(`${API_URL}/api/gis/datasets/${projectId}/${dataset.id}/export?format=${format}`, {
        headers: authHeaders,
        responseType: 'blob'
      });
      const objectUrl = URL.createObjectURL(response.data);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = `${fileSlug(dataset.name)}.${format === 'csv' ? 'csv' : 'geojson'}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);
      setNotice(`Exported “${dataset.name}” as ${format.toUpperCase()} in ${dataset.crs}.`);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const reprojectDataset = async dataset => {
    if (!dataset) return;
    if (!window.confirm(`Reproject “${dataset.name}” from ${dataset.crs} to ${reprojectCrs}? Coordinates are converted in place; attributes and the layer stay.`)) return;
    setReprojecting(true);
    setError('');
    try {
      const response = await axios.post(`${API_URL}/api/gis/datasets/${projectId}/${dataset.id}/reproject`, {
        targetCrs: reprojectCrs
      }, { headers: authHeaders });
      await refreshDatasets();
      setDataVersion(version => version + 1);
      setNotice(`Reprojected “${response.data.name}” from ${response.data.previousCrs} to ${response.data.crs}.`);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setReprojecting(false);
    }
  };

  const openTable = layer => {
    setTableLayerId(layer.id);
    setTableFilter('');
    setTableSort({ key: null, direction: 'asc' });
  };

  const focusTableRow = (layer, row) => {
    const center = geometryCenter(row.geometry);
    if (center && mapRef.current) {
      mapRef.current.flyTo({ center, zoom: Math.max(mapRef.current.getZoom(), 15) });
    }
    setSelected({
      layerId: `gislayer-${layer.id}`,
      properties: row.properties,
      geometryType: row.geometry && row.geometry.type
    });
  };

  const runAnalysis = async () => {
    if (!analysis.inputId) {
      setError('Choose an input dataset for the analysis.');
      return;
    }
    if (['clip', 'intersect'].includes(analysis.operation) && !analysis.overlayId) {
      setError(`${analysis.operation} needs an overlay dataset.`);
      return;
    }
    setAnalysing(true);
    setError('');
    setNotice('');
    try {
      const body = {
        operation: analysis.operation,
        inputDatasetId: Number(analysis.inputId),
        crs: analysis.crs
      };
      if (analysis.operation === 'buffer') body.distance = Number(analysis.distance);
      if (['clip', 'intersect'].includes(analysis.operation)) body.overlayDatasetId = Number(analysis.overlayId);
      if (analysis.operation === 'dissolve' && analysis.dissolveBy.trim()) body.dissolveBy = analysis.dissolveBy.trim();
      if (analysis.name.trim()) body.name = analysis.name.trim();

      const response = await axios.post(`${API_URL}/api/gis/analysis/${projectId}`, body, { headers: authHeaders });
      setAnalysisResult(response.data);
      await refreshDatasets();
      setDataVersion(version => version + 1);
      if (workspaceId) {
        await addLayer({ kind: 'dataset', datasetId: response.data.dataset.id, name: response.data.dataset.name });
      }
      const metrics = response.data.metrics;
      setNotice(
        `${analysis.operation} finished: ${response.data.outputFeatureCount} feature(s), computed in ${response.data.computationCrs}`
        + `${metrics ? `, area ${metrics.areaM2.toLocaleString()} m²` : ''}. Saved as “${response.data.dataset.name}”.`
      );
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setAnalysing(false);
    }
  };

  const project = projects.find(item => String(item.id) === String(projectId));
  const gridStyle = narrow
    ? { ...styles.grid, gridTemplateColumns: 'minmax(0, 1fr)' }
    : styles.grid;
  const readyTerrains = terrains.filter(item => item.status === 'ready');
  const layers = workspace?.layers || [];

  const workingCrs = workspace?.workingCrs || 'EPSG:4326';
  const workingCrsDef = crsList.find(item => item.code === workingCrs);
  const cursorText = formatCursor(cursor, workingCrs, crsList);
  const tableLayer = layers.find(layer => String(layer.id) === String(tableLayerId));
  const tableDataset = tableLayer && tableLayer.kind === 'dataset'
    ? datasets.find(dataset => String(dataset.id) === String(tableLayer.datasetId))
    : null;

  const table = useMemo(() => {
    const payload = tableLayerId ? payloads[tableLayerId] : null;
    const features = payload && payload.geojson ? payload.geojson.features || [] : [];
    const columns = [];
    features.forEach(feature => {
      Object.keys(feature.properties || {}).forEach(key => {
        if (!columns.includes(key)) columns.push(key);
      });
    });
    let rows = features.map((feature, index) => ({
      index,
      geometry: feature.geometry,
      properties: feature.properties || {}
    }));
    const query = tableFilter.trim().toLowerCase();
    if (query) {
      rows = rows.filter(row => Object.values(row.properties).some(value => String(value).toLowerCase().includes(query)));
    }
    if (tableSort.key) {
      rows = [...rows].sort((left, right) => {
        const a = left.properties[tableSort.key];
        const b = right.properties[tableSort.key];
        const aNumber = Number(a);
        const bNumber = Number(b);
        let result;
        if (a !== '' && b !== '' && Number.isFinite(aNumber) && Number.isFinite(bNumber)) {
          result = aNumber - bNumber;
        } else {
          result = String(a ?? '').localeCompare(String(b ?? ''));
        }
        return tableSort.direction === 'asc' ? result : -result;
      });
    }
    return { columns, rows, total: features.length };
  }, [tableLayerId, payloads, tableFilter, tableSort]);

  const toggleTableSort = key => {
    setTableSort(current => current.key === key
      ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
      : { key, direction: 'asc' });
  };

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <div>
          <h2 style={{ margin: '0 0 4px' }}>🗺️ GIS Workspace</h2>
          <p style={{ ...styles.helper, margin: 0 }}>
            An independent geospatial workspace: saved views, an ordered layer stack and project datasets.
            Basemap is a local OpenStreetMap extract; contextual data is never a survey measurement.
          </p>
        </div>
        <div style={{ marginLeft: 'auto' }}>
          <label style={{ ...styles.helper, display: 'block' }}>SiteTrackerPro project</label>
          <select value={projectId} onChange={event => setProjectId(event.target.value)} style={styles.input}>
            <option value="">-- Select Project --</option>
            {projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </div>
      </div>

      {error && <div style={styles.error}>⚠️ {error}</div>}
      {notice && <div style={styles.notice}>{notice}</div>}
      {busy && <div style={styles.notice}>{busy}</div>}
      {basemapError && (
        <div style={styles.error}>
          ⚠️ No local basemap extract at <code>/basemaps/addis-osm.json</code>. Run
          {' '}<code>node scripts/build-basemap.js</code> (or the PBF variant) and restart the backend.
          Project layers still work on a plain background.
        </div>
      )}

      <div style={gridStyle}>
        <div>
          <div style={styles.card}>
            <h3 style={{ marginTop: 0 }}>Workspaces</h3>
            {!projectId ? (
              <p style={styles.helper}>Select a project to open its GIS workspaces.</p>
            ) : (
              <>
                {workspaces.length > 0 && (
                  <select
                    value={workspaceId}
                    onChange={event => setWorkspaceId(event.target.value)}
                    style={{ ...styles.input, width: '100%', marginBottom: '8px' }}
                  >
                    <option value="">-- Select workspace --</option>
                    {workspaces.map(item => (
                      <option key={item.id} value={item.id}>{item.name} ({item.layerCount ?? 0} layers)</option>
                    ))}
                  </select>
                )}

                {workspace ? (
                  <div>
                    <p style={{ ...styles.helper, marginTop: 0 }}>
                      <strong>{workspace.name}</strong><br />
                      {workspace.workingCrs}{workspace.verticalDatum ? ` · ${workspace.verticalDatum}` : ' · no vertical datum'} ·
                      {' '}{layers.length} layer{layers.length === 1 ? '' : 's'}
                    </p>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                      <button onClick={saveView} disabled={savingView} style={styles.button}>
                        {savingView ? 'Saving…' : 'Save view'}
                      </button>
                      <button id="gis-print-open" onClick={openPrintLayout} style={styles.buttonSmall}>Print layout</button>
                      <button onClick={deleteWorkspace} style={styles.buttonSmall}>Delete workspace</button>
                    </div>
                  </div>
                ) : (
                  <p style={styles.helper}>
                    {workspaces.length === 0 ? 'No GIS workspace yet.' : 'Choose a workspace above.'}
                  </p>
                )}

                <div style={{ borderTop: '1px solid #eee', marginTop: '10px', paddingTop: '10px' }}>
                  <label style={styles.helper}>New workspace</label>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <input
                      value={newName}
                      onChange={event => setNewName(event.target.value)}
                      placeholder={project ? `${project.name} GIS` : 'Workspace name'}
                      style={{ ...styles.input, flex: 1 }}
                    />
                    <button onClick={createWorkspace} style={styles.button}>Create</button>
                  </div>
                </div>
              </>
            )}
          </div>

          {projectId && (
            <div style={{ display: 'flex', gap: '6px', marginTop: '12px', flexWrap: 'wrap' }} role="tablist" aria-label="GIS tools">
              {[['workspace', 'Map workspace'], ['osm', 'OSM Explorer'], ['survey', 'Survey GIS']].map(([key, label]) => (
                <button
                  key={key}
                  id={`gis-tab-${key}`}
                  role="tab"
                  aria-selected={view === key}
                  onClick={() => setView(key)}
                  style={{
                    padding: '6px 10px', borderRadius: '5px', cursor: 'pointer', fontSize: '12px',
                    border: view === key ? '1px solid #d9480f' : '1px solid #dfe6ec',
                    background: view === key ? '#fff4ec' : '#fff',
                    color: view === key ? '#8a2b12' : '#26313c',
                    fontWeight: view === key ? 600 : 400
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          )}

          {workspace && view === 'workspace' && (
            <>
              <div style={{ ...styles.card, marginTop: '12px' }}>
                <h3 style={{ marginTop: 0 }}>Coordinate system</h3>
                <p style={{ ...styles.helper, marginTop: 0 }}>
                  Map canvas: <strong>EPSG:3857</strong> (Web Mercator). Layers are requested in
                  {' '}<strong>EPSG:4326</strong> and transformed from each dataset's stored CRS on read.
                </p>
                <label style={styles.helper}>Working CRS (cursor readout)</label>
                <select
                  id="gis-working-crs"
                  value={workingCrs}
                  onChange={event => changeWorkingCrs(event.target.value)}
                  style={{ ...styles.input, width: '100%' }}
                >
                  {crsList.map(item => (
                    <option key={item.code} value={item.code}>{item.code} — {item.name}</option>
                  ))}
                </select>
                <div style={{ background: '#f7f9fb', border: '1px solid #e3e9ef', borderRadius: '6px', padding: '8px', marginTop: '8px', fontFamily: 'Consolas, monospace', fontSize: '12px' }}>
                  {cursor ? (
                    <>
                      <div>WGS 84: {cursor.lat.toFixed(6)}, {cursor.lng.toFixed(6)}</div>
                      {workingCrs !== 'EPSG:4326' && (
                        <div>{workingCrs}: {cursorText || '—'}</div>
                      )}
                      <button
                        style={{ ...styles.buttonSmall, marginTop: '6px' }}
                        onClick={() => navigator.clipboard && navigator.clipboard.writeText(
                          workingCrs === 'EPSG:4326' || !cursorText
                            ? `${cursor.lat.toFixed(6)}, ${cursor.lng.toFixed(6)}`
                            : cursorText
                        )}
                      >
                        Copy coordinates
                      </button>
                    </>
                  ) : (
                    <span style={{ fontFamily: 'Calibri' }}>Move the pointer over the map to read coordinates.</span>
                  )}
                </div>
                <div style={{ borderTop: '1px solid #eee', marginTop: '10px', paddingTop: '10px' }}>
                  <label style={styles.helper}>Reproject a dataset (in place)</label>
                  {datasets.length === 0 ? (
                    <p style={styles.helper}>No datasets to reproject.</p>
                  ) : (
                    <>
                      <select
                        id="gis-reproject-dataset"
                        value={reprojectDatasetId}
                        onChange={event => setReprojectDatasetId(event.target.value)}
                        style={{ ...styles.input, width: '100%', marginBottom: '6px' }}
                      >
                        <option value="">-- Dataset --</option>
                        {datasets.map(dataset => (
                          <option key={dataset.id} value={dataset.id}>{dataset.name} ({dataset.crs})</option>
                        ))}
                      </select>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <select
                          id="gis-reproject-target"
                          value={reprojectCrs}
                          onChange={event => setReprojectCrs(event.target.value)}
                          style={{ ...styles.input, flex: 1 }}
                        >
                          {crsList.filter(item => item.code !== 'EPSG:3857').map(item => (
                            <option key={item.code} value={item.code}>{item.code} — {item.name}</option>
                          ))}
                        </select>
                        <button
                          style={styles.button}
                          disabled={reprojecting || !reprojectDatasetId}
                          onClick={() => reprojectDataset(datasets.find(item => String(item.id) === String(reprojectDatasetId)))}
                        >
                          {reprojecting ? 'Working…' : 'Reproject'}
                        </button>
                      </div>
                    </>
                  )}
                  <p style={{ ...styles.helper, fontSize: '11px' }}>
                    {workingCrsDef ? `${workingCrsDef.units}; ${workingCrsDef.axis}.` : ''} proj4js converts x/y only:
                    no datum grid shift, no vertical datum.
                  </p>
                </div>
              </div>

              <div style={{ ...styles.card, marginTop: '12px' }}>
                <h3 style={{ marginTop: 0 }}>Layers</h3>
                {layers.length === 0 && <p style={styles.helper}>No layers yet. Add a dataset, DEM hillshade or the survey points below.</p>}
                {[...layers].sort((a, b) => b.zIndex - a.zIndex).map(layer => (
                  <div key={layer.id} style={styles.layerRow}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <input
                        type="checkbox"
                        checked={layer.visible}
                        onChange={event => patchLayer(layer, { visible: event.target.checked })}
                        title="Show or hide this layer"
                      />
                      <span style={{ flex: 1, fontSize: '13px' }}>{layer.name}</span>
                      <span style={styles.badge}>{layer.kind}</span>
                    </div>
                    {payloads[layer.id]?.error && (
                      <p style={{ ...styles.helper, color: '#8a2b12' }}>⚠️ {payloads[layer.id].error}</p>
                    )}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '5px' }}>
                      <input
                        type="range" min="0" max="1" step="0.1" value={layer.opacity}
                        onChange={event => setLayerOpacity(layer, Number(event.target.value))}
                        style={{ flex: 1 }}
                        title="Layer opacity"
                      />
                      <button onClick={() => zoomToLayer(layer)} style={styles.buttonSmall}>Zoom</button>
                      {layer.kind !== 'terrain' && (
                        <button
                          id={`layer-style-toggle-${layer.id}`}
                          onClick={() => setStyleLayerId(styleLayerId === String(layer.id) ? '' : String(layer.id))}
                          style={{ ...styles.buttonSmall, background: styleLayerId === String(layer.id) ? '#fff4ec' : 'white' }}
                        >
                          Style
                        </button>
                      )}
                      <button onClick={() => removeLayer(layer)} style={styles.buttonSmall}>×</button>
                    </div>
                    {styleLayerId === String(layer.id) && layer.kind !== 'terrain' && (
                      <div
                        id={`layer-style-panel-${layer.id}`}
                        style={{ background: '#f7f9fb', border: '1px solid #e3e9ef', borderRadius: '6px', padding: '8px', marginTop: '6px' }}
                      >
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 10px' }}>
                          <label style={{ fontSize: '11px', color: '#425466' }}>
                            Colour
                            <div style={{ display: 'flex', gap: '5px', alignItems: 'center', marginTop: '3px' }}>
                              <input
                                id={`layer-color-${layer.id}`}
                                type="color"
                                value={/^#[0-9a-f]{6}$/i.test(layer.style?.color || '') ? layer.style.color : (layer.kind === 'survey' ? '#0b7285' : '#d9480f')}
                                onChange={event => setLayerStyle(layer, { color: event.target.value })}
                                style={{ width: '42px', height: '26px', padding: 0, border: '1px solid #ccd6df', borderRadius: '3px' }}
                              />
                              <code style={{ fontSize: '10px' }}>{layer.style?.color || 'default'}</code>
                            </div>
                          </label>
                          <label style={{ fontSize: '11px', color: '#425466' }}>
                            Line width · {Number(layer.style?.lineWidth ?? 2)}px
                            <input
                              id={`layer-linewidth-${layer.id}`}
                              type="range" min="0.5" max="10" step="0.5"
                              value={Number(layer.style?.lineWidth ?? 2)}
                              onChange={event => setLayerStyle(layer, { lineWidth: Number(event.target.value) })}
                              style={{ display: 'block', width: '100%' }}
                            />
                          </label>
                          <label style={{ fontSize: '11px', color: '#425466' }}>
                            Fill opacity · {Math.round(Number(layer.style?.fillOpacity ?? 0.28) * 100)}%
                            <input
                              id={`layer-fill-${layer.id}`}
                              type="range" min="0" max="1" step="0.05"
                              value={Number(layer.style?.fillOpacity ?? 0.28)}
                              onChange={event => setLayerStyle(layer, { fillOpacity: Number(event.target.value) })}
                              style={{ display: 'block', width: '100%' }}
                            />
                          </label>
                          <label style={{ fontSize: '11px', color: '#425466' }}>
                            Point size · {Number(layer.style?.pointSize ?? 5)}px
                            <input
                              id={`layer-pointsize-${layer.id}`}
                              type="range" min="2" max="20" step="1"
                              value={Number(layer.style?.pointSize ?? 5)}
                              onChange={event => setLayerStyle(layer, { pointSize: Number(event.target.value) })}
                              style={{ display: 'block', width: '100%' }}
                            />
                          </label>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'center', marginTop: '7px' }}>
                          <span style={{ fontSize: '10px', color: '#5b6773' }}>
                            {layer.kind === 'survey' ? 'Benchmarks stay red; colour applies to control points.' : 'Saved to the layer style.'}
                          </span>
                          <button id={`layer-reset-${layer.id}`} onClick={() => resetLayerStyle(layer)} style={styles.buttonSmall}>Reset</button>
                        </div>
                      </div>
                    )}
                    {(layer.kind === 'dataset' || layer.kind === 'survey') && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '5px', flexWrap: 'wrap' }}>
                        <button onClick={() => openTable(layer)} style={styles.buttonSmall}>Attribute table</button>
                        {layer.kind === 'dataset' && (
                          <>
                            <button
                              onClick={() => exportDataset(datasets.find(item => String(item.id) === String(layer.datasetId)), 'geojson')}
                              style={styles.buttonSmall}
                            >
                              GeoJSON
                            </button>
                            <button
                              onClick={() => exportDataset(datasets.find(item => String(item.id) === String(layer.datasetId)), 'csv')}
                              style={styles.buttonSmall}
                            >
                              CSV
                            </button>
                            <span style={{ fontSize: '11px', color: '#5b6773' }}>
                              stored {payloads[layer.id]?.meta?.crs || '—'}
                            </span>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <div style={{ ...styles.card, marginTop: '12px' }}>
                <h3 style={{ marginTop: 0 }}>Add layer</h3>

                <label style={styles.helper}>Project datasets</label>
                {datasets.length === 0 ? (
                  <p style={styles.helper}>No saved GIS datasets for this project yet.</p>
                ) : (
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <select
                      id="gis-dataset-choice"
                      style={{ ...styles.input, flex: 1 }}
                      defaultValue={datasets[0]?.id}
                    >
                      {datasets.map(dataset => (
                        <option key={dataset.id} value={dataset.id}>
                          {dataset.name} · {dataset.featureCount} features · {dataset.crs}
                        </option>
                      ))}
                    </select>
                    <button
                      style={styles.button}
                      onClick={() => {
                        const select = document.getElementById('gis-dataset-choice');
                        const dataset = datasets.find(item => String(item.id) === String(select?.value));
                        if (dataset) addLayer({ kind: 'dataset', datasetId: dataset.id, name: dataset.name });
                      }}
                    >
                      Add
                    </button>
                  </div>
                )}

                <div style={{ borderTop: '1px solid #eee', marginTop: '12px', paddingTop: '10px' }}>
                  <label style={styles.helper}>Import dataset (GeoJSON or CSV)</label>
                  <input
                    id="gis-import-file"
                    ref={fileInputRef}
                    type="file"
                    accept=".geojson,.json,.csv,application/json,text/csv"
                    onChange={event => setImportFile(event.target.files && event.target.files[0] ? event.target.files[0] : null)}
                    style={{ fontSize: '12px', marginBottom: '6px', maxWidth: '100%' }}
                  />
                  <input
                    id="gis-import-name"
                    value={importName}
                    onChange={event => setImportName(event.target.value)}
                    placeholder="Dataset name (optional)"
                    style={{ ...styles.input, width: '100%', marginBottom: '6px' }}
                  />
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <select
                      id="gis-import-crs"
                      value={importCrs}
                      onChange={event => setImportCrs(event.target.value)}
                      style={{ ...styles.input, flex: 1 }}
                    >
                      {crsList.map(item => (
                        <option key={item.code} value={item.code}>{item.code} — {item.name}</option>
                      ))}
                    </select>
                    <button onClick={importDataset} disabled={importing} style={styles.button}>
                      {importing ? 'Importing…' : 'Import'}
                    </button>
                  </div>
                  <p style={{ ...styles.helper, fontSize: '11px' }}>
                    The source CRS must be stated; nothing is inferred from the file. CSV needs
                    lon/lat or easting/northing columns. Max {3000} features, 20 MB.
                  </p>
                </div>

                <div style={{ borderTop: '1px solid #eee', marginTop: '12px', paddingTop: '10px' }}>
                  <label style={styles.helper}>Survey control points ({surveyCount})</label>
                  <button onClick={() => addLayer({ kind: 'survey', name: 'Survey control points' })} style={styles.button}>
                    Add survey points
                  </button>
                </div>

                <div style={{ borderTop: '1px solid #eee', marginTop: '12px', paddingTop: '10px' }}>
                  <label style={styles.helper}>DEM hillshade (preview-derived)</label>
                  {readyTerrains.length === 0 ? (
                    <p style={styles.helper}>No processed DEM for this project. Upload one in the 3D viewer's terrain card.</p>
                  ) : (
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <select id="gis-terrain-choice" style={{ ...styles.input, flex: 1 }} defaultValue={readyTerrains[0]?.id}>
                        {readyTerrains.map(terrain => (
                          <option key={terrain.id} value={terrain.id}>
                            {terrain.originalName} · {terrain.crs} · {terrain.preview?.width}×{terrain.preview?.height}
                          </option>
                        ))}
                      </select>
                      <button
                        style={styles.button}
                        onClick={() => {
                          const select = document.getElementById('gis-terrain-choice');
                          const terrain = readyTerrains.find(item => String(item.id) === String(select?.value));
                          if (terrain) addLayer({ kind: 'terrain', terrainId: terrain.id, name: `Hillshade — ${terrain.originalName}` });
                        }}
                      >
                        Add
                      </button>
                    </div>
                  )}
                </div>
              </div>

              <div style={{ ...styles.card, marginTop: '12px' }}>
                <h3 style={{ marginTop: 0 }}>Spatial analysis</h3>
                <p style={{ ...styles.helper, marginTop: 0 }}>
                  Geometry is computed in the chosen projected CRS, then saved as a dataset in
                  EPSG:4326 and added to the map. Geographic coordinates are never used for lengths or areas.
                </p>

                <label style={styles.helper}>Operation</label>
                <select
                  id="gis-analysis-operation"
                  value={analysis.operation}
                  onChange={event => setAnalysis(current => ({ ...current, operation: event.target.value }))}
                  style={{ ...styles.input, width: '100%', marginBottom: '6px' }}
                >
                  <option value="buffer">Buffer (metres)</option>
                  <option value="clip">Clip to mask</option>
                  <option value="intersect">Intersect</option>
                  <option value="dissolve">Dissolve polygons</option>
                  <option value="measure">Area / length</option>
                </select>

                <label style={styles.helper}>Input dataset</label>
                <select
                  id="gis-analysis-input"
                  value={analysis.inputId}
                  onChange={event => setAnalysis(current => ({ ...current, inputId: event.target.value }))}
                  style={{ ...styles.input, width: '100%', marginBottom: '6px' }}
                >
                  <option value="">-- Dataset --</option>
                  {datasets.map(dataset => (
                    <option key={dataset.id} value={dataset.id}>{dataset.name} ({dataset.crs})</option>
                  ))}
                </select>

                {['clip', 'intersect'].includes(analysis.operation) && (
                  <>
                    <label style={styles.helper}>{analysis.operation === 'clip' ? 'Clip mask (polygons)' : 'Overlay dataset (polygons)'}</label>
                    <select
                      id="gis-analysis-overlay"
                      value={analysis.overlayId}
                      onChange={event => setAnalysis(current => ({ ...current, overlayId: event.target.value }))}
                      style={{ ...styles.input, width: '100%', marginBottom: '6px' }}
                    >
                      <option value="">-- Dataset --</option>
                      {datasets.map(dataset => (
                        <option key={dataset.id} value={dataset.id}>{dataset.name} ({dataset.crs})</option>
                      ))}
                    </select>
                  </>
                )}

                {analysis.operation === 'buffer' && (
                  <>
                    <label style={styles.helper}>Buffer distance (metres)</label>
                    <input
                      id="gis-analysis-distance"
                      type="number"
                      min="0.1"
                      max="50000"
                      step="1"
                      value={analysis.distance}
                      onChange={event => setAnalysis(current => ({ ...current, distance: event.target.value }))}
                      style={{ ...styles.input, width: '100%', marginBottom: '6px' }}
                    />
                  </>
                )}

                {analysis.operation === 'dissolve' && (
                  <>
                    <label style={styles.helper}>Dissolve by attribute (optional)</label>
                    <input
                      id="gis-analysis-dissolve-by"
                      value={analysis.dissolveBy}
                      onChange={event => setAnalysis(current => ({ ...current, dissolveBy: event.target.value }))}
                      placeholder="e.g. kind; leaves empty to dissolve all"
                      style={{ ...styles.input, width: '100%', marginBottom: '6px' }}
                    />
                  </>
                )}

                <label style={styles.helper}>Computation CRS (projected, metres)</label>
                <select
                  id="gis-analysis-crs"
                  value={analysis.crs}
                  onChange={event => setAnalysis(current => ({ ...current, crs: event.target.value }))}
                  style={{ ...styles.input, width: '100%', marginBottom: '6px' }}
                >
                  {crsList.filter(item => item.units === 'metres' && item.code !== 'EPSG:3857').map(item => (
                    <option key={item.code} value={item.code}>{item.code} — {item.name}</option>
                  ))}
                </select>

                <input
                  id="gis-analysis-name"
                  value={analysis.name}
                  onChange={event => setAnalysis(current => ({ ...current, name: event.target.value }))}
                  placeholder="Result name (optional)"
                  style={{ ...styles.input, width: '100%', marginBottom: '6px' }}
                />

                <button id="gis-analysis-run" onClick={runAnalysis} disabled={analysing} style={styles.button}>
                  {analysing ? 'Computing…' : 'Run analysis'}
                </button>

                {analysisResult && (
                  <div style={{ marginTop: '10px', background: '#f7f9fb', border: '1px solid #e3e9ef', borderRadius: '6px', padding: '9px', fontSize: '12px' }}>
                    <strong>{analysisResult.operation}</strong> completed in {analysisResult.computationCrs}
                    <div>{analysisResult.outputFeatureCount} feature(s) · saved as {analysisResult.dataset.name} ({analysisResult.dataset.crs})</div>
                    {analysisResult.metrics && (
                      <>
                        <div style={{ marginTop: '5px' }}>
                          Area: <strong>{analysisResult.metrics.areaM2.toLocaleString()} m²</strong>
                          {' '}({(analysisResult.metrics.areaM2 / 10000).toLocaleString(undefined, { maximumFractionDigits: 4 })} ha)
                        </div>
                        <div>Perimeter: {analysisResult.metrics.perimeterM.toLocaleString()} m</div>
                        <div>Length: {analysisResult.metrics.lengthM.toLocaleString()} m</div>
                        {analysisResult.metrics.features.length > 0 && (
                          <table style={{ width: '100%', marginTop: '6px', borderCollapse: 'collapse' }}>
                            <thead>
                              <tr style={{ color: '#5b6773' }}>
                                <th style={{ textAlign: 'left', padding: '2px' }}>Feature</th>
                                <th style={{ textAlign: 'right', padding: '2px' }}>Area m²</th>
                                <th style={{ textAlign: 'right', padding: '2px' }}>Length m</th>
                              </tr>
                            </thead>
                            <tbody>
                              {analysisResult.metrics.features.slice(0, 5).map(feature => (
                                <tr key={feature.index}>
                                  <td style={{ padding: '2px' }}>{feature.properties.name || `#${feature.index}`}</td>
                                  <td style={{ padding: '2px', textAlign: 'right' }}>{feature.areaM2.toLocaleString()}</td>
                                  <td style={{ padding: '2px', textAlign: 'right' }}>{feature.lengthM.toLocaleString()}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            </>
          )}

          {view === 'osm' && (
            <OsmExplorer
              projectId={projectId}
              authHeaders={authHeaders}
              onPreview={setOsmPreview}
              onSavedDataset={async dataset => {
                await refreshDatasets();
                if (workspaceId) await addLayer({ kind: 'dataset', datasetId: dataset.id, name: dataset.name });
              }}
              onNotice={setNotice}
              onError={setError}
              getBbox={() => {
                const bounds = mapRef.current && mapRef.current.getBounds();
                return bounds ? [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()] : null;
              }}
            />
          )}

          {view === 'survey' && (
            <SurveyGis
              projectId={projectId}
              authHeaders={authHeaders}
              crsList={crsList}
              terrains={terrains}
              survey={survey}
              onSurveyChanged={refreshSurvey}
              onAddSurveyLayer={() => {
                if (!workspaceId) { setError('Choose or create a workspace before adding survey points to the map.'); return; }
                addLayer({ kind: 'survey', name: 'Survey control points' });
              }}
              onNotice={setNotice}
              onError={setError}
            />
          )}
        </div>

        <div>
          <div style={{ position: 'relative' }}>
            <div ref={mapContainer} style={{ ...styles.map, height: narrow ? '480px' : '660px' }} />
          {selected && (
            <div style={styles.inspector}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px' }}>
                <strong>Feature</strong>
                <button onClick={() => setSelected(null)} style={{ border: 'none', background: 'none', cursor: 'pointer' }}>×</button>
              </div>
              <p style={{ ...styles.helper, margin: '4px 0' }}>{selected.geometryType}</p>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <tbody>
                  {Object.entries(selected.properties).filter(([, value]) => value !== null && value !== '').slice(0, 12).map(([key, value]) => (
                    <tr key={key}>
                      <td style={{ padding: '2px 4px', color: '#5b6773', verticalAlign: 'top' }}>{key}</td>
                      <td style={{ padding: '2px 4px' }}>{String(value).slice(0, 120)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          </div>

          {tableLayer && (
            <div style={{ ...styles.card, marginTop: '12px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                <h3 style={{ margin: 0 }}>Attribute table — {tableLayer.name}</h3>
                <button onClick={() => setTableLayerId('')} style={styles.buttonSmall}>Close</button>
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', margin: '8px 0' }}>
                <input
                  id="gis-table-filter"
                  value={tableFilter}
                  onChange={event => setTableFilter(event.target.value)}
                  placeholder="Filter rows…"
                  style={{ ...styles.input, flex: 1, minWidth: '160px' }}
                />
                <span style={{ ...styles.helper, margin: 0 }}>
                  {table.rows.length} of {table.total} features
                </span>
                {tableDataset && (
                  <>
                    <button onClick={() => exportDataset(tableDataset, 'geojson')} style={styles.buttonSmall}>Export GeoJSON</button>
                    <button onClick={() => exportDataset(tableDataset, 'csv')} style={styles.buttonSmall}>Export CSV</button>
                  </>
                )}
              </div>
              <div style={{ maxHeight: '300px', overflow: 'auto', border: '1px solid #e3e9ef', borderRadius: '6px' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                  <thead>
                    <tr>
                      <th style={{ position: 'sticky', top: 0, background: '#f3f6f9', textAlign: 'left', padding: '6px', borderBottom: '1px solid #dfe6ec' }}>#</th>
                      {table.columns.map(column => (
                        <th
                          key={column}
                          onClick={() => toggleTableSort(column)}
                          style={{ position: 'sticky', top: 0, background: '#f3f6f9', textAlign: 'left', padding: '6px', borderBottom: '1px solid #dfe6ec', cursor: 'pointer', whiteSpace: 'nowrap' }}
                        >
                          {column}{tableSort.key === column ? (tableSort.direction === 'asc' ? ' ▲' : ' ▼') : ''}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {table.rows.map(row => (
                      <tr
                        key={row.index}
                        onClick={() => focusTableRow(tableLayer, row)}
                        style={{ cursor: 'pointer', borderBottom: '1px solid #f0f3f6' }}
                      >
                        <td style={{ padding: '5px 6px', color: '#8190a0' }}>{row.index + 1}</td>
                        {table.columns.map(column => (
                          <td key={column} style={{ padding: '5px 6px', whiteSpace: 'nowrap', maxWidth: '260px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {row.properties[column] === undefined || row.properties[column] === null ? '' : String(row.properties[column])}
                          </td>
                        ))}
                      </tr>
                    ))}
                    {table.rows.length === 0 && (
                      <tr>
                        <td colSpan={table.columns.length + 1} style={{ padding: '12px', color: '#5b6773' }}>
                          No feature matches the filter.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <p style={{ ...styles.helper, fontSize: '11px' }}>
                Click a header to sort; click a row to locate the feature on the map. Values are the
                stored attributes; geometry is displayed in EPSG:4326.
              </p>
            </div>
          )}
        </div>
      </div>

      {printSnapshot && (
        <MapPrintLayout
          snapshot={printSnapshot}
          settings={printSettings}
          setSettings={setPrintSettings}
          onClose={() => setPrintSnapshot(null)}
          project={project}
        />
      )}
    </div>
  );
}
