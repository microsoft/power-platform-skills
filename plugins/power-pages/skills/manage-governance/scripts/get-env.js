#!/usr/bin/env node

// get-env.js — Reads the environment-level state of a governance policy.
// Routes to either the gateway transport (`GET /governance/{policy}` against
// api.powerplatform.com) or the admin-portal transport
// (`GET /api/v1/powerPortal/governance/environments/{envId}/{policy}` against
// portalsitewide-tip.portal-infra.dynamics.com) based on the --useAdminPortal
// flag. The admin-portal transport requires a caller-supplied bearer token.

const {
  parseCliArgs,
  fail,
  runCli,
} = require('../../../scripts/lib/power-platform-api');
const { SUPPORTED_POLICIES, assertPolicy } = require('./policies');
const { callGovernance } = require('./governance-transport');

const HELP = `get-env.js — Reads the environment-level governance policy state.

Usage:
  node get-env.js --policy <name> [--envId <guid>]
                  [--useAdminPortal --token <bearer> [--principalId <guid>] [--tenantId <guid>]]

Flags:
  --policy            Governance policy name. One of:
                        ${SUPPORTED_POLICIES.join('\n                        ')}
  --envId             Optional environment id. Falls back to the current PAC env
                      (gateway transport only).
  --useAdminPortal    Use the admin-portal transport (portalsitewide-tip.portal-infra.dynamics.com).
  --token             Bearer token for the admin portal (required with --useAdminPortal).
                      Copy from a logged-in browser session of
                      admin.preprod.powerplatform.microsoft.com.
  --principalId       Caller's Entra Object Id (admin portal only; defaults to PAC).
  --tenantId          Tenant id (admin portal only; defaults to PAC).
  --help              Show this help message.

Exit codes:
  0  Success
  2  Sign-in required (gateway transport only)
  1  Other failure

Stdout (JSON):
  { "status": "ok", "policy": "<name>", "envId": "<guid>",
    "transport": "gateway"|"admin-portal", "body": <raw> }
`;

async function main() {
  if (process.argv.includes('--help')) {
    process.stdout.write(HELP);
    return;
  }

  const args = parseCliArgs(process.argv);
  if (!args.policy) {
    fail('Usage: node get-env.js --policy <name> [--envId <guid>] [--useAdminPortal --token <bearer>]', 1);
  }
  assertPolicy(args.policy);
  if (args.useAdminPortal && !args.envId) {
    fail('--useAdminPortal requires --envId (the admin portal URL embeds it).', 1);
  }

  const res = await callGovernance({
    op: 'getEnv',
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
    fail(`Get env-level governance failed (${status}): ${msg}`, code);
  }

  process.stdout.write(
    JSON.stringify(
      {
        status: 'ok',
        policy: args.policy,
        envId: args.envId,
        transport: res.transport,
        body: res.body,
      },
      null,
      2
    ) + '\n'
  );
}

runCli(module, main);
