#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { resolveContext, request, parseCliArgs, fail } = require('../../../scripts/lib/admin-api');

if (process.argv.includes('--help')) {
  process.stdout.write(`get-rules.js — Returns the firewall rules for a site (custom and managed).

Usage:
  node get-rules.js --portalId <guid> --output <file> [--ruleType <name>]

Flags:
  --portalId   Admin-API portal identifier (resolved during prerequisites)
  --output     Path for the response JSON
  --ruleType   Optional filter: Custom or Managed (omit for both)
  --help       Show this help message

Exit codes:
  0  Success
  2  Sign-in required
  1  Other failure
`);
  process.exit(0);
}

const args = parseCliArgs(process.argv);
const portalId = args.portalId;
const output = args.output;
const ruleType = args.ruleType;

if (!portalId || !output) {
  fail('Usage: node get-rules.js --portalId <guid> --output <file> [--ruleType <name>]', 1);
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

  fs.mkdirSync(path.dirname(output), { recursive: true });

  if (res.statusCode === 400 && (res.error?.code === 'B022' || res.error?.code === 'B023' || /not supported/i.test(res.error?.message || ''))) {
    const body = { status: 'unsupported', message: res.error?.message || 'Firewall not available' };
    fs.writeFileSync(output, JSON.stringify(body, null, 2));
    process.stdout.write(JSON.stringify({ ...body, output }) + '\n');
    return;
  }

  if (!res.ok) fail(`Get firewall rules failed (${res.statusCode}): ${res.error?.message || ''}`, 1);

  const data = res.body || {};
  const customRules = Array.isArray(data.CustomRules) ? data.CustomRules.length : 0;
  const managedRules = Array.isArray(data.ManagedRules) ? data.ManagedRules.length : 0;
  fs.writeFileSync(output, JSON.stringify({ status: 'ok', body: data }, null, 2));
  process.stdout.write(JSON.stringify({ status: 'ok', customRules, managedRules, output }) + '\n');
})();
