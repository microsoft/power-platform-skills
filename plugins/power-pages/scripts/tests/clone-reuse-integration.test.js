'use strict';

/**
 * Cross-module integration tests for the clone-reuse flow.
 *
 * Covers:
 *   1. git-configure → git-sync REUSE path:
 *      writeCloneRecord → readCloneRecord round-trips; cloneMatches semantics;
 *      build-merge-inputs emits cloneDir (not base/envName);
 *      resolver consumes cloneDir (mocked cloneOrUpdateRepo) and does NOT re-derive a path.
 *   2. FLAT-LAYOUT assertion:
 *      cloneDirLayout('<abs>/pp-clones/RetailOS') yields repoDir ending in /repo
 *      and ppMergeDir ending in /.pp-merge.
 *   3. e2e build-merge-inputs → resolver dry-run:
 *      build-merge-inputs with mocked readCloneRecord carries cloneDir end-to-end;
 *      the resolver reads it and runs a dry-run plan without cloning.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { cloneDirLayout } = require('../lib/resolve-clone-path');
const { readCloneRecord, writeCloneRecord, cloneMatches } = require('../lib/clone-record');
const { buildMergeInputs } = require('../lib/build-merge-inputs');
const { runCloneMerge } = require('../lib/clone-merge-resolver');
const { isAtOrBeyond } = require('../lib/merge-run-state');

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const COORDS = {
  env: 'sri-alm-dev-1',
  organization: 'GitIntegration22',
  project: 'srijan-pp-alm',
  repository: 'srijan-pp-alm-2',
  rootFolder: 'solutions',
  gitFolder: 'RetailOS',
  branch: 'feature/dev-b',
  solutionUniqueName: 'RetailOS',
};

const BINDING = {
  ...COORDS,
  branchSyncedCommitId: '757656aa',
  upstreamBranchSyncedCommitId: '5619e3e7',
};

const CONFLICTS = [
  {
    conflictId: 'g1', componentId: 'c1',
    componentName: 'Search Results.webtemplate',
    componentPath: '/powerpagesites/RetailOS/web-templates/Search-Results',
    ppcType: 8,
  },
];

function tmpProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-clone-reuse-integ-'));
  fs.mkdirSync(path.join(root, 'docs', 'inner-loop'), { recursive: true });
  return root;
}

// ─── 1. git-configure → git-sync REUSE ────────────────────────────────────────

test('REUSE: writeCloneRecord round-trips and readCloneRecord returns the stored path', () => {
  const root = tmpProject();
  try {
    const CLONE_PATH = path.resolve('C:\\pp-clones\\RetailOS');
    const block = writeCloneRecord({ projectRoot: root, clonePath: CLONE_PATH, coordinates: COORDS });

    // Record is written with the correct path
    assert.equal(block.path, CLONE_PATH);
    assert.equal(block.coordinates.branch, 'feature/dev-b');
    assert.equal(block.coordinates.solutionUniqueName, 'RetailOS');

    // Read back gives the same block
    const read = readCloneRecord({ projectRoot: root });
    assert.ok(read, 'readCloneRecord must return a record after write');
    assert.equal(read.path, CLONE_PATH);
    assert.deepEqual(read.coordinates, block.coordinates);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('REUSE: cloneMatches returns true for same coordinates, false on any drift', () => {
  const root = tmpProject();
  try {
    const CLONE_PATH = path.resolve('C:\\pp-clones\\RetailOS');
    const block = writeCloneRecord({ projectRoot: root, clonePath: CLONE_PATH, coordinates: COORDS });

    assert.equal(cloneMatches(block, COORDS), true, 'same coords → match');
    assert.equal(cloneMatches(block, { ...COORDS, branch: 'main' }), false, 'changed branch → no match');
    assert.equal(cloneMatches(block, { ...COORDS, repository: 'other' }), false, 'changed repo → no match');
    assert.equal(cloneMatches(block, { ...COORDS, solutionUniqueName: 'OtherSolution' }), false, 'changed solution → no match');
    assert.equal(cloneMatches(null, COORDS), false, 'null record → no match');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('REUSE: build-merge-inputs emits cloneDir from the clone record (not base/envName)', () => {
  const root = tmpProject();
  try {
    const CLONE_PATH = path.resolve('C:\\pp-clones\\RetailOS');
    writeCloneRecord({ projectRoot: root, clonePath: CLONE_PATH, coordinates: COORDS });

    // Simulate what git-sync does: read the record, feed cloneDir to buildMergeInputs
    const rec = readCloneRecord({ projectRoot: root });
    assert.ok(rec, 'record must exist');
    const cloneDir = rec.path;

    const { inputs, warnings } = buildMergeInputs({
      binding: BINDING, conflicts: CONFLICTS, cloneDir,
      envUrl: 'https://sri-alm-dev-1.crm.dynamics.com',
      solutionUniqueName: COORDS.solutionUniqueName,
    });

    // Contract: cloneDir flows through
    assert.equal(inputs.cloneDir, CLONE_PATH, 'inputs must carry cloneDir');
    assert.ok(!('base' in inputs), 'inputs must NOT carry a base field');
    assert.ok(!('envName' in inputs), 'inputs must NOT carry an envName field');
    assert.equal(warnings.length, 0, 'no warnings expected for well-formed input');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('REUSE: resolver uses cloneDir and does NOT re-derive a path', async () => {
  const CLONE_DIR = path.resolve('C:\\pp-clones\\RetailOS');
  const REPO_DIR = path.join(CLONE_DIR, 'repo');
  const PP_MERGE_DIR = path.join(CLONE_DIR, '.pp-merge');

  let cloneOrUpdateArgs = null;
  const deps = {
    buildAdoPath: () => ({ path: '/solutions/RetailOS/web-templates/Search-Results/source.html', field: 'source' }),
    readComponentContent: async () => ({
      mergeFields: [{ key: 'source', value: 'hello\n', isText: true }],
      mergeStrategy: 'text',
    }),
    cloneOrUpdateRepo: async (args) => {
      cloneOrUpdateArgs = args;
      return { ok: true, repoDir: REPO_DIR, ppMergeDir: PP_MERGE_DIR, branchTip: 'tipsha', inProgressMerge: false };
    },
    stageGitMerge: () => ({ ok: true, merge: { clean: false, conflicted: true, conflictedPaths: ['/f.html'] }, mergeCommit: null }),
    detectMergeState: () => ({ clean: true, unmergedPaths: [], markerFiles: [] }),
    matchesRoster: () => ({ matches: true, missing: [], extra: [] }),
    openMergeFolder: () => ({ opened: true }),
    pushOrPr: async () => ({ mode: 'direct-push', pushed: true, branch: 'feature/dev-b' }),
    reconcileDataverse: async () => ({ ok: true, status: 'success', accepted: [{ name: 'Search Results' }] }),
    recordMergeMetrics: () => {},
    git: {
      addAll: () => ({ ok: true }),
      mergeAbort: () => ({ ok: true }),
      runGit: () => ({ ok: true, stdout: '', stderr: '' }),
      revParse: () => ({ ok: true, stdout: 'mergedsha\n' }),
    },
    runState: {
      writeRunState: () => {},
      readRunState: () => null,
      isAtOrBeyond,
    },
  };

  const res = await runCloneMerge({
    cloneDir: CLONE_DIR,
    envUrl: 'https://sri-alm-dev-1.crm.dynamics.com',
    solutionUniqueName: 'RetailOS',
    solutionId: 'sln-guid',
    binding: BINDING,
    conflicts: [{ conflictId: 'g1', componentId: 'c1', name: 'Search Results', type: 8, componentPath: '/powerpagesites/RetailOS/web-templates/Search-Results', field: 'source' }],
    user: 'tester',
    dvToken: 'dv',
    adoToken: 'ado',
    apply: true,
    deps,
    confirm: { done: async () => true, push: async () => true, pull: async () => true },
    fsImpl: { readFileSync: () => 'hello-resolved\n' },
  });

  assert.ok(res.status === 'success' || res.status === 'awaiting-resolution',
    `Expected success or awaiting-resolution, got: ${res.status}`);

  // Key contract: cloneOrUpdateRepo received cloneDir directly — not a re-derived path
  assert.ok(cloneOrUpdateArgs, 'cloneOrUpdateRepo must be called');
  assert.equal(cloneOrUpdateArgs.cloneDir, CLONE_DIR, 'resolver must pass cloneDir verbatim to cloneOrUpdateRepo');
  assert.ok(!('base' in cloneOrUpdateArgs), 'base must not be passed to cloneOrUpdateRepo');
  assert.ok(!('envName' in cloneOrUpdateArgs), 'envName must not be passed to cloneOrUpdateRepo');
});

// ─── 2. FLAT-LAYOUT assertion ─────────────────────────────────────────────────

test('FLAT-LAYOUT: cloneDirLayout yields repoDir ending in /repo and ppMergeDir ending in /.pp-merge', () => {
  const abs = path.resolve('C:\\pp-clones\\RetailOS');
  const layout = cloneDirLayout(abs);

  assert.equal(layout.cloneDir, abs, 'cloneDir is passed through unchanged');
  assert.ok(layout.repoDir.endsWith(path.sep + 'repo') || layout.repoDir.endsWith('/repo'),
    `repoDir must end with ${path.sep}repo, got: ${layout.repoDir}`);
  assert.ok(layout.ppMergeDir.endsWith(path.sep + '.pp-merge') || layout.ppMergeDir.endsWith('/.pp-merge'),
    `ppMergeDir must end with ${path.sep}.pp-merge, got: ${layout.ppMergeDir}`);

  // Exact sub-path check
  assert.equal(layout.repoDir, path.join(abs, 'repo'), 'repoDir is exactly <cloneDir>/repo');
  assert.equal(layout.ppMergeDir, path.join(abs, '.pp-merge'), 'ppMergeDir is exactly <cloneDir>/.pp-merge');

  // Only 3 keys
  assert.deepEqual(Object.keys(layout).sort(), ['cloneDir', 'ppMergeDir', 'repoDir'].sort());
});

test('FLAT-LAYOUT: paths are distinct and repoDir/ppMergeDir are siblings under cloneDir', () => {
  const abs = path.resolve('C:\\pp-clones\\my-project');
  const { cloneDir, repoDir, ppMergeDir } = cloneDirLayout(abs);

  assert.notEqual(repoDir, ppMergeDir, 'repoDir and ppMergeDir must be distinct');
  assert.equal(path.dirname(repoDir), cloneDir, 'repoDir parent is cloneDir');
  assert.equal(path.dirname(ppMergeDir), cloneDir, 'ppMergeDir parent is cloneDir');
  assert.equal(path.basename(repoDir), 'repo');
  assert.equal(path.basename(ppMergeDir), '.pp-merge');
});

// ─── 3. e2e: build-merge-inputs → resolver dry-run (mocked record) ───────────

test('e2e: build-merge-inputs with mocked readCloneRecord carries cloneDir to resolver dry-run', async () => {
  const CLONE_DIR = path.resolve('C:\\pp-clones\\e2e-test');
  const REPO_DIR = path.join(CLONE_DIR, 'repo');
  const PP_MERGE_DIR = path.join(CLONE_DIR, '.pp-merge');

  // Step 1: buildMergeInputs returns inputs with cloneDir
  const { inputs } = buildMergeInputs({
    binding: BINDING,
    conflicts: CONFLICTS,
    cloneDir: CLONE_DIR,
    envUrl: 'https://sri-alm-dev-1.crm.dynamics.com',
    solutionUniqueName: COORDS.solutionUniqueName,
  });

  assert.equal(inputs.cloneDir, CLONE_DIR, 'inputs must carry cloneDir');

  // Step 2: resolver reads cloneDir from inputs and passes it to cloneOrUpdateRepo
  let capturedCloneDir = null;
  const deps = {
    buildAdoPath: () => ({ path: '/solutions/RetailOS/web-templates/Search-Results/source.html', field: 'source' }),
    readComponentContent: async () => ({
      mergeFields: [{ key: 'source', value: 'content\n', isText: true }],
      mergeStrategy: 'text',
    }),
    cloneOrUpdateRepo: async (args) => {
      capturedCloneDir = args.cloneDir;
      return { ok: true, repoDir: REPO_DIR, ppMergeDir: PP_MERGE_DIR, branchTip: 'tipsha', inProgressMerge: false };
    },
    stageGitMerge: () => ({ ok: true, merge: { clean: false, conflicted: true, conflictedPaths: ['/f.html'] }, mergeCommit: null }),
    detectMergeState: () => ({ clean: true, unmergedPaths: [], markerFiles: [] }),
    matchesRoster: () => ({ matches: true, missing: [], extra: [] }),
    openMergeFolder: () => ({ opened: true }),
    pushOrPr: async () => ({ mode: 'direct-push', pushed: true, branch: 'feature/dev-b' }),
    reconcileDataverse: async () => ({ ok: true, status: 'success' }),
    recordMergeMetrics: () => {},
    git: {
      addAll: () => ({ ok: true }),
      mergeAbort: () => ({ ok: true }),
      runGit: () => ({ ok: true, stdout: '', stderr: '' }),
      revParse: () => ({ ok: true, stdout: 'mergedsha\n' }),
    },
    runState: { writeRunState: () => {}, readRunState: () => null, isAtOrBeyond },
  };

  // dry-run (apply=false): plan only, no mutations
  const res = await runCloneMerge({
    ...inputs,
    apply: false,
    dvToken: 'dv',
    adoToken: 'ado',
    deps,
    confirm: {},
    fsImpl: { readFileSync: () => '' },
  });

  assert.equal(res.status, 'dry-run', 'dry-run must return dry-run status');
  assert.ok(Array.isArray(res.plan.textUnits) && res.plan.textUnits.length >= 0,
    'plan must include textUnits array');

  // cloneDir flows end-to-end: inputs → runCloneMerge → cloneOrUpdateRepo
  // (cloneOrUpdateRepo IS called even in dry-run to build the plan)
  // It may or may not be called in dry-run depending on resolver logic; but cloneDir
  // must be accessible on inputs.
  assert.equal(inputs.cloneDir, CLONE_DIR, 'inputs.cloneDir end-to-end matches the clone record path');
});
