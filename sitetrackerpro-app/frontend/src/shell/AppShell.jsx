import React, { useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import Icon from '../ui/Icon';

const API_URL = process.env.REACT_APP_API_URL || '';

export const NAV_SECTIONS = [
  {
    label: 'Operations',
    items: [
      { id: 'dashboard', label: 'Overview', icon: 'overview' },
      { id: 'projects', label: 'Projects', icon: 'projects' },
      { id: 'gis', label: 'Map intelligence', icon: 'map' },
      { id: '3d-viewer', label: 'Digital twin', icon: 'cube' }
    ]
  },
  {
    label: 'Delivery',
    items: [
      { id: 'surveying', label: 'Field survey', icon: 'compass' },
      { id: 'quantity-survey', label: 'Quantity survey', icon: 'clipboard' },
      { id: 'project-dashboard', label: 'Progress & budget', icon: 'chart' }
    ]
  },
  {
    label: 'Assurance',
    items: [
      { id: 'fraud', label: 'Risk & fraud', icon: 'shield' },
      { id: 'materials', label: 'Materials', icon: 'box' }
    ]
  },
  {
    label: 'Workspace',
    items: [
      { id: 'bim-import', label: 'BIM import', icon: 'upload' },
      { id: 'account', label: 'Account', icon: 'key' }
    ]
  }
];

const SCREEN_META = {
  dashboard: { label: 'Overview', section: 'Operations', icon: 'overview' },
  projects: { label: 'Projects', section: 'Operations', icon: 'projects' },
  'project-details': { label: 'Project record', section: 'Projects', icon: 'projects' },
  'new-project': { label: 'New project', section: 'Projects', icon: 'plus' },
  gis: { label: 'Map intelligence', section: 'Operations', icon: 'map' },
  '3d-viewer': { label: 'Digital twin', section: 'Operations', icon: 'cube' },
  surveying: { label: 'Field survey', section: 'Delivery', icon: 'compass' },
  'quantity-survey': { label: 'Quantity survey', section: 'Delivery', icon: 'clipboard' },
  'project-dashboard': { label: 'Progress & budget', section: 'Delivery', icon: 'chart' },
  fraud: { label: 'Risk & fraud', section: 'Assurance', icon: 'shield' },
  materials: { label: 'Materials', section: 'Assurance', icon: 'box' },
  'bim-import': { label: 'BIM import', section: 'Workspace', icon: 'upload' },
  account: { label: 'Account', section: 'Workspace', icon: 'key' }
};

export function Brand({ size = 40, withSub = true }) {
  return (
    <div className="brand">
      <div className="brand-mark" style={{ width: size, height: size }}>
        <img src="/logo-mark.png" alt="" />
      </div>
      <div>
        <span className="brand-word">SiteTracker<span>Pro</span></span>
        {withSub && <span className="brand-sub">Infrastructure intelligence</span>}
      </div>
    </div>
  );
}

function initials(name) {
  return String(name || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0])
    .join('')
    .toUpperCase() || 'ST';
}

function compactMoney(value) {
  const amount = Number(value) || 0;
  if (amount >= 1e9) return `${(amount / 1e9).toFixed(1)}B`;
  if (amount >= 1e6) return `${(amount / 1e6).toFixed(1)}M`;
  if (amount >= 1e3) return `${(amount / 1e3).toFixed(0)}k`;
  return amount.toFixed(0);
}

function useOnlineStatus() {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
}

function CommandPalette({ open, onClose, currentScreen, projects, onNavigate, onSelectProject, onOpenAI }) {
  const [query, setQuery] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    const timer = setTimeout(() => inputRef.current?.focus(), 40);
    return () => clearTimeout(timer);
  }, [open]);

  const navResults = useMemo(() => {
    const term = query.trim().toLowerCase();
    return NAV_SECTIONS.flatMap(section => section.items.map(item => ({ ...item, section: section.label })))
      .filter(item => !term || item.label.toLowerCase().includes(term) || item.section.toLowerCase().includes(term));
  }, [query]);

  const projectResults = useMemo(() => {
    const term = query.trim().toLowerCase();
    return projects.filter(project => !term || String(project.name).toLowerCase().includes(term) || String(project.location || '').toLowerCase().includes(term));
  }, [projects, query]);

  if (!open) return null;

  return (
    <div className="overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="command" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="command-search">
          <Icon name="search" size={17} />
          <input
            ref={inputRef}
            value={query}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Escape') onClose();
              if (event.key === 'Enter' && navResults[0]) onNavigate(navResults[0].id);
              if (event.key === 'Enter' && !navResults[0] && projectResults[0]) onSelectProject(projectResults[0]);
            }}
            placeholder="Go to a screen, project or action…"
            aria-label="Search screens and projects"
          />
          <kbd>ESC</kbd>
        </div>

        <div className="command-list">
          {navResults.length > 0 && (
            <>
              <div className="command-section">Navigate</div>
              {navResults.map(item => (
                <button
                  key={item.id}
                  className="command-item"
                  data-active={currentScreen === item.id ? 'true' : undefined}
                  onClick={() => onNavigate(item.id)}
                >
                  <Icon name={item.icon} size={15} />
                  <span className="command-item-copy">
                    <span className="command-item-title">{item.label}</span>
                    <span className="command-item-sub">{item.section}</span>
                  </span>
                  {currentScreen === item.id && <span className="project-status neutral">Current</span>}
                </button>
              ))}
            </>
          )}

          {projectResults.length > 0 && (
            <>
              <div className="command-section">Projects</div>
              {projectResults.slice(0, 6).map(project => (
                <button key={project.id} className="command-item" onClick={() => onSelectProject(project)}>
                  <Icon name="building" size={15} />
                  <span className="command-item-copy">
                    <span className="command-item-title">{project.name}</span>
                    <span className="command-item-sub">{project.location || 'No location'} · ETB {compactMoney(project.budget)}</span>
                  </span>
                </button>
              ))}
            </>
          )}

          {!query && (
            <>
              <div className="command-section">Actions</div>
              <button className="command-item" onClick={() => { onClose(); onOpenAI(); }}>
                <Icon name="sparkles" size={15} />
                <span className="command-item-copy">
                  <span className="command-item-title">Ask Site AI</span>
                  <span className="command-item-sub">Brief, risks and next actions from portfolio data</span>
                </span>
              </button>
              <button className="command-item" onClick={() => onNavigate('new-project')}>
                <Icon name="plus" size={15} />
                <span className="command-item-copy">
                  <span className="command-item-title">Create a project</span>
                  <span className="command-item-sub">Set budget, location and delivery window</span>
                </span>
              </button>
            </>
          )}

          {navResults.length === 0 && projectResults.length === 0 && (
            <div className="empty" style={{ margin: 8 }}>
              <div className="empty-icon"><Icon name="search" /></div>
              <h4>Nothing matched</h4>
              <p>Try a module name, a project name or a location.</p>
            </div>
          )}
        </div>

        <div className="command-footer">
          <span><kbd>↵</kbd> open</span>
          <span><kbd>ESC</kbd> close</span>
          <span style={{ marginLeft: 'auto' }}>Search across the workspace</span>
        </div>
      </div>
    </div>
  );
}

function IntelligenceDock({ open, onClose, token, projects, activeProject, onNavigate }) {
  const [stats, setStats] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const threadRef = useRef(null);

  useEffect(() => {
    if (!open || !token) return;
    let cancelled = false;
    axios.get(`${API_URL}/api/dashboard`, { headers: { Authorization: `Bearer ${token}` } })
      .then(response => { if (!cancelled) setStats(response.data); })
      .catch(() => { if (!cancelled) setStats(null); });
    return () => { cancelled = true; };
  }, [open, token]);

  useEffect(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [messages]);

  const project = activeProject || projects[0] || null;
  const alertCount = Number(stats?.activeAlerts) || 0;
  const totalBudget = projects.reduce((sum, item) => sum + (Number(item.budget) || 0), 0);
  const missingBudgets = projects.filter(item => !Number(item.budget)).length;
  const missingLocations = projects.filter(item => !item.location).length;

  const answerFor = (prompt) => {
    const term = String(prompt).toLowerCase();

    if (term.includes('risk') || term.includes('attention') || term.includes('wrong')) {
      const findings = [];
      if (alertCount > 0) findings.push(`${alertCount} payment risk flag${alertCount === 1 ? '' : 's'} currently need review.`);
      if (missingBudgets > 0) findings.push(`${missingBudgets} project${missingBudgets === 1 ? ' has' : 's have'} no budget, so progress cannot be measured against cost.`);
      if (missingLocations > 0) findings.push(`${missingLocations} project${missingLocations === 1 ? ' is' : 's are'} missing a site location, which weakens map context.`);
      if (findings.length === 0) findings.push('No portfolio-level blockers are visible. Risk flags are clear, budgets are set and every project has a location.');
      return {
        text: 'Here is the current attention picture, grounded in the records loaded in this workspace.',
        bullets: findings,
        followups: ['Brief me on the portfolio', 'Draft an inspection checklist']
      };
    }

    if (term.includes('inspection') || term.includes('checklist') || term.includes('field')) {
      return {
        text: 'A field inspection sequence for this stage of work:',
        bullets: [
          'Confirm control points and the working CRS before capturing new observations.',
          'Photograph access, boundaries and any work covered by the next payment application.',
          'Record quantities against the current BIM take-off, with a note on any variance.',
          'Capture GPS and timestamp evidence for every issue that could affect certification.',
          'Mark the inspection complete only after photos and notes have synced.'
        ],
        followups: ['What needs attention?', 'Summarise project status']
      };
    }

    if (term.includes('budget') || term.includes('cost') || term.includes('spend')) {
      return {
        text: `The active portfolio carries ETB ${totalBudget.toLocaleString(undefined, { maximumFractionDigits: 0 })} across ${projects.length} project${projects.length === 1 ? '' : 's'}.`,
        bullets: [
          project ? `${project.name} is budgeted at ETB ${(Number(project.budget) || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}.` : 'No project is selected.',
          'Open Progress & budget to compare recorded spend against physical progress.',
          'Generate a forecast before certifying the next payment cycle.'
        ],
        followups: ['What needs attention?', 'Brief me on the portfolio']
      };
    }

    if (term.includes('map') || term.includes('gis') || term.includes('location')) {
      return {
        text: 'Map intelligence is the spatial source of truth for the portfolio.',
        bullets: [
          'Check the working CRS and saved georeferencing fit before placing any model geometry.',
          'Use Map intelligence → Map workspace to inspect layers, annotations and the georeferencing preview.',
          'Treat OpenStreetMap context as reference only; survey observations remain the measured record.'
        ],
        followups: ['Summarise project status', 'Draft an inspection checklist']
      };
    }

    if (term.includes('project') || term.includes('status') || term.includes('summary')) {
      if (!project) {
        return {
          text: 'There is no active project in this workspace yet.',
          bullets: ['Create a project to unlock field survey, quantity survey, GIS and digital twin workflows.'],
          followups: ['Brief me on the portfolio']
        };
      }
      return {
        text: `${project.name} is the active project${project.location ? ` in ${project.location}` : ''}.`,
        bullets: [
          `Budget: ETB ${(Number(project.budget) || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}.`,
          'Use Progress & budget to record physical progress and spend, then compare the burn gap.',
          'Use Digital twin to inspect imported components, terrain and model completeness.',
          'Use Risk & fraud before releasing a payment certificate.'
        ],
        followups: ['What needs attention?', 'Draft an inspection checklist']
      };
    }

    return {
      text: `Across ${projects.length} active project${projects.length === 1 ? '' : 's'}, this workspace is managing ETB ${totalBudget.toLocaleString(undefined, { maximumFractionDigits: 0 })}.`,
      bullets: [
        alertCount > 0 ? `${alertCount} risk flag${alertCount === 1 ? '' : 's'} need review.` : 'No payment risk flags are open.',
        missingBudgets > 0 ? `${missingBudgets} project${missingBudgets === 1 ? ' needs' : 's need'} a budget before cost performance can be measured.` : 'Budgets are in place for every project.',
        'The next highest-value move is to review project progress, then inspect spatial evidence before certifying work.'
      ],
      followups: ['What needs attention?', 'Summarise project status', 'Draft an inspection checklist']
    };
  };

  const ask = (prompt) => {
    const question = String(prompt || '').trim();
    if (!question) return;
    const answer = answerFor(question);
    setMessages(current => [...current, { role: 'user', text: question }, { role: 'assistant', ...answer }]);
    setInput('');
  };

  if (!open) return null;

  return (
    <>
      <div className="overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Site AI assistant">
        <div className="drawer-head">
          <div className="brand-mark" style={{ width: 34, height: 34, borderRadius: 10, padding: 2 }}>
            <img src="/logo-mark.png" alt="" />
          </div>
          <div className="drawer-head-copy">
            <h3>Site AI</h3>
            <div className="drawer-sub"><span className="status-dot" /> Grounded in workspace records · preview</div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close assistant"><Icon name="x" /></button>
        </div>

        <div className="drawer-body" ref={threadRef}>
          <div className="ai-context">
            <div className="ai-context-label"><Icon name="sparkles" size={12} /> Operational context</div>
            <p>{project ? `${project.name} is active. Ask for a brief, a risk read or a field checklist.` : 'No project is active yet. Ask about the workspace or create your first project.'}</p>
            <div className="ai-context-meta">
              <span className="chip">{projects.length} project{projects.length === 1 ? '' : 's'}</span>
              <span className="chip">ETB {compactMoney(totalBudget)}</span>
              <span className="chip">{alertCount} risk flag{alertCount === 1 ? '' : 's'}</span>
            </div>
          </div>

          {messages.length === 0 && (
            <>
              <div className="ai-suggestions">
                {['Brief me on the portfolio', 'What needs attention?', 'Summarise project status', 'Draft an inspection checklist'].map(prompt => (
                  <button key={prompt} className="ai-suggestion" onClick={() => ask(prompt)}>
                    <Icon name={prompt.includes('inspection') ? 'clipboard' : prompt.includes('attention') ? 'alert' : prompt.includes('status') ? 'activity' : 'sparkles'} size={14} />
                    {prompt}
                  </button>
                ))}
              </div>

              <div className="ai-signals">
                <div className="ai-signals-label">Live signals</div>
                <div className="ai-signal">
                  <span className="twin-row-icon done"><Icon name="database" size={12} /></span>
                  <span className="twin-row-copy"><strong>Portfolio value</strong><span>ETB {totalBudget.toLocaleString(undefined, { maximumFractionDigits: 0 })} across active budgets</span></span>
                </div>
                <div className="ai-signal">
                  <span className="twin-row-icon"><Icon name="mapPin" size={12} /></span>
                  <span className="twin-row-copy"><strong>Site context</strong><span>{projects.filter(project => project.location).length} of {projects.length} projects have a location</span></span>
                </div>
                <div className="ai-signal">
                  <span className={`twin-row-icon ${alertCount > 0 ? '' : 'done'}`}><Icon name={alertCount > 0 ? 'alert' : 'shield'} size={12} /></span>
                  <span className="twin-row-copy"><strong>Payment assurance</strong><span>{alertCount > 0 ? `${alertCount} risk flags need review` : 'No open payment risk flags'}</span></span>
                </div>
              </div>
            </>
          )}

          <div className="ai-thread">
            {messages.map((message, index) => (
              <div key={index} className={`ai-message ${message.role}`}>
                {message.role === 'assistant' ? (
                  <>
                    <p>{message.text}</p>
                    {message.bullets?.length > 0 && (
                      <ul>{message.bullets.map((item, itemIndex) => <li key={itemIndex}>{item}</li>)}</ul>
                    )}
                    {message.followups?.length > 0 && (
                      <div className="ai-followup">
                        {message.followups.map(followup => (
                          <button key={followup} onClick={() => ask(followup)}>{followup}</button>
                        ))}
                      </div>
                    )}
                  </>
                ) : message.text}
              </div>
            ))}
          </div>
        </div>

        <form className="ai-compose" onSubmit={event => { event.preventDefault(); ask(input); }}>
          <textarea
            value={input}
            onChange={event => setInput(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                ask(input);
              }
            }}
            placeholder="Ask about risk, progress, map evidence…"
            aria-label="Message Site AI"
            rows={1}
          />
          <button type="submit" className="ai-send" disabled={!input.trim()} aria-label="Send message"><Icon name="arrowRight" size={16} /></button>
        </form>
        <div className="ai-disclaimer">Preview intelligence computed from workspace records. Verify before acting or certifying work.</div>

        {!project && (
          <div style={{ padding: '0 14px 12px' }}>
            <button className="btn btn-primary btn-sm" style={{ width: '100%' }} onClick={() => { onClose(); onNavigate('new-project'); }}>
              <Icon name="plus" size={13} /> Create a project
            </button>
          </div>
        )}
      </aside>
    </>
  );
}

export default function AppShell({
  children,
  currentScreen,
  setCurrentScreen,
  token,
  projects,
  activeProject,
  onSelectProject,
  onLogout
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const online = useOnlineStatus();
  const meta = SCREEN_META[currentScreen] || SCREEN_META.dashboard;

  useEffect(() => {
    setMobileOpen(false);
  }, [currentScreen]);

  useEffect(() => {
    const onKey = event => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCommandOpen(true);
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'j') {
        event.preventDefault();
        setAiOpen(true);
      }
      if (event.key === 'Escape') {
        setCommandOpen(false);
        setAiOpen(false);
        setMobileOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const locked = commandOpen || aiOpen || mobileOpen;
  useEffect(() => {
    if (!locked) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [locked]);

  const navigate = (screen) => {
    setCurrentScreen(screen);
    setCommandOpen(false);
    setAiOpen(false);
    setMobileOpen(false);
  };

  const selectProject = (project) => {
    onSelectProject(project);
    navigate('project-details');
  };

  return (
    <div className="app-shell">
      {mobileOpen && <div className="sidebar-backdrop" onClick={() => setMobileOpen(false)} />}
      <aside className={`sidebar ${mobileOpen ? 'open' : ''}`}>
        <button onClick={() => navigate('dashboard')} style={{ background: 'none', border: 0, padding: 0, textAlign: 'left' }} aria-label="SiteTrackerPro home">
          <Brand />
        </button>

        <div className="workspace-switch">
          <div className="workspace-switch-label">
            Active project
            <Icon name="chevronDown" size={12} className="workspace-switch-chevron" />
          </div>
          <select
            value={activeProject?.id || ''}
            onChange={event => {
              const project = projects.find(item => String(item.id) === event.target.value);
              if (project) selectProject(project);
            }}
            aria-label="Active project"
          >
            <option value="">Portfolio · all projects</option>
            {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </div>

        <nav className="nav" aria-label="Primary navigation">
          {NAV_SECTIONS.map(section => (
            <div className="nav-group" key={section.label}>
              <div className="nav-label">{section.label}</div>
              {section.items.map(item => (
                <button
                  key={item.id}
                  className={`nav-item ${currentScreen === item.id ? 'active' : ''}`}
                  onClick={() => navigate(item.id)}
                  aria-current={currentScreen === item.id ? 'page' : undefined}
                >
                  <Icon name={item.icon} size={15} className="nav-icon" />
                  {item.label}
                  {item.id === 'fraud' && Number(0) > 0 && <span className="nav-badge">0</span>}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar-footer">
          <button className="nav-item" onClick={() => navigate('new-project')} style={{ marginBottom: 8 }}>
            <Icon name="plus" size={15} className="nav-icon" />
            New project
          </button>
          <div className="sidebar-user">
            <div className="sidebar-avatar">{initials(activeProject?.name || 'Site Tracker')}</div>
            <div style={{ minWidth: 0 }}>
              <div className="sidebar-user-name">{activeProject?.name || 'Portfolio workspace'}</div>
              <div className="sidebar-user-role">{online ? 'Connected · live records' : 'Offline · local session'}</div>
            </div>
            <button className="sidebar-logout" onClick={onLogout} aria-label="Log out" title="Log out">
              <Icon name="logout" size={14} />
            </button>
          </div>
        </div>
      </aside>

      <div className="app-body">
        <header className="topbar">
          <button className="icon-btn mobile-menu-btn" onClick={() => setMobileOpen(true)} aria-label="Open navigation">
            <Icon name="menu" />
          </button>

          <div className="topbar-breadcrumb">
            <span className="crumb-parent">{meta.section}</span>
            <span className="sep">/</span>
            <strong>{meta.label}</strong>
          </div>

          <div className="topbar-spacer" />

          <button className="search-trigger" onClick={() => setCommandOpen(true)} aria-label="Open command palette">
            <Icon name="search" size={14} />
            Search or jump to…
            <kbd>⌘K</kbd>
          </button>

          <div className="topbar-status" title={online ? 'Connected to the workspace' : 'No network connection'}>
            <span className={`status-dot ${online ? '' : 'offline'}`} />
            {online ? 'Live' : 'Offline'}
          </div>

          <button className="icon-btn" onClick={() => setCommandOpen(true)} aria-label="Search" title="Search (Cmd K)">
            <Icon name="search" size={17} />
          </button>

          <button className="ai-trigger" onClick={() => setAiOpen(true)} title="Site AI (Cmd J)">
            <Icon name="sparkles" size={15} className="spark" />
            <span className="ai-text">Site AI</span>
          </button>

          <div className="topbar-avatar" title="Workspace operator">{initials(activeProject?.name || 'Operator')}</div>
        </header>

        <main className="app-main">{children}</main>
      </div>

      <nav className="mobile-bottom" aria-label="Field navigation">
        {[
          ['dashboard', 'Overview', 'overview'],
          ['gis', 'Map', 'map'],
          ['3d-viewer', 'Twin', 'cube'],
          ['surveying', 'Field', 'compass']
        ].map(([screen, label, icon]) => (
          <button key={screen} className={`mobile-tab ${currentScreen === screen ? 'active' : ''}`} onClick={() => navigate(screen)}>
            <Icon name={icon} size={18} />
            {label}
          </button>
        ))}
        <button className="mobile-tab" onClick={() => setAiOpen(true)}>
          <Icon name="sparkles" size={18} />
          Site AI
        </button>
      </nav>

      <CommandPalette
        open={commandOpen}
        onClose={() => setCommandOpen(false)}
        currentScreen={currentScreen}
        projects={projects}
        onNavigate={navigate}
        onSelectProject={selectProject}
        onOpenAI={() => setAiOpen(true)}
      />
      <IntelligenceDock
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        token={token}
        projects={projects}
        activeProject={activeProject}
        onNavigate={navigate}
      />
    </div>
  );
}
