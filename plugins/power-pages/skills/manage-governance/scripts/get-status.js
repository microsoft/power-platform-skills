#!/usr/bin/env node

// get-status.js — One-shot status read for a governance policy roll-out.
// Routes via gateway (`GET /governance/status/{policy}`) or admin portal
// (`GET /api/v1/powerPortal/governance/status/{envId}/{policy}`) based on the
// --useAdminPortal flag.

const {
  parseCliArgs,
  fail,
  runCli,
} = require('../../../scripts/lib/power-platform-api');
const { SUPPORTED_POLICIES, assertPolicy } = require('./policies');
const { callGovernance } = require('./governance-transport');

const HELP = `get-status.js — Returns the current roll-out status for a governance policy.

Usage:
  node get-status.js --policy <name> [--envId <guid>]
                     [--useAdminPortal --token <bearer> [--principalId <guid>] [--tenantId <guid>]]

Flags:
  --policy            Governance policy name. One of:
                        ${SUPPORTED_POLICIES.join('\n                        ')}
  --envId             Environment id (required with --useAdminPortal).
  --useAdminPortal    Use the admin-portal transport.
  --token             Bearer token for the admin portal.
  --principalId       Caller's Entra Object Id (admin portal only).
  --tenantId          Tenant id (admin portal only).
  --help              Show this help message.

Exit codes:
  0  Success (including in-progress status)
  2  Sign-in required (gateway transport only)
  1  Other failure

Stdout (JSON):
  { "status": "ok", "policy": "<name>", "transport": "...",
    "value": "<state>", "body": <raw> }
`;

async function main() {
  if (process.argv.includes('--help')) {
    process.stdout.write(HELP);
    return;
  }

  const args = parseCliArgs(process.argv);
  if (!args.policy) {
    fail('Usage: node get-status.js --policy <name> [--envId <guid>]', 1);
  }
  assertPolicy(args.policy);
  if (args.useAdminPortal && !args.envId) {
    fail('--useAdminPortal requires --envId (the admin portal URL embeds it).', 1);
  }

  const res = await callGovernance({
    op: 'getStatus',
    envId: args.envId,
    policy: args.policy,
    useAdminPortal: Boolean(args.useAdminPortal),
    token: args.token,
    principalId: args.principalId,
    tenantId: args.tenantId,
  });

  if (!res.ok) {
    const code = res.error?.code === 'ContextError' ? 2 : 1;
    const status = res.statusCode != null && res.statusCode !== 0 ? res.statusCode : 'no response';
    const msg = res.error?.message?.trim() || res.error?.code || 'unknown error';
    fail(`Get governance status failed (${status}): ${msg}`, code);
  }

  // Bare string ("Succeeded") OR { status|state|value: "..." } — surface both.
  const raw = res.body;
  const value =
    typeof raw === 'string'
      ? raw
      : raw?.status ?? raw?.state ?? raw?.value ?? null;

  process.stdout.write(
    JSON.stringify(
      { status: 'ok', policy: args.policy, transport: res.transport, value, body: raw },
      null,
      2
    ) + '\n'
  );
}

runCli(module, main);
