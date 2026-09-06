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
