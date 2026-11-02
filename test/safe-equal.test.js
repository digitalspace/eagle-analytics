'use strict';

const assert = require('node:assert');
const { test } = require('node:test');

// No config: this is the comparison the header guards are built on, not a guard itself.
const { safeEqual } = require('../src/auth/safe-equal');

const EXPECTED = 'gateway-value-for-tests';

function answerOf(presented, expected) {
  let answer;
  assert.doesNotThrow(() => { answer = safeEqual(presented, expected); });
  return answer;
}

test('the same value matches', () => {
  assert.strictEqual(safeEqual(EXPECTED, EXPECTED), true);
});

test('the same value in another case does not match', () => {
  assert.strictEqual(safeEqual(EXPECTED.toUpperCase(), EXPECTED), false);
});

// Both sides are hashed first: timingSafeEqual throws on unequal lengths, and that throw is a length
// oracle for the real credential.
test('a value with a trailing space answers false rather than throwing', () => {
  assert.strictEqual(answerOf(`${EXPECTED} `, EXPECTED), false);
});

// A guard calls this with whatever req.header() returned, which is undefined when the header is
// absent. Hashing that throws, and a throw out of a guard is a 500 where a 401 belongs.
test('an absent header does not match and does not throw', () => {
  assert.strictEqual(answerOf(undefined, EXPECTED), false);
});

test('a Buffer holding the right string does not match', () => {
  assert.strictEqual(answerOf(Buffer.from(EXPECTED), EXPECTED), false);
});

// No credential configured means no way in: without this, an environment that forgot the setting
// would admit every request that sends the header empty.
test('an empty header does not match an empty expectation', () => {
  assert.strictEqual(answerOf('', ''), false);
});

// The guard in src/auth/safe-equal.js answers false for a non-string expectation instead of
// throwing; a throw out of a guard is a 500 where a 401 belongs.
test('an undefined expectation matches nothing and does not throw', () => {
  assert.strictEqual(answerOf(EXPECTED, undefined), false);
});
