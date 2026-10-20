'use strict';

// Azure Functions matches routes in discovery order, not by specificity, so per-route registrations
// route unpredictably. One catch-all plus the table in ./routes.js is deterministic.

const crypto = require('crypto');
const querystring = require('querystring');

const { httpError } = require('./http-error');
const { logger, runWithRequestId } = require('../utils/logger');
const routes = require('./routes');

const BODY_LIMIT = 1024 * 1024;

const SECURITY_HEADERS = Object.freeze({
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY'
});

const JSON_TYPE = 'application/json; charset=utf-8';

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

// Echoed into a header and every log line, so an upstream id must not carry a line break.
const REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

const BODYLESS_STATUS = new Set([204, 304]);

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

function match(method, pathname) {
  // APIM and nginx mount this API under `/analytics`; `func start` and the host serve it at the root.
  let target = pathname;
  if (target === '/analytics') target = '/';
  else if (target.startsWith('/analytics/')) target = target.slice(10);
  if (target.length > 1) target = target.replace(/\/+$/, '') || '/';

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

// Nothing streams: the host wants one buffered body.
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
  // A declared length bounds the body before it is read; the gateway always sends one.
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

// Guards run before the body is read, so an unauthenticated caller never costs a megabyte parse.
// Returns false when a guard has already answered.
async function runGuards(route, req, res) {
  for (const guard of route.guards || []) {
    await guard()(req, res);
    if (res.finished) return false;
  }
  return true;
}

/** The Functions HTTP handler. Returns an HttpResponseInit. */
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
      if (status >= 500) logger.error('Analytics API error', { error: err.message, stack: err.stack });
      if (!res.finished) {
        // Only a 500 is masked: other messages are API, e.g. the 503 reason the admin UI shows.
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

// makeRes is exported for tests: a hand-rolled double answers twice without complaint.
module.exports = { dispatch, makeRes };
