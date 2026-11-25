import React, { useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import Icon from '../ui/Icon';
import { BASEMAP_CHOICES } from '../gis/basemaps';
import { getWorkspaceSettings, sendGisCommand, updateWorkspaceSettings } from './workspaceSettings';

const API_URL = process.env.REACT_APP_API_URL || '';

// The five workspace modes requested for the command centre. Terrain opens the map with the
// earthworks tool already active; control points opens the survey screen, where observations live.
export const MODE_TABS = [
  { id: 'map', label: 'Map & GIS', screen: 'gis' },
  { id: 'bim', label: '3D BIM / IFC', screen: '3d-viewer' },
  { id: 'terrain', label: 'Terrain & Survey', screen: 'gis', command: 'tool:cut-fill' },
  { id: 'control', label: 'Control Points', screen: 'surveying' },
  { id: 'reports', label: 'Reports & Team', screen: 'team' }
];

const ROLE_LABELS = { admin: 'Admin', analyst: 'Analyst', viewer: 'Viewer' };

function initials(name) {
  return String(name || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0])
    .join('')
    .toUpperCase() || 'ST';
}

function MenuItem({ item, onDone }) {
  const [open, setOpen] = useState(false);
  const [flip, setFlip] = useState(false);
  const timer = useRef(null);
  const submenuRef = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  // Smart boundary detection: a nested submenu that would leave the viewport opens inward.
  useEffect(() => {
    if (!open || !submenuRef.current) return;
    const rect = submenuRef.current.getBoundingClientRect();
    setFlip(rect.right > window.innerWidth - 8);
  }, [open]);

  if (item.divider) return <div className="cmd-menu-divider" role="separator" />;

  if (Array.isArray(item.submenu)) {
    return (
      <div
        className="cmd-menu-row has-sub"
        onMouseEnter={() => { clearTimeout(timer.current); setOpen(true); }}
        onMouseLeave={() => { timer.current = setTimeout(() => setOpen(false), 120); }}
      >
        <button type="button" className="cmd-menu-item" aria-haspopup="menu" aria-expanded={open}
          onClick={() => setOpen(value => !value)}>
          <Icon name={item.icon || 'chevronRight'} size={14} />
          <span>{item.label}</span>
          <Icon name="chevronRight" size={13} className="cmd-menu-caret" />
        </button>
        {open && (
          <div className={`cmd-submenu${flip ? ' flip' : ''}`} role="menu" ref={submenuRef}>
            {item.submenu.map(sub => (
              <button
                key={sub.label}
                type="button"
                className="cmd-menu-item"
                role="menuitem"
                onClick={() => { onDone(); if (sub.run) sub.run(); }}
              >
                {sub.icon ? <Icon name={sub.icon} size={14} /> : <span className="cmd-menu-dot" />}
                <span>{sub.label}</span>
                {sub.hint && <kbd>{sub.hint}</kbd>}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <button
      type="button"
      className="cmd-menu-item"
      role="menuitem"
      disabled={item.disabled}
      onClick={() => { onDone(); if (item.run) item.run(); }}
    >
      <Icon name={item.icon || 'chevronRight'} size={14} />
      <span>{item.label}</span>
      {item.hint && <kbd>{item.hint}</kbd>}
    </button>
  );
}

export default function CommandBar({
  token,
  currentScreen,
  navigate,
  meta,
  navSections = [],
  projects = [],
  activeProject,
  onSelectProject,
  onLogout,
  onOpenCommand,
  onOpenAI,
  onOpenGuide,
  theme,
  onToggleTheme,
  activeTab
}) {
  const [role, setRole] = useState('');
  const [menu, setMenu] = useState(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [basemapOpen, setBasemapOpen] = useState(false);
  const [modulesOpen, setModulesOpen] = useState(false);
  const [basemap, setBasemap] = useState(() => getWorkspaceSettings().basemap);
  const rootRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    if (!token) { setRole(''); return undefined; }
    axios.get(`${API_URL}/auth/me`, { headers: { Authorization: `Bearer ${token}` } })
      .then(response => { if (!cancelled) setRole(response.data?.role || ''); })
      .catch(() => { if (!cancelled) setRole(''); });
    return () => { cancelled = true; };
  }, [token]);

  // Click-outside and Escape dismissal for every popover in the bar.
  useEffect(() => {
    const onDown = event => {
      if (rootRef.current && !rootRef.current.contains(event.target)) {
        setMenu(null); setProfileOpen(false); setBasemapOpen(false); setModulesOpen(false);
      }
    };
    const onKey = event => {
      if (event.key === 'Escape') {
        setMenu(null); setProfileOpen(false); setBasemapOpen(false); setModulesOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  const goGis = (command) => {
    if (currentScreen !== 'gis') navigate('gis');
    // The workspace may still be mounting; the command waits for it.
    window.setTimeout(() => sendGisCommand(command), 0);
  };

  const chooseBasemap = (id) => {
    setBasemap(id);
    updateWorkspaceSettings({ basemap: id });
    sendGisCommand(`basemap:${id}`);
    setBasemapOpen(false);
    if (currentScreen !== 'gis') navigate('gis');
  };

  const menus = useMemo(() => ([
    {
      label: 'File',
      items: [
        { label: 'New project', icon: 'plus', hint: 'N', run: () => navigate('new-project') },
        {
          label: 'Import / Export',
          icon: 'upload',
          submenu: [
            { label: 'Import GeoJSON / CSV / DXF', icon: 'upload', run: () => goGis('panel:import') },
            { label: 'Export active layer (GeoJSON)', icon: 'download', run: () => goGis('export:geojson') },
            { label: 'Export attribute table (CSV)', icon: 'download', run: () => goGis('export:csv') },
            { label: 'BIM / IFC import', icon: 'cube', run: () => navigate('bim-import') }
          ]
        },
        { label: 'Print layout', icon: 'file', hint: 'P', run: () => goGis('map:print') },
        { divider: true },
        { label: 'Account & security', icon: 'key', run: () => navigate('account') },
        { label: 'Team & access', icon: 'shield', run: () => navigate('team') }
      ]
    },
    {
      label: 'Layers',
      items: [
        { label: 'Toggle layer & asset tree', icon: 'layers', hint: 'L', run: () => goGis('panel:layers') },
        { label: 'Attribute table', icon: 'database', run: () => goGis('panel:table') },
        { label: 'Ethiopia coverage', icon: 'globe', run: () => goGis('panel:ethiopia') },
        { label: 'Survey control points', icon: 'compass', run: () => navigate('surveying') },
        { label: 'Georeferencing', icon: 'target', run: () => goGis('panel:georef') }
      ]
    },
    {
      label: 'Analysis',
      items: [
        { label: 'Measure distance', icon: 'ruler', hint: 'M', run: () => goGis('tool:measure-distance') },
        { label: 'Measure area', icon: 'ruler', run: () => goGis('tool:measure-area') },
        { label: 'Buffer / clip / intersect', icon: 'layers', run: () => goGis('panel:analysis') },
        { divider: true },
        { label: 'Cut & fill volumes', icon: 'mountain', hint: 'C', run: () => goGis('tool:cut-fill') },
        { label: 'Clash & encroachment', icon: 'alert', hint: 'K', run: () => goGis('tool:clash') },
        { label: 'Slope hazards', icon: 'activity', run: () => goGis('tool:clash-slope') }
      ]
    },
    {
      label: 'View',
      items: [
        { label: theme === 'dark' ? 'Light GIS theme' : 'Dark GIS theme', icon: theme === 'dark' ? 'sun' : 'moon', run: onToggleTheme },
        {
          label: 'Basemap',
          icon: 'map',
          submenu: BASEMAP_CHOICES.filter(choice => !choice.local).map(choice => ({
            label: choice.label,
            icon: 'map',
            run: () => chooseBasemap(choice.id)
          }))
        },
        { divider: true },
        { label: 'Toggle left panel', icon: 'panel', run: () => goGis('panel:layers') },
        { label: 'Toggle inspector', icon: 'panel', run: () => goGis('panel:inspector') },
        { label: 'Fit project extent', icon: 'maximize', hint: 'F', run: () => goGis('map:fit') }
      ]
    },
    {
      label: 'CAD / BIM',
      items: [
        { label: 'Import BIM / IFC model', icon: 'cube', run: () => navigate('bim-import') },
        { label: 'Open digital twin', icon: 'cube', run: () => navigate('3d-viewer') },
        { divider: true },
        { label: 'Export layer to DXF', icon: 'download', hint: '⌘D', run: () => goGis('export:dxf') },
        { label: 'Export layer to KML', icon: 'globe', run: () => goGis('export:kml') },
        { label: 'Export layer to Shapefile', icon: 'layers', run: () => goGis('export:shp') },
        { label: 'Import DXF / KML / Shapefile', icon: 'upload', run: () => goGis('panel:import') }
      ]
    },
    {
      label: 'Reports',
      items: [
        { label: 'Progress & budget', icon: 'chart', run: () => navigate('project-dashboard') },
        { label: 'Quantity survey', icon: 'clipboard', run: () => navigate('quantity-survey') },
        { label: 'Risk & fraud', icon: 'shield', run: () => navigate('fraud') },
        { label: 'Print layout', icon: 'file', hint: 'P', run: () => goGis('map:print') }
      ]
    },
    {
      label: 'Team',
      items: [
        { label: 'Team & access', icon: 'shield', run: () => navigate('team') },
        { label: 'Account & security', icon: 'key', run: () => navigate('account') },
        { divider: true },
        { label: 'Feature guide', icon: 'help', hint: '?', run: () => onOpenGuide?.() },
        { label: 'Site AI', icon: 'sparkles', hint: '⌘J', run: () => onOpenAI?.() }
      ]
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ]), [theme, currentScreen]);

  const roleLabel = ROLE_LABELS[role] || 'Member';

  // Tier 2 is the contextual ribbon: the same 40px strip swaps its actions with the active mode,
  // the way ArcGIS Pro's ribbon tabs and AutoCAD Web's contextual panels do.
  const ribbonActions = {
    map: [
      { label: 'Fit', icon: 'maximize', run: () => goGis('map:fit') },
      { label: 'Layers', icon: 'layers', run: () => goGis('panel:layers') },
      { label: 'Inspector', icon: 'panel', run: () => goGis('panel:inspector') },
      { label: 'Import', icon: 'upload', run: () => goGis('panel:import') },
      { label: 'Export DXF', icon: 'download', run: () => goGis('export:dxf') },
      { label: 'Print', icon: 'file', run: () => goGis('map:print') }
    ],
    bim: [
      { label: 'Import model', icon: 'upload', run: () => navigate('bim-import') },
      { label: 'Open twin', icon: 'cube', run: () => navigate('3d-viewer') },
      { label: 'Place on map', icon: 'target', run: () => goGis('panel:georef') }
    ],
    terrain: [
      { label: 'Cut & fill', icon: 'mountain', run: () => goGis('tool:cut-fill') },
      { label: 'Clash check', icon: 'alert', run: () => goGis('tool:clash') },
      { label: 'Slope hazards', icon: 'activity', run: () => goGis('tool:clash-slope') },
      { label: 'Export DXF', icon: 'download', run: () => goGis('export:dxf') }
    ],
    control: [
      { label: 'Control points', icon: 'compass', run: () => navigate('surveying') },
      { label: 'Fit on map', icon: 'maximize', run: () => goGis('map:fit') }
    ],
    reports: [
      { label: 'Progress', icon: 'chart', run: () => navigate('project-dashboard') },
      { label: 'Risk register', icon: 'shield', run: () => navigate('fraud') },
      { label: 'Team', icon: 'shield', run: () => navigate('team') }
    ]
  }[activeTab] || [];

  return (
    <header className="cmdbar" ref={rootRef} data-screen={currentScreen}>
      <div className="cmdbar-tier cmdbar-tier--title">
      <div className="cmdbar-left">
        <button type="button" className="cmdbar-brand" onClick={() => navigate('dashboard')} aria-label="SiteTrackerPro overview">
          <span className="cmdbar-mark"><img src="/logo-mark.png" alt="" /></span>
          <span className="cmdbar-word">SiteTracker<span>Pro</span></span>
        </button>

        <div className="cmd-modules">
          <button
            type="button"
            className={`cmd-modules-btn${modulesOpen ? ' open' : ''}`}
            onClick={() => { setModulesOpen(value => !value); setMenu(null); setProfileOpen(false); setBasemapOpen(false); }}
            aria-haspopup="menu"
            aria-expanded={modulesOpen}
            title="All modules"
          >
            <Icon name="menu" size={15} />
          </button>
          {modulesOpen && (
            <div className="cmd-menu cmd-modules-menu" role="menu">
              {navSections.map(section => (
                <React.Fragment key={section.label}>
                  <div className="cmd-menu-section">{section.label}</div>
                  {section.items.map(item => (
                    <button
                      key={item.id}
                      type="button"
                      className="cmd-menu-item"
                      data-active={currentScreen === item.id ? 'true' : undefined}
                      role="menuitem"
                      onClick={() => { setModulesOpen(false); navigate(item.id); }}
                    >
                      <Icon name={item.icon} size={14} />
                      <span>{item.label}</span>
                      {currentScreen === item.id && <span className="cmd-menu-current">Current</span>}
                    </button>
                  ))}
                </React.Fragment>
              ))}
            </div>
          )}
        </div>

        <div className="cmd-project">
          <label className="cmd-project-label" htmlFor="cmd-project-select">
            <Icon name="building" size={12} /> Project
          </label>
          <select
            id="cmd-project-select"
            value={activeProject?.id || ''}
            onChange={event => {
              const project = projects.find(item => String(item.id) === event.target.value);
              if (project) { onSelectProject(project); navigate('project-details'); }
            }}
          >
            <option value="">Portfolio · all projects</option>
            {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </div>

        <nav className="cmd-menubar" aria-label="Application menus">
          {menus.map(group => (
            <div className="cmd-menu-root" key={group.label}>
              <button
                type="button"
                className={`cmd-menu-trigger${menu === group.label ? ' open' : ''}`}
                aria-haspopup="menu"
                aria-expanded={menu === group.label}
                onClick={() => { setMenu(menu === group.label ? null : group.label); setProfileOpen(false); setBasemapOpen(false); setModulesOpen(false); }}
              >
                {group.label}
              </button>
              {menu === group.label && (
                <div className="cmd-menu cmd-menubar-menu" role="menu">
                  {group.items.map((item, index) => (
                    <MenuItem key={item.label || `divider-${index}`} item={item} onDone={() => setMenu(null)} />
                  ))}
                </div>
              )}
            </div>
          ))}
        </nav>
      </div>

      <div className="cmdbar-center">
        <span className="cmd-breadcrumb" aria-label="Location">
          <span className="cmd-crumb-parent">{activeProject?.name || 'Portfolio'}</span>
          <span className="cmd-crumb-sep">›</span>
          <strong>{meta?.label || 'Overview'}</strong>
        </span>
      </div>

      <div className="cmdbar-right">
        <button type="button" className="cmd-icon" onClick={onOpenCommand} title="Command palette (Ctrl+K)" aria-label="Command palette">
          <Icon name="search" size={15} />
          <kbd>⌘K</kbd>
        </button>

        <div className="cmd-popover-wrap">
          <button
            type="button"
            className={`cmd-icon${basemapOpen ? ' open' : ''}`}
            onClick={() => { setBasemapOpen(value => !value); setMenu(null); setProfileOpen(false); setModulesOpen(false); }}
            title="Basemap"
            aria-haspopup="menu"
            aria-expanded={basemapOpen}
          >
            <Icon name="satellite" size={15} />
          </button>
          {basemapOpen && (
            <div className="cmd-menu cmd-basemap-menu" role="menu">
              <div className="cmd-menu-section">Basemap</div>
              {BASEMAP_CHOICES.map(choice => (
                <button
                  key={choice.id}
                  type="button"
                  role="menuitem"
                  className="cmd-menu-item"
                  data-active={basemap === choice.id ? 'true' : undefined}
                  onClick={() => chooseBasemap(choice.id)}
                >
                  <Icon name="map" size={14} />
                  <span>{choice.label}</span>
                  {basemap === choice.id && <Icon name="check" size={13} />}
                </button>
              ))}
              <div className="cmd-menu-divider" role="separator" />
              <button type="button" role="menuitem" className="cmd-menu-item" onClick={() => { onToggleTheme(); setBasemapOpen(false); }}>
                <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={14} />
                <span>{theme === 'dark' ? 'Light GIS theme' : 'Dark GIS theme'}</span>
              </button>
            </div>
          )}
        </div>

        <button type="button" className="cmd-icon" onClick={onToggleTheme} title={`${theme === 'dark' ? 'Light' : 'Dark'} GIS theme`} aria-label="Toggle GIS theme">
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={15} />
        </button>

        <span className={`cmd-role role-${role || 'member'}`} title="Your access level">
          {roleLabel}
        </span>

        <div className="cmd-popover-wrap">
          <button
            type="button"
            className="cmd-avatar"
            onClick={() => { setProfileOpen(value => !value); setMenu(null); setBasemapOpen(false); setModulesOpen(false); }}
            aria-haspopup="menu"
            aria-expanded={profileOpen}
            title="Profile menu"
          >
            {initials(activeProject?.name || 'Operator')}
          </button>
          {profileOpen && (
            <div className="cmd-menu cmd-profile-menu" role="menu">
              <div className="cmd-profile-head">
                <strong>Workspace operator</strong>
                <small>{roleLabel} · {activeProject?.name || 'Portfolio'}</small>
              </div>
              <button type="button" role="menuitem" className="cmd-menu-item" onClick={() => { setProfileOpen(false); navigate('account'); }}>
                <Icon name="key" size={14} /><span>Account &amp; security</span>
              </button>
              <button type="button" role="menuitem" className="cmd-menu-item" onClick={() => { setProfileOpen(false); navigate('team'); }}>
                <Icon name="shield" size={14} /><span>Team &amp; access</span>
              </button>
              <button type="button" role="menuitem" className="cmd-menu-item" onClick={() => { setProfileOpen(false); onOpenGuide?.(); }}>
                <Icon name="help" size={14} /><span>Feature guide</span><kbd>?</kbd>
              </button>
              <button type="button" role="menuitem" className="cmd-menu-item" onClick={() => { setProfileOpen(false); onOpenAI?.(); }}>
                <Icon name="sparkles" size={14} /><span>Site AI</span><kbd>⌘J</kbd>
              </button>
              <div className="cmd-menu-divider" role="separator" />
              <button type="button" role="menuitem" className="cmd-menu-item danger" onClick={onLogout}>
                <Icon name="logout" size={14} /><span>Log out</span>
              </button>
            </div>
          )}
        </div>
      </div>
      </div>

      <div className="cmdbar-tier cmdbar-tier--ribbon">
        <div className="cmd-tabs" role="tablist" aria-label="Workspace mode">
          {MODE_TABS.map(tab => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              className={`cmd-tab${activeTab === tab.id ? ' active' : ''}`}
              aria-selected={activeTab === tab.id}
              onClick={() => {
                navigate(tab.screen, tab.id);
                if (tab.command) window.setTimeout(() => sendGisCommand(tab.command), 0);
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="cmd-ribbon-actions" role="toolbar" aria-label="Contextual actions">
          {ribbonActions.map(action => (
            <button
              key={action.label}
              type="button"
              className="cmd-ribbon-btn"
              onClick={action.run}
              title={action.label}
            >
              <Icon name={action.icon} size={14} />
              <span>{action.label}</span>
            </button>
          ))}
        </div>
      </div>
    </header>
  );
}
