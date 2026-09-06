'use strict';

// Controllers and guards are required LAZILY, one accessor each: this table loads on every cold
// start, and /health must not pay for the Azure clients a query or dashboard route pulls in.
const healthController = () => require('../controllers/health');
const eventsController = () => require('../controllers/events');
const auditController = () => require('../controllers/audit');
const queryController = () => require('../controllers/query');
const dashboardsController = () => require('../controllers/dashboards');

const apimGuard = () => require('../auth/apim-header').apimGuard;
const auditGuard = () => require('../auth/apim-header').auditGuard;
const originGuard = () => require('../auth/origin').originGuard;
const staffGuard = () => require('../auth/keycloak').staffGuard;

/**
 * Every route the API serves, in the order the dispatcher tries them. One leading `/analytics` is
 * stripped before matching, so each line covers both the prefixed and root-mounted forms.
 *
 * `guards` run in order, before the body is parsed, and answer for themselves; see runGuards in
 * ./router.js. Authentication is only ever here: a staff route's controller reads the identity
 * `staffGuard` left on `req.user` and does not verify a token of its own.
 *
 * `apimGuard` first on everything but /health, reads included: the Function host answers on a public
 * hostname, and a route that skips it is reachable without the gateway in front.
 */
module.exports = [
  { method: 'get', path: '/health', load: () => healthController().health },
  { method: 'post', path: '/events', guards: [apimGuard, originGuard], load: () => eventsController().events },
  { method: 'post', path: '/audit', guards: [apimGuard, auditGuard], load: () => auditController().audit },
  { method: 'post', path: '/query', guards: [apimGuard, staffGuard], load: () => queryController().query },
  { method: 'get', path: '/query/schema', guards: [apimGuard, staffGuard], load: () => queryController().schema },
  { method: 'get', path: '/dashboards', guards: [apimGuard, staffGuard], load: () => dashboardsController().list },
  { method: 'get', path: '/dashboards/:id', guards: [apimGuard, staffGuard], load: () => dashboardsController().get },
  { method: 'put', path: '/dashboards/:id', guards: [apimGuard, staffGuard], load: () => dashboardsController().put },
  { method: 'delete', path: '/dashboards/:id', guards: [apimGuard, staffGuard], load: () => dashboardsController().remove }
];
