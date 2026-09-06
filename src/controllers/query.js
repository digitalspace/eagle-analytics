'use strict';

/**
 * The read side: a builder request in, rows out. Staff only — the route table's `staffGuard` has
 * already run and left the identity on `req.user`.
 *
 * The compiled KQL is not part of the normal response. It names workspaces and tables, and the whole
 * point of the compiler is that a caller never writes query text — echoing it back invites treating
 * it as an input. `?debug=1` returns it to a sysadmin, which is who debugs a wrong chart.
 */

const { compile } = require('../query/compile-kql');
const { describe } = require('../query/schema');
const { run } = require('../query/run');
const { logger } = require('../utils/logger');

const DEBUG_ROLE = 'sysadmin';

function wantsKql(req) {
  return req.query && req.query.debug === '1' && req.user.roles.includes(DEBUG_ROLE);
}

exports.query = async (req, res) => {
  const { kql, timespan, summary } = compile(req.body);

  const rows = await run(kql, timespan, summary);

  logger.info(`[analytics] ${req.user.username} ran ${summary} for ${rows.length} row(s)`);

  return res.json(wantsKql(req) ? { rows, kql } : { rows });
};

/** The whitelist, so the builder offers exactly what the compiler accepts and nothing else. */
exports.schema = (req, res) => res.json(describe());
