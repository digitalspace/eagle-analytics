'use strict';

// APIM Consumption has no rate-limit-by-key and /events is anonymous, so the per-address cap lives
// here. session-cap bounds a looping session; this bounds an address minting session ids.

const config = require('../config');
const { logger } = require('../utils/logger');

const MINUTE_MS = 60000;

/** Seconds a refused caller is told to wait. One window, so a retry lands in a fresh one. */
const RETRY_AFTER_SECONDS = 60;

// ponytail: per-instance counter, so real ceiling = cap x instances; shared Table Storage counter if needed.
let counts = new Map();
let currentMinute = -1;

/** One bucket for every caller whose address could not be resolved. Throttled, not exempt. */
const UNKNOWN_ADDRESS = 'unknown';

/**
 * Charges a whole batch (this runs before validation); one over the cap is refused and charged nothing.
 * An empty ip shares the `unknown` bucket: an unresolvable address is the cheapest one to arrange.
 * @returns {boolean} false when the request should be refused.
 */
function allow(ip, count = 1) {
  const key = ip || UNKNOWN_ADDRESS;

  const minute = Math.floor(Date.now() / MINUTE_MS);
  if (minute !== currentMinute) {
    currentMinute = minute;
    counts.clear();
  }

  let entry = counts.get(key);
  if (!entry) {
    entry = { count: 0, warned: false };
    counts.set(key, entry);
  }

  if (entry.count + count > config.ipEventCap) {
    if (!entry.warned) {
      entry.warned = true;
      // No address: the app-log workspace has more readers than the analytics one.
      logger.warn(`[analytics] ip-cap: a client address reached ${config.ipEventCap} events this ` +
        'minute; further requests are refused.');
    }
    return false;
  }

  entry.count += count;
  return true;
}

module.exports = {
  allow,
  RETRY_AFTER_SECONDS,
  _reset: () => { counts = new Map(); currentMinute = -1; }
};
