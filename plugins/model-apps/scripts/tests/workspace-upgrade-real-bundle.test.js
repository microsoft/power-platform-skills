'use strict';
// REAL BUNDLES: a `.maker-workspace` the PREVIOUS release wrote, read by this one.
//
// The SDK stamps every workspace copy with the version of the parsers that projected it and refuses to push a copy stamped with
// another version (ARTIFACT_PROJECTION_STALE, nothing written): after a parser change an untouched part of an old copy can read as
// edited. The bundled SDK raised that version (nested Quick Find filters and multi-value view conditions are now kept verbatim), so
// EVERY copy a maker's workspace holds — the app, its forms, views, charts, dashboard and command bars — is "old" the first time this
// release runs in it. workspace-projection-real-bundle.test.js pins the mechanism on one stamped app copy; this file pins the upgrade a
// maker actually makes, end to end, with both bundles over the stateful fake (helpers/lifecycle-harness.js):
//   UPGRADE  the previous release's bundle builds the kitchen-sink spec; then THIS bundle, on the same workspace and environment, runs
//            an unchanged rebuild, an edited rebuild, verify, a download and a teardown;
//   CONTROL  the same steps with this bundle from the start.
// The upgrade must behave exactly as the control does: every step succeeds, sends the same writes and leaves the same features — so no
// maker-facing failure, and no request a maker could see differs because the workspace is an old one.
// The previous release's bundle is read from git history (the 2.20.4 release commit). A checkout without that history — CI's shallow
// clone — skips, saying so; MODEL_APPS_PREVIOUS_BUNDLE names a copy of the bundle instead.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { createLifecycleOrg } = require('./helpers/fake-lifecycle-org.js');
const { kitchenSinkSpec, createLifecycleHarness, seedForeignWork, deployedFeatures, diffContents, appUniqueName } = require('./helpers/lifecycle-harness.js');
const { withVendoredCompiler, createMakerSdk } = require('../lib/maker-sdk.js');

const PREVIOUS_RELEASE = 'c159268b994b218729ff69ccdd74be3c83c56f86'; // model-apps 2.20.4
const BUNDLE_PATH = 'plugins/model-apps/scripts/vendor/cds-maker-sdk.cjs';
const scratch = makeTempDir('workspace-upgrade-');

// The previous bundle as a module of its own: from MODEL_APPS_PREVIOUS_BUNDLE, else from the release commit; null when neither is there.
function previousBundle() {
  let file = process.env.MODEL_APPS_PREVIOUS_BUNDLE || null;
  if (!file) {
    let text;
    try {
      text = execFileSync('git', ['show', `${PREVIOUS_RELEASE}:${BUNDLE_PATH}`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return null;
    }
    file = path.join(scratch, 'previous-cds-maker-sdk.cjs');
    fs.writeFileSync(file, text, 'utf8');
  }
  return require(file);
}
const previous = previousBundle();
const SKIP = previous ? false : `the previous release's SDK bundle is not available (no git history for ${PREVIOUS_RELEASE}; set MODEL_APPS_PREVIOUS_BUNDLE)`;

// The projection version of every copy in a workspace, per artifact folder: { apps: [8], forms: [8, 8, 8, 8], ... }.
function projections(workspaceDir) {
  const root = path.join(workspaceDir, '.metadata');
  const out = {};
  if (!fs.existsSync(root)) return out;
  for (const kind of fs.readdirSync(root)) {
    const dir = path.join(root, kind);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.meta.json'))) {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      if (Number.isInteger(meta.projectionVersion)) (out[kind] = out[kind] || []).push(meta.projectionVersion);
    }
  }
  return out;
}

// A maker's edits after the upgrade, one to each kind of copy the build keeps and edits: the app header, a view, a form, a chart, the
// dashboard, the navigation — and a command bar on a table that had none (a build never edits an existing bar: recreate to change).
function editedSpec() {
  const spec = kitchenSinkSpec();
  spec.app.description = 'One app that uses every feature, edited.';
  spec.views.find((v) => v.name === 'Open Tasks').columns.push('contoso_done');
  spec.forms.find((f) => f.name === 'Task').description = 'The task record, edited.';
  spec.charts[0].description = 'Workload by priority, edited.';
  spec.dashboards[0].description = 'Project health, edited.';
  spec.appShell.areas[0].groups[0].subAreas.find((s) => s.title === 'Help').title = 'Help Center';
  spec.commands.push({ entity: 'contoso_task', label: 'Close Task', location: 'MainTab', library: 'contoso_project.js', function: 'Project.escalate' });
  return spec;
}

// One path: the first build with `firstSdk`, then every later step with this bundle, on the same workspace and environment.
async function runPath(firstSdk) {
  const org = createLifecycleOrg();
  await seedForeignWork(org);
  const root = makeTempDir('workspace-upgrade-env-');
  const out = { org, seed: org.inventory(), seedContents: org.contents() };
  const first = createLifecycleHarness(org, root, { createMakerSdk: firstSdk });
  out.build = await first.measure(() => first.build(kitchenSinkSpec()));
  out.firstProjections = projections(first.workspaceDir);
  out.afterBuild = org.inventory();
  const harness = createLifecycleHarness(org, root);
  out.rebuild = await harness.measure(() => harness.build(kitchenSinkSpec()));
  out.afterRebuild = org.inventory();
  out.rebuildProjections = projections(harness.workspaceDir);
  const edited = editedSpec();
  out.editBuild = await harness.measure(() => harness.build(edited));
  out.edited = deployedFeatures(org);
  out.verify = await harness.measure(() => harness.verify(edited));
  out.download = await harness.measure(() => harness.download(appUniqueName(edited), path.join(root, 'download')));
  out.teardown = await harness.measure(() => harness.teardown(edited));
  out.afterTeardown = org.inventory();
  out.afterTeardownContents = org.contents();
  return out;
}

// One after the other: a download takes over process.stderr while it runs (helpers/lifecycle-harness.js), so two cannot overlap.
let pathsP;
const paths = () => pathsP || (pathsP = (async () => ({
  upgrade: await runPath(withVendoredCompiler(previous.createMakerSdk)),
  control: await runPath(createMakerSdk),
}))());

// A step's value, after checking that it threw nothing and sent nothing the fake does not model.
function stage(run, name) {
  const record = run[name];
  if (record.error) throw record.error;
  assert.deepEqual(record.unexpected, [], `every request the ${name} sent is one the fake models`);
  return record;
}
const versions = (byKind) => [...new Set(Object.values(byKind).flat())].sort((a, b) => a - b);

test('upgrade: the previous release builds the app and leaves copies of every kind at its own, older projection', { skip: SKIP }, async () => {
  const { upgrade, control } = await paths();
  assert.equal(stage(upgrade, 'build').value.result.ok, true, JSON.stringify(upgrade.build.value.result.errors));
  for (const kind of ['apps', 'forms', 'views', 'charts', 'dashboards', 'commands']) {
    assert.ok(upgrade.firstProjections[kind], `the previous build kept ${kind} copies (${Object.keys(upgrade.firstProjections)})`);
  }
  const [old] = versions(upgrade.firstProjections);
  const [current] = versions(control.firstProjections);
  assert.deepEqual(versions(upgrade.firstProjections), [old], 'one projection version in the old workspace');
  assert.ok(old < current, `this bundle projects at a newer version (${current}) than the previous one (${old}): the workspace is an old one`);
});

test('upgrade: an unchanged rebuild over the old workspace succeeds and sends exactly what it sends over a current one', { skip: SKIP }, async () => {
  const { upgrade, control } = await paths();
  const { value: { result, warnings } } = stage(upgrade, 'rebuild');
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(warnings, stage(control, 'rebuild').value.warnings, 'no warning the current workspace does not give');
  assert.deepEqual(upgrade.afterRebuild, upgrade.afterBuild, 'nothing created or deleted');
  assert.deepEqual(upgrade.rebuild.writes, control.rebuild.writes, 'the same writes as over a current workspace');
  // Every copy the rebuild edits is re-read and stamped current, so no later push meets the refusal. A command bar is never re-pushed by a
  // build (sdk-build.js: an existing bar is reused), so its old copy is left as it was — and is never pushed.
  const [current] = versions(control.firstProjections);
  for (const kind of ['apps', 'forms', 'views', 'charts', 'dashboards']) {
    assert.deepEqual([...new Set(upgrade.rebuildProjections[kind])], [current], `the ${kind} copies are re-read at the current projection`);
  }
});

test('upgrade: an edited rebuild over the old workspace applies the edits as over a current one, and verify passes', { skip: SKIP }, async () => {
  const { upgrade, control } = await paths();
  const { value: { result, warnings } } = stage(upgrade, 'editBuild');
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(warnings, stage(control, 'editBuild').value.warnings, 'no warning the current workspace does not give');
  assert.deepEqual(upgrade.editBuild.writes, control.editBuild.writes, 'the same writes as over a current workspace');
  assert.notDeepEqual(upgrade.editBuild.writes, upgrade.rebuild.writes, 'and the edits were written');
  assert.deepEqual(upgrade.edited, control.edited, 'the environment ends with the same features');
  const verify = stage(upgrade, 'verify').value;
  assert.equal(verify.ok, true, JSON.stringify(verify));
  assert.deepEqual(verify, stage(control, 'verify').value, 'verify reports what it reports over a current workspace');
});

test('upgrade: a download and a teardown after the upgrade work as after a current build, and leave the environment as it was', { skip: SKIP }, async () => {
  const { upgrade, control } = await paths();
  const download = stage(upgrade, 'download').value;
  assert.equal(download.emitted.ok, true, download.stderr);
  assert.equal(download.spec.app.description, 'One app that uses every feature, edited.');
  assert.deepEqual(upgrade.download.writes, {}, 'a download writes nothing');
  const teardown = stage(upgrade, 'teardown').value;
  assert.equal(teardown.result.ok, true, JSON.stringify(teardown.result));
  assert.deepEqual(upgrade.teardown.writes, stage(control, 'teardown').writes, 'the teardown deletes what it deletes after a current build');
  const builtPublisher = upgrade.afterBuild.rows.publishers.filter((p) => !upgrade.seed.rows.publishers.includes(p));
  const now = upgrade.afterTeardown;
  assert.deepEqual({ ...now, rows: { ...now.rows, publishers: now.rows.publishers.filter((p) => !builtPublisher.includes(p)) } }, upgrade.seed, 'every row but the build\'s publisher is as it was before the build');
  assert.deepEqual(diffContents(upgrade.seedContents, upgrade.afterTeardownContents, { added: false }), [], 'and holds exactly what it held');
});
