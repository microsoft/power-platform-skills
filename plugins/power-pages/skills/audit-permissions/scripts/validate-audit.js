#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const DIMENSIONS = [
  'intent-coverage',
  'privilege-calibration',
  'scope-correctness',
  'role-completeness',
  'table-coverage',
  'anonymous-access-hygiene',
  'data-model-alignment',
  'internal-consistency',
  'security-posture',
];
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
    dimensions: ['privilege-calibration', 'anonymous-access-hygiene', 'security-posture'],
  },
  {
    id: 'under-exposure',
    dimensions: ['intent-coverage', 'table-coverage', 'role-completeness'],
  },
  {
    id: 'correctness',
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

function assertCounts(actual, expected, label) {
  for (const key of ['major', 'minor', 'total']) {
    if (actual?.[key] !== expected[key]) {
      throw new Error(`${label}.${key} is ${actual?.[key]}; expected ${expected[key]}.`);
    }
  }
}

function requireText(record, fields, label) {
  for (const field of fields) {
    if (typeof record[field] !== 'string' || !record[field].trim()) {
      throw new Error(`${label} needs a non-empty ${field}.`);
    }
  }
}

function validateResult(result) {
  if (!result || typeof result !== 'object') throw new Error('Result must be a JSON object.');
  if (!Array.isArray(result.dimensionResults) || result.dimensionResults.length !== DIMENSIONS.length) {
    throw new Error(`dimensionResults must contain exactly ${DIMENSIONS.length} entries.`);
  }
  if (!Array.isArray(result.categoryResults) || result.categoryResults.length !== CATEGORIES.length) {
    throw new Error(`categoryResults must contain exactly ${CATEGORIES.length} entries.`);
  }

  const issueIds = new Set();
  const issues = [];
  result.dimensionResults.forEach((dimensionResult, index) => {
    const expectedDimension = DIMENSIONS[index];
    if (dimensionResult.dimension !== expectedDimension) {
      throw new Error(`dimensionResults[${index}] must be ${expectedDimension}, found ${dimensionResult.dimension}.`);
    }
    if (!Array.isArray(dimensionResult.issues)) {
      throw new Error(`${expectedDimension}.issues must be an array.`);
    }
    for (const issue of dimensionResult.issues) {
      if (issue.dimension !== expectedDimension) {
        throw new Error(`Issue ${issue.id} is nested under ${expectedDimension} but declares ${issue.dimension}.`);
      }
      if (!['major', 'minor'].includes(issue.severity)) {
        throw new Error(`Issue ${issue.id} has invalid severity ${issue.severity}.`);
      }
      if (!new RegExp(`^${PREFIXES[expectedDimension]}[1-9][0-9]*$`).test(issue.id)) {
        throw new Error(`Issue ${issue.id} must use the ${PREFIXES[expectedDimension]} prefix.`);
      }
      if (issueIds.has(issue.id)) throw new Error(`Duplicate issue id ${issue.id}.`);
      if (!Array.isArray(issue.mergedFrom) || issue.mergedFrom.length === 0) {
        throw new Error(`Issue ${issue.id} must include non-empty mergedFrom.`);
      }
      requireText(issue, ['description', 'suggestion'], `Issue ${issue.id}`);
      issueIds.add(issue.id);
      issues.push(issue);
    }
  });

  const expectedTotalCounts = countIssues(issues);
  assertCounts(result.issueCounts, expectedTotalCounts, 'issueCounts');
  const expectedVerdict = expectedTotalCounts.major === 0 ? 'Safe to go' : 'Needs revision';
  if (result.verdict !== expectedVerdict) {
    throw new Error(`verdict is ${result.verdict}; expected ${expectedVerdict}.`);
  }

  CATEGORIES.forEach((category, index) => {
    const categoryResult = result.categoryResults[index];
    if (categoryResult.category !== category.id) {
      throw new Error(`categoryResults[${index}] must be ${category.id}, found ${categoryResult.category}.`);
    }
    const categoryIssues = issues.filter((issue) => category.dimensions.includes(issue.dimension));
    const expectedCounts = countIssues(categoryIssues);
    assertCounts(categoryResult.issueCounts, expectedCounts, `${category.id}.issueCounts`);
    const expectedScore = scoreFromIssues(expectedCounts.major, expectedCounts.minor);
    if (categoryResult.score !== expectedScore) {
      throw new Error(`${category.id}.score is ${categoryResult.score}; expected ${expectedScore}.`);
    }
  });

  const majorIssues = issues.filter((issue) => issue.severity === 'major');
  const propagations = result.crossTrackPropagations;
  if (!Array.isArray(propagations)) throw new Error('crossTrackPropagations must be an array.');
  const propagatedIds = propagations.map((entry) => entry.issueId);
  if (new Set(propagatedIds).size !== propagatedIds.length) {
    throw new Error('crossTrackPropagations contains duplicate issue ids.');
  }
  const missingPropagation = majorIssues.find((issue) => !propagatedIds.includes(issue.id));
  const extraPropagation = propagatedIds.find((id) => !majorIssues.some((issue) => issue.id === id));
  if (missingPropagation) throw new Error(`Major issue ${missingPropagation.id} has no propagation entry.`);
  if (extraPropagation) throw new Error(`Propagation entry ${extraPropagation} does not reference a major issue.`);
  for (const propagation of propagations) {
    const issue = majorIssues.find((candidate) => candidate.id === propagation.issueId);
    if (propagation.issueDimension !== issue.dimension) {
      throw new Error(`Propagation ${propagation.issueId} has dimension ${propagation.issueDimension}; expected ${issue.dimension}.`);
    }
    if (!ROOT_CAUSES.includes(propagation.rootCause)) {
      throw new Error(`Propagation ${propagation.issueId} has invalid rootCause ${propagation.rootCause}.`);
    }
    if (typeof propagation.explanation !== 'string' || !propagation.explanation.trim()) {
      throw new Error(`Propagation ${propagation.issueId} needs a non-empty explanation.`);
    }
  }

  return { issueCounts: expectedTotalCounts, verdict: expectedVerdict };
}

function htmlPathFor(resultPath) {
  if (/-result\.json$/i.test(resultPath)) return resultPath.replace(/-result\.json$/i, '.html');
  return path.join(path.dirname(resultPath), 'permissions-audit.html');
}

function readFindings(html) {
  const marker = 'const FINDINGS = ';
  const start = html.indexOf(marker);
  if (start < 0) throw new Error('Audit report has no FINDINGS data.');
  const end = html.indexOf('\n', start);
  const json = html.slice(start + marker.length, end < 0 ? undefined : end).trim().replace(/;$/, '');
  try {
    return JSON.parse(json);
  } catch {
    throw new Error('Audit report FINDINGS data is not valid JSON.');
  }
}

function validateHtmlFindings(html, result) {
  const findings = readFindings(html);
  const issues = result.dimensionResults.flatMap((dimension) => dimension.issues);
  const rootCauseById = Object.fromEntries(result.crossTrackPropagations.map((entry) => [entry.issueId, entry.rootCause]));
  if (findings.length !== issues.length) {
    throw new Error(`Audit report lists ${findings.length} issues; JSON result has ${issues.length}.`);
  }
  const findingIds = new Set();
  for (const finding of findings) {
    if (findingIds.has(finding.id)) {
      throw new Error(`Audit report lists finding ${finding.id} more than once.`);
    }
    findingIds.add(finding.id);
    const issue = issues.find((candidate) => candidate.id === finding.id);
    if (!issue) {
      throw new Error(`Audit report finding ${finding.id} does not match a JSON issue id.`);
    }
    requireText(finding, ['title', 'reasoning', 'fix'], `Audit report finding ${finding.id}`);
    if (issue.severity === 'major' && finding.rootCause !== rootCauseById[finding.id]) {
      throw new Error(`Audit report finding ${finding.id} has rootCause ${finding.rootCause}; expected ${rootCauseById[finding.id]}.`);
    }
  }
}

function validateFiles(resultPath, htmlPath) {
  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  const summary = validateResult(result);
  if (htmlPath && fs.existsSync(htmlPath)) {
    const html = fs.readFileSync(htmlPath, 'utf8');
    if (/__(?:SITE_NAME|AUDIT_DESC|SUMMARY|FINDINGS_DATA|INVENTORY_DATA|SCORECARD_DATA)__/.test(html)) {
      throw new Error('Audit report has unreplaced data placeholders.');
    }
    validateHtmlFindings(html, result);
  }
  return summary;
}

function fail(error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Audit validation failed: ${message}\n`);
  process.exit(1);
}

const resultFlagIndex = process.argv.indexOf('--result');
const positionalResult = process.argv.slice(2).find((argument) => !argument.startsWith('-'));
const explicitResult = resultFlagIndex >= 0 ? process.argv[resultFlagIndex + 1] : positionalResult;

if (explicitResult) {
  try {
    const resultPath = path.resolve(explicitResult);
    const htmlPath = htmlPathFor(resultPath);
    const summary = validateFiles(resultPath, htmlPath);
    process.stdout.write(`${JSON.stringify({ valid: true, resultPath, ...summary })}\n`);
  } catch (error) {
    fail(error);
  }
} else {
  // The PostToolUse(Skill) hook fires before the audit writes its artifacts, so it can only see a previous run; Step 7.4 validates the new result.
  process.stdin.resume();
  process.stdin.on('end', () => process.exit(0));
}
