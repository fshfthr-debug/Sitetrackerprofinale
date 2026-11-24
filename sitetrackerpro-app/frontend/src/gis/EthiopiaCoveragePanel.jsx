import React from 'react';
import Icon from '../ui/Icon';
import { ETHIOPIA_REGIONS } from './ethiopia';

// ============================================================================
// Ethiopia coverage panel.
//
// Lives in the GIS tool rail rather than floating over the map: at desktop
// widths a floating panel covered almost half of the map, and framing the
// country beside it zoomed out too far to be useful.
//
// Everything here is presentational; the workspace owns the map and the search.
// ============================================================================
export default function EthiopiaCoveragePanel({
  open,
  onClose,
  coverage,
  coverageMax,
  layers,
  setLayers,
  query,
  setQuery,
  matches,
  onFocus,
  onFit
}) {
  if (!open) return null;

  const toggle = (key) => setLayers(value => ({ ...value, [key]: !value[key] }));

  return (
    <section className="eth-panel" aria-label="Ethiopia coverage">
      <div className="eth-head">
        <div>
          <h4>Ethiopia coverage</h4>
          <p>National regions, place search and where the portfolio sits.</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close Ethiopia coverage">
          <Icon name="x" size={13} />
        </button>
      </div>

      <div className="eth-body">
        <div className="eth-stat">
          <strong>{coverage.placed}</strong>
          <span>
            of {coverage.total} project{coverage.total === 1 ? '' : 's'} placed ·{' '}
            {coverage.coveredRegions} of {ETHIOPIA_REGIONS.length} regions covered
          </span>
        </div>

        <div className="eth-actions">
          <button type="button" className="eth-chip" onClick={onFit}>
            <Icon name="maximize" size={10} /> Fit Ethiopia
          </button>
          <button type="button" className={`eth-chip${layers.boundaries ? ' on' : ''}`} aria-pressed={layers.boundaries} onClick={() => toggle('boundaries')}>
            Boundaries
          </button>
          <button type="button" className={`eth-chip${layers.labels ? ' on' : ''}`} aria-pressed={layers.labels} onClick={() => toggle('labels')}>
            Labels
          </button>
          <button type="button" className={`eth-chip${layers.coverage ? ' on' : ''}`} aria-pressed={layers.coverage} onClick={() => toggle('coverage')}>
            Coverage
          </button>
        </div>

        <label className="eth-search">
          <Icon name="search" size={13} />
          <input
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="Search a town or region…"
            aria-label="Search Ethiopian places"
          />
        </label>

        {query.trim().length >= 2 && (
          <div className="eth-results">
            {matches.length === 0 ? (
              <div className="eth-empty">No Ethiopian town or region matches “{query.trim()}”.</div>
            ) : matches.map(match => (
              <button key={match.id} type="button" className="eth-result" onClick={() => onFocus(match)}>
                {match.name}
                <span>{match.detail}</span>
              </button>
            ))}
          </div>
        )}

        <div className="eth-regions">
          {ETHIOPIA_REGIONS.map(region => {
            const count = coverage.counts[region.name] || 0;
            return (
              <button
                key={region.name}
                type="button"
                className="eth-region-row"
                onClick={() => onFocus({
                  kind: 'region', region: region.name, name: region.label,
                  center: region.center, zoom: 7
                })}
              >
                <span>
                  {region.label}
                  <small>{region.capital} · {region.kind}</small>
                </span>
                <b>{count}</b>
                <span className="eth-bar">
                  <i style={{ width: `${Math.round((count / coverageMax) * 100)}%` }} />
                </span>
              </button>
            );
          })}
        </div>

        {coverage.unplaced.length > 0 && (
          <p className="eth-note">
            {coverage.unplaced.length} project{coverage.unplaced.length === 1 ? '' : 's'} have no
            recognisable Ethiopian location and are not counted above. Add a town or region on the
            project record.
          </p>
        )}

        <p className="eth-note">
          Boundaries: geoBoundaries ETH ADM1 (2016, CC BY 4.0), simplified. Ethiopia has created
          further regions since 2023; they are not in this layer yet.
        </p>
      </div>
    </section>
  );
}
