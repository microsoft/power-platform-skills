#!/usr/bin/env node

const {
  resolveContext,
  request,
  parseCliArgs,
  parseTimeoutMs,
  fail,
  runCli,
} = require('../../../scripts/lib/power-platform-api');

const DEFAULT_TIMEOUT_MIN = 20;
const DEFAULT_INTERVAL_SEC = 60;
const PROGRESS_LOG_MS = 60_000;

const HELP = `poll-deep-scan.js — Polls the deep-scan status endpoint until completion or timeout.

Usage:
  node poll-deep-scan.js --portalId <portal-id> [--timeoutMinutes <n>] [--intervalSeconds <n>]
  node poll-deep-scan.js --portalId <portal-id> --once

Flags:
  --portalId          Power Platform API portal identifier (resolved during prerequisites)
  --timeoutMinutes    Maximum wait time (default: ${DEFAULT_TIMEOUT_MIN})
  --intervalSeconds   Pause between status checks (default: ${DEFAULT_INTERVAL_SEC})
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
`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// API may return status as boolean, "true"/"false" string, or 0/1 number.
function isOngoing(body) {
  return body?.status === true || body?.status === 'true' || body?.status === 1;
}

function parsePositiveSeconds(value, defaultSec, flagName) {
  const seconds = value === undefined ? defaultSec : Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    fail(`Invalid --${flagName} value "${value}". Must be a positive number.`, 1);
  }
  return seconds * 1000;
}

async function fetchOngoing(ctx, portalId) {
  const res = await request({
    context: ctx,
    method: 'GET',
    path: `/websites/${portalId}/scan/deep/isongoing`,
  });
  if (!res.ok) {
    fail(`Status check failed (${res.statusCode}): ${res.error?.message || ''}`, 1);
  }
  return isOngoing(res.body);
}

async function main() {
  if (process.argv.includes('--help')) {
    process.stdout.write(HELP);
    return;
  }

  const args = parseCliArgs(process.argv);
  const { portalId, once } = args;
  if (!portalId) {
    fail(
      'Usage: node poll-deep-scan.js --portalId <portal-id> ' +
        '[--timeoutMinutes <n>] [--intervalSeconds <n>] [--once]',
      1
    );
  }

  const ctx = resolveContext();
  if (ctx.error) fail(ctx.error, 2);

  if (once) {
    const ongoing = await fetchOngoing(ctx, portalId);
    process.stdout.write(JSON.stringify({ status: ongoing ? 'ongoing' : 'idle' }) + '\n');
    return;
  }

  const timeoutMs = parseTimeoutMs(args.timeoutMinutes, DEFAULT_TIMEOUT_MIN);
  const intervalMs = parsePositiveSeconds(
    args.intervalSeconds,
    DEFAULT_INTERVAL_SEC,
    'intervalSeconds'
  );
  const startTime = Date.now();
  const deadline = startTime + timeoutMs;
  let lastLog = 0;

  while (Date.now() < deadline) {
    if (!(await fetchOngoing(ctx, portalId))) {
      process.stdout.write(
        JSON.stringify({
          status: 'done',
          elapsedSeconds: Math.round((Date.now() - startTime) / 1000),
        }) + '\n'
      );
      return;
    }
    if (Date.now() - lastLog >= PROGRESS_LOG_MS) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      process.stderr.write(`Scan still running (${elapsed}s elapsed)\n`);
      lastLog = Date.now();
    }
    await sleep(intervalMs);
  }

  process.stdout.write(
    JSON.stringify({
      status: 'timeout',
      elapsedSeconds: Math.round((Date.now() - startTime) / 1000),
    }) + '\n'
  );
  process.exit(3);
}

runCli(module, main);
