'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { Readable } = require('node:stream');

const {
  checkPassword,
  setAccountPassword,
  createAccount,
  listAccounts,
  parseArgs,
  main
} = require('../scripts/account-tool');

// ---------------------------------------------------------------------------
// A pool that answers the four queries the tool issues, and records writes.
// ---------------------------------------------------------------------------
function fakePool({ users = [], insertRow } = {}) {
  const writes = [];
  return {
    writes,
    async query(sql, params = []) {
      if (/^\s*SELECT id, email, full_name, role, created_at/i.test(sql)) return { rows: users };
      if (/^\s*SELECT id FROM users WHERE LOWER\(email\)/i.test(sql)) {
        const match = users.find(u => u.email.toLowerCase() === String(params[0]).toLowerCase());
        return { rows: match ? [{ id: match.id }] : [] };
      }
      if (/COUNT\(\*\)/i.test(sql)) return { rows: [{ total: users.length }] };
      if (/^\s*UPDATE users SET password/i.test(sql)) {
        writes.push({ sql, params });
        return { rowCount: 1, rows: [] };
      }
      if (/^\s*UPDATE password_reset_tokens/i.test(sql)) {
        writes.push({ sql, params });
        return { rowCount: 1, rows: [] };
      }
      if (/^\s*INSERT INTO users/i.test(sql)) {
        writes.push({ sql, params });
        return { rows: [insertRow || { id: 9, email: params[0], role: params[3] }] };
      }
      throw new Error(`Unexpected query in test: ${sql}`);
    }
  };
}

const EMAIL = 'surveyor@example.com';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('the password policy matches the app: length, not the email, within bcrypt limits', () => {
  assert.match(checkPassword('short', EMAIL), /at least 12/);
  assert.match(checkPassword('', EMAIL), /Choose a password/);
  assert.match(checkPassword(EMAIL, EMAIL), /cannot be the account's email/);
  assert.match(checkPassword('a'.repeat(73), EMAIL), /72 characters or fewer/);
  assert.equal(checkPassword('a-long-enough-passphrase', EMAIL), null);
});

test('setting a password stores a bcrypt hash the login route would accept', async () => {
  const pool = fakePool({ users: [{ id: 4, email: EMAIL }] });

  const id = await setAccountPassword({ pool, email: 'Surveyor@Example.com ', password: 'a-long-enough-passphrase' });

  assert.equal(id, 4);
  const passwordWrite = pool.writes.find(w => /UPDATE users SET password/i.test(w.sql));
  assert.ok(passwordWrite, 'the password row is updated');
  assert.equal(passwordWrite.params[1], 4);
  assert.notEqual(passwordWrite.params[0], 'a-long-enough-passphrase', 'the password is not stored in clear');
  assert.equal(bcrypt.compareSync('a-long-enough-passphrase', passwordWrite.params[0]), true);
});

test('setting a password retires outstanding reset links', async () => {
  const pool = fakePool({ users: [{ id: 4, email: EMAIL }] });

  await setAccountPassword({ pool, email: EMAIL, password: 'a-long-enough-passphrase' });

  const retire = pool.writes.find(w => /UPDATE password_reset_tokens/i.test(w.sql));
  assert.ok(retire, 'reset tokens are marked used');
  assert.deepEqual(retire.params, [4]);
});

test('an unknown email on an empty database points at DATABASE_URL', async () => {
  const pool = fakePool({ users: [] });

  await assert.rejects(
    () => setAccountPassword({ pool, email: EMAIL, password: 'a-long-enough-passphrase' }),
    /No account uses surveyor@example\.com.*holds 0 account\(s\).*DATABASE_URL/s
  );
});

test('an unknown email among existing accounts suggests create instead', async () => {
  const pool = fakePool({ users: [{ id: 1, email: 'someone@example.com' }] });

  await assert.rejects(
    () => setAccountPassword({ pool, email: EMAIL, password: 'a-long-enough-passphrase' }),
    /holds 1 account\(s\).*Use `create`/s
  );
});

test('a password that fails the policy is refused before anything is written', async () => {
  const pool = fakePool({ users: [{ id: 4, email: EMAIL }] });

  await assert.rejects(
    () => setAccountPassword({ pool, email: EMAIL, password: 'short' }),
    /at least 12/
  );
  assert.equal(pool.writes.length, 0);
});

test('create inserts an admin account by default and refuses a duplicate', async () => {
  const pool = fakePool({ users: [] });
  const account = await createAccount({ pool, email: 'new@example.com', password: 'a-long-enough-passphrase' });

  assert.equal(account.email, 'new@example.com');
  const insert = pool.writes.find(w => /INSERT INTO users/i.test(w.sql));
  assert.deepEqual(insert.params, ['new@example.com', insert.params[1], null, 'admin']);
  assert.equal(bcrypt.compareSync('a-long-enough-passphrase', insert.params[1]), true);

  const taken = fakePool({ users: [{ id: 3, email: EMAIL }] });
  await assert.rejects(
    () => createAccount({ pool: taken, email: EMAIL, password: 'a-long-enough-passphrase' }),
    /already has an account \(id 3\)/
  );
});

test('create refuses a role outside viewer/analyst/admin', async () => {
  const pool = fakePool({ users: [] });
  await assert.rejects(
    () => createAccount({ pool, email: 'new@example.com', password: 'a-long-enough-passphrase', role: 'owner' }),
    /--role must be one of/
  );
});

test('list returns the accounts without password hashes', async () => {
  const rows = await listAccounts(fakePool({ users: [{ id: 1, email: EMAIL, role: 'admin' }] }));
  assert.deepEqual(rows, [{ id: 1, email: EMAIL, role: 'admin' }]);
});

test('arguments are parsed for the three commands', () => {
  assert.deepEqual(
    parseArgs(['password', '--email', 'a@b.c']),
    { command: 'password', email: 'a@b.c', password: null, role: 'admin', name: '', help: false }
  );
  assert.equal(parseArgs(['create', '--email', 'a@b.c', '--role', 'analyst', '--name', 'A B']).role, 'analyst');
  assert.throws(() => parseArgs(['--nope']), /Unknown option/);
});

test('the password can arrive on stdin instead of the command line', async () => {
  const pool = fakePool({ users: [{ id: 4, email: EMAIL }] });
  const captured = [];
  const stdin = Readable.from(['a-long-enough-passphrase\n']);

  const code = await main(['password', '--email', EMAIL], { stdin, out: line => captured.push(line), pool });

  assert.equal(code, 0);
  const passwordWrite = pool.writes.find(w => /UPDATE users SET password/i.test(w.sql));
  assert.ok(passwordWrite, 'the stdin password reached the database');
  assert.equal(bcrypt.compareSync('a-long-enough-passphrase', passwordWrite.params[0]), true);
  assert.match(captured.join('\n'), /Password updated for surveyor@example\.com/);
});

test('list with no accounts explains the likely cause', async () => {
  const captured = [];
  const code = await main(['list'], { out: line => captured.push(line), pool: fakePool({ users: [] }) });

  assert.equal(code, 1);
  assert.match(captured.join('\n'), /0 accounts.*DATABASE_URL/s);
});

test('a bad command prints the usage instead of guessing', async () => {
  const captured = [];
  const code = await main(['frobnicate'], { out: line => captured.push(line), pool: fakePool({ users: [] }) });

  assert.equal(code, 1);
  assert.match(captured.join('\n'), /Unknown command "frobnicate"/);
});
