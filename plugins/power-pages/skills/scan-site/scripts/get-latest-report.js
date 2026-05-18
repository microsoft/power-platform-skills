#!/usr/bin/env node

const { resolveContext, request, parseCliArgs, fail } = require('../../../scripts/lib/power-platform-api');

if (process.argv.includes('--help')) {
  process.stdout.write(`get-latest-report.js — Fetches the latest completed deep-scan report.

Usage:
  node get-latest-report.js --portalId <portal-id>

Flags:
  --portalId   Power Platform API portal identifier (resolved during prerequisites)
  --help       Show this help message

Exit codes:
  0  Success (also returns { status: "empty" } when no scan has completed)
  2  Sign-in required
  1  Other failure

Example:
  node get-latest-report.js --portalId <portal-id>
`);
  process.exit(0);
}

const args = parseCliArgs(process.argv);
const portalId = args.portalId;

if (!portalId) {
  fail('Usage: node get-latest-report.js --portalId <portal-id>', 1);
}

(async () => {
  const ctx = resolveContext();
  if (ctx.error) fail(ctx.error, 2);

  const res = await request({
    context: ctx,
    method: 'GET',
    path: `/websites/${portalId}/scan/deep/getLatestCompletedReport`,
    timeout: 240_000, // 4 min — report fetch can be slow when alerts are numerous
  });

  // 204 No Content with Z003 means a scan is in progress and no completed report exists yet.
  if (res.statusCode === 204) {
    process.stdout.write(JSON.stringify({ status: 'empty' }) + '\n');
    return;
  }

  if (!res.ok) fail(`Get latest report failed (${res.statusCode}): ${res.error?.message || ''}`, 1);

  process.stdout.write(JSON.stringify({ status: 'ok', body: res.body || {} }) + '\n');
})();
