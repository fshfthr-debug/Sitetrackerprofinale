#!/usr/bin/env node
'use strict';
/**
 * Account rescue from the server shell, for when the login page and the reset email are both
 * useless (the account is missing, or its password is unknown and mail does not arrive).
 *
 *   node scripts/account-tool.js list
 *   node scripts/account-tool.js password --email you@example.com
 *   node scripts/account-tool.js create --email you@example.com --role admin
 *
 * Passwords are read from stdin when --password is left out, so the shell history stays clean:
 *
 *   node scripts/account-tool.js password --email you@example.com
 *   (type the password, press Enter, then Ctrl-D)
 *
 * It uses the same database settings as the server (DATABASE_URL, or DB_USER/DB_PASSWORD/DB_HOST/
 * DB_PORT/DB_NAME and DB_SSL), so on Render it can be run from the service shell.
 */

require('dotenv').config();

const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const ROLES = ['viewer', 'analyst', 'admin'];
const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 72; // bcrypt truncates anything longer
const ROUNDS = 10;

const HELP = `Manage accounts from the server shell.

Usage: node scripts/account-tool.js <command> [options]

  list                                  List the accounts in this database.
  password --email <address>            Set a new password for an existing account.
  create   --email <address>            Create an account (fails if the address exists).

Options:
  --email <address>      The account's email address (case-insensitive).
  --password <value>     The new password. Omit it to type it on stdin instead.
  --role <role>          create only: viewer, analyst or admin (default admin).
  --name "<full name>"   create only: the account's name.

Environment: DATABASE_URL (or DB_USER/DB_PASSWORD/DB_HOST/DB_PORT/DB_NAME, DB_SSL).
`;

function createPool(env = process.env) {
  const databaseUrl = (env.DATABASE_URL || '').trim();
  const wantsSsl = env.DB_SSL === 'true' ||
    /[?&]sslmode=(require|verify-ca|verify-full)/i.test(databaseUrl);

  return new Pool({
    ...(databaseUrl
      ? { connectionString: databaseUrl }
      : {
          user: env.DB_USER,
          password: env.DB_PASSWORD,
          host: env.DB_HOST,
          port: env.DB_PORT,
          database: env.DB_NAME
        }),
    ssl: wantsSsl && env.DB_SSL !== 'false' ? { rejectUnauthorized: false } : undefined
  });
}

/** The same policy the app applies: long enough, not the email, within bcrypt's limit. */
function checkPassword(password, email) {
  const value = typeof password === 'string' ? password : '';
  if (!value) return 'Choose a password.';
  if (value.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (value.length > MAX_PASSWORD_LENGTH) return `Use ${MAX_PASSWORD_LENGTH} characters or fewer.`;
  if (email && value.trim().toLowerCase() === String(email).trim().toLowerCase()) {
    return 'The password cannot be the account\'s email address.';
  }
  return null;
}

function cleanEmail(value) {
  return String(value || '').trim().toLowerCase();
}

async function listAccounts(pool) {
  const { rows } = await pool.query(
    'SELECT id, email, full_name, role, created_at FROM users ORDER BY id'
  );
  return rows;
}

/**
 * Sets a new password and retires outstanding reset links, so a link mailed before the rescue
 * cannot be used afterwards. Returns the account id.
 */
async function setAccountPassword({ pool, email, password, hash = bcrypt.hash }) {
  const address = cleanEmail(email);
  if (!address) throw new Error('--email is required.');

  const found = await pool.query('SELECT id FROM users WHERE LOWER(email) = $1', [address]);
  if (found.rows.length === 0) {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS total FROM users');
    const total = rows[0] ? rows[0].total : 0;
    throw new Error(
      `No account uses ${address}. This database holds ${total} account(s)` +
      (total === 0
        ? ' — it is probably not the database the accounts live in. Check DATABASE_URL.'
        : '. Use `create` to make one.')
    );
  }

  const problem = checkPassword(password, address);
  if (problem) throw new Error(problem);

  const hashed = await hash(password, ROUNDS);
  const id = found.rows[0].id;
  await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hashed, id]);
  await pool.query(
    'UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND used_at IS NULL',
    [id]
  );
  return id;
}

async function createAccount({ pool, email, password, role = 'admin', fullName = '', hash = bcrypt.hash }) {
  const address = cleanEmail(email);
  if (!address) throw new Error('--email is required.');
  if (!ROLES.includes(role)) throw new Error(`--role must be one of ${ROLES.join(', ')}.`);

  const existing = await pool.query('SELECT id FROM users WHERE LOWER(email) = $1', [address]);
  if (existing.rows.length > 0) {
    throw new Error(`${address} already has an account (id ${existing.rows[0].id}). Use \`password\` instead.`);
  }

  const problem = checkPassword(password, address);
  if (problem) throw new Error(problem);

  const hashed = await hash(password, ROUNDS);
  const { rows } = await pool.query(
    `INSERT INTO users (email, password, full_name, role)
     VALUES ($1, $2, $3, $4)
     RETURNING id, email, role`,
    [address, hashed, String(fullName || '').trim() || null, role]
  );
  return rows[0];
}

function parseArgs(argv) {
  const options = { command: null, email: '', password: null, role: 'admin', name: '', help: false };
  const rest = [...argv];
  while (rest.length > 0) {
    const arg = rest.shift();
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--email') options.email = rest.shift() || '';
    else if (arg === '--password') options.password = rest.shift() || '';
    else if (arg === '--role') options.role = rest.shift() || '';
    else if (arg === '--name') options.name = rest.shift() || '';
    else if (arg.startsWith('--')) throw new Error(`Unknown option "${arg}".`);
    else if (!options.command) options.command = arg;
    else throw new Error(`Unexpected argument "${arg}".`);
  }
  return options;
}

/** Reads the password from stdin when it was not given as a flag. */
function readStdinPassword(stream = process.stdin) {
  return new Promise((resolve, reject) => {
    let data = '';
    stream.setEncoding('utf8');
    stream.on('data', chunk => { data += chunk; });
    stream.on('error', reject);
    stream.on('end', () => resolve(data.split('\n')[0].replace(/\r$/, '')));
  });
}

async function main(argv = process.argv.slice(2), { stdin = process.stdin, out = console.log, pool: provided } = {}) {
  const options = parseArgs(argv);
  if (options.help || !options.command) {
    out(HELP);
    return options.help ? 0 : 1;
  }

  const pool = provided || createPool();
  try {
    if (options.command === 'list') {
      const accounts = await listAccounts(pool);
      if (accounts.length === 0) {
        out('0 accounts in the database this service uses.');
        out('Check that DATABASE_URL points at the database the accounts were created in.');
        return 1;
      }
      out(`${accounts.length} account(s) in the database this service uses:`);
      for (const row of accounts) {
        out(`  #${row.id}  ${row.email}  ${String(row.role || 'viewer').padEnd(7)}  ${row.created_at ? new Date(row.created_at).toISOString().slice(0, 10) : '?'}`);
      }
      return 0;
    }

    if (options.command === 'password') {
      const password = options.password ?? await readStdinPassword(stdin);
      const id = await setAccountPassword({ pool, email: options.email, password });
      out(`Password updated for ${cleanEmail(options.email)} (id ${id}). Any outstanding reset links are retired.`);
      out('Sign in with the new password.');
      return 0;
    }

    if (options.command === 'create') {
      const password = options.password ?? await readStdinPassword(stdin);
      const account = await createAccount({
        pool, email: options.email, password, role: options.role, fullName: options.name
      });
      out(`Created ${account.role} account ${account.email} (id ${account.id}).`);
      return 0;
    }

    out(`Unknown command "${options.command}".\n`);
    out(HELP);
    return 1;
  } finally {
    // A pool handed in by a test belongs to the caller.
    if (!provided) await pool.end().catch(() => {});
  }
}

if (require.main === module) {
  main().then(
    code => { process.exitCode = code; },
    err => {
      console.error(err.message);
      process.exitCode = 1;
    }
  );
}

module.exports = {
  ROLES,
  MIN_PASSWORD_LENGTH,
  checkPassword,
  cleanEmail,
  listAccounts,
  setAccountPassword,
  createAccount,
  parseArgs,
  readStdinPassword,
  main
};
