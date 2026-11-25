'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const totp = require('../totp');

// RFC 6238 appendix B, SHA-1: the shared secret is the ASCII string 12345678901234567890.
// The RFC prints eight digits; the app shows six, which is the same value with two fewer.
const RFC_SECRET = totp.base32Encode(Buffer.from('12345678901234567890', 'ascii'));

/** Returns the six-digit code the standard prints for a given unix time. */
function codeAtSeconds(seconds) {
  return totp.codeForCounter(RFC_SECRET, Math.floor(seconds / 30), 6);
}

test('matches the published RFC 6238 test vectors', () => {
  assert.equal(RFC_SECRET, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(codeAtSeconds(59), '287082');
  assert.equal(codeAtSeconds(1111111109), '081804');
  assert.equal(codeAtSeconds(1111111111), '050471');
  assert.equal(codeAtSeconds(1234567890), '005924');
  assert.equal(codeAtSeconds(2000000000), '279037');
  assert.equal(codeAtSeconds(20000000000), '353130');
});

test('base32 survives a round trip', () => {
  for (const length of [1, 5, 10, 20, 32]) {
    const bytes = Buffer.from(Array.from({ length }, (_, i) => (i * 37) % 256));
    assert.deepEqual(totp.base32Decode(totp.base32Encode(bytes)), bytes);
  }
});

test('generateSecret produces a usable 160-bit key', () => {
  const secret = totp.generateSecret();
  assert.match(secret, /^[A-Z2-7]{32}$/);
  assert.notEqual(secret, totp.generateSecret());
  assert.equal(totp.base32Decode(secret).length, 20);
});

test('verifyCode accepts the current step and one step either side', () => {
  const at = 1700000000000;
  const current = totp.generateCode(RFC_SECRET, at);

  assert.equal(totp.verifyCode(RFC_SECRET, current, { atMs: at }), true);
  assert.equal(totp.verifyCode(RFC_SECRET, current, { atMs: at + 30 * 1000 }), true);
  assert.equal(totp.verifyCode(RFC_SECRET, current, { atMs: at - 30 * 1000 }), true);
  assert.equal(totp.verifyCode(RFC_SECRET, current, { atMs: at + 120 * 1000 }), false);
});

test('verifyCode ignores spaces and dashes, and rejects anything else', () => {
  const at = 1700000000000;
  const current = totp.generateCode(RFC_SECRET, at);
  const spaced = current.slice(0, 3) + ' ' + current.slice(3);

  assert.equal(totp.verifyCode(RFC_SECRET, spaced, { atMs: at }), true);
  assert.equal(totp.verifyCode(RFC_SECRET, '', { atMs: at }), false);
  assert.equal(totp.verifyCode(RFC_SECRET, '12345', { atMs: at }), false);
  assert.equal(totp.verifyCode(RFC_SECRET, 'abcdef', { atMs: at }), false);
  assert.equal(totp.normaliseCode('12-34 56'), '123456');
});

test('a malformed stored secret is a non-match, not an exception', () => {
  assert.equal(totp.verifyCode('not base32 !!', '123456'), false);
  assert.equal(totp.verifyCode('', '123456'), false);
});

test('the otpauth URL carries the key, issuer and algorithm an app expects', () => {
  const url = new URL(totp.otpauthUrl({ secret: RFC_SECRET, label: 'me@example.com' }));

  assert.equal(url.protocol, 'otpauth:');
  assert.equal(url.host, 'totp');
  assert.equal(decodeURIComponent(url.pathname), '/SiteTrackerPro:me@example.com');
  assert.equal(url.searchParams.get('secret'), RFC_SECRET);
  assert.equal(url.searchParams.get('issuer'), 'SiteTrackerPro');
  assert.equal(url.searchParams.get('algorithm'), 'SHA1');
  assert.equal(url.searchParams.get('digits'), '6');
  assert.equal(url.searchParams.get('period'), '30');
});

test('recovery codes are readable, unique and hash the same however they are typed', () => {
  const codes = totp.generateRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  for (const code of codes) assert.match(code, /^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/);

  const typed = codes[0].toUpperCase().replace(/-/g, ' ');
  assert.equal(totp.hashRecoveryCode(typed), totp.hashRecoveryCode(codes[0]));
  assert.notEqual(totp.hashRecoveryCode(codes[1]), totp.hashRecoveryCode(codes[0]));
  assert.equal(totp.normaliseRecoveryCode('AB CD-EF'), 'abcdef');
});
