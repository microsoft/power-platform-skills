#!/usr/bin/env node

const { resolveContext, request, pollUntil, parseCliArgs, fail } = require('../../../scripts/lib/power-platform-api');

if (process.argv.includes('--help')) {
  process.stdout.write(`enable.js — Turns on the web application firewall for a site.

Usage:
  node enable.js --portalId <guid> [--timeoutMinutes <n>]

Flags:
  --portalId         Power Platform API portal identifier (resolved during prerequisites)
  --timeoutMinutes   Maximum wait time (default: 15)
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
`);
  process.exit(0);
}

const args = parseCliArgs(process.argv);
const portalId = args.portalId;
// 15 min default — WAF enable typically completes in 5-10 min; 15 allows headroom
const timeoutMs = (parseInt(args.timeoutMinutes || '15', 10)) * 60 * 1000;

if (!portalId) {
  fail('Usage: node enable.js --portalId <guid> [--timeoutMinutes <n>]', 1);
}

(async () => {
  const ctx = resolveContext();
  if (ctx.error) fail(ctx.error, 2);

  const start = await request({ context: ctx, method: 'POST', path: `/websites/${portalId}/enableWaf` });
  if (start.statusCode === 400 && (start.error?.code === 'B022' || start.error?.code === 'B023')) {
    fail(`Firewall not available for this site: ${start.error?.message || ''}`, 4);
  }
  if (start.statusCode === 409 && start.error?.code === 'B003') {
    process.stderr.write('A firewall change is already in progress; will wait for it to settle.\n');
  } else if (start.statusCode !== 202) {
    fail(`Enable firewall failed (${start.statusCode}): ${start.error?.message || ''}`, 1);
  }

  const poll = await pollUntil({
    fetchStatus: async () => {
      const r = await request({ context: ctx, method: 'GET', path: `/websites/${portalId}/getWafStatus` });
      if (!r.ok) return { ok: false, error: r.error?.message || `${r.statusCode}` };
      const value = typeof r.body === 'string' ? r.body : (r.body?.status ?? r.body);
      return { ok: true, body: String(value || '').toLowerCase() };
    },
    isDone: (status) => status.includes('enabled') && !status.includes('disabling'),
    timeoutMs,
    intervalMs: 30_000, // 30s between polls — balances API load vs responsiveness
  });

  if (!poll.ok && poll.error === 'timeout') fail('Enable did not complete before timeout.', 3);
  if (!poll.ok) fail(`Polling failed: ${poll.error}`, 1);
  process.stdout.write(JSON.stringify({ status: 'enabled', attempts: poll.attempts }) + '\n');
})();
