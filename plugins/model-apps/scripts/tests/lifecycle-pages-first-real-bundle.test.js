'use strict';
// A NEW app whose navigation holds only generative pages, through its whole lifecycle — over the REAL vendored SDK, the plugin's own
// HTTP client and the stateful fake Dataverse the lifecycle tests share (helpers/fake-lifecycle-org.js, helpers/lifecycle-harness.js),
// each command run the way its CLI runs it. It is the LIVE CHECK of this change, offline.
//
// Dataverse refuses to CREATE a sitemap that holds no entry (measured):
//
//   HTTP 400: SiteMap needs to have a non-empty Area with a non-empty Group, even when ignoring all Areas, Groups, and SubAreas with an IsVisible child
//
// A new app used to be created BEFORE its pages, its first navigation without them, so a navigation of pages only could not be
// built at all (2.17.0 refused it before writing anything: app-navigation-empty). The build now creates the pages first and then the
// app, whose first navigation holds them (lib/sdk-build.js, `createAppWithPages`). The fake does not model the platform's refusal, so
// the seam in front of it adds it, and the cases pin, by what reached the wire and what the environment holds:
//   * built from nothing: the page is created before the app, the one sitemap ever created holds it, no navigation without an entry
//     is ever sent (so no temporary entry exists), and the app is published with the page in it; verify passes;
//   * a build refused between the pages and the app (the app's create): the page, its creation receipt and the manifest are there and
//     there is no app; run again, the page is adopted — not created a second time — and the app is created with it;
//   * a teardown, after the clean build and right after the build that stopped (there is no app then): everything the build made is
//     gone, and everything the environment held before it holds what it held.
// A failure is provoked only by refusing this test's own app's create, in front of the fake, so the environment holds what it would
// after a real refusal.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { createLifecycleOrg } = require('./helpers/fake-lifecycle-org.js');
const { createLifecycleHarness, seedForeignWork, diffContents } = require('./helpers/lifecycle-harness.js');
const { readPageOwnership } = require('../lib/page-ownership-records.js');

const APP_UNIQUE = 'contoso_pagesfirst';
const PAGE_NAME = 'Kitchen Page';
const PLATFORM_ANSWER = 'SiteMap needs to have a non-empty Area with a non-empty Group, even when ignoring all Areas, Groups, and SubAreas with an IsVisible child, regardless of their visibility settings.';

// One table the build creates, one page that reads it, and a navigation that holds that page and nothing else. The page's source is the
// file the harness writes into the app folder (KitchenPage.tsx).
function pagesOnlySpec() {
  return {
    schemaVersion: 2,
    solution: { uniqueName: 'ContosoPagesFirst', displayName: 'Contoso Pages First', publisherPrefix: 'contoso' },
    app: { name: 'Pages First', description: 'An app whose navigation is one generative page.' },
    entities: [{ schemaName: 'contoso_project', displayName: 'Project', pluralName: 'Projects', primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' }, columns: [] }],
    pages: [{ key: 'overview', name: PAGE_NAME, purpose: 'A page over projects.', dataSources: ['contoso_project'], source: { kind: 'tsx', codeFile: 'KitchenPage.tsx' } }],
    appShell: { areas: [{ label: 'Work', groups: [{ label: 'Pages', subAreas: [{ page: 'overview', title: PAGE_NAME }] }] }] },
  };
}
const spec = pagesOnlySpec();

// The request a seam answers, as the fake records it: the path below the API root, the body parsed.
const pathOf = (req) => decodeURIComponent(new URL(req.url).pathname).replace(/^\/api\/data\/v9\.\d/, '');
const bodyOf = (req) => { try { return JSON.parse(req.body); } catch { return null; } };
// A Dataverse OData error the client does not retry, as a real refusal is answered:
// https://learn.microsoft.com/power-apps/developer/data-platform/webapi/compose-http-requests-handle-errors#parse-errors-from-the-response
const refusal = (message) => ({ statusCode: 400, headers: { 'content-type': 'application/json; odata.metadata=minimal' }, body: JSON.stringify({ error: { code: '0x80040216', message } }) });

// A fake environment with another maker's work in it, the platform's rule for a sitemap's create, and a seam that refuses an app's
// create while `refuseAppCreate` is set. A sitemap the SDK creates is sent as
//   POST /sitemaps  { "sitemapid": "…", "sitemapnameunique": "contoso_pagesfirst", "sitemapxml": "<SiteMap …><Area …><Group …>…</Group></Area></SiteMap>" }
// and the rule refuses one whose XML holds no <SubArea>.
async function environment() {
  const org = createLifecycleOrg();
  await seedForeignWork(org);
  const seen = { emptySitemapCreates: 0, sitemapCreates: [], sitemapWrites: [], appCreatesRefused: 0, refuseAppCreate: false, gatewayRefusals: 0 };
  const request = async (req) => {
    const where = pathOf(req);
    // A gateway that answers the app's create with a 503 the next `gatewayRefusals` times: a failure the HTTP client re-sends, and the build retries.
    if (seen.gatewayRefusals > 0 && req.method === 'POST' && /^\/appmodules$/.test(where)) {
      seen.gatewayRefusals -= 1;
      return { statusCode: 503, headers: { 'content-type': 'application/json; odata.metadata=minimal' }, body: JSON.stringify({ error: { code: '0x80040216', message: 'Service Unavailable' } }) };
    }
    if (req.method === 'POST' && /^\/sitemaps$/.test(where)) {
      const xml = String((bodyOf(req) || {}).sitemapxml || '');
      seen.sitemapCreates.push(xml);
      if (!/<SubArea\b/.test(xml)) { seen.emptySitemapCreates += 1; return refusal(PLATFORM_ANSWER); }
    }
    // Every navigation the build writes, the create's and any later push's (the placement of the page's default view pushes the app it reads).
    if ((req.method === 'POST' && /^\/sitemaps$/.test(where)) || (req.method === 'PATCH' && /^\/sitemaps\(/.test(where))) {
      const body = bodyOf(req) || {};
      if (typeof body.sitemapxml === 'string') seen.sitemapWrites.push(body.sitemapxml);
    }
    if (seen.refuseAppCreate && req.method === 'POST' && /^\/appmodules$/.test(where)) {
      seen.appCreatesRefused += 1;
      return refusal('An unexpected error occurred.');
    }
    return org.request(req);
  };
  const harness = createLifecycleHarness({ ...org, request }, makeTempDir('lifecycle-pages-first-'));
  return { org, harness, seen, seed: org.inventory(), seedContents: org.contents() };
}

// A measured step ran: it did not throw, and every request it sent is one the fake models.
const ran = (step, label) => {
  assert.ok(step, `${label} ran`);
  if (step.error) throw step.error;
  assert.deepEqual(step.unexpected, [], `every request ${label} sent is one the fake models`);
  return step;
};

// The entries of a navigation, each as the id of the page it names — `not a page` for an entry that names none:
//   <SubArea Id="sub_0_0_0" GenPageId="2f10af3e-632d-489d-ad61-3820c7b100f0" …>  ->  '2f10af3e-632d-489d-ad61-3820c7b100f0'
const entriesOf = (xml) => (String(xml || '').match(/<SubArea\b[^>]*>/g) || []).map((tag) => ((/\bGenPageId="([^"]+)"/.exec(tag) || [])[1] || 'not a page').toLowerCase());

// What the environment holds of this app: the app and whether it is published, its navigation's entries (entriesOf), the pages of that
// name, how many of them are published, and whether the page manifest is there.
function holds(org) {
  const app = org.find('appmodules', (a) => a.uniquename === APP_UNIQUE)[0];
  const appRow = app && org.rowsOf('appmodules').get(app.appmoduleid);
  const sitemap = org.find('sitemaps', (m) => m.sitemapnameunique === APP_UNIQUE)[0];
  const pages = [...org.pageServer.state.projects.values()].filter((p) => p.name === PAGE_NAME);
  return {
    app: app ? { published: !!(appRow && appRow.published) } : null,
    navigation: entriesOf(sitemap && sitemap.sitemapxml),
    pages: pages.map((p) => String(p.id).toLowerCase()),
    publishedPages: pages.filter((p) => org.pageServer.publishedPages.has(p.id)).length,
    manifest: org.find('webresourceset', (w) => w.name === `${APP_UNIQUE}_pagemanifest`).length,
  };
}

// The environment is as the seed left it, but for the publisher the build made for the prefix (a teardown keeps a publisher) — set
// aside by identity, so a publisher the environment had before that went missing still fails. By identity nothing the build made is
// left and nothing the environment had is missing; by content everything it had holds exactly what it held. (The recovery tests
// compare the same way: lifecycle-recovery-real-bundle.test.js.)
function assertBackToSeed(env) {
  const { org, seed } = env;
  const now = org.inventory();
  const made = now.rows.publishers.filter((p) => !seed.rows.publishers.includes(p));
  assert.equal(made.length, 1, 'the build made one publisher, for its prefix');
  assert.deepEqual({ ...now, rows: { ...now.rows, publishers: now.rows.publishers.filter((p) => !made.includes(p)) } }, seed, 'every other row is as it was before the build: no more, no fewer');
  assert.deepEqual(diffContents(env.seedContents, org.contents(), { added: false }), [], 'and every one of them holds exactly what it held');
}

// A request that creates a generative page: the page service's change set (`$batch`) holds the POST of its project row, or — for a
// transport that sends it alone — the POST itself.
const createsPage = (r) => r.method === 'POST' && (/^\/uxagentprojects(\?|$)/.test(r.path) || (r.operations || []).some((o) => o.method === 'POST' && /(^|\/)uxagentprojects(\?|$)/.test(String(o.path))));
const createsApp = (r) => r.method === 'POST' && /^\/appmodules(\?|$)/.test(r.path);

// CLEAN: built from nothing.
let cleanP;
const clean = () => cleanP || (cleanP = (async () => {
  const env = await environment();
  env.build = await env.harness.measure(() => env.harness.build(spec));
  env.afterBuild = holds(env.org);
  env.workspaceAfterBuild = readPageOwnership(env.harness.workspaceDir, APP_UNIQUE, env.org.origin);
  return env;
})());

// STOPPED: the app's create refused, after the pages were written; then run again with the refusal lifted.
let stoppedP;
const stopped = () => stoppedP || (stoppedP = (async () => {
  const env = await environment();
  env.seen.refuseAppCreate = true;
  env.failed = await env.harness.measure(() => env.harness.build(spec));
  env.seen.refuseAppCreate = false;
  env.afterFailed = holds(env.org);
  env.navigationWritesAfterFailed = env.seen.sitemapWrites.length;
  env.workspaceAfterFailed = readPageOwnership(env.harness.workspaceDir, APP_UNIQUE, env.org.origin);
  return env;
})());

test('pages first: the spec these cases build is one 2.17.0 refused — a navigation of pages only, for an app that does not exist', () => {
  const { navigationHolds } = require('../lib/app-navigation.js');
  const navigation = navigationHolds(spec);
  assert.deepEqual({ entries: navigation.entries, pages: navigation.pages }, { entries: 1, pages: ['overview'] });
});

test('pages first: a new app of pages only is built from nothing — the page before the app, and the app\u2019s first navigation already holds it', async () => {
  const env = await clean();
  const build = ran(env.build, 'the build');
  assert.equal(build.value.result.ok, true, JSON.stringify(build.value.result.errors));
  assert.equal(env.seen.emptySitemapCreates, 0, 'no navigation without an entry was ever sent');
  assert.equal(env.seen.sitemapCreates.length, 1, 'one sitemap was created');
  const after = env.afterBuild;
  assert.equal(after.pages.length, 1, 'the page was created once');
  assert.deepEqual(entriesOf(env.seen.sitemapCreates[0]), after.pages, 'and it held the page when it was created, and nothing else: no temporary entry');
  // The page's create comes before the app's: the page service's write of the page, then the app module row.
  const requests = env.org.since(build.mark);
  const pageCreate = requests.findIndex(createsPage);
  const appCreate = requests.findIndex(createsApp);
  assert.ok(pageCreate >= 0 && appCreate > pageCreate, `the page is created (${pageCreate}) before the app (${appCreate})`);
  assert.equal(requests.filter(createsPage).length, 1, 'the page is created once');
  assert.equal(requests.filter(createsApp).length, 1, 'the app is created once');
  // Every navigation written — the create's, and the push that pins the page's default view into the app — holds the page entry and only it.
  assert.ok(env.seen.sitemapWrites.length >= 1);
  for (const xml of env.seen.sitemapWrites) assert.deepEqual(entriesOf(xml), after.pages, 'a navigation write holds the page, and nothing else');
  assert.deepEqual(after.app, { published: true }, 'the app is published');
  assert.deepEqual(after.navigation, after.pages, 'the navigation holds the page, and nothing else');
  assert.equal(after.publishedPages, 1, 'and the page is published');
  assert.equal(after.manifest, 1, 'the page manifest is there');
  assert.deepEqual(build.value.result.verify && { ok: build.value.result.verify.ok, missing: build.value.result.verify.missing }, { ok: true, missing: [] }, 'verify passes');
  // What the log says of the app step: deferred, not done, and then the create.
  assert.ok(build.value.log.some((line) => /⊘ app "Pages First" \(created after its pages: its navigation holds only page entries\)/.test(line)), build.value.log.join('\n'));
  assert.ok(build.value.log.some((line) => /✓ app "Pages First" \(created with its pages\)/.test(line)), build.value.log.join('\n'));
  assert.deepEqual(env.workspaceAfterBuild.created.map((r) => r.pageId), after.pages, 'the page\u2019s creation receipt names it');
});

test('pages first: an unchanged rebuild of that app is an ordinary rebuild of an existing app — no page and no app is created', async () => {
  const env = await clean();
  const rebuild = ran(await env.harness.measure(() => env.harness.build(spec)), 'the rebuild');
  assert.equal(rebuild.value.result.ok, true, JSON.stringify(rebuild.value.result.errors));
  const requests = env.org.since(rebuild.mark);
  assert.equal(requests.filter(createsApp).length, 0, 'the app exists: it is not created again');
  assert.ok(!requests.some(createsPage), 'nor is the page');
  assert.ok(!rebuild.value.log.some((line) => /created after its pages|created with its pages/.test(line)), 'the app step reuses the app, as for any existing app');
  assert.deepEqual(holds(env.org), env.afterBuild, 'and the app, its navigation and its page are what the first build left');
});

test('pages first: a build refused between the pages and the app leaves the page with its receipt and no app — and says where it stopped', async () => {
  const env = await stopped();
  const failed = env.failed;
  assert.ok(env.seen.appCreatesRefused > 0, 'the app\u2019s create was refused');
  assert.deepEqual(failed.unexpected, []);
  assert.ok(failed.error, 'the build stopped');
  assert.equal(failed.error.phase, 'app-shell', 'at the app\u2019s create, which is the app step\u2019s work');
  assert.equal(env.seen.emptySitemapCreates, 0);
  const after = env.afterFailed;
  assert.equal(after.app, null, 'there is no app');
  assert.equal(env.navigationWritesAfterFailed, 0, 'and no navigation was written: the app\u2019s create comes before its sitemap\u2019s');
  assert.equal(after.pages.length, 1, 'the page was created');
  assert.equal(after.manifest, 1, 'and recorded in the manifest');
  assert.deepEqual(env.workspaceAfterFailed.created.map((r) => r.pageId), after.pages, 'and in its creation receipt, which is what the next build adopts it by');
});

test('pages first: run again, the build that stopped adopts its page — it is not created twice — and creates the app with it', async () => {
  const env = await stopped();
  const resumed = ran(await env.harness.measure(() => env.harness.build(spec)), 'the build run again');
  assert.equal(resumed.value.result.ok, true, JSON.stringify(resumed.value.result.errors));
  const requests = env.org.since(resumed.mark);
  assert.ok(!requests.some(createsPage), 'no page is created');
  assert.equal(requests.filter(createsApp).length, 1, 'the app is created, once');
  const after = holds(env.org);
  assert.deepEqual(after.pages, env.afterFailed.pages, 'the page is the one the stopped build made');
  assert.deepEqual(after.navigation, after.pages, 'and it is the app\u2019s navigation');
  assert.ok(env.seen.sitemapWrites.length > env.navigationWritesAfterFailed);
  for (const xml of env.seen.sitemapWrites) assert.deepEqual(entriesOf(xml), after.pages, 'every navigation written holds the page, and nothing else');
  assert.deepEqual(after.app, { published: true });
  assert.equal(env.seen.emptySitemapCreates, 0);
  assert.deepEqual(resumed.value.result.verify && { ok: resumed.value.result.verify.ok, missing: resumed.value.result.verify.missing }, { ok: true, missing: [] });
  // Then the teardown of the app built in two runs: everything the build made is gone.
  const teardown = ran(await env.harness.measure(() => env.harness.teardown(spec)), 'the teardown');
  assert.equal(teardown.value.result.ok, true, JSON.stringify(teardown.value.result.errors));
  assertBackToSeed(env);
});

test('pages first: the teardown of the clean build deletes everything the build made', async () => {
  const env = await clean();
  const teardown = ran(await env.harness.measure(() => env.harness.teardown(spec)), 'the teardown');
  assert.equal(teardown.value.result.ok, true, JSON.stringify(teardown.value.result.errors));
  assert.deepEqual(holds(env.org), { app: null, navigation: [], pages: [], publishedPages: 0, manifest: 0 });
  assertBackToSeed(env);
});

test('pages first: a teardown right after the build that stopped before its app finds the page by its receipt and deletes it — everything is gone', async () => {
  // A fresh environment of its own: the run-again case above goes on from the stopped build.
  const env = await environment();
  env.seen.refuseAppCreate = true;
  const failed = await env.harness.measure(() => env.harness.build(spec));
  env.seen.refuseAppCreate = false;
  assert.ok(failed.error && env.seen.appCreatesRefused > 0, 'the build stopped at the app\u2019s create');
  assert.equal(holds(env.org).pages.length, 1, 'with the page created');
  const teardown = ran(await env.harness.measure(() => env.harness.teardown(spec)), 'the teardown with no app');
  assert.equal(teardown.value.result.ok, true, JSON.stringify(teardown.value.result.errors));
  assert.ok(env.org.since(teardown.mark).some((r) => r.method === 'DELETE' && /^\/uxagentprojects\(/.test(r.path)), 'the page was deleted');
  assert.deepEqual(holds(env.org), { app: null, navigation: [], pages: [], publishedPages: 0, manifest: 0 });
  assertBackToSeed(env);
  assert.deepEqual(readPageOwnership(env.harness.workspaceDir, APP_UNIQUE, env.org.origin).created, [], 'and its receipt is consumed');
  assert.ok(fs.existsSync(path.join(env.harness.appDir, 'KitchenPage.tsx')), 'the page\u2019s source in the app folder is the maker\u2019s, and stays');
});

test('pages first: a page made by a build of this app in another workspace is not adopted — it names no record here, and the advice does not send the maker to an app that does not exist', async () => {
  const env = await environment();
  env.seen.refuseAppCreate = true;
  await env.harness.measure(() => env.harness.build(spec));
  env.seen.refuseAppCreate = false;
  const made = holds(env.org);
  assert.equal(made.pages.length, 1, 'the stopped build made the page');
  // The same app folder, another workspace: it holds no creation receipt for the page the manifest names.
  const elsewhere = path.join(makeTempDir('lifecycle-pages-first-elsewhere-'), '.maker-workspace');
  fs.mkdirSync(elsewhere, { recursive: true });
  const other = await env.harness.measure(() => env.harness.build(spec, { workspace: elsewhere }));
  assert.deepEqual(other.unexpected, []);
  assert.ok(other.error, 'the build stops');
  assert.equal(other.error.code, 'pages-identity-conflict');
  assert.match(other.error.message, /is in no navigation of this app — the app does not exist yet: its navigation holds only page entries, so the build creates it once its pages exist — and this workspace holds no record that this app created it in this environment: if it is this app's page, run the build from the workspace that created it, which holds that record; if not, remove the stale id from the manifest\/spec/);
  assert.doesNotMatch(other.error.message, /add-to-app/, 'no command for an app that does not exist');
  const requests = env.org.since(other.mark);
  assert.ok(!requests.some(createsPage) && !requests.some(createsApp), 'no page and no app was created');
  assert.deepEqual(holds(env.org), made, 'the environment holds what the stopped build left');
  // The workspace that made the page builds the app with it.
  const resumed = ran(await env.harness.measure(() => env.harness.build(spec)), 'the build from the workspace that made the page');
  assert.equal(resumed.value.result.ok, true, JSON.stringify(resumed.value.result.errors));
  assert.deepEqual(holds(env.org).navigation, made.pages);
  const teardown = ran(await env.harness.measure(() => env.harness.teardown(spec)), 'the teardown');
  assert.equal(teardown.value.result.ok, true, JSON.stringify(teardown.value.result.errors));
  assertBackToSeed(env);
});

test('pages first: a gateway failure at the app\u2019s create is retried by the build itself — the retry adopts the page, so one page and one app are made', async () => {
  const env = await environment();
  // The HTTP client sends a request at most six times (lib/sdk-http-client.js maxAttempts), so six refusals fail the first attempt of the build
  // and the seventh send — the build's own retry of a transient halt — gets through.
  env.seen.gatewayRefusals = 6;
  const build = ran(await env.harness.measure(() => env.harness.build(spec)), 'the build');
  assert.equal(env.seen.gatewayRefusals, 0, 'every refusal was spent');
  assert.equal(build.value.result.ok, true, JSON.stringify(build.value.result.errors));
  assert.ok(build.value.log.some((line) => /⟳ transient error in app-shell — retrying \(attempt 1\/3\)/.test(line)), build.value.log.join('\n'));
  const requests = env.org.since(build.mark);
  assert.equal(requests.filter(createsPage).length, 1, 'the page is created once: the retry adopts it by its receipt');
  assert.equal(requests.filter((r) => createsApp(r) && r.status < 300).length, 1, 'and the app is created once');
  const after = holds(env.org);
  assert.equal(after.pages.length, 1);
  assert.deepEqual(after.navigation, after.pages);
  assert.deepEqual(after.app, { published: true });
  assert.equal(env.seen.emptySitemapCreates, 0);
  const teardown = ran(await env.harness.measure(() => env.harness.teardown(spec)), 'the teardown');
  assert.equal(teardown.value.result.ok, true, JSON.stringify(teardown.value.result.errors));
  assertBackToSeed(env);
});
