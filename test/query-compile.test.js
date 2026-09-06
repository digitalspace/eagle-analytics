'use strict';

// Cross-workspace measures take a workspace from configuration, not from a request, and address it by
// its customer id: azure/main.bicep reads the GUID off each workspace, because a bare name is
// ambiguous when the workspace lives in another resource group.
process.env.EAGLE_LOGS_WORKSPACE = '4a1b3c5d-1111-4222-8333-aaaaaaaaaaaa';
process.env.DEMI_AUDIT_WORKSPACE = '7f2e9d8c-4444-4555-8666-bbbbbbbbbbbb';

const assert = require('node:assert');
const { test } = require('node:test');

const { compile } = require('../src/query/compile-kql');

const WEEK = { from: '2026-08-29T00:00:00.000Z', to: '2026-09-05T00:00:00.000Z' };
const QUARTER = { from: '2026-06-05T00:00:00.000Z', to: '2026-09-05T00:00:00.000Z' };

function kql(body) {
  return compile({ range: WEEK, ...body }).kql;
}

function statusOf(body) {
  try {
    compile({ range: WEEK, ...body });
    return 200;
  } catch (err) {
    return err.status;
  }
}

test('the range is returned as a timespan and never appears in the query text', () => {
  const { kql: text, timespan } = compile({ measure: 'events', bin: 'day', range: WEEK });

  assert.strictEqual(timespan, '2026-08-29T00:00:00.000Z/2026-09-05T00:00:00.000Z');
  assert.ok(!text.includes('2026-08-29'), text);
});

// An imported row carries import time in TimeGenerated and its real date in Day, and the API's
// timespan filters TimeGenerated, so the rollup is bounded inside the text and the timespan is widened
// past anything the two timestamps can be apart by (docs/MIGRATION.md).
test('the daily source is bounded on Day, with a timespan widened by the rollup retention', () => {
  const { kql: text, timespan } = compile({ measure: 'events', source: 'daily', range: WEEK });
  const [from, to] = timespan.split('/');

  assert.ok(text.includes("| where Day >= todatetime(@'2026-08-29T00:00:00.000Z')"), text);
  assert.strictEqual(from, WEEK.from);
  const widenedDays = (Date.parse(to) - Date.parse(WEEK.to)) / 86400000;
  assert.strictEqual(widenedDays, 730);
});

// Two requests for the same chart must compile to the same query, or a cached answer is never reused
// and no assertion above can hold.
test('the same request compiles to the same query and timespan twice', () => {
  const body = { measure: 'events', source: 'daily', bin: 'day', range: WEEK };
  assert.deepStrictEqual(compile(body), compile(body));
});

test('the compiler returns a log-safe summary that carries no query text', () => {
  const { kql: text, summary } = compile({
    measure: 'events',
    bin: 'day',
    groupBy: ['SourceApp'],
    range: WEEK
  });

  assert.match(summary, /^q=[0-9a-f]{8} measure=events source=raw bin=day dims=SourceApp$/);
  assert.ok(!summary.includes(text.split('\n')[0]), summary);
});

test('events over raw events, binned by day', () => {
  assert.strictEqual(kql({ measure: 'events', bin: 'day' }), [
    'EagleEvents_CL',
    '| summarize value = count() by t = bin(TimeGenerated, 1d)',
    '| order by t asc',
    '| limit 1000'
  ].join('\n'));
});

test('sessions over raw events counts distinct session ids, binned by hour', () => {
  assert.strictEqual(kql({ measure: 'sessions', bin: 'hour' }), [
    'EagleEvents_CL',
    '| summarize value = dcount(SessionId) by t = bin(TimeGenerated, 1h)',
    '| order by t asc',
    '| limit 1000'
  ].join('\n'));
});

test('users over raw events counts distinct user ids', () => {
  assert.strictEqual(kql({ measure: 'users', bin: 'week' }), [
    'EagleEvents_CL',
    '| summarize value = dcount(UserId) by t = bin(TimeGenerated, 7d)',
    '| order by t asc',
    '| limit 1000'
  ].join('\n'));
});

test('p95Duration takes the 95th percentile of DurationMs', () => {
  assert.strictEqual(kql({ measure: 'p95Duration', bin: 'day' }), [
    'EagleEvents_CL',
    '| summarize value = percentile(DurationMs, 95) by t = bin(TimeGenerated, 1d)',
    '| order by t asc',
    '| limit 1000'
  ].join('\n'));
});

test('errors read AppExceptions in the application workspace and rename AppRoleName', () => {
  assert.strictEqual(kql({ measure: 'errors', bin: 'day', groupBy: ['SourceApp'] }), [
    "workspace(@'4a1b3c5d-1111-4222-8333-aaaaaaaaaaaa').AppExceptions",
    '| summarize value = count() by t = bin(TimeGenerated, 1d), SourceApp = AppRoleName',
    '| order by t asc, SourceApp asc',
    '| limit 1000'
  ].join('\n'));
});

test('the daily rollup sums its pre-summed counts, bucketed on its own Day column', () => {
  assert.strictEqual(kql({ measure: 'events', source: 'daily', bin: 'week', groupBy: ['Page'] }), [
    'EagleEventsDaily_CL',
    "| where Day >= todatetime(@'2026-08-29T00:00:00.000Z') and Day < todatetime(@'2026-09-05T00:00:00.000Z')",
    '| summarize value = sum(Events) by t = bin(Day, 7d), Page',
    '| order by t asc, Page asc',
    '| limit 1000'
  ].join('\n'));
});

test('every filter operator emits one where clause with an escaped literal', () => {
  const text = kql({
    measure: 'events',
    filters: [
      { dimension: 'SourceApp', op: 'eq', value: 'eagle-public' },
      { dimension: 'EventName', op: 'in', value: ['page_view', 'doc_download'] },
      { dimension: 'Page', op: 'contains', value: '/projects' }
    ]
  });

  assert.strictEqual(text, [
    'EagleEvents_CL',
    "| where SourceApp == @'eagle-public'",
    "| where EventName in (@'page_view', @'doc_download')",
    "| where Page contains @'/projects'",
    '| summarize value = count()',
    '| limit 1000'
  ].join('\n'));
});

test('an unbinned breakdown is ordered biggest first, so limit means the top N', () => {
  assert.strictEqual(kql({ measure: 'events', groupBy: ['Page'], limit: 10 }), [
    'EagleEvents_CL',
    '| summarize value = count() by Page',
    '| order by value desc, Page asc',
    '| limit 10'
  ].join('\n'));
});

test('includeDemi unions the DEMI hourly rollup and labels its rows', () => {
  assert.strictEqual(kql({ measure: 'events', bin: 'day', groupBy: ['SourceApp'], includeDemi: true }), [
    'union',
    '  (EagleEventsDaily_CL | project Day, SourceApp, EventName, ProjectId, Events, Users),',
    "  (workspace(@'7f2e9d8c-4444-4555-8666-bbbbbbbbbbbb').DemiEventsHourly_CL | extend SourceApp = @'eagle-demi'" +
      ", Day = bin(TimeGenerated, 1d) | project Day, SourceApp, EventName, ProjectId, Events, Users)",
    "| where Day >= todatetime(@'2026-08-29T00:00:00.000Z') and Day < todatetime(@'2026-09-05T00:00:00.000Z')",
    '| summarize value = sum(Events) by t = bin(Day, 1d), SourceApp',
    '| order by t asc, SourceApp asc',
    '| limit 1000'
  ].join('\n'));
});

test('auto reads raw events for a short range', () => {
  assert.ok(kql({ measure: 'events', bin: 'day' }).startsWith('EagleEvents_CL'));
});

test('auto reads the daily rollup once the range is past a month', () => {
  const text = compile({ measure: 'events', bin: 'day', range: QUARTER }).kql;

  assert.ok(text.startsWith('EagleEventsDaily_CL'), text);
});

test('auto stays on raw events for a long range the rollup cannot answer', () => {
  const cases = [
    { measure: 'p95Duration', bin: 'day' },
    { measure: 'events', bin: 'day', groupBy: ['Referrer'] },
    { measure: 'events', bin: 'hour' }
  ];

  for (const body of cases) {
    const text = compile({ ...body, range: QUARTER }).kql;
    assert.ok(text.startsWith('EagleEvents_CL'), `${JSON.stringify(body)} -> ${text}`);
  }
});

test('an hourly bin over the daily rollup is refused rather than silently mislabelled', () => {
  assert.strictEqual(statusOf({ measure: 'events', source: 'daily', bin: 'hour' }), 400);
});

test('a measure the rollup does not hold is refused when the rollup is asked for by name', () => {
  assert.strictEqual(statusOf({ measure: 'p95Duration', source: 'daily' }), 400);
});

test('a dimension the rollup does not hold is refused when the rollup is asked for by name', () => {
  assert.strictEqual(statusOf({ measure: 'events', source: 'daily', groupBy: ['Browser'] }), 400);
});

test('includeDemi is refused for a measure or dimension DEMI does not carry', () => {
  assert.strictEqual(statusOf({ measure: 'sessions', includeDemi: true }), 400);
  assert.strictEqual(statusOf({ measure: 'events', includeDemi: true, groupBy: ['Country'] }), 400);
  assert.strictEqual(statusOf({ measure: 'events', includeDemi: true, source: 'raw' }), 400);
});

test('errors group and filter by source app only', () => {
  assert.strictEqual(statusOf({ measure: 'errors', groupBy: ['Page'] }), 400);
  assert.strictEqual(
    statusOf({ measure: 'errors', filters: [{ dimension: 'Country', op: 'eq', value: 'CA' }] }),
    400
  );
});

test('contains is offered on free text only', () => {
  assert.strictEqual(statusOf({
    measure: 'events',
    filters: [{ dimension: 'Referrer', op: 'contains', value: 'google' }]
  }), 200);
  assert.strictEqual(statusOf({
    measure: 'events',
    filters: [{ dimension: 'Country', op: 'contains', value: 'CA' }]
  }), 400);
});

test('a contains value longer than 200 characters is refused', () => {
  assert.strictEqual(statusOf({
    measure: 'events',
    filters: [{ dimension: 'Page', op: 'contains', value: 'a'.repeat(201) }]
  }), 400);
});

test('a quote in a filter value is doubled inside a verbatim literal, adding no pipeline stage', () => {
  const text = kql({
    measure: 'events',
    filters: [{ dimension: 'Page', op: 'eq', value: "x' | union EagleAudit_CL //" }]
  });

  assert.strictEqual(text, [
    'EagleEvents_CL',
    "| where Page == @'x'' | union EagleAudit_CL //'",
    '| summarize value = count()',
    '| limit 1000'
  ].join('\n'));
});

test('a backslash cannot escape the closing quote of a verbatim literal', () => {
  const text = kql({
    measure: 'events',
    filters: [{ dimension: 'Page', op: 'eq', value: 'home\\' }]
  });

  assert.strictEqual(text, [
    'EagleEvents_CL',
    "| where Page == @'home\\'",
    '| summarize value = count()',
    '| limit 1000'
  ].join('\n'));
});

test('a control character in a filter value is refused, so no literal can span lines', () => {
  const values = ['a\nb', 'a\rb', 'a\tb', `a${String.fromCharCode(0)}b`];

  for (const value of values) {
    assert.strictEqual(
      statusOf({ measure: 'events', filters: [{ dimension: 'Page', op: 'eq', value }] }),
      400,
      JSON.stringify(value)
    );
  }
});

test('an in list carrying injection attempts escapes every element', () => {
  const text = kql({
    measure: 'events',
    filters: [{ dimension: 'EventName', op: 'in', value: ["a'", 'workspace(', '; drop'] }]
  });

  assert.strictEqual(text, [
    'EagleEvents_CL',
    "| where EventName in (@'a''', @'workspace(', @'; drop')",
    '| summarize value = count()',
    '| limit 1000'
  ].join('\n'));
});

test('every name-shaped field is a whitelist key, so injection there is a 400', () => {
  const attempts = [
    { measure: 'count() by 1 //' },
    { measure: 'events', groupBy: ['Page | take 1'] },
    { measure: 'events', filters: [{ dimension: 'Page', op: '== 1 or', value: 'x' }] },
    { measure: 'events', filters: [{ dimension: "Page'", op: 'eq', value: 'x' }] },
    { measure: 'events', bin: '1d) //' },
    { measure: 'events', source: "raw' | union EagleAudit_CL" },
    { measure: 'events', order: 'value' }
  ];

  for (const body of attempts) {
    assert.strictEqual(statusOf(body), 400, JSON.stringify(body));
  }
});

test('a range longer than raw retention is refused', () => {
  assert.strictEqual(
    statusOf({ measure: 'events', range: { from: '2025-01-01T00:00:00Z', to: '2026-06-01T00:00:00Z' } }),
    400
  );
});

test('a range that does not move forward, or is not a date, is refused', () => {
  const ranges = [
    { from: WEEK.to, to: WEEK.from },
    { from: WEEK.from, to: WEEK.from },
    { from: 'yesterday', to: WEEK.to },
    { from: WEEK.from },
    { from: WEEK.from, to: WEEK.to, days: 7 }
  ];

  for (const range of ranges) {
    assert.strictEqual(statusOf({ measure: 'events', range }), 400, JSON.stringify(range));
  }
});

test('a missing range is refused', () => {
  assert.strictEqual(statusOf({ measure: 'events', range: undefined }), 400);
});

test('limit stays a whole number inside the ceiling', () => {
  for (const limit of [0, -1, 1001, 3.5, '10']) {
    assert.strictEqual(statusOf({ measure: 'events', limit }), 400, String(limit));
  }
});

test('a repeated groupBy dimension is refused', () => {
  assert.strictEqual(statusOf({ measure: 'events', groupBy: ['Page', 'Page'] }), 400);
});

test('an unconfigured cross-workspace reference is refused rather than compiled', () => {
  const previous = process.env.EAGLE_LOGS_WORKSPACE;
  process.env.EAGLE_LOGS_WORKSPACE = '';

  assert.strictEqual(statusOf({ measure: 'errors', bin: 'day' }), 400);

  process.env.EAGLE_LOGS_WORKSPACE = previous;
});
