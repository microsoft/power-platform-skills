#!/usr/bin/env node

// render-status-table.js — Renders the per-site EFFECTIVE governance-status
// table for a CHILD authentication policy, showing the parent context columns
// alongside the child's own state.
//
// WHY this exists — effective status ≠ own status for gated children
// ------------------------------------------------------------------
// Power Pages authentication governance is a tree (see
// references/governance-mapping.json `policyAvailabilityDependencies` /
// `effectiveStatusRules`):
//
//   EnableExternalAuthProviders            (the "Main Flag" / root parent)
//     ├─ EnableProtocolOpenIdConnect
//     ├─ EnableProtocolSAML20
//     ├─ EnableProtocolWsFederation
//     └─ EnableProtocolOpenAuth            (OAuth 2.0 — also a parent)
//           ├─ EnableIdpOAuthFacebook
//           ├─ EnableIdpOAuthGoogle
//           └─ EnableIdpOAuthMicrosoft
//
// A child method's OWN governance setting being Enabled is necessary but NOT
// sufficient — the method only actually works on a portal when EVERY gating
// parent is also Enabled there. So the runtime-observable ("effective") status
// is: own AND all parents. Concretely:
//   * OAuth 2.0 / OpenID Connect / SAML 2.0 / WS-Federation are effectively
//     Enabled on a portal only if that protocol AND External Auth are Enabled.
//   * Facebook / Google / Microsoft are effectively Enabled only if that IdP
//     AND OAuth 2.0 AND External Auth are all Enabled.
//
// This helper renders a Markdown table with one column per gating parent (in
// `availabilityDependsOn` order — External Auth first, then OAuth 2.0 for the
// social IdPs), plus a single Effective <child> Status column carrying the AND
// result (own AND all parents). The child's OWN state is an input to that AND
// but is not shown as its own column. That is exactly the "portal-wise status"
// view the admin needs to see WHY a child is dark: the parent context and the
// net effective status.
//
// Pure-data-in / data-out (network-free, unit-testable). The CLI reads a
// { policy, portals:[{name,url,portalId,own,parents:{policyName:bool|null}}] }
// JSON blob from stdin (or --file) and prints the Markdown table. The
// orchestrator is responsible for reading the live own/parent states (via
// get-env.js / get-portal.js) and assembling that blob — this module never
// touches the network (DRY: it does not re-implement the read transport).

'use strict';

const fs = require('fs');
const path = require('path');

// Reuse the single-policy renderer's state normalization + icon helpers so the
// 🟢/🔴 markers and Enabled/Disabled labels stay identical across every status
// surface (DRY — one source for the visual convention).
const { normalizeState, iconForState } = require('./render-portal-table');

const MAPPING_PATH = path.join(__dirname, '..', 'references', 'governance-mapping.json');

function loadMapping(mappingPath) {
  const raw = fs.readFileSync(mappingPath || MAPPING_PATH, 'utf8');
  return JSON.parse(raw);
}

function findPolicy(mapping, policyName) {
  return (mapping.policies || []).find((p) => p.policyName === policyName) || null;
}

// The ordered parent chain to render as context columns for a child policy.
// Read straight from the child's own `availabilityDependsOn` (authoritative;
// the top-level effectiveStatusRules.parentColumnsByPolicy block is only the
// readable overview). Order is meaningful and preserved: External Auth first,
// then OAuth 2.0 for the three social IdPs — matching the admin's mental model
// ("External Auth + OAuth" for Facebook/Google/Microsoft). A leaf/independent
// policy (Maker Copilot, local login) — or External Auth itself as the root —
// returns [] (no parent columns; effective == own).
function parentChainForPolicy(policyName, mapping) {
  const policy = findPolicy(mapping, policyName);
  if (!policy || !Array.isArray(policy.availabilityDependsOn)) return [];
  return policy.availabilityDependsOn.slice();
}

// Short header label for a policy's status column. Prefer the explicit
// `statusColumnLabel` (e.g. "External Auth", "OAuth 2.0", "Google"); fall back
// to summaryLabel/subject/policyName so an unlabeled policy still renders a
// sensible header rather than crashing.
function statusColumnLabel(policyName, mapping) {
  const policy = findPolicy(mapping, policyName);
  if (!policy) return policyName;
  return policy.statusColumnLabel || policy.summaryLabel || policy.subject || policyName;
}

// Header for the final "net result" column. Defaults to
// `Effective <statusColumnLabel> Status`, but a policy may override the entire
// header string via `effectiveStatusLabel` in the mapping (e.g. OAuth 2.0 uses
// "Effective OpenAuth State") — the admin controls the exact wording per policy
// without affecting that policy's parent-column label elsewhere.
function effectiveStatusLabel(policyName, mapping) {
  const policy = findPolicy(mapping, policyName);
  if (policy && policy.effectiveStatusLabel) return policy.effectiveStatusLabel;
  return `Effective ${statusColumnLabel(policyName, mapping)} Status`;
}

// Combine the child's own state with its parents' states into the EFFECTIVE
// status per the effectiveStatusRules contract:
//   * 'Enabled'  iff every state (own + all parents) is Enabled;
//   * 'Disabled' iff no state is Unknown and at least one is Disabled;
//   * 'Unknown'  otherwise (some own/parent state could not be read — fail
//     visible, never silently claim Enabled/Disabled on a partial read).
// `states` is an array of already-normalized 'Enabled'/'Disabled'/'Unknown'
// labels (own first, then each parent).
function effectiveState(states) {
  const list = Array.isArray(states) ? states : [];
  if (list.length === 0) return 'Unknown';
  if (list.some((s) => s === 'Unknown')) return 'Unknown';
  if (list.every((s) => s === 'Enabled')) return 'Enabled';
  return 'Disabled';
}

// Escape a cell for a GitHub-flavored Markdown table: a literal `|` would be
// read as a column separator, and a newline would break the single-line cell.
function mdCell(s) {
  return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

// Format a normalized state label as an icon + word cell (🟢 Enabled /
// 🔴 Disabled / plain Unknown). `icons` defaults on; pass false for plain text.
function stateCell(label, icons) {
  const on = icons !== false;
  const icon = on ? iconForState(label) : '';
  return icon ? `${icon} ${label}` : label;
}

/**
 * Render the per-site effective-status Markdown table for a child policy.
 *
 * @param {object} req
 * @param {string} req.policy - the child policy name (e.g. EnableIdpOAuthGoogle).
 * @param {Array<{name?:string,url?:string,portalId?:string,own?:(boolean|string),parents?:object}>} req.portals
 *   Each portal carries its OWN state (`own`) and a `parents` map keyed by
 *   parent policy name → boolean|string|null live state.
 * @param {object} [opts]
 * @param {object} [opts.mapping] - preloaded mapping (else loaded from disk).
 * @param {boolean} [opts.icons=true] - prefix state cells with 🟢/🔴.
 * @returns {string} Markdown table (no trailing newline).
 */
function renderStatusTableMarkdown(req, opts = {}) {
  const mapping = opts.mapping || loadMapping();
  const icons = opts.icons !== false;
  const policyName = req && req.policy;
  const portals = Array.isArray(req && req.portals) ? req.portals : [];

  const parents = parentChainForPolicy(policyName, mapping);
  const ownLabel = statusColumnLabel(policyName, mapping);
  const parentLabels = parents.map((p) => statusColumnLabel(p, mapping));

  // Column order follows the dependency chain top-down so the admin reads the
  // gating context first: the parents (External Auth, then OAuth 2.0 for social
  // IdPs), then a single Effective <child> Status column. The child's OWN
  // governance-setting value is still an input to the effective computation
  // (own AND all parents) but is NOT shown as its own column — the admin asked
  // for just the parent context plus the net effective result.
  const effectiveHeader = effectiveStatusLabel(policyName, mapping);
  const headers = ['#', 'Name', 'URL', 'Site ID', ...parentLabels, effectiveHeader];

  const rows = portals.map((p, i) => {
    const ownState = normalizeState(p && p.own);
    const parentStates = parents.map((parentName) => {
      const pv = p && p.parents ? p.parents[parentName] : undefined;
      return normalizeState(pv);
    });
    // Effective = own AND every parent (order-independent logical AND). The own
    // state still gates the result even though it has no dedicated column.
    const eff = effectiveState([ownState, ...parentStates]);
    return [
      String(i + 1),
      (p && p.name) || '(unnamed)',
      (p && p.url) || '',
      (p && p.portalId) || '',
      ...parentStates.map((s) => stateCell(s, icons)),
      stateCell(eff, icons),
    ];
  });

  const head = '| ' + headers.map(mdCell).join(' | ') + ' |';
  const sep = '| ' + headers.map(() => '---').join(' | ') + ' |';
  const body = rows.map((r) => '| ' + r.map(mdCell).join(' | ') + ' |');
  return [head, sep, ...body].join('\n');
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
  });
}

const HELP = `render-status-table.js — Render the per-site EFFECTIVE governance-status table
for a child authentication policy (own state + parent context columns).

The effective status of a gated child = its own setting AND every parent:
  * OAuth 2.0 / OpenID Connect / SAML 2.0 / WS-Federation → also needs External Auth.
  * Facebook / Google / Microsoft → also needs OAuth 2.0 AND External Auth.

Usage:
  echo '<JSON>' | node render-status-table.js
  node render-status-table.js --file <path>

Input JSON:
  {
    "policy": "EnableIdpOAuthGoogle",
    "portals": [
      { "name": "Portal_4", "url": "https://...", "portalId": "<guid>",
        "own": true,
        "parents": { "EnableExternalAuthProviders": true, "EnableProtocolOpenAuth": true } }
    ]
  }

  "own" and each "parents" value accept true|false|"Enabled"|"Disabled"|null.
  A null/unreadable state renders "Unknown" and forces Effective = Unknown.

Flags:
  --file <path>  Read the JSON from a file instead of stdin.
  --no-icons     Omit the 🟢 / 🔴 state icons (plain Enabled / Disabled).
  --help         Show this help.

Output is a GitHub-flavored Markdown table — emit it as a rendered table, NOT
inside a code fence. Columns: # | Name | URL | Site ID | <parents…> |
Effective <child> Status  (parents first: External Auth → OAuth 2.0; the child's
own state gates the Effective column but has no column of its own).
`;

function parseFlags(argv) {
  const out = { icons: true };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-icons') out.icons = false;
    else if (a === '--icons') out.icons = true;
    else if (a === '--file') out.file = argv[++i];
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
  if (flags.file) {
    raw = fs.readFileSync(flags.file, 'utf8');
  } else {
    raw = await readStdin();
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`render-status-table: could not parse JSON input: ${e.message}\n`);
    process.exit(1);
    return;
  }
  const rendered = renderStatusTableMarkdown(parsed, { icons: flags.icons });
  process.stdout.write(rendered + '\n');
}

module.exports = {
  loadMapping,
  parentChainForPolicy,
  statusColumnLabel,
  effectiveStatusLabel,
  effectiveState,
  renderStatusTableMarkdown,
};

if (require.main === module) {
  main();
}
