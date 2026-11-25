'use strict';
/**
 * Two-factor state and recovery codes.
 *
 * The secret and the enabled flag live on the users row; recovery codes live in their own
 * table, stored only as SHA-256 hashes, because they are passwords in disguise.
 *
 * Enforcement is a policy, not a fact about an account: MFA_REQUIRED_ROLES lists the roles
 * that must have a second factor (default: admin). Setting it to "none" turns the rule off,
 * which is the way back in if the phone that held the only authenticator is lost.
 */

const totp = require('./totp');

const DEFAULT_REQUIRED_ROLES = 'admin';

/** Adds the columns and table older databases predate. Safe to run on every boot. */
async function ensureMfaSchema(pool) {
  const usersTable = await pool.query("SELECT to_regclass('public.users') AS oid");
  if (!usersTable.rows[0].oid) return false;

  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret VARCHAR(64)');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT FALSE');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled_at TIMESTAMP');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash VARCHAR(64) NOT NULL,
      used_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (user_id, code_hash)
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_mfa_recovery_user ON mfa_recovery_codes(user_id)');
  return true;
}

function requiredRoles(env = process.env) {
  const raw = env.MFA_REQUIRED_ROLES === undefined ? DEFAULT_REQUIRED_ROLES : env.MFA_REQUIRED_ROLES;
  return String(raw)
    .split(',')
    .map(role => role.trim().toLowerCase())
    .filter(role => role && role !== 'none');
}

/**
 * A break-glass switch: MFA_DISABLED=true makes sign-in ignore the second factor entirely.
 * It exists because an administrator who loses both the phone and the recovery codes would
 * otherwise need database access to get back in, and the environment is the one thing they can
 * always change. Whoever can set this can also read DATABASE_URL, so it grants nothing new.
 */
function disabledByEnv(env = process.env) {
  return ['1', 'true', 'yes', 'on'].includes(String(env.MFA_DISABLED || '').trim().toLowerCase());
}

/** Does this role have to use a second factor? */
function mfaRequiredFor(role, env = process.env) {
  if (disabledByEnv(env)) return false;
  return requiredRoles(env).includes(String(role || '').toLowerCase());
}

async function getState(pool, userId) {
  const { rows } = await pool.query(
    'SELECT id, email, role, totp_secret, totp_enabled FROM users WHERE id = $1',
    [userId]
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    secret: row.totp_secret || null,
    enabled: Boolean(row.totp_enabled)
  };
}

/** Stores a secret without switching two-factor on: the next code has to prove it works. */
async function startEnrollment(pool, userId, secret) {
  await pool.query(
    'UPDATE users SET totp_secret = $1, totp_enabled = FALSE, totp_enabled_at = NULL WHERE id = $2',
    [secret, userId]
  );
}

/**
 * Switches two-factor on and replaces the recovery codes, so codes from an earlier enrolment
 * (or a re-enrolment) cannot be reused.
 */
async function enableTotp(pool, userId, codeHashes = []) {
  await pool.query(
    'UPDATE users SET totp_enabled = TRUE, totp_enabled_at = CURRENT_TIMESTAMP WHERE id = $1',
    [userId]
  );
  await pool.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [userId]);
  for (const hash of codeHashes) {
    await pool.query(
      'INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [userId, hash]
    );
  }
}

async function disableTotp(pool, userId) {
  await pool.query(
    'UPDATE users SET totp_secret = NULL, totp_enabled = FALSE, totp_enabled_at = NULL WHERE id = $1',
    [userId]
  );
  await pool.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [userId]);
}

/** Uses up a recovery code. Returns false for a wrong one or one already spent. */
async function consumeRecoveryCode(pool, userId, code) {
  const normalised = totp.normaliseRecoveryCode(code);
  if (normalised.length < 8) return false;

  const { rowCount } = await pool.query(
    `UPDATE mfa_recovery_codes
        SET used_at = CURRENT_TIMESTAMP
      WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL`,
    [userId, totp.hashRecoveryCode(normalised)]
  );
  return rowCount > 0;
}

async function recoveryCodesLeft(pool, userId) {
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS remaining FROM mfa_recovery_codes WHERE user_id = $1 AND used_at IS NULL',
    [userId]
  );
  return rows[0] ? rows[0].remaining : 0;
}

module.exports = {
  DEFAULT_REQUIRED_ROLES,
  ensureMfaSchema,
  requiredRoles,
  disabledByEnv,
  mfaRequiredFor,
  getState,
  startEnrollment,
  enableTotp,
  disableTotp,
  consumeRecoveryCode,
  recoveryCodesLeft
};
