'use strict';

/**
 * An error the dispatcher answers with rather than turning into a 500. Anything carrying a `status`
 * other than 500 has its message returned to the caller verbatim (src/http/router.js), so the message is
 * part of the API and must never carry internal detail.
 */
function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/** The one every validator throws: the caller sent something this API cannot act on. */
const bad = (message) => httpError(400, message);

module.exports = { httpError, bad };
