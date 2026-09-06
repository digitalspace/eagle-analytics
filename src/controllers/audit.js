'use strict';

const { AUDIT_STREAM, enqueue } = require('../ingest/dcr-writer');
const { clientIp } = require('../ingest/enrich-geo');
const { validateAuditBatch } = require('../ingest/validate');

/**
 * POST /audit — staff actions from a server-side producer, at most 50 rows.
 *
 * The gate is the gateway: APIM's keyed product checks and consumes its own subscription key, so a
 * request that gets this far came from a named producer, and the two shared headers the route's guards
 * check are what make the Function's own hostname useless to anything else.
 *
 * Not capped per session and never dropped for volume: an audit trail with holes in it is not an
 * audit trail. Volume control for this endpoint is APIM's keyed product too. A malformed row is
 * reported in `rejected` and costs only itself; 400 only when no row validated.
 */
function audit(req, res) {
  const { entries, rejected, invalid } = validateAuditBatch(req.body);
  if (invalid) {
    res.status(400).json({ error: invalid.errors.join('; '), index: invalid.index });
    return;
  }
  if (entries.length === 0) {
    res.status(400).json({ error: 'No row in the batch was valid.', rejected });
    return;
  }

  // Where the producer called from, not what it claimed. Masked to /16 by the DCR transform, so the
  // full value is sent and the boundary stays in one place.
  const sourceIp = clientIp(req);

  for (const row of entries) {
    row.SourceIp = sourceIp;
    enqueue(AUDIT_STREAM, row);
  }

  res.status(202).json({ accepted: entries.length, rejected });
}

module.exports = { audit };
