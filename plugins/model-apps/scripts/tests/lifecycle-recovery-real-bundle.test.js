'use strict';
// RECOVERY PINS around the lifecycle matrix (lifecycle-matrix-real-bundle.test.js): what a maker relies on when the environment and
// the spec part ways — over the same kitchen-sink spec, the REAL vendored SDK and the stateful fake Dataverse
// (helpers/fake-lifecycle-org.js, helpers/lifecycle-harness.js):
//
//   verify catches drift          what a maker deleted in Maker is named by verify, and a rebuild puts it back
//   a failed build resumes        a build that stops part way, run again, ends as a clean build ends: nothing missing, nothing twice
//   a failed teardown resumes     a teardown that stops part way, run again, deletes the rest and leaves everything else as it was
//   teardown never loses data     a teardown of a DOWNLOADED spec keeps every table, column, relationship, global choice and row
//   teardown is re-runnable       a teardown of what is already gone changes nothing and reports no error
//
// Two environments serve the tests, each walked in the order a maker meets these steps; as in the matrix, a step that throws is
// recorded and fails its own test (a later test on the same environment then fails after it):
//   CLEAN    built -> a maker deletes six artifacts in Maker -> verify -> rebuild | download -> teardown of the downloaded spec ->
//            teardown of the authored spec -> a teardown of what is gone
//   FAULTED  a build refused part way -> the build run again | a teardown refused part way -> the teardown run again
// A failure is provoked only by refusing a request for this test's own app, in front of the fake: the refused request never reaches
// the fake, so the environment holds what it would after a real refusal.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { createLifecycleOrg } = require('./helpers/fake-lifecycle-org.js');
const { kitchenSinkSpec, createLifecycleHarness, seedForeignWork, deployedFeatures, appUniqueName } = require('./helpers/lifecycle-harness.js');

const spec = kitchenSinkSpec();

// A fake environment with another maker's work in it, and a seam in front of its transport that refuses what `refuse` names.
async function environment() {
  const org = createLifecycleOrg();
  await seedForeignWork(org);
  const faults = [];
  // A refusal is a Dataverse OData error the client does not retry — { "error": { "code", "message" } } with a 400 — so the step fails
  // as it would on a real refusal. It holds until it is lifted, whatever the step retries. The error shape:
  // https://learn.microsoft.com/power-apps/developer/data-platform/webapi/compose-http-requests-handle-errors#parse-errors-from-the-response
  const request = async (req) => {
    const where = decodeURIComponent(new URL(req.url).pathname);
    const fault = faults.find((f) => f.method === req.method && f.path.test(where));
    if (!fault) return org.request(req);
    fault.hits += 1;
    return { statusCode: 400, headers: { 'content-type': 'application/json; odata.metadata=minimal' }, body: JSON.stringify({ error: { code: '0x80040216', message: fault.message } }) };
  };
  const refuse = (method, pathPattern, message) => {
    const fault = { method, path: pathPattern, message, hits: 0 };
    faults.push(fault);
    return { lift: () => { faults.splice(faults.indexOf(fault), 1); return fault.hits; } };
  };
  const harness = createLifecycleHarness({ ...org, request }, makeTempDir('lifecycle-recovery-'));
  return { org, harness, refuse, seed: org.inventory() };
}

// What a maker does in Maker, sent to the fake as the Web API call Maker makes.
async function inMaker(org, method, where) {
  const res = await org.request({ url: `${org.API}${where}`, method, headers: {} });
  assert.ok(res.statusCode < 300, `${method} ${where} answered ${res.statusCode}: ${res.body}`);
}

const buttonsOf = (org) => org.find('appactions', () => true).map((a) => a.buttonlabeltext).sort();

// CLEAN: the kitchen sink built, and what it deployed (the reference a recovered environment must end equal to); then a maker deletes
// a view, a Quick Create form, a button, the persona's role, the N:N relationship and the generative page; verify; the rebuild.
let cleanP;
const clean = () => cleanP || (cleanP = (async () => {
  const env = await environment();
  const { org, harness } = env;
  const build = await harness.build(spec);
  assert.equal(build.result.ok, true, JSON.stringify(build.result.errors));
  env.reference = deployedFeatures(org);
  env.buttons = buttonsOf(org);
  const one = (set, predicate) => { const rows = org.find(set, predicate); assert.equal(rows.length, 1, `one ${set} row matches`); return rows[0]; };
  await inMaker(org, 'DELETE', `/savedqueries(${one('savedqueries', (v) => v.name === 'My Open Tasks').savedqueryid})`);
  await inMaker(org, 'DELETE', `/systemforms(${one('systemforms', (f) => f.name === 'Task Quick Create').formid})`);
  await inMaker(org, 'DELETE', `/appactions(${one('appactions', (a) => a.buttonlabeltext === 'Escalate').appactionid})`);
  await inMaker(org, 'DELETE', `/roles(${one('roles', (r) => r.name === 'Kitchen Planner').roleid})`);
  await inMaker(org, 'DELETE', `/RelationshipDefinitions(${org.metadata.relationships.get('contoso_tag_contoso_task').MetadataId})`);
  // The page goes with its conversation, as the plugin's own teardown deletes it: a project delete does not cascade to the messages, and
  // whether Maker's page delete takes them too is not modelled — left behind, they would be two rows no teardown names.
  const page = [...org.pageServer.state.projects.values()].find((p) => p.name === 'Kitchen Page');
  for (const message of org.pageServer.messagesOf(page.id)) await inMaker(org, 'DELETE', `/agentconversationmessages(${message.id})`);
  await inMaker(org, 'DELETE', `/uxagentprojects(${page.id})`);
  env.drifted = await harness.measure(() => harness.verify(spec));
  env.rebuild = await harness.measure(() => harness.build(spec));
  env.afterRebuild = deployedFeatures(org);
  return env;
})());

// FAULTED: the build is refused its first form create — the solution, the data model, sample data, web resources, views and the chart
// are in by then — and run again once the refusal is lifted.
let faultedP;
const faulted = () => faultedP || (faultedP = (async () => {
  const env = await environment();
  const { harness, refuse } = env;
  const refusal = refuse('POST', /\/systemforms$/, 'An unexpected error occurred.');
  env.failedBuild = await harness.measure(() => harness.build(spec));
  env.failedBuild.hits = refusal.lift();
  env.resumedBuild = await harness.measure(() => harness.build(spec));
  env.afterResume = deployedFeatures(env.org);
  return env;
})());

// A measured step ran: it did not throw, and every request it sent is one the fake models.
const ran = (step, label) => {
  assert.ok(step, `${label} ran`);
  if (step.error) throw step.error;
  assert.deepEqual(step.unexpected, [], `every request ${label} sent is one the fake models`);
  return step;
};

// The environment is as the seed left it, but for the publisher the build made for the prefix: teardown never deletes a publisher.
function assertBackToSeed(org, seed) {
  const now = org.inventory();
  assert.deepEqual(now.rows.publishers.filter((p) => !seed.rows.publishers.includes(p)).map((p) => / contosopublisher$/.test(p)), [true]);
  assert.deepEqual({ ...now, rows: { ...now.rows, publishers: seed.rows.publishers } }, seed, 'every other row is as it was before the build');
}

// ====================================================================================================================================
// THE PINNED VALUES — one per step. A value that moves on purpose is a one-line change here.

// What verify reports for the six deletions, in its order. The deleted "Escalate" button is NOT among them: verify checks one command
// bar per table (verify-spec.js, "Commands (existence)"), and the table still has the flyout.
const DRIFT_MISSING = [
  'view contoso_task.My Open Tasks',
  'form Task Quick Create',
  'relationship contoso_tag_contoso_task',
  'page Kitchen Page',
  'role Kitchen Planner (persona security role not found (or its business unit could not be resolved))',
];

// The refused build stops at the phase that failed and says which, and why (the CLI prints it and exits non-zero)...
const FAILED_BUILD_ERROR = 'forms failed: HTTP 400 from https://contoso.crm.dynamics.com/api/data/v9.0/systemforms?$select=formid: An unexpected error occurred.';
// ...having written every phase before it, whole.
const FAILED_BUILD_WRITES = {
  'POST publishers': 1, 'POST solutions': 1, // solution
  'POST GlobalOptionSetDefinitions': 1, 'POST EntityDefinitions': 3, 'POST EntityDefinitions/Attributes': 17, 'POST InsertStatusValue': 1, // data model
  'POST EntityDefinitions/Keys': 1, 'POST CreateCustomerRelationships': 1, 'POST RelationshipDefinitions': 3, 'PUT EntityDefinitions': 2,
  'POST contoso_projects/Microsoft.Dynamics.CRM.CreateMultiple': 1, 'POST contoso_tasks/Microsoft.Dynamics.CRM.CreateMultiple': 1, // sample data
  'POST webresourceset': 2, // web resources: the script and the table icon
  'POST savedqueries': 3, 'PATCH savedqueries': 4, // views, and the default-view enrichment
  'POST savedqueryvisualizations': 1, // the chart
  'POST AddSolutionComponent': 6,
  'POST PublishXml': 4,
};

// The refused teardown: one table's delete fails, the teardown goes on as far as it can, keeps the solution for the re-run, and says so.
const FAILED_TEARDOWN_LINES = [
  "[18/27] ✗ table contoso_tag — HTTP 400 from https://contoso.crm.dynamics.com/api/data/v9.0/EntityDefinitions(LogicalName='contoso_tag'): The Entity component cannot be deleted because it is referenced by 1 other component.",
  '✗ teardown finished with errors — 25 deleted, 0 not found, 1 failed, 1 kept (27 steps)',
];
// The teardown run again: the table it could not delete and the solution it kept. A table or global choice is deleted by name, so the
// two tables and the global choice that are already gone are sent again and answered 404, which the teardown reads as "already gone".
const RESUMED_TEARDOWN_WRITES = { 'DELETE EntityDefinitions': 3, 'DELETE GlobalOptionSetDefinitions': 1, 'DELETE solutions': 1 };

// What a teardown of the downloaded spec deletes: the app and what is the app's own. Its tables, relationships and global choice are
// marked existing and kept; its forms, views, charts and commands are not in a downloaded spec, so they are kept too.
const DOWNLOADED_TEARDOWN_WRITES = {
  'DELETE appmodules': 1, // the app and its sitemap
  'DELETE sitemaps': 1,
  'DELETE uxagentprojects': 1, // the page, and its conversation
  'DELETE agentconversationmessages': 2,
  'DELETE systemforms': 1, // the dashboard, which the download pins by its id
  'DELETE webresourceset': 2, // the generated app icon and the page manifest
  // The solution: the download names the app's own unmanaged solution "for a later clean teardown" (docs/app-builder-capabilities.md,
  // "Edit flow"). Deleting an unmanaged solution deletes the container only; every component it held stays in the environment.
  'DELETE solutions': 1,
};

// A teardown of what is gone. This overstates what it did: a default-view reset, a relationship, a table or a global choice that was
// already gone is reported as deleted (each step is idempotent and ends ✓). Once that is fixed this reads "0 deleted, 27 not found".
const AGAIN_SUMMARY = '✓ teardown complete — 9 deleted, 18 not found, 0 failed (27 steps)';

// ====================================================================================================================================

test('lifecycle recovery: verify names every artifact a maker deleted in Maker, and a rebuild puts it back', async () => {
  const env = await clean();
  const drifted = ran(env.drifted, 'verify of the drifted app');
  assert.equal(drifted.value.ok, false);
  assert.deepEqual(drifted.value.missing.map((m) => `${m.kind} ${m.name}${m.detail ? ` (${m.detail})` : ''}`), DRIFT_MISSING);
  const rebuild = ran(env.rebuild, 'the rebuild of the drifted app');
  assert.equal(rebuild.value.result.ok, true, JSON.stringify(rebuild.value.result.errors));
  assert.deepEqual(rebuild.value.result.verify && { ok: rebuild.value.result.verify.ok, missing: rebuild.value.result.verify.missing }, { ok: true, missing: [] });
  // Documented: the command phase creates a table's command bar only when the table has none ("Button edits are not applied on
  // rebuild", references/app-spec-schema-advanced.md), so the deleted button stays deleted, and the build says it reused the bar.
  assert.deepEqual(buttonsOf(env.org), env.buttons.filter((label) => label !== 'Escalate'));
  assert.ok(rebuild.value.log.some((line) => line.includes("command bar for contoso_project (exists — reuse; button edits aren't applied on rebuild, recreate to change)")));
  assert.deepEqual({ ...env.afterRebuild, commands: env.reference.commands }, env.reference, 'every other deleted artifact is back, once, as the clean build made it');
});

test('lifecycle recovery: a build that fails part way, run again, ends as a clean build ends', async () => {
  const env = await faulted();
  const failed = env.failedBuild;
  assert.ok(failed.hits > 0, 'the refusal was hit');
  assert.deepEqual(failed.unexpected, []);
  assert.equal(failed.error && failed.error.message, FAILED_BUILD_ERROR);
  assert.deepEqual(failed.writes, FAILED_BUILD_WRITES);
  const resumed = ran(env.resumedBuild, 'the build run again');
  assert.equal(resumed.value.result.ok, true, JSON.stringify(resumed.value.result.errors));
  assert.deepEqual(env.afterResume, (await clean()).reference, 'nothing is missing, nothing is made twice, nothing is left unpublished');
});

test('lifecycle recovery: a teardown that fails part way, run again, deletes the rest and nothing else', async () => {
  const { org, harness, refuse, seed } = await faulted();
  const refusal = refuse('DELETE', /EntityDefinitions\(LogicalName='contoso_tag'\)$/, 'The Entity component cannot be deleted because it is referenced by 1 other component.');
  const failed = ran(await harness.measure(() => harness.teardown(spec)), 'the refused teardown');
  assert.ok(refusal.lift() > 0, 'the refusal was hit');
  assert.equal(failed.value.result.ok, false);
  assert.deepEqual(failed.value.log.filter((line) => /✗/.test(line)).map((line) => line.trim()), FAILED_TEARDOWN_LINES);
  const resumed = ran(await harness.measure(() => harness.teardown(spec)), 'the teardown run again');
  assert.equal(resumed.value.result.ok, true, JSON.stringify(resumed.value.result.errors));
  assert.deepEqual(resumed.writes, RESUMED_TEARDOWN_WRITES);
  assertBackToSeed(org, seed);
});

test('lifecycle recovery: a teardown of the downloaded spec keeps every table, column, relationship, global choice and row', async () => {
  const { org, harness, seed } = await clean();
  const dir = path.join(makeTempDir('lifecycle-recovery-download-'), 'app');
  const download = ran(await harness.measure(() => harness.download(appUniqueName(spec), dir)), 'the download');
  const before = deployedFeatures(org);
  const teardown = ran(await harness.measure(() => harness.teardown(download.value.spec, { workspace: path.join(dir, '.maker-workspace') })), 'the teardown of the downloaded spec');
  assert.equal(teardown.value.result.ok, true, JSON.stringify(teardown.value.result.errors));
  assert.deepEqual(teardown.writes, DOWNLOADED_TEARDOWN_WRITES);
  const after = deployedFeatures(org);
  for (const kept of ['tables', 'relationships', 'optionSets', 'records', 'views', 'charts', 'forms', 'commands']) assert.deepEqual(after[kept], before[kept], `the ${kept} are kept`);
  // The authored spec's teardown then deletes the rest...
  const rest = ran(await harness.measure(() => harness.teardown(spec)), 'the teardown of the authored spec');
  assert.equal(rest.value.result.ok, true, JSON.stringify(rest.value.result.errors));
  assertBackToSeed(org, seed);
  // ...and a teardown of what is gone changes nothing: what is resolved by a query is skipped when the query finds nothing, and a table
  // or global choice is deleted by name, the platform's 404 read as "already gone".
  const again = ran(await harness.measure(() => harness.teardown(spec)), 'the teardown of what is gone');
  assert.equal(again.value.result.ok, true, JSON.stringify(again.value.result.errors));
  assert.deepEqual(again.writes, { 'DELETE EntityDefinitions': 3, 'DELETE GlobalOptionSetDefinitions': 1 });
  assert.deepEqual(org.since(again.mark).filter((r) => r.method !== 'GET').map((r) => r.status), [404, 404, 404, 404]);
  assertBackToSeed(org, seed);
  assert.deepEqual(again.value.log.filter((line) => /teardown complete|finished with errors/.test(line)).map((line) => line.trim()), [AGAIN_SUMMARY]);
});
