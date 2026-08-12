#!/usr/bin/env node

// get-status.js — One-shot status read for a governance policy roll-out via the
// gateway transport (`GET /governance/status/{policy}`).

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

Flags:
  --policy            Governance policy name. One of:
                        ${SUPPORTED_POLICIES.join('\n                        ')}
  --envId             Optional environment id. Falls back to the current PAC env.
  --help              Show this help message.

Exit codes:
  0  Success (including in-progress status)
  2  Sign-in required
  1  Other failure

Stdout (JSON):
  { "status": "ok", "policy": "<name>", "transport": "gateway",
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

  const res = await callGovernance({
    op: 'getStatus',
    envId: args.envId,
    policy: args.policy,
  });

  if (!res.ok) {
    const code = res.error?.code === 'ContextError' ? 2 : 1;
    const status = res.statusCode != null && res.statusCode !== 0 ? res.statusCode : 'no response';
    const msg = res.error?.message?.trim() || res.error?.code || 'unknown error';
    fail(`Get governance status failed (${status}): ${msg}`, code);
  }

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
