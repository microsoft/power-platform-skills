#!/usr/bin/env node

const fs = require('fs');
const { resolveContext, request, parseCliArgs, fail } = require('../../../scripts/lib/admin-api');

if (process.argv.includes('--help')) {
  process.stdout.write(`set-rules.js — Creates or updates firewall rules from a JSON file.

Usage:
  node set-rules.js --portalId <guid> --rules <json-file>

Flags:
  --portalId   Admin-API portal identifier (resolved during prerequisites)
  --rules      Path to a JSON file with CustomRules and/or ManagedRules
  --help       Show this help message

Exit codes:
  0  Success
  2  Sign-in required
  4  Unsupported (trial site or region restriction)
  1  Other failure
`);
  process.exit(0);
}

const args = parseCliArgs(process.argv);
const portalId = args.portalId;
const rulesFile = args.rules;

if (!portalId || !rulesFile) {
  fail('Usage: node set-rules.js --portalId <guid> --rules <json-file>', 1);
}

let payload;
try {
  payload = JSON.parse(fs.readFileSync(rulesFile, 'utf8'));
} catch (err) {
  fail(`Failed to read rules file: ${err.message}`, 1);
}

const RULE_NAME_RE = /^[a-zA-Z][a-zA-Z0-9]*$/;
if (Array.isArray(payload.CustomRules)) {
  for (const rule of payload.CustomRules) {
    if (rule.name && !RULE_NAME_RE.test(rule.name)) {
      fail(`Invalid rule name "${rule.name}": must start with a letter and contain only letters and numbers.`, 1);
    }
  }
}

(async () => {
  const ctx = resolveContext();
  if (ctx.error) fail(ctx.error, 2);

  const res = await request({
    context: ctx,
    method: 'PUT',
    path: `/websites/${portalId}/createWafRules`,
    body: payload,
  });

  if (res.statusCode === 400 && (res.error?.code === 'B022' || res.error?.code === 'B023')) {
    fail(`Firewall not available: ${res.error?.message || ''}`, 4);
  }
  if (!res.ok) fail(`Set firewall rules failed (${res.statusCode}): ${res.error?.message || ''}`, 1);

  process.stdout.write(JSON.stringify({ status: 'ok', body: res.body }, null, 2) + '\n');
})();
