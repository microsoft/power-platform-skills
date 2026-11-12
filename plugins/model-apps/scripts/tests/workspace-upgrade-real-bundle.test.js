'use strict';
// REAL BUNDLES: a `.maker-workspace` the PREVIOUS release wrote, rebuilt by this one — unchanged, and edited.
//
// The SDK stamps every workspace copy with the version of the parsers that projected it and refuses to push a copy stamped with
// another version (ARTIFACT_PROJECTION_STALE, nothing written): after a parser change an untouched part of an old copy can read as
// edited. A plain fetch re-reads a clean old copy and stamps it current, so the upgrade stays invisible to a maker.
// workspace-projection-real-bundle.test.js pins the mechanism on one stamped app copy; this file and
// workspace-upgrade-entry-real-bundle.test.js pin the upgrade a maker makes, end to end, over the stateful fake
// (helpers/lifecycle-harness.js, helpers/workspace-upgrade.js). Each path starts from the state the previous release's bundle left
// — never from one this release has touched — and its first step with this release is compared with the same step on a workspace
// this release's bundle wrote: every step succeeds, sends the same writes, and leaves the same features.
//   UNCHANGED REBUILD  the first build of this release changes nothing, and re-reads every copy it edits
//   EDITED REBUILD     the first build of this release applies a maker's edits — and keeps, by content, a view filter the typed view
//                      model does not hold, added in Maker and read into the old copy by the previous release
// Each is run twice: on the workspace the previous release left as it is (whatever projection it stamped, equal to this bundle's or
// not), and, as its own case, with every copy stamped one projection version LOWER — the stale-copy path, which must not depend
// on the previous release having projected at an older version than this one.
// The previous release's bundle comes from helpers/previous-bundle.js: CI fetches it; elsewhere it is read from git history.
const test = require('node:test');
const assert = require('node:assert/strict');
const { deployedFeatures } = require('./helpers/lifecycle-harness.js');
const { skipWithoutPrevious } = require('./helpers/previous-bundle.js');
const { projections, versions, editedSpec, residualView, RESIDUAL_FILTER, startFrom, stage, kitchenSinkSpec } = require('./helpers/workspace-upgrade.js');

const SKIP = skipWithoutPrevious();
const sorted = (list) => [...list].sort();
const WORKSPACES = [[false, 'the previous release\'s workspace'], [true, 'a workspace whose copies are all one projection version older']];

// --- the unchanged rebuild ---------------------------------------------------------------------------------------------------

const rebuildCache = {};
const rebuildPaths = (staleProjection) => rebuildCache[staleProjection] || (rebuildCache[staleProjection] = (async () => {
  const run = async (which, options) => {
    const s = await startFrom(which, options);
    s.rebuild = await s.next.measure(() => s.next.build(kitchenSinkSpec()));
    s.afterRebuild = s.org.inventory();
    s.rebuildProjections = projections(s.next.workspaceDir);
    return s;
  };
  return { upgrade: await run('previous', { staleProjection }), control: await run('current') };
})());

test('upgrade: the previous release builds the app and leaves copies of every kind, at one projection no newer than this bundle\'s', { skip: SKIP }, async () => {
  const { upgrade, control } = await rebuildPaths(false);
  assert.equal(stage(upgrade.build, 'previous release\'s build').value.result.ok, true, JSON.stringify(upgrade.build.value.result.errors));
  for (const kind of ['apps', 'forms', 'views', 'charts', 'dashboards', 'commands']) {
    assert.ok(upgrade.firstProjections[kind], `the previous build kept ${kind} copies (${Object.keys(upgrade.firstProjections)})`);
  }
  const [previous] = versions(upgrade.firstProjections);
  const [current] = versions(control.firstProjections);
  assert.deepEqual(versions(upgrade.firstProjections), [previous], 'one projection version in the previous release\'s workspace');
  assert.ok(previous <= current, `this bundle projects at version ${current}, not older than the previous release's ${previous}`);
  // The two builds leave the same environment, so every later step starts from the same place on both paths.
  assert.deepEqual(deployedFeatures(upgrade.org), deployedFeatures(control.org));
});

test('upgrade: a workspace stamped one projection version older holds every copy at that older version before the first rebuild', { skip: SKIP }, async () => {
  const { upgrade, control } = await rebuildPaths(true);
  const [stale] = versions(upgrade.firstProjections);
  const [current] = versions(control.firstProjections);
  assert.deepEqual(versions(upgrade.firstProjections), [stale], 'one projection version in the stamped workspace');
  assert.equal(stale, current - 1, `every copy is stamped older than this bundle's ${current}`);
  assert.deepEqual(deployedFeatures(upgrade.org), deployedFeatures(control.org));
});

for (const [staleProjection, workspace] of WORKSPACES) {
  test(`upgrade: an unchanged first rebuild over ${workspace} succeeds and sends exactly what it sends over a current one`, { skip: SKIP }, async () => {
    const { upgrade, control } = await rebuildPaths(staleProjection);
    const { value: { result, warnings } } = stage(upgrade.rebuild, 'rebuild');
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    // The build reconciles views side by side, so its warnings are compared in any order.
    assert.deepEqual(sorted(warnings), sorted(stage(control.rebuild, 'control rebuild').value.warnings), 'no warning the current workspace does not give');
    assert.deepEqual(upgrade.afterRebuild, upgrade.afterBuild, 'nothing created or deleted');
    assert.deepEqual(upgrade.rebuild.writes, control.rebuild.writes, 'the same writes as over a current workspace');
    // Every copy the rebuild edits is current afterwards (re-read where it was old), so no later push meets the refusal. A command
    // bar is never re-pushed by a build (sdk-build.js: an existing bar is reused), so its copy is left as it was — and is never pushed.
    const [current] = versions(control.firstProjections);
    for (const kind of ['apps', 'forms', 'views', 'charts', 'dashboards']) {
      assert.deepEqual([...new Set(upgrade.rebuildProjections[kind])], [current], `the ${kind} copies are at the current projection`);
    }
  });
}

// --- the edited rebuild, first ------------------------------------------------------------------------------------------------

const editCache = {};
const editPaths = (staleProjection) => editCache[staleProjection] || (editCache[staleProjection] = (async () => {
  const run = async (which, options) => {
    const s = await startFrom(which, { residualFilter: true, ...options });
    s.heldBefore = residualView(s.org).fetchxml;
    s.edit = await s.next.measure(() => s.next.build(editedSpec()));
    s.edited = deployedFeatures(s.org);
    s.heldAfter = residualView(s.org).fetchxml;
    s.verify = await s.next.measure(() => s.next.verify(editedSpec()));
    return s;
  };
  return { upgrade: await run('previous', { staleProjection }), control: await run('current') };
})());

for (const [staleProjection, workspace] of WORKSPACES) {
  test(`upgrade: an edited first rebuild over ${workspace} applies the edits as over a current one, and verify passes`, { skip: SKIP }, async () => {
    const { upgrade, control } = await editPaths(staleProjection);
    stage(upgrade.reread, 'previous release\'s rebuild after the maker\'s edit');
    const { value: { result, warnings } } = stage(upgrade.edit, 'edited rebuild');
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.deepEqual(sorted(warnings), sorted(stage(control.edit, 'control edited rebuild').value.warnings), 'no warning the current workspace does not give');
    assert.deepEqual(upgrade.edit.writes, control.edit.writes, 'the same writes as over a current workspace');
    assert.deepEqual(upgrade.edited, control.edited, 'the environment ends with the same features');
    const verify = stage(upgrade.verify, 'verify').value;
    assert.equal(verify.ok, true, JSON.stringify(verify));
    // The checks run side by side, so they are compared as a set.
    const checks = (report) => report.checks.map((c) => JSON.stringify(c)).sort();
    const current = stage(control.verify, 'control verify').value;
    assert.deepEqual({ ...verify, checks: checks(verify) }, { ...current, checks: checks(current) }, 'verify reports what it reports over a current workspace');
  });

  test(`upgrade: over ${workspace}, a view filter the typed model does not hold — a nested Quick Find marker, a multi-value condition — survives the edit by content`, { skip: SKIP }, async () => {
    const { upgrade, control } = await editPaths(staleProjection);
    stage(upgrade.edit, 'edited rebuild');
    assert.ok(upgrade.heldBefore.includes(RESIDUAL_FILTER), 'the previous release\'s rebuild left the maker\'s filter in place');
    // The edit reached the view: its new column is saved.
    assert.match(upgrade.heldAfter, /<attribute name="contoso_done" ?\/>/, 'the view\'s column edit is saved');
    // And the filter is the maker's, byte for byte, where the maker put it: inside the view's top-level filter.
    assert.ok(upgrade.heldAfter.includes(`<filter type="and">${RESIDUAL_FILTER}`), `the nested Quick Find filter and its multi-value condition are kept verbatim: ${upgrade.heldAfter}`);
    assert.equal(upgrade.heldAfter, control.heldAfter, 'exactly as over a current workspace');
  });
}
