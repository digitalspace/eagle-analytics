'use strict';

// Lazy requires: this table loads on every cold start, and /health must not pay for Azure clients.
const healthController = () => require('../controllers/health');
const eventsController = () => require('../controllers/events');
const auditController = () => require('../controllers/audit');
const queryController = () => require('../controllers/query');
const dashboardsController = () => require('../controllers/dashboards');

const apimGuard = () => require('../auth/apim-header').apimGuard;
const auditGuard = () => require('../auth/apim-header').auditGuard;
const originGuard = () => require('../auth/origin').originGuard;
const staffGuard = () => require('../auth/keycloak').staffGuard;

// Authentication lives only in `guards`; controllers trust `req.user`. apimGuard leads every route but
// /health: the host has a public hostname, so a route without it bypasses the gateway.
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
