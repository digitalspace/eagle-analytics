'use strict';

/**
 * Every limit the ingest endpoints enforce, and the mapping from a producer's JSON onto a table row.
 *
 * The event caps are ported from penguin-analytics (src/routes/events.js), so a producer that was
 * accepted there is accepted here. Two deliberate differences: sourceApp is checked against an
 * allow-list, and a timestamp has to actually look like ISO 8601 rather than merely be something
 * Date.parse tolerates — the column it lands in is a datetime, and 'next tuesday' parses.
 *
 * A bad entry is rejected on its own and the rest of the batch is accepted, so a producer knows
 * exactly which events it still holds and its retry duplicates nothing.
 */

const crypto = require('crypto');

const config = require('../config');
const { isPlainObject, safeEntries } = require('../utils/inputs');
const { logger } = require('../utils/logger');

const LIMITS = Object.freeze({
  batch: 50,
  eventType: 100,
  sessionId: 255,
  sourceApp: 50,
  userId: 255,
  auditField: 255,
  detailBytes: 8000,
  // Page holds a URL, and a producer that builds one in a loop can offer kilobytes of it. The column
  // is grouped by in every chart, where anything past this is already unreadable.
  columnText: 2048
});

/** Producers with no browser session, so no sessionId to require. */
const SERVER_SOURCE_APPS = Object.freeze(['eagle-api', 'eagle-demi']);

// The window the Logs Ingestion API stores verbatim: it rewrites TimeGenerated more than two days
// old to ingestion time, which would silently move an event to the wrong day.
const MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;

/** Tolerance for a client clock running fast. Anything past it is a bad clock or a made-up date. */
const MAX_FUTURE_MS = 5 * 60 * 1000;

/** Properties that get a column of their own; whatever is left over becomes Detail. */
const PROMOTED_PROPERTIES = Object.freeze([
  'path',
  'url',
  'referrer',
  'project_id',
  'document_id',
  'duration_ms'
]);

// Date, time, optional seconds and fraction, optional zone. Anything else is a producer bug.
const ISO_8601 = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,7})?)?(Z|[+-]\d{2}:?\d{2})?$/;

/** A promoted column value: strings and numbers only, never an object rendered as [object Object]. */
function columnText(value) {
  if (typeof value === 'string') return value.trim().slice(0, LIMITS.columnText);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/**
 * A trimmed string within its cap. Absent and over-long share one message on purpose: the caller
 * needs to know which field to fix, not which of two ways it was wrong.
 */
function stringField(errors, raw, field, max, required) {
  const value = typeof raw === 'string' ? raw.trim() : raw;
  if (value === undefined || value === null || value === '') {
    if (required) errors.push(`${field} is required`);
    return '';
  }
  if (typeof value !== 'string' || value.length > max) {
    errors.push(`${field} must be a string with max ${max} characters`);
    return '';
  }
  return value;
}

/** An ISO 8601 instant, normalised to UTC so the column holds one format. */
function timestampField(errors, raw, field) {
  const value = stringField(errors, raw, field, 40, true);
  if (!value) return '';
  if (!ISO_8601.test(value) || Number.isNaN(Date.parse(value))) {
    errors.push(`${field} must be a valid ISO 8601 date string`);
    return '';
  }
  return new Date(value).toISOString();
}

/** Whether an instant is one the ingestion API will store as sent. */
function inIngestionWindow(iso) {
  const at = Date.parse(iso);
  const now = Date.now();
  return at <= now + MAX_FUTURE_MS && at >= now - MAX_AGE_MS;
}

const OUT_OF_WINDOW = 'timestamp must be no more than 5 minutes ahead of now and no more than 2 days old';

/**
 * A JSON object under the serialised byte ceiling. The ceiling is what keeps one producer from
 * turning a per-GB bill into an incident, and it is measured after undefined values are dropped
 * because that is what will be sent.
 */
function detailField(errors, raw, field) {
  if (raw === undefined || raw === null) return {};
  if (!isPlainObject(raw)) {
    errors.push(`${field} must be an object`);
    return {};
  }

  const cleaned = {};
  for (const [key, value] of safeEntries(raw)) {
    if (value !== undefined) cleaned[key] = value;
  }

  let serialized;
  try {
    serialized = JSON.stringify(cleaned);
  } catch {
    // Circular references and BigInt. Caught here rather than at the writer, which cannot answer
    // the caller.
    errors.push(`${field} must be JSON serializable`);
    return {};
  }

  if (Buffer.byteLength(serialized, 'utf8') > LIMITS.detailBytes) {
    errors.push(`${field} must be <= ${LIMITS.detailBytes} bytes when serialized`);
    return {};
  }

  return cleaned;
}

function normalizeEvent(raw) {
  const errors = [];
  if (!isPlainObject(raw)) return { errors: ['event must be an object'] };

  const sourceApp = stringField(errors, raw.sourceApp, 'sourceApp', LIMITS.sourceApp, true);

  const event = {
    timestamp: timestampField(errors, raw.timestamp, 'timestamp'),
    eventType: stringField(errors, raw.eventType, 'eventType', LIMITS.eventType, true),
    sessionId: stringField(errors, raw.sessionId, 'sessionId', LIMITS.sessionId,
      !SERVER_SOURCE_APPS.includes(sourceApp)),
    sourceApp,
    userId: stringField(errors, raw.userId, 'userId', LIMITS.userId, false),
    properties: detailField(errors, raw.properties, 'properties')
  };

  if (event.timestamp && !inIngestionWindow(event.timestamp)) errors.push(OUT_OF_WINDOW);

  if (event.sourceApp && !config.allowedSourceApps.includes(event.sourceApp)) {
    errors.push(`sourceApp must be one of ${config.allowedSourceApps.join(', ')}`);
  }

  return { errors, event };
}

/**
 * Shared by both endpoints: same envelope, same caps, same per-entry answer. An envelope problem is
 * the whole request's; a bad entry costs only itself.
 */
function validateBatch(rows, field, normalize) {
  if (!Array.isArray(rows)) {
    return { invalid: { index: null, errors: [`body must contain an array of ${field}`] } };
  }
  if (rows.length === 0) {
    return { invalid: { index: null, errors: [`${field} must contain at least one entry`] } };
  }
  if (rows.length > LIMITS.batch) {
    return { invalid: { index: null, errors: [`${field} must contain at most ${LIMITS.batch} entries`] } };
  }

  const entries = [];
  const rejected = [];
  for (let index = 0; index < rows.length; index += 1) {
    const { errors, entry } = normalize(rows[index]);
    if (errors.length > 0) rejected.push({ index, error: errors.join('; ') });
    else entries.push(entry);
  }
  return { entries, rejected };
}

/**
 * @returns {{entries: object[], rejected: {index: number, error: string}[]}|{invalid: {index: null,
 * errors: string[]}}} the events that validated and the index of each that did not, or a single
 * envelope problem that means there is no batch to read at all.
 */
function validateEventBatch(body) {
  const rows = isPlainObject(body) ? body.events : undefined;
  return validateBatch(rows, 'events', (raw) => {
    const { errors, event } = normalizeEvent(raw);
    return { errors, entry: event };
  });
}

/** A normalised event as an EagleEvents_CL row. Enrichment adds the rest of the columns. */
function toEventRow(event) {
  const properties = event.properties;

  const detail = {};
  for (const [key, value] of safeEntries(properties)) {
    if (!PROMOTED_PROPERTIES.includes(key)) detail[key] = value;
  }

  const row = {
    TimeGenerated: event.timestamp,
    EventName: event.eventType,
    SourceApp: event.sourceApp,
    SessionId: event.sessionId,
    UserId: event.userId,
    // path is what the client sends on every event; url only under enhanced tracking, and it carries
    // the query string, so it is the fallback rather than the first choice.
    Page: columnText(properties.path) || columnText(properties.url),
    Referrer: columnText(properties.referrer),
    ProjectId: columnText(properties.project_id),
    DocumentId: columnText(properties.document_id),
    Env: config.environmentName,
    Detail: detail
  };

  // Numeric columns are left out when absent rather than sent as null: ingest is billed by the byte.
  const duration = Number(properties.duration_ms);
  if (properties.duration_ms !== undefined && Number.isFinite(duration)) row.DurationMs = duration;

  return row;
}

/**
 * An EagleAudit_CL row from a server-side producer. Columns are eagle-demi's audit set
 * (azure/modules/event-logs.bicep) plus SourceApp, which is what makes one table serve every app.
 *
 * SourceIp is not read from the body — the caller does not get to say where it called from. The
 * controller fills it from the connection and the DCR transform masks it.
 */
/**
 * An audit row's instant. Optional: a producer that generates its own can identify a retried batch as
 * the same event. Out of the ingestion window it is replaced rather than refused, because a row the
 * ingestion API would move to a wrong day is still a row an audit trail has to keep.
 */
function auditTime(errors, raw) {
  const serverTime = new Date().toISOString();
  if (raw === undefined || raw === null) return serverTime;

  const given = timestampField(errors, raw, 'timestamp');
  if (!given) return serverTime;
  if (inIngestionWindow(given)) return given;

  logger.warn(`[analytics] audit row timestamp ${given} is outside the ingestion window; ` +
    'the row is stamped with server time.');
  return serverTime;
}

function normalizeAuditRow(raw) {
  const errors = [];
  if (!isPlainObject(raw)) return { errors: ['row must be an object'] };

  const max = LIMITS.auditField;
  const text = (field, required) => stringField(errors, raw[field], field, max, required);

  // Producers may send roles either way; the column is a comma-separated string.
  const roles = Array.isArray(raw.actorRoles) ? raw.actorRoles.join(',') : raw.actorRoles;

  const row = {
    TimeGenerated: auditTime(errors, raw.timestamp),
    EventId: text('eventId', false) || crypto.randomUUID(),
    Action: text('action', true),
    Outcome: text('outcome', false) || 'success',
    ActorId: text('actorId', false),
    ActorName: text('actorName', false),
    ActorType: text('actorType', false),
    ActorRoles: stringField(errors, roles, 'actorRoles', max, false),
    SourceApp: text('sourceApp', true),
    TargetType: text('targetType', false),
    TargetId: text('targetId', false),
    ProjectId: text('projectId', false),
    CorrelationId: text('correlationId', false),
    Env: config.environmentName,
    Detail: detailField(errors, raw.detail, 'detail')
  };

  if (row.SourceApp && !config.allowedSourceApps.includes(row.SourceApp)) {
    errors.push(`sourceApp must be one of ${config.allowedSourceApps.join(', ')}`);
  }

  return { errors, row };
}

function validateAuditBatch(body) {
  const rows = isPlainObject(body) ? body.rows : undefined;
  return validateBatch(rows, 'rows', (raw) => {
    const { errors, row } = normalizeAuditRow(raw);
    return { errors, entry: row };
  });
}

module.exports = {
  validateEventBatch,
  validateAuditBatch,
  toEventRow,
  LIMITS
};
