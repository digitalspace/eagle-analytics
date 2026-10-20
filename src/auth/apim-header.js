'use strict';

const config = require('../config');
const { httpError } = require('../http/http-error');
const { safeEqual } = require('./safe-equal');

// The Function host has its own public hostname; a request without APIM's header skipped the gateway.
// guardsDisabled is local dev only: src/config.js refuses to load that way on test or prod.
function checkHeader(req, headerName, expected) {
  if (config.guardsDisabled) return;
  if (!safeEqual(req.header(headerName), expected)) throw httpError(401, 'Unauthorized');
}

// Stamped by the `analytics-machine` policy in demi-apim-<env>; nothing else names it.
const AUDIT_HEADER_NAME = 'X-Analytics-Audit';

function apimGuard(req) {
  checkHeader(req, config.apimSharedHeaderName, config.apimSharedHeaderValue);
}

// /audit writes the EPIC audit trail, so it needs a credential the anonymous ingest gateway lacks.
function auditGuard(req) {
  checkHeader(req, AUDIT_HEADER_NAME, config.auditSharedHeaderValue);
}

module.exports = { apimGuard, auditGuard, AUDIT_HEADER_NAME };
