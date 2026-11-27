// ============================================================================
// Workspace settings and the command bus shared by the top application bar and
// the GIS workstation.
//
// Kept in a module rather than React context so that the top bar (outside the
// map component) can switch basemaps, themes and tools, and so a menu command
// issued while the GIS screen is mounting is not lost: it waits in
// `pendingGisCommand` until the workspace consumes it.
// ============================================================================

// v2: the GIS studio now opens light to match the rest of the app, so the old key's
// stored dark default is deliberately not read. The theme switch still works and
// still persists once an operator picks something.
const STORAGE_KEY = 'stp.workspace.settings.v2';

const DEFAULTS = {
  gisTheme: 'light',
  basemap: 'street'
};

function readStored() {
  if (typeof window === 'undefined') return { ...DEFAULTS };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    return {
      gisTheme: parsed.gisTheme === 'dark' ? 'dark' : 'light',
      basemap: typeof parsed.basemap === 'string' && parsed.basemap ? parsed.basemap : DEFAULTS.basemap
    };
  } catch (err) {
    return { ...DEFAULTS };
  }
}

let state = readStored();
const listeners = new Set();
const commandListeners = new Set();
let pendingGisCommand = null;

export function getWorkspaceSettings() {
  return state;
}

export function subscribeWorkspaceSettings(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function updateWorkspaceSettings(patch) {
  state = { ...state, ...patch };
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (err) {
      // Private mode can refuse writes; the in-memory value still applies.
    }
  }
  listeners.forEach(listener => {
    try { listener(state); } catch (err) { /* one bad subscriber must not break the rest */ }
  });
  return state;
}

// Commands are short strings understood by the GIS workspace:
//   tool:measure-distance | tool:draw-polygon | tool:cut-fill | tool:clash ...
//   panel:layers | panel:import | panel:analysis | panel:table | panel:ethiopia
//   map:fit | map:print | export:geojson | export:csv
export function sendGisCommand(command, payload = null) {
  if (!command) return;
  if (commandListeners.size === 0) {
    pendingGisCommand = { command, payload };
    return;
  }
  commandListeners.forEach(listener => {
    try { listener(command, payload); } catch (err) { /* ignore a broken listener */ }
  });
}

export function subscribeGisCommands(listener) {
  commandListeners.add(listener);
  return () => commandListeners.delete(listener);
}

export function consumePendingGisCommand() {
  const pending = pendingGisCommand;
  pendingGisCommand = null;
  return pending;
}
