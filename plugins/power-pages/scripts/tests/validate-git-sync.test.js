'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const VALIDATOR = path.join(
  __dirname, '..', '..', 'skills', 'git-sync', 'scripts', 'validate-git-sync.js'
);

function run(cwd) {
  return spawnSync(process.execPath, [VALIDATOR], { input: JSON.stringify({ cwd }), encoding: 'utf8' });
}

function makeProject(t, markers = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-git-sync-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const dir = path.join(tmp, 'docs', 'inner-loop');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'powerpages.config.json'), JSON.stringify({ siteName: 'test', compiledPath: 'dist' }));
  const write = (name, data) => { if (data !== undefined) fs.writeFileSync(path.join(dir, name), typeof data === 'string' ? data : JSON.stringify(data)); };
  write('last-commit.json', markers.commit);
  write('last-validation.json', markers.validation);
  write('last-sync.json', markers.sync);
  write('last-conflict-resolution.json', markers.conflict);
  return tmp;
}

const GOOD_COMMIT = { skill: 'git-sync', committedAt: '2026-06-14T00:00:00Z', envUrl: 'https://e.crm.dynamics.com', commitId: 'abc1234', commitMessage: 'Update templates', status: 'succeeded' };
const GOOD_SYNC = { skill: 'git-sync', syncedAt: '2026-06-14T00:00:00Z', envUrl: 'https://e.crm.dynamics.com', status: 'succeeded' };
const GOOD_CONFLICT = { skill: 'git-sync', resolvedAt: '2026-06-14T00:00:00Z', envUrl: 'https://e.crm.dynamics.com', conflictsFound: 2, conflictsResolved: 2, status: 'succeeded', remainingConflicts: 0 };
const GOOD_DRYRUN = { skill: 'git-sync', status: 'dry-run-passed' };

describe('validate-git-sync', () => {
  it('approves when no project root (not a Power Pages project)', (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'no-root-'));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    assert.equal(run(tmp).status, 0);
  });

  it('approves when no markers exist', (t) => {
    assert.equal(run(makeProject(t)).status, 0);
  });

  // ---- commit (real) ----
  it('approves a good real-commit marker', (t) => {
    assert.equal(run(makeProject(t, { commit: GOOD_COMMIT })).status, 0);
  });
  it('blocks real-commit missing commitId', (t) => {
    const r = run(makeProject(t, { commit: { ...GOOD_COMMIT, commitId: '' } }));
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /missing a commitId/);
  });
  it('blocks real-commit status=failed', (t) => {
    const r = run(makeProject(t, { commit: { ...GOOD_COMMIT, status: 'failed' } }));
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /status=failed/);
  });
  it('blocks corrupt last-commit.json', (t) => {
    const r = run(makeProject(t, { commit: '{not json' }));
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /not valid JSON/);
  });

  // ---- commit (dry-run) — only when last-commit.json absent ----
  it('approves a dry-run validation marker (no real commit present)', (t) => {
    assert.equal(run(makeProject(t, { validation: GOOD_DRYRUN })).status, 0);
  });
  it('blocks dry-run with unknown status', (t) => {
    const r = run(makeProject(t, { validation: { status: 'banana' } }));
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /unrecognised status/);
  });
  it('real-commit takes precedence: dry-run ignored when last-commit.json present', (t) => {
    // bad dry-run marker but good commit → still approves (commit wins, dry-run not checked)
    assert.equal(run(makeProject(t, { commit: GOOD_COMMIT, validation: { status: 'banana' } })).status, 0);
  });

  // ---- pull ----
  it('approves a good sync marker', (t) => {
    assert.equal(run(makeProject(t, { sync: GOOD_SYNC })).status, 0);
  });
  it('approves sync status=already-up-to-date', (t) => {
    assert.equal(run(makeProject(t, { sync: { ...GOOD_SYNC, status: 'already-up-to-date' } })).status, 0);
  });
  it('blocks sync status=failed', (t) => {
    const r = run(makeProject(t, { sync: { ...GOOD_SYNC, status: 'failed' } }));
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /status=failed/);
  });
  it('blocks sync missing required field', (t) => {
    const r = run(makeProject(t, { sync: { ...GOOD_SYNC, envUrl: '' } }));
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /missing required fields/);
  });

  // ---- conflict ----
  it('approves a good conflict-resolution marker', (t) => {
    assert.equal(run(makeProject(t, { conflict: GOOD_CONFLICT })).status, 0);
  });
  it('blocks conflict status=failed', (t) => {
    const r = run(makeProject(t, { conflict: { ...GOOD_CONFLICT, status: 'failed' } }));
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /all conflict resolutions failed/);
  });
  it('blocks partial conflict with remainingConflicts > 0', (t) => {
    const r = run(makeProject(t, { conflict: { ...GOOD_CONFLICT, status: 'partial', remainingConflicts: 2 } }));
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /remain unresolved/);
  });
  it('approves partial conflict with remainingConflicts = 0', (t) => {
    assert.equal(run(makeProject(t, { conflict: { ...GOOD_CONFLICT, status: 'partial', remainingConflicts: 0 } })).status, 0);
  });

  // ---- multiple flows in one session (Mixed) ----
  it('validates all present markers; approves when all are good', (t) => {
    assert.equal(run(makeProject(t, { commit: GOOD_COMMIT, sync: GOOD_SYNC, conflict: GOOD_CONFLICT })).status, 0);
  });
  it('blocks if any present marker is bad (e.g. sync failed alongside good commit)', (t) => {
    const r = run(makeProject(t, { commit: GOOD_COMMIT, sync: { ...GOOD_SYNC, status: 'failed' } }));
    assert.notEqual(r.status, 0);
  });

  // ---- legacy markers still validate (skill value not hard-required) ----
  it('accepts a legacy commit-to-git-authored marker (skill != git-sync)', (t) => {
    assert.equal(run(makeProject(t, { commit: { ...GOOD_COMMIT, skill: 'commit-to-git' } })).status, 0);
  });
});
