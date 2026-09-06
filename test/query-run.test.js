'use strict';

const assert = require('node:assert');
const { test, beforeEach, afterEach } = require('node:test');

const runner = require('../src/query/run');
const { logger } = require('../src/utils/logger');

/** What src/query/compile-kql.js hands the runner in place of the query text. */
const SUMMARY = 'q=1a2b3c4d measure=events source=raw bin=day dims=SourceApp';

const TIMESPAN = '2026-08-29T00:00:00.000Z/2026-09-05T00:00:00.000Z';

function table(columns, rows) {
  return {
    status: 'Success',
    tables: [{ name: 'PrimaryResult', columnDescriptors: columns.map((name) => ({ name })), rows }]
  };
}

beforeEach(() => { process.env.ANALYTICS_WORKSPACE_CUSTOMER_ID = 'e1d4a0b2-test-workspace'; });
afterEach(() => runner._resetRunner());

async function statusOf(kql = 'EagleEvents_CL') {
  try {
    await runner.run(kql, TIMESPAN);
    return 200;
  } catch (err) {
    return err.status;
  }
}

test('a result table becomes one object per row, with t as an ISO string and value numeric', async () => {
  runner._setRunner(async () => table(
    ['t', 'SourceApp', 'value'],
    [[new Date('2026-09-01T00:00:00Z'), 'eagle-public', 412], [new Date('2026-09-02T00:00:00Z'), 'eagle-admin', 7]]
  ));

  const rows = await runner.run('EagleEvents_CL', TIMESPAN);

  assert.deepStrictEqual(rows, [
    { t: '2026-09-01T00:00:00.000Z', SourceApp: 'eagle-public', value: 412 },
    { t: '2026-09-02T00:00:00.000Z', SourceApp: 'eagle-admin', value: 7 }
  ]);
});

test('an unbinned result carries no t', async () => {
  runner._setRunner(async () => table(['Page', 'value'], [['/projects', 12]]));

  assert.deepStrictEqual(await runner.run('EagleEvents_CL', TIMESPAN), [{ Page: '/projects', value: 12 }]);
});

test('a null aggregate reads as zero rather than null', async () => {
  runner._setRunner(async () => table(['Page', 'value'], [['/projects', null]]));

  const [row] = await runner.run('EagleEvents_CL', TIMESPAN);

  assert.strictEqual(row.value, 0);
});

test('the compiled query and the timespan are what gets executed', async () => {
  const seen = [];
  runner._setRunner(async (kql, timespan) => {
    seen.push({ kql, timespan });
    return table(['value'], [[1]]);
  });

  await runner.run('EagleEvents_CL | summarize value = count()', TIMESPAN);

  assert.deepStrictEqual(seen, [{ kql: 'EagleEvents_CL | summarize value = count()', timespan: TIMESPAN }]);
});

test('an empty result is an empty list, not an error', async () => {
  runner._setRunner(async () => ({ status: 'Success', tables: [] }));

  assert.deepStrictEqual(await runner.run('EagleEvents_CL', TIMESPAN), []);
});

test('a partial failure still returns the rows it produced', async () => {
  runner._setRunner(async () => ({
    status: 'PartialFailure',
    partialError: new Error('query exceeded its data limit'),
    partialTables: [{ columnDescriptors: [{ name: 'value' }], rows: [[3]] }]
  }));

  assert.deepStrictEqual(await runner.run('EagleEvents_CL', TIMESPAN), [{ value: 3 }]);
});

test('a rejected query is a bad gateway, not a server error', async () => {
  runner._setRunner(async () => ({ status: 'Failure', partialError: new Error('SEM0100: syntax error') }));

  assert.strictEqual(await statusOf(), 502);
});

test('a transport failure is a bad gateway', async () => {
  runner._setRunner(async () => { throw new Error('ETIMEDOUT'); });

  assert.strictEqual(await statusOf(), 502);
});

test('an unconfigured workspace answers unavailable rather than calling Azure', async () => {
  process.env.ANALYTICS_WORKSPACE_CUSTOMER_ID = '';
  let called = false;
  runner._setRunner(async () => { called = true; return table(['value'], [[1]]); });

  assert.strictEqual(await statusOf(), 503);
  assert.strictEqual(called, false);
});

// The application-log workspace is read by more people than the analytics one, and a compiled query
// names the tables and cross-workspace GUIDs it reads.
test('a failed query is logged by its summary, never by its text', async (t) => {
  runner._setRunner(async () => { throw new Error('ETIMEDOUT'); });
  const lines = [];
  t.mock.method(logger, 'error', (message) => lines.push(message));

  await assert.rejects(runner.run('EagleEvents_CL | summarize value = count()', TIMESPAN, SUMMARY));

  assert.match(lines[0], /q=1a2b3c4d measure=events/);
  assert.doesNotMatch(lines.join(' '), /EagleEvents_CL/);
});

// The SDK message for a refused query is only 'Unexpected status code: 400'; the reason lives in the
// response body's error chain, and either casing of innererror shows up across Azure services.
test('a refused query is logged with its status and inner error chain', async (t) => {
  runner._setRunner(async () => {
    throw Object.assign(new Error('Unexpected status code: 400'), {
      statusCode: 400,
      details: {
        error: {
          code: 'BadArgumentError',
          message: 'The request had some invalid properties',
          innerError: {
            code: 'SemanticError',
            message: 'A semantic error occurred.',
            innererror: { code: 'SEM0260', message: "Unknown function: 'workspace'" }
          }
        }
      }
    });
  });
  const lines = [];
  t.mock.method(logger, 'error', (message) => lines.push(message));

  await assert.rejects(runner.run('EagleEvents_CL', TIMESPAN, SUMMARY));

  assert.match(lines[0], /status=400/);
  assert.match(lines[0], /BadArgumentError: .* <- SemanticError: .* <- SEM0260: Unknown function: 'workspace'/);
});

test('a partial result is warned about by its summary too', async (t) => {
  runner._setRunner(async () => ({
    status: 'PartialFailure',
    partialError: new Error('query exceeded its data limit'),
    partialTables: [{ columnDescriptors: [{ name: 'value' }], rows: [[3]] }]
  }));
  const lines = [];
  t.mock.method(logger, 'warn', (message) => lines.push(message));

  await runner.run('EagleEvents_CL | summarize value = count()', TIMESPAN, SUMMARY);

  assert.match(lines[0], /q=1a2b3c4d/);
  assert.doesNotMatch(lines.join(' '), /EagleEvents_CL/);
});
