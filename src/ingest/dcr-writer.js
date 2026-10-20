'use strict';

// MUST NEVER FAIL A REQUEST: enqueue() only buffers, the send runs on a timer, and a failed send is
// logged and dropped. With no EVENTS_DCR_ENDPOINT (local, tests) the module is inert.

const config = require('../config');
const { logger } = require('../utils/logger');

const EVENTS_STREAM = 'Custom-EagleEvents_CL';
const AUDIT_STREAM = 'Custom-EagleAudit_CL';

// Not buffered: the summary rule fills it, and only scripts/import-penguin-history.js posts to it.
const DAILY_STREAM = 'Custom-EagleEventsDaily_CL';

// One buffer per stream: the ingestion API takes one stream per call.
const buffers = new Map([
  [EVENTS_STREAM, []],
  [AUDIT_STREAM, []]
]);

let flushTimer = null;
let warnedDisabled = false;
let client = null;

// Test seam: _setTransport swaps it.
let sendBatch = uploadToDcr;

function enabled() {
  return Boolean(config.eventsDcrEndpoint && config.eventsDcrImmutableId);
}

/** Append a row and make sure a flush is coming. Never throws for a full or failing pipeline. */
function enqueue(stream, row) {
  const buffer = buffers.get(stream);
  if (!buffer) throw new Error(`[analytics] unknown stream ${stream}`);

  if (!enabled()) {
    if (!warnedDisabled) {
      warnedDisabled = true;
      logger.warn('[analytics] EVENTS_DCR_ENDPOINT is not set; rows are being discarded.');
    }
    return;
  }

  buffer.push(row);

  // .catch on both call sites: batches() stringifies outside sendWithRetry's try, so a row that
  // cannot be serialised rejects flush() with nothing attached, which is an unhandled rejection.
  if (buffer.length >= config.maxBatch) {
    flush().catch((err) => logger.error(`[analytics] flush failed: ${describeUploadError(err)}`));
    return;
  }

  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flush().catch((err) => logger.error(`[analytics] flush failed: ${describeUploadError(err)}`));
    }, config.flushMs);
    // Never hold the worker open for a pending flush; the shutdown hook in index.js drains instead.
    if (flushTimer.unref) flushTimer.unref();
  }
}

/** Batches under both caps. Bytes matter most: the API rejects a body over 1 MB, and Detail can be large. */
function batches(rows, maxCount, maxBytes) {
  const out = [];
  let current = [];
  let bytes = 2; // the enclosing []

  for (const row of rows) {
    const size = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (current.length > 0 && (current.length >= maxCount || bytes + size > maxBytes)) {
      out.push(current);
      current = [];
      bytes = 2;
    }
    current.push(row);
    bytes += size;
  }

  if (current.length > 0) out.push(current);
  return out;
}

async function uploadToDcr(stream, rows) {
  if (!client) {
    const { DefaultAzureCredential } = require('@azure/identity');
    const { LogsIngestionClient } = require('@azure/monitor-ingestion');
    client = new LogsIngestionClient(config.eventsDcrEndpoint, new DefaultAzureCredential());
  }
  await client.upload(config.eventsDcrImmutableId, stream, rows);
}

// enqueue() does not await its flush, so without this set the shutdown flush could return while an
// earlier batch is mid-upload, and that batch dies with the worker.
const inFlight = new Set();

/** Drain every buffer, and every drain another caller already started. */
async function flush() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  const drain = (async () => {
    for (const [stream, buffer] of buffers) {
      if (buffer.length === 0) continue;
      // Taken before the await so rows arriving mid-flush land in the next batch rather than twice.
      const rows = buffer.splice(0, buffer.length);
      for (const batch of batches(rows, config.maxBatch, config.maxBatchBytes)) {
        await sendWithRetry(stream, batch);
      }
    }
  })();

  inFlight.add(drain);
  try {
    await drain;
  } finally {
    inFlight.delete(drain);
  }

  // Looped, not one Promise.all: a request that flushed while this one waited added its own.
  while (inFlight.size > 0) await Promise.all([...inFlight]);
}

// A batch goes to one DCR so causes repeat; three tell a bad role from a throttled workspace.
const MAX_REPORTED_CAUSES = 3;

// The SDK's AggregateLogsUploadError has `.message` `undefined\n}`; the cause sits on errors[i].cause.
// Test the array, not the SDK's guard, which passes name-only objects and would throw in a catch.
function isAggregateUploadError(err) {
  return Boolean(err) && Array.isArray(err.errors);
}

function causeStatusCodes(err) {
  if (isAggregateUploadError(err)) return err.errors.map((entry) => entry && entry.cause && entry.cause.statusCode);
  return [err && err.statusCode];
}

/** A short cause for a log line. Never the failed rows: callers log this into the application log. */
function describeUploadError(err) {
  if (!isAggregateUploadError(err)) return err && err.message;

  const causes = [];
  for (const entry of err.errors) {
    const cause = entry && entry.cause;
    if (!cause) continue;
    const status = cause.statusCode ? `${cause.statusCode} ` : '';
    const text = `${status}${cause.message || 'no cause reported'}`;
    if (!causes.includes(text)) causes.push(text);
    if (causes.length === MAX_REPORTED_CAUSES) break;
  }
  return causes.join('; ');
}

/**
 * 401/403: the identity lacks Monitoring Metrics Publisher on the DCR (Owner does not carry it).
 * A retry cannot grant a role; it only adds shutdown latency and duplicate log lines.
 */
function isPermissionFailure(err) {
  const codes = causeStatusCodes(err);
  return codes.length > 0 && codes.every((code) => code === 401 || code === 403);
}

async function sendWithRetry(stream, batch) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await sendBatch(stream, batch);
      logger.debug(`[analytics] sent ${batch.length} row(s) to ${stream}`);
      return;
    } catch (err) {
      if (attempt === 2 || isPermissionFailure(err)) {
        const tries = attempt + 1;
        // Never the rows: the app-log workspace has more readers than analytics, and SourceIp is
        // masked only by the DCR transform. analytics-drop-<env> alerts on this string.
        logger.error(
          `[analytics] dropped ${batch.length} row(s) for ${stream} after ${tries} attempt${tries === 1 ? '' : 's'}: ${describeUploadError(err)}`
        );
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}

module.exports = {
  enqueue,
  flush,
  describeUploadError,
  EVENTS_STREAM,
  AUDIT_STREAM,
  DAILY_STREAM,
  // Test seams only.
  _setTransport: (send) => { sendBatch = send; },
  _resetTransport: () => { sendBatch = uploadToDcr; client = null; },
  _batches: batches
};
