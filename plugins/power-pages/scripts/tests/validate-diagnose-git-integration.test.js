'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const VALIDATOR = path.join(
  __dirname, '..', '..', 'skills', 'diagnose-git-integration',
  'scripts', 'validate-diagnose-git-integration.js'
);

function run(cwd) {
  return spawnSync(process.execPath, [VALIDATOR], {
    input: JSON.stringify({ cwd }),
    encoding: 'utf8',
  });
}

function makeProject(tmpDir, markerData) {
  const innerLoopDir = path.join(tmpDir, 'docs', 'inner-loop');
  fs.mkdirSync(innerLoopDir, { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, 'powerpages.config.json'),
    JSON.stringify({ siteName: 'test', compiledPath: 'dist' })
  );
  if (markerData !== undefined) {
    fs.writeFileSync(
      path.join(innerLoopDir, 'last-diagnosis.json'),
      typeof markerData === 'string' ? markerData : JSON.stringify(markerData)
    );
  }
}

const GOOD_MARKER = {
  skill: 'diagnose-git-integration',
  diagnosedAt: new Date().toISOString(),
  envUrl: 'https://env.crm.dynamics.com',
  mode: 'full-scan',
  symptomInput: '*',
  patternsCovered: ['IL-001', 'IL-003', 'IL-006', 'IL-010'],
  errorCount: 1,
  warningCount: 0,
  infoCount: 1,
  skippedCount: 0,
  findings: [
    {
      patternId: 'IL-003',
      patternName: 'ADO repo not initialized',
      detected: true,
      severity: 'Error',
      evidence: 'verify-repo-initialized.js returned initialized=false',
      autoFixAvailable: true,
      fixDelegate: '/power-pages:git-configure',
      autoFix: { status: 'applied' },
    },
    {
      patternId: 'IL-001',
      patternName: 'Managed Environments disabled',
      detected: false,
      severity: 'Info',
      evidence: 'Managed Env is ON',
      autoFixAvailable: false,
      fixDelegate: null,
    },
  ],
  reportPath: 'docs/inner-loop/diagnosis.html',
  status: 'succeeded',
};

describe('validate-diagnose-git-integration', () => {
  let tmp;

  before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vdiag-test-')); });
  after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('approves when no project root found', () => {
    const r = run(os.tmpdir());
    assert.equal(r.status, 0, r.stderr);
  });

  it('approves when no marker file found', () => {
    const dir = path.join(tmp, 'no-marker');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'powerpages.config.json'), JSON.stringify({ siteName: 'x', compiledPath: 'dist' }));
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
  });

  it('blocks when marker is not valid JSON', () => {
    const dir = path.join(tmp, 'bad-json');
    makeProject(dir, 'NOT JSON');
    const r = run(dir);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, /not valid JSON/);
  });

  it('blocks when required fields are missing', () => {
    const dir = path.join(tmp, 'missing');
    makeProject(dir, { skill: 'diagnose-git-integration' });
    const r = run(dir);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, /missing required fields/);
  });

  it('blocks when status is failed', () => {
    const dir = path.join(tmp, 'failed');
    makeProject(dir, { ...GOOD_MARKER, status: 'failed' });
    const r = run(dir);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, /status=failed/);
  });

  it('blocks when mode is unknown', () => {
    const dir = path.join(tmp, 'bad-mode');
    makeProject(dir, { ...GOOD_MARKER, mode: 'mystery-mode' });
    const r = run(dir);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, /unknown mode/i);
  });

  it('blocks when status is unknown', () => {
    const dir = path.join(tmp, 'bad-status');
    makeProject(dir, { ...GOOD_MARKER, status: 'unknown-state' });
    const r = run(dir);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, /unknown status/i);
  });

  it('blocks when findings is not an array', () => {
    const dir = path.join(tmp, 'bad-findings');
    makeProject(dir, { ...GOOD_MARKER, findings: 'not an array' });
    const r = run(dir);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, /findings must be an array/);
  });

  it('approves when findings is an empty array (clean scan)', () => {
    const dir = path.join(tmp, 'empty-findings');
    makeProject(dir, {
      ...GOOD_MARKER,
      findings: [],
      errorCount: 0,
      warningCount: 0,
      infoCount: 0,
      skippedCount: 0,
    });
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
  });

  it('approves with errorCount > 0 (the whole point of the skill)', () => {
    const dir = path.join(tmp, 'errors-present');
    makeProject(dir, { ...GOOD_MARKER, errorCount: 7 });
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
  });

  it('approves when status is partial (some detectors errored)', () => {
    const dir = path.join(tmp, 'partial');
    makeProject(dir, { ...GOOD_MARKER, status: 'partial', skippedCount: 5 });
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
  });

  it('approves with mode "paste-error"', () => {
    const dir = path.join(tmp, 'paste');
    makeProject(dir, { ...GOOD_MARKER, mode: 'paste-error', symptomInput: 'ConnectToGit returned 400 ...' });
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
  });

  it('approves with mode "describe-symptoms"', () => {
    const dir = path.join(tmp, 'describe');
    makeProject(dir, { ...GOOD_MARKER, mode: 'describe-symptoms', symptomInput: 'commit-to-git failed, binding looks wrong' });
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
  });

  it('approves with complete good marker (full-scan default)', () => {
    const dir = path.join(tmp, 'good');
    makeProject(dir, GOOD_MARKER);
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
  });
});
