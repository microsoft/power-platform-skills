'use strict';
// REAL-BUNDLE tests of the teardown of an app that was created and never published — the app-level twin of a page that was created and never published.
//
// A plain read answers the PUBLISHED layer, and an app that was created and not published (a build killed before its publish, an app saved in the maker and left) has no row in it, so the
// teardown's read of the app's sitemap answered "app not found", as it does for an app that was deleted. Its navigation exists only in the saved layer. The teardown proved the app's pages by
// this workspace's own records alone, so a page the navigation held and no record named stayed behind — and the teardown then deleted the app and its sitemap, the only navigation that said which
// pages were the app's, so nothing could ever find them again.
//
// Every other teardown test drives a hand-written SDK, and would stay green through a change in what the REAL bundle asks the platform. Here the bundle is the real one, over the plugin's own
// transport and a fake org that answers the way the platform does (helpers/fake-apps-org.js: an app is a draft until a PublishXml names it, a draft is not in a plain read, and the SDK's app
// delete is one `$batch`). The app is made by the plugin's own `createApp` and left unpublished, so the sitemap that holds its pages is the one the SDK writes. What the fake org does not model — the
// app's layer key, its sitemap component (componenttype 62), the page manifest, and the web resource and solution deletes — is answered by the test.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAzHttpClient } = require('../lib/sdk-http-client.js');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../lib/maker-sdk.js');
const { runTeardown } = require('../lib/sdk-teardown.js');
const { manifestResourceName } = require('../lib/page-manifest.js');
const { createApp } = require('../apps.js');
const { createFakeAppsOrg, json } = require('./helpers/fake-apps-org.js');
const { appSitemapLinkRows } = require('./helpers/app-sitemap-link-rows.js');

const ORIGIN = 'https://contoso.crm.dynamics.com';
const PAGE_A = '0f8fad5b-d9cb-469f-a165-70867728950e'; // in the app's navigation, published
const PAGE_B = '1f8fad5b-d9cb-469f-a165-70867728950e'; // in the app's navigation, and never published itself
const PAGE_C = '2f8fad5b-d9cb-469f-a165-70867728950e'; // in the environment, and in no app's navigation
const LAYER = '66666666-7777-4888-8999-000000000000';
const MANIFEST_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ICON_ID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const REFERENCED = 'The uxagentproject component cannot be deleted because it is referenced by 1 other components. For a list of referenced components, use the RetrieveDependenciesForDeleteRequest.';

// The org, an app made by the plugin's own create, and the SDK over it. `publish` leaves the app published, `refuse(req)` answers a request first (the platform's refusal of it), and `inNavigation` are the
// pages the app is created with.
async function scenario(t, { publish = false, refuse = () => null, inNavigation = [PAGE_A, PAGE_B] } = {}) {
  const dirs = [];
  t.after(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });
  const tempDir = (what) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), `contoso-${what}-`)); dirs.push(dir); return dir; };
  const made = {};
  // The platform's refusals are for the teardown: the app's own create reads the org too, and must get through.
  let armed = false;
  const manifest = () => Buffer.from(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: PAGE_A }, { key: 'details', name: 'Details', pageId: PAGE_B }] })).toString('base64');
  const org = createFakeAppsOrg({
    pages: [{ id: PAGE_A, name: 'Overview' }, { id: PAGE_B, name: 'Details', componentstate: 1 }, { id: PAGE_C, name: 'Somebody Else' }],
    answer: (req) => {
      const refused = armed ? refuse(req) : null;
      if (refused) return refused;
      if (req.method === 'GET') {
        // After create, model the actual pin on this app's layer for both the forward lookup and
        // the SDK's reverse-owner proof. Unrelated component reads are not answered here.
        const linked = appSitemapLinkRows(`${ORIGIN}/api/data/v9.0${req.path}`, {
          apps: org.state.apps,
          components: made.sitemapId ? [{ _appmoduleidunique_value: LAYER, objectid: made.sitemapId, componenttype: 62 }] : [],
        });
        if (linked !== undefined) return json(200, { value: linked });
      }
      if (req.method === 'GET' && req.path.startsWith('/webresourceset')) {
        const name = (/name eq '([^']+)'/.exec(req.path) || [])[1];
        if (name === manifestResourceName(made.uniqueName)) return json(200, { value: [{ webresourceid: MANIFEST_ID, name, content: manifest() }] });
        if (name === `${made.uniqueName}_icon`) return json(200, { value: [{ webresourceid: ICON_ID, name }] });
        return json(200, { value: [] });
      }
      if (req.method === 'DELETE' && /^\/(webresourceset|solutions)\(/.test(req.path)) return { statusCode: 204, headers: {}, body: '' };
      return null;
    },
  });
  const client = createAzHttpClient(ORIGIN, { getToken: () => 'test-token', request: org.request, sleep: async () => {} });
  const created = await createApp({ env: ORIGIN, name: 'Account Metrics', solution: 'ContosoCore', pageIds: inNavigation, publish }, client, { randomHex: () => '1a2b3c4d' });
  assert.strictEqual(created.ok, true, JSON.stringify(created));
  Object.assign(made, created);
  org.state.apps[0].appmoduleidunique = LAYER;
  assert.strictEqual(org.state.apps[0].componentstate, publish ? 0 : 1, publish ? 'a published app' : 'a draft: the app was created and never published');
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(tempDir('sdk')), instanceUrl: ORIGIN, httpClient: client });
  await sdk.initWorkspace();
  // What the teardown asks of the platform starts here: the app's own create wrote its rows through the same org.
  const since = org.requests.length;
  armed = true;
  const requests = () => org.requests.slice(since);
  const spec = {
    solution: { uniqueName: 'ContosoCore', publisherPrefix: 'contoso' },
    app: { name: 'Account Metrics', uniqueName: created.uniqueName },
    pages: [{ key: 'overview', name: 'Overview' }, { key: 'details', name: 'Details' }],
  };
  const teardown = (opts = {}) => runTeardown(spec, { apply: true, env: ORIGIN, workspaceDir: tempDir('workspace'), ...opts }, { sdk });
  // Every write that reached the platform, a `$batch` change set taken apart, as `METHOD /path`.
  const writes = () => requests().filter((r) => r.method !== 'GET').flatMap((r) => (r.operations || [r]).map((op) => `${op.method} ${op.path}`));
  return { org, created, teardown, requests, writes };
}

const pathsOf = (writes, prefix) => writes.filter((w) => w.startsWith(`DELETE /${prefix}(`)).map((w) => w.slice(`DELETE /${prefix}(`.length, -1));
const lookupsOfApp = (requests) => requests.filter((r) => r.method === 'GET' && /^\/appmodules\/Microsoft\.Dynamics\.CRM\.RetrieveUnpublishedMultiple\(\)\?.*uniquename eq/.test(r.path));

test('REAL BUNDLE: an app that was created and never published is torn down with the pages its saved navigation holds — and with nothing else', async (t) => {
  const { org, created, teardown, requests, writes } = await scenario(t);
  const result = await teardown();
  assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
  assert.deepStrictEqual([...result.deleted.genpage].sort(), [PAGE_A, PAGE_B].sort(), 'both pages are in the sitemap the app saved, and no record of this workspace is needed to say so');
  const all = writes();
  assert.deepStrictEqual(pathsOf(all, 'uxagentprojects').sort(), [PAGE_A, PAGE_B].sort(), 'the two pages\' project rows, and no other page');
  assert.deepStrictEqual(pathsOf(all, 'appmodules'), [created.appId], 'the app, and its sitemap beside it:');
  assert.deepStrictEqual(pathsOf(all, 'sitemaps'), [created.sitemapId]);
  assert.deepStrictEqual(pathsOf(all, 'webresourceset').sort(), [MANIFEST_ID, ICON_ID].sort(), 'then the page manifest and the generated icon, which a clean pages step lets go');
  assert.strictEqual(pathsOf(all, 'solutions').length, 1, 'and the solution container');
  assert.ok(all.every((w) => /^DELETE \/(appmodules|sitemaps|uxagentprojects|agentconversationmessages|webresourceset|solutions)\(/.test(w)), `nothing else is written: ${all.join(', ')}`);
  assert.ok(!requests().some((r) => r.path.includes(PAGE_C)), 'the page in no app\'s navigation is not read, let alone deleted');
  assert.deepStrictEqual([org.state.apps.length, org.state.sitemaps.length], [0, 0], 'the app and its sitemap are gone');
  assert.deepStrictEqual(org.unexpected, []);
});

test('REAL BUNDLE: a dry run of the same teardown lists the pages as ones it would delete, from the saved navigation, and writes nothing', async (t) => {
  const { org, teardown, writes } = await scenario(t);
  const result = await teardown({ apply: false });
  assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
  assert.match(result.plan.join('\n'), new RegExp(`${PAGE_A}[^\\n]*would delete`));
  assert.match(result.plan.join('\n'), new RegExp(`${PAGE_B}[^\\n]*would delete`));
  assert.deepStrictEqual(writes(), [], 'a dry run changes nothing');
  assert.deepStrictEqual(org.unexpected, []);
});

test('REAL BUNDLE: a page of the app\'s navigation that another app still references is kept — the platform refuses its delete in its own words, and teardown reports it', async (t) => {
  const { org, teardown, writes } = await scenario(t, {
    refuse: (req) => (req.method === 'DELETE' && req.path === `/uxagentprojects(${PAGE_B})` ? json(400, { error: { code: '0x80040000', message: REFERENCED } }) : null),
  });
  const result = await teardown();
  assert.deepStrictEqual(result.deleted.genpage, [PAGE_A], 'only the page nothing else references');
  assert.strictEqual(result.ok, false, 'a proven page that is still there is not a clean teardown');
  assert.match(JSON.stringify(result.errors), new RegExp(`proven pages remain undeleted: ${PAGE_B}`));
  const all = writes();
  assert.ok(all.includes(`DELETE /uxagentprojects(${PAGE_B})`), 'the page was put to the platform, which is the authority on what references it');
  assert.ok(!pathsOf(all, 'webresourceset').includes(MANIFEST_ID), 'and its manifest stays, for the re-run that finds the page again');
  assert.deepStrictEqual(org.unexpected, []);
});

test('REAL BUNDLE: a saved navigation the platform refuses to answer is an error that deletes nothing — no page, and not the app and sitemap that would be the only proof of them', async (t) => {
  const { org, teardown, writes } = await scenario(t, {
    refuse: (req) => (req.method === 'GET' && req.path.startsWith('/sitemaps/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()') ? json(403, { error: { code: '0x80040220', message: 'The user is not a member of the organization.' } }) : null),
  });
  const result = await teardown();
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(writes(), [], 'not one write reached the platform');
  assert.match(result.errors.map((e) => e.message).join('\n'), /app sitemap unreadable \(the app was never published, so its navigation is the one it saved, and that could not be read: sitemap-query-failed: .*403/);
  assert.deepStrictEqual([org.state.apps.length, org.state.sitemaps.length], [1, 1], 'the app and its sitemap stay for the re-run');
});

test('REAL BUNDLE: a published app is proven by its published navigation as before — the app is not looked for in its saved layer by the proof, only by the delete', async (t) => {
  const { org, teardown, requests, writes } = await scenario(t, { publish: true });
  const result = await teardown();
  assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
  assert.deepStrictEqual(pathsOf(writes(), 'uxagentprojects').sort(), [PAGE_A, PAGE_B].sort());
  assert.strictEqual(lookupsOfApp(requests()).length, 1, 'the app step\'s own lookup, and no other');
  assert.deepStrictEqual(org.unexpected, []);
});

test('REAL BUNDLE: the same teardown of an app that was never published looks for it in its saved layer twice — once to prove its pages, once to delete it', async (t) => {
  const { teardown, requests } = await scenario(t);
  const result = await teardown();
  assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
  const lookups = lookupsOfApp(requests());
  assert.strictEqual(lookups.length, 2);
  assert.ok(lookups.every((r) => r.path.includes("uniquename eq 'account_metrics_1a2b3c4d'")));
});
