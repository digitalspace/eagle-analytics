'use strict';

const { EVENTS_STREAM, enqueue } = require('../ingest/dcr-writer');
const { enrichDevice } = require('../ingest/enrich-device');
const { clientIp, geoFields } = require('../ingest/enrich-geo');
const ipCap = require('../ingest/ip-cap');
const { allow } = require('../ingest/session-cap');
const { toEventRow, validateEventBatch } = require('../ingest/validate');

/**
 * POST /events — a batch of at most 50 product events.
 *
 * 202, not 200: the rows are buffered here and sent to the ingestion API on a timer, so at this point
 * they are accepted rather than stored. `dropped` is how many the per-session cap ignored and
 * `rejected` which entries failed validation; both are reported rather than hidden, so a producer can
 * see it is being throttled and can fix the events it still holds.
 *
 * 400 only when nothing was accepted: one malformed event must not cost the batch around it.
 *
 * The gateway and Origin checks are the route's guards, before this runs.
 */
async function events(req, res) {
  // One resolution of the address, used for the cap and then for the location lookup.
  const ip = clientIp(req);

  // Before validation, deliberately: an address over its cap should not cost this instance the work
  // of parsing what it sent. 429 and not a silent drop, because a refused batch is the producer's to
  // retry.
  const offered = Array.isArray(req.body && req.body.events) ? req.body.events.length : 1;
  if (!ipCap.allow(ip, offered)) {
    res.set('Retry-After', String(ipCap.RETRY_AFTER_SECONDS));
    res.status(429).json({ error: 'Too many events from this address. Retry in a minute.' });
    return;
  }

  const { entries, rejected, invalid } = validateEventBatch(req.body);
  if (invalid) {
    res.status(400).json({ error: invalid.errors.join('; '), index: invalid.index });
    return;
  }
  if (entries.length === 0) {
    res.status(400).json({ error: 'No event in the batch was valid.', rejected });
    return;
  }

  // One lookup for the whole batch: every event in it arrived over the same connection.
  const geo = await geoFields(ip);

  let accepted = 0;
  let dropped = 0;

  for (const event of entries) {
    const row = toEventRow(event);
    enrichDevice(row);
    Object.assign(row, geo);

    if (!allow(row.SessionId)) {
      dropped += 1;
      continue;
    }

    enqueue(EVENTS_STREAM, row);
    accepted += 1;
  }

  res.status(202).json({ accepted, dropped, rejected });
}

module.exports = { events };
