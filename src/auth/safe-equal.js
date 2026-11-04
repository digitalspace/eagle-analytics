'use strict';

const crypto = require('crypto');

/**
 * Timing-safe compare. Both sides are hashed: timingSafeEqual throws on unequal lengths, a length
 * oracle. An empty or non-string expectation never matches: no credential configured, no way in.
 */
function safeEqual(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string' || expected === '') return false;
  return crypto.timingSafeEqual(
    crypto.createHash('sha256').update(presented).digest(),
    crypto.createHash('sha256').update(expected).digest()
  );
}

// Every entry is compared, so the time taken does not say which one matched.
function safeEqualAny(presented, expectedList) {
  let matched = false;
  for (const expected of expectedList) matched = safeEqual(presented, expected) || matched;
  return matched;
}

module.exports = { safeEqual, safeEqualAny };
