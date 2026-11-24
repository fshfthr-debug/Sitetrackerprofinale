import React, { useMemo, useState } from 'react';
import axios from 'axios';
import Icon from '../ui/Icon';

const API_URL = process.env.REACT_APP_API_URL || '';

/**
 * Clearance and slope clash check. The form sits in the right inspector; results are returned
 * to the workspace so it can highlight the warning zones and fly to a conflict on click.
 */
export default function ClashPanel({
  token,
  projectId,
  datasets = [],
  surveys = [],
  result,
  onResult,
  onFlyTo,
  onClear
}) {
  const [mode, setMode] = useState('clearance');
  const [layerId, setLayerId] = useState('');
  const [obstacleId, setObstacleId] = useState('');
  const [clearance, setClearance] = useState('15');
  const [surveyId, setSurveyId] = useState('');
  const [threshold, setThreshold] = useState('15');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const readySurveys = useMemo(() => surveys.filter(survey => survey.status === 'ready'), [surveys]);

  const run = async () => {
    setError('');
    if (!projectId) { setError('Choose a project first.'); return; }
    if (!layerId) { setError('Choose the layer to check.'); return; }

    setBusy(true);
    try {
      const body = mode === 'slope'
        ? {
          layerDatasetId: Number(layerId),
          terrainSurveyId: Number(surveyId),
          slopeThresholdDegrees: Number(threshold)
        }
        : {
          layerDatasetId: Number(layerId),
          obstacleDatasetId: Number(obstacleId),
          clearanceMetres: Number(clearance),
          crs: 'EPSG:32637'
        };

      const response = await axios.post(
        `${API_URL}/api/projects/${projectId}/analysis/clash-check`,
        body,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      onResult(response.data);
    } catch (err) {
      setError(err.response?.data?.error || 'The clash check could not run.');
      onResult(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="clash-panel">
      <div className="inspector-section-head">
        <strong><Icon name="target" size={13} /> Clash &amp; encroachment</strong>
        {result && (
          <button type="button" className="icon-btn" onClick={() => { onClear(); onResult(null); }} aria-label="Clear clash results">
            <Icon name="x" size={12} />
          </button>
        )}
      </div>

      <div className="float-seg small" role="group" aria-label="Check type">
        <button type="button" className={mode === 'clearance' ? 'active' : ''} onClick={() => setMode('clearance')}>Clearance</button>
        <button type="button" className={mode === 'slope' ? 'active' : ''} onClick={() => setMode('slope')}>Slope hazard</button>
      </div>

      <label className="float-field">
        <span>Layer to check</span>
        <select value={layerId} onChange={event => setLayerId(event.target.value)}>
          <option value="">Choose a dataset</option>
          {datasets.map(dataset => (
            <option key={dataset.id} value={dataset.id}>{dataset.name}</option>
          ))}
        </select>
      </label>

      {mode === 'clearance' ? (
        <>
          <label className="float-field">
            <span>Obstacle / corridor layer</span>
            <select value={obstacleId} onChange={event => setObstacleId(event.target.value)}>
              <option value="">Choose a dataset</option>
              {datasets.filter(dataset => String(dataset.id) !== String(layerId)).map(dataset => (
                <option key={dataset.id} value={dataset.id}>{dataset.name}</option>
              ))}
            </select>
          </label>
          <label className="float-field inline">
            <span>Clearance</span>
            <input type="number" min="0" value={clearance} onChange={event => setClearance(event.target.value)} />
            <em>m</em>
          </label>
        </>
      ) : (
        <>
          <label className="float-field">
            <span>Terrain survey</span>
            <select value={surveyId} onChange={event => setSurveyId(event.target.value)}>
              <option value="">Choose a survey</option>
              {readySurveys.map(survey => (
                <option key={survey.id} value={survey.id}>{survey.originalName}</option>
              ))}
            </select>
          </label>
          <label className="float-field inline">
            <span>Slope above</span>
            <input type="number" min="1" max="89" value={threshold} onChange={event => setThreshold(event.target.value)} />
            <em>°</em>
          </label>
        </>
      )}

      {error && <div className="float-error" role="alert">{error}</div>}

      <button type="button" className="btn btn-primary btn-sm float-run" onClick={run} disabled={busy}>
        {busy ? 'Checking…' : 'Run clash check'}
      </button>

      {result && (
        <div className="clash-results">
          <div className={`clash-summary${result.clashCount > 0 ? ' warn' : ' clear'}`}>
            <Icon name={result.clashCount > 0 ? 'alert' : 'checkCircle'} size={14} />
            <span>
              {result.clashCount > 0
                ? `${result.clashCount} conflict${result.clashCount === 1 ? '' : 's'} found`
                : 'No conflicts within the rule'}
            </span>
          </div>
          <p className="float-note">
            {mode === 'slope'
              ? `Slope above ${result.slopeThresholdDegrees}° · ${result.testedPairs} features tested`
              : `Clearance ${result.clearanceMetres} m · ${result.testedPairs.toLocaleString()} pairs tested`}
            {result.truncated ? ' · list truncated at the limit' : ''}
          </p>

          <ul className="clash-list">
            {(result.clashes || []).map(clash => (
              <li key={clash.id}>
                <button type="button" onClick={() => onFlyTo(clash)} title="Fly to this conflict">
                  <span className={`clash-dot ${clash.severity}`} />
                  <span className="clash-copy">
                    <strong>{clash.layerLabel}</strong>
                    <small>
                      {clash.severity === 'slope'
                        ? `${clash.slopeDeg}° slope (limit ${clash.thresholdDeg}°)`
                        : clash.overlap
                          ? `overlaps ${clash.obstacleLabel}`
                          : `${clash.distanceM} m from ${clash.obstacleLabel}`}
                    </small>
                  </span>
                  <Icon name="arrowRight" size={12} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
