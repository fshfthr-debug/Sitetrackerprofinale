import React, { useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import maplibregl from 'maplibre-gl';
import proj4 from 'proj4';
import 'maplibre-gl/dist/maplibre-gl.css';
import OsmExplorer from './OsmExplorer';
import SurveyGis from './SurveyGis';
import Georeferencing from './Georeferencing';
import MapPrintLayout, { niceDistance, formatDistance } from './MapPrintLayout';
import EthiopiaCoveragePanel from './EthiopiaCoveragePanel';
import Icon from '../ui/Icon';
import { DEFAULT_CENTER, SITE_ATTRIBUTION, addPlaceLabels, basemapStyle } from './basemap';
import { DEFAULT_BASEMAP, maptilerStyleUrl } from './basemaps';
import { loadMapConfig } from './mapConfig';
import { ToolDock, ContextToolbar } from './ToolDock';
import StatusBar from './StatusBar';
import CutFillPanel from './CutFillPanel';
import ClashPanel from './ClashPanel';
import {
  consumePendingGisCommand,
  getWorkspaceSettings,
  subscribeGisCommands,
  subscribeWorkspaceSettings
} from '../shell/workspaceSettings';
import Popup from '../ui/Popup';
import ETHIOPIA_BOUNDARIES from './ethiopia-regions.json';
import {
  COVERAGE_RAMP, ETHIOPIA_EXTENT, ETHIOPIA_REGIONS,
  coverageByRegion, regionLabel, searchEthiopia
} from './ethiopia';

const API_URL = process.env.REACT_APP_API_URL || '';

// ---------------------------------------------------------------------------
// Ethiopia national layer. The ADM1 geometry is bundled with the app (64 KB,
// simplified from geoBoundaries, CC BY 4.0) rather than fetched, so the country
// draws even when the API or a tile host is slow. Bounds are precomputed here so
// "zoom to region" never has to walk the coordinates again.
// ---------------------------------------------------------------------------
function geometryBounds(geometry) {
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  const walk = (coordinates) => {
    if (typeof coordinates[0] === 'number') {
      bounds[0] = Math.min(bounds[0], coordinates[0]);
      bounds[1] = Math.min(bounds[1], coordinates[1]);
      bounds[2] = Math.max(bounds[2], coordinates[0]);
      bounds[3] = Math.max(bounds[3], coordinates[1]);
      return;
    }
    coordinates.forEach(walk);
  };
  walk(geometry.coordinates);
  return bounds;
}

const REGION_BOUNDS = {};
const REGION_CENTRES = {};
ETHIOPIA_BOUNDARIES.features.forEach(feature => {
  const name = feature.properties?.name;
  if (!name) return;
  const bounds = geometryBounds(feature.geometry);
  REGION_BOUNDS[name] = bounds;
  REGION_CENTRES[name] = [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];
});

const styles = {
  page: { padding: '0 0 24px' },
  header: { display: 'flex', flexWrap: 'wrap', gap: '14px', alignItems: 'flex-end', marginBottom: '14px' },
  card: { background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: '12px', padding: '16px', boxShadow: 'var(--shadow-xs)' },
  input: {
    padding: '8px 10px',
    border: '1px solid var(--line)',
    borderRadius: '8px',
    fontSize: '11px',
    fontFamily: 'var(--font-sans)',
    color: 'var(--ink)',
    background: 'var(--surface)',
    minWidth: '140px',
    outline: 'none'
  },
  button: {
    padding: '8px 11px',
    background: 'var(--copper)',
    color: '#fffaf3',
    border: '1px solid var(--copper)',
    borderRadius: '7px',
    cursor: 'pointer',
    fontWeight: 600,
    fontSize: '10.5px'
  },
  buttonSmall: {
    padding: '6px 9px',
    background: 'var(--surface)',
    border: '1px solid var(--line)',
    borderRadius: '7px',
    cursor: 'pointer',
    fontSize: '10px',
    color: 'var(--ink-2)'
  },
  helper: { color: 'var(--ink-3)', fontSize: '10px', lineHeight: 1.45, margin: '6px 0' },
  error: { background: 'var(--danger-soft)', border: '1px solid #ecc9c4', color: 'var(--danger)', padding: '9px 11px', borderRadius: '8px', fontSize: '10.5px', marginBottom: '10px' },
  notice: { background: 'var(--surface-2)', border: '1px solid var(--line)', color: 'var(--ink-2)', padding: '8px 11px', borderRadius: '8px', fontSize: '10.5px', marginBottom: '10px' },
  grid: { display: 'grid', gridTemplateColumns: 'minmax(320px, 370px) minmax(0, 1fr)', gap: '12px', alignItems: 'start' },
  map: { height: '660px', borderRadius: '0', overflow: 'hidden', border: '0', background: '#eef2f7' },
  layerRow: { borderTop: '1px solid var(--line)', padding: '8px 0' },
  badge: { display: 'inline-block', fontSize: '8px', textTransform: 'uppercase', letterSpacing: '0.05em', background: 'var(--surface-3)', color: 'var(--ink-3)', borderRadius: '4px', padding: '2px 5px', marginLeft: '6px' },
  inspector: { position: 'absolute', left: '12px', bottom: '12px', maxWidth: '340px', background: 'rgba(255,253,249,0.97)', border: '1px solid var(--line-strong)', borderRadius: '9px', padding: '10px 12px', fontSize: '10px', boxShadow: 'var(--shadow-md)' }
};

function labelFieldsFor(payload) {
  const fields = new Set();
  (payload?.geojson?.features || []).slice(0, 100).forEach(feature => {
    Object.keys(feature.properties || {}).forEach(key => fields.add(key));
  });
  return [...fields].slice(0, 40);
}

// A label needs one stable point per feature. Points use themselves, lines their middle vertex and
// polygons the average of their outer ring (close enough for a map label, never written back).
function representativePoint(geometry) {
  if (!geometry || !geometry.type) return null;
  if (geometry.type === 'Point') return geometry.coordinates;
  if (geometry.type === 'MultiPoint') return geometry.coordinates[0] || null;
  if (geometry.type === 'LineString') return geometry.coordinates[Math.floor(geometry.coordinates.length / 2)] || null;
  if (geometry.type === 'MultiLineString') return representativePoint({ type: 'LineString', coordinates: geometry.coordinates[0] || [] });
  if (geometry.type === 'Polygon') {
    const ring = (geometry.coordinates[0] || []).slice(0, -1);
    if (ring.length === 0) return null;
    const sum = ring.reduce((acc, point) => [acc[0] + point[0], acc[1] + point[1]], [0, 0]);
    return [sum[0] / ring.length, sum[1] / ring.length];
  }
  if (geometry.type === 'MultiPolygon') return representativePoint({ type: 'Polygon', coordinates: geometry.coordinates[0] || [] });
  return null;
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
  const [basemapId, setBasemapId] = useState(DEFAULT_BASEMAP);
  // Set when MapTiler stops serving mid-session; shown in the status bar next to the basemap name.
  const [basemapNote, setBasemapNote] = useState('');
  const [mapKey, setMapKey] = useState('');
  const [localBasemap, setLocalBasemap] = useState(null);
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
  const [annotations, setAnnotations] = useState([]);
  const [annotationMode, setAnnotationMode] = useState(false);
  const [annotationText, setAnnotationText] = useState('');
  const [annotationColour, setAnnotationColour] = useState('#b54708');
  const [narrow, setNarrow] = useState(typeof window !== 'undefined' && window.innerWidth < 900);
  const [mapQuery, setMapQuery] = useState('');
  const [mapSearchOpen, setMapSearchOpen] = useState(false);

  // ---- Workstation state (tool dock, glass panels, sketch, analysis) ----
  const [activeTool, setActiveTool] = useState('select');
  // Map clicks belong to the active drawing tool, so national coverage
  // features must not intercept them.
  const activeToolRef = useRef('select');
  const [leftOpen, setLeftOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [measureMode, setMeasureMode] = useState('distance');
  const [drawMode, setDrawMode] = useState('polygon');
  const [units, setUnits] = useState('metric');
  const [snap, setSnap] = useState(true);
  const [sketch, setSketch] = useState([]);
  const [sketchResult, setSketchResult] = useState('');
  const [cutFillOpen, setCutFillOpen] = useState(false);
  const [cutFillPolygon, setCutFillPolygon] = useState(null);
  const [clashResult, setClashResult] = useState(null);
  const [clashSeed, setClashSeed] = useState(0);
  const [zoom, setZoom] = useState(11);
  const [theme, setTheme] = useState(() => getWorkspaceSettings().gisTheme);
  const [elevation, setElevation] = useState(null);

  // Ethiopia coverage tools
  const [ethiopiaOpen, setEthiopiaOpen] = useState(false);
  const [ethiopiaLayers, setEthiopiaLayers] = useState({ boundaries: true, labels: true, coverage: true });
  const [placeQuery, setPlaceQuery] = useState('');
  const [regionRecord, setRegionRecord] = useState(null);
  const [placeRecord, setPlaceRecord] = useState(null);

  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 900);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // The MapTiler key arrives from the server at runtime. Until it does, the raster fallback
  // (CARTO / Esri) is what renders, so the map is never blank and never depends on OSM tiles.
  useEffect(() => {
    let cancelled = false;
    loadMapConfig().then(config => {
      if (cancelled) return;
      setMapKey((config.maptiler && config.maptiler.key) || '');
    });
    return () => { cancelled = true; };
  }, []);

  const mapContainer = useRef(null);
  const mapRef = useRef(null);
  const regionMarkersRef = useRef([]);
  const ethiopiaPanelRef = useRef(null);
  const placePopupRef = useRef(null);
  const fittedRef = useRef(null);
  const markersRef = useRef([]);
  const opacityTimers = useRef({});
  const styleTimers = useRef({});
  const styleDraftRef = useRef({});
  const annotationMarkersRef = useRef([]);
  const featureLabelMarkersRef = useRef([]);
  const annotationModeRef = useRef(false);
  useEffect(() => { activeToolRef.current = activeTool; }, [activeTool]);
  const createAnnotationRef = useRef(null);
  const fileInputRef = useRef(null);
  const terrainGridRef = useRef(null);
  const finishSketchRef = useRef(null);

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
      style: basemapStyle(null, DEFAULT_BASEMAP),
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
      if (annotationModeRef.current) return;
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

    // The shipped extract is optional now: it is the offline basemap, loaded in the
    // background so choosing it is instant. A failure only matters for that choice.
    (async () => {
      try {
        const response = await axios.get(`${API_URL}/basemaps/addis-osm.json`);
        if (cancelled) return;
        setLocalBasemap(response.data);
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
  // Basemap switching. setStyle replaces every layer in the style, and the managed
  // `gislayer-*` layers are re-drawn by the style.load listener, so project layers
  // survive the swap. Place labels are DOM markers and are rebuilt here.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    markersRef.current.forEach(marker => marker.remove());
    markersRef.current = [];
    if (basemapId === 'local' && localBasemap) {
      markersRef.current = addPlaceLabels(map, localBasemap);
    }
    // Vector style when the server has a MapTiler key; raster fallback otherwise.
    const vectorStyle = maptilerStyleUrl(basemapId, mapKey);
    map.setStyle(vectorStyle || basemapStyle(localBasemap, basemapId));

    // A key that worked on page load can still start failing later (a quota is used up, a
    // restriction is added, MapTiler returns 429). Watching the style and tile errors lets the
    // map switch to the Esri raster basemap instead of leaving a blank canvas behind.
    if (!vectorStyle) return undefined;
    let handled = false;
    const dropToRaster = reason => {
      if (handled) return;
      handled = true;
      // Clearing the key re-runs this effect with the raster style for every basemap.
      setBasemapNote(reason);
      setMapKey('');
    };
    const looksLikeKeyFailure = message => /maptiler|403|429|usage restricted|failed to fetch|forbidden/i.test(String(message || ''));
    const onError = event => {
      const message = event && event.error ? event.error.message || String(event.error) : '';
      if (looksLikeKeyFailure(message)) dropToRaster('MapTiler unavailable — showing Esri basemaps');
    };
    map.on('error', onError);
    const timer = window.setTimeout(() => {
      if (!map.isStyleLoaded()) dropToRaster('MapTiler slow to respond — showing Esri basemaps');
    }, 8000);
    return () => {
      window.clearTimeout(timer);
      map.off('error', onError);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basemapId, localBasemap, mapReady, mapKey]);

  // ---------------------------------------------------------------------------
  // Ethiopia coverage. Boundaries and labels survive basemap swaps because the
  // effect re-runs on every style load (styleVersion). Project layers stay on top
  // by inserting the national layers before the first `gislayer-` layer.
  // ---------------------------------------------------------------------------
  const geoCoverage = useMemo(() => coverageByRegion(projects || []), [projects]);
  const ethiopiaMatches = useMemo(() => searchEthiopia(placeQuery), [placeQuery]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return undefined;

    const clearLayers = () => {
      ['ethiopia-fill', 'ethiopia-line'].forEach(layerId => {
        if (map.getLayer(layerId)) map.removeLayer(layerId);
      });
      if (map.getSource('ethiopia-regions')) map.removeSource('ethiopia-regions');
    };

    clearLayers();
    if (!ethiopiaLayers.boundaries) return undefined;

    const counts = geoCoverage.counts;
    const matchCounts = [
      'match', ['get', 'name'],
      ...ETHIOPIA_REGIONS.flatMap(region => [region.name, counts[region.name] || 0]),
      0
    ];
    const beforeId = (map.getStyle().layers || []).find(layer => String(layer.id).startsWith('gislayer-'))?.id;

    map.addSource('ethiopia-regions', { type: 'geojson', data: ETHIOPIA_BOUNDARIES });
    map.addLayer({
      id: 'ethiopia-fill',
      type: 'fill',
      source: 'ethiopia-regions',
      paint: {
        'fill-color': [
          'step', matchCounts,
          COVERAGE_RAMP[0], 1, COVERAGE_RAMP[1], 2, COVERAGE_RAMP[2], 3, COVERAGE_RAMP[3], 6, COVERAGE_RAMP[4]
        ],
        'fill-opacity': ethiopiaLayers.coverage ? 0.55 : 0.12
      }
    }, beforeId);
    map.addLayer({
      id: 'ethiopia-line',
      type: 'line',
      source: 'ethiopia-regions',
      paint: { 'line-color': '#8a5a33', 'line-width': 1.4, 'line-opacity': 0.9 }
    }, beforeId);

    const onClick = event => {
      if (['measure', 'draw', 'cut-fill'].includes(activeToolRef.current)) return;
      // A project layer feature under the pointer owns the click.
      const onProjectLayer = map.queryRenderedFeatures(event.point)
        .some(f => String(f.layer && f.layer.id).startsWith('gislayer-'));
      if (onProjectLayer) return;
      const feature = event.features && event.features[0];
      const name = feature && feature.properties ? feature.properties.name : '';
      if (!name) return;
      setRegionRecord({ name, projects: geoCoverage.byRegion[name] || [] });
    };
    const onEnter = () => {
      if (['measure', 'draw', 'cut-fill'].includes(activeToolRef.current)) return;
      map.getCanvas().style.cursor = 'pointer';
    };
    const onLeave = () => { if (!annotationModeRef.current) map.getCanvas().style.cursor = ''; };

    map.on('click', 'ethiopia-fill', onClick);
    map.on('mousemove', 'ethiopia-fill', onEnter);
    map.on('mouseleave', 'ethiopia-fill', onLeave);

    return () => {
      map.off('click', 'ethiopia-fill', onClick);
      map.off('mousemove', 'ethiopia-fill', onEnter);
      map.off('mouseleave', 'ethiopia-fill', onLeave);
      clearLayers();
    };
  }, [mapReady, styleVersion, ethiopiaLayers.boundaries, ethiopiaLayers.coverage, geoCoverage]);

  // Region names are DOM markers for the same reason feature labels are: the
  // local basemap has no glyph server, so a symbol layer would need a font host.
  // They hide once the view is closer than the country so towns stay readable.
  useEffect(() => {
    regionMarkersRef.current.forEach(entry => entry.marker.remove());
    regionMarkersRef.current = [];
    const map = mapRef.current;
    if (!map || !mapReady || !ethiopiaLayers.boundaries || !ethiopiaLayers.labels) return undefined;

    // At country zoom the two chartered cities and Harari are dots, so their
    // labels would pile up on each other. They appear once the view is closer.
    const smallAtCountryZoom = ['Addis Ababa', 'Dire Dawa', 'Hareri'];

    ETHIOPIA_REGIONS.forEach(region => {
      const count = geoCoverage.counts[region.name] || 0;
      const element = document.createElement('div');
      element.className = 'eth-region-label';
      element.textContent = count ? `${region.label} · ${count}` : region.label;
      const marker = new maplibregl.Marker({ element, anchor: 'center' })
        .setLngLat(REGION_CENTRES[region.name] || region.center)
        .addTo(map);
      regionMarkersRef.current.push({ name: region.name, marker });
    });

    const syncVisibility = () => {
      const zoom = map.getZoom();
      regionMarkersRef.current.forEach(entry => {
        const show = zoom < 8.2 && !(zoom < 5.7 && smallAtCountryZoom.includes(entry.name));
        entry.marker.getElement().style.display = show ? '' : 'none';
      });
    };
    map.on('zoom', syncVisibility);
    syncVisibility();

    return () => {
      map.off('zoom', syncVisibility);
      regionMarkersRef.current.forEach(entry => entry.marker.remove());
      regionMarkersRef.current = [];
    };
  }, [mapReady, styleVersion, ethiopiaLayers.boundaries, ethiopiaLayers.labels, geoCoverage]);

  // A searched town drops a labelled marker; the popup is the place record.
  useEffect(() => {
    const map = mapRef.current;
    if (placePopupRef.current) {
      placePopupRef.current.remove();
      placePopupRef.current = null;
    }
    if (!map || !mapReady || !placeRecord) return undefined;

    const element = document.createElement('div');
    element.className = 'eth-place-pop';
    const title = document.createElement('strong');
    title.textContent = placeRecord.name;
    const detail = document.createElement('span');
    detail.textContent = placeRecord.detail;
    element.append(title, detail);

    const popup = new maplibregl.Popup({ offset: 14, closeButton: true, maxWidth: '260px' })
      .setLngLat(placeRecord.center)
      .setDOMContent(element)
      .addTo(map);
    popup.on('close', () => setPlaceRecord(null));
    placePopupRef.current = popup;

    return () => {
      popup.remove();
      if (placePopupRef.current === popup) placePopupRef.current = null;
    };
  }, [placeRecord, mapReady]);

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

  // Annotations belong to a workspace, so switching workspaces must not leak notes between them.
  useEffect(() => {
    setAnnotations([]);
    setAnnotationMode(false);
    if (!workspaceId || !projectId) return;
    let cancelled = false;
    axios.get(`${API_URL}/api/gis/workspaces/${projectId}/${workspaceId}/annotations`, { headers: authHeaders })
      .then(response => { if (!cancelled) setAnnotations(response.data.annotations || []); })
      .catch(err => { if (!cancelled) setError(err.response?.data?.error || err.message); });
    return () => { cancelled = true; };
  }, [workspaceId, projectId, authHeaders]);

  useEffect(() => {
    annotationModeRef.current = annotationMode;
    if (mapReady && mapRef.current) {
      mapRef.current.getCanvas().style.cursor = annotationMode ? 'crosshair' : '';
    }
  }, [annotationMode, mapReady]);

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

  // Feature labels are DOM markers rather than a MapLibre symbol layer: the local basemap has no
  // glyph server, and labels must not introduce a new font/tile dependency. They stay capped so a
  // large dataset cannot bury the map under thousands of DOM nodes.
  useEffect(() => {
    featureLabelMarkersRef.current.forEach(marker => marker.remove());
    featureLabelMarkersRef.current = [];
    if (!mapReady || !workspace || !mapRef.current) return;
    const map = mapRef.current;
    let shown = 0;

    [...workspace.layers].sort((a, b) => a.zIndex - b.zIndex).forEach(layer => {
      const style = layer.style || {};
      const field = style.labelField;
      if (!layer.visible || !field || style.labelsVisible === false || shown >= 400) return;
      const features = payloads[layer.id]?.geojson?.features || [];
      const placement = style.labelPlacement || 'center';
      const anchor = placement === 'above' ? 'bottom' : placement === 'below' ? 'top' : 'center';
      const size = Number(style.labelSize) || 12;

      for (const feature of features) {
        if (shown >= 400) break;
        const value = feature.properties ? feature.properties[field] : null;
        if (value === undefined || value === null || String(value).trim() === '') continue;
        const point = representativePoint(feature.geometry);
        if (!point) continue;
        const element = document.createElement('div');
        element.className = 'gis-feature-label';
        element.textContent = String(value).slice(0, 80);
        Object.assign(element.style, {
          padding: '1px 4px', background: 'rgba(255,255,255,0.88)',
          border: '1px solid rgba(29,39,48,0.25)', borderRadius: '3px',
          font: `${size}px Calibri, sans-serif`, lineHeight: '1.2', color: '#1d2730',
          pointerEvents: 'none', whiteSpace: 'nowrap', boxShadow: '0 1px 2px rgba(0,0,0,0.15)'
        });
        const marker = new maplibregl.Marker({ element, anchor }).setLngLat(point).addTo(map);
        featureLabelMarkersRef.current.push(marker);
        shown += 1;
      }
    });

    return () => {
      featureLabelMarkersRef.current.forEach(marker => marker.remove());
      featureLabelMarkersRef.current = [];
    };
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

  const createAnnotationAt = async lngLat => {
    const text = annotationText.trim();
    if (!text) {
      setError('Type the annotation text before placing it on the map.');
      setAnnotationMode(false);
      return;
    }
    try {
      const response = await axios.post(
        `${API_URL}/api/gis/workspaces/${projectId}/${workspaceId}/annotations`,
        { text, longitude: lngLat.lng, latitude: lngLat.lat, color: annotationColour },
        { headers: authHeaders }
      );
      setAnnotations(current => [...current, response.data]);
      setAnnotationText('');
      setAnnotationMode(false);
      setNotice('Annotation added. Drag its marker to move it.');
      setTimeout(() => setNotice(''), 3000);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
      setAnnotationMode(false);
    }
  };
  createAnnotationRef.current = createAnnotationAt;

  useEffect(() => {
    if (!mapReady) return;
    const map = mapRef.current;
    if (!map) return;
    const handler = event => {
      if (!annotationModeRef.current) return;
      createAnnotationRef.current(event.lngLat);
    };
    map.on('click', handler);
    return () => map.off('click', handler);
  }, [mapReady]);

  useEffect(() => {
    annotationMarkersRef.current.forEach(marker => marker.remove());
    annotationMarkersRef.current = [];
    if (!mapReady || !mapRef.current) return;
    const map = mapRef.current;

    annotations.forEach(annotation => {
      const element = document.createElement('div');
      element.className = 'gis-annotation-marker';
      element.textContent = annotation.text;
      Object.assign(element.style, {
        maxWidth: '240px', padding: '4px 7px', background: 'rgba(255,255,255,0.96)',
        border: `1px solid ${annotation.color}`, borderLeft: `4px solid ${annotation.color}`,
        borderRadius: '4px', color: '#1d2730', font: '12px Calibri, sans-serif',
        lineHeight: '1.3', boxShadow: '0 3px 10px rgba(0,0,0,0.22)', cursor: 'grab'
      });
      const marker = new maplibregl.Marker({ element, anchor: 'bottom', draggable: true })
        .setLngLat([annotation.longitude, annotation.latitude])
        .addTo(map);
      marker.on('dragend', async () => {
        const position = marker.getLngLat();
        try {
          const response = await axios.put(
            `${API_URL}/api/gis/workspaces/${projectId}/${workspaceId}/annotations/${annotation.id}`,
            { longitude: position.lng, latitude: position.lat },
            { headers: authHeaders }
          );
          setAnnotations(current => current.map(item => item.id === annotation.id ? response.data : item));
        } catch (err) {
          setError(err.response?.data?.error || err.message);
        }
      });
      annotationMarkersRef.current.push(marker);
    });

    return () => {
      annotationMarkersRef.current.forEach(marker => marker.remove());
      annotationMarkersRef.current = [];
    };
  }, [annotations, mapReady, projectId, workspaceId, authHeaders]);

  const deleteAnnotation = async annotation => {
    try {
      await axios.delete(
        `${API_URL}/api/gis/workspaces/${projectId}/${workspaceId}/annotations/${annotation.id}`,
        { headers: authHeaders }
      );
      setAnnotations(current => current.filter(item => item.id !== annotation.id));
      setNotice('Annotation deleted.');
      setTimeout(() => setNotice(''), 2500);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
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
      // DXF/KML keep their own extension; a shapefile is always delivered as a .zip set.
      const extension = { csv: 'csv', geojson: 'geojson', dxf: 'dxf', kml: 'kml' }[format] || format;
      link.download = format === 'shp'
        ? `${fileSlug(dataset.name)}-shp.zip`
        : `${fileSlug(dataset.name)}.${extension}`;
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
  const labelFieldsByLayer = useMemo(() => {
    const fields = {};
    Object.entries(payloads).forEach(([layerId, payload]) => { fields[layerId] = labelFieldsFor(payload); });
    return fields;
  }, [payloads]);
  const readyTerrains = terrains.filter(item => item.status === 'ready');
  const layers = useMemo(() => workspace?.layers || [], [workspace]);

  const workingCrs = workspace?.workingCrs || 'EPSG:4326';
  const workingCrsDef = crsList.find(item => item.code === workingCrs);

  const mapMatches = useMemo(() => {
    const query = mapQuery.trim().toLowerCase();
    if (query.length < 2) return [];
    const matches = [];
    Object.entries(payloads).forEach(([layerId, payload]) => {
      const layer = layers.find(item => String(item.id) === String(layerId));
      (payload?.geojson?.features || []).slice(0, 250).forEach((feature, index) => {
        const properties = feature.properties || {};
        const hit = Object.entries(properties).find(([, value]) => String(value ?? '').toLowerCase().includes(query));
        if (!hit) return;
        const center = geometryCenter(feature.geometry);
        if (!center) return;
        matches.push({
          id: `${layerId}-${index}`,
          label: String(hit[1]).slice(0, 64),
          field: hit[0],
          layer: layer?.name || 'Layer',
          center,
          feature
        });
      });
    });
    return matches.slice(0, 6);
  }, [mapQuery, payloads, layers]);

  const focusSearchResult = result => {
    if (mapRef.current) {
      mapRef.current.flyTo({ center: result.center, zoom: Math.max(mapRef.current.getZoom(), 17), duration: 900 });
    }
    setSelected({ geometryType: result.feature.geometry.type, properties: result.feature.properties });
    setMapQuery(result.label);
    setMapSearchOpen(false);
  };

  const locateMe = () => {
    if (!navigator.geolocation || !mapRef.current) {
      setError('This browser does not provide a location signal.');
      return;
    }
    setNotice('Locating field position…');
    navigator.geolocation.getCurrentPosition(
      position => {
        mapRef.current.flyTo({
          center: [position.coords.longitude, position.coords.latitude],
          zoom: 17,
          duration: 1000
        });
        setNotice(`Field position fixed · accuracy ±${Math.round(position.coords.accuracy)} m`);
      },
      error => setError(error.message || 'Could not read the field position.'),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };
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

  // The coverage panel floats over the map, so framing has to use asymmetric
  // padding: otherwise the western half of the country sits behind the panel.
  // On a phone the panel spans the map, so plain padding is correct there.
  const framingPadding = () => ({ top: 60, left: 24, right: 24, bottom: 30 });

  const fitEthiopia = () => {
    if (mapRef.current) mapRef.current.fitBounds(ETHIOPIA_EXTENT, { padding: framingPadding(), duration: 1100 });
  };

  // Search results and the region list share one target shape.
  const focusEthiopiaTarget = (target) => {
    const map = mapRef.current;
    if (!map) return;
    if (target.kind === 'region') {
      const bounds = REGION_BOUNDS[target.region];
      if (bounds) {
        map.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], { padding: framingPadding(), duration: 1000 });
      } else {
        map.flyTo({ center: target.center, zoom: target.zoom, duration: 1000 });
      }
      setRegionRecord({ name: target.region, projects: geoCoverage.byRegion[target.region] || [] });
    } else {
      map.flyTo({ center: target.center, zoom: target.zoom, duration: 1200 });
      setPlaceRecord(target);
    }
    setPlaceQuery('');
  };

  // On a phone the rail sits above the map, so opening the panel from the map
  // toolbar has to bring it into view or nothing appears to happen.
  useEffect(() => {
    if (ethiopiaOpen && narrow) {
      ethiopiaPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [ethiopiaOpen, narrow]);

  const coverageMax = Math.max(1, ...Object.values(geoCoverage.counts));

  const toggleTableSort = key => {
    setTableSort(current => current.key === key
      ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
      : { key, direction: 'asc' });
  };


  // =========================================================================
  // Workstation logic
  // =========================================================================

  const formatLength = value => {
    if (!Number.isFinite(value)) return '—';
    if (units === 'imperial') return `${(value * 3.28084).toFixed(1)} ft`;
    return value >= 1000 ? `${(value / 1000).toFixed(3)} km` : `${value.toFixed(1)} m`;
  };

  const formatSurface = value => {
    if (!Number.isFinite(value)) return '—';
    if (units === 'imperial') return `${(value / 4046.8564224).toFixed(2)} acre`;
    return value >= 10000 ? `${(value / 10000).toFixed(2)} ha` : `${value.toFixed(0)} m²`;
  };

  const haversineMetres = (a, b) => {
    const R = 6371008.8;
    const rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad;
    const dLng = (b.lng - a.lng) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };

  const sketchLength = useMemo(
    () => sketch.reduce((sum, point, index) => (index === 0 ? 0 : sum + haversineMetres(sketch[index - 1], point)), 0),
    [sketch]
  );

  const sketchArea = useMemo(() => {
    if (sketch.length < 3) return 0;
    try {
      const zone = Math.floor((sketch[0].lng + 180) / 6) + 1;
      const def = `+proj=utm +zone=${zone} +datum=WGS84 +units=m +no_defs`;
      const xy = sketch.map(point => proj4('+proj=longlat +datum=WGS84 +no_defs', def, [point.lng, point.lat]));
      let sum = 0;
      for (let i = 0, j = xy.length - 1; i < xy.length; j = i, i += 1) {
        sum += xy[j][0] * xy[i][1] - xy[i][0] * xy[j][1];
      }
      return Math.abs(sum / 2);
    } catch (err) {
      return 0;
    }
  }, [sketch]);

  const sketchClosed = (activeTool === 'draw' && drawMode === 'polygon')
    || activeTool === 'cut-fill'
    || (activeTool === 'measure' && measureMode === 'area');

  const sketchReadout = useMemo(() => {
    if (sketch.length === 0) return null;
    if (activeTool === 'measure') {
      return measureMode === 'area'
        ? `${formatSurface(sketchArea)} · perimeter ${formatLength(sketchLength)}`
        : `${formatLength(sketchLength)} · ${sketch.length} pt${sketch.length === 1 ? '' : 's'}`;
    }
    if (activeTool === 'cut-fill') return `${sketch.length} vertices · ${formatSurface(sketchArea)}`;
    if (activeTool === 'draw') {
      return drawMode === 'point' ? `${sketch.length} point${sketch.length === 1 ? '' : 's'}` : `${formatSurface(sketchArea)} · ${formatLength(sketchLength)}`;
    }
    if (activeTool === 'clash') return clashResult ? `${clashResult.clashCount} conflicts` : 'Run a check in the inspector';
    return null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTool, measureMode, drawMode, sketch, sketchArea, sketchLength, units, clashResult]);

  const clearSketch = () => {
    setSketch([]);
    setSketchResult('');
  };

  const finishSketch = () => {
    if (sketch.length < 2) { setNotice('Add at least two points on the map first.'); return; }
    if (activeTool === 'cut-fill') {
      if (sketch.length < 3) { setError('A volume polygon needs at least three vertices.'); return; }
      const ring = [...sketch.map(point => [point.lng, point.lat]), [sketch[0].lng, sketch[0].lat]];
      setCutFillPolygon({ type: 'Polygon', coordinates: [ring] });
      setCutFillOpen(true);
      setInspectorOpen(true);
      setNotice(`Design polygon captured · ${formatSurface(sketchArea)}. Set the design surface in the panel.`);
      return;
    }
    if (activeTool === 'draw') {
      setSketchResult(drawMode === 'point' ? `${sketch.length} point${sketch.length === 1 ? '' : 's'} captured` : `Area ${formatSurface(sketchArea)} · perimeter ${formatLength(sketchLength)}`);
      return;
    }
    if (activeTool === 'measure') {
      setSketchResult(measureMode === 'area'
        ? `Area ${formatSurface(sketchArea)} · perimeter ${formatLength(sketchLength)}`
        : `Distance ${formatLength(sketchLength)}`);
    }
  };
  finishSketchRef.current = finishSketch;

  // Sketch geometry on the map: one source, three layers, updated in place.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const coords = sketch.map(point => [point.lng, point.lat]);
    const closedRing = sketchClosed && coords.length >= 3 ? [...coords, coords[0]] : null;
    const features = [];
    if (coords.length >= 2) {
      features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: closedRing || coords } });
    }
    if (closedRing) {
      features.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [closedRing] } });
    }
    coords.forEach(coordinate => {
      features.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: coordinate } });
    });

    const data = { type: 'FeatureCollection', features };
    const existing = map.getSource('stp-sketch');
    if (existing) { existing.setData(data); return; }
    if (features.length === 0) return;

    map.addSource('stp-sketch', { type: 'geojson', data });
    map.addLayer({
      id: 'stp-sketch-fill', type: 'fill', source: 'stp-sketch',
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: { 'fill-color': '#f59e0b', 'fill-opacity': 0.16 }
    });
    map.addLayer({
      id: 'stp-sketch-line', type: 'line', source: 'stp-sketch',
      filter: ['==', ['geometry-type'], 'LineString'],
      paint: { 'line-color': '#fbbf24', 'line-width': 2, 'line-dasharray': [2, 1.5] }
    });
    map.addLayer({
      id: 'stp-sketch-points', type: 'circle', source: 'stp-sketch',
      filter: ['==', ['geometry-type'], 'Point'],
      paint: { 'circle-radius': 4.5, 'circle-color': '#fbbf24', 'circle-stroke-color': '#111827', 'circle-stroke-width': 1.2 }
    });
  }, [sketch, sketchClosed, mapReady, styleVersion]);

  // Click to place vertices, double-click to finish. The click handler is only bound for tools
  // that draw, so feature selection still works with Select.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return undefined;
    const drawing = activeTool === 'measure' || activeTool === 'draw' || activeTool === 'cut-fill';
    map.getCanvas().style.cursor = drawing ? 'crosshair' : '';
    if (!drawing) {
      map.doubleClickZoom.enable();
      return undefined;
    }
    map.doubleClickZoom.disable();
    const onClick = event => setSketch(points => [...points, { lng: event.lngLat.lng, lat: event.lngLat.lat }]);
    const onDouble = event => {
      event.preventDefault();
      finishSketchRef.current?.();
    };
    map.on('click', onClick);
    map.on('dblclick', onDouble);
    return () => {
      map.off('click', onClick);
      map.off('dblclick', onDouble);
      map.doubleClickZoom.enable();
    };
  }, [activeTool, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return undefined;
    const onZoom = () => setZoom(map.getZoom());
    map.on('zoom', onZoom);
    setZoom(map.getZoom());
    return () => map.off('zoom', onZoom);
  }, [mapReady]);

  // Clash warning zones: a pulsing danger layer above the project layers.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return undefined;
    const remove = () => {
      ['clash-fill', 'clash-line', 'clash-points'].forEach(id => { if (map.getLayer(id)) map.removeLayer(id); });
      if (map.getSource('stp-clash')) map.removeSource('stp-clash');
    };
    const features = (clashResult?.clashes || [])
      .filter(clash => clash.geometry)
      .map(clash => ({
        type: 'Feature',
        properties: { severity: clash.severity, label: clash.layerLabel },
        geometry: clash.geometry
      }));
    if (features.length === 0) { remove(); return undefined; }

    const data = { type: 'FeatureCollection', features };
    if (map.getSource('stp-clash')) {
      map.getSource('stp-clash').setData(data);
    } else {
      map.addSource('stp-clash', { type: 'geojson', data });
      map.addLayer({
        id: 'clash-fill', type: 'fill', source: 'stp-clash',
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: { 'fill-color': '#f97316', 'fill-opacity': 0.22 }
      });
      map.addLayer({
        id: 'clash-line', type: 'line', source: 'stp-clash',
        paint: { 'line-color': '#ef4444', 'line-width': 2 }
      });
      map.addLayer({
        id: 'clash-points', type: 'circle', source: 'stp-clash',
        filter: ['==', ['geometry-type'], 'Point'],
        paint: { 'circle-radius': 7, 'circle-color': '#ef4444', 'circle-opacity': 0.85 }
      });
    }

    let frame = 0;
    const timer = window.setInterval(() => {
      frame += 1;
      const wave = (Math.sin(frame / 4) + 1) / 2;
      if (map.getLayer('clash-line')) map.setPaintProperty('clash-line', 'line-width', 1.5 + wave * 2);
      if (map.getLayer('clash-fill')) map.setPaintProperty('clash-fill', 'fill-opacity', 0.12 + wave * 0.16);
    }, 140);

    return () => { window.clearInterval(timer); remove(); };
  }, [clashResult, mapReady, styleVersion]);

  // Elevation for the telemetry bar, sampled from the first ready survey's preview grid.
  useEffect(() => {
    const ready = terrains.find(item => item.status === 'ready' && item.bounds && item.preview);
    terrainGridRef.current = null;
    if (!ready) return undefined;
    let cancelled = false;
    axios.get(`${API_URL}/api/terrain/${ready.projectId}/${ready.id}/preview.bin`, {
      responseType: 'arraybuffer',
      headers: authHeaders
    }).then(response => {
      if (cancelled) return;
      const epsg = Number(String(ready.crs || '').replace(/[^0-9]/g, ''));
      if (!Number.isFinite(epsg)) return;
      const def = epsg === 4326
        ? '+proj=longlat +datum=WGS84 +no_defs'
        : `+proj=utm +zone=${epsg >= 32700 ? epsg - 32700 : epsg - 32600} ${epsg >= 32700 ? '+south' : ''} +datum=WGS84 +units=m +no_defs`;
      terrainGridRef.current = {
        grid: new Float32Array(response.data),
        width: ready.preview.width,
        height: ready.preview.height,
        bounds: ready.bounds,
        def
      };
    }).catch(() => { terrainGridRef.current = null; });
    return () => { cancelled = true; };
  }, [terrains, authHeaders]);

  useEffect(() => {
    const source = terrainGridRef.current;
    if (!cursor || !source) { setElevation(null); return; }
    try {
      const [x, y] = proj4('+proj=longlat +datum=WGS84 +no_defs', source.def, [cursor.lng, cursor.lat]);
      const fx = ((x - source.bounds[0]) / (source.bounds[2] - source.bounds[0])) * (source.width - 1);
      const fy = ((source.bounds[3] - y) / (source.bounds[3] - source.bounds[1])) * (source.height - 1);
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      if (x0 < 0 || y0 < 0 || x0 >= source.width - 1 || y0 >= source.height - 1) { setElevation(null); return; }
      const tx = fx - x0;
      const ty = fy - y0;
      const at = (cx, cy) => source.grid[cy * source.width + cx];
      const values = [at(x0, y0), at(x0 + 1, y0), at(x0, y0 + 1), at(x0 + 1, y0 + 1)];
      if (!values.every(Number.isFinite)) { setElevation(null); return; }
      const top = values[0] * (1 - tx) + values[1] * tx;
      const bottom = values[2] * (1 - tx) + values[3] * tx;
      setElevation(top * (1 - ty) + bottom * ty);
    } catch (err) {
      setElevation(null);
    }
  }, [cursor]);

  // ---- Commands from the top menu bar / mode tabs ----
  const applyTool = (tool) => {
    setActiveTool(tool);
    setSketch([]);
    setSketchResult('');
    if (tool === 'cut-fill') { setDrawMode('polygon'); setCutFillOpen(true); }
    if (tool === 'clash') { setInspectorOpen(true); }
    if (tool === 'georef') { setView('georef'); setLeftOpen(true); }
  };

  const fitProject = () => {
    const map = mapRef.current;
    if (!map) return;
    const boxes = [];
    Object.values(payloads).forEach(payload => {
      (payload?.geojson?.features || []).forEach(feature => {
        if (feature.geometry) boxes.push(geometryBounds(feature.geometry));
      });
    });
    if (boxes.length === 0) {
      map.flyTo({ center: DEFAULT_CENTER, zoom: 11, duration: 800 });
      return;
    }
    const west = Math.min(...boxes.map(box => box[0]));
    const south = Math.min(...boxes.map(box => box[1]));
    const east = Math.max(...boxes.map(box => box[2]));
    const north = Math.max(...boxes.map(box => box[3]));
    map.fitBounds([[west, south], [east, north]], {
      padding: { top: 90, left: leftOpen ? 340 : 90, right: inspectorOpen ? 380 : 90, bottom: 70 },
      duration: 900
    });
  };

  const flyToClash = (clash) => {
    const map = mapRef.current;
    if (!map || !clash?.geometry) return;
    const bounds = geometryBounds(clash.geometry);
    map.flyTo({
      center: [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2],
      zoom: Math.max(map.getZoom(), 17),
      duration: 900
    });
    setSelected({
      geometryType: clash.geometry.type,
      properties: {
        conflict: clash.layerLabel,
        against: clash.obstacleLabel,
        rule: clash.severity === 'slope' ? `${clash.slopeDeg}° slope` : `${clash.distanceM} m clearance`,
        severity: clash.severity
      }
    });
  };

  const handleCommand = (command) => {
    if (!command) return;
    if (command.startsWith('tool:')) {
      const tool = command.slice(5);
      if (tool === 'clash-slope') { setActiveTool('clash'); setInspectorOpen(true); setClashSeed(seed => seed + 1); return; }
      applyTool(tool);
      return;
    }
    if (command.startsWith('basemap:')) {
      setBasemapId(command.slice(8));
      return;
    }
    switch (command) {
      case 'panel:layers':
        setLeftOpen(value => !value);
        break;
      case 'panel:inspector':
        setInspectorOpen(value => !value);
        break;
      case 'panel:import':
        setLeftOpen(true);
        setView('workspace');
        setTimeout(() => document.getElementById('gis-import-card')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 140);
        break;
      case 'panel:analysis':
        setLeftOpen(true);
        setView('workspace');
        setTimeout(() => document.getElementById('gis-analysis-card')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 140);
        break;
      case 'panel:table':
        if (layers[0]) setTableLayerId(layers[0].id);
        else setNotice('Load a workspace layer before opening the attribute table.');
        break;
      case 'panel:ethiopia':
        setEthiopiaOpen(true);
        break;
      case 'panel:georef':
        setView('georef');
        setLeftOpen(true);
        break;
      case 'map:fit':
        fitProject();
        break;
      case 'map:print':
        openPrintLayout();
        break;
      case 'export:geojson':
      case 'export:csv':
      case 'export:dxf':
      case 'export:kml':
      case 'export:shp': {
        const dataset = datasets.find(item => item.id === layers.find(layer => layer.kind === 'dataset')?.datasetId) || datasets[0];
        if (dataset) exportDataset(dataset, command.split(':')[1]);
        else setNotice('Add a dataset layer before exporting.');
        break;
      }
      default:
        break;
    }
  };
  const commandHandlerRef = useRef(null);
  commandHandlerRef.current = handleCommand;

  useEffect(() => {
    const unsubscribe = subscribeGisCommands(command => commandHandlerRef.current?.(command));
    const pending = consumePendingGisCommand();
    if (pending) window.setTimeout(() => commandHandlerRef.current?.(pending.command), 160);
    return unsubscribe;
  }, []);

  useEffect(() => subscribeWorkspaceSettings(state => {
    if (state.gisTheme) setTheme(state.gisTheme);
    if (state.basemap) setBasemapId(state.basemap);
  }), []);

  return (
    <div className="gis-studio" data-tool={activeTool} data-theme={theme}>
      <div className="gis-studio-bar">
        <div className="studio-project">
          <Icon name="building" size={13} />
          <label htmlFor="gis-project-select">Project</label>
          <select
            id="gis-project-select"
            value={projectId}
            onChange={event => setProjectId(event.target.value)}
          >
            <option value="">Select project</option>
            {projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </div>

        <span className="studio-context">
          {project ? `${project.name}${workspace ? ` · ${workspace.name}` : ''} · ${layers.length} layer${layers.length === 1 ? '' : 's'} · ${workingCrs}` : 'Choose a project to open its map workspace'}
        </span>

        <span className="studio-spacer" />

        <button type="button" className={`studio-btn${leftOpen ? ' active' : ''}`} onClick={() => setLeftOpen(value => !value)} title="Layer and asset tree">
          <Icon name="layers" size={13} /> Layers
        </button>
        <button type="button" className={`studio-btn${inspectorOpen ? ' active' : ''}`} onClick={() => setInspectorOpen(value => !value)} title="Property and clash inspector">
          <Icon name="panel" size={13} /> Inspector
        </button>
        <button type="button" className="studio-btn" onClick={fitProject} title="Fit project extent">
          <Icon name="maximize" size={13} /> Fit
        </button>
        <button type="button" className="studio-btn" onClick={openPrintLayout} title="Print layout">
          <Icon name="file" size={13} /> Print
        </button>
        <button type="button" className="studio-btn" onClick={saveView} disabled={savingView}>
          {savingView ? 'Saving…' : 'Save view'}
        </button>
        <button type="button" className={`studio-btn${ethiopiaOpen ? ' active' : ''}`} onClick={() => setEthiopiaOpen(value => !value)}>
          <Icon name="globe" size={13} /> Ethiopia
        </button>
      </div>

      <div className="gis-stage">
        {(error || notice || busy || (basemapError && basemapId === 'local')) && (
          <div className="gis-toasts">
            {error && (
              <div className="gis-toast error" role="alert">
                <Icon name="alert" size={13} /> <span>{error}</span>
                <button type="button" onClick={() => setError('')} aria-label="Dismiss"><Icon name="x" size={11} /></button>
              </div>
            )}
            {notice && (
              <div className="gis-toast">
                <Icon name="checkCircle" size={13} /> <span>{notice}</span>
                <button type="button" onClick={() => setNotice('')} aria-label="Dismiss"><Icon name="x" size={11} /></button>
              </div>
            )}
            {busy && <div className="gis-toast"><Icon name="clock" size={13} /> <span>{busy}</span></div>}
            {basemapError && basemapId === 'local' && (
              <div className="gis-toast error">
                <Icon name="alert" size={13} /> <span>No local extract. Run <code>node scripts/build-basemap.js</code> or choose another basemap.</span>
              </div>
            )}
          </div>
        )}

        <div className={`gis-rail gis-glass${leftOpen ? '' : ' collapsed'}`}>
          <button type="button" className="rail-toggle" onClick={() => setLeftOpen(value => !value)} aria-label="Toggle layer and asset tree">
            <Icon name={leftOpen ? 'chevronLeft' : 'chevronRight'} size={12} />
          </button>
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

          <div ref={ethiopiaPanelRef}>
          <EthiopiaCoveragePanel
            open={ethiopiaOpen}
            onClose={() => setEthiopiaOpen(false)}
            coverage={geoCoverage}
            coverageMax={coverageMax}
            layers={ethiopiaLayers}
            setLayers={setEthiopiaLayers}
            query={placeQuery}
            setQuery={setPlaceQuery}
            matches={ethiopiaMatches}
            onFocus={focusEthiopiaTarget}
            onFit={fitEthiopia}
          />
          </div>

          {projectId && (
            <div className="gis-tabs" role="tablist" aria-label="GIS tools">
              {[['workspace', 'Map'], ['osm', 'OSM explorer'], ['survey', 'Survey GIS'], ['georef', 'Georeferencing']].map(([key, label]) => (
                <button
                  key={key}
                  id={`gis-tab-${key}`}
                  className="gis-tab"
                  role="tab"
                  aria-selected={view === key}
                  onClick={() => setView(key)}
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
                        <div style={{ borderTop: '1px solid #dfe6ec', marginTop: '8px', paddingTop: '8px' }}>
                          <label style={{ fontSize: '11px', color: '#425466' }}>
                            Label field
                            <select
                              id={`layer-label-field-${layer.id}`}
                              value={layer.style?.labelField || ''}
                              onChange={event => setLayerStyle(layer, {
                                labelField: event.target.value,
                                labelsVisible: Boolean(event.target.value)
                              })}
                              style={{ display: 'block', width: '100%', padding: '5px 6px', marginTop: '3px', border: '1px solid #ccd6df', borderRadius: '4px', fontSize: '12px' }}
                            >
                              <option value="">No labels</option>
                              {Array.from(new Set([...(labelFieldsByLayer[layer.id] || []), ...(layer.style?.labelField ? [layer.style.labelField] : [])])).map(field => (
                                <option key={field} value={field}>{field}</option>
                              ))}
                            </select>
                          </label>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center', marginTop: '6px' }}>
                            <label style={{ fontSize: '11px', color: '#425466', display: 'flex', gap: '4px', alignItems: 'center' }}>
                              <input
                                id={`layer-labels-visible-${layer.id}`}
                                type="checkbox"
                                checked={layer.style?.labelsVisible !== false}
                                disabled={!layer.style?.labelField}
                                onChange={event => setLayerStyle(layer, { labelsVisible: event.target.checked })}
                              />
                              Show labels
                            </label>
                            <label style={{ fontSize: '11px', color: '#425466' }}>
                              Placement
                              <select
                                id={`layer-label-placement-${layer.id}`}
                                value={layer.style?.labelPlacement || 'center'}
                                disabled={!layer.style?.labelField}
                                onChange={event => setLayerStyle(layer, { labelPlacement: event.target.value })}
                                style={{ marginLeft: '4px', padding: '3px 5px', border: '1px solid #ccd6df', borderRadius: '4px', fontSize: '11px' }}
                              >
                                <option value="above">Above</option>
                                <option value="center">Center</option>
                                <option value="below">Below</option>
                              </select>
                            </label>
                            <label style={{ fontSize: '11px', color: '#425466' }}>
                              Size · {Number(layer.style?.labelSize ?? 12)}px
                              <input
                                id={`layer-label-size-${layer.id}`}
                                type="range" min="8" max="24" step="1"
                                value={Number(layer.style?.labelSize ?? 12)}
                                disabled={!layer.style?.labelField}
                                onChange={event => setLayerStyle(layer, { labelSize: Number(event.target.value) })}
                                style={{ display: 'block', width: '110px' }}
                              />
                            </label>
                          </div>
                          <p style={{ fontSize: '10px', color: '#5b6773', margin: '5px 0 0' }}>
                            Up to 400 labels are drawn on screen. Labels and annotations are screen overlays and are not included in the raster print capture.
                          </p>
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
                            <button
                              title="Open in AutoCAD, Civil 3D or any DXF viewer"
                              onClick={() => exportDataset(datasets.find(item => String(item.id) === String(layer.datasetId)), 'dxf')}
                              style={styles.buttonSmall}
                            >
                              DXF
                            </button>
                            <button
                              title="Open in Google Earth or any KML reader"
                              onClick={() => exportDataset(datasets.find(item => String(item.id) === String(layer.datasetId)), 'kml')}
                              style={styles.buttonSmall}
                            >
                              KML
                            </button>
                            <button
                              title="Zipped ESRI Shapefile set (.shp/.shx/.dbf/.prj)"
                              onClick={() => exportDataset(datasets.find(item => String(item.id) === String(layer.datasetId)), 'shp')}
                              style={styles.buttonSmall}
                            >
                              Shapefile
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
                <h3 style={{ marginTop: 0 }}>Annotations</h3>
                <p style={{ ...styles.helper, marginTop: 0 }}>
                  Place map notes for context. Notes are saved to this workspace and can be dragged or deleted.
                </p>
                <input
                  id="gis-annotation-text"
                  value={annotationText}
                  maxLength={240}
                  onChange={event => setAnnotationText(event.target.value)}
                  placeholder="Note text"
                  style={{ ...styles.input, width: '100%', marginBottom: '6px' }}
                />
                <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                  <input
                    id="gis-annotation-colour"
                    type="color"
                    value={annotationColour}
                    onChange={event => setAnnotationColour(event.target.value)}
                    title="Annotation colour"
                    style={{ width: '38px', height: '28px', padding: 0, border: '1px solid #ccd6df', borderRadius: '4px' }}
                  />
                  <button
                    id="gis-annotation-place"
                    onClick={() => {
                      if (!annotationText.trim()) { setError('Type the annotation text before placing it on the map.'); return; }
                      setError('');
                      setAnnotationMode(true);
                      setNotice('Click the map to place the annotation.');
                    }}
                    disabled={annotationMode}
                    style={{ ...styles.button, padding: '7px 10px', opacity: annotationMode ? 0.65 : 1 }}
                  >
                    {annotationMode ? 'Click the map…' : 'Place on map'}
                  </button>
                  {annotationMode && (
                    <button onClick={() => setAnnotationMode(false)} style={styles.buttonSmall}>Cancel</button>
                  )}
                </div>
                {annotations.length > 0 && (
                  <div style={{ marginTop: '9px', maxHeight: '190px', overflow: 'auto', borderTop: '1px solid #eee', paddingTop: '6px' }}>
                    {annotations.map(annotation => (
                      <div key={annotation.id} style={{ display: 'flex', gap: '6px', alignItems: 'center', padding: '4px 0', borderBottom: '1px solid #f2f4f6' }}>
                        <span style={{ width: '9px', height: '9px', borderRadius: '50%', background: annotation.color, flex: '0 0 auto' }} />
                        <span style={{ flex: 1, fontSize: '12px', lineHeight: 1.3 }}>{annotation.text}</span>
                        <button
                          onClick={() => {
                            if (mapRef.current) mapRef.current.flyTo({ center: [annotation.longitude, annotation.latitude], zoom: Math.max(mapRef.current.getZoom(), 15) });
                          }}
                          style={styles.buttonSmall}
                        >
                          Zoom
                        </button>
                        <button
                          id={`gis-annotation-delete-${annotation.id}`}
                          onClick={() => deleteAnnotation(annotation)}
                          style={styles.buttonSmall}
                          title="Delete annotation"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}
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
                  <label style={styles.helper}>Import dataset (GeoJSON, CSV, KML or zipped Shapefile)</label>
                  <input
                    id="gis-import-file"
                    ref={fileInputRef}
                    type="file"
                    accept=".geojson,.json,.csv,.kml,.kmz,.zip,application/json,text/csv,application/vnd.google-earth.kml+xml,application/zip"
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
                    lon/lat or easting/northing columns. KML is always WGS 84, so its CRS is set
                    automatically. A zipped Shapefile is read from its .shp/.shx/.dbf set. Max
                    {3000} features, 20 MB.
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

          {view === 'georef' && (
            <Georeferencing
              projectId={projectId}
              authHeaders={authHeaders}
              crsList={crsList}
              survey={survey}
              onNotice={setNotice}
              onError={setError}
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

        <div className="gis-map-column">
          <div className="map-shell gis-map-shell">
            <div className="map-top">
              <div className="map-search">
                <Icon name="search" size={14} />
                <input
                  value={mapQuery}
                  onChange={event => { setMapQuery(event.target.value); setMapSearchOpen(true); }}
                  onFocus={() => setMapSearchOpen(true)}
                  onBlur={() => setTimeout(() => setMapSearchOpen(false), 120)}
                  placeholder="Find a feature in this workspace…"
                  aria-label="Search features on the map"
                />
                {mapQuery && (
                  <button
                    onClick={() => { setMapQuery(''); setMapSearchOpen(false); }}
                    style={{ border: 0, background: 'none', padding: 0, color: 'inherit', display: 'grid', placeItems: 'center' }}
                    aria-label="Clear map search"
                  >
                    <Icon name="x" size={12} />
                  </button>
                )}
                {mapSearchOpen && mapQuery.trim().length >= 2 && (
                  <div className="map-search-results">
                    {mapMatches.length === 0 ? (
                      <div style={{ padding: '8px', color: 'var(--ink-3)', fontSize: 10 }}>
                        No feature in the loaded layers matches “{mapQuery.trim()}”.
                      </div>
                    ) : mapMatches.map(result => (
                      <button
                        key={result.id}
                        className="map-search-result"
                        onMouseDown={event => event.preventDefault()}
                        onClick={() => focusSearchResult(result)}
                      >
                        {result.label}
                        <span>{result.layer} · {result.field}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="map-badge secondary"><Icon name="layers" size={11} /> <strong>{layers.length}</strong> layers</div>
              <div className="map-badge"><Icon name="compass" size={11} /> <strong>{workingCrs}</strong></div>
            </div>

            <div
              ref={mapContainer}
              style={{ ...styles.map, height: '100%', border: 0, borderRadius: 0 }}
            />

            <button className="icon-btn map-geolocate" onClick={locateMe} title="Locate field position" aria-label="Locate field position">
              <Icon name="locate" size={16} />
            </button>

            {selected && (
              <div className="map-inspector">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
                  <strong style={{ fontSize: 11 }}>Feature record</strong>
                  <button onClick={() => setSelected(null)} style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--ink-3)', display: 'grid', placeItems: 'center' }} aria-label="Close feature record">
                    <Icon name="x" size={13} />
                  </button>
                </div>
                <div style={{ margin: '3px 0 7px', color: 'var(--ink-3)', fontSize: 9, textTransform: 'uppercase', letterSpacing: '.08em' }}>{selected.geometryType}</div>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <tbody>
                    {Object.entries(selected.properties).filter(([, value]) => value !== null && value !== '').slice(0, 12).map(([key, value]) => (
                      <tr key={key}>
                        <td style={{ padding: '3px 4px', color: 'var(--ink-3)', verticalAlign: 'top', borderBottom: '1px solid var(--line)' }}>{key}</td>
                        <td style={{ padding: '3px 4px', borderBottom: '1px solid var(--line)' }}>{String(value).slice(0, 120)}</td>
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

        <aside className={`gis-inspector gis-glass${inspectorOpen ? '' : ' collapsed'}`}>
          <button type="button" className="rail-toggle right" onClick={() => setInspectorOpen(value => !value)} aria-label="Toggle inspector">
            <Icon name={inspectorOpen ? 'chevronRight' : 'chevronLeft'} size={12} />
          </button>

          <div className="inspector-section">
            <div className="inspector-section-head">
              <strong><Icon name="cursor" size={13} /> Feature record</strong>
              {selected && (
                <button type="button" className="icon-btn" onClick={() => setSelected(null)} aria-label="Clear selection">
                  <Icon name="x" size={12} />
                </button>
              )}
            </div>
            {selected ? (
              <>
                <div className="inspector-kind">{selected.geometryType || 'Feature'}</div>
                <table className="inspector-table">
                  <tbody>
                    {Object.entries(selected.properties || {})
                      .filter(([, value]) => value !== null && value !== '')
                      .slice(0, 16)
                      .map(([key, value]) => (
                        <tr key={key}>
                          <td>{key}</td>
                          <td>{String(value).slice(0, 140)}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </>
            ) : (
              <p className="inspector-empty">Click a feature on the map with the Select tool to see its attributes here.</p>
            )}
          </div>

          <ClashPanel
            key={clashSeed}
            token={token}
            projectId={projectId}
            datasets={datasets}
            surveys={terrains}
            result={clashResult}
            onResult={setClashResult}
            onFlyTo={flyToClash}
            onClear={() => setClashResult(null)}
          />
        </aside>
      </div>

      <StatusBar
        cursor={cursor}
        zoom={zoom}
        elevation={elevation}
        workingCrs={workingCrs}
        layers={layers.length}
        projectName={project?.name}
        theme={theme}
        basemap={mapKey ? 'MapTiler vector' : 'Esri raster'}
        basemapNote={basemapNote}
      />

      <ToolDock activeTool={activeTool} onTool={applyTool} />
      <ContextToolbar
        activeTool={activeTool}
        options={{ measureMode, drawMode, snap, units }}
        onChange={patch => {
          if (patch.measureMode) setMeasureMode(patch.measureMode);
          if (patch.drawMode) setDrawMode(patch.drawMode);
          if ('snap' in patch) setSnap(patch.snap);
          if (patch.units) setUnits(patch.units);
        }}
        readout={sketchReadout || sketchResult}
        onClear={clearSketch}
        onFinish={finishSketch}
        canFinish={sketch.length >= 2}
      />

      {cutFillOpen && (
        <CutFillPanel
          token={token}
          projectId={projectId}
          surveys={terrains}
          polygon={cutFillPolygon}
          onClose={() => setCutFillOpen(false)}
          onDrawPolygon={() => { applyTool('cut-fill'); setCutFillOpen(true); }}
          onClearPolygon={() => setCutFillPolygon(null)}
        />
      )}

      <Popup
        open={Boolean(regionRecord)}
        onClose={() => setRegionRecord(null)}
        kicker="Ethiopia / regional coverage"
        title={regionRecord ? regionLabel(regionRecord.name) : 'Region'}
        icon="globe"
        size="md"
        ariaLabel="Ethiopia region record"
        footer={
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {regionRecord && REGION_BOUNDS[regionRecord.name] && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  const bounds = REGION_BOUNDS[regionRecord.name];
                  if (mapRef.current) {
                    mapRef.current.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], { padding: framingPadding(), duration: 900 });
                  }
                }}
              >
                Zoom to region
              </button>
            )}
            <button type="button" className="btn btn-sm" onClick={fitEthiopia}>Whole country</button>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setRegionRecord(null)}>Close</button>
          </div>
        }
      >
        {regionRecord && (() => {
          const meta = ETHIOPIA_REGIONS.find(region => region.name === regionRecord.name);
          const share = geoCoverage.total
            ? Math.round((regionRecord.projects.length / geoCoverage.total) * 100)
            : 0;
          return (
            <div className="eth-region-record">
              <div className="eth-facts">
                <div className="eth-fact"><small>Capital</small><strong>{meta?.capital || '—'}</strong></div>
                <div className="eth-fact"><small>Type</small><strong>{meta?.kind || 'Regional unit'}</strong></div>
                <div className="eth-fact"><small>Projects placed</small><strong>{regionRecord.projects.length}</strong></div>
                <div className="eth-fact"><small>Share of portfolio</small><strong>{share}%</strong></div>
              </div>
              <div>
                <strong style={{ fontSize: 11 }}>Projects in this region</strong>
                {regionRecord.projects.length === 0 ? (
                  <p style={{ ...styles.helper, marginBottom: 0 }}>
                    No project location resolves to this region yet. Type the town or region on the
                    project record and it appears here and in the shading.
                  </p>
                ) : (
                  <ul>
                    {regionRecord.projects.map(project => (
                      <li key={project.id}>
                        {project.name}{project.location ? ` · ${project.location}` : ''}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <p style={{ ...styles.helper, marginBottom: 0 }}>
                Coverage is inferred from the project location text. It places the portfolio for
                planning; it is not a cadastral or administrative boundary record.
              </p>
            </div>
          );
        })()}
      </Popup>

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
