'use strict';

// `query` passes through untouched: the compiler re-validates it on every run, and a second check
// here could store a dashboard one layer accepts and the other rejects.

const { bad } = require('../http/http-error');
const { hasControlCharacter, isPlainObject } = require('../utils/inputs');

const CHART_TYPES = Object.freeze(['line', 'bar', 'pie', 'funnel', 'number', 'table']);

const MAX_WIDGETS = 24;
const MAX_NAME = 120;
const MAX_TITLE = 80;
const MAX_WIDGET_ID = 64;

// A Table RowKey: a UUID keeps out every character Table keys reject (`/ \ # ?`, control codes).
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isDashboardId = (value) => typeof value === 'string' && ID_PATTERN.test(value);

function requireString(value, field, max) {
  if (typeof value !== 'string' || value.trim() === '') throw bad(`${field} is required.`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw bad(`${field} must be at most ${max} characters.`);
  if (hasControlCharacter(trimmed)) throw bad(`${field} must not contain control characters.`);
  return trimmed;
}

function requireBool(value, field) {
  if (typeof value !== 'boolean') throw bad(`${field} must be true or false.`);
  return value;
}

function requireInt(value, field, min) {
  if (!Number.isInteger(value) || value < min) throw bad(`${field} must be a whole number ${min} or more.`);
  return value;
}

function validateLayout(input, field) {
  if (!isPlainObject(input)) throw bad(`${field} is required.`);
  return {
    x: requireInt(input.x, `${field}.x`, 0),
    y: requireInt(input.y, `${field}.y`, 0),
    w: requireInt(input.w, `${field}.w`, 1),
    h: requireInt(input.h, `${field}.h`, 1)
  };
}

function validateWidget(input, index) {
  const field = `widgets[${index}]`;
  if (!isPlainObject(input)) throw bad(`${field} must be an object.`);
  if (!CHART_TYPES.includes(input.chart)) {
    throw bad(`${field}.chart must be one of ${CHART_TYPES.join(', ')}.`);
  }
  if (!isPlainObject(input.query)) throw bad(`${field}.query must be an object.`);
  return {
    id: requireString(input.id, `${field}.id`, MAX_WIDGET_ID),
    title: requireString(input.title, `${field}.title`, MAX_TITLE),
    chart: input.chart,
    query: input.query,
    layout: validateLayout(input.layout, `${field}.layout`)
  };
}

/** Returns the dashboard to store, unknown properties dropped; throws a 400. */
function validateDashboard(input) {
  if (!isPlainObject(input)) throw bad('A dashboard object is required.');
  if (input.id !== undefined && !isDashboardId(input.id)) throw bad('id must be a UUID.');

  const widgets = input.widgets === undefined ? [] : input.widgets;
  if (!Array.isArray(widgets)) throw bad('widgets must be an array.');
  if (widgets.length > MAX_WIDGETS) throw bad(`A dashboard holds at most ${MAX_WIDGETS} widgets.`);

  const validated = widgets.map(validateWidget);

  // The UI renders widgets keyed by id.
  const ids = new Set(validated.map((widget) => widget.id));
  if (ids.size !== validated.length) throw bad('widget ids must be unique.');

  return {
    ...(input.id === undefined ? {} : { id: input.id }),
    name: requireString(input.name, 'name', MAX_NAME),
    shared: requireBool(input.shared, 'shared'),
    widgets: validated
  };
}

module.exports = {
  validateDashboard,
  isDashboardId,
  MAX_WIDGETS,
  MAX_NAME
};
