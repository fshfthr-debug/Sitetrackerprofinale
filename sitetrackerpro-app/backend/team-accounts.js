'use strict';
/**
 * Accounts created from the Team screen, so an administrator never has to open public
 * registration (or a shell) to add a colleague.
 *
 * The administrator supplies the address, the role and a temporary password; the person
 * signs in with it and changes it in Account. Validation lives here rather than in the route
 * so the rules can be tested without a running server.
 */

const ROLES = ['viewer', 'analyst', 'admin'];
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TEXT_MAX = 255; // users.full_name and users.company are VARCHAR(255)

/** Trims an optional text field, recording a problem when it cannot be stored. */
function optionalText(value, label, problems) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > TEXT_MAX) {
    problems.push(label + ' must be ' + TEXT_MAX + ' characters or fewer.');
    return null;
  }
  return text;
}

/**
 * Reads the request body into insert values, or into a list of readable problems.
 * validatePassword is passed in so sign-up, reset and this form share one policy.
 */
function readMember(body = {}, validatePassword = () => []) {
  const problems = [];

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email) {
    problems.push('Enter the email address they will sign in with.');
  } else if (!EMAIL_PATTERN.test(email)) {
    problems.push('That email address does not look valid.');
  }

  const role = String(body.role || 'viewer').trim().toLowerCase();
  if (!ROLES.includes(role)) problems.push('Choose Viewer, Analyst or Admin.');

  const password = typeof body.password === 'string' ? body.password : '';
  if (email) problems.push(...validatePassword(password, email));

  const fullName = optionalText(body.fullName, 'The name', problems);
  const company = optionalText(body.company, 'The company', problems);

  return {
    problems,
    values: {
      email,
      password,
      role: ROLES.includes(role) ? role : 'viewer',
      fullName,
      company
    }
  };
}

/**
 * Inserts the account and returns the row the interface needs (never the hash).
 * A duplicate address surfaces as a unique violation, which the route turns into a 409.
 */
async function createMember({ pool, hash, email, password, role = 'viewer', fullName = null, company = null }) {
  if (!ROLES.includes(role)) throw new Error('Choose Viewer, Analyst or Admin.');

  const hashed = await hash(password);
  const { rows } = await pool.query(
    `INSERT INTO users (email, password, full_name, company, role)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, email, full_name, company, role, created_at`,
    [email, hashed, fullName, company, role]
  );
  return rows[0];
}

module.exports = { ROLES, EMAIL_PATTERN, readMember, createMember };
