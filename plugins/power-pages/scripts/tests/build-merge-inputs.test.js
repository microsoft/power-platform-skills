'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildMergeInputs, writeMergeInputs, normalizeConflict } = require('../lib/build-merge-inputs');
const { isEligibleForSelectiveMerge } = require('../lib/component-type-map');

// A binding shaped like detect-git-binding.js output.
const BINDING = {
  organization: 'GitIntegration22', project: 'srijan-pp-alm', repository: 'srijan-pp-alm-2',
  branch: 'feature/dev-b', rootFolder: 'solutions', gitFolder: 'RetailOS',
  branchSyncedCommitId: '757656aa', upstreamBranchSyncedCommitId: '5619e3e7',
  solutionUniqueName: 'RetailOS',
};

// Enriched list-conflicts rows (mixed types + a string-typed roster row).
const ENRICHED = [
  { conflictId: 'g1', componentId: 'c1', componentName: 'Search Results.webtemplate', componentPath: '/powerpagesites/RetailOS/web-templates/Search-Results', ppcType: 8 },
  { conflictId: 'g2', componentId: 'c2', componentName: 'Footer.contentsnippet', componentPath: '/powerpagesites/RetailOS/content-snippets/Footer', ppcType: 7 },
  { conflictId: 'g3', componentId: 'c3', componentName: 'Cat-PC.png.webfile', componentPath: '/powerpagesites/RetailOS/web-files/Cat-PC.png', ppcType: 3 },
];

test('A3 buildMergeInputs: ALWAYS includes BOTH synced commit IDs as base candidates', () => {
  const { inputs } = buildMergeInputs({ binding: BINDING, conflicts: ENRICHED, cloneDir: 'C:/clones/sri-alm-dev-1', envUrl: 'https://e', solutionUniqueName: 'RetailOS' });
  assert.equal(inputs.binding.branchSyncedCommitId, '757656aa');
  assert.equal(inputs.binding.upstreamBranchSyncedCommitId, '5619e3e7');
  assert.equal(inputs.binding.baseCommit, null); // resolver's pickBaseCommit chooses
  assert.equal(inputs.cloneDir, 'C:/clones/sri-alm-dev-1', 'inputs must carry cloneDir (not base/envName)');
  assert.ok(!('base' in inputs), 'inputs must NOT carry a base field');
  assert.ok(!('envName' in inputs), 'inputs must NOT carry an envName field');
});

test('A3 buildMergeInputs: conflict types are NUMERIC and fields resolved per type', () => {
  const { inputs } = buildMergeInputs({ binding: BINDING, conflicts: ENRICHED, cloneDir: 'C:/clones/sri-alm-dev-1', solutionUniqueName: 'RetailOS' });
  assert.deepEqual(inputs.conflicts.map((c) => c.type), [8, 7, 3]);
  assert.deepEqual(inputs.conflicts.map((c) => c.field), ['source', 'value', null]);
  assert.deepEqual(inputs.conflicts.map((c) => c.name), ['Search Results', 'Footer', 'Cat-PC.png']);
  assert.deepEqual(inputs.conflicts.map((c) => c.eligibleForSelectiveMerge), [8, 7, 3].map(isEligibleForSelectiveMerge));
});

test('B5 buildMergeInputs: type-3 web file conflicts retain resolver coordinates without a local eligibility override', () => {
  const { inputs } = buildMergeInputs({ binding: BINDING, conflicts: ENRICHED, cloneDir: 'C:/clones/sri-alm-dev-1', solutionUniqueName: 'RetailOS' });
  const webFile = inputs.conflicts.find((c) => c.type === 3);
  assert.ok(webFile);
  assert.equal(webFile.conflictId, 'g3');
  assert.equal(webFile.componentId, 'c3');
  assert.equal(webFile.name, 'Cat-PC.png');
  assert.equal(webFile.type, 3);
  assert.equal(webFile.componentPath, '/powerpagesites/RetailOS/web-files/Cat-PC.png');
  assert.equal(webFile.field, null);
  assert.equal(webFile.eligibleForSelectiveMerge, isEligibleForSelectiveMerge(3));
});

test('A3 normalizeConflict: a STRING-typed roster row becomes numeric (A1 belt-and-suspenders)', () => {
  const n = normalizeConflict({ conflictId: 'x', componentId: 'y', name: 'Pagination', type: 'webtemplate', componentPath: '/p/web-templates/Pagination' });
  assert.equal(n.type, 8);
  assert.equal(n.field, 'source');
});

test('A3 normalizeConflict: type derived from componentName suffix when type missing', () => {
  const n = normalizeConflict({ conflictId: 'x', componentId: 'y', componentName: 'Footer.contentsnippet', componentPath: '/p' });
  assert.equal(n.type, 7);
  assert.equal(n.field, 'value');
});

test('A3 buildMergeInputs: unresolvable-type conflicts are skipped with a warning, not silently dropped', () => {
  const { inputs, warnings } = buildMergeInputs({
    binding: BINDING, cloneDir: 'C:/clones/sri-alm-dev-1', solutionUniqueName: 'RetailOS',
    conflicts: [...ENRICHED, { conflictId: 'bad', componentId: 'z', componentName: 'mystery', componentPath: '/nope' }],
  });
  assert.equal(inputs.conflicts.length, 3);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unresolvable type/i);
});

test('A3 buildMergeInputs: warns when binding has no synced commit IDs (auto-discovery fallback)', () => {
  const { warnings } = buildMergeInputs({
    binding: { ...BINDING, branchSyncedCommitId: null, upstreamBranchSyncedCommitId: null },
    conflicts: ENRICHED, cloneDir: 'C:/clones/sri-alm-dev-1', solutionUniqueName: 'RetailOS',
  });
  assert.ok(warnings.some((w) => /auto-discovery/i.test(w)));
});

test('A3 buildMergeInputs: required args throw', () => {
  assert.throws(() => buildMergeInputs({ conflicts: [], cloneDir: 'x' }), /binding is required/);
  assert.throws(() => buildMergeInputs({ binding: BINDING, cloneDir: 'x' }), /conflicts must be an array/);
  assert.throws(() => buildMergeInputs({ binding: BINDING, conflicts: [] }), /cloneDir is required/);
});

test('A3 writeMergeInputs: writes to .pp-merge with createdAt/updatedAt stamps (E1)', () => {
  const writes = {};
  const fsImpl = {
    mkdirSync: () => {},
    writeFileSync: (p, content) => { writes[p] = content; },
  };
  const { inputs } = buildMergeInputs({ binding: BINDING, conflicts: ENRICHED, cloneDir: 'C:/clones/sri-alm-dev-1', solutionUniqueName: 'RetailOS' });
  const out = writeMergeInputs({ ppMergeDir: '/clone/.pp-merge', inputs, fsImpl });
  assert.match(out.replace(/\\/g, '/'), /\/clone\/\.pp-merge\/merge-inputs\.json$/);
  const written = JSON.parse(writes[out]);
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(written.createdAt));
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(written.updatedAt));
  assert.equal(written.conflicts.length, 3);
});
