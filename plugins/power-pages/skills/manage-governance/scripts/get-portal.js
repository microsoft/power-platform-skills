#!/usr/bin/env node

// get-portal.js — Reads the portal-level state of a governance policy via the
// gateway transport: GET /websites/{portalId}/governance/{policy}.

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

Flags:
  --policy            Governance policy name. One of:
                        ${SUPPORTED_POLICIES.join('\n                        ')}
  --portalId          Power Platform API portal id. Resolve via list-portals.js
                      — this is the value from the website record's "Id" field,
                      NOT the Dataverse WebsiteRecordId.
  --envId             Optional environment id. Falls back to the current PAC env.
  --help              Show this help message.

Exit codes:
  0  Success
  2  Sign-in required
  1  Other failure

Stdout (JSON):
  { "status": "ok", "policy": "<name>", "envId": "<guid>",
    "portalId": "<guid>", "transport": "gateway", "body": <raw> }
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

  const res = await callGovernance({
    op: 'getPortal',
    envId: args.envId,
    policy: args.policy,
    portalId: args.portalId,
  });

  if (!res.ok) {
    const code = res.error?.code === 'ContextError' ? 2 : 1;
    const status = res.statusCode != null && res.statusCode !== 0 ? res.statusCode : 'no response';
    const msg = res.error?.message?.trim() || res.error?.code || 'unknown error';
    fail(`Get portal-level governance failed (${status}): ${msg}`, code);
  }

  process.stdout.write(
    JSON.stringify(
      {
        status: 'ok',
        policy: args.policy,
        envId: args.envId,
        portalId: args.portalId,
        transport: res.transport,
        body: res.body,
      },
      null,
      2
    ) + '\n'
  );
}

runCli(module, main);
