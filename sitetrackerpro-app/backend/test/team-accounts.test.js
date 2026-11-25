'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const { readMember, createMember, ROLES } = require('../team-accounts');

// The app's real policy, trimmed to the two rules that matter for these cases.
function policy(password, email) {
  const problems = [];
  if (!password) problems.push('A password is required.');
  else if (Array.from(password).length < 12) problems.push('Use at least 12 characters.');
  // Like the app: only addresses with a name long enough to be meaningful are checked.
  const emailName = String(email || '').split('@')[0].toLowerCase();
  if (emailName.length >= 4 && password && password.includes(emailName)) {
    problems.push('Do not use your email address inside the password.');
  }
  return problems;
}

function fakePool() {
  const writes = [];
  return {
    writes,
    async query(sql, params = []) {
      writes.push({ sql, params });
      return {
        rows: [{
          id: 7,
          email: params[0],
          full_name: params[2],
          company: params[3],
          role: params[4],
          created_at: new Date(0)
        }]
      };
    }
  };
}

test('reads a complete member into insert values', () => {
  const { problems, values } = readMember({
    email: '  Site.Engineer@Example.COM ',
    password: 'gravel-orbit-lantern-42',
    role: 'Analyst',
    fullName: ' Site Engineer ',
    company: ' '
  }, policy);

  assert.deepEqual(problems, []);
  assert.equal(values.email, 'site.engineer@example.com');
  assert.equal(values.role, 'analyst');
  assert.equal(values.fullName, 'Site Engineer');
  assert.equal(values.company, null);
});

test('the role defaults to viewer, never to something wider', () => {
  const { problems, values } = readMember({ email: 'a@b.co', password: 'gravel-orbit-lantern-42' }, policy);
  assert.deepEqual(problems, []);
  assert.equal(values.role, 'viewer');
});

test('rejects an unknown role instead of guessing', () => {
  const { problems, values } = readMember(
    { email: 'a@b.co', password: 'gravel-orbit-lantern-42', role: 'owner' },
    policy
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /Viewer, Analyst or Admin/);
  assert.equal(values.role, 'viewer');
});

test('reports every password problem the shared policy finds', () => {
  const { problems } = readMember({ email: 'engineer@example.com', password: 'engineer123456' }, policy);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /email address/);
});

test('requires a usable email address', () => {
  assert.match(readMember({ email: '', password: 'gravel-orbit-lantern-42' }, policy).problems[0], /Enter the email/);
  assert.match(readMember({ email: 'not-an-address', password: 'gravel-orbit-lantern-42' }, policy).problems[0], /look valid/);
});

test('refuses a name too long for the column', () => {
  const { problems } = readMember({
    email: 'a@b.co',
    password: 'gravel-orbit-lantern-42',
    fullName: 'x'.repeat(256)
  }, policy);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /255 characters or fewer/);
});

test('createMember hashes the password and returns no hash to the caller', async () => {
  const pool = fakePool();
  const hashes = [];
  const user = await createMember({
    pool,
    hash: password => { hashes.push(password); return Promise.resolve('$2a$10$stub'); },
    email: 'a@b.co',
    password: 'gravel-orbit-lantern-42',
    role: 'analyst',
    fullName: 'A Person',
    company: null
  });

  assert.deepEqual(hashes, ['gravel-orbit-lantern-42']);
  assert.equal(pool.writes.length, 1);
  assert.match(pool.writes[0].sql, /INSERT INTO users \(email, password, full_name, company, role\)/);
  assert.deepEqual(pool.writes[0].params, ['a@b.co', '$2a$10$stub', 'A Person', null, 'analyst']);
  assert.equal(user.id, 7);
  assert.equal(user.password, undefined);
});

test('a real bcrypt hash from createMember verifies with the login comparison', async () => {
  const pool = fakePool();
  await createMember({
    pool,
    hash: password => bcrypt.hash(password, 10),
    email: 'a@b.co',
    password: 'gravel-orbit-lantern-42',
    role: 'viewer'
  });

  // The hash is what lands in the password column, so the login route must accept it.
  const storedHash = pool.writes[0].params[1];
  assert.match(storedHash, /^\$2[aby]\$10\$/);
  assert.equal(bcrypt.compareSync('gravel-orbit-lantern-42', storedHash), true);
  assert.equal(bcrypt.compareSync('wrong-password-entirely', storedHash), false);
  assert.ok(ROLES.includes('viewer'));
});
