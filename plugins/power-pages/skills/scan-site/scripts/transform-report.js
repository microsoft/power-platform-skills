#!/usr/bin/env node

const fs = require('fs');
const {
  resolveContext,
  request,
  parseCliArgs,
  fail,
  runCli,
} = require('../../../scripts/lib/power-platform-api');

const REQUEST_TIMEOUT_MS = 240_000; // 4 min — report fetch is slow with many alerts.

// Risk → severity per scan-reference.md "Severity mapping".
const RISK_TO_BUCKET = {
  3: 'critical',
  2: 'warning',
  1: 'warning',
  0: 'info',
};

const RULE_STATUS_BUCKET = {
  RulePassed: 'pass',
  RuleNotRun: 'warning',
  RuleTimedOut: 'warning',
  RuleFailed: 'warning', // only reachable when RuleFailed has zero alerts.
};

const RULE_STATUS_DETAILS = {
  RulePassed: 'Rule ran and produced no alerts.',
  RuleTimedOut: 'Rule started but did not finish within the time budget.',
  RuleNotRun: 'Rule did not run for this site.',
  RuleFailed: 'Rule reported a failure with no alerts attached — verify the scan report.',
};

const HELP = `transform-report.js — Transforms a deep-scan report into findings JSON.

Usage:
  node transform-report.js --portalId <portal-id>
  node transform-report.js --reportFile <path>

Flags:
  --portalId    Power Platform API portal identifier (resolved during prerequisites)
  --reportFile  Path to a previously saved raw report JSON (skips the API call)
  --help        Show this help message

Exit codes:
  0  Success (status "ok", "empty", or "malformed")
  2  Sign-in required (only --portalId)
  1  Other failure

Examples:
  node transform-report.js --portalId <portal-id>
  node transform-report.js --reportFile <report-file>
`;

// API timestamps arrive as "2026-05-14T05:35:57.0236778Z"; render as
// "2026-05-14 05:35:57 UTC". Returns "unknown" for missing values so the HTML
// never displays the literal string "undefined".
function formatTimestamp(iso) {
  if (iso == null) return 'unknown';
  const match = String(iso).match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/);
  return match ? `${match[1]} ${match[2]} UTC` : String(iso);
}

function formatNumOrDash(value) {
  return value == null ? '—' : String(value);
}

function malformedReport() {
  process.stderr.write(
    'transform-report.js: report body missing "Rules" array — emitting "malformed" status.\n'
  );
  return {
    status: 'malformed',
    findings: [
      {
        id: 'scan-site-malformed',
        severity: 'warning',
        title: 'Scan report could not be parsed',
        details:
          'The deep-scan API returned a response without the expected "Rules" array. ' +
          'Re-run the scan; if the problem persists, contact support.',
      },
    ],
    details: {},
  };
}

function failedRuleFinding(rule, alerts, id) {
  // Alerts with missing/invalid Risk are filtered before Math.max so worstRisk is
  // never NaN. Per scan-reference.md, missing risk → "warning".
  const validRisks = alerts.map((a) => a.Risk).filter((r) => RISK_TO_BUCKET[r] !== undefined);
  const worstRisk = validRisks.length > 0 ? Math.max(...validRisks) : null;
  const severity = worstRisk !== null ? RISK_TO_BUCKET[worstRisk] : 'warning';

  const description = alerts[0]?.Description || 'No description provided.';
  const alertList = alerts.map((a) => `- ${a?.AlertName || '(unnamed alert)'}`).join('\n');
  const mitigations = alerts
    .map(
      (a) =>
        `- ${a?.AlertName || '(unnamed alert)'}: ${a?.Mitigation || 'No mitigation provided.'}`
    )
    .join('\n');
  const learnMore = alerts
    .flatMap((a) => a?.LearnMoreLink || [])
    .filter((url, i, arr) => arr.indexOf(url) === i);

  const count = alerts.length;
  return {
    id,
    severity,
    title: rule.RuleName,
    tag: rule.RuleId,
    location: learnMore[0] ?? null,
    details: `${description}\n\n${count} alert${count === 1 ? '' : 's'}:\n${alertList}`,
    fix: mitigations,
  };
}

function passthroughRuleFinding(rule, id) {
  const severity = RULE_STATUS_BUCKET[rule.RuleStatus] || 'warning';
  const details =
    RULE_STATUS_DETAILS[rule.RuleStatus] ||
    `Rule reported an unrecognized status "${rule.RuleStatus}" — verify the scan report.`;
  return { id, severity, title: rule.RuleName, tag: rule.RuleId, details };
}

function transform(reportBody) {
  if (!reportBody || !Array.isArray(reportBody.Rules)) {
    return malformedReport();
  }

  const findings = [];
  let counter = 1;

  for (const rule of reportBody.Rules) {
    const alerts = Array.isArray(rule.Alerts) ? rule.Alerts : [];
    const id = `scan-site-${counter++}`;
    if (rule.RuleStatus === 'RuleFailed' && alerts.length > 0) {
      findings.push(failedRuleFinding(rule, alerts, id));
    } else {
      findings.push(passthroughRuleFinding(rule, id));
    }
  }

  const scanDetails = {
    kind: 'kv',
    label: 'Scan details',
    entries: [
      { key: 'Started', value: formatTimestamp(reportBody.StartTime) },
      { key: 'Ended', value: formatTimestamp(reportBody.EndTime) },
      { key: 'Rules evaluated', value: formatNumOrDash(reportBody.TotalRuleCount) },
      { key: 'Rules failed', value: formatNumOrDash(reportBody.FailedRuleCount) },
      { key: 'Alerts', value: formatNumOrDash(reportBody.TotalAlertCount) },
    ],
  };

  return { status: 'ok', findings, details: scanDetails };
}

function emptyReport() {
  return {
    status: 'empty',
    findings: [
      {
        id: 'scan-site-empty',
        severity: 'info',
        title: 'No completed scan report available',
        details:
          'The deep-scan service has no completed report for this site yet. ' +
          'Either no scan has been run, or a scan is currently in progress. ' +
          'Wait for the active scan to finish, or start a new scan via `/scan-site`.',
      },
    ],
    details: {},
  };
}

function readReportFile(filePath) {
  if (!fs.existsSync(filePath)) {
    process.stderr.write(`Report file not found: ${filePath}\n`);
    process.exit(1);
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    process.stderr.write(`Failed to parse ${filePath}: ${err.message}\n`);
    process.exit(1);
  }
}

async function fetchReportBody(portalId) {
  const ctx = resolveContext();
  if (ctx.error) fail(ctx.error, 2);

  const res = await request({
    context: ctx,
    method: 'GET',
    path: `/websites/${portalId}/scan/deep/getLatestCompletedReport`,
    timeout: REQUEST_TIMEOUT_MS,
  });

  if (res.statusCode === 204) return null;
  if (!res.ok) {
    fail(`Get latest report failed (${res.statusCode}): ${res.error?.message || ''}`, 1);
  }
  return res.body;
}

async function main() {
  if (process.argv.includes('--help')) {
    process.stdout.write(HELP);
    return;
  }

  const { portalId, reportFile } = parseCliArgs(process.argv);

  let reportBody;
  if (reportFile) {
    const raw = readReportFile(reportFile);
    if (raw.status === 'empty') {
      process.stdout.write(JSON.stringify(emptyReport()) + '\n');
      return;
    }
    // Accept either get-latest-report.js stdout ({ status, body }) or the bare body.
    reportBody = 'body' in raw ? raw.body : raw;
  } else if (portalId) {
    reportBody = await fetchReportBody(portalId);
    if (reportBody == null) {
      process.stdout.write(JSON.stringify(emptyReport()) + '\n');
      return;
    }
  } else {
    process.stderr.write(
      'Usage: node transform-report.js --portalId <portal-id> | --reportFile <report-file>\n'
    );
    process.exit(1);
  }

  process.stdout.write(JSON.stringify(transform(reportBody)) + '\n');
}

module.exports = { transform, emptyReport };

runCli(module, main);
