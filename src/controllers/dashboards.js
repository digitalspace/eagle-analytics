'use strict';

const { httpError } = require('../http/http-error');
const { validateDashboard, isDashboardId } = require('../store/widget-schema');

// Lazy, so a cold start serving only /health or ingest skips the Table client.
let cached = null;

function store() {
  if (!cached) cached = require('../store/dashboards-table');
  return cached;
}

const isSysadmin = (user) => Array.isArray(user.roles) && user.roles.includes('sysadmin');

function pathId(req) {
  const id = req.params.id;
  if (!isDashboardId(id)) throw httpError(400, 'Dashboard id must be a UUID.');
  return id;
}

function notFound() {
  // Also for an unshared dashboard: a 403 would reveal which ids exist in other partitions.
  return httpError(404, 'Dashboard not found.');
}

exports.list = async (req, res) => {
  res.json({ dashboards: await store().list(req.user.sub) });
};

exports.get = async (req, res) => {
  const dashboard = await store().get(req.user.sub, pathId(req));
  if (!dashboard) throw notFound();
  res.json(dashboard);
};

exports.put = async (req, res) => {
  const user = req.user;
  const id = pathId(req);
  const body = req.body || {};
  if (body.id !== undefined && body.id !== id) throw httpError(400, 'The body id must match the path id.');

  const dashboard = validateDashboard({ ...body, id });
  const existing = await store().get(user.sub, id);

  // An id another user holds unshared is still a create here; their partition stays untouched.
  let ownerId = user.sub;
  if (existing && existing.ownerId !== user.sub) {
    if (!isSysadmin(user)) throw httpError(403, 'Only the owner can change this dashboard.');
    ownerId = existing.ownerId;
  }

  const saved = await store().put(ownerId, { ...dashboard, updatedBy: user.username });
  res.status(existing ? 200 : 201).json(saved);
};

exports.remove = async (req, res) => {
  const user = req.user;
  const id = pathId(req);

  const existing = await store().get(user.sub, id);
  if (!existing) throw notFound();
  if (existing.ownerId !== user.sub && !isSysadmin(user)) {
    throw httpError(403, 'Only the owner can delete this dashboard.');
  }

  await store().remove(existing.ownerId, id);
  res.status(204).send('');
};
