'use strict';

const assert = require('node:assert');
const { test, beforeEach, afterEach } = require('node:test');

const helper = require('./helpers/staff-token');
const keycloak = require('../src/auth/keycloak');

let jwksCalls = 0;

beforeEach(() => {
  helper.applyEnvironment();
  jwksCalls = 0;
  keycloak._setJwksLoader(async () => {
    jwksCalls += 1;
    return helper.jwks();
  });
});

afterEach(() => keycloak._resetJwks());

async function statusOf(req) {
  try {
    await keycloak.requireStaff(req);
    return 200;
  } catch (err) {
    return err.status;
  }
}

test('a valid staff token yields the subject, username and every realm role', async () => {
  const token = helper.sign({ realm_access: { roles: ['staff', 'project:207'] } });

  const user = await keycloak.requireStaff(helper.request({ token }));

  assert.strictEqual(user.username, 'jdoe@idir');
  assert.strictEqual(user.sub, '6f3c1f9e-0000-4000-8000-abcdefabcdef');
  assert.deepStrictEqual(user.roles, ['staff', 'project:207']);
});

test('a request with no Authorization header is refused', async () => {
  assert.strictEqual(await statusOf(helper.request()), 401);
});

test('an expired token is refused', async () => {
  const token = helper.sign({}, { sign: { expiresIn: '-1m' } });

  assert.strictEqual(await statusOf(helper.request({ token })), 401);
});

test('a token carrying no expiry is refused, so it cannot be a permanent credential', async () => {
  const token = helper.signRaw({
    sub: '6f3c1f9e-0000-4000-8000-abcdefabcdef',
    azp: helper.CLIENT,
    aud: 'account',
    typ: 'Bearer',
    iss: `${helper.URL}/realms/${helper.REALM}`,
    realm_access: { roles: ['staff'] }
  });

  assert.strictEqual(await statusOf(helper.request({ token })), 401);
});

// An ID token is signed by the same realm key and held by the same browser, so only `typ` separates it
// from the access token this API accepts.
test('an ID token is refused even though it verifies', async () => {
  const token = helper.sign({ typ: 'ID' });

  assert.strictEqual(await statusOf(helper.request({ token })), 401);
});

test('a token from another realm is refused', async () => {
  const token = helper.sign({ iss: 'https://loginproxy.gov.bc.ca/auth/realms/some-other-realm' });

  assert.strictEqual(await statusOf(helper.request({ token })), 401);
});

test('a token signed by a key the JWKS never published is refused', async () => {
  const token = helper.sign({}, { key: helper.foreignKey });

  assert.strictEqual(await statusOf(helper.request({ token })), 401);
});

test('a token whose client is not in KEYCLOAK_ALLOWED_CLIENTS is refused', async () => {
  const token = helper.sign({ azp: 'some-other-client' });

  assert.strictEqual(await statusOf(helper.request({ token })), 401);
});

test('an empty KEYCLOAK_ALLOWED_CLIENTS refuses every token rather than admitting all of them', async () => {
  process.env.KEYCLOAK_ALLOWED_CLIENTS = '';
  const token = helper.sign();

  assert.strictEqual(await statusOf(helper.request({ token })), 401);
});

test('a client named only in aud is accepted', async () => {
  const token = helper.sign({ azp: undefined, aud: ['account', 'eagle-public'] });

  const user = await keycloak.requireStaff(helper.request({ token }));

  assert.strictEqual(user.username, 'jdoe@idir');
});

test('a verified token with no staff role is forbidden, not unauthorized', async () => {
  const token = helper.sign({ realm_access: { roles: ['project:207'] } });

  assert.strictEqual(await statusOf(helper.request({ token })), 403);
});

test('an HS256 token is refused without a key lookup', async () => {
  const token = require('jsonwebtoken').sign({ realm_access: { roles: ['sysadmin'] } }, 'shared-secret');

  assert.strictEqual(await statusOf(helper.request({ token })), 401);
  assert.strictEqual(jwksCalls, 0);
});

test('the JWKS is fetched once and reused inside the cache window', async () => {
  const token = helper.sign();

  await keycloak.requireStaff(helper.request({ token }));
  await keycloak.requireStaff(helper.request({ token }));

  assert.strictEqual(jwksCalls, 1);
});

test('an unknown kid does not send another request to Keycloak', async () => {
  await keycloak.requireStaff(helper.request({ token: helper.sign() }));

  await statusOf(helper.request({ token: helper.sign({}, { sign: { keyid: 'rotated-key' } }) }));

  assert.strictEqual(jwksCalls, 1);
});

test('an unreachable JWKS is refused rather than admitted', async () => {
  keycloak._setJwksLoader(async () => { throw new Error('ENOTFOUND'); });

  assert.strictEqual(await statusOf(helper.request({ token: helper.sign() })), 401);
});

test('an unset KEYCLOAK_URL refuses every request', async () => {
  const token = helper.sign();
  process.env.KEYCLOAK_URL = '';

  assert.strictEqual(await statusOf(helper.request({ token })), 401);
});
