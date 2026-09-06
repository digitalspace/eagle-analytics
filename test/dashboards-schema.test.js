'use strict';

const assert = require('node:assert');
const { test } = require('node:test');

const { validateDashboard, MAX_WIDGETS, MAX_NAME } = require('../src/store/widget-schema');

function widget(over = {}) {
  return {
    id: 'w1',
    title: 'Sessions per day',
    chart: 'line',
    query: { measure: 'sessions', bin: 'day' },
    layout: { x: 0, y: 0, w: 12, h: 5 },
    ...over
  };
}

function dashboard(over = {}) {
  return { name: 'Weekly traffic', shared: false, widgets: [widget()], ...over };
}

function assertRejected(input, pattern) {
  assert.throws(() => validateDashboard(input), (err) => err.status === 400 && pattern.test(err.message));
}

test('a valid dashboard keeps its widgets and drops properties nobody declared', () => {
  const result = validateDashboard(dashboard({ createdBy: 'spoofed', widgets: [widget({ colour: 'red' })] }));

  assert.strictEqual(result.createdBy, undefined);
  assert.strictEqual(result.widgets[0].colour, undefined);
  assert.strictEqual(result.widgets[0].title, 'Sessions per day');
});

test('the query object is passed through untouched for the compiler to judge', () => {
  const query = { measure: 'events', filters: [{ field: 'Page', op: 'eq', value: '/projects' }] };

  const result = validateDashboard(dashboard({ widgets: [widget({ query })] }));

  assert.deepStrictEqual(result.widgets[0].query, query);
});

test('a dashboard with no widgets is valid', () => {
  assert.deepStrictEqual(validateDashboard(dashboard({ widgets: undefined })).widgets, []);
});

test('name is trimmed and capped', () => {
  assert.strictEqual(validateDashboard(dashboard({ name: '  Weekly traffic  ' })).name, 'Weekly traffic');
  assertRejected(dashboard({ name: 'n'.repeat(MAX_NAME + 1) }), /name/);
});

test('a missing name is rejected', () => {
  assertRejected(dashboard({ name: '   ' }), /name/);
});

test('shared has to be a boolean, not a truthy string', () => {
  assertRejected(dashboard({ shared: 'true' }), /shared/);
});

test('more widgets than the ceiling is rejected', () => {
  const widgets = Array.from({ length: MAX_WIDGETS + 1 }, (_, i) => widget({ id: `w${i}` }));

  assertRejected(dashboard({ widgets }), /at most 24 widgets/);
});

test('a chart type outside the supported set is rejected', () => {
  assertRejected(dashboard({ widgets: [widget({ chart: 'sankey' })] }), /chart/);
});

test('a query that is not an object is rejected', () => {
  assertRejected(dashboard({ widgets: [widget({ query: 'events | count' })] }), /query/);
});

test('a layout coordinate that is not a whole number is rejected', () => {
  assertRejected(dashboard({ widgets: [widget({ layout: { x: 0.5, y: 0, w: 4, h: 4 } })] }), /layout\.x/);
});

test('a widget with no height is rejected', () => {
  assertRejected(dashboard({ widgets: [widget({ layout: { x: 0, y: 0, w: 4, h: 0 } })] }), /layout\.h/);
});

test('a widget title past the cap is rejected', () => {
  assertRejected(dashboard({ widgets: [widget({ title: 't'.repeat(81) })] }), /title/);
});

test('two widgets sharing an id is rejected', () => {
  assertRejected(dashboard({ widgets: [widget(), widget({ title: 'Second' })] }), /unique/);
});

test('an id that is not a UUID is rejected', () => {
  assertRejected(dashboard({ id: '../../etc/passwd' }), /UUID/);
});

// A name is rendered as text and echoed in a list, and both tables store it as one line.
test('a dashboard name carrying a newline is rejected', () => {
  assertRejected(dashboard({ name: 'Downloads\nby month' }), /control characters/);
});

test('a widget title carrying a NUL is rejected', () => {
  assertRejected(dashboard({ widgets: [widget({ title: 'Downloads\u0000' })] }), /control characters/);
});
