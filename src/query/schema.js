'use strict';

/**
 * The whitelist, and the only place a table, column, aggregation or operator name is written.
 *
 * Nothing from a request body ever becomes KQL syntax: a request names a measure, a dimension, an
 * operator and a bin, each of which is a key in one of the objects below, and everything else it
 * carries becomes an escaped string literal (src/query/compile-kql.js).
 */

/** Raw events and the daily rollup, both in `analytics-logs-<env>` (azure/modules/event-logs.bicep). */
const SOURCES = Object.freeze({
  raw: 'EagleEvents_CL',
  daily: 'EagleEventsDaily_CL'
});

/** Ranges past this many days read the rollup under `source: 'auto'`. */
const AUTO_DAILY_MIN_DAYS = 30;

/** `dailyRetentionDays` in azure/modules/event-logs.bicep. Bounds how stale a rollup row can be. */
const DAILY_RETENTION_DAYS = 730;

/**
 * The rollup's own day bucket, and the reason the daily source is read by it: the Logs Ingestion API
 * rewrites TimeGenerated on anything older than two days, so an imported row carries import time
 * there and its real date only here (docs/MIGRATION.md).
 */
const DAILY_TIME_COLUMN = 'Day';

/**
 * DEMI's own events, read cross-workspace.
 *
 * `DemiEventsHourly_CL` and not `DemiEvents_CL`: the raw table is on the Auxiliary plan, which
 * answers an interactive query with no rows at all (eagle-demi `azure/modules/audit-logs.bicep`,
 * and `src/controllers/admin-reads.js` reads the rollup for the same reason). The rollup is
 * Analytics-plan and holds pre-summed Events and Users, which is why the union is only offered
 * against the pre-summed `daily` shape.
 */
const DEMI_TABLE = 'DemiEventsHourly_CL';
const DEMI_SOURCE_APP = 'eagle-demi';

// The summary rule creates that table, so it keeps its workspace's default retention rather than one
// of its own (eagle-demi azure/modules/audit-logs.bicep). Far shorter than our 730, so the union is
// lopsided over a long range and the builder has to say so.
const DEMI_HOURLY_RETENTION_DAYS = 30;

const DEMI_MEASURES = Object.freeze(['events', 'users']);

/** Error counts come from the application workspace, not the analytics one. */
const ERRORS_TABLE = 'AppExceptions';

/**
 * `aggregate` doubles as the availability map: a measure runs on exactly the sources it lists.
 *
 * Sessions and Users on `daily` are SUMS OF DAILY DISTINCT COUNTS, not distinct counts over the
 * range: the rollup stores one dcount per day, and per-day distinct counts cannot be added back
 * into a range-wide distinct count. Someone who visits on three days counts three times. The
 * builder labels this, and it is why `auto` only reaches for the rollup past a month, where the
 * shape of the curve is the question and the absolute number is not.
 */
const MEASURES = Object.freeze({
  events: {
    label: 'Events',
    aggregate: { raw: 'count()', daily: 'sum(Events)' }
  },
  sessions: {
    label: 'Sessions',
    aggregate: { raw: 'dcount(SessionId)', daily: 'sum(Sessions)' }
  },
  users: {
    label: 'Signed-in users',
    aggregate: { raw: 'dcount(UserId)', daily: 'sum(Users)' }
  },
  p95Duration: {
    label: 'p95 duration (ms)',
    aggregate: { raw: 'percentile(DurationMs, 95)' }
  },
  errors: {
    label: 'Errors',
    aggregate: { errors: 'count()' }
  }
});

/**
 * `sources` is which tables carry the column. `demi` marks the three the DEMI union projects, and
 * `errorsColumn` is how a dimension is spelled in `AppExceptions` — the errors table names the
 * producing app `AppRoleName`, and the builder should not have to know that.
 */
const DIMENSIONS = Object.freeze({
  SourceApp: { label: 'Source app', sources: ['raw', 'daily'], demi: true, errorsColumn: 'AppRoleName' },
  EventName: { label: 'Event', sources: ['raw', 'daily'], demi: true },
  Page: { label: 'Page', sources: ['raw', 'daily'], contains: true },
  ProjectId: { label: 'Project', sources: ['raw', 'daily'], demi: true },
  Country: { label: 'Country', sources: ['raw', 'daily'] },
  DeviceType: { label: 'Device type', sources: ['raw', 'daily'] },
  Referrer: { label: 'Referrer', sources: ['raw'], contains: true },
  Browser: { label: 'Browser', sources: ['raw'] },
  Region: { label: 'Region', sources: ['raw'] },
  City: { label: 'City', sources: ['raw'] }
});

/** Bin name to KQL timespan literal. `week` is 7d, so weeks start on the Unix epoch's Thursday. */
const BINS = Object.freeze({ hour: '1h', day: '1d', week: '7d' });

const FILTER_OPS = Object.freeze(['eq', 'in', 'contains']);

const LIMITS = Object.freeze({
  /** Raw retention is 400 days, so a longer window can only return a partial answer. */
  maxRangeDays: 400,
  maxLimit: 1000,
  maxContainsValueLength: 200,
  maxValueLength: 512,
  maxInValues: 50,
  maxFilters: 10,
  maxGroupBy: 3,
  autoDailyMinDays: AUTO_DAILY_MIN_DAYS
});

/** Which operators a dimension accepts. `contains` scans, so it is offered on free text only. */
function opsFor(dimension) {
  const meta = DIMENSIONS[dimension];
  if (!meta) return [];
  return meta.contains ? ['eq', 'in', 'contains'] : ['eq', 'in'];
}

/** Is `dimension` readable from `source`, given whether the DEMI union is in play? */
function available(dimension, source, includeDemi = false) {
  const meta = DIMENSIONS[dimension];
  if (!meta) return false;
  if (source === 'errors') return Boolean(meta.errorsColumn);
  if (!meta.sources.includes(source)) return false;
  return includeDemi ? Boolean(meta.demi) : true;
}

/** How `dimension` is spelled in `source`. Differs only in the errors table. */
function columnFor(dimension, source) {
  const meta = DIMENSIONS[dimension];
  return source === 'errors' ? meta.errorsColumn : dimension;
}

/** The whitelist as the UI builder consumes it: everything it may offer, and nothing it may not. */
function describe() {
  return {
    measures: Object.entries(MEASURES).map(([name, meta]) => ({
      name,
      label: meta.label,
      sources: Object.keys(meta.aggregate),
      demi: DEMI_MEASURES.includes(name)
    })),
    dimensions: Object.entries(DIMENSIONS).map(([name, meta]) => ({
      name,
      label: meta.label,
      sources: meta.sources.concat(meta.errorsColumn ? ['errors'] : []),
      demi: Boolean(meta.demi),
      ops: opsFor(name)
    })),
    filterOps: [...FILTER_OPS],
    bins: Object.keys(BINS),
    limits: { ...LIMITS },
    notes: {
      daily: 'Sessions and users from the daily rollup are sums of daily distinct counts, so a ' +
        'visitor seen on several days is counted once per day.',
      demi: 'Including eagle-demi reads its hourly rollup and reports it as SourceApp ' +
        `'${DEMI_SOURCE_APP}'. Only events and signed-in users are available there, and that rollup ` +
        `keeps ${DEMI_HOURLY_RETENTION_DAYS} days, so a longer range shows eagle-demi over its last ` +
        `${DEMI_HOURLY_RETENTION_DAYS} days only.`
    }
  };
}

module.exports = {
  SOURCES,
  DEMI_TABLE,
  DEMI_SOURCE_APP,
  DEMI_MEASURES,
  ERRORS_TABLE,
  MEASURES,
  DIMENSIONS,
  BINS,
  LIMITS,
  AUTO_DAILY_MIN_DAYS,
  DAILY_RETENTION_DAYS,
  DAILY_TIME_COLUMN,
  opsFor,
  available,
  columnFor,
  describe
};
