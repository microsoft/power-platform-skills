#!/usr/bin/env node

const { resolveContext, request, parseCliArgs, fail } = require('../../../scripts/lib/admin-api');

if (process.argv.includes('--help')) {
  process.stdout.write(`start-deep-scan.js — Triggers an asynchronous deep scan.

Usage:
  node start-deep-scan.js --portalId <guid> [--username <u> --password <p>]

Flags:
  --portalId   Admin-API portal identifier (resolved during prerequisites)
  --username   Test account for signed-in scanning (optional, pair with --password)
  --password   Password for the test account
  --help       Show this help message

Exit codes:
  0  Success (scan started, or one is already running)
  2  Sign-in required
  1  Other failure
`);
  process.exit(0);
}

const args = parseCliArgs(process.argv);
const portalId = args.portalId;
const body = {};
if (args.username) body.username = args.username;
if (args.password) body.password = args.password;

if (!portalId) {
  fail('Usage: node start-deep-scan.js --portalId <guid> [--username <u> --password <p>]', 1);
}

(async () => {
  const ctx = resolveContext();
  if (ctx.error) fail(ctx.error, 2);

  const res = await request({
    context: ctx,
    method: 'POST',
    path: `/websites/${portalId}/scan/deep/start`,
    body: Object.keys(body).length ? body : undefined,
  });

  if (res.statusCode === 202) {
    process.stdout.write(JSON.stringify({ status: 'started' }) + '\n');
    return;
  }
  if (res.statusCode === 204 || (res.statusCode === 400 && res.error?.code === 'Z003')) {
    process.stdout.write(JSON.stringify({ status: 'already-running' }) + '\n');
    return;
  }
  fail(`Start deep scan failed (${res.statusCode}): ${res.error?.message || ''}`, 1);
})();
