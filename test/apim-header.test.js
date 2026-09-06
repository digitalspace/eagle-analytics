'use strict';

const assert = require('node:assert');
const { test } = require('node:test');

const { loadModule } = require('./helpers/load-config');

const HEADER = 'X-Analytics-Gateway';
const VALUE = 'gateway-value-for-tests';
const AUDIT_VALUE = 'audit-value-for-tests';

const loadGuards = (env) => loadModule('auth/apim-header', env);
const loadGuard = (env) => loadGuards(env).apimGuard;
const loadAuditGuard = (env) => loadGuards(env).auditGuard;

function request(headers) {
  return { header: (name) => headers[name.toLowerCase()] };
}

test('a request carrying the header APIM stamps is allowed through', () => {
  const guard = loadGuard({ ENVIRONMENT: 'test', APIM_SHARED_HEADER_VALUE: VALUE });
  assert.doesNotThrow(() => guard(request({ 'x-analytics-gateway': VALUE })));
});

test('the header name is matched however the gateway cased it', () => {
  const guard = loadGuard({ ENVIRONMENT: 'test', APIM_SHARED_HEADER_VALUE: VALUE });
  assert.doesNotThrow(() => guard({ header: (name) => (name === HEADER ? VALUE : undefined) }));
});

test('a request that reached the Function host directly is refused', () => {
  const guard = loadGuard({ ENVIRONMENT: 'test', APIM_SHARED_HEADER_VALUE: VALUE });
  assert.throws(() => guard(request({})), { status: 401, message: 'Unauthorized' });
});

test('a request carrying the wrong value is refused', () => {
  const guard = loadGuard({ ENVIRONMENT: 'test', APIM_SHARED_HEADER_VALUE: VALUE });
  assert.throws(() => guard(request({ 'x-analytics-gateway': 'gateway-value-for-tests ' })), {
    status: 401
  });
});

test('a custom header name is honoured', () => {
  const guard = loadGuard({
    ENVIRONMENT: 'test',
    APIM_SHARED_HEADER_NAME: 'X-Other-Gateway',
    APIM_SHARED_HEADER_VALUE: VALUE
  });
  assert.doesNotThrow(() => guard(request({ 'x-other-gateway': VALUE })));
});

test('with no value configured the check is skipped, which is local development', () => {
  const guard = loadGuard({ ENVIRONMENT: 'dev', APIM_SHARED_HEADER_VALUE: undefined });
  assert.doesNotThrow(() => guard(request({})));
});

test('a deployed environment refuses to load without a value, rather than serving ingest openly', () => {
  assert.throws(
    () => loadGuard({ ENVIRONMENT: 'test', APIM_SHARED_HEADER_VALUE: undefined }),
    /APIM_SHARED_HEADER_VALUE is required/
  );
});

// The other two settings a deployed instance cannot work without. Both fail closed at runtime rather
// than open, so without this the symptom is a dashboard that 401s or 503s and looks like a bug.
test('a deployed environment refuses to load with no Keycloak client allow-list', () => {
  assert.throws(
    () => loadGuard({
      ENVIRONMENT: 'test',
      APIM_SHARED_HEADER_VALUE: VALUE,
      KEYCLOAK_ALLOWED_CLIENTS: undefined
    }),
    /KEYCLOAK_ALLOWED_CLIENTS is required/
  );
});

test('a deployed environment refuses to load with no analytics workspace', () => {
  assert.throws(
    () => loadGuard({
      ENVIRONMENT: 'test',
      APIM_SHARED_HEADER_VALUE: VALUE,
      ANALYTICS_WORKSPACE_CUSTOMER_ID: undefined
    }),
    /ANALYTICS_WORKSPACE_CUSTOMER_ID is required/
  );
});

// /audit carries its own credential: the anonymous /events product and the keyed one stamp different
// headers, so a producer that only knows the gateway value cannot write the audit trail.
test('an audit request carrying the audit header is allowed through', () => {
  const guard = loadAuditGuard({ ENVIRONMENT: 'test', APIM_SHARED_HEADER_VALUE: VALUE });
  assert.doesNotThrow(() => guard(request({ 'x-analytics-audit': AUDIT_VALUE })));
});

test('the gateway value alone does not open /audit', () => {
  const guard = loadAuditGuard({ ENVIRONMENT: 'test', APIM_SHARED_HEADER_VALUE: VALUE });
  assert.throws(() => guard(request({ 'x-analytics-audit': VALUE })), { status: 401 });
});

test('an audit request carrying no audit header is refused', () => {
  const guard = loadAuditGuard({ ENVIRONMENT: 'test', APIM_SHARED_HEADER_VALUE: VALUE });
  assert.throws(() => guard(request({})), { status: 401, message: 'Unauthorized' });
});

test('a deployed environment refuses to load with no audit header value', () => {
  assert.throws(
    () => loadGuards({
      ENVIRONMENT: 'test',
      APIM_SHARED_HEADER_VALUE: VALUE,
      AUDIT_SHARED_HEADER_VALUE: undefined
    }),
    /AUDIT_SHARED_HEADER_VALUE is required/
  );
});
