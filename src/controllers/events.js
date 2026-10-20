'use strict';

const { EVENTS_STREAM, enqueue } = require('../ingest/dcr-writer');
const { enrichDevice } = require('../ingest/enrich-device');
const { geoFields, resolveCaller } = require('../ingest/enrich-geo');
const ipCap = require('../ingest/ip-cap');
const { allow } = require('../ingest/session-cap');
const { toEventRow, validateEventBatch } = require('../ingest/validate');

// 202: rows are buffered, not yet stored. 400 only when nothing was accepted, so one bad event does
// not cost its batch; `dropped` and `rejected` tell the producer what to fix or slow down.
async function events(req, res) {
  const { ip, trusted } = resolveCaller(req);

  // Capped before validation so an over-cap address costs no parsing. Trusted proxies are exempt: the
  // cluster egress pool is shared by eagle-api and browsers, so one address cap cannot split them.
  const offered = Array.isArray(req.body && req.body.events) ? req.body.events.length : 1;
  if (!trusted && !ipCap.allow(ip, offered)) {
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
