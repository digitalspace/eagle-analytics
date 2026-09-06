'use strict';

const crypto = require('crypto');

/**
 * Compare a presented credential against the expected one without leaking, through timing, either
 * its length or where the first difference is. Both sides are hashed first because timingSafeEqual
 * throws on buffers of unequal length, and that throw is itself a length oracle.
 *
 * An empty or non-string expectation never matches: no credential configured means no way in.
 */
function safeEqual(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string' || expected === '') return false;
  return crypto.timingSafeEqual(
    crypto.createHash('sha256').update(presented).digest(),
    crypto.createHash('sha256').update(expected).digest()
  );
}

module.exports = { safeEqual };
