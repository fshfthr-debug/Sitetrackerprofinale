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
