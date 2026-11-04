'use strict';

const assert = require('node:assert');
const { test, afterEach } = require('node:test');

const { loadModule } = require('./helpers/load-config');
const rotatingSecret = require('../src/auth/rotating-secret');
const { logger } = require('../src/utils/logger');

const VALUE = 'gateway-value-for-tests';
const AUDIT_VALUE = 'audit-value-for-tests';

const loadGuards = (env) => loadModule('auth/apim-header', env);
const loadGuard = (env) => loadGuards(env).apimGuard;
const loadAuditGuard = (env) => loadGuards(env).auditGuard;

function request(headers) {
  return { header: (name) => headers[name.toLowerCase()] };
}

const VAULT = 'https://demi-kv-test.vault.azure.net/secrets';
const GATEWAY_URI = `${VAULT}/analytics-shared-header`;
const AUDIT_URI = `${VAULT}/analytics-audit-header`;
const TOKEN = 'token-for-tests';

const NEW_VALUE = 'rotated-gateway-value';
const STANDBY_VALUE = 'standby-gateway-value';
const AUDIT_STANDBY_VALUE = 'standby-audit-value';

/** Settings of a deployed instance reading both headers from the vault. */
const VAULT_ENV = {
  ENVIRONMENT: 'test',
  APIM_SHARED_HEADER_SECRET_URI: GATEWAY_URI,
  AUDIT_SHARED_HEADER_SECRET_URI: AUDIT_URI
};

/**
 * Stands in for Key Vault: `secrets` maps a versionless secret URI to its latest value, a missing
 * entry answers 404, and `down: true` answers 503 for everything.
 */
function fakeVault(t, secrets) {
  const vault = { secrets, down: false, pending: false };
  rotatingSecret._setTokenProvider(async () => TOKEN);
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (vault.pending) return new Promise(() => {});
    const { pathname, origin, searchParams } = new URL(url);
    const status = (code) => ({ ok: code < 300, status: code, json: async () => ({}) });
    if (vault.down) return status(503);
    if (init.headers.authorization !== `Bearer ${TOKEN}` || searchParams.get('api-version') !== '7.4') return status(401);
    const value = vault.secrets[`${origin}${pathname}`];
    if (value === undefined) return status(404);
    return { ok: true, status: 200, json: async () => ({ value }) };
  });
  return vault;
}

// A refresh runs behind the request that started it; let it finish before the next request.
const settle = () => new Promise((resolve) => setImmediate(resolve));

afterEach(() => rotatingSecret._resetTokenProvider());

test('a request carrying the header APIM stamps is allowed through', async () => {
  const guard = loadGuard({ ENVIRONMENT: 'test', APIM_SHARED_HEADER_VALUE: VALUE });
  await assert.doesNotReject(guard(request({ 'x-analytics-gateway': VALUE })));
});

test('a request that reached the Function host directly is refused', async () => {
  const guard = loadGuard({ ENVIRONMENT: 'test', APIM_SHARED_HEADER_VALUE: VALUE });
  await assert.rejects(guard(request({})), { status: 401, message: 'Unauthorized' });
});

test('a request carrying the wrong value is refused', async () => {
  const guard = loadGuard({ ENVIRONMENT: 'test', APIM_SHARED_HEADER_VALUE: VALUE });
  await assert.rejects(guard(request({ 'x-analytics-gateway': 'gateway-value-for-tests ' })), {
    status: 401
  });
});

test('a custom header name is honoured', async () => {
  const guard = loadGuard({
    ENVIRONMENT: 'test',
    APIM_SHARED_HEADER_NAME: 'X-Other-Gateway',
    APIM_SHARED_HEADER_VALUE: VALUE
  });
  await assert.doesNotReject(guard(request({ 'x-other-gateway': VALUE })));
});

test('with no value configured the check is skipped, which is local development', async () => {
  const guard = loadGuard({ ENVIRONMENT: 'dev', APIM_SHARED_HEADER_VALUE: undefined });
  await assert.doesNotReject(guard(request({})));
});

// /audit carries its own credential: the anonymous /events product and the keyed one stamp different
// headers, so a producer that only knows the gateway value cannot write the audit trail.
test('an audit request carrying the audit header is allowed through', async () => {
  const guard = loadAuditGuard({ ENVIRONMENT: 'test', APIM_SHARED_HEADER_VALUE: VALUE });
  await assert.doesNotReject(guard(request({ 'x-analytics-audit': AUDIT_VALUE })));
});

test('the gateway value alone does not open /audit', async () => {
  const guard = loadAuditGuard({ ENVIRONMENT: 'test', APIM_SHARED_HEADER_VALUE: VALUE });
  await assert.rejects(guard(request({ 'x-analytics-audit': VALUE })), { status: 401 });
});

test('an audit request carrying no audit header is refused', async () => {
  const guard = loadAuditGuard({ ENVIRONMENT: 'test', APIM_SHARED_HEADER_VALUE: VALUE });
  await assert.rejects(guard(request({})), { status: 401, message: 'Unauthorized' });
});

// The app setting is a Key Vault reference the platform caches for up to a day, so right after a
// rotation it still holds the old value while APIM already stamps the new one.
test('fresh instance, env=O, presented N, vault holds N: apimGuard passes', async (t) => {
  fakeVault(t, { [GATEWAY_URI]: NEW_VALUE });
  const guard = loadGuard(VAULT_ENV);

  await assert.doesNotReject(guard(request({ 'x-analytics-gateway': NEW_VALUE })));
});

// During a rotation APIM may stamp either value, depending on when it last refreshed its named value.
test('standby value passes apimGuard and auditGuard', async (t) => {
  fakeVault(t, {
    [GATEWAY_URI]: NEW_VALUE,
    [`${GATEWAY_URI}-standby`]: STANDBY_VALUE,
    [AUDIT_URI]: AUDIT_VALUE,
    [`${AUDIT_URI}-standby`]: AUDIT_STANDBY_VALUE
  });
  const { apimGuard, auditGuard } = loadGuards(VAULT_ENV);

  await assert.doesNotReject(apimGuard(request({ 'x-analytics-gateway': STANDBY_VALUE })));
  await assert.doesNotReject(auditGuard(request({ 'x-analytics-audit': AUDIT_STANDBY_VALUE })));
});

// Retiring a value in the vault has to revoke it, even though the app setting still holds it.
test('after a vault read succeeds, the app setting value alone no longer passes', async (t) => {
  fakeVault(t, { [GATEWAY_URI]: NEW_VALUE });
  const guard = loadGuard(VAULT_ENV);

  await assert.rejects(guard(request({ 'x-analytics-gateway': VALUE })), { status: 401 });
});

test('when the vault cannot be read at boot, the app setting value still passes', async (t) => {
  fakeVault(t, {}).down = true;
  t.mock.method(logger, 'warn', () => {});
  const guard = loadGuard(VAULT_ENV);

  await assert.doesNotReject(guard(request({ 'x-analytics-gateway': VALUE })));
});

test('a value rotated in the vault passes once the 5 minute cache runs out', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-04T12:00:00Z') });
  const vault = fakeVault(t, { [GATEWAY_URI]: VALUE });
  const guard = loadGuard(VAULT_ENV);
  await guard(request({ 'x-analytics-gateway': VALUE }));

  vault.secrets[GATEWAY_URI] = NEW_VALUE;
  t.mock.timers.tick(5 * 60 * 1000);
  await assert.rejects(guard(request({ 'x-analytics-gateway': NEW_VALUE })), { status: 401 });
  await settle();

  await assert.doesNotReject(guard(request({ 'x-analytics-gateway': NEW_VALUE })));
});

// Falling back to the app setting here would undo a retire whenever the vault blips.
test('a failed refresh keeps the values last read, and logs no value', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-04T12:00:00Z') });
  const warnings = [];
  t.mock.method(logger, 'warn', (message) => warnings.push(message));
  const vault = fakeVault(t, { [GATEWAY_URI]: NEW_VALUE, [`${GATEWAY_URI}-standby`]: STANDBY_VALUE });
  const guard = loadGuard(VAULT_ENV);
  await guard(request({ 'x-analytics-gateway': NEW_VALUE }));

  vault.down = true;
  t.mock.timers.tick(5 * 60 * 1000);
  await guard(request({ 'x-analytics-gateway': NEW_VALUE }));
  await settle();

  await assert.doesNotReject(guard(request({ 'x-analytics-gateway': NEW_VALUE })));
  await assert.rejects(guard(request({ 'x-analytics-gateway': VALUE })), { status: 401 });
  assert.match(warnings.join('\n'), /Key Vault read failed, keeping the values last read/);
  assert.doesNotMatch(warnings.join('\n'), new RegExp([VALUE, NEW_VALUE, STANDBY_VALUE, TOKEN].join('|')));
});

test('a vault that does not answer holds the first request for 3 s at most', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  fakeVault(t, {}).pending = true;
  const guard = loadGuard(VAULT_ENV);

  const outcome = guard(request({ 'x-analytics-gateway': VALUE }));
  t.mock.timers.tick(3000);

  await assert.doesNotReject(outcome);
});
