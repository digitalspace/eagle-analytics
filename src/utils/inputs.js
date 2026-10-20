'use strict';

// Assigning these reaches Object.prototype through a setter, so they are never copied from a request.
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const SPACE_CODE = 32;
const DELETE_CODE = 127;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeEntries(value) {
  return Object.entries(value).filter(([key]) => !UNSAFE_KEYS.has(key));
}

// A code-point scan, not a regex: a literal control character in this source is worse.
function hasControlCharacter(value) {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code < SPACE_CODE || code === DELETE_CODE) return true;
  }
  return false;
}

module.exports = { isPlainObject, safeEntries, hasControlCharacter };
