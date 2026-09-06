'use strict';

process.env.ANALYTICS_WORKSPACE_CUSTOMER_ID = 'e1d4a0b2-test-workspace';
// Set before src/config.js loads. A value here is what turns the gateway guard on, which is the other
// half of what closes these routes: the Function host answers on a public hostname of its own.
process.env.APIM_SHARED_HEADER_VALUE = 'gateway-value-for-tests';

const assert = require('node:assert');
const { test, beforeEach, afterEach } = require('node:test');

const helper = require('./helpers/staff-token');
const keycloak = require('../src/auth/keycloak');
const { dispatch } = require('../src/http/router');

/**
 * The staff guard belongs to the route table, not to a controller, so this is where "every read and
 * dashboard route is closed to an anonymous caller" is checked. Take a `guards: [staffGuard]` off any
 * row in src/http/routes.js and one of these turns green-to-red.
 */
const STAFF_ROUTES = [
  ['POST', '/analytics/query'],
  ['GET', '/analytics/query/schema'],
  ['GET', '/analytics/dashboards'],
  ['GET', '/analytics/dashboards/44444444-4444-4444-8444-444444444444'],
  ['PUT', '/analytics/dashboards/44444444-4444-4444-8444-444444444444'],
  ['DELETE', '/analytics/dashboards/44444444-4444-4444-8444-444444444444']
];

const GATEWAY = { 'x-analytics-gateway': 'gateway-value-for-tests' };

/** The shape the Functions host hands the dispatcher. */
function call(method, path, { token, body, gateway = true } = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const headers = {
    ...(gateway ? GATEWAY : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body === undefined ? {} : { 'content-length': String(Buffer.byteLength(payload)) })
  };
  return dispatch({
    method,
    url: `https://analytics-api-fc-test.azurewebsites.net${path}`,
    headers: new Map(Object.entries(headers)),
    arrayBuffer: async () => Buffer.from(payload)
  });
}

beforeEach(() => {
  helper.applyEnvironment();
  keycloak._setJwksLoader(async () => helper.jwks());
});

afterEach(() => keycloak._resetJwks());

for (const [method, path] of STAFF_ROUTES) {
  test(`${method} ${path} refuses a caller with no token`, async () => {
    assert.strictEqual((await call(method, path, { body: {} })).status, 401);
  });
}

// Reads are guarded as well as writes: without the header the Function's own hostname would serve
// analytics for anything on the internet holding a staff token.
for (const [method, path] of STAFF_ROUTES) {
  test(`${method} ${path} refuses a caller that skipped the gateway`, async () => {
    const token = helper.sign();
    assert.strictEqual((await call(method, path, { token, body: {}, gateway: false })).status, 401);
  });
}

test('a staff token reaches the handler, which answers off the identity the guard left', async () => {
  const response = await call('GET', '/analytics/query/schema', { token: helper.sign() });

  assert.strictEqual(response.status, 200);
  assert.ok(JSON.parse(response.body).measures.length > 0);
});

test('a verified token with no staff role is forbidden, not unauthorized', async () => {
  const token = helper.sign({ realm_access: { roles: ['project:207'] } });

  assert.strictEqual((await call('GET', '/analytics/query/schema', { token })).status, 403);
});
