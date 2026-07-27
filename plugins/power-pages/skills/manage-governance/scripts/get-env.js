#!/usr/bin/env node

// get-env.js — Reads the environment-level state of a governance policy via the
// gateway transport (`GET /governance/{policy}` against api.powerplatform.com,
// env-scoped through the base URL).

const {
  parseCliArgs,
  fail,
  runCli,
} = require('../../../scripts/lib/power-platform-api');
const { SUPPORTED_POLICIES, assertPolicy, normalizeEnvValue } = require('./policies');
const { callGovernance } = require('./governance-transport');

const HELP = `get-env.js — Reads the environment-level governance policy state.

Usage:
  node get-env.js --policy <name> [--envId <guid>]

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
    "value": "All"|"None"|"Include"|"Exclude", "body": <raw> }
`;

async function main() {
  if (process.argv.includes('--help')) {
    process.stdout.write(HELP);
    return;
  }

  const args = parseCliArgs(process.argv);
  if (!args.policy) {
    fail('Usage: node get-env.js --policy <name> [--envId <guid>]', 1);
  }
  assertPolicy(args.policy);

  const res = await callGovernance({
    op: 'getEnv',
    envId: args.envId,
    policy: args.policy,
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
        value: normalizeEnvValue(res.body),
        body: res.body,
      },
      null,
      2
    ) + '\n'
  );
}

runCli(module, main);
