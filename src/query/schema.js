'use strict';

// The only place a table, column, aggregation or operator name is written; requests name keys here.

// Both in `analytics-logs-<env>` (azure/modules/event-logs.bicep).
const SOURCES = Object.freeze({
  raw: 'EagleEvents_CL',
  daily: 'EagleEventsDaily_CL'
});

const AUTO_DAILY_MIN_DAYS = 30;

// Must match `dailyRetentionDays` in azure/modules/event-logs.bicep.
const DAILY_RETENTION_DAYS = 730;

// Logs Ingestion rewrites TimeGenerated older than two days, so an imported row keeps its real date
// only in Day (docs/EVENT-SCHEMA.md).
const DAILY_TIME_COLUMN = 'Day';

// Not DemiEvents_CL: that table is on the Auxiliary plan, which returns no rows to an interactive
// query. The hourly rollup is pre-summed, so the union is offered on the daily shape only.
const DEMI_TABLE = 'DemiEventsHourly_CL';
const DEMI_SOURCE_APP = 'eagle-demi';

// Workspace default retention (set in eagle-demi), far shorter than ours, so the builder warns.
const DEMI_HOURLY_RETENTION_DAYS = 30;

const DEMI_MEASURES = Object.freeze(['events', 'users']);

// In the application workspace, not the analytics one.
const ERRORS_TABLE = 'AppExceptions';

// `aggregate` is also the availability map. Daily sessions and users are sums of per-day dcounts, so
// a three-day visitor counts three times; `auto` uses the rollup only past a month for that reason.
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

// `demi`: projected by the DEMI union. `errorsColumn`: the name in AppExceptions, so the builder
// never has to know it.
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

// `week` is 7d, so weeks start on the Unix epoch's Thursday.
const BINS = Object.freeze({ hour: '1h', day: '1d', week: '7d' });

const FILTER_OPS = Object.freeze(['eq', 'in', 'contains']);

const LIMITS = Object.freeze({
  // Raw retention: a longer window can only return a partial answer.
  maxRangeDays: 400,
  maxLimit: 1000,
  maxContainsValueLength: 200,
  maxValueLength: 512,
  maxInValues: 50,
  maxFilters: 10,
  maxGroupBy: 3,
  autoDailyMinDays: AUTO_DAILY_MIN_DAYS
});

// `contains` scans, so it is offered on free text only.
function opsFor(dimension) {
  const meta = DIMENSIONS[dimension];
  if (!meta) return [];
  return meta.contains ? ['eq', 'in', 'contains'] : ['eq', 'in'];
}

function available(dimension, source, includeDemi = false) {
  const meta = DIMENSIONS[dimension];
  if (!meta) return false;
  if (source === 'errors') return Boolean(meta.errorsColumn);
  if (!meta.sources.includes(source)) return false;
  return includeDemi ? Boolean(meta.demi) : true;
}

function columnFor(dimension, source) {
  const meta = DIMENSIONS[dimension];
  return source === 'errors' ? meta.errorsColumn : dimension;
}

// What the UI builder may offer, and nothing it may not.
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
