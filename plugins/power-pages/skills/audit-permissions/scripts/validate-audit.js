#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const PREFIXES = {
  'intent-coverage': 'IC',
  'privilege-calibration': 'PC',
  'scope-correctness': 'SC',
  'role-completeness': 'RC',
  'table-coverage': 'TC',
  'anonymous-access-hygiene': 'AH',
  'data-model-alignment': 'DM',
  'internal-consistency': 'IS',
  'security-posture': 'SP',
};
const CATEGORIES = [
  {
    id: 'over-exposure',
    name: /^Over-Exposure/i,
    dimensions: ['privilege-calibration', 'anonymous-access-hygiene', 'security-posture'],
  },
  {
    id: 'under-exposure',
    name: /^Under-Exposure/i,
    dimensions: ['intent-coverage', 'table-coverage', 'role-completeness'],
  },
  {
    id: 'correctness',
    name: /^Correctness/i,
    dimensions: ['scope-correctness', 'data-model-alignment', 'internal-consistency'],
  },
];
const ROOT_CAUSES = ['permissions', 'mixed', 'data-model', 'webapi-code', 'webapi-settings'];

function round(value) {
  return Math.round(value * 100) / 100;
}

function scoreFromIssues(major, minor) {
  return round(5 - 4 * Math.tanh(0.2 * (major + 0.25 * minor)));
}

function countIssues(issues) {
  const major = issues.filter((issue) => issue.severity === 'major').length;
  const minor = issues.filter((issue) => issue.severity === 'minor').length;
  return { major, minor, total: major + minor };
}

function requireText(record, fields, label) {
  for (const field of fields) {
    if (typeof record[field] !== 'string' || !record[field].trim()) {
      throw new Error(`${label} needs a non-empty ${field}.`);
    }
  }
}

function validateFindings(findings) {
  if (!Array.isArray(findings)) throw new Error('FINDINGS must be an array.');
  const ids = new Set();
  for (const finding of findings) {
    const prefix = PREFIXES[finding.dimension];
    if (!prefix) throw new Error(`Finding ${finding.id} has invalid dimension ${finding.dimension}.`);
    if (!new RegExp(`^${prefix}[1-9][0-9]*$`).test(finding.id)) {
      throw new Error(`Finding ${finding.id} must use the ${prefix} prefix for ${finding.dimension}.`);
    }
    if (ids.has(finding.id)) throw new Error(`Finding ${finding.id} is listed more than once.`);
    ids.add(finding.id);
    if (!['major', 'minor'].includes(finding.severity)) {
      throw new Error(`Finding ${finding.id} has invalid severity ${finding.severity}.`);
    }
    requireText(finding, ['title', 'reasoning', 'fix'], `Finding ${finding.id}`);
    if (finding.severity === 'major') {
      if (!ROOT_CAUSES.includes(finding.rootCause)) {
        throw new Error(`Major finding ${finding.id} has invalid rootCause ${finding.rootCause}.`);
      }
      requireText(finding, ['rootCauseReason'], `Major finding ${finding.id}`);
    } else if (finding.rootCause !== undefined || finding.rootCauseReason !== undefined) {
      throw new Error(`Minor finding ${finding.id} must not carry a root cause.`);
    }
  }
}

function validateScorecard(scorecard, findings) {
  if (scorecard === null) return;
  const categories = scorecard?.categories;
  if (!Array.isArray(categories) || categories.length !== CATEGORIES.length) {
    throw new Error(`SCORECARD.categories must contain exactly ${CATEGORIES.length} entries.`);
  }
  CATEGORIES.forEach((category, index) => {
    const entry = categories[index];
    if (!category.name.test(String(entry?.name || ''))) {
      throw new Error(`SCORECARD.categories[${index}] must be ${category.id}, found ${entry?.name}.`);
    }
    const counts = countIssues(findings.filter((finding) => category.dimensions.includes(finding.dimension)));
    const expected = scoreFromIssues(counts.major, counts.minor);
    if (entry.score !== expected) {
      throw new Error(`${entry.name} score is ${entry.score}; expected ${expected}.`);
    }
  });
}

function readConst(html, name) {
  const marker = `const ${name} = `;
  const start = html.indexOf(marker);
  if (start < 0) throw new Error(`Audit report has no ${name} data.`);
  const end = html.indexOf('\n', start);
  const json = html.slice(start + marker.length, end < 0 ? undefined : end).trim().replace(/;$/, '');
  try {
    return JSON.parse(json);
  } catch {
    throw new Error(`Audit report ${name} data is not valid JSON.`);
  }
}

function validateReport(reportPath) {
  const html = fs.readFileSync(reportPath, 'utf8');
  if (/__(?:(?:HTML|ATTR|JSON|RAW)_)?(?:SITE_NAME|AUDIT_DESC|SUMMARY|FINDINGS_DATA|INVENTORY_DATA|SCORECARD_DATA)__/.test(html)) {
    throw new Error('Audit report has unreplaced data placeholders.');
  }
  const findings = readConst(html, 'FINDINGS');
  validateFindings(findings);
  validateScorecard(readConst(html, 'SCORECARD'), findings);
  const issueCounts = countIssues(findings);
  return { issueCounts, verdict: issueCounts.major === 0 ? 'Safe to go' : 'Needs revision' };
}

function fail(error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Audit validation failed: ${message}\n`);
  process.exit(1);
}

const reportFlagIndex = process.argv.indexOf('--report');
const positionalReport = process.argv.slice(2).find((argument) => !argument.startsWith('-'));
const explicitReport = reportFlagIndex >= 0 ? process.argv[reportFlagIndex + 1] : positionalReport;

if (explicitReport) {
  try {
    const reportPath = path.resolve(explicitReport);
    const summary = validateReport(reportPath);
    process.stdout.write(`${JSON.stringify({ valid: true, reportPath, ...summary })}\n`);
  } catch (error) {
    fail(error);
  }
} else {
  // The PostToolUse(Skill) hook fires before the audit writes its report, so it can only see a previous run; Step 7.4 validates the new report.
  process.stdin.resume();
  process.stdin.on('end', () => process.exit(0));
}
