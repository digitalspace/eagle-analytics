'use strict';

const config = require('../config');
const { httpError } = require('../http/http-error');
const { safeEqual } = require('./safe-equal');

/**
 * The Function host answers on a public hostname of its own, which no route in front of it can take
 * away. APIM stamps a shared header on everything it forwards, and refusing a request that arrives
 * without it is what makes that hostname useless to whoever finds it.
 *
 * Every route but /health carries `apimGuard` (src/http/routes.js), reads included, so the host has
 * no reachable surface of its own. /audit carries `auditGuard` as well: that route writes the EPIC
 * audit trail and is served through APIM's keyed product, so it gets a credential of its own rather
 * than sharing the one every anonymous ingest caller's gateway also holds.
 *
 * Both are skipped when no gateway value is configured — local development only, and src/config.js
 * refuses to load on test or prod that way.
 */
function checkHeader(req, headerName, expected) {
  if (config.guardsDisabled) return;
  if (!safeEqual(req.header(headerName), expected)) throw httpError(401, 'Unauthorized');
}

// Stamped by the `analytics-machine` policy in demi-apim-<env>. Not configurable: unlike the gateway
// header, nothing outside this repository and that policy has ever needed to name it.
const AUDIT_HEADER_NAME = 'X-Analytics-Audit';

function apimGuard(req) {
  checkHeader(req, config.apimSharedHeaderName, config.apimSharedHeaderValue);
}

function auditGuard(req) {
  checkHeader(req, AUDIT_HEADER_NAME, config.auditSharedHeaderValue);
}

module.exports = { apimGuard, auditGuard, AUDIT_HEADER_NAME };
