'use strict';

// Rows: (ownerId, id) holds the dashboard; ('shared', id) is an index row so shared dashboards are one
// partition read, not a scan of every owner's partition.

const dataTables = require('@azure/data-tables');

const config = require('../config');
const { httpError } = require('../http/http-error');
const { isDashboardId } = require('./widget-schema');

const TABLE_NAME = 'dashboards';
const SHARED_PARTITION = 'shared';

// Half the 64 KiB property limit: that limit is UTF-16, while this counts UTF-8 bytes.
const MAX_WIDGETS_BYTES = 32 * 1024;

// The value becomes a PartitionKey and an OData filter literal.
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
  return { queryOptions: { filter: dataTables.odata`PartitionKey eq ${partitionKey}` } };
}

// No owner id: another staff member's Keycloak sub is not the caller's to read.
function toSummary(entity, mine) {
  return {
    id: entity.rowKey,
    name: entity.name,
    // An index row exists only while its dashboard is shared.
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

async function list(ownerId) {
  assertOwnerId(ownerId);
  const table = tableClient();
  const out = [];

  for await (const entity of table.listEntities(partitionFilter(ownerId))) {
    out.push(toSummary(entity, true));
  }

  for await (const entity of table.listEntities(partitionFilter(SHARED_PARTITION))) {
    if (entity.ownerId === ownerId) continue;
    out.push(toSummary(entity, false));
  }

  return out;
}

async function get(ownerId, id) {
  assertOwnerId(ownerId);
  assertId(id);

  const own = await getEntityOrNull(ownerId, id);
  if (own) return toDashboard(own);

  const index = await getEntityOrNull(SHARED_PARTITION, id);
  if (!index) return null;

  // The dashboard's own flag decides, never the index row, which can outlive a failed unshare.
  const shared = await getEntityOrNull(index.ownerId, id);
  return shared && shared.shared ? toDashboard(shared) : null;
}

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
    // Index row first: a half-done unshare leaves it unreachable, not readable by everyone.
    await deleteIfPresent(SHARED_PARTITION, dashboard.id);
    await table.upsertEntity(entity, 'Replace');
  }

  return toDashboard(entity);
}

async function remove(ownerId, id) {
  assertOwnerId(ownerId);
  assertId(id);
  await deleteIfPresent(ownerId, id);
  // The index RowKey is the id alone: check the owner so another owner's row survives.
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
  _setClient: (fake) => { client = fake; },
  _resetClient: () => { client = null; }
};
