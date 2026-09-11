'use strict';

const assert = require('node:assert');
const { test } = require('node:test');

const { loadModule } = require('./helpers/load-config');

const loadConfig = (env) => loadModule('config', env);

// A cap of zero is a service that accepts nothing and reports it as throttling, and a NaN cap compares
// false against every value, which removes the limit instead of failing the deploy.
for (const setting of ['SESSION_EVENT_CAP', 'IP_EVENT_CAP', 'ANALYTICS_MAX_BATCH']) {
  test(`${setting} of zero fails the load rather than accepting nothing`, () => {
    assert.throws(
      () => loadConfig({ ENVIRONMENT: 'test', [setting]: '0' }),
      /must be a whole number of 1 or more/
    );
  });

  test(`${setting} that is not a whole number fails the load`, () => {
    assert.throws(() => loadConfig({ ENVIRONMENT: 'test', [setting]: '12.5' }), /whole number/);
  });
}

test('a cap that is set is the one used', () => {
  assert.strictEqual(loadConfig({ ENVIRONMENT: 'test', SESSION_EVENT_CAP: '7' }).sessionEventCap, 7);
});

// Staff bearer tokens are verified against the JWKS at this URL, so plain http would put the signing
// keys on the wire for anything in the path to replace.
test('a plain http Keycloak URL fails the load outside dev', () => {
  assert.throws(
    () => loadConfig({ ENVIRONMENT: 'test', KEYCLOAK_URL: 'http://test.loginproxy.gov.bc.ca/auth' }),
    /KEYCLOAK_URL must be https/
  );
});

test('an https Keycloak URL loads', () => {
  assert.doesNotThrow(() => loadConfig({
    ENVIRONMENT: 'test',
    KEYCLOAK_URL: 'https://test.loginproxy.gov.bc.ca/auth'
  }));
});

// Where a developer runs Keycloak themselves, http is the only thing on offer.
test('a local http Keycloak URL is still allowed in dev', () => {
  assert.doesNotThrow(() => loadConfig({
    ENVIRONMENT: 'dev',
    KEYCLOAK_URL: 'http://localhost:8080/auth'
  }));
});

test('ALLOWED_ORIGINS is read as a trimmed list', () => {
  const config = loadConfig({
    ENVIRONMENT: 'test',
    ALLOWED_ORIGINS: 'https://one.example.invalid, http://localhost:4200'
  });

  assert.deepStrictEqual(config.allowedOrigins, [
    'https://one.example.invalid',
    'http://localhost:4200'
  ]);
});

test('an unset ALLOWED_ORIGINS admits no browser at all', () => {
  assert.deepStrictEqual(loadConfig({ ENVIRONMENT: 'test' }).allowedOrigins, []);
});

test('TRUSTED_PROXY_IPS is read as a trimmed list', () => {
  const config = loadConfig({
    ENVIRONMENT: 'test',
    TRUSTED_PROXY_IPS: '142.34.194.121, 142.34.194.122'
  });

  assert.deepStrictEqual(config.trustedProxyIps, ['142.34.194.121', '142.34.194.122']);
});

// Nothing trusted is the safe default: every caller is located and capped by the last hop, which is
// what this service did before the cluster's egress addresses were known.
test('an unset TRUSTED_PROXY_IPS trusts no proxy', () => {
  assert.deepStrictEqual(loadConfig({ ENVIRONMENT: 'test' }).trustedProxyIps, []);
});

// App Service passes the reference string through as the value when it cannot read the secret, and
// that string is public: the vault and secret names live in azure/. A non-empty check alone would let
// it become the value the header guards compare against.
const UNRESOLVED_REFERENCE =
  '@Microsoft.KeyVault(SecretUri=https://demi-kv-test.vault.azure.net/secrets/analytics-shared-header)';

for (const setting of ['APIM_SHARED_HEADER_VALUE', 'AUDIT_SHARED_HEADER_VALUE']) {
  test(`${setting} left holding its Key Vault reference fails the load`, () => {
    assert.throws(
      () => loadConfig({ ENVIRONMENT: 'test', [setting]: UNRESOLVED_REFERENCE }),
      new RegExp(`${setting} did not resolve`)
    );
  });

  // App Service does not case the prefix consistently, and a setting can arrive padded.
  test(`${setting} holding a padded, differently cased reference fails the load too`, () => {
    assert.throws(
      () => loadConfig({ ENVIRONMENT: 'test', [setting]: '  @microsoft.keyvault(SecretUri=x)  ' }),
      /did not resolve/
    );
  });
}

test('an unresolved reference in dev reads as unset rather than as a value', () => {
  const config = loadConfig({ ENVIRONMENT: 'dev', APIM_SHARED_HEADER_VALUE: UNRESOLVED_REFERENCE });

  assert.strictEqual(config.apimSharedHeaderValue, '');
  assert.strictEqual(config.guardsDisabled, true);
});

test('a resolved secret is still read, with surrounding whitespace dropped', () => {
  const config = loadConfig({ ENVIRONMENT: 'test', APIM_SHARED_HEADER_VALUE: '  a-real-value  ' });

  assert.strictEqual(config.apimSharedHeaderValue, 'a-real-value');
  assert.strictEqual(config.guardsDisabled, false);
});
