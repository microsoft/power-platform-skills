#!/usr/bin/env node

const { resolveContext, request, parseCliArgs, fail } = require('../../../scripts/lib/power-platform-api');

if (process.argv.includes('--help')) {
  process.stdout.write(`set-rules.js — Creates or updates specific firewall rules.
Only include the rules being added or modified; existing rules not in the payload are preserved.

Usage:
  node set-rules.js --portalId <portal-id> --data-inline '<json>'

Flags:
  --portalId      Power Platform API portal identifier (resolved during prerequisites)
  --data-inline   JSON string with the CustomRules and/or ManagedRules to create or update
  --help          Show this help message

Exit codes:
  0  Success
  2  Sign-in required
  4  Unsupported (trial site or region restriction)
  1  Other failure

Example:
  node set-rules.js --portalId <portal-id> --data-inline '<json-payload>'
`);
  process.exit(0);
}

const args = parseCliArgs(process.argv);
const portalId = args.portalId;
const dataInline = args['data-inline'] || args.dataInline;

if (!portalId || !dataInline) {
  fail('Usage: node set-rules.js --portalId <portal-id> --data-inline \'<json-payload>\'', 1);
}

let payload;
try {
  payload = JSON.parse(dataInline);
} catch (err) {
  fail(`Failed to parse JSON: ${err.message}`, 1);
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
    timeout: 240_000, // 4 min — rule creation can take longer than the default 15s
  });

  if (res.statusCode === 400 && (res.error?.code === 'B022' || res.error?.code === 'B023')) {
    fail(`Firewall not available: ${res.error?.message || ''}`, 4);
  }
  if (!res.ok) fail(`Set firewall rules failed (${res.statusCode}): ${res.error?.message || ''}`, 1);

  process.stdout.write(JSON.stringify({ status: 'ok', body: res.body }) + '\n');
})();
