'use strict';

// Set before src/config.js loads, which happens on the first require below. These are the settings a
// deployed instance has, so the guards are on and rows really reach the writer.
process.env.ENVIRONMENT = 'test';
process.env.KEYCLOAK_ALLOWED_CLIENTS = 'eagle-admin-console';
process.env.ANALYTICS_WORKSPACE_CUSTOMER_ID = 'e1d4a0b2-test-workspace';
process.env.EVENTS_DCR_ENDPOINT = 'https://dcr.example.invalid';
process.env.EVENTS_DCR_IMMUTABLE_ID = 'dcr-test';
process.env.APIM_SHARED_HEADER_VALUE = 'gateway-value-for-tests';
process.env.AUDIT_SHARED_HEADER_VALUE = 'audit-value-for-tests';
process.env.ALLOWED_ORIGINS = 'https://eagle-public-test.example.invalid,http://localhost:4200';
process.env.SESSION_EVENT_CAP = '2';
process.env.IP_EVENT_CAP = '3';
// Two of the four addresses the OpenShift cluster calls out from, as deployed.
process.env.TRUSTED_PROXY_IPS = '142.34.194.121,142.34.194.122';

const assert = require('node:assert');
const { test, beforeEach } = require('node:test');

const { dispatch } = require('../src/http/router');
const writer = require('../src/ingest/dcr-writer');
const geo = require('../src/ingest/enrich-geo');
const ipCap = require('../src/ingest/ip-cap');
const sessionCap = require('../src/ingest/session-cap');

const GATEWAY = { 'x-analytics-gateway': 'gateway-value-for-tests' };
const AUDIT_HEADER = { 'x-analytics-audit': 'audit-value-for-tests' };
const ORIGIN = { origin: 'https://eagle-public-test.example.invalid' };

// The proxy in front of this app appends the hop it saw, so the client address is the RIGHT-most
// entry; everything to its left is what the caller sent.
const CLIENT = { 'x-forwarded-for': '10.0.0.5, 24.108.0.1' };

// What the real chain puts on a request: the cluster's egress address in X-Client-Ip, stamped by
// demi-apim-<env>, and APIM's own outbound hop appended after the visitor's by the Functions front
// end. A browser is the hop before that one; a server producer has no hop of its own.
const CLUSTER = '142.34.194.121';
const APIM_HOP = '20.104.10.20';

const throughCluster = (visitor) => ({
  'x-forwarded-for': visitor ? `${visitor}, ${APIM_HOP}` : APIM_HOP,
  'x-client-ip': CLUSTER
});

// Every case here posts to /events, and a request with no X-Forwarded-For shares one `unknown` bucket
// with every other, so without this the cap one case fills is charged to the next.
beforeEach(() => ipCap._reset());

/**
 * The shape the Functions host hands the dispatcher. Content-Length is filled in the way the gateway
 * fills it; `declareLength: false` is the request that arrives without one.
 */
function request(method, path, { headers = {}, body, declareLength = true } = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const all = {
    ...(body !== undefined && declareLength ? { 'content-length': String(Buffer.byteLength(payload)) } : {}),
    ...headers
  };
  return {
    method,
    url: `https://analytics-api-fc-test.azurewebsites.net${path}`,
    headers: new Map(Object.entries(all)),
    arrayBuffer: async () => Buffer.from(payload)
  };
}

async function call(method, path, options) {
  const response = await dispatch(request(method, path, options));
  return {
    status: response.status,
    headers: response.headers,
    body: response.body ? JSON.parse(response.body) : undefined
  };
}

/**
 * Collect what the writer actually sends. The transport is the seam the writer already has, so these
 * cases go through the real enqueue and batching rather than a stand-in for them.
 */
function recordRows(t) {
  const sent = [];
  writer._setTransport(async (stream, rows) => { sent.push(...rows.map((row) => ({ stream, row }))); });
  t.after(async () => {
    await writer.flush();
    writer._resetTransport();
  });
  return sent;
}

/** Now, not a fixed date: an event older than two days is refused (src/ingest/validate.js). */
const NOW = new Date().toISOString();

function event(overrides) {
  return {
    timestamp: NOW,
    eventType: 'Page Viewed',
    sessionId: 'session-1',
    sourceApp: 'eagle-public',
    ...overrides
  };
}

test('an event batch arriving without the gateway header is refused', async () => {
  const response = await call('POST', '/analytics/events', { body: { events: [event()] } });
  assert.strictEqual(response.status, 401);
});

test('a batch through the gateway is accepted, and reports what it took', async (t) => {
  recordRows(t);
  geo._setReader(null);
  t.after(() => geo._reset());
  sessionCap._reset();
  t.after(() => sessionCap._reset());

  const events = [
    event({ sessionId: 'accepted-session', properties: { path: '/projects' } }),
    event({ sessionId: 'accepted-session', eventType: 'Project Viewed' })
  ];
  const response = await call('POST', '/analytics/events', { headers: GATEWAY, body: { events } });

  assert.deepStrictEqual(
    { status: response.status, body: response.body },
    { status: 202, body: { accepted: 2, dropped: 0, rejected: [] } }
  );
});

test('the endpoint is served at the root as well as under /analytics', async (t) => {
  recordRows(t);
  geo._setReader(null);
  t.after(() => geo._reset());

  const body = { events: [event({ sessionId: 'root-mounted-session' })] };
  const response = await call('POST', '/events', { headers: GATEWAY, body });

  assert.strictEqual(response.status, 202);
});

test('an accepted event reaches the writer as a table row', async (t) => {
  const sent = recordRows(t);
  geo._setReader(null);
  t.after(() => geo._reset());

  const properties = {
    path: '/p/58851197aaecd9001b8227cc',
    project_id: '58851197aaecd9001b8227cc',
    user_agent: 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
    screen_width: 1920,
    screen_height: 1080,
    document_name: 'Application.pdf'
  };
  const body = { events: [event({ sessionId: 'row-shape-session', properties })] };
  await call('POST', '/analytics/events', { headers: { ...GATEWAY, ...CLIENT }, body });
  await writer.flush();

  const { stream, row } = sent[0];
  assert.strictEqual(stream, writer.EVENTS_STREAM);
  assert.deepStrictEqual(row, {
    TimeGenerated: NOW,
    EventName: 'Page Viewed',
    SourceApp: 'eagle-public',
    SessionId: 'row-shape-session',
    UserId: '',
    Page: '/p/58851197aaecd9001b8227cc',
    Referrer: '',
    ProjectId: '58851197aaecd9001b8227cc',
    DocumentId: '',
    Env: 'test',
    Detail: { document_name: 'Application.pdf' },
    DeviceType: 'desktop',
    Browser: 'Firefox',
    ScreenW: 1920,
    ScreenH: 1080
  });
});

test('an accepted event carries the location its address resolved to, never the address', async (t) => {
  const sent = recordRows(t);
  geo._setReader({
    get: () => ({
      country: { iso_code: 'CA' },
      subdivisions: [{ iso_code: 'BC' }],
      city: { names: { en: 'Victoria' } }
    })
  });
  t.after(() => geo._reset());

  const body = { events: [event({ sessionId: 'located-session' })] };
  await call('POST', '/analytics/events', { headers: { ...GATEWAY, ...CLIENT }, body });
  await writer.flush();

  const { row } = sent[0];
  assert.deepStrictEqual({ Country: row.Country, Region: row.Region, City: row.City }, {
    Country: 'CA',
    Region: 'BC',
    City: 'Victoria'
  });
  assert.doesNotMatch(JSON.stringify(row), /24\.108\.0\.1/);
});

test('one invalid event is reported and the rest of the batch is still taken', async (t) => {
  recordRows(t);
  geo._setReader(null);
  t.after(() => geo._reset());
  sessionCap._reset();
  t.after(() => sessionCap._reset());

  const events = [event({ sessionId: 'mixed-batch' }), event({ sourceApp: 'not-an-epic-app' })];
  const response = await call('POST', '/analytics/events', { headers: GATEWAY, body: { events } });

  assert.strictEqual(response.status, 202);
  assert.strictEqual(response.body.accepted, 1);
  assert.strictEqual(response.body.rejected[0].index, 1);
});

test('a batch with nothing valid in it is a 400', async (t) => {
  recordRows(t);
  geo._setReader(null);
  t.after(() => geo._reset());

  const events = [event({ sourceApp: 'not-an-epic-app' })];
  const response = await call('POST', '/analytics/events', { headers: GATEWAY, body: { events } });

  assert.strictEqual(response.status, 400);
  assert.strictEqual(response.body.rejected.length, 1);
});

test('a batch from a page EPIC published is accepted', async (t) => {
  recordRows(t);
  geo._setReader(null);
  t.after(() => geo._reset());
  sessionCap._reset();
  t.after(() => sessionCap._reset());

  const body = { events: [event({ sessionId: 'allowed-origin-session' })] };
  const response = await call('POST', '/analytics/events', {
    headers: { ...GATEWAY, ...ORIGIN },
    body
  });

  assert.strictEqual(response.status, 202);
});

test('a batch from somebody else\'s page is refused', async (t) => {
  recordRows(t);

  const body = { events: [event()] };
  const response = await call('POST', '/analytics/events', {
    headers: { ...GATEWAY, origin: 'https://not-ours.example.invalid' },
    body
  });

  assert.strictEqual(response.status, 403);
});

// A server-side producer sends no Origin, and it is the header's absence that identifies it.
test('a batch with no Origin at all is accepted', async (t) => {
  recordRows(t);
  geo._setReader(null);
  t.after(() => geo._reset());
  sessionCap._reset();
  t.after(() => sessionCap._reset());

  const body = { events: [event({ sourceApp: 'eagle-api', sessionId: undefined })] };
  const response = await call('POST', '/analytics/events', { headers: GATEWAY, body });

  assert.strictEqual(response.status, 202);
  assert.strictEqual(response.body.accepted, 1);
});

test('a body route that declares no length is refused before it is read', async (t) => {
  recordRows(t);

  const response = await call('POST', '/analytics/events', {
    headers: GATEWAY,
    body: { events: [event()] },
    declareLength: false
  });

  assert.strictEqual(response.status, 411);
});

test('events past the session cap are dropped and counted, not refused', async (t) => {
  recordRows(t);
  geo._setReader(null);
  t.after(() => geo._reset());
  sessionCap._reset();
  t.after(() => sessionCap._reset());

  // SESSION_EVENT_CAP is 2 above.
  const events = [event(), event(), event()].map((one) => ({ ...one, sessionId: 'capped-session' }));
  const response = await call('POST', '/analytics/events', { headers: GATEWAY, body: { events } });

  assert.deepStrictEqual(
    { status: response.status, body: response.body },
    { status: 202, body: { accepted: 2, dropped: 1, rejected: [] } }
  );
});

test('a batch past the per-address cap is refused with a Retry-After', async (t) => {
  recordRows(t);
  geo._setReader(null);
  t.after(() => geo._reset());

  // Its own address, so this case does not spend the budget the cases above use.
  const from = { 'x-forwarded-for': '198.51.100.7' };
  // IP_EVENT_CAP is 3 above; one session each, so the per-session cap is not what answers here.
  const filling = [0, 1, 2].map((n) => event({ sessionId: `burst-${n}` }));

  const first = await call('POST', '/analytics/events', {
    headers: { ...GATEWAY, ...from },
    body: { events: filling }
  });
  const second = await call('POST', '/analytics/events', {
    headers: { ...GATEWAY, ...from },
    body: { events: [event({ sessionId: 'burst-3' })] }
  });

  assert.deepStrictEqual(
    { first: first.status, second: second.status, retryAfter: second.headers['retry-after'] },
    { first: 202, second: 429, retryAfter: '60' }
  );
});

// eagle-api reaches APIM from the cluster's egress pool, which every browser behind the same cluster
// also comes out of. Capping that one address refused eagle-api's batches on prod.
test('a server producer behind the cluster is not capped by address', async (t) => {
  recordRows(t);
  geo._setReader(null);
  t.after(() => geo._reset());
  sessionCap._reset();
  t.after(() => sessionCap._reset());

  // IP_EVENT_CAP is 3 above, so a capped caller would be refused from the fourth event on.
  const answers = [];
  for (const n of [0, 1, 2, 3, 4]) {
    const body = { events: [event({ sourceApp: 'eagle-api', sessionId: `server-${n}` })] };
    const response = await call('POST', '/analytics/events', {
      headers: { ...GATEWAY, ...throughCluster(null) },
      body
    });
    answers.push(response.status);
  }

  assert.deepStrictEqual(answers, [202, 202, 202, 202, 202]);
});

test('two browsers behind the cluster get a budget each', async (t) => {
  recordRows(t);
  geo._setReader(null);
  t.after(() => geo._reset());
  sessionCap._reset();
  t.after(() => sessionCap._reset());

  const filling = [0, 1, 2].map((n) => event({ sessionId: `busy-visitor-${n}` }));
  const first = await call('POST', '/analytics/events', {
    headers: { ...GATEWAY, ...throughCluster('24.108.0.1') },
    body: { events: filling }
  });
  const second = await call('POST', '/analytics/events', {
    headers: { ...GATEWAY, ...throughCluster('198.51.100.7') },
    body: { events: [event({ sessionId: 'quiet-visitor' })] }
  });

  assert.deepStrictEqual({ first: first.status, second: second.status }, { first: 202, second: 202 });
});

test('a browser behind the cluster is still capped at its own address', async (t) => {
  recordRows(t);
  geo._setReader(null);
  t.after(() => geo._reset());
  sessionCap._reset();
  t.after(() => sessionCap._reset());

  const from = { ...GATEWAY, ...throughCluster('203.0.113.9') };
  const filling = [0, 1, 2].map((n) => event({ sessionId: `capped-visitor-${n}` }));
  const first = await call('POST', '/analytics/events', { headers: from, body: { events: filling } });
  const second = await call('POST', '/analytics/events', {
    headers: from,
    body: { events: [event({ sessionId: 'capped-visitor-3' })] }
  });

  assert.deepStrictEqual(
    { first: first.status, second: second.status, retryAfter: second.headers['retry-after'] },
    { first: 202, second: 429, retryAfter: '60' }
  );
});

// Every event geolocated to APIM's Toronto address before the visitor hop was read.
test('a browser behind the cluster is located by its own address, not the gateway hop', async (t) => {
  const sent = recordRows(t);
  geo._setReader({
    get: (ip) => (ip === '24.108.0.1'
      ? { country: { iso_code: 'CA' }, subdivisions: [{ iso_code: 'BC' }], city: { names: { en: 'Victoria' } } }
      : { country: { iso_code: 'US' }, city: { names: { en: 'Toronto' } } })
  });
  t.after(() => geo._reset());

  const body = { events: [event({ sessionId: 'located-visitor' })] };
  await call('POST', '/analytics/events', {
    headers: { ...GATEWAY, ...throughCluster('24.108.0.1') },
    body
  });
  await writer.flush();

  const { row } = sent[0];
  assert.deepStrictEqual({ Country: row.Country, Region: row.Region, City: row.City }, {
    Country: 'CA',
    Region: 'BC',
    City: 'Victoria'
  });
});

const AUDIT_ROW = Object.freeze({
  action: 'project.updated',
  sourceApp: 'eagle-demi',
  actorId: 'a8f1c0de-0000-4000-8000-000000000001',
  actorName: 'jdoe',
  actorType: 'user',
  actorRoles: ['sysadmin'],
  targetType: 'project',
  targetId: '58851197aaecd9001b8227cc'
});

test('an audit row arriving without the gateway header is refused', async () => {
  const response = await call('POST', '/analytics/audit', { body: { rows: [AUDIT_ROW] } });
  assert.strictEqual(response.status, 401);
});

// The keyed APIM product stamps a second header. Without it the anonymous /events credential would be
// enough to write the audit trail every other EPIC app is judged by.
test('an audit row carrying only the gateway header is refused', async () => {
  const response = await call('POST', '/analytics/audit', {
    headers: GATEWAY,
    body: { rows: [AUDIT_ROW] }
  });
  assert.strictEqual(response.status, 401);
});

test('an audit row through the keyed product is accepted', async (t) => {
  recordRows(t);

  const response = await call('POST', '/analytics/audit', {
    headers: { ...GATEWAY, ...AUDIT_HEADER, ...CLIENT },
    body: { rows: [AUDIT_ROW] }
  });

  assert.deepStrictEqual(
    { status: response.status, body: response.body },
    { status: 202, body: { accepted: 1, rejected: [] } }
  );
});

test('an audit row reaches the audit stream, with the address it was called from', async (t) => {
  const sent = recordRows(t);

  await call('POST', '/analytics/audit', {
    headers: { ...GATEWAY, ...AUDIT_HEADER, ...CLIENT },
    body: { rows: [AUDIT_ROW] }
  });
  await writer.flush();

  const { stream, row } = sent[0];
  assert.strictEqual(stream, writer.AUDIT_STREAM);
  assert.deepStrictEqual(
    {
      Action: row.Action,
      SourceApp: row.SourceApp,
      ActorName: row.ActorName,
      ActorRoles: row.ActorRoles,
      // Masked to /16 by the DCR transform, so the row carries the whole value.
      SourceIp: row.SourceIp,
      Env: row.Env
    },
    {
      Action: 'project.updated',
      SourceApp: 'eagle-demi',
      ActorName: 'jdoe',
      ActorRoles: 'sysadmin',
      SourceIp: '24.108.0.1',
      Env: 'test'
    }
  );
});

// The producer, not APIM's outbound hop: an audit trail that names the gateway names nobody.
test('an audit row from a server producer carries the address the gateway saw', async (t) => {
  const sent = recordRows(t);

  await call('POST', '/analytics/audit', {
    headers: { ...GATEWAY, ...AUDIT_HEADER, ...throughCluster(null) },
    body: { rows: [AUDIT_ROW] }
  });
  await writer.flush();

  assert.strictEqual(sent[0].row.SourceIp, CLUSTER);
});
