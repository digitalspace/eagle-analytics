'use strict';

const config = require('../config');
const { httpError } = require('../http/http-error');

/**
 * Which page may post events.
 *
 * `POST /events` is anonymous by design and its body carries a producer-asserted `userId`, so the
 * Origin is the only thing that says the batch came from a page EPIC published. A request with no
 * Origin is a server-side producer (eagle-api, eagle-demi) and passes: only a browser sends the
 * header, and only a browser can be pointed at this endpoint by somebody else's page.
 *
 * Skipped with the other guards in local development. An empty ALLOWED_ORIGINS refuses every browser.
 */
function originGuard(req) {
  if (config.guardsDisabled) return;

  const origin = req.header('origin');
  if (!origin) return;
  if (!config.allowedOrigins.includes(origin)) {
    throw httpError(403, 'Forbidden. This origin may not send events.');
  }
}

module.exports = { originGuard };
