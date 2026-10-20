'use strict';

// In-memory TableClient: only the methods src/store/dashboards-table.js uses, with RestError-shaped 404s.

const compositeKey = (partitionKey, rowKey) => `${partitionKey}\x00${rowKey}`;

const notFound = () => Object.assign(new Error('ResourceNotFound'), { statusCode: 404 });

function fakeTableClient() {
  const rows = new Map();

  return {
    rows,

    async getEntity(partitionKey, rowKey) {
      const entity = rows.get(compositeKey(partitionKey, rowKey));
      if (!entity) throw notFound();
      return { ...entity };
    },

    async upsertEntity(entity) {
      rows.set(compositeKey(entity.partitionKey, entity.rowKey), { ...entity });
    },

    async deleteEntity(partitionKey, rowKey) {
      if (!rows.delete(compositeKey(partitionKey, rowKey))) throw notFound();
    },

    listEntities({ queryOptions }) {
      const partition = /PartitionKey eq '([^']*)'/.exec(queryOptions.filter)[1];
      return (async function* stream() {
        for (const entity of rows.values()) {
          if (entity.partitionKey === partition) yield { ...entity };
        }
      })();
    }
  };
}

/** Point the store at a fresh fake for the length of one test. */
function useFakeTable(t, store) {
  const table = fakeTableClient();
  store._setClient(table);
  t.after(() => store._resetClient());
  return table;
}

module.exports = { fakeTableClient, useFakeTable };
