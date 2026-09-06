'use strict';

/**
 * Saved dashboards, in the `dashboards` table of the analytics storage account. Two kinds of entity
 * share the table:
 *
 *   PartitionKey = ownerId (Keycloak sub), RowKey = dashboard id  the dashboard, widgets included
 *   PartitionKey = 'shared', RowKey = dashboard id                index row, name and owner only
 *
 * The index row is what makes "dashboards other staff shared" one partition read, and reaching a
 * shared dashboard by id a point read. Without it, either means scanning every user's partition,
 * which Table Storage charges and paginates per entity examined rather than per entity returned.
 * Dashboard ids are UUIDs (src/store/widget-schema.js), so one id is one dashboard; a reused one is
 * refused rather than allowed to overwrite another owner's index row.
 *
 * Keyless: the app reads and writes with its user-assigned identity, which holds Storage Table Data
 * Contributor. The account has `allowSharedKeyAccess: false`, so there is no key to hold.
 */

const dataTables = require('@azure/data-tables');

const config = require('../config');
const { httpError } = require('../http/http-error');
const { isDashboardId } = require('./widget-schema');

const TABLE_NAME = 'dashboards';
const SHARED_PARTITION = 'shared';

/**
 * A Table string property holds 64 KiB. Half of it is the widget ceiling: JSON.stringify counts
 * UTF-8 bytes while the property limit is measured after UTF-16 encoding, and a dashboard is
 * displayed, not archived — 32 KB is already far more than 24 widgets of builder JSON.
 */
const MAX_WIDGETS_BYTES = 32 * 1024;

// A Keycloak sub is a UUID, so this only ever rejects a malformed token claim. It exists because
// the value becomes a PartitionKey and an OData filter literal.
const OWNER_PATTERN = /^[A-Za-z0-9._:@-]{1,128}$/;

let client = null;

function tableClient() {
  if (client) return client;

  const account = config.storageAccountName;
  if (!account) throw new Error('STORAGE_ACCOUNT_NAME is not set; dashboards cannot be stored.');

  const { DefaultAzureCredential } = require('@azure/identity');
  client = new dataTables.TableClient(
    `https://${account}.table.core.windows.net`,
    TABLE_NAME,
    new DefaultAzureCredential()
  );
  return client;
}

function assertOwnerId(ownerId) {
  if (!OWNER_PATTERN.test(String(ownerId || '')) || ownerId === SHARED_PARTITION) {
    throw httpError(400, 'Invalid owner id.');
  }
}

function assertId(id) {
  if (!isDashboardId(id)) throw httpError(400, 'Invalid dashboard id.');
}

function partitionFilter(partitionKey) {
  // The tagged template escapes the value; a Keycloak sub is pattern-checked as well, above.
  return { queryOptions: { filter: dataTables.odata`PartitionKey eq ${partitionKey}` } };
}

/** A list row. No owner id: another staff member's Keycloak sub is not the caller's to read. */
function toSummary(entity, mine) {
  return {
    id: entity.rowKey,
    name: entity.name,
    // An index row exists only while its dashboard is shared, so for those its presence is the flag.
    shared: mine ? Boolean(entity.shared) : true,
    updatedAt: entity.updatedAt,
    mine
  };
}

function toDashboard(entity) {
  return {
    id: entity.rowKey,
    ownerId: entity.partitionKey,
    name: entity.name,
    shared: Boolean(entity.shared),
    updatedAt: entity.updatedAt,
    updatedBy: entity.updatedBy,
    widgets: JSON.parse(entity.widgetsJson || '[]')
  };
}

async function getEntityOrNull(partitionKey, rowKey) {
  try {
    return await tableClient().getEntity(partitionKey, rowKey);
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

async function deleteIfPresent(partitionKey, rowKey) {
  try {
    await tableClient().deleteEntity(partitionKey, rowKey);
  } catch (err) {
    if (err.statusCode !== 404) throw err;
  }
}

/** Own dashboards, plus the index rows for what other staff shared. Widgets are left behind. */
async function list(ownerId) {
  assertOwnerId(ownerId);
  const table = tableClient();
  const out = [];

  for await (const entity of table.listEntities(partitionFilter(ownerId))) {
    out.push(toSummary(entity, true));
  }

  for await (const entity of table.listEntities(partitionFilter(SHARED_PARTITION))) {
    // The owner's own shared dashboards came from the partition above; the index row would repeat.
    if (entity.ownerId === ownerId) continue;
    out.push(toSummary(entity, false));
  }

  return out;
}

/** A dashboard the caller owns, or one somebody shared. Null when neither. */
async function get(ownerId, id) {
  assertOwnerId(ownerId);
  assertId(id);

  const own = await getEntityOrNull(ownerId, id);
  if (own) return toDashboard(own);

  const index = await getEntityOrNull(SHARED_PARTITION, id);
  if (!index) return null;

  // The dashboard's own flag decides, never the index row: put deletes the index before turning a
  // dashboard private, but a failure between those two writes would otherwise keep it readable.
  const shared = await getEntityOrNull(index.ownerId, id);
  return shared && shared.shared ? toDashboard(shared) : null;
}

/** Create or replace, and bring the shared index in line. Returns what was stored. */
async function put(ownerId, dashboard) {
  assertOwnerId(ownerId);
  assertId(dashboard.id);

  const widgetsJson = JSON.stringify(dashboard.widgets || []);
  if (Buffer.byteLength(widgetsJson) > MAX_WIDGETS_BYTES) {
    throw httpError(400, `A dashboard's widgets must serialise to at most ${MAX_WIDGETS_BYTES} bytes.`);
  }

  const entity = {
    partitionKey: ownerId,
    rowKey: dashboard.id,
    name: dashboard.name,
    shared: Boolean(dashboard.shared),
    widgetsJson,
    updatedAt: new Date().toISOString(),
    updatedBy: dashboard.updatedBy || ''
  };

  const table = tableClient();

  if (entity.shared) {
    const index = await getEntityOrNull(SHARED_PARTITION, dashboard.id);
    if (index && index.ownerId !== ownerId) {
      throw httpError(409, 'Another staff member already shares a dashboard with that id.');
    }
    await table.upsertEntity(entity, 'Replace');
    await table.upsertEntity({
      partitionKey: SHARED_PARTITION,
      rowKey: dashboard.id,
      name: entity.name,
      ownerId,
      updatedAt: entity.updatedAt
    }, 'Replace');
  } else {
    // Index row first: while both states disagree the dashboard is unreachable rather than readable
    // by everyone, which is the failure to prefer when unsharing.
    await deleteIfPresent(SHARED_PARTITION, dashboard.id);
    await table.upsertEntity(entity, 'Replace');
  }

  return toDashboard(entity);
}

async function remove(ownerId, id) {
  assertOwnerId(ownerId);
  assertId(id);
  await deleteIfPresent(ownerId, id);
  // The index RowKey is the id alone, so it is checked before deletion: never another owner's row.
  const index = await getEntityOrNull(SHARED_PARTITION, id);
  if (index && index.ownerId === ownerId) await deleteIfPresent(SHARED_PARTITION, id);
}

module.exports = {
  list,
  get,
  put,
  remove,
  SHARED_PARTITION,
  MAX_WIDGETS_BYTES,
  // Test seam: an in-memory stand-in for the handful of TableClient methods used above.
  _setClient: (fake) => { client = fake; },
  _resetClient: () => { client = null; }
};
