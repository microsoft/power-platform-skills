#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { resolveContext, request, parseCliArgs, fail } = require('../../../scripts/lib/admin-api');

if (process.argv.includes('--help')) {
  process.stdout.write(`run-quick-scan.js — Runs a quick scan and writes the response to a file.

Usage:
  node run-quick-scan.js --portalId <guid> --output <file> [--lcid <code>]

Flags:
  --portalId   Admin-API portal identifier (resolved during prerequisites)
  --output     Path for the raw response JSON
  --lcid       Locale code for findings text (default: 1033)
  --help       Show this help message

Exit codes:
  0  Success (file written)
  2  Sign-in required
  1  Other failure
`);
  process.exit(0);
}

const args = parseCliArgs(process.argv);
const portalId = args.portalId;
const output = args.output;
const lcid = args.lcid || '1033';

if (!portalId || !output) {
  fail('Usage: node run-quick-scan.js --portalId <guid> --output <file> [--lcid <code>]', 1);
}

(async () => {
  const ctx = resolveContext();
  if (ctx.error) fail(ctx.error, 2);

  const res = await request({
    context: ctx,
    method: 'POST',
    path: `/websites/${portalId}/scan/quick/execute`,
    query: { lcid },
  });

  if (!res.ok) fail(`Quick scan failed (${res.statusCode}): ${res.error?.message || ''}`, 1);

  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(res.body, null, 2));
  process.stdout.write(JSON.stringify({ status: 'ok', output }) + '\n');
})();
