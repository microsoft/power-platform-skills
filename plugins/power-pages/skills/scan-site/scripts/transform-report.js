#!/usr/bin/env node
// Fetches (or reads) a deep-scan report and emits unified section findings.
// Strict to the documented response shape — no fallbacks for unseen variants.
// Run with --help for flags.

const fs = require('fs');
const path = require('path');

if (process.argv.includes('--help')) {
  process.stdout.write(`transform-report.js — Transforms a deep-scan report into findings JSON.

Usage:
  node transform-report.js --portalId <guid>
  node transform-report.js --reportFile <path>

Flags:
  --portalId    Power Platform API portal identifier (fetches the report)
  --reportFile  Path to a previously saved raw report JSON (skips the API call)
  --help        Show this help message

Exit codes:
  0  Success (status "ok" or "empty")
  2  Sign-in required (only --portalId)
  1  Other failure

Examples:
  node transform-report.js --portalId <portal-id>
  node transform-report.js --reportFile <report-file>
`);
  process.exit(0);
}

function getArg(name, fallback = null) {
  const idx = process.argv.indexOf('--' + name);
  return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : fallback;
}

// Cleans an API timestamp: "2026-05-14T05:35:57.0236778Z" → "2026-05-14 05:35:57 UTC".
// Drops the T separator and fractional seconds, then appends the timezone label.
// The deep-scan API returns UTC (the Z marker on EndTime confirms this); StartTime sometimes
// arrives without the Z but represents the same UTC clock — always label UTC.
function formatTimestamp(iso) {
  const match = String(iso).match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/);
  return match ? `${match[1]} ${match[2]} UTC` : iso;
}

// Risk → severity, mirroring Power Pages Studio classification (per scan-reference.md).
const RISK_TO_BUCKET = {
  3: 'critical',
  2: 'warning',
  1: 'warning',
  0: 'info',
};

const RULE_STATUS_TO_BUCKET = {
  RulePassed: 'pass',
  RuleNotRun: 'warning',
  RuleTimedOut: 'warning',
};

// Report body shape (per zap-scan1.json sample):
//   { TotalRuleCount, FailedRuleCount, TotalAlertCount, UserName, StartTime, EndTime,
//     Rules: [ { RuleId, RuleName, RuleStatus, AlertsCount, Alerts: [ { AlertId, AlertName, Description, Mitigation, Risk, RuleId, LearnMoreLink } ] } ] }
//
// One finding per rule — the report finding count matches TotalRuleCount. For RuleFailed,
// the rule's alerts are aggregated into the finding's details and fix.
function transform(reportBody) {
  const findings = [];
  let counter = 1;

  for (const rule of reportBody.Rules) {
    if (rule.RuleStatus === 'RuleFailed') {
      // Severity = worst severity across alerts. Risk 3 > 2 > 1 > 0.
      const worstRisk = Math.max(...rule.Alerts.map(a => a.Risk));
      // Within a rule, all alerts share the same Description — show it once, then list AlertNames.
      const sharedDescription = rule.Alerts[0].Description;
      const alertList = rule.Alerts.map(a => `- ${a.AlertName}`).join('\n');
      const mitigations = rule.Alerts.map(a => `- ${a.AlertName}: ${a.Mitigation}`).join('\n');
      const learnMore = rule.Alerts
        .flatMap(a => a.LearnMoreLink || [])
        .filter((url, i, arr) => arr.indexOf(url) === i);

      findings.push({
        id: `scan-site-${counter++}`,
        severity: RISK_TO_BUCKET[worstRisk],
        title: rule.RuleName,
        tag: rule.RuleId,
        location: learnMore.length > 0 ? learnMore[0] : null,
        details: `${sharedDescription}\n\n${rule.Alerts.length} alert${rule.Alerts.length === 1 ? '' : 's'}:\n${alertList}`,
        fix: mitigations,
      });
    } else {
      findings.push({
        id: `scan-site-${counter++}`,
        severity: RULE_STATUS_TO_BUCKET[rule.RuleStatus],
        title: rule.RuleName,
        tag: rule.RuleId,
        details: rule.RuleStatus === 'RulePassed'
          ? 'Rule ran and produced no alerts.'
          : (rule.RuleStatus === 'RuleTimedOut'
            ? 'Rule started but did not finish within the time budget.'
            : 'Rule did not run for this site.'),
      });
    }
  }

  const details = {
    kind: 'kv',
    label: 'Scan details',
    entries: [
      { key: 'Started', value: formatTimestamp(reportBody.StartTime) },
      { key: 'Ended', value: formatTimestamp(reportBody.EndTime) },
      { key: 'Rules evaluated', value: String(reportBody.TotalRuleCount) },
      { key: 'Rules failed', value: String(reportBody.FailedRuleCount) },
      { key: 'Alerts', value: String(reportBody.TotalAlertCount) },
    ],
  };

  return { status: 'ok', findings, details };
}

async function main() {
  const portalId = getArg('portalId');
  const reportFile = getArg('reportFile');

  let reportBody = null;

  if (reportFile) {
    if (!fs.existsSync(reportFile)) {
      process.stderr.write(`Report file not found: ${reportFile}\n`);
      process.exit(1);
    }
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    } catch (err) {
      process.stderr.write(`Failed to parse ${reportFile}: ${err.message}\n`);
      process.exit(1);
    }
    if (raw.status === 'empty') {
      process.stdout.write(JSON.stringify({ status: 'empty', findings: [], details: {} }) + '\n');
      return;
    }
    // Accept either get-latest-report.js stdout ({ status, body }) or the bare body.
    reportBody = 'body' in raw ? raw.body : raw;
  } else if (portalId) {
    const { resolveContext, request, fail } = require(path.join(__dirname, '..', '..', '..', 'scripts', 'lib', 'power-platform-api'));
    const ctx = resolveContext();
    if (ctx.error) fail(ctx.error, 2);

    const res = await request({
      context: ctx,
      method: 'GET',
      path: `/websites/${portalId}/scan/deep/getLatestCompletedReport`,
      timeout: 240_000,
    });

    if (res.statusCode === 204) {
      process.stdout.write(JSON.stringify({ status: 'empty', findings: [], details: {} }) + '\n');
      return;
    }
    if (!res.ok) {
      process.stderr.write(`Get latest report failed (${res.statusCode}): ${res.error?.message || ''}\n`);
      process.exit(1);
    }
    reportBody = res.body;
  } else {
    process.stderr.write('Usage: node transform-report.js --portalId <portal-id> | --reportFile <report-file>\n');
    process.exit(1);
  }

  process.stdout.write(JSON.stringify(transform(reportBody)) + '\n');
}

module.exports = { transform };

if (require.main === module) {
  main().catch(err => {
    process.stderr.write(`transform-report.js failed: ${err.message}\n`);
    process.exit(1);
  });
}
