'use strict';

// Set before src/config.js is loaded: it reads the environment once, and a non-dev ENVIRONMENT is
// refused without a gateway value. Env also proves the label reaches the row.
process.env.ENVIRONMENT = 'test';
process.env.KEYCLOAK_ALLOWED_CLIENTS = 'eagle-admin-console';
process.env.ANALYTICS_WORKSPACE_CUSTOMER_ID = 'e1d4a0b2-test-workspace';
process.env.APIM_SHARED_HEADER_VALUE = 'gateway-value-for-tests';
process.env.AUDIT_SHARED_HEADER_VALUE = 'audit-value-for-tests';

const assert = require('node:assert');
const { test } = require('node:test');

const { LIMITS, toEventRow, validateAuditBatch, validateEventBatch } = require('../src/ingest/validate');

const MINUTE_MS = 60000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** Relative to now, not a fixed date: the accepted window is now-2d to now+5min. */
const at = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();

const EVENT = Object.freeze({
  timestamp: at(0),
  eventType: 'Page Viewed',
  sessionId: 'session-1',
  sourceApp: 'eagle-public'
});

const AUDIT_ROW = Object.freeze({
  action: 'project.updated',
  sourceApp: 'eagle-demi'
});

function events(...overrides) {
  return { events: overrides.map((override) => ({ ...EVENT, ...override })) };
}

/** The first thing wrong with a batch, whether that was the envelope or one of its entries. */
function firstError(result) {
  return result.invalid ? result.invalid.errors[0] : result.rejected[0].error;
}

// Each capped string field, at its bound and one over. sourceApp is checked separately: it also has
// to be in the allow-list, so an over-long value can never be a valid one.
const BOUNDS = [
  { field: 'eventType', max: LIMITS.eventType },
  { field: 'sessionId', max: LIMITS.sessionId },
  { field: 'userId', max: LIMITS.userId }
];

for (const { field, max } of BOUNDS) {
  test(`${field} is accepted at ${max} characters`, () => {
    const value = 'x'.repeat(max);
    const result = validateEventBatch(events({ [field]: value }));
    assert.strictEqual(result.entries[0][field], value);
  });

  test(`${field} is rejected at ${max + 1} characters`, () => {
    const result = validateEventBatch(events({ [field]: 'x'.repeat(max + 1) }));
    assert.strictEqual(firstError(result), `${field} must be a string with max ${max} characters`);
  });
}

test('userId is optional', () => {
  const result = validateEventBatch(events({}));
  assert.strictEqual(result.entries[0].userId, '');
});

test('an over-long sourceApp is reported as a length problem, not an unknown app', () => {
  const result = validateEventBatch(events({ sourceApp: 'x'.repeat(LIMITS.sourceApp + 1) }));
  assert.strictEqual(
    firstError(result),
    `sourceApp must be a string with max ${LIMITS.sourceApp} characters`
  );
});

test('a sourceApp outside the allow-list is rejected', () => {
  const result = validateEventBatch(events({ sourceApp: 'eagle-publik' }));
  assert.match(firstError(result), /^sourceApp must be one of eagle-public, /);
});

const REQUIRED = ['timestamp', 'eventType', 'sessionId', 'sourceApp'];

for (const field of REQUIRED) {
  test(`${field} is required`, () => {
    const result = validateEventBatch(events({ [field]: undefined }));
    assert.strictEqual(firstError(result), `${field} is required`);
  });
}

test('a timestamp Date.parse tolerates but ISO 8601 does not is rejected', () => {
  const result = validateEventBatch(events({ timestamp: 'September 5 2026' }));
  assert.strictEqual(firstError(result), 'timestamp must be a valid ISO 8601 date string');
});

test('a timestamp with an offset is normalised to UTC', () => {
  const instant = new Date();
  // The same instant written as a Berlin wall-clock time, so the offset has to be applied.
  const berlin = new Date(instant.getTime() + 2 * 3600000).toISOString().replace('Z', '+02:00');
  const result = validateEventBatch(events({ timestamp: berlin }));
  assert.strictEqual(result.entries[0].timestamp, instant.toISOString());
});

// The window the ingestion API stores verbatim. Outside it a row lands on the wrong day, silently.
const WINDOW_MESSAGE =
  'timestamp must be no more than 5 minutes ahead of now and no more than 2 days old';

test('an event 4 minutes ahead of the server is accepted', () => {
  const result = validateEventBatch(events({ timestamp: at(4 * MINUTE_MS) }));
  assert.strictEqual(result.rejected.length, 0);
});

test('an event 6 minutes ahead of the server is rejected', () => {
  const result = validateEventBatch(events({ timestamp: at(6 * MINUTE_MS) }));
  assert.strictEqual(firstError(result), WINDOW_MESSAGE);
});

test('an event from yesterday is accepted', () => {
  const result = validateEventBatch(events({ timestamp: at(-DAY_MS) }));
  assert.strictEqual(result.rejected.length, 0);
});

test('an event older than two days is rejected rather than restamped on ingestion', () => {
  const result = validateEventBatch(events({ timestamp: at(-2 * DAY_MS - MINUTE_MS) }));
  assert.strictEqual(firstError(result), WINDOW_MESSAGE);
});

test('a server-side producer may omit sessionId, and the column is stored empty', () => {
  const result = validateEventBatch({
    events: [{ ...EVENT, sourceApp: 'eagle-api', sessionId: undefined }]
  });
  assert.strictEqual(result.rejected.length, 0);
  assert.strictEqual(result.entries[0].sessionId, '');
});

test('a browser producer still needs a sessionId', () => {
  const result = validateEventBatch(events({ sourceApp: 'eagle-public', sessionId: undefined }));
  assert.strictEqual(firstError(result), 'sessionId is required');
});

test('a __proto__ property never reaches the prototype of a cleaned object', () => {
  const properties = JSON.parse('{"__proto__": {"polluted": true}, "path": "/p/1"}');
  const result = validateEventBatch(events({ properties }));
  assert.strictEqual(result.rejected.length, 0);
  assert.strictEqual(Object.getPrototypeOf(result.entries[0].properties), Object.prototype);
  assert.strictEqual({}.polluted, undefined);
});

// JSON.stringify({ a: 'x'.repeat(n) }) is n + 8 bytes: the key, the quotes and the braces.
const PROPERTY_FILLER = LIMITS.detailBytes - 8;

test(`properties are accepted at ${LIMITS.detailBytes} serialized bytes`, () => {
  const result = validateEventBatch(events({ properties: { a: 'x'.repeat(PROPERTY_FILLER) } }));
  assert.strictEqual(result.entries[0].properties.a.length, PROPERTY_FILLER);
});

test(`properties are rejected at ${LIMITS.detailBytes + 1} serialized bytes`, () => {
  const result = validateEventBatch(events({ properties: { a: 'x'.repeat(PROPERTY_FILLER + 1) } }));
  assert.strictEqual(
    firstError(result),
    `properties must be <= ${LIMITS.detailBytes} bytes when serialized`
  );
});

test('properties that are not an object are rejected', () => {
  const result = validateEventBatch(events({ properties: ['path'] }));
  assert.strictEqual(firstError(result), 'properties must be an object');
});

test('a batch is accepted at 50 events', () => {
  const result = validateEventBatch(events(...Array.from({ length: LIMITS.batch }, () => ({}))));
  assert.strictEqual(result.entries.length, LIMITS.batch);
});

test('a batch is rejected at 51 events', () => {
  const result = validateEventBatch(events(...Array.from({ length: LIMITS.batch + 1 }, () => ({}))));
  assert.strictEqual(firstError(result), `events must contain at most ${LIMITS.batch} entries`);
});

test('one invalid event is rejected on its own, and the rest of the batch is kept', () => {
  const result = validateEventBatch(events({}, {}, { eventType: '' }));
  assert.strictEqual(result.entries.length, 2);
  assert.deepStrictEqual(result.rejected, [{ index: 2, error: 'eventType is required' }]);
});

test('a batch of nothing but bad events reports every index', () => {
  const result = validateEventBatch(events({ eventType: '' }, { sourceApp: 'nope' }));
  assert.strictEqual(result.entries.length, 0);
  assert.deepStrictEqual(result.rejected.map((entry) => entry.index), [0, 1]);
});

test('a batch-level problem reports no index', () => {
  const result = validateEventBatch({ events: [] });
  assert.strictEqual(result.invalid.index, null);
});

test('a body without an events array is rejected', () => {
  const result = validateEventBatch({ event: EVENT });
  assert.strictEqual(firstError(result), 'body must contain an array of events');
});

test('an event row carries the environment label', () => {
  const row = toEventRow(validateEventBatch(events({})).entries[0]);
  assert.strictEqual(row.Env, 'test');
});

test('Page comes from the path property', () => {
  const properties = { path: '/p/123', url: 'https://projects.example.invalid/p/123?q=dam' };
  const row = toEventRow(validateEventBatch(events({ properties })).entries[0]);
  assert.strictEqual(row.Page, '/p/123');
});

test('Page falls back to the url when no path was sent', () => {
  const properties = { url: 'https://projects.example.invalid/p/123' };
  const row = toEventRow(validateEventBatch(events({ properties })).entries[0]);
  assert.strictEqual(row.Page, 'https://projects.example.invalid/p/123');
});

test(`Page is truncated at ${LIMITS.columnText} characters`, () => {
  const path = `/p/${'x'.repeat(LIMITS.columnText)}`;
  const row = toEventRow(validateEventBatch(events({ properties: { path } })).entries[0]);
  assert.strictEqual(row.Page.length, LIMITS.columnText);
});

test('promoted properties get their own column', () => {
  const properties = {
    referrer: 'https://www.google.com/',
    project_id: '58851197aaecd9001b8227cc',
    document_id: '5cf00c03a266b7e1877504db',
    duration_ms: 1200.5
  };
  const row = toEventRow(validateEventBatch(events({ properties })).entries[0]);
  assert.deepStrictEqual(
    {
      Referrer: row.Referrer,
      ProjectId: row.ProjectId,
      DocumentId: row.DocumentId,
      DurationMs: row.DurationMs
    },
    {
      Referrer: 'https://www.google.com/',
      ProjectId: '58851197aaecd9001b8227cc',
      DocumentId: '5cf00c03a266b7e1877504db',
      DurationMs: 1200.5
    }
  );
});

test('a promoted property is not repeated in Detail', () => {
  const properties = { path: '/p/123', document_name: 'Application.pdf' };
  const row = toEventRow(validateEventBatch(events({ properties })).entries[0]);
  assert.deepStrictEqual(row.Detail, { document_name: 'Application.pdf' });
});

test('DurationMs is left out rather than sent empty', () => {
  const row = toEventRow(validateEventBatch(events({})).entries[0]);
  assert.ok(!('DurationMs' in row));
});

test('an audit row needs an action', () => {
  const result = validateAuditBatch({ rows: [{ sourceApp: 'eagle-demi' }] });
  assert.strictEqual(firstError(result), 'action is required');
});

test('an audit row needs a sourceApp, which is what lets one table serve every app', () => {
  const result = validateAuditBatch({ rows: [{ action: 'project.updated' }] });
  assert.strictEqual(firstError(result), 'sourceApp is required');
});

test('an audit row gets an EventId when the producer sent none', () => {
  const result = validateAuditBatch({ rows: [{ ...AUDIT_ROW }] });
  assert.match(result.entries[0].EventId, /^[0-9a-f-]{36}$/);
});

test('an audit row keeps the EventId the producer sent, so a retry is identifiable', () => {
  const eventId = 'e6f2a0d4-1111-4222-8333-444455556666';
  const result = validateAuditBatch({ rows: [{ ...AUDIT_ROW, eventId }] });
  assert.strictEqual(result.entries[0].EventId, eventId);
});

test('an audit row defaults to a successful outcome', () => {
  const result = validateAuditBatch({ rows: [{ ...AUDIT_ROW }] });
  assert.strictEqual(result.entries[0].Outcome, 'success');
});

test('audit actor roles sent as an array become the comma-separated column', () => {
  const result = validateAuditBatch({ rows: [{ ...AUDIT_ROW, actorRoles: ['sysadmin', 'staff'] }] });
  assert.strictEqual(result.entries[0].ActorRoles, 'sysadmin,staff');
});

test('an audit row without a timestamp is stamped on arrival', () => {
  const result = validateAuditBatch({ rows: [{ ...AUDIT_ROW }] });
  assert.ok(!Number.isNaN(Date.parse(result.entries[0].TimeGenerated)));
});

test('an audit detail over the byte ceiling is rejected', () => {
  const detail = { a: 'x'.repeat(PROPERTY_FILLER + 1) };
  const result = validateAuditBatch({ rows: [{ ...AUDIT_ROW, detail }] });
  assert.strictEqual(
    firstError(result),
    `detail must be <= ${LIMITS.detailBytes} bytes when serialized`
  );
});

test('an audit row outside the ingestion window keeps the row, on server time', () => {
  const result = validateAuditBatch({ rows: [{ ...AUDIT_ROW, timestamp: at(-30 * DAY_MS) }] });
  assert.strictEqual(result.rejected.length, 0);
  assert.ok(Date.parse(result.entries[0].TimeGenerated) > Date.now() - MINUTE_MS);
});

test('an audit row with an unparseable timestamp is still rejected', () => {
  const result = validateAuditBatch({ rows: [{ ...AUDIT_ROW, timestamp: 'last tuesday' }] });
  assert.strictEqual(firstError(result), 'timestamp must be a valid ISO 8601 date string');
});

test('one bad audit row does not cost the rows around it', () => {
  const result = validateAuditBatch({ rows: [{ ...AUDIT_ROW }, { sourceApp: 'eagle-demi' }] });
  assert.strictEqual(result.entries.length, 1);
  assert.deepStrictEqual(result.rejected, [{ index: 1, error: 'action is required' }]);
});

test('an audit row never takes SourceIp from the body', () => {
  const result = validateAuditBatch({ rows: [{ ...AUDIT_ROW, SourceIp: '8.8.8.8', sourceIp: '8.8.8.8' }] });
  assert.ok(!('SourceIp' in result.entries[0]));
});
