'use strict';

/**
 * Every environment variable this service reads. Nothing else calls process.env.
 */

/**
 * A whole number of at least `min`, or the fallback when unset.
 *
 * Throws at load rather than yielding NaN: a NaN batch cap compares false against every value, so
 * a typo would remove the limit instead of failing the deploy. A batch or cap of zero is refused the
 * same way — a zero cap is a service that accepts nothing and reports it as throttling.
 */
function intFromEnv(name, fallback, min = 0) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${name} must be a whole number of ${min} or more, got '${raw}'.`);
  }
  return value;
}

/** A comma-separated setting as a frozen list of non-empty trimmed entries. */
function listFromEnv(name, fallback) {
  const raw = process.env[name];
  const source = raw === undefined || raw === '' ? fallback : raw;
  return Object.freeze(source.split(',').map((item) => item.trim()).filter(Boolean));
}

// ENVIRONMENT, and only ENVIRONMENT: it is what the Bicep template sets. Labels every row.
const environmentName = process.env.ENVIRONMENT || 'dev';

const apimSharedHeaderValue = process.env.APIM_SHARED_HEADER_VALUE || '';
const auditSharedHeaderValue = process.env.AUDIT_SHARED_HEADER_VALUE || '';

// azure/modules/api-function-flex.bicep deploys each of these as an app setting and documents an
// empty one as local development only. Refusing to load without them is what makes that
// documentation true: a deploy that forgot a header value serves ingest to the whole internet and
// looks healthy, and one that forgot the other two answers every staff request 401 or 503, which
// reads as a bug in the dashboard rather than a missing setting.
if (environmentName !== 'dev') {
  const required = {
    APIM_SHARED_HEADER_VALUE: apimSharedHeaderValue,
    AUDIT_SHARED_HEADER_VALUE: auditSharedHeaderValue,
    KEYCLOAK_ALLOWED_CLIENTS: process.env.KEYCLOAK_ALLOWED_CLIENTS,
    ANALYTICS_WORKSPACE_CUSTOMER_ID: process.env.ANALYTICS_WORKSPACE_CUSTOMER_ID
  };
  for (const [name, value] of Object.entries(required)) {
    if (!value) throw new Error(`${name} is required when ENVIRONMENT is '${environmentName}'.`);
  }

  // Staff bearer tokens travel to this URL's JWKS and are verified against what it returns, so plain
  // http would put the signing keys on the wire for anything in the path to replace.
  const url = process.env.KEYCLOAK_URL || '';
  if (url && !url.startsWith('https://')) {
    throw new Error(`KEYCLOAK_URL must be https when ENVIRONMENT is '${environmentName}'.`);
  }
}

module.exports = {
  logLevel: process.env.LOG_LEVEL || 'info',
  environmentName,

  // Logs Ingestion API, Direct DCR (azure/modules/event-logs.bicep). Keyless: the app publishes
  // with its user-assigned identity, which holds Monitoring Metrics Publisher on the DCR.
  //
  // Both empty is local development and the test suite, and the writer treats it as OFF rather than
  // an error. An analytics call must never be the reason a request fails.
  eventsDcrEndpoint: process.env.EVENTS_DCR_ENDPOINT || '',
  eventsDcrImmutableId: process.env.EVENTS_DCR_IMMUTABLE_ID || '',

  // Flush triggers, whichever fires first. 800 KB leaves headroom under the 1 MB per-call
  // ingestion limit for the JSON envelope.
  flushMs: intFromEnv('ANALYTICS_FLUSH_MS', 1000, 1),
  maxBatch: intFromEnv('ANALYTICS_MAX_BATCH', 100, 1),
  maxBatchBytes: intFromEnv('ANALYTICS_MAX_BATCH_BYTES', 800000, 1),

  // An allow-list rather than free text: SourceApp is a dimension every dashboard groups by, and one
  // typo in a producer would otherwise become a permanent extra row in every chart.
  allowedSourceApps: listFromEnv('ALLOWED_SOURCE_APPS', 'eagle-public,eagle-admin,eagle-api,eagle-demi'),

  // Browser origins allowed to post events. Empty refuses every request that carries an Origin, which
  // is the fail-closed half of src/auth/origin.js.
  allowedOrigins: listFromEnv('ALLOWED_ORIGINS', ''),

  apimSharedHeaderName: process.env.APIM_SHARED_HEADER_NAME || 'X-Analytics-Gateway',
  apimSharedHeaderValue,
  // The keyed /audit product stamps a second header, so a producer that only knows the gateway value
  // cannot write the audit trail.
  auditSharedHeaderValue,
  // Read by the header guards instead of each testing a value itself, so "this is local development"
  // is decided once.
  guardsDisabled: !apimSharedHeaderValue,

  // Front Door's own id. Only when it matches is X-Azure-SocketIP the address Front Door saw.
  frontDoorId: process.env.FRONT_DOOR_ID || '',

  // Holds the GeoLite2 database and the saved dashboards. No key: the identity has the data roles.
  storageAccountName: process.env.STORAGE_ACCOUNT_NAME || '',

  sessionEventCap: intFromEnv('SESSION_EVENT_CAP', 2000, 1),

  // Per client address, per minute. APIM Consumption has no rate-limit-by-key, so the request-rate
  // ceiling is the Function's own (src/ingest/ip-cap.js).
  ipEventCap: intFromEnv('IP_EVENT_CAP', 600, 1),

  // Read here rather than in src/utils/logger.js, so this file stays the only reader of process.env.
  get nodeEnv() { return process.env.NODE_ENV || ''; },

  // The read side, as getters rather than fixed values: these are consulted per request, and each
  // suite sets its own Keycloak realm and workspaces before exercising a handler.
  //
  // An empty allowedClients admits nobody (src/auth/keycloak.js) — this is a staff read API over a
  // whole tenancy's analytics, so an unset variable must not be what opens it.
  get keycloakUrl() { return (process.env.KEYCLOAK_URL || '').replace(/\/+$/, ''); },
  get keycloakRealm() { return process.env.KEYCLOAK_REALM || 'eao-epic'; },
  get keycloakAllowedClients() { return listFromEnv('KEYCLOAK_ALLOWED_CLIENTS', ''); },

  // Workspace customer ids: the one the Logs API addresses, and the two the cross-workspace legs of a
  // compiled query reference as workspace('<guid>'). Empty makes the measure that needs it answer 503
  // rather than guess.
  get analyticsWorkspaceCustomerId() { return process.env.ANALYTICS_WORKSPACE_CUSTOMER_ID || ''; },
  get eagleLogsWorkspace() { return process.env.EAGLE_LOGS_WORKSPACE || ''; },
  get demiAuditWorkspace() { return process.env.DEMI_AUDIT_WORKSPACE || ''; }
};
