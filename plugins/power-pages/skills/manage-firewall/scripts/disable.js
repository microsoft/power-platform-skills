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

const HELP = `disable.js — Turns off the web application firewall for a site.

Usage:
  node disable.js --portalId <portal-id> [--timeoutMinutes <n>]

Flags:
  --portalId         Power Platform API portal identifier (resolved during prerequisites)
  --timeoutMinutes   Maximum wait time (default: ${DEFAULT_TIMEOUT_MIN})
  --help             Show this help message

Exit codes:
  0  Disabled
  2  Sign-in required
  3  Polling timed out
  4  Unsupported (trial site or region restriction)
  1  Other failure

Example:
  node disable.js --portalId <portal-id>
  node disable.js --portalId <portal-id> --timeoutMinutes <minutes>
`;

async function main() {
  if (process.argv.includes('--help')) {
    process.stdout.write(HELP);
    return;
  }

  const args = parseCliArgs(process.argv);
  const { portalId } = args;
  if (!portalId) {
    fail('Usage: node disable.js --portalId <portal-id> [--timeoutMinutes <n>]', 1);
  }
  const timeoutMs = parseTimeoutMs(args.timeoutMinutes, DEFAULT_TIMEOUT_MIN);

  const ctx = resolveContext();
  if (ctx.error) fail(ctx.error, 2);

  const start = await request({
    context: ctx,
    method: 'POST',
    path: `/websites/${portalId}/disableWaf`,
  });
  if (hasErrorCode(start, 'B022', 'B023')) {
    fail(`Firewall not available for this site: ${start.error?.message || ''}`, 4);
  }
  if (hasErrorCode(start, 'B003')) {
    process.stderr.write('A firewall change is already in progress; will wait for it to settle.\n');
  } else if (start.statusCode !== 202) {
    fail(`Disable firewall failed (${start.statusCode}): ${start.error?.message || ''}`, 1);
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
      if (status === 'failed') {
        return { ok: false, error: 'disable operation reached the "Failed" terminal state' };
      }
      return { ok: true, body: status };
    },
    isDone: (status) => status === 'disabled',
    timeoutMs,
    intervalMs: POLL_INTERVAL_MS,
  });

  if (!poll.ok && poll.error === 'timeout') {
    fail('Disable did not complete before timeout.', 3);
  }
  if (!poll.ok) fail(`Polling failed: ${poll.error}`, 1);

  process.stdout.write(
    JSON.stringify({ status: 'disabled', attempts: poll.attempts }) + '\n'
  );
}

runCli(module, main);
