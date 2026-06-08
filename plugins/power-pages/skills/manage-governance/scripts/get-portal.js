#!/usr/bin/env node

// get-portal.js — Reads the portal-level state of a governance policy.
//
// gateway transport:    GET /websites/{portalId}/governance/{policy}.
// admin-portal transport: there is no per-portal endpoint — the script
// instead fetches the policy's inclusion/exclusion lists via
// GET /api/v1/powerPortal/governance/policyRecord/{envId}/{policy} and reports
// whether the portalId appears in either list. The "portal-level state" is
// derived from those lists by the SKILL.md prose.

const {
  parseCliArgs,
  fail,
  runCli,
} = require('../../../scripts/lib/power-platform-api');
const { SUPPORTED_POLICIES, assertPolicy } = require('./policies');
const { callGovernance } = require('./governance-transport');

const HELP = `get-portal.js — Reads the portal-level governance policy state.

Usage:
  node get-portal.js --policy <name> --portalId <guid> [--envId <guid>]
                     [--useAdminPortal --token <bearer> [--principalId <guid>] [--tenantId <guid>]]

Flags:
  --policy            Governance policy name. One of:
                        ${SUPPORTED_POLICIES.join('\n                        ')}
  --portalId          Power Platform API portal id. Resolve via list-portals.js
                      — this is the value from the website record's "Id" field,
                      NOT the Dataverse WebsiteRecordId.
  --envId             Environment id (required with --useAdminPortal).
  --useAdminPortal    Use the admin-portal transport.
  --token             Bearer token for the admin portal.
  --principalId       Caller's Entra Object Id (admin portal only).
  --tenantId          Tenant id (admin portal only).
  --help              Show this help message.

Exit codes:
  0  Success
  2  Sign-in required (gateway transport only)
  1  Other failure

Stdout (JSON):
  { "status": "ok", "policy": "<name>", "envId": "<guid>",
    "portalId": "<guid>", "transport": "...",
    "body": <raw> }

  When transport=admin-portal, the body is the policyRecord object
  { "InclusionList": [...], "ExclusionList": [...] }. The script also
  derives a top-level "membership" field with values "included" |
  "excluded" | "neither".
`;

async function main() {
  if (process.argv.includes('--help')) {
    process.stdout.write(HELP);
    return;
  }

  const args = parseCliArgs(process.argv);
  if (!args.policy || !args.portalId) {
    fail('Usage: node get-portal.js --policy <name> --portalId <guid> [--envId <guid>]', 1);
  }
  assertPolicy(args.policy);
  if (args.useAdminPortal && !args.envId) {
    fail('--useAdminPortal requires --envId (the admin portal URL embeds it).', 1);
  }

  const res = await callGovernance({
    op: 'getPortal',
    envId: args.envId,
    policy: args.policy,
    portalId: args.portalId,
    useAdminPortal: Boolean(args.useAdminPortal),
    token: args.token,
    principalId: args.principalId,
    tenantId: args.tenantId,
  });

  if (!res.ok) {
    const code = res.error?.code === 'ContextError' ? 2 : 1;
    const status = res.statusCode != null && res.statusCode !== 0 ? res.statusCode : 'no response';
    const msg = res.error?.message?.trim() || res.error?.code || 'unknown error';
    fail(`Get portal-level governance failed (${status}): ${msg}`, code);
  }

  // For admin-portal: derive `membership` from the inclusion / exclusion lists.
  let membership;
  if (res.transport === 'admin-portal' && res.body && typeof res.body === 'object') {
    const inList = Array.isArray(res.body.InclusionList)
      ? res.body.InclusionList.map(String).map((s) => s.toLowerCase())
      : [];
    const exList = Array.isArray(res.body.ExclusionList)
      ? res.body.ExclusionList.map(String).map((s) => s.toLowerCase())
      : [];
    const target = String(args.portalId).toLowerCase();
    if (inList.includes(target)) membership = 'included';
    else if (exList.includes(target)) membership = 'excluded';
    else membership = 'neither';
  }

  process.stdout.write(
    JSON.stringify(
      {
        status: 'ok',
        policy: args.policy,
        envId: args.envId,
        portalId: args.portalId,
        transport: res.transport,
        ...(membership && { membership }),
        body: res.body,
      },
      null,
      2
    ) + '\n'
  );
}

runCli(module, main);
