'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { toDailyRows, parseArgs } = require('../scripts/import-penguin-history');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

const DAILY_CSV = fixture('penguin-daily-events-summary.csv');
const PAGE_VIEWS_CSV = fixture('penguin-page-views.csv');

// Fixed, because TimeGenerated is "when the import ran" and an assertion on Date.now() cannot hold.
const NOW = new Date('2026-09-06T18:30:00.000Z');

const OPTIONS = { env: 'test', now: NOW };

test('a daily_events_summary export is recognised by its columns', () => {
  assert.strictEqual(toDailyRows(DAILY_CSV, OPTIONS).view, 'daily_events_summary');
});

test('a daily_events_summary row becomes one rollup row', () => {
  const { rows } = toDailyRows(DAILY_CSV, OPTIONS);

  assert.deepStrictEqual(rows[0], {
    TimeGenerated: '2026-09-06T18:30:00.000Z',
    Day: '2026-08-01T00:00:00.000Z',
    SourceApp: 'eagle-public',
    EventName: 'page_view',
    Page: '',
    ProjectId: '',
    Country: '',
    DeviceType: '',
    Env: 'test',
    Events: 1420,
    Sessions: 318,
    Users: 0
  });
});

test('counts arrive as numbers, not the strings the CSV holds', () => {
  const { rows } = toDailyRows(DAILY_CSV, OPTIONS);

  assert.strictEqual(rows[1].Events, 37);
});

test('every row in the file is mapped', () => {
  assert.strictEqual(toDailyRows(DAILY_CSV, OPTIONS).rows.length, 3);
});

test('TimeGenerated is when the import ran, because ingestion rewrites older timestamps', () => {
  const { rows } = toDailyRows(DAILY_CSV, OPTIONS);

  assert.strictEqual(rows[0].TimeGenerated, NOW.toISOString());
});

test('a page_views export is recognised by its columns', () => {
  assert.strictEqual(toDailyRows(PAGE_VIEWS_CSV, OPTIONS).view, 'page_views');
});

test('a quoted field holding a comma does not shift the columns after it', () => {
  const { rows } = toDailyRows(PAGE_VIEWS_CSV, OPTIONS);

  assert.strictEqual(rows[0].Events, 8210);
});

test('a page_views row takes its page from page_path', () => {
  const { rows } = toDailyRows(PAGE_VIEWS_CSV, OPTIONS);

  assert.strictEqual(rows[0].Page, '/projects');
});

test('a page_views row carries penguin own event type', () => {
  const { rows } = toDailyRows(PAGE_VIEWS_CSV, OPTIONS);

  assert.strictEqual(rows[0].EventName, 'page_view');
});

test('Day is the UTC day of a timestamp, not the timestamp', () => {
  const { rows } = toDailyRows(PAGE_VIEWS_CSV, OPTIONS);

  assert.strictEqual(rows[0].Day, '2026-08-31T00:00:00.000Z');
});

test('Env is the environment the caller named', () => {
  const { rows } = toDailyRows(DAILY_CSV, { env: 'prod', now: NOW });

  assert.strictEqual(rows[0].Env, 'prod');
});

test('an export from another view is refused by name', () => {
  const csv = 'link_url,click_count\nhttps://example.gov.bc.ca,4\n';

  assert.throws(() => toDailyRows(csv, OPTIONS), /daily_events_summary or page_views/);
});

test('a count that is not a number names the line it is on', () => {
  const csv = 'day,source_app,event_type,event_count,unique_sessions,unique_users\n' +
    '2026-08-01 00:00:00+00,eagle-public,page_view,many,318,0\n';

  assert.throws(() => toDailyRows(csv, OPTIONS), /line 2: event_count 'many'/);
});

test('a day that is not a date names the line it is on', () => {
  const csv = 'day,source_app,event_type,event_count,unique_sessions,unique_users\n' +
    'last tuesday,eagle-public,page_view,10,3,0\n';

  assert.throws(() => toDailyRows(csv, OPTIONS), /line 2: day 'last tuesday'/);
});

test('a header with no rows under it is refused', () => {
  const csv = 'day,source_app,event_type,event_count,unique_sessions,unique_users\n';

  assert.throws(() => toDailyRows(csv, OPTIONS), /no rows/);
});

test('the flags are read into an env, a file list and the dry-run switch', () => {
  const args = parseArgs(['--env', 'test', '--file', 'a.csv', '--file', 'b.csv', '--dry-run']);

  assert.deepStrictEqual(args, { env: 'test', files: ['a.csv', 'b.csv'], dryRun: true, help: false });
});

// Without this the next flag becomes the file name, and the import reads nothing while reporting that
// it ran.
test('a --file with its value left out is refused, not filled from the next flag', () => {
  assert.throws(() => parseArgs(['--env', 'test', '--file', '--dry-run']), /--file needs a value/);
});

test('a trailing --env with no value is refused too', () => {
  assert.throws(() => parseArgs(['--env']), /--env needs a value/);
});
