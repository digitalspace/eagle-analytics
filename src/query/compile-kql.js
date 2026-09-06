'use strict';

/**
 * JSON in, KQL out. The request body is the only untrusted input this service compiles, and the
 * contract is narrow on purpose: a measure, a source, dimensions, operators and a bin are all KEYS
 * into src/query/schema.js, and every value is emitted as a verbatim string literal. No column,
 * table, operator or function name can come out of a request body.
 *
 * The requested window is returned separately as the `timespan` the Log Analytics API bounds the query
 * with, so a range cannot carry syntax either. The one exception is the daily source, whose rows are
 * bounded on their own `Day` column inside the text — as this compiler's own re-normalised ISO string,
 * never the caller's.
 *
 * Output is byte-for-byte deterministic for a given input — test/query-compile.test.js compares
 * whole strings, which is the only assertion that catches an accidental change in what runs.
 */

const crypto = require('crypto');

const config = require('../config');
const schema = require('./schema');
const { bad } = require('../http/http-error');
const { hasControlCharacter, isPlainObject } = require('../utils/inputs');

const MS_PER_DAY = 86400000;

const BODY_KEYS = ['measure', 'filters', 'groupBy', 'bin', 'range', 'source', 'includeDemi', 'limit'];
const FILTER_KEYS = ['dimension', 'op', 'value'];
const RANGE_KEYS = ['from', 'to'];

/**
 * A KQL VERBATIM string literal: `@'...'` with `'` doubled.
 *
 * Verbatim and not plain `'...'` — that form honours backslash escapes, so a value ending in a
 * single backslash would escape the closing quote and let the rest of the value out as syntax. In
 * `@'...'` the doubled quote is the only escape there is, and control characters are refused by
 * `stringValue` below, so nothing can terminate the literal early.
 */
function literal(value) {
  return `@'${String(value).replace(/'/g, "''")}'`;
}

function object(value, what) {
  if (!isPlainObject(value)) throw bad(`${what} must be an object.`);
  return value;
}

function onlyKeys(value, allowed, what) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw bad(`Unknown ${what} field '${key}'.`);
  }
  return value;
}

/**
 * A filter value. Control characters are refused rather than escaped: a newline or a NUL in a metric
 * filter is never a real query, and refusing them keeps every literal on one line.
 */
function stringValue(value, dimension, op) {
  if (typeof value === 'number' && Number.isFinite(value)) value = String(value);
  if (typeof value !== 'string') throw bad(`Filter value for '${dimension}' must be a string.`);
  if (hasControlCharacter(value)) {
    throw bad(`Filter value for '${dimension}' contains a control character.`);
  }
  const max = op === 'contains' ? schema.LIMITS.maxContainsValueLength : schema.LIMITS.maxValueLength;
  if (value.length === 0) throw bad(`Filter value for '${dimension}' is empty.`);
  if (value.length > max) throw bad(`Filter value for '${dimension}' is longer than ${max} characters.`);
  return value;
}

/**
 * A workspace reference for `workspace(...)`, from configuration rather than from a request. The
 * deployed settings carry customer ids (GUIDs), which is what makes the reference unambiguous when the
 * workspace sits in another resource group.
 *
 * Still pattern-checked: a GUID, a name and a resource id are all made of these characters, and a
 * mistyped setting must fail as a 400 here rather than as whatever KQL a stray quote would make.
 */
function workspaceRef(value, envName) {
  const ref = String(value || '').trim();
  if (!ref) throw bad(`${envName} is not configured, so this measure is unavailable.`);
  if (!/^[A-Za-z0-9._/-]+$/.test(ref)) throw bad(`${envName} is not a usable workspace reference.`);
  return ref;
}

/** ISO from/to, bounded so no request can ask for a scan wider than raw retention. */
function range(value) {
  const raw = onlyKeys(object(value, 'range'), RANGE_KEYS, 'range');
  const parsed = {};
  for (const key of RANGE_KEYS) {
    if (typeof raw[key] !== 'string') throw bad(`range.${key} must be an ISO 8601 string.`);
    const at = new Date(raw[key]);
    if (Number.isNaN(at.getTime())) throw bad(`range.${key} is not a valid date.`);
    parsed[key] = at;
  }
  const spanMs = parsed.to.getTime() - parsed.from.getTime();
  if (spanMs <= 0) throw bad('range.from must be before range.to.');
  const days = spanMs / MS_PER_DAY;
  if (days > schema.LIMITS.maxRangeDays) {
    throw bad(`range must be ${schema.LIMITS.maxRangeDays} days or shorter.`);
  }
  return { from: parsed.from.toISOString(), to: parsed.to.toISOString(), days };
}

function measureName(value) {
  if (typeof value !== 'string' || !Object.hasOwn(schema.MEASURES, value)) {
    throw bad(`Unknown measure '${value}'.`);
  }
  return value;
}

function binName(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !Object.hasOwn(schema.BINS, value)) throw bad(`Unknown bin '${value}'.`);
  return value;
}

function groupByList(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw bad('groupBy must be an array.');
  if (value.length > schema.LIMITS.maxGroupBy) {
    throw bad(`groupBy takes at most ${schema.LIMITS.maxGroupBy} dimensions.`);
  }
  const seen = new Set();
  for (const dimension of value) {
    if (typeof dimension !== 'string' || !Object.hasOwn(schema.DIMENSIONS, dimension)) {
      throw bad(`Unknown dimension '${dimension}'.`);
    }
    if (seen.has(dimension)) throw bad(`groupBy repeats '${dimension}'.`);
    seen.add(dimension);
  }
  return value.slice();
}

function filterList(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw bad('filters must be an array.');
  if (value.length > schema.LIMITS.maxFilters) {
    throw bad(`filters takes at most ${schema.LIMITS.maxFilters} entries.`);
  }

  return value.map((entry) => {
    const filter = onlyKeys(object(entry, 'filter'), FILTER_KEYS, 'filter');
    const { dimension, op } = filter;

    if (typeof dimension !== 'string' || !Object.hasOwn(schema.DIMENSIONS, dimension)) {
      throw bad(`Unknown dimension '${dimension}'.`);
    }
    if (typeof op !== 'string' || !schema.opsFor(dimension).includes(op)) {
      throw bad(`Operator '${op}' is not allowed on '${dimension}'.`);
    }

    if (op === 'in') {
      if (!Array.isArray(filter.value) || filter.value.length === 0) {
        throw bad(`Filter on '${dimension}' with 'in' needs a non-empty array of values.`);
      }
      if (filter.value.length > schema.LIMITS.maxInValues) {
        throw bad(`Filter on '${dimension}' lists more than ${schema.LIMITS.maxInValues} values.`);
      }
      return { dimension, op, values: filter.value.map((one) => stringValue(one, dimension, op)) };
    }

    return { dimension, op, values: [stringValue(filter.value, dimension, op)] };
  });
}

function limitOf(value) {
  if (value === undefined || value === null) return schema.LIMITS.maxLimit;
  if (!Number.isInteger(value) || value < 1 || value > schema.LIMITS.maxLimit) {
    throw bad(`limit must be a whole number between 1 and ${schema.LIMITS.maxLimit}.`);
  }
  return value;
}

/** Everything a source has to satisfy before it can serve a request. */
function supports(source, { measure, bin, dimensions, includeDemi }) {
  if (!Object.hasOwn(schema.MEASURES[measure].aggregate, source)) return false;
  // The rollup has one row per day; an hourly bin over it would be one bucket per day, mislabelled.
  if (source === 'daily' && bin === 'hour') return false;
  return dimensions.every((dimension) => schema.available(dimension, source, includeDemi));
}

/**
 * Which table answers this request.
 *
 * `auto` reads the rollup once the range is past a month AND everything asked for exists there,
 * which is what keeps a year-long chart off a 400-day raw scan. Anything the rollup cannot serve
 * falls back to raw rather than quietly dropping a dimension.
 */
function resolveSource(requested, needs) {
  if (requested !== undefined && requested !== null && !['auto', 'raw', 'daily'].includes(requested)) {
    throw bad(`Unknown source '${requested}'.`);
  }
  const choice = requested || 'auto';

  if (needs.includeDemi) {
    if (choice === 'raw') throw bad('includeDemi reads pre-summed rollups, so source must be daily.');
    if (!supports('daily', needs)) {
      throw bad('That measure, bin or dimension is not available with includeDemi.');
    }
    return 'daily';
  }

  if (choice === 'auto') {
    if (needs.days > schema.AUTO_DAILY_MIN_DAYS && supports('daily', needs)) return 'daily';
    if (supports('raw', needs)) return 'raw';
    throw bad('That combination of measure, bin and dimensions is not available.');
  }

  if (!supports(choice, needs)) {
    throw bad(`That combination of measure, bin and dimensions is not available on source '${choice}'.`);
  }
  return choice;
}

function predicate(filter, source) {
  const column = schema.columnFor(filter.dimension, source);
  if (filter.op === 'in') return `${column} in (${filter.values.map(literal).join(', ')})`;
  if (filter.op === 'contains') return `${column} contains ${literal(filter.values[0])}`;
  return `${column} == ${literal(filter.values[0])}`;
}

/**
 * The union that adds eagle-demi. Both legs are projected to the same six columns so the summarize
 * below cannot tell them apart, and DEMI's rows are stamped with a constant SourceApp because its
 * rollup has no such column.
 */
function demiFrom() {
  const ref = workspaceRef(config.demiAuditWorkspace, 'DEMI_AUDIT_WORKSPACE');
  const day = schema.DAILY_TIME_COLUMN;
  const columns = `${day}, SourceApp, EventName, ProjectId, Events, Users`;
  return [
    'union',
    `  (${schema.SOURCES.daily} | project ${columns}),`,
    // DEMI's rollup is hourly and has no Day column, so its own bucket is folded down to one.
    `  (workspace(${literal(ref)}).${schema.DEMI_TABLE}` +
      ` | extend SourceApp = ${literal(schema.DEMI_SOURCE_APP)}, ${day} = bin(TimeGenerated, 1d)` +
      ` | project ${columns})`
  ].join('\n');
}

function tableFor(source, includeDemi) {
  if (source === 'errors') {
    const ref = workspaceRef(config.eagleLogsWorkspace, 'EAGLE_LOGS_WORKSPACE');
    return `workspace(${literal(ref)}).${schema.ERRORS_TABLE}`;
  }
  return includeDemi ? demiFrom() : schema.SOURCES[source];
}

/** The column a source's time series is read from. */
function timeColumn(source) {
  return source === 'daily' ? schema.DAILY_TIME_COLUMN : 'TimeGenerated';
}

/**
 * The window for the API to apply, which filters TimeGenerated.
 *
 * For the daily source that is not the window asked for: an imported row carries import time in
 * TimeGenerated and its real date in Day, so the end is widened by the rollup's retention — the
 * longest a row's two timestamps can be apart before the row is gone anyway. The `Day` predicate in
 * the text is what actually bounds the answer. Widened by a constant, not by "now", so a given
 * request always compiles to the same two strings.
 */
function timespanFor(source, from, to) {
  if (source !== 'daily') return `${from}/${to}`;
  const widened = new Date(Date.parse(to) + schema.DAILY_RETENTION_DAYS * MS_PER_DAY);
  return `${from}/${widened.toISOString()}`;
}

/**
 * A log-safe name for a compiled query: the shape that was asked for, plus a digest of the text so one
 * log line can be matched to the query `?debug=1` returns. The text itself never goes to a log, which
 * is read by more people than the analytics workspace — it names workspaces and tables.
 */
function summarize(kql, { measure, source, bin, dimensions }) {
  const id = crypto.createHash('sha256').update(kql).digest('hex').slice(0, 8);
  return `q=${id} measure=${measure} source=${source} bin=${bin || 'none'} ` +
    `dims=${dimensions.length ? dimensions.join(',') : 'none'}`;
}

/**
 * Compile a builder request.
 *
 * @param {object} input the request body.
 * @returns {{kql: string, timespan: string, summary: string}} `timespan` is `from/to`, which the Log
 * Analytics API applies server-side; `summary` is what may be logged in place of the query.
 */
function compile(input) {
  const body = onlyKeys(object(input, 'body'), BODY_KEYS, 'request');

  const measure = measureName(body.measure);
  const bin = binName(body.bin);
  const groupBy = groupByList(body.groupBy);
  const filters = filterList(body.filters);
  const limit = limitOf(body.limit);
  const { from, to, days } = range(body.range);

  if (body.includeDemi !== undefined && typeof body.includeDemi !== 'boolean') {
    throw bad('includeDemi must be a boolean.');
  }
  const includeDemi = Boolean(body.includeDemi);

  const dimensions = groupBy.concat(filters.map((filter) => filter.dimension));

  let source;
  if (measure === 'errors') {
    if (includeDemi) throw bad('includeDemi is not available for the errors measure.');
    if (body.source && body.source !== 'auto') {
      throw bad('The errors measure reads its own table; leave source unset.');
    }
    if (!supports('errors', { measure, bin, dimensions, includeDemi: false })) {
      throw bad('The errors measure groups and filters by source app only.');
    }
    source = 'errors';
  } else {
    if (includeDemi && !schema.DEMI_MEASURES.includes(measure)) {
      throw bad(`Measure '${measure}' is not available with includeDemi.`);
    }
    source = resolveSource(body.source, { measure, bin, dimensions, includeDemi, days });
  }

  const lines = [tableFor(source, includeDemi)];
  // The API's timespan cannot bound the rollup (see timespanFor), so the range is a predicate here.
  if (source === 'daily') {
    const day = schema.DAILY_TIME_COLUMN;
    lines.push(`| where ${day} >= todatetime(${literal(from)}) and ${day} < todatetime(${literal(to)})`);
  }
  for (const filter of filters) lines.push(`| where ${predicate(filter, source)}`);

  const by = [];
  if (bin) by.push(`t = bin(${timeColumn(source)}, ${schema.BINS[bin]})`);
  for (const dimension of groupBy) {
    const column = schema.columnFor(dimension, source);
    by.push(column === dimension ? dimension : `${dimension} = ${column}`);
  }

  const aggregate = schema.MEASURES[measure].aggregate[source];
  lines.push(`| summarize value = ${aggregate}${by.length ? ` by ${by.join(', ')}` : ''}`);

  // A binned series is read in time order; an unbinned breakdown is read biggest-first, which is
  // also what makes `limit` mean "the top N" rather than "an alphabetical prefix". Dimensions are
  // appended either way so the output never depends on how the engine happened to shuffle ties.
  const order = [];
  if (bin) order.push('t asc');
  else if (groupBy.length) order.push('value desc');
  for (const dimension of groupBy) order.push(`${dimension} asc`);
  if (order.length) lines.push(`| order by ${order.join(', ')}`);

  lines.push(`| limit ${limit}`);

  const kql = lines.join('\n');
  return {
    kql,
    timespan: timespanFor(source, from, to),
    summary: summarize(kql, { measure, source, bin, dimensions })
  };
}

module.exports = { compile };
