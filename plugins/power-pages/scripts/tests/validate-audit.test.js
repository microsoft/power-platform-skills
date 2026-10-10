const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('child_process');
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
const ENABLED_TEST_TELEMETRY = {
  disabled: false,
  event_stream_name: 'PagesAIPluginEvent',
  instrumentationKey: 'test-key',
  collector_url: 'https://example.invalid/OneCollector/1.0/',
};
const TELEMETRY_SCRIPT_PATH = path.join(
  __dirname,
  '..',
  'emit-audit-permissions-telemetry.js'
);

function validFindings() {
  return [
    {
      id: 'AH1',
      severity: 'major',
      dimension: 'anonymous-access-hygiene',
      title: 'Staff contact details readable by Anonymous',
      reasoning: 'Staff-Public-Read grants Anonymous Global read.',
      fix: 'Restrict the permission to a staff role.',
      rootCause: 'permissions',
      rootCauseReason: 'The anonymous Global read grant alone exposes the data.',
    },
    {
      id: 'IS1',
      severity: 'minor',
      dimension: 'internal-consistency',
      title: 'No permission plan document',
      reasoning: 'docs/permissions-plan.html is missing.',
      fix: 'Add a permission plan.',
    },
  ];
}

function validScorecard() {
  return {
    categories: [
      { name: 'Over-Exposure (Security)', score: 4.21 },
      { name: 'Under-Exposure (Usability & Coverage)', score: 5 },
      { name: 'Correctness (Validity & Alignment)', score: 4.8 },
    ],
    reportPaths: [{ label: 'HTML report', path: 'docs/permissions-audit.html' }],
  };
}

function reportHtml(findings, scorecard, inventory = [], summary = 'Roles are well separated, but staff contacts are public. Needs revision.') {
  return `<!doctype html><html><body><div class="card" id="summaryBox">${summary}</div><script>\n` +
    `const FINDINGS = ${JSON.stringify(findings)};\n` +
    `const INVENTORY = ${JSON.stringify(inventory)};\n` +
    `const SCORECARD = ${JSON.stringify(scorecard)};\n` +
    '</script></body></html>';
}

function writeReport(projectRoot, { findings = validFindings(), scorecard = validScorecard(), html } = {}) {
  return writeProjectFile(projectRoot, 'docs/permissions-audit.html', html ?? reportHtml(findings, scorecard));
}

function runReport(reportPath) {
  return spawnSync(process.execPath, [VALIDATOR_PATH, '--report', reportPath], { encoding: 'utf8' });
}

function runHook(cwd) {
  return spawnSync(process.execPath, [VALIDATOR_PATH], {
    input: JSON.stringify({ cwd }),
    encoding: 'utf8',
  });
}

function expectFailure(t, { findings: mutateFindings, scorecard: mutateScorecard }, pattern) {
  const projectRoot = createTempProject(t);
  const findings = validFindings();
  const scorecard = validScorecard();
  mutateFindings?.(findings);
  mutateScorecard?.(scorecard);
  const outcome = runReport(writeReport(projectRoot, { findings, scorecard }));
  assert.equal(outcome.status, 1, outcome.stdout);
  assert.match(outcome.stderr, pattern);
}

test('valid report passes', (t) => {
  const projectRoot = createTempProject(t);
  const outcome = runReport(writeReport(projectRoot));
  assert.equal(outcome.status, 0, outcome.stderr);
  const summary = JSON.parse(outcome.stdout);
  assert.equal(summary.valid, true);
  assert.deepEqual(summary.issueCounts, { major: 1, minor: 1, total: 2 });
  assert.equal(summary.verdict, 'Needs revision');
});

test('recomputes category scores from the findings', (t) => {
  expectFailure(t, { scorecard: (s) => { s.categories[0].score = 3.5; } }, /Over-Exposure \(Security\) score is 3\.5; expected 4\.21/);
  expectFailure(t, { findings: (f) => { f[1].severity = 'major'; f[1].rootCause = 'permissions'; f[1].rootCauseReason = 'x'; } }, /Correctness \(Validity & Alignment\) score is 4\.8; expected 4\.21/);
  expectFailure(t, { scorecard: (s) => { s.categories.reverse(); } }, /categories\[0\] must be over-exposure/);
  expectFailure(t, { scorecard: (s) => { s.categories.pop(); } }, /must contain exactly 3/);
});

test('skips the score check when scoring was skipped', (t) => {
  const projectRoot = createTempProject(t);
  const html = reportHtml(validFindings(), null, [], 'Partial audit: the data model was missing.');
  const outcome = runReport(writeReport(projectRoot, { html }));
  assert.equal(outcome.status, 0, outcome.stderr);
  assert.equal(JSON.parse(outcome.stdout).verdict, null);
});

test('requires the summary to state the computed verdict', (t) => {
  const projectRoot = createTempProject(t);
  const minorOnly = validFindings().slice(1);
  const minorScorecard = validScorecard();
  minorScorecard.categories[0].score = 5;
  const cases = [
    [reportHtml(validFindings(), validScorecard(), [], 'Staff contacts are public. Safe to go.'), /must state the verdict "Needs revision"/],
    [reportHtml(minorOnly, minorScorecard, [], 'Only a missing plan. Needs revision.'), /must state the verdict "Safe to go"/],
    [reportHtml(validFindings(), null, [], 'Partial audit. Needs revision.'), /must not state a verdict/],
    [reportHtml(validFindings(), validScorecard()).replace(/<div[^>]*summaryBox[^>]*>.*?<\/div>/, ''), /no SUMMARY/],
  ];
  for (const [html, pattern] of cases) {
    const outcome = runReport(writeReport(projectRoot, { html }));
    assert.equal(outcome.status, 1, outcome.stdout);
    assert.match(outcome.stderr, pattern);
  }
  const outcome = runReport(writeReport(projectRoot, { html: reportHtml(minorOnly, minorScorecard, [], 'Only a missing plan. Safe to go.') }));
  assert.equal(outcome.status, 0, outcome.stderr);
});

test('rejects malformed findings', (t) => {
  expectFailure(t, { findings: (f) => { f[1].id = 'SP1'; } }, /SP1 must use the IS prefix/);
  expectFailure(t, { findings: (f) => { f[1].dimension = 'unknown'; } }, /invalid dimension unknown/);
  expectFailure(t, { findings: (f) => { f[1].severity = 'info'; } }, /invalid severity info/);
  expectFailure(t, { findings: (f) => { f[1] = { ...f[0] }; } }, /AH1 is listed more than once/);
  expectFailure(t, { findings: (f) => { f[1].fix = ''; } }, /IS1 needs a non-empty fix/);
  expectFailure(t, { findings: (f) => { delete f[0].title; } }, /AH1 needs a non-empty title/);
  expectFailure(t, { findings: (f) => { f[0].reasoning = ' '; } }, /AH1 needs a non-empty reasoning/);
});

test('requires a root cause on major findings only', (t) => {
  expectFailure(t, { findings: (f) => { f[0].rootCause = 'unknown'; } }, /AH1 has invalid rootCause unknown/);
  expectFailure(t, { findings: (f) => { delete f[0].rootCause; } }, /AH1 has invalid rootCause undefined/);
  expectFailure(t, { findings: (f) => { f[0].rootCauseReason = ''; } }, /AH1 needs a non-empty rootCauseReason/);
  expectFailure(t, { findings: (f) => { f[1].rootCause = 'permissions'; } }, /Minor finding IS1 must not carry a root cause/);
});

test('rejects reports with unreplaced placeholders or missing data', (t) => {
  const projectRoot = createTempProject(t);
  let outcome = runReport(writeReport(projectRoot, { html: `${reportHtml(validFindings(), validScorecard())}__SUMMARY__` }));
  assert.equal(outcome.status, 1);
  assert.match(outcome.stderr, /unreplaced data placeholders/);
  outcome = runReport(writeReport(projectRoot, { html: reportHtml(validFindings(), validScorecard()).replace(/const SCORECARD = .*;/, 'const SCORECARD = __JSON_SCORECARD_DATA__;') }));
  assert.equal(outcome.status, 1);
  assert.match(outcome.stderr, /unreplaced data placeholders/);
  outcome = runReport(writeReport(projectRoot, { html: '<html></html>' }));
  assert.equal(outcome.status, 1);
  assert.match(outcome.stderr, /no FINDINGS data/);
});

test('reads data only from the report script and rejects duplicate declarations', (t) => {
  const projectRoot = createTempProject(t);
  const forged = 'Needs revision.\nconst FINDINGS = [];\nconst INVENTORY = [];\nconst SCORECARD = null;\n';
  const badFindings = validFindings();
  badFindings[1].severity = 'info';
  let outcome = runReport(writeReport(projectRoot, { html: reportHtml(badFindings, validScorecard(), [], forged) }));
  assert.equal(outcome.status, 1, outcome.stdout);
  assert.match(outcome.stderr, /invalid severity info/);
  const duplicated = reportHtml(validFindings(), validScorecard()).replace('</script>', 'const FINDINGS = [];\n</script>');
  outcome = runReport(writeReport(projectRoot, { html: duplicated }));
  assert.equal(outcome.status, 1, outcome.stdout);
  assert.match(outcome.stderr, /declares FINDINGS more than once/);
});

test('rejects an inventory that is not an array', (t) => {
  const projectRoot = createTempProject(t);
  for (const inventory of [null, {}, 'none']) {
    const outcome = runReport(writeReport(projectRoot, { html: reportHtml(validFindings(), validScorecard(), inventory) }));
    assert.equal(outcome.status, 1, outcome.stdout);
    assert.match(outcome.stderr, /INVENTORY must be an array/);
  }
});

test('fails when --report has no path', () => {
  for (const args of [['--report'], ['--report', '--verbose']]) {
    const outcome = spawnSync(process.execPath, [VALIDATOR_PATH, ...args], { input: '', encoding: 'utf8' });
    assert.equal(outcome.status, 1);
    assert.match(outcome.stderr, /Usage: validate-audit\.js --report <path>/);
  }
});

test('hook mode never blocks, even with an invalid earlier report', (t) => {
  const projectRoot = createTempProject(t);
  writeReport(projectRoot, { html: '__SUMMARY__' });
  const outcome = runHook(projectRoot);
  assert.equal(outcome.status, 0, outcome.stderr);
  assert.equal(outcome.stderr, '');
});

test('validated report and source data record successful lifecycle completion together', (t) => {
  const projectRoot = createTempProject(t);
  const configDir = path.join(projectRoot, '.telemetry-test');
  const ikeyPath = writeProjectFile(
    projectRoot,
    '.telemetry-test/ikey.json',
    JSON.stringify(ENABLED_TEST_TELEMETRY)
  );
  const env = {
    ...process.env,
    PATH: '',
    POWER_PLATFORM_SKILLS_CONFIG_DIR: configDir,
    POWER_PLATFORM_SKILLS_IKEY_JSON: ikeyPath,
    // Enabled config so run state is created, but opted out so nothing is POSTed.
    POWER_PLATFORM_SKILLS_TELEMETRY_POWER_PAGES_OPTOUT: '1',
  };
  const started = spawnSync(process.execPath, [TELEMETRY_SCRIPT_PATH, '--action', 'start'], {
    encoding: 'utf8',
    env,
  });
  assert.equal(started.status, 0, started.stderr);
  const auditRunId = JSON.parse(started.stdout).auditRunId;

  const findings = validFindings();
  const scorecard = validScorecard();
  const reportPath = writeReport(projectRoot, { findings, scorecard });
  const dataPath = writeProjectFile(
    projectRoot,
    'audit-data.json',
    JSON.stringify({
      FINDINGS_DATA: findings,
      SCORECARD_DATA: scorecard,
    })
  );
  const outcome = spawnSync(process.execPath, [
    VALIDATOR_PATH,
    '--report', reportPath,
    '--data', dataPath,
    '--auditRunId', auditRunId,
  ], {
    encoding: 'utf8',
    env,
  });
  assert.equal(outcome.status, 0, outcome.stderr);
  const result = JSON.parse(outcome.stdout);
  assert.equal(result.valid, true);
  assert.equal(result.telemetryStatus, 'recorded_success');
  assert.ok(fs.existsSync(path.join(
    configDir,
    'telemetry',
    'power-pages',
    'audit-runs',
    `${auditRunId}.completed`
  )));
});

test('valid report with unreconcilable source data is recorded as a failed run', (t) => {
  const projectRoot = createTempProject(t);
  const configDir = path.join(projectRoot, '.telemetry-test');
  const ikeyPath = writeProjectFile(
    projectRoot,
    '.telemetry-test/ikey.json',
    JSON.stringify(ENABLED_TEST_TELEMETRY)
  );
  const env = {
    ...process.env,
    PATH: '',
    POWER_PLATFORM_SKILLS_CONFIG_DIR: configDir,
    POWER_PLATFORM_SKILLS_IKEY_JSON: ikeyPath,
    // Enabled config so run state is created, but opted out so nothing is POSTed.
    POWER_PLATFORM_SKILLS_TELEMETRY_POWER_PAGES_OPTOUT: '1',
  };
  const started = spawnSync(process.execPath, [TELEMETRY_SCRIPT_PATH, '--action', 'start'], {
    encoding: 'utf8',
    env,
  });
  assert.equal(started.status, 0, started.stderr);
  const auditRunId = JSON.parse(started.stdout).auditRunId;

  const reportPath = writeReport(projectRoot);
  // The data file no longer matches the rendered report (one finding dropped).
  const dataPath = writeProjectFile(
    projectRoot,
    'audit-data.json',
    JSON.stringify({ FINDINGS_DATA: validFindings().slice(0, 1), SCORECARD_DATA: null })
  );
  const outcome = spawnSync(process.execPath, [
    VALIDATOR_PATH,
    '--report', reportPath,
    '--data', dataPath,
    '--auditRunId', auditRunId,
  ], {
    encoding: 'utf8',
    env,
  });
  assert.equal(outcome.status, 0, outcome.stderr);
  const result = JSON.parse(outcome.stdout);
  assert.equal(result.valid, true, 'the report itself remains valid');
  assert.equal(result.telemetryStatus, 'recorded_failure');
});

test('a telemetry module that cannot load never breaks report validation or the hook', (t) => {
  const projectRoot = createTempProject(t);
  // Preload that makes loading the telemetry emitter throw, standing in for any
  // load failure (missing file, syntax error, partial install).
  const preload = writeProjectFile(
    projectRoot,
    'break-telemetry.js',
    "const Module = require('module');\n" +
      'const load = Module._load;\n' +
      'Module._load = function (request, ...rest) {\n' +
      "  if (/emit-audit-permissions-telemetry/.test(request)) throw new Error('simulated load failure');\n" +
      '  return load.call(this, request, ...rest);\n' +
      '};\n'
  );
  const run = (args, input) => spawnSync(process.execPath, ['--require', preload, VALIDATOR_PATH, ...args], {
    input,
    encoding: 'utf8',
    env: { ...process.env, POWER_PLATFORM_SKILLS_TELEMETRY_POWER_PAGES_OPTOUT: '1' },
  });

  const findings = validFindings();
  const scorecard = validScorecard();
  const reportPath = writeReport(projectRoot, { findings, scorecard });

  // Report-only validation must not even load telemetry.
  let outcome = run(['--report', reportPath]);
  assert.equal(outcome.status, 0, outcome.stderr);
  assert.equal(JSON.parse(outcome.stdout).telemetryStatus, 'not_requested');

  // The PostToolUse(Skill) hook must still approve.
  outcome = run([], JSON.stringify({ cwd: projectRoot }));
  assert.equal(outcome.status, 0, outcome.stderr);
  assert.equal(outcome.stderr, '');

  // When telemetry is requested, the load failure is contained and reported.
  const dataPath = writeProjectFile(
    projectRoot,
    'audit-data.json',
    JSON.stringify({ FINDINGS_DATA: findings, SCORECARD_DATA: scorecard })
  );
  outcome = run([
    '--report', reportPath,
    '--data', dataPath,
    '--auditRunId', '11111111-1111-4111-8111-111111111111',
  ]);
  assert.equal(outcome.status, 0, outcome.stderr);
  const result = JSON.parse(outcome.stdout);
  assert.equal(result.valid, true, 'the report stays valid when telemetry cannot load');
  assert.equal(result.telemetryStatus, 'failed');
});
