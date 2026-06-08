'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const VALIDATOR = path.join(
  __dirname, '..', '..', 'skills', 'branch-switch',
  'scripts', 'validate-branch-switch.js'
);

function run(cwd) {
  return spawnSync(process.execPath, [VALIDATOR], {
    input: JSON.stringify({ cwd }),
    encoding: 'utf8',
  });
}

function makeProject(tmpDir, markerData, manifestData) {
  const innerLoopDir = path.join(tmpDir, 'docs', 'inner-loop');
  fs.mkdirSync(innerLoopDir, { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, 'powerpages.config.json'),
    JSON.stringify({ siteName: 'test', compiledPath: 'dist' })
  );
  if (markerData !== undefined) {
    fs.writeFileSync(
      path.join(innerLoopDir, 'last-branch-switch.json'),
      typeof markerData === 'string' ? markerData : JSON.stringify(markerData)
    );
  }
  if (manifestData !== undefined) {
    fs.writeFileSync(
      path.join(tmpDir, '.git-integration-manifest.json'),
      typeof manifestData === 'string' ? manifestData : JSON.stringify(manifestData)
    );
  }
}

const GOOD_MARKER = {
  skill: 'branch-switch',
  switchedAt: new Date().toISOString(),
  envUrl: 'https://env.crm.dynamics.com',
  organization: 'contoso',
  project: 'PowerSite',
  repository: 'site-repo',
  oldBranch: 'main',
  newBranch: 'feature/new-ui',
  bindingType: 'environment',
  status: 'succeeded',
};

const GOOD_MANIFEST = {
  bindingType: 'environment',
  envUrl: 'https://env.crm.dynamics.com',
  organization: 'contoso',
  project: 'PowerSite',
  repository: 'site-repo',
  branch: 'feature/new-ui',
  gitFolder: 'src',
  boundAt: new Date().toISOString(),
  lastVerifiedAt: new Date().toISOString(),
  lastCommitSha: null,
  manifestVersion: '1',
};

describe('validate-branch-switch', () => {
  let tmp;

  before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vbswitch-test-')); });
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
    makeProject(dir, { skill: 'branch-switch', status: 'succeeded' });
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

  it('blocks when oldBranch equals newBranch (no-op)', () => {
    const dir = path.join(tmp, 'noop');
    makeProject(dir, { ...GOOD_MARKER, newBranch: 'main' });
    const r = run(dir);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, /no-op switch/);
  });

  it('blocks when oldBranch equals newBranch even with refs/heads/ prefix', () => {
    const dir = path.join(tmp, 'noop-refs');
    makeProject(dir, { ...GOOD_MARKER, oldBranch: 'main', newBranch: 'refs/heads/main' });
    const r = run(dir);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, /no-op switch/);
  });

  it('blocks when manifest branch does not match newBranch', () => {
    const dir = path.join(tmp, 'manifest-drift');
    makeProject(dir, GOOD_MARKER, { ...GOOD_MANIFEST, branch: 'main' });
    const r = run(dir);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, /does not match.*newBranch/);
  });

  it('approves when marker complete and manifest matches', () => {
    const dir = path.join(tmp, 'good-with-manifest');
    makeProject(dir, GOOD_MARKER, GOOD_MANIFEST);
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
  });

  it('approves when manifest is absent (marker-only project)', () => {
    const dir = path.join(tmp, 'good-no-manifest');
    makeProject(dir, GOOD_MARKER);
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
  });

  it('approves when manifest branch matches via refs/heads/ normalization', () => {
    const dir = path.join(tmp, 'good-refs');
    makeProject(dir,
      { ...GOOD_MARKER, newBranch: 'feature/new-ui' },
      { ...GOOD_MANIFEST, branch: 'refs/heads/feature/new-ui' }
    );
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
  });
});
