/**
 * The password rules, shared by the account commands.
 *
 * These mirror validatePassword() in sitetrackerpro-app/backend/backend-v3-enhanced.js.
 * They are duplicated here on purpose: importing the backend module would start an
 * HTTP server as a side effect. If the app's rules change, change them here too —
 * a password accepted here but refused at the login screen is exactly the trap
 * this avoids.
 */
const crypto = require('crypto');

const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_BYTES = 72;

const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', 'password1234', 'passw0rd', 'p@ssw0rd',
  '123456789012', '1234567890123', '12345678910', 'qwertyuiopas', 'qwerty123456',
  'administrator', 'letmein12345', 'welcome123456', 'changeme1234', 'iloveyou1234',
  'sitetrackerpro', 'construction', 'construction1', 'abyssinia1234'
]);

// Unambiguous alphabet: no O/0, l/1/I, so a password read out over the phone survives.
const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#%^&*-_=+';

/** Returns a list of readable problems; empty means the app will accept it. */
function validatePassword(password, email) {
  const problems = [];
  const characters = Array.from(String(password || ''));

  if (characters.length < PASSWORD_MIN_LENGTH) problems.push(`Use at least ${PASSWORD_MIN_LENGTH} characters.`);
  if (Buffer.byteLength(String(password || ''), 'utf8') > PASSWORD_MAX_BYTES) problems.push(`Keep it under ${PASSWORD_MAX_BYTES} characters.`);
  if (password !== String(password).trim()) problems.push('Remove spaces from the start or end.');
  if (COMMON_PASSWORDS.has(String(password).toLowerCase())) problems.push('That password is too common.');
  if (new Set(characters).size < 4) problems.push('Use a mix of characters, not one repeated pattern.');

  const localPart = String(email || '').split('@')[0].toLowerCase();
  if (localPart.length >= 4 && String(password).toLowerCase().includes(localPart)) {
    problems.push('Do not use the email address inside the password.');
  }

  return problems;
}

function generatePassword(length = 18) {
  const bytes = crypto.randomBytes(length * 2);
  let password = '';
  for (let index = 0; password.length < length; index += 1) {
    const byte = bytes[index % bytes.length];
    if (byte < 256 - (256 % ALPHABET.length)) password += ALPHABET[byte % ALPHABET.length];
  }
  return password;
}

module.exports = {
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_BYTES,
  COMMON_PASSWORDS,
  validatePassword,
  generatePassword
};
