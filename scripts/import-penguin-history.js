#!/usr/bin/env node
'use strict';

/**
 * Import penguin-analytics history into EagleEventsDaily_CL.
 *
 * penguin kept raw events in TimescaleDB; only its daily aggregates are worth carrying over, so this
 * reads CSV exported from two of its views and posts one rollup row per CSV row. docs/MIGRATION.md
 * has the export commands.
 *
 * TimeGenerated IS NOW, deliberately: the Logs Ingestion API rewrites the timestamp on rows older
 * than two days, so a historical date cannot travel in it. The real date goes in `Day`, which is the
 * same column the live summary rule fills (azure/modules/event-logs.bicep).
 *
 *   node scripts/import-penguin-history.js --env test --file daily_events_summary.csv --dry-run
 */

const fs = require('fs');

const { DAILY_STREAM, describeUploadError } = require('../src/ingest/dcr-writer');
const { logger } = require('../src/utils/logger');

const ENVIRONMENTS = ['dev', 'test', 'prod'];

const HELP = `
import-penguin-history.js --env <dev|test|prod> --file <csv> [--file <csv>…] [--dry-run]

  --env       value of the Env column on every imported row.
  --file      CSV exported from the penguin view daily_events_summary or page_views. Repeatable.
  --dry-run   parse and map, print the counts, post nothing.
  --help      this text.

  EVENTS_DCR_ENDPOINT and EVENTS_DCR_IMMUTABLE_ID name the target rule; deploy-infra.sh prints both.
  Authentication is DefaultAzureCredential, and the caller needs Monitoring Metrics Publisher on the
  rule.
`;

/** RFC 4180 fields: quoted values may hold commas, newlines and doubled quotes. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (quoted) {
      if (char !== '"') {
        field += char;
      } else if (text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = false;
      }
      continue;
    }

    if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (char !== '\r') field += char;
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Header row plus one object per data row, keyed by lower-cased column name. */
function records(text) {
  const rows = parseCsv(text).filter((row) => row.some((value) => value.trim() !== ''));
  if (rows.length === 0) throw new Error('the file is empty');

  const header = rows[0].map((name) => name.trim().toLowerCase());
  return rows.slice(1).map((row, position) => {
    const record = {};
    header.forEach((name, column) => { record[name] = row[column] === undefined ? '' : row[column]; });
    // The line in the file, so a message points at something the operator can open and look at.
    record._line = position + 2;
    return record;
  });
}

function fail(record, field, value, expected) {
  return new Error(`line ${record._line}: ${field} '${value}' is not ${expected}`);
}

/** psql writes the zone as +00, which Date.parse does not take; everything else it already does. */
function normalizeTimestamp(value) {
  const text = String(value).trim().replace(' ', 'T');
  return /[+-]\d{2}$/.test(text) ? `${text}:00` : text;
}

/** The UTC day a timestamp falls in. Truncated because `Day` is a bucket, not an instant. */
function dayField(record, field) {
  const value = record[field];
  const parsed = Date.parse(normalizeTimestamp(value));
  if (Number.isNaN(parsed)) throw fail(record, field, value, 'a date');
  return `${new Date(parsed).toISOString().slice(0, 10)}T00:00:00.000Z`;
}

function countField(record, field) {
  const value = record[field];
  const number = Number(String(value).trim());
  if (!Number.isInteger(number) || number < 0) throw fail(record, field, value, 'a row count');
  return number;
}

function textField(record, field) {
  return String(record[field] === undefined ? '' : record[field]).trim();
}

/**
 * One EagleEventsDaily_CL row. ProjectId, Country and DeviceType are empty because penguin's rollups
 * carried no such dimension — a chart grouped by them shows imported history as one blank bucket.
 */
function rollupRow(fields, env, now) {
  return {
    TimeGenerated: now,
    Day: fields.day,
    SourceApp: fields.sourceApp,
    EventName: fields.eventName,
    Page: fields.page,
    ProjectId: '',
    Country: '',
    DeviceType: '',
    Env: env,
    Events: fields.events,
    Sessions: fields.sessions,
    Users: fields.users
  };
}

const SHAPES = [
  {
    view: 'daily_events_summary',
    columns: ['day', 'source_app', 'event_type', 'event_count', 'unique_sessions', 'unique_users'],
    map: (record, env, now) => rollupRow({
      day: dayField(record, 'day'),
      sourceApp: textField(record, 'source_app'),
      eventName: textField(record, 'event_type'),
      page: '',
      events: countField(record, 'event_count'),
      sessions: countField(record, 'unique_sessions'),
      users: countField(record, 'unique_users')
    }, env, now)
  },
  {
    // page_views totals a page over all time and carries no day, so its rows land on the last day
    // the page was seen. Use it for "which pages mattered", not for a time series.
    view: 'page_views',
    columns: ['page_path', 'source_app', 'total_views', 'unique_sessions', 'unique_users', 'last_viewed'],
    map: (record, env, now) => rollupRow({
      day: dayField(record, 'last_viewed'),
      sourceApp: textField(record, 'source_app'),
      // penguin's own event type, kept so imported rows and its dashboards agree.
      eventName: 'page_view',
      page: textField(record, 'page_path'),
      events: countField(record, 'total_views'),
      sessions: countField(record, 'unique_sessions'),
      users: countField(record, 'unique_users')
    }, env, now)
  }
];

/**
 * CSV text as rollup rows.
 *
 * @param {string} text CSV with a header row, as `\copy … csv header` writes it.
 * @param {{env: string, now?: Date}} options
 * @returns {{view: string, rows: object[]}}
 */
function toDailyRows(text, { env, now = new Date() }) {
  const rows = records(text);
  if (rows.length === 0) throw new Error('the file has a header but no rows');

  const present = Object.keys(rows[0]);
  const shape = SHAPES.find((candidate) => candidate.columns.every((name) => present.includes(name)));

  if (!shape) {
    throw new Error(
      `unrecognised columns: ${present.filter((name) => name !== '_line').join(', ')}. ` +
      `Export ${SHAPES.map((candidate) => candidate.view).join(' or ')} with a header row.`
    );
  }

  const stamp = now.toISOString();
  return { view: shape.view, rows: rows.map((record) => shape.map(record, env, stamp)) };
}

/** A flag's value. A missing one shows up as the next flag, which would be read as a file name. */
function value(argv, index, flag) {
  const found = argv[index] || '';
  if (!found || found.startsWith('--')) throw new Error(`${flag} needs a value`);
  return found;
}

function parseArgs(argv) {
  const args = { env: '', files: [], dryRun: false, help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--env') args.env = value(argv, index += 1, flag);
    else if (flag === '--file') args.files.push(value(argv, index += 1, flag));
    else if (flag === '--dry-run') args.dryRun = true;
    else if (flag === '--help' || flag === '-h') args.help = true;
    else throw new Error(`unknown argument '${flag}'`);
  }

  return args;
}

async function upload(rows) {
  // Required here rather than at the top: --dry-run must work with no Azure settings at all.
  const config = require('../src/config');
  if (!config.eventsDcrEndpoint || !config.eventsDcrImmutableId) {
    throw new Error('EVENTS_DCR_ENDPOINT and EVENTS_DCR_IMMUTABLE_ID must both be set.');
  }

  const { DefaultAzureCredential } = require('@azure/identity');
  const { LogsIngestionClient } = require('@azure/monitor-ingestion');
  const client = new LogsIngestionClient(config.eventsDcrEndpoint, new DefaultAzureCredential());

  // The client splits the array into 1 MB chunks itself, which is the ingestion API's per-call limit.
  await client.upload(config.eventsDcrImmutableId, DAILY_STREAM, rows);
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (!ENVIRONMENTS.includes(args.env) || args.files.length === 0) {
    process.stdout.write(HELP);
    return 2;
  }

  const rows = [];
  for (const file of args.files) {
    const { view, rows: mapped } = toDailyRows(fs.readFileSync(file, 'utf8'), { env: args.env });
    logger.info(`[import] ${file}: ${mapped.length} row(s) from ${view}`);
    rows.push(...mapped);
  }

  const days = new Set(rows.map((row) => row.Day));
  const events = rows.reduce((total, row) => total + row.Events, 0);
  logger.info(`[import] ${rows.length} row(s), ${days.size} day(s), ${events} event(s), Env=${args.env}`);

  if (args.dryRun) {
    logger.info('[import] dry run, nothing posted.');
    return 0;
  }

  await upload(rows);
  logger.info(`[import] posted ${rows.length} row(s) to ${DAILY_STREAM}.`);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      logger.error(`[import] ${describeUploadError(err)}`);
      process.exitCode = 1;
    });
}

module.exports = { parseCsv, toDailyRows, parseArgs };
