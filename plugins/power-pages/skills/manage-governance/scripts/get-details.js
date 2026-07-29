#!/usr/bin/env node

// get-details.js — Reads a governance policy's per-site membership (the
// inclusion / exclusion portal lists) for the whole environment in ONE call via
// the gateway transport: GET /governance/{policy}/details.
//
// WHY this exists — kill the per-portal read loop
// -----------------------------------------------
// The portal-scoped endpoint `GET /websites/{portalId}/governance/{policy}`
// (get-portal.js) answers for exactly one portal and returns a single boolean,
// so reading N portals costs N cold-started calls — each one a fresh chance to
// hit a transient "PAC not signed in" (observed mid-loop in practice). It also
// cannot be probed with a dummy portalId: a non-existent website id returns
// 404 "Website with the given id does not exist", so the old "call get-portal
// with 00000000-… to get the env lists" trick never worked.
//
// The `/details` endpoint returns the env-level inclusion/exclusion lists once:
//   { "IncludedSites": ["<portalId>", ...], "ExcludedSites": ["<portalId>", ...] }
// (ExcludedSites is null when unused). Combined with get-env.js (the All / None
// / Include / Exclude env value), the caller can resolve EVERY portal's state
// locally via resolvePortalStates() — 2 network calls per policy regardless of
// portal count, instead of 1 + N. See references/commands.md and SKILL.md
// Phase 4.3.1 / 4.4.4 / 4.2.3 / 4.2.5.
//
// This is a thin network wrapper: the pure list-parsing + per-portal
// classification lives in resolve-portal-availability.js (extractLists /
// resolvePortalStates), reused here so there is a single source of truth for
// the list field-name spellings and the siteStateRules contract.

const {
  parseCliArgs,
  fail,
  runCli,
} = require('../../../scripts/lib/power-platform-api');
const { SUPPORTED_POLICIES, assertPolicy } = require('./policies');
const { callGovernance } = require('./governance-transport');
const { extractLists } = require('./resolve-portal-availability');

const HELP = `get-details.js — Reads a governance policy's inclusion/exclusion site lists.

Reads the env-level per-site membership for a policy in a SINGLE call
(GET /governance/{policy}/details), so every portal's state can be resolved
locally without a per-portal read loop.

Usage:
  node get-details.js --policy <name> [--envId <guid>]

Flags:
  --policy            Governance policy name. One of:
                        ${SUPPORTED_POLICIES.join('\n                        ')}
  --envId             Optional environment id. Falls back to the current PAC env.
  --help              Show this help message.

Exit codes:
  0  Success
  2  Sign-in required
  1  Other failure

Stdout (JSON):
  { "status": "ok", "policy": "<name>", "envId": "<guid>",
    "transport": "gateway",
    "includedSites": ["<portalId>", ...],
    "excludedSites": ["<portalId>", ...],
    "body": <raw> }
`;

async function main() {
  if (process.argv.includes('--help')) {
    process.stdout.write(HELP);
    return;
  }

  const args = parseCliArgs(process.argv);
  if (!args.policy) {
    fail('Usage: node get-details.js --policy <name> [--envId <guid>]', 1);
  }
  assertPolicy(args.policy);

  const res = await callGovernance({
    op: 'getDetails',
    envId: args.envId,
    policy: args.policy,
  });

  if (!res.ok) {
    const code = res.error?.code === 'ContextError' ? 2 : 1;
    const status = res.statusCode != null && res.statusCode !== 0 ? res.statusCode : 'no response';
    const msg = res.error?.message?.trim() || res.error?.code || 'unknown error';
    fail(`Get governance details failed (${status}): ${msg}`, code);
  }

  // Normalize the two lists through the shared parser so the emitted arrays use
  // one canonical spelling (lowercased id strings) no matter how the gateway
  // spelled the fields on this ring. Callers that want the raw shape still get
  // it under `body`.
  const { inclusion, exclusion } = extractLists(res.body);

  process.stdout.write(
    JSON.stringify(
      {
        status: 'ok',
        policy: args.policy,
        envId: args.envId,
        transport: res.transport,
        includedSites: [...inclusion],
        excludedSites: [...exclusion],
        body: res.body,
      },
      null,
      2
    ) + '\n'
  );
}

runCli(module, main);
