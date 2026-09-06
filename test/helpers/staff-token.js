'use strict';

/**
 * A local Keycloak: one RSA key pair, the JWKS that publishes it, and a signer.
 *
 * Shared by test/keycloak.test.js and test/query-controller.test.js so the controller suite
 * exercises the real verification path rather than a stubbed identity.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const URL = 'https://dev.loginproxy.gov.bc.ca/auth';
const REALM = 'eao-epic';
const CLIENT = 'eagle-admin-console';
const KID = 'analytics-test-key';

const signing = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
/** A second pair, never published in the JWKS: a token signed with it is a forgery. */
const foreign = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

function applyEnvironment() {
  process.env.KEYCLOAK_URL = URL;
  process.env.KEYCLOAK_REALM = REALM;
  process.env.KEYCLOAK_ALLOWED_CLIENTS = `${CLIENT}, eagle-public`;
}

function jwks() {
  return {
    keys: [{ ...signing.publicKey.export({ format: 'jwk' }), kid: KID, use: 'sig', alg: 'RS256' }]
  };
}

function sign(claims = {}, options = {}) {
  return jwt.sign(
    {
      sub: '6f3c1f9e-0000-4000-8000-abcdefabcdef',
      preferred_username: 'jdoe@idir',
      azp: CLIENT,
      aud: 'account',
      // Keycloak's marker for an access token. src/auth/keycloak.js refuses an ID or refresh token.
      typ: 'Bearer',
      iss: `${URL}/realms/${REALM}`,
      realm_access: { roles: ['staff'] },
      ...claims
    },
    options.key || signing.privateKey,
    { algorithm: 'RS256', keyid: KID, expiresIn: '5m', ...options.sign }
  );
}

/** Signs exactly the payload given, so a case can leave a registered claim like `exp` out. */
function signRaw(payload) {
  return jwt.sign(payload, signing.privateKey, { algorithm: 'RS256', keyid: KID, noTimestamp: true });
}

/** A request shaped the way src/http/router.js builds one. */
function request({ token, query = {}, body = {} } = {}) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  return {
    headers,
    query,
    body,
    header: (name) => headers[String(name).toLowerCase()]
  };
}

module.exports = {
  URL,
  REALM,
  CLIENT,
  KID,
  foreignKey: foreign.privateKey,
  applyEnvironment,
  jwks,
  sign,
  signRaw,
  request
};
