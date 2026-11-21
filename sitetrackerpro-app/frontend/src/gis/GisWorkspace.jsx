import React, { useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

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

export default function GisWorkspace({ token, projects }) {
  const [projectId, setProjectId] = useState('');
  const [workspaces, setWorkspaces] = useState([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [workspace, setWorkspace] = useState(null);
  const [datasets, setDatasets] = useState([]);
  const [terrains, setTerrains] = useState([]);
  const [surveyCount, setSurveyCount] = useState(0);
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
      attributionControl: false
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
        const [workspaceResponse, datasetResponse, terrainResponse, surveyResponse] = await Promise.all([
          axios.get(`${API_URL}/api/gis/workspaces/${projectId}`, { headers: authHeaders }),
          axios.get(`${API_URL}/api/gis/datasets/${projectId}`, { headers: authHeaders }),
          axios.get(`${API_URL}/api/terrain/${projectId}`, { headers: authHeaders }),
          axios.get(`${API_URL}/api/gis/survey-points/${projectId}`, { headers: authHeaders })
        ]);
        setWorkspaces(workspaceResponse.data);
        setDatasets(datasetResponse.data);
        setTerrains(terrainResponse.data);
        setSurveyCount(surveyResponse.data.count || 0);
        if (workspaceResponse.data.length > 0) setWorkspaceId(String(workspaceResponse.data[0].id));
      } catch (err) {
        setError(err.response?.data?.error || err.message);
      } finally {
        setBusy('');
      }
    })();
  }, [projectId, authHeaders]);

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

  // ---------------------------------------------------------------------------
  // Layer payloads (GeoJSON, survey points, DEM image)
  // ---------------------------------------------------------------------------
  // Depend on the layer identity, not the whole workspace: changing opacity or visibility must not
  // refetch every dataset and hillshade image.
  const layerSignature = workspace
    ? `${workspace.id}:` + workspace.layers.map(layer => `${layer.id}:${layer.kind}:${layer.datasetId || ''}:${layer.terrainId || ''}`).join('|')
    : '';

  useEffect(() => {
    if (!workspace || !projectId) { setPayloads({}); return; }
    let cancelled = false;

    (async () => {
      const next = {};
      for (const layer of workspace.layers) {
        try {
          if (layer.kind === 'dataset' && layer.datasetId) {
            const response = await axios.get(`${API_URL}/api/gis/datasets/${projectId}/${layer.datasetId}`, { headers: authHeaders });
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
          paint: { 'fill-color': colour, 'fill-opacity': 0.28 * layer.opacity }
        });
        map.addLayer({
          id: `${sourceId}-line`, type: 'line', source: sourceId, filter: geometryFilters.line,
          layout: { visibility, 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': colour, 'line-width': layer.style?.lineWidth || 2, 'line-opacity': layer.opacity }
        });
        map.addLayer({
          id: `${sourceId}-circle`, type: 'circle', source: sourceId, filter: geometryFilters.point,
          layout: { visibility },
          paint: {
            'circle-color': colour,
            'circle-radius': layer.kind === 'survey' ? 6 : 5,
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 1.5,
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

  const project = projects.find(item => String(item.id) === String(projectId));
  const gridStyle = narrow
    ? { ...styles.grid, gridTemplateColumns: 'minmax(0, 1fr)' }
    : styles.grid;
  const readyTerrains = terrains.filter(item => item.status === 'ready');
  const layers = workspace?.layers || [];

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

          {workspace && (
            <>
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
                      <button onClick={() => removeLayer(layer)} style={styles.buttonSmall}>×</button>
                    </div>
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
            </>
          )}
        </div>

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
      </div>
    </div>
  );
}
