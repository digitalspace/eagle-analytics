'use strict';

// The only reader of process.env.

// Throws at load: a NaN cap compares false against everything, so a typo would remove the limit, and
// a zero cap accepts nothing while reporting it as throttling.
function intFromEnv(name, fallback, min = 0) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${name} must be a whole number of ${min} or more, got '${raw}'.`);
  }
  return value;
}

function listFromEnv(name, fallback) {
  const raw = process.env[name];
  const source = raw === undefined || raw === '' ? fallback : raw;
  return Object.freeze(source.split(',').map((item) => item.trim()).filter(Boolean));
}

// Only ENVIRONMENT: it is what the Bicep template sets.
const environmentName = process.env.ENVIRONMENT || 'dev';

// An unreadable secret arrives as the literal '@Microsoft.KeyVault(...)' string, built from public
// names in azure/, so a non-empty check would accept a value anyone can reconstruct.
const KEY_VAULT_REFERENCE = /^@Microsoft\.KeyVault\(/i;

const unresolvedSecrets = [];

function secretFromEnv(name) {
  const raw = (process.env[name] || '').trim();
  if (!KEY_VAULT_REFERENCE.test(raw)) return raw;
  unresolvedSecrets.push(name);
  return '';
}

const apimSharedHeaderValue = secretFromEnv('APIM_SHARED_HEADER_VALUE');
const auditSharedHeaderValue = secretFromEnv('AUDIT_SHARED_HEADER_VALUE');

// A missing header value would serve ingest to the internet and look healthy; a missing client list
// or workspace reads as a dashboard bug. Fail the load instead.
if (environmentName !== 'dev') {
  const required = {
    APIM_SHARED_HEADER_VALUE: apimSharedHeaderValue,
    AUDIT_SHARED_HEADER_VALUE: auditSharedHeaderValue,
    KEYCLOAK_ALLOWED_CLIENTS: process.env.KEYCLOAK_ALLOWED_CLIENTS,
    ANALYTICS_WORKSPACE_CUSTOMER_ID: process.env.ANALYTICS_WORKSPACE_CUSTOMER_ID
  };
  for (const [name, value] of Object.entries(required)) {
    if (unresolvedSecrets.includes(name)) {
      throw new Error(
        `${name} did not resolve: its Key Vault reference was passed through as the value. Check the ` +
        "Function's Key Vault reference identity, its role assignment on the vault, and the app's " +
        'network path to the vault.'
      );
    }
    if (!value) throw new Error(`${name} is required when ENVIRONMENT is '${environmentName}'.`);
  }

  // Tokens are verified against this URL's JWKS; over http anything on the path could swap the keys.
  const url = process.env.KEYCLOAK_URL || '';
  if (url && !url.startsWith('https://')) {
    throw new Error(`KEYCLOAK_URL must be https when ENVIRONMENT is '${environmentName}'.`);
  }
}

module.exports = {
  logLevel: process.env.LOG_LEVEL || 'info',
  environmentName,

  // Both empty turns the writer off, not into an error: analytics must never fail a request.
  eventsDcrEndpoint: process.env.EVENTS_DCR_ENDPOINT || '',
  eventsDcrImmutableId: process.env.EVENTS_DCR_IMMUTABLE_ID || '',

  // 800 KB leaves room for the JSON envelope under the 1 MB per-call ingestion limit.
  flushMs: intFromEnv('ANALYTICS_FLUSH_MS', 1000, 1),
  maxBatch: intFromEnv('ANALYTICS_MAX_BATCH', 100, 1),
  maxBatchBytes: intFromEnv('ANALYTICS_MAX_BATCH_BYTES', 800000, 1),

  // An allow-list: one producer typo would otherwise be a permanent extra row in every chart.
  allowedSourceApps: listFromEnv('ALLOWED_SOURCE_APPS', 'eagle-public,eagle-admin,eagle-api,eagle-demi'),

  // Empty refuses every request with an Origin (fail-closed, src/auth/origin.js).
  allowedOrigins: listFromEnv('ALLOWED_ORIGINS', ''),

  apimSharedHeaderName: process.env.APIM_SHARED_HEADER_NAME || 'X-Analytics-Gateway',
  apimSharedHeaderValue,
  // A second header, so a producer knowing only the gateway value cannot write the audit trail.
  auditSharedHeaderValue,
  guardsDisabled: !apimSharedHeaderValue,

  // Only when it matches is X-Azure-SocketIP the address Front Door saw.
  frontDoorId: process.env.FRONT_DOOR_ID || '',

  storageAccountName: process.env.STORAGE_ACCOUNT_NAME || '',

  sessionEventCap: intFromEnv('SESSION_EVENT_CAP', 2000, 1),

  // Per address per minute. APIM Consumption has no rate-limit-by-key, so the Function caps itself.
  ipEventCap: intFromEnv('IP_EVENT_CAP', 600, 1),

  // Cluster egress IPs (as X-Client-Ip): enrich-geo.js looks one hop back in X-Forwarded-For so the
  // cluster is not capped as one caller. Empty trusts no proxy.
  trustedProxyIps: listFromEnv('TRUSTED_PROXY_IPS', ''),

  get nodeEnv() { return process.env.NODE_ENV || ''; },

  // Getters: read per request, and each test suite sets its own realm and workspaces. An empty
  // allowedClients admits nobody (src/auth/keycloak.js).
  get keycloakUrl() { return (process.env.KEYCLOAK_URL || '').replace(/\/+$/, ''); },
  get keycloakRealm() { return process.env.KEYCLOAK_REALM || 'eao-epic'; },
  get keycloakAllowedClients() { return listFromEnv('KEYCLOAK_ALLOWED_CLIENTS', ''); },

  // Workspace customer ids. Empty makes the measure that needs one answer 503 rather than guess.
  get analyticsWorkspaceCustomerId() { return process.env.ANALYTICS_WORKSPACE_CUSTOMER_ID || ''; },
  get eagleLogsWorkspace() { return process.env.EAGLE_LOGS_WORKSPACE || ''; },
  get demiAuditWorkspace() { return process.env.DEMI_AUDIT_WORKSPACE || ''; }
};
