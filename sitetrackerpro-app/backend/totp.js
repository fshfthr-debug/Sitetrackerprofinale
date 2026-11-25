'use strict';
/**
 * Time-based one-time passwords (RFC 6238), the 6-digit codes an authenticator app shows.
 *
 * Written here rather than pulled in as a dependency: it is a hundred lines of HMAC and
 * base32, and the app already ships its own crypto-adjacent code (password reset tokens).
 */

const crypto = require('crypto');

// RFC 4648 base32, the alphabet authenticator apps expect.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;
const SECRET_BYTES = 20; // 160 bits, what Google Authenticator recommends

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let out = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text) {
  const clean = String(text || '').toUpperCase().replace(/\s+/g, '').replace(/=+$/, '');
  if (!clean) throw new Error('Empty base32 value.');

  let bits = 0;
  let value = 0;
  const bytes = [];

  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new Error('Invalid base32 character: ' + char);
    value = ((value << 5) | index) & 0xffffffff;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function generateSecret(bytes = SECRET_BYTES) {
  return base32Encode(crypto.randomBytes(bytes));
}

/** The code for one 30-second counter, so tests can pin it to a known time. */
function codeForCounter(secret, counter, digits = DIGITS) {
  const key = base32Decode(secret);
  const message = Buffer.alloc(8);
  let remaining = counter;
  for (let i = 7; i >= 0; i -= 1) {
    message[i] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }

  const digest = crypto.createHmac('sha1', key).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(binary % (10 ** digits)).padStart(digits, '0');
}

function counterAt(atMs = Date.now()) {
  return Math.floor(atMs / 1000 / STEP_SECONDS);
}

function generateCode(secret, atMs = Date.now(), digits = DIGITS) {
  return codeForCounter(secret, counterAt(atMs), digits);
}

/** Accepts the code typed with spaces or dashes; anything else is not a code. */
function normaliseCode(code) {
  return String(code || '').replace(/[^0-9]/g, '');
}

/**
 * True when the code matches the current step, the one before or the one after. The window
 * absorbs a phone clock that is a few seconds off, without widening it enough to be useful
 * for guessing.
 */
function verifyCode(secret, code, { atMs = Date.now(), window = 1, digits = DIGITS } = {}) {
  const entered = normaliseCode(code);
  if (entered.length !== digits) return false;

  // A malformed stored secret must read as 'no match', never as an exception.
  try {
    base32Decode(secret);
  } catch (err) {
    return false;
  }

  const counter = counterAt(atMs);
  const given = Buffer.from(entered);
  for (let offset = -window; offset <= window; offset += 1) {
    const expected = Buffer.from(codeForCounter(secret, counter + offset, digits));
    if (expected.length === given.length && crypto.timingSafeEqual(expected, given)) return true;
  }
  return false;
}

function otpauthUrl({ secret, label, issuer = 'SiteTrackerPro', digits = DIGITS }) {
  const name = encodeURIComponent(issuer) + ':' + encodeURIComponent(label);
  const query = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(digits),
    period: String(STEP_SECONDS)
  });
  return 'otpauth://totp/' + name + '?' + query.toString();
}

/** Ten single-use codes, shown once when two-factor is switched on. */
function generateRecoveryCodes(count = 10) {
  const codes = [];
  for (let i = 0; i < count; i += 1) {
    const raw = crypto.randomBytes(6).toString('hex');
    codes.push(raw.slice(0, 4) + '-' + raw.slice(4, 8) + '-' + raw.slice(8, 12));
  }
  return codes;
}

function normaliseRecoveryCode(code) {
  return String(code || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function hashRecoveryCode(code) {
  return crypto.createHash('sha256').update(normaliseRecoveryCode(code)).digest('hex');
}

module.exports = {
  ALPHABET,
  STEP_SECONDS,
  DIGITS,
  base32Encode,
  base32Decode,
  generateSecret,
  codeForCounter,
  counterAt,
  generateCode,
  normaliseCode,
  verifyCode,
  otpauthUrl,
  generateRecoveryCodes,
  normaliseRecoveryCode,
  hashRecoveryCode
};
