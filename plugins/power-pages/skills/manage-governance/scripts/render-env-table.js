#!/usr/bin/env node

// render-env-table.js — Renders the environment picker as a fixed-width,
// ASCII-only bordered box table so columns stay aligned in every terminal
// and chat font. A marker column flags the current selection (the env that
// applies when the user replies "keep").
//
// ASCII-only is deliberate: emoji / wide glyphs (➡️, ✅) render at unpredictable
// widths and break monospace alignment, producing a "broken" table. Keep every
// character inside the borders single-width ASCII.

const CURRENT_TAG = '<-- CURRENT SELECTION (default)';
const CURRENT_MARK = '>';

// Pad an ASCII string to a fixed visible width (right side).
function pad(str, width) {
  const s = String(str == null ? '' : str);
  return s + ' '.repeat(Math.max(0, width - s.length));
}

// Build a horizontal border segment given the 4 column widths.
function border(widths, left, mid, right) {
  return (
    left +
    widths.map((w) => '-'.repeat(w + 2)).join(mid) +
    right
  );
}

/**
 * Render the env list as an aligned ASCII box table.
 *
 * @param {Array<{displayName?: string, envId?: string}>} envs
 * @param {object} [opts]
 * @param {string|null} [opts.currentEnvId] - envId to flag as current selection.
 * @returns {string} the rendered table (no trailing newline).
 */
function renderEnvTable(envs, opts = {}) {
  const currentEnvId = opts.currentEnvId || null;
  const list = Array.isArray(envs) ? envs : [];

  const rows = list.map((e, i) => {
    const isCurrent = currentEnvId != null && e && e.envId === currentEnvId;
    const name = (e && e.displayName) || '(unnamed)';
    return {
      n: String(i + 1),
      mark: isCurrent ? CURRENT_MARK : '',
      name: isCurrent ? `${name}  ${CURRENT_TAG}` : name,
      id: (e && e.envId) || '',
    };
  });

  const headers = { n: '#', mark: '', name: 'Environment Name', id: 'Environment ID' };
  const all = [headers, ...rows];

  const widths = [
    Math.max(...all.map((r) => r.n.length)),
    Math.max(CURRENT_MARK.length, ...all.map((r) => r.mark.length)),
    Math.max(...all.map((r) => r.name.length)),
    Math.max(...all.map((r) => r.id.length)),
  ];

  const line = (r) =>
    `| ${pad(r.n, widths[0])} | ${pad(r.mark, widths[1])} | ${pad(r.name, widths[2])} | ${pad(r.id, widths[3])} |`;

  const out = [];
  out.push(border(widths, '+', '+', '+'));
  out.push(line(headers));
  out.push(border(widths, '+', '+', '+'));
  for (const r of rows) out.push(line(r));
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

const HELP = `render-env-table.js — Render the env picker as an aligned ASCII box table.

Usage:
  node list-envs.js | node render-env-table.js [--current <envId>]
  node render-env-table.js --envsFile <path> [--current <envId>]

Input:
  A JSON object shaped like list-envs.js output: { "status": "ok", "envs": [ ... ] }
  or a bare JSON array of { envId, displayName }.

Flags:
  --current <envId>   Flag this env as the current selection (default) row.
  --envsFile <path>   Read the JSON from a file instead of stdin.
  --help              Show this help.
`;

function parseFlags(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--current') out.current = argv[++i];
    else if (a === '--envsFile') out.envsFile = argv[++i];
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
  if (flags.envsFile) {
    raw = require('fs').readFileSync(flags.envsFile, 'utf8');
  } else {
    raw = await readStdin();
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`render-env-table: could not parse JSON input: ${e.message}\n`);
    process.exit(1);
    return;
  }
  const envs = Array.isArray(parsed) ? parsed : parsed.envs || [];
  process.stdout.write(renderEnvTable(envs, { currentEnvId: flags.current || null }) + '\n');
}

module.exports = { renderEnvTable, CURRENT_TAG, CURRENT_MARK };

if (require.main === module) {
  main();
}
