'use strict';

/**
 * Checks every layer applies to a value that came from a request body. One copy, because a rule that
 * is written twice is a rule that is enforced twice differently.
 */

// Assigning any of these to a plain object reaches Object.prototype through a setter instead of
// adding a property, so they are never copied out of a request.
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const SPACE_CODE = 32;
const DELETE_CODE = 127;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Own entries of a caller-supplied object, minus the prototype-bearing keys. */
function safeEntries(value) {
  return Object.entries(value).filter(([key]) => !UNSAFE_KEYS.has(key));
}

/** Written as a code-point scan, not a regex: a literal control character in this source is worse. */
function hasControlCharacter(value) {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code < SPACE_CODE || code === DELETE_CODE) return true;
  }
  return false;
}

module.exports = { isPlainObject, safeEntries, hasControlCharacter };
