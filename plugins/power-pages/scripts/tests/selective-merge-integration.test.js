'use strict';

// FULL-CHAIN INTEGRATION TEST for the selective-merge feature.
//
// Wires the REAL modules together end-to-end — build-merge-inputs →
// merge-workspace.write → (simulated VS Code resolve) → merge-workspace.read →
// apply-merged-component — mocking ONLY the external I/O boundaries
// (Dataverse reads, ADO file fetch, ADO push, refresh/accept/pull). This is the
// deterministic, CI-safe stand-in for the consent-gated live e2e: it proves the
// real data shapes flow correctly between the real helpers, not just that each
// helper works in isolation.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildMergeInputs } = require('../lib/build-merge-inputs');
const { writeMergeWorkspace, readMergeCompletion } = require('../lib/merge-workspace');
const { applyMergedComponents } = require('../lib/apply-merged-component');

// Isolate the secure merge artifact store (secure-by-default) for this test file
// so fixed runIds can't collide with real merges or across runs. Each test file
// runs in its own process under node:test, so this env override is file-local.
const STORE_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-e2e-store-'));
process.env.PP_MERGE_STORE_ROOT = STORE_BASE;
process.on('exit', () => { try { fs.rmSync(STORE_BASE, { recursive: true, force: true }); } catch { /* best-effort */ } });

function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sm-e2e-')); }

const BINDING = {
  organization: 'GitIntegration22', project: 'srijan-pp-alm', repository: 'Sri-collab',
  branch: 'feature/dev-a', rootFolder: 'solutions', gitFolder: 'RetailOS', siteName: 'RetailOS',
  upstreamBranchSyncedCommitId: '19fa740fe637c57c6fdb12615b86c6d7a960ae65',
};

// A web template (text → selective merge) with NON-OVERLAPPING edits on each side,
// plus a web file (binary → keep/accept, must NOT reach the merge editor or apply).
const BASE_SRC = '{% assign x = 1 %}\r\n<div>{{ x }}</div>\r\n<footer>old</footer>\r\n';   // CRLF (ADO)
const OURS_SRC = '{% assign x = 2 %}\n<div>{{ x }}</div>\n<footer>old</footer>\n';          // LF (Dataverse), changed assign
const THEIRS_SRC = '{% assign x = 1 %}\r\n<div>{{ x }}</div>\r\n<footer>NEW</footer>\r\n';  // CRLF, changed footer
const EXPECTED_MERGE_CRLF = '{% assign x = 2 %}\r\n<div>{{ x }}</div>\r\n<footer>NEW</footer>\r\n';

function buildInputsDeps() {
  return {
    // OURS reader (Dataverse)
    readComponentContent: async ({ componentType }) => {
      if (componentType === 8) {
        return { id: 'tpl-1', name: 'Search', type: 8, typeLabel: 'Web Template',
          mergeStrategy: 'text', mergeFields: [{ key: 'source', value: OURS_SRC, isText: true }],
          envelope: { source: OURS_SRC }, raw: JSON.stringify({ source: OURS_SRC }) };
      }
      // web file → binary
      return { id: 'wf-1', name: 'app.css', type: 3, typeLabel: 'Web File', mergeStrategy: 'binary', mergeFields: [] };
    },
    // ADO path resolver
    resolveSourceFilePath: async () => ({
      found: true, resolvedVia: 'listing', field: 'source',
      path: '/solutions/RetailOS/powerpagesites/RetailOS/web-templates/Search/Search.webtemplate.source.html',
    }),
    // ADO file fetch: branch tip = THEIRS, commit = BASE
    getFile: async ({ versionType }) => (versionType === 'commit'
      ? { found: true, content: BASE_SRC }
      : { found: true, content: THEIRS_SRC }),
  };
}

test('selective-merge full chain: assemble → workspace → resolve → read → apply', async () => {
  const root = tmpRoot();
  try {
    // 1) ASSEMBLE — real build-merge-inputs, mocked Dataverse/ADO reads.
    const manifest = await buildMergeInputs({
      conflicts: [
        { conflictId: 'g-tpl', componentType: 8, componentName: 'Search' },
        { conflictId: 'g-wf', componentType: 3, componentName: 'app.css' },
      ],
      binding: BINDING, runId: 'e2e-run', deps: buildInputsDeps(),
    });
    assert.equal(manifest.summary.total, 2);
    assert.equal(manifest.summary.selectiveMerge, 1, 'web template routes to selective-merge');
    assert.equal(manifest.summary.binaryKeepAccept, 1, 'web file routes to binary keep/accept');

    // 2) MATERIALIZE — real merge-workspace, real fs.
    const ws = writeMergeWorkspace({ projectRoot: root, manifest });
    assert.equal(ws.units.length, 1, 'only the text component becomes a merge unit');
    assert.equal(ws.binaryComponents.length, 1, 'web file recorded as binary, not a unit');
    const unit = ws.units[0];
    // EOL/BOM fix: independent edits across CRLF/LF skew auto-merge cleanly.
    assert.equal(unit.hasConflicts, false, 'non-overlapping edits auto-merge despite EOL skew');
    assert.equal(unit.eol, 'crlf', 'output EOL follows THEIRS (the repo file)');
    const proposed = fs.readFileSync(path.join(ws.runDir, unit.files.result), 'utf8');
    assert.equal(proposed, EXPECTED_MERGE_CRLF, 'diff3 produced the correct clean merge with CRLF preserved');

    // 3) SIMULATE the developer reviewing in VS Code and saving (clean → unchanged).
    //    (The extension would write completion.json; the agent reads result.txt.)
    fs.writeFileSync(path.join(ws.runDir, 'completion.json'), JSON.stringify({ status: 'done' }), 'utf8');

    // 4) READ BACK — real merge-workspace; refuses leftover markers, carries oursContent.
    const completion = readMergeCompletion({ projectRoot: root, runId: 'e2e-run' });
    assert.equal(completion.complete, true);
    assert.equal(completion.resolved.length, 1);
    const resolved = completion.resolved[0];
    assert.equal(resolved.mergedContent, EXPECTED_MERGE_CRLF);
    assert.ok(resolved.oursContent && resolved.oursContent.includes('assign x = 2'), 'OURS carried for snapshot');
    assert.equal(resolved.adoPath, unit.adoPath);
    assert.equal(resolved.conflictId, 'g-tpl');

    // 5) APPLY — real apply-merged-component; mock the 5 Dataverse/ADO mutations.
    const committed = [];
    const order = [];
    const applyDeps = {
      commitFiles: async ({ changes, comment }) => { order.push('commit'); committed.push(...changes); return { ok: true, commitId: 'merged-sha', comment }; },
      refreshChangesFromGit: async () => { order.push('refresh'); return { ok: true }; },
      resolveConflictAccept: async ({ conflictId }) => { order.push(`accept:${conflictId}`); return { resolved: true }; },
      pullChangesFromGit: async () => { order.push('pull'); return { ok: true }; },
      listConflicts: async () => { order.push('verify'); return { count: 0 }; },
      innerLoop: require('../lib/inner-loop-paths'),
    };

    const applyResult = await applyMergedComponents({
      binding: BINDING,
      components: completion.resolved, // ← real output of readMergeCompletion threaded in
      envUrl: 'https://org5ba33a19.crm.dynamics.com/', solutionUniqueName: 'RetailOS',
      projectRoot: root, runId: 'e2e-run', apply: true, deps: applyDeps,
    });

    // The chain reached a verified, clean resolution.
    assert.equal(applyResult.status, 'succeeded');
    assert.deepEqual(order, ['commit', 'refresh', 'accept:g-tpl', 'pull', 'verify']);
    // The EXACT merged content (CRLF) was committed to the correct ADO path.
    assert.equal(committed.length, 1);
    assert.equal(committed[0].path, unit.adoPath);
    assert.equal(committed[0].content, EXPECTED_MERGE_CRLF);
    // Marker records the selective-merge strategy + the ADO commit.
    assert.equal(applyResult.marker.strategy, 'selective-merge');
    assert.equal(applyResult.marker.adoCommitId, 'merged-sha');
    assert.equal(applyResult.marker.remainingConflicts, 0);
    // OURS snapshot is non-empty (reversibility).
    const snapFiles = fs.readdirSync(applyResult.marker.snapshotDir);
    assert.ok(snapFiles.some((f) => f.endsWith('.ours.txt')));
    const snap = fs.readFileSync(path.join(applyResult.marker.snapshotDir, snapFiles.find((f) => f.endsWith('.ours.txt'))), 'utf8');
    assert.ok(snap.includes('assign x = 2'), 'snapshot captured real OURS, not empty');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('selective-merge full chain: leftover conflict markers block apply (D6 end-to-end)', async () => {
  const root = tmpRoot();
  try {
    // Overlapping edits → a real conflict the user must resolve.
    const overlapDeps = {
      readComponentContent: async () => ({ id: 'tpl-1', name: 'Search', type: 8, typeLabel: 'Web Template',
        mergeStrategy: 'text', mergeFields: [{ key: 'source', value: 'A\nOURS\nC\n', isText: true }], envelope: {}, raw: '{}' }),
      resolveSourceFilePath: async () => ({ found: true, resolvedVia: 'listing', field: 'source', path: '/x/Search.webtemplate.source.html' }),
      getFile: async ({ versionType }) => (versionType === 'commit' ? { found: true, content: 'A\nBASE\nC\n' } : { found: true, content: 'A\nTHEIRS\nC\n' }),
    };
    const manifest = await buildMergeInputs({
      conflicts: [{ conflictId: 'g', componentType: 8, componentName: 'Search' }],
      binding: BINDING, runId: 'e2e-conflict', deps: overlapDeps,
    });
    const ws = writeMergeWorkspace({ projectRoot: root, manifest });
    assert.equal(ws.units[0].hasConflicts, true, 'overlapping edits produce a real conflict');

    // Developer leaves the conflict markers in result.txt (did NOT resolve).
    const completion = readMergeCompletion({ projectRoot: root, runId: 'e2e-conflict' });
    assert.equal(completion.complete, false);
    assert.equal(completion.resolved.length, 0, 'unresolved markers are never handed to apply');
    assert.equal(completion.unresolved.length, 1);
    assert.match(completion.unresolved[0].reason, /conflict markers/);

    // Apply must refuse: no resolved components → the non-empty guard blocks it,
    // so nothing is ever committed to ADO for an unresolved merge.
    let commitCalled = false;
    const applyDeps = {
      commitFiles: async () => { commitCalled = true; return { ok: true }; },
      refreshChangesFromGit: async () => ({}), resolveConflictAccept: async () => ({}),
      pullChangesFromGit: async () => ({}), listConflicts: async () => ({ count: 0 }),
      innerLoop: require('../lib/inner-loop-paths'),
    };
    await assert.rejects(
      applyMergedComponents({
        binding: BINDING, components: completion.resolved, envUrl: 'u', solutionUniqueName: 'RetailOS',
        projectRoot: root, apply: true, deps: applyDeps,
      }),
      /non-empty array/,
      'apply must refuse an empty resolved set rather than commit nothing',
    );
    assert.equal(commitCalled, false, 'nothing committed to ADO when the merge is unresolved');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
