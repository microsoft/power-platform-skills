#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { resolveContext, request, parseCliArgs, fail } = require('../../../scripts/lib/admin-api');

if (process.argv.includes('--help')) {
  process.stdout.write(`get-status.js — Returns the current firewall status for a site.

Usage:
  node get-status.js --portalId <guid> --output <file>

Flags:
  --portalId   Admin-API portal identifier (resolved during prerequisites)
  --output     Path for the response JSON
  --help       Show this help message

Exit codes:
  0  Success (including unsupported region — written to file)
  2  Sign-in required
  1  Other failure
`);
  process.exit(0);
}

const args = parseCliArgs(process.argv);
const portalId = args.portalId;
const output = args.output;

if (!portalId || !output) {
  fail('Usage: node get-status.js --portalId <guid> --output <file>', 1);
}

(async () => {
  const ctx = resolveContext();
  if (ctx.error) fail(ctx.error, 2);

  const res = await request({ context: ctx, method: 'GET', path: `/websites/${portalId}/getWafStatus` });

  fs.mkdirSync(path.dirname(output), { recursive: true });

  if (res.statusCode === 400 && (res.error?.code === 'B022' || res.error?.code === 'B023' || /not supported/i.test(res.error?.message || ''))) {
    const body = { status: 'unsupported', message: res.error?.message || 'Firewall not available for this site' };
    fs.writeFileSync(output, JSON.stringify(body, null, 2));
    process.stdout.write(JSON.stringify({ ...body, output }) + '\n');
    return;
  }

  if (!res.ok) fail(`Get firewall status failed (${res.statusCode}): ${res.error?.message || ''}`, 1);

  const value = typeof res.body === 'string' ? res.body : (res.body?.status ?? res.body);
  fs.writeFileSync(output, JSON.stringify({ status: 'ok', value }, null, 2));
  process.stdout.write(JSON.stringify({ status: 'ok', value, output }) + '\n');
})();
