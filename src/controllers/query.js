'use strict';

// The KQL is returned only to a sysadmin with `?debug=1`: it names workspaces and tables, and echoing
// it to everyone invites treating it as an input.

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

exports.schema = (req, res) => res.json(describe());
