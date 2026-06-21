'use strict';

// FULL-CHAIN integration for the two least-covered selective-merge component
// types — content snippet (7, `value`) and web page (2, `copy`). The existing
// selective-merge-integration.test.js proves the chain for web templates (8);
// this proves the SAME real-module chain (build-merge-inputs → merge-workspace
// write → simulated resolve → read → apply, with content-verify) carries the
// correct field key, ADO source path, and merged bytes for snippet + web page.
// Mocks ONLY the external I/O boundaries. This closes the offline (logic) half of
// Wave 1 #7 for these types; the remaining half is a live, consent-gated run.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildMergeInputs } = require('../lib/build-merge-inputs');
const { writeMergeWorkspace, readMergeCompletion } = require('../lib/merge-workspace');
const { applyMergedComponents } = require('../lib/apply-merged-component');

const STORE_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-types-store-'));
process.env.PP_MERGE_STORE_ROOT = STORE_BASE;
process.on('exit', () => { try { fs.rmSync(STORE_BASE, { recursive: true, force: true }); } catch { /* best-effort */ } });

function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sm-types-')); }

const BINDING = {
  organization: 'GitIntegration22', project: 'srijan-pp-alm', repository: 'Sri-collab',
  branch: 'feature/dev-a', rootFolder: 'solutions', gitFolder: 'RetailOS', siteName: 'RetailOS',
  upstreamBranchSyncedCommitId: '19fa740fe637c57c6fdb12615b86c6d7a960ae65',
};

// Non-overlapping edits (OURS changes line 1, THEIRS changes line 3) → clean diff3.
const CASES = [
  {
    label: 'content snippet (7, value)', type: 7, field: 'value', runId: 'merge-type-7',
    id: 'snip-1', name: 'Footer',
    adoPath: '/solutions/RetailOS/powerpagesites/RetailOS/content-snippets/Footer/Footer.contentsnippet.value.html',
    base: 'Hello\nWorld\nFooter old\n',
    ours: 'Hello CHANGED\nWorld\nFooter old\n',
    theirs: 'Hello\nWorld\nFooter NEW\n',
    expected: 'Hello CHANGED\nWorld\nFooter NEW\n',
    envelope: (v) => ({ value: v, type: 1 }),
  },
  {
    label: 'web page (2, copy)', type: 2, field: 'copy', runId: 'merge-type-2',
    id: 'wp-1', name: 'Access Denied',
    adoPath: '/solutions/RetailOS/powerpagesites/RetailOS/web-pages/Access-Denied/content-pages/Access-Denied.webpage.copy.html',
    base: '<h1>Denied</h1>\n<p>body</p>\n<footer>old</footer>\n',
    ours: '<h1>Access Denied</h1>\n<p>body</p>\n<footer>old</footer>\n',
    theirs: '<h1>Denied</h1>\n<p>body</p>\n<footer>NEW</footer>\n',
    expected: '<h1>Access Denied</h1>\n<p>body</p>\n<footer>NEW</footer>\n',
    envelope: (v) => ({ name: 'Access Denied', copy: v }),
  },
];

function buildInputsDeps(cfg) {
  return {
    readComponentContent: async () => ({
      id: cfg.id, name: cfg.name, type: cfg.type, typeLabel: cfg.label,
      mergeStrategy: 'text', mergeFields: [{ key: cfg.field, value: cfg.ours, isText: true }],
      envelope: cfg.envelope(cfg.ours), raw: JSON.stringify(cfg.envelope(cfg.ours)),
    }),
    resolveSourceFilePath: async ({ field }) => ({ found: true, resolvedVia: 'listing', field, path: cfg.adoPath }),
    getFile: async ({ versionType }) => (versionType === 'commit'
      ? { found: true, content: cfg.base }
      : { found: true, content: cfg.theirs }),
  };
}

for (const cfg of CASES) {
  test(`full chain for ${cfg.label}: correct field, ADO path, merged bytes; clean apply + content-verify`, async () => {
    const root = tmpRoot();
    try {
      // 1) ASSEMBLE
      const manifest = await buildMergeInputs({
        conflicts: [{ conflictId: 'g1', componentType: cfg.type, componentName: cfg.name }],
        binding: BINDING, runId: cfg.runId, deps: buildInputsDeps(cfg),
      });
      assert.equal(manifest.summary.total, 1);
      const comp = manifest.components[0];
      assert.equal(comp.routedTo, 'selective-merge', 'text component routes to selective merge');
      assert.equal(comp.units[0].field, cfg.field, 'carries the type-correct field key');
      assert.equal(comp.units[0].status, 'mergeable');
      assert.equal(comp.units[0].adoPath, cfg.adoPath, 'maps to the type-correct ADO source path');

      // 2) MATERIALIZE + 3) simulated clean resolve
      const ws = writeMergeWorkspace({ manifest });
      assert.equal(ws.units.length, 1);
      assert.equal(ws.units[0].hasConflicts, false, 'non-overlapping edits auto-merge cleanly');
      const resultFile = path.join(ws.runDir, ws.units[0].files.result);
      assert.equal(fs.readFileSync(resultFile, 'utf8'), cfg.expected, 'diff3 produced the expected merge');
      fs.writeFileSync(path.join(ws.runDir, 'completion.json'), JSON.stringify({ status: 'done' }), 'utf8');

      // 4) READ BACK
      const completion = readMergeCompletion({ runId: cfg.runId });
      assert.equal(completion.complete, true);
      const resolved = completion.resolved[0];
      assert.equal(resolved.field, cfg.field);
      assert.equal(resolved.adoPath, cfg.adoPath);
      assert.equal(resolved.mergedContent, cfg.expected);

      // 5) APPLY (mocked mutations) + content-verify
      const committed = [];
      const applyDeps = {
        commitFiles: async ({ changes }) => { committed.push(...changes); return { ok: true, commitId: 'sha-merge' }; },
        refreshChangesFromGit: async () => ({ ok: true }),
        resolveGitConflictUserAction: async () => ({ ok: true, useraction: 2 }),
        resolveConflictAccept: async () => ({ resolved: true }),
        pullChangesFromGit: async () => ({ ok: true }),
        listConflicts: async () => ({ count: 0 }),
        // post-pull re-read returns the merged value in the type-correct field
        readComponentContent: async () => ({ mergeFields: [{ key: cfg.field, value: cfg.expected, isText: true }] }),
        innerLoop: require('../lib/inner-loop-paths'),
      };
      const r = await applyMergedComponents({
        binding: BINDING, components: completion.resolved, envUrl: 'https://e', solutionUniqueName: 'RetailOS',
        solutionId: '52cdfb68-415e-f111-a826-6045bd08be8b', runId: cfg.runId, apply: true, projectRoot: root, deps: applyDeps,
      });
      assert.equal(r.status, 'succeeded');
      assert.equal(committed.length, 1);
      assert.equal(committed[0].path, cfg.adoPath, 'committed to the type-correct ADO path');
      assert.equal(committed[0].content, cfg.expected, 'committed the exact merged bytes');
      assert.equal(r.contentVerify[0].result, 'verified', 'env content matches the merge after pull');
      assert.equal(r.marker.strategy, 'selective-merge');
      assert.equal(r.marker.adoCommitId, 'sha-merge');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}
