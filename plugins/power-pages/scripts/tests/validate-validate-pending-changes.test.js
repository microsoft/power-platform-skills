'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const VALIDATOR = path.join(
  __dirname, '..', '..', 'skills', 'validate-pending-changes',
  'scripts', 'validate-validate-pending-changes.js'
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
  // Create a powerpages.config.json so findProjectRoot resolves
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

describe('validate-validate-pending-changes', () => {
  let tmp;

  before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vval-test-')); });
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
    const dir = path.join(tmp, 'missing-fields');
    makeProject(dir, { skill: 'validate-pending-changes' }); // missing validatedAt, envUrl, status
    const r = run(dir);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, /missing required fields/);
  });

  it('blocks when status is blocked', () => {
    const dir = path.join(tmp, 'blocked');
    makeProject(dir, {
      skill: 'validate-pending-changes',
      validatedAt: new Date().toISOString(),
      envUrl: 'https://env.crm.dynamics.com',
      status: 'blocked',
      blockers: [{ validator: 'validate-file-sizes', component: 'foo.msapp', detail: '20 MB > 17 MB cap' }],
    });
    const r = run(dir);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, /blocker/i);
  });

  it('blocks when status is an unknown value', () => {
    const dir = path.join(tmp, 'unknown-status');
    makeProject(dir, {
      skill: 'validate-pending-changes',
      validatedAt: new Date().toISOString(),
      envUrl: 'https://env.crm.dynamics.com',
      status: 'mystery',
    });
    const r = run(dir);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, /unknown status/i);
  });

  it('approves when status is passed', () => {
    const dir = path.join(tmp, 'passed');
    makeProject(dir, {
      skill: 'validate-pending-changes',
      validatedAt: new Date().toISOString(),
      envUrl: 'https://env.crm.dynamics.com',
      pendingChangesCount: 3,
      blockers: [],
      warnings: [],
      status: 'passed',
    });
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
  });

  it('approves when status is warnings (no blockers)', () => {
    const dir = path.join(tmp, 'warnings');
    makeProject(dir, {
      skill: 'validate-pending-changes',
      validatedAt: new Date().toISOString(),
      envUrl: 'https://env.crm.dynamics.com',
      pendingChangesCount: 1,
      blockers: [],
      warnings: [{ validator: 'check-large-canvas-warning', component: 'App', detail: '6 MB canvas' }],
      status: 'warnings',
    });
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
  });

  it('approves when status is clean (nothing to validate)', () => {
    const dir = path.join(tmp, 'clean');
    makeProject(dir, {
      skill: 'validate-pending-changes',
      validatedAt: new Date().toISOString(),
      envUrl: 'https://env.crm.dynamics.com',
      pendingChangesCount: 0,
      blockers: [],
      warnings: [],
      status: 'clean',
    });
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
  });
});
