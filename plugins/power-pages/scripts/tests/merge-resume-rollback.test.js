'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isolate the secure store (snapshot + run-state live there).
const STORE_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-rollback-store-'));
process.env.PP_MERGE_STORE_ROOT = STORE_BASE;
process.on('exit', () => { try { fs.rmSync(STORE_BASE, { recursive: true, force: true }); } catch { /* best-effort */ } });

const { applyMergedComponents, resumeMergeApply, rollbackMergeApply } = require('../lib/apply-merged-component');
const { readRunState } = require('../lib/merge-run-state');
const { secureWipeRun } = require('../lib/merge-artifact-store');

const BINDING = { organization: 'GitIntegration22', project: 'srijan-pp-alm', repository: 'Sri-collab', branch: 'feature/dev-a' };

function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'rr-')); }

function deps(overrides = {}) {
  return {
    commitFiles: async () => ({ ok: true, commitId: 'sha-default' }),
    refreshChangesFromGit: async () => ({ ok: true }),
    resolveConflictAccept: async () => ({ resolved: true }),
    resolveGitConflictUserAction: async () => ({ ok: true, useraction: 2 }),
    pullChangesFromGit: async () => ({ ok: true }),
    listConflicts: async () => ({ count: 0 }),
    innerLoop: require('../lib/inner-loop-paths'),
    ...overrides,
  };
}

const COMP = () => ([{ conflictId: 'g1', componentId: 'c1', name: 'Search', type: 8, field: 'source', adoPath: '/x.html', oursContent: 'ORIGINAL\n', mergedContent: 'MERGED\n' }]);

test('resume: a run that died after accept (pull failed) resumes pull -> verify without repeating commit/accept', async () => {
  const root = tmpRoot();
  const RUN = 'rr-resume-1';
  try {
    // 1st attempt — pull fails, leaving state at 'accepted'.
    let calls = [];
    const d1 = deps({
      commitFiles: async () => { calls.push('commit'); return { ok: true, commitId: 'sha1' }; },
      refreshChangesFromGit: async () => { calls.push('refresh'); return { ok: true }; },
      resolveConflictAccept: async () => { calls.push('accept'); return { resolved: true }; },
      pullChangesFromGit: async () => { calls.push('pull'); return { error: 'pull boom' }; },
      listConflicts: async () => { calls.push('verify'); return { count: 0 }; },
    });
    const r1 = await applyMergedComponents({ binding: BINDING, components: COMP(), envUrl: 'https://e', solutionUniqueName: 'S', apply: true, projectRoot: root, runId: RUN, deps: d1 });
    assert.equal(r1.status, 'partial');
    const st = readRunState(RUN);
    assert.equal(st.phase, 'accepted', 'committed + accepted done, pull outstanding');
    assert.equal(st.commitId, 'sha1');

    // Resume — pull now succeeds. Commit/accept MUST NOT repeat.
    calls = [];
    const d2 = deps({
      commitFiles: async () => { calls.push('commit'); return { ok: true, commitId: 'SHOULD-NOT-RUN' }; },
      refreshChangesFromGit: async () => { calls.push('refresh'); return { ok: true }; },
      resolveConflictAccept: async () => { calls.push('accept'); return { resolved: true }; },
      pullChangesFromGit: async () => { calls.push('pull'); return { ok: true }; },
      listConflicts: async () => { calls.push('verify'); return { count: 0 }; },
    });
    const r2 = await resumeMergeApply({ runId: RUN, projectRoot: root, deps: d2 });
    assert.equal(r2.status, 'succeeded');
    assert.ok(!calls.includes('commit'), 'commit not repeated on resume');
    assert.ok(!calls.includes('accept'), 'accept not repeated on resume');
    assert.ok(calls.includes('pull'), 'pull retried');
    assert.equal(r2.marker.adoCommitId, 'sha1', 'reuses the original ADO commit');
    assert.equal(readRunState(RUN).phase, 'verified');
  } finally { secureWipeRun(RUN); fs.rmSync(root, { recursive: true, force: true }); }
});

test('resume: no run-state -> actionable failure', async () => {
  const r = await resumeMergeApply({ runId: 'rr-none-' + Date.now() });
  assert.equal(r.ok, false);
  assert.match(r.error, /No resumable run-state/);
});

test('resume: an already-verified run is a no-op success', async () => {
  const root = tmpRoot();
  const RUN = 'rr-done-1';
  try {
    const r1 = await applyMergedComponents({ binding: BINDING, components: COMP(), envUrl: 'https://e', solutionUniqueName: 'S', apply: true, projectRoot: root, runId: RUN, deps: deps() });
    assert.equal(r1.status, 'succeeded');
    assert.equal(readRunState(RUN).phase, 'verified');
    const r2 = await resumeMergeApply({ runId: RUN, projectRoot: root, deps: deps() });
    assert.equal(r2.ok, true);
    assert.equal(r2.status, 'succeeded');
    assert.match(r2.note, /already completed/i);
  } finally { secureWipeRun(RUN); fs.rmSync(root, { recursive: true, force: true }); }
});

test('rollback: restores the pre-merge OURS via a new ADO commit (no history rewrite)', async () => {
  const root = tmpRoot();
  const RUN = 'rr-rollback-1';
  try {
    // Apply the merge first.
    const committed = [];
    const dApply = deps({ commitFiles: async ({ changes }) => { committed.push(...changes); return { ok: true, commitId: 'sha-merge' }; } });
    const r1 = await applyMergedComponents({ binding: BINDING, components: COMP(), envUrl: 'https://e', solutionUniqueName: 'S', apply: true, projectRoot: root, runId: RUN, deps: dApply });
    assert.equal(r1.status, 'succeeded');
    assert.equal(committed[0].content, 'MERGED\n');

    // Roll back — commits OURS back, pulls it in.
    const rolled = [];
    const dRoll = deps({ commitFiles: async ({ changes }) => { rolled.push(...changes); return { ok: true, commitId: 'sha-rollback' }; } });
    const rb = await rollbackMergeApply({ runId: RUN, projectRoot: root, deps: dRoll });
    assert.equal(rb.status, 'succeeded');
    assert.equal(rolled.length, 1);
    assert.equal(rolled[0].content, 'ORIGINAL\n', 'rollback re-commits the pre-merge OURS');
    assert.equal(rolled[0].path, '/x.html');
    assert.equal(rb.rollbackRunId, RUN + '-rollback');
    assert.equal(readRunState(RUN).phase, 'rolledback', 'original run marked rolled back');
  } finally { secureWipeRun(RUN); secureWipeRun(RUN + '-rollback'); fs.rmSync(root, { recursive: true, force: true }); }
});

test('rollback: no run-state -> actionable failure', async () => {
  const r = await rollbackMergeApply({ runId: 'rr-norollback-' + Date.now() });
  assert.equal(r.ok, false);
  assert.match(r.error, /No run-state/);
});

test('resume preserves the original OURS snapshot (does not re-snapshot the now-merged env)', async () => {
  const root = tmpRoot();
  const RUN = 'rr-snap-1';
  try {
    const d1 = deps({ pullChangesFromGit: async () => ({ error: 'pull boom' }) });
    await applyMergedComponents({ binding: BINDING, components: COMP(), envUrl: 'https://e', solutionUniqueName: 'S', apply: true, projectRoot: root, runId: RUN, deps: d1 });
    const st = readRunState(RUN);
    const oursPath = path.join(st.snapshotDir, 'Search.ours.txt');
    assert.equal(fs.readFileSync(oursPath, 'utf8'), 'ORIGINAL\n');
    // Resume should not overwrite the snapshot.
    await resumeMergeApply({ runId: RUN, projectRoot: root, deps: deps() });
    assert.equal(fs.readFileSync(oursPath, 'utf8'), 'ORIGINAL\n', 'OURS snapshot preserved across resume');
  } finally { secureWipeRun(RUN); fs.rmSync(root, { recursive: true, force: true }); }
});
