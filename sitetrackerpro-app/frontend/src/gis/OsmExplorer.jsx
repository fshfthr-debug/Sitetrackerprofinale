import React, { useEffect, useState } from 'react';
import axios from 'axios';

const API_URL = process.env.REACT_APP_API_URL || '';

const styles = {
  button: {
    background: '#d9480f', color: '#fff', border: 'none', borderRadius: '5px',
    padding: '7px 12px', cursor: 'pointer', fontSize: '13px'
  },
  buttonSmall: {
    background: '#f1f4f7', color: '#26313c', border: '1px solid #dfe6ec',
    borderRadius: '4px', padding: '4px 7px', cursor: 'pointer', fontSize: '12px'
  },
  input: {
    padding: '6px 8px', border: '1px solid #d5dde5', borderRadius: '5px',
    fontSize: '13px', background: '#fff', color: '#26313c'
  },
  helper: { margin: '3px 0', color: '#5b6773', fontSize: '12px' }
};

const DEFAULT_BBOX = { west: '38.74', south: '9.00', east: '38.78', north: '9.03' };

export default function OsmExplorer({
  projectId, authHeaders, getBbox,
  onPreview, onSavedDataset, onNotice, onError
}) {
  const [catalogue, setCatalogue] = useState([]);
  const [categories, setCategories] = useState(['buildings']);
  const [bbox, setBbox] = useState(DEFAULT_BBOX);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState('');
  const [datasetName, setDatasetName] = useState('OSM buildings');
  const [queries, setQueries] = useState([]);
  const [queryName, setQueryName] = useState('');

  useEffect(() => {
    if (!projectId) return;
    (async () => {
      try {
        const [catalogueResponse, queryResponse] = await Promise.all([
          axios.get(`${API_URL}/api/gis/catalogue`, { headers: authHeaders }),
          axios.get(`${API_URL}/api/gis/queries/${projectId}`, { headers: authHeaders })
        ]);
        setCatalogue(catalogueResponse.data.categories || []);
        setQueries(queryResponse.data.queries || []);
      } catch (err) {
        onError(err.response?.data?.error || err.message);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, authHeaders]);

  useEffect(() => {
    if (categories.length === 0 || !catalogue.length) return;
    const labels = catalogue.filter(item => categories.includes(item.key)).map(item => item.label);
    if (labels.length > 0) setDatasetName(current => (current === 'OSM buildings' ? `OSM ${labels.join(', ')}` : current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categories, catalogue]);

  const toggleCategory = key => {
    setCategories(current => current.includes(key)
      ? current.filter(item => item !== key)
      : [...current, key]);
  };

  const readBbox = () => {
    const values = ['west', 'south', 'east', 'north'].map(key => Number(bbox[key]));
    if (values.some(value => !Number.isFinite(value))) {
      throw new Error('Enter numeric west, south, east and north coordinates.');
    }
    if (values[0] >= values[2] || values[1] >= values[3]) {
      throw new Error('The west/south corner must be below the east/north corner.');
    }
    return values;
  };

  const useMapView = () => {
    if (!getBbox) { onError('Open a workspace map first, then use the current view.'); return; }
    const next = getBbox();
    if (!next) { onError('The map is not ready yet.'); return; }
    setBbox({
      west: next[0].toFixed(6),
      south: next[1].toFixed(6),
      east: next[2].toFixed(6),
      north: next[3].toFixed(6)
    });
  };

  const runQuery = async (selected = categories, area = bbox) => {
    if (selected.length === 0) { onError('Select at least one feature category.'); return; }
    let bounds;
    try {
      bounds = ['west', 'south', 'east', 'north'].map(key => {
        const value = Number(area[key]);
        if (!Number.isFinite(value)) throw new Error('Enter numeric west, south, east and north coordinates.');
        return value;
      });
      if (bounds[0] >= bounds[2] || bounds[1] >= bounds[3]) {
        throw new Error('The west/south corner must be below the east/north corner.');
      }
    } catch (err) {
      onError(err.message); return;
    }

    setBusy('Querying OpenStreetMap…');
    onError('');
    try {
      const response = await axios.post(`${API_URL}/api/gis/overpass/preview`, {
        categories: selected, bbox: bounds
      }, { headers: authHeaders });
      setPreview(response.data);
      onPreview(response.data.geojson);
      onNotice(`OpenStreetMap preview: ${response.data.geojson.features.length} feature(s)${response.data.cached ? ' from cache' : ''}. Contextual data, not survey measurements.`);
    } catch (err) {
      const data = err.response?.data || {};
      setPreview(null);
      onPreview(null);
      onError(data.error || err.message);
    } finally {
      setBusy('');
    }
  };

  const saveQuery = async () => {
    if (!queryName.trim()) { onError('Give the saved query a name.'); return; }
    setBusy('Saving query…');
    onError('');
    try {
      const response = await axios.post(`${API_URL}/api/gis/queries/${projectId}`, {
        name: queryName.trim(), categories, bbox: readBbox()
      }, { headers: authHeaders });
      setQueries(current => [response.data, ...current]);
      setQueryName('');
      onNotice(`Saved query “${response.data.name}”.`);
    } catch (err) {
      onError(err.response?.data?.error || err.message);
    } finally {
      setBusy('');
    }
  };

  const deleteQuery = async query => {
    setBusy('Deleting query…');
    try {
      await axios.delete(`${API_URL}/api/gis/queries/${projectId}/${query.id}`, { headers: authHeaders });
      setQueries(current => current.filter(item => item.id !== query.id));
      onNotice(`Deleted saved query “${query.name}”.`);
    } catch (err) {
      onError(err.response?.data?.error || err.message);
    } finally {
      setBusy('');
    }
  };

  const loadQuery = query => {
    const next = {
      west: Number(query.bbox[0]).toFixed(6),
      south: Number(query.bbox[1]).toFixed(6),
      east: Number(query.bbox[2]).toFixed(6),
      north: Number(query.bbox[3]).toFixed(6)
    };
    setCategories(query.categories);
    setBbox(next);
    runQuery(query.categories, next);
  };

  const saveDataset = async () => {
    if (!preview) { onError('Preview an area before saving it as a dataset.'); return; }
    setBusy('Saving dataset…');
    onError('');
    try {
      const response = await axios.post(`${API_URL}/api/gis/datasets/${projectId}`, {
        name: datasetName.trim() || 'OSM import',
        geojson: preview.geojson,
        bbox: preview.bbox,
        categories: preview.categories
      }, { headers: authHeaders });
      onNotice(`Saved dataset “${response.data.name}” (${response.data.featureCount} features).`);
      if (onSavedDataset) await onSavedDataset(response.data);
    } catch (err) {
      onError(err.response?.data?.error || err.message);
    } finally {
      setBusy('');
    }
  };

  if (!projectId) {
    return <p style={styles.helper}>Select a project to explore OpenStreetMap data.</p>;
  }

  const selectedLabels = catalogue.filter(item => categories.includes(item.key)).map(item => item.label);

  return (
    <div style={{ marginTop: '12px', background: '#fff', border: '1px solid #e3e9ef', borderRadius: '8px', padding: '14px' }}>
      <h3 style={{ marginTop: 0 }}>OSM Data Explorer</h3>
      <p style={{ ...styles.helper, marginTop: 0 }}>
        Preview OpenStreetMap features for an area, then save them as a project dataset or keep
        the query for later. OSM is contextual: it is not a survey measurement.
      </p>

      <label style={styles.helper}>Feature categories</label>
      <div id="osm-categories" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 8px', marginBottom: '8px' }}>
        {catalogue.map(category => (
          <label key={category.key} style={{ fontSize: '12px', display: 'flex', gap: '5px', alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={categories.includes(category.key)}
              onChange={() => toggleCategory(category.key)}
            />
            {category.label}
          </label>
        ))}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <label style={styles.helper}>Area (WGS 84 bounding box)</label>
        <button onClick={useMapView} style={styles.buttonSmall}>Use map view</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '5px', marginBottom: '8px' }}>
        {[['west', 'West'], ['south', 'South'], ['east', 'East'], ['north', 'North']].map(([key, label]) => (
          <label key={key} style={{ ...styles.helper, display: 'flex', gap: '4px', alignItems: 'center' }}>
            <span style={{ width: '38px' }}>{label}</span>
            <input
              id={`osm-bbox-${key}`}
              value={bbox[key]}
              onChange={event => setBbox(current => ({ ...current, [key]: event.target.value }))}
              style={{ ...styles.input, width: '100%', fontSize: '12px' }}
            />
          </label>
        ))}
      </div>

      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
        <button id="osm-preview-run" onClick={() => runQuery()} disabled={Boolean(busy)} style={styles.button}>
          {busy === 'Querying OpenStreetMap…' ? 'Querying…' : 'Preview features'}
        </button>
        <button onClick={() => { setPreview(null); onPreview(null); }} style={styles.buttonSmall}>Clear preview</button>
      </div>
      <p style={{ ...styles.helper, fontSize: '11px' }}>
        Overpass queries are rate-limited and cached for a few hours. Large areas are refused;
        select a smaller box.
      </p>

      {preview && (
        <div id="osm-preview-result" style={{ background: '#f7f9fb', border: '1px solid #e3e9ef', borderRadius: '6px', padding: '9px', marginTop: '8px', fontSize: '12px' }}>
          <strong>{preview.geojson.features.length.toLocaleString()}</strong> feature(s)
          {preview.cached ? ' · cached' : ''} · {Object.entries(preview.geometryTypes || {}).map(([type, count]) => `${count} ${type}`).join(', ')}
          <div style={{ marginTop: '4px' }}>
            {Object.entries(preview.counts || {}).map(([key, count]) => `${key}: ${count}`).join(' · ')}
          </div>
          {preview.truncated && <div style={{ color: '#8a2b12' }}>Result was capped; draw a smaller area for the full set.</div>}
          <div style={{ marginTop: '6px', color: '#5b6773' }}>
            {preview.attribution} · {preview.licence}
            {preview.osmTimestamp ? ` · OSM snapshot ${preview.osmTimestamp}` : ''}
          </div>

          <div style={{ display: 'flex', gap: '6px', marginTop: '8px', flexWrap: 'wrap' }}>
            <input
              id="osm-dataset-name"
              value={datasetName}
              onChange={event => setDatasetName(event.target.value)}
              placeholder="Dataset name"
              style={{ ...styles.input, flex: 1, minWidth: '150px' }}
            />
            <button id="osm-save-dataset" onClick={saveDataset} disabled={Boolean(busy)} style={styles.button}>
              Save as dataset
            </button>
          </div>
        </div>
      )}

      <div style={{ borderTop: '1px solid #eee', marginTop: '12px', paddingTop: '10px' }}>
        <label style={styles.helper}>Saved Overpass queries</label>
        <div style={{ display: 'flex', gap: '6px', marginBottom: '6px' }}>
          <input
            id="osm-query-name"
            value={queryName}
            onChange={event => setQueryName(event.target.value)}
            placeholder={`Name for ${selectedLabels.join(' + ') || 'this query'}`}
            style={{ ...styles.input, flex: 1 }}
          />
          <button id="osm-save-query" onClick={saveQuery} disabled={Boolean(busy)} style={styles.buttonSmall}>
            Save query
          </button>
        </div>

        {queries.length === 0 ? (
          <p style={styles.helper}>No saved queries for this project yet.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
            {queries.map(query => (
              <div key={query.id} style={{ border: '1px solid #e3e9ef', borderRadius: '5px', padding: '6px' }}>
                <div style={{ fontSize: '12px' }}>
                  <strong>{query.name}</strong>
                  <span style={{ color: '#5b6773' }}> · {query.categories.join(', ')}</span>
                </div>
                <div style={{ ...styles.helper, fontSize: '11px' }}>
                  {query.bbox.map(value => Number(value).toFixed(4)).join(', ')}
                </div>
                <div style={{ display: 'flex', gap: '5px', marginTop: '3px' }}>
                  <button onClick={() => loadQuery(query)} disabled={Boolean(busy)} style={styles.buttonSmall}>Run</button>
                  <button onClick={() => deleteQuery(query)} disabled={Boolean(busy)} style={styles.buttonSmall}>Delete</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
