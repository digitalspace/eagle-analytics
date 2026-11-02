'use strict';

// Cross-workspace measures address a configured workspace by customer id: a bare name is ambiguous
// when the workspace lives in another resource group.
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

function assertLine(text, line) {
  assert.ok(text.split('\n').includes(line), `no line ${JSON.stringify(line)} in:\n${text}`);
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

// The API timespan filters TimeGenerated, which on imported rows is import time; the real date is Day.
// So the text bounds Day and the timespan is widened past any gap between them (docs/EVENT-SCHEMA.md).
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

test('events over raw events counts rows, binned by day', () => {
  assertLine(kql({ measure: 'events', bin: 'day' }), '| summarize value = count() by t = bin(TimeGenerated, 1d)');
});

test('sessions over raw events counts distinct session ids, binned by hour', () => {
  assertLine(kql({ measure: 'sessions', bin: 'hour' }), '| summarize value = dcount(SessionId) by t = bin(TimeGenerated, 1h)');
});

test('users over raw events counts distinct user ids', () => {
  assertLine(kql({ measure: 'users', bin: 'week' }), '| summarize value = dcount(UserId) by t = bin(TimeGenerated, 7d)');
});

test('p95Duration takes the 95th percentile of DurationMs', () => {
  assertLine(
    kql({ measure: 'p95Duration', bin: 'day' }),
    '| summarize value = percentile(DurationMs, 95) by t = bin(TimeGenerated, 1d)'
  );
});

test('errors read AppExceptions in the application workspace and rename AppRoleName', () => {
  const text = kql({ measure: 'errors', bin: 'day', groupBy: ['SourceApp'] });

  assertLine(text, "workspace('4a1b3c5d-1111-4222-8333-aaaaaaaaaaaa').AppExceptions");
  assertLine(text, '| summarize value = count() by t = bin(TimeGenerated, 1d), SourceApp = AppRoleName');
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

  // Full text: a where after summarize would filter on columns summarize already dropped.
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
  const text = kql({ measure: 'events', groupBy: ['Page'], limit: 10 });

  assertLine(text, '| order by value desc, Page asc');
  assertLine(text, '| limit 10');
});

test('includeDemi unions the DEMI hourly rollup and labels its rows', () => {
  const text = kql({ measure: 'events', bin: 'day', groupBy: ['SourceApp'], includeDemi: true });

  assertLine(text, 'union');
  assertLine(text, '  (EagleEventsDaily_CL | project Day, SourceApp, EventName, ProjectId, Events, Users),');
  assertLine(
    text,
    "  (workspace('7f2e9d8c-4444-4555-8666-bbbbbbbbbbbb').DemiEventsHourly_CL | extend SourceApp = @'eagle-demi'" +
      ', Day = bin(TimeGenerated, 1d) | project Day, SourceApp, EventName, ProjectId, Events, Users)'
  );
});

// SEM0260 unknown function: Log Analytics resolves workspace() from a plain string literal only, so
// the cross-workspace scope is the one place a verbatim literal is wrong.
test('a cross-workspace scope is never emitted as a verbatim literal', () => {
  const errors = kql({ measure: 'errors', bin: 'day', groupBy: ['SourceApp'] });
  const demi = kql({ measure: 'events', source: 'daily', bin: 'day', includeDemi: true });

  assert.ok(!errors.includes('workspace(@'), errors);
  assert.ok(!demi.includes('workspace(@'), demi);
});

test('the summary tells a DEMI union apart from the same query without it', () => {
  const body = { measure: 'events', source: 'daily', bin: 'day', range: WEEK };

  assert.ok(!compile(body).summary.includes('demi='), compile(body).summary);
  assert.match(compile({ ...body, includeDemi: true }).summary, /source=daily bin=day dims=none demi=true$/);
});

test('auto reads raw events for a short range', () => {
  assert.ok(kql({ measure: 'events', bin: 'day' }).startsWith('EagleEvents_CL'));
});

test('auto reads the daily rollup once the range is past a month', () => {
  const text = compile({ measure: 'events', bin: 'day', range: QUARTER }).kql;

  assert.ok(text.startsWith('EagleEventsDaily_CL'), text);
});

for (const body of [
  { measure: 'p95Duration', bin: 'day' },
  { measure: 'events', bin: 'day', groupBy: ['Referrer'] },
  { measure: 'events', bin: 'hour' }
]) {
  test(`auto stays on raw events for a long range the rollup cannot answer: ${JSON.stringify(body)}`, () => {
    const text = compile({ ...body, range: QUARTER }).kql;

    assert.ok(text.startsWith('EagleEvents_CL'), text);
  });
}

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

  assertLine(text, "| where Page == @'x'' | union EagleAudit_CL //'");
});

test('a backslash cannot escape the closing quote of a verbatim literal', () => {
  const text = kql({
    measure: 'events',
    filters: [{ dimension: 'Page', op: 'eq', value: 'home\\' }]
  });

  assertLine(text, "| where Page == @'home\\'");
});

for (const value of ['a\nb', 'a\rb', 'a\tb', `a${String.fromCharCode(0)}b`]) {
  test(`a control character in a filter value is refused, so no literal can span lines: ${JSON.stringify(value)}`, () => {
    assert.strictEqual(statusOf({ measure: 'events', filters: [{ dimension: 'Page', op: 'eq', value }] }), 400);
  });
}

test('an in list carrying injection attempts escapes every element', () => {
  const text = kql({
    measure: 'events',
    filters: [{ dimension: 'EventName', op: 'in', value: ["a'", 'workspace(', '; drop'] }]
  });

  assertLine(text, "| where EventName in (@'a''', @'workspace(', @'; drop')");
});

for (const body of [
  { measure: 'count() by 1 //' },
  { measure: 'events', groupBy: ['Page | take 1'] },
  { measure: 'events', filters: [{ dimension: 'Page', op: '== 1 or', value: 'x' }] },
  { measure: 'events', filters: [{ dimension: "Page'", op: 'eq', value: 'x' }] },
  { measure: 'events', bin: '1d) //' },
  { measure: 'events', source: "raw' | union EagleAudit_CL" },
  { measure: 'events', order: 'value' }
]) {
  test(`every name-shaped field is a whitelist key, so injection there is a 400: ${JSON.stringify(body)}`, () => {
    assert.strictEqual(statusOf(body), 400);
  });
}

test('a range longer than raw retention is refused', () => {
  assert.strictEqual(
    statusOf({ measure: 'events', range: { from: '2025-01-01T00:00:00Z', to: '2026-06-01T00:00:00Z' } }),
    400
  );
});

for (const range of [
  { from: WEEK.to, to: WEEK.from },
  { from: WEEK.from, to: WEEK.from },
  { from: 'yesterday', to: WEEK.to },
  { from: WEEK.from },
  { from: WEEK.from, to: WEEK.to, days: 7 }
]) {
  test(`a range that does not move forward, or is not a date, is refused: ${JSON.stringify(range)}`, () => {
    assert.strictEqual(statusOf({ measure: 'events', range }), 400);
  });
}

test('a missing range is refused', () => {
  assert.strictEqual(statusOf({ measure: 'events', range: undefined }), 400);
});

for (const limit of [0, -1, 1001, 3.5, '10']) {
  test(`limit stays a whole number inside the ceiling: ${JSON.stringify(limit)}`, () => {
    assert.strictEqual(statusOf({ measure: 'events', limit }), 400);
  });
}

test('a repeated groupBy dimension is refused', () => {
  assert.strictEqual(statusOf({ measure: 'events', groupBy: ['Page', 'Page'] }), 400);
});

test('an unconfigured cross-workspace reference is refused rather than compiled', (t) => {
  const previous = process.env.EAGLE_LOGS_WORKSPACE;
  t.after(() => { process.env.EAGLE_LOGS_WORKSPACE = previous; });
  process.env.EAGLE_LOGS_WORKSPACE = '';

  assert.strictEqual(statusOf({ measure: 'errors', bin: 'day' }), 400);
});
