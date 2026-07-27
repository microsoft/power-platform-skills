#!/usr/bin/env node

// render-impact-summary.js — Deterministically render the Phase 2.2 / 4.2.3
// consent-gate "impact summary" block from governance-mapping.json data plus a
// resolved request. This is an ADDITIVE helper: the consent-gate format is
// already specified in SKILL.md ("Consent gate (always before POST)"), but the
// orchestrator hand-builds it today and can drift. Feeding the same inputs
// through one renderer keeps the Action / Environment / Scope / Sites / Effect
// rows — and the sign-out Side-effect line — consistent with the committed spec
// and the per-policy `subject` / `effectLineTemplates` / `sideEffectCallout`
// data. It mirrors the render-env-table.js / render-portal-table.js pattern:
// pure data-in → text-out, no network, no writes.
//
// The rendered block intentionally starts at the `Action:` line with NO lead-in
// heading — SKILL.md forbids prepending "Impact summary:" or any label before
// the Action row, so callers must emit this output verbatim.

const fs = require('fs');
const path = require('path');

// Reuse the committed ANSI helper so the state cells can be colorized in a real
// terminal, but stay plain (emoji-only) for chat surfaces that strip ANSI.
const { green, red } = require('./colors');

const MAPPING_PATH = path.join(__dirname, '..', 'references', 'governance-mapping.json');

function loadMapping(mappingPath) {
  const raw = fs.readFileSync(mappingPath || MAPPING_PATH, 'utf8');
  return JSON.parse(raw);
}

function capitalize(s) {
  const str = String(s || '');
  return str ? str[0].toUpperCase() + str.slice(1) : str;
}

// Normalize a free-form current-state string to the canonical 'Enabled' /
// 'Disabled' / 'Unknown' used by governance-mapping.json `stateColors`. Live
// reads (get-env.js / get-portal.js) can surface 'None', 'All', mixed casing,
// or a missing value when a read fails — the consent gate must never crash on
// that, so anything unrecognized renders as 'Unknown' (SKILL.md: "If a live
// read fails, render Current State as Unknown ... never block the gate").
function normalizeState(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (s === 'enabled' || s === 'enable' || s === 'on' || s === 'true') return 'Enabled';
  if (s === 'disabled' || s === 'disable' || s === 'off' || s === 'false' || s === 'blocked') {
    return 'Disabled';
  }
  return 'Unknown';
}

// The target state a site reaches after the requested direction is applied.
// enable -> Enabled, disable -> Disabled. Only sites in scope are passed in, so
// every provided site takes the target state.
function newStateFor(direction) {
  return direction === 'disable' ? 'Disabled' : 'Enabled';
}

// Wrap a state label with its emoji marker (and optional ANSI color). Emoji is
// always present because some chat renderers strip ANSI; the color helper is a
// no-op unless coloring is enabled, matching the committed stateColors contract.
function stateCell(state, colorOpts) {
  if (state === 'Enabled') return green('🟢 Enabled', colorOpts);
  if (state === 'Disabled') return red('🔴 Disabled', colorOpts);
  return '⚪ Unknown';
}

// Emoji-only state label for the Sites BOX table. The bordered box computes
// column widths on the visible text and wraps cells, so the state cell must be
// ANSI-free (an escape sequence is zero-width and would desync width math and
// corrupt a wrapped line). The 🟢 / 🔴 emoji already carry the green/red cue on
// every surface — including chat that strips ANSI — so no color is applied here.
// (ANSI color still applies to the Action / Effect rows, which are single-line.)
function plainStateCell(state) {
  if (state === 'Enabled') return '🟢 Enabled';
  if (state === 'Disabled') return '🔴 Disabled';
  return '⚪ Unknown';
}

// Escape a cell value for a GitHub-flavored Markdown table: a literal `|` would
// otherwise be read as a column separator and shift every following cell, so
// backslash-escape it. Newlines are flattened to spaces because a Markdown table
// cell cannot span physical lines. (URLs/GUIDs/emoji need no other escaping.)
function mdCell(s) {
  return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

// Render a GitHub-flavored Markdown pipe table (header row + `---` delimiter +
// one line per data row). We deliberately DROPPED the fixed-width Unicode box
// (┌─┐ borders) here: admins reported it "breaks" in chat because the state
// emoji (🟢/🔴) are double-width glyphs while the box padding math counts them
// as their JS string length, so the columns never line up on a proportional or
// emoji-aware surface. A Markdown table delegates column sizing to the chat
// client's own renderer, so each row renders on ONE line and the emoji can be
// any width without corrupting alignment. `headers` is a string[]; `rows` is
// string[][] (already emoji-decorated, no ANSI). Returns the joined lines with
// no trailing newline.
function renderMarkdownTable(headers, rows) {
  const head = '| ' + headers.map(mdCell).join(' | ') + ' |';
  const sep = '| ' + headers.map(() => '---').join(' | ') + ' |';
  const body = rows.map((r) => '| ' + r.map(mdCell).join(' | ') + ' |');
  return [head, sep, ...body].join('\n');
}

// Plain-language scope line for the Scope row. Never leaks the internal
// All/Include/None/Exclude policyValue terms (SKILL.md: "never leak the internal
// All / Include / None / Exclude terms to the user").
function scopeLine(scope, siteNames) {
  if (scope === 'specific') {
    const list = siteNames.length ? siteNames.join(', ') : '(no sites listed)';
    return `Only ${list}`;
  }
  return 'Every site in this environment';
}

// Build the Effect line from effectLineTemplates (keyed by direction + all/
// specific) with the per-policy `subject`, env display, and the affected site
// names substituted in.
function effectLine(mapping, policy, direction, scope, envDisplay, siteNames) {
  const key = scope === 'specific' ? 'specific' : 'all';
  const tmpl = (mapping.effectLineTemplates || []).find(
    (t) => t.intentDirection === direction && t.scope === key
  );
  if (!tmpl) {
    // Fall back to a bare sentence rather than throwing — the gate must render.
    return `${policy.subject} will be ${direction === 'disable' ? 'disabled' : 'enabled'} in ${envDisplay}.`;
  }
  return tmpl.template
    .replace('{Subject}', policy.subject)
    .replace('{EnvDisplay}', envDisplay)
    .replace('{SiteNameList}', siteNames.join(', '));
}

// The sign-out Side-effect line, only when the resulting policyValue is one of
// the per-policy triggers. For the legacy Disable* block rules the triggers are
// ["All","Include"] (turning the block ON blocks the protocol); for the Enable*
// toggles they are ["None","Exclude"] (turning the toggle OFF blocks sign-in).
// See governance-mapping.json policies[].sideEffectCallout.
function sideEffectLine(policy, policyValue) {
  const cb = policy.sideEffectCallout;
  if (!cb || !Array.isArray(cb.policyValueTriggers) || !policyValue) return null;
  if (!cb.policyValueTriggers.includes(policyValue)) return null;
  return cb.message;
}

// Some "parent" policies affect a set of downstream sign-in methods, and the
// admin needs to see that ripple at the consent gate — it isn't obvious from the
// single-policy table. Both directions get a checklist under the summary:
//
//   * disable -> "Below Setting will get Disable": the downstream methods that
//     this parent turns OFF (OAuth 2.0 -> Facebook/Google/Microsoft; External
//     Auth -> every protocol + social IdP), each marked red "🔴 Disabled".
//   * enable  -> an informational list of the methods that become AVAILABLE
//     again (subject to their own per-provider config). Enabling a parent does
//     NOT force-enable the children, so these are annotated (e.g. "Controlled by
//     the Facebook setting.") and a footer note spells out that each provider
//     must still be configured — no green "Enabled" marker, because the child's
//     real state is unchanged by this apply.
//
// Both are data-driven from governance-mapping.json policies[].cascadeOnDisable /
// cascadeOnEnable so adding/removing a downstream method never touches this file.
// Items may be a bare string (label only) or { label, note } — normalized here.
// Returns the ready-to-emit lines (blank separator + heading + rows + optional
// footer) or [] when the policy has no cascade for that direction.
function cascadeLines(policy, direction, colorOpts) {
  const isDisable = direction === 'disable';
  const cascade = isDisable ? policy.cascadeOnDisable : policy.cascadeOnEnable;
  if (!cascade || !Array.isArray(cascade.items) || cascade.items.length === 0) {
    return [];
  }
  // Normalize each item to { label, note, state } so string and object forms
  // coexist. `state` (e.g. 'Enabled') is optional and only used on the enable side
  // to render a green "🟢 Enabled" marker mirroring the disable side's red one.
  const items = cascade.items.map((it) =>
    typeof it === 'string'
      ? { label: it }
      : { label: it.label, note: it.note, state: it.state }
  );
  const lines = [];
  lines.push('');
  lines.push(cascade.heading || (isDisable ? 'Below Setting will get Disable' : 'When enabled, the following become available:'));
  // Left-align the labels into one column so the trailing markers/notes line up,
  // matching the approved mock. Width is computed on the visible label text.
  const labelWidth = items.reduce((w, it) => Math.max(w, String(it.label).length), 0);
  items.forEach((it, i) => {
    const num = `${i + 1}.`;
    const label = String(it.label).padEnd(labelWidth, ' ');
    let marker;
    if (isDisable) {
      // Render the state marker through the SAME stateCell() convention the Sites
      // table uses — "🔴 Disabled" wrapped in ANSI red. The 🔴 emoji is what makes
      // the "red for Disable" cue visible on chat surfaces that strip ANSI (they
      // drop the escape codes but keep the red circle); the ANSI red still applies
      // in a real terminal. Green ("🟢 Enabled") is the symmetric marker for any
      // enable-side row that declares an explicit `state` (see below).
      marker = '  ' + stateCell('Disabled', colorOpts);
    } else if (it.state) {
      // Enable rows may opt into an explicit state marker (data-driven via the
      // item's `state` field). "Enabled" renders green "🟢 Enabled" — the mirror
      // of the disable side — followed by the note when present.
      marker = '  ' + stateCell(it.state, colorOpts) + (it.note ? ' - ' + it.note : '');
    } else {
      // Default enable rows only annotate the provider-controlled entries; protocol
      // rows (OpenID Connect, SAML 2.0, ...) have no note and render as label-only.
      // No green "Enabled" marker here because enabling a parent does NOT force the
      // child on — its real state is unchanged by this apply.
      marker = it.note ? '  - ' + it.note : '';
    }
    // Trim trailing whitespace so label-only enable rows don't carry padding.
    lines.push(`${num} ${label}${marker}`.replace(/\s+$/, ''));
  });
  if (cascade.footer) {
    lines.push('');
    lines.push(`Note: ${cascade.footer}`);
  }
  return lines;
}

// Color the consent-gate Action line by direction: green "🟢 Enable …" when the
// operation turns something ON, red "🔴 Disable …" when it turns something OFF —
// the same green=enabled / red=disabled convention as the state cells, and per
// the SKILL.md rule to color the Action row. The emoji carries the cue where ANSI
// is stripped (chat); the color helper adds ANSI in a real terminal.
function actionCell(direction, action, colorOpts) {
  return direction === 'disable'
    ? red(`🔴 ${action}`, colorOpts)
    : green(`🟢 ${action}`, colorOpts);
}

/**
 * Render the consent-gate impact summary block.
 *
 * @param {object} req
 * @param {string} req.policy       - internal PolicyName (e.g. 'EnableProtocolOpenIdConnect').
 * @param {string} req.direction    - 'enable' | 'disable' (view never reaches the gate).
 * @param {string} [req.scope]      - 'all' | 'specific' (default 'all').
 * @param {string} [req.policyValue]- resolved All/Include/None/Exclude, for the side-effect check.
 * @param {{displayName?: string, envId?: string}} req.env
 * @param {Array<{name?: string, url?: string, portalId?: string, currentState?: string}>} [req.sites]
 * @param {object} [opts]
 * @param {object} [opts.mapping]   - preloaded mapping (defaults to the committed JSON).
 * @param {boolean} [opts.color]    - force ANSI color on the state cells.
 * @returns {string} the rendered block (no trailing newline, starts at `Action:`).
 */
function renderImpactSummary(req, opts = {}) {
  const mapping = opts.mapping || loadMapping();
  const colorOpts = { enabled: opts.color === true ? true : null };

  const policy = (mapping.policies || []).find((p) => p.policyName === req.policy);
  if (!policy) {
    throw new Error(`render-impact-summary: unknown policy '${req.policy}'`);
  }
  const direction = req.direction === 'disable' ? 'disable' : 'enable';
  const scope = req.scope === 'specific' ? 'specific' : 'all';
  const env = req.env || {};
  const envDisplay = env.displayName || '(unnamed env)';
  const envLine = env.envId ? `${envDisplay}  (${env.envId})` : envDisplay;
  const sites = Array.isArray(req.sites) ? req.sites : [];
  const siteNames = sites.map((s) => (s && s.name) || '(unnamed)');

  const action = `${capitalize(direction)} ${policy.subject}`;
  const newState = newStateFor(direction);

  const out = [];
  out.push(`Action:        ${actionCell(direction, action, colorOpts)}`);
  out.push(`Environment:   ${envLine}`);
  out.push(`Scope:         ${scopeLine(scope, siteNames)}`);

  // Sites table with the required Current State / New State columns, rendered as
  // a GitHub-flavored Markdown table (NOT a fixed-width Unicode box — see
  // renderMarkdownTable for why the box broke in chat). A site whose state
  // actually flips is tagged '← CHANGED' in its New State cell per the
  // consentGate rules ("Rows where the per-site state changes MUST be marked
  // CHANGED"). The chat client sizes the columns, so each site is one line.
  const sitesLabel = scope === 'specific' ? 'Sites covered:' : 'Sites in env:';
  out.push(sitesLabel);
  out.push('');
  const tableHeaders = ['Portal Name', 'Portal URL', 'Portal ID', 'Current State', 'New State'];
  const tableRows = sites.map((s) => {
    const cur = normalizeState(s && s.currentState);
    // Only flag a change when we actually know the current state and it differs.
    const changed = cur !== 'Unknown' && cur !== newState ? ' ← CHANGED' : '';
    return [
      (s && s.name) || '(unnamed)',
      (s && s.url) || '',
      (s && s.portalId) || '',
      plainStateCell(cur),
      plainStateCell(newState) + changed,
    ];
  });
  for (const line of renderMarkdownTable(tableHeaders, tableRows).split('\n')) {
    out.push(line);
  }

  out.push(`Effect:        ${effectLine(mapping, policy, direction, scope, envDisplay, siteNames)}`);

  const se = sideEffectLine(policy, req.policyValue);
  if (se) out.push(`Side effect:   ${se}`);

  // Downstream policies the admin should know about: on disable, the methods
  // this parent turns off; on enable, the methods it makes available again
  // (subject to their own config). No-op for every non-parent policy.
  for (const line of cascadeLines(policy, direction, colorOpts)) out.push(line);

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

const HELP = `render-impact-summary.js — Render the consent-gate impact summary block.

Usage:
  node render-impact-summary.js --reqFile <path.json> [--color]
  echo '<json>' | node render-impact-summary.js [--color]

Input JSON shape:
  {
    "policy": "EnableProtocolOpenIdConnect",
    "direction": "disable",
    "scope": "all" | "specific",
    "policyValue": "None",
    "env": { "displayName": "Sachin-Jun-2nd", "envId": "202c4f04-..." },
    "sites": [
      { "name": "Site 1", "url": "https://...", "portalId": "3e13...", "currentState": "Enabled" }
    ]
  }

Flags:
  --reqFile <path>  Read the request JSON from a file instead of stdin.
  --color           Force ANSI color on the state cells (default: auto/off).
  --help            Show this help.

Output starts at the 'Action:' line with no lead-in — emit it verbatim.
`;

function parseFlags(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--reqFile') out.reqFile = argv[++i];
    else if (a === '--color') out.color = true;
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
  if (flags.reqFile) {
    raw = fs.readFileSync(flags.reqFile, 'utf8');
  } else {
    raw = await readStdin();
  }
  let req;
  try {
    req = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`render-impact-summary: could not parse JSON input: ${e.message}\n`);
    process.exit(1);
    return;
  }
  try {
    process.stdout.write(renderImpactSummary(req, { color: flags.color === true }) + '\n');
  } catch (e) {
    process.stderr.write(`render-impact-summary: ${e.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  renderImpactSummary,
  loadMapping,
  normalizeState,
  newStateFor,
  scopeLine,
  effectLine,
  sideEffectLine,
  cascadeLines,
  actionCell,
};

if (require.main === module) {
  main();
}
