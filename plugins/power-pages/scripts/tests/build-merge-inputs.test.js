'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildMergeInputs, buildComponentMergeUnit, eolNormalize } = require('../lib/build-merge-inputs');

const BINDING = {
  organization: 'GitIntegration22', project: 'srijan-pp-alm', repository: 'Sri-collab',
  branch: 'feature/dev-a', rootFolder: 'solutions', gitFolder: 'RetailOS', siteName: 'RetailOS',
  upstreamBranchSyncedCommitId: '19fa740fe637c57c6fdb12615b86c6d7a960ae65',
};

// Build a deps bag with canned responses.
function mkDeps({ ours, mapped, theirs, base }) {
  return {
    readComponentContent: async () => ours,
    resolveSourceFilePath: async () => mapped,
    getFile: async ({ versionType }) => (versionType === 'commit' ? base : theirs),
  };
}

const textOurs = (source) => ({
  id: 'c1', name: 'Search', type: 8, typeLabel: 'Web Template',
  mergeStrategy: 'text', mergeFields: [{ key: 'source', value: source, isText: true }],
  envelope: { source }, raw: '{}',
});
const mappedOk = { found: true, path: '/solutions/RetailOS/powerpagesites/RetailOS/web-templates/Search/Search.webtemplate.source.html', resolvedVia: 'listing', field: 'source', type: 8 };

test('eolNormalize: folds CRLF to LF', () => {
  assert.equal(eolNormalize('a\r\nb'), 'a\nb');
});

test('prefers componentPath (deterministic) over the slug-listing resolver when the conflict carries it', async () => {
  let listingCalled = false;
  const deps = {
    readComponentContent: async () => textOurs('OURS\nx'),
    buildPathFromComponentPath: require('../lib/map-component-to-git-path').buildPathFromComponentPath,
    resolveSourceFilePath: async () => { listingCalled = true; return { found: true, path: '/WRONG/listing/path.html', field: 'source' }; },
    getFile: async ({ versionType }) => (versionType === 'commit' ? { found: true, content: 'BASE\nx' } : { found: true, content: 'THEIRS\nx' }),
  };
  const r = await buildComponentMergeUnit({
    conflict: { componentType: 8, componentName: 'Search Results', componentPath: '/powerpagesites/RetailOS/web-templates/Search-Results' },
    binding: BINDING, deps,
  });
  assert.equal(listingCalled, false, 'did NOT call the ADO slug-listing resolver');
  assert.equal(r.units[0].adoPath, '/solutions/RetailOS/powerpagesites/RetailOS/web-templates/Search-Results/Search-Results.webtemplate.source.html');
  assert.equal(r.units[0].resolvedVia, 'componentpath');
});

test('uses the OURS powerpagecomponent type (not the roster solution-component-type 10429) for path resolution', async () => {
  // Live regression (2026-06-19, sri-alm-dev-1): the conflict roster from
  // list-conflicts reports componenttype=10429 (the SOLUTION component type) and a
  // suffixed display name ("Search Results.webtemplate"). The ADO path mapper needs
  // the real powerpagecomponent type (8) + bare name. Passing 10429 made every text
  // conflict resolve as `path-unresolved`. buildComponentMergeUnit must use ours.type
  // / ours.name for path resolution.
  let listingCalled = false;
  const deps = {
    // OURS read returns the REAL type 8 and the bare name "Search Results".
    readComponentContent: async () => ({
      id: 'c1', name: 'Search Results', type: 8, typeLabel: 'Web Template',
      mergeStrategy: 'text', mergeFields: [{ key: 'source', value: 'OURS\nx', isText: true }],
      envelope: {}, raw: '{}',
    }),
    buildPathFromComponentPath: require('../lib/map-component-to-git-path').buildPathFromComponentPath,
    resolveSourceFilePath: async () => { listingCalled = true; return { found: false, path: null, supported: false, reason: 'should use ours.type' }; },
    getFile: async ({ versionType }) => (versionType === 'commit' ? { found: true, content: 'BASE\nx' } : { found: true, content: 'THEIRS\nx' }),
    scoreConflictRisk: () => ({ level: 'low', recommendedGate: 'standard', reasons: [] }),
  };
  const r = await buildComponentMergeUnit({
    // Roster-shaped conflict: solution-component-type + suffixed display name.
    conflict: { componentId: 'c1', componentType: 10429, componentName: 'Search Results.webtemplate', componentPath: '/powerpagesites/RetailOS/web-templates/Search-Results' },
    binding: BINDING, deps,
  });
  assert.equal(listingCalled, false, 'componentpath should resolve with ours.type — no listing fallback');
  assert.equal(r.routedTo, 'selective-merge');
  assert.equal(r.units[0].status, 'mergeable');
  assert.equal(r.units[0].adoPath, '/solutions/RetailOS/powerpagesites/RetailOS/web-templates/Search-Results/Search-Results.webtemplate.source.html');
  assert.equal(r.units[0].resolvedVia, 'componentpath');
});

test('falls back to the slug-listing resolver when no componentPath is present', async () => {
  let listingCalled = false;
  const deps = {
    readComponentContent: async () => textOurs('OURS\nx'),
    buildPathFromComponentPath: require('../lib/map-component-to-git-path').buildPathFromComponentPath,
    resolveSourceFilePath: async () => { listingCalled = true; return mappedOk; },
    getFile: async ({ versionType }) => (versionType === 'commit' ? { found: true, content: 'BASE\nx' } : { found: true, content: 'THEIRS\nx' }),
  };
  const r = await buildComponentMergeUnit({ conflict: { componentType: 8, componentName: 'Search' }, binding: BINDING, deps });
  assert.equal(listingCalled, true, 'fell back to the slug-listing resolver');
  assert.equal(r.units[0].adoPath, mappedOk.path);
});

test('big-file guard: an oversized field is routed to binary keep/accept (status too-large), not merged inline', async () => {
  const { MAX_MERGE_LINES } = require('../lib/build-merge-inputs');
  const huge = Array.from({ length: MAX_MERGE_LINES + 10 }, (_, i) => `line ${i}`).join('\n');
  const deps = mkDeps({
    ours: textOurs(huge + '\nOURS'), mapped: mappedOk,
    theirs: { found: true, content: huge + '\nTHEIRS' },
    base: { found: true, content: huge },
  });
  const r = await buildComponentMergeUnit({ conflict: { componentType: 8, componentName: 'Big' }, binding: BINDING, deps });
  assert.equal(r.units[0].status, 'too-large');
  assert.match(r.units[0].note, /too large/i);
  assert.equal(r.routedTo, 'binary-keep-accept', 'too-large-only component routes to binary keep/accept');
});

test('risk gate (W4#4): a security-sensitive (binary-only) component is forced OFF selective merge even with text fields', async () => {
  const deps = mkDeps({
    ours: { id: 'cs', name: 'Authentication/OpenIdConnect/ClientSecret', type: 8, typeLabel: 'Web Template', mergeStrategy: 'text', mergeFields: [{ key: 'source', value: 'OURS', isText: true }], envelope: {}, raw: '{}' },
    mapped: mappedOk,
    theirs: { found: true, content: 'THEIRS' }, base: { found: true, content: 'BASE' },
  });
  deps.scoreConflictRisk = require('../lib/score-conflict-risk').scoreConflictRisk;
  const r = await buildComponentMergeUnit({ conflict: { componentType: 8, componentName: 'Authentication/OpenIdConnect/ClientSecret' }, binding: BINDING, deps });
  assert.equal(r.routedTo, 'binary-keep-accept', 'critical component never inline-merged');
  assert.equal(r.risk.recommendedGate, 'binary-only');
  assert.match(r.note, /security-sensitive/i);
});

test('buildMergeInputs processes components concurrently but preserves order (Wave 3 #4)', async () => {
  const { buildMergeInputs } = require('../lib/build-merge-inputs');
  let active = 0, maxActive = 0;
  const deps = {
    readComponentContent: async ({ name }) => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return { id: name, name, type: 8, typeLabel: 'Web Template', mergeStrategy: 'text', mergeFields: [{ key: 'source', value: `OURS-${name}`, isText: true }], envelope: {}, raw: '{}' };
    },
    buildPathFromComponentPath: require('../lib/map-component-to-git-path').buildPathFromComponentPath,
    resolveSourceFilePath: async () => mappedOk,
    getFile: async ({ versionType }) => (versionType === 'commit' ? { found: true, content: 'BASE' } : { found: true, content: 'THEIRS' }),
  };
  const conflicts = ['A', 'B', 'C', 'D', 'E', 'F'].map((n) => ({ componentType: 8, componentName: n }));
  const manifest = await buildMergeInputs({ conflicts, binding: BINDING, deps });
  assert.deepEqual(manifest.components.map((c) => c.name), ['A', 'B', 'C', 'D', 'E', 'F'], 'order preserved');
  assert.ok(maxActive > 1, 'ran components concurrently');
});

test('mergeable: all three present and OURS != THEIRS', async () => {
  const deps = mkDeps({
    ours: textOurs('OURS\r\ntext'), mapped: mappedOk,
    theirs: { found: true, content: 'THEIRS\r\ntext' },
    base: { found: true, content: 'BASE\r\ntext' },
  });
  const r = await buildComponentMergeUnit({ conflict: { componentType: 8, componentName: 'Search' }, binding: BINDING, deps });
  assert.equal(r.routedTo, 'selective-merge');
  assert.equal(r.units[0].status, 'mergeable');
  assert.equal(r.units[0].base.present, true);
  assert.equal(r.units[0].ours.content, 'OURS\r\ntext');
  assert.equal(r.units[0].theirs.content, 'THEIRS\r\ntext');
  assert.equal(r.units[0].adoPath, mappedOk.path);
});

test('add-add: BASE absent → 2-way merge', async () => {
  const deps = mkDeps({
    ours: textOurs('OURS'), mapped: mappedOk,
    theirs: { found: true, content: 'THEIRS' },
    base: { found: false },
  });
  const r = await buildComponentMergeUnit({ conflict: { componentType: 8, componentName: 'X' }, binding: BINDING, deps });
  assert.equal(r.units[0].status, 'add-add');
  assert.equal(r.units[0].base.present, false);
  assert.equal(r.routedTo, 'selective-merge');
});

test('BASE fallback: upstream synced commit 404s → falls back to branchSyncedCommitId (live-e2e fix)', async () => {
  const UP = 'a'.repeat(7), BR = 'b'.repeat(7);
  const binding = { ...BINDING, upstreamBranchSyncedCommitId: UP, branchSyncedCommitId: BR };
  const deps = {
    readComponentContent: async () => textOurs('OURS\ntext'),
    resolveSourceFilePath: async () => mappedOk,
    getFile: async ({ version, versionType }) => {
      if (versionType === 'branch') return { found: true, content: 'THEIRS\ntext' };
      if (version === UP) return { found: false };                       // upstream commit lacks the file
      if (version === BR) return { found: true, content: 'BASE\ntext' };  // branch-synced commit has it
      return { found: false };
    },
  };
  const r = await buildComponentMergeUnit({ conflict: { componentType: 8, componentName: 'Search' }, binding, deps });
  assert.equal(r.units[0].status, 'mergeable', 'BASE found via fallback → not add-add');
  assert.equal(r.units[0].base.present, true);
  assert.equal(r.units[0].base.content, 'BASE\ntext');
});

test('deleted-in-git: THEIRS absent', async () => {
  const deps = mkDeps({
    ours: textOurs('OURS'), mapped: mappedOk,
    theirs: { found: false },
    base: { found: true, content: 'BASE' },
  });
  const r = await buildComponentMergeUnit({ conflict: { componentType: 8, componentName: 'X' }, binding: BINDING, deps });
  assert.equal(r.units[0].status, 'deleted-in-git');
  assert.equal(r.routedTo, 'binary-keep-accept');
  assert.match(r.note, /deleted in Git/i);
});

test('identical: OURS == THEIRS (EOL-insensitive) → nothing to merge', async () => {
  const deps = mkDeps({
    ours: textOurs('SAME\r\ntext'), mapped: mappedOk,
    theirs: { found: true, content: 'SAME\ntext' }, // differs only by EOL
    base: { found: true, content: 'BASE' },
  });
  const r = await buildComponentMergeUnit({ conflict: { componentType: 8, componentName: 'X' }, binding: BINDING, deps });
  assert.equal(r.units[0].status, 'identical');
  assert.equal(r.routedTo, 'binary-keep-accept'); // fix #2: identical-only must not route to selective-merge (would be dropped)
});

test('path-unresolved: mapping unsupported/not found → fall back, keep OURS', async () => {
  const deps = mkDeps({
    ours: textOurs('OURS'), mapped: { supported: false, reason: 'binary type' },
    theirs: { found: true, content: 'T' }, base: { found: true, content: 'B' },
  });
  const r = await buildComponentMergeUnit({ conflict: { componentType: 8, componentName: 'X' }, binding: BINDING, deps });
  assert.equal(r.units[0].status, 'path-unresolved');
  assert.equal(r.units[0].ours.content, 'OURS');
  assert.equal(r.routedTo, 'binary-keep-accept'); // fix #2: path-unresolved-only must route to binary, not be dropped
});

test('binary component (web file) routes to keep/accept, no units', async () => {
  const deps = {
    readComponentContent: async () => ({ id: 'w1', name: 'app.css', type: 3, typeLabel: 'Web File', mergeStrategy: 'binary', mergeFields: [] }),
    resolveSourceFilePath: async () => { throw new Error('should not be called'); },
    getFile: async () => { throw new Error('should not be called'); },
  };
  const r = await buildComponentMergeUnit({ conflict: { componentType: 3, componentName: 'app.css' }, binding: BINDING, deps });
  assert.equal(r.routedTo, 'binary-keep-accept');
  assert.equal(r.units.length, 0);
});

test('scalar setting routes to keep/accept', async () => {
  const deps = {
    readComponentContent: async () => ({ id: 's1', name: 'Foo/Bar', type: 9, typeLabel: 'Site Setting', mergeStrategy: 'scalar', mergeFields: [{ key: 'value', value: 'true', isText: false }] }),
    resolveSourceFilePath: async () => ({ supported: false }),
    getFile: async () => ({ found: false }),
  };
  const r = await buildComponentMergeUnit({ conflict: { componentType: 9, componentName: 'Foo/Bar' }, binding: BINDING, deps });
  assert.equal(r.routedTo, 'binary-keep-accept');
});

test('OURS read error → binary fallback with note', async () => {
  const deps = mkDeps({ ours: { error: 'boom' }, mapped: mappedOk, theirs: {}, base: {} });
  const r = await buildComponentMergeUnit({ conflict: { componentType: 8, componentName: 'X' }, binding: BINDING, deps });
  assert.equal(r.routedTo, 'binary-keep-accept');
  assert.match(r.note, /Could not read OURS/);
});

test('buildMergeInputs: manifest shape + summary', async () => {
  const deps = mkDeps({
    ours: textOurs('OURS'), mapped: mappedOk,
    theirs: { found: true, content: 'THEIRS' }, base: { found: true, content: 'BASE' },
  });
  const manifest = await buildMergeInputs({
    conflicts: [{ conflictId: 'g1', componentType: 8, componentName: 'Search' }],
    binding: BINDING, runId: 'run-123', deps,
  });
  assert.equal(manifest.runId, 'run-123');
  assert.ok(manifest.generatedAt);
  assert.equal(manifest.binding.repository, 'Sri-collab');
  assert.equal(manifest.binding.upstreamBranchSyncedCommitId, BINDING.upstreamBranchSyncedCommitId);
  assert.equal(manifest.components.length, 1);
  assert.equal(manifest.summary.total, 1);
  assert.equal(manifest.summary.selectiveMerge, 1);
});

test('buildMergeInputs: rejects non-array conflicts / missing binding', async () => {
  await assert.rejects(buildMergeInputs({ conflicts: null, binding: BINDING }), /conflicts must be an array/);
  await assert.rejects(buildMergeInputs({ conflicts: [], binding: null }), /binding is required/);
});

test('buildMergeInputs: auto-generates runId when absent', async () => {
  const deps = mkDeps({ ours: textOurs('O'), mapped: mappedOk, theirs: { found: true, content: 'T' }, base: { found: true, content: 'B' } });
  const manifest = await buildMergeInputs({ conflicts: [{ componentType: 8, componentName: 'Search' }], binding: BINDING, deps });
  assert.match(manifest.runId, /[0-9a-f-]{36}/);
});
