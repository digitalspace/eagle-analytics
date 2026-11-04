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

// Key Vault: `secrets` maps a versionless URI to its latest value, missing = 404, `failing` URIs and
// `down: true` answer 503. `slow` URIs read their value a turn late; `afterRead(uri)` runs after each read.
// Every request waits on `hold` first, so a never-settling promise is a vault that does not answer.
function fakeVault(t, secrets) {
  const vault = { secrets, failing: [], slow: [], afterRead: () => {}, down: false, hold: null };
  rotatingSecret._setTokenProvider(async () => TOKEN);
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    await vault.hold;
    const { pathname, origin, searchParams } = new URL(url);
    const status = (code) => ({ ok: code < 300, status: code, json: async () => ({}) });
    if (vault.down || vault.failing.includes(`${origin}${pathname}`)) return status(503);
    if (init.headers.authorization !== `Bearer ${TOKEN}` || searchParams.get('api-version') !== '7.4') return status(401);
    const uri = `${origin}${pathname}`;
    if (vault.slow.includes(uri)) await settle();
    const value = vault.secrets[uri];
    vault.afterRead(uri);
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

const TTL_MS = 5 * 60 * 1000;

const startClock = (t) =>
  t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: new Date('2026-11-04T12:00:00Z') });

// Lets the clock run `ms` with no request arriving, then lets the refresh it started finish.
async function idle(t, ms = TTL_MS) {
  t.mock.timers.tick(ms);
  await settle();
}

// Retiring a value in the vault has to revoke it, traffic or not; one refresh late, so a read in promote's gap is harmless.
test('a value retired in the vault stops passing after two refreshes, with no request between', async (t) => {
  startClock(t);
  const vault = fakeVault(t, { [GATEWAY_URI]: NEW_VALUE, [`${GATEWAY_URI}-standby`]: VALUE, [AUDIT_URI]: AUDIT_VALUE });
  const guard = loadGuard(VAULT_ENV);
  await guard(request({ 'x-analytics-gateway': VALUE }));

  vault.secrets[`${GATEWAY_URI}-standby`] = NEW_VALUE;
  await idle(t);
  await idle(t);

  await assert.rejects(guard(request({ 'x-analytics-gateway': VALUE })), { status: 401 });
});

// Between promote's writes (standby := O, then name := N) the vault holds O twice, and a stamper
// may switch to N before the next refresh.
test('a refresh between the two promote writes keeps the new value accepted', async (t) => {
  startClock(t);
  const vault = fakeVault(t, { [GATEWAY_URI]: VALUE, [`${GATEWAY_URI}-standby`]: NEW_VALUE, [AUDIT_URI]: AUDIT_VALUE });
  const guard = loadGuard(VAULT_ENV);
  await guard(request({ 'x-analytics-gateway': VALUE }));

  vault.secrets[`${GATEWAY_URI}-standby`] = VALUE;
  await idle(t);

  await assert.doesNotReject(guard(request({ 'x-analytics-gateway': NEW_VALUE })));
});

// A failed read is not a generation: the read before the gap read must still be the one kept.
test('a failed read between two good ones leaves the earlier read accepted', async (t) => {
  startClock(t);
  t.mock.method(logger, 'warn', () => {});
  const vault = fakeVault(t, { [GATEWAY_URI]: VALUE, [`${GATEWAY_URI}-standby`]: NEW_VALUE, [AUDIT_URI]: AUDIT_VALUE });
  const guard = loadGuard(VAULT_ENV);
  await guard(request({ 'x-analytics-gateway': VALUE }));

  vault.down = true;
  await idle(t);
  vault.down = false;
  vault.secrets[`${GATEWAY_URI}-standby`] = VALUE;
  await idle(t);

  await assert.doesNotReject(guard(request({ 'x-analytics-gateway': NEW_VALUE })));
});

test('when the vault cannot be read at boot, the app setting value still passes', async (t) => {
  fakeVault(t, {}).down = true;
  t.mock.method(logger, 'warn', () => {});
  const guard = loadGuard(VAULT_ENV);

  await assert.doesNotReject(guard(request({ 'x-analytics-gateway': VALUE })));
});

// Until one read works the instance holds only the app setting, which the platform may cache for a day.
test('after a failed first read the vault is read again within 30 s', async (t) => {
  startClock(t);
  t.mock.method(logger, 'warn', () => {});
  const vault = fakeVault(t, { [GATEWAY_URI]: NEW_VALUE, [AUDIT_URI]: AUDIT_VALUE });
  vault.down = true;
  const guard = loadGuard(VAULT_ENV);
  await guard(request({ 'x-analytics-gateway': VALUE }));

  vault.down = false;
  await idle(t, 30 * 1000);

  await assert.doesNotReject(guard(request({ 'x-analytics-gateway': NEW_VALUE })));
});

test('a value rotated in the vault passes once the 5 minute cache runs out, with no request between', async (t) => {
  startClock(t);
  const vault = fakeVault(t, { [GATEWAY_URI]: VALUE });
  const guard = loadGuard(VAULT_ENV);
  await guard(request({ 'x-analytics-gateway': VALUE }));

  vault.secrets[GATEWAY_URI] = NEW_VALUE;
  await idle(t);

  await assert.doesNotReject(guard(request({ 'x-analytics-gateway': NEW_VALUE })));
});

// Falling back to the app setting here would undo a retire whenever the vault blips.
test('a failed refresh keeps the values last read, and logs no value', async (t) => {
  startClock(t);
  const warnings = [];
  t.mock.method(logger, 'warn', (message) => warnings.push(message));
  const vault = fakeVault(t, { [GATEWAY_URI]: NEW_VALUE, [`${GATEWAY_URI}-standby`]: STANDBY_VALUE });
  const guard = loadGuard(VAULT_ENV);
  await guard(request({ 'x-analytics-gateway': NEW_VALUE }));

  vault.down = true;
  await idle(t);

  await assert.doesNotReject(guard(request({ 'x-analytics-gateway': NEW_VALUE })));
  await assert.rejects(guard(request({ 'x-analytics-gateway': VALUE })), { status: 401 });
  assert.match(warnings.join('\n'), /Key Vault read failed, keeping the values last read/);
  assert.doesNotMatch(warnings.join('\n'), new RegExp([VALUE, NEW_VALUE, STANDBY_VALUE, TOKEN].join('|')));
});

test('a value the vault retired stops passing 10 minutes after that read, even while reads fail', async (t) => {
  startClock(t);
  t.mock.method(logger, 'warn', () => {});
  const vault = fakeVault(t, { [GATEWAY_URI]: NEW_VALUE, [`${GATEWAY_URI}-standby`]: VALUE, [AUDIT_URI]: AUDIT_VALUE });
  const guard = loadGuard(VAULT_ENV);
  await guard(request({ 'x-analytics-gateway': VALUE }));

  vault.secrets[`${GATEWAY_URI}-standby`] = NEW_VALUE;
  await idle(t);
  vault.down = true;
  await idle(t, 2 * TTL_MS);

  await assert.rejects(guard(request({ 'x-analytics-gateway': VALUE })), { status: 401 });
});

// An interval tick that lands while a retry is still reading joins that read. A second read would take
// the previous slot, so the one read inside promote's gap that follows would drop N.
test('an interval tick during a retry read counts as one read, so a gap read after it keeps N', async (t) => {
  startClock(t);
  t.mock.method(logger, 'warn', () => {});
  const vault = fakeVault(t, { [GATEWAY_URI]: VALUE, [`${GATEWAY_URI}-standby`]: NEW_VALUE, [AUDIT_URI]: AUDIT_VALUE });
  vault.down = true;
  const guard = loadGuard(VAULT_ENV);
  await guard(request({ 'x-analytics-gateway': VALUE }));

  vault.down = false;
  let release;
  vault.hold = new Promise((resolve) => { release = resolve; });
  await idle(t, 30 * 1000);
  await idle(t, TTL_MS - 30 * 1000);
  vault.afterRead = (uri) => {
    if (uri === `${GATEWAY_URI}-standby`) vault.secrets[uri] = VALUE;
  };
  release();
  await settle();
  await idle(t);

  await assert.doesNotReject(guard(request({ 'x-analytics-gateway': NEW_VALUE })));
});

// The rotator rewrites the standby on its own; a failed read of it alone must not drop the value.
test('a refresh whose standby read fails keeps the standby value', async (t) => {
  startClock(t);
  const warn = t.mock.method(logger, 'warn', () => {});
  const vault = fakeVault(t, {
    [GATEWAY_URI]: NEW_VALUE,
    [`${GATEWAY_URI}-standby`]: STANDBY_VALUE,
    [AUDIT_URI]: AUDIT_VALUE
  });
  const guard = loadGuard(VAULT_ENV);
  await guard(request({ 'x-analytics-gateway': NEW_VALUE }));

  vault.failing.push(`${GATEWAY_URI}-standby`);
  await idle(t);

  await assert.doesNotReject(guard(request({ 'x-analytics-gateway': STANDBY_VALUE })));
  assert.strictEqual(warn.mock.callCount(), 1);
});

// Promote writes standby := O, then name := N. A read of standby before that pair and of name after
// it would see N twice and drop O, which APIM may still stamp for 4 h.
test('a read that straddles a promote keeps the old value accepted', async (t) => {
  const vault = fakeVault(t, { [GATEWAY_URI]: VALUE, [`${GATEWAY_URI}-standby`]: NEW_VALUE });
  vault.slow.push(GATEWAY_URI);
  vault.afterRead = (uri) => {
    if (uri !== `${GATEWAY_URI}-standby`) return;
    vault.secrets[`${GATEWAY_URI}-standby`] = VALUE;
    vault.secrets[GATEWAY_URI] = NEW_VALUE;
  };
  const guard = loadGuard(VAULT_ENV);

  await assert.doesNotReject(guard(request({ 'x-analytics-gateway': VALUE })));
});

test('a token request that never answers fails that refresh, and the next one still runs', async (t) => {
  startClock(t);
  const warnings = [];
  t.mock.method(logger, 'warn', (message) => warnings.push(message));
  fakeVault(t, { [GATEWAY_URI]: NEW_VALUE });
  let tokenCalls = 0;
  rotatingSecret._setTokenProvider(() => (tokenCalls++ === 0 ? new Promise(() => {}) : Promise.resolve(TOKEN)));
  const guard = loadGuard(VAULT_ENV);

  const first = guard(request({ 'x-analytics-gateway': VALUE }));
  t.mock.timers.tick(10000);
  await first;
  await settle();
  await idle(t);

  assert.match(warnings.join('\n'), /token request timed out/);
  await assert.doesNotReject(guard(request({ 'x-analytics-gateway': NEW_VALUE })));
});

test('a vault that does not answer holds the first request for 3 s at most', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  fakeVault(t, {}).hold = new Promise(() => {});
  const guard = loadGuard(VAULT_ENV);

  const outcome = guard(request({ 'x-analytics-gateway': VALUE }));
  t.mock.timers.tick(3000);

  await assert.doesNotReject(outcome);
});
