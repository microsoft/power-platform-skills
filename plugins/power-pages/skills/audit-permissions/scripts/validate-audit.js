#!/usr/bin/env node

const path = require('path');
const { approve, runValidation } = require('../../../scripts/lib/validation-helpers');
const { validateReport } = require('../../../scripts/lib/audit-report-validation');
const { completeRun } = require('../../../scripts/emit-audit-permissions-telemetry');

function fail(error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Audit validation failed: ${message}\n`);
  process.exit(1);
}

const reportFlagIndex = process.argv.indexOf('--report');
const positionalReport = process.argv.slice(2).find((argument) => !argument.startsWith('-'));
if (reportFlagIndex >= 0 && (!process.argv[reportFlagIndex + 1] || process.argv[reportFlagIndex + 1].startsWith('-'))) {
  fail(new Error('Usage: validate-audit.js --report <path>'));
}
const explicitReport = reportFlagIndex >= 0 ? process.argv[reportFlagIndex + 1] : positionalReport;
const runFlagIndex = process.argv.indexOf('--auditRunId');
const dataFlagIndex = process.argv.indexOf('--data');
const auditRunId = runFlagIndex >= 0 ? process.argv[runFlagIndex + 1] : null;
const dataPath = dataFlagIndex >= 0 ? process.argv[dataFlagIndex + 1] : null;

if (explicitReport) {
  try {
    const reportPath = path.resolve(explicitReport);
    const summary = validateReport(reportPath);
    let telemetryStatus = 'not_requested';
    if (auditRunId && dataPath) {
      try {
        // completeRun downgrades to a metrics_validation failure when the source
        // data cannot be reconciled with the report, so report what was recorded.
        const completion = completeRun({
          runId: auditRunId,
          outcome: 'success',
          data: path.resolve(dataPath),
          report: reportPath,
        });
        telemetryStatus = completion.disabled
          ? 'disabled'
          : completion.outcome === 'success' ? 'recorded_success' : 'recorded_failure';
      } catch {
        // A validated report remains successful even if optional telemetry fails.
        telemetryStatus = 'failed';
      }
    }
    process.stdout.write(`${JSON.stringify({
      valid: true,
      reportPath,
      issueCounts: summary.issueCounts,
      verdict: summary.verdict,
      telemetryStatus,
    })}\n`);
  } catch (error) {
    fail(error);
  }
} else {
  // The PostToolUse(Skill) hook fires before the audit writes its report, so it can only see a previous run; Step 7.4 validates the new report.
  runValidation(() => approve());
}
