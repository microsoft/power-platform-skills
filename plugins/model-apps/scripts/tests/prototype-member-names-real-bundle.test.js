'use strict';
// The names of prototype-member-names.test.js — `__proto__`, `constructor`, `toString`, `hasOwnProperty` — through a whole build, its verify and
// its teardown: over the REAL vendored SDK, the plugin's own HTTP client and the strict stateful fake of helpers/fake-lifecycle-org.js, as
// lifecycle-matrix-real-bundle.test.js runs the kitchen-sink spec. A name the platform takes is a name the build must take: these are a maker's
// dashboards, a page's key and a table's status reasons, and nothing here is refused for its name.
//
//   1. four dashboards so named, each opened from the app's navigation
//   2. a new app whose navigation holds a table and a page keyed `constructor`: the app is created before its pages, so its first navigation
//      leaves the page out, and the pages step adds it
//   3. status reasons so labelled, and the values the data-model phase captures for them
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { createLifecycleOrg } = require('./helpers/fake-lifecycle-org.js');
const { createLifecycleHarness } = require('./helpers/lifecycle-harness.js');
const { makeRunner, provisionDataModel } = require('../lib/entity-provision.js');

const NAMES = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'];
const SOLUTION = 'ContosoNames';
const APP = 'contoso_names';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A map holding each of `names` as its OWN key, as JSON.parse makes it (a plain object literal or assignment cannot hold `__proto__`).
const ownMap = (names, valueOf) => JSON.parse(`{${names.map((name) => `${JSON.stringify(name)}:${JSON.stringify(valueOf(name))}`).join(',')}}`);

function environment() {
  const org = createLifecycleOrg();
  return { org, harness: createLifecycleHarness(org, makeTempDir('proto-names-')) };
}

// A measured step ran: it did not throw, and every request it sent is one the fake models.
function ran(step, label) {
  assert.ok(step, `${label} ran`);
  if (step.error) throw step.error;
  assert.deepEqual(step.unexpected, [], `every request ${label} sent is one the fake models`);
  return step;
}
function built(step, label) {
  const { result } = ran(step, label).value;
  assert.equal(result.ok, true, `${label}: ${JSON.stringify(result.errors || result.error)}`);
  assert.deepEqual(result.verify && { ok: result.verify.ok, missing: result.verify.missing }, { ok: true, missing: [] }, `${label}: its own verify finds every artifact`);
  return result;
}

const app = (subAreas, more) => ({
  schemaVersion: 2,
  solution: { uniqueName: SOLUTION, displayName: 'Contoso Names', publisherPrefix: 'contoso' },
  app: { name: 'Names', uniqueName: APP },
  entities: [{ schemaName: 'contact', displayName: 'Contact', existing: true, primaryAttribute: { schemaName: 'fullname', displayName: 'Full Name' }, columns: [] }],
  appShell: { areas: [{ label: 'Work', groups: [{ label: 'Work', subAreas: [{ entity: 'contact', title: 'Contacts' }, ...subAreas] }] }] },
  ...more,
});

// The app's navigation as the environment holds it: the attributes of each SubArea, in order. A sitemap's XML, e.g.
//   <SiteMap …><Area Id="area_0" …><Group Id="group_0_0" …><SubArea Id="sub_0_0_1" DefaultDashboard="{…}" Url="/main.aspx?pagetype=dashboard…" …>
// Only the SubArea start tags are read, and only the attributes the build writes.
const subAreasOf = (xml) => (String(xml).match(/<SubArea\b[^>]*>/g) || []).map((tag) => Object.fromEntries([...tag.matchAll(/\s([A-Za-z]+)="([^"]*)"/g)].map(([, k, v]) => [k, v])));
const navigation = (org) => {
  const [sitemap] = org.find('sitemaps', (s) => s.sitemapnameunique === APP);
  return sitemap ? subAreasOf(sitemap.sitemapxml) : null;
};
const bare = (id) => String(id || '').replace(/[{}]/g, '').toLowerCase();
const dashboardsNamed = (org, name) => org.find('systemforms', (f) => Number(f.type) === 0 && f.name === name).map((f) => bare(f.formid));
const allDashboards = (org) => org.find('systemforms', (f) => Number(f.type) === 0).map((f) => bare(f.formid));

// --- 1. dashboards ----------------------------------------------------------------------------------------------------------------------------------------

const boards = () => app(NAMES.map((name) => ({ dashboard: name, title: `Board ${name}` })), {
  dashboards: NAMES.map((name) => ({ name, tiles: [{ type: 'iframe', url: 'https://contoso.example/status', name: 'Status' }] })),
});

test('dashboards called __proto__, constructor, toString and hasOwnProperty are built, each opened from the navigation, reused by a rebuild, verified and torn down', async () => {
  const env = environment();
  const result = built(await env.harness.measure(() => env.harness.build(boards())), 'the build');
  const ids = NAMES.map((name) => {
    const rows = dashboardsNamed(env.org, name);
    assert.equal(rows.length, 1, `${name}: one dashboard of this name`);
    return rows[0];
  });
  assert.deepEqual(navigation(env.org).filter((s) => s.DefaultDashboard !== undefined).map((s) => bare(s.DefaultDashboard)), ids, 'each nav entry opens the dashboard of its name, in the spec\'s order');
  assert.equal(JSON.stringify(result.created.dashboards), JSON.stringify(ownMap(NAMES, (name) => ids[NAMES.indexOf(name)])), 'the build result names every dashboard by its name');

  const again = built(await env.harness.measure(() => env.harness.build(boards())), 'the rebuild');
  assert.deepEqual(NAMES.map((name) => dashboardsNamed(env.org, name)), ids.map((id) => [id]), 'the rebuild created no dashboard: each is reused by its name');
  assert.equal(JSON.stringify(again.created.dashboards), JSON.stringify(result.created.dashboards));

  const teardown = ran(await env.harness.measure(() => env.harness.teardown(boards())), 'the teardown');
  assert.equal(teardown.value.result.ok, true, JSON.stringify(teardown.value.result.errors));
  assert.deepEqual(allDashboards(env.org), [], 'ALL ABSENT: every dashboard the build made is deleted');
});

// --- 2. a page keyed constructor ------------------------------------------------------------------------------------------------------------------------

// The lifecycle harness writes KitchenPage.tsx into the app folder; the page is built from it.
const withPage = () => app([{ page: 'constructor', title: 'Constructor' }], {
  pages: [{ key: 'constructor', name: 'Constructor', source: { kind: 'tsx', codeFile: 'KitchenPage.tsx' } }],
});
const sitemapsWritten = (org, mark) => org.since(mark).filter((r) => r.body && typeof r.body === 'object' && typeof r.body.sitemapxml === 'string').map((r) => subAreasOf(r.body.sitemapxml));

test('a new app whose navigation holds a table and a page keyed constructor: its first navigation leaves the page out, the pages step adds it, and verify and teardown find it', async () => {
  const env = environment();
  const step = await env.harness.measure(() => env.harness.build(withPage()));
  const result = built(step, 'the build');
  const pageId = bare(result.created.pages.constructor);
  assert.match(pageId, GUID, 'the page was built, under its key');
  assert.deepEqual(Object.keys(result.created.pages), ['constructor']);
  const written = sitemapsWritten(env.org, step.mark);
  assert.ok(written.length >= 1, 'the build wrote the app\'s navigation');
  assert.deepEqual(written[0].map((s) => (s.Entity ? `Entity ${s.Entity}` : `GenPage ${s.GenPageId}`)), ['Entity contact'], 'the app\'s first navigation leaves out the page it does not have yet — never an entry with no page');
  for (const sitemap of written) for (const s of sitemap) if (s.GenPageId !== undefined) assert.match(s.GenPageId, GUID, 'no navigation the build writes names a page by anything but its id');
  assert.deepEqual(navigation(env.org).map((s) => (s.Entity ? `Entity ${s.Entity}` : `GenPage ${bare(s.GenPageId)}`)), ['Entity contact', `GenPage ${pageId}`], 'the pages step put the page in the navigation');

  const teardown = ran(await env.harness.measure(() => env.harness.teardown(withPage())), 'the teardown');
  assert.equal(teardown.value.result.ok, true, JSON.stringify(teardown.value.result.errors));
  assert.equal(navigation(env.org), null, 'ALL ABSENT: the app\'s navigation is gone with the app');
  assert.deepEqual(env.org.find('uxagentprojects', (p) => bare(p.uxagentprojectid) === pageId), [], 'and so is the page');
});

// --- 3. status reasons ----------------------------------------------------------------------------------------------------------------------------------

// The data-model phase alone, over the real SDK and a transport that answers only what this test models: a table that exists, whose status
// reasons cannot be read, so each is inserted. The value an insert is answered with is the one it asked for (the build pins each), as
//   POST /InsertStatusValue { "EntityLogicalName": "contoso_project", "AttributeLogicalName": "statuscode", "Value": 100000000, … } -> { "NewOptionValue": 100000000 }
// See: https://learn.microsoft.com/power-apps/developer/data-platform/webapi/reference/insertstatusvalue
const BUNDLE = path.resolve(__dirname, '..', 'vendor', 'cds-maker-sdk.cjs');
const ORG = 'https://contoso.crm.dynamics.com';
const PROBE = "/EntityDefinitions(LogicalName='contoso_project')?$select=LogicalName,EntitySetName";
const COLUMN_LIST = "/EntityDefinitions(LogicalName='contoso_project')/Attributes?$select=LogicalName,RequiredLevel";
const STATUS_READ = "/EntityDefinitions(LogicalName='contoso_project')/Attributes/Microsoft.Dynamics.CRM.StatusAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)";
async function dataModel(spec) {
  const { createMakerSdk, createNodeWorkspaceStorage } = require(BUNDLE);
  const unmodelled = [];
  const inserted = [];
  const send = async (method, url, body) => {
    const asked = decodeURIComponent(String(url)).replace(/^https:\/\/contoso\.crm\.dynamics\.com\/api\/data\/v9\.\d+/, '');
    const reply = (() => {
      if (method === 'GET' && asked === PROBE) return { status: 200, body: { LogicalName: 'contoso_project', EntitySetName: 'contoso_projects' } };
      if (method === 'GET' && asked === COLUMN_LIST) return { status: 200, body: { value: [{ LogicalName: 'contoso_name', RequiredLevel: { Value: 'None' } }] } };
      if (method === 'GET' && asked === STATUS_READ) return { status: 500, body: { error: { code: '0x80040216', message: 'An unexpected error occurred.' } } };
      if (method === 'POST' && asked === '/InsertStatusValue') { inserted.push(body.Label); return { status: 200, body: { NewOptionValue: body.Value } }; }
      return null;
    })();
    if (!reply) {
      unmodelled.push(`${method} ${asked}`);
      throw new Error(`the test does not model ${method} ${asked}`);
    }
    return { status: reply.status, headers: {}, body: reply.body };
  };
  const httpClient = { get: (url) => send('GET', url), post: (url, body) => send('POST', url, body), put: (url, body) => send('PUT', url, body), patch: (url, body) => send('PATCH', url, body), delete: (url) => send('DELETE', url) };
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(makeTempDir('proto-names-sdk-')), instanceUrl: ORG, httpClient });
  await sdk.initWorkspace();
  const result = await provisionDataModel({
    sdk, provision: sdk, runner: makeRunner({ emit: () => {}, total: 20 }), spec, apply: true,
    preResolvedLanguageCode: 1033, provisionedLanguages: async () => [1033], sleep: async () => {}, warn: () => {},
  });
  return { result, unmodelled, inserted };
}

test('status reasons labelled __proto__, constructor, toString and hasOwnProperty are each inserted, and the value of each is kept under its label for the sample data', async () => {
  const spec = {
    solution: { uniqueName: SOLUTION, publisherPrefix: 'contoso' },
    relationships: [],
    entities: [{ schemaName: 'contoso_Project', displayName: 'Project', pluralName: 'Projects', primaryAttribute: { schemaName: 'contoso_Name' }, columns: [], statusReasons: [...NAMES, 'In Review'].map((label) => ({ label, state: 'Active' })) }],
  };
  const { result, unmodelled, inserted } = await dataModel(spec);
  assert.deepEqual(unmodelled, [], 'every request was one the test models');
  assert.deepEqual(inserted.map((label) => label.LocalizedLabels[0].Label), [...NAMES, 'In Review'], 'each reason inserted once, in the spec\'s order');
  const values = result.statusReasonValues.contoso_project;
  assert.deepEqual(Object.keys(values), [...NAMES, 'In Review'], 'each value kept under its own label');
  assert.equal(JSON.stringify(values), JSON.stringify(ownMap([...NAMES, 'In Review'], (label) => ({ value: 100000000 + [...NAMES, 'In Review'].indexOf(label), stateCode: 0 }))));
});
