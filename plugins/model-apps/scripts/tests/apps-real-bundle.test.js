'use strict';
// REAL BUNDLE: scripts/apps.js through the plugin's real az-token HttpClient and the real vendored SDK, over a fake Dataverse
// (helpers/fake-apps-org.js) that answers the reads the script makes and the writes the SDK's app create makes in the shapes the real bundle
// asks for them. A stub of the SDK can only agree with the script about the SDK; this is what tells the plugin that a re-vendored bundle
// moved a read, wrote in another order, stopped taking a field of the app, or began to publish inside the create.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createAzHttpClient } = require('../lib/sdk-http-client.js');
const { createFakeAppsOrg, json, batchResponse } = require('./helpers/fake-apps-org.js');
const { listApps, createApp } = require('../apps.js');
const { appDef } = require('../lib/sdk-build.js');

const ORIGIN = 'https://contoso.crm.dynamics.com';
const PAGE_A = '0f8fad5b-d9cb-469f-a165-70867728950e';
const PAGE_B = '1f8fad5b-d9cb-469f-a165-70867728950e';
const MISSING = '3f8fad5b-d9cb-469f-a165-70867728950e';
const DEFAULT_ICON = '953b9fac-1e5e-e611-80d6-00155ded156f';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GUID_IN_PATH = /\([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\)/;

const client = (org) => createAzHttpClient(ORIGIN, { getToken: () => 'test-token', request: org.request, sleep: async () => {} });
const orgWithPages = (options = {}) => createFakeAppsOrg({ pages: [{ id: PAGE_A, name: 'Overview' }, { id: PAGE_B, name: 'Details' }], ...options });
const args = (overrides = {}) => ({ env: ORIGIN, name: 'Account Metrics', solution: 'ContosoCore', pageIds: [PAGE_A], publish: false, ...overrides });
const seams = { randomHex: () => '1a2b3c4d' };
// `published` is whether the published layer holds the row; by default it does for componentstate 0 and not for 1 (a draft).
const row = (id, name, uniquename, componentstate, description = null, published = undefined) => ({ appmoduleid: id, name, uniquename, componentstate, description, ...(published === undefined ? {} : { published }) });
const LIST_PATH = '/appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=appmoduleid,name,uniquename,description,componentstate';
const PUBLISHED_PATH = '/appmodules?$select=appmoduleid';

// --- list --------------------------------------------------------------------------------------------------------------

test('REAL BUNDLE: list asks the platform for the current layer of every app, drafts included, then for the published layer, and writes nothing', async () => {
  const org = createFakeAppsOrg({
    apps: [
      row('00000000-0000-4000-8000-000000000003', 'Zeta', 'zeta', 1),
      row('00000000-0000-4000-8000-000000000001', 'Alpha', 'cr_alpha', 0, 'The first'),
      row('00000000-0000-4000-8000-000000000002', 'Beta', 'beta', 0),
      row('00000000-0000-4000-8000-000000000002', 'Beta (draft)', 'beta', 1),
      // One row answered for a published app with a saved edit (componentstate 1) while its published row stays, and for a managed app a solution import
      // brought in (componentstate 0; live all the same).
      row('00000000-0000-4000-8000-000000000004', 'Gamma', 'gamma', 1, null, true),
      row('00000000-0000-4000-8000-000000000005', 'Delta', 'msdyn_delta', 0, null, true),
    ],
  });
  const result = await listApps(ORIGIN, {}, client(org));
  assert.deepStrictEqual(org.requests.map((r) => `${r.method} ${r.path}`), [`GET ${LIST_PATH}`, `GET ${PUBLISHED_PATH}`], 'the saved layer first, then the published one');
  assert.deepStrictEqual(org.writes(), []);
  assert.deepStrictEqual(org.unexpected, []);
  assert.deepStrictEqual(result, {
    ok: true,
    count: 5,
    apps: [
      { id: '00000000-0000-4000-8000-000000000001', name: 'Alpha', uniqueName: 'cr_alpha', description: 'The first', published: true, unpublishedChanges: false },
      { id: '00000000-0000-4000-8000-000000000002', name: 'Beta (draft)', uniqueName: 'beta', description: '', published: true, unpublishedChanges: true },
      { id: '00000000-0000-4000-8000-000000000005', name: 'Delta', uniqueName: 'msdyn_delta', description: '', published: true, unpublishedChanges: false },
      { id: '00000000-0000-4000-8000-000000000004', name: 'Gamma', uniqueName: 'gamma', description: '', published: true, unpublishedChanges: true },
      { id: '00000000-0000-4000-8000-000000000003', name: 'Zeta', uniqueName: 'zeta', description: '', published: false, unpublishedChanges: true },
    ],
  });
  assert.deepStrictEqual((await listApps(ORIGIN, { search: 'ALP' }, client(org))).apps.map((a) => a.name), ['Alpha']);
});

// The script reads the collection itself because the SDK's list keeps only id and name. If the SDK's own list request ever stops being this one
// (another endpoint, so apps with no published row go missing) or the SDK's list starts to carry the unique name, this says so.
test('REAL BUNDLE: the list is the collection the SDK\u2019s own fetchArtifactList(\'app\') reads, with the one column it would need added — and the same apps', async () => {
  const { createMakerSdk, createNodeWorkspaceStorage } = require('../lib/maker-sdk.js');
  const apps = [row('00000000-0000-4000-8000-000000000001', 'Alpha', 'alpha', 0), row('00000000-0000-4000-8000-000000000002', 'Draft', 'draft', 1)];
  const sdkOrg = createFakeAppsOrg({ apps });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apps-list-parity-'));
  try {
    const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: ORIGIN, httpClient: client(sdkOrg) });
    const summaries = await sdk.fetchArtifactList('app');
    assert.strictEqual(sdkOrg.requests.length, 1);
    assert.deepStrictEqual(summaries.map((s) => Object.keys(s).sort()), [['id', 'isDirty', 'name', 'type'], ['id', 'isDirty', 'name', 'type']], 'the SDK\u2019s list is id and name, which is why the script reads the collection itself');
    const own = sdkOrg.requests[0].path;
    const org = createFakeAppsOrg({ apps });
    await listApps(ORIGIN, {}, client(org));
    assert.strictEqual(own.replace(',aiappdescription', ',componentstate'), org.requests[0].path);
    assert.deepStrictEqual((await listApps(ORIGIN, {}, client(createFakeAppsOrg({ apps })))).apps.map((a) => a.id).sort(), summaries.map((s) => s.id).sort(), 'the same apps');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('REAL BUNDLE: a list longer than one page is followed to the end — the saved layer and the published layer both — through the absolute @odata.nextLink the platform gives', async () => {
  const apps = Array.from({ length: 7 }, (_, i) => row(`00000000-0000-4000-8000-00000000000${i}`, `App ${i}`, `app_${i}`, 0));
  const org = createFakeAppsOrg({ apps, pageSize: 3 });
  const result = await listApps(ORIGIN, {}, client(org));
  assert.strictEqual(result.count, 7, 'every page was read');
  assert.deepStrictEqual(result.apps.map((a) => a.name), apps.map((a) => a.name));
  assert.ok(result.apps.every((a) => a.published === true), 'every app is in the published layer, which is paged too: an app on its later pages is not read as unpublished');
  assert.deepStrictEqual(org.requests.map((r) => r.path.replace(/^.*\$skiptoken=/, '#')), [LIST_PATH, '#3', '#6', PUBLISHED_PATH, '#3', '#6']);
  assert.deepStrictEqual(org.unexpected, []);
});

// The two layers are matched by id in any letter case. The platform answers GUIDs in lower case from both endpoints, so only a test holds that comparison in place.
test('REAL BUNDLE: a published row whose id the platform answers in capitals is the same app as its saved row', async () => {
  const id = '00000000-0000-4000-8000-0000000000ab';
  const org = createFakeAppsOrg({
    apps: [row(id, 'Edited', 'edited', 1, null, true)],
    answer: (req) => (req.method === 'GET' && /^\/appmodules\?/.test(req.path) ? json(200, { value: [{ appmoduleid: id.toUpperCase() }] }) : undefined),
  });
  const result = await listApps(ORIGIN, {}, client(org));
  assert.deepStrictEqual(result.apps.map((a) => [a.id, a.published, a.unpublishedChanges]), [[id, true, true]]);
});

// The saved layer is read first, then the published one, so an app deleted between the two reads is in the first answer as published (componentstate 0) and
// not in the second: neither published nor holding a saved change, which no app is. It is left out.
test('REAL BUNDLE: an app deleted between the list\u2019s two reads is left out, and an app still there is listed', async () => {
  const gone = '00000000-0000-4000-8000-000000000001';
  const kept = '00000000-0000-4000-8000-000000000002';
  const org = createFakeAppsOrg({
    apps: [row(gone, 'Going away', 'going_away', 0), row(kept, 'Staying', 'staying', 0)],
    answer: (req) => {
      if (req.method === 'GET' && /^\/appmodules\?/.test(req.path)) org.state.apps.splice(org.state.apps.findIndex((a) => a.appmoduleid === gone), 1);
      return undefined;
    },
  });
  const result = await listApps(ORIGIN, {}, client(org));
  assert.deepStrictEqual(org.requests.map((r) => `${r.method} ${r.path}`), [`GET ${LIST_PATH}`, `GET ${PUBLISHED_PATH}`], 'the order that makes this the only way to read it as neither');
  assert.deepStrictEqual(result.apps.map((a) => [a.name, a.published, a.unpublishedChanges]), [['Staying', true, false]]);
  assert.strictEqual(result.count, 1);
});

test('REAL BUNDLE: a list the platform refuses, or cannot be asked for want of a token, fails with the SDK\u2019s own code and the platform\u2019s own words', async () => {
  const org = createFakeAppsOrg({ answer: () => json(403, { error: { code: '0x80040220', message: 'The user is not a member of the organization.' } }) });
  await assert.rejects(listApps(ORIGIN, {}, client(org)), (err) => {
    assert.strictEqual(err.code, 'CONNECTION_ERROR');
    assert.strictEqual(err.statusCode, 403);
    assert.strictEqual(err.message, `the model-driven apps: HTTP 403 from ${ORIGIN}/api/data/v9.0/appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=appmoduleid,name,uniquename,description,componentstate: The user is not a member of the organization.`);
    return true;
  });
  const noToken = createAzHttpClient(ORIGIN, { getToken: () => null, request: createFakeAppsOrg().request, sleep: async () => {} });
  await assert.rejects(listApps(ORIGIN, {}, noToken), (err) => err.code === 'CONNECTION_ERROR' && /az login|Azure CLI/.test(err.message));
});

test('REAL BUNDLE: an answer that is no list, a link that is no link, and a page that repeats, are errors — never a shorter list', async () => {
  const bad = {
    'a body with no value': () => json(200, { oops: true }),
    'a value that is not a list': () => json(200, { value: 'nope' }),
    'a next link that is not text': () => json(200, { value: [], '@odata.nextLink': 7 }),
    'a next link that repeats the first page': () => json(200, { value: [], '@odata.nextLink': `${ORIGIN}/api/data/v9.0/appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=appmoduleid,name,uniquename,description,componentstate` }),
  };
  for (const [name, page] of Object.entries(bad)) {
    // A reader that follows a repeated link never ends, so the fake gives up after a few reads rather than hang the run.
    let reads = 0;
    const answer = () => (++reads > 10 ? json(500, { error: { message: 'followed a repeated link' } }) : page());
    await assert.rejects(listApps(ORIGIN, {}, client(createFakeAppsOrg({ answer }))), (err) => err.code === 'CONNECTION_ERROR' && /^the model-driven apps: (no readable result set|malformed @odata\.nextLink|repeated @odata\.nextLink)$/.test(err.message), name);
  }
});

test('REAL BUNDLE: a redirect or any other answer that is not a 2xx is a failed read, in the platform\u2019s status — never an empty list', async () => {
  for (const [status, answer] of [[301, { statusCode: 301, headers: { location: `${ORIGIN}/elsewhere` }, body: '' }], [304, { statusCode: 304, headers: {}, body: '' }], [400, json(400, { error: { message: 'bad request' } })], [404, json(404, { error: { message: 'not found' } })]]) {
    await assert.rejects(listApps(ORIGIN, {}, client(createFakeAppsOrg({ answer: () => answer }))), (err) => {
      assert.strictEqual(err.code, 'CONNECTION_ERROR', String(status));
      assert.match(err.message, new RegExp(`^the model-driven apps: HTTP ${status} from `), String(status));
      return true;
    }, String(status));
  }
});

// --- create: the sequence ----------------------------------------------------------------------------------------------

test('REAL BUNDLE: createApp itself refuses what the command line cannot carry — an empty unique name — before any request', async () => {
  const org = orgWithPages();
  const result = await createApp(args({ uniqueName: '' }), client(org), seams);
  assert.deepStrictEqual([result.ok, result.code, result.written], [false, 'UNIQUE_NAME_INVALID', false]);
  assert.deepStrictEqual(org.requests, [], 'not even a read');
});

test('REAL BUNDLE: create without --publish writes the app, its sitemap and the solution membership — and no PublishXml', async () => {
  const org = orgWithPages({ baseLanguage: 1033 });
  const result = await createApp(args(), client(org), seams);
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.deepStrictEqual(org.writeNames(), [
    'POST appmodules',
    'POST sitemaps',
    'POST AddAppComponents',
    'POST appmodules/appmoduleroles_association/$ref',
    'POST appsettings',
    'POST AddSolutionComponent',
    'POST AddSolutionComponent',
  ]);
  assert.deepStrictEqual(org.unexpected, []);
  assert.deepStrictEqual(org.state.publishes, [], 'the SDK published nothing inside the create');
  assert.strictEqual(org.state.apps[0].componentstate, 1, 'the app is a draft');
  assert.strictEqual(result.published, false);
  // Nothing reads the draft back: it is not in the published projection, and the ids the script needs were minted before the first write.
  const afterFirstWrite = org.requests.slice(org.requests.findIndex((r) => r.method !== 'GET'));
  assert.ok(!afterFirstWrite.some((r) => r.method === 'GET' && /\/appmodules(\(|\/Microsoft)/.test(r.path)), 'no read of the app after it is written');
});

test('REAL BUNDLE: the two facts create prints are the two facts list then reads off the platform — for a draft, and for an app published with --publish', async () => {
  const org = orgWithPages();
  const draft = await createApp(args({ name: 'Draft App' }), client(org), seams);
  const live = await createApp(args({ name: 'Live App', publish: true }), client(org), seams);
  assert.deepStrictEqual([draft.ok, live.ok], [true, true]);
  const listed = (await listApps(ORIGIN, {}, client(org))).apps;
  const facts = (app) => [app.published, app.unpublishedChanges];
  assert.deepStrictEqual(facts(draft), [false, true]);
  assert.deepStrictEqual(facts(live), [true, false]);
  assert.deepStrictEqual(facts(listed.find((a) => a.id === draft.appId)), facts(draft), 'what list says of the draft is what create said');
  assert.deepStrictEqual(facts(listed.find((a) => a.id === live.appId)), facts(live), 'and of the published app');
});

test('REAL BUNDLE: create --publish adds exactly one PublishXml, naming the app, after both solution components', async () => {
  const org = orgWithPages();
  const result = await createApp(args({ publish: true }), client(org), seams);
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  const names = org.writeNames();
  assert.deepStrictEqual(names.filter((n) => n === 'POST PublishXml'), ['POST PublishXml']);
  assert.strictEqual(names[names.length - 1], 'POST PublishXml', 'the last write');
  // The sequence, in order: the app row, the sitemap, the app and the sitemap into the solution, the publish.
  const key = names.filter((n) => ['POST appmodules', 'POST sitemaps', 'POST AddSolutionComponent', 'POST PublishXml'].includes(n));
  assert.deepStrictEqual(key, ['POST appmodules', 'POST sitemaps', 'POST AddSolutionComponent', 'POST AddSolutionComponent', 'POST PublishXml']);
  assert.deepStrictEqual(org.state.publishes, [result.appId], 'the publish names the app');
  assert.strictEqual(org.state.apps[0].componentstate, 0, 'the app is now published');
  assert.strictEqual(result.published, true);
  assert.deepStrictEqual(org.unexpected, []);
  // Every read came before every write, but the SDK\u2019s own and the publish\u2019s.
  const firstWrite = org.requests.findIndex((r) => r.method !== 'GET');
  assert.ok(org.requests.slice(0, firstWrite).every((r) => r.method === 'GET'));
  assert.ok(firstWrite >= 6, 'the script asked about the solution, the pages, the unique name and the language first');
});

test('REAL BUNDLE: what the platform holds after a create — the app row, the sitemap\u2019s name and id, and the solution\u2019s two components', async () => {
  const org = orgWithPages();
  const result = await createApp(args({ description: 'KPIs for the team', publish: true }), client(org), seams);
  assert.deepStrictEqual(Object.keys(result).sort(), ['addedToSolution', 'appId', 'dataSources', 'inSolution', 'languageCode', 'name', 'navigation', 'ok', 'pinnedViews', 'published', 'sitemapId', 'solution', 'uniqueName', 'unpublishedChanges']);
  assert.deepStrictEqual([result.published, result.unpublishedChanges, result.inSolution], [true, false, ['app', 'sitemap']]);
  assert.strictEqual(result.uniqueName, 'account_metrics_1a2b3c4d');
  assert.match(result.appId, GUID);
  assert.match(result.sitemapId, GUID);

  const appPost = org.requests.find((r) => r.method === 'POST' && /^\/appmodules(\?|$)/.test(r.path)).body;
  assert.deepStrictEqual(appPost, {
    name: 'Account Metrics',
    uniquename: 'account_metrics_1a2b3c4d',
    description: 'KPIs for the team',
    clienttype: 4,
    formfactor: 1,
    navigationtype: 0,
    webresourceid: DEFAULT_ICON,
    appmoduleid: result.appId,
  });
  assert.strictEqual(org.state.sitemaps.length, 1);
  const [sitemap] = org.state.sitemaps;
  assert.strictEqual(sitemap.sitemapnameunique, result.uniqueName, 'the sitemap is named for the app: the only link between the two rows');
  assert.strictEqual(sitemap.sitemapid, result.sitemapId, 'the id the script minted is the one stored');
  assert.deepStrictEqual(org.state.components, [
    { solution: 'ContosoCore', objectid: result.appId, type: 80 },
    { solution: 'ContosoCore', objectid: result.sitemapId, type: 62 },
  ]);
  const addComponent = org.requests.filter((r) => r.path === '/AddSolutionComponent').map((r) => r.body);
  assert.ok(addComponent.every((b) => b.AddRequiredComponents === false && b.SolutionUniqueName === 'ContosoCore'));
});

const SUB_AREA = /<SubArea\b[^>]*>/g;
const attribute = (tag, name) => { const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag); return m && m[1]; };
const titles = (xml) => [...xml.matchAll(/<Title LCID="(\d+)" Title="([^"]*)" \/>/g)].map((m) => [Number(m[1]), m[2]]);

test('REAL BUNDLE: the sitemap is one area "Main", one group "Pages" and a GenPage sub-area per page, titled with the page\u2019s stored name', async () => {
  const org = orgWithPages({ pages: [{ id: PAGE_A, name: 'Overview' }, { id: PAGE_B, name: 'Say "Hi" & <more>' }] });
  const result = await createApp(args({ pageIds: [PAGE_B, PAGE_A] }), client(org), seams);
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  const xml = org.state.sitemaps[0].sitemapxml;
  assert.strictEqual((xml.match(/<Area\b/g) || []).length, 1);
  assert.strictEqual((xml.match(/<Group\b/g) || []).length, 1);
  const subAreas = xml.match(SUB_AREA);
  assert.deepStrictEqual(subAreas.map((t) => attribute(t, 'GenPageId')), [PAGE_B, PAGE_A], 'in the order given');
  assert.deepStrictEqual(subAreas.map((t) => attribute(t, 'Id')), ['sub_0_0_0', 'sub_0_0_1']);
  assert.ok(subAreas.every((t) => attribute(t, 'VectorIcon') === '/_imgs/TableIconsFluentV9/document_one_page_sparkle.svg'), 'the icon the maker gives a page entry');
  assert.deepStrictEqual(titles(xml), [[1033, 'Main'], [1033, 'Pages'], [1033, 'Say &quot;Hi&quot; &amp; &lt;more&gt;'], [1033, 'Overview']], 'markup in a page\u2019s name is escaped, and the name is not changed');
  assert.match(xml, /^<SiteMap IntroducedVersion="7\.0\.0\.0"><Area Id="area_0" ShowGroups="true"/);
});

test('REAL BUNDLE: the navigation\u2019s titles are in the environment\u2019s base language, not an assumed 1033', async () => {
  for (const lcid of [1033, 3082, 1025]) {
    const org = orgWithPages({ baseLanguage: lcid });
    const result = await createApp(args(), client(org), seams);
    assert.strictEqual(result.languageCode, lcid);
    assert.deepStrictEqual([...new Set(titles(org.state.sitemaps[0].sitemapxml).map(([code]) => code))], [lcid]);
  }
});

// What `lib/sdk-build.js` appDef writes for the same navigation, through the same SDK: so a change to the build's sub-area shape (a vector
// icon, the ids) is a change this script is told about.
test('REAL BUNDLE: the sitemap written is byte for byte the one the build\u2019s appDef gives the same navigation', async () => {
  const { createMakerSdk, createNodeWorkspaceStorage } = require('../lib/maker-sdk.js');
  const org = orgWithPages();
  const result = await createApp(args({ pageIds: [PAGE_A, PAGE_B] }), client(org), seams);
  const spec = {
    solution: { uniqueName: 'ContosoCore', publisherPrefix: 'cr' },
    app: { name: 'Account Metrics', uniqueName: 'account_metrics_1a2b3c4d', description: '' },
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Pages', subAreas: [{ title: 'Overview', page: 'a' }, { title: 'Details', page: 'b' }] }] }] },
  };
  const def = appDef(spec, { pages: { a: PAGE_A, b: PAGE_B } }, { iconWebResourceId: DEFAULT_ICON });
  const buildOrg = orgWithPages();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apps-appdef-'));
  try {
    const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: ORIGIN, httpClient: client(buildOrg) });
    await sdk.initWorkspace();
    const art = await sdk.createArtifact('app', def);
    const pushed = await sdk.pushArtifact('app', art.id);
    assert.strictEqual(pushed.saved, true);
    assert.strictEqual(buildOrg.state.sitemaps[0].sitemapxml, org.state.sitemaps[0].sitemapxml);
    assert.deepStrictEqual(def.siteMap.areas[0].groups[0].subAreas.map((s) => s.type), ['GenPage', 'GenPage']);
    assert.ok(result.ok);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- create: the default views of the tables the pages read ------------------------------------------------------------

const VIEW_ACCOUNT = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const VIEW_CONTACT = 'aaaaaaaa-0000-4000-8000-0000000000a2';
const pinOrg = (options = {}) => createFakeAppsOrg({
  pages: [{ id: PAGE_A, name: 'Overview', dataSources: ['account', 'contact'] }, { id: PAGE_B, name: 'Details', dataSources: ['contact'] }],
  views: [{ savedqueryid: VIEW_ACCOUNT, table: 'account' }, { savedqueryid: VIEW_CONTACT, table: 'contact' }],
  ...options,
});
const addAppComponents = (org) => org.requests.filter((r) => r.method === 'POST' && r.path === '/AddAppComponents').map((r) => r.body);

test('REAL BUNDLE: create reads each page\'s tables and their default public views, and the SDK pins the views in the same AddAppComponents that adds the sitemap — one write, none after it', async () => {
  const org = pinOrg();
  const result = await createApp(args({ pageIds: [PAGE_A, PAGE_B] }), client(org), seams);
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.deepStrictEqual([result.dataSources, result.pinnedViews], [['account', 'contact'], [VIEW_ACCOUNT, VIEW_CONTACT]]);
  assert.ok(!('warnings' in result), JSON.stringify(result.warnings));
  const bodies = addAppComponents(org);
  assert.strictEqual(bodies.length, 1, 'the views are part of the create, not a second write');
  const components = JSON.stringify(bodies[0]).toLowerCase();
  for (const view of [VIEW_ACCOUNT, VIEW_CONTACT]) assert.ok(components.includes(view), `AddAppComponents names the view ${view}: ${components}`);
  assert.ok(components.includes(result.sitemapId), 'and the sitemap');
  // The same writes as a create with no views: nothing was added to the sequence.
  assert.deepStrictEqual(org.writeNames(), ['POST appmodules', 'POST sitemaps', 'POST AddAppComponents', 'POST appmodules/appmoduleroles_association/$ref', 'POST appsettings', 'POST AddSolutionComponent', 'POST AddSolutionComponent']);
  assert.deepStrictEqual(org.unexpected, []);
});

test('REAL BUNDLE: every read of the pages\' tables and views comes before the first write — a table\'s default public view is asked for once, as a public (querytype 0) default one', async () => {
  const org = pinOrg();
  const result = await createApp(args({ pageIds: [PAGE_A, PAGE_B] }), client(org), seams);
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  const firstWrite = org.requests.findIndex((r) => r.method !== 'GET');
  const before = org.requests.slice(0, firstWrite);
  const views = before.filter((r) => /^\/savedqueries\?/.test(r.path));
  assert.strictEqual(views.length, 2, 'one read per table, however many pages read it');
  for (const request of views) assert.match(decodeURIComponent(request.path), /returnedtypecode eq '(account|contact)' and querytype eq 0 and isdefault eq true/);
  assert.ok(before.some((r) => /^\/uxagentprojectfiles/.test(r.path)), 'the pages\' own rows were read to learn their tables');
  assert.ok(!org.requests.slice(firstWrite).some((r) => /^\/savedqueries\?/.test(r.path) || /^\/uxagentprojectfiles/.test(r.path)), 'nothing about the pages is read after the first write');
});

test('REAL BUNDLE: a table with no default public view is named in the warnings and left out, a page that reads no table pins nothing — and the app is made all the same', async () => {
  const noView = pinOrg({ views: [{ savedqueryid: VIEW_ACCOUNT, table: 'account' }] });
  const partial = await createApp(args({ pageIds: [PAGE_A] }), client(noView), seams);
  assert.strictEqual(partial.ok, true, JSON.stringify(partial));
  assert.deepStrictEqual(partial.pinnedViews, [VIEW_ACCOUNT]);
  assert.deepStrictEqual(partial.warnings, ['table contact has no default public view to pin into the app, so the maker\'s "/" picker may not list it']);

  const bare = createFakeAppsOrg({ pages: [{ id: PAGE_A, name: 'Overview' }] });
  const none = await createApp(args(), client(bare), seams);
  assert.deepStrictEqual([none.ok, none.dataSources, none.pinnedViews], [true, [], []]);
  assert.ok(!bare.requests.some((r) => /^\/savedqueries\?/.test(r.path)), 'no table, no view asked for');
  assert.ok(!JSON.stringify(addAppComponents(bare)).toLowerCase().includes('savedquery'), 'and none added to the app');
});

test('REAL BUNDLE: a page the SDK holds as raw files has no tables to read — it is named in the warnings and the create goes on', async () => {
  const org = pinOrg({ pages: [{ id: PAGE_A, name: 'Overview', raw: true }, { id: PAGE_B, name: 'Details', dataSources: ['contact'] }] });
  const result = await createApp(args({ pageIds: [PAGE_A, PAGE_B] }), client(org), seams);
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.deepStrictEqual(result.pinnedViews, [VIEW_CONTACT]);
  assert.deepStrictEqual(result.warnings, [`page ${PAGE_A} ("Overview") is held as raw files, so the tables it reads are not known and no view was pinned for it`]);
});

test('REAL BUNDLE: a page whose rows cannot be read refuses the create before anything is written, with the platform\'s words — and the page backend\'s workspace is removed', async () => {
  const org = pinOrg({ answer: (req) => (/^\/uxagentprojectfiles/.test(req.path) ? json(403, { error: { code: '0x80040220', message: 'The user is missing a privilege.' } }) : undefined) });
  const made = [];
  const mkdtemp = fs.mkdtempSync;
  fs.mkdtempSync = (prefix, ...rest) => { const dir = mkdtemp(prefix, ...rest); made.push(dir); return dir; };
  let result;
  try {
    result = await createApp(args(), client(org), seams);
  } finally {
    fs.mkdtempSync = mkdtemp;
  }
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.written, false);
  assert.ok(result.code, 'the failure has a code');
  assert.deepStrictEqual(org.writeNames(), [], 'not one write');
  assert.ok(made.length >= 2 && made.every((dir) => !fs.existsSync(dir)), 'every throwaway folder is gone');
});

test('REAL BUNDLE: two apps of one display name get two unique names, and the second is refused when it names the first', async () => {
  const org = orgWithPages();
  const first = await createApp(args(), client(org));
  const second = await createApp(args(), client(org));
  assert.strictEqual(first.ok && second.ok, true);
  assert.notStrictEqual(first.uniqueName, second.uniqueName);
  assert.match(first.uniqueName, /^account_metrics_[0-9a-f]{8}$/);
  const again = await createApp(args({ uniqueName: first.uniqueName }), client(org));
  assert.strictEqual(again.code, 'UNIQUE_NAME_TAKEN');
  assert.strictEqual(org.state.apps.length, 2, 'the refused create wrote nothing');
});

test('REAL BUNDLE: a system solution gets no AddSolutionComponent, and a normal one gets both, case aside', async () => {
  const system = createFakeAppsOrg({ solutions: [{ solutionid: '11111111-1111-4111-8111-111111111111', uniquename: 'Default', friendlyname: 'Default Solution', ismanaged: false }], pages: [{ id: PAGE_A, name: 'Overview' }] });
  const r = await createApp(args({ solution: 'default', publish: true }), client(system));
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.deepStrictEqual([r.solution, r.addedToSolution, r.inSolution, r.systemSolution], ['Default', false, [], true], 'nothing added, and the output says that is because the solution holds every component already');
  assert.ok(!system.writeNames().includes('POST AddSolutionComponent'));
  const org = orgWithPages();
  const lower = await createApp(args({ solution: 'CONTOSOCORE' }), client(org));
  assert.deepStrictEqual([lower.solution, lower.addedToSolution, lower.inSolution, org.state.components.length], ['ContosoCore', true, ['app', 'sitemap'], 2]);
  assert.ok(!('systemSolution' in lower), 'a solution of the author\u2019s own is not a system solution');
});

// --- create: refusals write nothing ------------------------------------------------------------------------------------

// Every refusal, through the real bundle and the real client: not one request that is not a read reached the platform, and the code says why.
const REFUSALS = [
  ['no page id', () => ({ args: args({ pageIds: [] }) }), 'PAGE_ID_REQUIRED'],
  ['a page id that is not a GUID', () => ({ args: args({ pageIds: ['nope'] }) }), 'PAGE_ID_INVALID'],
  ['a page that does not exist', () => ({ args: args({ pageIds: [PAGE_A, MISSING] }) }), 'PAGE_NOT_FOUND'],
  ['a solution that does not exist', () => ({ args: args({ solution: 'Nope' }) }), 'SOLUTION_NOT_FOUND'],
  ['a managed solution', () => ({ options: { solutions: [{ solutionid: '11111111-1111-4111-8111-111111111111', uniquename: 'ContosoCore', friendlyname: 'x', ismanaged: true }] }, args: args() }), 'SOLUTION_MANAGED'],
  ['a unique name an app has', () => ({ options: { apps: [row('00000000-0000-4000-8000-000000000001', 'Taken', 'taken', 1)] }, args: args({ uniqueName: 'TAKEN' }) }), 'UNIQUE_NAME_TAKEN'],
  ['a unique name a deleted app\u2019s sitemap kept', () => ({ options: { sitemaps: [{ sitemapid: '55555555-5555-4555-8555-555555555555', sitemapnameunique: 'orphan' }] }, args: args({ uniqueName: 'orphan' }) }), 'UNIQUE_NAME_TAKEN'],
  ['a unique name with a space', () => ({ args: args({ uniqueName: 'a b' }) }), 'UNIQUE_NAME_INVALID'],
  ['a base language the organization does not give', () => ({ options: { baseLanguage: null }, args: args() }), 'LANGUAGE_UNREADABLE'],
];
for (const [why, make, code] of REFUSALS) {
  test(`REAL BUNDLE: refused with ${code}, and nothing written: ${why}`, async () => {
    const { options = {}, args: given } = make();
    const org = orgWithPages(options);
    const before = JSON.stringify(org.state);
    const result = await createApp(given, client(org), seams);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, code, result.error);
    assert.strictEqual(result.written, false);
    assert.deepStrictEqual(org.writes(), [], 'no write of any kind reached the platform');
    assert.strictEqual(JSON.stringify(org.state), before, 'and nothing the platform holds changed: no app, no sitemap, no component, no publish');
    assert.deepStrictEqual(org.unexpected, []);
  });
}

test('REAL BUNDLE: a page that is only a draft in Maker is a page; a deleted one is not, and is named as the SDK would name it', async () => {
  const draftOnly = orgWithPages({ pages: [{ id: PAGE_A, name: 'Saved only', componentstate: 1 }] });
  const ok = await createApp(args(), client(draftOnly), seams);
  assert.strictEqual(ok.ok, true, JSON.stringify(ok));
  assert.strictEqual(ok.navigation.pages[0].title, 'Saved only');
  const gone = orgWithPages({ pages: [] });
  const refused = await createApp(args(), client(gone), seams);
  assert.strictEqual(refused.code, 'PAGE_NOT_FOUND');
  assert.ok(refused.error.includes(PAGE_A));
  assert.deepStrictEqual(gone.writes(), []);
});

test('REAL BUNDLE: a page with two layers (a published name and a renamed draft) is titled with the draft, the one the navigation will show', async () => {
  const org = orgWithPages({ pages: [{ id: PAGE_A, name: 'Old name', componentstate: 0 }, { id: PAGE_A, name: 'New name', componentstate: 1 }] });
  const result = await createApp(args(), client(org), seams);
  assert.strictEqual(result.navigation.pages[0].title, 'New name');
});

test('REAL BUNDLE: the authored layer is the page\u2019s title, and the app, whichever of its two rows the platform answers first', async () => {
  const pages = orgWithPages({ pages: [{ id: PAGE_A, name: 'New name', componentstate: 1 }, { id: PAGE_A, name: 'Old name', componentstate: 0 }] });
  const created = await createApp(args(), client(pages), seams);
  assert.strictEqual(created.navigation.pages[0].title, 'New name', 'authored row first');
  const between = orgWithPages({ pages: [{ id: PAGE_A, name: 'First', componentstate: 0 }, { id: PAGE_A, name: 'Authored', componentstate: 1 }, { id: PAGE_A, name: 'Last', componentstate: 0 }] });
  assert.strictEqual((await createApp(args(), client(between), seams)).navigation.pages[0].title, 'Authored', 'authored row between two published ones');

  const id = '00000000-0000-4000-8000-000000000009';
  const apps = createFakeAppsOrg({ apps: [row(id, 'Delta (renamed)', 'delta', 1), row(id, 'Delta', 'delta', 0)] });
  const listed = await listApps(ORIGIN, {}, client(apps));
  assert.deepStrictEqual(listed.apps, [{ id, name: 'Delta (renamed)', uniqueName: 'delta', description: '', published: true, unpublishedChanges: true }]);
});

// --- create: a failure after the first write ---------------------------------------------------------------------------

// What a failed create prints is READ BACK from the platform by the unique name the script chose (the saved layer, the published layer, the site map),
// so `written`, `appId`, `left`, `published` and `unpublishedChanges` say what is there and not how far the run got; `sitemapId` is always the id the
// script chose before its first write, which is the one on the wire.
const sitemapIdSent = (org) => org.requests.find((r) => r.method === 'POST' && /^\/sitemaps(\?|$)/.test(r.path)).body.sitemapid;

test('REAL BUNDLE: a sitemap the platform refuses fails the create at its stage, in the SDK\u2019s words; the SDK takes the partial app away, and the output says nothing is left', async () => {
  const refusal = json(400, { error: { code: '0x80048404', message: 'SiteMap needs to have a non-empty Area with a non-empty Group' } });
  const org = orgWithPages({ answer: (req) => (req.method === 'POST' && /^\/sitemaps/.test(req.path) ? refusal : undefined) });
  const result = await createApp(args({ publish: true }), client(org), seams);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.stage, 'create');
  assert.strictEqual(result.code, 'CONNECTION_ERROR');
  assert.match(result.error, /SiteMap needs to have a non-empty Area with a non-empty Group/);
  assert.match(result.error, /The partial app this create wrote was removed/, 'the SDK\u2019s own report of what it undid is kept');
  assert.deepStrictEqual([result.written, result.left, result.addedToSolution, result.uniqueName], [false, { app: false, sitemap: false }, false, 'account_metrics_1a2b3c4d']);
  assert.deepStrictEqual(result.inSolution, []);
  assert.ok(!('appId' in result), 'the app that was started is gone, so it is not named as one');
  assert.ok(!('published' in result), 'and nothing is said of an app that is not there');
  assert.strictEqual(result.sitemapId, sitemapIdSent(org), 'the id the script chose, which is the one that went to the platform');
  assert.deepStrictEqual(org.state.apps, [], 'and the partial app is gone');
  assert.strictEqual(org.state.components.length, 0);
});

// The SDK cannot take the partial app away when its sitemap write was refused and the delete of the app is refused too: the app stays, and the sitemap
// never existed, so the output names the app and says the sitemap is not there — and still gives the id it chose for it.
test('REAL BUNDLE: a refused sitemap whose app the platform will not delete leaves the app and no sitemap, and the output says exactly that', async () => {
  const org = orgWithPages({
    answer: (req) => {
      if (req.method === 'POST' && /^\/sitemaps(\?|$)/.test(req.path)) return json(400, { error: { message: 'SiteMap needs to have a non-empty Area with a non-empty Group' } });
      return req.method === 'DELETE' && /^\/appmodules\(/.test(req.path) ? json(400, { error: { message: 'the app cannot be deleted' } }) : undefined;
    },
  });
  const result = await createApp(args(), client(org), seams);
  assert.strictEqual(org.state.apps.length, 1, 'the premise: the app is still there');
  assert.strictEqual(org.state.sitemaps.length, 0, 'and its sitemap never was');
  assert.match(result.error, /The partial app this create wrote was KEPT/);
  assert.deepStrictEqual([result.ok, result.written, result.stage, result.left, result.published, result.unpublishedChanges], [false, true, 'create', { app: true, sitemap: false }, false, true]);
  assert.strictEqual(result.appId, org.state.apps[0].appmoduleid);
  assert.strictEqual(result.sitemapId, sitemapIdSent(org), 'the id it chose, though no row has it');
});

// A failure after the sitemap was written is the SDK's atomic rollback: ONE `$batch` change set deleting the app and the sitemap together, which the
// fake records (as it did not before: the multipart body was parsed as JSON before the request was recorded).
test('REAL BUNDLE: a failure after the sitemap was written is rolled back by the SDK in ONE $batch change set — recorded — and the output says nothing is left', async () => {
  const org = orgWithPages({ answer: (req) => (req.path === '/AddAppComponents' ? json(400, { error: { message: 'component refused' } }) : undefined) });
  const result = await createApp(args({ publish: true }), client(org), seams);
  const batches = org.requests.filter((r) => r.path === '/$batch');
  assert.strictEqual(batches.length, 1, 'one change set');
  assert.strictEqual(batches[0].method, 'POST');
  assert.match(batches[0].headers['Content-Type'], /^multipart\/mixed;boundary=batch_/);
  assert.deepStrictEqual(batches[0].operations.map((op) => [op.contentId, op.method, op.path.replace(GUID_IN_PATH, '(<id>)')]), [['1', 'DELETE', '/appmodules(<id>)'], ['2', 'DELETE', '/sitemaps(<id>)']]);
  assert.strictEqual(batches[0].operations[1].headers['if-match'], 'W/"2001"', 'the sitemap goes on the token its own write answered with, so a row someone else changed is not deleted');
  assert.deepStrictEqual(org.unexpected, [], 'every request was answered, the change set included');
  assert.deepStrictEqual([org.state.apps, org.state.sitemaps], [[], []], 'both rows are gone');
  assert.ok(org.writeNames().includes('POST $batch'));

  assert.strictEqual(result.ok, false);
  assert.match(result.error, /component refused/);
  assert.match(result.error, /The partial app this create wrote was removed/);
  assert.deepStrictEqual([result.written, result.stage, result.left], [false, 'create', { app: false, sitemap: false }]);
  assert.ok(!('appId' in result) && !('published' in result));
  assert.strictEqual(result.sitemapId, sitemapIdSent(org));
  assert.deepStrictEqual(org.requests.slice(org.requests.indexOf(batches[0]) + 1).map((r) => `${r.method} ${r.path.replace(/\?.*$/, '')}`), [
    'GET /appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()',
    'GET /appmodules',
    'GET /sitemaps/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()',
  ], 'then the read-back, once, in the saved layer, the published layer and the site maps');
});

test('REAL BUNDLE: a rollback the platform refuses keeps both rows, and the output names them: written, the app that exists, the sitemap, nothing published', async () => {
  const org = orgWithPages({
    answer: (req) => {
      if (req.path === '/AddAppComponents') return json(400, { error: { message: 'component refused' } });
      // A change set that fails is answered with the failed operation alone, and nothing in it was applied.
      return req.path === '/$batch' ? batchResponse([{ contentId: '2', status: 412 }]) : undefined;
    },
  });
  const result = await createApp(args({ publish: true }), client(org), seams);
  assert.strictEqual(org.state.apps.length, 1, 'the premise: the app is still there');
  assert.strictEqual(org.state.sitemaps.length, 1, 'and so is its sitemap');
  assert.match(result.error, /The partial app this create wrote was KEPT, because its delete was refused/, 'the SDK says so too');
  assert.deepStrictEqual([result.ok, result.written, result.stage, result.left], [false, true, 'create', { app: true, sitemap: true }]);
  assert.strictEqual(result.appId, org.state.apps[0].appmoduleid, 'the app that exists');
  assert.strictEqual(result.sitemapId, org.state.sitemaps[0].sitemapid);
  assert.deepStrictEqual([result.published, result.unpublishedChanges, result.addedToSolution, result.inSolution], [false, true, false, []]);
});

for (const wholeChangeSet of [true, false]) {
  test(`REAL BUNDLE: a customization lock ${wholeChangeSet ? 'refusing the rollback whole' : 'interrupting its answer'} keeps the SDK's honest advice, without replay`, async () => {
    const lock = { code: '0x80071151', message: 'Cannot start the requested operation because there is another EntityCustomization running at this moment.' };
    const org = orgWithPages({
      answer: (req) => {
        if (req.path === '/AddAppComponents') return json(400, { error: { message: 'component refused' } });
        if (req.path !== '/$batch') return undefined;
        if (!wholeChangeSet) return json(429, { error: lock });
        // Only a failed operation is returned when an atomic change set is refused. The lock code
        // must be on that operation, not just in the outer envelope, to prove nothing was deleted.
        return {
          statusCode: 200, headers: { 'content-type': 'multipart/mixed; boundary=br' },
          body: [
            '--br', 'Content-Type: multipart/mixed; boundary=csr', '',
            '--csr', 'Content-Type: application/http', 'Content-ID: 1', '',
            'HTTP/1.1 429 Too Many Requests', 'Content-Type: application/json', '',
            JSON.stringify({ error: lock }), '--csr--', '--br--', '',
          ].join('\r\n'),
        };
      },
    });
    const result = await createApp(args({ publish: true }), client(org), seams);
    assert.deepStrictEqual([result.ok, result.stage, result.written, result.left, result.published, result.unpublishedChanges],
      [false, 'create', true, { app: true, sitemap: true }, false, true]);
    if (wholeChangeSet) {
      assert.match(result.error, /KEPT — its rollback deleted nothing, because the environment's customization lock refused it/);
      assert.match(result.error, /Once the lock frees .*check that the rows exist and are this create's own before removing them/);
    } else {
      // postRaw preserves response TEXT, including a JSON error outside a change set. The SDK cannot
      // prove that answer refused an atomic rollback: keep its unknown verdict and cause, not KEPT.
      assert.match(result.error, /could not be confirmed, because its delete was sent but its outcome is unknown/);
      assert.match(result.error, /0x80071151.*EntityCustomization/);
      assert.match(result.error, /once you have confirmed the rows are this create's own/);
      assert.doesNotMatch(result.error, /KEPT|rollback deleted nothing/);
    }
    assert.strictEqual(result.appId, org.state.apps[0].appmoduleid);
    assert.strictEqual(result.sitemapId, org.state.sitemaps[0].sitemapid);
    assert.strictEqual(org.requests.filter((r) => r.path === '/PublishXml').length, 0, 'the component failure happened before publication');
    assert.strictEqual(org.requests.filter((r) => r.path === '/$batch').length, 1, 'rollback has an unguarded app delete, so neither layer may replay it');
    assert.deepStrictEqual(org.unexpected, []);
  });
}

// The SDK cannot tell whether a change set whose answer it never read was applied, and says so. The output does not have to guess: it reads the platform.
test('REAL BUNDLE: a rollback whose answer is lost is "unconfirmed" to the SDK, and the output reads which it was — rows gone, or rows kept', async () => {
  for (const applied of [true, false]) {
    const org = orgWithPages({
      answer: (req) => {
        if (req.path === '/AddAppComponents') return json(400, { error: { message: 'component refused' } });
        if (req.path !== '/$batch') return undefined;
        if (applied) { org.state.apps.length = 0; org.state.sitemaps.length = 0; }
        return json(502, { error: { message: 'bad gateway' } });
      },
    });
    const result = await createApp(args(), client(org), seams);
    assert.match(result.error, /could not be confirmed/, `applied ${applied}: the SDK is unsure`);
    assert.deepStrictEqual([result.written, result.left], [!applied, { app: !applied, sitemap: !applied }], `applied ${applied}: the output is not`);
    assert.strictEqual('appId' in result, !applied, `applied ${applied}`);
  }
});

test('REAL BUNDLE: a failure on the very first write leaves nothing, says so, and still names the sitemap it chose — an app that was never there is not named', async () => {
  const org = orgWithPages({ answer: (req) => (req.method === 'POST' && /^\/appmodules(\?|$)/.test(req.path) ? json(403, { error: { code: '0x80040220', message: 'The user is missing prvCreateAppModule privilege.' } }) : undefined) });
  const result = await createApp(args(), client(org), seams);
  assert.deepStrictEqual([result.ok, result.written, result.stage, result.left], [false, false, 'create', { app: false, sitemap: false }]);
  assert.match(result.error, /prvCreateAppModule/);
  assert.ok(!('appId' in result));
  assert.match(result.sitemapId, GUID);
  assert.deepStrictEqual(org.state.apps, []);
  assert.deepStrictEqual(org.state.sitemaps, []);
  assert.deepStrictEqual(org.writeNames(), ['POST appmodules'], 'the refused app was the only write');
});

test('REAL BUNDLE: a page deleted between the script\u2019s check and the SDK\u2019s own preflight is refused by the SDK before anything is written, and the output says so', async () => {
  let pageReads = 0;
  const org = orgWithPages({
    answer: (req) => {
      // The script reads the pages first; the SDK's preflight reads them again, and by then the page is gone.
      if (/^\/uxagentprojects\//.test(req.path) && (pageReads += 1) === 2) org.state.pages.length = 0;
      return undefined;
    },
  });
  const result = await createApp(args(), client(org), seams);
  assert.deepStrictEqual([result.ok, result.code, result.written, result.stage], [false, 'SITEMAP_TARGET_NOT_FOUND', false, 'create']);
  assert.deepStrictEqual(org.writes(), [], 'not one request that writes');
  assert.ok(!('appId' in result), 'no app was started, so none is named');
  assert.match(result.sitemapId, GUID);
});

test('REAL BUNDLE: a read-back that cannot be made is an unknown outcome — never a failure of the failure — and the create\u2019s own error is the one reported', async () => {
  let failed = false;
  const org = orgWithPages({
    answer: (req) => {
      if (req.method === 'POST' && /^\/appmodules(\?|$)/.test(req.path)) { failed = true; return json(403, { error: { message: 'The user is missing prvCreateAppModule privilege.' } }); }
      return failed && req.method === 'GET' ? json(503, { error: { message: 'service unavailable' } }) : undefined;
    },
  });
  const result = await createApp(args(), client(org), seams);
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /prvCreateAppModule/, 'the create\u2019s error, not the read-back\u2019s');
  assert.strictEqual(result.written, null, 'unknown');
  assert.match(result.readBackError, /HTTP 503/);
  assert.deepStrictEqual(result.lookFor, { uniqueName: 'account_metrics_1a2b3c4d', appId: result.lookFor.appId, sitemapId: result.sitemapId });
  assert.match(result.lookFor.appId, GUID);
  assert.ok(!('left' in result) && !('appId' in result) && !('published' in result));
});

// A push the SDK reported as saved committed both rows. A failure after it, with the platform then unreadable, is not "unknown": the output says what the run knows.
test('REAL BUNDLE: a failure after the push, with the platform unreadable, still says written — the push saved both rows — and names the app', async () => {
  let down = false;
  const org = orgWithPages({
    answer: (req) => {
      if (req.path === '/AddSolutionComponent') down = true;
      return down ? json(503, { error: { message: 'service unavailable' } }) : undefined;
    },
  });
  const result = await createApp(args(), client(org), seams);
  assert.deepStrictEqual([org.state.apps.length, org.state.sitemaps.length], [1, 1], 'the premise: both rows are there');
  assert.deepStrictEqual([result.ok, result.stage, result.written], [false, 'solution', true]);
  assert.strictEqual(result.appId, org.state.apps[0].appmoduleid);
  assert.strictEqual(result.sitemapId, org.state.sitemaps[0].sitemapid);
  assert.deepStrictEqual(result.left, { app: true, sitemap: true });
  assert.match(result.readBackError, /HTTP 503/);
  assert.deepStrictEqual(result.lookFor, { uniqueName: 'account_metrics_1a2b3c4d', appId: result.appId, sitemapId: result.sitemapId });
  assert.ok(!('published' in result), 'the platform could not be asked whether the app is published');
});

// The rollback is refused, so both rows stay; the app is read, and then the site maps cannot be. The app was read, so it is written.
test('REAL BUNDLE: an app found before the site map read failed is written, and the output keeps what it read', async () => {
  const org = orgWithPages({
    answer: (req) => {
      if (req.path === '/AddAppComponents') return json(400, { error: { message: 'component refused' } });
      if (req.path === '/$batch') return batchResponse([{ contentId: '2', status: 412 }]);
      return req.method === 'GET' && /^\/sitemaps\/Microsoft/.test(req.path) && org.requests.some((r) => r.path === '/$batch') ? json(503, { error: { message: 'service unavailable' } }) : undefined;
    },
  });
  const result = await createApp(args(), client(org), seams);
  assert.strictEqual(org.state.apps.length, 1, 'the premise: the app is still there');
  assert.deepStrictEqual([result.ok, result.written, result.stage], [false, true, 'create']);
  assert.strictEqual(result.appId, org.state.apps[0].appmoduleid);
  assert.deepStrictEqual(result.left, { app: true, sitemap: null }, 'the app was read; the site map could not be');
  assert.deepStrictEqual([result.published, result.unpublishedChanges], [false, true], 'both layers of the app were read before the site maps');
  assert.match(result.readBackError, /HTTP 503/);
  assert.strictEqual(result.lookFor.sitemapId, result.sitemapId);
});

// What makes a row THIS create's is its id — the app's, which the SDK minted and sent as the row's key, and the site map's, which the script chose — not the
// unique name, which is only what a retry collides on. A create under the same --unique-name that reaches the platform first makes this one's write fail as a
// duplicate and writes nothing; the rows under the name are that other create's, and they are not reported as left behind by this one.
const FOREIGN_APP = '99999999-9999-4999-8999-999999999999';
const FOREIGN_SITEMAP = '88888888-8888-4888-8888-888888888888';
const foreignSitemap = (uniqueName) => ({ sitemapid: FOREIGN_SITEMAP, sitemapnameunique: uniqueName, sitemapname: uniqueName, sitemapxml: '<SiteMap />' });

test('REAL BUNDLE: a create that loses the race for its unique name writes nothing, and the app and site map another create made under the name are named apart, not reported as its leftovers', async () => {
  let raced = false;
  const org = orgWithPages({
    answer: (req) => {
      // The other create reaches the platform between the script\u2019s check that the name is free and the SDK\u2019s write of the app.
      if (!raced && req.method === 'POST' && /^\/appmodules(\?|$)/.test(req.path)) {
        raced = true;
        org.state.apps.push({ appmoduleid: FOREIGN_APP, name: 'Another maker\u2019s app', uniquename: req.body.uniquename, description: null, componentstate: 0, published: true });
        org.state.sitemaps.push(foreignSitemap(req.body.uniquename));
      }
      return undefined;
    },
  });
  const result = await createApp(args({ uniqueName: 'shared_name' }), client(org), seams);
  assert.deepStrictEqual(org.writeNames(), ['POST appmodules'], 'this run\u2019s only write was refused, as a duplicate of the other app');
  assert.match(result.error, /already exists/);
  assert.deepStrictEqual([result.ok, result.written, result.stage, result.left], [false, false, 'create', { app: false, sitemap: false }]);
  assert.deepStrictEqual(result.nameTakenBy, { appId: FOREIGN_APP, sitemapId: FOREIGN_SITEMAP });
  assert.ok(!('appId' in result) && !('published' in result), 'the other app is not this create\u2019s: it is neither named as its app nor described');
  assert.match(result.sitemapId, GUID);
  assert.notStrictEqual(result.sitemapId, FOREIGN_SITEMAP, 'the id the script chose, which no row has');
  assert.deepStrictEqual([org.state.apps.length, org.state.sitemaps.length], [1, 1], 'and the other create\u2019s rows are untouched');
});

test('REAL BUNDLE: this create\u2019s app is left when its site map is refused as a duplicate and the app cannot be deleted — and the site map that holds the name is another\u2019s, named apart', async () => {
  const org = orgWithPages({
    answer: (req) => {
      if (req.method === 'POST' && /^\/sitemaps(\?|$)/.test(req.path)) org.state.sitemaps.push(foreignSitemap(req.body.sitemapnameunique));
      return req.method === 'DELETE' && /^\/appmodules\(/.test(req.path) ? json(400, { error: { message: 'the app cannot be deleted' } }) : undefined;
    },
  });
  const result = await createApp(args(), client(org), seams);
  assert.deepStrictEqual(org.state.apps.map((a) => a.componentstate), [1], 'the premise: this create\u2019s app is a draft, and it is still there');
  assert.deepStrictEqual([result.ok, result.written, result.stage, result.left], [false, true, 'create', { app: true, sitemap: false }]);
  assert.strictEqual(result.appId, org.state.apps[0].appmoduleid);
  assert.deepStrictEqual([result.published, result.unpublishedChanges], [false, true]);
  assert.deepStrictEqual(result.nameTakenBy, { sitemapId: FOREIGN_SITEMAP });
  assert.strictEqual(result.sitemapId, sitemapIdSent(org), 'the id this create sent, which no row has: the site map found under the name is the other one');
  assert.notStrictEqual(result.sitemapId, FOREIGN_SITEMAP);
});

test('REAL BUNDLE: a solution the sitemap cannot join fails at the solution stage, naming the app and which component joined — and the platform agrees — and publishes nothing', async () => {
  let adds = 0;
  const org = orgWithPages({ answer: (req) => (req.path === '/AddSolutionComponent' && (adds += 1) === 2 ? json(400, { error: { message: 'cannot add the sitemap' } }) : undefined) });
  const result = await createApp(args({ publish: true }), client(org), seams);
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual([result.written, result.stage, result.addedToSolution, result.published, result.unpublishedChanges], [true, 'solution', false, false, true]);
  assert.deepStrictEqual(result.inSolution, ['app'], 'the app joined the solution, its sitemap did not');
  assert.deepStrictEqual(result.left, { app: true, sitemap: true });
  // What the platform holds is what the output says: the app is a component of the solution, and only the app.
  assert.deepStrictEqual(org.state.components, [{ solution: 'ContosoCore', objectid: result.appId, type: 80 }]);
  assert.match(result.error, /cannot add the sitemap/);
  assert.strictEqual(result.appId, org.state.apps[0].appmoduleid, 'the app that exists is the one named');
  assert.strictEqual(result.sitemapId, org.state.sitemaps[0].sitemapid);
  assert.deepStrictEqual(org.state.publishes, []);
  assert.strictEqual(org.state.apps[0].componentstate, 1, 'still a draft');
});

test('REAL BUNDLE: an app the platform will not add to the solution leaves nothing in it, and the output says nothing is', async () => {
  const org = orgWithPages({ answer: (req) => (req.path === '/AddSolutionComponent' ? json(400, { error: { message: 'cannot add the app' } }) : undefined) });
  const result = await createApp(args(), client(org), seams);
  assert.deepStrictEqual([result.ok, result.stage, result.addedToSolution, result.inSolution], [false, 'solution', false, []]);
  assert.deepStrictEqual(org.state.components, []);
  assert.strictEqual(org.writeNames().filter((n) => n === 'POST AddSolutionComponent').length, 1, 'the sitemap is not tried after the app failed');
});

test('REAL BUNDLE: the SDK\u2019s own warning on the push — the role it could not associate — is in the output of a run that then fails', async () => {
  let adds = 0;
  const org = orgWithPages({
    answer: (req) => {
      if (/appmoduleroles_association/.test(req.path)) return json(400, { error: { message: 'role association refused' } });
      return req.path === '/AddSolutionComponent' && (adds += 1) === 2 ? json(400, { error: { message: 'cannot add the sitemap' } }) : undefined;
    },
  });
  const result = await createApp(args(), client(org), seams);
  assert.deepStrictEqual([result.ok, result.stage, result.inSolution], [false, 'solution', ['app']]);
  assert.strictEqual(result.warnings.length, 1);
  assert.match(result.warnings[0], /^App roles: could not associate the 'System Administrator' role with the app .*role association refused.*not be visible or playable until a role is granted access to it\.$/);
});

test('REAL BUNDLE: a publish the platform refuses fails at the publish stage with the app and its sitemap already in the solution, and the app still a draft', async () => {
  const org = orgWithPages({ answer: (req) => (req.path === '/PublishXml' ? json(400, { error: { code: '0x80040E14', message: 'another publish is running' } }) : undefined) });
  const result = await createApp(args({ publish: true }), client(org), seams);
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual([result.written, result.stage, result.addedToSolution, result.published, result.unpublishedChanges], [true, 'publish', true, false, true]);
  assert.deepStrictEqual(result.inSolution, ['app', 'sitemap']);
  assert.match(result.error, /another publish is running/);
  assert.deepStrictEqual(org.state.components.map((c) => c.type), [80, 62]);
});

test('REAL BUNDLE: a publish the platform took while its answer was lost reads as published — the read-back, not the failure, says what is there', async () => {
  const org = orgWithPages({
    answer: (req) => {
      if (req.path !== '/PublishXml') return undefined;
      // The platform publishes the app, and the answer never comes: the SDK reports a failed publish.
      for (const app of org.state.apps) Object.assign(app, { componentstate: 0, published: true });
      return json(504, { error: { message: 'gateway timeout' } });
    },
  });
  const result = await createApp(args({ publish: true }), client(org), seams);
  assert.strictEqual(result.ok, false, 'the SDK reported a failed publish');
  assert.deepStrictEqual([result.stage, result.written, result.published, result.unpublishedChanges], ['publish', true, true, false]);
});

// --- create: the app setting the SDK writes -------------------------------------------------------------------------------

// `createArtifact('app')` makes the app with the new header and navigation ON (`headerAndNavigationRefresh` is true unless the definition says
// otherwise) and the SDK's create writes that as an app setting, in the push, before its own publish step and before anything this script adds.
test('REAL BUNDLE: the SDK writes the app setting HeaderAndNavigationRefresh = 2 in the push — unpublished, before the solution and any publish — and the script writes nothing of the kind', async () => {
  const org = orgWithPages();
  const result = await createApp(args({ publish: true }), client(org), seams);
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  const names = org.writeNames();
  assert.ok(names.indexOf('POST appsettings') > names.indexOf('POST appmodules/appmoduleroles_association/$ref'), 'after the role association');
  assert.ok(names.indexOf('POST appsettings') < names.indexOf('POST AddSolutionComponent'), 'before the solution adds');
  assert.ok(names.indexOf('POST appsettings') < names.indexOf('POST PublishXml'), 'before the publish, which then activates it');
  const definition = org.state.settingDefinitions.find((d) => d.uniquename === 'HeaderAndNavigationRefresh');
  const post = org.requests.find((r) => r.method === 'POST' && r.path === '/appsettings').body;
  assert.deepStrictEqual(post, { 'parentappmoduleid@odata.bind': `/appmodules(${result.appId})`, 'settingdefinitionid@odata.bind': `/settingdefinitions(${definition.settingdefinitionid})`, value: '2' });
  assert.strictEqual(org.requests.filter((r) => r.method === 'POST' && r.path === '/appsettings').length, 1, 'once');
  // The SDK looks for a row it may already have in the unpublished layer, because a row it has just written is not in the published one.
  assert.ok(org.requests.some((r) => r.method === 'GET' && /^\/appsettings\/Microsoft\.Dynamics\.CRM\.RetrieveUnpublishedMultiple\(\)\?/.test(r.path)));
  // Written unpublished; the app's publish publishes it with the app.
  assert.deepStrictEqual(org.state.appSettings.map((s) => [s.parentappmoduleid, s.value, s.published]), [[result.appId, '2', true]]);
  assert.deepStrictEqual(org.state.components.map((c) => c.type), [80, 62], 'the setting is not added to the solution: only the app and its sitemap are');
});

test('REAL BUNDLE: a draft app made by the script has its setting only in the unpublished layer: a plain read of the settings finds none, the unpublished-aware read finds it', async () => {
  const org = orgWithPages();
  const result = await createApp(args(), client(org), seams);
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.deepStrictEqual(org.state.appSettings.map((s) => [s.parentappmoduleid, s.value, s.published]), [[result.appId, '2', false]]);
  const { createMakerSdk, createNodeWorkspaceStorage } = require('../lib/maker-sdk.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apps-setting-'));
  try {
    const c = client(org);
    const plain = await c.get(`${ORIGIN}/api/data/v9.0/appsettings?$filter=_parentappmoduleid_value eq ${result.appId}`);
    assert.deepStrictEqual(plain.body.value, [], 'what the live check of a draft app saw: no row');
    const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: ORIGIN, httpClient: c });
    assert.deepStrictEqual((await sdk.getAppSettings(result.appId)).map((s) => [s.name, s.value]), [['HeaderAndNavigationRefresh', '2']], 'the SDK\u2019s own read, which looks in the unpublished layer, finds it');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('REAL BUNDLE: an environment with no HeaderAndNavigationRefresh setting gets the app all the same, with the SDK\u2019s warning that the setting was not applied', async () => {
  const org = orgWithPages({ settingDefinitions: [] });
  const result = await createApp(args(), client(org), seams);
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.deepStrictEqual(org.state.appSettings, []);
  assert.strictEqual(result.warnings.length, 1);
  assert.match(result.warnings[0], /^App setting 'HeaderAndNavigationRefresh' was not applied: App setting 'HeaderAndNavigationRefresh' is not available in this environment/);
  assert.strictEqual(org.state.apps.length, 1);
  assert.deepStrictEqual(org.writeNames().filter((n) => n === 'POST appsettings'), []);
});

test('REAL BUNDLE: the throwaway workspace is removed after a create, after a refusal and after a failure — the page backend\u2019s own, which a create that reaches the page reads makes, included', async () => {
  const made = [];
  const mkdtemp = fs.mkdtempSync;
  fs.mkdtempSync = (prefix, ...rest) => { const dir = mkdtemp(prefix, ...rest); made.push(dir); return dir; };
  try {
    await createApp(args({ publish: true }), client(orgWithPages()), seams);
    await createApp(args({ solution: 'Nope' }), client(orgWithPages()), seams);
    await createApp(args(), client(orgWithPages({ answer: (req) => (req.path === '/AddSolutionComponent' ? json(400, { error: { message: 'no' } }) : undefined) })), seams);
    await listApps(ORIGIN, {}, client(orgWithPages()));
  } finally {
    fs.mkdtempSync = mkdtemp;
  }
  // One folder for each of the four runs, and one more for the page backend of the two creates that got as far as the pages' reads (the refusal did not). Each is
  // named for what made it: its prefix, this process, and mkdtemp's six characters (lib/temp-workspace.js).
  const prefixOf = (dir) => path.basename(dir).replace(new RegExp(`${process.pid}-[A-Za-z0-9]{6}$`), '');
  assert.deepStrictEqual(made.map(prefixOf).sort(), ['apps-', 'apps-', 'apps-', 'apps-', 'genpage-', 'genpage-']);
  for (const dir of made) assert.strictEqual(fs.existsSync(dir), false, dir);
});

// --- end to end: the real script in a real process ---------------------------------------------------------------------
// What the skill leans on — one ASCII JSON line on stdout, the exit status, what reaches stderr — and what the platform was sent, are
// properties of a PROCESS. A `node --require` preload gives the real client a fake Dataverse and writes the requests it saw to a file.

const PRELOAD = path.resolve(__dirname, 'helpers', 'fake-apps-org-preload.js');
const SCRIPT = path.resolve(__dirname, '..', 'apps.js');

function runScript(argv, orgOptions = {}, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apps-e2e-'));
  const log = path.join(dir, 'requests.json');
  try {
    const r = spawnSync(process.execPath, ['--require', PRELOAD, SCRIPT, ...argv], {
      env: { ...process.env, ...extraEnv, FAKE_APPS_ORG: JSON.stringify(orgOptions), FAKE_APPS_ORG_LOG: log },
      encoding: 'utf8',
      timeout: 120000,
    });
    return { ...r, lines: r.stdout.split(/\r?\n/).filter(Boolean), requests: fs.existsSync(log) ? JSON.parse(fs.readFileSync(log, 'utf8')) : [] };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const writesOf = (r) => r.requests.filter((req) => req.method !== 'GET').map((req) => `${req.method} ${req.path.replace(/^\//, '').replace(/\([^)]*\)/g, '').replace(/\?.*$/, '')}`);

test('END TO END: list prints one pure-ASCII JSON line, exit 0, nothing on stderr; a name beyond ASCII is an escape that reads back as itself', () => {
  const apps = [row('00000000-0000-4000-8000-000000000001', 'PCF Showcase \u2013 Org Explorer', 'pcfdemo_showcase', 0), row('00000000-0000-4000-8000-000000000002', 'Caf\u00e9', 'cafe', 1)];
  const r = runScript(['list', '--env', ORIGIN], { apps });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stderr, '');
  assert.strictEqual(r.lines.length, 1, 'one line');
  assert.match(r.stdout, /^[\x00-\x7e\r\n]*$/, 'pure ASCII');
  assert.ok(r.stdout.includes('\\u2013') && r.stdout.includes('Caf\\u00e9'));
  assert.deepStrictEqual(JSON.parse(r.lines[0]).apps.map((a) => a.name), ['Caf\u00e9', 'PCF Showcase \u2013 Org Explorer']);
  assert.deepStrictEqual(JSON.parse(r.lines[0]).apps.map((a) => [a.published, a.unpublishedChanges]), [[false, true], [true, false]], 'the draft, then the published app: two facts on each line');
  assert.deepStrictEqual(writesOf(r), []);
  assert.deepStrictEqual(r.requests.map((req) => req.path.replace(/\?.*$/, '')), ['/appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()', '/appmodules'], 'the saved layer, then the published one');
});

test('END TO END: create --publish prints one JSON line, exits 0, and the platform was sent the writes in order', () => {
  const r = runScript(['create', '--env', ORIGIN, '--name', 'Account Metrics', '--solution', 'ContosoCore', '--page-id', PAGE_A, '--page-id', PAGE_B, '--publish'], { pages: [{ id: PAGE_A, name: 'Overview' }, { id: PAGE_B, name: 'Details' }], baseLanguage: 1033 });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stderr, '');
  assert.strictEqual(r.lines.length, 1);
  const result = JSON.parse(r.lines[0]);
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual([result.published, result.unpublishedChanges, result.inSolution], [true, false, ['app', 'sitemap']]);
  assert.deepStrictEqual(result.navigation.pages.map((p) => p.title), ['Overview', 'Details']);
  const writes = writesOf(r);
  assert.deepStrictEqual(writes.filter((w) => /appmodules$|sitemaps$|AddSolutionComponent|PublishXml/.test(w)), ['POST appmodules', 'POST sitemaps', 'POST AddSolutionComponent', 'POST AddSolutionComponent', 'POST PublishXml']);
});

test('END TO END: a refusal prints its { ok: false, code } line, the reason on stderr, exits 1 — and nothing was written', () => {
  const r = runScript(['create', '--env', ORIGIN, '--name', 'A', '--solution', 'ContosoCore', '--page-id', MISSING, '--publish'], { pages: [{ id: PAGE_A, name: 'Overview' }] });
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.lines.length, 1);
  const result = JSON.parse(r.lines[0]);
  assert.deepStrictEqual([result.ok, result.code, result.written], [false, 'PAGE_NOT_FOUND', false]);
  assert.ok(r.stderr.includes(MISSING), 'stderr says why, for a person');
  assert.deepStrictEqual(writesOf(r), []);
  const none = runScript(['create', '--env', ORIGIN, '--name', 'A', '--solution', 'ContosoCore', '--publish'], {});
  assert.strictEqual(none.status, 1);
  assert.strictEqual(JSON.parse(none.lines[0]).code, 'PAGE_ID_REQUIRED');
  assert.match(none.stderr, /Create the first page without an app, then create the app with its id\./);
  assert.deepStrictEqual(none.requests, [], 'not even a read: it is decided from the command line');
});

test('END TO END: a run that fails after the push exits 1 with the SDK\u2019s notes on stderr beside the error, and the output says which component joined the solution', () => {
  const r = runScript(['create', '--env', ORIGIN, '--name', 'Account Metrics', '--solution', 'ContosoCore', '--page-id', PAGE_A, '--publish'], {
    pages: [{ id: PAGE_A, name: 'Overview' }],
    refuseWhen: [
      { method: 'POST', path: 'appmoduleroles_association', status: 400, message: 'role association refused' },
      { method: 'POST', path: '^/AddSolutionComponent$', nth: 2, status: 400, message: 'cannot add the sitemap' },
    ],
  });
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.lines.length, 1, 'one line on stdout');
  const result = JSON.parse(r.lines[0]);
  assert.deepStrictEqual([result.ok, result.written, result.stage, result.addedToSolution, result.inSolution, result.published], [false, true, 'solution', false, ['app'], false]);
  assert.deepStrictEqual([result.left, result.unpublishedChanges], [{ app: true, sitemap: true }, true], 'and what the platform holds was read back before the line was printed');
  assert.match(result.appId, GUID);
  assert.match(result.sitemapId, GUID);
  assert.strictEqual(result.warnings.length, 1);
  assert.match(r.stderr, /\u26a0 App roles: could not associate the 'System Administrator' role with the app/);
  assert.match(r.stderr, /cannot add the sitemap/, 'and the error itself');
  assert.ok(r.stderr.indexOf('\u26a0 App roles') < r.stderr.indexOf('cannot add the sitemap'), 'the note comes first');
  assert.ok(!writesOf(r).includes('POST PublishXml'), 'nothing was published');
});

test('END TO END: a usage error prints nothing on stdout, names the flag and the usage on stderr, and exits 1', () => {
  const r = runScript(['create', '--env', ORIGIN, '--name', 'A', '--solution', 'S', '--page-id', PAGE_A, '--publish', 'yes']);
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.stdout, '');
  assert.match(r.stderr, /--publish takes no value \(got 'yes'\)[\s\S]*Usage:/);
  assert.deepStrictEqual(r.requests, []);
});

test('END TO END, a platform that refuses the read: one { ok: false } line with the SDK\u2019s code, exit 1', () => {
  const r = runScript(['list', '--env', ORIGIN], { refuse: { status: 403, message: 'The user is not a member of the organization.' } });
  assert.strictEqual(r.status, 1);
  const result = JSON.parse(r.lines[0]);
  assert.deepStrictEqual([result.ok, result.code], [false, 'CONNECTION_ERROR']);
  assert.match(result.error, /HTTP 403/);
  assert.ok(r.stderr.includes('The user is not a member of the organization.'));
});

test('END TO END, with the Azure CLI not on PATH: a failed read is an { ok: false } line and exit 1 — never an empty list', () => {
  const { resolveExecutable } = require('../lib/process-runner.js');
  const emptyPath = fs.mkdtempSync(path.join(os.tmpdir(), 'no-az-'));
  try {
    const env = { ...process.env };
    // Windows names the variable `Path`, and a second spelling beside it would leave the child one of the two.
    for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
    env.PATH = emptyPath;
    assert.strictEqual(resolveExecutable('az', { env }), null, 'the premise: no `az` is found under this PATH');
    const r = spawnSync(process.execPath, [SCRIPT, 'list', '--env', ORIGIN], { env, encoding: 'utf8', timeout: 120000 });
    assert.strictEqual(r.status, 1, r.stderr);
    const result = JSON.parse(r.stdout.trim());
    assert.deepStrictEqual([result.ok, result.code], [false, 'CONNECTION_ERROR']);
    assert.match(result.error, /Azure CLI/);
    assert.ok(!('apps' in result), 'no answer, not even an empty one');
  } finally {
    fs.rmSync(emptyPath, { recursive: true, force: true });
  }
});

test('the az-token client the script builds is the plugin\u2019s own: the token is requested for the origin, and never printed', async () => {
  const asked = [];
  const org = createFakeAppsOrg();
  const c = createAzHttpClient(ORIGIN, { getToken: (origin) => { asked.push(origin); return 'secret-token'; }, request: org.request, sleep: async () => {} });
  const result = await listApps(ORIGIN, {}, c);
  assert.deepStrictEqual(asked, [ORIGIN]);
  assert.ok(!JSON.stringify(result).includes('secret-token'));
});
