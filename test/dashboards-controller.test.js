'use strict';

const assert = require('node:assert');
const { test } = require('node:test');

const controller = require('../src/controllers/dashboards');
const store = require('../src/store/dashboards-table');
const { makeRes } = require('../src/http/router');
const { useFakeTable } = require('./helpers/fake-table-client');

const OWNER = { sub: '11111111-1111-4111-8111-111111111111', username: 'owner', roles: ['staff'] };
const STAFF = { sub: '22222222-2222-4222-8222-222222222222', username: 'colleague', roles: ['staff'] };
const ADMIN = { sub: '33333333-3333-4333-8333-333333333333', username: 'admin', roles: ['staff', 'sysadmin'] };
const ID = '44444444-4444-4444-8444-444444444444';

function widget() {
  return {
    id: 'w1',
    title: 'Sessions',
    chart: 'number',
    query: { measure: 'sessions' },
    layout: { x: 0, y: 0, w: 3, h: 2 }
  };
}

function body(over = {}) {
  return { name: 'Weekly traffic', shared: false, widgets: [widget()], ...over };
}

/**
 * The real store over an in-memory table: the authz rules under test are the ones the store's
 * partitioning enforces, so a hand-written store double would only test itself.
 */
function harness(t, user) {
  const table = useFakeTable(t, store);
  let current = user;
  return {
    table,
    as(next) { current = next; },
    async call(handler, { id, payload } = {}) {
      const res = makeRes('test-request');
      // `user` is what src/auth/keycloak.js staffGuard leaves on the request; the route table runs it
      // before any handler here, and test/staff-routes.test.js covers that wiring.
      await handler({ params: id ? { id } : {}, body: payload, headers: {}, user: current }, res);
      return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : undefined };
    }
  };
}

test('an owner creating a dashboard gets 201 and is recorded as the last editor', async (t) => {
  const h = harness(t, OWNER);

  const res = await h.call(controller.put, { id: ID, payload: body() });

  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.json.ownerId, OWNER.sub);
  assert.strictEqual(res.json.updatedBy, 'owner');
});

test('saving the same dashboard again is an update, not a second create', async (t) => {
  const h = harness(t, OWNER);
  await h.call(controller.put, { id: ID, payload: body() });

  const res = await h.call(controller.put, { id: ID, payload: body({ name: 'Renamed' }) });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.name, 'Renamed');
});

test('other staff can read a shared dashboard', async (t) => {
  const h = harness(t, OWNER);
  await h.call(controller.put, { id: ID, payload: body({ shared: true }) });
  h.as(STAFF);

  const res = await h.call(controller.get, { id: ID });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.name, 'Weekly traffic');
});

test('other staff get a 404 for a dashboard nobody shared with them', async (t) => {
  const h = harness(t, OWNER);
  await h.call(controller.put, { id: ID, payload: body({ shared: false }) });
  h.as(STAFF);

  await assert.rejects(h.call(controller.get, { id: ID }), (err) => err.status === 404);
});

test('other staff cannot overwrite a shared dashboard they do not own', async (t) => {
  const h = harness(t, OWNER);
  await h.call(controller.put, { id: ID, payload: body({ shared: true }) });
  h.as(STAFF);

  await assert.rejects(
    h.call(controller.put, { id: ID, payload: body({ shared: true, name: 'Hijacked' }) }),
    (err) => err.status === 403
  );

  h.as(OWNER);
  const after = await h.call(controller.get, { id: ID });
  assert.strictEqual(after.json.name, 'Weekly traffic');
});

test('a sysadmin can update a shared dashboard without taking it over', async (t) => {
  const h = harness(t, OWNER);
  await h.call(controller.put, { id: ID, payload: body({ shared: true }) });
  h.as(ADMIN);

  const res = await h.call(controller.put, { id: ID, payload: body({ shared: true, name: 'Corrected' }) });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.ownerId, OWNER.sub);
  assert.strictEqual(res.json.updatedBy, 'admin');
});

test('other staff cannot delete a shared dashboard they do not own', async (t) => {
  const h = harness(t, OWNER);
  await h.call(controller.put, { id: ID, payload: body({ shared: true }) });
  h.as(STAFF);

  await assert.rejects(h.call(controller.remove, { id: ID }), (err) => err.status === 403);

  h.as(OWNER);
  assert.strictEqual((await h.call(controller.get, { id: ID })).status, 200);
});

test('an owner deleting their dashboard gets 204 and it is gone', async (t) => {
  const h = harness(t, OWNER);
  await h.call(controller.put, { id: ID, payload: body() });

  const res = await h.call(controller.remove, { id: ID });

  assert.strictEqual(res.status, 204);
  await assert.rejects(h.call(controller.get, { id: ID }), (err) => err.status === 404);
});

test('a sysadmin can delete a shared dashboard owned by somebody else', async (t) => {
  const h = harness(t, OWNER);
  await h.call(controller.put, { id: ID, payload: body({ shared: true }) });
  h.as(ADMIN);

  assert.strictEqual((await h.call(controller.remove, { id: ID })).status, 204);

  h.as(OWNER);
  await assert.rejects(h.call(controller.get, { id: ID }), (err) => err.status === 404);
});

test('the list holds own dashboards and what others shared', async (t) => {
  const h = harness(t, OWNER);
  await h.call(controller.put, { id: ID, payload: body({ shared: true }) });
  h.as(STAFF);
  const ownId = '55555555-5555-4555-8555-555555555555';
  await h.call(controller.put, { id: ownId, payload: body({ name: 'Mine' }) });

  const res = await h.call(controller.list);

  assert.deepStrictEqual(res.json.dashboards.map((row) => row.name).sort(), ['Mine', 'Weekly traffic']);
});

test('a path id that is not a UUID is a 400 before the store is touched', async (t) => {
  const h = harness(t, OWNER);

  await assert.rejects(h.call(controller.get, { id: 'shared' }), (err) => err.status === 400);
});

test('a body id disagreeing with the path id is a 400', async (t) => {
  const h = harness(t, OWNER);

  await assert.rejects(
    h.call(controller.put, { id: ID, payload: body({ id: '66666666-6666-4666-8666-666666666666' }) }),
    (err) => err.status === 400
  );
});

test('an invalid widget is a 400 and stores nothing', async (t) => {
  const h = harness(t, OWNER);

  await assert.rejects(
    h.call(controller.put, { id: ID, payload: body({ widgets: [{ ...widget(), chart: 'sankey' }] }) }),
    (err) => err.status === 400
  );
  assert.deepStrictEqual((await h.call(controller.list)).json.dashboards, []);
});
