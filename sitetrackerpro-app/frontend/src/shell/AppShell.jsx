import React, { useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import Icon from '../ui/Icon';
import FeatureGuidePopup from '../ui/FeatureGuidePopup';
import { answerQuestion } from '../ai/siteAi';
import { buildHostedContext, conversationForModel, draftFromAnswer, shouldUseHostedAi } from '../ai/hosted';
import CommandBar from './CommandBar';
import { getWorkspaceSettings, updateWorkspaceSettings } from './workspaceSettings';

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
      { id: 'team', label: 'Team & access', icon: 'shield' },
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
  team: { label: 'Team & access', section: 'Workspace', icon: 'shield' },
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

function compactMoney(value) {
  const amount = Number(value) || 0;
  if (amount >= 1e9) return `${(amount / 1e9).toFixed(1)}B`;
  if (amount >= 1e6) return `${(amount / 1e6).toFixed(1)}M`;
  if (amount >= 1e3) return `${(amount / 1e3).toFixed(0)}k`;
  return amount.toFixed(0);
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
  const [workspace, setWorkspace] = useState({});
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [thinking, setThinking] = useState(false);
  const [shareContext, setShareContext] = useState(true);
  const busyRef = useRef(false);
  const threadRef = useRef(null);
  const project = activeProject || projects[0] || null;

  useEffect(() => {
    if (!open || !token) return;
    let cancelled = false;
    axios.get(`${API_URL}/api/dashboard`, { headers: { Authorization: `Bearer ${token}` } })
      .then(response => { if (!cancelled) setStats(response.data); })
      .catch(() => { if (!cancelled) setStats(null); });
    return () => { cancelled = true; };
  }, [open, token]);

  // Load the records behind the active project so answers cite real progress,
  // quantities, materials, survey points and risk flags rather than a generic brief.
  useEffect(() => {
    if (!open || !token || !project?.id) {
      setWorkspace({});
      return undefined;
    }

    let cancelled = false;
    const headers = { Authorization: `Bearer ${token}` };
    const optional = (url) => axios.get(url, { headers }).catch(() => null);

    setWorkspace({});
    Promise.all([
      optional(`${API_URL}/api/progress/${project.id}`),
      optional(`${API_URL}/api/progress/${project.id}/history`),
      optional(`${API_URL}/api/quantity-survey/${project.id}`),
      optional(`${API_URL}/api/bim/components/${project.id}`),
      optional(`${API_URL}/api/surveying/${project.id}/control-points`),
      optional(`${API_URL}/api/fraud-detection/${project.id}`),
      optional(`${API_URL}/api/bim/${project.id}`),
      optional(`${API_URL}/api/budget/forecast/${project.id}`)
    ]).then(([progress, history, survey, components, points, alerts, models, forecast]) => {
      if (cancelled) return;
      setWorkspace({
        progress: progress?.data || null,
        history: Array.isArray(history?.data) ? history.data : [],
        quantitySurvey: Array.isArray(survey?.data?.items) ? survey.data : null,
        components: Array.isArray(components?.data) ? components.data : [],
        controlPoints: Array.isArray(points?.data) ? points.data : [],
        alerts: Array.isArray(alerts?.data) ? alerts.data : [],
        models: Array.isArray(models?.data) ? models.data : [],
        forecast: forecast?.data || null
      });
    });

    return () => { cancelled = true; };
  }, [open, token, project?.id]);

  useEffect(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [messages]);

  const alertCount = Number(stats?.activeAlerts) || 0;
  const totalBudget = projects.reduce((sum, item) => sum + (Number(item.budget) || 0), 0);

  const answerFor = (prompt) => answerQuestion(prompt, {
    projects,
    project,
    stats,
    ...workspace
  });

  const ask = async (prompt) => {
    const question = String(prompt || '').trim();
    if (!question || busyRef.current) return;

    const local = answerFor(question);
    const history = conversationForModel(messages);
    setMessages(current => [...current, { role: 'user', text: question }]);
    setInput('');

    // Record lookups, app help and engineering maths stay deterministic. Open-ended
    // construction practice and unmatched questions go to the hosted model.
    if (!shouldUseHostedAi(local) || !token) {
      setMessages(current => [...current, { role: 'assistant', ...local }]);
      return;
    }

    busyRef.current = true;
    setThinking(true);
    try {
      const response = await axios.post(`${API_URL}/api/ai/chat`, {
        question,
        context: shareContext ? buildHostedContext({ projects, project, stats, ...workspace }) : null,
        history: shareContext ? history : [],
        draft: shareContext ? draftFromAnswer(local) : ''
      }, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 45000
      });

      const hosted = {
        text: response.data?.answer || 'The hosted AI returned an empty answer.',
        bullets: Array.isArray(response.data?.bullets) ? response.data.bullets.slice(0, 8) : [],
        followups: local.followups || [],
        tag: shareContext ? `Hosted AI · ${response.data?.model || 'GLM'}` : 'Hosted AI · question only'
      };
      setMessages(current => [...current, { role: 'assistant', ...hosted }]);
    } catch (error) {
      const reason = error.response?.data?.error || 'The hosted AI is unavailable right now.';
      const fallback = local.tag === 'Not enough records'
        ? { ...local, text: `${local.text} ${reason}`, tag: 'Hosted AI unavailable' }
        : { ...local, bullets: [...(local.bullets || []), reason], tag: local.tag };
      setMessages(current => [...current, { role: 'assistant', ...fallback }]);
    } finally {
      busyRef.current = false;
      setThinking(false);
    }
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
            <div className="drawer-sub"><span className="status-dot" /> Grounded records · hosted AI for open questions</div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close assistant"><Icon name="x" /></button>
        </div>

        <div className="drawer-body" ref={threadRef}>
          <div className="ai-context">
            <div className="ai-context-label"><Icon name="sparkles" size={12} /> Operational context</div>
            <p>{project ? `${project.name} is active. Ask for progress, quantities, risk or an engineering take-off.` : 'No project is active yet. Ask about the workspace or create your first project.'}</p>
            <div className="ai-context-meta">
              <span className="chip">{projects.length} project{projects.length === 1 ? '' : 's'}</span>
              <span className="chip">ETB {compactMoney(totalBudget)}</span>
              <span className="chip">{alertCount} risk flag{alertCount === 1 ? '' : 's'}</span>
            </div>
          </div>

          <label className="ai-privacy">
            <input
              type="checkbox"
              checked={shareContext}
              onChange={event => setShareContext(event.target.checked)}
            />
            <span>
              <strong>Share project summary</strong>
              <small>Progress notes are never sent. Turn this off to send only your question and no chat history.</small>
            </span>
          </label>

          {messages.length === 0 && (
            <>
              <div className="ai-suggestions">
                {[
                  'Cost performance of the active project',
                  'Concrete for 10 m³ C25',
                  'Quantities on the active project',
                  'What needs attention?',
                  'Draft an inspection checklist'
                ].map(prompt => (
                  <button key={prompt} className="ai-suggestion" onClick={() => ask(prompt)} disabled={thinking}>
                    <Icon name={prompt.includes('inspection') ? 'clipboard' : prompt.includes('attention') ? 'alert' : prompt.includes('Concrete') ? 'box' : prompt.includes('Quantities') ? 'database' : 'activity'} size={14} />
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

          <div className="ai-thread" aria-live="polite">
            {messages.map((message, index) => (
              <div key={index} className={`ai-message ${message.role}`}>
                {message.role === 'assistant' ? (
                  <>
                    <p>{message.text}</p>
                    {message.bullets?.length > 0 && (
                      <ul>{message.bullets.map((item, itemIndex) => <li key={itemIndex}>{item}</li>)}</ul>
                    )}
                    {message.tag && <div className="ai-tag">{message.tag}</div>}
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
            {thinking && (
              <div className="ai-message assistant ai-thinking">
                <span className="ai-dot" /><span className="ai-dot" /><span className="ai-dot" />
                <span>Asking the hosted AI…</span>
              </div>
            )}
          </div>
        </div>

        <form className="ai-compose" onSubmit={event => { event.preventDefault(); if (!thinking) ask(input); }}>
          <textarea
            value={input}
            onChange={event => setInput(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                if (!thinking) ask(input);
              }
            }}
            placeholder="Ask anything about the project or construction…"
            aria-label="Message Site AI"
            rows={1}
          />
          <button type="submit" className="ai-send" disabled={!input.trim() || thinking} aria-label="Send message"><Icon name="arrowRight" size={16} /></button>
        </form>
        <div className="ai-disclaimer">Grounded in workspace records, with hosted AI for open questions. Progress notes stay out of hosted requests. Verify before acting or certifying work.</div>

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

const TAB_FOR_SCREEN = {
  gis: 'map',
  '3d-viewer': 'bim',
  surveying: 'control',
  team: 'reports'
};

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
  const [commandOpen, setCommandOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [guideTrigger, setGuideTrigger] = useState(0);
  const [theme, setTheme] = useState(() => getWorkspaceSettings().gisTheme);
  const [activeTab, setActiveTab] = useState(() => TAB_FOR_SCREEN[currentScreen] || '');
  const meta = SCREEN_META[currentScreen] || SCREEN_META.dashboard;

  // The theme is a document-level attribute so the map, glass panels and telemetry bar all
  // re-style together, including the MapLibre controls.
  useEffect(() => {
    document.documentElement.dataset.gisTheme = theme;
    return () => { delete document.documentElement.dataset.gisTheme; };
  }, [theme]);

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
      if (event.key === '?' && !event.metaKey && !event.ctrlKey) {
        const tag = String(event.target?.tagName || '').toLowerCase();
        if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') {
          event.preventDefault();
          setGuideTrigger(value => value + 1);
        }
      }
      if (event.key === 'Escape') {
        setCommandOpen(false);
        setAiOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const locked = commandOpen || aiOpen;
  useEffect(() => {
    if (!locked) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [locked]);

  const navigate = (screen, tabId) => {
    setCurrentScreen(screen);
    setActiveTab(tabId || TAB_FOR_SCREEN[screen] || '');
    setCommandOpen(false);
    setAiOpen(false);
  };

  const selectProject = (project) => {
    onSelectProject(project);
    navigate('project-details');
  };

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    updateWorkspaceSettings({ gisTheme: next });
    // Keep the basemap in step unless the operator chose imagery on purpose.
    const current = getWorkspaceSettings().basemap;
    if (['dark', 'light', 'street'].includes(current)) {
      updateWorkspaceSettings({ basemap: next === 'dark' ? 'dark' : 'street' });
    }
  };

  return (
    <div className="app-shell app-shell--command">
      <CommandBar
        token={token}
        currentScreen={currentScreen}
        navigate={navigate}
        meta={meta}
        navSections={NAV_SECTIONS}
        projects={projects}
        activeProject={activeProject}
        onSelectProject={selectProject}
        onLogout={onLogout}
        onOpenCommand={() => setCommandOpen(true)}
        onOpenAI={() => setAiOpen(true)}
        onOpenGuide={() => setGuideTrigger(value => value + 1)}
        theme={theme}
        onToggleTheme={toggleTheme}
        activeTab={activeTab}
      />

      <main className={`app-main${currentScreen === 'gis' ? ' app-main--gis' : ''}`}>{children}</main>

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
      <FeatureGuidePopup screen={currentScreen} trigger={guideTrigger} onNavigate={navigate} />
    </div>
  );
}
