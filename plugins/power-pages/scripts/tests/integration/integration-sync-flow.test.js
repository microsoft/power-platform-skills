'use strict';

// Integration test — exercises the FULL sync cycle the `sync-from-git` and
// `resolve-conflicts` skills run in concert:
//
//   1. refreshChangesFromGit (HTTP)   — ask Dataverse to query ADO
//   2. listIncomingUpdates / listConflicts (HTTP) — read populated tabs
//   3. resolveConflictKeep / resolveConflictAccept (HTTP) — per-object
//   4. listConflicts again — verify all resolved (count == 0)
//   5. pullChangesFromGit (HTTP) + polled HTTP listIncomingUpdates → 0
//   6. Skill writes last-conflict-resolution.json + last-sync.json
//   7. Validators read both markers and approve
//
// All HTTP traffic goes through the real network code path via startMock.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { startMock } = require('./mock-dataverse');

const { refreshChangesFromGit } = require('../../lib/refresh-changes-from-git');
const { listIncomingUpdates } = require('../../lib/list-incoming-updates');
const { listConflicts } = require('../../lib/list-conflicts');
const { resolveConflictKeep } = require('../../lib/resolve-conflict-keep');
const { resolveConflictAccept } = require('../../lib/resolve-conflict-accept');
const { pullChangesFromGit } = require('../../lib/pull-changes-from-git');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..', '..');
const SYNC_VALIDATOR = path.join(
  PLUGIN_ROOT, 'skills', 'sync-from-git', 'scripts', 'validate-sync-from-git.js',
);
const CONFLICTS_VALIDATOR = path.join(
  PLUGIN_ROOT, 'skills', 'resolve-conflicts', 'scripts', 'validate-resolve-conflicts.js',
);

function mkTempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'il-sync-flow-'));
  fs.writeFileSync(
    path.join(dir, 'powerpages.config.json'),
    JSON.stringify({ siteName: 'IntegrationTestSite' }, null, 2),
  );
  fs.mkdirSync(path.join(dir, 'docs', 'inner-loop'), { recursive: true });
  return dir;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function runValidator(scriptPath, cwd) {
  return spawnSync(process.execPath, [scriptPath], {
    input: JSON.stringify({ cwd }),
    encoding: 'utf8',
  });
}

function writeMarker(projectRoot, filename, payload) {
  const p = path.join(projectRoot, 'docs', 'inner-loop', filename);
  fs.writeFileSync(p, JSON.stringify(payload, null, 2));
  return p;
}

test('integration sync-flow: refresh → resolve 1 conflict (keep) → pull → updates drop to 0', async () => {
  const projectRoot = mkTempProject();

  // Per the helper docs:
  //   - First listIncomingUpdates call (Phase 2 read): 2 incoming updates
  //   - Second listIncomingUpdates call (post-pull poll): 0
  //   - First listConflicts call (Phase 2 read): 1 conflict
  //   - Second listConflicts call (post-resolve recheck): 0
  let updatesCalls = 0;
  let conflictsCalls = 0;
  let pullCalls = 0;

  const mock = await startMock([
    { method: 'POST', matcher: '/RefreshChangesFromGit', status: 204, body: '' },
    {
      method: 'GET',
      matcher: '/gitupdatefiles',
      body: () => {
        updatesCalls += 1;
        if (updatesCalls === 1) {
          return {
            value: [
              { gitupdatefileid: 'u1', componentname: 'NewPage',    componenttype: 'mspp_webpage', updatetype: 0, commitsha: 'aaaaaaa1111', commitmessage: 'teammate adds NewPage',    solutionuniquename: 'IntSol' },
              { gitupdatefileid: 'u2', componentname: 'EditedNav',  componenttype: 'mspp_webtemplate', updatetype: 1, commitsha: 'bbbbbbb2222', commitmessage: 'teammate tweaks nav', solutionuniquename: 'IntSol' },
            ],
          };
        }
        return { value: [] }; // post-pull
      },
    },
    {
      method: 'GET',
      matcher: '/gitconflictfiles',
      body: () => {
        conflictsCalls += 1;
        if (conflictsCalls === 1) {
          return {
            value: [
              { gitconflictfileid: 'c1', componentname: 'Header', componenttype: 'mspp_webtemplate', localchangetype: 1, incomingchangetype: 1, localcommitsha: null, incomingcommitsha: 'cccccccc3333', solutionuniquename: 'IntSol' },
            ],
          };
        }
        return { value: [] }; // after resolve
      },
    },
    { method: 'POST', matcher: '/ResolveGitConflict', status: 204, body: '' },
    {
      method: 'POST',
      matcher: '/PullChangesFromGit',
      body: () => { pullCalls += 1; return ''; },
      status: 204,
    },
  ]);

  try {
    // === sync-from-git Phase 2: refresh ===
    const refresh = await refreshChangesFromGit({
      envUrl: mock.baseUrl, token: 'fake-tok', solutionUniqueName: 'IntSol',
    });
    assert.equal(refresh.refreshed, true);

    // === Read tabs ===
    const updates = await listIncomingUpdates({
      envUrl: mock.baseUrl, token: 'fake-tok', solutionUniqueName: 'IntSol',
    });
    assert.equal(updates.count, 2);
    assert.equal(updates.items[0].updateType, 'Add');

    const conflicts = await listConflicts({
      envUrl: mock.baseUrl, token: 'fake-tok', solutionUniqueName: 'IntSol',
    });
    assert.equal(conflicts.count, 1);
    assert.equal(conflicts.items[0].componentName, 'Header');

    // === resolve-conflicts: resolve the single conflict ===
    const decision = await resolveConflictKeep({
      envUrl: mock.baseUrl, token: 'fake-tok',
      conflictId: conflicts.items[0].conflictId,
      solutionUniqueName: 'IntSol',
    });
    assert.equal(decision.resolved, true);
    assert.equal(decision.outcome, 'keep-environment');

    writeMarker(projectRoot, 'last-conflict-resolution.json', {
      skill: 'resolve-conflicts',
      resolvedAt: decision.calledAt,
      envUrl: mock.baseUrl,
      solutionUniqueName: 'IntSol',
      conflictsFound: 1,
      conflictsResolved: 1,
      remainingConflicts: 0,
      status: 'succeeded',
      decisions: [{ conflictId: decision.conflictId, outcome: decision.outcome }],
    });

    const conflictsVal = runValidator(CONFLICTS_VALIDATOR, projectRoot);
    assert.equal(conflictsVal.status, 0,
      `resolve-conflicts validator should approve; stderr=${conflictsVal.stderr}`);

    // === Phase 4 recheck — conflicts cleared ===
    const reCheck = await listConflicts({
      envUrl: mock.baseUrl, token: 'fake-tok', solutionUniqueName: 'IntSol',
    });
    assert.equal(reCheck.count, 0, 'conflicts must be cleared before pull');

    // === sync-from-git Phase 4: pull ===
    const pull = await pullChangesFromGit({
      envUrl: mock.baseUrl, token: 'fake-tok',
      solutionUniqueName: 'IntSol',
      pollIntervalMs: 1, pollMaxAttempts: 5,
    });
    assert.equal(pull.pulled, true);
    assert.equal(pull.polled.reached, true);
    assert.equal(pull.polled.finalValue.updatesCount, 0);
    assert.equal(pullCalls, 1, 'pull POSTed once');

    writeMarker(projectRoot, 'last-sync.json', {
      skill: 'sync-from-git',
      syncedAt: pull.calledAt,
      envUrl: mock.baseUrl,
      solutionUniqueName: 'IntSol',
      status: 'succeeded',
      updatesPulled: 2,
      polled: pull.polled,
    });

    const syncVal = runValidator(SYNC_VALIDATOR, projectRoot);
    assert.equal(syncVal.status, 0,
      `sync-from-git validator should approve; stderr=${syncVal.stderr}`);
  } finally {
    await mock.close();
    cleanup(projectRoot);
  }
});

test('integration sync-flow: nothing incoming → already-up-to-date short-circuit, no pull, validator approves', async () => {
  const projectRoot = mkTempProject();

  let pullCalls = 0;
  const mock = await startMock([
    { method: 'POST', matcher: '/RefreshChangesFromGit', status: 204, body: '' },
    { method: 'GET', matcher: '/gitupdatefiles', body: { value: [] } },
    { method: 'GET', matcher: '/gitconflictfiles', body: { value: [] } },
    {
      method: 'POST',
      matcher: '/PullChangesFromGit',
      body: () => { pullCalls += 1; return ''; },
      status: 204,
    },
  ]);

  try {
    const refresh = await refreshChangesFromGit({
      envUrl: mock.baseUrl, token: 'fake-tok', solutionUniqueName: 'IntSol',
    });
    assert.equal(refresh.refreshed, true);

    const updates = await listIncomingUpdates({
      envUrl: mock.baseUrl, token: 'fake-tok', solutionUniqueName: 'IntSol',
    });
    const conflicts = await listConflicts({
      envUrl: mock.baseUrl, token: 'fake-tok', solutionUniqueName: 'IntSol',
    });
    assert.equal(updates.count, 0);
    assert.equal(conflicts.count, 0);

    // Skill SHORT-CIRCUITS pull when nothing is incoming.
    writeMarker(projectRoot, 'last-sync.json', {
      skill: 'sync-from-git',
      syncedAt: '2025-01-01T00:00:00Z',
      envUrl: mock.baseUrl,
      solutionUniqueName: 'IntSol',
      status: 'already-up-to-date',
      updatesPulled: 0,
    });

    const syncVal = runValidator(SYNC_VALIDATOR, projectRoot);
    assert.equal(syncVal.status, 0, `validator should approve; stderr=${syncVal.stderr}`);
    assert.equal(pullCalls, 0, 'pull must NOT have been called when nothing incoming');
  } finally {
    await mock.close();
    cleanup(projectRoot);
  }
});

test('integration sync-flow: resolve-accept on conflict, then validator approves', async () => {
  const projectRoot = mkTempProject();

  let conflictsCalls = 0;
  const mock = await startMock([
    { method: 'POST', matcher: '/RefreshChangesFromGit', status: 204, body: '' },
    { method: 'GET', matcher: '/gitupdatefiles', body: { value: [] } },
    {
      method: 'GET',
      matcher: '/gitconflictfiles',
      body: () => {
        conflictsCalls += 1;
        return conflictsCalls === 1
          ? { value: [
              { gitconflictfileid: 'c1', componentname: 'Footer', componenttype: 'mspp_webtemplate', localchangetype: 1, incomingchangetype: 1, localcommitsha: null, incomingcommitsha: 'aabb1234', solutionuniquename: 'IntSol' },
            ] }
          : { value: [] };
      },
    },
    { method: 'POST', matcher: '/ResolveGitConflict', status: 204, body: '' },
  ]);

  try {
    await refreshChangesFromGit({
      envUrl: mock.baseUrl, token: 'fake-tok', solutionUniqueName: 'IntSol',
    });
    const conflicts = await listConflicts({
      envUrl: mock.baseUrl, token: 'fake-tok', solutionUniqueName: 'IntSol',
    });
    assert.equal(conflicts.count, 1);

    const decision = await resolveConflictAccept({
      envUrl: mock.baseUrl, token: 'fake-tok',
      conflictId: conflicts.items[0].conflictId,
      solutionUniqueName: 'IntSol',
    });
    assert.equal(decision.resolved, true);
    assert.equal(decision.outcome, 'accept-incoming');

    writeMarker(projectRoot, 'last-conflict-resolution.json', {
      skill: 'resolve-conflicts',
      resolvedAt: decision.calledAt,
      envUrl: mock.baseUrl,
      solutionUniqueName: 'IntSol',
      conflictsFound: 1,
      conflictsResolved: 1,
      remainingConflicts: 0,
      status: 'succeeded',
      decisions: [{ conflictId: decision.conflictId, outcome: decision.outcome }],
    });

    const cVal = runValidator(CONFLICTS_VALIDATOR, projectRoot);
    assert.equal(cVal.status, 0, `validator should approve; stderr=${cVal.stderr}`);

    const reCheck = await listConflicts({
      envUrl: mock.baseUrl, token: 'fake-tok', solutionUniqueName: 'IntSol',
    });
    assert.equal(reCheck.count, 0);
  } finally {
    await mock.close();
    cleanup(projectRoot);
  }
});

test('integration sync-flow: sync-validator BLOCKS when status=failed', () => {
  const projectRoot = mkTempProject();
  try {
    writeMarker(projectRoot, 'last-sync.json', {
      skill: 'sync-from-git',
      syncedAt: '2025-01-01T00:00:00Z',
      envUrl: 'http://x',
      status: 'failed',
      error: 'PullChangesFromGit returned 500',
    });
    const r = runValidator(SYNC_VALIDATOR, projectRoot);
    assert.equal(r.status, 2, `validator must block on status=failed; stderr=${r.stderr}`);
    assert.match(r.stderr, /status=failed/);
  } finally {
    cleanup(projectRoot);
  }
});
