'use strict';

const assert = require('node:assert');
const { test } = require('node:test');

const healthController = require('../src/controllers/health');
const { httpError } = require('../src/http/http-error');
const { dispatch, makeRes } = require('../src/http/router');

const GENERATED_ID = /^[0-9a-f]{8}$/;

/** /health is the one route with no guards, so these cases are about the dispatcher and nothing else. */
function call(headers = {}, path = '/analytics/health') {
  return dispatch({
    method: 'GET',
    url: `https://analytics-api-fc-test.azurewebsites.net${path}`,
    headers: new Map(Object.entries(headers)),
    arrayBuffer: async () => Buffer.from('')
  });
}

test('an upstream request id is reused, so one request is one id end to end', async () => {
  const response = await call({ 'x-request-id': 'front-door.7f3a-9021' });

  assert.strictEqual(response.headers['x-request-id'], 'front-door.7f3a-9021');
});

test('a correlation id is used when there is no request id', async () => {
  const response = await call({ 'x-correlation-id': 'eagle-api-4821' });

  assert.strictEqual(response.headers['x-correlation-id'], undefined);
  assert.strictEqual(response.headers['x-request-id'], 'eagle-api-4821');
});

// The id is echoed into a response header and into every log line the request writes, so an upstream
// one is only reused when it cannot break the header or forge a second log line.
const REJECTED_IDS = [
  ['a header break', 'abc\r\nx-injected: yes'],
  ['a newline', 'abc\ndef'],
  ['a space and a bracket', 'abc [analytics] fake line'],
  ['65 characters', 'x'.repeat(65)]
];

for (const [what, id] of REJECTED_IDS) {
  test(`a request id carrying ${what} is replaced by a generated one`, async () => {
    const response = await call({ 'x-request-id': id });

    assert.match(response.headers['x-request-id'], GENERATED_ID);
  });
}

test('a request with no id at all gets one', async () => {
  const response = await call();

  assert.match(response.headers['x-request-id'], GENERATED_ID);
});

test('an unknown path is a 404 rather than a match on the nearest route', async () => {
  const response = await call({}, '/analytics/healthz');

  assert.strictEqual(response.status, 404);
});

// No entity is allowed on either status, so the headers that describe one must not be sent: a 204 with
// Content-Length: 0 is what makes a proxy or an XHR client report a malformed response.
for (const status of [204, 304]) {
  test(`a ${status} answer carries no content headers and no body`, () => {
    const res = makeRes('abcd1234');

    res.status(status).send('this should not be sent');

    assert.strictEqual(res.body, undefined);
    assert.strictEqual(res.headers['content-type'], undefined);
    assert.strictEqual(res.headers['content-length'], undefined);
    assert.strictEqual(res.headers['x-request-id'], 'abcd1234');
  });
}

/** The error handler is only reachable through a route, and /health is the one without guards. */
async function callThrowing(err) {
  const original = healthController.health;
  healthController.health = () => { throw err; };
  try {
    return await call();
  } finally {
    healthController.health = original;
  }
}

test('a 503 httpError keeps its message, which the admin UI shows', async () => {
  const response = await callThrowing(httpError(503, 'Analytics workspace is not configured.'));

  assert.strictEqual(response.status, 503);
  assert.deepStrictEqual(JSON.parse(response.body), { error: 'Analytics workspace is not configured.' });
});

test('an unexpected throw is masked, so no internal detail reaches a caller', async () => {
  const response = await callThrowing(new Error('connect ECONNREFUSED 10.0.0.4:5432'));

  assert.strictEqual(response.status, 500);
  assert.deepStrictEqual(JSON.parse(response.body), { error: 'Internal Server Error' });
});

test('a 200 answer still describes its body', () => {
  const res = makeRes('abcd1234');

  res.status(200).json({ ok: true });

  assert.strictEqual(res.headers['content-type'], 'application/json; charset=utf-8');
  assert.strictEqual(res.headers['content-length'], String(Buffer.byteLength(res.body)));
});
