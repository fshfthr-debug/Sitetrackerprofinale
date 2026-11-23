const test = require('node:test');
const assert = require('node:assert');
const { splitFrom } = require('../email');

// The reset email only ever leaves the server through a provider, so the pieces
// that decide where it goes are worth pinning down without a network.

test('splitFrom reads a display name and address', () => {
  assert.deepStrictEqual(splitFrom('SiteTrackerPro <no-reply@example.com>'), {
    name: 'SiteTrackerPro',
    email: 'no-reply@example.com'
  });
});

test('splitFrom passes a bare address through', () => {
  assert.deepStrictEqual(splitFrom('no-reply@example.com'), { email: 'no-reply@example.com' });
});
