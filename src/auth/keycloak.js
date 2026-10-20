'use strict';

// JWKS cached here rather than through jwks-rsa: Node converts a JWK to a key object natively.

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const config = require('../config');
const { httpError } = require('../http/http-error');
const { logger } = require('../utils/logger');

/** Mirrors eagle-demi-admin `src/api/keycloak.ts` STAFF_ROLES. Both lists gate the same screens. */
const STAFF_ROLES = ['sysadmin', 'staff', 'demi-admin'];

const JWKS_TTL_MS = 10 * 60 * 1000;

/** Clock skew allowed between Keycloak and this worker. */
const CLOCK_TOLERANCE_SECONDS = 5;

function issuer() {
  return `${config.keycloakUrl}/realms/${config.keycloakRealm}`;
}

function jwksUri() {
  return `${issuer()}/protocol/openid-connect/certs`;
}

let cache = { keys: new Map(), at: 0 };
let refreshing = null;

async function fetchJwks() {
  const res = await fetch(jwksUri(), { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`JWKS fetch returned ${res.status}`);
  return res.json();
}

// Test seam: _setJwksLoader swaps it.
let loadJwks = fetchJwks;

// An unknown kid NEVER triggers a refetch: each forged token would hit Keycloak, the login path for
// every EPIC app. A rotated signing key becomes usable when the cache expires.
async function refresh(now) {
  const jwks = await loadJwks();
  const keys = new Map();
  for (const jwk of (jwks && jwks.keys) || []) {
    if (jwk.kty !== 'RSA' || (jwk.use && jwk.use !== 'sig')) continue;
    keys.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
  }
  cache = { keys, at: now };
}

async function signingKey(kid, now = Date.now()) {
  if (cache.keys.size === 0 || now - cache.at >= JWKS_TTL_MS) {
    // One fetch however many requests find the cache stale together, as a cold instance does.
    if (!refreshing) refreshing = refresh(now).finally(() => { refreshing = null; });
    await refreshing;
  }
  return cache.keys.get(kid) || null;
}

/**
 * Both `aud` and `azp`: Keycloak sets `aud` to `account` for a browser client and names it in `azp`.
 * An empty allowlist refuses everything, so an unset variable cannot open the API.
 */
function isAllowedClient(claims, allowedClients) {
  if (allowedClients.length === 0) return false;
  const presented = [].concat(claims.aud || [], claims.azp || claims.client_id || []);
  return presented.some((name) => allowedClients.includes(name));
}

function bearerToken(req) {
  const header = (req.header && req.header('authorization')) ||
    ((req.headers || {}).authorization) || '';
  if (!header.startsWith('Bearer ')) throw httpError(401, 'Unauthorized. Bearer token required.');
  const token = header.slice(7).trim();
  if (!token) throw httpError(401, 'Unauthorized. Bearer token required.');
  return token;
}

/** Verified claims, or an Error carrying 401. The reason stays in the log; the body says little. */
async function verify(req) {
  if (!config.keycloakUrl) {
    logger.error('[analytics] KEYCLOAK_URL is unset; every staff request is refused.');
    throw httpError(401, 'Unauthorized.');
  }

  const token = bearerToken(req);

  let header;
  try {
    header = (jwt.decode(token, { complete: true }) || {}).header;
  } catch {
    throw httpError(401, 'Unauthorized. Malformed bearer token.');
  }
  if (!header || !header.kid) throw httpError(401, 'Unauthorized. Token header carries no kid.');
  // Checked here as well as in jwt.verify: a key is fetched only for an algorithm we accept.
  if (header.alg !== 'RS256') throw httpError(401, 'Unauthorized. Unsupported token algorithm.');

  let key;
  try {
    key = await signingKey(header.kid);
  } catch (err) {
    logger.error(`[analytics] JWKS unavailable: ${err.message}`);
    throw httpError(401, 'Unauthorized.');
  }
  if (!key) throw httpError(401, 'Unauthorized. Unknown signing key.');

  let claims;
  try {
    claims = jwt.verify(token, key, {
      algorithms: ['RS256'],
      issuer: issuer(),
      clockTolerance: CLOCK_TOLERANCE_SECONDS
    });
  } catch (err) {
    logger.warn(`[analytics] token verification failed: ${err.message}`);
    throw httpError(401, 'Unauthorized. Token verification failed.');
  }

  // jsonwebtoken enforces `exp` only when present, so a token without one would never expire.
  if (typeof claims.exp !== 'number') throw httpError(401, 'Unauthorized. Token carries no expiry.');

  // Access tokens only: the same browser holds ID and refresh tokens, which are no API credential.
  if (claims.typ !== 'Bearer') throw httpError(401, 'Unauthorized. Token is not an access token.');

  if (!isAllowedClient(claims, config.keycloakAllowedClients)) {
    logger.warn(`[analytics] client '${claims.azp || 'unknown'}' is not in KEYCLOAK_ALLOWED_CLIENTS.`);
    throw httpError(401, 'Unauthorized. Client is not permitted to call this API.');
  }

  return claims;
}

/** @returns {Promise<{sub: string, username: string, roles: string[]}>} all realm roles; callers check `sysadmin`. */
async function requireStaff(req) {
  const claims = await verify(req);
  const roles = (((claims.realm_access || {}).roles) || []).filter((role) => typeof role === 'string');

  if (!roles.some((role) => STAFF_ROLES.includes(role))) {
    logger.warn(`[analytics] ${claims.preferred_username || claims.sub} has no staff role; refused.`);
    throw httpError(403, 'Forbidden. A staff role is required.');
  }

  return {
    sub: claims.sub,
    username: claims.preferred_username || claims.sub,
    roles
  };
}

/** Route-table form of requireStaff; controllers read `req.user` instead of authenticating again. */
async function staffGuard(req) {
  req.user = await requireStaff(req);
}

module.exports = {
  requireStaff,
  staffGuard,
  // Test seams only.
  _setJwksLoader: (loader) => { loadJwks = loader; cache = { keys: new Map(), at: 0 }; refreshing = null; },
  _resetJwks: () => { loadJwks = fetchJwks; cache = { keys: new Map(), at: 0 }; refreshing = null; }
};
