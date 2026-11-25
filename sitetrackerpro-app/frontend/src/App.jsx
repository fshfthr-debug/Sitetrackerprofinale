
import React, { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import GisWorkspace from './gis/GisWorkspace';
import AppShell, { Brand } from './shell/AppShell';
import Icon from './ui/Icon';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { buildCsv, downloadCsv, safeFilePart, todayStamp } from './csv';
import { CONTROL_POINT_STATUSES, INITIAL_CONTROL_POINT_STATUSES, parseControlPointText, statusLabel } from './controlPoints';

const BimViewer = React.lazy(() => import('./BimViewer'));

// Relative by default: the CRA dev server proxies /api and /auth to the backend
// (see "proxy" in package.json), and in production the build is served from the
// same origin as the API. Set REACT_APP_API_URL only to point at a separate host.
const API_URL = process.env.REACT_APP_API_URL || '';

// PostgreSQL returns DECIMAL/NUMERIC columns as strings (e.g. "6000.00"), and a
// string has no .toFixed(). Coerce anything before formatting it.
const num = (value) => {
  const parsed = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const fmt = (value, decimals = 0) => num(value).toFixed(decimals);
const money = (value) => num(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ratesMissing = (lines) => (lines || []).some(line => !line.priced);

// ===================== MAIN APPLICATION COMPONENT =====================
export default function SiteTrackerPro() {
  const [currentScreen, setCurrentScreen] = useState('dashboard');
  const [token, setToken] = useState(localStorage.getItem('token'));
  const [projects, setProjects] = useState([]);
  const [selectedProject, setSelectedProject] = useState(null);
  const [projectsError, setProjectsError] = useState('');
  const [sessionExpired, setSessionExpired] = useState(false);

  // A reset link opens the app as /?reset=<token>. That screen comes first, even
  // when an old session is still stored, so the link always does what it says.
  const [resetToken, setResetToken] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('reset') || '';
  });
  const [resetNotice, setResetNotice] = useState('');

  const finishReset = (notice = '') => {
    window.history.replaceState({}, '', window.location.pathname);
    setResetToken('');
    setResetNotice(notice);
  };

  useEffect(() => {
    if (token) {
      fetchProjects();
    }
  }, [token]);

  // A token that has expired must send the user back to sign-in. Without this the
  // portfolio simply looked empty, which reads as "my projects are gone". A wrong
  // current password also answers 401, so only the token errors end the session.
  useEffect(() => {
    const interceptor = axios.interceptors.response.use(
      (response) => response,
      (error) => {
        const status = error.response?.status;
        const message = error.response?.data?.error;
        if (status === 401 && (message === 'Invalid token' || message === 'No token')) {
          localStorage.removeItem('token');
          setSessionExpired(true);
          setToken(null);
        }
        return Promise.reject(error);
      }
    );
    return () => axios.interceptors.response.eject(interceptor);
  }, []);

  const fetchProjects = async () => {
    try {
      const response = await axios.get(`${API_URL}/api/projects`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setProjects(response.data);
      setProjectsError('');
      return response.data;
    } catch (err) {
      console.error('Error fetching projects:', err);
      setProjectsError(err.response?.data?.error || 'Could not load your projects. Check the connection and try again.');
      return null;
    }
  };

  if (resetToken) {
    return <ResetPasswordScreen token={resetToken} onDone={finishReset} />;
  }

  if (!token) {
    return (
      <AuthScreen
        setToken={(nextToken) => { setSessionExpired(false); setResetNotice(''); setToken(nextToken); }}
        sessionExpired={sessionExpired}
        notice={resetNotice}
      />
    );
  }

  const activeProject = selectedProject || projects[0] || null;

  return (
    <AppShell
      currentScreen={currentScreen}
      setCurrentScreen={setCurrentScreen}
      token={token}
      projects={projects}
      activeProject={activeProject}
      onSelectProject={setSelectedProject}
      onLogout={() => { localStorage.removeItem('token'); setToken(null); }}
    >
      {currentScreen === 'dashboard' && (
        <DashboardScreen
          token={token}
          projects={projects}
          activeProject={activeProject}
          setSelectedProject={setSelectedProject}
          setCurrentScreen={setCurrentScreen}
        />
      )}
      {currentScreen === 'projects' && <ProjectsScreen token={token} projects={projects} projectsError={projectsError} fetchProjects={fetchProjects} setSelectedProject={setSelectedProject} setCurrentScreen={setCurrentScreen} />}
      {currentScreen === 'project-details' && (
        <ProjectDetailsScreen
          token={token}
          project={selectedProject}
          setCurrentScreen={setCurrentScreen}
          onProjectUpdated={(updated) => { setSelectedProject(updated); fetchProjects(); }}
          onProjectDeleted={(id) => {
            setSelectedProject(null);
            setProjects((list) => list.filter((item) => item.id !== id));
            setCurrentScreen('projects');
          }}
        />
      )}
      {currentScreen === 'new-project' && <NewProjectScreen token={token} fetchProjects={fetchProjects} setCurrentScreen={setCurrentScreen} />}
      {currentScreen === 'bim-import' && <BimImportScreen token={token} projects={projects} />}
      {currentScreen === 'quantity-survey' && <QuantitySurveyScreen token={token} projects={projects} />}
      {currentScreen === 'project-dashboard' && <ProjectDashboardScreen token={token} projects={projects} setCurrentScreen={setCurrentScreen} setSelectedProject={setSelectedProject} />}
      {currentScreen === 'surveying' && <SurveyingControlPointsScreen token={token} projects={projects} />}
      {currentScreen === '3d-viewer' && <ThreeDViewerScreen token={token} projects={projects} />}
      {currentScreen === 'gis' && <GisWorkspace token={token} projects={projects} />}
      {currentScreen === 'materials' && <MaterialsDatabaseScreen token={token} projects={projects} />}
      {currentScreen === 'fraud' && <FraudDetectionScreen token={token} projects={projects} />}
      {currentScreen === 'team' && <TeamScreen token={token} />}
      {currentScreen === 'account' && <AccountScreen token={token} />}
    </AppShell>
  );
}

// ===================== AUTHENTICATION SCREEN =====================
function AuthScreen({ setToken, sessionExpired = false, notice = '' }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [company, setCompany] = useState('');
  const [isLogin, setIsLogin] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);
  const [resetMessage, setResetMessage] = useState('');
  const [resetDelivery, setResetDelivery] = useState('');
  // Second-factor states: a password-only sign-in lands in one of these instead of the app.
  const [challenge, setChallenge] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [enrollment, setEnrollment] = useState(null);
  const [enrollCode, setEnrollCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState(null);
  const [pendingToken, setPendingToken] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const endpoint = isLogin ? '/auth/login' : '/auth/register';
      const response = await axios.post(`${API_URL}${endpoint}`, {
        email,
        password,
        fullName: !isLogin ? fullName : undefined,
        company: !isLogin ? company.trim() || undefined : undefined
      });

      const data = response.data || {};

      // A password is only the first factor for an account with an authenticator; a role that
      // must use one but has not enrolled yet gets a session that can only finish the setup.
      if (data.mfaRequired) {
        setChallenge(data.challenge);
        setMfaCode('');
        return;
      }
      if (data.mfaSetupRequired) {
        await beginEnrollment(data.token);
        return;
      }

      localStorage.setItem('token', data.token);
      setToken(data.token);
    } catch (err) {
      // The server can return several password problems at once; show them all.
      const data = err.response?.data;
      const detail = Array.isArray(data?.problems) && data.problems.length > 1
        ? data.problems.join(' ')
        : data?.error || err.message;
      setError(detail);
    } finally {
      setBusy(false);
    }
  };

  // Sends the reset link. The reply is the same whether or not the address has an
  // account, so this form cannot be used to discover who is registered.
  const handleForgot = async (e) => {
    e.preventDefault();
    setError('');
    setResetMessage('');
    setBusy(true);
    try {
      const response = await axios.post(`${API_URL}/auth/forgot-password`, { email: email.trim() });
      setResetMessage(response.data?.message || 'If that email address has an account, a reset link is on its way.');
      setResetDelivery(response.data?.delivery || '');
    } catch (err) {
      const data = err.response?.data;
      setError(data?.error || 'Could not send the reset link. Check the connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  // Where to look for the link when mail could not be sent from this deployment.
  const deliveryHint = (delivery) => {
    if (delivery === 'log' || delivery === 'failed') {
      return 'Email sending is not set up on this server, so the link was written to its log. ' +
        'Open the service in Render, choose Logs, and copy the line that starts with [password-reset]. ' +
        'It expires in one hour.';
    }
    return 'The link works once and expires in one hour. If it has not arrived in a few minutes, check your spam folder.';
  };

  const beginEnrollment = async (authToken) => {
    setSetupToken(authToken);
    const response = await axios.post(`${API_URL}/auth/mfa/setup`, {}, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    setEnrollment(response.data);
  };

  const submitTotp = async (event) => {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const response = await axios.post(`${API_URL}/auth/login/mfa`, { challenge, code: mfaCode });
      localStorage.setItem('token', response.data.token);
      setToken(response.data.token);
    } catch (err) {
      setError(err.response?.data?.error || 'That code was not accepted. Use the next one from your app.');
    } finally {
      setBusy(false);
    }
  };

  const confirmEnrollment = async (event) => {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const response = await axios.post(`${API_URL}/auth/mfa/enable`, { code: enrollCode }, {
        headers: { Authorization: `Bearer ${setupToken}` }
      });
      setRecoveryCodes(response.data.recoveryCodes || []);
      setPendingToken(response.data.token);
    } catch (err) {
      setError(err.response?.data?.error || 'That code was not accepted. Wait for the next one and try again.');
    } finally {
      setBusy(false);
    }
  };

  // Administrators finish here rather than in the app, because until they do, their session
  // is allowed to do nothing else.
  if (challenge) {
    return (
      <div className="auth auth-single">
        <section className="auth-panel">
          <div className="auth-form">
            <Brand size={42} />
            <h2>Enter your code</h2>
            <p className="auth-form-sub">
              Open your authenticator app and type the 6-digit code for {email}.
            </p>
            <form onSubmit={submitTotp}>
              <div className="field">
                <label htmlFor="mfa-code">Authenticator code</label>
                <input
                  id="mfa-code"
                  className="input"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={11}
                  placeholder="123 456"
                  value={mfaCode}
                  onChange={(e) => setMfaCode(e.target.value)}
                  autoFocus
                  required
                />
              </div>
              {error && <div className="auth-error" role="alert">{error}</div>}
              <button type="submit" className="btn btn-primary auth-submit" disabled={busy}>
                {busy ? 'Checking…' : 'Sign in'}
              </button>
            </form>
            <div className="auth-switch">
              <button onClick={() => { setChallenge(''); setMfaCode(''); setError(''); }}>
                Use a different account
              </button>
            </div>
            <p className="auth-legal">
              Lost your phone? A recovery code works in the same box, once each.
            </p>
          </div>
        </section>
      </div>
    );
  }

  if (setupToken && enrollment) {
    if (recoveryCodes) {
      return (
        <div className="auth auth-single">
          <section className="auth-panel">
            <div className="auth-form">
              <Brand size={42} />
              <h2>Save your recovery codes</h2>
              <p className="auth-form-sub">
                Each one works once, if you lose your phone. They are shown this once only.
              </p>
              <div style={mfaStyles.codes}>
                {recoveryCodes.map(value => <code key={value} style={mfaStyles.code}>{value}</code>)}
              </div>
              <button
                className="btn btn-primary auth-submit"
                onClick={() => {
                  localStorage.setItem('token', pendingToken);
                  setToken(pendingToken);
                }}
              >
                I have saved these — continue <Icon name="arrowRight" size={14} />
              </button>
            </div>
          </section>
        </div>
      );
    }

    return (
      <div className="auth auth-single">
        <section className="auth-panel">
          <div className="auth-form">
            <Brand size={42} />
            <h2>Set up two-factor</h2>
            <p className="auth-form-sub">
              Administrator accounts need a second step at sign-in. Add this key to your
              authenticator app, then type the code it shows.
            </p>
            <div className="field">
              <label>Setup key for {enrollment.account}</label>
              <div style={mfaStyles.secretRow}>
                <code style={mfaStyles.secret}>{enrollment.secret}</code>
                <button type="button" className="btn btn-sm" onClick={() => copyText(enrollment.secret)}>Copy</button>
              </div>
              <span style={mfaStyles.help}>
                In Google Authenticator, Authy, 1Password or Microsoft Authenticator choose
                “enter a setup key”, then “time based”. Keep the app's time to automatic.
              </span>
            </div>
            <form onSubmit={confirmEnrollment}>
              <div className="field">
                <label htmlFor="enroll-code">Code from the app</label>
                <input
                  id="enroll-code"
                  className="input"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={11}
                  placeholder="123 456"
                  value={enrollCode}
                  onChange={(e) => setEnrollCode(e.target.value)}
                  required
                />
              </div>
              {error && <div className="auth-error" role="alert">{error}</div>}
              <button type="submit" className="btn btn-primary auth-submit" disabled={busy}>
                {busy ? 'Checking…' : 'Turn on two-factor'}
              </button>
            </form>
          </div>
        </section>
      </div>
    );
  }

  if (forgot) {
    return (
      <div className="auth auth-single">
        <section className="auth-panel">
          <div className="auth-form">
            <Brand size={42} />
            <h2>Reset your password</h2>
            <p className="auth-form-sub">
              {resetMessage
                ? 'If that address has an account, a link is on its way.'
                : 'Enter the email address you sign in with and we will send a link to choose a new password.'}
            </p>

            {resetMessage ? (
              <>
                <div className="section-note" role="status" style={{ marginBottom: 14 }}>
                  <Icon name="key" size={13} /> {deliveryHint(resetDelivery)}
                </div>
                <button
                  type="button"
                  className="btn btn-primary auth-submit"
                  onClick={() => { setForgot(false); setResetMessage(''); setResetDelivery(''); }}
                >
                  Back to sign in
                </button>
              </>
            ) : (
              <form onSubmit={handleForgot} className="auth-fields">
                <div className="field">
                  <label htmlFor="forgot-email">Work email</label>
                  <input
                    id="forgot-email"
                    className="input"
                    type="email"
                    placeholder="you@company.com"
                    name="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </div>

                {error && <div className="auth-error" role="alert">{error}</div>}

                <button type="submit" className="btn btn-primary auth-submit" disabled={busy}>
                  {busy ? 'Sending…' : 'Send reset link'}
                  {!busy && <Icon name="arrowRight" size={14} />}
                </button>
              </form>
            )}

            {!resetMessage && (
              <div className="auth-switch">
                <button onClick={() => { setForgot(false); setError(''); }}>Back to sign in</button>
              </div>
            )}
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="auth">
      <section className="auth-brand">
        <div className="auth-brand-top">
          <Brand size={48} />
        </div>

        <div className="auth-copy">
          <div className="auth-kicker">Infrastructure intelligence platform</div>
          <h1>Ground truth,<br />meet <em>operational clarity.</em></h1>
          <p>
            One command surface for field evidence, geospatial records, digital twins and
            commercial assurance. Built for teams accountable for what happens on site.
          </p>
          <div className="auth-proof">
            <div><strong>Field</strong><span>Control points, observations and evidence capture</span></div>
            <div><strong>Spatial</strong><span>Georeferenced layers, terrain and map workflows</span></div>
            <div><strong>Control</strong><span>Quantities, progress and payment risk in one chain</span></div>
          </div>
        </div>

        <div className="auth-foot">SiteTrackerPro · Addis Ababa · Infrastructure operations</div>
      </section>

      <section className="auth-panel">
        <div className="auth-form">
          <Brand size={42} />
          <h2>{isLogin ? 'Welcome back' : 'Create your workspace'}</h2>
          <p className="auth-form-sub">
            {isLogin ? 'Sign in to the operating picture.' : 'Start with a project, then bring your field data into context.'}
          </p>

          {notice && !error && (
            <div className="section-note" style={{ background: 'var(--amber-soft)', borderColor: '#e8d4ae', color: '#7b4a0d' }} role="status">
              <Icon name="key" size={13} /> {notice}
            </div>
          )}

          {sessionExpired && !error && (
            <div className="section-note" style={{ background: 'var(--amber-soft)', borderColor: '#e8d4ae', color: '#7b4a0d' }} role="status">
              <Icon name="clock" size={13} /> Your session expired. Sign in again to continue where you left off.
            </div>
          )}

          <form onSubmit={handleSubmit} className="auth-fields">
            {!isLogin && (
              <div className="field">
                <label htmlFor="auth-name">Full name</label>
                <input
                  id="auth-name"
                  className="input"
                  type="text"
                  placeholder="e.g. Selam Bekele"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  required
                />
              </div>
            )}
            {!isLogin && (
              <div className="field">
                <label htmlFor="auth-company">Company</label>
                <input
                  id="auth-company"
                  className="input"
                  type="text"
                  placeholder="e.g. Timona Geospatial and Survey"
                  autoComplete="organization"
                  value={company}
                  onChange={(e) => setCompany(e.target.value)}
                />
              </div>
            )}
            <div className="field">
              <label htmlFor="auth-email">Work email</label>
              <input
                id="auth-email"
                className="input"
                type="email"
                placeholder="you@company.com"
                name="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="auth-password">Password</label>
              <input
                id="auth-password"
                className="input"
                type="password"
                placeholder="••••••••••••"
                name="password"
                autoComplete={isLogin ? 'current-password' : 'new-password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={isLogin ? undefined : 12}
                maxLength={72}
                required
              />
              {!isLogin && (
                <span style={{ color: 'var(--ink-3)', fontSize: 9.5, lineHeight: 1.4 }}>
                  At least 12 characters. Avoid your email, common passwords or repeated characters.
                </span>
              )}
            </div>

            {error && <div className="auth-error" role="alert">{error}</div>}

            <button type="submit" className="btn btn-primary auth-submit" disabled={busy}>
              {busy ? 'Connecting…' : isLogin ? 'Enter workspace' : 'Create workspace'}
              {!busy && <Icon name="arrowRight" size={14} />}
            </button>
          </form>

          <div className="auth-switch">
            {isLogin ? "Don't have a workspace? " : 'Already have a workspace? '}
            <button onClick={() => { setIsLogin(!isLogin); setError(''); }}>
              {isLogin ? 'Create one' : 'Sign in'}
            </button>
          </div>

          {isLogin && (
            <div className="auth-switch" style={{ marginTop: 6 }}>
              <button onClick={() => { setForgot(true); setError(''); }}>Forgot your password?</button>
            </div>
          )}

          <p className="auth-legal">Access is logged. Survey observations and commercial records remain the authoritative source.</p>
        </div>
      </section>
    </div>
  );
}

// ===================== RESET PASSWORD (EMAILED LINK) =====================
// Opened from the link in the reset email: /?reset=<token>. The server decides
// whether the token is still good; this screen collects the new password and
// mirrors the rules so the person sees a problem before the request is sent.
function ResetPasswordScreen({ token, onDone }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [problems, setProblems] = useState([]);
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setProblems([]);

    const localProblems = [];
    if (Array.from(password).length < 12) localProblems.push('Use at least 12 characters.');
    if (password !== confirm) localProblems.push('The two passwords do not match.');
    if (localProblems.length > 0) {
      setProblems(localProblems);
      return;
    }

    setBusy(true);
    try {
      const response = await axios.post(`${API_URL}/auth/reset-password`, { token, newPassword: password });
      setSuccess(response.data?.message || 'Password updated. Sign in with your new password.');
      setPassword('');
      setConfirm('');
    } catch (err) {
      const data = err.response?.data;
      setProblems(
        Array.isArray(data?.problems) && data.problems.length > 0
          ? data.problems
          : [data?.error || 'Could not set the new password. The link may have expired - request a new one.']
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth auth-single">
      <section className="auth-panel">
        <div className="auth-form">
          <Brand size={42} />
          <h2>{success ? 'Password set' : 'Choose a new password'}</h2>
          <p className="auth-form-sub">
            {success
              ? 'You can now sign in with the password you just chose.'
              : 'This link works once. Pick something you do not use anywhere else.'}
          </p>

          {success ? (
            <>
              <div className="section-note" role="status" style={{ marginBottom: 14 }}>
                <Icon name="key" size={13} /> {success}
              </div>
              <button
                type="button"
                className="btn btn-primary auth-submit"
                onClick={() => onDone('Your password was updated. Sign in with the new one.')}
              >
                Back to sign in
              </button>
            </>
          ) : (
            <form onSubmit={handleSubmit} className="auth-fields">
              <div className="field">
                <label htmlFor="reset-password">New password</label>
                <input
                  id="reset-password"
                  className="input"
                  type="password"
                  placeholder="••••••••••••"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  minLength={12}
                  maxLength={72}
                  required
                />
                <span style={{ color: 'var(--ink-3)', fontSize: 9.5, lineHeight: 1.4 }}>
                  At least 12 characters. Avoid your email, common passwords or repeated characters.
                </span>
              </div>
              <div className="field">
                <label htmlFor="reset-confirm">Confirm new password</label>
                <input
                  id="reset-confirm"
                  className="input"
                  type="password"
                  placeholder="••••••••••••"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  minLength={12}
                  maxLength={72}
                  required
                />
              </div>

              {problems.length > 0 && (
                <div className="auth-error" role="alert">
                  {problems.length === 1 ? problems[0] : problems.join(' ')}
                </div>
              )}

              <button type="submit" className="btn btn-primary auth-submit" disabled={busy}>
                {busy ? 'Saving…' : 'Set new password'}
                {!busy && <Icon name="arrowRight" size={14} />}
              </button>
            </form>
          )}

          {!success && (
            <div className="auth-switch">
              <button onClick={() => onDone('')}>Back to sign in</button>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

// ===================== ACCOUNT / CHANGE PASSWORD =====================
// Rotating your own password. The server enforces the same rules; the checks here
// exist so the person sees the problem before the request is sent.
// ===================== TEAM & ACCESS =====================
// Administrators assign one of three roles per account. This screen is a thin client over
// GET /api/users and PATCH /api/users/:id/role; the API is what actually enforces them.
const ROLE_CHOICES = [
  { value: 'viewer', label: 'Viewer', hint: 'Reads every project record, changes nothing.' },
  { value: 'analyst', label: 'Analyst', hint: 'Adds and edits project data, runs analysis and imports.' },
  { value: 'admin', label: 'Admin', hint: 'Also deletes records and manages team access.' }
];

const mfaStyles = {
  secretRow: { display: 'flex', gap: '8px', alignItems: 'center' },
  secret: {
    flex: 1,
    padding: '8px 10px',
    border: '1px solid var(--line)',
    borderRadius: '7px',
    background: 'var(--surface-2)',
    fontSize: '12px',
    letterSpacing: '0.08em',
    wordBreak: 'break-all'
  },
  help: { color: 'var(--ink-3)', fontSize: '9.5px', lineHeight: 1.4 },
  codes: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '6px', margin: '4px 0 14px' },
  code: {
    padding: '6px 8px',
    border: '1px solid var(--line)',
    borderRadius: '6px',
    background: 'var(--surface-2)',
    fontSize: '11.5px',
    letterSpacing: '0.06em',
    textAlign: 'center'
  }
};

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(String(value));
    return true;
  } catch (err) {
    return false;
  }
}

const EMPTY_MEMBER = { email: '', fullName: '', company: '', role: 'viewer', password: '' };

// Readable words rather than random characters: an administrator has to pass this on, and
// a phrase is easier to hand over accurately than a string of letters and symbols.
const TEMP_WORDS = [
  'orbit', 'gravel', 'lantern', 'copper', 'willow', 'harbor', 'cobalt', 'meadow',
  'bramble', 'saddle', 'quarry', 'pylon', 'tundra', 'marble', 'sorrel', 'ember'
];

function randomIndex(length) {
  const buffer = new Uint32Array(1);
  if (typeof window !== 'undefined' && window.crypto && window.crypto.getRandomValues) {
    window.crypto.getRandomValues(buffer);
    return buffer[0] % length;
  }
  return Math.floor(Math.random() * length);
}

function suggestPassword() {
  const word = () => TEMP_WORDS[randomIndex(TEMP_WORDS.length)];
  return `${word()}-${word()}-${word()}-${100 + randomIndex(900)}`;
}

function roleLabel(role) {
  return (ROLE_CHOICES.find(choice => choice.value === role) || ROLE_CHOICES[0]).label;
}

function TeamScreen({ token }) {
  const [users, setUsers] = useState([]);
  const [me, setMe] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [draft, setDraft] = useState(EMPTY_MEMBER);
  const [adding, setAdding] = useState(false);
  const [invite, setInvite] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const headers = { Authorization: `Bearer ${token}` };

    (async () => {
      try {
        const [meResponse, usersResponse] = await Promise.all([
          axios.get(`${API_URL}/auth/me`, { headers }),
          axios.get(`${API_URL}/api/users`, { headers })
        ]);
        if (cancelled) return;
        setMe(meResponse.data);
        setUsers(usersResponse.data);
      } catch (err) {
        if (cancelled) return;
        setError(err.response?.status === 403
          ? 'Team access is limited to administrators. Everything else in SiteTrackerPro still works for your account.'
          : (err.response?.data?.error || 'Could not load the team. Check your connection and try again.'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [token]);

  const assign = async (user, role) => {
    setError('');
    setNotice('');
    setSavingId(user.id);
    try {
      const response = await axios.patch(
        `${API_URL}/api/users/${user.id}/role`,
        { role },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const updated = response.data.user;
      setUsers(list => list.map(item => (item.id === updated.id ? { ...item, ...updated } : item)));
      const label = (ROLE_CHOICES.find(choice => choice.value === role) || ROLE_CHOICES[0]).label;
      setNotice(`${updated.full_name || updated.email} is now ${label}.`);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not change that role. Please try again.');
    } finally {
      setSavingId(null);
    }
  };

  const createAccount = async (event) => {
    event.preventDefault();
    setError('');
    setNotice('');
    setInvite(null);

    const localProblems = [];
    if (!draft.email.trim()) localProblems.push('Enter the email address they will sign in with.');
    if (Array.from(draft.password).length < 12) localProblems.push('Use at least 12 characters for the temporary password.');
    if (localProblems.length > 0) {
      setError(localProblems.join(' '));
      return;
    }

    setAdding(true);
    try {
      const response = await axios.post(
        `${API_URL}/api/users`,
        {
          email: draft.email.trim(),
          fullName: draft.fullName.trim() || undefined,
          company: draft.company.trim() || undefined,
          role: draft.role,
          password: draft.password
        },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      const user = response.data.user;
      setUsers(list => [...list, { ...user, project_count: 0 }]);
      setInvite({ email: user.email, password: draft.password });
      setNotice(`${user.full_name || user.email} is now a member, as ${roleLabel(user.role)}.`);
      setDraft(EMPTY_MEMBER);
      setShowAdd(false);
    } catch (err) {
      const data = err.response?.data;
      setError(Array.isArray(data?.problems) && data.problems.length > 1
        ? data.problems.join(' ')
        : (data?.error || 'Could not create that account. Please try again.'));
    } finally {
      setAdding(false);
    }
  };

  const copyInvite = async (details) => {
    const text = 'SiteTrackerPro\n' +
      (typeof window !== 'undefined' ? window.location.origin : '') + '\n' +
      'Email: ' + details.email + '\n' +
      'Temporary password: ' + details.password;
    try {
      await navigator.clipboard.writeText(text);
      setNotice('Copied. Send it to them over a channel you trust, and ask them to change it in Account.');
    } catch (err) {
      setError('Could not copy automatically — select the password above and copy it yourself.');
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div className="page-head-copy">
          <div className="eyebrow">Workspace / access control</div>
          <h1 className="page-title">Team &amp; access</h1>
          <p className="page-sub">
            One role per account. Viewers read every record, analysts add and edit project data,
            admins also delete records and assign roles. The API refuses anything the role does
            not allow, whatever the screen offers.
          </p>
        </div>
        <div className="page-actions">
          <button
            className={showAdd ? 'btn' : 'btn btn-primary'}
            onClick={() => { setShowAdd(!showAdd); setError(''); }}
          >
            <Icon name={showAdd ? 'minus' : 'plus'} size={14} /> {showAdd ? 'Cancel' : 'Add member'}
          </button>
        </div>
      </div>

      {showAdd && (
        <section className="panel" style={{ marginBottom: 16 }}>
          <div className="panel-head">
            <div className="panel-head-copy">
              <h3>Add a member</h3>
              <p>Give them a temporary password and a role. They can sign in straight away and change the password in Account.</p>
            </div>
            <span className="panel-eyebrow">Admin only</span>
          </div>
          <div className="panel-body">
            <form onSubmit={createAccount}>
              <div className="form-grid">
                <div className="field">
                  <label htmlFor="member-email">Email they sign in with</label>
                  <input
                    id="member-email"
                    className="input"
                    type="email"
                    autoComplete="off"
                    value={draft.email}
                    onChange={event => setDraft(item => ({ ...item, email: event.target.value }))}
                    required
                  />
                </div>
                <div className="field">
                  <label htmlFor="member-role">Role</label>
                  <select
                    id="member-role"
                    style={teamStyles.select}
                    value={draft.role}
                    onChange={event => setDraft(item => ({ ...item, role: event.target.value }))}
                  >
                    {ROLE_CHOICES.map(choice => (
                      <option key={choice.value} value={choice.value}>{choice.label}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="member-name">Full name (optional)</label>
                  <input
                    id="member-name"
                    className="input"
                    type="text"
                    maxLength={255}
                    value={draft.fullName}
                    onChange={event => setDraft(item => ({ ...item, fullName: event.target.value }))}
                  />
                </div>
                <div className="field">
                  <label htmlFor="member-company">Company (optional)</label>
                  <input
                    id="member-company"
                    className="input"
                    type="text"
                    maxLength={255}
                    value={draft.company}
                    onChange={event => setDraft(item => ({ ...item, company: event.target.value }))}
                  />
                </div>
                <div className="field full">
                  <label htmlFor="member-password">Temporary password</label>
                  <input
                    id="member-password"
                    className="input"
                    type="text"
                    autoComplete="new-password"
                    minLength={12}
                    maxLength={72}
                    value={draft.password}
                    onChange={event => setDraft(item => ({ ...item, password: event.target.value }))}
                    required
                  />
                  <span style={teamStyles.hint}>
                    At least 12 characters, and not built from their email address. Nothing is emailed —
                    you pass it on yourself, and they change it in Account after signing in.
                  </span>
                </div>
              </div>
              <div className="form-actions">
                <button type="submit" className="btn btn-primary" disabled={adding}>
                  <Icon name="plus" size={13} /> {adding ? 'Creating…' : 'Create account'}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setDraft(item => ({ ...item, password: suggestPassword() }))}
                >
                  Suggest a password
                </button>
                <span className="toolbar-note">The role can be changed later in the list below.</span>
              </div>
            </form>
          </div>
        </section>
      )}

      {invite && (
        <div style={teamStyles.invite} role="status">
          <div>
            <strong>{invite.email}</strong> can sign in now. Temporary password:
            <code style={teamStyles.code}>{invite.password}</code>
            <span style={teamStyles.hint}>
              Send it over a channel you trust. They should change it in Account after their first sign-in.
            </span>
          </div>
          <button type="button" className="btn btn-sm" onClick={() => copyInvite(invite)}>
            <Icon name="key" size={12} /> Copy details
          </button>
        </div>
      )}

      {error && (
        <div role="alert" style={teamStyles.error}>{error}</div>
      )}
      {notice && <div style={teamStyles.notice}>{notice}</div>}
      {loading && <p style={teamStyles.helper}>Loading accounts…</p>}

      {!loading && users.length > 0 && (
        <div style={teamStyles.card}>
          <div style={teamStyles.headRow}>
            <span>Account</span>
            <span>Projects</span>
            <span>Role</span>
          </div>
          {users.map(user => {
            const isMe = me && me.id === user.id;
            const saving = savingId === user.id;
            return (
              <div key={user.id} style={teamStyles.row}>
                <div style={{ minWidth: 0 }}>
                  <strong style={teamStyles.name}>
                    {user.full_name || user.email.split('@')[0]}
                    {isMe && <span style={teamStyles.you}>you</span>}
                  </strong>
                  <span style={teamStyles.email}>{user.email}</span>
                  {user.company && <span style={teamStyles.email}>{user.company}</span>}
                </div>
                <div style={teamStyles.count}>{user.project_count}</div>
                <div>
                  <select
                    aria-label={`Role for ${user.email}`}
                    value={user.role}
                    disabled={isMe || saving}
                    onChange={event => assign(user, event.target.value)}
                    style={teamStyles.select}
                  >
                    {ROLE_CHOICES.map(choice => (
                      <option key={choice.value} value={choice.value}>{choice.label}</option>
                    ))}
                  </select>
                  <span style={teamStyles.hint}>
                    {isMe
                      ? 'Your own role cannot be changed here.'
                      : (ROLE_CHOICES.find(choice => choice.value === user.role) || ROLE_CHOICES[0]).hint}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {!loading && !error && users.length === 0 && (
        <p style={teamStyles.helper}>No accounts yet.</p>
      )}

      <div style={teamStyles.legend}>
        {ROLE_CHOICES.map(choice => (
          <div key={choice.value} style={teamStyles.legendItem}>
            <strong>{choice.label}</strong>
            <span>{choice.hint}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const teamStyles = {
  card: {
    background: 'var(--surface)',
    border: '1px solid var(--line)',
    borderRadius: 'var(--radius-md)',
    boxShadow: 'var(--shadow-xs)',
    overflow: 'hidden'
  },
  headRow: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) 90px minmax(200px, 260px)',
    gap: '12px',
    padding: '10px 16px',
    background: 'var(--surface-2)',
    borderBottom: '1px solid var(--line)',
    fontSize: '10px',
    fontWeight: 600,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: 'var(--ink-3)'
  },
  row: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) 90px minmax(200px, 260px)',
    gap: '12px',
    alignItems: 'center',
    padding: '14px 16px',
    borderTop: '1px solid var(--line)'
  },
  name: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '13px' },
  you: {
    fontSize: '9px',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    background: 'var(--copper-soft)',
    color: 'var(--copper-strong)',
    borderRadius: '4px',
    padding: '1px 5px'
  },
  email: { display: 'block', fontSize: '10.5px', color: 'var(--ink-3)', marginTop: '2px' },
  count: { fontSize: '12px', fontVariantNumeric: 'tabular-nums', color: 'var(--ink-2)' },
  select: {
    width: '100%',
    padding: '7px 9px',
    border: '1px solid var(--line-strong)',
    borderRadius: '7px',
    background: 'var(--surface)',
    color: 'var(--ink)',
    fontSize: '11.5px'
  },
  hint: { display: 'block', fontSize: '9.5px', color: 'var(--ink-3)', marginTop: '5px', lineHeight: 1.4 },
  helper: { fontSize: '11px', color: 'var(--ink-3)' },
  error: {
    background: 'var(--danger-soft)',
    border: '1px solid #ecc9c4',
    color: 'var(--danger)',
    padding: '10px 12px',
    borderRadius: '8px',
    fontSize: '11.5px',
    marginBottom: '12px'
  },
  notice: {
    background: 'var(--signal-soft)',
    border: '1px solid #bcdccd',
    color: 'var(--signal-strong)',
    padding: '10px 12px',
    borderRadius: '8px',
    fontSize: '11.5px',
    marginBottom: '12px'
  },
  invite: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: '12px',
    background: 'var(--signal-soft)',
    border: '1px solid #bcdccd',
    color: 'var(--signal-strong)',
    padding: '12px 14px',
    borderRadius: '8px',
    fontSize: '11.5px',
    marginBottom: '12px'
  },
  code: {
    display: 'inline-block',
    marginLeft: '6px',
    padding: '2px 6px',
    borderRadius: '5px',
    background: 'var(--surface)',
    border: '1px solid var(--line)',
    color: 'var(--ink)',
    fontFamily: 'var(--font-mono, monospace)',
    fontSize: '11.5px'
  },
  legend: { display: 'grid', gap: '8px', marginTop: '16px' },
  legendItem: { display: 'flex', gap: '10px', alignItems: 'baseline', fontSize: '10.5px', color: 'var(--ink-3)' }
};

// Two-factor status and enrolment for the signed-in account. Administrators are required to
// keep it on, so this card explains that instead of offering a switch that would refuse.
function TwoFactorPanel({ token }) {
  const [status, setStatus] = useState(null);
  const [enrollment, setEnrollment] = useState(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState(null);
  const [problem, setProblem] = useState('');
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);

  const headers = { Authorization: `Bearer ${token}` };

  const load = async () => {
    try {
      const response = await axios.get(`${API_URL}/auth/mfa`, { headers });
      setStatus(response.data);
    } catch (err) {
      setProblem(err.response?.data?.error || 'Could not read the two-factor status.');
    }
  };

  useEffect(() => { load(); }, [token]);

  const start = async () => {
    setProblem('');
    setDone('');
    setCodes(null);
    try {
      const response = await axios.post(`${API_URL}/auth/mfa/setup`, {}, { headers });
      setEnrollment(response.data);
    } catch (err) {
      setProblem(err.response?.data?.error || 'Could not start the setup. Try again.');
    }
  };

  const confirm = async (event) => {
    event.preventDefault();
    setProblem('');
    setBusy(true);
    try {
      const response = await axios.post(`${API_URL}/auth/mfa/enable`, { code }, { headers });
      setCodes(response.data.recoveryCodes || []);
      setEnrollment(null);
      setCode('');
      setDone('Two-factor is on for this account.');
      await load();
    } catch (err) {
      setProblem(err.response?.data?.error || 'That code was not accepted. Wait for the next one.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <div className="panel-head">
        <div className="panel-head-copy">
          <h3>Two-factor authentication</h3>
          <p>{status ? (status.enabled ? 'On for this account.' : 'Off.') : 'Checking…'}</p>
        </div>
        <span className="panel-eyebrow">{status && status.requiredForRole ? 'Required' : 'Optional'}</span>
      </div>
      <div className="panel-body">
        {problem && (
          <div className="section-note" role="alert" style={{ color: 'var(--danger)', background: 'var(--danger-soft)', borderColor: '#ecc9c4', marginBottom: 12 }}>
            <Icon name="alert" size={13} /> {problem}
          </div>
        )}
        {done && (
          <div className="section-note" role="status" style={{ color: 'var(--signal-strong)', background: 'var(--signal-soft)', borderColor: '#b9ddcd', marginBottom: 12 }}>
            <Icon name="checkCircle" size={13} /> {done}
          </div>
        )}

        {status && status.enabled && (
          <p className="helper" style={{ marginTop: 0 }}>
            {status.recoveryCodesLeft} recovery code{status.recoveryCodesLeft === 1 ? '' : 's'} left.
            A code works once, if you lose your phone.
            {status.requiredForRole ? ' Administrators must keep this on.' : ''}
          </p>
        )}

        {codes && (
          <div style={{ marginBottom: 12 }}>
            <div className="helper" style={{ marginTop: 0 }}>Save these now — they will not be shown again.</div>
            <div style={mfaStyles.codes}>
              {codes.map(value => <code key={value} style={mfaStyles.code}>{value}</code>)}
            </div>
            <button type="button" className="btn btn-sm" onClick={() => copyText(codes.join('\n'))}>
              Copy all codes
            </button>
          </div>
        )}

        {enrollment ? (
          <form onSubmit={confirm}>
            <div className="field">
              <label>Setup key for {enrollment.account}</label>
              <div style={mfaStyles.secretRow}>
                <code style={mfaStyles.secret}>{enrollment.secret}</code>
                <button type="button" className="btn btn-sm" onClick={() => copyText(enrollment.secret)}>Copy</button>
              </div>
              <span style={mfaStyles.help}>
                Add it to your authenticator app as a time-based key, then type the 6-digit code here.
              </span>
            </div>
            <div className="field" style={{ marginTop: 12 }}>
              <label htmlFor="account-mfa-code">Code from the app</label>
              <input
                id="account-mfa-code"
                className="input"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={11}
                placeholder="123 456"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                required
              />
            </div>
            <div className="form-actions">
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {busy ? 'Checking…' : 'Turn on two-factor'}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setEnrollment(null); setProblem(''); }}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          !codes && (!status || !status.enabled) && (
            <div className="form-actions" style={{ marginTop: 0 }}>
              <button type="button" className="btn btn-primary" onClick={start}>
                <Icon name="shield" size={13} /> Set up two-factor
              </button>
              <span className="toolbar-note">Needs an authenticator app on your phone.</span>
            </div>
          )
        )}
      </div>
    </section>
  );
}

function AccountScreen({ token }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [problems, setProblems] = useState([]);
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);

  const clearFields = () => {
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setProblems([]);
    setSuccess('');

    const localProblems = [];
    if (!currentPassword) localProblems.push('Enter your current password.');
    if (Array.from(newPassword).length < 12) localProblems.push('Use at least 12 characters for the new password.');
    if (newPassword !== confirmPassword) localProblems.push('The two new passwords do not match.');
    if (newPassword && newPassword === currentPassword) localProblems.push('Choose a password that is different from your current one.');
    if (localProblems.length > 0) {
      setProblems(localProblems);
      return;
    }

    setBusy(true);
    try {
      const response = await axios.post(
        `${API_URL}/auth/change-password`,
        { currentPassword, newPassword },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setSuccess(response.data?.message || 'Password updated.');
      clearFields();
    } catch (err) {
      const data = err.response?.data;
      if (Array.isArray(data?.problems) && data.problems.length > 0) {
        setProblems(data.problems);
      } else {
        setProblems([data?.error || 'Could not change the password. Please try again.']);
      }
    } finally {
      setBusy(false);
    }
  };

  const passwordChecks = [
    { label: 'At least 12 characters', met: Array.from(newPassword).length >= 12 },
    { label: 'Confirmation matches', met: confirmPassword.length > 0 && newPassword === confirmPassword },
    { label: 'Different from current password', met: newPassword.length > 0 && newPassword !== currentPassword }
  ];
  const metChecks = passwordChecks.filter(check => check.met).length;

  return (
    <div className="page">
      <div className="page-head">
        <div className="page-head-copy">
          <div className="eyebrow">Account / security</div>
          <h1 className="page-title">Account</h1>
          <p className="page-sub">
            Manage the credentials for this workspace. Password changes are verified by the server
            before they are saved.
          </p>
        </div>
      </div>

      <div className="screen-grid">
        <section className="panel">
          <div className="panel-head">
            <div className="panel-head-copy">
              <h3>Change password</h3>
              <p>Choose a password you do not use anywhere else.</p>
            </div>
            <Icon name="key" size={14} style={{ color: 'var(--copper)' }} />
          </div>
          <form onSubmit={handleSubmit} className="panel-body">
            <div className="form-grid">
              <div className="field full">
                <label htmlFor="current-password">Current password</label>
                <input
                  id="current-password"
                  className="input"
                  type="password"
                  name="current-password"
                  autoComplete="current-password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  maxLength={72}
                  required
                />
              </div>
              <div className="field full">
                <label htmlFor="new-password">New password</label>
                <input
                  id="new-password"
                  className="input"
                  type="password"
                  name="new-password"
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  minLength={12}
                  maxLength={72}
                  required
                />
              </div>
              <div className="field full">
                <label htmlFor="confirm-password">Repeat new password</label>
                <input
                  id="confirm-password"
                  className="input"
                  type="password"
                  name="confirm-password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  minLength={12}
                  maxLength={72}
                  required
                />
              </div>
            </div>

            {problems.length > 0 && (
              <div className="section-note" role="alert" style={{ marginTop: 14, color: 'var(--danger)', background: 'var(--danger-soft)', borderColor: '#ecc9c4' }}>
                <Icon name="alert" size={13} />
                <div>
                  <strong>{problems.length > 1 ? 'Please fix these:' : 'Password not changed:'}</strong>
                  <ul style={{ margin: '5px 0 0 16px', padding: 0 }}>
                    {problems.map((problem, i) => <li key={i}>{problem}</li>)}
                  </ul>
                </div>
              </div>
            )}

            {success && (
              <div className="section-note" role="status" style={{ marginTop: 14, color: 'var(--signal-strong)', background: 'var(--signal-soft)', borderColor: '#b9ddcd' }}>
                <Icon name="checkCircle" size={13} /> {success}
              </div>
            )}

            <div className="form-actions">
              <button type="submit" className="btn btn-primary" disabled={busy}>
                <Icon name="key" size={13} /> {busy ? 'Saving…' : 'Change password'}
              </button>
              <span className="toolbar-note">You stay signed in on this device.</span>
            </div>
          </form>
        </section>

        <div className="stack">
          <TwoFactorPanel token={token} />

          <section className="panel">
            <div className="panel-head">
              <div className="panel-head-copy"><h3>Password requirements</h3><p>{metChecks} of {passwordChecks.length} met.</p></div>
              <span className="panel-eyebrow">Local check</span>
            </div>
            <div className="panel-body">
              <div className="requirement-list">
                {passwordChecks.map(check => (
                  <div className={`requirement ${check.met ? 'met' : ''}`} key={check.label}>
                    <Icon name={check.met ? 'checkCircle' : 'minus'} size={12} /> {check.label}
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div className="panel-head-copy"><h3>Session</h3><p>How this change applies.</p></div>
              <Icon name="shield" size={14} style={{ color: 'var(--ink-3)' }} />
            </div>
            <div className="panel-body">
              <p className="helper" style={{ marginTop: 0 }}>
                You stay signed in here. Other devices already signed in keep their session until it
                expires (7 days).
              </p>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

// ===================== DASHBOARD SCREEN =====================
function compactValue(value) {
  const amount = Number(value) || 0;
  if (amount >= 1e9) return `${(amount / 1e9).toFixed(1)}B`;
  if (amount >= 1e6) return `${(amount / 1e6).toFixed(1)}M`;
  if (amount >= 1e3) return `${(amount / 1e3).toFixed(0)}k`;
  return amount.toFixed(0);
}

function DashboardScreen({ token, projects, activeProject, setSelectedProject, setCurrentScreen }) {
  const [stats, setStats] = useState(null);
  const [signals, setSignals] = useState({});
  const [signalsReady, setSignalsReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    axios.get(`${API_URL}/api/dashboard`, { headers: { Authorization: `Bearer ${token}` } })
      .then(response => { if (!cancelled) setStats(response.data); })
      .catch(() => { if (!cancelled) setStats(null); });
    return () => { cancelled = true; };
  }, [token]);

  useEffect(() => {
    let cancelled = false;
    if (projects.length === 0) {
      setSignals({});
      setSignalsReady(true);
      return undefined;
    }

    const authHeaders = { Authorization: `Bearer ${token}` };
    const optional = (url) => axios.get(url, { headers: authHeaders }).catch(() => null);

    Promise.all(projects.slice(0, 8).map(async project => {
      const [progressResponse, alertsResponse] = await Promise.all([
        optional(`${API_URL}/api/progress/${project.id}`),
        optional(`${API_URL}/api/fraud-detection/${project.id}`)
      ]);
      return [String(project.id), {
        progress: progressResponse?.data || null,
        alerts: Array.isArray(alertsResponse?.data) ? alertsResponse.data : []
      }];
    })).then(entries => {
      if (cancelled) return;
      setSignals(Object.fromEntries(entries));
      setSignalsReady(true);
    });

    return () => { cancelled = true; };
  }, [projects, token]);

  const totalBudget = projects.reduce((sum, project) => sum + (Number(project.budget) || 0), 0);
  const projectAlerts = Object.values(signals).reduce((sum, signal) => sum + (signal.alerts?.length || 0), 0);
  const alertCount = Math.max(Number(stats?.activeAlerts) || 0, projectAlerts);
  const reported = projects.filter(project => signals[String(project.id)]?.progress).length;
  const coverage = projects.length ? Math.round((reported / projects.length) * 100) : 0;

  const attention = [];
  projects.forEach(project => {
    const signal = signals[String(project.id)] || {};
    if (!Number(project.budget)) {
      attention.push({
        kind: 'danger', icon: 'alert', title: `${project.name} has no budget`,
        detail: 'Cost performance cannot be measured until a budget is set.',
        action: 'Set budget', screen: 'project-dashboard'
      });
    }
    if (!project.location) {
      attention.push({
        kind: 'warn', icon: 'mapPin', title: `${project.name} has no site location`,
        detail: 'Add a location to anchor records and map context.',
        action: 'Open project', screen: 'project-details', project
      });
    }
    if (signalsReady && !signal.progress) {
      attention.push({
        kind: 'warn', icon: 'activity', title: `${project.name} has no field progress`,
        detail: 'Record physical progress before comparing spend or certifying work.',
        action: 'Record progress', screen: 'project-dashboard'
      });
    }
    if ((signal.alerts || []).length > 0) {
      attention.push({
        kind: 'danger', icon: 'shield', title: `${signal.alerts.length} payment risk flag${signal.alerts.length === 1 ? '' : 's'} on ${project.name}`,
        detail: 'Review the evidence trail before the next certification.',
        action: 'Review flags', screen: 'fraud'
      });
    }
  });

  if (attention.length === 0 && signalsReady) {
    attention.push({
      kind: 'good', icon: 'checkCircle', title: 'No blocking issues in the operating picture',
      detail: 'Budgets, site context and field reporting are present for every active project.',
      action: 'Open portfolio', screen: 'projects'
    });
  }

  const openProject = (project) => {
    setSelectedProject(project);
    setCurrentScreen('project-details');
  };

  const leadProject = activeProject || projects[0];
  const leadProgress = leadProject ? signals[String(leadProject.id)]?.progress : null;
  const leadPct = leadProgress ? Math.max(0, Math.min(100, Number(leadProgress.progress_percent) || 0)) : null;
  const leadBudget = Number(leadProject?.budget) || 0;
  const leadSpent = Number(leadProgress?.budget_spent) || 0;
  const leadSpendPct = leadBudget > 0 ? Math.max(0, Math.min(100, (leadSpent / leadBudget) * 100)) : 0;
  const leadBurnGap = (leadPct || 0) - leadSpendPct;

  return (
    <div className="page">
      <div className="page-head">
        <div className="page-head-copy">
          <div className="eyebrow">Operations / live portfolio</div>
          <h1 className="page-title">Infrastructure overview</h1>
          <p className="page-sub">
            One operating picture across field evidence, spatial records and commercial control.
            {' '}
            {new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}
          </p>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={() => setCurrentScreen('gis')}>
            <Icon name="map" size={14} /> Open map
          </button>
          <button className="btn btn-primary" onClick={() => setCurrentScreen('new-project')}>
            <Icon name="plus" size={14} /> New project
          </button>
        </div>
      </div>

      <div className="kpi-grid">
        <div className="kpi">
          <div className="kpi-label"><Icon name="building" size={12} /> Active projects</div>
          <div className="kpi-value">{projects.length}</div>
          <div className="kpi-meta"><strong>{projects.filter(project => project.location).length}</strong> with site context</div>
        </div>
        <div className="kpi">
          <div className="kpi-label"><Icon name="database" size={12} /> Portfolio value</div>
          <div className="kpi-value">{compactValue(totalBudget)} <small>ETB</small></div>
          <div className="kpi-meta">{totalBudget > 0 ? 'Across active budgets' : 'No budgets recorded'}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label"><Icon name="shield" size={12} /> Open risk flags</div>
          <div className="kpi-value">{alertCount}</div>
          <div className={`kpi-meta ${alertCount > 0 ? 'warn' : ''}`}>
            <span className={alertCount > 0 ? 'warn' : 'good'}>{alertCount > 0 ? 'Review required' : 'All clear'}</span>
            {alertCount > 0 ? ' · payment assurance' : ' · no payment blocks'}
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-label"><Icon name="activity" size={12} /> Field reporting</div>
          <div className="kpi-value">{coverage}<small>%</small></div>
          <div className="kpi-meta"><strong>{reported}</strong> of {projects.length} projects reporting</div>
        </div>
      </div>

      <div className="dash-grid">
        <div className="stack">
          <section className="panel">
            <div className="panel-head">
              <div className="panel-head-copy">
                <h3>Needs attention</h3>
                <p>What changed, what is missing and what to do next.</p>
              </div>
              <button className="panel-action" onClick={() => setCurrentScreen('fraud')}>
                Risk register <Icon name="chevronRight" size={12} />
              </button>
            </div>
            <div className="panel-body">
              {!signalsReady && projects.length > 0 ? (
                <div className="attention-item">
                  <div className="attention-icon"><Icon name="clock" size={14} /></div>
                  <div className="attention-copy">
                    <div className="attention-title">Reading field and commercial records…</div>
                    <div className="attention-detail">The attention list will update as records load.</div>
                  </div>
                </div>
              ) : attention.length === 0 ? (
                <div className="empty">
                  <div className="empty-icon"><Icon name="checkCircle" /></div>
                  <h4>No active projects yet</h4>
                  <p>Create a project to start an evidence chain from field capture to payment assurance.</p>
                  <button className="btn btn-primary btn-sm" onClick={() => setCurrentScreen('new-project')}>
                    <Icon name="plus" size={13} /> Create project
                  </button>
                </div>
              ) : (
                <div className="attention-list">
                  {attention.slice(0, 4).map((item, index) => (
                    <div className="attention-item" key={`${item.title}-${index}`}>
                      <div className={`attention-icon ${item.kind === 'good' ? 'good' : item.kind}`}>
                        <Icon name={item.icon} size={14} />
                      </div>
                      <div className="attention-copy">
                        <div className="attention-title">{item.title}</div>
                        <div className="attention-detail">{item.detail}</div>
                      </div>
                      <button
                        className="attention-action"
                        onClick={() => {
                          if (item.project) setSelectedProject(item.project);
                          setCurrentScreen(item.screen);
                        }}
                      >
                        {item.action}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div className="panel-head-copy">
                <h3>Project portfolio</h3>
                <p>Operational status, value and the next action for each site.</p>
              </div>
              <button className="panel-action" onClick={() => setCurrentScreen('projects')}>
                View all <Icon name="chevronRight" size={12} />
              </button>
            </div>
            <div className="panel-body flush">
              {projects.length === 0 ? (
                <div className="empty" style={{ margin: 14 }}>
                  <div className="empty-icon"><Icon name="projects" /></div>
                  <h4>Your portfolio is empty</h4>
                  <p>Add the first project to give field, spatial and commercial records a home.</p>
                  <button className="btn btn-primary btn-sm" onClick={() => setCurrentScreen('new-project')}>
                    <Icon name="plus" size={13} /> New project
                  </button>
                </div>
              ) : (
                <div className="project-list">
                  {projects.slice(0, 6).map((project, index) => {
                    const signal = signals[String(project.id)] || {};
                    const progress = signal.progress;
                    const pct = progress ? Math.max(0, Math.min(100, Number(progress.progress_percent) || 0)) : null;
                    const needsAttention = !Number(project.budget) || (signalsReady && !progress) || (signal.alerts || []).length > 0;
                    return (
                      <button className="project-row" key={project.id} onClick={() => openProject(project)}>
                        <div className="project-avatar">
                          <Icon name={index % 3 === 0 ? 'building' : index % 3 === 1 ? 'mapPin' : 'route'} size={16} />
                        </div>
                        <div style={{ minWidth: 0 }}>
                          <div className="project-name">{project.name}</div>
                          <div className="project-meta">
                            <span>{project.location || 'Location missing'}</span>
                            <span>·</span>
                            <span>{pct === null ? 'Progress not recorded' : `${fmt(pct, 0)}% complete`}</span>
                          </div>
                        </div>
                        <div className="project-money">
                          {Number(project.budget) ? `${compactValue(project.budget)}` : '—'}
                          <span>ETB budget</span>
                        </div>
                        <span className={`project-status ${needsAttention ? 'attention' : ''}`}>
                          <span className="status-dot" style={{ width: 4, height: 4, boxShadow: 'none', background: needsAttention ? 'currentColor' : undefined }} />
                          {needsAttention ? 'Attention' : 'On track'}
                        </span>
                        <Icon name="chevronRight" size={15} className="project-arrow" />
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div className="panel-head-copy">
                <h3>Commercial control</h3>
                <p>Physical progress against recorded spend{leadProject ? ` · ${leadProject.name}` : ''}.</p>
              </div>
              <button className="panel-action" onClick={() => setCurrentScreen('project-dashboard')}>
                Open ledger <Icon name="chevronRight" size={12} />
              </button>
            </div>
            <div className="panel-body">
              <div className="meter-block">
                <div className="meter-head"><span>Physical progress</span><strong>{leadPct === null ? 'Not recorded' : `${fmt(leadPct, 1)}%`}</strong></div>
                <div className="meter-track"><div className="meter-fill" style={{ width: `${leadPct || 0}%` }} /></div>
              </div>
              <div className="meter-block">
                <div className="meter-head"><span>Budget used</span><strong>{leadBudget > 0 ? `${fmt(leadSpendPct, 1)}%` : 'No budget'}</strong></div>
                <div className="meter-track"><div className={`meter-fill ${leadSpendPct > (leadPct || 0) ? 'warn' : 'copper'}`} style={{ width: `${leadSpendPct}%` }} /></div>
              </div>
              <div className={`commercial-note ${leadPct === null || leadBurnGap < -1 ? 'warn' : ''}`}>
                <Icon name={leadPct === null ? 'alert' : leadBurnGap < -1 ? 'alert' : 'checkCircle'} size={12} />
                <span>
                  {leadPct === null
                    ? 'No physical progress has been recorded, so cost performance cannot be certified.'
                    : leadBurnGap < -1
                      ? `Spend is ${fmt(Math.abs(leadBurnGap), 1)} points ahead of physical progress. Review before certification.`
                      : 'Physical progress and recorded spend are broadly aligned.'}
                </span>
              </div>
            </div>
          </section>
        </div>

        <div className="stack">
          <section className="panel brief">
            <div className="panel-head">
              <div className="panel-head-copy">
                <h3>Operational brief</h3>
                <p>Site AI · grounded in current records</p>
              </div>
              <div className="brief-label"><span className="brief-live" /> Live</div>
            </div>
            <div className="panel-body">
              <div className="brief-copy">
                {leadProject ? (
                  <>
                    <em>{leadProject.name}</em> is the active site.
                    {leadPct === null
                      ? ' Field progress is not recorded yet, so cost performance cannot be certified.'
                      : ` Work is ${fmt(leadPct, 0)}% complete and the evidence chain is available for review.`}
                  </>
                ) : (
                  <>The workspace is ready. Add a project to begin the evidence chain from ground control to payment assurance.</>
                )}
              </div>

              <div className="brief-checks">
                <div className={`brief-check ${alertCount > 0 ? 'warn' : ''}`}>
                  <Icon name={alertCount > 0 ? 'alert' : 'checkCircle'} size={13} />
                  <span><strong>{alertCount > 0 ? `${alertCount} risk flag${alertCount === 1 ? '' : 's'}` : 'Payment assurance'}</strong> {alertCount > 0 ? 'need review before the next certificate.' : 'is clear across the active portfolio.'}</span>
                </div>
                <div className={`brief-check ${reported < projects.length ? 'warn' : ''}`}>
                  <Icon name={reported < projects.length ? 'clock' : 'checkCircle'} size={13} />
                  <span><strong>Field reporting</strong> {reported < projects.length ? `is missing on ${projects.length - reported} project${projects.length - reported === 1 ? '' : 's'}.` : 'is current for every active project.'}</span>
                </div>
                <div className="brief-check">
                  <Icon name="map" size={13} />
                  <span><strong>Spatial evidence</strong> {projects.some(project => project.location) ? 'has a site anchor in the portfolio.' : 'needs a site location before maps can be trusted.'}</span>
                </div>
              </div>

              <div className="brief-actions">
                <button className="btn btn-light btn-sm" onClick={() => setCurrentScreen(leadProject ? 'project-dashboard' : 'new-project')}>
                  {leadProject ? 'Review progress' : 'Create project'} <Icon name="arrowRight" size={12} />
                </button>
                <button className="btn btn-dark btn-sm" onClick={() => setCurrentScreen('fraud')}>
                  Review risk
                </button>
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div className="panel-head-copy">
                <h3>Evidence chain</h3>
                <p>Follow the record from ground to payment.</p>
              </div>
            </div>
            <div className="panel-body">
              <div className="twin-list">
                {[
                  ['surveying', 'compass', 'Field capture', 'Control points and observations'],
                  ['gis', 'map', 'Spatial context', 'Layers, terrain and georeferencing'],
                  ['3d-viewer', 'cube', 'Digital twin', 'Model, terrain and asset records'],
                  ['fraud', 'shield', 'Payment assurance', 'Risk scoring and evidence review']
                ].map(([screen, icon, title, copy]) => (
                  <button className="twin-row" key={screen} onClick={() => setCurrentScreen(screen)} style={{ background: 'none', borderWidth: 0, borderRight: 0, borderBottom: 0, borderLeft: 0, textAlign: 'left', width: '100%' }}>
                    <span className="twin-row-icon"><Icon name={icon} size={12} /></span>
                    <span className="twin-row-copy"><strong>{title}</strong><span>{copy}</span></span>
                    <Icon name="chevronRight" size={12} style={{ color: 'var(--line-strong)' }} />
                  </button>
                ))}
              </div>
            </div>
          </section>
        </div>
      </div>

      <section className="panel">
        <div className="panel-head">
          <div className="panel-head-copy">
            <h3>Operating model</h3>
            <p>Every record stays connected to the decision it supports.</p>
          </div>
        </div>
        <div className="panel-body">
          <div className="stage-grid">
            {[
              ['01', 'Capture', 'Observe the site and preserve field evidence.'],
              ['02', 'Georeference', 'Place every record in a trusted coordinate frame.'],
              ['03', 'Model', 'Connect quantities, terrain and asset identity.'],
              ['04', 'Assure', 'Compare progress, cost and evidence before payment.']
            ].map(([number, title, copy]) => (
              <div className="stage" key={number}>
                <div className="stage-number">{number}</div>
                <div className="stage-title">{title}</div>
                <div className="stage-copy">{copy}</div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

// ===================== BIM IMPORT SCREEN (NEW) =====================
function BimImportScreen({ token, projects }) {
  const [projectId, setProjectId] = useState('');
  const [file, setFile] = useState(null);
  const [paste, setPaste] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [report, setReport] = useState(null);
  const [components, setComponents] = useState([]);

  const authHeaders = { Authorization: `Bearer ${token}` };

  const loadComponents = async (id) => {
    if (!id) { setComponents([]); return; }

    try {
      const response = await axios.get(`${API_URL}/api/bim/components/${id}`, { headers: authHeaders });
      setComponents(response.data);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  useEffect(() => {
    loadComponents(projectId);
  }, [projectId]);

  const handleUpload = async (e) => {
    e.preventDefault();
    if (!projectId) { setError('Select a project first.'); return; }
    if (!file) { setError('Choose a CSV or TSV take-off file first.'); return; }

    const form = new FormData();
    form.append('file', file);
    form.append('projectId', projectId);

    setBusy(true); setError(''); setReport(null);

    try {
      const response = await axios.post(`${API_URL}/api/bim/import`, form, { headers: authHeaders });
      setReport({ source: file.name, ...response.data.parsed });
      setFile(null);
      e.target.reset();
      await loadComponents(projectId);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  };

  const handlePaste = async (e) => {
    e.preventDefault();
    if (!projectId) { setError('Select a project first.'); return; }
    if (!paste.trim()) { setError('Paste some take-off rows first.'); return; }

    setBusy(true); setError(''); setReport(null);

    try {
      const response = await axios.post(`${API_URL}/api/bim/components`, { projectId, raw: paste }, { headers: authHeaders });
      setReport({ source: 'pasted rows', ...response.data.parsed });
      setPaste('');
      await loadComponents(projectId);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
      setReport(err.response?.data?.parsed || null);
    } finally {
      setBusy(false);
    }
  };

  const handleClear = async () => {
    if (!projectId) return;
    if (!window.confirm('Delete every component in this project? The quantity survey, BOM and 3D viewer will be empty again.')) return;

    setBusy(true); setError(''); setReport(null);

    try {
      await axios.delete(`${API_URL}/api/bim/components/${projectId}`, { headers: authHeaders });
      await loadComponents(projectId);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  };

  const downloadTemplate = () => {
    const csv = [
      'Component,Material Type,Quantity,Unit,Phase',
      'Ground floor slab,Concrete,24.50,m3,Substructure',
      'Column C1 (300x300),Concrete,1.80,m3,Superstructure',
      'External wall,CMU Blocks,410,units,Superstructure',
      'Distribution board,Electrical,1,units,MEP'
    ].join('\n');

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'bim-components-template.csv';
    link.click();
    URL.revokeObjectURL(url);
  };

  // Totals grouped by material *and* unit, mirroring the quantity-survey API.
  const totals = Object.values(components.reduce((acc, row) => {
    const key = `${row.material_type}|${row.unit}`;
    if (!acc[key]) acc[key] = { materialType: row.material_type, unit: row.unit, quantity: 0, count: 0 };
    acc[key].quantity += num(row.quantity);
    acc[key].count += 1;
    return acc;
  }, {})).sort((a, b) => String(a.materialType).localeCompare(String(b.materialType)));

  return (
    <div className="page">
      <div className="page-head">
        <div className="page-head-copy">
          <div className="eyebrow">Delivery / model input</div>
          <h1 className="page-title">BIM import</h1>
          <p className="page-sub">
            Bring a quantity take-off from Revit, ArchiCAD, Navisworks or any IFC tool into the
            evidence chain. Imported components feed the quantity survey, BOM and digital twin.
          </p>
        </div>
        <div className="page-actions">
          <div className="gis-project">
            <Icon name="building" size={13} />
            <label htmlFor="bim-project">Project</label>
            <select id="bim-project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">Select project</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <button onClick={downloadTemplate} className="btn" type="button">
            <Icon name="download" size={13} /> CSV template
          </button>
        </div>
      </div>

      {error && <div className="section-note" style={{ color: 'var(--danger)', background: 'var(--danger-soft)', borderColor: '#ecc9c4' }}><Icon name="alert" size={13} /> {error}</div>}

      {!projectId ? (
        <div className="empty">
          <div className="empty-icon"><Icon name="upload" /></div>
          <h4>Choose a project to import a take-off</h4>
          <p>Components are stored against one project, then shared with the quantity survey and digital twin.</p>
        </div>
      ) : (
        <>
          <div className="kpi-grid">
            <div className="kpi">
              <div className="kpi-label"><Icon name="box" size={12} /> Components</div>
              <div className="kpi-value">{components.length}</div>
              <div className="kpi-meta">Imported take-off rows</div>
            </div>
            <div className="kpi">
              <div className="kpi-label"><Icon name="layers" size={12} /> Material lines</div>
              <div className="kpi-value">{totals.length}</div>
              <div className="kpi-meta">Grouped by material and unit</div>
            </div>
            <div className="kpi">
              <div className="kpi-label"><Icon name="activity" size={12} /> Import status</div>
              <div className="kpi-value" style={{ fontSize: 24 }}>{components.length ? 'Ready' : 'Waiting'}</div>
              <div className={`kpi-meta ${components.length ? '' : 'warn'}`}>
                {components.length ? 'Available to survey and twin' : 'No components imported'}
              </div>
            </div>
          </div>

          <div className="split-grid">
            <section className="panel">
              <div className="panel-head">
                <div className="panel-head-copy">
                  <h3>Upload a file</h3>
                  <p>CSV, TSV or TXT. Extra columns are ignored.</p>
                </div>
                <span className="panel-eyebrow">01</span>
              </div>
              <form onSubmit={handleUpload} className="panel-body">
                <div className="upload-zone">
                  <Icon name="upload" size={22} style={{ color: 'var(--copper)', marginBottom: 8 }} />
                  <input
                    type="file"
                    accept=".csv,.tsv,.txt,text/csv,text/plain"
                    onChange={(e) => setFile(e.target.files?.[0] || null)}
                  />
                  <span style={{ marginTop: 7, color: 'var(--ink-3)', fontSize: 9.5 }}>
                    Component · Material Type · Quantity · Unit · Phase
                  </span>
                </div>
                <div className="form-actions">
                  <button type="submit" className="btn btn-primary" disabled={busy}>
                    <Icon name="upload" size={13} /> {busy ? 'Importing…' : 'Import take-off'}
                  </button>
                </div>
              </form>
            </section>

            <section className="panel">
              <div className="panel-head">
                <div className="panel-head-copy">
                  <h3>Paste from Excel</h3>
                  <p>Select a range, copy it, and paste the rows here.</p>
                </div>
                <span className="panel-eyebrow">02</span>
              </div>
              <form onSubmit={handlePaste} className="panel-body">
                <textarea
                  className="code-area"
                  placeholder={'Component\tMaterial Type\tQuantity\tUnit\tPhase\nGround floor slab\tConcrete\t24.5\tm3\tSubstructure'}
                  value={paste}
                  onChange={(e) => setPaste(e.target.value)}
                />
                <div className="form-actions">
                  <button type="submit" className="btn btn-copper" disabled={busy}>
                    <Icon name="clipboard" size={13} /> {busy ? 'Importing…' : 'Import pasted rows'}
                  </button>
                </div>
              </form>
            </section>
          </div>

          {report && (
            <section className="panel">
              <div className="panel-head">
                <div className="panel-head-copy">
                  <h3>Import report</h3>
                  <p>{report.source ? `Source: ${report.source}` : 'Pasted rows'}</p>
                </div>
                <span className={`project-status ${report.skipped ? 'attention' : ''}`}>
                  {report.skipped ? 'Review skipped rows' : 'Import complete'}
                </span>
              </div>
              <div className="panel-body">
                <div className="toolbar-row" style={{ marginBottom: report.errors?.length ? 14 : 0 }}>
                  <span className="context-line"><strong>{report.imported}</strong> imported</span>
                  <span className="context-line"><strong>{report.skipped}</strong> skipped</span>
                  <span className="context-line"><strong>{report.rowsFound}</strong> rows read</span>
                </div>
                {report.errors && report.errors.length > 0 && (
                  <div className="table-wrap">
                    <table className="data-table">
                      <thead><tr><th>Line</th><th>Reason</th></tr></thead>
                      <tbody>
                        {report.errors.map((issue, index) => (
                          <tr key={index}><td className="num">{issue.row || '-'}</td><td>{issue.message}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </section>
          )}

          <section className="panel">
            <div className="panel-head">
              <div className="panel-head-copy">
                <h3>Material totals</h3>
                <p>Grouped exactly as the quantity survey will read them.</p>
              </div>
              <span className="panel-eyebrow">{totals.length} lines</span>
            </div>
            <div className="panel-body flush">
              {components.length === 0 ? (
                <div className="empty" style={{ margin: 14 }}>
                  <div className="empty-icon"><Icon name="box" /></div>
                  <h4>No components yet</h4>
                  <p>Import a take-off above and the quantity survey and digital twin will have data to work with.</p>
                </div>
              ) : (
                <div className="table-wrap">
                  <table className="data-table">
                    <thead><tr><th>Material</th><th>Unit</th><th className="num">Total quantity</th><th className="num">Components</th></tr></thead>
                    <tbody>
                      {totals.map((row, index) => (
                        <tr key={index}>
                          <td className="strong">{row.materialType}</td>
                          <td>{row.unit}</td>
                          <td className="num">{num(row.quantity).toLocaleString()}</td>
                          <td className="num">{row.count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>

          {components.length > 0 && (
            <section className="panel">
              <div className="panel-head">
                <div className="panel-head-copy">
                  <h3>Imported components</h3>
                  <p>{components.length} rows currently feed the digital twin.</p>
                </div>
                <button onClick={handleClear} className="btn btn-danger btn-sm" disabled={busy}>
                  <Icon name="x" size={12} /> Clear take-off
                </button>
              </div>
              <div className="panel-body flush">
                <div className="table-wrap">
                  <table className="data-table">
                    <thead><tr><th>Component</th><th>Material</th><th className="num">Quantity</th><th>Unit</th><th>Phase</th></tr></thead>
                    <tbody>
                      {components.map(row => (
                        <tr key={row.id}>
                          <td className="strong">{row.component_name}</td>
                          <td>{row.material_type}</td>
                          <td className="num">{num(row.quantity).toLocaleString()}</td>
                          <td>{row.unit}</td>
                          <td>{row.phase || 'Unassigned'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

// ===================== PROGRESS TREND CHART =====================
function ProgressTrendChart({ rows, budget }) {
  const width = 720;
  const height = 220;
  const padLeft = 46;
  const padRight = 14;
  const padTop = 16;
  const padBottom = 30;

  const progressOf = (row) => Math.max(0, num(row.progress_percent));
  const spendOf = (row) => (budget > 0 ? (num(row.budget_spent) / budget) * 100 : 0);

  // The axis fits 100% by default, and stretches when spending has gone past budget.
  const peak = Math.max(100, ...rows.map(spendOf), ...rows.map(progressOf));
  const domainMax = Math.max(100, Math.ceil(peak / 25) * 25);

  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;

  const x = (index) => (rows.length === 1
    ? padLeft + plotWidth / 2
    : padLeft + (index / (rows.length - 1)) * plotWidth);
  const y = (value) => padTop + plotHeight - (Math.max(0, Math.min(domainMax, value)) / domainMax) * plotHeight;
  const path = (values) => values
    .map((value, index) => `${index === 0 ? 'M' : 'L'}${x(index).toFixed(1)},${y(value).toFixed(1)}`)
    .join(' ');

  const gridValues = [];
  for (let value = 0; value <= domainMax; value += 25) gridValues.push(value);

  const progressValues = rows.map(progressOf);
  const spendValues = rows.map(spendOf);

  // Several entries often land on one day, so label by time unless the series spans longer.
  const firstTime = new Date(rows[0].created_at).getTime();
  const lastTime = new Date(rows[rows.length - 1].created_at).getTime();
  const sameDay = lastTime - firstTime < 24 * 60 * 60 * 1000;
  const labelStep = Math.max(1, Math.ceil(rows.length / 7));

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="Progress and budget used over time"
      style={{width: '100%', height: 'auto', display: 'block', marginTop: '10px'}}
    >
      {gridValues.map((value) => (
        <g key={value}>
          <line
            x1={padLeft} x2={width - padRight} y1={y(value)} y2={y(value)}
            stroke="#e7edf4" strokeWidth="1"
          />
          <text x={padLeft - 8} y={y(value) + 4} textAnchor="end" fontSize="11" fill="#6b7785">
            {value}%
          </text>
        </g>
      ))}

      <line x1={padLeft} x2={width - padRight} y1={height - padBottom} y2={height - padBottom} stroke="#c3cdd8" strokeWidth="1" />

      <path d={path(spendValues)} fill="none" stroke="#FF6B35" strokeWidth="2.5" strokeLinejoin="round" />
      <path d={path(progressValues)} fill="none" stroke="#06a77d" strokeWidth="2.5" strokeLinejoin="round" />

      {rows.map((row, index) => (
        <g key={row.id ?? index}>
          <circle cx={x(index)} cy={y(spendOf(row))} r="3.5" fill="#FF6B35" />
          <circle cx={x(index)} cy={y(progressOf(row))} r="3.5" fill="#06a77d" />
        </g>
      ))}

      {rows.map((row, index) => {
        if (index % labelStep !== 0 && index !== rows.length - 1) return null;

        return (
          <text
            key={`label-${row.id ?? index}`}
            x={x(index)} y={height - padBottom + 16}
            textAnchor="middle" fontSize="10" fill="#6b7785"
          >
            {sameDay
              ? new Date(row.created_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
              : new Date(row.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
          </text>
        );
      })}
    </svg>
  );
}

// ===================== PROJECT DASHBOARD (PROGRESS vs BUDGET + FRAUD ALERTS) =====================
function ProjectDashboardScreen({ token, projects, setCurrentScreen, setSelectedProject }) {
  const [projectId, setProjectId] = useState('');
  const [project, setProject] = useState(null);
  const [progress, setProgress] = useState(null);
  const [history, setHistory] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [forecast, setForecast] = useState(null);
  const [estimate, setEstimate] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ progressPercent: '', budgetSpent: '', notes: '' });

  const authHeaders = { Authorization: `Bearer ${token}` };

  const load = async (id) => {
    if (!id) {
      setProject(null); setProgress(null); setHistory([]); setAlerts([]); setForecast(null); setEstimate(null);
      return;
    }

    try {
      // Progress, survey and forecast all 404 until something has been recorded,
      // so they are optional rather than failures of the screen.
      const optional = (url) => axios.get(url, { headers: authHeaders }).catch(() => null);

      const [projectResponse, progressResponse, historyResponse, alertsResponse, surveyResponse, forecastResponse] = await Promise.all([
        axios.get(`${API_URL}/api/projects/${id}`, { headers: authHeaders }),
        optional(`${API_URL}/api/progress/${id}`),
        optional(`${API_URL}/api/progress/${id}/history`),
        axios.get(`${API_URL}/api/fraud-detection/${id}`, { headers: authHeaders }),
        optional(`${API_URL}/api/quantity-survey/${id}`),
        optional(`${API_URL}/api/budget/forecast/${id}`)
      ]);

      setProject(projectResponse.data);
      setProgress(progressResponse?.data || null);
      setHistory(Array.isArray(historyResponse?.data) ? historyResponse.data : []);
      setAlerts(alertsResponse.data || []);
      setEstimate(surveyResponse?.data || null);
      setForecast(forecastResponse?.data || null);

      const latest = progressResponse?.data || {};
      setForm({
        progressPercent: latest.progress_percent == null ? '' : String(num(latest.progress_percent)),
        budgetSpent: latest.budget_spent == null ? '' : String(num(latest.budget_spent)),
        notes: latest.notes || ''
      });
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  useEffect(() => {
    setError(''); setNotice('');
    load(projectId);
  }, [projectId]);

  const saveProgress = async (e) => {
    e.preventDefault();

    const percent = form.progressPercent === '' ? null : Number(form.progressPercent);
    const spent = form.budgetSpent === '' ? null : Number(form.budgetSpent);

    if (percent === null || !Number.isFinite(percent) || percent < 0 || percent > 100) {
      setError('Progress must be a number between 0 and 100.');
      return;
    }
    if (spent === null || !Number.isFinite(spent) || spent < 0) {
      setError('Budget spent must be zero or more.');
      return;
    }

    setBusy(true); setError(''); setNotice('');

    try {
      await axios.post(`${API_URL}/api/progress/update`, {
        projectId,
        progressPercent: percent,
        budgetSpent: spent,
        notes: form.notes
      }, { headers: authHeaders });

      setNotice('Progress recorded.');
      await load(projectId);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  };

  const generateForecast = async () => {
    const budget = num(project?.budget);

    if (!budget || budget <= 0) {
      setError('This project has no budget set, so there is nothing to split.');
      return;
    }

    setBusy(true); setError(''); setNotice('');

    try {
      await axios.post(`${API_URL}/api/budget/forecast`, { projectId, totalBudget: budget }, { headers: authHeaders });
      setNotice('Budget forecast generated.');
      await load(projectId);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  };

  const budget = num(project?.budget);
  const spent = num(progress?.budget_spent);
  const progressPct = Math.max(0, Math.min(100, num(progress?.progress_percent)));
  const spentPct = budget > 0 ? (spent / budget) * 100 : 0;
  const remaining = budget - spent;
  const burnGap = spentPct - progressPct;
  const estimateTotal = num(estimate?.totalAmount);
  const blockedAlerts = alerts.filter(a => String(a.recommendation).toUpperCase() === 'BLOCK_PAYMENT').length;

  const readDetails = (value) => {
    try { return JSON.parse(value) || {}; } catch (err) { return {}; }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div className="page-head-copy">
          <div className="eyebrow">Delivery / commercial control</div>
          <h1 className="page-title">Progress & budget</h1>
          <p className="page-sub">
            Record physical progress against spend, then compare the burn with the rated take-off
            and payment-risk position before certifying work.
          </p>
        </div>
        <div className="page-actions">
          <div className="gis-project">
            <Icon name="chart" size={13} />
            <label htmlFor="progress-project">Project</label>
            <select id="progress-project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">Select project</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          {projectId && (
            <button
              className="btn"
              onClick={() => {
                const current = projects.find(p => String(p.id) === String(projectId));
                if (current) setSelectedProject(current);
                setCurrentScreen('project-details');
              }}
            >
              <Icon name="projects" size={13} /> Project record
            </button>
          )}
        </div>
      </div>

      {error && <div className="section-note" style={{ color: 'var(--danger)', background: 'var(--danger-soft)', borderColor: '#ecc9c4' }}><Icon name="alert" size={13} /> {error}</div>}
      {notice && <div className="section-note"><Icon name="checkCircle" size={13} /> {notice}</div>}

      {!projectId ? (
        <div className="empty">
          <div className="empty-icon"><Icon name="chart" /></div>
          <h4>Choose a project to open its commercial position</h4>
          <p>Progress entries are kept over time so the burn gap and forecast can be reviewed.</p>
        </div>
      ) : (
        <>
          <div className="kpi-grid">
            <div className="kpi">
              <div className="kpi-label"><Icon name="database" size={12} /> Budget</div>
              <div className="kpi-value">{compactValue(budget)} <small>ETB</small></div>
              <div className="kpi-meta">{project?.name}</div>
            </div>
            <div className="kpi">
              <div className="kpi-label"><Icon name="activity" size={12} /> Spent</div>
              <div className="kpi-value">{compactValue(spent)} <small>ETB</small></div>
              <div className="kpi-meta">{fmt(spentPct, 1)}% of budget</div>
            </div>
            <div className="kpi">
              <div className="kpi-label"><Icon name="database" size={12} /> Remaining</div>
              <div className="kpi-value" style={{ color: remaining < 0 ? 'var(--danger)' : 'var(--ink)' }}>{compactValue(remaining)} <small>ETB</small></div>
              <div className={`kpi-meta ${remaining < 0 ? 'warn' : ''}`}>{remaining < 0 ? 'Over budget' : 'Left to spend'}</div>
            </div>
            <div className="kpi">
              <div className="kpi-label"><Icon name="checkCircle" size={12} /> Progress</div>
              <div className="kpi-value">{fmt(progressPct, 1)}<small>%</small></div>
              <div className="kpi-meta">{progress ? `Recorded ${new Date(progress.created_at).toLocaleDateString()}` : 'Not recorded yet'}</div>
            </div>
          </div>

          <div className="dash-grid">
            <div className="stack">
              <section className="panel">
                <div className="panel-head">
                  <div className="panel-head-copy">
                    <h3>Progress against budget</h3>
                    <p>Work complete compared with recorded spend.</p>
                  </div>
                  <span className={`project-status ${spentPct > progressPct + 1 ? 'attention' : ''}`}>
                    {spentPct > progressPct + 1 ? 'Cost ahead' : 'In step'}
                  </span>
                </div>
                <div className="panel-body">
                  <div className="meter-block">
                    <div className="meter-head"><span>Work complete</span><strong>{fmt(progressPct, 1)}%</strong></div>
                    <div className="meter-track"><div className="meter-fill" style={{ width: `${Math.max(0, Math.min(100, progressPct))}%` }} /></div>
                  </div>
                  <div className="meter-block">
                    <div className="meter-head"><span>Budget used</span><strong>{fmt(spentPct, 1)}%</strong></div>
                    <div className="meter-track"><div className={`meter-fill ${spentPct > progressPct ? 'warn' : 'copper'}`} style={{ width: `${Math.max(0, Math.min(100, spentPct))}%` }} /></div>
                  </div>
                  <div className={`commercial-note ${burnGap > 1 ? 'warn' : ''}`}>
                    <Icon name={burnGap > 1 ? 'alert' : 'checkCircle'} size={12} />
                    <span>
                      {burnGap > 1
                        ? `Spending is ${fmt(burnGap, 1)} points ahead of progress — cost is outrunning the work done.`
                        : burnGap < -1
                          ? `Spending is ${fmt(Math.abs(burnGap), 1)} points behind progress — the project is earning faster than it is consuming budget.`
                          : 'Spending and progress are roughly in step.'}
                    </span>
                  </div>
                  {estimateTotal > 0 && (
                    <div className="context-line" style={{ marginTop: 10 }}>
                      Rated take-off: <strong>{money(estimateTotal)} ETB</strong>
                      {budget > 0 && ` · ${fmt((estimateTotal / budget) * 100, 1)}% of budget`}
                    </div>
                  )}
                </div>
              </section>

              <section className="panel">
                <div className="panel-head">
                  <div className="panel-head-copy">
                    <h3>Progress and spend over time</h3>
                    <p>{history.length ? `${history.length} recorded ${history.length === 1 ? 'entry' : 'entries'}, oldest first.` : 'No trend yet.'}</p>
                  </div>
                  {history.length > 0 && (
                    <div className="toolbar-row">
                      <span className="context-line"><span style={{ color: 'var(--signal)' }}>●</span> Progress</span>
                      <span className="context-line"><span style={{ color: 'var(--copper)' }}>●</span> Budget used</span>
                    </div>
                  )}
                </div>
                <div className="panel-body">
                  {history.length === 0 ? (
                    <div className="empty" style={{ minHeight: 170 }}>
                      <div className="empty-icon"><Icon name="activity" /></div>
                      <h4>No progress entries</h4>
                      <p>Each save in the form adds a point to this trend. Record the first entry to begin.</p>
                    </div>
                  ) : (
                    <ProgressTrendChart rows={history} budget={budget} />
                  )}
                </div>
              </section>

              <section className="panel">
                <div className="panel-head">
                  <div className="panel-head-copy">
                    <h3>Progress history</h3>
                    <p>Every progress record, newest first.</p>
                  </div>
                  <span className="panel-eyebrow">{history.length} entries</span>
                </div>
                <div className="panel-body flush">
                  {history.length === 0 ? (
                    <p className="panel-body" style={{ color: 'var(--ink-3)', fontSize: 10.5 }}>No entries yet.</p>
                  ) : (
                    <div className="table-wrap">
                      <table className="data-table">
                        <thead><tr><th>Recorded</th><th className="num">Progress</th><th className="num">Spent (ETB)</th><th className="num">% of budget</th><th>Notes</th></tr></thead>
                        <tbody>
                          {[...history].reverse().map((entry) => {
                            const entryProgress = num(entry.progress_percent);
                            const entrySpent = num(entry.budget_spent);
                            const entrySpentPct = budget > 0 ? (entrySpent / budget) * 100 : 0;
                            return (
                              <tr key={entry.id}>
                                <td>{new Date(entry.created_at).toLocaleString()}</td>
                                <td className="num">{fmt(entryProgress, 1)}%</td>
                                <td className="num">{money(entrySpent)}</td>
                                <td className="num" style={{ color: entrySpentPct > entryProgress + 1 ? 'var(--danger)' : 'var(--signal)' }}>{fmt(entrySpentPct, 1)}%</td>
                                <td>{entry.notes || '—'}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </section>
            </div>

            <div className="stack">
              <section className="panel">
                <div className="panel-head">
                  <div className="panel-head-copy"><h3>Record progress</h3><p>Adds a new dated entry.</p></div>
                  <Icon name="plus" size={14} style={{ color: 'var(--copper)' }} />
                </div>
                <form onSubmit={saveProgress} className="panel-body">
                  <div className="form-grid">
                    <div className="field">
                      <label htmlFor="progress-percent">Progress complete (%)</label>
                      <input
                        id="progress-percent" className="input" type="number" min="0" max="100" step="0.1"
                        value={form.progressPercent}
                        onChange={(e) => setForm({ ...form, progressPercent: e.target.value })}
                        required
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="progress-spent">Budget spent (ETB)</label>
                      <input
                        id="progress-spent" className="input" type="number" min="0" step="0.01"
                        value={form.budgetSpent}
                        onChange={(e) => setForm({ ...form, budgetSpent: e.target.value })}
                        required
                      />
                    </div>
                    <div className="field full">
                      <label htmlFor="progress-notes">Notes</label>
                      <textarea
                        id="progress-notes" className="input" style={{ height: 76, paddingTop: 9, resize: 'vertical' }}
                        placeholder="What was completed, inspected or certified?"
                        value={form.notes}
                        onChange={(e) => setForm({ ...form, notes: e.target.value })}
                      />
                    </div>
                  </div>
                  <div className="form-actions">
                    <button type="submit" className="btn btn-primary" disabled={busy}>
                      <Icon name="check" size={13} /> {busy ? 'Saving…' : 'Save progress'}
                    </button>
                  </div>
                  <p className="helper">Each save is kept. The overview uses the most recent entry.</p>
                </form>
              </section>

              <section className="panel">
                <div className="panel-head">
                  <div className="panel-head-copy"><h3>Fraud alerts</h3><p>{alerts.length} checks · {blockedAlerts} blocked payment.</p></div>
                  <Icon name="shield" size={14} style={{ color: blockedAlerts ? 'var(--danger)' : 'var(--signal)' }} />
                </div>
                <div className="panel-body flush">
                  {alerts.length === 0 ? (
                    <div className="empty" style={{ margin: 14, minHeight: 120 }}>
                      <div className="empty-icon"><Icon name="shield" /></div>
                      <h4>No risk checks</h4>
                      <p>Run a check on Risk & fraud and its recommendation will appear here.</p>
                    </div>
                  ) : (
                    <div className="table-wrap">
                      <table className="data-table">
                        <thead><tr><th>Checked</th><th className="num">Score</th><th>Decision</th><th className="num">Qty var.</th><th className="num">Price var.</th></tr></thead>
                        <tbody>
                          {alerts.map((alert) => {
                            const details = readDetails(alert.details);
                            const blocked = String(alert.recommendation).toUpperCase() === 'BLOCK_PAYMENT';
                            return (
                              <tr key={alert.id}>
                                <td>{new Date(alert.created_at).toLocaleDateString()}</td>
                                <td className="num" style={{ color: blocked ? 'var(--danger)' : 'var(--signal)' }}>{fmt(alert.fraud_score, 1)}%</td>
                                <td><span className={`project-status ${blocked ? 'attention' : ''}`}>{blocked ? 'Block payment' : 'Approve'}</span></td>
                                <td className="num">{details.qtyVariance == null ? '—' : fmt(num(details.qtyVariance) * 100, 1) + '%'}</td>
                                <td className="num">{details.priceVariance == null ? '—' : fmt(num(details.priceVariance) * 100, 1) + '%'}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </section>

              <section className="panel">
                <div className="panel-head">
                  <div className="panel-head-copy"><h3>Budget forecast</h3><p>{forecast ? `Generated ${new Date(forecast.created_at).toLocaleDateString()}` : 'Not generated yet.'}</p></div>
                  <Icon name="database" size={14} style={{ color: 'var(--ink-3)' }} />
                </div>
                <div className="panel-body">
                  {!forecast ? (
                    <p className="helper" style={{ marginTop: 0 }}>A forecast splits the project budget across materials, labour, equipment and contingency.</p>
                  ) : (
                    <div className="table-wrap">
                      <table className="data-table">
                        <thead><tr><th>Category</th><th className="num">Allocated</th><th className="num">Share</th></tr></thead>
                        <tbody>
                          {[['Materials', forecast.materials], ['Labour', forecast.labor], ['Equipment', forecast.equipment], ['Contingency', forecast.contingency]].map(([label, value]) => (
                            <tr key={label}>
                              <td className="strong">{label}</td>
                              <td className="num">{money(value)}</td>
                              <td className="num">{forecast.allocated > 0 ? fmt((num(value) / forecast.allocated) * 100, 1) + '%' : '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot><tr><td>Total allocated</td><td className="num">{money(forecast.allocated)}</td><td className="num">100%</td></tr></tfoot>
                      </table>
                    </div>
                  )}
                  <div className="form-actions">
                    <button onClick={generateForecast} className="btn btn-copper btn-sm" disabled={busy || !(budget > 0)}>
                      <Icon name="refresh" size={12} /> {busy ? 'Working…' : forecast ? 'Regenerate forecast' : 'Generate forecast'}
                    </button>
                  </div>
                </div>
              </section>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ===================== SURVEYING CONTROL POINTS SCREEN (NEW) =====================
function SurveyingControlPointsScreen({ token, projects }) {
  const [projectId, setProjectId] = useState('');
  const [controlPointName, setControlPointName] = useState('BM-01');
  const [verticalDatum, setVerticalDatum] = useState('Project benchmark as recorded');
  const [pointStatus, setPointStatus] = useState('submitted');
  const [latitude, setLatitude] = useState('9.0320');
  const [longitude, setLongitude] = useState('38.7469');
  const [benchmarkElevation, setBenchmarkElevation] = useState('2355');
  const [groundLevel, setGroundLevel] = useState('2350');
  const [floorLevel, setFloorLevel] = useState('2360');
  const [foundationDepth, setFoundationDepth] = useState('2.5');
  const [buildingFootprint, setBuildingFootprint] = useState('2400');
  const [results, setResults] = useState(null);
  const [saved, setSaved] = useState(null);
  const [points, setPoints] = useState([]);
  const [pointsError, setPointsError] = useState('');
  const [updatingStatus, setUpdatingStatus] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [importFile, setImportFile] = useState(null);
  const [importParsed, setImportParsed] = useState(null);
  const [importReport, setImportReport] = useState(null);
  const [importError, setImportError] = useState('');
  const [importing, setImporting] = useState(false);
  const [importInputKey, setImportInputKey] = useState(0);
  const [defaultDatum, setDefaultDatum] = useState('Project benchmark as recorded');
  const [defaultStatus, setDefaultStatus] = useState('submitted');
  const [historyPoint, setHistoryPoint] = useState(null);
  const [historyEvents, setHistoryEvents] = useState([]);
  const [historyError, setHistoryError] = useState('');
  const [historyLoading, setHistoryLoading] = useState(false);

  const loadPoints = useCallback(async (id) => {
    if (!id) { setPoints([]); return; }
    try {
      const response = await axios.get(`${API_URL}/api/surveying/${id}/control-points`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setPoints(Array.isArray(response.data) ? response.data : []);
      setPointsError('');
    } catch (err) {
      setPointsError(err.response?.data?.error || 'Control points could not be loaded.');
    }
  }, [token]);

  useEffect(() => {
    // Switching project must not leave the previous project's calculation on screen.
    setResults(null);
    setSaved(null);
    setError('');
    setPointsError('');
    setImportFile(null);
    setImportParsed(null);
    setImportReport(null);
    setImportError('');
    setImportInputKey(key => key + 1);
    setHistoryPoint(null);
    setHistoryEvents([]);
    setHistoryError('');
    loadPoints(projectId);
  }, [projectId, loadPoints]);

  const handleCalculate = async (e) => {
    e.preventDefault();
    if (!projectId) { setError('Select a project before calculating earthworks.'); return; }

    setBusy(true); setError(''); setSaved(null);
    try {
      // Save control points
      const saveResponse = await axios.post(`${API_URL}/api/surveying/control-points`, {
        projectId,
        name: controlPointName.trim() || null,
        isBenchmark: true,
        verticalDatum: verticalDatum.trim() || null,
        status: pointStatus,
        latitude: parseFloat(latitude),
        longitude: parseFloat(longitude),
        benchmarkElevation: parseFloat(benchmarkElevation),
        groundLevel: parseFloat(groundLevel),
        floorLevel: parseFloat(floorLevel),
        foundationDepth: parseFloat(foundationDepth),
        buildingFootprint: parseFloat(buildingFootprint)
      }, {
        headers: { Authorization: `Bearer ${token}` }
      });
      
      setSaved(saveResponse.data);

      // Calculate cut & fill
      const fillNeeded = parseFloat(floorLevel) - parseFloat(groundLevel);
      const calcResponse = await axios.post(`${API_URL}/api/earthworks/calculate`, {
        projectId,
        buildingFootprint: parseFloat(buildingFootprint),
        foundationDepth: parseFloat(foundationDepth),
        fillNeeded
      }, {
        headers: { Authorization: `Bearer ${token}` }
      });

      setResults(calcResponse.data);
      await loadPoints(projectId);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleImportFile = async (event) => {
    const file = event.target.files?.[0] || null;
    setImportFile(file);
    setImportParsed(null);
    setImportReport(null);
    setImportError('');

    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      setImportError('The control-point file must be smaller than 2 MB.');
      return;
    }

    try {
      const parsed = parseControlPointText(await file.text());
      setImportParsed(parsed);
    } catch (err) {
      setImportError(err.message || 'That file could not be read.');
    }
  };

  const handleImport = async () => {
    if (!projectId) { setImportError('Select a project before importing control points.'); return; }
    if (!importParsed || importParsed.rows.length === 0) {
      setImportError('Choose a valid CSV or TXT file first.');
      return;
    }

    setImporting(true);
    setImportError('');
    try {
      const response = await axios.post(`${API_URL}/api/surveying/control-points/import`, {
        projectId,
        points: importParsed.rows,
        defaultVerticalDatum: defaultDatum,
        defaultStatus
      }, {
        headers: { Authorization: `Bearer ${token}` }
      });

      setImportReport(response.data);
      await loadPoints(projectId);

      if (response.data.imported > 0) {
        setImportFile(null);
        setImportParsed(null);
        setImportInputKey(key => key + 1);
      }
    } catch (err) {
      setImportError(err.response?.data?.error || err.message);
    } finally {
      setImporting(false);
    }
  };

  const updatePointStatus = async (point, nextStatus) => {
    if (!projectId || !nextStatus || nextStatus === point.status) return;
    setUpdatingStatus(point.id);
    setPointsError('');
    try {
      const response = await axios.patch(`${API_URL}/api/surveying/control-points/${point.id}`, {
        projectId,
        status: nextStatus
      }, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setPoints(current => current.map(item => item.id === point.id ? response.data : item));
      if (historyPoint?.id === point.id) await loadPointHistory(point);
    } catch (err) {
      setPointsError(err.response?.data?.error || 'The control-point status could not be saved.');
    } finally {
      setUpdatingStatus(null);
    }
  };

  const loadPointHistory = async (point) => {
    if (!projectId || !point) return;
    setHistoryPoint(point);
    setHistoryLoading(true);
    setHistoryError('');
    try {
      const response = await axios.get(`${API_URL}/api/surveying/control-points/${point.id}/history`, {
        params: { projectId },
        headers: { Authorization: `Bearer ${token}` }
      });
      setHistoryEvents(Array.isArray(response.data) ? response.data : []);
    } catch (err) {
      setHistoryEvents([]);
      setHistoryError(err.response?.data?.error || 'The status history could not be loaded.');
    } finally {
      setHistoryLoading(false);
    }
  };

  const downloadTemplate = () => {
    downloadCsv('control-point-template.csv', buildCsv(
      ['name', 'latitude', 'longitude', 'benchmark_elevation', 'vertical_datum', 'status', 'is_benchmark'],
      [
        ['BM-01', '9.055607', '38.972702', '2361.24', 'Project benchmark as recorded', 'submitted', 'yes'],
        ['CP-05', '9.053797', '38.970882', '2362.51', 'Project benchmark as recorded', 'draft', 'no']
      ]
    ));
  };

  return (
    <div className="page">
      <div className="page-head">
        <div className="page-head-copy">
          <div className="eyebrow">Field / survey control</div>
          <h1 className="page-title">Field survey</h1>
          <p className="page-sub">
            Record the site control point and design levels, then derive excavation, fill and the
            material quantities that follow from the earthworks balance.
          </p>
        </div>
        <div className="page-actions">
          <div className="gis-project">
            <Icon name="locate" size={13} />
            <label htmlFor="survey-project">Project</label>
            <select id="survey-project" value={projectId} onChange={(e) => setProjectId(e.target.value)} required>
              <option value="">Select project</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        </div>
      </div>

      {error && <div className="section-note" style={{ color: 'var(--danger)', background: 'var(--danger-soft)', borderColor: '#ecc9c4' }}><Icon name="alert" size={13} /> {error}</div>}

      {!projectId ? (
        <div className="empty">
          <div className="empty-icon"><Icon name="locate" /></div>
          <h4>Choose a project to begin</h4>
          <p>Control points and earthwork calculations are stored against one project and shared with its twin.</p>
        </div>
      ) : (
        <>
          <div className="screen-grid">
            <form onSubmit={handleCalculate} className="panel">
              <div className="panel-head">
                <div className="panel-head-copy">
                  <h3>Survey control data</h3>
                  <p>Coordinates and levels are saved before the calculation runs.</p>
                </div>
                <span className="panel-eyebrow">MSL</span>
              </div>
              <div className="panel-body">
                <div className="form-grid">
                  <div className="field full">
                    <label htmlFor="survey-name">Control point name</label>
                    <input id="survey-name" className="input" type="text" maxLength="120" value={controlPointName} onChange={(e) => setControlPointName(e.target.value)} placeholder="e.g. BM-01" />
                  </div>
                  <div className="field">
                    <label htmlFor="survey-lat">Latitude (°N)</label>
                    <input id="survey-lat" className="input" type="number" step="0.0001" value={latitude} onChange={(e) => setLatitude(e.target.value)} required />
                  </div>
                  <div className="field">
                    <label htmlFor="survey-lon">Longitude (°E)</label>
                    <input id="survey-lon" className="input" type="number" step="0.0001" value={longitude} onChange={(e) => setLongitude(e.target.value)} required />
                  </div>
                  <div className="field">
                    <label htmlFor="survey-benchmark">Benchmark elevation (m)</label>
                    <input id="survey-benchmark" className="input" type="number" step="0.1" value={benchmarkElevation} onChange={(e) => setBenchmarkElevation(e.target.value)} required />
                  </div>
                  <div className="field">
                    <label htmlFor="survey-ground">Current ground level (m)</label>
                    <input id="survey-ground" className="input" type="number" step="0.1" value={groundLevel} onChange={(e) => setGroundLevel(e.target.value)} required />
                  </div>
                  <div className="field">
                    <label htmlFor="survey-floor">Designed floor level (m)</label>
                    <input id="survey-floor" className="input" type="number" step="0.1" value={floorLevel} onChange={(e) => setFloorLevel(e.target.value)} required />
                  </div>
                  <div className="field">
                    <label htmlFor="survey-depth">Foundation depth (m)</label>
                    <input id="survey-depth" className="input" type="number" step="0.1" min="0" value={foundationDepth} onChange={(e) => setFoundationDepth(e.target.value)} required />
                  </div>
                  <div className="field full">
                    <label htmlFor="survey-footprint">Building footprint (m²)</label>
                    <input id="survey-footprint" className="input" type="number" step="1" min="0" value={buildingFootprint} onChange={(e) => setBuildingFootprint(e.target.value)} required />
                  </div>
                  <div className="field">
                    <label htmlFor="survey-datum">Vertical datum</label>
                    <input id="survey-datum" className="input" type="text" maxLength="80" value={verticalDatum} onChange={(e) => setVerticalDatum(e.target.value)} placeholder="e.g. Project benchmark as recorded" required />
                  </div>
                  <div className="field">
                    <label htmlFor="survey-status">Status</label>
                    <select id="survey-status" className="input" value={pointStatus} onChange={(e) => setPointStatus(e.target.value)}>
                      {INITIAL_CONTROL_POINT_STATUSES.map(status => (
                        <option key={status} value={status}>{statusLabel(status)}</option>
                      ))}
                    </select>
                    <span className="helper" style={{ marginTop: 6 }}>
                      Verification happens from the register after the point is saved.
                    </span>
                  </div>
                </div>
                <div className="form-actions">
                  <button type="submit" className="btn btn-primary" disabled={busy}>
                    <Icon name="calculator" size={13} /> {busy ? 'Calculating…' : 'Calculate cut & fill'}
                  </button>
                  <span className="toolbar-note">Saves the control point and the earthworks result.</span>
                </div>
              </div>
            </form>

            <div className="stack">
              <section className="panel">
                <div className="panel-head">
                  <div className="panel-head-copy"><h3>Calculation path</h3><p>What this screen records.</p></div>
                  <Icon name="compass" size={14} style={{ color: 'var(--copper)' }} />
                </div>
                <div className="panel-body">
                  <div className="step-list">
                    <div className="step-item">
                      <span className="step-number">01</span>
                      <div><strong>Control point</strong><span>Latitude, longitude and benchmark elevation.</span></div>
                    </div>
                    <div className="step-item">
                      <span className="step-number">02</span>
                      <div><strong>Vertical design</strong><span>Ground, finished floor and foundation depth.</span></div>
                    </div>
                    <div className="step-item">
                      <span className="step-number">03</span>
                      <div><strong>Earthworks balance</strong><span>Cut, fill and net import from the footprint.</span></div>
                    </div>
                  </div>
                </div>
              </section>

              <section className="panel">
                <div className="panel-head">
                  <div className="panel-head-copy"><h3>Engineering note</h3><p>Quantities are derived, not surveyed.</p></div>
                  <Icon name="alert" size={14} style={{ color: 'var(--ink-3)' }} />
                </div>
                <div className="panel-body">
                  <p className="helper" style={{ marginTop: 0 }}>
                    The result is an estimate from the entered levels and footprint. It does not replace a
                    site survey or a geotechnical assessment, and the material split is an assumption,
                    not a measured take-off.
                  </p>
                </div>
              </section>
            </div>
          </div>

          <section className="panel" style={{ marginTop: 18 }}>
            <div className="panel-head">
              <div className="panel-head-copy">
                <h3>Import control network</h3>
                <p>CSV or TXT. Valid rows are imported; invalid rows are listed and skipped.</p>
              </div>
              <span className="panel-eyebrow">CSV · TXT</span>
            </div>
            <div className="panel-body">
              <div className="form-grid">
                <div className="field full">
                  <label htmlFor="control-import-file">Control network file</label>
                  <input
                    key={importInputKey}
                    id="control-import-file"
                    className="input"
                    type="file"
                    accept=".csv,.txt,text/csv,text/plain"
                    onChange={handleImportFile}
                  />
                  <span className="helper" style={{ marginTop: 6 }}>
                    Required columns: name, latitude, longitude, benchmark_elevation. Optional: vertical_datum, status, is_benchmark.
                  </span>
                </div>
                <div className="field">
                  <label htmlFor="control-default-datum">Default vertical datum</label>
                  <input id="control-default-datum" className="input" type="text" maxLength="80" value={defaultDatum} onChange={(e) => setDefaultDatum(e.target.value)} placeholder="Used when a row has none" />
                </div>
                <div className="field">
                  <label htmlFor="control-default-status">Default status</label>
                  <select id="control-default-status" className="input" value={defaultStatus} onChange={(e) => setDefaultStatus(e.target.value)}>
                    {INITIAL_CONTROL_POINT_STATUSES.map(status => (
                      <option key={status} value={status}>{statusLabel(status)}</option>
                    ))}
                  </select>
                  <span className="helper" style={{ marginTop: 6 }}>
                    New points can only be Draft or Submitted. The project owner verifies them from the register.
                  </span>
                </div>
              </div>
              <div className="form-actions">
                <button type="button" className="btn btn-ghost btn-sm" onClick={downloadTemplate}>
                  <Icon name="download" size={12} /> CSV template
                </button>
                <button type="button" className="btn btn-primary" onClick={handleImport} disabled={importing || !importParsed}>
                  <Icon name="upload" size={13} /> {importing ? 'Importing…' : 'Import control points'}
                </button>
                {importFile && (
                  <span className="toolbar-note">
                    {importFile.name} · {importParsed ? `${importParsed.rowsRead} rows · ${importParsed.delimiter}-separated` : 'not validated'}
                  </span>
                )}
              </div>

              {importError && (
                <div className="section-note" style={{ color: 'var(--danger)', background: 'var(--danger-soft)', borderColor: '#ecc9c4', marginTop: 12 }}>
                  <Icon name="alert" size={13} /> {importError}
                </div>
              )}

              {importReport && (
                <div className="section-note" role="status" style={{ marginTop: 12, color: importReport.skipped > 0 ? 'var(--ink)' : 'var(--signal-strong)', background: importReport.skipped > 0 ? 'var(--surface-2)' : 'var(--signal-soft)', borderColor: importReport.skipped > 0 ? 'var(--line)' : '#b9ddcd' }}>
                  <Icon name={importReport.skipped > 0 ? 'alert' : 'checkCircle'} size={13} />
                  {importReport.imported} imported · {importReport.skipped} skipped · {importReport.rowsRead} rows read
                </div>
              )}

              {importReport?.errors?.length > 0 && (
                <div className="table-wrap" style={{ marginTop: 10 }}>
                  <table className="data-table">
                    <thead><tr><th>Row</th><th>Issue</th></tr></thead>
                    <tbody>
                      {importReport.errors.map((item, index) => (
                        <tr key={`${item.row}-${index}`}><td className="num">{item.row}</td><td>{item.message}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>

          <section className="panel" style={{ marginTop: 18 }}>
            <div className="panel-head">
              <div className="panel-head-copy">
                <h3>Control point register</h3>
                <p>Every point recorded against this project, newest first. Only the project owner can change a status; every change is recorded.</p>
              </div>
              <span className="panel-eyebrow">{points.length} RECORDED</span>
            </div>
            <div className="panel-body flush">
              {pointsError ? (
                <p className="helper" style={{ padding: '16px 20px', margin: 0, color: 'var(--danger)' }}>{pointsError}</p>
              ) : points.length === 0 ? (
                <p className="helper" style={{ padding: '16px 20px', margin: 0 }}>No control points recorded yet. The point saved above will appear here.</p>
              ) : (
                <div className="table-wrap">
                  <table className="data-table">
                    <thead><tr><th>Name</th><th>Status</th><th className="num">Latitude</th><th className="num">Longitude</th><th className="num">Benchmark (m)</th><th>Vertical datum</th><th>Recorded</th><th>History</th></tr></thead>
                    <tbody>
                      {points.map(point => (
                        <tr key={point.id}>
                          <td>
                            <strong>{point.name || `Point ${point.id}`}</strong>
                            <span className="table-sub">{point.is_benchmark ? 'Benchmark' : 'Control point'}</span>
                          </td>
                          <td>
                            <select
                              className={`status-select ${point.status || 'submitted'}`}
                              value={point.status || 'submitted'}
                              disabled={updatingStatus === point.id || point.can_change_status === false}
                              title={point.can_change_status === false ? 'Only the project owner can change this status.' : 'Changing a status records who made the change.'}
                              onChange={(e) => updatePointStatus(point, e.target.value)}
                              aria-label={`Status for ${point.name || `point ${point.id}`}`}
                            >
                              {CONTROL_POINT_STATUSES.map(status => (
                                <option key={status} value={status}>{statusLabel(status)}</option>
                              ))}
                            </select>
                          </td>
                          <td className="num">{fmt(point.latitude, 6)}</td>
                          <td className="num">{fmt(point.longitude, 6)}</td>
                          <td className="num">{fmt(point.benchmark_elevation, 2)}</td>
                          <td>{point.vertical_datum || '—'}</td>
                          <td>{point.created_at ? new Date(point.created_at).toLocaleDateString() : '—'}</td>
                          <td>
                            <button type="button" className="btn btn-ghost btn-sm" onClick={() => loadPointHistory(point)}>
                              History
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>

          {historyPoint && (
            <section className="panel" style={{ marginTop: 18 }}>
              <div className="panel-head">
                <div className="panel-head-copy">
                  <h3>Status history · {historyPoint.name || `Point ${historyPoint.id}`}</h3>
                  <p>Append-only record of who changed this point, when, and from which status.</p>
                </div>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setHistoryPoint(null); setHistoryEvents([]); setHistoryError(''); }}>
                  Close
                </button>
              </div>
              <div className="panel-body flush">
                {historyLoading ? (
                  <p className="helper" style={{ padding: '16px 20px', margin: 0 }}>Loading history…</p>
                ) : historyError ? (
                  <p className="helper" style={{ padding: '16px 20px', margin: 0, color: 'var(--danger)' }}>{historyError}</p>
                ) : historyEvents.length === 0 ? (
                  <p className="helper" style={{ padding: '16px 20px', margin: 0 }}>No status history recorded yet.</p>
                ) : (
                  <div className="table-wrap">
                    <table className="data-table">
                      <thead><tr><th>When</th><th>From</th><th>To</th><th>Changed by</th><th>Source</th><th>Note</th></tr></thead>
                      <tbody>
                        {historyEvents.map(event => (
                          <tr key={event.id}>
                            <td>{event.changed_at ? new Date(event.changed_at).toLocaleString() : '—'}</td>
                            <td>{event.from_status ? statusLabel(event.from_status) : 'Initial'}</td>
                            <td><span className={`status-chip ${event.to_status}`}>{statusLabel(event.to_status)}</span></td>
                            <td>
                              {event.changed_by_name || event.changed_by_email || 'System'}
                              {event.changed_by_email && <span className="table-sub">{event.changed_by_email}</span>}
                            </td>
                            <td>{event.source}</td>
                            <td>{event.note || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </section>
          )}

          {saved && (
            <div className="section-note" role="status" style={{ color: 'var(--signal-strong)', background: 'var(--signal-soft)', borderColor: '#b9ddcd' }}>
              <Icon name="checkCircle" size={13} />
              Control point saved successfully. It is now available to the digital twin, earthworks reports and the register below.
            </div>
          )}

          {results && (
            <>
              <div className="kpi-grid three">
                <div className="kpi">
                  <div className="kpi-label"><Icon name="layers" size={12} /> Excavation volume</div>
                  <div className="kpi-value">{fmt(results.cutVolume)} <small>m³</small></div>
                  <div className="kpi-meta">Material to remove</div>
                </div>
                <div className="kpi">
                  <div className="kpi-label"><Icon name="database" size={12} /> Fill required</div>
                  <div className="kpi-value">{fmt(results.fillVolume)} <small>m³</small></div>
                  <div className="kpi-meta">Material needed on site</div>
                </div>
                <div className="kpi">
                  <div className="kpi-label"><Icon name="activity" size={12} /> Net import</div>
                  <div className="kpi-value" style={{ color: num(results.netImport) > 0 ? 'var(--danger)' : 'var(--signal)' }}>{fmt(results.netImport)} <small>m³</small></div>
                  <div className={`kpi-meta ${num(results.netImport) > 0 ? 'warn' : ''}`}>{num(results.netImport) > 0 ? 'Import from outside' : 'Export surplus'}</div>
                </div>
              </div>

              <section className="panel">
                <div className="panel-head">
                  <div className="panel-head-copy"><h3>Material requirements from excavation</h3><p>Assumed splits applied to the cut volume.</p></div>
                  <span className="panel-eyebrow">{fmt(results.cutVolume)} m³ cut</span>
                </div>
                <div className="panel-body flush">
                  <div className="table-wrap">
                    <table className="data-table">
                      <thead><tr><th>Material</th><th>Unit</th><th className="num">Quantity</th><th>Notes</th></tr></thead>
                      <tbody>
                        <tr><td className="strong">Foundation concrete</td><td>m³</td><td className="num">{fmt(num(results.cutVolume) * 0.35)}</td><td>35% of excavation volume</td></tr>
                        <tr><td className="strong">Rebar steel (foundation)</td><td>kg</td><td className="num">{fmt(num(results.cutVolume) * 0.35 * 50)}</td><td>50 kg per m³ of concrete</td></tr>
                        <tr><td className="strong">PCC base course</td><td>m³</td><td className="num">{fmt(num(results.cutVolume) * 0.10)}</td><td>10% of excavation volume</td></tr>
                        <tr><td className="strong">Earth backfill</td><td>m³</td><td className="num">{fmt(num(results.fillVolume))}</td><td>Design fill requirement</td></tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}

// ===================== 3D VIEWER SCREEN (Three.js, built from imported components) =====================
// Stable colour per material name, so a material keeps its colour across reloads.
const MATERIAL_COLOURS = new Map();
const colourForMaterial = (name) => {
  const key = String(name || 'Unspecified');
  if (!MATERIAL_COLOURS.has(key)) {
    let hue = 0;
    for (let i = 0; i < key.length; i++) hue = (hue * 31 + key.charCodeAt(i)) % 360;
    MATERIAL_COLOURS.set(key, new THREE.Color().setHSL(hue / 360, 0.55, 0.5));
  }
  return MATERIAL_COLOURS.get(key);
};

function ChartViewerScreen({ token, projects, embedded = false }) {
  const [projectId, setProjectId] = useState('');
  const [modelData, setModelData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(null);
  const mountRef = useRef(null);

  // DEM terrain layer (optional; the component blocks are unchanged).
  const [terrainSurveys, setTerrainSurveys] = useState([]);
  const [terrainSurveyId, setTerrainSurveyId] = useState('');
  const [terrain, setTerrain] = useState(null);
  const [terrainVisible, setTerrainVisible] = useState(true);
  const [exaggeration, setExaggeration] = useState(1);
  const [terrainBusy, setTerrainBusy] = useState('');
  const [terrainError, setTerrainError] = useState('');
  const [uploadPercent, setUploadPercent] = useState(0);
  const [verticalDatum, setVerticalDatum] = useState('');
  const [derivative, setDerivative] = useState(null);
  const [benchmarks, setBenchmarks] = useState(null);
  const terrainMeshRef = useRef(null);


  const authHeaders = { Authorization: `Bearer ${token}` };
  const components = modelData?.components || [];
  const phases = [...new Set(components.map(c => c.phase || 'Unassigned'))];
  const terrainKey = terrain ? `${terrain.surveyId}:${terrainVisible ? 'on' : 'off'}` : 'off';

  const loadModel = async (id) => {
    if (!id) { setModelData(null); return; }

    setLoading(true); setError(''); setSelected(null);

    try {
      const response = await axios.get(`${API_URL}/api/3d/model/${id}`, { headers: authHeaders });
      setModelData(response.data);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
      setModelData(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadModel(projectId);
  }, [projectId]);

  const refreshTerrainSurveys = async (id = projectId) => {
    if (!id) { setTerrainSurveys([]); return; }
    try {
      const response = await axios.get(`${API_URL}/api/terrain/${id}`, { headers: authHeaders });
      setTerrainSurveys(response.data);
    } catch (err) {
      setTerrainError(err.response?.data?.error || err.message);
    }
  };

  useEffect(() => {
    setTerrain(null);
    setTerrainSurveyId('');
    setBenchmarks(null);
    setDerivative(null);
    setTerrainError('');
    refreshTerrainSurveys(projectId);
  }, [projectId]);

  // Loads the <=512 px preview grid for the selected survey. The GeoTIFF itself is never
  // sent to the browser: only the decimated grid and its metadata.
  useEffect(() => {
    let cancelled = false;
    setBenchmarks(null);
    setDerivative(null);
    if (!projectId || !terrainSurveyId) { setTerrain(null); return undefined; }

    (async () => {
      setTerrainBusy('Loading terrain preview…');
      setTerrainError('');
      try {
        const meta = await axios.get(`${API_URL}/api/terrain/${projectId}/${terrainSurveyId}/preview`, { headers: authHeaders });
        const bin = await axios.get(`${API_URL}/api/terrain/${projectId}/${terrainSurveyId}/preview.bin`, { headers: authHeaders, responseType: 'arraybuffer' });
        if (cancelled) return;

        const width = meta.data.preview.width;
        const height = meta.data.preview.height;
        const grid = new Float32Array(bin.data);
        if (grid.length !== width * height) throw new Error('The preview grid does not match its metadata size.');

        setTerrain({
          surveyId: Number(terrainSurveyId),
          grid,
          width,
          height,
          bounds: meta.data.bounds,
          statistics: meta.data.statistics,
          cellSizeMetres: meta.data.cellSizeMetres,
          crs: meta.data.crs,
          verticalDatum: meta.data.verticalDatum,
          fullResolution: meta.data.fullResolution
        });
        setTerrainVisible(true);
      } catch (err) {
        if (!cancelled) setTerrainError(err.response?.data?.error || err.message);
      } finally {
        if (!cancelled) setTerrainBusy('');
      }
    })();

    return () => { cancelled = true; };
  }, [projectId, terrainSurveyId]);

  const uploadTerrain = async (file) => {
    if (!file || !projectId) return;
    setTerrainBusy('Uploading GeoTIFF…');
    setTerrainError('');
    setUploadPercent(0);
    try {
      const body = new FormData();
      body.append('file', file);
      if (verticalDatum.trim()) body.append('verticalDatum', verticalDatum.trim());
      const response = await axios.post(`${API_URL}/api/terrain/${projectId}/upload`, body, {
        headers: authHeaders,
        onUploadProgress: event => {
          if (event.total) setUploadPercent(Math.round((event.loaded / event.total) * 100));
        }
      });
      await refreshTerrainSurveys();
      setTerrainSurveyId(String(response.data.survey.id));
    } catch (err) {
      setTerrainError(err.response?.data?.error || err.message);
      await refreshTerrainSurveys(); // rejected attempts are recorded with their reason
    } finally {
      setTerrainBusy('');
      setUploadPercent(0);
    }
  };

  const loadDerivative = async (kind) => {
    if (!terrain) return;
    setTerrainBusy(`Preparing ${kind}…`);
    setTerrainError('');
    try {
      if (kind === 'contours') {
        const response = await axios.get(`${API_URL}/api/terrain/${projectId}/${terrain.surveyId}/contours`, {
          headers: authHeaders,
          params: { interval: 10 }
        });
        setDerivative({ kind, count: response.data.features.length, metadata: response.data.metadata });
      } else {
        const response = await axios.get(`${API_URL}/api/terrain/${projectId}/${terrain.surveyId}/${kind}.png`, {
          headers: authHeaders,
          responseType: 'blob'
        });
        // The app's CSP allows data: images but not blob:, so encode the PNG as a data URL.
        const url = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error || new Error('Could not read the preview image.'));
          reader.readAsDataURL(response.data);
        });
        setDerivative({ kind, url });
      }
    } catch (err) {
      setTerrainError(err.response?.data?.error || err.message);
    } finally {
      setTerrainBusy('');
    }
  };

  const compareBenchmarks = async () => {
    if (!terrain) return;
    setTerrainBusy('Comparing with survey benchmarks…');
    setTerrainError('');
    try {
      const response = await axios.get(`${API_URL}/api/terrain/${projectId}/${terrain.surveyId}/benchmarks`, { headers: authHeaders });
      setBenchmarks(response.data);
    } catch (err) {
      setTerrainError(err.response?.data?.error || err.message);
    } finally {
      setTerrainBusy('');
    }
  };

  // Builds the scene from the project's components, and tears it down completely
  // when the data changes or the screen is left (Three.js objects are not GC'd).
  useEffect(() => {
    const mount = mountRef.current;
    const rows = modelData?.components || [];
    const hasTerrain = Boolean(terrain && terrainVisible);
    if (!mount || (rows.length === 0 && !hasTerrain)) return undefined;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf4f1ea);

    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.borderRadius = '0';
    mount.appendChild(renderer.domElement);

    scene.add(new THREE.HemisphereLight(0xfffbf4, 0xa9a294, 1.08));
    const sun = new THREE.DirectionalLight(0xffffff, 0.85);
    sun.position.set(22, 38, 18);
    scene.add(sun);

    // One block per imported component. Blocks are sized relative to the largest
    // quantity in their own unit group, because 500 kg and 500 m³ are not
    // comparable magnitudes.
    const maxByUnit = rows.reduce((acc, row) => {
      const unit = row.unit || 'units';
      acc[unit] = Math.max(acc[unit] || 0, num(row.quantity));
      return acc;
    }, {});

    const byPhase = rows.reduce((acc, row) => {
      const phase = row.phase || 'Unassigned';
      (acc[phase] = acc[phase] || []).push(row);
      return acc;
    }, {});
    const phaseNames = Object.keys(byPhase).sort();

    const geometry = new THREE.BoxGeometry(1, 1, 1);
    geometry.translate(0, 0.5, 0); // blocks grow upward from the ground plane
    const materials = [];
    const blocks = new THREE.Group();
    const spacing = 2.8;

    phaseNames.forEach((phase, rowIndex) => {
      const row = byPhase[phase];
      const centring = (row.length - 1) / 2;

      row.forEach((component, columnIndex) => {
        const unit = component.unit || 'units';
        const share = maxByUnit[unit] > 0 ? num(component.quantity) / maxByUnit[unit] : 0;
        const side = Math.max(0.35, 2.7 * Math.cbrt(share)); // volume ∝ quantity

        const material = new THREE.MeshStandardMaterial({
          color: colourForMaterial(component.material_type),
          roughness: 0.45,
          metalness: 0.1
        });
        materials.push(material);

        const block = new THREE.Mesh(geometry, material);
        block.scale.set(side, side, side);
        block.position.set((columnIndex - centring) * spacing, 0, rowIndex * spacing);
        block.userData = component;
        blocks.add(block);
      });
    });

    scene.add(blocks);

    const span = Math.max(12, phaseNames.length * spacing, Math.max(...phaseNames.map(p => byPhase[p].length)) * spacing);
    const grid = new THREE.GridHelper(span * 1.6, 12, 0xbfc9d6, 0xdde4ec);
    scene.add(grid);

    // Optional DEM layer: one mesh built from the preview grid. Heights are scaled from the real
    // elevation range and the real cell size, so relief keeps its true proportions; the vertical
    // exaggeration multiplies only the vertical axis. Cells touching NoData are left open.
    const terrainGroup = new THREE.Group();
    terrainGroup.name = 'dem-terrain';
    if (terrain && terrainVisible) {
      const demGrid = terrain.grid;
      const pw = terrain.width;
      const ph = terrain.height;
      const spanX = Math.max(6, blocks.children.length > 0 ? span * 1.6 : 24);
      const realWidth = Math.max(1e-6, Math.abs(num(terrain.cellSizeMetres?.x) || 1) * Math.max(1, pw - 1));
      const realHeight = Math.max(1e-6, Math.abs(num(terrain.cellSizeMetres?.y) || 1) * Math.max(1, ph - 1));
      const planeWidth = realWidth >= realHeight ? spanX : spanX * (realWidth / realHeight);
      const planeDepth = realWidth >= realHeight ? spanX * (realHeight / realWidth) : spanX;
      const zMin = num(terrain.statistics?.min);
      const zRange = Math.max(1e-6, num(terrain.statistics?.max) - zMin);
      const vScale = planeWidth / realWidth; // display units per metre

      const positions = new Float32Array(pw * ph * 3);
      const colors = new Float32Array(pw * ph * 3);
      const palette = [new THREE.Color(0x1f5c3a), new THREE.Color(0x4f8f4a), new THREE.Color(0x9bbf62), new THREE.Color(0xc9a86a), new THREE.Color(0x8a5a3b)];

      for (let y = 0; y < ph; y += 1) {
        for (let x = 0; x < pw; x += 1) {
          const index = y * pw + x;
          const z = demGrid[index];
          positions[index * 3] = (x / Math.max(1, pw - 1) - 0.5) * planeWidth;
          positions[index * 3 + 1] = Number.isNaN(z) ? 0 : (z - zMin) * vScale;
          positions[index * 3 + 2] = (y / Math.max(1, ph - 1) - 0.5) * planeDepth;

          const t = Number.isNaN(z) ? 0 : Math.min(1, Math.max(0, (z - zMin) / zRange));
          const scaled = t * (palette.length - 1);
          const lower = Math.floor(scaled);
          const colour = palette[lower].clone().lerp(palette[Math.min(palette.length - 1, lower + 1)], scaled - lower);
          colors[index * 3] = colour.r;
          colors[index * 3 + 1] = colour.g;
          colors[index * 3 + 2] = colour.b;
        }
      }

      const indices = [];
      for (let y = 0; y < ph - 1; y += 1) {
        for (let x = 0; x < pw - 1; x += 1) {
          const a = y * pw + x;
          const b = a + 1;
          const c = a + pw;
          const d = c + 1;
          if ([demGrid[a], demGrid[b], demGrid[c], demGrid[d]].some(Number.isNaN)) continue;
          indices.push(a, c, b, b, c, d);
        }
      }

      const terrainGeometry = new THREE.BufferGeometry();
      terrainGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      terrainGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      terrainGeometry.setIndex(indices);
      terrainGeometry.computeVertexNormals();

      const terrainMaterial = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.95,
        metalness: 0,
        side: THREE.DoubleSide
      });

      const terrainMesh = new THREE.Mesh(terrainGeometry, terrainMaterial);
      terrainMesh.name = 'dem-terrain-layer';
      terrainMesh.scale.y = exaggeration;
      terrainMesh.userData = { kind: 'terrain', surveyId: terrain.surveyId };
      terrainGroup.add(terrainMesh);
      terrainMeshRef.current = terrainMesh;
      renderer.domElement.setAttribute('data-terrain-triangles', String(indices.length / 3));
      renderer.domElement.setAttribute('data-terrain-cells', `${pw}x${ph}`);
    } else {
      terrainMeshRef.current = null;
    }
    scene.add(terrainGroup);

    const bounds = new THREE.Box3();
    if (blocks.children.length > 0) bounds.expandByObject(blocks);
    if (terrainGroup.children.length > 0) bounds.expandByObject(terrainGroup);
    if (bounds.isEmpty()) bounds.set(new THREE.Vector3(-5, 0, -5), new THREE.Vector3(5, 8, 5));
    const centre = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z, 1);

    camera.position.set(centre.x + radius * 1.15, centre.y + radius * 0.9, centre.z + radius * 1.4);
    camera.lookAt(centre);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(centre);
    controls.enableDamping = true;
    controls.dampingFactor = 0.09;
    controls.maxPolarAngle = Math.PI / 2.02; // stay above the ground plane

    const resize = () => {
      const { clientWidth, clientHeight } = mount;
      if (!clientWidth || !clientHeight) return;
      // Keep the canvas CSS size equal to the mount: with `false` the canvas keeps its device-pixel
      // size while the container stays in CSS pixels, so high-DPI screens showed only a quadrant.
      renderer.setSize(clientWidth, clientHeight);
      camera.aspect = clientWidth / clientHeight;
      camera.updateProjectionMatrix();
    };
    resize();

    const observer = new ResizeObserver(resize);
    observer.observe(mount);

    // Clicking a block reads its component back out.
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const handleClick = (event) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(blocks.children, false)[0];
      setSelected(hit ? hit.object.userData : null);
    };
    renderer.domElement.addEventListener('click', handleClick);

    renderer.setAnimationLoop(() => {
      controls.update();
      renderer.render(scene, camera);
    });

    return () => {
      renderer.setAnimationLoop(null);
      observer.disconnect();
      renderer.domElement.removeEventListener('click', handleClick);
      controls.dispose();
      geometry.dispose();
      materials.forEach(material => material.dispose());
      if (terrainMeshRef.current) {
        terrainMeshRef.current.geometry.dispose();
        terrainMeshRef.current.material.dispose();
        terrainMeshRef.current = null;
      }
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
      renderer.dispose();
    };
  }, [modelData, terrainKey]);

  useEffect(() => {
    if (terrainMeshRef.current) terrainMeshRef.current.scale.y = exaggeration;
  }, [exaggeration, terrainKey]);

  const legend = Object.values(components.reduce((acc, row) => {
    const key = `${row.material_type}|${row.unit}`;
    if (!acc[key]) acc[key] = { material: row.material_type, unit: row.unit, quantity: 0, count: 0 };
    acc[key].quantity += num(row.quantity);
    acc[key].count += 1;
    return acc;
  }, {})).sort((a, b) => String(a.material).localeCompare(String(b.material)));

  const materialCount = new Set(components.map(component => component.material_type).filter(Boolean)).size;
  const twinChecks = [
    { label: 'BIM model linked', done: Boolean(modelData?.bimModel) },
    { label: 'Components imported', done: components.length > 0 },
    { label: 'Phases structured', done: phases.some(phase => phase && phase !== 'Unassigned') },
    { label: 'Terrain attached', done: Boolean(terrain) },
    { label: 'Earthworks calculated', done: Boolean(modelData?.earthworks) }
  ];
  const twinScore = Math.round((twinChecks.filter(check => check.done).length / twinChecks.length) * 100);
  const nextTwinAction = !components.length
    ? ['Import model components', 'Bring a BIM take-off into the project before reading the twin.']
    : !terrain
      ? ['Attach terrain', 'Upload a GeoTIFF so the model sits inside site relief.']
      : !modelData?.earthworks
        ? ['Calculate cut and fill', 'Derive earthworks before reviewing the vertical design.']
        : ['Review asset evidence', 'Connect inspections, photos and documents to close the evidence chain.'];

  return (
    <div className={embedded ? 'stack' : 'page'}>
      {embedded ? (
        <div className="toolbar-row" style={{ justifyContent: 'space-between' }}>
          <div>
            <div className="panel-eyebrow">Component take-off chart</div>
            <p className="helper" style={{ marginTop: 3 }}>One block per imported take-off row, sized by quantity and coloured by material.</p>
          </div>
          <div className="gis-project">
            <Icon name="cube" size={13} />
            <label htmlFor="twin-project-select">Project</label>
            <select id="twin-project-select" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">Select project</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        </div>
      ) : (
        <div className="page-head">
          <div className="page-head-copy">
            <div className="eyebrow">Asset operations / digital twin</div>
            <h1 className="page-title">Digital twin</h1>
            <p className="page-sub">
              Inspect the model, terrain and asset records as one operational object. Each block is a
              BIM component; select it to read identity, material and phase.
            </p>
          </div>
          <div className="page-actions">
            <div className="gis-project">
              <Icon name="cube" size={13} />
              <label htmlFor="twin-project-select">Project</label>
              <select id="twin-project-select" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">Select project</option>
                {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          </div>
        </div>
      )}

      {projectId && (
        <details className="panel">
          <summary style={{ padding: '16px 18px', cursor: 'pointer' }}>
            <div className="panel-head-copy" style={{ display: 'inline-block', maxWidth: 'calc(100% - 30px)' }}>
              <h3 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 14, fontWeight: 600, letterSpacing: '-0.02em' }}>Terrain and model inputs</h3>
              <p style={{ margin: '3px 0 0', color: 'var(--ink-3)', fontSize: 10.5 }}>Upload a GeoTIFF and manage the DEM preview layer.</p>
            </div>
          </summary>
          <div className="disclosure-body">
            <div className="section-note" style={{ marginBottom: 14 }}>
              <Icon name="alert" size={12} />
              <span>
                The CRS must be WGS 84 (EPSG:4326) or a WGS 84 UTM zone. A raster without a CRS, or in
                another CRS, is refused rather than guessed. The viewer receives a preview of at most
                512 px per side for visualization only; it is not an engineering surface.
              </span>
            </div>

            <div className="form-grid">
              <div className="field full">
                <label htmlFor="terrain-upload">GeoTIFF file</label>
                <div className="upload-zone">
                  <Icon name="upload" size={20} style={{ color: 'var(--copper)', marginBottom: 7 }} />
                  <input
                    id="terrain-upload"
                    type="file"
                    accept=".tif,.tiff,image/tiff"
                    onChange={(event) => { uploadTerrain(event.target.files?.[0]); event.target.value = ''; }}
                  />
                  <span style={{ marginTop: 6, color: 'var(--ink-3)', fontSize: 9.5 }}>GeoTIFF · preview only</span>
                </div>
              </div>
              <div className="field">
                <label htmlFor="vertical-datum">Vertical datum (optional)</label>
                <input
                  id="vertical-datum"
                  className="input"
                  value={verticalDatum}
                  onChange={(event) => setVerticalDatum(event.target.value)}
                  placeholder="e.g. MSL"
                />
              </div>
              {terrainSurveys.length > 0 && (
                <div className="field">
                  <label htmlFor="terrain-survey">DEM survey</label>
                  <select id="terrain-survey" className="input" value={terrainSurveyId} onChange={(event) => setTerrainSurveyId(event.target.value)}>
                    <option value="">None selected</option>
                    {terrainSurveys.map(survey => (
                      <option key={survey.id} value={survey.id}>
                        {survey.originalName} — {survey.status}{survey.epsg ? ` · EPSG:${survey.epsg}` : ''}{survey.noDataValue !== null ? ` · NoData ${survey.noDataValue}` : ''}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            {uploadPercent > 0 && (
              <div className="range-block">
                <label><span>Uploading GeoTIFF</span><strong>{uploadPercent}%</strong></label>
                <div className="meter-track"><div className="meter-fill copper" style={{ width: `${uploadPercent}%` }} /></div>
              </div>
            )}

            {terrainSurveys.filter(survey => survey.status === 'failed').map(survey => (
              <div key={survey.id} className="section-note" style={{ marginTop: 10 }}>
                <Icon name="alert" size={12} />
                <span><strong>{survey.originalName}</strong> — {survey.error}</span>
              </div>
            ))}

            {terrain && (
              <div style={{ marginTop: 14 }}>
                <div className="terrain-meta">
                  <div><span>CRS</span><strong>{terrain.crs}</strong></div>
                  <div><span>Preview grid</span><strong>{terrain.width} × {terrain.height} px</strong></div>
                  <div><span>Full resolution</span><strong>{terrain.fullResolution.width} × {terrain.fullResolution.height} cells</strong></div>
                  <div><span>Elevation range</span><strong>{num(terrain.statistics.min).toFixed(2)}–{num(terrain.statistics.max).toFixed(2)} m</strong></div>
                  <div style={{ gridColumn: '1 / -1' }}><span>Bounds</span><strong>[{terrain.bounds.map(value => Number(value).toFixed(2)).join(', ')}]</strong></div>
                  <div style={{ gridColumn: '1 / -1' }}><span>Vertical datum</span><strong>{terrain.verticalDatum || 'Not recorded'}</strong></div>
                </div>

                <p className="helper" style={{ marginTop: 0 }}>
                  The footprint keeps the DEM's true aspect ratio but is scaled to the component blocks for
                  display. Vertical relief keeps its true proportion at ×1; the slider exaggerates only the
                  vertical axis, so horizontal distances in the viewer are schematic.
                </p>

                <div className="check-row">
                  <input id="terrain-visible" type="checkbox" checked={terrainVisible} onChange={(event) => setTerrainVisible(event.target.checked)} />
                  <label htmlFor="terrain-visible">Show terrain layer in the 3D viewer</label>
                </div>

                <div className="range-block">
                  <label htmlFor="terrain-exaggeration"><span>Vertical exaggeration</span><strong>×{exaggeration.toFixed(1)}</strong></label>
                  <input
                    id="terrain-exaggeration"
                    type="range" min="1" max="5" step="0.5" value={exaggeration}
                    onChange={(event) => setExaggeration(Number(event.target.value))}
                  />
                </div>

                <div className="toolbar-row" style={{ marginTop: 4 }}>
                  <button onClick={() => loadDerivative('hillshade')} className="btn btn-sm"><Icon name="layers" size={12} /> Hillshade</button>
                  <button onClick={() => loadDerivative('slope')} className="btn btn-sm"><Icon name="layers" size={12} /> Slope</button>
                  <button onClick={() => loadDerivative('aspect')} className="btn btn-sm"><Icon name="layers" size={12} /> Aspect</button>
                  <button onClick={() => loadDerivative('contours')} className="btn btn-sm"><Icon name="route" size={12} /> Contours 10 m</button>
                  <button onClick={compareBenchmarks} className="btn btn-sm"><Icon name="activity" size={12} /> Compare benchmarks</button>
                  <button onClick={() => { setTerrain(null); setDerivative(null); setBenchmarks(null); }} className="btn btn-sm btn-danger"><Icon name="x" size={12} /> Remove layer</button>
                </div>

                {terrainBusy && <div className="section-note" style={{ marginTop: 10 }}><Icon name="refresh" size={12} /> {terrainBusy}</div>}
                {terrainError && <div className="section-note" style={{ marginTop: 10, color: 'var(--danger)', background: 'var(--danger-soft)', borderColor: '#ecc9c4' }}><Icon name="alert" size={12} /> {terrainError}</div>}

                {derivative?.url && (
                  <div style={{ marginTop: 12 }}>
                    <div className="panel-eyebrow" style={{ marginBottom: 6 }}>Preview-derived {derivative.kind}</div>
                    <img
                      src={derivative.url}
                      alt={`Preview-derived ${derivative.kind} of the DEM`}
                      style={{ maxWidth: '100%', border: '1px solid var(--line)', borderRadius: 8 }}
                    />
                    <p className="helper">From the {terrain.width} × {terrain.height} grid, not full resolution.</p>
                  </div>
                )}

                {derivative?.kind === 'contours' && (
                  <p className="helper">
                    {derivative.count} contour segment{derivative.count === 1 ? '' : 's'} at {derivative.metadata?.interval} m from the preview grid
                    {derivative.metadata?.truncated ? ' (capped — raise the interval for fewer lines)' : ''}.
                    Preview-derived, not for engineering quantities.
                  </p>
                )}

                {benchmarks && (
                  <div style={{ marginTop: 14 }}>
                    <div className="panel-head" style={{ padding: '0 0 10px' }}>
                      <div className="panel-head-copy"><h3>DEM vs survey benchmarks</h3><p>{benchmarks.verticalDatumNote}</p></div>
                    </div>
                    {benchmarks.results.length === 0 ? (
                      <p className="helper">No surveying control points with coordinates exist for this project.</p>
                    ) : (
                      <>
                        <div className="table-wrap">
                          <table className="data-table">
                            <thead><tr><th>Point</th><th className="num">DEM (m)</th><th className="num">Benchmark (m)</th><th className="num">Difference (m)</th></tr></thead>
                            <tbody>
                              {benchmarks.results.map((row, index) => (
                                <tr key={index}>
                                  <td>#{row.pointId} <span className="muted">{row.status}</span></td>
                                  <td className="num">{row.demElevation === undefined ? '—' : Number(row.demElevation).toFixed(2)}</td>
                                  <td className="num">{row.benchmarkElevation === null || row.benchmarkElevation === undefined ? '—' : Number(row.benchmarkElevation).toFixed(2)}</td>
                                  <td className="num">{row.difference === null || row.difference === undefined ? '—' : Number(row.difference).toFixed(2)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        <p className="helper">
                          {benchmarks.summary ? `Mean difference ${benchmarks.summary.meanDifference} m, spread ${benchmarks.summary.spread} m. ` : ''}
                          {benchmarks.note} Nothing has been shifted or normalised; a systematic offset may indicate a vertical datum difference for engineering review.
                        </p>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </details>
      )}

      {error && <div className="section-note" style={{ color: 'var(--danger)', background: 'var(--danger-soft)', borderColor: '#ecc9c4' }}><Icon name="alert" size={13} /> {error}</div>}

      {loading && (
        <div className="section-note"><Icon name="refresh" size={12} /> Loading model components…</div>
      )}

      {!projectId ? (
        <div className="empty">
          <div className="empty-icon"><Icon name="cube" /></div>
          <h4>Select a project to build its twin</h4>
          <p>The viewer combines imported components, site terrain and the records attached to them.</p>
        </div>
      ) : components.length === 0 && !loading && (!terrain || !terrainVisible) ? (
        <div className="empty">
          <div className="empty-icon"><Icon name="box" /></div>
          <h4>No geometry yet</h4>
          <p>Import a take-off on BIM Import and each component will appear here as a block.</p>
        </div>
      ) : (
        <>
          {(components.length > 0 || (terrain && terrainVisible)) && (
            <div className="twin-grid">
              <div className="twin-stage">
                <div className="twin-topline">
                  <div className="twin-label"><span className="status-dot" /> Live twin</div>
                  <div className="twin-label">{components.length} components · {phases.length} phases</div>
                </div>
                <div ref={mountRef} className="viewer-surface" />
                <div className="viewer-badge">
                  {components.length} blocks · {phases.length} phase{phases.length === 1 ? '' : 's'}{terrain && terrainVisible ? ' · DEM terrain' : ''} · drag to rotate, scroll to zoom
                </div>
              </div>

              <aside className="twin-rail">
                <section className="panel health-card">
                  <div className="panel-head" style={{ padding: '0 0 12px', border: 0 }}>
                    <div className="panel-head-copy">
                      <h3>Twin completeness</h3>
                      <p>Model, terrain and commercial context.</p>
                    </div>
                  </div>
                  <div className="health-ring" style={{ background: `conic-gradient(var(--signal) ${twinScore}%, var(--surface-3) 0)` }}>
                    <strong>{twinScore}</strong>
                    <span>of 100</span>
                  </div>
                  <div className="health-caption">
                    {twinScore >= 80 ? 'Ready for asset review' : twinScore >= 50 ? 'Partially configured' : 'Needs model inputs'}
                  </div>
                  <div className="health-metrics">
                    <div className="health-metric"><strong>{components.length}</strong><span>Components</span></div>
                    <div className="health-metric"><strong>{materialCount}</strong><span>Materials</span></div>
                    <div className="health-metric"><strong>{phases.length}</strong><span>Phases</span></div>
                    <div className="health-metric"><strong>{terrain ? 'Yes' : '—'}</strong><span>Terrain</span></div>
                  </div>
                </section>

                <section className="panel">
                  <div className="panel-head">
                    <div className="panel-head-copy"><h3>Asset context</h3><p>Identity and source records.</p></div>
                  </div>
                  <div className="panel-body">
                    <div className="twin-list">
                      <div className="twin-row">
                        <span className="twin-row-icon done"><Icon name="file" size={12} /></span>
                        <span className="twin-row-copy"><strong>{modelData?.bimModel?.file_name || 'No model file'}</strong><span>{modelData?.bimModel ? 'BIM source linked' : 'Import a take-off to begin'}</span></span>
                      </div>
                      <div className="twin-row">
                        <span className={`twin-row-icon ${terrain ? 'done' : ''}`}><Icon name="layers" size={12} /></span>
                        <span className="twin-row-copy"><strong>{terrain ? `${terrain.width} × ${terrain.height} terrain grid` : 'Terrain not attached'}</strong><span>{terrain ? `${terrain.crs} · preview surface` : 'Open terrain inputs above'}</span></span>
                      </div>
                      <div className="twin-row">
                        <span className={`twin-row-icon ${modelData?.earthworks ? 'done' : ''}`}><Icon name="chart" size={12} /></span>
                        <span className="twin-row-copy"><strong>{modelData?.earthworks ? 'Earthworks calculated' : 'Earthworks not calculated'}</strong><span>{modelData?.earthworks ? `${fmt(modelData.earthworks.cut_volume)} m³ cut · ${fmt(modelData.earthworks.fill_volume)} m³ fill` : 'No vertical balance recorded'}</span></span>
                      </div>
                    </div>
                  </div>
                </section>

                <section className="panel">
                  <div className="panel-head">
                    <div className="panel-head-copy"><h3>Next action</h3><p>Recommended from twin completeness.</p></div>
                    <Icon name="sparkles" size={14} style={{ color: 'var(--copper)' }} />
                  </div>
                  <div className="panel-body">
                    <div className="twin-recommendation" style={{ marginTop: 0 }}>
                      <strong><Icon name="sparkles" size={11} /> {nextTwinAction[0]}</strong>
                      {nextTwinAction[1]}
                    </div>
                  </div>
                </section>

                <section className="panel">
                  <div className="panel-head">
                    <div className="panel-head-copy"><h3>Record links</h3><p>Evidence attached to the asset.</p></div>
                  </div>
                  <div className="panel-body">
                    <div className="twin-list">
                      {[
                        ['Inspections', 'clipboard'],
                        ['Photos', 'camera'],
                        ['Documents', 'file']
                      ].map(([label, icon]) => (
                        <div className="twin-row" key={label}>
                          <span className="twin-row-icon"><Icon name={icon} size={12} /></span>
                          <span className="twin-row-copy"><strong>{label}</strong><span>Not linked to this twin yet</span></span>
                          <span className="project-status neutral">0</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </section>
              </aside>
            </div>
          )}

          {selected && (
            <section className="panel asset-selection">
              <div>
                <div className="panel-eyebrow">Selected component</div>
                <h4>{selected.component_name}</h4>
                <p>{selected.material_type} · {selected.phase || 'Unassigned'}</p>
              </div>
              <div className="selection-metrics">
                <div className="selection-metric"><span>Quantity</span><strong>{num(selected.quantity).toLocaleString()} {selected.unit}</strong></div>
                <div className="selection-metric"><span>Material</span><strong>{selected.material_type}</strong></div>
                <div className="selection-metric"><span>Phase</span><strong>{selected.phase || 'Unassigned'}</strong></div>
              </div>
            </section>
          )}

          <div className="split-grid">
            <section className="panel">
              <div className="panel-head">
                <div className="panel-head-copy"><h3>Colour legend</h3><p>Materials mapped to block colour.</p></div>
                <span className="panel-eyebrow">{legend.length} materials</span>
              </div>
              <div className="panel-body">
                {legend.length === 0 ? (
                  <p className="helper" style={{ marginTop: 0 }}>Nothing to show yet.</p>
                ) : (
                  <div className="legend-list">
                    {legend.map((line, index) => (
                      <div className="legend-row" key={index}>
                        <span className="legend-swatch" style={{ background: `#${colourForMaterial(line.material).getHexString()}` }} />
                        <span>{line.material} — {num(line.quantity).toLocaleString()} {line.unit}</span>
                        <span className="num">{line.count} block{line.count === 1 ? '' : 's'}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>

            <section className="panel">
              <div className="panel-head">
                <div className="panel-head-copy"><h3>Scene contents</h3><p>What the viewer is rendering.</p></div>
                <Icon name="cube" size={14} style={{ color: 'var(--ink-3)' }} />
              </div>
              <div className="panel-body">
                <div className="context-line">Phases: <strong>{phases.join(', ') || 'None'}</strong></div>
                <div className="context-line" style={{ marginTop: 6 }}>Model files recorded: <strong>{modelData?.bimModel ? 1 : 0}</strong></div>
                {modelData?.earthworks ? (
                  <>
                    <div className="context-line" style={{ marginTop: 6 }}>Cut volume: <strong>{fmt(modelData.earthworks.cut_volume)} m³</strong></div>
                    <div className="context-line" style={{ marginTop: 6 }}>Fill volume: <strong>{fmt(modelData.earthworks.fill_volume)} m³</strong></div>
                  </>
                ) : (
                  <p className="helper">No earthworks calculation saved for this project yet.</p>
                )}
              </div>
            </section>
          </div>
        </>
      )}
    </div>
  );
}

// ===================== 3D VIEWER (BIM model or take-off chart) =====================
function ThreeDViewerScreen({ token, projects }) {
  const [view, setView] = useState('bim');

  return (
    <div className="page">
      <div className="page-head">
        <div className="page-head-copy">
          <div className="eyebrow">Asset operations / 3D model</div>
          <h1 className="page-title">3D viewer</h1>
          <p className="page-sub">
            Open an exported IFC, GLB or glTF file to see the building itself — elements, storeys,
            properties, measurements, section cuts and quantities. The take-off chart remains
            available as a separate view of the imported components.
          </p>
        </div>
        <div className="page-actions">
          <div className="viewer-modes" role="tablist" aria-label="3D viewer mode">
            <button
              type="button"
              role="tab"
              aria-selected={view === 'bim'}
              className={`viewer-mode ${view === 'bim' ? 'active' : ''}`}
              onClick={() => setView('bim')}
            >
              <Icon name="cube" size={12} /> BIM model
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'chart'}
              className={`viewer-mode ${view === 'chart' ? 'active' : ''}`}
              onClick={() => setView('chart')}
            >
              <Icon name="chart" size={12} /> Take-off chart
            </button>
          </div>
        </div>
      </div>

      {view === 'bim' ? (
        <React.Suspense fallback={
          <div className="empty">
            <div className="empty-icon"><Icon name="cube" /></div>
            <h4>Loading the BIM viewer</h4>
            <p>Preparing the IFC geometry engine. The first load downloads the WebAssembly module.</p>
          </div>
        }>
          <BimViewer token={token} projects={projects} />
        </React.Suspense>
      ) : (
        <ChartViewerScreen token={token} projects={projects} embedded />
      )}
    </div>
  );
}

// ===================== QUANTITY SURVEY SCREEN (NEW) =====================
function QuantitySurveyScreen({ token, projects }) {
  const [projectId, setProjectId] = useState('');
  const [survey, setSurvey] = useState(null);
  const [bom, setBom] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [draftRates, setDraftRates] = useState({});
  const [savingRates, setSavingRates] = useState(false);

  const authHeaders = { Authorization: `Bearer ${token}` };

  const loadSurvey = async (id) => {
    if (!id) { setSurvey(null); setBom(null); return; }

    try {
      // The BOM endpoint returns 404 until one has been generated, so it is
      // optional rather than a failure of the screen.
      const [surveyResponse, bomResponse] = await Promise.all([
        axios.get(`${API_URL}/api/quantity-survey/${id}`, { headers: authHeaders }),
        axios.get(`${API_URL}/api/bom/${id}`, { headers: authHeaders }).catch(() => null)
      ]);

      setSurvey(surveyResponse.data);
      setBom(bomResponse?.data || null);
      setDraftRates(
        (surveyResponse.data.summary || []).reduce((acc, line) => {
          acc[`${line.materialType}|${line.unit}`] = line.rate === null || line.rate === undefined ? '' : String(line.rate);
          return acc;
        }, {})
      );
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  useEffect(() => {
    setError('');
    setNotice('');
    loadSurvey(projectId);
  }, [projectId]);

  const handleGenerate = async () => {
    if (!projectId) { setError('Select a project first.'); return; }

    if (!survey || survey.summary.length === 0) {
      setError('Nothing to put in a BOM yet — import a take-off on the BIM Import screen first.');
      return;
    }

    setBusy(true); setError(''); setNotice('');

    try {
      // The backend prices the BOM itself from the take-off and the saved rates.
      await axios.post(`${API_URL}/api/bom/generate`, { projectId }, { headers: authHeaders });
      setNotice('BOM generated and saved.');
      await loadSurvey(projectId);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  };

  // bom.components is stored as JSON text, so a malformed or old row must not
  // break the page.
  const bomLines = (() => {
    if (!bom?.components) return [];
    try {
      const parsed = JSON.parse(bom.components);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  })();

  const summary = survey?.summary || [];
  const projectName = projects.find(p => String(p.id) === String(projectId))?.name;
  const stamp = todayStamp();
  const totalAmount = num(survey?.totalAmount);
  const pricedLines = survey?.pricedLines ?? 0;
  const unpricedLines = survey?.unpricedLines ?? 0;
  const bomTotal = num(bom?.totalAmount);
  const bomStoredTotal = num(bom?.storedTotal ?? bom?.total_cost);

  const handleRateChange = (line, value) => {
    setDraftRates({ ...draftRates, [`${line.materialType}|${line.unit}`]: value });
  };

  const handleSaveRates = async () => {
    setSavingRates(true); setError(''); setNotice('');

    try {
      const rates = summary.map(line => {
        const draft = draftRates[`${line.materialType}|${line.unit}`];
        return {
          materialType: line.materialType,
          unit: line.unit,
          rate: draft === '' || draft === undefined || draft === null ? null : draft
        };
      });

      const response = await axios.put(`${API_URL}/api/rates/${projectId}`, { rates }, { headers: authHeaders });
      setNotice(`Rates saved — ${response.data.pricedLines} of ${response.data.lines.length} lines now priced.`);
      await loadSurvey(projectId);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setSavingRates(false);
    }
  };

  const exportSurvey = () => {
    const csv = buildCsv(
      ['Material', 'Unit', 'Total Quantity', 'Components', 'Rate (ETB/unit)', 'Amount (ETB)'],
      [
        ...summary.map(line => [
          line.materialType,
          line.unit,
          num(line.quantity).toFixed(2),
          line.componentCount,
          line.priced ? num(line.rate).toFixed(2) : '',
          line.priced ? num(line.amount).toFixed(2) : ''
        ]),
        ['Total', '', '', '', '', totalAmount.toFixed(2)]
      ]
    );
    downloadCsv(`quantity-survey-${safeFilePart(projectName)}-${stamp}.csv`, csv);
  };

  const exportBom = () => {
    const csv = buildCsv(
      ['Material', 'Unit', 'Quantity', 'Components', 'Rate (ETB/unit)', 'Amount (ETB)'],
      [
        ...bomLines.map(line => [
          line.materialType ?? line.material_type ?? '',
          line.unit ?? '',
          num(line.quantity).toFixed(2),
          line.componentCount ?? line.component_count ?? '',
          line.priced ? num(line.rate).toFixed(2) : '',
          line.priced ? num(line.amount).toFixed(2) : ''
        ]),
        ['Total', '', '', '', '', bomTotal.toFixed(2)]
      ]
    );
    downloadCsv(`bill-of-materials-${safeFilePart(projectName)}-${stamp}.csv`, csv);
  };

  return (
    <div className="page">
      <div className="page-head">
        <div className="page-head-copy">
          <div className="eyebrow">Commercial / measurement</div>
          <h1 className="page-title">Quantity survey</h1>
          <p className="page-sub">
            Totals are built from the imported take-off, grouped by material and unit. Set a rate
            once, then generate the bill of materials used for procurement and payment.
          </p>
        </div>
        <div className="page-actions">
          <div className="gis-project">
            <Icon name="calculator" size={13} />
            <label htmlFor="qs-project">Project</label>
            <select id="qs-project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">Select project</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          {summary.length > 0 && (
            <button className="btn" onClick={exportSurvey}>
              <Icon name="download" size={13} /> Export totals
            </button>
          )}
        </div>
      </div>

      {error && <div className="section-note" style={{ color: 'var(--danger)', background: 'var(--danger-soft)', borderColor: '#ecc9c4' }}><Icon name="alert" size={13} /> {error}</div>}
      {notice && <div className="section-note"><Icon name="checkCircle" size={13} /> {notice}</div>}

      {!projectId ? (
        <div className="empty">
          <div className="empty-icon"><Icon name="calculator" /></div>
          <h4>Choose a project to open its survey</h4>
          <p>Material totals, rate build-up and the saved BOM all belong to one project.</p>
        </div>
      ) : (
        <>
          <div className="kpi-grid">
            <div className="kpi">
              <div className="kpi-label"><Icon name="layers" size={12} /> Material lines</div>
              <div className="kpi-value">{summary.length}</div>
              <div className="kpi-meta">Distinct material / unit</div>
            </div>
            <div className="kpi">
              <div className="kpi-label"><Icon name="box" size={12} /> Components</div>
              <div className="kpi-value">{survey?.totalComponents ?? 0}</div>
              <div className="kpi-meta">Imported take-off rows</div>
            </div>
            <div className="kpi">
              <div className="kpi-label"><Icon name="database" size={12} /> Rated total</div>
              <div className="kpi-value">{compactValue(totalAmount)} <small>ETB</small></div>
              <div className="kpi-meta">{pricedLines} of {summary.length} lines priced</div>
            </div>
            <div className="kpi">
              <div className="kpi-label"><Icon name="alert" size={12} /> Unpriced</div>
              <div className="kpi-value" style={{ color: unpricedLines ? 'var(--amber)' : 'var(--ink)' }}>{unpricedLines}</div>
              <div className={`kpi-meta ${unpricedLines ? 'warn' : ''}`}>{unpricedLines ? 'Excluded from total' : 'Every line priced'}</div>
            </div>
          </div>

          {unpricedLines > 0 && summary.length > 0 && (
            <div className="section-note" style={{ color: '#7b4a0d', background: 'var(--amber-soft)', borderColor: '#e8d4ae' }}>
              <Icon name="alert" size={13} />
              <span>{unpricedLines} of {summary.length} material lines have no rate yet, so they add 0 ETB. The total stays incomplete until every line is rated.</span>
            </div>
          )}

          <div className="screen-grid">
            <section className="panel">
              <div className="panel-head">
                <div className="panel-head-copy">
                  <h3>Material totals & rate build-up</h3>
                  <p>Amount = quantity × rate. Rates are saved per project.</p>
                </div>
                <span className="panel-eyebrow">{summary.length} lines</span>
              </div>
              <div className="panel-body flush">
                {summary.length === 0 ? (
                  <div className="empty" style={{ margin: 14 }}>
                    <div className="empty-icon"><Icon name="upload" /></div>
                    <h4>No components yet</h4>
                    <p>Import a take-off on the BIM Import screen and the survey will fill in automatically.</p>
                  </div>
                ) : (
                  <div className="table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr><th>Material</th><th>Unit</th><th className="num">Quantity</th><th className="num">Components</th><th className="num">Rate (ETB)</th><th className="num">Amount (ETB)</th></tr>
                      </thead>
                      <tbody>
                        {summary.map((line, index) => (
                          <tr key={index}>
                            <td className="strong">{line.materialType}</td>
                            <td>{line.unit}</td>
                            <td className="num">{num(line.quantity).toLocaleString()}</td>
                            <td className="num">{line.componentCount}</td>
                            <td>
                              <input
                                type="number" min="0" step="0.01" className="input"
                                value={draftRates[`${line.materialType}|${line.unit}`] ?? ''}
                                onChange={(e) => handleRateChange(line, e.target.value)}
                                placeholder="no rate"
                                aria-label={`Rate for ${line.materialType} per ${line.unit}`}
                              />
                            </td>
                            <td className="num strong">{line.priced ? money(line.amount) : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr><td colSpan={5}>Total</td><td className="num">{money(totalAmount)}</td></tr>
                      </tfoot>
                    </table>
                  </div>
                )}
              </div>
              {summary.length > 0 && (
                <div className="panel-body" style={{ borderTop: '1px solid var(--line)' }}>
                  <div className="toolbar-row">
                    <button onClick={handleGenerate} className="btn btn-primary" disabled={busy || summary.length === 0}>
                      <Icon name="receipt" size={13} /> {busy ? 'Generating…' : 'Generate bill of materials'}
                    </button>
                    <button onClick={handleSaveRates} className="btn" disabled={savingRates || summary.length === 0}>
                      <Icon name="check" size={13} /> {savingRates ? 'Saving…' : 'Save rates'}
                    </button>
                    <button onClick={exportSurvey} className="btn" disabled={summary.length === 0}>
                      <Icon name="download" size={13} /> CSV
                    </button>
                  </div>
                  <p className="helper">Blank a rate to clear it. Save rates before generating the BOM.</p>
                </div>
              )}
            </section>

            <section className="panel">
              <div className="panel-head">
                <div className="panel-head-copy">
                  <h3>Saved BOM</h3>
                  <p>{bom ? `Generated ${bom.created_at ? new Date(bom.created_at).toLocaleString() : 'previously'}` : 'Not generated yet.'}</p>
                </div>
                <Icon name="receipt" size={14} style={{ color: 'var(--copper)' }} />
              </div>
              <div className="panel-body">
                {!bom ? (
                  <div className="empty" style={{ minHeight: 180 }}>
                    <div className="empty-icon"><Icon name="receipt" /></div>
                    <h4>No bill of materials</h4>
                    <p>Rate the material lines, then generate a BOM to price procurement.</p>
                  </div>
                ) : (
                  <>
                    <div className="bom-total">{money(bomTotal)} <small>ETB</small></div>
                    <div className="toolbar-row" style={{ marginTop: 8 }}>
                      <span className="context-line"><strong>{bomLines.length}</strong> lines</span>
                      <span className="context-line"><strong>{bom.pricedLines ?? 0}</strong> priced</span>
                    </div>
                    {Number.isFinite(bomStoredTotal) && Math.abs(bomStoredTotal - bomTotal) > 0.009 && (
                      <div className="section-note" style={{ marginTop: 12 }}>
                        <Icon name="alert" size={12} />
                        <span>Re-priced with current rates. The saved total was {money(bomStoredTotal)} ETB — regenerate to store the new figure.</span>
                      </div>
                    )}
                    <div className="form-actions">
                      <button onClick={exportBom} className="btn btn-copper btn-sm" disabled={bomLines.length === 0}>
                        <Icon name="download" size={12} /> Export BOM
                      </button>
                    </div>
                    <p className="helper">Lines without a rate show “—” and contribute 0 ETB, so an incomplete rate sheet is visible in the total.</p>
                  </>
                )}
              </div>
            </section>
          </div>

          {bom && bomLines.length > 0 && (
            <section className="panel">
              <div className="panel-head">
                <div className="panel-head-copy"><h3>Bill of materials lines</h3><p>Current rates applied to the saved BOM.</p></div>
                <span className="panel-eyebrow">{bomLines.length} lines</span>
              </div>
              <div className="panel-body flush">
                <div className="table-wrap">
                  <table className="data-table">
                    <thead><tr><th>Material</th><th>Unit</th><th className="num">Quantity</th><th className="num">Components</th><th className="num">Rate (ETB)</th><th className="num">Amount (ETB)</th></tr></thead>
                    <tbody>
                      {bomLines.map((line, index) => (
                        <tr key={index}>
                          <td className="strong">{line.materialType ?? line.material_type ?? '-'}</td>
                          <td>{line.unit ?? '-'}</td>
                          <td className="num">{num(line.quantity).toLocaleString()}</td>
                          <td className="num">{line.componentCount ?? line.component_count ?? '-'}</td>
                          <td className="num">{line.priced ? money(line.rate) : '—'}</td>
                          <td className="num strong">{line.priced ? money(line.amount) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot><tr><td colSpan={5}>Total (ETB)</td><td className="num">{money(bomTotal)}</td></tr></tfoot>
                  </table>
                </div>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

// ===================== MATERIALS DATABASE SCREEN (NEW) =====================
function MaterialsDatabaseScreen({ token, projects }) {
  const [projectId, setProjectId] = useState('');
  const [category, setCategory] = useState('Foundation');
  const [materials, setMaterials] = useState([]);
  const [customMaterials, setCustomMaterials] = useState([]);
  const [newMaterial, setNewMaterial] = useState({ materialType: '', unit: '', quantity: '', cost: '' });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    fetchMaterials();
  }, [category]);

  const fetchMaterials = async () => {
    try {
      const response = await axios.get(`${API_URL}/api/materials/category/${category}`);
      setMaterials(response.data);
      setError('');
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const handleAddCustom = async (e) => {
    e.preventDefault();
    if (!projectId) {
      setError('Select a project before adding a custom material.');
      return;
    }

    setError(''); setNotice('');

    try {
      const response = await axios.post(`${API_URL}/api/materials/custom`, {
        projectId,
        ...newMaterial,
        category
      }, {
        headers: { Authorization: `Bearer ${token}` }
      });
      
      setCustomMaterials([...customMaterials, response.data]);
      setNewMaterial({ materialType: '', unit: '', quantity: '', cost: '' });
      setNotice('Custom material added to this project.');
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div className="page-head-copy">
          <div className="eyebrow">Reference / Ethiopian standards</div>
          <h1 className="page-title">Materials database</h1>
          <p className="page-sub">
            Standard material costs and quantities for Ethiopian construction, with project-specific
            additions for local suppliers and non-standard specifications.
          </p>
        </div>
        <div className="page-actions">
          <div className="gis-project">
            <Icon name="layers" size={13} />
            <label htmlFor="materials-project">Custom materials for</label>
            <select id="materials-project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">Optional — no project</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        </div>
      </div>

      {error && <div className="section-note" style={{ color: 'var(--danger)', background: 'var(--danger-soft)', borderColor: '#ecc9c4' }}><Icon name="alert" size={13} /> {error}</div>}
      {notice && <div className="section-note"><Icon name="checkCircle" size={13} /> {notice}</div>}

      <div className="kpi-grid">
        <div className="kpi">
          <div className="kpi-label"><Icon name="layers" size={12} /> Category</div>
          <div className="kpi-value" style={{ fontSize: 24 }}>{category}</div>
          <div className="kpi-meta">Ethiopian standard library</div>
        </div>
        <div className="kpi">
          <div className="kpi-label"><Icon name="box" size={12} /> Materials</div>
          <div className="kpi-value">{materials.length}</div>
          <div className="kpi-meta">In this category</div>
        </div>
        <div className="kpi">
          <div className="kpi-label"><Icon name="plus" size={12} /> Custom</div>
          <div className="kpi-value">{customMaterials.length}</div>
          <div className="kpi-meta">{projectId ? 'Added to this project' : 'Select a project to add'}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label"><Icon name="database" size={12} /> Library</div>
          <div className="kpi-value">80<small>+</small></div>
          <div className="kpi-meta">Across seven categories</div>
        </div>
      </div>

      <section className="panel">
        <div className="panel-body">
          <div className="toolbar-row" style={{ justifyContent: 'space-between' }}>
            <div className="category-tabs">
              {['Foundation', 'Structural', 'Masonry', 'MEP', 'Finishes', 'Roofing', 'Safety'].map(cat => (
                <button
                  key={cat}
                  type="button"
                  className={`category-tab ${category === cat ? 'active' : ''}`}
                  onClick={() => { setCategory(cat); setError(''); setNotice(''); }}
                >
                  {cat}
                </button>
              ))}
            </div>
            <span className="panel-eyebrow">{materials.length} records</span>
          </div>
        </div>
      </section>

      <div className="screen-grid">
        <section className="panel">
          <div className="panel-head">
            <div className="panel-head-copy">
              <h3>{category} materials</h3>
              <p>Standard quantity and cost assumptions, editable through the project record.</p>
            </div>
            <span className="panel-eyebrow">ETB</span>
          </div>
          <div className="panel-body flush">
            <div className="table-wrap">
              <table className="data-table">
                <thead><tr><th>Material</th><th>Unit</th><th className="num">Standard qty</th><th className="num">Cost (ETB)</th><th>Notes</th></tr></thead>
                <tbody>
                  {materials.length === 0 ? (
                    <tr><td colSpan="5" className="muted" style={{ padding: 18, textAlign: 'center' }}>No materials in this category. Try another category or refresh.</td></tr>
                  ) : (
                    materials.map((mat, idx) => (
                      <tr key={idx}>
                        <td className="strong">{mat.material_type}</td>
                        <td>{mat.unit}</td>
                        <td className="num">{mat.standard_quantity == null ? '—' : num(mat.standard_quantity)}</td>
                        <td className="num">{mat.cost == null ? 'N/A' : num(mat.cost).toLocaleString()}</td>
                        <td className="muted">{mat.notes || '—'}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <div className="stack">
          <section className="panel">
            <div className="panel-head">
              <div className="panel-head-copy">
                <h3>Add custom material</h3>
                <p>{projectId ? 'Saved against the selected project.' : 'Choose a project above to enable this form.'}</p>
              </div>
              <Icon name="plus" size={14} style={{ color: 'var(--copper)' }} />
            </div>
            {!projectId ? (
              <div className="panel-body">
                <div className="empty" style={{ minHeight: 140 }}>
                  <div className="empty-icon"><Icon name="projects" /></div>
                  <h4>No project selected</h4>
                  <p>Custom materials need a project so their cost stays in the right record.</p>
                </div>
              </div>
            ) : (
              <form onSubmit={handleAddCustom} className="panel-body">
                <div className="form-grid">
                  <div className="field full">
                    <label htmlFor="custom-type">Material type</label>
                    <input
                      id="custom-type" className="input" placeholder="e.g. Hollow concrete block"
                      value={newMaterial.materialType}
                      onChange={(e) => setNewMaterial({...newMaterial, materialType: e.target.value})}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="custom-unit">Unit</label>
                    <input
                      id="custom-unit" className="input" placeholder="m², kg, pcs"
                      value={newMaterial.unit}
                      onChange={(e) => setNewMaterial({...newMaterial, unit: e.target.value})}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="custom-qty">Quantity</label>
                    <input
                      id="custom-qty" className="input" type="number" placeholder="0"
                      value={newMaterial.quantity}
                      onChange={(e) => setNewMaterial({...newMaterial, quantity: e.target.value})}
                    />
                  </div>
                  <div className="field full">
                    <label htmlFor="custom-cost">Cost (ETB)</label>
                    <input
                      id="custom-cost" className="input" type="number" placeholder="0.00"
                      value={newMaterial.cost}
                      onChange={(e) => setNewMaterial({...newMaterial, cost: e.target.value})}
                    />
                  </div>
                </div>
                <div className="form-actions">
                  <button type="submit" className="btn btn-primary btn-sm">
                    <Icon name="plus" size={12} /> Add to {category}
                  </button>
                </div>
              </form>
            )}
            {customMaterials.length > 0 && (
              <div className="panel-body" style={{ borderTop: '1px solid var(--line)' }}>
                <div className="panel-eyebrow" style={{ marginBottom: 8 }}>Project additions</div>
                <div className="table-wrap">
                  <table className="data-table">
                    <tbody>
                      {customMaterials.map((mat, idx) => (
                        <tr key={idx}>
                          <td className="strong">{mat.material_type}</td>
                          <td className="num">{mat.quantity} {mat.unit}</td>
                          <td className="num">{mat.cost} ETB</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </section>

          <section className="panel">
            <div className="panel-head">
              <div className="panel-head-copy"><h3>Standards coverage</h3><p>Pre-loaded assumptions for common site work.</p></div>
              <Icon name="database" size={14} style={{ color: 'var(--ink-3)' }} />
            </div>
            <div className="panel-body">
              <div className="context-line" style={{ marginBottom: 8 }}>Foundation · Structural · Masonry · MEP · Finishes · Roofing · Safety</div>
              <p className="helper" style={{ marginTop: 0 }}>Quantities can be derived from building size, and project additions sit alongside the standard library without changing it.</p>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

// ===================== FRAUD DETECTION SCREEN =====================
function FraudDetectionScreen({ token, projects }) {
  const [projectId, setProjectId] = useState('');
  const [actualQty, setActualQty] = useState('60');
  const [expectedQty, setExpectedQty] = useState('50');
  const [actualPrice, setActualPrice] = useState('10.20');
  const [marketPrice, setMarketPrice] = useState('8.50');
  const [deliveryDate, setDeliveryDate] = useState('2024-01-15');
  const [expectedDate, setExpectedDate] = useState('2024-01-08');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  const handleAnalyze = async (e) => {
    e.preventDefault();
    setError('');
    try {
      const response = await axios.post(`${API_URL}/api/fraud-detection/smart`, {
        projectId,
        actualQty: parseFloat(actualQty),
        expectedQty: parseFloat(expectedQty),
        actualPrice: parseFloat(actualPrice),
        marketPrice: parseFloat(marketPrice),
        deliveryDate,
        expectedDate
      }, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setResult(response.data);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const highRisk = result?.riskLevel === 'high';
  const scoringFactors = (result?.factors || []).filter(factor => factor.points > 0);

  return (
    <div className="page">
      <div className="page-head">
        <div className="page-head-copy">
          <div className="eyebrow">Commercial / payment control</div>
          <h1 className="page-title">Risk & fraud</h1>
          <p className="page-sub">
            Test a material delivery against market price, expected quantity and schedule. The score
            flags invoices worth reviewing before payment — it is not proof of fraud.
          </p>
        </div>
        <div className="page-actions">
          <div className="gis-project">
            <Icon name="shield" size={13} />
            <label htmlFor="risk-project">Project</label>
            <select id="risk-project" value={projectId} onChange={(e) => setProjectId(e.target.value)} required>
              <option value="">Select project</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        </div>
      </div>

      {error && <div className="section-note" style={{ color: 'var(--danger)', background: 'var(--danger-soft)', borderColor: '#ecc9c4' }}><Icon name="alert" size={13} /> {error}</div>}

      <div className="screen-grid">
        <form onSubmit={handleAnalyze} className="panel">
          <div className="panel-head">
            <div className="panel-head-copy">
              <h3>Delivery details</h3>
              <p>Quantities per unit, price per unit, and both dates.</p>
            </div>
            <span className="panel-eyebrow">Check</span>
          </div>
          <div className="panel-body">
            <div className="form-grid">
              <div className="field">
                <label htmlFor="risk-actual-qty">Actual quantity</label>
                <input id="risk-actual-qty" className="input" type="number" step="0.01" value={actualQty} onChange={(e) => setActualQty(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="risk-expected-qty">Expected quantity</label>
                <input id="risk-expected-qty" className="input" type="number" step="0.01" value={expectedQty} onChange={(e) => setExpectedQty(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="risk-actual-price">Actual price (per unit)</label>
                <input id="risk-actual-price" className="input" type="number" step="0.01" value={actualPrice} onChange={(e) => setActualPrice(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="risk-market-price">Market price (per unit)</label>
                <input id="risk-market-price" className="input" type="number" step="0.01" value={marketPrice} onChange={(e) => setMarketPrice(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="risk-delivery-date">Delivery date</label>
                <input id="risk-delivery-date" className="input" type="date" value={deliveryDate} onChange={(e) => setDeliveryDate(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="risk-expected-date">Expected delivery date</label>
                <input id="risk-expected-date" className="input" type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} />
              </div>
            </div>
            <div className="form-actions">
              <button type="submit" className="btn btn-primary" disabled={!projectId}>
                <Icon name="search" size={13} /> Analyze delivery
              </button>
              <span className="toolbar-note">70% or more blocks payment.</span>
            </div>
          </div>
        </form>

        <section className="panel">
          <div className="panel-head">
            <div className="panel-head-copy"><h3>How the score is built</h3><p>Weighted, capped and explainable.</p></div>
            <Icon name="shield" size={14} style={{ color: 'var(--copper)' }} />
          </div>
          <div className="panel-body">
            <div className="factor-legend">
              {[
                ['01', 'Price variance', 'Actual price against market price'],
                ['02', 'Quantity variance', 'Delivered against expected quantity'],
                ['03', 'Delivery delay', 'Delivery date against schedule']
              ].map(([index, label, detail]) => (
                <div className="factor-item" key={index}>
                  <span className="factor-index">{index}</span>
                  <div>
                    <strong>{label}</strong>
                    <span>{detail}</span>
                  </div>
                </div>
              ))}
            </div>
            <div className="section-note" style={{ marginTop: 16 }}>
              <Icon name="alert" size={12} />
              <span>Each factor scores nothing inside its tolerance and its full points at saturation. Points add up to the total; a high score means look closely, not that fraud is proven.</span>
            </div>
          </div>
        </section>
      </div>

      {result && (
        <>
          <div className={`score-banner ${highRisk ? 'high' : ''}`}>
            <div className="score-banner-copy">
              <div className="score-kicker">Fraud confidence score</div>
              <div className={`score-number ${highRisk ? 'high' : ''}`}>{fmt(result.fraudScore, 1)}%</div>
              <div className="score-text">
                {highRisk ? 'High risk' : 'Low risk'} · payment is blocked at {result.threshold}%
              </div>
            </div>
            <div className="score-recommendation">
              <div className="score-kicker">Recommendation</div>
              <strong className={result.recommendation === 'BLOCK_PAYMENT' ? 'high' : ''}>
                {result.recommendation === 'BLOCK_PAYMENT' ? 'Block payment' : 'Approve payment'}
              </strong>
            </div>
          </div>

          <div className="kpi-grid three">
            <div className="kpi">
              <div className="kpi-label"><Icon name="database" size={12} /> Invoiced above expected</div>
              <div className="kpi-value">{compactValue(result.excessClaimed)} <small>ETB</small></div>
              <div className="kpi-meta">Delivered value less expected value</div>
            </div>
            <div className="kpi">
              <div className="kpi-label"><Icon name="alert" size={12} /> Factors scoring</div>
              <div className="kpi-value">{scoringFactors.length}<small> of {(result.factors || []).length}</small></div>
              <div className="kpi-meta">Outside tolerance</div>
            </div>
            <div className="kpi">
              <div className="kpi-label"><Icon name="shield" size={12} /> Block threshold</div>
              <div className="kpi-value">{result.threshold}<small>%</small></div>
              <div className="kpi-meta">{result.capped ? 'Score capped at 99%' : 'Uncapped score'}</div>
            </div>
          </div>

          <section className="panel">
            <div className="panel-head">
              <div className="panel-head-copy"><h3>Factors behind the score</h3><p>Measured value, tolerance and contribution.</p></div>
              <span className="panel-eyebrow">{fmt(result.fraudScore, 1)}% total</span>
            </div>
            <div className="panel-body flush">
              <div className="table-wrap">
                <table className="data-table">
                  <thead><tr><th>Factor</th><th className="num">Measured</th><th className="num">Normal up to</th><th className="num">Points</th><th>Contribution</th></tr></thead>
                  <tbody>
                    {(result.factors || []).map((factor) => (
                      <tr key={factor.key}>
                        <td>
                          <div className="strong">{factor.label}</div>
                          <div className="muted" style={{ marginTop: 2, maxWidth: 340 }}>{factor.explanation}</div>
                        </td>
                        <td className="num">{fmt(factor.measured, 1)}{factor.unit}</td>
                        <td className="num">{factor.tolerance}{factor.unit}</td>
                        <td className="num strong" style={{ color: factor.points >= result.threshold ? 'var(--danger)' : factor.points > 0 ? 'var(--copper)' : 'var(--signal)' }}>
                          {fmt(factor.points, 1)} of {factor.maxPoints}
                        </td>
                        <td>
                          <div className="factor-track" aria-hidden="true">
                            <div
                              className={`factor-fill ${factor.points >= result.threshold ? 'high' : ''}`}
                              style={{ width: `${Math.min(100, (factor.points / factor.maxPoints) * 100)}%` }}
                            />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr><td colSpan={3}>Total score</td><td className="num">{fmt(result.fraudScore, 1)}%</td><td>{result.capped ? 'Capped at 99%' : '—'}</td></tr>
                  </tfoot>
                </table>
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div className="panel-head-copy"><h3>What it means in money</h3><p>Delivered quantity at invoiced price, less expected quantity at market price.</p></div>
              <span className="panel-eyebrow">ETB</span>
            </div>
            <div className="panel-body">
              <div className="context-line" style={{ fontSize: 12 }}>
                Invoiced above expected: <strong style={{ fontSize: 15 }}>{money(result.excessClaimed)} ETB</strong>
              </div>
              {scoringFactors.length > 0 && (
                <p className="helper">Scored here by: {scoringFactors.map(factor => factor.label.toLowerCase()).join(', ')}.</p>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

// ===================== PROJECTS SCREEN =====================
function ProjectsScreen({ token, projects, projectsError, fetchProjects, setSelectedProject, setCurrentScreen }) {
  return (
    <div className="page">
      <div className="page-head">
        <div className="page-head-copy">
          <div className="eyebrow">Portfolio / project records</div>
          <h1 className="page-title">Projects</h1>
          <p className="page-sub">Every site, its commercial envelope and the records that support it.</p>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" onClick={() => setCurrentScreen('new-project')}>
            <Icon name="plus" size={14} /> New project
          </button>
        </div>
      </div>

      {projectsError && (
        <div className="section-note" role="alert" style={{ color: 'var(--danger)', background: 'var(--danger-soft)', borderColor: '#ecc9c4' }}>
          <Icon name="alert" size={13} /> {projectsError}
          <button className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={() => fetchProjects && fetchProjects()}>
            <Icon name="refresh" size={12} /> Try again
          </button>
        </div>
      )}

      {projects.length === 0 ? (
        <div className="empty">
          <div className="empty-icon"><Icon name="projects" /></div>
          <h4>No projects in the portfolio</h4>
          <p>Create the first project to connect field evidence, spatial context and commercial control.</p>
          <button className="btn btn-primary btn-sm" onClick={() => setCurrentScreen('new-project')}>
            <Icon name="plus" size={13} /> Create project
          </button>
        </div>
      ) : (
        <div className="portfolio-grid">
          {projects.map((project, index) => (
            <button
              key={project.id}
              className="portfolio-card"
              onClick={() => { setSelectedProject(project); setCurrentScreen('project-details'); }}
            >
              <div className="portfolio-card-top">
                <div className="project-avatar"><Icon name={index % 3 === 0 ? 'building' : index % 3 === 1 ? 'mapPin' : 'route'} size={17} /></div>
                <span className="project-status"><span className="status-dot" style={{ width: 4, height: 4, boxShadow: 'none' }} /> Active</span>
              </div>
              <h3>{project.name}</h3>
              <div className="portfolio-location"><Icon name="mapPin" size={11} /> {project.location || 'Location not set'}</div>
              <div className="portfolio-metrics">
                <div className="portfolio-metric">
                  <span>Budget</span>
                  <strong>{project.budget == null ? '—' : `ETB ${compactValue(project.budget)}`}</strong>
                </div>
                <div className="portfolio-metric">
                  <span>Timeline</span>
                  <strong>{project.timeline ? `${project.timeline} months` : 'Not set'}</strong>
                </div>
              </div>
              <div className="portfolio-open">Open project record <Icon name="arrowRight" size={12} /></div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ===================== PROJECT DETAILS SCREEN =====================
function ProjectDetailsScreen({ token, project, setCurrentScreen, onProjectUpdated, onProjectDeleted }) {
  const [survey, setSurvey] = useState(null);
  const [bom, setBom] = useState(null);
  const [progress, setProgress] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [earthworks, setEarthworks] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState('');
  const [form, setForm] = useState({ name: '', description: '', budget: '', location: '', timeline: '' });

  const authHeaders = { Authorization: `Bearer ${token}` };
  const projectId = project?.id;

  const startEdit = () => {
    setActionError('');
    setForm({
      name: project?.name || '',
      description: project?.description || '',
      budget: project?.budget == null ? '' : String(project.budget),
      location: project?.location || '',
      timeline: project?.timeline == null ? '' : String(project.timeline)
    });
    setEditing(true);
  };

  const handleSave = async (event) => {
    event.preventDefault();
    setActionError('');

    if (!form.name.trim()) {
      setActionError('A project name is required.');
      return;
    }
    const budget = form.budget === '' ? null : Number(form.budget);
    if (budget !== null && (!Number.isFinite(budget) || budget < 0)) {
      setActionError('Budget must be a number of 0 or more.');
      return;
    }
    const timeline = form.timeline === '' ? null : Number(form.timeline);
    if (timeline !== null && (!Number.isFinite(timeline) || timeline < 0)) {
      setActionError('Timeline must be a number of months, 0 or more.');
      return;
    }

    setSaving(true);
    try {
      const response = await axios.patch(`${API_URL}/api/projects/${projectId}`, {
        name: form.name.trim(),
        description: form.description.trim(),
        location: form.location.trim(),
        budget,
        timeline
      }, { headers: authHeaders });
      setEditing(false);
      if (onProjectUpdated) onProjectUpdated(response.data);
    } catch (err) {
      setActionError(err.response?.data?.error || err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!project) return;
    const confirmed = window.confirm(`Delete “${project.name}” and every record attached to it? This cannot be undone.`);
    if (!confirmed) return;

    setActionError('');
    try {
      await axios.delete(`${API_URL}/api/projects/${projectId}`, { headers: authHeaders });
      if (onProjectDeleted) onProjectDeleted(projectId);
    } catch (err) {
      setActionError(err.response?.data?.error || err.message);
    }
  };

  useEffect(() => {
    if (!projectId) return undefined;

    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError('');

      try {
        // Every one of these 404s until the project has that kind of data, so they
        // are optional rather than failures of the page.
        const optional = (url) => axios.get(url, { headers: authHeaders }).catch(() => null);

        const [surveyResponse, bomResponse, progressResponse, alertsResponse, earthworksResponse] = await Promise.all([
          optional(`${API_URL}/api/quantity-survey/${projectId}`),
          optional(`${API_URL}/api/bom/${projectId}`),
          optional(`${API_URL}/api/progress/${projectId}`),
          optional(`${API_URL}/api/fraud-detection/${projectId}`),
          optional(`${API_URL}/api/earthworks/${projectId}`)
        ]);

        if (cancelled) return;

        setSurvey(surveyResponse?.data || null);
        setBom(bomResponse?.data || null);
        setProgress(progressResponse?.data || null);
        setAlerts(alertsResponse?.data || []);
        setEarthworks(earthworksResponse?.data || null);
      } catch (err) {
        if (!cancelled) setError(err.response?.data?.error || err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => { cancelled = true; };
  }, [projectId]);

  if (!project) {
    return (
      <div className="page">
        <div className="page-head">
          <div className="page-head-copy">
            <div className="eyebrow">Project record</div>
            <h1 className="page-title">Project details</h1>
            <p className="page-sub">Select a project from the portfolio to open its connected records.</p>
          </div>
        </div>
        <div className="empty">
          <div className="empty-icon"><Icon name="projects" /></div>
          <h4>No project selected</h4>
          <p>Open the portfolio and choose a site to see its take-off, BOM, progress, risk and earthworks.</p>
          <button className="btn btn-primary btn-sm" onClick={() => setCurrentScreen('projects')}>
            <Icon name="chevronLeft" size={12} /> Back to portfolio
          </button>
        </div>
      </div>
    );
  }

  const budget = num(project.budget);
  const spent = num(progress?.budget_spent);
  const progressPct = num(progress?.progress_percent);
  const spentPct = budget > 0 ? (spent / budget) * 100 : 0;
  const remaining = budget - spent;
  const lines = survey?.summary || [];
  const ratedTotal = num(survey?.totalAmount);
  const blockedAlerts = alerts.filter(a => String(a.recommendation).toUpperCase() === 'BLOCK_PAYMENT').length;

  const bomLines = (() => {
    if (!bom?.components) return [];
    try {
      const parsed = JSON.parse(bom.components);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      return [];
    }
  })();

  // Biggest material lines first: by cost when priced, otherwise by quantity.
  const topLines = [...lines]
    .sort((a, b) => (b.priced ? num(b.amount) : num(b.quantity)) - (a.priced ? num(a.amount) : num(a.quantity)))
    .slice(0, 5);

  return (
    <div className="page">
      <div className="page-head">
        <div className="page-head-copy">
          <button className="btn btn-ghost btn-sm" onClick={() => setCurrentScreen('projects')} style={{ alignSelf: 'flex-start', marginBottom: 6, paddingLeft: 0 }}>
            <Icon name="chevronLeft" size={12} /> Portfolio
          </button>
          <div className="eyebrow">Project record / {project.location || 'No location'}</div>
          <h1 className="page-title">{project.name}</h1>
          <p className="page-sub">
            {project.description || 'The single record for field evidence, quantities, spend and payment risk on this site.'}
          </p>
          <div className="context-line" style={{ marginTop: 8 }}>
            <span><Icon name="mapPin" size={11} style={{ verticalAlign: -1 }} /> {project.location || 'No location'}</span>
            <span>·</span>
            <span>{project.timeline ? `${project.timeline} months` : 'No timeline'}</span>
            <span>·</span>
            <span>Created {project.created_at ? new Date(project.created_at).toLocaleDateString() : 'unknown'}</span>
          </div>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={startEdit}>
            <Icon name="settings" size={13} /> Edit project
          </button>
          <button className="btn" onClick={() => setCurrentScreen('gis')}>
            <Icon name="map" size={13} /> Open map
          </button>
          <button className="btn btn-primary" onClick={() => setCurrentScreen('3d-viewer')}>
            <Icon name="cube" size={13} /> Digital twin
          </button>
          <button className="btn" onClick={handleDelete} style={{ color: 'var(--danger)' }}>
            Delete
          </button>
        </div>
      </div>

      {editing && (
        <section className="panel" style={{ marginBottom: 14 }}>
          <div className="panel-head">
            <div className="panel-head-copy">
              <h3>Edit project</h3>
              <p>Correct the name, site or commercial envelope. Take-off, survey and map records stay attached.</p>
            </div>
            <span className="panel-eyebrow">Editing</span>
          </div>
          <form className="panel-body" onSubmit={handleSave}>
            <div className="form-grid">
              <div className="field full">
                <label htmlFor="edit-project-name">Project name</label>
                <input id="edit-project-name" className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
              </div>
              <div className="field full">
                <label htmlFor="edit-project-description">Description</label>
                <textarea
                  id="edit-project-description"
                  className="input"
                  style={{ height: 86, paddingTop: 9, resize: 'vertical' }}
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                />
              </div>
              <div className="field">
                <label htmlFor="edit-project-budget">Budget (ETB)</label>
                <input id="edit-project-budget" className="input" type="number" min="0" step="0.01" value={form.budget} onChange={(e) => setForm({ ...form, budget: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="edit-project-timeline">Timeline (months)</label>
                <input id="edit-project-timeline" className="input" type="number" min="0" step="1" value={form.timeline} onChange={(e) => setForm({ ...form, timeline: e.target.value })} />
              </div>
              <div className="field full">
                <label htmlFor="edit-project-location">Location</label>
                <input id="edit-project-location" className="input" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
              </div>
            </div>
            <div className="toolbar-row" style={{ marginTop: 12 }}>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</button>
              <button type="button" className="btn" onClick={() => setEditing(false)} disabled={saving}>Cancel</button>
            </div>
          </form>
        </section>
      )}

      {actionError && <div className="section-note" role="alert" style={{ color: 'var(--danger)', background: 'var(--danger-soft)', borderColor: '#ecc9c4' }}><Icon name="alert" size={13} /> {actionError}</div>}
      {error && <div className="section-note" style={{ color: 'var(--danger)', background: 'var(--danger-soft)', borderColor: '#ecc9c4' }}><Icon name="alert" size={13} /> {error}</div>}
      {loading && <div className="section-note"><Icon name="refresh" size={12} /> Loading connected project records…</div>}

      <div className="kpi-grid">
        <div className="kpi">
          <div className="kpi-label"><Icon name="database" size={12} /> Budget</div>
          <div className="kpi-value">{compactValue(budget)} <small>ETB</small></div>
          <div className="kpi-meta">Approved envelope</div>
        </div>
        <div className="kpi">
          <div className="kpi-label"><Icon name="activity" size={12} /> Spent</div>
          <div className="kpi-value">{compactValue(spent)} <small>ETB</small></div>
          <div className="kpi-meta">{fmt(spentPct, 1)}% of budget</div>
        </div>
        <div className="kpi">
          <div className="kpi-label"><Icon name="database" size={12} /> Remaining</div>
          <div className="kpi-value" style={{ color: remaining < 0 ? 'var(--danger)' : 'var(--ink)' }}>{compactValue(remaining)} <small>ETB</small></div>
          <div className={`kpi-meta ${remaining < 0 ? 'warn' : ''}`}>{remaining < 0 ? 'Over budget' : 'Left to spend'}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label"><Icon name="checkCircle" size={12} /> Progress</div>
          <div className="kpi-value">{progress ? `${fmt(progressPct, 1)}%` : '—'}</div>
          <div className="kpi-meta">{progress ? `Recorded ${new Date(progress.created_at).toLocaleDateString()}` : 'Not recorded yet'}</div>
        </div>
      </div>

      <div className="screen-grid">
        <div className="stack">
          <section className="panel">
            <div className="panel-head">
              <div className="panel-head-copy">
                <h3>Take-off</h3>
                <p>Largest material lines by cost, then quantity.</p>
              </div>
              <span className="panel-eyebrow">{survey?.totalComponents ?? 0} components</span>
            </div>
            <div className="panel-body flush">
              {lines.length === 0 ? (
                <div className="empty" style={{ margin: 14 }}>
                  <div className="empty-icon"><Icon name="upload" /></div>
                  <h4>No take-off imported</h4>
                  <p>Import components on BIM Import and the survey, BOM and twin will use them.</p>
                </div>
              ) : (
                <>
                  <div className="panel-body">
                    <div className="context-line">
                      <strong>{lines.length}</strong> material lines · <strong>{ratedTotal > 0 ? `${money(ratedTotal)} ETB` : 'no rates set'}</strong>
                    </div>
                  </div>
                  <div className="table-wrap">
                    <table className="data-table">
                      <thead><tr><th>Material</th><th className="num">Quantity</th><th className="num">Amount (ETB)</th></tr></thead>
                      <tbody>
                        {topLines.map((line, index) => (
                          <tr key={index}>
                            <td className="strong">{line.materialType}</td>
                            <td className="num">{num(line.quantity).toLocaleString()} {line.unit}</td>
                            <td className="num">{line.priced ? money(line.amount) : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {ratesMissing(lines) && (
                    <div className="panel-body" style={{ borderTop: '1px solid var(--line)' }}>
                      <div className="section-note" style={{ background: 'var(--amber-soft)', borderColor: '#e8d4ae', color: '#7b4a0d' }}>
                        <Icon name="alert" size={12} /> Some material lines have no rate yet, so the rated total is incomplete.
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div className="panel-head-copy"><h3>Latest bill of materials</h3><p>The priced procurement position.</p></div>
              <Icon name="receipt" size={14} style={{ color: 'var(--ink-3)' }} />
            </div>
            <div className="panel-body">
              {!bom ? (
                <div className="empty" style={{ minHeight: 130 }}>
                  <div className="empty-icon"><Icon name="receipt" /></div>
                  <h4>No BOM generated</h4>
                  <p>Build one on Quantity Survey once the material rates are set.</p>
                </div>
              ) : (
                <>
                  <div className="bom-total">{money(num(bom.totalAmount))} <small>ETB</small></div>
                  <div className="context-line" style={{ marginTop: 7 }}>
                    <strong>{bomLines.length}</strong> lines · generated {bom.created_at ? new Date(bom.created_at).toLocaleString() : 'previously'}
                  </div>
                  {Number.isFinite(num(bom.storedTotal)) && Math.abs(num(bom.storedTotal) - num(bom.totalAmount)) > 0.009 && (
                    <p className="helper">Re-priced with current rates; the saved total was {money(num(bom.storedTotal))} ETB.</p>
                  )}
                </>
              )}
            </div>
          </section>
        </div>

        <div className="stack">
          <section className="panel">
            <div className="panel-head">
              <div className="panel-head-copy"><h3>Latest progress</h3><p>Physical completion and spend.</p></div>
              <span className={`project-status ${!progress ? 'neutral' : ''}`}>{progress ? 'Recorded' : 'No entry'}</span>
            </div>
            <div className="panel-body">
              {!progress ? (
                <p className="helper" style={{ marginTop: 0 }}>No progress recorded. Record it on Progress & budget.</p>
              ) : (
                <>
                  <div className="meter-block" style={{ paddingTop: 0, borderTop: 0 }}>
                    <div className="meter-head"><span>Work complete</span><strong>{fmt(progressPct, 1)}%</strong></div>
                    <div className="meter-track"><div className="meter-fill" style={{ width: `${Math.max(0, Math.min(100, progressPct))}%` }} /></div>
                  </div>
                  <p className="helper" style={{ color: 'var(--ink-2)', fontSize: 10.5 }}>{money(spent)} ETB spent</p>
                  <p className="helper">{progress.notes ? progress.notes : 'No notes on this entry.'}</p>
                  <p className="helper">Saved {new Date(progress.created_at).toLocaleString()}</p>
                </>
              )}
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div className="panel-head-copy"><h3>Payment risk</h3><p>Fraud checks recorded against this project.</p></div>
              <Icon name="shield" size={14} style={{ color: blockedAlerts ? 'var(--danger)' : 'var(--signal)' }} />
            </div>
            <div className="panel-body">
              {alerts.length === 0 ? (
                <p className="helper" style={{ marginTop: 0 }}>No fraud checks recorded yet. Run one on Risk & fraud.</p>
              ) : (
                <>
                  <div className="toolbar-row" style={{ marginBottom: 8 }}>
                    <span className="context-line"><strong>{alerts.length}</strong> {alerts.length === 1 ? 'check' : 'checks'}</span>
                    <span className={`project-status ${blockedAlerts ? 'attention' : ''}`}>{blockedAlerts} blocked payment</span>
                  </div>
                  <p className="helper" style={{ marginTop: 0 }}>
                    Most recent: {fmt(alerts[0].fraud_score, 1)}% · {String(alerts[0].recommendation).toUpperCase() === 'BLOCK_PAYMENT' ? 'Block payment' : 'Approve'} · {new Date(alerts[0].created_at).toLocaleDateString()}
                  </p>
                </>
              )}
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div className="panel-head-copy"><h3>Earthworks</h3><p>Cut, fill and net movement.</p></div>
              <Icon name="layers" size={14} style={{ color: 'var(--ink-3)' }} />
            </div>
            <div className="panel-body">
              {!earthworks ? (
                <p className="helper" style={{ marginTop: 0 }}>No earthworks calculation recorded. Run one from Survey control points.</p>
              ) : (
                <>
                  <div className="kpi-grid three" style={{ marginBottom: 0 }}>
                    <div className="kpi" style={{ padding: 10 }}>
                      <div className="kpi-label">Cut</div>
                      <div className="kpi-value" style={{ fontSize: 18 }}>{fmt(num(earthworks.cut_volume))} <small>m³</small></div>
                    </div>
                    <div className="kpi" style={{ padding: 10 }}>
                      <div className="kpi-label">Fill</div>
                      <div className="kpi-value" style={{ fontSize: 18 }}>{fmt(num(earthworks.fill_volume))} <small>m³</small></div>
                    </div>
                    <div className="kpi" style={{ padding: 10 }}>
                      <div className="kpi-label">Net</div>
                      <div className="kpi-value" style={{ fontSize: 18 }}>{fmt(num(earthworks.net_volume))} <small>m³</small></div>
                    </div>
                  </div>
                  <p className="helper">{num(earthworks.net_volume) > 0 ? 'Import required' : 'Surplus to export'}.</p>
                </>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

// ===================== NEW PROJECT SCREEN =====================
function NewProjectScreen({ token, fetchProjects, setCurrentScreen }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [budget, setBudget] = useState('');
  const [location, setLocation] = useState('');
  const [timeline, setTimeline] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const handleCreate = async (e) => {
    e.preventDefault();
    setError(''); setBusy(true);
    try {
      await axios.post(`${API_URL}/api/projects`, {
        name, description, budget, location, timeline
      }, {
        headers: { Authorization: `Bearer ${token}` }
      });
      fetchProjects();
      setCurrentScreen('projects');
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div className="page-head-copy">
          <div className="eyebrow">Portfolio / new record</div>
          <h1 className="page-title">Create project</h1>
          <p className="page-sub">
            Set the commercial envelope and site identity first. Field evidence, quantities, progress
            and risk records attach to this project.
          </p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn" onClick={() => setCurrentScreen('projects')}>
            <Icon name="chevronLeft" size={13} /> Portfolio
          </button>
        </div>
      </div>

      {error && <div className="section-note" role="alert" style={{ color: 'var(--danger)', background: 'var(--danger-soft)', borderColor: '#ecc9c4' }}><Icon name="alert" size={13} /> {error}</div>}

      <div className="screen-grid">
        <form onSubmit={handleCreate} className="panel">
          <div className="panel-head">
            <div className="panel-head-copy"><h3>Project details</h3><p>Name and location are required.</p></div>
            <span className="panel-eyebrow">New</span>
          </div>
          <div className="panel-body">
            <div className="form-grid">
              <div className="field full">
                <label htmlFor="project-name">Project name</label>
                <input id="project-name" className="input" placeholder="e.g. Bole mixed-use development" value={name} onChange={(e) => setName(e.target.value)} required />
              </div>
              <div className="field full">
                <label htmlFor="project-description">Description</label>
                <textarea
                  id="project-description"
                  className="input"
                  style={{ height: 86, paddingTop: 9, resize: 'vertical' }}
                  placeholder="Scope, client and the decisions this record supports."
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="project-budget">Budget (ETB)</label>
                <input id="project-budget" className="input" type="number" min="0" step="0.01" placeholder="0.00" value={budget} onChange={(e) => setBudget(e.target.value)} required />
              </div>
              <div className="field">
                <label htmlFor="project-timeline">Timeline (months)</label>
                <input id="project-timeline" className="input" type="number" min="0" step="1" placeholder="e.g. 18" value={timeline} onChange={(e) => setTimeline(e.target.value)} />
              </div>
              <div className="field full">
                <label htmlFor="project-location">Location</label>
                <input id="project-location" className="input" placeholder="City, sub-city or site name" value={location} onChange={(e) => setLocation(e.target.value)} required />
              </div>
            </div>
            <div className="form-actions">
              <button type="submit" className="btn btn-primary" disabled={busy}>
                <Icon name="plus" size={13} /> {busy ? 'Creating…' : 'Create project'}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setCurrentScreen('projects')} disabled={busy}>
                Cancel
              </button>
            </div>
          </div>
        </form>

        <div className="stack">
          <section className="panel">
            <div className="panel-head">
              <div className="panel-head-copy"><h3>What happens next</h3><p>The record is ready for evidence.</p></div>
              <Icon name="sparkles" size={14} style={{ color: 'var(--copper)' }} />
            </div>
            <div className="panel-body">
              <div className="step-list">
                <div className="step-item">
                  <span className="step-number">01</span>
                  <div><strong>Import the take-off</strong><span>Components become the quantity survey and twin.</span></div>
                </div>
                <div className="step-item">
                  <span className="step-number">02</span>
                  <div><strong>Attach the site</strong><span>Survey control points and GIS layers locate the work.</span></div>
                </div>
                <div className="step-item">
                  <span className="step-number">03</span>
                  <div><strong>Record progress</strong><span>Spend and completion drive the commercial view.</span></div>
                </div>
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div className="panel-head-copy"><h3>Budget note</h3><p>Used for every cost comparison.</p></div>
              <Icon name="calculator" size={14} style={{ color: 'var(--ink-3)' }} />
            </div>
            <div className="panel-body">
              <p className="helper" style={{ marginTop: 0 }}>
                Enter the approved budget in ETB. The overview, progress screen and project record all
                compare spend against this figure; a project without one cannot show cost performance.
              </p>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
