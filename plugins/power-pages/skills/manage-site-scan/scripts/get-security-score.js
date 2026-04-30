#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { resolveContext, request, parseCliArgs, fail } = require('../../../scripts/lib/admin-api');

if (process.argv.includes('--help')) {
  process.stdout.write(`get-security-score.js — Fetches the security score for a site.

Usage:
  node get-security-score.js --portalId <guid> --output <file>

Flags:
  --portalId   Admin-API portal identifier (resolved during prerequisites)
  --output     Path for the response JSON
  --help       Show this help message

Exit codes:
  0  Success
  2  Sign-in required
  1  Other failure
`);
  process.exit(0);
}

const args = parseCliArgs(process.argv);
const portalId = args.portalId;
const output = args.output;

if (!portalId || !output) {
  fail('Usage: node get-security-score.js --portalId <guid> --output <file>', 1);
}

(async () => {
  const ctx = resolveContext();
  if (ctx.error) fail(ctx.error, 2);

  const res = await request({
    context: ctx,
    method: 'GET',
    path: `/websites/${portalId}/scan/deep/getSecurityScore`,
  });

  fs.mkdirSync(path.dirname(output), { recursive: true });

  if (res.statusCode === 204) {
    fs.writeFileSync(output, JSON.stringify({ status: 'empty' }, null, 2));
    process.stdout.write(JSON.stringify({ status: 'empty', output }) + '\n');
    return;
  }

  if (!res.ok) fail(`Get security score failed (${res.statusCode}): ${res.error?.message || ''}`, 1);

  fs.writeFileSync(output, JSON.stringify(res.body, null, 2));
  process.stdout.write(JSON.stringify({ status: 'ok', output }) + '\n');
})();
