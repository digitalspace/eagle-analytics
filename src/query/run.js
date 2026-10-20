'use strict';

// SDK clients are required lazily so /health does not pay for them.

const config = require('../config');
const { httpError } = require('../http/http-error');
const { logger } = require('../utils/logger');

// Past this a builder screen has already given up on the answer.
const QUERY_TIMEOUT_MS = 30_000;

let client = null;

function interval(timespan) {
  const [from, to] = String(timespan).split('/');
  return { startTime: new Date(from), endTime: new Date(to) };
}

async function queryWorkspace(kql, timespan) {
  if (!client) {
    const { DefaultAzureCredential } = require('@azure/identity');
    const { LogsQueryClient } = require('@azure/monitor-query');
    client = new LogsQueryClient(new DefaultAzureCredential());
  }
  return client.queryWorkspace(config.analyticsWorkspaceCustomerId, kql, interval(timespan), {
    // Without the abort a hung connection holds a Flex Consumption instance open.
    serverTimeoutInSeconds: Math.floor(QUERY_TIMEOUT_MS / 1000),
    abortSignal: AbortSignal.timeout(QUERY_TIMEOUT_MS)
  });
}

let execute = queryWorkspace;

function zip(table) {
  const names = (table.columnDescriptors || []).map((column) => column.name);
  return (table.rows || []).map((row) => {
    const out = {};
    names.forEach((name, index) => {
      const cell = row[index];
      if (name === 't') out.t = cell instanceof Date ? cell.toISOString() : cell;
      else if (name === 'value') out.value = cell === null || cell === undefined ? 0 : Number(cell);
      else out[name] = cell;
    });
    return out;
  });
}

/** `summary` is logged in place of the KQL, which must never reach a log. */
async function run(kql, timespan, summary = '') {
  if (!config.analyticsWorkspaceCustomerId) {
    logger.error('[analytics] ANALYTICS_WORKSPACE_CUSTOMER_ID is unset; the query endpoint cannot answer.');
    throw httpError(503, 'Analytics workspace is not configured.');
  }

  let result;
  try {
    result = await execute(kql, timespan);
  } catch (err) {
    // The reason (SEM0260 etc.) is only in the nested error chain. Codes only: the messages quote
    // table names and workspace GUIDs.
    const chain = [];
    let node = err.details?.error;
    while (node && chain.length < 5) {
      if (node.code) chain.push(node.code);
      node = node.innerError || node.innererror;
    }
    const status = err.statusCode ? ` status=${err.statusCode}` : '';
    const reason = chain.length ? ` (${chain.join(' <- ')})` : '';
    logger.error(`[analytics] query ${summary} failed: ${err.message}${status}${reason}`);
    throw httpError(502, 'The analytics workspace did not answer.');
  }

  // A truncated chart beats an error page; the warning makes a repeat partial failure visible.
  if (result.status === 'Failure') {
    logger.error(`[analytics] query ${summary} rejected: ${(result.partialError || result).message}`);
    throw httpError(502, 'The analytics workspace rejected the query.');
  }
  if (result.status === 'PartialFailure') {
    logger.warn(`[analytics] query ${summary} partial: ${(result.partialError || {}).message}`);
  }

  const table = (result.tables || result.partialTables || [])[0];
  return table ? zip(table) : [];
}

module.exports = {
  run,
  _setRunner: (runner) => { execute = runner; },
  _resetRunner: () => { execute = queryWorkspace; client = null; }
};
