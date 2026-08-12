#!/usr/bin/env node

// fetch-env-status.js — One-shot "Fetch Env status" for a governance policy.
//
// This is the single script the skill triggers to answer "what is the status of
// <policy> in <env>?" (SKILL.md Phase 4.3.1). It performs the WHOLE Fetch Env in
// ONE parallel wave and emits a render-ready payload, so the orchestrator just
// runs it and pipes `.portals` into render-portal-table.js.
//
// What it batches (all fired concurrently against ONE shared context/token)
// -----------------------------------------------------------------------
//   1. GET /websites                     — the env's full site list (paged).
//   2. getEnv + getDetails for the POLICY — the policy's own per-site state.
//   3. getEnv + getDetails for EACH gating PARENT (External Auth, and for a
//      social IdP also OAuth 2.0) — needed to compute the EFFECTIVE state.
//
// Before this script the flow was two steps: list-portals.js FIRST (a separate
// round-trip), THEN get-effective-status.js for the governance reads. Folding
// the site-list fetch into the same Promise.all removes that extra serial
// round-trip — the site list and all 4–6 governance reads now resolve together,
// so total latency is ≈ one round-trip regardless of parent count.
//
// Why share ONE context: resolving the governance context mints a bearer token
// via a blocking `tip-auth.js` subprocess (execSync). The token is env-scoped,
// not policy-scoped, so every read in the batch reuses it — resolving per-call
// would re-spawn the token helper 7× and serialize the whole batch behind those
// subprocess spawns. See governance-transport.js `context` param.
//
// Effective state (for a gated child): a protocol/social IdP is only actually
// live on a site when its OWN setting AND every gating parent are Enabled there
// (governance-mapping.json `availabilityDependsOn`). For a leaf policy (Maker
// Copilot, local login, External Auth, the 11 PowerPages_* policies) there are
// no parents, so effective state == own state and only 2 governance reads fire.

'use strict';

const { assertPolicy, normalizeEnvValue } = require('./policies');
const { callGovernance } = require('./governance-transport');
const { resolveGovernanceContext } = require('./governance-context');
const { fetchPortalsPaged } = require('./list-portals');
const {
  loadMapping,
  dependenciesForPolicy,
  canonicalizeEnvValue,
  resolvePortalStates,
} = require('./resolve-portal-availability');
const { classifyPolicy } = require('./get-effective-status');

// Per-request timeout for the parallel batch. The governance gateway is slow
// (single reads observed at 20–40s wall) and gets slower under concurrent load,
// so the request() 15s default trips a spurious "Request timed out" mid-batch.
// 120s gives every concurrent read ample headroom without hanging forever.
// Mirrors get-effective-status.js.
const BATCH_REQUEST_TIMEOUT_MS = 120_000;

const HELP = `fetch-env-status.js — One-shot Fetch Env status (site list + all reads in one parallel batch).

Answers "what is the status of <policy> in <env>?" in a SINGLE parallel wave:
the /websites site list plus getEnv + getDetails for the policy AND every
gating parent (External Auth, and for a social IdP also OAuth 2.0) are all
fired concurrently against one shared token, then each site's EFFECTIVE state
(own AND every parent) is computed.

Usage:
  node fetch-env-status.js --policy <name> [--envId <guid>] [--json]

Flags:
  --policy   Governance policy name (any of the supported policies). A leaf
             policy with no parents reports its own state as the effective state
             and issues only 2 governance reads.
  --envId    Optional environment id (falls back to the current PAC env).
  --json     (default) Emit JSON.
  --help     Show this help.

Exit codes:
  0  Success (including an env with zero sites)
  2  Sign-in required
  1  Other failure

Stdout (JSON) — the \`.portals\` array is exactly what render-portal-table.js
consumes, so pipe it straight in:
  {
    "status": "ok",
    "policy": "<name>",
    "envId": "<guid>",
    "envValue": "All|None|Include|Exclude",   // the POLICY's own env-level value
    "dependencies": ["<parent>", ...],
    "apiCalls": <n>,                            // 1 (websites) + policies × 2
    "portalCount": <n>,
    "effectiveEnabledCount": <n>,
    "headline": "This Governance setting is 🟢 Enabled for these Sites:" | "... 🔴 Disabled ...",
    "portals": [
      { "name", "url", "portalId",
        "state": true|false,        // EFFECTIVE (own AND all parents) — for the box
        "own": true|false,          // policy's own setting on this site
        "parents": { "<parent>": true|false, ... } }
    ]
  }
`;

function parseFlags(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--policy') out.policy = argv[++i];
    else if (a === '--envId') out.envId = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--help') out.help = true;
  }
  return out;
}

// Headline mirrors SKILL.md Phase 4.3.1: green when at least one site is
// effectively Enabled, red when the setting is off everywhere (including the
// zero-site case, where there is nothing enabled).
function pickHeadline(effectiveEnabledCount) {
  return effectiveEnabledCount > 0
    ? 'This Governance setting is \u{1F7E2} Enabled for these Sites:'
    : 'This Governance setting is \u{1F534} Disabled for these Sites:';
}

async function main() {
  const flags = parseFlags(process.argv);
  if (flags.help) {
    process.stdout.write(HELP);
    return;
  }
  if (!flags.policy) {
    process.stderr.write('Usage: node fetch-env-status.js --policy <name> [--envId <guid>]\n');
    process.exit(1);
    return;
  }
  assertPolicy(flags.policy);

  const mapping = loadMapping();
  const deps = dependenciesForPolicy(flags.policy, mapping);
  // Child first so its own state is easy to pick out; parents follow.
  const allPolicies = [flags.policy, ...deps];

  // Resolve the governance context (which mints the bearer token via a
  // tip-auth.js subprocess) EXACTLY ONCE and share it across the site-list fetch
  // and every governance read — see the file header for why.
  const context = resolveGovernanceContext(flags.envId);
  if (context.error) {
    process.stderr.write(`Failed to resolve governance context: ${context.error}\n`);
    process.exit(2);
    return;
  }

  // THE PARALLEL BATCH. The /websites site-list fetch and every getEnv +
  // getDetails read are all promises kicked off before any is awaited, so
  // Promise.all runs them in a single concurrent wave. The site-list result is
  // tagged kind:'sites' so it can be separated from the governance reads when we
  // regroup below.
  const calls = [];
  calls.push(fetchPortalsPaged(context).then((r) => ({ kind: 'sites', r })));
  for (const p of allPolicies) {
    calls.push(
      callGovernance({ op: 'getEnv', envId: flags.envId, policy: p, context, timeout: BATCH_REQUEST_TIMEOUT_MS }).then((r) => ({ p, kind: 'env', r }))
    );
    calls.push(
      callGovernance({ op: 'getDetails', envId: flags.envId, policy: p, context, timeout: BATCH_REQUEST_TIMEOUT_MS }).then((r) => ({ p, kind: 'details', r }))
    );
  }
  const settled = await Promise.all(calls);

  // Regroup the flat results: pull out the site list, and rebuild
  // { policy: { env, details } } for each governance policy.
  let sitesResult = null;
  const byPolicy = {};
  for (const item of settled) {
    if (item.kind === 'sites') {
      sitesResult = item.r;
      continue;
    }
    byPolicy[item.p] = byPolicy[item.p] || {};
    byPolicy[item.p][item.kind] = item.r;
  }

  // A failed /websites read is fatal — without the site list there is nothing to
  // classify. (An empty list is NOT an error: the env legitimately has no sites.)
  if (!sitesResult || sitesResult.error) {
    process.stderr.write(`Listing sites failed: ${sitesResult ? sitesResult.error : 'no result'}\n`);
    process.exit(1);
    return;
  }
  const portals = sitesResult.portals || [];

  // A failed getEnv is fatal — without the env value we cannot classify that
  // policy at all. Surface a sign-in vs. other-failure exit code like the
  // sibling scripts do. (A failed getDetails is tolerated as an empty list.)
  for (const p of allPolicies) {
    const envRes = byPolicy[p] && byPolicy[p].env;
    if (!envRes || !envRes.ok) {
      const msg = envRes?.error?.message || `status ${envRes?.statusCode}`;
      const code = envRes?.error?.code === 'ContextError' ? 2 : 1;
      process.stderr.write(`Reading "${p}" env state failed: ${msg}\n`);
      process.exit(code);
      return;
    }
  }

  // The POLICY's own env-level value (canonical All/None/Include/Exclude) — kept
  // in the payload so the caller can render the plain-language env summary.
  const envValue = canonicalizeEnvValue(normalizeEnvValue(byPolicy[flags.policy].env.body));

  // Classify each policy's per-portal state from its (env, details) pair, then
  // fold parents into the child to get the EFFECTIVE state per site.
  const childInfo = classifyPolicy(byPolicy[flags.policy].env, byPolicy[flags.policy].details, portals);
  const parentInfos = {};
  for (const parent of deps) {
    parentInfos[parent] = classifyPolicy(byPolicy[parent].env, byPolicy[parent].details, portals);
  }

  const rows = childInfo.states.map((s) => {
    const key = String(s.portalId).toLowerCase();
    const own = s.state === 'Enabled';
    const parents = {};
    let effective = own;
    for (const parent of deps) {
      const on = parentInfos[parent].byId[key] === true;
      parents[parent] = on;
      effective = effective && on;
    }
    return { name: s.name, url: s.url, portalId: s.portalId, state: effective, own, parents };
  });
  // Effective-Enabled first (stable within each group) so the status box lists
  // the live sites at the top, matching the rest of the skill's status renders.
  rows.sort((a, b) => Number(b.state) - Number(a.state));

  const effectiveEnabledCount = rows.filter((r) => r.state).length;

  process.stdout.write(
    JSON.stringify(
      {
        status: 'ok',
        policy: flags.policy,
        envId: flags.envId || null,
        envValue,
        dependencies: deps,
        apiCalls: 1 + allPolicies.length * 2,
        portalCount: rows.length,
        effectiveEnabledCount,
        headline: pickHeadline(effectiveEnabledCount),
        portals: rows,
      },
      null,
      2
    ) + '\n'
  );
}

module.exports = { pickHeadline, parseFlags };

if (require.main === module) {
  main();
}
