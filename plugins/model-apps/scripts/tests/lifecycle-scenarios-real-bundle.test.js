'use strict';
// FOCUSED PINS around the lifecycle matrix (lifecycle-matrix-real-bundle.test.js): the paths a maker takes besides build -> rebuild ->
// download -> verify -> teardown, each over the same kitchen-sink spec, the REAL vendored SDK and the stateful fake Dataverse
// (helpers/fake-lifecycle-org.js, helpers/lifecycle-harness.js). Each pins a property whose silent loss would hurt a maker:
//
//   a preview never writes        a dry run of the build — on an empty environment and on a built one — and a teardown without
//                                 --apply send no write at all, and the teardown preview lists what --apply would delete
//   the download is stable        two downloads of an unchanged app write the same spec, byte for byte
//   --publish means what it says  a rebuild without it sends none of the bulk publishes it gates, and leaves the rest unpublished
//   the edit flow is safe         the downloaded spec rebuilds in the same environment without creating or deleting anything, and both
//                                 it and the authored spec verify
// (lifecycle-recovery-real-bundle.test.js pins the rest: drift, a failed build or teardown run again, a teardown of a downloaded spec.)
//
// One environment is built once and the tests use it in order — the ones that only read first, then the rebuilds.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { createLifecycleOrg } = require('./helpers/fake-lifecycle-org.js');
const { kitchenSinkSpec, createLifecycleHarness, seedForeignWork, publishesOf, appUniqueName } = require('./helpers/lifecycle-harness.js');

const spec = kitchenSinkSpec();
const APP = appUniqueName(spec);

// The environment the scenarios share: built once, with another maker's work in it.
let builtP;
const built = () => builtP || (builtP = (async () => {
  const org = createLifecycleOrg();
  await seedForeignWork(org);
  const root = makeTempDir('lifecycle-scenarios-');
  const harness = createLifecycleHarness(org, root);
  const build = await harness.measure(() => harness.build(spec));
  if (build.error) throw build.error;
  assert.equal(build.value.result.ok, true, JSON.stringify(build.value.result.errors));
  return { org, root, harness };
})());

// Every request a measured step sent was one the fake models, and the step did not throw.
const clean = (step, label) => {
  if (step.error) throw step.error;
  assert.deepEqual(step.unexpected, [], `every request ${label} sent is one the fake models`);
  return step;
};

// ====================================================================================================================================
// THE PINNED VALUES — one per scenario. A value that moves on purpose is a one-line change here.

// What teardown --apply would delete for the kitchen sink, in the order it would: the plan a maker approves (a page id is <id>).
const TEARDOWN_PLAN = [
  'app module "Kitchen Sink"',
  'generative pages proven for this app: <id> "Kitchen Page" (would delete)',
  'dashboard "Kitchen Overview"',
  'command bar for contoso_project',
  'form "Project" (contoso_project)',
  'form "Task Quick Create" (contoso_task)',
  'form "Task" (contoso_task)',
  'form "Project Card" (contoso_project)',
  'security role "Kitchen Planner"',
  'chart "Projects by Priority" (contoso_project)',
  'view "Open Projects" (contoso_project)',
  'view "Open Tasks" (contoso_task)',
  'view "My Open Tasks" (contoso_task)',
  'reset default views for contoso_project (drop parent lookups)',
  'reset default views for contoso_task (drop parent lookups)',
  'relationship contoso_project_contoso_task',
  'relationship contoso_tag_contoso_task',
  'table contoso_tag',
  'table contoso_task',
  'table contoso_project',
  'relationship contoso_project_contoso_project', // a self-referencing relationship goes with its table; this step finds it gone
  'web resource contoso_project.js',
  'web resource contoso_projecticon.svg',
  'web resource contoso_kitchensink_icon (generated app icon)',
  'web resource contoso_kitchensink_pagemanifest (page manifest)',
  'global choice contoso_stage',
  'solution ContosoKitchen',
];

// A rebuild of the unchanged spec WITHOUT --publish. The bulk publishes are what --publish gates (skills/app-builder/SKILL.md: the
// tables published together once before the app, and the publish phase); without it each step publishes what it re-pushed, table by
// table — measured, not derived: 11 publishes where the --publish rebuild of the matrix sends 4, each a PublishXml that takes seconds
// on a real environment. The two tables' views and forms are pushed concurrently, so the publishes are counted, not ordered.
const UNPUBLISHED_REBUILD_PUBLISHES = {
  contoso_project: 5, // the table icon set again; the view "Open Projects" pushed again unchanged (no write, but a publish); the
  //                     default-view enrichment; the forms "Project" and "Project Card", likewise unchanged
  contoso_task: 5, // the views "Open Tasks" and "My Open Tasks"; the default-view enrichment; the forms "Task Quick Create" and "Task"
  app: 1, // the app after the sitemap finalize, the last publish
};
// ...and what it leaves saved but not published, for the maker's own publish: the two Main forms whose default flag and security roles
// were written again, and the new look setting saved after the app's publish.
const UNPUBLISHED_AFTER = ['appsettings <id>', 'systemforms Project', 'systemforms Task'];

// The rebuild of the downloaded spec. Its tables are existing and it carries no form, view, chart or command, so nothing of the data
// model or the record UI is written; what is written is the app's own, as on any rebuild of an existing app.
const DOWNLOADED_REBUILD_WRITES = {
  'PATCH webresourceset': 1, // the page manifest: the downloaded page's source is pages/<pageId>/page.tsx, where the authored one was KitchenPage.tsx
  'PATCH sitemaps': 1, // the sitemap of an existing app is rewritten by the pages finalize, byte for byte (as in the matrix's rebuild)
  'POST AddAppComponents': 1, // ...and the push re-adds the app's components
  'POST SaveSettingValue': 1, // the new look setting is saved again
  'POST PublishXml': 5, // the tables before the app's publish, the page, the manifest, the app after the finalize, and the publish phase
};

// ====================================================================================================================================

test('lifecycle scenarios: a dry run of the build writes nothing, against an empty environment and against the built one', async () => {
  // An empty environment: everything would be created, nothing may be.
  const emptyOrg = createLifecycleOrg();
  const empty = createLifecycleHarness(emptyOrg, makeTempDir('lifecycle-scenarios-empty-'));
  const before = emptyOrg.inventory();
  const fresh = clean(await empty.measure(() => empty.build(spec, { apply: false })), 'the dry run on an empty environment');
  assert.equal(fresh.value.result.ok, true, JSON.stringify(fresh.value.result.errors));
  assert.equal(fresh.value.result.dryRun, true);
  assert.deepEqual(fresh.writes, {}, 'a preview sends no write');
  assert.deepEqual(emptyOrg.inventory(), before);
  // The built environment: everything would be reused, and nothing may be written either.
  const { org, harness } = await built();
  const held = org.inventory();
  const again = clean(await harness.measure(() => harness.build(spec, { apply: false })), 'the dry run on the built environment');
  assert.equal(again.value.result.ok, true, JSON.stringify(again.value.result.errors));
  assert.deepEqual(again.writes, {});
  assert.deepEqual(org.inventory(), held);
  // The live plan tells the two apart: on the empty environment nothing is reused, on the built one the tables and the app are.
  const stateOf = (r, label) => (r.value.result.planItems.find((p) => p.label === label) || {}).state;
  assert.equal(stateOf(fresh, 'app module "Kitchen Sink" + sitemap'), 'create');
  assert.equal(stateOf(again, 'app module "Kitchen Sink" + sitemap'), 'reuse');
});

test('lifecycle scenarios: a teardown without --apply writes nothing and lists every artifact the build made', async () => {
  const { org, harness } = await built();
  const held = org.inventory();
  const plan = clean(await harness.measure(() => harness.teardown(spec, { apply: false })), 'the teardown preview');
  assert.equal(plan.value.result.dryRun, true);
  assert.deepEqual(plan.writes, {}, 'a teardown preview sends no write');
  assert.deepEqual(org.inventory(), held);
  assert.deepEqual(plan.value.result.plan.map((line) => line.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')), TEARDOWN_PLAN);
});

test('lifecycle scenarios: two downloads of an unchanged app write the same spec', async () => {
  const { harness, root } = await built();
  const first = clean(await harness.measure(() => harness.download(APP, path.join(root, 'download-a'))), 'the first download');
  const second = clean(await harness.measure(() => harness.download(APP, path.join(root, 'download-b'))), 'the second download');
  assert.equal(first.value.emitted.ok, true, JSON.stringify(first.value.emitted));
  assert.equal(second.value.text, first.value.text, 'the spec is the same, byte for byte');
  // And downloading again into the folder that holds the first spec rewrites it unchanged (the page keys it gave are kept).
  const third = clean(await harness.measure(() => harness.download(APP, path.join(root, 'download-a'))), 'the download over the first');
  assert.equal(third.value.text, first.value.text);
});

test('lifecycle scenarios: a rebuild without --publish skips the bulk publishes, and leaves the rest unpublished', async () => {
  const { org, harness } = await built();
  const held = org.inventory();
  const rebuild = clean(await harness.measure(() => harness.build(spec, { publish: false })), 'the rebuild without --publish');
  assert.equal(rebuild.value.result.ok, true, JSON.stringify(rebuild.value.result.errors));
  assert.deepEqual(org.inventory(), held);
  const publishes = publishesOf(org, rebuild);
  assert.deepEqual(publishes.reduce((counts, name) => ({ ...counts, [name]: (counts[name] || 0) + 1 }), {}), UNPUBLISHED_REBUILD_PUBLISHES);
  assert.equal(publishes[publishes.length - 1], 'app');
  assert.deepEqual(rebuild.unpublished.map((row) => row.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')).sort(), UNPUBLISHED_AFTER);
});

test('lifecycle scenarios: the downloaded spec rebuilds in the same environment without creating or deleting anything, and verifies', async () => {
  const { org, harness, root } = await built();
  const dir = path.join(root, 'download-a');
  const downloaded = (await harness.download(APP, dir)).spec;
  const held = org.inventory();
  const rebuild = clean(await harness.measure(() => harness.build(downloaded, { appFolder: dir, workspace: path.join(dir, '.maker-workspace') })), 'the rebuild of the downloaded spec');
  assert.equal(rebuild.value.result.ok, true, JSON.stringify(rebuild.value.result.errors));
  assert.deepEqual(org.inventory(), held, 'nothing is created or deleted: the app keeps every form, view, chart, command and page the download did not carry');
  assert.deepEqual(rebuild.writes, DOWNLOADED_REBUILD_WRITES);
  const verified = clean(await harness.measure(() => harness.verify(downloaded, { workspace: path.join(dir, '.maker-workspace') })), 'verify of the downloaded spec');
  assert.deepEqual({ ok: verified.value.ok, missing: verified.value.missing }, { ok: true, missing: [] });
  // The authored spec still verifies too: the rebuild of the downloaded one took nothing away.
  const original = clean(await harness.measure(() => harness.verify(spec)), 'verify of the authored spec');
  assert.deepEqual({ ok: original.value.ok, missing: original.value.missing }, { ok: true, missing: [] });
});

