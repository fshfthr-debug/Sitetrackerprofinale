import React, { useState } from 'react';
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

const formatMetres = value => (value === null || value === undefined ? '—' : Number(value).toFixed(2));

const STATUS_COLOURS = {
  compared: '#2b8a3e',
  outside: '#b35c00',
  nodata: '#8a2b12',
  'no-benchmark': '#5b6773',
  error: '#8a2b12'
};

export default function SurveyGis({
  projectId, authHeaders, crsList, terrains, survey,
  onSurveyChanged, onAddSurveyLayer, onNotice, onError
}) {
  const [file, setFile] = useState(null);
  const [crs, setCrs] = useState('EPSG:4326');
  const [verticalDatum, setVerticalDatum] = useState('');
  const [importing, setImporting] = useState(false);
  const [terrainId, setTerrainId] = useState('');
  const [review, setReview] = useState(null);
  const [reviewing, setReviewing] = useState(false);

  const features = survey?.features || [];
  const readyTerrains = (terrains || []).filter(terrain => terrain.status === 'ready');
  const benchmarks = features.filter(feature => feature.properties.isBenchmark);
  const controls = features.filter(feature => !feature.properties.isBenchmark);

  const importCsv = async () => {
    if (!file) { onError('Choose a CSV file of control points.'); return; }
    setImporting(true);
    onError('');
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('crs', crs);
      if (verticalDatum.trim()) form.append('verticalDatum', verticalDatum.trim());
      const response = await axios.post(`${API_URL}/api/gis/survey-points/${projectId}/import`, form, {
        headers: { ...authHeaders, 'Content-Type': 'multipart/form-data' }
      });
      onNotice(`Imported ${response.data.imported} control point(s) from ${response.data.sourceCrs}, stored in ${response.data.storedCrs}. ${response.data.benchmarkCount} benchmark(s).`);
      setFile(null);
      const input = document.getElementById('survey-csv-file');
      if (input) input.value = '';
      await onSurveyChanged();
    } catch (err) {
      onError(err.response?.data?.error || err.message);
    } finally {
      setImporting(false);
    }
  };

  const runReview = async () => {
    if (!terrainId) { onError('Choose a processed DEM to compare against.'); return; }
    setReviewing(true);
    onError('');
    try {
      const response = await axios.get(`${API_URL}/api/terrain/${projectId}/${terrainId}/benchmarks`, { headers: authHeaders });
      setReview(response.data);
      onNotice(`DEM review: ${response.data.summary ? `${response.data.summary.compared} control point(s) with elevations compared` : 'no points with benchmark elevations'}. Nothing was shifted.`);
    } catch (err) {
      onError(err.response?.data?.error || err.message);
      setReview(null);
    } finally {
      setReviewing(false);
    }
  };

  if (!projectId) {
    return <p style={styles.helper}>Select a project to import survey control points.</p>;
  }

  return (
    <div style={{ marginTop: '12px' }}>
      <div style={{ background: '#fff', border: '1px solid #e3e9ef', borderRadius: '8px', padding: '14px' }}>
        <h3 style={{ marginTop: 0 }}>Survey GIS</h3>
        <p style={{ ...styles.helper, marginTop: 0 }}>
          Control points are stored as longitude/latitude and elevations exactly as recorded.
          A benchmark is a point with a known elevation used to check the DEM.
        </p>

        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', fontSize: '12px', marginBottom: '8px' }}>
          <span><span style={{ color: '#c92a2a', fontWeight: 700 }}>●</span> Benchmark · {benchmarks.length}</span>
          <span><span style={{ color: '#0b7285', fontWeight: 700 }}>●</span> Control · {controls.length}</span>
        </div>

        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '8px' }}>
          <button id="survey-add-layer" onClick={onAddSurveyLayer} style={styles.button}>
            Add survey points to map
          </button>
          <button onClick={onSurveyChanged} style={styles.buttonSmall}>Refresh points</button>
        </div>

        <div style={{ borderTop: '1px solid #eee', paddingTop: '9px' }}>
          <label style={styles.helper}>Import control points (CSV)</label>
          <input
            id="survey-csv-file"
            type="file"
            accept=".csv,text/csv"
            onChange={event => setFile(event.target.files && event.target.files[0] ? event.target.files[0] : null)}
            style={{ fontSize: '12px', marginBottom: '5px', maxWidth: '100%' }}
          />
          <div style={{ display: 'flex', gap: '5px', marginBottom: '5px' }}>
            <select
              id="survey-csv-crs"
              value={crs}
              onChange={event => setCrs(event.target.value)}
              style={{ ...styles.input, flex: 1 }}
            >
              {crsList.map(item => (
                <option key={item.code} value={item.code}>{item.code} — {item.name}</option>
              ))}
            </select>
            <button id="survey-import" onClick={importCsv} disabled={importing} style={styles.button}>
              {importing ? 'Importing…' : 'Import'}
            </button>
          </div>
          <input
            id="survey-vertical-datum"
            value={verticalDatum}
            onChange={event => setVerticalDatum(event.target.value)}
            placeholder="Vertical datum (optional, as recorded)"
            style={{ ...styles.input, width: '100%', marginBottom: '5px' }}
          />
          <p style={{ ...styles.helper, fontSize: '11px' }}>
            Required: <code>name</code>, coordinates and <code>elevation</code>. Use
            {' '}<code>longitude/latitude</code> or, for a projected CRS, <code>easting/northing</code>.
            Add <code>benchmark</code> (yes/no) to mark benchmarks. Rows are converted to EPSG:4326;
            elevations are never converted.
          </p>
        </div>
      </div>

      <div style={{ background: '#fff', border: '1px solid #e3e9ef', borderRadius: '8px', padding: '14px', marginTop: '12px' }}>
        <h3 style={{ marginTop: 0 }}>DEM vs benchmarks</h3>
        <p style={{ ...styles.helper, marginTop: 0 }}>
          Samples the DEM at each control point and reports the difference. It never shifts or
          corrects either dataset.
        </p>
        {readyTerrains.length === 0 ? (
          <p style={styles.helper}>No processed DEM for this project. Upload one in the 3D viewer's terrain card.</p>
        ) : (
          <>
            <div style={{ display: 'flex', gap: '6px' }}>
              <select
                id="survey-dem-choice"
                value={terrainId}
                onChange={event => { setTerrainId(event.target.value); setReview(null); }}
                style={{ ...styles.input, flex: 1 }}
              >
                <option value="">-- DEM --</option>
                {readyTerrains.map(terrain => (
                  <option key={terrain.id} value={terrain.id}>
                    {terrain.originalName} · {terrain.crs}
                  </option>
                ))}
              </select>
              <button id="survey-review" onClick={runReview} disabled={reviewing || !terrainId} style={styles.button}>
                {reviewing ? 'Sampling…' : 'Review'}
              </button>
            </div>

            {review && (
              <div id="survey-review-result" style={{ marginTop: '9px' }}>
                {review.summary ? (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '5px', fontSize: '12px' }}>
                    <div style={{ background: '#f7f9fb', border: '1px solid #e3e9ef', borderRadius: '5px', padding: '6px' }}>
                      Compared<br /><strong>{review.summary.compared}</strong>
                    </div>
                    <div style={{ background: '#f7f9fb', border: '1px solid #e3e9ef', borderRadius: '5px', padding: '6px' }}>
                      Mean difference<br /><strong>{review.summary.meanDifference} m</strong>
                    </div>
                    <div style={{ background: '#f7f9fb', border: '1px solid #e3e9ef', borderRadius: '5px', padding: '6px' }}>
                      Range<br /><strong>{review.summary.minDifference} … {review.summary.maxDifference} m</strong>
                    </div>
                    <div style={{ background: '#f7f9fb', border: '1px solid #e3e9ef', borderRadius: '5px', padding: '6px' }}>
                      Spread<br /><strong>{review.summary.spread} m</strong>
                    </div>
                  </div>
                ) : (
                  <p style={styles.helper}>No control point with a benchmark elevation falls inside this DEM.</p>
                )}

                <div style={{ maxHeight: '260px', overflow: 'auto', border: '1px solid #e3e9ef', borderRadius: '5px', marginTop: '7px' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
                    <thead>
                      <tr>
                        {['Point', 'Benchmark m', 'DEM m', 'Diff m', 'Status'].map(header => (
                          <th key={header} style={{ position: 'sticky', top: 0, background: '#f3f6f9', textAlign: 'left', padding: '4px', borderBottom: '1px solid #dfe6ec' }}>{header}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {review.results.map(result => (
                        <tr key={result.pointId} style={{ borderBottom: '1px solid #f0f3f6' }}>
                          <td style={{ padding: '4px' }}>
                            {result.pointName || `CP-${result.pointId}`}
                            {result.isBenchmark ? <span style={{ color: '#c92a2a' }}> ●</span> : null}
                          </td>
                          <td style={{ padding: '4px' }}>{formatMetres(result.benchmarkElevation)}</td>
                          <td style={{ padding: '4px' }}>{formatMetres(result.demElevation)}</td>
                          <td style={{ padding: '4px' }}>{formatMetres(result.difference)}</td>
                          <td style={{ padding: '4px', color: STATUS_COLOURS[result.status] || '#26313c' }}>{result.status}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p style={{ ...styles.helper, fontSize: '11px', marginTop: '6px' }}>
                  {review.verticalDatumNote} {review.note}
                </p>
              </div>
            )}
          </>
        )}
      </div>

      <div style={{ background: '#fff', border: '1px solid #e3e9ef', borderRadius: '8px', padding: '14px', marginTop: '12px' }}>
        <h3 style={{ marginTop: 0 }}>Control points ({features.length})</h3>
        {features.length === 0 ? (
          <p style={styles.helper}>No survey control points yet. Import a CSV above.</p>
        ) : (
          <div style={{ maxHeight: '260px', overflow: 'auto', border: '1px solid #e3e9ef', borderRadius: '5px' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
              <thead>
                <tr>
                  {['Point', 'Type', 'Elevation m', 'Datum', 'Lat', 'Lon'].map(header => (
                    <th key={header} style={{ position: 'sticky', top: 0, background: '#f3f6f9', textAlign: 'left', padding: '4px', borderBottom: '1px solid #dfe6ec' }}>{header}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {features.map(feature => {
                  const point = feature.properties;
                  return (
                    <tr key={feature.id} style={{ borderBottom: '1px solid #f0f3f6' }}>
                      <td style={{ padding: '4px' }}>{point.name || point.pointId}</td>
                      <td style={{ padding: '4px', color: point.isBenchmark ? '#c92a2a' : '#0b7285' }}>
                        {point.isBenchmark ? 'benchmark' : 'control'}
                      </td>
                      <td style={{ padding: '4px' }}>{point.benchmarkElevation ?? '—'}</td>
                      <td style={{ padding: '4px' }}>{point.verticalDatum || '—'}</td>
                      <td style={{ padding: '4px' }}>{Number(point.latitude).toFixed(6)}</td>
                      <td style={{ padding: '4px' }}>{Number(point.longitude).toFixed(6)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p style={{ ...styles.helper, fontSize: '11px' }}>
          {survey?.verticalDatumNote || 'Elevations are shown as recorded.'}
        </p>
      </div>
    </div>
  );
}
