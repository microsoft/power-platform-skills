#!/usr/bin/env node

const {
  resolveContext,
  request,
  parseCliArgs,
  fail,
  runCli,
} = require('../../../scripts/lib/power-platform-api');

const HELP = `start-deep-scan.js — Triggers an asynchronous deep scan.

Usage:
  node start-deep-scan.js --portalId <portal-id>

Flags:
  --portalId   Power Platform API portal identifier (resolved during prerequisites)
  --help       Show this help message

Exit codes:
  0  Success (scan started, or one is already running)
  2  Sign-in required
  1  Other failure

Example:
  node start-deep-scan.js --portalId <portal-id>
`;

async function main() {
  if (process.argv.includes('--help')) {
    process.stdout.write(HELP);
    return;
  }

  const { portalId } = parseCliArgs(process.argv);
  if (!portalId) {
    fail('Usage: node start-deep-scan.js --portalId <portal-id>', 1);
  }

  const ctx = resolveContext();
  if (ctx.error) fail(ctx.error, 2);

  const res = await request({
    context: ctx,
    method: 'POST',
    path: `/websites/${portalId}/scan/deep/start`,
  });

  if (res.statusCode === 202) {
    process.stdout.write(JSON.stringify({ status: 'started' }) + '\n');
    return;
  }
  // 204 / 400+Z003 both mean a scan is already in flight.
  if (res.statusCode === 204 || (res.statusCode === 400 && res.error?.code === 'Z003')) {
    process.stdout.write(JSON.stringify({ status: 'already-running' }) + '\n');
    return;
  }
  fail(`Start deep scan failed (${res.statusCode}): ${res.error?.message || ''}`, 1);
}

runCli(module, main);
