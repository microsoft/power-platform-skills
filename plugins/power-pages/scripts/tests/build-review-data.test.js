const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  buildSections,
  formatGeneratedAt,
  SECTION_MAP,
  SEVERITIES,
} = require('../build-review-data');

const SCRIPT = path.join(__dirname, '..', 'build-review-data.js');

function withTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brd-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeJson(dir, name, value) {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
}

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('SECTION_MAP recognizes the six known per-skill files', () => {
  const expected = [
    'scan-code.json',
    'scan-site.json',
    'manage-headers.json',
    'manage-firewall.json',
    'audit-permissions.json',
    'setup-auth.json',
  ];
  for (const file of expected) {
    assert.ok(SECTION_MAP[file], `${file} missing from SECTION_MAP`);
    assert.equal(typeof SECTION_MAP[file].id, 'string');
    assert.equal(typeof SECTION_MAP[file].label, 'string');
  }
});

test('buildSections renders scan-code findings with severity totals', (t) => {
  const dir = withTempDir(t);
  writeJson(dir, 'scan-code.json', {
    status: 'ok',
    findings: [
      { id: 'a', severity: 'critical', category: 'vulnerability', title: 't' },
      { id: 'b', severity: 'high', category: 'secret', title: 't' },
      { id: 'c', severity: 'warning', confidence: 'HIGH', title: 't' },
    ],
  });

  const { sections, totals } = buildSections(dir, 'data.json');
  assert.equal(sections.length, 1);
  assert.equal(sections[0].id, 'code-scan');
  assert.equal(sections[0].label, 'Code & Packages');
  assert.equal(sections[0].findings.length, 3);
  assert.equal(totals.critical, 1);
  assert.equal(totals.high, 1);
  assert.equal(totals.warning, 1);
});

test('SEVERITIES lists the seven supported severity buckets in precedence order', () => {
  assert.deepEqual(SEVERITIES, [
    'critical',
    'high',
    'warning',
    'medium',
    'info',
    'low',
    'pass',
  ]);
});

test('buildSections skips files not in SECTION_MAP', (t) => {
  const dir = withTempDir(t);
  writeJson(dir, 'unknown.json', { status: 'ok', findings: [] });
  writeJson(dir, 'next-steps.json', ['step1']);

  const result = buildSections(dir, 'data.json');
  assert.deepEqual(result.sections, []);
});

test('buildSections ignores the configured output basename', (t) => {
  const dir = withTempDir(t);
  writeJson(dir, 'scan-site.json', { status: 'ok', findings: [], details: {} });
  writeJson(dir, 'data.json', { REVIEW_DATA: {} });

  const result = buildSections(dir, 'data.json');
  assert.equal(result.sections.length, 1);
  assert.equal(result.sections[0].id, 'site-scan');
});

test('buildSections aggregates findings into severity totals', (t) => {
  const dir = withTempDir(t);
  writeJson(dir, 'scan-site.json', {
    status: 'ok',
    findings: [
      { id: 'a', severity: 'critical', title: 't' },
      { id: 'b', severity: 'high', title: 't' },
      { id: 'c', severity: 'warning', title: 't' },
      { id: 'd', severity: 'warning', title: 't' },
      { id: 'e', severity: 'medium', title: 't' },
      { id: 'f', severity: 'info', title: 't' },
      { id: 'g', severity: 'low', title: 't' },
      { id: 'h', severity: 'pass', title: 't' },
    ],
    details: {},
  });

  const { sections, totals } = buildSections(dir, 'data.json');
  assert.equal(sections.length, 1);
  assert.equal(totals.critical, 1);
  assert.equal(totals.high, 1);
  assert.equal(totals.warning, 2);
  assert.equal(totals.medium, 1);
  assert.equal(totals.info, 1);
  assert.equal(totals.low, 1);
  assert.equal(totals.pass, 1);
});

test('buildSections renders skipped status without a severity field', (t) => {
  const dir = withTempDir(t);
  writeJson(dir, 'manage-firewall.json', {
    status: 'skipped',
    reason: 'sign-in required',
  });

  const { sections, totals } = buildSections(dir, 'data.json');
  assert.equal(sections.length, 1);
  assert.equal(sections[0].id, 'firewall');
  assert.equal(sections[0].findings.length, 1);
  assert.ok(!('severity' in sections[0].findings[0]));
  assert.equal(sections[0].findings[0].details, 'sign-in required');
  for (const sev of SEVERITIES) {
    assert.equal(totals[sev], 0, `totals.${sev} should be 0 for skipped-only run`);
  }
});

test('buildSections defaults skipped reason when missing', (t) => {
  const dir = withTempDir(t);
  writeJson(dir, 'scan-site.json', { status: 'skipped' });

  const { sections } = buildSections(dir, 'data.json');
  assert.equal(sections[0].findings[0].details, 'No additional detail.');
});

test('buildSections skips files that are not valid JSON', (t) => {
  const dir = withTempDir(t);
  fs.writeFileSync(path.join(dir, 'scan-site.json'), '{not json');

  const { sections } = buildSections(dir, 'data.json');
  assert.deepEqual(sections, []);
});

test('buildSections treats unknown severity values as non-counting', (t) => {
  const dir = withTempDir(t);
  writeJson(dir, 'scan-site.json', {
    status: 'ok',
    findings: [
      { id: 'x', severity: 'unrecognized', title: 't' },
      { id: 'y', severity: 'warning', title: 't' },
    ],
    details: {},
  });

  const { totals } = buildSections(dir, 'data.json');
  assert.equal(totals.warning, 1);
  assert.equal(totals.unrecognized, undefined);
});

test('buildSections defaults missing findings array to empty', (t) => {
  const dir = withTempDir(t);
  writeJson(dir, 'scan-site.json', { status: 'ok' });

  const { sections } = buildSections(dir, 'data.json');
  assert.deepEqual(sections[0].findings, []);
});

test('formatGeneratedAt produces YYYY-MM-DD HH:MM:SS plus a timezone abbreviation', () => {
  const originalTz = process.env.TZ;
  process.env.TZ = 'UTC';
  try {
    const stamp = formatGeneratedAt(new Date('2026-05-26T03:04:05Z'));
    assert.match(stamp, /^2026-05-26 03:04:05 [A-Z][A-Z0-9+/:-]+$/);
  } finally {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  }
});

test('buildSections returns no sections and zero totals for an empty directory', (t) => {
  const dir = withTempDir(t);
  const { sections, totals } = buildSections(dir, 'data.json');
  assert.deepEqual(sections, []);
  for (const sev of SEVERITIES) {
    assert.equal(totals[sev], 0);
  }
});

test('CLI exits 1 with a clear message when a required flag is missing', () => {
  const result = runCli([
    '--reportName',
    'X',
    '--inputDir',
    '.',
    '--siteName',
    'Y',
    '--goalLabel',
    'Z',
    '--scopeLabel',
    'W',
  ]);
  assert.equal(result.status, 1, `stderr: ${result.stderr}`);
  assert.match(result.stderr, /Missing required flag: --output/);
});

test('CLI exits 1 when --inputDir does not exist', (t) => {
  const tmp = withTempDir(t);
  const result = runCli([
    '--reportName',
    'X',
    '--inputDir',
    path.join(tmp, 'no-such-dir'),
    '--siteName',
    'Y',
    '--goalLabel',
    'Z',
    '--scopeLabel',
    'W',
    '--output',
    path.join(tmp, 'data.json'),
  ]);
  assert.equal(result.status, 1, `stderr: ${result.stderr}`);
  assert.match(result.stderr, /Input dir not found/);
});

test('CLI --help writes usage to stdout and exits 0', () => {
  const result = runCli(['--help']);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(result.stdout, /build-review-data\.js/);
  assert.match(result.stdout, /Usage:/);
});

test('CLI writes the data file and a status line to stdout', (t) => {
  const inputDir = withTempDir(t);
  writeJson(inputDir, 'scan-site.json', {
    status: 'ok',
    findings: [{ id: 'a', severity: 'warning', title: 't' }],
    details: {},
  });
  const outPath = path.join(inputDir, 'data.json');

  const result = runCli([
    '--reportName',
    'Security Review',
    '--inputDir',
    inputDir,
    '--siteName',
    'Demo',
    '--goalLabel',
    'release',
    '--scopeLabel',
    'site',
    '--output',
    outPath,
  ]);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  const status = JSON.parse(result.stdout);
  assert.equal(status.status, 'ok');
  assert.equal(status.sectionsCount, 1);
  assert.equal(status.totals.warning, 1);

  const written = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.equal(written.REPORT_NAME, 'Security Review');
  assert.equal(written.SITE_NAME, 'Demo');
  assert.equal(written.REVIEW_DATA.sections.length, 1);
});

test('CLI reads --nextStepsFile and folds entries into REVIEW_DATA.nextSteps', (t) => {
  const inputDir = withTempDir(t);
  writeJson(inputDir, 'scan-site.json', { status: 'ok', findings: [], details: {} });

  const nextStepsPath = path.join(inputDir, 'next-steps.json');
  fs.writeFileSync(
    nextStepsPath,
    JSON.stringify(['Fix CSP wildcard', 'Enable rate limiting', 42, null])
  );
  const outPath = path.join(inputDir, 'data.json');

  const result = runCli([
    '--reportName',
    'X',
    '--inputDir',
    inputDir,
    '--siteName',
    'Y',
    '--goalLabel',
    'Z',
    '--scopeLabel',
    'W',
    '--output',
    outPath,
    '--nextStepsFile',
    nextStepsPath,
  ]);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  const written = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.deepEqual(written.REVIEW_DATA.nextSteps, [
    'Fix CSP wildcard',
    'Enable rate limiting',
  ]);
});
