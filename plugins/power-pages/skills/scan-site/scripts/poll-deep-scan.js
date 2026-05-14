#!/usr/bin/env node

const { resolveContext, request, parseCliArgs, fail } = require('../../../scripts/lib/power-platform-api');

if (process.argv.includes('--help')) {
  process.stdout.write(`poll-deep-scan.js — Polls the deep-scan status endpoint until completion or timeout.

Usage:
  node poll-deep-scan.js --portalId <guid> [--timeoutMinutes <n>] [--intervalSeconds <n>]
  node poll-deep-scan.js --portalId <guid> --once

Flags:
  --portalId          Power Platform API portal identifier (resolved during prerequisites)
  --timeoutMinutes    Maximum wait time (default: 20)
  --intervalSeconds   Pause between status checks (default: 60)
  --once              Single status check, no polling. Returns { "status": "ongoing" | "idle" } and exits 0.
  --help              Show this help message

Exit codes:
  0  Scan completed (or single check returned current state when --once)
  3  Polling timed out
  2  Sign-in required
  1  Other failure

Example:
  node poll-deep-scan.js --portalId <portal-id>
  node poll-deep-scan.js --portalId <portal-id> --once
  node poll-deep-scan.js --portalId <portal-id> --timeoutMinutes <minutes>
`);
  process.exit(0);
}

const args = parseCliArgs(process.argv);
const portalId = args.portalId;
const once = process.argv.includes('--once');
// 20 min default — sufficient for small sites; large sites may need a higher value.
const timeoutMinutes = parseInt(args.timeoutMinutes || '20', 10);
// 60s default — balances API load vs responsiveness.
const intervalSeconds = parseInt(args.intervalSeconds || '60', 10);

if (!portalId) {
  fail('Usage: node poll-deep-scan.js --portalId <guid> [--timeoutMinutes <n>] [--intervalSeconds <n>] [--once]', 1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isOngoing = (body) => body?.status === true || body?.status === 'true' || body?.status === 1;

(async () => {
  const ctx = resolveContext();
  if (ctx.error) fail(ctx.error, 2);

  // Single-shot mode: query once, return current state, exit 0.
  if (once) {
    const res = await request({
      context: ctx,
      method: 'GET',
      path: `/websites/${portalId}/scan/deep/isongoing`,
    });
    if (!res.ok) fail(`Status check failed (${res.statusCode}): ${res.error?.message || ''}`, 1);
    process.stdout.write(JSON.stringify({ status: isOngoing(res.body) ? 'ongoing' : 'idle' }) + '\n');
    process.exit(0);
  }

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

    if (!isOngoing(res.body)) {
      process.stdout.write(JSON.stringify({ status: 'done', elapsedSeconds: Math.round((Date.now() - startTime) / 1000) }) + '\n');
      process.exit(0);
    }
    // Throttle progress logs to once per minute to keep stderr readable.
    if (Date.now() - lastLog >= 60_000) {
      process.stderr.write(`Scan still running (${Math.round((Date.now() - startTime) / 1000)}s elapsed)\n`);
      lastLog = Date.now();
    }
    await sleep(intervalSeconds * 1000);
  }

  process.stdout.write(JSON.stringify({ status: 'timeout', elapsedSeconds: Math.round((Date.now() - startTime) / 1000) }) + '\n');
  process.exit(3);
})();
