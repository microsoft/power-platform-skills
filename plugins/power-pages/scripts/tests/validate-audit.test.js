const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createTempProject, writeProjectFile } = require('./test-utils');

const VALIDATOR_PATH = path.join(
  __dirname,
  '..',
  '..',
  'skills',
  'audit-permissions',
  'scripts',
  'validate-audit.js'
);

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

function validResult() {
  const issuesByDimension = {
    'anonymous-access-hygiene': [{
      id: 'AH1',
      dimension: 'anonymous-access-hygiene',
      severity: 'major',
      description: 'Anonymous users can read staff email and phone.',
      suggestion: 'Remove the Anonymous role from the staff read permission.',
      mergedFrom: ['AH1'],
    }],
    'internal-consistency': [{
      id: 'IS1',
      dimension: 'internal-consistency',
      severity: 'minor',
      description: 'No permission plan document.',
      suggestion: 'Add docs/permissions-plan.html.',
      mergedFrom: ['IS1'],
    }],
  };
  return {
    dimensionResults: DIMENSIONS.map((dimension) => ({
      dimension,
      observations: 'Observed.',
      issues: issuesByDimension[dimension] || [],
      suggestions: [],
    })),
    categoryResults: [
      { category: 'over-exposure', issueCounts: { major: 1, minor: 0, total: 1 }, score: 4.21 },
      { category: 'under-exposure', issueCounts: { major: 0, minor: 0, total: 0 }, score: 5 },
      { category: 'correctness', issueCounts: { major: 0, minor: 1, total: 1 }, score: 4.8 },
    ],
    verdict: 'Needs revision',
    overallSummary: 'One major and one minor issue.',
    issueCounts: { major: 1, minor: 1, total: 2 },
    deterministic: {},
    crossTrackPropagations: [{
      issueId: 'AH1',
      issueDimension: 'anonymous-access-hygiene',
      rootCause: 'permissions',
      confidence: 'high',
      explanation: 'The anonymous Global read grant alone exposes the data.',
    }],
    modelInfo: {},
  };
}

function validFindings() {
  return [
    {
      id: 'AH1',
      severity: 'major',
      title: 'Staff contact details readable by Anonymous',
      reasoning: 'Staff-Public-Read grants Anonymous Global read.',
      fix: 'Restrict the permission to a staff role.',
      rootCause: 'permissions',
      rootCauseReason: 'The anonymous Global read grant alone exposes the data.',
    },
    {
      id: 'IS1',
      severity: 'minor',
      title: 'No permission plan document',
      reasoning: 'docs/permissions-plan.html is missing.',
      fix: 'Add a permission plan.',
    },
  ];
}

function reportHtml(findings) {
  return `<!doctype html><html><body><script>\nconst FINDINGS = ${JSON.stringify(findings)};\n</script></body></html>`;
}

function writeAudit(projectRoot, {
  name = 'permissions-audit',
  result = validResult(),
  findings = validFindings(),
  html,
} = {}) {
  const resultPath = writeProjectFile(projectRoot, `docs/${name}-result.json`, JSON.stringify(result));
  writeProjectFile(projectRoot, `docs/${name}.html`, html ?? reportHtml(findings));
  return resultPath;
}

function runResult(resultPath) {
  return spawnSync(process.execPath, [VALIDATOR_PATH, '--result', resultPath], { encoding: 'utf8' });
}

function runHook(cwd) {
  return spawnSync(process.execPath, [VALIDATOR_PATH], {
    input: JSON.stringify({ cwd }),
    encoding: 'utf8',
  });
}

function expectResultFailure(t, mutate, pattern, { findings } = {}) {
  const projectRoot = createTempProject(t);
  const result = validResult();
  mutate(result);
  const outcome = runResult(writeAudit(projectRoot, { result, findings }));
  assert.equal(outcome.status, 1, outcome.stdout);
  assert.match(outcome.stderr, pattern);
}

function expectFindingsFailure(t, mutate, pattern) {
  const projectRoot = createTempProject(t);
  const findings = validFindings();
  mutate(findings);
  const outcome = runResult(writeAudit(projectRoot, { findings }));
  assert.equal(outcome.status, 1, outcome.stdout);
  assert.match(outcome.stderr, pattern);
}

const findIssue = (result, id) => result.dimensionResults.flatMap((d) => d.issues).find((i) => i.id === id);

test('valid result and report pass', (t) => {
  const projectRoot = createTempProject(t);
  const outcome = runResult(writeAudit(projectRoot));
  assert.equal(outcome.status, 0, outcome.stderr);
  const summary = JSON.parse(outcome.stdout);
  assert.equal(summary.valid, true);
  assert.deepEqual(summary.issueCounts, { major: 1, minor: 1, total: 2 });
  assert.equal(summary.verdict, 'Needs revision');
});

test('recomputes category scores', (t) => {
  expectResultFailure(t, (r) => { r.categoryResults[0].score = 3.5; }, /over-exposure\.score is 3\.5; expected 4\.21/);
});

test('recomputes issue counts', (t) => {
  expectResultFailure(t, (r) => { r.issueCounts.minor = 0; }, /issueCounts\.minor/);
  expectResultFailure(t, (r) => { r.categoryResults[2].issueCounts.total = 0; }, /correctness\.issueCounts\.total/);
});

test('recomputes the verdict', (t) => {
  expectResultFailure(t, (r) => { r.verdict = 'Safe to go'; }, /verdict is Safe to go; expected Needs revision/);
});

test('rejects malformed results', (t) => {
  expectResultFailure(t, (r) => { r.dimensionResults.reverse(); }, /dimensionResults\[0\] must be intent-coverage/);
  expectResultFailure(t, (r) => { r.categoryResults.pop(); }, /categoryResults must contain exactly 3/);
  expectResultFailure(t, (r) => { findIssue(r, 'IS1').id = 'SP1'; }, /must use the IS prefix/);
  expectResultFailure(t, (r) => { findIssue(r, 'IS1').severity = 'info'; }, /invalid severity info/);
  expectResultFailure(t, (r) => { findIssue(r, 'IS1').mergedFrom = []; }, /non-empty mergedFrom/);
  expectResultFailure(t, (r) => { findIssue(r, 'IS1').description = ' '; }, /IS1 needs a non-empty description/);
  expectResultFailure(t, (r) => { delete findIssue(r, 'AH1').suggestion; }, /AH1 needs a non-empty suggestion/);
});

test('requires one root-cause entry per major issue', (t) => {
  expectResultFailure(t, (r) => { r.crossTrackPropagations = []; }, /Major issue AH1 has no propagation entry/);
  expectResultFailure(t, (r) => {
    r.crossTrackPropagations.push({ ...r.crossTrackPropagations[0], issueId: 'IS1', issueDimension: 'internal-consistency' });
  }, /Propagation entry IS1 does not reference a major issue/);
  expectResultFailure(t, (r) => { r.crossTrackPropagations[0].rootCause = 'unknown'; }, /invalid rootCause unknown/);
  expectResultFailure(t, (r) => { r.crossTrackPropagations[0].explanation = ''; }, /non-empty explanation/);
});

test('checks the report against the JSON result', (t) => {
  expectFindingsFailure(t, (f) => { f.pop(); }, /lists 1 issues; JSON result has 2/);
  expectFindingsFailure(t, (f) => { f[1].id = 'f2'; }, /finding f2 does not match a JSON issue id/);
  expectFindingsFailure(t, (f) => { f[0].rootCause = 'mixed'; }, /AH1 has rootCause mixed; expected permissions/);
  expectFindingsFailure(t, (f) => { f[1].fix = ''; }, /finding IS1 needs a non-empty fix/);
  expectFindingsFailure(t, (f) => { delete f[0].title; }, /finding AH1 needs a non-empty title/);
});

test('rejects reports with unreplaced placeholders', (t) => {
  const projectRoot = createTempProject(t);
  const outcome = runResult(writeAudit(projectRoot, { html: `${reportHtml(validFindings())}__SUMMARY__` }));
  assert.equal(outcome.status, 1);
  assert.match(outcome.stderr, /unreplaced data placeholders/);
});

test('pairs a renamed result with its own report', (t) => {
  const projectRoot = createTempProject(t);
  writeAudit(projectRoot, { findings: [validFindings()[0]] });
  const outcome = runResult(writeAudit(projectRoot, { name: 'permissions-audit-apr-2026' }));
  assert.equal(outcome.status, 0, outcome.stderr);
});

test('hook mode passes when there is no audit result', (t) => {
  const projectRoot = createTempProject(t);
  const outcome = runHook(projectRoot);
  assert.equal(outcome.status, 0, outcome.stderr);
});

test('hook mode passes a valid audit and blocks an invalid one', (t) => {
  const validRoot = createTempProject(t);
  writeAudit(validRoot);
  assert.equal(runHook(validRoot).status, 0);

  const invalidRoot = createTempProject(t);
  const result = validResult();
  result.verdict = 'Safe to go';
  writeAudit(invalidRoot, { result });
  const outcome = runHook(invalidRoot);
  assert.equal(outcome.status, 2);
  assert.match(outcome.stderr, /Audit validation failed: verdict is Safe to go/);
});

test('hook mode validates the newest result', (t) => {
  const projectRoot = createTempProject(t);
  const older = writeAudit(projectRoot);
  const result = validResult();
  result.issueCounts.total = 9;
  const newer = writeAudit(projectRoot, { name: 'permissions-audit-oct-2026', result });
  fs.utimesSync(older, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  fs.utimesSync(newer, new Date(), new Date());
  const outcome = runHook(projectRoot);
  assert.equal(outcome.status, 2);
  assert.match(outcome.stderr, /issueCounts\.total is 9/);
});

test('hook mode finds a site in a child directory', (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'powerpages-workspace-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const siteRoot = path.join(workspace, 'site');
  writeProjectFile(siteRoot, 'powerpages.config.json', '{}');
  const result = validResult();
  result.verdict = 'Safe to go';
  writeAudit(siteRoot, { result });
  const outcome = runHook(workspace);
  assert.equal(outcome.status, 2);
  assert.match(outcome.stderr, /verdict is Safe to go/);
});
