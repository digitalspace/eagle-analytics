'use strict';

// Read once by src/config.js. Three is enough to see the bound; the real default is 600.
process.env.IP_EVENT_CAP = '3';

const assert = require('node:assert');
const { test } = require('node:test');

const { allow, _reset } = require('../src/ingest/ip-cap');
const { logger } = require('../src/utils/logger');

const MINUTE_MS = 60000;
const ADDRESS = '198.51.100.7';

/** Offer `times` single-event requests from one address, so a body says what it wants, not how it counts. */
function offer(ip, times) {
  const answers = [];
  for (let i = 0; i < times; i += 1) answers.push(allow(ip, 1));
  return answers;
}

test('an address is allowed up to its cap', (t) => {
  _reset();
  t.after(_reset);

  assert.deepStrictEqual(offer(ADDRESS, 3), [true, true, true]);
});

test('the request after the cap is refused', (t) => {
  _reset();
  t.after(_reset);

  assert.deepStrictEqual(offer(ADDRESS, 4), [true, true, true, false]);
});

test('a batch is charged whole, so one that would cross the cap is refused', (t) => {
  _reset();
  t.after(_reset);

  assert.strictEqual(allow(ADDRESS, 2), true);
  assert.strictEqual(allow(ADDRESS, 2), false);
});

test('a refused batch is charged nothing, so a smaller one still fits', (t) => {
  _reset();
  t.after(_reset);

  allow(ADDRESS, 2);
  allow(ADDRESS, 2);

  assert.strictEqual(allow(ADDRESS, 1), true);
});

test('one busy address does not spend another address budget', (t) => {
  _reset();
  t.after(_reset);

  offer(ADDRESS, 5);

  assert.strictEqual(allow('203.0.113.9', 1), true);
});

// An unresolvable address is the cheapest one to arrange, so it is throttled rather than exempt: every
// caller behind a proxy that strips the header shares one bucket.
test('callers with no resolvable address share one throttled bucket', (t) => {
  _reset();
  t.after(_reset);

  assert.deepStrictEqual(offer('', 4), [true, true, true, false]);
});

test('an unresolved caller does not spend a resolved one budget', (t) => {
  _reset();
  t.after(_reset);

  offer('', 5);

  assert.strictEqual(allow(ADDRESS, 1), true);
});

test('an address over its cap is reported once, not once per refused request', (t) => {
  _reset();
  t.after(_reset);
  const warnings = [];
  t.mock.method(logger, 'warn', (message) => warnings.push(message));

  offer(ADDRESS, 10);

  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /^\[analytics\] ip-cap: /);
});

test('the warning names no address', (t) => {
  _reset();
  t.after(_reset);
  const warnings = [];
  t.mock.method(logger, 'warn', (message) => warnings.push(message));

  offer(ADDRESS, 5);

  assert.doesNotMatch(warnings[0], /198\.51\.100\.7/);
});

test('the count starts again in the next minute', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-05T12:00:00Z') });
  _reset();
  t.after(_reset);

  assert.strictEqual(offer(ADDRESS, 5).at(-1), false);

  t.mock.timers.tick(MINUTE_MS);

  assert.strictEqual(allow(ADDRESS, 1), true);
});
