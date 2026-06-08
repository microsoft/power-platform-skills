'use strict';

// Integration test — exercises the FULL branch-switch flow the `branch-switch`
// skill drives end-to-end:
//
//   1. detectGitBinding (HTTP)  — read current binding ("main")
//   2. switchBranch → internally calls disconnectFromGit + connectToGit
//      against the SAME mock so the org/project/repo/folder are reused
//   3. detectGitBinding (HTTP)  — verify new binding ("feature/x")
//   4. Skill rewrites .git-integration-manifest.json `branch` field
//   5. Skill writes last-branch-switch.json marker
//   6. validate-branch-switch validator reads both files and cross-checks
//      that manifest.branch === marker.newBranch
//
// All HTTP traffic goes through the real network path via startMock.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { startMock } = require('./mock-dataverse');

const { detectGitBinding } = require('../../lib/detect-git-binding');
const { switchBranch } = require('../../lib/switch-branch');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..', '..');
const BRANCH_SWITCH_VALIDATOR = path.join(
  PLUGIN_ROOT, 'skills', 'branch-switch', 'scripts', 'validate-branch-switch.js',
);

function mkTempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'il-branch-switch-'));
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

function writeManifest(projectRoot, payload) {
  const p = path.join(projectRoot, '.git-integration-manifest.json');
  fs.writeFileSync(p, JSON.stringify(payload, null, 2));
  return p;
}

function bindingRow({ branch }) {
  return {
    gitintegrationid: 'binding-guid-int-001',
    connectiontype: 1,
    organizationname: 'contoso',
    projectname: 'pp-site',
    repositoryname: 'pp-repo',
    branchname: branch,
    gitfolder: '/site',
    rootfolder: null,
    solutionuniquename: null,
    connectionstatus: 'Connected',
  };
}

test('integration branch-switch: main → feature/x — disconnect + reconnect + manifest reconcile', async () => {
  const projectRoot = mkTempProject();

  // Initial binding (read by switchBranch's pre-check) is "main".
  // After disconnect + reconnect, detect call must report "feature/x".
  let bindingReads = 0;
  const mock = await startMock([
    {
      method: 'GET',
      matcher: '/gitintegrations',
      body: () => {
        bindingReads += 1;
        // Reads 1 (skill Phase 1 read) and 2 (switchBranch pre-check) → "main"
        // Reads 3+ (skill Phase 5 verification) → "feature/x"
        const branch = bindingReads <= 2 ? 'main' : 'feature/x';
        return { value: [bindingRow({ branch })] };
      },
    },
    { method: 'POST', matcher: '/DisconnectFromGit', status: 204, body: '' },
    { method: 'POST', matcher: '/ConnectToGit',      status: 204, body: '' },
  ]);

  try {
    // Initial manifest — would have been written by setup-git-integration.
    writeManifest(projectRoot, {
      bindingType: 'environment',
      envUrl: mock.baseUrl,
      organization: 'contoso',
      project: 'pp-site',
      repository: 'pp-repo',
      branch: 'main',
      gitFolder: '/site',
      boundAt: '2025-01-01T00:00:00Z',
      manifestVersion: 1,
    });

    // === Skill Phase 1 — read current state ===
    const before = await detectGitBinding({ envUrl: mock.baseUrl, token: 'fake-tok' });
    assert.equal(before.bound, true);
    assert.equal(before.branch, 'main');

    // === Skill Phase 4 — execute switch ===
    const sw = await switchBranch({
      envUrl: mock.baseUrl, token: 'fake-tok',
      newBranch: 'feature/x',
    });
    assert.equal(sw.switched, true);
    assert.equal(sw.previousBranch, 'main');
    assert.equal(sw.newBranch, 'feature/x');
    assert.equal(sw.organization, 'contoso');
    assert.equal(sw.gitFolder, '/site');

    // === Skill Phase 5 — verify (re-read binding) ===
    const after = await detectGitBinding({ envUrl: mock.baseUrl, token: 'fake-tok' });
    assert.equal(after.branch, 'feature/x');

    // === Skill Phase 6 — reconcile local manifest + write marker ===
    writeManifest(projectRoot, {
      bindingType: 'environment',
      envUrl: mock.baseUrl,
      organization: 'contoso',
      project: 'pp-site',
      repository: 'pp-repo',
      branch: 'feature/x',     // ← updated
      gitFolder: '/site',
      boundAt: '2025-01-01T00:00:00Z',
      manifestVersion: 1,
    });
    writeMarker(projectRoot, 'last-branch-switch.json', {
      skill: 'branch-switch',
      switchedAt: sw.reconnectedAt,
      envUrl: mock.baseUrl,
      organization: 'contoso',
      project: 'pp-site',
      repository: 'pp-repo',
      oldBranch: sw.previousBranch,
      newBranch: sw.newBranch,
      status: 'succeeded',
      disconnectedAt: sw.disconnectedAt,
      reconnectedAt: sw.reconnectedAt,
    });

    const valRes = runValidator(BRANCH_SWITCH_VALIDATOR, projectRoot);
    assert.equal(valRes.status, 0,
      `branch-switch validator should approve; stderr=${valRes.stderr}`);
  } finally {
    await mock.close();
    cleanup(projectRoot);
  }
});

test('integration branch-switch: reconnect FAILS → switchBranch rolls back to previous branch', async () => {
  const projectRoot = mkTempProject();

  let connectCalls = 0;
  const mock = await startMock([
    {
      method: 'GET',
      matcher: '/gitintegrations',
      body: { value: [bindingRow({ branch: 'main' })] },
    },
    { method: 'POST', matcher: '/DisconnectFromGit', status: 204, body: '' },
    {
      method: 'POST',
      matcher: '/ConnectToGit',
      status: () => {
        connectCalls += 1;
        // First reconnect (to feature/x) FAILS; second reconnect (rollback to main) succeeds.
        return connectCalls === 1 ? 400 : 204;
      },
      body: ({}) => {
        return connectCalls === 1
          ? { error: { code: '0x80060010', message: 'Branch feature/x not found in repo' } }
          : '';
      },
    },
  ]);

  try {
    const sw = await switchBranch({
      envUrl: mock.baseUrl, token: 'fake-tok',
      newBranch: 'feature/x',
    });
    assert.ok(sw.error, 'switchBranch must return an error envelope');
    assert.equal(sw.phase, 'reconnect');
    assert.equal(sw.rolledBack, true, 'helper must auto-rollback on reconnect failure');
    assert.equal(sw.attemptedBranch, 'feature/x');
    assert.equal(sw.previousBranch, 'main');
    assert.equal(connectCalls, 2,
      'expected one failed reconnect + one rollback reconnect');
  } finally {
    await mock.close();
    cleanup(projectRoot);
  }
});

test('integration branch-switch: same-branch attempt is rejected by helper (no-op detected)', async () => {
  const projectRoot = mkTempProject();
  const mock = await startMock([
    {
      method: 'GET',
      matcher: '/gitintegrations',
      body: { value: [bindingRow({ branch: 'main' })] },
    },
  ]);
  try {
    const sw = await switchBranch({
      envUrl: mock.baseUrl, token: 'fake-tok',
      newBranch: 'main',
    });
    assert.ok(sw.error, 'same-branch switch should return an error');
    assert.match(sw.error, /Already bound to branch "main"/);
  } finally {
    await mock.close();
    cleanup(projectRoot);
  }
});

test('integration branch-switch: validator BLOCKS when manifest.branch drifts from marker.newBranch', () => {
  const projectRoot = mkTempProject();
  try {
    // Manifest claims branch=develop but the marker says newBranch=feature/x.
    // The validator's job is to catch this drift.
    writeManifest(projectRoot, {
      bindingType: 'environment',
      envUrl: 'http://x',
      organization: 'contoso',
      project: 'pp-site',
      repository: 'pp-repo',
      branch: 'develop',
      gitFolder: '/site',
      boundAt: '2025-01-01T00:00:00Z',
      manifestVersion: 1,
    });
    writeMarker(projectRoot, 'last-branch-switch.json', {
      skill: 'branch-switch',
      switchedAt: '2025-01-01T00:00:00Z',
      envUrl: 'http://x',
      organization: 'contoso',
      project: 'pp-site',
      repository: 'pp-repo',
      oldBranch: 'main',
      newBranch: 'feature/x',
      status: 'succeeded',
    });
    const r = runValidator(BRANCH_SWITCH_VALIDATOR, projectRoot);
    assert.equal(r.status, 2,
      `validator must block when manifest drifts; stderr=${r.stderr}`);
    assert.match(r.stderr, /does not match/);
  } finally {
    cleanup(projectRoot);
  }
});

test('integration branch-switch: validator accepts refs/heads/x normalized to x', () => {
  const projectRoot = mkTempProject();
  try {
    // Manifest stores short name; marker uses fully-qualified refs/heads/feature/x.
    writeManifest(projectRoot, {
      bindingType: 'environment',
      envUrl: 'http://x',
      organization: 'contoso',
      project: 'pp-site',
      repository: 'pp-repo',
      branch: 'feature/x',
      gitFolder: '/site',
      boundAt: '2025-01-01T00:00:00Z',
      manifestVersion: 1,
    });
    writeMarker(projectRoot, 'last-branch-switch.json', {
      skill: 'branch-switch',
      switchedAt: '2025-01-01T00:00:00Z',
      envUrl: 'http://x',
      organization: 'contoso',
      project: 'pp-site',
      repository: 'pp-repo',
      oldBranch: 'main',
      newBranch: 'refs/heads/feature/x',
      status: 'succeeded',
    });
    const r = runValidator(BRANCH_SWITCH_VALIDATOR, projectRoot);
    assert.equal(r.status, 0,
      `validator should approve with refs/heads/ normalization; stderr=${r.stderr}`);
  } finally {
    cleanup(projectRoot);
  }
});
