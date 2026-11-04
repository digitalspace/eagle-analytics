'use strict';

const config = require('../config');
const { httpError } = require('../http/http-error');
const { safeEqualAny } = require('./safe-equal');
const { createRotatingSecrets } = require('./rotating-secret');

const secrets = createRotatingSecrets({
  apim: { uri: config.apimSharedHeaderSecretUri, fallback: config.apimSharedHeaderValue },
  audit: { uri: config.auditSharedHeaderSecretUri, fallback: config.auditSharedHeaderValue }
});

// The Function host has its own public hostname; a request without APIM's header skipped the gateway.
// guardsDisabled is local dev only: src/config.js refuses to load that way on test or prod.
async function checkHeader(req, headerName, name) {
  if (config.guardsDisabled) return;
  await secrets.ready();
  if (!safeEqualAny(req.header(headerName), secrets.acceptedValues(name))) throw httpError(401, 'Unauthorized');
}

// Stamped by the `analytics-machine` policy in demi-apim-<env>; nothing else names it.
const AUDIT_HEADER_NAME = 'X-Analytics-Audit';

async function apimGuard(req) {
  await checkHeader(req, config.apimSharedHeaderName, 'apim');
}

// /audit writes the EPIC audit trail, so it needs a credential the anonymous ingest gateway lacks.
async function auditGuard(req) {
  await checkHeader(req, AUDIT_HEADER_NAME, 'audit');
}

module.exports = { apimGuard, auditGuard, AUDIT_HEADER_NAME };
