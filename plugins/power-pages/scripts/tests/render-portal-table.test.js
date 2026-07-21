'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const scriptsDir = path.join(
  __dirname,
  '..',
  '..',
  'skills',
  'manage-governance',
  'scripts'
);
const { foregroundColor, green, red, shouldColor } = require(path.join(scriptsDir, 'colors.js'));
const { renderPortalTable, normalizeState, colorForState } = require(path.join(
  scriptsDir,
  'render-portal-table.js'
));

const GREEN = '\u001b[32m';
const RED = '\u001b[31m';
const RESET = '\u001b[0m';

// --- colors.js ---

test('foregroundColor wraps text when enabled', () => {
  assert.strictEqual(green('Enabled', { enabled: true }), `${GREEN}Enabled${RESET}`);
  assert.strictEqual(red('Disabled', { enabled: true }), `${RED}Disabled${RESET}`);
});

test('foregroundColor returns plain text when disabled', () => {
  assert.strictEqual(green('Enabled', { enabled: false }), 'Enabled');
  assert.strictEqual(foregroundColor('x', 'Green', { enabled: false }), 'x');
});

test('unknown color name is left uncolored even when enabled', () => {
  assert.strictEqual(foregroundColor('x', 'Chartreuse', { enabled: true }), 'x');
});

test('shouldColor honors explicit tri-state', () => {
  assert.strictEqual(shouldColor({ enabled: true }), true);
  assert.strictEqual(shouldColor({ enabled: false }), false);
});

test('shouldColor: NO_COLOR forces off, FORCE_COLOR forces on', () => {
  assert.strictEqual(shouldColor({ env: { NO_COLOR: '1' }, stream: { isTTY: true } }), false);
  assert.strictEqual(shouldColor({ env: { FORCE_COLOR: '1' }, stream: { isTTY: false } }), true);
});

test('shouldColor auto-detects TTY when no override', () => {
  assert.strictEqual(shouldColor({ env: {}, stream: { isTTY: true } }), true);
  assert.strictEqual(shouldColor({ env: {}, stream: { isTTY: false } }), false);
});

// --- render-portal-table.js ---

const portals = [
  { name: 'Portal_1', url: 'https://a.example.com', portalId: 'id-1', state: true },
  { name: 'Portal_2', url: 'https://b.example.com', portalId: 'id-2', state: false },
];

test('normalizeState maps booleans and strings', () => {
  assert.strictEqual(normalizeState(true), 'Enabled');
  assert.strictEqual(normalizeState(false), 'Disabled');
  assert.strictEqual(normalizeState('enabled'), 'Enabled');
  assert.strictEqual(normalizeState('Disabled'), 'Disabled');
  assert.strictEqual(normalizeState('weird'), 'Unknown');
});

test('colorForState picks green/red/none', () => {
  assert.strictEqual(colorForState('Enabled'), 'Green');
  assert.strictEqual(colorForState('Disabled'), 'Red');
  assert.strictEqual(colorForState('Unknown'), null);
});

test('renderPortalTable is plain ASCII when color off', () => {
  const out = renderPortalTable(portals, { color: false });
  assert.ok(!out.includes('\u001b['), 'must contain no ANSI escapes');
  assert.ok(out.includes('Enabled'));
  assert.ok(out.includes('Disabled'));
});

test('renderPortalTable colors State green/red when color on', () => {
  const out = renderPortalTable(portals, { color: true });
  assert.ok(out.includes(GREEN), 'Enabled row should be green');
  assert.ok(out.includes(RED), 'Disabled row should be red');
  assert.ok(out.includes(RESET));
});

test('coloring does not change visible column alignment', () => {
  const plain = renderPortalTable(portals, { color: false }).split('\n');
  const colored = renderPortalTable(portals, { color: true }).split('\n');
  // Strip ANSI from colored, compare to plain — must be identical.
  const stripped = colored.map((l) => l.replace(/\u001b\[[0-9;]*m/g, ''));
  assert.deepStrictEqual(stripped, plain);
});

test('all rows have equal visible width', () => {
  const lines = renderPortalTable(portals, { color: false }).split('\n');
  const widths = new Set(lines.map((l) => l.length));
  assert.strictEqual(widths.size, 1, 'every row must be the same width');
});

test('renderPortalTable auto-detect: off when not a TTY', () => {
  const out = renderPortalTable(portals, { color: null, stream: { isTTY: false }, env: {} });
  assert.ok(!out.includes('\u001b['), 'non-TTY auto-detect must stay plain');
});

test('empty portal list still renders header + borders', () => {
  const out = renderPortalTable([], { color: false });
  assert.ok(out.includes('State'));
  assert.strictEqual(out.split('\n').length, 4, 'top border + header + separator + bottom border');
});

test('unknown state stays uncolored even with color on', () => {
  const out = renderPortalTable([{ name: 'X', state: 'weird' }], { color: true });
  assert.ok(out.includes('Unknown'));
  assert.ok(!out.includes(GREEN) && !out.includes(RED));
});
