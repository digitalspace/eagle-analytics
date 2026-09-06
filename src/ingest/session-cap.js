'use strict';

/**
 * A ceiling on how many events one session can contribute in an hour.
 *
 * The analytics workspace is deliberately uncapped, because a cap on a workspace drops data silently
 * once it trips. That leaves a client stuck in a loop as the way this service costs money, and this
 * is the guard against it: a session that has said enough is answered normally and ignored.
 *
 * ponytail: the counter is per instance, so the real ceiling is the cap times the number of live
 * instances; move it to a shared counter in Table Storage if the bill ever needs a hard limit.
 */

const config = require('../config');
const { logger } = require('../utils/logger');

const HOUR_MS = 3600000;

/**
 * How many sessions one instance tracks in an hour. An hour of real traffic is thousands, so this is
 * only ever reached by a client minting session ids, which is the case the ip-cap next door bounds by
 * address; the map is what would grow first.
 *
 * ponytail: a full map refuses NEW sessions until the hour rolls over, so a flood can lock out
 * genuine visitors for the rest of that hour; move both counters to Table Storage if that shows up.
 */
const MAX_SESSIONS = 50000;

// sessionId -> { count, warned }. Emptied when the hour rolls over, which is also what keeps the map
// from growing without bound: it only ever holds one hour of sessions.
let counts = new Map();
let currentHour = -1;
let warnedFull = false;

/**
 * Count one event against its session.
 *
 * @returns {boolean} false when the session is over its cap and the event should be dropped.
 */
function allow(sessionId) {
  // A server-side producer has no session (src/ingest/validate.js); its volume is the ip-cap's to
  // bound, and pooling every such event under one empty key would throttle them as if they shared one.
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
    // No session id: this workspace is read by more people than the analytics one. The count is what
    // an operator needs, and EagleEvents_CL can name the session.
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
