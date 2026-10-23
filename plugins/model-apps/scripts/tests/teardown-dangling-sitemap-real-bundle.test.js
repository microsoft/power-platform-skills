'use strict';
// The teardown of a published app whose navigation link names a sitemap that no longer exists.
//
// An app is two rows, the appmodule and its sitemap, and the bundled SDK deletes the two together once it has found the sitemap through the
// app's SiteMap component (componenttype 62) on its current layer. Before 2.18.0, the teardown of one app deleted the sitemap it used even when
// another app used that sitemap too. 2.18.0 refuses that, but environments where it happened hold apps whose SiteMap component names a sitemap
// that is gone: measured live, the component outlives the row it names. 2.17.0's delete looked an app's sitemap up by the app's unique name and, when
// no sitemap had that name, deleted such an app alone; the component-aware delete of the 2.18.0 SDK refuses it, on every run:
//   APP_SITEMAP_UNRESOLVED  Refusing to delete app '<app>': sitemap '<sitemap>' was not returned by the unpublished-aware read. … Retry.
// — and its "Retry." can never succeed.
//
// Teardown now proves the sitemap gone itself — by its id, in the published and in the saved layer, with no other app's current layer naming
// it, and with the link unchanged — having read the app's row version FIRST. Then it deletes the app ALONE, with one DELETE conditioned on that
// version, so a change of the app while the proof ran (a repair, a relink, a publish) makes the platform refuse the delete; it proves the app gone
// in both layers, and goes on. In every other case it refuses, with what it found and what the maker can do, never with "Retry" — and every error
// of this path stops the teardown before the steps that depend on the app, whatever its words say. It is reached only by a teardown that gets to
// the app step: an app whose live generative pages must first be proven from its navigation stops at that proof, as it did before.
//
// Over the REAL vendored SDK, the plugin's own HTTP client and the strict stateful fake of helpers/fake-lifecycle-org.js: a row that does not
// exist answers 404 0x80040217 by id and is in no collection read; a plain read of a collection is the published layer, and
// RetrieveUnpublishedMultiple is the saved one. The app is made by the build. The dangling link is made by a DISCLOSED FIXTURE STEP (`strand`):
// the sitemap is deleted the way another app's teardown deleted it, and the app's SiteMap component is put back, because the platform kept it
// (measured live) where this fake drops every component that names a row it deletes. A failure is provoked in front of the fake, for this
// test's own requests only; so is the platform's If-Match rule for the app's DELETE (`honourIfMatch`), which this fake does not apply to deletes.
//
//   1. the SDK's refusal: the one shape teardown recognises
//   2. a dangling link: teardown deletes that app alone and finishes — or, when that delete is refused (a change of the app while the proof ran
//      among others) or cannot be read back, stops before the steps that depend on the app, and a run again finishes
//   3. a dangling link teardown cannot prove gone: refused, never retried, nothing deleted — and no error of this path is taken for a row that is
//      not found or an artifact that cannot be deleted, whatever the app is called
//   4. what is unchanged: an ordinary teardown, and the SDK's own refusals — a sitemap another app shares, a link that changes while the SDK
//      reads it, a SiteMap component it cannot read, a namesake sitemap that is another app's navigation
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { createLifecycleOrg } = require('./helpers/fake-lifecycle-org.js');
const { createLifecycleHarness, diffContents } = require('./helpers/lifecycle-harness.js');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../lib/maker-sdk.js');
const { KIND_HANDLERS } = require('../lib/sdk-teardown.js');
const { RETRY, retryPolicyFor } = require('../lib/retry-policy.js');

// Loaded where it is used, so that a test fails on its own assertion when the module is not there.
const dangling = () => require('../lib/app-sitemap-dangling.js');

const SOLUTION = 'ContosoNav';
const APP = 'contoso_navc';
const APP_NAME = 'Nav C';
const OTHER_APP = '66666666-6666-4666-8666-666666666666';
const OTHER_LAYER = '77777777-7777-4777-8777-777777777777';
const ELSEWHERE = '44444444-4444-4444-8444-444444444444';

// The smallest app the build makes with navigation of its own: in its solution, published, a table in its sitemap. `appName` is its display name.
const spec = (appName = APP_NAME) => ({
  schemaVersion: 2,
  solution: { uniqueName: SOLUTION, displayName: 'Contoso Nav', publisherPrefix: 'contoso' },
  app: { name: appName, uniqueName: APP },
  entities: [{ schemaName: 'contact', displayName: 'Contact', existing: true, primaryAttribute: { schemaName: 'fullname', displayName: 'Full Name' }, columns: [] }],
  appShell: { areas: [{ label: 'Work', groups: [{ label: 'People', subAreas: [{ entity: 'contact', title: 'Contacts' }] }] }] },
});

// --- the environment ---------------------------------------------------------------------------------------------------------------------------------------

// A fake environment, and a seam in front of its transport that answers what a test's faults name instead of the fake. A refused request never
// reaches the fake (and so is not in its record of requests: a fault counts its own `hits`). A Dataverse refusal is an OData error:
//   { "error": { "code": "0x80040216", "message": "An unexpected error occurred." } }
// See: https://learn.microsoft.com/power-apps/developer/data-platform/webapi/compose-http-requests-handle-errors#parse-errors-from-the-response
function environment() {
  const org = createLifecycleOrg();
  const seed = { inventory: org.inventory(), contents: org.contents() };
  const faults = [];
  const request = async (req) => {
    const url = new URL(req.url);
    const where = decodeURIComponent(url.pathname + url.search).replace(/^\/api\/data\/v9\.\d/, '');
    const fault = faults.find((f) => f.method === req.method && f.matches(where));
    if (!fault) return org.request(req);
    fault.hits += 1;
    return fault.answer(req, where);
  };
  const add = (method, matches, answer) => {
    const fault = { method, matches, answer, hits: 0 };
    faults.push(fault);
    return fault;
  };
  const harness = createLifecycleHarness({ ...org, request }, makeTempDir('teardown-dangling-'));
  return { org, seed, harness, add };
}

const answered = (statusCode, body) => () => ({ statusCode, headers: { 'content-type': 'application/json; odata.metadata=minimal' }, body: JSON.stringify(body) });
const refusedWith = (statusCode, code, message) => answered(statusCode, { error: { code, message } });

// What another command or a maker does in the environment, sent to the fake as the Web API call it makes — around the seam.
async function direct(org, method, where, body) {
  const res = await org.request({ url: `${org.API}${where}`, method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.ok(res.statusCode < 300, `${method} ${where} answered ${res.statusCode}: ${res.body}`);
  return res;
}

// The app the build made from `appSpec`: its id, its current layer, and the sitemap its SiteMap component names.
async function built(env, appSpec = spec()) {
  const { result } = await env.harness.build(appSpec);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const [app] = env.org.find('appmodules', (a) => a.uniquename === APP);
  const layer = String(app.appmoduleidunique).toLowerCase();
  const links = env.org.find('appmodulecomponents', (c) => String(c._appmoduleidunique_value).toLowerCase() === layer && Number(c.componenttype) === 62);
  assert.equal(links.length, 1, 'the build links its app to one sitemap');
  return { id: String(app.appmoduleid).toLowerCase(), layer, sitemapId: String(links[0].objectid).toLowerCase(), link: links[0] };
}

// THE FIXTURE STEP. The app's sitemap is deleted the way another app's teardown deleted a sitemap the two apps shared — one DELETE of the row —
// and the app's SiteMap component is put back as it was. Measured live, the platform keeps the component of an app whose sitemap is deleted:
//   GET /appmodulecomponents?$select=objectid&$filter=_appmoduleidunique_value eq <the app's layer> and componenttype eq 62  ->  { "value": [ { "objectid": "<the deleted sitemap>" } ] }
//   GET /sitemaps(<the deleted sitemap>)?$select=sitemapid                                                                     ->  404
// This fake drops every component that names a row it deletes, so the component is written back.
async function strand(env, app) {
  await direct(env.org, 'DELETE', `/sitemaps(${app.sitemapId})`);
  await direct(env.org, 'POST', '/appmodulecomponents', {
    appmodulecomponentid: app.link.appmodulecomponentid, _appmoduleidunique_value: app.layer, objectid: app.sitemapId, componenttype: 62, rootcomponentbehavior: Number(app.link.rootcomponentbehavior) || 0,
  });
  assert.deepEqual(env.org.find('sitemaps', (s) => String(s.sitemapid).toLowerCase() === app.sitemapId), [], 'the sitemap is gone, in both layers');
  assert.equal(env.org.find('appmodulecomponents', (c) => String(c._appmoduleidunique_value).toLowerCase() === app.layer && String(c.objectid).toLowerCase() === app.sitemapId).length, 1, 'and the app still names it');
}

// The row version of the app as its read by id answers it (the version a conditional delete of it carries).
async function rowVersion(org, id) {
  const res = await direct(org, 'GET', `/appmodules(${id})?$select=appmoduleid`);
  return res.headers.etag;
}

// The reads teardown makes to prove the sitemap gone — by id, in each layer — the link, the app's row version, and the app gone after its delete.
const PUBLISHED_SITEMAP = (id) => `/sitemaps?$select=sitemapid&$filter=sitemapid eq ${id}`;
const SAVED_SITEMAP = (id) => `/sitemaps/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=sitemapid&$filter=sitemapid eq ${id}`;
const LINK = (layer) => `/appmodulecomponents?$select=objectid,componenttype&$filter=_appmoduleidunique_value eq ${layer} and componenttype eq 62`;
const APP_ROW = (id) => `/appmodules(${id})?$select=appmoduleid`;
const PUBLISHED_APP = (id) => `/appmodules?$select=appmoduleid&$filter=appmoduleid eq ${id}`;
const SAVED_APP = (id) => `/appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=appmoduleid&$filter=appmoduleid eq ${id}`;
const proofReads = (app) => [PUBLISHED_SITEMAP(app.sitemapId), SAVED_SITEMAP(app.sitemapId), LINK(app.layer), APP_ROW(app.id), PUBLISHED_APP(app.id), SAVED_APP(app.id)];

// What an ordinary teardown of this spec reads, by resource, in order: the page manifest's table and row; the app; the SDK's resolution of its sitemap (its
// read of the app, its current layer, the link, the sitemap by id and in the saved layer, the layer and the link again, and the apps that name that
// sitemap); then the generated web resources, the table the teardown keeps, and the solution.
const ORDINARY_READS = [
  'GET EntityDefinitions', 'GET webresourceset', 'GET appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple', 'GET appmodules',
  'GET appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple', 'GET appmodulecomponents', 'GET sitemaps', 'GET sitemaps/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple',
  'GET appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple', 'GET appmodulecomponents', 'GET appmodulecomponents', 'GET appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple',
  'GET webresourceset', 'GET webresourceset', 'GET EntityDefinitions', 'GET solutions',
];
// What the teardown of an app with a dangling link reads: the ordinary reads up to the SDK's refusal (its saved-layer read of the sitemap answers no
// row); the app's row version, read BEFORE the proof so that the delete is conditioned on the app as it was proven; the proof — the app's current
// layer and its link, the sitemap in the published and the saved layer, the apps that name it, the layer and the link again; after the app's
// delete, the app in the published and the saved layer; then the steps after the app, as ever.
const DANGLING_READS = [
  ...ORDINARY_READS.slice(0, 8),
  'GET appmodules',
  'GET appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple', 'GET appmodulecomponents', 'GET sitemaps', 'GET sitemaps/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple',
  'GET appmodulecomponents', 'GET appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple', 'GET appmodulecomponents',
  'GET appmodules', 'GET appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple',
  ...ORDINARY_READS.slice(12),
];

// A measured step ran: it did not throw, and every request it sent is one the fake models.
function ran(step, label) {
  assert.ok(step, `${label} ran`);
  if (step.error) throw step.error;
  assert.deepEqual(step.unexpected, [], `every request ${label} sent is one the fake models`);
  return step;
}

// Back where the environment started, but for the publisher the build made for the prefix (teardown never deletes a publisher), and nothing the
// environment had before was touched (the proof the lifecycle matrix makes of a whole teardown).
function backToSeed(env) {
  const after = env.org.inventory();
  const made = after.rows.publishers.filter((p) => !env.seed.inventory.rows.publishers.includes(p));
  assert.equal(made.length, 1, 'the one row left that the environment did not have is the build\'s publisher');
  assert.deepEqual({ ...after, rows: { ...after.rows, publishers: after.rows.publishers.filter((p) => !made.includes(p)) } }, env.seed.inventory, 'everything the build made is gone, and nothing the environment had is missing');
  assert.deepEqual(diffContents(env.seed.contents, env.org.contents(), { added: false }), [], 'nothing the environment had before was touched');
}

// The SDK's own refusal for an app whose sitemap is gone, word for word.
const sdkRefusal = (app) => `Refusing to delete app '${app.id}': sitemap '${app.sitemapId}' was not returned by the unpublished-aware read. Deleting the app would destroy the only pointer to its sitemap, stranding that row and reserving its unique name forever. Retry.`;

// --- 1. the SDK's refusal ----------------------------------------------------------------------------------------------------------------------------------

test('the SDK refuses to delete an app whose sitemap is gone, in the one shape teardown recognises — and no other refusal is taken for it', async () => {
  const env = environment();
  const app = await built(env);
  await strand(env, app);
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(makeTempDir('teardown-dangling-sdk-')), instanceUrl: env.org.origin, httpClient: env.harness.client });
  await sdk.initWorkspace();
  const mark = env.org.mark();
  const refused = await sdk.deleteAppCascade(app.id, app.layer).then(() => null, (e) => e);
  assert.ok(refused, 'the SDK refuses');
  assert.equal(refused.code, 'APP_SITEMAP_UNRESOLVED');
  assert.equal(refused.message, sdkRefusal(app));
  assert.deepEqual(env.org.writes(mark), [], 'and writes nothing');
  assert.deepEqual(dangling().danglingSitemapOf(refused, app.id), { sitemapId: app.sitemapId }, 'teardown recognises it, for this app');
  assert.deepEqual(dangling().danglingSitemapOf(refused, app.id.toUpperCase()), { sitemapId: app.sitemapId }, 'however the app id is spelled');
  assert.equal(dangling().danglingSitemapOf(refused, OTHER_APP), null, 'and never as the refusal of another app');
  // The SDK raises the same code for every way its resolution of the sitemap can fail; each other one is the SDK's to explain, and stays as it is.
  for (const message of [
    `Refusing to delete app '${app.id}': its sitemap link changed while it was read (sitemap '${app.sitemapId}' by component, then '${ELSEWHERE}' by component). Deleting the app would destroy the only pointer to its sitemap, stranding that row and reserving its unique name forever. Retry.`,
    `Refusing to delete app '${app.id}': reading sitemap '${app.sitemapId}' returned HTTP 503. Deleting the app would destroy the only pointer to its sitemap, stranding that row and reserving its unique name forever. Retry.`,
    `Refusing to delete app '${app.id}': its current layer carries 2 SiteMap components, where an app can hold one, so it cannot be determined which sitemap is this app's. Nothing was deleted. Retry.`,
  ]) assert.equal(dangling().danglingSitemapOf({ code: 'APP_SITEMAP_UNRESOLVED', message }, app.id), null, message);
  assert.equal(dangling().danglingSitemapOf({ code: 'APP_SITEMAP_SHARED', message: refused.message }, app.id), null, 'nor another code with the same words');
  assert.equal(dangling().danglingSitemapOf(new Error(refused.message), app.id), null, 'nor an error with no code');
  assert.deepEqual(env.org.unexpected, []);
});

// --- 2. a dangling link: the app alone -------------------------------------------------------------------------------------------------------------------

test('a dangling link on this spec\'s own app: teardown deletes exactly that app, alone and conditioned on its row version, proves it gone in both layers, and finishes', async () => {
  const env = environment();
  const app = await built(env);
  await strand(env, app);
  const version = await rowVersion(env.org, app.id);
  const run = ran(await env.harness.measure(() => env.harness.teardown(spec())), 'the teardown');
  const { result, log } = run.value;
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.deleted.app, [app.id], 'the app step deleted that app');

  const writes = env.org.writes(run.mark);
  assert.deepEqual(writes.filter((w) => /^\/(appmodules|sitemaps|\$batch)\b/.test(w.path)).map((w) => `${w.method} ${w.path}${w.batched ? ' (in a change set)' : ''}`), [`DELETE /appmodules(${app.id})`], 'one request: the app, alone');
  assert.ok(!writes.some((w) => /sitemap/i.test(w.path)), 'no sitemap is written, let alone deleted');
  const appDelete = writes.find((w) => w.path === `/appmodules(${app.id})`);
  const ifMatch = Object.entries(appDelete.headers || {}).find(([k]) => k.toLowerCase() === 'if-match');
  assert.deepEqual(ifMatch && ifMatch[1], version, 'conditioned on the row version the app had');
  assert.deepEqual(run.writes, { 'DELETE appmodules': 1, 'DELETE webresourceset': 1, 'DELETE solutions': 1 }, 'an ordinary teardown\'s writes, but for the sitemap, which was already gone');

  // The proof came first, by id in each layer, and the app was read again in both layers after its delete.
  const sent = env.org.since(run.mark).map((r) => `${r.method} ${r.path}`);
  const at = (line) => { const i = sent.indexOf(line); assert.ok(i > -1, `sent: ${line}`); return i; };
  const deleted = at(`DELETE /appmodules(${app.id})`);
  for (const read of [PUBLISHED_SITEMAP(app.sitemapId), SAVED_SITEMAP(app.sitemapId), LINK(app.layer), APP_ROW(app.id)]) assert.ok(at(`GET ${read}`) < deleted, `${read} before the delete`);
  for (const read of [PUBLISHED_APP(app.id), SAVED_APP(app.id)]) assert.ok(at(`GET ${read}`) > deleted, `${read} after the delete`);
  assert.ok(at(`GET ${APP_ROW(app.id)}`) < at(`GET ${LINK(app.layer)}`), 'the app\'s row version is read BEFORE the proof begins: the delete is conditioned on the app as it was proven');
  assert.equal(sent.filter((line) => line === `GET ${LINK(app.layer)}`).length, 2, 'the link is read again after the sitemap, as the SDK reads it again');
  assert.deepEqual(env.org.readNames(run.mark), DANGLING_READS);
  assert.equal(run.end - run.mark, 25, 'the reads, the app\'s delete, and the two deletes after it');

  assert.equal(env.org.rowsOf('appmodules').has(app.id), false, 'the app is gone');
  backToSeed(env);
  // Said once, in the result and in the log: the app went without its sitemap, and why.
  assert.equal((result.warnings || []).length, 1, JSON.stringify(result.warnings));
  assert.match(result.warnings[0], new RegExp(`^app "${APP_NAME}" \\(${app.id}\\) was deleted without its sitemap: its navigation link named sitemap ${app.sitemapId}, which is in neither the published nor the saved layer .*no sitemap was touched`));
  assert.ok(log.some((line) => line.includes(`⚠ teardown warning: ${result.warnings[0]}`)), 'and the log says it');
  assert.ok(log.some((line) => /^✓ teardown complete — /.test(line.trim())), 'the teardown completes');
});

// The platform's answer to a delete conditioned on a version the row no longer has, and the final refusal teardown makes of it.
const VERSION_MOVED = "The version of the existing record doesn't match the RowVersion property provided.";
const versionMoved = (app, name = APP_NAME) => `app "${name}" (${app.id}) was not deleted: its sitemap ${app.sitemapId} is gone, but the app changed while teardown was proving that, so the platform refused a delete conditioned on the version the proof began at (HTTP 412: 0x80060882 ${VERSION_MOVED}). Nothing was deleted. Run the teardown again: it proves the app as it is now before it deletes anything.`;
const notAttempted = (result) => result.skipped.length > 0 && result.skipped.every((line) => / \(not attempted — the app was not deleted\)$/.test(line));

test('a dangling link, and the platform refuses the app\'s delete on its row version (412): a final refusal — nothing is deleted, no step after the app is attempted, and nothing asks for a retry', async () => {
  const env = environment();
  const app = await built(env);
  await strand(env, app);
  const refused = env.add('DELETE', (w) => w === `/appmodules(${app.id})`, refusedWith(412, '0x80060882', VERSION_MOVED));
  const before = env.org.contents();
  const run = ran(await env.harness.measure(() => env.harness.teardown(spec())), 'the teardown');
  const { result } = run.value;
  assert.equal(refused.hits, 1, 'the app\'s delete was sent once');
  assert.equal(result.ok, false);
  assert.deepEqual(env.org.contents(), before, 'the environment holds exactly what it held');
  assert.deepEqual(result.errors, [{ step: `app module "${APP_NAME}"`, message: versionMoved(app) }]);
  assert.doesNotMatch(result.errors[0].message, /\bretry\b/i);
  assert.ok(notAttempted(result), JSON.stringify(result.skipped));
});

test('a dangling link, and the app cannot be read back after its delete: the steps that depend on it wait, and the teardown run again finds the app gone and finishes', async () => {
  const env = environment();
  const app = await built(env);
  await strand(env, app);
  const unreadable = env.add('GET', (w) => w === PUBLISHED_APP(app.id), refusedWith(503, '0x80040216', 'Service Unavailable'));
  const first = ran(await env.harness.measure(() => env.harness.teardown(spec())), 'the teardown');
  // The client sends a read that answers 503 again before it gives up (lib/sdk-http-client.js), so the fault is met more than once.
  assert.ok(unreadable.hits >= 1, 'the app was read back');
  assert.equal(first.value.result.ok, false);
  assert.equal(env.org.rowsOf('appmodules').has(app.id), false, 'the delete ran');
  assert.deepEqual(first.writes, { 'DELETE appmodules': 1 }, 'and nothing after it');
  const [error] = first.value.result.errors;
  assert.match(error.message, new RegExp(`^app "${APP_NAME}" \\(${app.id}\\): its sitemap ${app.sitemapId} is gone and the app's delete was sent \\(HTTP 204\\), but whether the app is gone could not be read \\(.*HTTP 503.*\\), so the steps that depend on it are not attempted\\. Run the teardown again: `));
  assert.ok(first.value.result.skipped.every((line) => / \(not attempted — the app was not deleted\)$/.test(line)), JSON.stringify(first.value.result.skipped));

  // The read answers again, as an environment does once it is back.
  unreadable.matches = () => false;
  const again = ran(await env.harness.measure(() => env.harness.teardown(spec())), 'the teardown run again');
  assert.equal(again.value.result.ok, true, JSON.stringify(again.value.result.errors));
  assert.deepEqual(again.writes, { 'DELETE webresourceset': 1, 'DELETE solutions': 1 }, 'the rest, and no app or sitemap write');
  backToSeed(env);
});

// The strict fake does not apply If-Match to a DELETE, so this seam applies the platform's documented rule to the app's delete: a delete conditioned
// on a version the row no longer has is refused — 412 0x80060882 — and changes nothing. An app's read by id answers its version as W/"<n>"
// (helpers/fake-lifecycle-org.js), the token such a delete carries.
// See: https://learn.microsoft.com/power-apps/developer/data-platform/webapi/perform-conditional-operations-using-web-api#apply-optimistic-concurrency
function honourIfMatch(env, app) {
  return env.add('DELETE', (w) => w === `/appmodules(${app.id})`, (req) => {
    const sent = Object.entries(req.headers || {}).find(([name]) => name.toLowerCase() === 'if-match');
    const row = env.org.rowsOf('appmodules').get(app.id);
    if (sent && row && sent[1] !== `W/"${row.version}"`) return refusedWith(412, '0x80060882', VERSION_MOVED)();
    return env.org.request(req);
  });
}

test('a dangling link the app is repaired from while teardown proves it — relinked to a new sitemap and published right after teardown\'s last read of its link: the delete, conditioned on the version the proof began at, is refused, and the app, its new sitemap and every step after the app stay', async () => {
  const env = environment();
  const app = await built(env);
  await strand(env, app);
  const REPAIRED = '55555555-5555-4555-8555-555555555555';
  let linkReads = 0;
  env.add('GET', (w) => w === LINK(app.layer), async (req) => {
    linkReads += 1;
    const answer = await env.org.request(req);
    if (linkReads === 2) {
      // Another maker repairs the app the moment teardown has read its link the second, last time: a new sitemap, the app linked to it in place
      // of the one that is gone, and the app published. Each is a change of THIS app, and each moves its row version.
      await direct(env.org, 'POST', '/sitemaps', { sitemapid: REPAIRED, sitemapname: 'Repaired', sitemapnameunique: 'contoso_repaired', sitemapxml: '<SiteMap><Area Id="a"><Group Id="g"><SubArea Id="s" Url="https://contoso.example/repaired" /></Group></Area></SiteMap>' });
      await direct(env.org, 'POST', '/RemoveAppComponents', { AppId: app.id, Components: [{ '@odata.type': 'Microsoft.Dynamics.CRM.sitemap', sitemapid: app.sitemapId }] });
      await direct(env.org, 'POST', '/AddAppComponents', { AppId: app.id, Components: [{ '@odata.type': 'Microsoft.Dynamics.CRM.sitemap', sitemapid: REPAIRED }] });
      await direct(env.org, 'POST', '/PublishXml', { ParameterXml: `<importexportxml><appmodules><appmodule>${app.id}</appmodule></appmodules></importexportxml>` });
    }
    return answer;
  });
  const appDelete = honourIfMatch(env, app);
  const run = ran(await env.harness.measure(() => env.harness.teardown(spec())), 'the teardown');
  const { result } = run.value;
  assert.equal(linkReads, 2, 'the repair came after teardown\'s second, last read of the link');
  assert.equal(result.ok, false, 'the repaired app is not deleted');
  assert.equal(env.org.rowsOf('appmodules').has(app.id), true, 'the app is still there');
  assert.equal(env.org.find('sitemaps', (s) => String(s.sitemapid).toLowerCase() === REPAIRED).length, 1, 'so is its new sitemap');
  assert.equal(env.org.find('appmodulecomponents', (c) => String(c.objectid).toLowerCase() === REPAIRED && Number(c.componenttype) === 62).length, 1, 'still its navigation');
  assert.equal(appDelete.hits, 1, 'the app\'s delete was sent once');
  assert.deepEqual(env.org.writes(run.mark).filter((w) => w.method === 'DELETE'), [], 'no delete reached the environment');
  assert.deepEqual(result.errors, [{ step: `app module "${APP_NAME}"`, message: versionMoved(app) }]);
  assert.ok(notAttempted(result), JSON.stringify(result.skipped));
});

test('an app whose display name reads like a platform refusal ("System Managed Ops"), with a dangling link teardown cannot prove gone: the refusal is not taken for an undeletable artifact — nothing is written, and no step after the app is attempted', async () => {
  const env = environment();
  const NAMED = 'System Managed Ops';
  const app = await built(env, spec(NAMED));
  await strand(env, app);
  const fault = env.add('GET', (w) => w === SAVED_SITEMAP(app.sitemapId), refusedWith(403, '0x80040220', 'The user is not a member of the organization.'));
  const before = env.org.contents();
  const run = ran(await env.harness.measure(() => env.harness.teardown(spec(NAMED))), 'the teardown');
  const { result } = run.value;
  assert.equal(result.ok, false, 'the app step failed, and was not skipped as undeletable');
  assert.deepEqual(env.org.writes(run.mark), [], 'not one write: no web resource, no solution');
  assert.deepEqual(env.org.contents(), before, 'the environment holds exactly what it held');
  assert.equal(result.errors.length, 1, JSON.stringify(result.errors));
  assert.equal(result.errors[0].step, `app module "${NAMED}"`);
  assert.match(result.errors[0].message, new RegExp(`^app "${NAMED}" \\(${app.id}\\) was not deleted: .*the saved layer could not be read \\(.*HTTP 403`));
  assert.ok(notAttempted(result), JSON.stringify(result.skipped));
  assert.ok(fault.hits >= 1, 'the read teardown could not use was sent');
});

// A read back refused with words that say "not found" — an OData 404 of a proxy or of the service:
//   { "error": { "code": "0x80060888", "message": "Resource not found for the segment 'appmodules'." } }
for (const [layer, readBack] of [['published', PUBLISHED_APP], ['saved', SAVED_APP]]) {
  test(`a dangling link, and the app's read back in the ${layer} layer is refused with words that say "not found": the step fails rather than count as a delete, nothing that depends on the app is touched, and a run again finishes`, async () => {
    const env = environment();
    const app = await built(env);
    await strand(env, app);
    const proxy = env.add('GET', (w) => w === readBack(app.id), refusedWith(404, '0x80060888', "Resource not found for the segment 'appmodules'."));
    const first = ran(await env.harness.measure(() => env.harness.teardown(spec())), 'the teardown');
    assert.ok(proxy.hits >= 1, 'the app was read back');
    assert.equal(first.value.result.ok, false, 'not counted as a delete');
    assert.equal(env.org.rowsOf('appmodules').has(app.id), false, 'the delete ran');
    assert.deepEqual(first.writes, { 'DELETE appmodules': 1 }, 'and nothing after it');
    assert.equal(first.value.result.warnings, undefined, 'no note that the app went without its sitemap: that is not proven');
    assert.match(first.value.result.errors[0].message, new RegExp(`^app "${APP_NAME}" \\(${app.id}\\): its sitemap ${app.sitemapId} is gone and the app's delete was sent \\(HTTP 204\\), but whether the app is gone could not be read \\(.*Resource not found for the segment 'appmodules'.*\\)`));
    assert.ok(notAttempted(first.value.result), JSON.stringify(first.value.result.skipped));

    proxy.matches = () => false;
    const again = ran(await env.harness.measure(() => env.harness.teardown(spec())), 'the teardown run again');
    assert.equal(again.value.result.ok, true, JSON.stringify(again.value.result.errors));
    assert.deepEqual(again.writes, { 'DELETE webresourceset': 1, 'DELETE solutions': 1 }, 'the rest, and no app or sitemap write');
    backToSeed(env);
  });
}

// --- 3. a dangling link teardown cannot prove gone ---------------------------------------------------------------------------------------------------------

// The words of a refusal for a sitemap teardown could not prove gone: why, after the rule (`words` is a pattern).
const unproven = (words) => new RegExp(`Teardown deletes such an app on its own only once that sitemap is proven gone, and it could not prove it: ${words}`);

// Each case: what goes wrong (arranged after the fixture step; a fault in front of the fake, or what the environment holds), and the words of
// the refusal that say so. A case that answers in place of the fake returns its fault, which must have been hit.
const UNPROVEN = [
  {
    title: 'the published layer cannot be read',
    arrange: (env, app) => env.add('GET', (w) => w === PUBLISHED_SITEMAP(app.sitemapId), refusedWith(503, '0x80040216', 'Service Unavailable')),
    why: () => unproven('the published layer could not be read \\(.*HTTP 503'),
  },
  {
    title: 'the saved layer cannot be read',
    arrange: (env, app) => env.add('GET', (w) => w === SAVED_SITEMAP(app.sitemapId), refusedWith(403, '0x80040220', 'The user is not a member of the organization.')),
    why: () => unproven('the saved layer could not be read \\(.*HTTP 403'),
  },
  {
    title: 'the saved layer answers with no list',
    arrange: (env, app) => env.add('GET', (w) => w === SAVED_SITEMAP(app.sitemapId), answered(200, { value: 'none' })),
    why: () => unproven('the saved layer could not be read \\(.*no readable result set'),
  },
  {
    title: 'the saved layer answers a row of another sitemap',
    arrange: (env, app) => env.add('GET', (w) => w === SAVED_SITEMAP(app.sitemapId), answered(200, { value: [{ sitemapid: ELSEWHERE }] })),
    why: () => unproven('the saved layer answered a row that is not that sitemap\\.'),
  },
  {
    title: 'the published layer still answers the sitemap',
    arrange: (env, app) => env.add('GET', (w) => w === PUBLISHED_SITEMAP(app.sitemapId), answered(200, { value: [{ sitemapid: app.sitemapId }] })),
    why: () => unproven('the published layer still holds it\\.'),
  },
  {
    title: 'another app\'s current layer names the sitemap too',
    arrange: async (env, app) => {
      await direct(env.org, 'POST', '/appmodules', { appmoduleid: OTHER_APP, appmoduleidunique: OTHER_LAYER, uniquename: 'contoso_other', name: 'Other', clienttype: 4 });
      await direct(env.org, 'POST', '/appmodulecomponents', { _appmoduleidunique_value: OTHER_LAYER, objectid: app.sitemapId, componenttype: 62, rootcomponentbehavior: 0 });
      return null;
    },
    why: () => unproven(`the navigation of app '${OTHER_APP}' names it too\\.`),
  },
  {
    title: 'the link changes while teardown reads it',
    // Another writer relinks the app between teardown's two reads of the link: the second read answers the new link.
    arrange: (env, app) => {
      const fault = env.add('GET', (w) => w === LINK(app.layer), (req) => {
        if (fault.hits === 2) env.org.rowsOf('appmodulecomponents').get(String(app.link.appmodulecomponentid).toLowerCase()).data.objectid = ELSEWHERE;
        return env.org.request(req);
      });
      return fault;
    },
    why: (app) => unproven(`the link changed while teardown read it \\(sitemap ${app.sitemapId}, then sitemap ${ELSEWHERE}\\)\\.`),
    relinks: true,
  },
  {
    title: 'the app has no row version to make its delete conditional on',
    arrange: (env, app) => env.add('GET', (w) => w === APP_ROW(app.id), refusedWith(404, '0x80040217', `appmodule With Id = ${app.id} Does Not Exist`)),
    why: () => /Teardown deletes such an app on its own only with a delete conditioned on the app's row version, and it could not read one: its read by id answered HTTP 404: it was never published, or it was deleted meanwhile\. /,
  },
];

for (const c of UNPROVEN) {
  test(`a dangling link teardown cannot prove gone — ${c.title}: refused with what was found and what to do, never "Retry", and nothing is deleted`, async () => {
    const env = environment();
    const app = await built(env);
    await strand(env, app);
    const fault = await c.arrange(env, app);
    const before = env.org.contents();
    const run = ran(await env.harness.measure(() => env.harness.teardown(spec())), 'the teardown');
    const { result } = run.value;
    assert.equal(result.ok, false);
    assert.deepEqual(env.org.writes(run.mark), [], 'not one write reached the environment');
    const after = env.org.contents();
    if (c.relinks) {
      // The relink itself is the one change, and it is the fault's, not the teardown's.
      const key = `row appmodulecomponents ${String(app.link.appmodulecomponentid).toLowerCase()}`;
      delete before[key];
      delete after[key];
    }
    assert.deepEqual(after, before, 'the environment holds exactly what it held');
    assert.equal(env.org.rowsOf('appmodules').has(app.id), true, 'the app is still there');

    assert.equal(result.errors.length, 1, JSON.stringify(result.errors));
    const [error] = result.errors;
    assert.equal(error.step, `app module "${APP_NAME}"`);
    assert.match(error.message, new RegExp(`^app "${APP_NAME}" \\(${app.id}\\) was not deleted: its navigation link names sitemap ${app.sitemapId}, which the SDK could not read\\. `));
    assert.match(error.message, c.why(app));
    assert.match(error.message, /Nothing was deleted\. If this app is yours, delete it in Power Apps \(make\.powerapps\.com, Apps\), then run the teardown again: it removes the rest\.$/);
    assert.doesNotMatch(error.message, /\bretry\b/i, 'a run again as it is changes nothing, so it is not asked for');
    assert.ok(result.skipped.length > 0 && result.skipped.every((line) => / \(not attempted — the app was not deleted\)$/.test(line)), `every later step is not attempted: ${JSON.stringify(result.skipped)}`);
    if (fault) assert.ok(fault.hits >= 1, 'the read teardown could not use was sent');
  });
}

test('the refusal is final: it is marked so, the build\'s retry policy never runs it again, and the SDK\'s own refusal stays its cause', async () => {
  const env = environment();
  const app = await built(env);
  await strand(env, app);
  env.add('GET', (w) => w === SAVED_SITEMAP(app.sitemapId), refusedWith(503, '0x80040216', 'Service Unavailable'));
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(makeTempDir('teardown-dangling-sdk-')), instanceUrl: env.org.origin, httpClient: env.harness.client });
  await sdk.initWorkspace();
  const [item] = await KIND_HANDLERS.app.resolve(sdk, { uniqueName: APP });
  assert.equal(item.id, app.id);
  const error = await KIND_HANDLERS.app.del(sdk, item, { warnings: [] }).then(() => null, (e) => e);
  assert.ok(error, 'the app step fails');
  assert.equal(error.transient, false, 'marked final');
  assert.equal(retryPolicyFor(error), RETRY.NEVER, 'even with a 503 in the read that failed: a run again proves nothing new on its own');
  assert.doesNotMatch(error.message, /\bretry\b/i);
  assert.equal(error.cause && error.cause.code, 'APP_SITEMAP_UNRESOLVED', 'the SDK\'s refusal is kept as its cause');
  assert.equal(error.cause.message, sdkRefusal(app));
});

// Every error that leaves this path stops the teardown before what depends on the app, whatever its words: it is marked `failClosed`, which
// deleteStep passes on before its shortcuts (below). A proof that cannot be made and a delete refused on a moved version are final as well.
test('every error the dangling-link path throws is marked failClosed; a proof that cannot be made and a delete refused on its version are final', async () => {
  const CASES = [
    ['a proof that cannot be made', (env, app) => env.add('GET', (w) => w === SAVED_SITEMAP(app.sitemapId), refusedWith(403, '0x80040220', 'The user is not a member of the organization.')), true],
    ['a delete refused on its version', (env, app) => env.add('DELETE', (w) => w === `/appmodules(${app.id})`, refusedWith(412, '0x80060882', VERSION_MOVED)), true],
    ['a delete answered with no change', (env, app) => env.add('DELETE', (w) => w === `/appmodules(${app.id})`, refusedWith(400, '0x80040216', 'An unexpected error occurred.')), false],
    ['a read back that cannot be made', (env, app) => env.add('GET', (w) => w === PUBLISHED_APP(app.id), refusedWith(404, '0x80060888', "Resource not found for the segment 'appmodules'.")), false],
  ];
  for (const [what, arrange, final] of CASES) {
    const env = environment();
    const app = await built(env);
    await strand(env, app);
    arrange(env, app);
    const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(makeTempDir('teardown-dangling-sdk-')), instanceUrl: env.org.origin, httpClient: env.harness.client });
    await sdk.initWorkspace();
    const [item] = await KIND_HANDLERS.app.resolve(sdk, { uniqueName: APP });
    const error = await KIND_HANDLERS.app.del(sdk, item, { warnings: [] }).then(() => null, (e) => e);
    assert.ok(error, `${what}: the app step fails`);
    assert.equal(error.failClosed, true, `${what}: marked failClosed`);
    assert.doesNotMatch(error.message, /\bretry\b/i, what);
    if (final) {
      assert.equal(error.transient, false, `${what}: final`);
      assert.equal(retryPolicyFor(error), RETRY.NEVER, what);
    }
  }
});

test('deleteStep: an error marked failClosed is passed on before every shortcut — not found, a dependency block, an undeletable artifact — and an unmarked one is read exactly as before', async () => {
  const { deleteStep } = require('../lib/sdk-teardown.js');
  const item = { id: 'a1', name: 'System Managed Ops' };
  let asked = 0;
  const handler = (error, extra = {}) => ({ del: async () => { throw error; }, confirmAbsent: async () => { asked += 1; return true; }, ...extra });
  // Unmarked, as before: words that say "not found", once the platform confirms the row absent, are a deletion; a dependency block is a skip for a
  // handler that tolerates one; system-managed words are an undeletable skip.
  assert.deepEqual(await deleteStep({}, handler(new Error('appmodule With Id = a1 Does Not Exist')), [item]), { deletedIds: ['a1'], absentIds: [], skippedIds: [], skipped: [] });
  assert.equal(asked, 1);
  assert.deepEqual(await deleteStep({}, handler(new Error('The uxagentproject component cannot be deleted because it is referenced by 1 other components.'), { tolerateDependencyBlock: true }), [item]),
    { deletedIds: [], absentIds: [], skippedIds: ['a1'], skipped: [{ id: 'a1', reason: 'referenced' }] });
  assert.deepEqual(await deleteStep({}, handler(new Error('The view is system-managed and cannot be deleted.')), [item]), { deletedIds: [], absentIds: [], skippedIds: ['a1'], skipped: [{ id: 'a1', reason: 'undeletable' }] });
  // Marked: passed on as it is, and nothing is asked of the platform about it.
  for (const [words, extra] of [
    ['appmodule With Id = a1 Does Not Exist', {}],
    ['The uxagentproject component cannot be deleted because it is referenced by 1 other components.', { tolerateDependencyBlock: true }],
    ['app "System Managed Ops" (a1) was not deleted', {}],
  ]) {
    const marked = Object.assign(new Error(words), { failClosed: true });
    await assert.rejects(deleteStep({}, handler(marked, extra), [item]), (e) => e === marked, words);
  }
  const status404 = Object.assign(new Error('HTTP 404'), { statusCode: 404, failClosed: true });
  await assert.rejects(deleteStep({}, handler(status404, { tolerateNotFound: true }), [item]), (e) => e === status404, 'a marked 404 even where not-found is tolerated');
  assert.equal(asked, 1, 'confirmAbsent was never asked about a marked error');
});

// --- 4. what is unchanged ----------------------------------------------------------------------------------------------------------------------------------

test('unchanged: an ordinary teardown sends exactly the requests it sent before — the app and its sitemap in one change set — and none of the dangling-link proof', async () => {
  const env = environment();
  const app = await built(env);
  const run = ran(await env.harness.measure(() => env.harness.teardown(spec())), 'the teardown');
  const { result } = run.value;
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(run.writes, { 'DELETE appmodules': 1, 'DELETE sitemaps': 1, 'DELETE webresourceset': 1, 'DELETE solutions': 1 });
  assert.deepEqual(env.org.writes(run.mark).filter((w) => /^\/(appmodules|sitemaps)\(/.test(w.path)).map((w) => `${w.method} ${w.path} ${w.batched ? 'in a change set' : 'alone'}`),
    [`DELETE /appmodules(${app.id}) in a change set`, `DELETE /sitemaps(${app.sitemapId}) in a change set`]);
  assert.deepEqual(env.org.readNames(run.mark), ORDINARY_READS);
  assert.equal(run.reads, 16);
  assert.equal(run.end - run.mark, 19, 'requests in all');
  const sent = env.org.since(run.mark).map((r) => r.path);
  for (const read of proofReads(app)) assert.ok(!sent.includes(read), `not sent: ${read}`);
  assert.equal(result.warnings, undefined, 'and nothing to warn about');
  backToSeed(env);
});

test('unchanged: a sitemap another app\'s current layer shares is refused by the SDK in its own words, with the same reads and no write', async () => {
  const env = environment();
  const app = await built(env);
  await direct(env.org, 'POST', '/appmodules', { appmoduleid: OTHER_APP, appmoduleidunique: OTHER_LAYER, uniquename: 'contoso_other', name: 'Other', clienttype: 4 });
  await direct(env.org, 'POST', '/appmodulecomponents', { _appmoduleidunique_value: OTHER_LAYER, objectid: app.sitemapId, componenttype: 62, rootcomponentbehavior: 0 });
  const before = env.org.contents();
  const run = ran(await env.harness.measure(() => env.harness.teardown(spec())), 'the teardown');
  const { result } = run.value;
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [{ step: `app module "${APP_NAME}"`, message: `Refusing to delete app '${app.id}': its sitemap '${app.sitemapId}' is also the navigation of app '${OTHER_APP}'. The delete removes an app's sitemap with it, and the platform does not stop that for a sitemap another app uses, so those apps would be left without navigation. Nothing was deleted. Remove the sitemap from the other app first, then retry.` }]);
  assert.deepEqual(env.org.writes(run.mark), []);
  assert.deepEqual(env.org.contents(), before);
  assert.deepEqual(env.org.readNames(run.mark), [...ORDINARY_READS.slice(0, 12), ...Array(3).fill('GET appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple')]);
  const sent = env.org.since(run.mark).map((r) => r.path);
  for (const read of proofReads(app)) assert.ok(!sent.includes(read), `not sent: ${read}`);
});

test('unchanged: a link that changes while the SDK reads it is refused by the SDK in its own words, with the same reads and no write', async () => {
  const env = environment();
  const app = await built(env);
  await direct(env.org, 'POST', '/sitemaps', { sitemapid: ELSEWHERE, sitemapname: 'Elsewhere', sitemapnameunique: 'contoso_elsewhere', sitemapxml: '<SiteMap><Area Id="a"><Group Id="g"><SubArea Id="s" Url="https://contoso.example/elsewhere" /></Group></Area></SiteMap>' });
  // The SDK reads the link twice, around its read of the sitemap; another writer relinks the app between the two.
  const sdkLink = `/appmodulecomponents?$select=objectid&$filter=_appmoduleidunique_value eq ${app.layer} and componenttype eq 62`;
  const fault = env.add('GET', (w) => w === sdkLink, (req) => {
    if (fault.hits === 2) env.org.rowsOf('appmodulecomponents').get(String(app.link.appmodulecomponentid).toLowerCase()).data.objectid = ELSEWHERE;
    return env.org.request(req);
  });
  const run = ran(await env.harness.measure(() => env.harness.teardown(spec())), 'the teardown');
  const { result } = run.value;
  assert.equal(fault.hits, 2);
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [{ step: `app module "${APP_NAME}"`, message: `Refusing to delete app '${app.id}': its sitemap link changed while it was read (sitemap '${app.sitemapId}' by component, then '${ELSEWHERE}' by component). Deleting the app would destroy the only pointer to its sitemap, stranding that row and reserving its unique name forever. Retry.` }]);
  assert.deepEqual(env.org.writes(run.mark), []);
  assert.deepEqual(env.org.readNames(run.mark), [...ORDINARY_READS.slice(0, 11), ...Array(2).fill('GET appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple')]);
  const sent = env.org.since(run.mark).map((r) => r.path);
  for (const read of proofReads(app)) assert.ok(!sent.includes(read), `not sent: ${read}`);
});

test('unchanged: a SiteMap component the SDK cannot read is refused by the SDK in its own words, and nothing is written or read for the dangling-link proof', async () => {
  const env = environment();
  const app = await built(env);
  const sdkLink = `/appmodulecomponents?$select=objectid&$filter=_appmoduleidunique_value eq ${app.layer} and componenttype eq 62`;
  const fault = env.add('GET', (w) => w === sdkLink, refusedWith(403, '0x80040220', 'The user is not a member of the organization.'));
  const before = env.org.contents();
  const run = ran(await env.harness.measure(() => env.harness.teardown(spec())), 'the teardown');
  const { result } = run.value;
  assert.equal(fault.hits, 1);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, new RegExp(`^Refusing to delete app '${app.id}': reading its SiteMap component failed \\(.*HTTP 403.*\\), so it cannot be determined which sitemap is this app's\\. Nothing was deleted\\. Retry\\.$`));
  assert.deepEqual(env.org.writes(run.mark), []);
  assert.deepEqual(env.org.contents(), before);
  const sent = env.org.since(run.mark).map((r) => r.path);
  for (const read of proofReads(app)) assert.ok(!sent.includes(read), `not sent: ${read}`);
});

test('unchanged: an app with no SiteMap component whose namesake sitemap is another app\'s navigation is refused by the SDK in its own words, with no write', async () => {
  const env = environment();
  const app = await built(env);
  const [sitemap] = env.org.find('sitemaps', (s) => String(s.sitemapid).toLowerCase() === app.sitemapId);
  assert.equal(sitemap.sitemapnameunique, APP, 'the build names the app\'s sitemap like the app');
  await direct(env.org, 'DELETE', `/appmodulecomponents(${app.link.appmodulecomponentid})`);
  await direct(env.org, 'POST', '/appmodules', { appmoduleid: OTHER_APP, appmoduleidunique: OTHER_LAYER, uniquename: 'contoso_other', name: 'Other', clienttype: 4 });
  await direct(env.org, 'POST', '/appmodulecomponents', { _appmoduleidunique_value: OTHER_LAYER, objectid: app.sitemapId, componenttype: 62, rootcomponentbehavior: 0 });
  const before = env.org.contents();
  const run = ran(await env.harness.measure(() => env.harness.teardown(spec())), 'the teardown');
  const { result } = run.value;
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [{ step: `app module "${APP_NAME}"`, message: `Refusing to delete app '${app.id}': its sitemap '${app.sitemapId}' is also the navigation of app '${OTHER_APP}'. The delete removes an app's sitemap with it, and the platform does not stop that for a sitemap another app uses, so those apps would be left without navigation. Nothing was deleted. Remove the sitemap from the other app first, then retry.` }]);
  assert.deepEqual(env.org.writes(run.mark), []);
  assert.deepEqual(env.org.contents(), before);
  const sent = env.org.since(run.mark).map((r) => r.path);
  for (const read of proofReads(app)) assert.ok(!sent.includes(read), `not sent: ${read}`);
});
