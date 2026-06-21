'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { applyMergedComponents, isActionAbsent } = require('../lib/apply-merged-component');

// Isolate the secure merge artifact store (apply now snapshots there by default)
// so fixed runIds can't collide with real merges or across runs.
const STORE_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-merge-store-'));
process.env.PP_MERGE_STORE_ROOT = STORE_BASE;
process.on('exit', () => { try { fs.rmSync(STORE_BASE, { recursive: true, force: true }); } catch { /* best-effort */ } });

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apply-merge-'));
}

const BINDING = { organization: 'GitIntegration22', project: 'srijan-pp-alm', repository: 'Sri-collab', branch: 'feature/dev-a' };
const COMPONENTS = [{
  conflictId: 'g1', componentId: 'c1', name: 'Search', type: 8,
  adoPath: '/solutions/RetailOS/powerpagesites/RetailOS/web-templates/Search/Search.webtemplate.source.html',
  oursContent: 'OURS', mergedContent: 'MERGED',
}];

function deps(overrides = {}) {
  return {
    commitFiles: async () => ({ ok: true, commitId: 'abc123', pushId: 7, fileCount: 1 }),
    refreshChangesFromGit: async () => ({ ok: true }),
    resolveConflictAccept: async () => ({ resolved: true, outcome: 'accept-incoming' }),
    resolveGitConflictUserAction: async () => ({ ok: true, useraction: 2 }),
    pullChangesFromGit: async () => ({ ok: true }),
    listConflicts: async () => ({ count: 0, items: [] }),
    innerLoop: require('../lib/inner-loop-paths'),
    ...overrides,
  };
}

test('validation: rejects missing binding/components/env', async () => {
  await assert.rejects(applyMergedComponents({ binding: {}, components: COMPONENTS, envUrl: 'u', solutionUniqueName: 's' }), /organization/);
  await assert.rejects(applyMergedComponents({ binding: BINDING, components: [], envUrl: 'u', solutionUniqueName: 's' }), /non-empty array/);
  await assert.rejects(applyMergedComponents({ binding: BINDING, components: COMPONENTS, solutionUniqueName: 's' }), /envUrl/);
  await assert.rejects(applyMergedComponents({ binding: BINDING, components: COMPONENTS, envUrl: 'u' }), /solutionUniqueName/);
});

test('dry-run: returns plan, performs no mutations', async () => {
  let committed = false;
  const d = deps({ commitFiles: async () => { committed = true; return { ok: true }; } });
  const r = await applyMergedComponents({ binding: BINDING, components: COMPONENTS, envUrl: 'https://e', solutionUniqueName: 'RetailOS', apply: false, deps: d });
  assert.equal(r.status, 'dry-run');
  assert.equal(r.plan.fileCount, 1);
  assert.deepEqual(r.plan.wouldCommit, [COMPONENTS[0].adoPath]);
  assert.deepEqual(r.plan.wouldAccept, ['g1']);
  assert.equal(committed, false);
});

test('no applicable files (missing adoPath/mergedContent) → failed', async () => {
  const r = await applyMergedComponents({
    binding: BINDING, components: [{ conflictId: 'g', name: 'X', type: 8 }],
    envUrl: 'u', solutionUniqueName: 's', apply: true, deps: deps(),
  });
  assert.equal(r.status, 'failed');
  assert.match(r.error, /No applicable merged files/);
});

test('happy path: commit -> refresh -> accept -> pull -> verify(0) -> succeeded + marker', async () => {
  const root = tmpRoot();
  const order = [];
  const d = deps({
    commitFiles: async () => { order.push('commit'); return { ok: true, commitId: 'deadbeef' }; },
    refreshChangesFromGit: async () => { order.push('refresh'); return { ok: true }; },
    resolveConflictAccept: async () => { order.push('accept'); return { resolved: true }; },
    pullChangesFromGit: async () => { order.push('pull'); return { ok: true }; },
    listConflicts: async () => { order.push('verify'); return { count: 0 }; },
  });
  const r = await applyMergedComponents({ binding: BINDING, components: COMPONENTS, envUrl: 'https://e', solutionUniqueName: 'RetailOS', apply: true, projectRoot: root, runId: 'run-9', deps: d });
  assert.equal(r.status, 'succeeded');
  assert.equal(r.ok, true);
  assert.deepEqual(order, ['commit', 'refresh', 'accept', 'pull', 'verify']);
  assert.equal(r.marker.strategy, 'selective-merge');
  assert.equal(r.marker.adoCommitId, 'deadbeef');
  assert.equal(r.marker.remainingConflicts, 0);
  assert.equal(r.marker.status, 'succeeded');
  // marker persisted
  assert.ok(fs.existsSync(r.markerPath));
  const onDisk = JSON.parse(fs.readFileSync(r.markerPath, 'utf8'));
  assert.equal(onDisk.strategy, 'selective-merge');
  // snapshot written — and to the secure store (off the project/session tree)
  assert.ok(r.marker.snapshotDir && fs.existsSync(r.marker.snapshotDir));
  assert.ok(!r.marker.snapshotDir.includes(root), 'OURS snapshot must not be durable plaintext under the project tree');
  assert.ok(r.marker.snapshotDir.replace(/\\/g, '/').includes('/pp-merge/run-9/snapshot'), 'snapshot lives in the secure run store');
  assert.ok(fs.existsSync(path.join(r.marker.snapshotDir, 'Search.ours.txt')), 'OURS captured for reversibility');
  fs.rmSync(root, { recursive: true, force: true });
});

test('content verify: re-read OURS matches merged result (EOL-normalized) -> verified + succeeded', async () => {
  const root = tmpRoot();
  const COMP = [{ conflictId: 'g1', componentId: 'c1', name: 'Search', type: 8, field: 'source', adoPath: '/x.html', oursContent: 'OLD', mergedContent: 'MERGED\n' }];
  const d = deps({
    commitFiles: async () => ({ ok: true, commitId: 'deadbeef' }),
    listConflicts: async () => ({ count: 0 }),
    // pulled value differs only by EOL — must normalize to equal
    readComponentContent: async () => ({ mergeFields: [{ key: 'source', value: 'MERGED\r\n', isText: true }] }),
  });
  const r = await applyMergedComponents({ binding: BINDING, components: COMP, envUrl: 'https://e', solutionUniqueName: 'RetailOS', apply: true, projectRoot: root, runId: 'cv-1', deps: d });
  assert.equal(r.status, 'succeeded');
  assert.equal(r.contentVerify.length, 1);
  assert.equal(r.contentVerify[0].result, 'verified');
  fs.rmSync(root, { recursive: true, force: true });
});

test('content verify: pulled content diverges from merged -> mismatch + partial + note (no raw content leaked)', async () => {
  const root = tmpRoot();
  const COMP = [{ conflictId: 'g1', componentId: 'c1', name: 'Search', type: 8, field: 'source', adoPath: '/x.html', oursContent: 'OLD', mergedContent: 'line1\nMERGED\nline3\n' }];
  const d = deps({
    commitFiles: async () => ({ ok: true, commitId: 'deadbeef' }),
    listConflicts: async () => ({ count: 0 }),                                  // conflicts cleared...
    readComponentContent: async () => ({ mergeFields: [{ key: 'source', value: 'line1\nDIVERGED\nline3\n', isText: true }] }), // ...but content differs
  });
  const r = await applyMergedComponents({ binding: BINDING, components: COMP, envUrl: 'https://e', solutionUniqueName: 'RetailOS', apply: true, projectRoot: root, runId: 'cv-2', deps: d });
  assert.equal(r.status, 'partial', 'Conflicts->0 but content diverged => not a real success');
  assert.equal(r.contentVerify[0].result, 'mismatch');
  assert.equal(r.contentVerify[0].divergedAtLine, 2);
  // only positional metadata, never the differing text
  assert.equal(r.contentVerify[0].DIVERGED, undefined);
  assert.ok(!JSON.stringify(r.contentVerify).includes('DIVERGED'), 'raw divergent content must not be surfaced');
  assert.match(r.marker.note || '', /does not match/i);
  fs.rmSync(root, { recursive: true, force: true });
});

test('content verify: re-read error -> unverified, does NOT downgrade a clean conflicts->0', async () => {
  const root = tmpRoot();
  const COMP = [{ conflictId: 'g1', componentId: 'c1', name: 'Search', type: 8, field: 'source', adoPath: '/x.html', oursContent: 'OLD', mergedContent: 'MERGED\n' }];
  const d = deps({
    commitFiles: async () => ({ ok: true, commitId: 'deadbeef' }),
    listConflicts: async () => ({ count: 0 }),
    readComponentContent: async () => ({ error: 'token expired' }),
  });
  const r = await applyMergedComponents({ binding: BINDING, components: COMP, envUrl: 'https://e', solutionUniqueName: 'RetailOS', apply: true, projectRoot: root, runId: 'cv-3', deps: d });
  assert.equal(r.status, 'succeeded');
  assert.equal(r.contentVerify[0].result, 'unverified');
  fs.rmSync(root, { recursive: true, force: true });
});

test('auto-resolves solutionId from solutionUniqueName so the useraction accept fires (no manual solutionId)', async () => {
  const root = tmpRoot();
  let uaArgs = null;
  const d = deps({
    commitFiles: async () => ({ ok: true, commitId: 'sha' }),
    listConflicts: async () => ({ count: 0 }),
    resolveSolutionId: async ({ solutionUniqueName, base, token }) => (solutionUniqueName === 'RetailOS' && base && token ? 'resolved-sol-id' : null),
    resolveGitConflictUserAction: async (a) => { uaArgs = a; return { ok: true, useraction: 2 }; },
    // legacy fallback would fail — proves useraction was the path actually taken
    resolveConflictAccept: async () => ({ statusCode: 404, error: "Resource not found for the segment 'ResolveGitConflict'." }),
  });
  const COMP = [{ conflictId: 'g1', componentId: 'c1', name: 'Search', type: 8, adoPath: '/x.html', mergedContent: 'M' }];
  // NOTE: solutionId intentionally NOT passed — only solutionUniqueName.
  const r = await applyMergedComponents({ binding: BINDING, components: COMP, envUrl: 'https://e', solutionUniqueName: 'RetailOS', dvToken: 'tok', apply: true, projectRoot: root, runId: 'autosol-1', deps: d });
  assert.equal(r.status, 'succeeded');
  assert.ok(uaArgs, 'useraction accept was invoked');
  assert.equal(uaArgs.solutionId, 'resolved-sol-id', 'used the auto-resolved solutionId');
  const step = r.steps.find((s) => s.step === 'resolve-solution-id');
  assert.ok(step && step.ok, 'recorded the resolve-solution-id step');
  fs.rmSync(root, { recursive: true, force: true });
});

test('IL-015: ResolveGitConflict absent -> manual-resolution-required, pull NOT called', async () => {
  const root = tmpRoot();
  let pulled = false;
  const d = deps({
    resolveGitConflictUserAction: async () => ({ ok: false, notFound: true }), // useraction row not found
    resolveConflictAccept: async () => ({ error: "Resource not found for the segment 'ResolveGitConflict'.", statusCode: 404 }),
    pullChangesFromGit: async () => { pulled = true; return { ok: true }; },
  });
  const r = await applyMergedComponents({ binding: BINDING, components: COMPONENTS, envUrl: 'https://e', solutionUniqueName: 'RetailOS', apply: true, projectRoot: root, deps: d });
  assert.equal(r.status, 'manual-resolution-required');
  assert.equal(r.ok, true); // committed to ADO; portal step remains
  assert.equal(pulled, false);
  assert.equal(r.marker.resolvedVia, 'maker-portal');
  assert.match(r.marker.note, /Maker Portal/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('useraction accept (IL-015 workaround): when solutionId provided, accepts via useraction and pulls', async () => {
  const root = tmpRoot();
  const order = [];
  let uaCalled = null;
  const d = deps({
    commitFiles: async () => { order.push('commit'); return { ok: true, commitId: 'sha' }; },
    refreshChangesFromGit: async () => { order.push('refresh'); return { ok: true }; },
    resolveGitConflictUserAction: async (a) => { order.push('useraction'); uaCalled = a; return { ok: true, useraction: 2, sourceControlComponentId: 'scc' }; },
    resolveConflictAccept: async () => { order.push('resolvegitconflict'); return { resolved: true }; }, // should NOT be called
    pullChangesFromGit: async () => { order.push('pull'); return { ok: true }; },
    listConflicts: async () => { order.push('verify'); return { count: 0 }; },
  });
  const r = await applyMergedComponents({
    binding: BINDING, components: COMPONENTS, envUrl: 'https://e', solutionUniqueName: 'RetailOS',
    solutionId: '52cdfb68-415e-f111-a826-6045bd08be8b', apply: true, projectRoot: root, deps: d,
  });
  assert.equal(r.status, 'succeeded');
  assert.deepEqual(order, ['commit', 'refresh', 'useraction', 'pull', 'verify']);
  assert.equal(order.includes('resolvegitconflict'), false, 'must not fall back when useraction succeeds');
  assert.equal(uaCalled.decision, 'accept-incoming');
  assert.equal(uaCalled.componentId, COMPONENTS[0].componentId);
  assert.equal(r.marker.decisions[0].strategy, 'selective-merge');
  fs.rmSync(root, { recursive: true, force: true });
});

test('useraction notFound is treated as already-resolved (no ResolveGitConflict fallback, no false manual-resolution)', async () => {
  // Regression for the live-found false escalation (2026-06-21, sri-alm-dev-1): a
  // web template returned useraction notFound (no action=3 row — already converged
  // or now a plain Update), the old code fell through to the absent ResolveGitConflict
  // and wrongly reported manual-resolution-required while the portal showed Conflicts:0.
  const root = tmpRoot();
  const order = [];
  let rgcCalled = false;
  const d = deps({
    resolveGitConflictUserAction: async () => { order.push('useraction'); return { ok: false, notFound: true }; },
    resolveConflictAccept: async () => { rgcCalled = true; order.push('resolvegitconflict'); return { error: "Resource not found for the segment 'ResolveGitConflict'.", statusCode: 404 }; },
    pullChangesFromGit: async () => { order.push('pull'); return { ok: true }; },
    listConflicts: async () => ({ count: 0 }),
  });
  const r = await applyMergedComponents({
    binding: BINDING, components: COMPONENTS, envUrl: 'https://e', solutionUniqueName: 'RetailOS',
    solutionId: 'sol', apply: true, projectRoot: root, deps: d,
  });
  assert.notEqual(r.status, 'manual-resolution-required', 'notFound must NOT escalate to manual-resolution-required');
  assert.equal(r.status, 'succeeded');
  assert.equal(rgcCalled, false, 'must NOT call ResolveGitConflict when useraction reports notFound');
  assert.deepEqual(order, ['useraction', 'pull'], 'skips the ResolveGitConflict fallback, proceeds straight to pull');
  const acc = r.steps.find((s) => s.step === 'accept-incoming');
  assert.ok(acc.results.every((x) => x.result === 'already-resolved'), 'notFound recorded as already-resolved');
  assert.equal(r.marker.conflictsResolved, COMPONENTS.length, 'already-resolved counts toward conflictsResolved');
  fs.rmSync(root, { recursive: true, force: true });
});

test('commit failure → failed, no refresh', async () => {
  const root = tmpRoot();
  let refreshed = false;
  const d = deps({
    commitFiles: async () => ({ ok: false, error: 'push rejected' }),
    refreshChangesFromGit: async () => { refreshed = true; return {}; },
  });
  const r = await applyMergedComponents({ binding: BINDING, components: COMPONENTS, envUrl: 'u', solutionUniqueName: 's', apply: true, projectRoot: root, deps: d });
  assert.equal(r.status, 'failed');
  assert.match(r.error, /ADO commit failed/);
  assert.equal(refreshed, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('refresh failure → partial', async () => {
  const root = tmpRoot();
  const d = deps({ refreshChangesFromGit: async () => ({ error: 'refresh boom' }) });
  const r = await applyMergedComponents({ binding: BINDING, components: COMPONENTS, envUrl: 'u', solutionUniqueName: 's', apply: true, projectRoot: root, deps: d });
  assert.equal(r.status, 'partial');
  assert.match(r.error, /RefreshChangesFromGit failed/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('pull failure → partial', async () => {
  const root = tmpRoot();
  const d = deps({ pullChangesFromGit: async () => ({ error: 'pull boom' }) });
  const r = await applyMergedComponents({ binding: BINDING, components: COMPONENTS, envUrl: 'u', solutionUniqueName: 's', apply: true, projectRoot: root, deps: d });
  assert.equal(r.status, 'partial');
  assert.match(r.error, /PullChangesFromGit failed/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('remaining conflicts after pull → partial', async () => {
  const root = tmpRoot();
  const d = deps({ listConflicts: async () => ({ count: 2 }) });
  const r = await applyMergedComponents({ binding: BINDING, components: COMPONENTS, envUrl: 'u', solutionUniqueName: 's', apply: true, projectRoot: root, deps: d });
  assert.equal(r.status, 'partial');
  assert.equal(r.marker.remainingConflicts, 2);
  fs.rmSync(root, { recursive: true, force: true });
});

test('null verify count (list-conflicts errored) → partial, NEVER false-succeeded (fix #3)', async () => {
  const root = tmpRoot();
  const d = deps({ listConflicts: async () => ({ error: 'token expired' }) }); // no numeric count
  const r = await applyMergedComponents({ binding: BINDING, components: COMPONENTS, envUrl: 'u', solutionUniqueName: 's', apply: true, projectRoot: root, deps: d });
  assert.equal(r.status, 'partial');
  assert.notEqual(r.marker.status, 'succeeded');
  fs.rmSync(root, { recursive: true, force: true });
});

test('failed accept (non-absent) → partial even if verify reports 0; conflictsResolved from actual accepts (fix #3)', async () => {
  const root = tmpRoot();
  const d = deps({
    resolveConflictAccept: async () => ({ error: 'transient 500', statusCode: 500 }),
    listConflicts: async () => ({ count: 0 }),
  });
  const r = await applyMergedComponents({ binding: BINDING, components: COMPONENTS, envUrl: 'u', solutionUniqueName: 's', apply: true, projectRoot: root, deps: d });
  assert.equal(r.status, 'partial');
  assert.equal(r.marker.conflictsResolved, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('isActionAbsent helper', () => {
  assert.equal(isActionAbsent({ statusCode: 404, error: "Resource not found for the segment 'ResolveGitConflict'." }), true);
  assert.equal(isActionAbsent({ statusCode: 404, error: 'some other 404' }), false);
  assert.equal(isActionAbsent({ error: 'ResolveGitConflict missing', statusCode: 404 }), true);
  assert.equal(isActionAbsent(null), false);
});
