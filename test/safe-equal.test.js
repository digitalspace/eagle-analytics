'use strict';

const assert = require('node:assert');
const { test } = require('node:test');

// No config: this is the comparison the header guards are built on, not a guard itself.
const { safeEqual } = require('../src/auth/safe-equal');

const EXPECTED = 'gateway-value-for-tests';

test('the same value matches', () => {
  assert.strictEqual(safeEqual(EXPECTED, EXPECTED), true);
});

test('a different value of the same length does not match', () => {
  const other = `${EXPECTED.slice(0, -1)}X`;
  assert.strictEqual(other.length, EXPECTED.length);
  assert.strictEqual(safeEqual(other, EXPECTED), false);
});

test('a value differing only in case does not match', () => {
  assert.strictEqual(safeEqual(EXPECTED.toUpperCase(), EXPECTED), false);
});

test('trailing whitespace does not match', () => {
  assert.strictEqual(safeEqual(`${EXPECTED} `, EXPECTED), false);
});

// Both sides are hashed before the comparison because crypto.timingSafeEqual throws on buffers of
// unequal length, and that throw is itself a length oracle: it tells a caller how long the real
// credential is. Two lengths, either side of the expected one.
for (const [label, presented] of [
  ['a shorter value', EXPECTED.slice(0, 4)],
  ['a longer value', `${EXPECTED}-and-then-some-more`],
  ['a single character', 'x'],
  ['an empty value', '']
]) {
  test(`${label} answers false rather than throwing`, () => {
    let answer;
    assert.doesNotThrow(() => { answer = safeEqual(presented, EXPECTED); });
    assert.strictEqual(answer, false);
  });
}

// A guard calls this with whatever req.header() returned, which is undefined when the header is
// absent. Hashing that throws, and a throw out of a guard is a 500 where a 401 belongs.
for (const [label, presented] of [
  ['undefined', undefined],
  ['null', null],
  ['a number', 1234],
  ['an object', {}],
  ['an array of the right string', [EXPECTED]],
  ['a Buffer of the right string', Buffer.from(EXPECTED)]
]) {
  test(`${label} presented does not match and does not throw`, () => {
    let answer;
    assert.doesNotThrow(() => { answer = safeEqual(presented, EXPECTED); });
    assert.strictEqual(answer, false);
  });
}

// No credential configured means no way in: without this, an environment that forgot the setting
// would admit every request that sends the header empty, or none at all.
for (const [label, expected] of [
  ['empty', ''],
  ['undefined', undefined],
  ['null', null]
]) {
  test(`nothing matches an expectation that is ${label}`, () => {
    let answers;
    assert.doesNotThrow(() => {
      answers = [safeEqual('', expected), safeEqual(EXPECTED, expected), safeEqual(undefined, expected)];
    });
    assert.deepStrictEqual(answers, [false, false, false]);
  });
}
