import React from 'react';
import Icon from '../ui/Icon';

// Primary map tools. Shortcuts are single keys, advertised in the tooltip and the sub-toolbar.
export const MAP_TOOLS = [
  { id: 'select', label: 'Select / Inspect', icon: 'cursor', key: 'V', hint: 'Click a feature to inspect it' },
  { id: 'pan', label: 'Pan', icon: 'locate', key: 'H', hint: 'Drag to pan the map' },
  { id: 'measure', label: 'Measure Distance / Area', icon: 'ruler', key: 'M', hint: 'Click to add points, double-click to finish' },
  { id: 'draw', label: 'Draw Polygon / Point', icon: 'pen', key: 'D', hint: 'Click vertices, double-click to close the polygon' },
  { id: 'cut-fill', label: 'Cut / Fill Volume', icon: 'mountain', key: 'C', hint: 'Draw a polygon and compute volumes against a DEM' },
  { id: 'clash', label: 'Clash Check', icon: 'target', key: 'K', hint: 'Check clearance between layers or slope hazards' },
  { id: 'georef', label: 'Georeference', icon: 'globe', key: 'G', hint: 'Fit a raster or drawing to survey control' }
];

export function ToolDock({ activeTool, onTool, collapsed = false }) {
  return (
    <div className={`tool-dock${collapsed ? ' collapsed' : ''}`} role="toolbar" aria-label="Map tools" aria-orientation="vertical">
      {MAP_TOOLS.map(tool => (
        <button
          key={tool.id}
          type="button"
          className={`tool-btn${activeTool === tool.id ? ' active' : ''}`}
          aria-pressed={activeTool === tool.id}
          onClick={() => onTool(tool.id)}
          title={`${tool.label} (${tool.key})`}
        >
          <Icon name={tool.icon} size={17} />
          <span className="tool-tip">
            <strong>{tool.label}</strong>
            <small>{tool.hint}</small>
            <kbd>{tool.key}</kbd>
          </span>
        </button>
      ))}
    </div>
  );
}

const MEASURE_MODES = [
  { id: 'distance', label: 'Distance' },
  { id: 'area', label: 'Area' }
];

const DRAW_MODES = [
  { id: 'polygon', label: 'Polygon' },
  { id: 'point', label: 'Point' }
];

const UNITS = [
  { id: 'metric', label: 'm / m² / ha' },
  { id: 'imperial', label: 'ft / acre' }
];

/**
 * Contextual sub-toolbar pill. It shows only what the active tool needs: sub-modes, snapping,
 * units and the live measurement or the drawing state.
 */
export function ContextToolbar({
  activeTool,
  options,
  onChange,
  readout,
  onClear,
  onFinish,
  canFinish = false
}) {
  const tool = MAP_TOOLS.find(item => item.id === activeTool);
  if (!tool) return null;

  const isSimple = activeTool === 'select' || activeTool === 'pan' || activeTool === 'georef';
  if (isSimple) return null;

  return (
    <div className="map-subbar" role="toolbar" aria-label={`${tool.label} options`}>
      <span className="subbar-tool"><Icon name={tool.icon} size={13} /> {tool.label}</span>
      <span className="subbar-sep" />

      {activeTool === 'measure' && (
        <div className="subbar-seg" role="group" aria-label="Measurement type">
          {MEASURE_MODES.map(mode => (
            <button
              key={mode.id}
              type="button"
              className={options.measureMode === mode.id ? 'active' : ''}
              onClick={() => onChange({ measureMode: mode.id })}
            >
              {mode.label}
            </button>
          ))}
        </div>
      )}

      {activeTool === 'draw' && (
        <div className="subbar-seg" role="group" aria-label="Draw type">
          {DRAW_MODES.map(mode => (
            <button
              key={mode.id}
              type="button"
              className={options.drawMode === mode.id ? 'active' : ''}
              onClick={() => onChange({ drawMode: mode.id })}
            >
              {mode.label}
            </button>
          ))}
        </div>
      )}

      {(activeTool === 'measure' || activeTool === 'draw' || activeTool === 'cut-fill') && (
        <>
          <label className="subbar-check">
            <input
              type="checkbox"
              checked={options.snap}
              onChange={event => onChange({ snap: event.target.checked })}
            />
            Snap
          </label>
          <label className="subbar-field">
            Unit
            <select value={options.units} onChange={event => onChange({ units: event.target.value })}>
              {UNITS.map(unit => <option key={unit.id} value={unit.id}>{unit.label}</option>)}
            </select>
          </label>
          <span className="subbar-sep" />
        </>
      )}

      {readout && <span className="subbar-readout">{readout}</span>}

      <span className="subbar-spacer" />

      {activeTool !== 'clash' && onClear && (
        <button type="button" className="subbar-action" onClick={onClear}>Clear</button>
      )}
      {canFinish && onFinish && (
        <button type="button" className="subbar-action primary" onClick={onFinish}>Finish</button>
      )}
      <span className="subbar-hint">{tool.hint}</span>
    </div>
  );
}
