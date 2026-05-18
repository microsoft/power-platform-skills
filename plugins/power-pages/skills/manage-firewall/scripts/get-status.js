#!/usr/bin/env node

const { resolveContext, request, parseCliArgs, fail } = require('../../../scripts/lib/power-platform-api');

if (process.argv.includes('--help')) {
  process.stdout.write(`get-status.js — Returns the current firewall status for a site.

Usage:
  node get-status.js --portalId <portal-id>

Flags:
  --portalId   Power Platform API portal identifier (resolved during prerequisites)
  --help       Show this help message

Exit codes:
  0  Success (including unsupported region)
  2  Sign-in required
  1  Other failure

Example:
  node get-status.js --portalId <portal-id>
`);
  process.exit(0);
}

const args = parseCliArgs(process.argv);
const portalId = args.portalId;

if (!portalId) {
  fail('Usage: node get-status.js --portalId <portal-id>', 1);
}

(async () => {
  const ctx = resolveContext();
  if (ctx.error) fail(ctx.error, 2);

  const res = await request({ context: ctx, method: 'GET', path: `/websites/${portalId}/getWafStatus` });

  if (res.statusCode === 400 && (res.error?.code === 'B022' || res.error?.code === 'B023' || /not supported/i.test(res.error?.message || ''))) {
    const body = { status: 'unsupported', message: res.error?.message || 'Firewall not available for this site' };
    process.stdout.write(JSON.stringify(body) + '\n');
    return;
  }

  if (!res.ok) fail(`Get firewall status failed (${res.statusCode}): ${res.error?.message || ''}`, 1);

  const value = typeof res.body === 'string' ? res.body : (res.body?.status ?? res.body);
  process.stdout.write(JSON.stringify({ status: 'ok', value }) + '\n');
})();
