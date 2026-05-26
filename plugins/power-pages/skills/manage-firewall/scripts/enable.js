#!/usr/bin/env node

const {
  resolveContext,
  request,
  pollUntil,
  parseCliArgs,
  parseTimeoutMs,
  fail,
  hasErrorCode,
  runCli,
} = require('../../../scripts/lib/power-platform-api');

const DEFAULT_TIMEOUT_MIN = 15;
const POLL_INTERVAL_MS = 30_000;

const HELP = `enable.js — Turns on the web application firewall for a site.

Usage:
  node enable.js --portalId <portal-id> [--timeoutMinutes <n>]

Flags:
  --portalId         Power Platform API portal identifier (resolved during prerequisites)
  --timeoutMinutes   Maximum wait time (default: ${DEFAULT_TIMEOUT_MIN})
  --help             Show this help message

Exit codes:
  0  Enabled
  2  Sign-in required
  3  Polling timed out
  4  Unsupported (trial site or region restriction)
  1  Other failure

Example:
  node enable.js --portalId <portal-id>
  node enable.js --portalId <portal-id> --timeoutMinutes <minutes>
`;

async function main() {
  if (process.argv.includes('--help')) {
    process.stdout.write(HELP);
    return;
  }

  const args = parseCliArgs(process.argv);
  const { portalId } = args;
  if (!portalId) {
    fail('Usage: node enable.js --portalId <portal-id> [--timeoutMinutes <n>]', 1);
  }
  const timeoutMs = parseTimeoutMs(args.timeoutMinutes, DEFAULT_TIMEOUT_MIN);

  const ctx = resolveContext();
  if (ctx.error) fail(ctx.error, 2);

  const start = await request({
    context: ctx,
    method: 'POST',
    path: `/websites/${portalId}/enableWaf`,
  });
  if (hasErrorCode(start, 'B022', 'B023')) {
    fail(`Firewall not available for this site: ${start.error?.message || ''}`, 4);
  }
  if (hasErrorCode(start, 'B003')) {
    // 409/B003 = a sibling enable/disable is mid-flight; observing its outcome is idempotent.
    process.stderr.write('A firewall change is already in progress; will wait for it to settle.\n');
  } else if (start.statusCode !== 202) {
    fail(`Enable firewall failed (${start.statusCode}): ${start.error?.message || ''}`, 1);
  }

  const poll = await pollUntil({
    fetchStatus: async () => {
      const r = await request({
        context: ctx,
        method: 'GET',
        path: `/websites/${portalId}/getWafStatus`,
      });
      if (!r.ok) return { ok: false, error: r.error?.message || `${r.statusCode}` };
      const raw = typeof r.body === 'string' ? r.body : r.body?.status;
      const status = String(raw || '').toLowerCase();
      // Two terminal states: "created" (success) and "failed" (permanent error).
      // Anything else is intermediate; keep polling.
      if (status === 'failed') {
        return { ok: false, error: 'enable operation reached the "Failed" terminal state' };
      }
      return { ok: true, body: status };
    },
    isDone: (status) => status === 'created',
    timeoutMs,
    intervalMs: POLL_INTERVAL_MS,
  });

  if (!poll.ok && poll.error === 'timeout') {
    fail('Enable did not complete before timeout.', 3);
  }
  if (!poll.ok) fail(`Polling failed: ${poll.error}`, 1);

  process.stdout.write(
    JSON.stringify({ status: 'enabled', attempts: poll.attempts }) + '\n'
  );
}

runCli(module, main);
