'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const VALIDATOR = path.join(
  __dirname, '..', '..', 'skills', 'revert-branch',
  'scripts', 'validate-revert-branch.js'
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
      path.join(innerLoopDir, 'last-branch-revert.json'),
      typeof markerData === 'string' ? markerData : JSON.stringify(markerData)
    );
  }
}

const SHA_OLD = 'a'.repeat(40);
const SHA_NEW = 'b'.repeat(40);

const GOOD_MARKER = {
  skill: 'revert-branch',
  revertedAt: new Date().toISOString(),
  envUrl: 'https://env.crm.dynamics.com',
  organization: 'contoso',
  project: 'PowerSite',
  repository: 'site-repo',
  branch: 'main',
  previousHeadSha: SHA_OLD,
  targetSha: SHA_NEW,
  discardedCommitCount: 3,
  discardedCommits: [
    { sha: 'c'.repeat(40), author: 'alice@contoso.com', messageFirstLine: 'bad commit' },
  ],
  affectedEnvsEstimate: 2,
  status: 'succeeded',
};

describe('validate-revert-branch', () => {
  let tmp;

  before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vbrevert-test-')); });
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
    makeProject(dir, { skill: 'revert-branch' });
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

  it('blocks when previousHeadSha is not 40-char hex', () => {
    const dir = path.join(tmp, 'short-sha-old');
    makeProject(dir, { ...GOOD_MARKER, previousHeadSha: 'abc1234' });
    const r = run(dir);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, /previousHeadSha.*not a 40-char/);
  });

  it('blocks when targetSha is not 40-char hex', () => {
    const dir = path.join(tmp, 'short-sha-new');
    makeProject(dir, { ...GOOD_MARKER, targetSha: 'xyz' });
    const r = run(dir);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, /targetSha.*not a 40-char/);
  });

  it('blocks when previousHeadSha contains non-hex chars', () => {
    const dir = path.join(tmp, 'nonhex');
    makeProject(dir, { ...GOOD_MARKER, previousHeadSha: 'z'.repeat(40) });
    const r = run(dir);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, /not a 40-char/);
  });

  it('blocks when previousHeadSha equals targetSha (no-op)', () => {
    const dir = path.join(tmp, 'noop');
    makeProject(dir, { ...GOOD_MARKER, targetSha: SHA_OLD });
    const r = run(dir);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, /no-op/);
  });

  it('approves when marker is complete and valid', () => {
    const dir = path.join(tmp, 'good');
    makeProject(dir, GOOD_MARKER);
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
  });

  it('approves when affectedEnvsEstimate is "unknown" (query failed)', () => {
    const dir = path.join(tmp, 'unknown-impact');
    makeProject(dir, { ...GOOD_MARKER, affectedEnvsEstimate: 'unknown' });
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
  });

  it('approves when SHAs use uppercase hex', () => {
    const dir = path.join(tmp, 'upper-hex');
    makeProject(dir, {
      ...GOOD_MARKER,
      previousHeadSha: 'A'.repeat(40),
      targetSha: 'B'.repeat(40),
    });
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
  });
});
