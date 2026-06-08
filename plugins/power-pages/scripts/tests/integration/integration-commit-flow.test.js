'use strict';

// Integration test — exercises the FULL pre-commit + commit + verify cycle
// the `commit-to-git` and `validate-pending-changes` skills run in concert:
//
//   1. listPendingChanges (HTTP) gets the items
//   2. validateFileSizes + validateSupportedObjectTypes inspect them
//   3. Skill writes `last-validation.json` marker
//   4. commitToGit (HTTP + polled HTTP) commits and waits for count→0
//   5. Skill writes `last-commit.json` marker
//   6. PostToolUse validators read both markers and approve
//
// All HTTP calls hit a localhost Dataverse mock built from the queued
// routes pattern shared with discover-integration.test.js. No require.cache
// stubbing — the real makeRequest / network path is exercised.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { startMock } = require('./mock-dataverse');

const { listPendingChanges } = require('../../lib/list-pending-changes');
const { validateFileSizes } = require('../../lib/validate-file-sizes');
const { validateSupportedObjectTypes } = require('../../lib/validate-supported-object-types');
const { commitToGit } = require('../../lib/commit-to-git');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..', '..');
const VALIDATE_PENDING_VALIDATOR = path.join(
  PLUGIN_ROOT, 'skills', 'validate-pending-changes', 'scripts',
  'validate-validate-pending-changes.js',
);
const COMMIT_VALIDATOR = path.join(
  PLUGIN_ROOT, 'skills', 'commit-to-git', 'scripts', 'validate-commit-to-git.js',
);

function mkTempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'il-commit-flow-'));
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

test('integration commit-flow: validate clean → commit → polled to 0 → validators approve', async () => {
  const projectRoot = mkTempProject();

  // changes appears as 3 first; after commit, the same endpoint must report 0
  // so the post-commit poll terminates.
  let pendingCalls = 0;
  const mock = await startMock([
    {
      method: 'GET',
      matcher: '/gitcommitfiles',
      body: () => {
        pendingCalls += 1;
        if (pendingCalls === 1) {
          // Phase 1 read: 3 modest items, well under any cap.
          return {
            value: [
              { gitcommitfileid: 'g1', componentname: 'Home',  componenttype: 'mspp_webpage', changetype: 1, filepath: 'src/web-pages/home/content-pages/en-us.webpage.copy.html',     sizeestimate: 4_000,   modifiedon: '2025-01-01T00:00:00Z', solutionuniquename: 'IntSol' },
              { gitcommitfileid: 'g2', componentname: 'About', componenttype: 'mspp_webpage', changetype: 1, filepath: 'src/web-pages/about/content-pages/en-us.webpage.copy.html',    sizeestimate: 6_500,   modifiedon: '2025-01-01T00:00:00Z', solutionuniquename: 'IntSol' },
              { gitcommitfileid: 'g3', componentname: 'Logo',  componenttype: 'mspp_webfile', changetype: 0, filepath: 'src/web-files/logo.png/logo.png',                              sizeestimate: 128_000, modifiedon: '2025-01-01T00:00:00Z', solutionuniquename: 'IntSol' },
            ],
          };
        }
        // Post-commit poll reads → empty.
        return { value: [] };
      },
    },
    {
      method: 'POST',
      matcher: '/CommitToGit',
      body: { CommitId: 'abc123def456deadbeef0011223344556677aa11', Type: 1 },
    },
  ]);

  try {
    // === Phase 1 (validate-pending-changes): read changes + run pre-flight ===
    const pending = await listPendingChanges({
      envUrl: mock.baseUrl, token: 'fake-tok', solutionUniqueName: 'IntSol',
    });
    assert.equal(pending.count, 3);
    assert.equal(pending.items[0].componentName, 'Home');
    assert.equal(pending.items[2].changeType, 'Add');

    const sizes = validateFileSizes(pending.items);
    assert.equal(sizes.ok, true);
    assert.equal(sizes.blocking.length, 0);
    assert.equal(sizes.totalFiles, 3);

    const types = validateSupportedObjectTypes(pending.items);
    assert.equal(types.ok, true);
    assert.equal(types.unsupported.length, 0);

    writeMarker(projectRoot, 'last-validation.json', {
      skill: 'validate-pending-changes',
      validatedAt: '2025-01-01T01:00:00Z',
      envUrl: mock.baseUrl,
      status: 'passed',
      summary: { totalFiles: 3, blockers: 0, warnings: 0 },
    });

    const valRes = runValidator(VALIDATE_PENDING_VALIDATOR, projectRoot);
    assert.equal(valRes.status, 0,
      `validate-pending-changes validator should approve; stderr=${valRes.stderr}`);

    // === Phase 2 (commit-to-git): commit + poll ===
    const commit = await commitToGit({
      envUrl: mock.baseUrl, token: 'fake-tok',
      solutionUniqueName: 'IntSol',
      commitMessage: 'integration: changes',
      pollIntervalMs: 1, pollMaxAttempts: 5,
    });
    assert.equal(commit.committed, true);
    assert.equal(commit.commitId, 'abc123def456deadbeef0011223344556677aa11');
    assert.equal(commit.polled.reached, true,
      'post-commit poll must terminate because count drops to 0');
    assert.equal(commit.polled.finalValue.changesCount, 0);

    writeMarker(projectRoot, 'last-commit.json', {
      skill: 'commit-to-git',
      committedAt: commit.calledAt,
      envUrl: mock.baseUrl,
      solutionUniqueName: 'IntSol',
      commitMessage: 'integration: changes',
      commitId: commit.commitId,
      status: 'succeeded',
      polled: commit.polled,
    });

    const commitVal = runValidator(COMMIT_VALIDATOR, projectRoot);
    assert.equal(commitVal.status, 0,
      `commit-to-git validator should approve; stderr=${commitVal.stderr}`);

    // Sanity: pendingCalls should be at least 2 (pre-commit read + 1 poll read).
    assert.ok(pendingCalls >= 2, `expected ≥2 listPendingChanges HTTP hits, got ${pendingCalls}`);
  } finally {
    await mock.close();
    cleanup(projectRoot);
  }
});

test('integration commit-flow: 17 MB file blocks at validate-pending-changes and validator hard-fails', async () => {
  const projectRoot = mkTempProject();

  // One file with raw size = 18 MB. Base64-encoded ≈ 24 MB → blocks at 17 MB cap.
  const HUGE_RAW = 18 * 1024 * 1024;
  const mock = await startMock([
    {
      method: 'GET',
      matcher: '/gitcommitfiles',
      body: {
        value: [
          { gitcommitfileid: 'big1', componentname: 'huge.zip', componenttype: 'mspp_webfile', changetype: 0, filepath: 'src/web-files/huge.zip/huge.zip', sizeestimate: HUGE_RAW, modifiedon: '2025-01-01T00:00:00Z', solutionuniquename: 'IntSol' },
        ],
      },
    },
  ]);

  try {
    const pending = await listPendingChanges({
      envUrl: mock.baseUrl, token: 'fake-tok', solutionUniqueName: 'IntSol',
    });
    assert.equal(pending.count, 1);

    const sizes = validateFileSizes(pending.items);
    assert.equal(sizes.ok, false, 'file > cap must be flagged as blocking');
    assert.equal(sizes.blocking.length, 1);
    assert.equal(sizes.blocking[0].componentName, 'huge.zip');
    assert.ok(sizes.blocking[0].overByBytes > 0);

    writeMarker(projectRoot, 'last-validation.json', {
      skill: 'validate-pending-changes',
      validatedAt: '2025-01-01T01:00:00Z',
      envUrl: mock.baseUrl,
      status: 'blocked',
      blockers: sizes.blocking.map(b => ({
        type: 'file-size',
        componentName: b.componentName,
        rawBytes: b.rawBytes,
        encodedBytes: b.encodedBytes,
        capBytes: b.capBytes,
      })),
    });

    const valRes = runValidator(VALIDATE_PENDING_VALIDATOR, projectRoot);
    assert.equal(valRes.status, 2,
      `validator must BLOCK when status=blocked; stderr=${valRes.stderr}`);
    assert.match(valRes.stderr, /1 blocker/);
  } finally {
    await mock.close();
    cleanup(projectRoot);
  }
});

test('integration commit-flow: commit poll-timeout writes pollWarning but commit still succeeds', async () => {
  const projectRoot = mkTempProject();

  // Pending count never drops to 0 → poll times out, but commit returns committed:true.
  const mock = await startMock([
    {
      method: 'GET',
      matcher: '/gitcommitfiles',
      body: {
        value: [
          { gitcommitfileid: 'stuck1', componentname: 'Stuck', componenttype: 'mspp_webpage', changetype: 1, filepath: 'src/x.html', sizeestimate: 1024, modifiedon: '2025-01-01T00:00:00Z', solutionuniquename: 'IntSol' },
        ],
      },
    },
    {
      method: 'POST',
      matcher: '/CommitToGit',
      body: { CommitId: 'feedface11223344556677889900aabbccddeeff', Type: 1 },
    },
  ]);

  try {
    const commit = await commitToGit({
      envUrl: mock.baseUrl, token: 'fake-tok',
      solutionUniqueName: 'IntSol',
      commitMessage: 'integration: poll-timeout',
      pollIntervalMs: 1, pollMaxAttempts: 3,
    });
    assert.equal(commit.committed, true);
    assert.equal(commit.commitId, 'feedface11223344556677889900aabbccddeeff');
    assert.equal(commit.polled.reached, false);
    assert.match(commit.pollWarning, /did not drop to 0/);

    // Skill would still write a marker, with status=succeeded but include
    // pollWarning so users can see it. Validator approves either way.
    writeMarker(projectRoot, 'last-commit.json', {
      skill: 'commit-to-git',
      committedAt: commit.calledAt,
      envUrl: mock.baseUrl,
      solutionUniqueName: 'IntSol',
      commitMessage: 'integration: poll-timeout',
      commitId: commit.commitId,
      status: 'succeeded',
      polled: commit.polled,
      pollWarning: commit.pollWarning,
    });

    const commitVal = runValidator(COMMIT_VALIDATOR, projectRoot);
    assert.equal(commitVal.status, 0, `validator should approve; stderr=${commitVal.stderr}`);
  } finally {
    await mock.close();
    cleanup(projectRoot);
  }
});

test('integration commit-flow: commit-validator BLOCKS when marker is missing commitId', () => {
  const projectRoot = mkTempProject();
  try {
    writeMarker(projectRoot, 'last-commit.json', {
      skill: 'commit-to-git',
      committedAt: '2025-01-01T00:00:00Z',
      envUrl: 'http://x',
      solutionUniqueName: 'IntSol',
      commitMessage: 'broken',
      status: 'succeeded',
      // commitId omitted on purpose
    });
    const r = runValidator(COMMIT_VALIDATOR, projectRoot);
    assert.equal(r.status, 2, `should block on missing commitId; stderr=${r.stderr}`);
    assert.match(r.stderr, /commitId/);
  } finally {
    cleanup(projectRoot);
  }
});
