#!/usr/bin/env node

const {
  resolveContext,
  request,
  parseCliArgs,
  fail,
  isFeatureUnsupported,
  runCli,
} = require('../../../scripts/lib/power-platform-api');

const HELP = `get-status.js — Returns the current firewall status for a site.

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
`;

async function main() {
  if (process.argv.includes('--help')) {
    process.stdout.write(HELP);
    return;
  }

  const { portalId } = parseCliArgs(process.argv);
  if (!portalId) {
    fail('Usage: node get-status.js --portalId <portal-id>', 1);
  }

  const ctx = resolveContext();
  if (ctx.error) fail(ctx.error, 2);

  const res = await request({
    context: ctx,
    method: 'GET',
    path: `/websites/${portalId}/getWafStatus`,
  });

  if (isFeatureUnsupported(res, 'B022', 'B023')) {
    process.stdout.write(
      JSON.stringify({
        status: 'unsupported',
        message: res.error?.message || 'Firewall not available for this site',
      }) + '\n'
    );
    return;
  }

  if (!res.ok) {
    fail(`Get firewall status failed (${res.statusCode}): ${res.error?.message || ''}`, 1);
  }

  // The service returns either the bare string ("Created") or { status: "Created" }.
  const value = typeof res.body === 'string' ? res.body : res.body?.status;
  process.stdout.write(JSON.stringify({ status: 'ok', value: value ?? null }) + '\n');
}

runCli(module, main);
