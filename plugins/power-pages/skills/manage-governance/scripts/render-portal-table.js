#!/usr/bin/env node

// render-portal-table.js — Renders the per-site governance state table as a
// fixed-width, ASCII-only bordered box table. The State column is colorized
// green (Enabled) / red (Disabled) via colors.js — but ONLY when the output is
// a real terminal (or coloring is forced with --color). In JSON/chat contexts
// coloring is off, so the table stays plain and aligned.
//
// ANSI escapes are zero-width, so column widths are computed on the *visible*
// (uncolored) text and the color is applied AFTER padding — alignment holds
// whether or not color is on.

const { foregroundColor, shouldColor } = require('./colors');

// Normalize a state value to the canonical 'Enabled' / 'Disabled' label.
// Accepts booleans (true=Enabled), or strings like 'enabled'/'disabled'/
// 'true'/'false'. Anything else falls through to 'Unknown'.
function normalizeState(state) {
  if (state === true) return 'Enabled';
  if (state === false) return 'Disabled';
  const s = String(state == null ? '' : state).trim().toLowerCase();
  if (s === 'enabled' || s === 'true') return 'Enabled';
  if (s === 'disabled' || s === 'false') return 'Disabled';
  return 'Unknown';
}

// Green for Enabled, red for Disabled, left plain for Unknown.
function colorForState(label) {
  if (label === 'Enabled') return 'Green';
  if (label === 'Disabled') return 'Red';
  return null;
}

// Emoji marker for the state — a fallback indicator on surfaces that strip ANSI
// (e.g. chat). Green circle = Enabled, red circle = Disabled, none for Unknown.
function iconForState(label) {
  if (label === 'Enabled') return '\u{1F7E2}';
  if (label === 'Disabled') return '\u{1F534}';
  return '';
}

function pad(str, width) {
  const s = String(str == null ? '' : str);
  return s + ' '.repeat(Math.max(0, width - s.length));
}

function border(widths, left, mid, right) {
  return left + widths.map((w) => '-'.repeat(w + 2)).join(mid) + right;
}

/**
 * Render the portal governance-state table.
 *
 * @param {Array<{name?: string, url?: string, portalId?: string, state?: (boolean|string)}>} portals
 * @param {object} [opts]
 * @param {boolean|null} [opts.color] - Tri-state color override. `true` forces
 *   on, `false` forces off, `null`/undefined auto-detects (TTY + NO_COLOR).
 * @param {NodeJS.WriteStream} [opts.stream] - Stream used for TTY detection.
 * @param {object} [opts.env] - Environment map for NO_COLOR/FORCE_COLOR.
 * @returns {string} rendered table (no trailing newline).
 */
function renderPortalTable(portals, opts = {}) {
  const list = Array.isArray(portals) ? portals : [];
  const colorOpts = { enabled: opts.color == null ? null : opts.color, stream: opts.stream, env: opts.env };
  const colorOn = shouldColor(colorOpts);
  const icons = Boolean(opts.icons);

  const rows = list.map((p, i) => {
    const label = normalizeState(p && p.state);
    return {
      n: String(i + 1),
      name: (p && p.name) || '(unnamed)',
      url: (p && p.url) || '',
      id: (p && p.portalId) || '',
      state: icons && iconForState(label) ? `${iconForState(label)} ${label}` : label,
    };
  });

  const headers = { n: '#', name: 'Name', url: 'URL', id: 'Site ID', state: 'State' };
  const all = [headers, ...rows];

  // Widths from the visible (uncolored) text.
  const widths = [
    Math.max(...all.map((r) => r.n.length)),
    Math.max(...all.map((r) => r.name.length)),
    Math.max(...all.map((r) => r.url.length)),
    Math.max(...all.map((r) => r.id.length)),
    Math.max(...all.map((r) => r.state.length)),
  ];

  const cell = (r, colorize) => {
    const statePadded = pad(r.state, widths[4]);
    // r.state may carry a leading icon (e.g. "🟢 Enabled"); derive the colour
    // from the trailing label word so colorization still works with --icons.
    const stateLabel = r.state.trim().split(/\s+/).pop();
    const colorKey = colorForState(stateLabel);
    const stateCell =
      colorize && colorKey
        ? foregroundColor(statePadded, colorKey, { enabled: true })
        : statePadded;
    return `| ${pad(r.n, widths[0])} | ${pad(r.name, widths[1])} | ${pad(r.url, widths[2])} | ${pad(r.id, widths[3])} | ${stateCell} |`;
  };

  const out = [];
  out.push(border(widths, '+', '+', '+'));
  out.push(cell(headers, false));
  out.push(border(widths, '+', '+', '+'));
  for (const r of rows) out.push(cell(r, colorOn));
  out.push(border(widths, '+', '+', '+'));
  return out.join('\n');
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
  });
}

const HELP = `render-portal-table.js — Render the per-site governance state table (colored State column).

Usage:
  node render-portal-table.js --portalsFile <path> [--color | --no-color]
  cat portals.json | node render-portal-table.js [--color | --no-color]

Input:
  A JSON array (or { "portals": [ ... ] }) of:
    { "name": "Portal_1", "url": "https://...", "portalId": "<guid>", "state": true|false|"Enabled"|"Disabled" }

Flags:
  --color       Force ANSI color on (green=Enabled, red=Disabled).
  --no-color    Force color off (plain ASCII — safe for capturing / chat).
  --icons       Prefix the State cell with 🟢 / 🔴 (default: on).
  --no-icons    Omit the state icons (plain "Enabled" / "Disabled").
  --portalsFile Read JSON from a file instead of stdin.
  --help        Show this help.

Color is auto-detected otherwise: on when stdout is a TTY and NO_COLOR is unset.
The state icons (🟢 Enabled / 🔴 Disabled) are shown by default — pass
--no-icons to suppress them.
`;

function parseFlags(argv) {
  const out = { color: null, icons: true };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--color') out.color = true;
    else if (a === '--no-color') out.color = false;
    else if (a === '--icons') out.icons = true;
    else if (a === '--no-icons') out.icons = false;
    else if (a === '--portalsFile') out.portalsFile = argv[++i];
    else if (a === '--help') out.help = true;
  }
  return out;
}

async function main() {
  const flags = parseFlags(process.argv);
  if (flags.help) {
    process.stdout.write(HELP);
    return;
  }
  let raw;
  if (flags.portalsFile) {
    raw = require('fs').readFileSync(flags.portalsFile, 'utf8');
  } else {
    raw = await readStdin();
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`render-portal-table: could not parse JSON input: ${e.message}\n`);
    process.exit(1);
    return;
  }
  const portals = Array.isArray(parsed) ? parsed : parsed.portals || [];
  process.stdout.write(renderPortalTable(portals, { color: flags.color, icons: flags.icons }) + '\n');
}

module.exports = { renderPortalTable, normalizeState, colorForState, iconForState };

if (require.main === module) {
  main();
}
