import React, { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { SITE_ATTRIBUTION, addPlaceLabels, basemapStyle } from './basemap';

const API_URL = process.env.REACT_APP_API_URL || '';

const pointElement = (text, colour, background) => {
  const element = document.createElement('div');
  element.textContent = text;
  Object.assign(element.style, {
    padding: '1px 4px',
    border: `1px solid ${colour}`,
    borderRadius: '3px',
    background: background || 'rgba(255,255,255,0.92)',
    color: '#26313c',
    font: '11px Calibri, sans-serif',
    lineHeight: '1.3',
    whiteSpace: 'nowrap',
    boxShadow: '0 1px 2px rgba(0,0,0,0.18)'
  });
  return element;
};

export default function AlignmentPreviewMap({ preview }) {
  const container = useRef(null);
  const mapRef = useRef(null);
  const labelsRef = useRef([]);
  const placeMarkersRef = useRef([]);
  const [ready, setReady] = useState(false);
  const [styleVersion, setStyleVersion] = useState(0);
  const [basemapUnavailable, setBasemapUnavailable] = useState(false);

  useEffect(() => {
    if (!container.current) return undefined;
    const centre = preview && Array.isArray(preview.bbox)
      ? [(preview.bbox[0] + preview.bbox[2]) / 2, (preview.bbox[1] + preview.bbox[3]) / 2]
      : [38.78, 9.02];
    const map = new maplibregl.Map({
      container: container.current,
      style: basemapStyle(null),
      center: centre,
      zoom: 17,
      attributionControl: false
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    map.addControl(new maplibregl.AttributionControl({ customAttribution: SITE_ATTRIBUTION }), 'bottom-right');
    map.on('load', () => setReady(true));
    map.on('style.load', () => setStyleVersion(version => version + 1));
    map.on('error', event => console.warn('Alignment preview map error:', event && event.error ? event.error.message : event));

    let cancelled = false;
    axios.get(`${API_URL}/basemaps/addis-osm.json`)
      .then(response => {
        if (cancelled) return;
        placeMarkersRef.current = addPlaceLabels(map, response.data);
        map.setStyle(basemapStyle(response.data));
      })
      .catch(() => { if (!cancelled) setBasemapUnavailable(true); });

    return () => {
      cancelled = true;
      labelsRef.current.forEach(marker => marker.remove());
      labelsRef.current = [];
      placeMarkersRef.current.forEach(marker => marker.remove());
      placeMarkersRef.current = [];
      map.remove();
      mapRef.current = null;
      setReady(false);
    };
    // The map shell is created once; overlay changes are handled by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!ready || !mapRef.current) return;
    mapRef.current.resize();
  }, [ready]);

  useEffect(() => {
    if (!ready || !preview || !mapRef.current) return;
    const map = mapRef.current;

    labelsRef.current.forEach(marker => marker.remove());
    labelsRef.current = [];

    ['model-fill', 'model-outline', 'building-fill', 'building-outline', 'entrance',
      'link-lines', 'survey-points', 'model-points'].forEach(id => {
      if (map.getLayer(`georef-preview-${id}`)) map.removeLayer(`georef-preview-${id}`);
    });
    ['model', 'links', 'points'].forEach(id => {
      if (map.getSource(`georef-preview-${id}`)) map.removeSource(`georef-preview-${id}`);
    });

    map.addSource('georef-preview-model', { type: 'geojson', data: preview.model });
    map.addLayer({
      id: 'georef-preview-model-fill', type: 'fill', source: 'georef-preview-model',
      filter: ['==', ['get', 'kind'], 'site'],
      paint: { 'fill-color': '#d9480f', 'fill-opacity': 0.08 }
    });
    map.addLayer({
      id: 'georef-preview-model-outline', type: 'line', source: 'georef-preview-model',
      filter: ['==', ['get', 'kind'], 'site'],
      paint: { 'line-color': '#b54708', 'line-width': 2.5, 'line-dasharray': [3, 2] }
    });
    map.addLayer({
      id: 'georef-preview-building-fill', type: 'fill', source: 'georef-preview-model',
      filter: ['==', ['get', 'kind'], 'building'],
      paint: { 'fill-color': '#f08c00', 'fill-opacity': 0.36 }
    });
    map.addLayer({
      id: 'georef-preview-building-outline', type: 'line', source: 'georef-preview-model',
      filter: ['==', ['get', 'kind'], 'building'],
      paint: { 'line-color': '#b54708', 'line-width': 2 }
    });
    map.addLayer({
      id: 'georef-preview-entrance', type: 'line', source: 'georef-preview-model',
      filter: ['==', ['get', 'kind'], 'entrance'],
      paint: { 'line-color': '#7c2d12', 'line-width': 4 }
    });

    map.addSource('georef-preview-links', { type: 'geojson', data: preview.links });
    map.addLayer({
      id: 'georef-preview-link-lines', type: 'line', source: 'georef-preview-links',
      paint: {
        'line-color': ['case', ['<=', ['get', 'residualMetres'], 0.05], '#2b8a3e', '#e8590c'],
        'line-width': 2,
        'line-opacity': 0.85
      }
    });

    map.addSource('georef-preview-points', { type: 'geojson', data: preview.points });
    map.addLayer({
      id: 'georef-preview-survey-points', type: 'circle', source: 'georef-preview-points',
      filter: ['==', ['get', 'role'], 'survey'],
      paint: {
        'circle-color': '#0b7285', 'circle-radius': 7,
        'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2
      }
    });
    map.addLayer({
      id: 'georef-preview-model-points', type: 'circle', source: 'georef-preview-points',
      filter: ['==', ['get', 'role'], 'model'],
      paint: {
        'circle-color': 'rgba(255,255,255,0)', 'circle-radius': 4,
        'circle-stroke-color': '#d9480f', 'circle-stroke-width': 2.5
      }
    });

    preview.pairs.forEach(pair => {
      const marker = new maplibregl.Marker({ element: pointElement(pair.pointName, '#0b7285'), anchor: 'bottom' })
        .setLngLat(pair.surveyPoint)
        .addTo(map);
      labelsRef.current.push(marker);
    });

    const building = (preview.model.features || []).find(feature => feature.properties.kind === 'building');
    if (building) {
      const ring = building.geometry.coordinates[0];
      const centre = ring.slice(0, -1).reduce((acc, point) => [acc[0] + point[0], acc[1] + point[1]], [0, 0]);
      const marker = new maplibregl.Marker({
        element: pointElement('SAMPLE MODEL', '#b54708', 'rgba(255,245,236,0.95)'),
        anchor: 'center'
      }).setLngLat([centre[0] / (ring.length - 1), centre[1] / (ring.length - 1)]).addTo(map);
      labelsRef.current.push(marker);
    }

    if (Array.isArray(preview.bbox) && preview.bbox.length === 4) {
      map.fitBounds([[preview.bbox[0], preview.bbox[1]], [preview.bbox[2], preview.bbox[3]]], {
        padding: 46, duration: 0, maxZoom: 19
      });
    }

    return () => {
      labelsRef.current.forEach(marker => marker.remove());
      labelsRef.current = [];
    };
  }, [ready, styleVersion, preview]);

  return (
    <div>
      <div ref={container} style={{ height: 420, borderRadius: 8, overflow: 'hidden', border: '1px solid #cfd8e3' }} />
      {basemapUnavailable && (
        <p style={{ margin: '5px 0 0', color: '#6b4b00', fontSize: 11 }}>
          Local basemap unavailable; the alignment overlay is still shown on the plain background.
        </p>
      )}
    </div>
  );
}
