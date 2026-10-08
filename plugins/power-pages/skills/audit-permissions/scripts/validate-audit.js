#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { approve, runValidation } = require('../../../scripts/lib/validation-helpers');

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

function scriptText(html) {
  return [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1]).join('\n');
}

// Rendered JSON stays on one line, so a line-start match can't come from inside a value.
function readConst(script, name) {
  const matches = [...script.matchAll(new RegExp(`^const ${name} = (.*)$`, 'gm'))];
  if (matches.length === 0) throw new Error(`Audit report has no ${name} data.`);
  if (matches.length > 1) throw new Error(`Audit report declares ${name} more than once.`);
  const json = matches[0][1].trim().replace(/;$/, '');
  try {
    return JSON.parse(json);
  } catch {
    throw new Error(`Audit report ${name} data is not valid JSON.`);
  }
}

function validateSummary(html, scorecard, majorCount) {
  const match = html.match(/id="summaryBox"[^>]*>([\s\S]*?)<\/div>/);
  if (!match) throw new Error('Audit report has no SUMMARY.');
  const states = (phrase) => match[1].toLowerCase().includes(phrase.toLowerCase());
  if (scorecard === null) {
    if (states('Safe to go') || states('Needs revision')) {
      throw new Error('SUMMARY must not state a verdict when scoring was skipped.');
    }
    return null;
  }
  const [expected, opposite] = majorCount === 0 ? ['Safe to go', 'Needs revision'] : ['Needs revision', 'Safe to go'];
  if (!states(expected) || states(opposite)) {
    throw new Error(`SUMMARY must state the verdict "${expected}" and not "${opposite}".`);
  }
  return expected;
}

function validateReport(reportPath) {
  const html = fs.readFileSync(reportPath, 'utf8');
  if (/__(?:(?:HTML|ATTR|JSON|RAW)_)?(?:SITE_NAME|AUDIT_DESC|SUMMARY|FINDINGS_DATA|INVENTORY_DATA|SCORECARD_DATA)__/.test(html)) {
    throw new Error('Audit report has unreplaced data placeholders.');
  }
  const script = scriptText(html);
  const findings = readConst(script, 'FINDINGS');
  validateFindings(findings);
  if (!Array.isArray(readConst(script, 'INVENTORY'))) throw new Error('INVENTORY must be an array.');
  const scorecard = readConst(script, 'SCORECARD');
  validateScorecard(scorecard, findings);
  const issueCounts = countIssues(findings);
  return { issueCounts, verdict: validateSummary(html, scorecard, issueCounts.major) };
}

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
  runValidation(() => approve());
}
