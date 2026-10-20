'use strict';

const { AUDIT_STREAM, enqueue } = require('../ingest/dcr-writer');
const { clientIp } = require('../ingest/enrich-geo');
const { validateAuditBatch } = require('../ingest/validate');

// Never capped or dropped for volume: an audit trail with holes is not an audit trail. APIM's keyed
// product gates and rate-limits producers.
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

  // Sent in full: the DCR transform masks it to /16, so that boundary stays in one place.
  const sourceIp = clientIp(req);

  for (const row of entries) {
    row.SourceIp = sourceIp;
    enqueue(AUDIT_STREAM, row);
  }

  res.status(202).json({ accepted: entries.length, rejected });
}

module.exports = { audit };
