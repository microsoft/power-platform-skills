'use strict';
// REAL BUNDLES: a `.maker-workspace` the PREVIOUS release wrote, rebuilt by this one — unchanged, and edited.
//
// The SDK stamps every workspace copy with the version of the parsers that projected it and refuses to push a copy stamped with
// another version (ARTIFACT_PROJECTION_STALE, nothing written): after a parser change an untouched part of an old copy can read as
// edited. The bundled SDK raised that version (a Quick Find marker below a view's top-level filter, and a multi-value condition, are
// now kept verbatim), so EVERY copy a maker's workspace holds — the app, its forms, views, charts, dashboard and command bars — is
// "old" the first time this release runs in it. workspace-projection-real-bundle.test.js pins the mechanism on one stamped app copy;
// this file and workspace-upgrade-entry-real-bundle.test.js pin the upgrade a maker makes, end to end, over the stateful fake
// (helpers/lifecycle-harness.js, helpers/workspace-upgrade.js). Each path starts from the state the previous release's bundle left
// — never from one this release has touched — and its first step with this release is compared with the same step on a workspace
// this release's bundle wrote: every step succeeds, sends the same writes, and leaves the same features.
//   UNCHANGED REBUILD  the first build of this release changes nothing, and re-reads every copy it edits
//   EDITED REBUILD     the first build of this release applies a maker's edits — and keeps, by content, a view filter the typed view
//                      model does not hold, added in Maker and read into the old copy by the previous release
// The previous release's bundle comes from helpers/previous-bundle.js: CI fetches it; elsewhere it is read from git history.
const test = require('node:test');
const assert = require('node:assert/strict');
const { deployedFeatures } = require('./helpers/lifecycle-harness.js');
const { skipWithoutPrevious } = require('./helpers/previous-bundle.js');
const { projections, versions, editedSpec, residualView, RESIDUAL_FILTER, startFrom, stage, kitchenSinkSpec } = require('./helpers/workspace-upgrade.js');

const SKIP = skipWithoutPrevious();
const sorted = (list) => [...list].sort();

// --- the unchanged rebuild ---------------------------------------------------------------------------------------------------

let rebuildP;
const rebuildPaths = () => rebuildP || (rebuildP = (async () => {
  const run = async (which) => {
    const s = await startFrom(which);
    s.rebuild = await s.next.measure(() => s.next.build(kitchenSinkSpec()));
    s.afterRebuild = s.org.inventory();
    s.rebuildProjections = projections(s.next.workspaceDir);
    return s;
  };
  return { upgrade: await run('previous'), control: await run('current') };
})());

test('upgrade: the previous release builds the app and leaves copies of every kind at its own, older projection', { skip: SKIP }, async () => {
  const { upgrade, control } = await rebuildPaths();
  assert.equal(stage(upgrade.build, 'previous release\'s build').value.result.ok, true, JSON.stringify(upgrade.build.value.result.errors));
  for (const kind of ['apps', 'forms', 'views', 'charts', 'dashboards', 'commands']) {
    assert.ok(upgrade.firstProjections[kind], `the previous build kept ${kind} copies (${Object.keys(upgrade.firstProjections)})`);
  }
  const [old] = versions(upgrade.firstProjections);
  const [current] = versions(control.firstProjections);
  assert.deepEqual(versions(upgrade.firstProjections), [old], 'one projection version in the old workspace');
  assert.ok(old < current, `this bundle projects at a newer version (${current}) than the previous one (${old}): the workspace is an old one`);
  // The two builds leave the same environment, so every later step starts from the same place on both paths.
  assert.deepEqual(deployedFeatures(upgrade.org), deployedFeatures(control.org));
});

test('upgrade: an unchanged first rebuild over the old workspace succeeds and sends exactly what it sends over a current one', { skip: SKIP }, async () => {
  const { upgrade, control } = await rebuildPaths();
  const { value: { result, warnings } } = stage(upgrade.rebuild, 'rebuild');
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  // The build reconciles views side by side, so its warnings are compared in any order.
  assert.deepEqual(sorted(warnings), sorted(stage(control.rebuild, 'control rebuild').value.warnings), 'no warning the current workspace does not give');
  assert.deepEqual(upgrade.afterRebuild, upgrade.afterBuild, 'nothing created or deleted');
  assert.deepEqual(upgrade.rebuild.writes, control.rebuild.writes, 'the same writes as over a current workspace');
  // Every copy the rebuild edits is re-read and stamped current, so no later push meets the refusal. A command bar is never
  // re-pushed by a build (sdk-build.js: an existing bar is reused), so its old copy is left as it was — and is never pushed.
  const [current] = versions(control.firstProjections);
  for (const kind of ['apps', 'forms', 'views', 'charts', 'dashboards']) {
    assert.deepEqual([...new Set(upgrade.rebuildProjections[kind])], [current], `the ${kind} copies are re-read at the current projection`);
  }
});

// --- the edited rebuild, first ------------------------------------------------------------------------------------------------

let editP;
const editPaths = () => editP || (editP = (async () => {
  const run = async (which) => {
    const s = await startFrom(which, { residualFilter: true });
    s.heldBefore = residualView(s.org).fetchxml;
    s.edit = await s.next.measure(() => s.next.build(editedSpec()));
    s.edited = deployedFeatures(s.org);
    s.heldAfter = residualView(s.org).fetchxml;
    s.verify = await s.next.measure(() => s.next.verify(editedSpec()));
    return s;
  };
  return { upgrade: await run('previous'), control: await run('current') };
})());

test('upgrade: an edited first rebuild over the old workspace applies the edits as over a current one, and verify passes', { skip: SKIP }, async () => {
  const { upgrade, control } = await editPaths();
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

test('upgrade: a view filter the typed model does not hold — a nested Quick Find marker, a multi-value condition — survives the edit by content', { skip: SKIP }, async () => {
  const { upgrade, control } = await editPaths();
  stage(upgrade.edit, 'edited rebuild');
  assert.ok(upgrade.heldBefore.includes(RESIDUAL_FILTER), 'the previous release\'s rebuild left the maker\'s filter in place');
  // The edit reached the view: its new column is saved.
  assert.match(upgrade.heldAfter, /<attribute name="contoso_done" ?\/>/, 'the view\'s column edit is saved');
  // And the filter is the maker's, byte for byte, where the maker put it: inside the view's top-level filter.
  assert.ok(upgrade.heldAfter.includes(`<filter type="and">${RESIDUAL_FILTER}`), `the nested Quick Find filter and its multi-value condition are kept verbatim: ${upgrade.heldAfter}`);
  assert.equal(upgrade.heldAfter, control.heldAfter, 'exactly as over a current workspace');
});
