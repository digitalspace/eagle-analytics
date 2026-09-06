'use strict';

const assert = require('node:assert');
const { test } = require('node:test');

const store = require('../src/store/dashboards-table');
const { useFakeTable } = require('./helpers/fake-table-client');

const OWNER = '11111111-1111-4111-8111-111111111111';
const READER = '22222222-2222-4222-8222-222222222222';
const ID = '33333333-3333-4333-8333-333333333333';
const OTHER_ID = '44444444-4444-4444-8444-444444444444';

function widget(over = {}) {
  return {
    id: 'w1',
    title: 'Downloads by month',
    chart: 'bar',
    query: { measure: 'events', dimension: 'EventName' },
    layout: { x: 0, y: 0, w: 6, h: 4 },
    ...over
  };
}

function dashboard(over = {}) {
  return { id: ID, name: 'Document downloads', shared: false, widgets: [widget()], updatedBy: 'jsmith', ...over };
}

test('a stored dashboard comes back with its widgets and the user who saved it', async (t) => {
  useFakeTable(t, store);

  await store.put(OWNER, dashboard());
  const found = await store.get(OWNER, ID);

  assert.strictEqual(found.name, 'Document downloads');
  assert.strictEqual(found.updatedBy, 'jsmith');
  assert.deepStrictEqual(found.widgets, [widget()]);
});

test('a private dashboard is invisible to another user', async (t) => {
  useFakeTable(t, store);

  await store.put(OWNER, dashboard({ shared: false }));

  assert.strictEqual(await store.get(READER, ID), null);
  assert.deepStrictEqual(await store.list(READER), []);
});

test('a shared dashboard is readable by another user, owner attributed', async (t) => {
  useFakeTable(t, store);

  await store.put(OWNER, dashboard({ shared: true }));
  const found = await store.get(READER, ID);

  assert.strictEqual(found.ownerId, OWNER);
  assert.strictEqual(found.widgets.length, 1);
});

test('unsharing takes the dashboard back out of every other user list', async (t) => {
  useFakeTable(t, store);

  await store.put(OWNER, dashboard({ shared: true }));
  await store.put(OWNER, dashboard({ shared: false }));

  assert.strictEqual(await store.get(READER, ID), null);
  assert.deepStrictEqual(await store.list(READER), []);
});

test('an owner list holds each own dashboard once, shared or not', async (t) => {
  useFakeTable(t, store);

  await store.put(OWNER, dashboard({ shared: true }));
  await store.put(OWNER, dashboard({ id: OTHER_ID, name: 'Sessions', shared: false }));

  const listed = await store.list(OWNER);

  assert.deepStrictEqual(listed.map((row) => row.id).sort(), [ID, OTHER_ID].sort());
});

test('a list row carries no widgets', async (t) => {
  useFakeTable(t, store);

  await store.put(OWNER, dashboard());
  const [row] = await store.list(OWNER);

  assert.strictEqual(row.widgets, undefined);
  assert.strictEqual(row.name, 'Document downloads');
});

// A list is a screen of names, and the owner id is a Keycloak sub. `mine` is what the screen needs.
test('another user sees a shared dashboard listed, with no owner id on it', async (t) => {
  useFakeTable(t, store);

  await store.put(OWNER, dashboard({ shared: true }));
  const [row] = await store.list(READER);

  assert.deepStrictEqual(row, {
    id: ID,
    name: 'Document downloads',
    shared: true,
    updatedAt: row.updatedAt,
    mine: false
  });
});

test('an own list row says so and carries no owner id either', async (t) => {
  useFakeTable(t, store);

  await store.put(OWNER, dashboard({ shared: true }));
  const [row] = await store.list(OWNER);

  assert.strictEqual(row.mine, true);
  assert.strictEqual(row.ownerId, undefined);
});

// The index row is keyed by the dashboard id alone, so reaching a shared dashboard is a point read
// rather than a scan of the shared partition.
test('a shared dashboard is read without listing the shared partition', async (t) => {
  const table = useFakeTable(t, store);
  await store.put(OWNER, dashboard({ shared: true }));

  table.listEntities = () => { throw new Error('list should not be needed to read one dashboard'); };

  assert.strictEqual((await store.get(READER, ID)).name, 'Document downloads');
});

// put deletes the index before turning a dashboard private, so a failure between the two writes leaves
// a dashboard nobody else can reach rather than one everybody still can.
test('an index row left behind by a failed unshare does not expose the dashboard', async (t) => {
  const table = useFakeTable(t, store);
  await store.put(OWNER, dashboard({ shared: true }));

  // Put the index row back by hand: the state a crash between the two writes would leave.
  await store.put(OWNER, dashboard({ shared: false }));
  await table.upsertEntity({
    partitionKey: store.SHARED_PARTITION,
    rowKey: ID,
    name: 'Document downloads',
    ownerId: OWNER,
    updatedAt: new Date().toISOString()
  });

  assert.strictEqual(await store.get(READER, ID), null);
});

test('unsharing clears the index even when the dashboard write fails', async (t) => {
  const table = useFakeTable(t, store);
  await store.put(OWNER, dashboard({ shared: true }));

  const upsert = table.upsertEntity;
  table.upsertEntity = async (entity) => {
    if (entity.partitionKey === OWNER) throw new Error('storage unavailable');
    return upsert(entity);
  };

  await assert.rejects(store.put(OWNER, dashboard({ shared: false })));
  table.upsertEntity = upsert;

  assert.deepStrictEqual(await store.list(READER), []);
});

test('a second owner cannot share a dashboard under an id somebody else already shares', async (t) => {
  useFakeTable(t, store);
  await store.put(OWNER, dashboard({ shared: true }));

  await assert.rejects(
    store.put(READER, dashboard({ shared: true, name: 'Mine now' })),
    (err) => err.status === 409
  );
  assert.strictEqual((await store.get(READER, ID)).name, 'Document downloads');
});

test('removing a dashboard leaves another owner shared index row alone', async (t) => {
  useFakeTable(t, store);
  await store.put(OWNER, dashboard({ shared: true }));

  await store.remove(READER, ID);

  assert.strictEqual((await store.get(OWNER, ID)).name, 'Document downloads');
  assert.strictEqual((await store.list(READER)).length, 1);
});

test('removing a shared dashboard clears the shared index too', async (t) => {
  useFakeTable(t, store);
  await store.put(OWNER, dashboard({ shared: true }));

  await store.remove(OWNER, ID);

  assert.strictEqual(await store.get(OWNER, ID), null);
  assert.deepStrictEqual(await store.list(READER), []);
});

test('removing a dashboard that is already gone is not an error', async (t) => {
  useFakeTable(t, store);

  await store.remove(OWNER, ID);

  assert.deepStrictEqual(await store.list(OWNER), []);
});

test('widgets that serialise past the property ceiling are rejected, not truncated', async (t) => {
  useFakeTable(t, store);
  const fat = dashboard({ widgets: [widget({ query: { note: 'x'.repeat(store.MAX_WIDGETS_BYTES + 1) } })] });

  await assert.rejects(store.put(OWNER, fat), (err) => err.status === 400);
  assert.deepStrictEqual(await store.list(OWNER), []);
});

test('an owner id that would collide with the shared partition is refused', async (t) => {
  useFakeTable(t, store);

  await assert.rejects(store.get(store.SHARED_PARTITION, ID), (err) => err.status === 400);
});
