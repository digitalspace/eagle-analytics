'use strict';

// Read once by src/config.js. Three is enough to see the bound; the real default is 2000.
process.env.SESSION_EVENT_CAP = '3';

const assert = require('node:assert');
const { test } = require('node:test');

const config = require('../src/config');
const { allow, MAX_SESSIONS, _reset } = require('../src/ingest/session-cap');
const { logger } = require('../src/utils/logger');

const HOUR_MS = 3600000;

/** Offer `times` events from one session, so a test body says what it wants and not how it counts. */
function offer(sessionId, times) {
  const answers = [];
  for (let i = 0; i < times; i += 1) answers.push(allow(sessionId));
  return answers;
}

test('a session is allowed up to its cap', (t) => {
  _reset();
  t.after(_reset);

  assert.deepStrictEqual(offer('session-a', 3), [true, true, true]);
});

test('the event after the cap is dropped', (t) => {
  _reset();
  t.after(_reset);

  assert.deepStrictEqual(offer('session-a', 4), [true, true, true, false]);
});

test('a session over its cap is reported once, not once per dropped event', (t) => {
  _reset();
  t.after(_reset);
  const warnings = [];
  t.mock.method(logger, 'warn', (message) => warnings.push(message));

  offer('session-a', 10);

  assert.strictEqual(warnings.length, 1);
  // analytics-drop-<env> and anyone reading the logs look for this prefix.
  assert.match(warnings[0], /^\[analytics\] session-cap: /);
});

test('the warning names no session id, because this workspace is read more widely', (t) => {
  _reset();
  t.after(_reset);
  const warnings = [];
  t.mock.method(logger, 'warn', (message) => warnings.push(message));

  offer('session-with-a-recognisable-id', 5);

  assert.doesNotMatch(warnings[0], /session-with-a-recognisable-id/);
});

test('one busy session does not spend another session budget', (t) => {
  _reset();
  t.after(_reset);

  offer('session-a', 5);

  assert.strictEqual(allow('session-b'), true);
});

test('the count starts again in the next hour', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-05T12:00:00Z') });
  _reset();
  t.after(_reset);

  assert.strictEqual(offer('session-a', 5).at(-1), false);

  t.mock.timers.tick(HOUR_MS);

  assert.strictEqual(allow('session-a'), true);
});

// A server-side producer sends no sessionId (src/ingest/validate.js). Pooling every such event under
// one empty key would throttle eagle-api and eagle-demi as if they shared a browser session; the
// per-address cap is what bounds them.
test('an event with no session is not counted against one', (t) => {
  _reset();
  t.after(_reset);

  assert.deepStrictEqual(offer('', 10).filter((answer) => answer === false), []);
});

test('a flood of made-up session ids stops at the map bound, and warns once', (t) => {
  _reset();
  t.after(_reset);
  const warnings = [];
  t.mock.method(logger, 'warn', (message) => warnings.push(message));

  for (let i = 0; i < MAX_SESSIONS; i += 1) assert.strictEqual(allow(`flood-${i}`), true);

  assert.strictEqual(allow('flood-one-too-many'), false);
  assert.strictEqual(allow('flood-and-another'), false);
  assert.strictEqual(warnings.length, 1);
  // A session already counted keeps its remaining budget: the bound refuses new ones only.
  assert.strictEqual(allow('flood-0'), true);
});

// config.js refuses a cap below 1, so this can only be reached by a caller setting it directly. The
// guard exists because reading the cap after counting the first event would admit one event per session.
test('a cap of zero admits nothing', (t) => {
  _reset();
  t.after(_reset);
  const cap = config.sessionEventCap;
  config.sessionEventCap = 0;
  t.after(() => { config.sessionEventCap = cap; });

  assert.strictEqual(allow('session-a'), false);
});
