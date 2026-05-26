#!/usr/bin/env node

const {
  resolveContext,
  request,
  parseCliArgs,
  fail,
  hasErrorCode,
  runCli,
} = require('../../../scripts/lib/power-platform-api');

const REQUEST_TIMEOUT_MS = 240_000; // 4 min — deletion exceeds the 15s default.

const HELP = `delete-rules.js — Deletes custom firewall rules by name.

Usage:
  node delete-rules.js --portalId <portal-id> --names <name1,name2,...>

Flags:
  --portalId   Power Platform API portal identifier (resolved during prerequisites)
  --names      Comma-separated list of custom rule names to delete
  --help       Show this help message

Exit codes:
  0  Accepted (deletion is asynchronous)
  2  Sign-in required
  4  Unsupported
  1  Other failure

Example:
  node delete-rules.js --portalId <portal-id> --names <RuleName1>,<RuleName2>
`;

async function main() {
  if (process.argv.includes('--help')) {
    process.stdout.write(HELP);
    return;
  }

  const args = parseCliArgs(process.argv);
  const { portalId, names: namesArg } = args;
  if (!portalId || !namesArg) {
    fail('Usage: node delete-rules.js --portalId <portal-id> --names <name1,name2,...>', 1);
  }

  const names = namesArg
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
  if (names.length === 0) fail('No rule names provided.', 1);

  const ctx = resolveContext();
  if (ctx.error) fail(ctx.error, 2);

  const res = await request({
    context: ctx,
    method: 'PUT',
    path: `/websites/${portalId}/deleteWafCustomRules`,
    body: names,
    timeout: REQUEST_TIMEOUT_MS,
  });

  if (hasErrorCode(res, 'B022', 'B023')) {
    fail(`Firewall not available: ${res.error?.message || ''}`, 4);
  }
  if (!res.ok) {
    fail(`Delete firewall rules failed (${res.statusCode}): ${res.error?.message || ''}`, 1);
  }

  process.stdout.write(JSON.stringify({ status: 'accepted', deleted: names }) + '\n');
}

runCli(module, main);
