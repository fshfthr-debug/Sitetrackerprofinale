'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const mfa = require('../mfa');
const totp = require('../totp');

function fakePool({ user = { id: 1, email: 'boss@example.com', role: 'admin', totp_secret: null, totp_enabled: false }, rowCount = 1, remaining = 0, hasUsers = true } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });

      if (/to_regclass/.test(sql)) return { rows: [{ oid: hasUsers ? 'users' : null }] };
      if (/SELECT id, email, role, totp_secret, totp_enabled FROM users/.test(sql)) {
        return { rows: user ? [user] : [] };
      }
      if (/COUNT\(\*\)::int AS remaining/.test(sql)) return { rows: [{ remaining }] };
      return { rows: [], rowCount };
    }
  };
}

test('administrators must use a second factor by default', () => {
  assert.equal(mfa.mfaRequiredFor('admin', {}), true);
  assert.equal(mfa.mfaRequiredFor('analyst', {}), false);
  assert.equal(mfa.mfaRequiredFor('viewer', {}), false);
});

test('the required roles are configurable, and "none" turns the rule off', () => {
  assert.equal(mfa.mfaRequiredFor('analyst', { MFA_REQUIRED_ROLES: 'admin, analyst' }), true);
  assert.equal(mfa.mfaRequiredFor('admin', { MFA_REQUIRED_ROLES: 'admin, analyst' }), true);
  assert.equal(mfa.mfaRequiredFor('admin', { MFA_REQUIRED_ROLES: 'none' }), false);
  assert.equal(mfa.mfaRequiredFor('admin', { MFA_REQUIRED_ROLES: '' }), false);
});

test('MFA_DISABLED is a break-glass switch that waives the rule', () => {
  assert.equal(mfa.disabledByEnv({}), false);
  assert.equal(mfa.disabledByEnv({ MFA_DISABLED: 'true' }), true);
  assert.equal(mfa.disabledByEnv({ MFA_DISABLED: '1' }), true);
  assert.equal(mfa.disabledByEnv({ MFA_DISABLED: 'no' }), false);
  assert.equal(mfa.mfaRequiredFor('admin', { MFA_DISABLED: 'true' }), false);
  assert.equal(mfa.mfaRequiredFor('admin', { MFA_DISABLED: 'true', MFA_REQUIRED_ROLES: 'admin' }), false);
});

test('getState reports the secret and whether it is switched on', async () => {
  const pool = fakePool({ user: { id: 4, email: 'a@b.co', role: 'admin', totp_secret: 'GEZDGNBV', totp_enabled: true } });
  const state = await mfa.getState(pool, 4);

  assert.deepEqual(state, { id: 4, email: 'a@b.co', role: 'admin', secret: 'GEZDGNBV', enabled: true });
  assert.deepEqual(pool.calls[0].params, [4]);

  assert.equal(await mfa.getState(fakePool({ user: null }), 9), null);
});

test('enrolment stores the secret without switching two-factor on', async () => {
  const pool = fakePool();
  await mfa.startEnrollment(pool, 4, 'NEWSECRET');

  assert.match(pool.calls[0].sql, /SET totp_secret = \$1, totp_enabled = FALSE/);
  assert.deepEqual(pool.calls[0].params, ['NEWSECRET', 4]);
});

test('enabling replaces any earlier recovery codes', async () => {
  const pool = fakePool();
  const hashes = ['hash-a', 'hash-b'];
  await mfa.enableTotp(pool, 4, hashes);

  const deletes = pool.calls.filter(call => /DELETE FROM mfa_recovery_codes/.test(call.sql));
  const inserts = pool.calls.filter(call => /INSERT INTO mfa_recovery_codes/.test(call.sql));

  assert.equal(deletes.length, 1);
  assert.equal(inserts.length, 2);
  assert.deepEqual(pool.calls[0].params, [4]);
  assert.match(pool.calls[0].sql, /totp_enabled = TRUE/);
});

test('a recovery code is spent once, and only when it matches', async () => {
  const pool = fakePool({ rowCount: 1 });
  const spent = await mfa.consumeRecoveryCode(pool, 4, 'abcd-ef12-3456');

  assert.equal(spent, true);
  assert.match(pool.calls[0].sql, /used_at IS NULL/);
  assert.deepEqual(pool.calls[0].params, [4, totp.hashRecoveryCode('abcd-ef12-3456')]);

  const miss = await mfa.consumeRecoveryCode(fakePool({ rowCount: 0 }), 4, 'abcd-ef12-3456');
  assert.equal(miss, false);

  // Too short to be a code: refused before it reaches the database.
  const tooShort = await mfa.consumeRecoveryCode(fakePool({ rowCount: 1 }), 4, 'ab');
  assert.equal(tooShort, false);
});

test('recoveryCodesLeft counts only unspent codes', async () => {
  assert.equal(await mfa.recoveryCodesLeft(fakePool({ remaining: 7 }), 4), 7);
});

test('ensureMfaSchema adds the columns and table, and does nothing without a users table', async () => {
  const pool = fakePool();
  assert.equal(await mfa.ensureMfaSchema(pool), true);

  const sql = pool.calls.map(call => call.sql).join('\n');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS totp_secret/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS totp_enabled/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS mfa_recovery_codes/);

  const empty = fakePool({ hasUsers: false });
  assert.equal(await mfa.ensureMfaSchema(empty), false);
  assert.equal(empty.calls.length, 1);
});
