'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const VALIDATOR = path.join(
  __dirname, '..', '..', 'skills', 'commit-to-git',
  'scripts', 'validate-commit-to-git.js'
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
      path.join(innerLoopDir, 'last-commit.json'),
      typeof markerData === 'string' ? markerData : JSON.stringify(markerData)
    );
  }
}

const GOOD_MARKER = {
  skill: 'commit-to-git',
  committedAt: new Date().toISOString(),
  envUrl: 'https://env.crm.dynamics.com',
  commitId: 'abc1234def5678',
  commitMessage: 'Update web templates',
  branch: 'main',
  componentsCommitted: 3,
  status: 'succeeded',
};

describe('validate-commit-to-git', () => {
  let tmp;

  before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vcommit-test-')); });
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

  it('blocks when required fields missing', () => {
    const dir = path.join(tmp, 'missing');
    makeProject(dir, { skill: 'commit-to-git', status: 'succeeded' });
    const r = run(dir);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, /missing required fields/);
  });

  it('blocks when status is failed', () => {
    const dir = path.join(tmp, 'failed');
    makeProject(dir, { ...GOOD_MARKER, status: 'failed', commitId: 'abc123' });
    const r = run(dir);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, /status=failed/);
  });

  it('blocks when commitId is empty string', () => {
    const dir = path.join(tmp, 'no-sha-empty');
    makeProject(dir, { ...GOOD_MARKER, commitId: '' });
    const r = run(dir);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, /commitId/);
  });

  it('blocks when commitId is missing', () => {
    const dir = path.join(tmp, 'no-sha-missing');
    const { commitId: _, ...rest } = GOOD_MARKER;
    makeProject(dir, rest);
    const r = run(dir);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, /commitId/);
  });

  it('approves when marker is complete and succeeded', () => {
    const dir = path.join(tmp, 'good');
    makeProject(dir, GOOD_MARKER);
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
  });

  it('approves when commitId is a full 40-char SHA', () => {
    const dir = path.join(tmp, 'full-sha');
    makeProject(dir, { ...GOOD_MARKER, commitId: 'a'.repeat(40) });
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
  });

  // --- Dry-run mode (X-4 / D2): last-validation.json present, last-commit.json absent.

  function makeDryRunProject(tmpDir, markerData) {
    const innerLoopDir = path.join(tmpDir, 'docs', 'inner-loop');
    fs.mkdirSync(innerLoopDir, { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'powerpages.config.json'),
      JSON.stringify({ siteName: 'test', compiledPath: 'dist' })
    );
    if (markerData !== undefined) {
      fs.writeFileSync(
        path.join(innerLoopDir, 'last-validation.json'),
        typeof markerData === 'string' ? markerData : JSON.stringify(markerData)
      );
    }
  }

  it('approves dry-run with status=dry-run-passed', () => {
    const dir = path.join(tmp, 'dry-passed');
    makeDryRunProject(dir, { status: 'dry-run-passed', blockers: [], warnings: [] });
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
  });

  it('approves dry-run with status=dry-run-warnings', () => {
    const dir = path.join(tmp, 'dry-warnings');
    makeDryRunProject(dir, { status: 'dry-run-warnings', warnings: [{ id: 'V-12' }] });
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
  });

  it('approves dry-run with status=dry-run-blocked (skill correctly surfaced findings; not a hook failure)', () => {
    const dir = path.join(tmp, 'dry-blocked');
    makeDryRunProject(dir, { status: 'dry-run-blocked', blockers: [{ id: 'V-4' }] });
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
  });

  it('approves dry-run with legacy status=passed (orchestrator-direct invocation)', () => {
    const dir = path.join(tmp, 'dry-passed-legacy');
    makeDryRunProject(dir, { status: 'passed' });
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
  });

  it('approves dry-run with status=clean (count-zero short-circuit)', () => {
    const dir = path.join(tmp, 'dry-clean');
    makeDryRunProject(dir, { status: 'clean' });
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
  });

  it('blocks dry-run with unrecognised status', () => {
    const dir = path.join(tmp, 'dry-bogus');
    makeDryRunProject(dir, { status: 'mystery-status' });
    const r = run(dir);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, /unrecognised status/);
  });

  it('blocks dry-run missing the status field', () => {
    const dir = path.join(tmp, 'dry-no-status');
    makeDryRunProject(dir, { blockers: [] });
    const r = run(dir);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, /missing required field: status/);
  });

  it('blocks dry-run when marker is not valid JSON', () => {
    const dir = path.join(tmp, 'dry-bad-json');
    makeDryRunProject(dir, 'NOT JSON');
    const r = run(dir);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, /last-validation\.json is not valid JSON/);
  });

  it('prefers last-commit.json when both markers exist', () => {
    const dir = path.join(tmp, 'both-markers');
    makeProject(dir, GOOD_MARKER);
    fs.writeFileSync(
      path.join(dir, 'docs', 'inner-loop', 'last-validation.json'),
      JSON.stringify({ status: 'totally-bogus-should-not-be-checked' })
    );
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
  });

  it('blocks real-commit with unrecognised status', () => {
    const dir = path.join(tmp, 'real-bogus');
    makeProject(dir, { ...GOOD_MARKER, status: 'mystery-status' });
    const r = run(dir);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, /unrecognised status/);
  });
});
