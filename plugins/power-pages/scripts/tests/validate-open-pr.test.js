'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const VALIDATOR = path.join(
  __dirname, '..', '..', 'skills', 'open-pr',
  'scripts', 'validate-open-pr.js'
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
      path.join(innerLoopDir, 'last-pr.json'),
      typeof markerData === 'string' ? markerData : JSON.stringify(markerData)
    );
  }
}

const GOOD_MARKER = {
  skill: 'open-pr',
  createdAt: new Date().toISOString(),
  envUrl: 'https://env.crm.dynamics.com',
  organization: 'contoso',
  project: 'PowerSite',
  repository: 'site-repo',
  sourceBranch: 'feature/new-ui',
  targetBranch: 'main',
  pullRequestId: 42,
  title: 'Update web templates and add contact-us page',
  url: 'https://dev.azure.com/contoso/PowerSite/_git/site-repo/pullrequest/42',
  reviewers: ['user1@contoso.com'],
  commitCount: 3,
  status: 'active',
};

describe('validate-open-pr', () => {
  let tmp;

  before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vopenpr-test-')); });
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
    makeProject(dir, { skill: 'open-pr' });
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

  it('blocks when pullRequestId is not a positive integer', () => {
    const dir = path.join(tmp, 'bad-pr-id');
    makeProject(dir, { ...GOOD_MARKER, pullRequestId: 0 });
    const r = run(dir);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, /pullRequestId/);
  });

  it('blocks when pullRequestId is a string', () => {
    const dir = path.join(tmp, 'str-pr-id');
    makeProject(dir, { ...GOOD_MARKER, pullRequestId: '42' });
    const r = run(dir);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, /pullRequestId/);
  });

  it('blocks when url is not http(s)', () => {
    const dir = path.join(tmp, 'bad-url');
    makeProject(dir, { ...GOOD_MARKER, url: 'ftp://example.com/pr/42' });
    const r = run(dir);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, /url/);
  });

  it('blocks when sourceBranch equals targetBranch (no-op)', () => {
    const dir = path.join(tmp, 'noop');
    makeProject(dir, { ...GOOD_MARKER, targetBranch: 'feature/new-ui' });
    const r = run(dir);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, /no-op PR/);
  });

  it('blocks when source/target match via refs/heads/ normalization', () => {
    const dir = path.join(tmp, 'noop-refs');
    makeProject(dir, { ...GOOD_MARKER, sourceBranch: 'main', targetBranch: 'refs/heads/main' });
    const r = run(dir);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, /no-op PR/);
  });

  it('approves when marker is complete and valid', () => {
    const dir = path.join(tmp, 'good');
    makeProject(dir, GOOD_MARKER);
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
  });
});
