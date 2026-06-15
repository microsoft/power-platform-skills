'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  refreshInnerLoopPlanData,
  classifyState,
  PHASES,
} = require('../lib/refresh-inner-loop-plan-data');

function tempProject(planData) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-inner-loop-'));
  if (planData !== null && planData !== undefined) {
    fs.mkdirSync(path.join(dir, 'docs', 'inner-loop'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'docs', 'inner-loop', 'inner-loop-plan.json'),
      JSON.stringify(planData),
      'utf8',
    );
  }
  return dir;
}

function writeMarker(dir, fileName, body) {
  fs.mkdirSync(path.join(dir, 'docs', 'inner-loop'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'inner-loop', fileName), JSON.stringify(body), 'utf8');
}

function readPlan(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'docs', 'inner-loop', 'inner-loop-plan.json'), 'utf8'));
}

function cleanup(dir) { fs.rmSync(dir, { recursive: true, force: true }); }

// ===== classifyState (pure function) =====

test('classifyState: returns Disconnected when binding is null', () => {
  assert.equal(classifyState(null, { changes: 0, updates: 0, conflicts: 0 }), 'Disconnected');
});

test('classifyState: returns null when counts are missing (caller must populate)', () => {
  assert.equal(classifyState({ bindingType: 'environment' }, null), null);
});

test('classifyState: Conflicted takes precedence over Mixed/Dirty/Stale', () => {
  const b = { bindingType: 'environment' };
  assert.equal(classifyState(b, { changes: 3, updates: 2, conflicts: 1 }), 'Conflicted');
});

test('classifyState: Mixed when both changes and updates are pending (no conflicts)', () => {
  assert.equal(classifyState({ bindingType: 'environment' }, { changes: 3, updates: 2, conflicts: 0 }), 'Mixed');
});

test('classifyState: Dirty when only changes are pending', () => {
  assert.equal(classifyState({ bindingType: 'environment' }, { changes: 3, updates: 0, conflicts: 0 }), 'Dirty');
});

test('classifyState: Stale when only updates are pending', () => {
  assert.equal(classifyState({ bindingType: 'environment' }, { changes: 0, updates: 4, conflicts: 0 }), 'Stale');
});

test('classifyState: Connected & Clean when everything is zero', () => {
  assert.equal(classifyState({ bindingType: 'environment' }, { changes: 0, updates: 0, conflicts: 0 }), 'Connected & Clean');
});

// ===== refreshInnerLoopPlanData — soft no-op cases =====

test('returns ok:false / plan-not-found when no plan file exists', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-noplan-'));
  try {
    const r = await refreshInnerLoopPlanData({ projectRoot: dir, phase: 'commit-to-git' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'plan-not-found');
  } finally { cleanup(dir); }
});

test('returns ok:false / plan-unparseable when plan file is malformed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-bad-'));
  try {
    fs.mkdirSync(path.join(dir, 'docs', 'inner-loop'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'docs', 'inner-loop', 'inner-loop-plan.json'), '{not json');
    const r = await refreshInnerLoopPlanData({ projectRoot: dir, phase: 'commit-to-git' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'plan-unparseable');
  } finally { cleanup(dir); }
});

test('requires --projectRoot and --phase', async () => {
  await assert.rejects(() => refreshInnerLoopPlanData({}), /projectRoot is required/);
  await assert.rejects(() => refreshInnerLoopPlanData({ projectRoot: '/tmp' }), /phase is required/);
});

test('rejects unknown phase', async () => {
  const dir = tempProject({ PLAN_STATUS: 'In Execution' });
  try {
    await assert.rejects(
      () => refreshInnerLoopPlanData({ projectRoot: dir, phase: 'not-a-phase' }),
      /Unknown phase/,
    );
  } finally { cleanup(dir); }
});

test('PHASES set covers the long-lived inner-loop refresh phases plus finalize', () => {
  // Snapshot: locks the phase vocabulary so a new skill must explicitly extend
  // the handler map alongside the test.
  const expected = [
    'git-configure',
    'commit-to-git',
    'sync-from-git',
    'resolve-conflicts',
    'revert-workspace',
    'revert-branch',
    'open-pr',
    'diagnose',
    'finalize',
  ];
  assert.deepEqual(Array.from(PHASES).sort(), expected.slice().sort());
});

// ===== Per-phase handlers =====

test('git-configure setup: ingests binding from last-git-configure.json, sets state=Connected & Clean', async () => {
  const dir = tempProject({ PLAN_STATUS: 'In Execution' });
  writeMarker(dir, 'last-git-configure.json', {
    skill: 'git-configure',
    mode: 'setup',
    status: 'ok',
    bindingType: 'environment',
    organization: 'contoso',
    project: 'pp-site',
    repository: 'pp-site-repo',
    branch: 'main',
    gitFolder: '/site-name',
    ranAt: '2026-05-01T10:00:00.000Z',
  });
  try {
    const r = await refreshInnerLoopPlanData({ projectRoot: dir, phase: 'git-configure' });
    assert.equal(r.ok, true);
    const plan = readPlan(dir);
    assert.equal(plan.binding.bindingType, 'environment');
    assert.equal(plan.binding.repository, 'pp-site-repo');
    assert.equal(plan.binding.branch, 'main');
    assert.equal(plan.state, 'Connected & Clean');
    assert.deepEqual(plan.pendingCounts, { changes: 0, updates: 0, conflicts: 0 });
    assert.ok(plan.LAST_REFRESH_AT, 'LAST_REFRESH_AT stamp should be set');
  } finally { cleanup(dir); }
});

test('git-configure setup: records solution binding metadata', async () => {
  const dir = tempProject({ PLAN_STATUS: 'In Execution' });
  writeMarker(dir, 'last-git-configure.json', {
    skill: 'git-configure',
    mode: 'setup',
    status: 'ok',
    bindingType: 'solution',
    solutionUniqueName: 'cre48_PowerPagesSite',
    organization: 'contoso',
    project: 'pp-site',
    repository: 'pp-site-repo',
    branch: 'feature/solution-binding',
    gitFolder: '/solutions/cre48_PowerPagesSite',
  });
  try {
    await refreshInnerLoopPlanData({ projectRoot: dir, phase: 'git-configure' });
    const plan = readPlan(dir);
    assert.equal(plan.binding.bindingType, 'solution');
    assert.equal(plan.binding.solutionUniqueName, 'cre48_PowerPagesSite');
  } finally { cleanup(dir); }
});

test('commit-to-git: ingests last-commit.json, zeros pendingCounts.changes, re-classifies state', async () => {
  const dir = tempProject({
    PLAN_STATUS: 'In Execution',
    binding: { bindingType: 'environment', repository: 'r', branch: 'main' },
    pendingCounts: { changes: 5, updates: 0, conflicts: 0 },
    state: 'Dirty',
  });
  writeMarker(dir, 'last-commit.json', {
    commitId: 'abc123def',
    message: 'feat: add about page',
    componentsCommitted: 7,
    committedAt: '2026-05-01T11:30:00.000Z',
  });
  try {
    await refreshInnerLoopPlanData({ projectRoot: dir, phase: 'commit-to-git' });
    const plan = readPlan(dir);
    assert.equal(plan.lastCommit.commitId, 'abc123def');
    assert.equal(plan.pendingCounts.changes, 0);
    assert.equal(plan.state, 'Connected & Clean');
  } finally { cleanup(dir); }
});

test('commit-to-git: if updates were pending pre-commit, state goes to Stale (not Connected & Clean)', async () => {
  const dir = tempProject({
    PLAN_STATUS: 'In Execution',
    binding: { bindingType: 'environment', repository: 'r', branch: 'main' },
    pendingCounts: { changes: 5, updates: 3, conflicts: 0 },
    state: 'Mixed',
  });
  writeMarker(dir, 'last-commit.json', { commitId: 'abc', message: 'x' });
  try {
    await refreshInnerLoopPlanData({ projectRoot: dir, phase: 'commit-to-git' });
    assert.equal(readPlan(dir).state, 'Stale');
  } finally { cleanup(dir); }
});

test('sync-from-git: zeros pendingCounts.updates, honours conflictsAfter from marker', async () => {
  const dir = tempProject({
    PLAN_STATUS: 'In Execution',
    binding: { bindingType: 'environment' },
    pendingCounts: { changes: 0, updates: 4, conflicts: 0 },
    state: 'Stale',
  });
  writeMarker(dir, 'last-sync.json', {
    pulledCommits: 2,
    componentsUpdated: 5,
    conflictsAfter: 2, // pull surfaced 2 conflicts
  });
  try {
    await refreshInnerLoopPlanData({ projectRoot: dir, phase: 'sync-from-git' });
    const plan = readPlan(dir);
    assert.equal(plan.pendingCounts.updates, 0);
    assert.equal(plan.pendingCounts.conflicts, 2);
    assert.equal(plan.state, 'Conflicted');
  } finally { cleanup(dir); }
});

test('sync-from-git without conflictsAfter: preserves existing conflicts count, just zeros updates', async () => {
  const dir = tempProject({
    PLAN_STATUS: 'In Execution',
    binding: { bindingType: 'environment' },
    pendingCounts: { changes: 0, updates: 4, conflicts: 1 },
    state: 'Conflicted',
  });
  writeMarker(dir, 'last-sync.json', { pulledCommits: 1 }); // no conflictsAfter
  try {
    await refreshInnerLoopPlanData({ projectRoot: dir, phase: 'sync-from-git' });
    const plan = readPlan(dir);
    assert.equal(plan.pendingCounts.updates, 0);
    assert.equal(plan.pendingCounts.conflicts, 1, 'pre-existing conflicts must be preserved');
  } finally { cleanup(dir); }
});

test('resolve-conflicts: zeros pendingCounts.conflicts, re-classifies state', async () => {
  const dir = tempProject({
    PLAN_STATUS: 'In Execution',
    binding: { bindingType: 'environment' },
    pendingCounts: { changes: 2, updates: 0, conflicts: 3 },
    state: 'Conflicted',
  });
  writeMarker(dir, 'last-conflict-resolution.json', {
    resolvedCount: 3,
    resolvedAt: '2026-05-01T13:00:00.000Z',
  });
  try {
    await refreshInnerLoopPlanData({ projectRoot: dir, phase: 'resolve-conflicts' });
    const plan = readPlan(dir);
    assert.equal(plan.pendingCounts.conflicts, 0);
    assert.equal(plan.state, 'Dirty', 'changes=2 remain → Dirty');
  } finally { cleanup(dir); }
});

test('commit-to-git (dry-run mode, X-5 merge): ingests last-validation.json and does NOT zero pendingCounts when last-commit.json absent', async () => {
  const dir = tempProject({
    PLAN_STATUS: 'In Execution',
    binding: { bindingType: 'environment' },
    pendingCounts: { changes: 3, updates: 0, conflicts: 0 },
    state: 'Dirty',
  });
  writeMarker(dir, 'last-validation.json', { status: 'dry-run-passed', issues: 0, validatedAt: 'x' });
  try {
    await refreshInnerLoopPlanData({ projectRoot: dir, phase: 'commit-to-git' });
    const plan = readPlan(dir);
    assert.equal(plan.lastValidation.issues, 0);
    assert.equal(plan.lastValidation.status, 'dry-run-passed');
    assert.deepEqual(plan.pendingCounts, { changes: 3, updates: 0, conflicts: 0 },
      'dry-run is read-only — pendingCounts.changes must NOT be zeroed when last-commit.json is absent');
    assert.equal(plan.state, 'Dirty');
  } finally { cleanup(dir); }
});

test('commit-to-git (real-commit mode): both markers present — ingests lastCommit, zeros pendingCounts.changes, AND surfaces lastValidation', async () => {
  const dir = tempProject({
    PLAN_STATUS: 'In Execution',
    binding: { bindingType: 'environment' },
    pendingCounts: { changes: 5, updates: 0, conflicts: 0 },
    state: 'Dirty',
  });
  writeMarker(dir, 'last-commit.json', {
    skill: 'commit-to-git', committedAt: 'x', envUrl: 'y', commitMessage: 'm', status: 'succeeded',
    commitId: 'sha', branch: 'main',
  });
  writeMarker(dir, 'last-validation.json', { status: 'dry-run-passed', issues: 0 });
  try {
    await refreshInnerLoopPlanData({ projectRoot: dir, phase: 'commit-to-git' });
    const plan = readPlan(dir);
    assert.equal(plan.lastCommit.commitId, 'sha');
    assert.equal(plan.lastValidation.status, 'dry-run-passed');
    assert.deepEqual(plan.pendingCounts, { changes: 0, updates: 0, conflicts: 0 });
    assert.equal(plan.state, 'Connected & Clean');
  } finally { cleanup(dir); }
});

test('git-configure switch-branch: updates binding.branch and zeros pendingCounts', async () => {
  const dir = tempProject({
    PLAN_STATUS: 'In Execution',
    binding: { bindingType: 'environment', repository: 'r', branch: 'main' },
    pendingCounts: { changes: 0, updates: 4, conflicts: 0 },
    state: 'Stale',
  });
  writeMarker(dir, 'last-git-configure.json', {
    skill: 'git-configure',
    mode: 'switch-branch',
    status: 'ok',
    organization: 'contoso',
    project: 'pp-site',
    repository: 'r',
    oldBranch: 'main',
    newBranch: 'feature/about-page',
    gitFolder: '/site-name',
    ranAt: '2026-05-01T14:00:00.000Z',
  });
  try {
    await refreshInnerLoopPlanData({ projectRoot: dir, phase: 'git-configure' });
    const plan = readPlan(dir);
    assert.equal(plan.binding.branch, 'feature/about-page');
    assert.deepEqual(plan.pendingCounts, { changes: 0, updates: 0, conflicts: 0 });
    assert.equal(plan.state, 'Connected & Clean');
  } finally { cleanup(dir); }
});

test('revert-workspace: zeros pendingCounts.changes only, re-classifies state', async () => {
  const dir = tempProject({
    PLAN_STATUS: 'In Execution',
    binding: { bindingType: 'environment' },
    pendingCounts: { changes: 5, updates: 2, conflicts: 0 },
    state: 'Mixed',
  });
  writeMarker(dir, 'last-revert.json', { revertedCount: 5 });
  try {
    await refreshInnerLoopPlanData({ projectRoot: dir, phase: 'revert-workspace' });
    const plan = readPlan(dir);
    assert.equal(plan.pendingCounts.changes, 0);
    assert.equal(plan.pendingCounts.updates, 2, 'updates untouched');
    assert.equal(plan.state, 'Stale');
  } finally { cleanup(dir); }
});

test('revert-branch: records marker but does NOT change pendingCounts (env still sees clean)', async () => {
  const dir = tempProject({
    PLAN_STATUS: 'In Execution',
    binding: { bindingType: 'environment' },
    pendingCounts: { changes: 0, updates: 0, conflicts: 0 },
    state: 'Connected & Clean',
  });
  writeMarker(dir, 'last-branch-revert.json', {
    revertedCommit: 'abc123',
    newHead: 'def456',
  });
  try {
    await refreshInnerLoopPlanData({ projectRoot: dir, phase: 'revert-branch' });
    const plan = readPlan(dir);
    assert.equal(plan.lastBranchRevert.revertedCommit, 'abc123');
    assert.deepEqual(plan.pendingCounts, { changes: 0, updates: 0, conflicts: 0 },
      'revert-branch leaves the env counts alone — sync-from-git will surface them later');
  } finally { cleanup(dir); }
});

test('open-pr: pure record — ingests last-pr.json, no count/state changes', async () => {
  const dir = tempProject({
    PLAN_STATUS: 'In Execution',
    binding: { bindingType: 'environment' },
    pendingCounts: { changes: 0, updates: 0, conflicts: 0 },
    state: 'Connected & Clean',
  });
  writeMarker(dir, 'last-pr.json', {
    url: 'https://dev.azure.com/contoso/_git/pp-site-repo/pullrequest/42',
    title: 'feat: about page',
  });
  try {
    await refreshInnerLoopPlanData({ projectRoot: dir, phase: 'open-pr' });
    const plan = readPlan(dir);
    assert.equal(plan.lastPr.url, 'https://dev.azure.com/contoso/_git/pp-site-repo/pullrequest/42');
    assert.equal(plan.state, 'Connected & Clean', 'state untouched');
  } finally { cleanup(dir); }
});

test('diagnose: pure record — ingests last-diagnosis.json', async () => {
  const dir = tempProject({
    PLAN_STATUS: 'In Execution',
    binding: { bindingType: 'environment' },
  });
  writeMarker(dir, 'last-diagnosis.json', {
    patternsHit: ['IL-005'],
    severity: 'warning',
  });
  try {
    await refreshInnerLoopPlanData({ projectRoot: dir, phase: 'diagnose' });
    const plan = readPlan(dir);
    assert.deepEqual(plan.lastDiagnosis.patternsHit, ['IL-005']);
  } finally { cleanup(dir); }
});

test('finalize: flips PLAN_STATUS to Completed and stamps COMPLETED_AT', async () => {
  const dir = tempProject({
    PLAN_STATUS: 'In Execution',
    binding: { bindingType: 'environment' },
  });
  try {
    await refreshInnerLoopPlanData({ projectRoot: dir, phase: 'finalize' });
    const plan = readPlan(dir);
    assert.equal(plan.PLAN_STATUS, 'Completed');
    assert.ok(plan.COMPLETED_AT, 'COMPLETED_AT should be stamped');
  } finally { cleanup(dir); }
});

test('state-only mode: skips marker read, just re-classifies from current counts', async () => {
  const dir = tempProject({
    PLAN_STATUS: 'In Execution',
    binding: { bindingType: 'environment' },
    pendingCounts: { changes: 0, updates: 4, conflicts: 0 },
    state: 'Connected & Clean', // intentionally wrong — should be re-classified to Stale
  });
  // No marker file written.
  try {
    const r = await refreshInnerLoopPlanData({ projectRoot: dir, phase: 'commit-to-git', stateOnly: true });
    assert.equal(r.ok, true);
    const plan = readPlan(dir);
    assert.equal(plan.state, 'Stale', 'state should be re-derived from counts');
    assert.equal(plan.pendingCounts.changes, 0, 'state-only must NOT zero out counts (commit handler skipped)');
  } finally { cleanup(dir); }
});

test('missing marker is a silent no-op for that phase (X-5 merge: handler no longer zeros changes without evidence of mutation)', async () => {
  const dir = tempProject({
    PLAN_STATUS: 'In Execution',
    binding: { bindingType: 'environment' },
    pendingCounts: { changes: 5, updates: 0, conflicts: 0 },
    state: 'Dirty',
  });
  try {
    const r = await refreshInnerLoopPlanData({ projectRoot: dir, phase: 'commit-to-git' });
    assert.equal(r.ok, true);
    const plan = readPlan(dir);
    // Post-X-5: without a last-commit.json marker, the handler has no evidence
    // a real commit landed — it must NOT zero the count (that would mask a
    // dry-run or a failed commit as a clean state).
    assert.equal(plan.pendingCounts.changes, 5,
      'no marker = no evidence of mutation; count must stay put');
    assert.equal(plan.state, 'Dirty');
    assert.equal(plan.lastCommit, undefined, 'no marker = no lastCommit field added');
    assert.ok(plan.LAST_REFRESH_AT);
  } finally { cleanup(dir); }
});

test('atomic write: tmp file is removed after successful rename', async () => {
  const dir = tempProject({
    PLAN_STATUS: 'In Execution',
    binding: { bindingType: 'environment' },
  });
  try {
    await refreshInnerLoopPlanData({ projectRoot: dir, phase: 'finalize' });
    const innerDir = path.join(dir, 'docs', 'inner-loop');
    const leftover = fs.readdirSync(innerDir).filter((f) => f.endsWith('.tmp'));
    assert.deepEqual(leftover, [], 'no .tmp files should be left after a successful write');
  } finally { cleanup(dir); }
});
