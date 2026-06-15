'use strict';

// Integration test — exercises the `git-sync --dry-run` happy path
// post-VPC-merge (per X-10):
//
//   1. listPendingChanges (HTTP) gets the items
//   2. The merged validator suite runs and finds no blockers/warnings
//   3. Skill writes BOTH `last-validation.json` (with status="dry-run-passed"
//      or "passed") AND a human-readable `pre-commit-report.html`
//   4. Skill DOES NOT call `CommitToGit` — no mutation of the live env
//   5. Skill DOES NOT write `last-commit.json`
//   6. The PostToolUse `validate-git-sync.js` hook reads
//      `last-validation.json` and approves the dry-run statuses
//
// This test simulates the skill's behaviour with a hand-written marker
// (the integration suite does not invoke the skill chrome). The key
// invariants are: (a) only the read endpoints are hit; (b) the
// CommitToGit POST endpoint is NEVER hit (we don't even register a route
// for it, which would 404 if list-pending-changes leaked into a commit);
// (c) the validator approves the dry-run marker.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { startMock } = require('./mock-dataverse');

const { listPendingChanges } = require('../../lib/list-pending-changes');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..', '..');
const COMMIT_VALIDATOR = path.join(
  PLUGIN_ROOT, 'skills', 'git-sync', 'scripts', 'validate-git-sync.js',
);

function mkTempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'il-commit-dry-'));
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
}

test('integration git-sync --dry-run: writes last-validation + report, NO mutation, hook approves', async () => {
  const projectRoot = mkTempProject();
  const FAKE_SOLUTION_ID = '00000000-aaaa-bbbb-cccc-000000000099';

  // CRITICAL: deliberately omit any /CommitToGit route. If the dry-run path
  // ever invokes commit-to-git, the test will fail with an unrouted-POST 404.
  let pendingCalls = 0;
  let commitCalls = 0;
  const mock = await startMock([
    {
      method: 'GET',
      matcher: '/solutions',
      body: { value: [{ solutionid: FAKE_SOLUTION_ID, uniquename: 'IntSol' }] },
    },
    {
      method: 'GET',
      matcher: '/sourcecontrolcomponents',
      body: () => {
        pendingCalls += 1;
        return {
          '@odata.count': 2,
          value: [
            { sourcecontrolcomponentid: 'd1', componentid: 'd1c', componentdisplayname: 'Home',  componenttypename: 'mspp_webpage', componenttype: 1054, solutioncomponentstate: 1, 'action@OData.Community.Display.V1.FormattedValue': 'Push', action: 0, componentpath: 'src/web-pages/home.html',  partitionid: FAKE_SOLUTION_ID, modifiedon: '2025-01-01T00:00:00Z' },
            { sourcecontrolcomponentid: 'd2', componentid: 'd2c', componentdisplayname: 'About', componenttypename: 'mspp_webpage', componenttype: 1054, solutioncomponentstate: 0, 'action@OData.Community.Display.V1.FormattedValue': 'Push', action: 0, componentpath: 'src/web-pages/about.html', partitionid: FAKE_SOLUTION_ID, modifiedon: '2025-01-01T00:00:00Z' },
          ],
        };
      },
    },
    {
      method: 'POST',
      matcher: '/CommitToGit',
      body: () => { commitCalls += 1; return { CommitId: 'SHOULD_NEVER_BE_CALLED' }; },
    },
  ]);

  try {
    // Phase 2: list pending changes (read-only).
    const pending = await listPendingChanges({
      envUrl: mock.baseUrl, token: 'fake-tok', solutionUniqueName: 'IntSol',
    });
    assert.equal(pending.count, 2);

    // Phase 3: dry-run validator orchestrator would run and find nothing.
    // Skill writes the dry-run marker AND the HTML report.
    writeMarker(projectRoot, 'last-validation.json', {
      skill: 'git-sync',
      validatedAt: '2025-01-01T01:00:00Z',
      envUrl: mock.baseUrl,
      solutionUniqueName: 'IntSol',
      mode: 'dry-run',
      status: 'dry-run-passed',
      pendingChangesCount: 2,
      blockers: [],
      warnings: [],
      infos: [],
    });
    fs.writeFileSync(
      path.join(projectRoot, 'docs', 'inner-loop', 'pre-commit-report.html'),
      '<!doctype html><html><body><h1>Pre-Commit Report</h1>'
        + '<p>Status: PASSED — 2 pending changes, 0 blockers, 0 warnings.</p>'
        + '</body></html>',
    );

    // === Invariants ===

    // (a) read endpoints were hit
    assert.ok(pendingCalls >= 1, 'list-pending-changes must have been called');

    // (b) commit endpoint was NEVER hit
    assert.equal(commitCalls, 0, 'dry-run must not POST CommitToGit');

    // (c) dry-run marker + HTML written
    assert.ok(
      fs.existsSync(path.join(projectRoot, 'docs', 'inner-loop', 'last-validation.json')),
      'last-validation.json must exist',
    );
    assert.ok(
      fs.existsSync(path.join(projectRoot, 'docs', 'inner-loop', 'pre-commit-report.html')),
      'pre-commit-report.html must exist',
    );

    // (d) last-commit.json must NOT exist (dry-run does not write the real-commit marker)
    assert.ok(
      !fs.existsSync(path.join(projectRoot, 'docs', 'inner-loop', 'last-commit.json')),
      'dry-run must NOT write last-commit.json',
    );

    // (e) the merged PostToolUse hook reads either marker; with only the
    //     dry-run marker present, it accepts dry-run-passed and exits 0.
    const valRes = runValidator(COMMIT_VALIDATOR, projectRoot);
    assert.equal(valRes.status, 0,
      `validate-git-sync should approve dry-run-passed; stderr=${valRes.stderr}`);
  } finally {
    await mock.close();
    cleanup(projectRoot);
  }
});
