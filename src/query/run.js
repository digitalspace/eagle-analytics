'use strict';

/**
 * Runs compiled KQL against the analytics workspace and flattens the answer to plain rows.
 *
 * `@azure/monitor-query` with DefaultAzureCredential, matching how src/ingest/dcr-writer.js talks to
 * the ingestion side: one Azure SDK family, one credential, both required lazily so /health does not
 * pay for either. (eagle-demi hand-rolls the same call over `fetch` because it has no such client
 * already installed; here one is.)
 */

const config = require('../config');
const { httpError } = require('../http/http-error');
const { logger } = require('../utils/logger');

/** Longer than this and a builder screen has already given up on the answer. */
const QUERY_TIMEOUT_MS = 30_000;

let client = null;

/** `from/to`, the form the Logs API takes, split back into the interval the SDK takes. */
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
    // Both halves of the same ceiling: the service stops working on it, and this worker stops
    // waiting. Without the abort a hung connection holds a Flex Consumption instance open.
    serverTimeoutInSeconds: Math.floor(QUERY_TIMEOUT_MS / 1000),
    abortSignal: AbortSignal.timeout(QUERY_TIMEOUT_MS)
  });
}

// Injection seam for the suites, matching src/ingest/dcr-writer.js. Real code never passes anything.
let execute = queryWorkspace;

/** Column names and positional rows, zipped into objects. */
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

/**
 * @param {string} summary the compiler's log-safe name for this query (src/query/compile-kql.js).
 * Logged in place of the query text, which names workspaces and tables the application-log workspace's
 * readers have no business seeing.
 * @returns {Promise<Array<{t?: string, value: number}>>} one row per bin and dimension combination.
 */
async function run(kql, timespan, summary = '') {
  if (!config.analyticsWorkspaceCustomerId) {
    logger.error('[analytics] ANALYTICS_WORKSPACE_CUSTOMER_ID is unset; the query endpoint cannot answer.');
    throw httpError(503, 'Analytics workspace is not configured.');
  }

  let result;
  try {
    result = await execute(kql, timespan);
  } catch (err) {
    // The SDK's own message is just the status code; the reason the service refused (SEM0260 and
    // friends) only exists in the nested error chain of the response body.
    const chain = [];
    let node = err.details?.error;
    while (node && chain.length < 5) {
      if (node.code || node.message) chain.push(`${node.code || '?'}: ${node.message || ''}`);
      node = node.innerError || node.innererror;
    }
    const status = err.statusCode ? ` status=${err.statusCode}` : '';
    const reason = chain.length ? ` (${chain.join(' <- ')})` : '';
    logger.error(`[analytics] query ${summary} failed: ${err.message}${status}${reason}`);
    throw httpError(502, 'The analytics workspace did not answer.');
  }

  // A partial result still carries rows, and a truncated chart beats an error page; the reason is
  // logged so a query that partially fails every time is visible.
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
  // Test seams only.
  _setRunner: (runner) => { execute = runner; },
  _resetRunner: () => { execute = queryWorkspace; client = null; }
};
