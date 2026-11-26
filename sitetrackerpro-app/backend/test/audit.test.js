'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const audit = require('../audit');

function fakeDb({ total = 0, rows = [], failOn = null } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (failOn && failOn.test(sql)) throw new Error('database is down');
      if (/COUNT\(\*\)::int AS total/.test(sql)) return { rows: [{ total }] };
      if (/FROM audit_events/.test(sql)) return { rows };
      return { rows: [], rowCount: 1 };
    }
  };
}

test('the table and the indexes the screen reads with are created', async () => {
  const db = fakeDb();
  await audit.ensureAuditSchema(db);

  assert.equal(db.calls.length, 4);
  assert.match(db.calls[0].sql, /CREATE TABLE IF NOT EXISTS audit_events/);
  // The snapshot columns are what make the history readable after an account is deleted.
  for (const column of ['actor_id', 'actor_email', 'actor_name', 'actor_role', 'action', 'summary', 'detail', 'ip', 'user_agent']) {
    assert.match(db.calls[0].sql, new RegExp(column));
  }
  const indexSql = db.calls.slice(1).map(call => call.sql).join(' ');
  assert.match(indexSql, /idx_audit_events_created/);
  assert.match(indexSql, /idx_audit_events_actor/);
  assert.match(indexSql, /idx_audit_events_action/);
});

test('an event keeps the actor snapshot, the target and the address', async () => {
  const db = fakeDb();
  await audit.record(db, {
    action: audit.ACTIONS.ROLE_CHANGED,
    userId: 7,
    actorEmail: 'boss@example.com',
    actorName: 'Boss',
    actorRole: 'admin',
    targetType: 'user',
    targetId: 9,
    projectId: undefined,
    summary: 'Changed ali@example.com from viewer to analyst',
    detail: { from: 'viewer', to: 'analyst' },
    req: {
      ip: '203.0.113.10',
      get: () => 'Mozilla/5.0 (test)'
    }
  });

  const insert = db.calls.find(call => /INSERT INTO audit_events/.test(call.sql));
  assert.ok(insert, 'an insert was issued');
  const [actorId, email, name, role, action, outcome, targetType, targetId, projectId, summary, detail, ip, userAgent] = insert.params;

  assert.equal(actorId, 7);
  assert.equal(email, 'boss@example.com');
  assert.equal(name, 'Boss');
  assert.equal(role, 'admin');
  assert.equal(action, 'user.role_changed');
  assert.equal(outcome, 'success');
  assert.equal(targetType, 'user');
  assert.equal(targetId, '9');
  assert.equal(projectId, null);
  assert.match(summary, /viewer to analyst/);
  assert.deepEqual(JSON.parse(detail), { from: 'viewer', to: 'analyst' });
  assert.equal(ip, '203.0.113.10');
  assert.equal(userAgent, 'Mozilla/5.0 (test)');
});

test('a failing audit insert never fails the action it describes', async () => {
  const db = fakeDb({ failOn: /INSERT INTO audit_events/ });
  await assert.doesNotReject(() => audit.record(db, {
    action: audit.ACTIONS.LOGIN,
    userId: 1,
    summary: 'Signed in'
  }));
});

test('text is clipped to the column widths instead of failing the insert', async () => {
  const db = fakeDb();
  await audit.record(db, {
    action: audit.ACTIONS.UPLOAD_BIM,
    summary: 'x'.repeat(900),
    detail: { note: 'y'.repeat(5000) },
    req: { ip: '1.2.3.4', get: () => 'z'.repeat(900) }
  });

  const insert = db.calls.find(call => /INSERT INTO audit_events/.test(call.sql));
  const params = insert.params;
  assert.ok(params[9].length <= 500, 'summary is clipped to the column');
  assert.ok(params[10].length <= 2000, 'detail is clipped');
  assert.ok(params[12].length <= 300, 'user agent is clipped');
});

test('nothing from the request body can reach the row', async () => {
  const db = fakeDb();
  await audit.record(db, {
    action: audit.ACTIONS.LOGIN_FAILED,
    outcome: 'failure',
    actorEmail: 'someone@example.com',
    summary: 'Wrong password',
    req: {
      ip: '198.51.100.7',
      get: () => 'curl',
      body: { email: 'someone@example.com', password: 'hunter2-should-not-be-stored' }
    }
  });

  const insert = db.calls.find(call => /INSERT INTO audit_events/.test(call.sql));
  assert.equal(insert.params.some(value => typeof value === 'string' && value.includes('hunter2')), false);
});

test('a group filter becomes a prefix, a person a search, and dates a range', () => {
  const group = audit.buildFilter({ action: 'upload.' });
  assert.match(group.where, /action LIKE \$1/);
  assert.deepEqual(group.params, ['upload.%']);

  const exact = audit.buildFilter({ action: 'delete.project' });
  assert.match(exact.where, /action = \$1/);
  assert.deepEqual(exact.params, ['delete.project']);

  const person = audit.buildFilter({ actor: 'ali' });
  assert.match(person.where, /actor_email ILIKE \$1 OR actor_name ILIKE \$1/);
  assert.deepEqual(person.params, ['%ali%']);

  const range = audit.buildFilter({ from: '2026-11-01', to: '2026-11-30T23:59:59' });
  assert.match(range.where, /created_at >= \$1 AND created_at <= \$2/);
  assert.equal(range.params.length, 2);

  assert.equal(audit.buildFilter({}).where, '');
});

test('a page comes back with the total and whether more exist', async () => {
  const row = {
    id: '41',
    actor_id: 3,
    actor_email: 'ali@example.com',
    actor_name: 'Ali',
    actor_role: 'analyst',
    action: 'upload.bim',
    outcome: 'success',
    target_type: 'bim_model',
    target_id: '18',
    project_id: 5,
    summary: 'Uploaded takeoff.csv — 120 take-off row(s) imported',
    detail: JSON.stringify({ imported: 120 }),
    ip: '203.0.113.10',
    user_agent: 'Mozilla/5.0',
    created_at: '2026-11-26T10:00:00.000Z'
  };
  const db = fakeDb({ total: 312, rows: [row] });

  const page = await audit.listEvents(db, { limit: '1000', offset: '0' });

  assert.equal(page.total, 312);
  assert.equal(page.limit, audit.MAX_LIMIT, 'the page size is capped');
  assert.equal(page.hasMore, true);
  assert.equal(page.events.length, 1);
  assert.equal(page.events[0].id, 41);
  assert.equal(page.events[0].projectId, 5);
  assert.equal(page.events[0].actorEmail, 'ali@example.com');
  assert.deepEqual(page.events[0].detail, { imported: 120 });

  const select = db.calls.find(call => /ORDER BY created_at DESC/.test(call.sql));
  assert.match(select.sql, /LIMIT \$1 OFFSET \$2/);
  assert.deepEqual(select.params, [audit.MAX_LIMIT, 0]);
});

test('the CSV export reads the screen\'s filters and holds every row, not a page', async () => {
  const db = fakeDb({ rows: [{ id: 1, action: 'auth.login', summary: 'Signed in', created_at: '2026-11-26T10:00:00.000Z' }] });
  const result = await audit.exportEvents(db, { action: 'auth.', from: '2026-11-01' });

  const select = db.calls[db.calls.length - 1];
  assert.match(select.sql, /action LIKE \$1/);
  assert.match(select.sql, /created_at >= \$2/);
  assert.match(select.sql, /LIMIT \$3/);
  assert.equal(select.params[0], 'auth.%');
  assert.equal(select.params[2], audit.EXPORT_LIMIT);
  assert.equal(result.events.length, 1);
  assert.equal(result.truncated, false);
});

test('the CSV opens cleanly in a spreadsheet: header row, CRLF, readable labels', () => {
  const csv = audit.toCsv([{
    id: 4,
    createdAt: '2026-11-26T10:00:00.000Z',
    action: 'user.role_changed',
    outcome: 'success',
    actorName: 'Boss',
    actorEmail: 'boss@example.com',
    actorRole: 'admin',
    summary: 'Changed ali@example.com from viewer to analyst',
    projectId: 5,
    targetType: 'user',
    targetId: '9',
    ip: '203.0.113.10',
    userAgent: 'Mozilla/5.0',
    detail: { from: 'viewer', to: 'analyst' }
  }]);

  const lines = csv.split('\r\n').filter(Boolean);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^When \(UTC\),Event,Outcome,Who,Email,Role,What happened,Project,Target,IP address,Browser,Detail$/);
  assert.match(lines[1], /^2026-11-26T10:00:00\.000Z,Role changed,success,Boss,boss@example\.com,admin,Changed ali@example\.com from viewer to analyst,Project 5,user 9,203\.0\.113\.10,Mozilla\/5\.0,/);
  // The nested detail keeps its own quotes escaped rather than breaking the row apart.
  assert.match(lines[1], /"\{""from"":""viewer"",""to"":""analyst""\}"$/);
  assert.equal(audit.exportFilename(new Date('2026-11-26T10:00:00Z')), 'sitetrackerpro-audit-2026-11-26.csv');
});

test('an empty trail still produces a readable file, and a formula cannot run', () => {
  const headerOnly = audit.toCsv([]).split('\r\n').filter(Boolean);
  assert.equal(headerOnly.length, 1);
  assert.match(headerOnly[0], /^When \(UTC\)/);

  const formula = audit.csvCell('=HYPERLINK("http://example.com")');
  assert.match(formula, /^"'=HYPERLINK/);
  assert.match(formula, /""http:\/\/example\.com""/);
  assert.match(formula, /"$/);
  assert.equal(audit.csvCell('ali, bob'), '"ali, bob"');
  assert.equal(audit.csvCell('plain'), 'plain');
  assert.equal(audit.csvCell(null), '');
});

test('a broken offset falls back to the first page, and the last page says so', async () => {
  assert.equal(audit.normaliseOffset('-20'), 0);
  assert.equal(audit.normaliseOffset('nonsense'), 0);
  assert.equal(audit.normaliseLimit('0'), audit.DEFAULT_LIMIT);

  const db = fakeDb({ total: 1, rows: [{ id: 1, action: 'auth.login', summary: 'Signed in', created_at: '2026-11-26T10:00:00.000Z' }] });
  const page = await audit.listEvents(db, {});
  assert.equal(page.hasMore, false);
  assert.equal(page.events[0].detail, null);
  assert.equal(page.events[0].actorId, null);
});

// ======================= RETENTION =======================
// The trail is append-only apart from the daily purge. These tests pin the window, the batch
// walk and the opt-out, because a mistake here deletes a client's history for good.

function purgeDb({ batches = [], fail = null } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (fail) throw fail;
      return { rows: [], rowCount: batches.length ? batches.shift() : 0 };
    }
  };
}

test('the retention window defaults to two years, is floored, and 0 turns it off', () => {
  assert.equal(audit.retentionDays({}), audit.DEFAULT_RETENTION_DAYS);
  assert.equal(audit.retentionDays({ AUDIT_RETENTION_DAYS: '365' }), 365);
  assert.equal(audit.retentionDays({ AUDIT_RETENTION_DAYS: '0' }), 0);
  assert.equal(audit.retentionDays({ AUDIT_RETENTION_DAYS: '' }), audit.DEFAULT_RETENTION_DAYS);
  assert.equal(audit.retentionDays({ AUDIT_RETENTION_DAYS: 'nonsense' }), audit.DEFAULT_RETENTION_DAYS);
  assert.equal(audit.retentionDays({ AUDIT_RETENTION_DAYS: '-5' }), audit.DEFAULT_RETENTION_DAYS);
  // A window of a few days would let a typo erase this month's work.
  assert.equal(audit.retentionDays({ AUDIT_RETENTION_DAYS: '3' }), audit.MIN_RETENTION_DAYS);
});

test('expired entries are deleted in batches, and only those older than the window', async () => {
  const db = purgeDb({ batches: [audit.PURGE_BATCH_SIZE, 120] });
  const now = new Date('2026-11-26T00:00:00.000Z');
  const result = await audit.purgeExpired(db, { days: 730, now });

  assert.equal(result.deleted, audit.PURGE_BATCH_SIZE + 120);
  assert.equal(result.cutoff.toISOString(), '2024-11-26T00:00:00.000Z');
  assert.equal(db.calls.length, 2, 'a short batch ends the walk');
  for (const call of db.calls) {
    assert.match(call.sql, /^DELETE FROM audit_events/);
    assert.match(call.sql, /WHERE created_at < \$1/);
    assert.match(call.sql, /LIMIT \$2/);
    assert.deepEqual(call.params, [result.cutoff, audit.PURGE_BATCH_SIZE]);
  }
});

test('retention off keeps the trail and touches no rows', async () => {
  const db = purgeDb();
  const result = await audit.purgeExpired(db, { days: 0 });
  assert.deepEqual(result, { deleted: 0, cutoff: null });
  assert.equal(db.calls.length, 0);
});

test('an empty expired range costs one query, and a short table one batch', async () => {
  const db = purgeDb({ batches: [7] });
  const result = await audit.purgeExpired(db, { days: 30, now: new Date('2026-11-26T00:00:00.000Z') });
  assert.equal(result.deleted, 7);
  assert.equal(db.calls.length, 1);
});
