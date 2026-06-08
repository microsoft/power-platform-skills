'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const VALIDATOR = path.join(
  __dirname, '..', '..', 'skills', 'revert-workspace',
  'scripts', 'validate-revert-workspace.js'
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
      path.join(innerLoopDir, 'last-revert.json'),
      typeof markerData === 'string' ? markerData : JSON.stringify(markerData)
    );
  }
}

const GOOD_MARKER = {
  skill: 'revert-workspace',
  revertedAt: new Date().toISOString(),
  envUrl: 'https://env.crm.dynamics.com',
  branch: 'main',
  bindingType: 'environment',
  solutionUniqueName: null,
  changesDiscarded: 5,
  discardedItems: [
    { objectId: 'aaa', name: 'Header', objectType: 'Web Template', changeType: 'modified' },
  ],
  status: 'succeeded',
};

describe('validate-revert-workspace', () => {
  let tmp;

  before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vrevert-test-')); });
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
    makeProject(dir, { skill: 'revert-workspace' });
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

  it('blocks when status is partial', () => {
    const dir = path.join(tmp, 'partial');
    makeProject(dir, { ...GOOD_MARKER, status: 'partial', changesDiscarded: 3 });
    const r = run(dir);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, /partial/);
  });

  it('blocks when status is unknown', () => {
    const dir = path.join(tmp, 'unknown');
    makeProject(dir, { ...GOOD_MARKER, status: 'mystery' });
    const r = run(dir);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, /unknown status/i);
  });

  it('approves when status is succeeded with 0 changesDiscarded', () => {
    // changesDiscarded=0 is unusual but not invalid (e.g. user reverted right
    // after a sync). 0 is a valid number and present-with-value.
    const dir = path.join(tmp, 'zero-discarded');
    makeProject(dir, { ...GOOD_MARKER, changesDiscarded: 0 });
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
  });

  it('approves when status is succeeded', () => {
    const dir = path.join(tmp, 'good');
    makeProject(dir, GOOD_MARKER);
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
  });
});
