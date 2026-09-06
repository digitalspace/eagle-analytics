'use strict';

/**
 * The only writer into the analytics workspace: buffered rows, sent through the Logs Ingestion API
 * of a Direct data collection rule (azure/modules/event-logs.bicep).
 *
 *   Custom-EagleEvents_CL       product analytics, no durable identity.
 *   Custom-EagleAudit_CL        staff actions, identity-bearing.
 *   Custom-EagleEventsDaily_CL  the rollup, named here but written only by the history import.
 *
 * THIS MODULE MUST NEVER FAIL A REQUEST. enqueue() returns after appending to memory; the network
 * call happens on a timer. A failed send is logged and dropped, never thrown at the caller.
 *
 * With no EVENTS_DCR_ENDPOINT the module is inert: local development, tests, and any environment
 * where the DCR is not deployed yet.
 */

const config = require('../config');
const { logger } = require('../utils/logger');

const EVENTS_STREAM = 'Custom-EagleEvents_CL';
const AUDIT_STREAM = 'Custom-EagleAudit_CL';

// Declared here because this file is where a stream name is defined, but deliberately not buffered:
// nothing in the request path writes rollup rows. The summary rule fills the table inside the
// workspace, and scripts/import-penguin-history.js posts to this stream once, by hand.
const DAILY_STREAM = 'Custom-EagleEventsDaily_CL';

// One buffer per stream: the ingestion API takes one stream per call.
const buffers = new Map([
  [EVENTS_STREAM, []],
  [AUDIT_STREAM, []]
]);

let flushTimer = null;
let warnedDisabled = false;
let client = null;

// Injection seam for test/dcr-writer.test.js. Real code never passes anything here; one function
// rather than a transport abstraction, because there is one real implementation.
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

/**
 * Split rows into batches under both ceilings. The byte one is what matters: the ingestion API
 * rejects a body over 1 MB, and a row carrying a large Detail object can be tens of kilobytes.
 */
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

// Every drain still on the wire. enqueue() starts one without awaiting it, so without this a flush
// from the shutdown hook can return while an earlier batch is mid-upload, and that batch goes away
// with the worker.
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

// How many causes a drop line reports. Every row in a batch goes to one DCR, so the causes repeat;
// three distinct ones is already enough to tell a bad role assignment from a throttled workspace.
const MAX_REPORTED_CAUSES = 3;

/**
 * @azure/monitor-ingestion rejects with an AggregateLogsUploadError whose own `.message` is the
 * literal `undefined\n}` — its constructor interpolates an argument the SDK never passes. The
 * status code and text are on `errors[i].cause`, a RestError. Read the predicate lazily, like the
 * rest of the Azure SDK in this file, and never let the lookup itself throw: this runs from a catch.
 */
let aggregatePredicate;
function isAggregateUploadError(err) {
  if (!err) return false;
  if (aggregatePredicate === undefined) {
    try {
      aggregatePredicate = require('@azure/monitor-ingestion').isAggregateLogsUploadError;
    } catch (_err) {
      aggregatePredicate = null;
    }
  }
  return Boolean(aggregatePredicate && aggregatePredicate(err)) || Array.isArray(err.errors);
}

function causeStatusCodes(err) {
  if (isAggregateUploadError(err)) return err.errors.map((entry) => entry.cause && entry.cause.statusCode);
  return [err && err.statusCode];
}

/** A short cause for a log line. Never the failed rows: callers log this into the application log. */
function describeUploadError(err) {
  if (!isAggregateUploadError(err)) return err && err.message;

  const causes = [];
  for (const { cause } of err.errors) {
    const status = cause && cause.statusCode ? `${cause.statusCode} ` : '';
    const text = `${status}${(cause && cause.message) || 'no cause reported'}`;
    if (!causes.includes(text)) causes.push(text);
    if (causes.length === MAX_REPORTED_CAUSES) break;
  }
  return causes.join('; ');
}

/**
 * 401 and 403 mean the identity is not a Monitoring Metrics Publisher on the DCR (Owner does not
 * carry that data action). Waiting does not grant a role, so two more calls only cost latency on
 * the shutdown path and bury the one cause under three identical log lines.
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
        // Count and cause only, never the rows: SourceIp is masked by the DCR transform, and the
        // application-log workspace is read by more people than the analytics one.
        // analytics-drop-<env> alerts on this string.
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
