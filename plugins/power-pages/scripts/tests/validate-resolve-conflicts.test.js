'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const VALIDATOR = path.join(
  __dirname, '..', '..', 'skills', 'resolve-conflicts',
  'scripts', 'validate-resolve-conflicts.js'
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
      path.join(innerLoopDir, 'last-conflict-resolution.json'),
      typeof markerData === 'string' ? markerData : JSON.stringify(markerData)
    );
  }
}

const GOOD_MARKER = {
  skill: 'resolve-conflicts',
  resolvedAt: new Date().toISOString(),
  envUrl: 'https://env.crm.dynamics.com',
  branch: 'main',
  conflictsFound: 2,
  conflictsResolved: 2,
  remainingConflicts: 0,
  decisions: [
    { objectId: 'aaa', name: 'Header', objectType: 'Web Template', strategy: 'keep-existing' },
    { objectId: 'bbb', name: 'Footer', objectType: 'Web Template', strategy: 'accept-incoming' },
  ],
  status: 'succeeded',
};

describe('validate-resolve-conflicts', () => {
  let tmp;

  before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vconflict-test-')); });
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
    makeProject(dir, { skill: 'resolve-conflicts' });
    const r = run(dir);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, /missing required fields/);
  });

  it('blocks when status is failed', () => {
    const dir = path.join(tmp, 'failed');
    makeProject(dir, { ...GOOD_MARKER, status: 'failed' });
    const r = run(dir);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, /failed/i);
  });

  it('blocks when status is unknown', () => {
    const dir = path.join(tmp, 'unknown');
    makeProject(dir, { ...GOOD_MARKER, status: 'mystery' });
    const r = run(dir);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, /unknown status/i);
  });

  it('blocks when status is partial with remaining conflicts', () => {
    const dir = path.join(tmp, 'partial');
    makeProject(dir, { ...GOOD_MARKER, status: 'partial', conflictsResolved: 1, remainingConflicts: 1 });
    const r = run(dir);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, /remain unresolved/);
  });

  it('approves when status is succeeded with 0 remaining', () => {
    const dir = path.join(tmp, 'succeeded');
    makeProject(dir, GOOD_MARKER);
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
  });

  it('approves when conflictsFound is 0 and status is succeeded', () => {
    const dir = path.join(tmp, 'zero-conflicts');
    makeProject(dir, {
      skill: 'resolve-conflicts',
      resolvedAt: new Date().toISOString(),
      envUrl: 'https://env.crm.dynamics.com',
      conflictsFound: 0,
      conflictsResolved: 0,
      remainingConflicts: 0,
      decisions: [],
      status: 'succeeded',
    });
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
  });

  it('approves when remainingConflicts is not present (defaults to 0)', () => {
    const dir = path.join(tmp, 'no-remaining-field');
    const { remainingConflicts: _, ...rest } = GOOD_MARKER;
    makeProject(dir, rest);
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
  });
});
