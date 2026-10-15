'use strict';
// REAL-BUNDLE tests of what the teardown takes as PROOF that a page is an app's page: the pages in the navigation of the app's sitemap, read as navigation.
//
// A page that the app's navigation holds is deleted with no record of this workspace to say it is the app's, so what counts as "the navigation holds it" decides which pages are deleted. A sitemap is XML. A
// `GenPageId="…"` inside a comment or a CDATA section is text, not an entry of the navigation, and `GenPageId='…'` in single quotes is an entry like any other. The proof is read from the navigation ELEMENTS
// (SiteMap/Area/Group/SubArea), as the SDK's own reader of the app's sitemap reads them, so the pages that are deleted are the pages the SDK says the app navigates to (`retained`, below) — for a published app, and for
// an app that was never published, found through its sitemap component or only through the unique name its sitemap carries.
//
// The sitemap of an app that was never published is read in its saved layer, which can answer with the rows of two layers of one sitemap: a published one and a pending edit. A sitemap is found by
// name for an app whose layer has no sitemap component, and then the row whose navigation is read is its CURRENT one — which must carry the app's unique name itself. A name that sits on another row of the sitemap
// than the current one does not make the current row's navigation the app's, whichever row the platform lists first.
//
// The bundle is the real one, over the plugin's own transport and the fake org of helpers/fake-apps-org.js. What the fake org does not model — the app's layer key, its sitemap component (componenttype 62), the page
// manifest, the web resource and solution deletes, and a read capped at one row — is answered by the test, as in teardown-never-published-real-bundle.test.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAzHttpClient } = require('../lib/sdk-http-client.js');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../lib/maker-sdk.js');
const { runTeardown } = require('../lib/sdk-teardown.js');
const { manifestResourceName } = require('../lib/page-manifest.js');
const { createFakeAppsOrg, json } = require('./helpers/fake-apps-org.js');

const ORIGIN = 'https://contoso.crm.dynamics.com';
const PAGE_A = '11111111-1111-4111-8111-111111111111';
const PAGE_B = '22222222-2222-4222-8222-222222222222';
const APP = '33333333-3333-4333-8333-333333333333';
const LAYER = '44444444-4444-4444-8444-444444444444';
const SITEMAP = '55555555-5555-4555-8555-555555555555';
const MANIFEST_ID = '66666666-6666-4666-8666-666666666666';
const ICON_ID = '77777777-7777-4777-8777-777777777777';
const SOLUTION_ID = '88888888-8888-4888-8888-888888888888';
const APP_NAME = 'contoso_probe';
const FOREIGN_NAME = 'contoso_foreign';

const navigation = (...entries) => `<SiteMap><Area Id="a"><Group Id="g">${entries.join('')}</Group></Area></SiteMap>`;
const entry = (id, quote = '"') => `<SubArea Id="p_${id}" GenPageId=${quote}${id}${quote} Title="Page"/>`;
const sitemapRow = (over) => ({ sitemapid: SITEMAP, sitemapnameunique: APP_NAME, sitemapxml: navigation(entry(PAGE_A)), componentstate: 1, ...over });

// An app, its sitemap and the two pages its page manifest lists — and no creation record of this workspace for either, so the app's navigation is the only proof there is. `xml` is the sitemap (its one row),
// or `sitemaps` are its rows verbatim, in the order the platform lists them. `published` makes the app a published one. `componentLinked: false` leaves its layer with no sitemap component, so the sitemap that
// carries its unique name is the one that is read. `others` are the rows of other apps and sitemaps the environment holds.
async function world(t, { xml = navigation(entry(PAGE_A), entry(PAGE_B)), sitemaps, published = false, componentLinked = true, others = {} } = {}) {
  const dirs = [];
  t.after(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });
  const tempDir = (what) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), `contoso-${what}-`)); dirs.push(dir); return dir; };
  const layer = published ? 0 : 1;
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'a', name: 'Page A', pageId: PAGE_A }, { key: 'b', name: 'Page B', pageId: PAGE_B }] })).toString('base64');
  const org = createFakeAppsOrg({
    solutions: [{ solutionid: SOLUTION_ID, uniquename: 'ContosoCore', friendlyname: 'Contoso Core', ismanaged: false }],
    apps: [{ appmoduleid: APP, appmoduleidunique: LAYER, name: 'Contoso Probe', uniquename: APP_NAME, componentstate: layer, '@odata.etag': 'W/"1001"' }, ...(others.apps || [])],
    sitemaps: [...(sitemaps || [sitemapRow({ sitemapxml: xml, componentstate: layer, '@odata.etag': 'W/"2001"' })]), ...(others.sitemaps || [])],
    pages: [{ id: PAGE_A, name: 'Page A' }, { id: PAGE_B, name: 'Page B' }],
    answer: (req) => {
      // A read capped at one row (`$top=1`) is answered with ONE row, as the platform does — the first of the sitemap's rows, whichever layer it is. The SDK's own read of an app's sitemap by id is such a read.
      if (req.method === 'GET' && /^\/sitemaps\/Microsoft\.Dynamics\.CRM\.RetrieveUnpublishedMultiple\(\)\?/.test(req.path) && /\$top=1(?:&|$)/.test(req.path)) {
        const id = (/sitemapid eq ([0-9a-f-]{36})/i.exec(req.path) || [])[1];
        const first = org.state.sitemaps.find((row) => !id || row.sitemapid.toLowerCase() === id.toLowerCase());
        return json(200, { value: first ? [first] : [] });
      }
      // The app's sitemap, as a component of its layer: GET /appmodulecomponents?$select=objectid,componenttype&$filter=_appmoduleidunique_value eq <layer key> and componenttype eq 62&$top=1
      if (req.method === 'GET' && req.path.startsWith('/appmodulecomponents')) return json(200, { value: componentLinked ? [{ objectid: SITEMAP, componenttype: 62 }] : [] });
      if (req.method === 'GET' && req.path.startsWith('/webresourceset')) {
        const name = (/name eq '([^']+)'/.exec(req.path) || [])[1];
        if (name === manifestResourceName(APP_NAME)) return json(200, { value: [{ webresourceid: MANIFEST_ID, name, content: manifest }] });
        if (name === `${APP_NAME}_icon`) return json(200, { value: [{ webresourceid: ICON_ID, name }] });
        return json(200, { value: [] });
      }
      if (req.method === 'DELETE' && /^\/(webresourceset|solutions)\(/.test(req.path)) return { statusCode: 204, headers: {}, body: '' };
      return null;
    },
  });
  const client = createAzHttpClient(ORIGIN, { getToken: () => 'test-token', request: org.request, sleep: async () => {} });
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(tempDir('sdk')), instanceUrl: ORIGIN, httpClient: client });
  await sdk.initWorkspace();
  // The pages the SDK's own reader of the app's sitemap — the one its app delete takes the pages to retain from — says the app navigates to.
  const retained = [];
  const deleteApp = sdk.deleteAppCascade.bind(sdk);
  sdk.deleteAppCascade = async (...args) => {
    const answer = await deleteApp(...args);
    retained.push(...answer.retained.map((page) => page.id));
    return answer;
  };
  const workspaceDir = tempDir('workspace');
  const spec = {
    solution: { uniqueName: 'ContosoCore', publisherPrefix: 'contoso' },
    app: { uniqueName: APP_NAME, name: 'Contoso Probe' },
    pages: [{ key: 'a', name: 'Page A' }, { key: 'b', name: 'Page B' }],
  };
  const teardown = (opts = {}) => runTeardown(spec, { apply: true, env: ORIGIN, workspaceDir, ...opts }, { sdk });
  // Every write that reached the platform, a `$batch` change set taken apart, as `METHOD /path`.
  const writes = () => org.requests.filter((r) => r.method !== 'GET').flatMap((r) => (r.operations || [r]).map((op) => `${op.method} ${op.path}`));
  // The records of the pages a teardown is about to delete, which it writes before it deletes the app: nothing else can find them again.
  const records = () => fs.readdirSync(workspaceDir).filter((name) => name.startsWith('page-ownership.teardown.'));
  return { org, teardown, writes, records, retained };
}

const pagesWritten = (writes) => writes.filter((w) => w.startsWith('DELETE /uxagentprojects(')).map((w) => w.slice('DELETE /uxagentprojects('.length, -1));
const notProven = (id, name) => new RegExp(`${id} "${name}" \\(kept — not proven to belong to this app`);

const ROUTES = [
  ['found through the sitemap component of its layer', { componentLinked: true }],
  ['found through the unique name its sitemap carries, its layer having no sitemap component', { componentLinked: false }],
];

for (const [route, setup] of ROUTES) {
  for (const [hiding, hidden] of [['COMMENT', (page) => `<!-- ${page} -->`], ['CDATA section', (page) => `<![CDATA[${page}]]>`]]) {
    test(`REAL BUNDLE: a page that only a ${hiding} in the saved navigation of an app that was never published names is not proven to be its page — ${route}`, async (t) => {
      const { teardown, writes, retained } = await world(t, { ...setup, xml: navigation(entry(PAGE_A), hidden(entry(PAGE_B))) });
      const result = await teardown();
      assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
      assert.deepStrictEqual(retained, [PAGE_A], 'the SDK\'s own reader finds one page in that navigation');
      assert.deepStrictEqual(result.deleted.genpage, [PAGE_A], 'so that is the one page proven');
      assert.deepStrictEqual(pagesWritten(writes()), [PAGE_A], 'and the other page is never put to the platform');
      assert.match(result.skipped.join('\n'), notProven(PAGE_B, 'Page B'));
    });
  }

  test(`REAL BUNDLE: the pages that single-quoted GenPageId attributes of the saved navigation of an app that was never published name are its pages — ${route}`, async (t) => {
    const { teardown, writes, retained } = await world(t, { ...setup, xml: navigation(entry(PAGE_A, "'"), entry(PAGE_B, "'")) });
    const result = await teardown();
    assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
    assert.deepStrictEqual([...retained].sort(), [PAGE_A, PAGE_B], 'the SDK\'s own reader finds both pages');
    assert.deepStrictEqual([...(result.deleted.genpage || [])].sort(), [PAGE_A, PAGE_B], 'and so does the proof: both are deleted, not left behind with the navigation that named them gone');
    assert.deepStrictEqual(pagesWritten(writes()).sort(), [PAGE_A, PAGE_B]);
  });
}

// A published app was read the same way before this: its published navigation proves its pages. A page that only a comment names is not in what the app shows, whatever the text says.
test('REAL BUNDLE: a page that only a COMMENT in the published navigation names is not proven to be the published app\'s page', async (t) => {
  const { teardown, writes, retained } = await world(t, { published: true, xml: navigation(entry(PAGE_A), `<!-- ${entry(PAGE_B)} -->`) });
  const result = await teardown();
  assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
  assert.deepStrictEqual(retained, [PAGE_A]);
  assert.deepStrictEqual(result.deleted.genpage, [PAGE_A]);
  assert.deepStrictEqual(pagesWritten(writes()), [PAGE_A]);
  assert.match(result.skipped.join('\n'), notProven(PAGE_B, 'Page B'));
});

test('REAL BUNDLE: the pages that single-quoted GenPageId attributes of the published navigation name are the published app\'s pages', async (t) => {
  const { teardown, writes, retained } = await world(t, { published: true, xml: navigation(entry(PAGE_A, "'"), entry(PAGE_B, "'")) });
  const result = await teardown();
  assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
  assert.deepStrictEqual([...retained].sort(), [PAGE_A, PAGE_B]);
  assert.deepStrictEqual([...(result.deleted.genpage || [])].sort(), [PAGE_A, PAGE_B]);
  assert.deepStrictEqual(pagesWritten(writes()).sort(), [PAGE_A, PAGE_B]);
});

// The platform's rows for one sitemap that has a pending edit: the published layer (componentstate 0) and the authored one (componentstate 1). Which of them it lists first is not specified, and the SDK's own
// read of the sitemap by id takes one row of them (`$top=1`) — so the app delete itself can accept or refuse the app by the name that happens to sit on the row it got. The proof must not depend on it either way.
const OLDER = (name) => sitemapRow({ sitemapnameunique: name, sitemapxml: navigation(entry(PAGE_A)), componentstate: 0, '@odata.etag': 'W/"2001"' });
const CURRENT = (name) => sitemapRow({ sitemapnameunique: name, sitemapxml: navigation(entry(PAGE_B)), componentstate: 1, '@odata.etag': 'W/"2002"' });
const DISAGREEING = [
  ['the app\'s name is on the older row only, and the current row is another app\'s', [OLDER(APP_NAME), CURRENT(FOREIGN_NAME)]],
  ['the app\'s name is on the current row only, and the older row is another app\'s', [OLDER(FOREIGN_NAME), CURRENT(APP_NAME)]],
];
for (const [what, rows] of DISAGREEING) {
  for (const [order, listed] of [['the older row listed first', rows], ['the current row listed first', [...rows].reverse()]]) {
    test(`REAL BUNDLE: ${what} — the sitemap is not read as the app's navigation, whichever row the platform lists first (${order}): nothing is recorded or deleted, and the app stays`, async (t) => {
      const { org, teardown, writes, records } = await world(t, { componentLinked: false, sitemaps: listed });
      const result = await teardown();
      assert.strictEqual(result.ok, false);
      assert.deepStrictEqual(writes(), [], 'not one write reached the platform: no page, not the app, not its sitemap');
      assert.deepStrictEqual(records(), [], 'and no page was recorded as one to delete — that record is written before the app is deleted');
      assert.match(result.errors.map((e) => e.message).join('\n'), /app sitemap unreadable \(the app was never published, so its navigation is the one it saved, and that could not be read: sitemap-query-failed: [^)]*unique name/);
      assert.deepStrictEqual([org.state.apps.length, org.state.sitemaps.length], [1, 2], 'the app and both rows of its sitemap stay for a re-run');
    });
  }
}

// The unique name is the app's identity, not its display name: another app that is called the same, and whose sitemap holds the other page, is not this app, and neither is its sitemap.
test('REAL BUNDLE: another app with the same display name and another unique name is not this app — only this app\'s page is deleted, and the other app and its sitemap stay', async (t) => {
  const others = {
    apps: [{ appmoduleid: '99999999-9999-4999-8999-999999999999', appmoduleidunique: '99999999-9999-4999-8999-999999999999', name: 'Contoso Probe', uniquename: FOREIGN_NAME, componentstate: 1 }],
    sitemaps: [{ sitemapid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sitemapnameunique: FOREIGN_NAME, sitemapxml: navigation(entry(PAGE_B)), componentstate: 1, '@odata.etag': 'W/"3001"' }],
  };
  const { org, teardown, writes } = await world(t, { componentLinked: false, xml: navigation(entry(PAGE_A)), others });
  const result = await teardown();
  assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
  assert.deepStrictEqual(result.deleted.genpage, [PAGE_A]);
  assert.deepStrictEqual(pagesWritten(writes()), [PAGE_A]);
  assert.deepStrictEqual([org.state.apps.length, org.state.sitemaps.length], [1, 1], 'the other app and its sitemap are untouched');
  assert.match(result.skipped.join('\n'), notProven(PAGE_B, 'Page B'));
});
