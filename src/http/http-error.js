'use strict';

// A non-500 message reaches the caller verbatim, so it must never carry internal detail.
function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const bad = (message) => httpError(400, message);

module.exports = { httpError, bad };
