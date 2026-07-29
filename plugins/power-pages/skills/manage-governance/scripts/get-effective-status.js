#!/usr/bin/env node

// get-effective-status.js — Compute the *effective* governance state of a
// policy for every portal in an environment, in ONE parallel batch of reads.
//
// Why this script exists
// ----------------------
// A gated child sign-in method (a protocol or a social IdP) is only actually
// live on a portal when the child's OWN setting AND every gating parent are
// Enabled there (see governance-mapping.json `availabilityDependsOn` /
// `effectiveStatusRules`). Reading that status means reading the child plus its
// parents, and for each policy we need TWO calls — the env-level value
// (`getEnv`) and, when that value is Include/Exclude, the per-site membership
// (`getDetails`). So:
//   - a protocol (parent: External Auth)                    → 2 policies × 2 = 4 calls
//   - a social IdP (parents: External Auth + OAuth 2.0)     → 3 policies × 2 = 6 calls
//
// The previous flow (resolve-portal-availability.js `readParentStates`) issued
// those reads SEQUENTIALLY in a `for … await` loop, so a social-IdP status took
// 6 round-trips end-to-end. Each call is independent, so this script fires ALL
// of them concurrently with a single `Promise.all` and only then assembles the
// report — turning 4–6 serial round-trips into one parallel wave. The wall-clock
// cost drops to roughly a single round-trip regardless of the parent count.
//
// getEnv + getDetails are fired for EVERY policy unconditionally (even when the
// env value turns out to be All/None, where the details list is irrelevant).
// That is deliberate: firing both up-front keeps the batch a flat, fully
// parallel Promise.all instead of a value-dependent second wave, and matches the
// "6 calls, all parallel" model. A getDetails response for an All/None policy is
// simply ignored downstream (resolvePortalStates derives All→Enabled /
// None→Disabled without the list), and a failed getDetails is tolerated as an
// empty list — only a failed getEnv is fatal (we cannot classify without it).

'use strict';

const fs = require('fs');
const path = require('path');

const { assertPolicy, normalizeEnvValue } = require('./policies');
const { callGovernance } = require('./governance-transport');
const { resolveGovernanceContext } = require('./governance-context');
const {
  loadMapping,
  dependenciesForPolicy,
  canonicalizeEnvValue,
  resolvePortalStates,
} = require('./resolve-portal-availability');

// Per-request timeout for the parallel batch. The governance gateway is slow
// (single reads observed at 20–40s wall) and gets slower under concurrent load,
// so the request() 15s default trips a spurious "Request timed out" mid-batch.
// 120s gives every concurrent read ample headroom without hanging forever.
const BATCH_REQUEST_TIMEOUT_MS = 120_000;

const HELP = `get-effective-status.js — Effective per-portal governance status in one parallel batch.

Fires getEnv + getDetails for the CHILD policy and every gating parent
concurrently (4 calls for a protocol, 6 for a social IdP), then reports each
portal's EFFECTIVE state = child own AND all parents.

Usage:
  node get-effective-status.js --policy <name> --portalsFile <path> [--envId <guid>] [--json]

Flags:
  --policy       Governance policy name (any of the ten). Leaf policies with no
                 parents report their own state as the effective state.
  --portalsFile  Path to list-portals.js output ({ portals: [...] } or a bare
                 array). Required — this script does NOT re-page /websites.
  --envId        Optional environment id (falls back to the current PAC env).
  --json         (default) Emit JSON.
  --help         Show this help.

Exit codes:
  0  Success   2  Sign-in required   1  Other failure

Stdout (JSON) — the shape render-portal-table.js consumes directly (it reads
\`.portals\`), so you can pipe this straight into it:
  {
    "status": "ok",
    "policy": "<name>",
    "dependencies": ["<parent>", ...],
    "apiCalls": <n>,               // policies × 2, all issued in parallel
    "effectiveEnabledCount": <n>,
    "portals": [
      { "name", "url", "portalId",
        "state": true|false,       // EFFECTIVE (own AND all parents) — for the box
        "own": true|false,         // child's own setting on this portal
        "parents": { "<parent>": true|false, ... } }
    ]
  }
`;

function parseFlags(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--policy') out.policy = argv[++i];
    else if (a === '--portalsFile') out.portalsFile = argv[++i];
    else if (a === '--envId') out.envId = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--help') out.help = true;
  }
  return out;
}

/**
 * Read one policy's env value + details concurrently is handled by the caller's
 * flat Promise.all; this helper just classifies a completed (env, details) pair
 * into per-portal Enabled/Disabled booleans keyed by portal id.
 *
 * @param {object} envRes    - callGovernance getEnv envelope for this policy.
 * @param {object} detailsRes- callGovernance getDetails envelope (may be !ok).
 * @param {Array} portals    - list-portals records.
 * @returns {{ byId: Object<string,boolean>, states: Array }}
 */
function classifyPolicy(envRes, detailsRes, portals) {
  const envValue = canonicalizeEnvValue(normalizeEnvValue(envRes.body));
  // Only Include/Exclude actually consult the membership list; for All/None the
  // details body is irrelevant, and a failed/absent details read degrades to an
  // empty list (fail-closed for the list only — the env value was read fine).
  const detailsBody = detailsRes && detailsRes.ok ? detailsRes.body : null;
  const states = resolvePortalStates(envValue, detailsBody, portals);
  const byId = {};
  for (const s of states) byId[String(s.portalId).toLowerCase()] = s.state === 'Enabled';
  return { byId, states };
}

async function main() {
  const flags = parseFlags(process.argv);
  if (flags.help) {
    process.stdout.write(HELP);
    return;
  }
  if (!flags.policy || !flags.portalsFile) {
    process.stderr.write(
      'Usage: node get-effective-status.js --policy <name> --portalsFile <path> [--envId <guid>]\n'
    );
    process.exit(1);
    return;
  }
  assertPolicy(flags.policy);

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(flags.portalsFile, 'utf8'));
  } catch (e) {
    process.stderr.write(`get-effective-status: could not read/parse --portalsFile: ${e.message}\n`);
    process.exit(1);
    return;
  }
  const portals = Array.isArray(parsed) ? parsed : parsed.portals || [];

  const mapping = loadMapping();
  const deps = dependenciesForPolicy(flags.policy, mapping);
  // Child first so its own state is easy to pick out; parents follow.
  const allPolicies = [flags.policy, ...deps];

  // Resolve the governance context (which mints the bearer token via a
  // tip-auth.js subprocess) EXACTLY ONCE and share it across every request in
  // the batch. The token is env-scoped, not policy-scoped, so all 4–6 reads use
  // the same context — resolving per-call would re-spawn the token helper 4–6×
  // and serialize the batch behind those blocking subprocess spawns.
  const context = resolveGovernanceContext(flags.envId);
  if (context.error) {
    process.stderr.write(`Failed to resolve governance context: ${context.error}\n`);
    process.exit(2);
    return;
  }

  // THE PARALLEL BATCH: every getEnv + getDetails for every policy is fired at
  // once against the shared context. `Promise.all` waits for the whole wave, so
  // total latency ≈ one round-trip instead of (2 × policy count) serial ones.
  const calls = [];
  for (const p of allPolicies) {
    calls.push(
      callGovernance({ op: 'getEnv', envId: flags.envId, policy: p, context, timeout: BATCH_REQUEST_TIMEOUT_MS }).then((r) => ({ p, kind: 'env', r }))
    );
    calls.push(
      callGovernance({ op: 'getDetails', envId: flags.envId, policy: p, context, timeout: BATCH_REQUEST_TIMEOUT_MS }).then((r) => ({ p, kind: 'details', r }))
    );
  }
  const settled = await Promise.all(calls);

  // Regroup the flat results back into { policy: { env, details } }.
  const byPolicy = {};
  for (const { p, kind, r } of settled) {
    byPolicy[p] = byPolicy[p] || {};
    byPolicy[p][kind] = r;
  }

  // A failed getEnv is fatal — without the env value we cannot classify the
  // policy at all. Surface a sign-in vs. other-failure exit code like the
  // sibling scripts do.
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

  // Classify each policy's per-portal state from its (env, details) pair.
  const childInfo = classifyPolicy(byPolicy[flags.policy].env, byPolicy[flags.policy].details, portals);
  const parentInfos = {};
  for (const parent of deps) {
    parentInfos[parent] = classifyPolicy(byPolicy[parent].env, byPolicy[parent].details, portals);
  }

  // Effective = child own Enabled AND every parent Enabled on that portal.
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

  process.stdout.write(
    JSON.stringify(
      {
        status: 'ok',
        policy: flags.policy,
        dependencies: deps,
        apiCalls: allPolicies.length * 2,
        effectiveEnabledCount: rows.filter((r) => r.state).length,
        portals: rows,
      },
      null,
      2
    ) + '\n'
  );
}

module.exports = { classifyPolicy };

if (require.main === module) {
  main();
}
