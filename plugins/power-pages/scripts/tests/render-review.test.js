const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'render-review.js');

const REQUIRED_KEYS = [
  'REPORT_NAME',
  'SITE_NAME',
  'GOAL_LABEL',
  'SCOPE_LABEL',
  'GENERATED_AT',
  'REVIEW_DATA',
];

function withTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runRenderReview(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

function fullDataPayload() {
  return {
    REPORT_NAME: 'Security Review',
    SITE_NAME: 'Test Site',
    GOAL_LABEL: 'Release readiness',
    SCOPE_LABEL: 'Full site',
    GENERATED_AT: '2026-05-26 12:00:00',
    REVIEW_DATA: {
      summary: 'All clear.',
      totals: { critical: 0, warning: 0, info: 0, pass: 1 },
      sections: [
        {
          id: 'site-scan',
          icon: '◐',
          label: 'Live Site Scan',
          findings: [],
          details: {},
        },
      ],
      nextSteps: [],
    },
  };
}

test('exits 1 when --output is missing', () => {
  const result = runRenderReview(['--data', 'whatever.json']);
  assert.equal(result.status, 1, `stderr: ${result.stderr}`);
  assert.match(result.stderr, /Usage:/);
});

test('exits 1 when --data is missing', () => {
  const result = runRenderReview(['--output', 'whatever.html']);
  assert.equal(result.status, 1, `stderr: ${result.stderr}`);
  assert.match(result.stderr, /Usage:/);
});

test('exits 1 when --data file does not exist', (t) => {
  const dir = withTempDir(t);
  const result = runRenderReview([
    '--output',
    path.join(dir, 'out.html'),
    '--data',
    path.join(dir, 'missing.json'),
  ]);
  assert.equal(result.status, 1, `stderr: ${result.stderr}`);
  assert.match(result.stderr, /ENOENT|not found|missing/i);
});

test('exits 1 when --data file contains unparseable JSON', (t) => {
  const dir = withTempDir(t);
  const dataPath = path.join(dir, 'data.json');
  fs.writeFileSync(dataPath, '{not valid json');

  const result = runRenderReview([
    '--output',
    path.join(dir, 'out.html'),
    '--data',
    dataPath,
  ]);
  assert.equal(result.status, 1, `stderr: ${result.stderr}`);
  assert.match(result.stderr, /JSON|parse|unexpected/i);
});

for (const key of REQUIRED_KEYS) {
  test(`exits 1 when required key "${key}" is missing from the data file`, (t) => {
    const dir = withTempDir(t);
    const dataPath = path.join(dir, 'data.json');
    const incomplete = fullDataPayload();
    delete incomplete[key];
    fs.writeFileSync(dataPath, JSON.stringify(incomplete));

    const result = runRenderReview([
      '--output',
      path.join(dir, 'out.html'),
      '--data',
      dataPath,
    ]);
    assert.equal(result.status, 1, `stderr: ${result.stderr}`);
    assert.ok(
      result.stderr.includes(key),
      `stderr should name the missing key "${key}", got: ${result.stderr}`
    );
  });
}

test('renders the shared security-review template when given a full data payload', (t) => {
  const dir = withTempDir(t);
  const dataPath = path.join(dir, 'data.json');
  const outPath = path.join(dir, 'out.html');
  fs.writeFileSync(dataPath, JSON.stringify(fullDataPayload()));

  const result = runRenderReview(['--output', outPath, '--data', dataPath]);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);

  const html = fs.readFileSync(outPath, 'utf8');
  const expectedSubstrings = [
    ['REPORT_NAME', 'Security Review'],
    ['SITE_NAME', 'Test Site'],
    ['summary', 'All clear.'],
    // REVIEW_DATA payload — section label must reach the rendered HTML so a
    // regression that drops REVIEW_DATA substitution is caught even when the
    // placeholder is also removed.
    ['REVIEW_DATA section label', 'Live Site Scan'],
  ];
  for (const [label, value] of expectedSubstrings) {
    assert.ok(html.includes(value), `rendered HTML must include ${label} value "${value}"`);
  }
  for (const placeholder of ['__REPORT_NAME__', '__SITE_NAME__', '__REVIEW_DATA__']) {
    assert.ok(!html.includes(placeholder), `${placeholder} must be substituted`);
  }
});
