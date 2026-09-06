'use strict';

// Set before the writer (and the config it requires) is loaded: config reads the environment once.
process.env.EVENTS_DCR_ENDPOINT = 'https://dcr.example.invalid';
process.env.EVENTS_DCR_IMMUTABLE_ID = 'dcr-test';
process.env.ANALYTICS_MAX_BATCH = '3';

const assert = require('node:assert');
const { test } = require('node:test');

const { AggregateLogsUploadError } = require('@azure/monitor-ingestion');

const writer = require('../src/ingest/dcr-writer');
const { logger } = require('../src/utils/logger');

const { EVENTS_STREAM, AUDIT_STREAM } = writer;

function row(name) {
  return { TimeGenerated: new Date().toISOString(), EventName: name, Env: 'test' };
}

// The real SDK error, not a stand-in: its own .message is the literal "undefined\n}", which is the
// whole reason describeUploadError exists. Causes are RestError-shaped, as the SDK builds them.
function uploadError(...causes) {
  return new AggregateLogsUploadError(causes.map((cause) => ({ cause, failedLogs: [row('page_view')] })));
}

test('flush sends each buffer to the stream it was enqueued on', async (t) => {
  const sent = [];
  writer._setTransport(async (stream, rows) => { sent.push({ stream, rows }); });
  t.after(() => writer._resetTransport());

  writer.enqueue(EVENTS_STREAM, row('page_view'));
  writer.enqueue(EVENTS_STREAM, row('doc_download'));
  writer.enqueue(AUDIT_STREAM, row('project_updated'));

  await writer.flush();

  const events = sent.find((call) => call.stream === EVENTS_STREAM);
  const audit = sent.find((call) => call.stream === AUDIT_STREAM);
  assert.deepStrictEqual(events.rows.map((r) => r.EventName), ['page_view', 'doc_download']);
  assert.deepStrictEqual(audit.rows.map((r) => r.EventName), ['project_updated']);
});

test('enqueue flushes on its own once the count cap is reached', async (t) => {
  let resolveSent;
  const sent = new Promise((resolve) => { resolveSent = resolve; });
  writer._setTransport(async (stream, rows) => resolveSent(rows));
  t.after(() => writer._resetTransport());

  // ANALYTICS_MAX_BATCH is 3 above, so the third row must not wait for the flush timer.
  writer.enqueue(EVENTS_STREAM, row('a'));
  writer.enqueue(EVENTS_STREAM, row('b'));
  writer.enqueue(EVENTS_STREAM, row('c'));

  assert.strictEqual((await sent).length, 3);
});

test('a batch over the byte ceiling is split, keeping every row', () => {
  const rows = [row('one'), row('two'), row('three')];
  const oneRowBytes = Buffer.byteLength(JSON.stringify(rows[0])) + 1;

  const batched = writer._batches(rows, 100, oneRowBytes * 2 + 2);

  assert.deepStrictEqual(batched.map((batch) => batch.length), [2, 1]);
  assert.deepStrictEqual(
    batched.flat().map((r) => r.EventName),
    ['one', 'two', 'three']
  );
});

test('a batch the transport keeps rejecting is dropped after three attempts, and says so', async (t) => {
  let attempts = 0;
  writer._setTransport(async () => { attempts += 1; throw new Error('socket hang up'); });
  t.after(() => writer._resetTransport());
  const errors = [];
  t.mock.method(logger, 'error', (message) => errors.push(message));

  writer.enqueue(EVENTS_STREAM, row('page_view'));
  // Resolves rather than rejecting: a failed send must never reach the caller.
  await writer.flush();

  assert.strictEqual(attempts, 3);
  // analytics-drop-<env> alerts on this exact string; the row count tells an operator how much went.
  assert.match(errors[0], /^\[analytics\] dropped 1 row\(s\) for Custom-EagleEvents_CL/);
});

// enqueue starts a flush it does not await, so the shutdown hook's own flush has to wait for it. Its
// buffers are already empty by then, and without tracking it would report the worker safe to stop.
test('a flush waits for a send an earlier flush already started', async (t) => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const finished = [];
  writer._setTransport(async (stream, rows) => {
    await held;
    finished.push(rows.length);
  });
  t.after(() => writer._resetTransport());

  // ANALYTICS_MAX_BATCH is 3 above, so the third row starts that unawaited flush.
  writer.enqueue(EVENTS_STREAM, row('a'));
  writer.enqueue(EVENTS_STREAM, row('b'));
  writer.enqueue(EVENTS_STREAM, row('c'));

  let done = false;
  const shutdown = writer.flush().then(() => { done = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(done, false);

  release();
  await shutdown;
  assert.deepStrictEqual(finished, [3]);
});

test('a drop line carries the cause the SDK buries, not its own placeholder message', async (t) => {
  writer._setTransport(async () => {
    throw uploadError({ statusCode: 403, message: 'Operation returned an invalid status code Forbidden' });
  });
  t.after(() => writer._resetTransport());
  const errors = [];
  t.mock.method(logger, 'error', (message) => errors.push(message));

  writer.enqueue(EVENTS_STREAM, row('page_view'));
  await writer.flush();

  // AggregateLogsUploadError.message is `undefined\n}`; an operator needs the status and the text.
  assert.match(errors[0], /^\[analytics\] dropped 1 row\(s\) for Custom-EagleEvents_CL/);
  assert.match(errors[0], /403 Operation returned an invalid status code Forbidden/);
  assert.doesNotMatch(errors[0], /undefined/);
});

test('a 403 is dropped on the first attempt: a missing role assignment is not transient', async (t) => {
  let attempts = 0;
  writer._setTransport(async () => {
    attempts += 1;
    throw uploadError({ statusCode: 403, message: 'Forbidden' });
  });
  t.after(() => writer._resetTransport());
  t.mock.method(logger, 'error', () => {});

  writer.enqueue(EVENTS_STREAM, row('page_view'));
  await writer.flush();

  assert.strictEqual(attempts, 1);
});

test('a 503 keeps all three attempts', async (t) => {
  let attempts = 0;
  writer._setTransport(async () => {
    attempts += 1;
    throw uploadError({ statusCode: 503, message: 'Service Unavailable' });
  });
  t.after(() => writer._resetTransport());
  t.mock.method(logger, 'error', () => {});

  writer.enqueue(EVENTS_STREAM, row('page_view'));
  await writer.flush();

  assert.strictEqual(attempts, 3);
});

test('describeUploadError returns a plain error by its own message', () => {
  assert.strictEqual(writer.describeUploadError(new Error('socket hang up')), 'socket hang up');
});

test('describeUploadError collapses causes that repeat across a batch', () => {
  const described = writer.describeUploadError(uploadError(
    { statusCode: 403, message: 'Forbidden' },
    { statusCode: 403, message: 'Forbidden' },
    { statusCode: 429, message: 'Too many requests' }
  ));

  assert.strictEqual(described, '403 Forbidden; 429 Too many requests');
});

test('describeUploadError reports at most three distinct causes', () => {
  const described = writer.describeUploadError(uploadError(
    { statusCode: 400, message: 'one' },
    { statusCode: 400, message: 'two' },
    { statusCode: 400, message: 'three' },
    { statusCode: 400, message: 'four' }
  ));

  assert.strictEqual(described, '400 one; 400 two; 400 three');
});
