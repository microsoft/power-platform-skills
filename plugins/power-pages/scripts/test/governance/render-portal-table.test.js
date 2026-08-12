'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const scriptsDir = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'skills',
  'manage-governance',
  'scripts'
);
const { foregroundColor, green, red, shouldColor } = require(path.join(scriptsDir, 'colors.js'));
const { renderPortalTable, renderPortalTableMarkdown, normalizeState, colorForState } = require(path.join(
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

// --- render-portal-table.js Unicode box mode (governance STATUS format) ---

test('unicode mode emits box-drawing frame with a rule between every row', () => {
  const out = renderPortalTable(
    [
      { name: 'Portal_3', url: 'https://a', portalId: 'id3', state: true },
      { name: 'Portal_4', url: 'https://b', portalId: 'id4', state: true },
      { name: 'Portal_1', url: 'https://c', portalId: 'id1', state: false },
    ],
    { color: false, icons: true, unicode: true }
  );
  const lines = out.split('\n');
  // Frame corners/tees + vertical bar are Unicode box-drawing, never ASCII '+'/'|'.
  assert.ok(lines[0].startsWith('┌') && lines[0].endsWith('┐'), 'top border');
  assert.ok(out.includes('│'), 'cells use the │ vertical bar');
  assert.ok(!out.includes('+') && !out.includes('|'), 'no ASCII box glyphs');
  assert.ok(lines[lines.length - 1].startsWith('└') && lines[lines.length - 1].endsWith('┘'), 'bottom border');
  // 3 rows → top, header, mid, r1, mid, r2, mid, r3, bottom = 9 lines.
  assert.strictEqual(lines.length, 9, 'a ├┼┤ rule separates every data row');
  assert.strictEqual(out.match(/├/g).length, 3, 'exactly 3 inter-row/header rules');
});

test('unicode mode keeps exactly the five columns with state icons', () => {
  const out = renderPortalTable([{ name: 'P', url: 'u', portalId: 'i', state: true }], {
    color: false,
    icons: true,
    unicode: true,
  });
  const header = out.split('\n')[1];
  assert.ok(/│ # │ Name .*│ URL .*│ Site ID .*│ State .*│/.test(header), 'five fixed columns');
  assert.ok(out.includes('🟢 Enabled'), 'State cell carries the icon');
});

test('unicode option is additive — default ASCII output is unchanged', () => {
  const ascii = renderPortalTable([{ name: 'P', url: 'u', portalId: 'i', state: true }], { color: false });
  assert.ok(ascii.includes('+---') && ascii.includes('| # |'), 'default stays ASCII box');
  assert.ok(!ascii.includes('┌') && !ascii.includes('│'), 'no Unicode glyphs by default');
});

test('unknown state stays uncolored even with color on', () => {
  const out = renderPortalTable([{ name: 'X', state: 'weird' }], { color: true });
  assert.ok(out.includes('Unknown'));
  assert.ok(!out.includes(GREEN) && !out.includes(RED));
});

// --- render-portal-table.js Markdown mode (chat-safe) ---

test('renderPortalTableMarkdown emits a GFM table, no box-drawing/ANSI', () => {
  const out = renderPortalTableMarkdown(portals);
  // No ASCII box borders and no ANSI escapes — the chat client sizes columns.
  assert.ok(!out.includes('\u001b['), 'markdown output must contain no ANSI escapes');
  assert.ok(!/[+\-]{3,}/.test(out.replace(/---/g, '')), 'no ASCII box rule rows');
  assert.match(out, /^\| # \| Name \| URL \| Site ID \| State \|$/m, 'header row present');
  assert.match(out, /^\| --- \| --- \| --- \| --- \| --- \|$/m, 'delimiter row present');
});

test('renderPortalTableMarkdown carries the 🟢/🔴 state icon by default and one row per site', () => {
  const out = renderPortalTableMarkdown(portals);
  const lines = out.split('\n');
  // header + delimiter + 2 data rows = 4 lines, each a single physical line.
  assert.strictEqual(lines.length, 4, 'exactly one line per header/delimiter/site row');
  assert.match(out, /^\| 1 \| Portal_1 \| https:\/\/a\.example\.com \| id-1 \| 🟢 Enabled \|$/m);
  assert.match(out, /^\| 2 \| Portal_2 \| https:\/\/b\.example\.com \| id-2 \| 🔴 Disabled \|$/m);
});

test('renderPortalTableMarkdown --no-icons drops the emoji', () => {
  const out = renderPortalTableMarkdown(portals, { icons: false });
  assert.ok(!out.includes('🟢') && !out.includes('🔴'), 'icons suppressed');
  assert.match(out, /\| Enabled \|/);
  assert.match(out, /\| Disabled \|/);
});

test('renderPortalTableMarkdown escapes a literal pipe in a cell', () => {
  const out = renderPortalTableMarkdown([{ name: 'A|B', url: 'https://x', portalId: 'p1', state: true }]);
  assert.match(out, /\| A\\\|B \|/, 'a literal pipe is backslash-escaped');
});
