'use strict';

process.env.ANALYTICS_WORKSPACE_CUSTOMER_ID = 'e1d4a0b2-test-workspace';
// Set before src/config.js loads, so the writer is live rather than inert: the case below is about a
// row NOT being written, and an off writer would pass it either way.
process.env.EVENTS_DCR_ENDPOINT = 'https://dcr.example.invalid';
process.env.EVENTS_DCR_IMMUTABLE_ID = 'dcr-test';

const assert = require('node:assert');
const { test, beforeEach, afterEach } = require('node:test');

const helper = require('./helpers/staff-token');
const runner = require('../src/query/run');
const writer = require('../src/ingest/dcr-writer');
const { makeRes } = require('../src/http/router');
const controller = require('../src/controllers/query');
const { logger } = require('../src/utils/logger');

const RANGE = { from: '2026-08-29T00:00:00.000Z', to: '2026-09-05T00:00:00.000Z' };
const BODY = { measure: 'events', bin: 'day', range: RANGE };

/** One row back from the workspace, so a 200 has something to carry. */
function oneRow() {
  return {
    status: 'Success',
    tables: [{ columnDescriptors: [{ name: 't' }, { name: 'value' }], rows: [[new Date('2026-09-01T00:00:00Z'), 5]] }]
  };
}

beforeEach(() => runner._setRunner(async () => oneRow()));

afterEach(() => runner._resetRunner());

/**
 * `user` is what src/auth/keycloak.js staffGuard leaves on the request. The route table runs that
 * guard before any handler here; test/staff-routes.test.js covers that wiring, and
 * test/keycloak.test.js covers what the guard admits.
 */
function staffRequest(roles, extra = {}) {
  return { ...helper.request({ body: BODY, ...extra }), user: { sub: 'test-sub', username: 'jdoe@idir', roles } };
}

async function statusOf(handler, req) {
  const res = makeRes('test-request');
  try {
    await handler(req, res);
    return res.statusCode;
  } catch (err) {
    return err.status;
  }
}

test('a staff request gets rows and no query text', async () => {
  const res = makeRes('test-request');

  await controller.query(staffRequest(['staff']), res);

  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(res.body), { rows: [{ t: '2026-09-01T00:00:00.000Z', value: 5 }] });
});

test('debug=1 returns the compiled query to a sysadmin', async () => {
  const res = makeRes('test-request');

  await controller.query(staffRequest(['sysadmin'], { query: { debug: '1' } }), res);

  assert.strictEqual(JSON.parse(res.body).kql, [
    'EagleEvents_CL',
    '| summarize value = count() by t = bin(TimeGenerated, 1d)',
    '| order by t asc',
    '| limit 1000'
  ].join('\n'));
});

test('debug=1 gives a non-sysadmin staff member rows only', async () => {
  const res = makeRes('test-request');

  await controller.query(staffRequest(['staff'], { query: { debug: '1' } }), res);

  assert.deepStrictEqual(Object.keys(JSON.parse(res.body)), ['rows']);
});

test('a body the whitelist rejects never reaches the workspace', async () => {
  let called = false;
  runner._setRunner(async () => { called = true; return oneRow(); });
  const req = staffRequest(['staff']);
  req.body = { measure: 'events', groupBy: ['DROP TABLE'], range: RANGE };

  assert.strictEqual(await statusOf(controller.query, req), 400);
  assert.strictEqual(called, false);
});

test('the schema route returns the whitelist the builder needs', async () => {
  const res = makeRes('test-request');

  controller.schema(staffRequest(['staff']), res);

  const body = JSON.parse(res.body);
  assert.deepStrictEqual(body.measures.map((measure) => measure.name),
    ['events', 'sessions', 'users', 'p95Duration', 'errors']);
  assert.deepStrictEqual(body.filterOps, ['eq', 'in', 'contains']);
  assert.deepStrictEqual(body.dimensions.find((one) => one.name === 'Referrer').sources, ['raw']);
  assert.deepStrictEqual(body.dimensions.find((one) => one.name === 'Page').ops, ['eq', 'in', 'contains']);
});

// Reads are not audited: a chart is not a staff action, and one dashboard screen would write hundreds
// of rows into the table that exists to answer "who changed what". docs/EVENT-SCHEMA.md says so too.
test('a query writes no audit row', async (t) => {
  const sent = [];
  writer._setTransport(async (stream, rows) => { sent.push({ stream, rows }); });
  t.after(async () => {
    await writer.flush();
    writer._resetTransport();
  });

  await controller.query(staffRequest(['staff']), makeRes('test-request'));
  await writer.flush();

  assert.deepStrictEqual(sent, []);
});

test('the log line names the query by its summary, not by its text', async (t) => {
  const lines = [];
  t.mock.method(logger, 'info', (message) => lines.push(message));

  await controller.query(staffRequest(['staff']), makeRes('test-request'));

  const line = lines.find((one) => one.includes('jdoe@idir'));
  assert.match(line, /q=[0-9a-f]{8} measure=events source=raw bin=day dims=none/);
  assert.doesNotMatch(line, /EagleEvents_CL/);
});
