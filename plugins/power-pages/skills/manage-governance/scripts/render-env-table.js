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

const { pad, border } = require('./table');

// Resolve the tenant-default env id straight from the list-envs.js payload so
// the picker can pre-flag a sensible default WITHOUT a second round-trip. The
// list already carries `type: "Default"` for the tenant's default environment
// (Dataverse environments API surfaces the default flag), so deriving it here
// avoids an extra `pac auth who` invocation — that separate call cold-starts
// the .NET CLI and can trigger its own tool-approval prompt, which is exactly
// the friction we want to remove from the "just show the list" step. Match is
// case-insensitive because casing has varied across CLI versions
// ("Default" vs "default").
function resolveDefaultEnvId(envs) {
  const list = Array.isArray(envs) ? envs : [];
  const def = list.find(
    (e) => e && typeof e.type === 'string' && e.type.toLowerCase() === 'default'
  );
  return def && def.envId ? def.envId : null;
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

// Escape a cell value for GitHub-flavored Markdown table cells. A literal '|'
// would prematurely close the cell, and a backslash could escape the next
// pipe — env display names are user-controlled, so both must be neutralized.
function mdCell(str) {
  return String(str == null ? '' : str)
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|');
}

/**
 * Render the env list as a GitHub-flavored Markdown table. Unlike the ASCII
 * box (which relies on a monospace font and can collapse to blank on chat
 * surfaces that don't render fenced code blocks), a Markdown table renders
 * reliably as a real table in chat UIs. A dedicated "Selected" column flags the
 * env chosen earlier in the session (the row that applies on "keep").
 *
 * @param {Array<{displayName?: string, envId?: string}>} envs
 * @param {object} [opts]
 * @param {string|null} [opts.currentEnvId] - envId to flag as current selection.
 * @returns {string} the rendered Markdown table (no trailing newline).
 */
function renderEnvMarkdown(envs, opts = {}) {
  const currentEnvId = opts.currentEnvId || null;
  const list = Array.isArray(envs) ? envs : [];
  const out = [];
  out.push('| # | Selected | Environment Name | Environment ID |');
  out.push('|---|---|---|---|');
  list.forEach((e, i) => {
    const isCurrent = currentEnvId != null && e && e.envId === currentEnvId;
    const name = (e && e.displayName) || '(unnamed)';
    // A dedicated "Selected" column marks the env chosen earlier (the one that
    // applies on "keep"), so the user can see at a glance which row is the
    // current default without hunting for an inline tag.
    const mark = isCurrent ? '**\u2190 selected earlier**' : '';
    out.push(
      `| ${i + 1} | ${mark} | ${mdCell(name)} | ${mdCell((e && e.envId) || '')} |`
    );
  });
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
                      When omitted, the env whose "type" is "Default" in the
                      list-envs.js payload is auto-flagged (no extra lookup).
  --envsFile <path>   Read the JSON from a file instead of stdin.
  --markdown          Emit a GitHub-flavored Markdown table (renders reliably
                      in chat UIs) instead of the ASCII box.
  --help              Show this help.
`;

function parseFlags(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--current') out.current = argv[++i];
    else if (a === '--envsFile') out.envsFile = argv[++i];
    else if (a === '--markdown') out.markdown = true;
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
  // Auto-flag the tenant-default env when the caller didn't pin one via
  // --current. This makes "show me the env list" a single deterministic step:
  // the list loads and renders with a sensible default already marked, with no
  // separate lookup command (and therefore no extra approval prompt).
  const currentEnvId = flags.current || resolveDefaultEnvId(envs);
  const render = flags.markdown ? renderEnvMarkdown : renderEnvTable;
  process.stdout.write(render(envs, { currentEnvId }) + '\n');
}

module.exports = {
  renderEnvTable,
  renderEnvMarkdown,
  resolveDefaultEnvId,
  CURRENT_TAG,
  CURRENT_MARK,
};

if (require.main === module) {
  main();
}
