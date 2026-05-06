#!/usr/bin/env node

const { resolveContext, request, parseCliArgs, fail } = require('../../../scripts/lib/admin-api');

if (process.argv.includes('--help')) {
  process.stdout.write(`poll-deep-scan.js — Polls the deep-scan status endpoint until completion or timeout.

Usage:
  node poll-deep-scan.js --portalId <guid> [--timeoutMinutes <n>] [--intervalSeconds <n>]

Flags:
  --portalId          Admin-API portal identifier (resolved during prerequisites)
  --timeoutMinutes    Maximum wait time (default: 20)
  --intervalSeconds   Pause between status checks (default: 30)
  --help              Show this help message

Exit codes:
  0  Scan completed
  3  Polling timed out
  2  Sign-in required
  1  Other failure
`);
  process.exit(0);
}

const args = parseCliArgs(process.argv);
const portalId = args.portalId;
const timeoutMinutes = parseInt(args.timeoutMinutes || '20', 10);
const intervalSeconds = parseInt(args.intervalSeconds || '30', 10);

if (!portalId) {
  fail('Usage: node poll-deep-scan.js --portalId <guid> [--timeoutMinutes <n>] [--intervalSeconds <n>]', 1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const ctx = resolveContext();
  if (ctx.error) fail(ctx.error, 2);

  const deadline = Date.now() + timeoutMinutes * 60 * 1000;
  const startTime = Date.now();
  let lastLog = 0;

  while (Date.now() < deadline) {
    const res = await request({
      context: ctx,
      method: 'GET',
      path: `/websites/${portalId}/scan/deep/isongoing`,
    });
    if (!res.ok) fail(`Status check failed (${res.statusCode}): ${res.error?.message || ''}`, 1);

    const ongoing = res.body?.status === true || res.body?.status === 'true' || res.body?.status === 1;
    if (!ongoing) {
      process.stdout.write(JSON.stringify({ status: 'done', elapsedSeconds: Math.round((Date.now() - startTime) / 1000) }) + '\n');
      process.exit(0);
    }
    if (Date.now() - lastLog >= 60_000) {
      process.stderr.write(`Scan still running (${Math.round((Date.now() - startTime) / 1000)}s elapsed)\n`);
      lastLog = Date.now();
    }
    await sleep(intervalSeconds * 1000);
  }

  process.stdout.write(JSON.stringify({ status: 'timeout', elapsedSeconds: Math.round((Date.now() - startTime) / 1000) }) + '\n');
  process.exit(3);
})();
