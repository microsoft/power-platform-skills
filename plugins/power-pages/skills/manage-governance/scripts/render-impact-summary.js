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
  out.push(`Action:        ${action}`);
  out.push(`Environment:   ${envLine}`);
  out.push(`Scope:         ${scopeLine(scope, siteNames)}`);

  // Sites table with the required Current State / New State columns. A site
  // whose state actually flips is tagged '<- CHANGED' per the consentGate
  // rules ("Rows where the per-site state changes MUST be marked '<- CHANGED'").
  const sitesLabel = scope === 'specific' ? 'Sites covered:' : 'Sites in env:';
  out.push(sitesLabel);
  const header = '| Portal Name | Portal URL | Portal ID | Current State | New State |';
  const divider = '|-------------|------------|-----------|---------------|-----------|';
  out.push('               ' + header);
  out.push('               ' + divider);
  for (const s of sites) {
    const cur = normalizeState(s && s.currentState);
    const curCell = stateCell(cur, colorOpts);
    const newCell = stateCell(newState, colorOpts);
    // Only flag a change when we actually know the current state and it differs.
    const changed = cur !== 'Unknown' && cur !== newState ? '  <- CHANGED' : '';
    const name = (s && s.name) || '(unnamed)';
    const url = (s && s.url) || '';
    const pid = (s && s.portalId) || '';
    out.push(`               | ${name} | ${url} | ${pid} | ${curCell} | ${newCell}${changed} |`);
  }

  out.push(`Effect:        ${effectLine(mapping, policy, direction, scope, envDisplay, siteNames)}`);

  const se = sideEffectLine(policy, req.policyValue);
  if (se) out.push(`Side effect:   ${se}`);

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
};

if (require.main === module) {
  main();
}
