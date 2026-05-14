#!/usr/bin/env node

const { resolveContext, request, parseCliArgs, fail } = require('../../../scripts/lib/power-platform-api');

if (process.argv.includes('--help')) {
  process.stdout.write(`get-rules.js — Returns the firewall rules for a site (custom and managed).

Usage:
  node get-rules.js --portalId <guid> [--ruleType <name>]

Flags:
  --portalId   Power Platform API portal identifier (resolved during prerequisites)
  --ruleType   Optional filter: Custom or Managed (omit for both)
  --help       Show this help message

Exit codes:
  0  Success
  2  Sign-in required
  1  Other failure

Example:
  node get-rules.js --portalId <portal-id>
  node get-rules.js --portalId <portal-id> --ruleType <Custom|Managed>
`);
  process.exit(0);
}

const args = parseCliArgs(process.argv);
const portalId = args.portalId;
const ruleType = args.ruleType;

if (!portalId) {
  fail('Usage: node get-rules.js --portalId <guid> [--ruleType <name>]', 1);
}

(async () => {
  const ctx = resolveContext();
  if (ctx.error) fail(ctx.error, 2);

  const res = await request({
    context: ctx,
    method: 'GET',
    path: `/websites/${portalId}/getWafRules`,
    query: ruleType ? { ruleType } : undefined,
  });

  if (res.statusCode === 400 && (res.error?.code === 'B022' || res.error?.code === 'B023' || /not supported/i.test(res.error?.message || ''))) {
    process.stdout.write(JSON.stringify({ status: 'unsupported', message: res.error?.message || 'Firewall not available' }) + '\n');
    return;
  }

  if (!res.ok) fail(`Get firewall rules failed (${res.statusCode}): ${res.error?.message || ''}`, 1);

  process.stdout.write(JSON.stringify({ status: 'ok', body: res.body || {} }) + '\n');
})();
