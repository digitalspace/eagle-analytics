'use strict';

const assert = require('node:assert');
const { test } = require('node:test');

const { loadModule } = require('./helpers/load-config');

const ALLOWED = 'https://eagle-public-test.example.invalid';
const SECOND = 'http://localhost:4200';

const loadGuard = (env) => loadModule('auth/origin', env).originGuard;

/** `config.allowedOrigins` is fixed at load, so a case names the list it is about. */
const guardFor = (origins) => loadGuard({ ENVIRONMENT: 'test', ALLOWED_ORIGINS: origins });

function request(headers) {
  return { header: (name) => headers[name.toLowerCase()] };
}

const FORBIDDEN = { status: 403, message: 'Forbidden. This origin may not send events.' };

test('a page on an allowed origin may post events', () => {
  const guard = guardFor(ALLOWED);
  assert.doesNotThrow(() => guard(request({ origin: ALLOWED })));
});

test('somebody else\'s page is refused', () => {
  const guard = guardFor(ALLOWED);
  assert.throws(() => guard(request({ origin: 'https://not-ours.example.invalid' })), FORBIDDEN);
});

// A server-side producer (eagle-api, eagle-demi) sends no Origin, and only a browser can be pointed
// at this endpoint by a page somebody else published.
test('a request with no Origin header is a server-side producer and passes', () => {
  const guard = guardFor(ALLOWED);
  assert.doesNotThrow(() => guard(request({})));
});

// An Origin present but empty is not a browser-sent Origin; it reads as absent, same as above.
test('an empty Origin header is treated as absent', () => {
  const guard = guardFor(ALLOWED);
  assert.doesNotThrow(() => guard(request({ origin: '' })));
});

// The three ways a near-match is still a different origin. The comparison is exact: the header a
// browser sends is already the serialised origin, so anything else came from somewhere else.
for (const [label, origin] of [
  ['cased differently', 'https://EAGLE-PUBLIC-TEST.example.invalid'],
  ['carrying a trailing slash', `${ALLOWED}/`],
  ['carrying a path', `${ALLOWED}/events`]
]) {
  test(`an origin ${label} is refused`, () => {
    const guard = guardFor(ALLOWED);
    assert.throws(() => guard(request({ origin })), FORBIDDEN);
  });
}

// The scheme and port are part of the origin: http and https on one host are two entries, and so are
// two ports.
test('the same host on another scheme is refused', () => {
  const guard = guardFor(ALLOWED);
  assert.throws(() => guard(request({ origin: ALLOWED.replace('https:', 'http:') })), FORBIDDEN);
});

test('the same host on another port is refused', () => {
  const guard = guardFor(SECOND);
  assert.throws(() => guard(request({ origin: 'http://localhost:4300' })), FORBIDDEN);
});

test('every entry in the list is allowed, not just the first', () => {
  const guard = guardFor(`${ALLOWED}, ${SECOND}`);
  assert.doesNotThrow(() => guard(request({ origin: ALLOWED })));
  assert.doesNotThrow(() => guard(request({ origin: SECOND })));
});

// There is no wildcard: `*` is one literal entry, which no browser ever sends as its Origin.
test('a list of * does not open the endpoint to every origin', () => {
  const guard = guardFor('*');
  assert.throws(() => guard(request({ origin: ALLOWED })), FORBIDDEN);
});

// The fail-closed half: a deploy that forgot ALLOWED_ORIGINS serves no browser rather than all of them.
test('an empty allow-list refuses every browser', () => {
  const guard = guardFor(undefined);
  assert.throws(() => guard(request({ origin: ALLOWED })), FORBIDDEN);
});

test('an empty allow-list still passes a producer that sends no Origin', () => {
  const guard = guardFor(undefined);
  assert.doesNotThrow(() => guard(request({})));
});

// Local development runs with no gateway header value, which switches every guard off; the same
// setting must not switch the Origin check off in a deployed environment.
test('with the guards disabled locally any origin passes', () => {
  const guard = loadGuard({
    ENVIRONMENT: 'dev',
    APIM_SHARED_HEADER_VALUE: undefined,
    ALLOWED_ORIGINS: ALLOWED
  });
  assert.doesNotThrow(() => guard(request({ origin: 'https://not-ours.example.invalid' })));
});

test('a deployed environment enforces the check even with an origin nobody listed', () => {
  const guard = loadGuard({ ENVIRONMENT: 'test', ALLOWED_ORIGINS: ALLOWED });
  assert.throws(() => guard(request({ origin: 'https://not-ours.example.invalid' })), FORBIDDEN);
});
