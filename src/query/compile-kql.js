'use strict';

// Every request field is a key into schema.js or a verbatim literal, so no KQL syntax comes from a
// body. Output must stay deterministic: test/query-compile.test.js compares whole strings.

const crypto = require('crypto');

const config = require('../config');
const schema = require('./schema');
const { bad } = require('../http/http-error');
const { hasControlCharacter, isPlainObject } = require('../utils/inputs');

const MS_PER_DAY = 86400000;

const BODY_KEYS = ['measure', 'filters', 'groupBy', 'bin', 'range', 'source', 'includeDemi', 'limit'];
const FILTER_KEYS = ['dimension', 'op', 'value'];
const RANGE_KEYS = ['from', 'to'];

// Verbatim, not plain '...': a plain literal honours backslash escapes, so a trailing `\` would
// escape the closing quote. Here the doubled quote is the only escape.
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

// Control characters are refused, not escaped: no real filter has one, and it keeps literals on one line.
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

// Plain-quoted, not literal(): the service answers workspace(@'...') with SEM0260 unknown function.
// The pattern check is what makes a plain literal safe, even though the value comes from config.
function workspaceRef(value, envName) {
  const ref = String(value || '').trim();
  if (!ref) throw bad(`${envName} is not configured, so this measure is unavailable.`);
  if (!/^[A-Za-z0-9._/-]+$/.test(ref)) throw bad(`${envName} is not a usable workspace reference.`);
  return `'${ref}'`;
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

function supports(source, { measure, bin, dimensions, includeDemi }) {
  if (!Object.hasOwn(schema.MEASURES[measure].aggregate, source)) return false;
  // The rollup has one row per day; an hourly bin over it would be one bucket per day, mislabelled.
  if (source === 'daily' && bin === 'hour') return false;
  return dimensions.every((dimension) => schema.available(dimension, source, includeDemi));
}

// `auto` reads the rollup past a month so a year-long chart skips a 400-day raw scan; anything the
// rollup cannot serve falls back to raw rather than quietly dropping a dimension.
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

// Both legs project the same columns so summarize cannot tell them apart. DEMI's rollup is hourly
// with no Day or SourceApp column, so both are made here.
function demiFrom() {
  const ref = workspaceRef(config.demiAuditWorkspace, 'DEMI_AUDIT_WORKSPACE');
  const day = schema.DAILY_TIME_COLUMN;
  const columns = `${day}, SourceApp, EventName, ProjectId, Events, Users`;
  return [
    'union',
    `  (${schema.SOURCES.daily} | project ${columns}),`,
    `  (workspace(${ref}).${schema.DEMI_TABLE}` +
      ` | extend SourceApp = ${literal(schema.DEMI_SOURCE_APP)}, ${day} = bin(TimeGenerated, 1d)` +
      ` | project ${columns})`
  ].join('\n');
}

function tableFor(source, includeDemi) {
  if (source === 'errors') {
    const ref = workspaceRef(config.eagleLogsWorkspace, 'EAGLE_LOGS_WORKSPACE');
    return `workspace(${ref}).${schema.ERRORS_TABLE}`;
  }
  return includeDemi ? demiFrom() : schema.SOURCES[source];
}

function timeColumn(source) {
  return source === 'daily' ? schema.DAILY_TIME_COLUMN : 'TimeGenerated';
}

// Imported daily rows carry import time in TimeGenerated, so the end widens by retention and the Day
// predicate bounds the answer. A constant, not "now", keeps the output deterministic.
function timespanFor(source, from, to) {
  if (source !== 'daily') return `${from}/${to}`;
  const widened = new Date(Date.parse(to) + schema.DAILY_RETENTION_DAYS * MS_PER_DAY);
  return `${from}/${widened.toISOString()}`;
}

// Log-safe stand-in for the query: the KQL names workspaces and tables and never goes to a log; the
// digest matches a log line to the `?debug=1` text.
function summarize(kql, { measure, source, bin, dimensions, includeDemi }) {
  const id = crypto.createHash('sha256').update(kql).digest('hex').slice(0, 8);
  return `q=${id} measure=${measure} source=${source} bin=${bin || 'none'} ` +
    `dims=${dimensions.length ? dimensions.join(',') : 'none'}${includeDemi ? ' demi=true' : ''}`;
}

/** @returns {{kql: string, timespan: string, summary: string}} timespan is `from/to` for the API. */
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

  // Biggest-first makes `limit` mean top N; dimensions break ties so engine order never leaks out.
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
    summary: summarize(kql, { measure, source, bin, dimensions, includeDemi })
  };
}

module.exports = { compile };
