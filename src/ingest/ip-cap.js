'use strict';

/**
 * A ceiling on how many events one client address can send in a minute.
 *
 * The gateway in front of ingest is APIM Consumption, which does not support `rate-limit-by-key`, and
 * the `/events` product is anonymous so there is no subscription key to limit by either. That leaves
 * the request-rate guard here. The per-session cap next door answers a different question: that one
 * bounds a looping client honestly reporting one session, this one bounds an address making up session
 * ids.
 *
 * ponytail: the counter is per instance, so the real ceiling is the cap times the number of live
 * instances; move it to a shared counter in Table Storage if a hard per-address limit is needed.
 */

const config = require('../config');
const { logger } = require('../utils/logger');

const MINUTE_MS = 60000;

/** Seconds a refused caller is told to wait. One window, so a retry lands in a fresh one. */
const RETRY_AFTER_SECONDS = 60;

// address -> { count, warned }. Cleared when the minute rolls over, which is also what keeps the map
// bounded: it only ever holds one minute of callers.
let counts = new Map();
let currentMinute = -1;

/** One bucket for every caller whose address could not be resolved. Throttled, not exempt. */
const UNKNOWN_ADDRESS = 'unknown';

/**
 * Charge a batch against its client address.
 *
 * Whole batches, not single events: this runs before the body is validated, so the answer has to be
 * "serve this request or refuse it". A batch that would cross the cap is refused and charged nothing,
 * so a caller that backs off gets its next minute in full.
 *
 * @param {string} ip the resolved client address. An empty one shares the `unknown` bucket: callers
 * behind a proxy that strips the header are throttled together rather than let through uncounted,
 * because an unresolvable address is also the cheapest one to arrange.
 * @param {number} count how many events the request carries.
 * @returns {boolean} false when the address is over its cap and the request should be refused.
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
      // No address: this is the application-log workspace, which is read by more people than the
      // analytics one, and an address in a log line is an address in a log line.
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
