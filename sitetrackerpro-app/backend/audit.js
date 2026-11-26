'use strict';

/**
 * Append-only audit trail for the whole installation.
 *
 * Why it exists: once more than one person has an account, "who deleted that dataset?"
 * and "who made him an admin?" have to be answerable from inside the app. A console log
 * answers neither - it is gone after a deploy, and on a host without a shell nobody can
 * read it at all.
 *
 * Two rules hold this together:
 *
 *   1. Recording never fails the action it describes. A missing table or a full disk must
 *      not stop somebody signing in or uploading: the failure is logged as a warning and
 *      the request continues. An audit trail that takes the product down with it gets
 *      switched off, and then there is no trail.
 *
 *   2. Nothing secret is stored. No passwords, no tokens, no file contents. Only what
 *      happened, to what, and by whom.
 *
 * The actor is stored twice on purpose: the foreign key for joins while the account exists,
 * and a snapshot of name/email/role so the history still reads correctly after a person is
 * renamed or removed. control_point_status_history already follows this rule.
 */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_SUMMARY = 500;
const MAX_DETAIL = 2000;
const MAX_TEXT = 300;

// One vocabulary for the whole app. The screen groups by the prefix ('auth.', 'upload.',
// 'delete.', 'user.'), so adding a new event needs no change in the browser.
const ACTIONS = {
  LOGIN: 'auth.login',
  LOGIN_FAILED: 'auth.login_failed',
  MFA_LOGIN: 'auth.mfa_login',
  MFA_ENABLED: 'auth.mfa_enabled',
  MFA_DISABLED: 'auth.mfa_disabled',
  USER_CREATED: 'user.created',
  ROLE_CHANGED: 'user.role_changed',
  UPLOAD_BIM: 'upload.bim',
  UPLOAD_GIS_DATASET: 'upload.gis_dataset',
  UPLOAD_SURVEY_POINTS: 'upload.survey_points',
  UPLOAD_CONTROL_POINTS: 'upload.control_points',
  DELETE_PROJECT: 'delete.project',
  DELETE_BIM_COMPONENTS: 'delete.bim_components',
  DELETE_GIS_DATASET: 'delete.gis_dataset',
  DELETE_GIS_QUERY: 'delete.gis_query',
  DELETE_ALIGNMENT_POINT: 'delete.alignment_point'
};

function clip(value, max) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

async function ensureAuditSchema(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS audit_events (
      id BIGSERIAL PRIMARY KEY,
      actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      actor_email VARCHAR(255),
      actor_name VARCHAR(255),
      actor_role VARCHAR(20),
      action VARCHAR(40) NOT NULL,
      outcome VARCHAR(12) NOT NULL DEFAULT 'success',
      target_type VARCHAR(30),
      target_id VARCHAR(120),
      project_id INTEGER,
      summary VARCHAR(500) NOT NULL,
      detail TEXT,
      ip VARCHAR(60),
      user_agent VARCHAR(300),
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // The screen always reads newest-first; the other two cover the two filters people
  // actually use (one person's history, one kind of event).
  await db.query('CREATE INDEX IF NOT EXISTS idx_audit_events_created ON audit_events(created_at DESC)');
  await db.query('CREATE INDEX IF NOT EXISTS idx_audit_events_actor ON audit_events(actor_id, created_at DESC)');
  await db.query('CREATE INDEX IF NOT EXISTS idx_audit_events_action ON audit_events(action, created_at DESC)');
}

/**
 * The address and browser of the request. Behind Render's proxy req.ip is the client once
 * TRUST_PROXY is set, which the deployment sets; the fallback is the socket address.
 */
function clientFacts(req) {
  if (!req) return { ip: null, userAgent: null };
  const socketAddress = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : null;
  const agent = typeof req.get === 'function' ? req.get('user-agent') : null;
  return {
    ip: clip(req.ip || socketAddress, 60),
    userAgent: clip(agent, 300)
  };
}

/**
 * Appends one event. Never throws: a failure is a warning in the log, not an error for the
 * person who was actually trying to sign in or upload something.
 */
async function record(db, event) {
  const options = event || {};
  const facts = options.req ? clientFacts(options.req) : { ip: options.ip || null, userAgent: options.userAgent || null };
  const actorId = Number.isInteger(options.actorId)
    ? options.actorId
    : (Number.isInteger(options.userId) ? options.userId : null);

  let detail = null;
  if (options.detail !== undefined && options.detail !== null) {
    try {
      detail = clip(JSON.stringify(options.detail), MAX_DETAIL);
    } catch (err) {
      detail = null;
    }
  }

  try {
    await db.query(
      `INSERT INTO audit_events
         (actor_id, actor_email, actor_name, actor_role, action, outcome,
          target_type, target_id, project_id, summary, detail, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        actorId,
        clip(options.actorEmail, 255),
        clip(options.actorName, 255),
        clip(options.actorRole, 20),
        clip(options.action, 40),
        clip(options.outcome || 'success', 12),
        clip(options.targetType, 30),
        clip(options.targetId === undefined || options.targetId === null ? null : String(options.targetId), 120),
        Number.isInteger(options.projectId) ? options.projectId : null,
        clip(options.summary || options.action || 'event', MAX_SUMMARY),
        detail,
        clip(facts.ip, 60),
        clip(facts.userAgent, 300)
      ]
    );
  } catch (err) {
    console.warn('audit: could not record "' + (options.action || 'event') + '":', err.message || err);
  }
}

function normaliseLimit(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

function normaliseOffset(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

function asDate(value) {
  if (!value) return null;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Builds the WHERE clause for a list request. `action` may be exact ('delete.project') or a
 * whole family ending in a dot ('upload.'), which is what the screen's group filter sends.
 */
function buildFilter({ action, actor, projectId, from, to }) {
  const conditions = [];
  const params = [];

  if (action) {
    const value = String(action).trim();
    if (value) {
      params.push(value.endsWith('.') ? value + '%' : value);
      conditions.push(value.endsWith('.')
        ? `action LIKE $${params.length}`
        : `action = $${params.length}`);
    }
  }

  if (actor) {
    const term = '%' + String(actor).trim() + '%';
    if (term !== '%%') {
      params.push(term);
      conditions.push(`(actor_email ILIKE $${params.length} OR actor_name ILIKE $${params.length})`);
    }
  }

  const project = Number.parseInt(projectId, 10);
  if (Number.isInteger(project) && project > 0) {
    params.push(project);
    conditions.push(`project_id = $${params.length}`);
  }

  const since = asDate(from);
  if (since) {
    params.push(since);
    conditions.push(`created_at >= $${params.length}`);
  }

  const until = asDate(to);
  if (until) {
    params.push(until);
    conditions.push(`created_at <= $${params.length}`);
  }

  return {
    where: conditions.length ? 'WHERE ' + conditions.join(' AND ') : '',
    params
  };
}

const SELECT_COLUMNS = `
  id, actor_id, actor_email, actor_name, actor_role, action, outcome,
  target_type, target_id, project_id, summary, detail, ip, user_agent, created_at
`;

function shape(row) {
  let detail = null;
  if (row.detail) {
    try {
      detail = JSON.parse(row.detail);
    } catch (err) {
      detail = null;
    }
  }
  return {
    id: Number(row.id),
    actorId: row.actor_id === null || row.actor_id === undefined ? null : Number(row.actor_id),
    actorEmail: row.actor_email,
    actorName: row.actor_name,
    actorRole: row.actor_role,
    action: row.action,
    outcome: row.outcome,
    targetType: row.target_type,
    targetId: row.target_id,
    projectId: row.project_id === null || row.project_id === undefined ? null : Number(row.project_id),
    summary: row.summary,
    detail,
    ip: row.ip,
    userAgent: row.user_agent,
    createdAt: row.created_at
  };
}

/**
 * One page of the trail, newest first, plus the total so the screen can say "50 of 312"
 * and know when to stop asking.
 */
async function listEvents(db, options = {}) {
  const limit = normaliseLimit(options.limit);
  const offset = normaliseOffset(options.offset);
  const { where, params } = buildFilter(options);

  const counted = await db.query(`SELECT COUNT(*)::int AS total FROM audit_events ${where}`, params);
  const total = counted.rows && counted.rows[0] ? Number(counted.rows[0].total) : 0;

  const pageParams = params.concat([limit, offset]);
  const result = await db.query(
    `SELECT ${SELECT_COLUMNS}
       FROM audit_events
       ${where}
       ORDER BY created_at DESC, id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    pageParams
  );

  return {
    events: (result.rows || []).map(shape),
    total,
    limit,
    offset,
    hasMore: offset + (result.rows || []).length < total
  };
}

module.exports = {
  ACTIONS,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_SUMMARY,
  MAX_TEXT,
  ensureAuditSchema,
  clientFacts,
  record,
  listEvents,
  buildFilter,
  normaliseLimit,
  normaliseOffset
};
