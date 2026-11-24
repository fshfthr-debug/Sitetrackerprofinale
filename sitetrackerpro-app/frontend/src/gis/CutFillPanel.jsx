import React, { useMemo, useState } from 'react';
import axios from 'axios';
import Icon from '../ui/Icon';

const API_URL = process.env.REACT_APP_API_URL || '';

const formatVolume = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  if (Math.abs(number) >= 1e6) return `${(number / 1e6).toFixed(2)} M m³`;
  if (Math.abs(number) >= 1e3) return `${(number / 1e3).toFixed(1)} k m³`;
  return `${number.toFixed(0)} m³`;
};

const formatArea = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return number >= 10000 ? `${(number / 10000).toFixed(2)} ha` : `${number.toFixed(0)} m²`;
};

function downloadCsv(result) {
  const rows = [
    ['metric', 'value', 'unit'],
    ['cut_volume', result.cutVolumeM3, 'm3'],
    ['fill_volume', result.fillVolumeM3, 'm3'],
    ['net_balance', result.netVolumeM3, 'm3'],
    ['surface_area', result.surfaceAreaM2, 'm2'],
    ['min_elevation', result.minElevation, 'm'],
    ['max_elevation', result.maxElevation, 'm'],
    ['mean_elevation', result.meanElevation, 'm'],
    ['design_mode', result.designMode, ''],
    ['target_elevation', result.targetElevation ?? '', 'm'],
    ['baseline_survey_id', result.baselineSurveyId ?? '', ''],
    ['crs', result.crs, ''],
    ['cell_count', result.cellCount, 'cells'],
    ['cell_size_x', result.cellSizeMetres?.x, 'm'],
    ['cell_size_y', result.cellSizeMetres?.y, 'm']
  ];
  const csv = rows.map(row => row.map(cell => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `cut-fill-survey-${result.surveyId}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export default function CutFillPanel({ token, projectId, surveys = [], polygon, onClose, onDrawPolygon, onClearPolygon }) {
  const ready = useMemo(() => surveys.filter(survey => survey.status === 'ready'), [surveys]);
  const [surveyId, setSurveyId] = useState(() => (ready[0] ? String(ready[0].id) : ''));
  const [designMode, setDesignMode] = useState('elevation');
  const [targetElevation, setTargetElevation] = useState('');
  const [baselineId, setBaselineId] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const survey = ready.find(item => String(item.id) === String(surveyId)) || null;
  const cut = Number(result?.cutVolumeM3) || 0;
  const fill = Number(result?.fillVolumeM3) || 0;
  const total = cut + fill;
  const cutPct = total > 0 ? Math.max(2, (cut / total) * 100) : 50;
  const net = Number(result?.netVolumeM3) || 0;

  const compute = async () => {
    setError('');
    if (!projectId) { setError('Choose a project first.'); return; }
    if (!polygon) { setError('Draw the design polygon on the map first.'); return; }
    if (!surveyId) { setError('Choose a terrain survey.'); return; }
    if (designMode === 'elevation' && targetElevation === '') {
      setError('Enter the target design elevation in metres.');
      return;
    }
    if (designMode === 'baseline' && !baselineId) {
      setError('Choose a comparison survey.');
      return;
    }

    setBusy(true);
    try {
      const response = await axios.post(`${API_URL}/api/projects/${projectId}/terrain/cut-fill`, {
        surveyId: Number(surveyId),
        polygon,
        crs: 'EPSG:4326',
        ...(designMode === 'elevation'
          ? { targetElevation: Number(targetElevation) }
          : { baselineSurveyId: Number(baselineId) })
      }, { headers: { Authorization: `Bearer ${token}` } });
      setResult(response.data);
    } catch (err) {
      setError(err.response?.data?.error || 'The volume could not be computed.');
      setResult(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="gis-float cutfill-panel" aria-label="Cut and fill volumes">
      <header className="float-head">
        <div>
          <strong>Cut &amp; fill</strong>
          <small>Earthworks volume from the survey DEM</small>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close cut and fill"><Icon name="x" size={14} /></button>
      </header>

      <div className="float-body">
        <div className={`poly-state${polygon ? ' ready' : ''}`}>
          <Icon name={polygon ? 'checkCircle' : 'pen'} size={14} />
          <span>{polygon ? `Design polygon · ${polygon.coordinates?.[0]?.length ? polygon.coordinates[0].length - 1 : 0} vertices` : 'No polygon drawn yet'}</span>
          <button type="button" className="link-btn" onClick={onDrawPolygon}>
            {polygon ? 'Redraw' : 'Draw'}
          </button>
          {polygon && <button type="button" className="link-btn" onClick={() => { onClearPolygon(); setResult(null); }}>Clear</button>}
        </div>

        <label className="float-field">
          <span>Survey DEM</span>
          <select value={surveyId} onChange={event => setSurveyId(event.target.value)} disabled={ready.length === 0}>
            {ready.length === 0 && <option value="">No ready terrain survey</option>}
            {ready.map(item => (
              <option key={item.id} value={item.id}>
                {item.originalName} · {item.crs}
              </option>
            ))}
          </select>
        </label>

        <div className="float-seg" role="group" aria-label="Design surface">
          <button type="button" className={designMode === 'elevation' ? 'active' : ''} onClick={() => setDesignMode('elevation')}>Target elevation</button>
          <button type="button" className={designMode === 'baseline' ? 'active' : ''} onClick={() => setDesignMode('baseline')}>Baseline DEM</button>
        </div>

        {designMode === 'elevation' ? (
          <label className="float-field">
            <span>Design elevation (m)</span>
            <input
              type="number"
              step="0.01"
              value={targetElevation}
              onChange={event => setTargetElevation(event.target.value)}
              placeholder={survey?.statistics?.mean ? survey.statistics.mean.toFixed(2) : 'e.g. 2350.5'}
            />
          </label>
        ) : (
          <label className="float-field">
            <span>Comparison survey</span>
            <select value={baselineId} onChange={event => setBaselineId(event.target.value)}>
              <option value="">Choose a survey</option>
              {ready.filter(item => String(item.id) !== String(surveyId)).map(item => (
                <option key={item.id} value={item.id}>{item.originalName}</option>
              ))}
            </select>
          </label>
        )}

        {error && <div className="float-error" role="alert">{error}</div>}

        <button type="button" className="btn btn-primary btn-sm float-run" onClick={compute} disabled={busy}>
          {busy ? 'Computing…' : 'Compute volumes'}
        </button>

        {result && (
          <div className="cutfill-result">
            <div className="balance-bar" title="Cut = red, fill = blue">
              <span className="balance-cut" style={{ width: `${cutPct}%` }} />
              <span className="balance-fill" style={{ width: `${100 - cutPct}%` }} />
            </div>
            <div className="balance-legend">
              <span className="cut"><i /> Cut {formatVolume(cut)}</span>
              <span className="fill"><i /> Fill {formatVolume(fill)}</span>
            </div>

            <div className={`net-row ${net >= 0 ? 'spoil' : 'borrow'}`}>
              <span>Net balance</span>
              <strong>{formatVolume(Math.abs(net))} {net >= 0 ? 'surplus' : 'deficit'}</strong>
            </div>

            <dl className="cutfill-stats">
              <div><dt>Surface</dt><dd>{formatArea(result.surfaceAreaM2)}</dd></div>
              <div><dt>Cells</dt><dd>{result.cellCount.toLocaleString()}</dd></div>
              <div><dt>Min elev</dt><dd>{result.minElevation} m</dd></div>
              <div><dt>Max elev</dt><dd>{result.maxElevation} m</dd></div>
              <div><dt>Mean elev</dt><dd>{result.meanElevation} m</dd></div>
              <div><dt>Design</dt><dd>{result.designMode === 'baseline' ? `baseline #${result.baselineSurveyId}` : `${result.targetElevation} m`}</dd></div>
            </dl>

            <p className="float-note">{result.resolution}. {result.note}</p>

            <button type="button" className="btn btn-sm" onClick={() => downloadCsv(result)}>
              <Icon name="download" size={13} /> Export CSV
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
