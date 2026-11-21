import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import AlignmentPreviewMap from './AlignmentPreviewMap';

const API_URL = process.env.REACT_APP_API_URL || '';

const styles = {
  card: { background: '#fff', border: '1px solid #e3e9ef', borderRadius: '8px', padding: '14px', marginTop: '12px' },
  input: {
    padding: '6px 8px', border: '1px solid #d5dde5', borderRadius: '5px',
    fontSize: '13px', background: '#fff', color: '#26313c', minWidth: 0
  },
  button: {
    background: '#d9480f', color: '#fff', border: 'none', borderRadius: '5px',
    padding: '7px 12px', cursor: 'pointer', fontSize: '13px'
  },
  buttonSmall: {
    background: '#f1f4f7', color: '#26313c', border: '1px solid #dfe6ec',
    borderRadius: '4px', padding: '4px 7px', cursor: 'pointer', fontSize: '12px'
  },
  helper: { margin: '4px 0', color: '#5b6773', fontSize: '12px', lineHeight: 1.45 },
  label: { display: 'block', color: '#5b6773', fontSize: '11px', margin: '6px 0 2px' },
  summary: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '6px', margin: '8px 0' },
  metric: { background: '#f5f8fb', border: '1px solid #e3e9ef', borderRadius: '6px', padding: '7px 8px' },
  metricValue: { fontSize: '16px', fontWeight: 700, color: '#26313c' },
  metricLabel: { fontSize: '10px', color: '#5b6773', textTransform: 'uppercase', letterSpacing: '0.03em' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '11px' },
  th: { textAlign: 'left', padding: '4px 3px', borderBottom: '1px solid #dfe6ec', color: '#5b6773', fontWeight: 600 },
  td: { padding: '4px 3px', borderBottom: '1px solid #f0f3f6', verticalAlign: 'top' },
  warning: { background: '#fff8e6', border: '1px solid #f0d18a', color: '#6b4b00', padding: '7px 9px', borderRadius: '5px', fontSize: '12px', margin: '5px 0' },
  success: { background: '#eef7ee', border: '1px solid #b7d9b7', color: '#235b2c', padding: '7px 9px', borderRadius: '5px', fontSize: '12px', margin: '5px 0' },
  error: { background: '#fff3f0', border: '1px solid #f3b7a6', color: '#8a2b12', padding: '7px 9px', borderRadius: '5px', fontSize: '12px', margin: '5px 0' },
  row: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '5px' },
  fitRow: { display: 'flex', justifyContent: 'space-between', gap: '6px', fontSize: '12px', padding: '3px 0', borderBottom: '1px solid #f0f3f6' }
};

const valueOrNull = value => (value === '' || value === null || value === undefined ? null : Number(value));
const show = (value, digits = 4) => (value === null || value === undefined ? '—' : Number(value).toFixed(digits));

function Field({ id, label, value, onChange, placeholder, type = 'number', step = 'any' }) {
  return (
    <label style={{ minWidth: 0 }}>
      <span style={styles.label}>{label}</span>
      <input
        id={id}
        type={type}
        step={type === 'number' ? step : undefined}
        value={value}
        placeholder={placeholder}
        onChange={event => onChange(event.target.value)}
        style={{ ...styles.input, width: '100%', boxSizing: 'border-box' }}
      />
    </label>
  );
}

export default function Georeferencing({ projectId, authHeaders, crsList, survey, onNotice, onError }) {
  const [georef, setGeoref] = useState(null);
  const [points, setPoints] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fitting, setFitting] = useState(false);
  const [applying, setApplying] = useState(false);
  const [fit, setFit] = useState(null);
  const [message, setMessage] = useState('');
  const [localError, setLocalError] = useState('');
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewNonce, setPreviewNonce] = useState(0);
  const [pair, setPair] = useState({ controlPointId: '', modelEast: '', modelNorth: '', modelUp: '' });
  const [form, setForm] = useState({
    crs: '', verticalDatum: '',
    anchorLat: '', anchorLon: '', anchorElevation: '',
    originEast: '', originNorth: '', originUp: '',
    rotationDeg: '', scale: '', zOffset: '',
    notes: '', verifiedBy: ''
  });

  const controls = useMemo(() => (survey?.features || []).map(feature => ({
    id: Number(String(feature.properties.id || feature.properties.pointId || '').replace(/^CP-/, '')),
    name: feature.properties.name,
    latitude: feature.properties.latitude,
    longitude: feature.properties.longitude,
    elevation: feature.properties.benchmarkElevation,
    verticalDatum: feature.properties.verticalDatum
  })), [survey]);

  const availableControls = controls.filter(control => !points.some(item => item.controlPointId === control.id));
  const projectedCrs = (crsList || []).filter(item => item.units === 'metres');

  const applyGeoref = data => {
    setGeoref(data);
    if (!data?.configured) {
      setForm(current => ({ ...current, crs: current.crs || '', verticalDatum: '' }));
      return;
    }
    setForm({
      crs: data.crs || '',
      verticalDatum: data.verticalDatum || '',
      anchorLat: data.anchor?.lat ?? '',
      anchorLon: data.anchor?.lon ?? '',
      anchorElevation: data.anchor?.elevation ?? '',
      originEast: data.modelOrigin?.east ?? '',
      originNorth: data.modelOrigin?.north ?? '',
      originUp: data.modelOrigin?.up ?? '',
      rotationDeg: data.rotationDeg ?? '',
      scale: data.scale ?? '',
      zOffset: data.zOffset ?? '',
      notes: data.notes || '',
      verifiedBy: data.verifiedBy || ''
    });
  };

  const load = async () => {
    if (!projectId) return;
    setLoading(true);
    setLocalError('');
    try {
      const [georefResponse, pointResponse] = await Promise.all([
        axios.get(`${API_URL}/api/gis/georeferencing/${projectId}`, { headers: authHeaders }),
        axios.get(`${API_URL}/api/gis/alignment/${projectId}/points`, { headers: authHeaders })
      ]);
      applyGeoref(georefResponse.data);
      setPoints(pointResponse.data.points || []);
    } catch (err) {
      setLocalError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setFit(null);
    setMessage('');
    setPreview(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, authHeaders]);

  const pointsKey = points.map(item => item.id).join(',');

  useEffect(() => {
    if (!projectId || !georef?.configured || points.length === 0) {
      setPreview(null);
      setPreviewError('');
      return undefined;
    }
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError('');
    axios.get(`${API_URL}/api/gis/alignment/${projectId}/preview`, { headers: authHeaders })
      .then(response => { if (!cancelled) setPreview(response.data); })
      .catch(err => {
        if (!cancelled) {
          setPreview(null);
          setPreviewError(err.response?.data?.error || err.message);
        }
      })
      .finally(() => { if (!cancelled) setPreviewLoading(false); });
    return () => { cancelled = true; };
  }, [projectId, authHeaders, georef?.configured, georef?.updatedAt, pointsKey, points.length, previewNonce]);

  const update = (key, value) => setForm(current => ({ ...current, [key]: value }));

  const save = async () => {
    setSaving(true);
    setLocalError('');
    setMessage('');
    onError?.('');
    try {
      await axios.put(`${API_URL}/api/gis/georeferencing/${projectId}`, {
        crs: form.crs || null,
        verticalDatum: form.verticalDatum || null,
        anchor: {
          lat: valueOrNull(form.anchorLat),
          lon: valueOrNull(form.anchorLon),
          elevation: valueOrNull(form.anchorElevation)
        },
        modelOrigin: {
          east: valueOrNull(form.originEast),
          north: valueOrNull(form.originNorth),
          up: valueOrNull(form.originUp)
        },
        rotationDeg: valueOrNull(form.rotationDeg),
        scale: valueOrNull(form.scale),
        zOffset: valueOrNull(form.zOffset),
        notes: form.notes || null,
        verifiedBy: form.verifiedBy || null
      }, { headers: authHeaders });
      await load();
      setFit(null);
      setMessage('Georeferencing saved. No geometry was moved or re-projected.');
      onNotice?.('Georeferencing parameters saved. No geometry shifted.');
    } catch (err) {
      setLocalError(err.response?.data?.error || err.message);
    } finally {
      setSaving(false);
    }
  };

  const addPair = async () => {
    setLocalError('');
    setMessage('');
    if (!pair.controlPointId) { setLocalError('Choose a survey control point.'); return; }
    try {
      await axios.post(`${API_URL}/api/gis/alignment/${projectId}/points`, {
        controlPointId: Number(pair.controlPointId),
        modelEast: valueOrNull(pair.modelEast),
        modelNorth: valueOrNull(pair.modelNorth),
        modelUp: valueOrNull(pair.modelUp)
      }, { headers: authHeaders });
      setPair({ controlPointId: '', modelEast: '', modelNorth: '', modelUp: '' });
      setFit(null);
      await load();
      setMessage('Alignment pair added. Fit again to see its residuals.');
    } catch (err) {
      setLocalError(err.response?.data?.error || err.message);
    }
  };

  const removePair = async id => {
    setLocalError('');
    try {
      await axios.delete(`${API_URL}/api/gis/alignment/${projectId}/points/${id}`, { headers: authHeaders });
      setFit(null);
      await load();
      setMessage('Alignment pair removed.');
    } catch (err) {
      setLocalError(err.response?.data?.error || err.message);
    }
  };

  const runFit = async () => {
    setFitting(true);
    setLocalError('');
    setMessage('');
    try {
      const response = await axios.post(`${API_URL}/api/gis/alignment/${projectId}/fit`, {}, { headers: authHeaders });
      setFit(response.data);
      setMessage('Fit calculated. Review the residuals, then apply it explicitly.');
    } catch (err) {
      setFit(null);
      setLocalError(err.response?.data?.error || err.message);
    } finally {
      setFitting(false);
    }
  };

  const applyFit = async () => {
    if (!fit) return;
    if (!window.confirm('Apply the fitted anchor, rotation, scale and height offset to the saved georeferencing? No geometry will be moved.')) return;
    setApplying(true);
    setLocalError('');
    setMessage('');
    try {
      const response = await axios.post(`${API_URL}/api/gis/georeferencing/${projectId}/apply-fit`, {
        verticalDatum: form.verticalDatum || null,
        notes: form.notes || null,
        verifiedBy: form.verifiedBy || null
      }, { headers: authHeaders });
      setFit(response.data.fit);
      await load();
      setMessage('Fit applied and saved. Geometry remains unchanged.');
      onNotice?.('Survey alignment fit applied. No geometry shifted.');
    } catch (err) {
      setLocalError(err.response?.data?.error || err.message);
    } finally {
      setApplying(false);
    }
  };

  if (!projectId) {
    return <p style={styles.helper}>Select a project to manage survey georeferencing.</p>;
  }

  return (
    <div>
      <div style={styles.card}>
        <h3 style={{ marginTop: 0 }}>Survey georeferencing</h3>
        <p style={{ ...styles.helper, marginTop: 0 }}>
          Relates model coordinates to survey control points. A fit is only a proposal until you
          apply it; neither the survey points nor any GIS layer is moved.
        </p>
        {loading && <p style={styles.helper}>Loading georeferencing…</p>}
        {localError && <div style={styles.error} id="georef-error">{localError}</div>}
        {message && <div style={styles.success} id="georef-message">{message}</div>}
        {!georef?.configured && !loading && (
          <p style={styles.helper}>
            No georeferencing is saved yet. Choose the model CRS, save it, then add alignment pairs.
          </p>
        )}

        <label style={styles.label}>Model CRS (projected, metres)</label>
        <select
          id="georef-crs"
          value={form.crs}
          onChange={event => update('crs', event.target.value)}
          style={{ ...styles.input, width: '100%' }}
        >
          <option value="">-- choose CRS --</option>
          {projectedCrs.map(item => (
            <option key={item.code} value={item.code}>{item.code} — {item.name}</option>
          ))}
        </select>
        <p style={{ ...styles.helper, fontSize: '11px' }}>
          Fit requires a projected CRS. A geographic CRS would mix degrees with model units.
        </p>

        <Field id="georef-vertical-datum" label="Vertical datum (as recorded)" value={form.verticalDatum} onChange={value => update('verticalDatum', value)} placeholder="e.g. local site datum" type="text" />

        <div style={styles.row}>
          <Field id="georef-anchor-lat" label="Anchor latitude" value={form.anchorLat} onChange={value => update('anchorLat', value)} />
          <Field id="georef-anchor-lon" label="Anchor longitude" value={form.anchorLon} onChange={value => update('anchorLon', value)} />
        </div>
        <Field id="georef-anchor-elevation" label="Anchor elevation (m)" value={form.anchorElevation} onChange={value => update('anchorElevation', value)} />

        <div style={styles.row}>
          <Field id="georef-origin-east" label="Model origin easting" value={form.originEast} onChange={value => update('originEast', value)} />
          <Field id="georef-origin-north" label="Model origin northing" value={form.originNorth} onChange={value => update('originNorth', value)} />
        </div>
        <div style={styles.row}>
          <Field id="georef-origin-up" label="Model origin height" value={form.originUp} onChange={value => update('originUp', value)} />
          <Field id="georef-rotation" label="Rotation (degrees)" value={form.rotationDeg} onChange={value => update('rotationDeg', value)} />
        </div>
        <div style={styles.row}>
          <Field id="georef-scale" label="Scale" value={form.scale} onChange={value => update('scale', value)} />
          <Field id="georef-z-offset" label="Height offset (m)" value={form.zOffset} onChange={value => update('zOffset', value)} />
        </div>
        <Field id="georef-verified-by" label="Verified by" value={form.verifiedBy} onChange={value => update('verifiedBy', value)} placeholder="Person or reference" type="text" />
        <label style={styles.label}>Notes</label>
        <textarea
          id="georef-notes"
          value={form.notes}
          onChange={event => update('notes', event.target.value)}
          rows={2}
          style={{ ...styles.input, width: '100%', boxSizing: 'border-box' }}
        />
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '8px' }}>
          <button id="georef-save" onClick={save} disabled={saving || !form.crs} style={styles.button}>
            {saving ? 'Saving…' : 'Save georeferencing'}
          </button>
          <button onClick={load} disabled={loading} style={styles.buttonSmall}>Reload</button>
        </div>
      </div>

      <div style={styles.card} id="alignment-preview">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' }}>
          <h3 style={{ margin: 0, flex: 1 }}>Map preview</h3>
          <button
            id="preview-refresh"
            onClick={() => setPreviewNonce(value => value + 1)}
            disabled={previewLoading}
            style={styles.buttonSmall}
          >
            {previewLoading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
        <p style={{ ...styles.helper, marginTop: 4 }}>
          Uses the <strong>saved</strong> georeferencing fit to place a generated sample footprint over the
          survey points. The footprint and its building are illustrative only; no BIM model or dataset is moved.
        </p>
        {!georef?.configured && (
          <p style={styles.helper}>Save the CRS, anchor, model origin, rotation and scale to see the preview.</p>
        )}
        {georef?.configured && points.length === 0 && (
          <p style={styles.helper}>Add at least one alignment pair to give the sample footprint an extent.</p>
        )}
        {previewError && <div style={styles.warning}>{previewError}</div>}
        {previewLoading && !preview && <p style={styles.helper}>Placing the sample model…</p>}
        {preview && (
          <>
            <div style={styles.fitRow}><span>Saved fit</span><strong>{show(preview.rotationDeg, 6)}° · scale {show(preview.scale, 9)}</strong></div>
            <div style={styles.fitRow}><span>Footprint on the ground</span><strong>{show(preview.sample.groundWidthMetres, 1)} × {show(preview.sample.groundDepthMetres, 1)} m</strong></div>
            <div style={styles.fitRow}><span>Pair check</span><strong>{preview.pairCount} pairs · max {show(preview.maxResidual, 4)} m</strong></div>

            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', margin: '8px 0' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: '#5b6773' }}>
                <span style={{ width: 18, borderTop: '2px dashed #b54708' }} /> model boundary
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: '#5b6773' }}>
                <span style={{ width: 12, height: 9, background: 'rgba(240,140,0,0.36)', border: '1px solid #b54708' }} /> sample building
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: '#5b6773' }}>
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#0b7285' }} /> survey point
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: '#5b6773' }}>
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#fff', border: '2px solid #d9480f', boxSizing: 'border-box' }} /> model point after fit
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: '#5b6773' }}>
                <span style={{ width: 18, borderTop: '2px solid #2b8a3e' }} /> residual ≤ 5 cm
              </span>
            </div>

            <AlignmentPreviewMap preview={preview} />
            <p style={{ ...styles.helper, fontSize: '11px', marginBottom: 0 }}>
              A model ring sitting inside a survey dot means that pair matches closely; an amber connector
              line shows the remaining horizontal offset. {preview.sample.note}
            </p>
          </>
        )}
      </div>

      <div style={styles.card}>
        <h3 style={{ marginTop: 0 }}>Alignment pairs</h3>
        <p style={{ ...styles.helper, marginTop: 0 }}>
          Each pair gives the same point in model easting/northing and as a survey control point.
          At least three pairs are needed; more pairs make the residuals meaningful.
        </p>
        {availableControls.length === 0 ? (
          <p style={styles.helper}>
            {controls.length === 0
              ? 'No survey control points yet. Import them in the Survey GIS tab.'
              : 'Every survey control point already has an alignment pair.'}
          </p>
        ) : (
          <>
            <label style={styles.label}>Survey control point</label>
            <select
              id="alignment-point"
              value={pair.controlPointId}
              onChange={event => setPair(current => ({ ...current, controlPointId: event.target.value }))}
              style={{ ...styles.input, width: '100%' }}
            >
              <option value="">-- choose point --</option>
              {availableControls.map(control => (
                <option key={control.id} value={control.id}>{control.name}</option>
              ))}
            </select>
            <div style={styles.row}>
              <Field id="alignment-model-east" label="Model easting" value={pair.modelEast} onChange={value => setPair(current => ({ ...current, modelEast: value }))} />
              <Field id="alignment-model-north" label="Model northing" value={pair.modelNorth} onChange={value => setPair(current => ({ ...current, modelNorth: value }))} />
            </div>
            <Field id="alignment-model-up" label="Model height (optional)" value={pair.modelUp} onChange={value => setPair(current => ({ ...current, modelUp: value }))} />
            <button id="alignment-add" onClick={addPair} style={{ ...styles.button, marginTop: '8px' }}>Add pair</button>
          </>
        )}

        {points.length > 0 && (
          <div style={{ overflowX: 'auto', marginTop: '10px' }}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>Point</th>
                  <th style={styles.th}>Model E / N / H</th>
                  <th style={styles.th}>Survey lon / lat</th>
                  <th style={styles.th} />
                </tr>
              </thead>
              <tbody>
                {points.map(item => (
                  <tr key={item.id}>
                    <td style={styles.td}>{item.pointName}</td>
                    <td style={styles.td}>
                      {show(item.modelEast, 3)} / {show(item.modelNorth, 3)} / {show(item.modelUp, 3)}
                    </td>
                    <td style={styles.td}>{show(item.longitude, 6)} / {show(item.latitude, 6)}</td>
                    <td style={styles.td}>
                      <button
                        id={`alignment-delete-${item.id}`}
                        onClick={() => removePair(item.id)}
                        style={{ ...styles.buttonSmall, color: '#8a2b12' }}
                        aria-label={`Remove alignment pair for ${item.pointName}`}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div style={{ marginTop: '10px', borderTop: '1px solid #eee', paddingTop: '9px' }}>
          <button
            id="alignment-fit"
            onClick={runFit}
            disabled={fitting || points.length < 3 || !georef?.configured}
            style={styles.button}
          >
            {fitting ? 'Calculating…' : 'Analyse fit'}
          </button>
          <p style={{ ...styles.helper, fontSize: '11px' }}>
            Uses the saved CRS and saved pairs. {points.length < 3 ? `Add ${3 - points.length} more pair(s).` : 'Save any CRS change before fitting.'}
          </p>
        </div>
      </div>

      {fit && (
        <div style={styles.card} id="alignment-result">
          <h3 style={{ marginTop: 0 }}>Fit result</h3>
          <div style={styles.summary}>
            <div style={styles.metric}>
              <div style={styles.metricValue}>{fit.pairCount}</div>
              <div style={styles.metricLabel}>Pairs</div>
            </div>
            <div style={styles.metric}>
              <div style={styles.metricValue}>{show(fit.rms, 4)} m</div>
              <div style={styles.metricLabel}>RMS</div>
            </div>
            <div style={styles.metric}>
              <div style={styles.metricValue}>{show(fit.maxResidual, 4)} m</div>
              <div style={styles.metricLabel}>Max residual</div>
            </div>
          </div>
          <div style={styles.fitRow}><span>Rotation</span><strong>{show(fit.rotationDeg, 6)}°</strong></div>
          <div style={styles.fitRow}><span>Scale</span><strong>{show(fit.scale, 9)}</strong></div>
          <div style={styles.fitRow}><span>Anchor</span><strong>{show(fit.anchor.lat, 8)}, {show(fit.anchor.lon, 8)}</strong></div>
          <div style={styles.fitRow}><span>Model origin</span><strong>{show(fit.modelOrigin.east, 3)}, {show(fit.modelOrigin.north, 3)}</strong></div>
          <div style={styles.fitRow}><span>Height offset</span><strong>{fit.zOffset === null ? 'not fitted' : `${show(fit.zOffset, 4)} m`}</strong></div>
          {fit.vertical && (
            <p style={styles.helper}>
              Vertical: {fit.vertical.pairCount} pair(s), RMS {show(fit.vertical.rms, 4)} m.
            </p>
          )}
          {(fit.warnings || []).map(warning => <div key={warning} style={styles.warning}>{warning}</div>)}

          <div style={{ overflowX: 'auto', marginTop: '8px' }}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>Point</th>
                  <th style={styles.th}>ΔE</th>
                  <th style={styles.th}>ΔN</th>
                  <th style={styles.th}>Residual</th>
                </tr>
              </thead>
              <tbody>
                {fit.residuals.map(item => (
                  <tr key={item.id}>
                    <td style={styles.td}>{item.pointName}</td>
                    <td style={styles.td}>{show(item.dx, 4)}</td>
                    <td style={styles.td}>{show(item.dy, 4)}</td>
                    <td style={styles.td}>{show(item.distance, 4)} m</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '10px' }}>
            <button id="alignment-apply" onClick={applyFit} disabled={applying} style={styles.button}>
              {applying ? 'Applying…' : 'Apply fit'}
            </button>
            <button onClick={() => setFit(null)} style={styles.buttonSmall}>Discard preview</button>
          </div>
          <p style={{ ...styles.helper, fontSize: '11px' }}>
            Apply saves the fitted anchor, rotation, scale and height offset only. It does not move,
            rotate or re-project any dataset.
          </p>
        </div>
      )}
    </div>
  );
}
