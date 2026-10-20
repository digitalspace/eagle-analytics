'use strict';

// The workspace is uncapped (a workspace cap drops data silently), so a looping client is what costs
// money. A session over its hourly cap is answered normally and ignored.

const config = require('../config');
const { logger } = require('../utils/logger');

const HOUR_MS = 3600000;

// Real traffic is thousands an hour; only a client minting session ids reaches this.
// ponytail: full map refuses new sessions until the hour rolls; move counters to Table Storage if hit.
const MAX_SESSIONS = 50000;

// ponytail: per-instance counter, so real ceiling = cap x instances; shared Table Storage counter if needed.
let counts = new Map();
let currentHour = -1;
let warnedFull = false;

/** @returns {boolean} false when the session is over its cap and the event should be dropped. */
function allow(sessionId) {
  // Server producers have no session; ip-cap bounds them, and one empty key would throttle them together.
  if (!sessionId) return true;

  const hour = Math.floor(Date.now() / HOUR_MS);
  if (hour !== currentHour) {
    currentHour = hour;
    counts.clear();
    warnedFull = false;
  }

  const entry = counts.get(sessionId);
  if (!entry) {
    if (counts.size >= MAX_SESSIONS) {
      if (!warnedFull) {
        warnedFull = true;
        logger.warn(`[analytics] session-cap: ${MAX_SESSIONS} sessions this hour; new ones are dropped.`);
      }
      return false;
    }
    // Read before the first event is counted, not after, so a cap of zero admits nothing.
    if (config.sessionEventCap < 1) return false;
    counts.set(sessionId, { count: 1, warned: false });
    return true;
  }

  if (entry.count < config.sessionEventCap) {
    entry.count += 1;
    return true;
  }

  if (!entry.warned) {
    entry.warned = true;
    // No session id: the app-log workspace has more readers; EagleEvents_CL can name the session.
    logger.warn(`[analytics] session-cap: a session reached ${config.sessionEventCap} events this ` +
      'hour; the rest are dropped.');
  }
  return false;
}

module.exports = {
  allow,
  MAX_SESSIONS,
  _reset: () => { counts = new Map(); currentHour = -1; warnedFull = false; }
};
