'use strict';

const config = require('../config');
const { httpError } = require('../http/http-error');

// POST /events is anonymous, so Origin is the only proof a batch came from an EPIC page. No Origin
// passes: only a browser sends one, and only a browser can be driven by somebody else's page.
function originGuard(req) {
  if (config.guardsDisabled) return;

  const origin = req.header('origin');
  if (!origin) return;
  if (!config.allowedOrigins.includes(origin)) {
    throw httpError(403, 'Forbidden. This origin may not send events.');
  }
}

module.exports = { originGuard };
