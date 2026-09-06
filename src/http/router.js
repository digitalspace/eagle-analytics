'use strict';

/**
 * The HTTP layer: one dispatcher behind the Functions host's catch-all route.
 *
 * Azure Functions matches routes in discovery order rather than by specificity (host issue #9876),
 * so per-route app.http registrations plus a fallback route non-deterministically. One catch-all
 * plus the table in ./routes.js is the only arrangement that routes predictably.
 */

const crypto = require('crypto');
const querystring = require('querystring');

const { httpError } = require('./http-error');
const { logger, runWithRequestId } = require('../utils/logger');
const routes = require('./routes');

/** Batch ingest is the largest body this service accepts; a batch is capped at 50 events. */
const BODY_LIMIT = 1024 * 1024;

const SECURITY_HEADERS = Object.freeze({
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY'
});

const JSON_TYPE = 'application/json; charset=utf-8';

/** Methods whose request must declare a length, so the body is bounded before it is read. */
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

// A request id is echoed into a response header and into every log line the request writes, so an
// upstream one is only reused when it cannot carry a header break or forge a second line.
const REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** No entity is allowed on these, so the headers that describe one must not be sent either. */
const BODYLESS_STATUS = new Set([204, 304]);

/** `:name` becomes a single non-empty path segment. Compiled once, at module load. */
function compile(routePath) {
  const names = [];
  const source = routePath
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => {
      names.push(name);
      return '([^/]+)';
    });
  return { regex: new RegExp(`^${source}$`), names };
}

const TABLE = routes.map((route) => ({ ...route, ...compile(route.path) }));

/**
 * @returns {object|null} the matched route with its `params`, or null for a 404.
 */
function match(method, pathname) {
  // One leading `/analytics` only: APIM and the nginx proxy both mount this API under that prefix,
  // while `func start` and the Function host serve it at the root.
  let target = pathname;
  if (target === '/analytics') target = '/';
  else if (target.startsWith('/analytics/')) target = target.slice(10);
  if (target.length > 1) target = target.replace(/\/+$/, '') || '/';

  // HEAD answers off the GET route and drops the body.
  const verb = method === 'HEAD' ? 'get' : method.toLowerCase();

  for (const route of TABLE) {
    if (route.method !== verb) continue;
    const found = route.regex.exec(target);
    if (!found) continue;
    const params = {};
    route.names.forEach((name, i) => {
      try {
        params[name] = decodeURIComponent(found[i + 1]);
      } catch {
        // A malformed percent-escape (`%ZZ`) is caller error, not a server fault.
        throw httpError(400, 'Bad Request');
      }
    });
    return { ...route, params };
  }
  return null;
}

/** The response surface the controllers use. Nothing streams: the host wants one buffered body. */
function makeRes(requestId) {
  const headers = { ...SECURITY_HEADERS, 'x-request-id': requestId };

  const finish = (body, defaultType) => {
    if (res.finished) return res;
    res.finished = true;
    if (BODYLESS_STATUS.has(res.statusCode)) {
      delete headers['content-type'];
      delete headers['content-length'];
      res.body = undefined;
      return res;
    }
    if (defaultType && !headers['content-type']) headers['content-type'] = defaultType;
    res.body = body;
    headers['content-length'] = String(Buffer.byteLength(body || ''));
    return res;
  };

  const res = {
    statusCode: 200,
    headers,
    body: undefined,
    finished: false,
    status(code) { res.statusCode = code; return res; },
    set(name, value) { headers[String(name).toLowerCase()] = value; return res; },
    get(name) { return headers[String(name).toLowerCase()]; },
    json(data) { return finish(JSON.stringify(data), JSON_TYPE); },
    send(body) { return finish(body, 'text/plain; charset=utf-8'); }
  };
  res.setHeader = res.set;
  return res;
}

async function readJsonBody(request, req) {
  if (req.method === 'GET' || req.method === 'HEAD') return;

  const declared = req.headers['content-length'];
  // Without a declared length there is nothing to check the body against before reading it, and the
  // gateway in front of this API always sends one.
  if (BODY_METHODS.has(req.method) && declared === undefined) throw httpError(411, 'Content-Length required');
  if (Number(declared) > BODY_LIMIT) throw httpError(413, 'request entity too large');

  const bytes = Buffer.from(await request.arrayBuffer());
  if (bytes.length > BODY_LIMIT) throw httpError(413, 'request entity too large');
  if (bytes.length === 0) { req.body = {}; return; }

  try {
    req.body = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw httpError(400, 'invalid JSON body');
  }
}

/**
 * Run a route's guards, before the body is read: an unauthenticated caller gets its 401 without the
 * service parsing a megabyte on its behalf. A guard either throws an httpError or answers itself.
 *
 * @returns {Promise<boolean>} false when a guard has already answered.
 */
async function runGuards(route, req, res) {
  for (const guard of route.guards || []) {
    await guard()(req, res);
    if (res.finished) return false;
  }
  return true;
}

/**
 * The Functions HTTP handler. Returns an HttpResponseInit.
 */
async function dispatch(request) {
  const started = process.hrtime.bigint();
  const url = new URL(request.url);

  const headers = {};
  for (const [name, value] of request.headers.entries()) headers[name.toLowerCase()] = value;

  // Reuse an upstream trace id (Front Door, rproxy, eagle-api) so one request is one id end to end.
  const upstreamId = headers['x-request-id'] || headers['x-correlation-id'] || '';
  const requestId = REQUEST_ID.test(upstreamId) ? upstreamId : crypto.randomUUID().slice(0, 8);

  const res = makeRes(requestId);
  const req = {
    id: requestId,
    method: request.method,
    url: url.pathname + url.search,
    headers,
    query: querystring.parse(url.search.replace(/^\?/, '')),
    params: {},
    body: undefined,
    header: (name) => headers[String(name).toLowerCase()]
  };

  return runWithRequestId(requestId, async () => {
    try {
      const route = match(request.method, url.pathname);
      if (!route) {
        res.status(404).json({ error: 'Endpoint not found.' });
      } else {
        req.params = route.params;
        if (await runGuards(route, req, res)) {
          await readJsonBody(request, req);
          await route.load()(req, res);
        }
      }
    } catch (err) {
      const status = err.status || 500;
      // A 4xx is caller error the route already classified, so it gets no error-level stack.
      if (status >= 500) logger.error('Analytics API error', { error: err.message, stack: err.stack });
      if (!res.finished) {
        // Only a 500 is masked: an httpError's message is part of the API, and the 503 a missing
        // workspace raises is the reason the admin UI shows.
        res.status(status).json({ error: status === 500 ? 'Internal Server Error' : err.message });
      }
    } finally {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const line = `${req.method} ${req.url} ${res.statusCode} ${ms.toFixed(1)}ms`;
      if (res.statusCode >= 500) logger.error(line);
      else if (res.statusCode >= 400) logger.warn(line);
      else logger.info(line);
    }

    return {
      status: res.statusCode,
      headers: res.headers,
      body: request.method === 'HEAD' ? undefined : res.body
    };
  });
}

// makeRes is exported for the controller suites: a hand-rolled `{ status, json }` double answers
// twice without complaining and reports objects the real one would have serialised.
module.exports = { dispatch, makeRes };
