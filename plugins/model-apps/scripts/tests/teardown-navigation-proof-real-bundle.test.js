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
//
// The navigation is read by ONE strict XML reader (lib/strict-xml.js; the section "One strict reader for the navigation" below): the markers of one kind of construct inside another are data, and a sitemap that is not one
// well-formed document is unreadable before any page is recorded as the app's. tests/strict-xml-oracle.test.js holds that reader to the parser the SDK itself reads the sitemap with.
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
const { assertGolden } = require('./helpers/golden.js');

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
// carries its unique name is the one that is read. `others` are the rows of other apps and sitemaps the environment holds. `answer(req, org)` answers a request before anything else does (a layer the fake org
// does not model, a refusal).
async function world(t, { xml = navigation(entry(PAGE_A), entry(PAGE_B)), sitemaps, published = false, componentLinked = true, others = {}, answer } = {}) {
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
      const own = answer && answer(req, org);
      if (own) return own;
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

// ── One strict reader for the navigation ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The navigation is read by ONE strict XML reader (strict-xml.js), in one pass, and a page is deleted only when it reads a SubArea under SiteMap/Area/Group that names it. Four things follow, and each was wrong
// before: a delimiter inside a comment, a CDATA section, a processing instruction or an attribute value is data and opens nothing (the navigation was read by three passes that each removed one kind of construct,
// and a delimiter of one kind inside another changed what was left); a document that is not ONE well-formed document is unreadable before any page is recorded as the app's (the records outlive the app, so a retry
// after the sitemap was repaired deleted the pages a malformed document had named); and neither depends on which route read the sitemap.
const PROOF_ROUTES = [
  ['a never-published app, found through its sitemap component', { componentLinked: true }],
  ['a never-published app, found through the unique name its sitemap carries', { componentLinked: false }],
  ['a published app', { published: true }],
];
const savedLayer = (xml) => (req) => (req.method === 'GET' && req.path.startsWith('/sitemaps/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple')
  ? json(200, { value: [sitemapRow({ sitemapxml: xml, componentstate: 1, '@odata.etag': 'W/"2001"' })] }) : null);

// Well-formed XML in which the delimiters of one kind of construct sit inside another kind. Only the SubArea elements are navigation.
//   a processing instruction that holds "<!--", then a CDATA section that holds "-->" and "?>" and a SubArea for B: B is text, and A is the only entry.
const DATA_B = navigation(entry(PAGE_A), '<?p <!-- ?><![CDATA[ --> ?> ', entry(PAGE_B), ' ]]>');
//   two processing instructions that hold the "<![CDATA[" and the "]]>" of a CDATA section, with A between them and B after: both are entries.
const ENTRIES_BETWEEN_MARKERS = navigation('<?note <![CDATA[ ?>', entry(PAGE_A), '<?note ]]> ?>', entry(PAGE_B));
//   two CDATA sections that hold the "<!--" and the "-->" of a comment, with A between them and B after: both are entries.
const ENTRIES_BETWEEN_CDATA = navigation('<![CDATA[ <!-- ]]>', entry(PAGE_A), '<![CDATA[ --> ]]>', entry(PAGE_B));

for (const [route, setup] of PROOF_ROUTES) {
  test(`REAL BUNDLE: ${route}: a processing instruction that holds "<!--" and a CDATA section that holds "-->" and "?>" make no entry of the page they hold — only A is deleted, and B is not proven`, async (t) => {
    const { teardown, writes, retained } = await world(t, { ...setup, xml: DATA_B });
    const result = await teardown();
    assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
    assert.deepStrictEqual(retained, [PAGE_A], 'the SDK\'s own reader finds one page: the CDATA section is text');
    assert.deepStrictEqual(result.deleted.genpage, [PAGE_A]);
    assert.deepStrictEqual(pagesWritten(writes()), [PAGE_A], 'B\'s project row is never written');
    assert.match(result.skipped.join('\n'), notProven(PAGE_B, 'Page B'));
  });

  for (const [what, xml] of [['two processing instructions that hold the markers of a CDATA section', ENTRIES_BETWEEN_MARKERS], ['two CDATA sections that hold the markers of a comment', ENTRIES_BETWEEN_CDATA]]) {
    test(`REAL BUNDLE: ${route}: ${what} hide no entry between them — both pages are entries, and both are deleted, not left behind without the navigation that named them`, async (t) => {
      const { teardown, writes, retained } = await world(t, { ...setup, xml });
      const result = await teardown();
      assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
      assert.deepStrictEqual([...retained].sort(), [PAGE_A, PAGE_B], 'the SDK\'s own reader finds both');
      assert.deepStrictEqual([...(result.deleted.genpage || [])].sort(), [PAGE_A, PAGE_B]);
      assert.deepStrictEqual(pagesWritten(writes()).sort(), [PAGE_A, PAGE_B]);
    });
  }
}

test('REAL BUNDLE: the saved layer of a published app is read the same way — a CDATA section that holds the markers of other constructs proves no page the published navigation does not name', async (t) => {
  const { teardown, writes, retained } = await world(t, { published: true, xml: navigation(entry(PAGE_A)), answer: savedLayer(DATA_B) });
  const result = await teardown();
  assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
  assert.deepStrictEqual(retained, [PAGE_A]);
  assert.deepStrictEqual(result.deleted.genpage, [PAGE_A]);
  assert.deepStrictEqual(pagesWritten(writes()), [PAGE_A]);
  assert.match(result.skipped.join('\n'), notProven(PAGE_B, 'Page B'));
});

test('REAL BUNDLE: the saved layer of a published app that holds entries between processing-instruction markers proves them — the pages that only it names are deleted', async (t) => {
  const { teardown, writes } = await world(t, { published: true, xml: navigation('<SubArea Id="e" Entity="account"/>'), answer: savedLayer(ENTRIES_BETWEEN_MARKERS) });
  const result = await teardown();
  assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
  assert.deepStrictEqual([...(result.deleted.genpage || [])].sort(), [PAGE_A, PAGE_B]);
  assert.deepStrictEqual(pagesWritten(writes()).sort(), [PAGE_A, PAGE_B]);
});

// A document that is not one well-formed XML document is not read at all: no page is proven by it, none is recorded as the app's, nothing is deleted, and the app and its sitemap stay for a re-run. An independent XML parser
// refuses every one of these. The SDK's own reader of the sitemap refuses some of them (two roots, an element that is never closed, a repeated attribute, an unquoted value, an entity that is not declared, a closing tag with
// attributes, a page id that is no GUID) — which is how its app delete found out, after the pages had been recorded — and reads the others (text outside the root, a closing tag out of order, a "<" in a value, a document
// type declaration, a stray "]]>"), for which the plugin's reader is the only check there is.
const PAGES_IN_NAVIGATION = [entry(PAGE_A), entry(PAGE_B)];
const NOT_ONE_DOCUMENT = [
  ['two document roots', `${navigation(entry(PAGE_A))}${navigation(entry(PAGE_B))}`],
  ['text after the root element', `${navigation(...PAGES_IN_NAVIGATION)} trailing <!-- end -->`],
  ['text before the root element', `leading ${navigation(...PAGES_IN_NAVIGATION)}`],
  ['an element that is never closed after the root', `${navigation(...PAGES_IN_NAVIGATION)}<Dangling>`],
  ['a Group that is never closed', `<SiteMap><Area Id="a"><Group Id="g">${PAGES_IN_NAVIGATION.join('')}</Area></SiteMap>`],
  ['a document that ends inside its Group', `<SiteMap><Area Id="a"><Group Id="g">${PAGES_IN_NAVIGATION.join('')}`],
  ['a closing tag out of order', `<SiteMap><Area Id="a"><Group Id="g">${PAGES_IN_NAVIGATION.join('')}</Area></Group></SiteMap>`],
  ['a closing tag with attributes', `<SiteMap><Area Id="a"><Group Id="g">${PAGES_IN_NAVIGATION.join('')}</Group bad="yes"></Area></SiteMap>`],
  ['an unquoted attribute value', navigation(`<SubArea Id=p_a GenPageId="${PAGE_A}"/>`, entry(PAGE_B))],
  ['an entity that is not declared', navigation(`<SubArea Id="p_a" Title="&unknown;" GenPageId="${PAGE_A}"/>`, entry(PAGE_B))],
  ['a "<" inside an attribute value', navigation(`<SubArea Id="p_a" Title="a < b" GenPageId="${PAGE_A}"/>`, entry(PAGE_B))],
  ['an attribute named twice', navigation(`<SubArea Id="p_a" GenPageId="${PAGE_A}" GenPageId='${PAGE_B}'/>`)],
  ['an attribute named twice on an element that is no entry', `<SiteMap><Area Id="a" Id="b"><Group Id="g">${PAGES_IN_NAVIGATION.join('')}</Group></Area></SiteMap>`],
  ['a document type declaration', `<!DOCTYPE SiteMap>${navigation(...PAGES_IN_NAVIGATION)}`],
  ['a single-quoted page id that is no GUID', navigation(entry(PAGE_A), entry('not-a-guid', "'"))],
  ['a "]]>" in character data', navigation(entry(PAGE_A), ' ]]> ', entry(PAGE_B))],
];

for (const [route, setup] of PROOF_ROUTES) {
  for (const [what, xml] of NOT_ONE_DOCUMENT) {
    test(`REAL BUNDLE: ${route}: ${what} — the sitemap is unreadable: nothing is deleted, no page is recorded as the app's, and the app and its sitemap stay`, async (t) => {
      const { org, teardown, writes, records } = await world(t, { ...setup, xml });
      const result = await teardown();
      assert.strictEqual(result.ok, false);
      assert.deepStrictEqual(writes(), [], 'not one write reached the platform');
      assert.deepStrictEqual(records(), [], 'and no page was recorded as one to delete: those records outlive the app, and a retry after the sitemap is repaired would delete on them');
      assert.match(result.errors.map((e) => e.message).join('\n'), /app sitemap unreadable \(.*malformed: /);
      assert.deepStrictEqual([org.state.apps.length, org.state.sitemaps.length], [1, 1]);
    });
  }

  test(`REAL BUNDLE: ${route}: a malformed sitemap that is repaired, and a teardown run again in the same workspace, delete the pages the repaired navigation names — and no page the malformed document named`, async (t) => {
    const w = await world(t, { ...setup, xml: `${navigation(entry(PAGE_A))}${navigation(entry(PAGE_B))}` });
    assert.strictEqual((await w.teardown()).ok, false);
    assert.deepStrictEqual(w.writes(), []);
    assert.deepStrictEqual(w.records(), []);
    w.org.state.sitemaps[0].sitemapxml = navigation(entry(PAGE_A));
    const retry = await w.teardown();
    assert.strictEqual(retry.ok, true, JSON.stringify(retry.errors));
    assert.deepStrictEqual(w.retained, [PAGE_A], 'the SDK\'s own reader sees only A');
    assert.deepStrictEqual(retry.deleted.genpage, [PAGE_A], 'B is in neither the repaired navigation nor any creation record');
    assert.deepStrictEqual(pagesWritten(w.writes()), [PAGE_A]);
    assert.match(retry.skipped.join('\n'), notProven(PAGE_B, 'Page B'));
  });

  // xmldom keeps a tag's attribute names in a plain object, so an attribute named hasOwnProperty followed by another one is an error to it, and the SDK's app delete refuses the document — after this
  // teardown had recorded, from its own reading, the pages to delete. Those records outlived the refusal, and the retry after the sitemap was repaired deleted the page only the bad document named.
  for (const [where, bad] of [
    ['on an entry', navigation(entry(PAGE_A), `<SubArea hasOwnProperty="x" GenPageId="${PAGE_B}"/>`)],
    ['on the Group', navigation(entry(PAGE_A), entry(PAGE_B)).replace('<Group Id="g">', '<Group hasOwnProperty="x" Id="g">')],
  ]) {
    test(`REAL BUNDLE: ${route}: an attribute named hasOwnProperty ${where}, which the SDK's parser cannot read, proves nothing and records nothing — and the retry after the sitemap is repaired deletes only the pages the repaired navigation names`, async (t) => {
      const w = await world(t, { ...setup, xml: bad });
      assert.strictEqual((await w.teardown()).ok, false);
      assert.deepStrictEqual(w.writes(), []);
      assert.deepStrictEqual(w.records(), [], 'no page was recorded as one to delete from a document the SDK cannot read');
      assert.deepStrictEqual([w.org.state.apps.length, w.org.state.sitemaps.length], [1, 1]);
      w.org.state.sitemaps[0].sitemapxml = navigation(entry(PAGE_A));
      const retry = await w.teardown();
      assert.strictEqual(retry.ok, true, JSON.stringify(retry.errors));
      assert.deepStrictEqual(w.retained, [PAGE_A], 'the SDK\'s own reader sees only A');
      assert.deepStrictEqual(retry.deleted.genpage, [PAGE_A], 'B is in neither the repaired navigation nor any record');
      assert.deepStrictEqual(pagesWritten(w.writes()), [PAGE_A]);
    });
  }

  for (const [damage, broken] of [
    ['ends inside its Group', `<SiteMap><Area Id="a"><Group Id="g">${PAGES_IN_NAVIGATION.join('')}`],
    ['has an element that is never closed after its root', `${navigation(...PAGES_IN_NAVIGATION)}<Dangling>`],
  ]) {
    test(`REAL BUNDLE: ${route}: a sitemap that ${damage} is refused with nothing written, and once it is repaired the same workspace's retry deletes both pages and both rows of the app`, async (t) => {
      const w = await world(t, { ...setup, xml: broken });
      assert.strictEqual((await w.teardown()).ok, false);
      assert.deepStrictEqual(w.writes(), []);
      assert.deepStrictEqual(w.records(), []);
      assert.deepStrictEqual([w.org.state.apps.length, w.org.state.sitemaps.length], [1, 1]);
      w.org.state.sitemaps[0].sitemapxml = navigation(...PAGES_IN_NAVIGATION);
      const retry = await w.teardown();
      assert.strictEqual(retry.ok, true, JSON.stringify(retry.errors));
      assert.deepStrictEqual([...retry.deleted.genpage].sort(), [PAGE_A, PAGE_B]);
      assert.deepStrictEqual([w.org.state.apps.length, w.org.state.sitemaps.length], [0, 0]);
      assert.deepStrictEqual(w.records(), [], 'the records are consumed once the pages are deleted');
    });
  }
}

test('REAL BUNDLE: the saved layer of a published app that is not one well-formed document proves nothing, is reported as unreadable and keeps the page it alone names — and records nothing for it', async (t) => {
  const { org, teardown, writes, records } = await world(t, { published: true, xml: navigation(entry(PAGE_A)), answer: savedLayer(`${navigation(entry(PAGE_A))}${navigation(entry(PAGE_B))}`) });
  const result = await teardown();
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(writes(), []);
  assert.deepStrictEqual(records(), []);
  assert.match(result.errors.map((e) => e.message).join('\n'), new RegExp(`page ${PAGE_B}: cannot be proven or ruled out while the app's saved but unpublished navigation is unreadable \\(malformed: `));
  assert.deepStrictEqual([org.state.apps.length, org.state.sitemaps.length], [1, 1]);
});

// Ordinary documents are read as they always were. Each of these is well-formed XML that the platform, the SDK's designer or an XML library may write: an XML declaration, a byte order mark, other line ends, spacing and
// attribute order that differ, namespace declarations, areas and groups with nothing in them, children of an entry, a ">" in a title, a page id spelled with character references, and comments, processing instructions and
// CDATA sections between the entries.
const ORDINARY = [
  ['an XML declaration, a byte order mark and CRLF line ends', `\uFEFF<?xml version="1.0" encoding="utf-8"?>\r\n${navigation(...PAGES_IN_NAVIGATION)}`],
  ['spaces around "=", tabs and new lines in tags, either quote style, and closing tags with a space', `<SiteMap >\n<Area Id = 'a'>\n<Group Id = 'g'><SubArea\r\n Title = 'A &amp; B &lt; C &gt; D &quot; E &apos; F'\tGenPageId = '${PAGE_A}' Id = 'a'></SubArea>\n<SubArea GenPageId = "${PAGE_B}" Id="b" /></Group ></Area ></SiteMap >`],
  ['namespace declarations', navigation(...PAGES_IN_NAVIGATION).replace('<SiteMap>', '<SiteMap xmlns="" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xml:space="preserve">')],
  ['areas and groups with nothing in them, and several of each', `<SiteMap><Area/><Area Id="a"><Titles><Title LCID="1033" Title="A"/></Titles><Group/><Group Id="g">${entry(PAGE_A)}</Group><Group Id="h">${entry(PAGE_B)}</Group></Area><Area Id="c"><Group/></Area></SiteMap>`],
  ['entries with children', navigation(`<SubArea Id="a" GenPageId="${PAGE_A}" Client="Web" Sku="All" AvailableOffline="true"><Titles><Title LCID="1033" Title="Page"/></Titles><Descriptions><Description LCID="1033" Description="A &amp; B"/></Descriptions><Privilege Entity="account" Privilege="Read"/><IsVisible><Or><Privilege Entity="account" Privilege="Read"/></Or></IsVisible></SubArea>`, entry(PAGE_B))],
  ['a ">" in a title', navigation(`<SubArea GenPageId="${PAGE_A}" Title="A > B" Id="a"/>`, entry(PAGE_B))],
  ['page ids spelled with character references, in single quotes', navigation(`<SubArea Id="a" GenPageId='&#49;${PAGE_A.slice(1)}'/>`, `<SubArea Id="b" GenPageId='${PAGE_B.replace('-', '&#x2d;')}'/>`)],
  ['comments, processing instructions and CDATA sections between the entries, and around the root', `<!-- before --><?before data?>${navigation(entry(PAGE_A), '<?note data?> <!-- harmless --> <![CDATA[ignored]]>', entry(PAGE_B))}<!-- after --><?after data?>\n`],
];
for (const [route, setup] of PROOF_ROUTES) {
  for (const [what, xml] of ORDINARY) {
    test(`REAL BUNDLE: ${route}: ${what} — read as it was: both pages are entries, and both are deleted`, async (t) => {
      const { teardown, writes, retained } = await world(t, { ...setup, xml });
      const result = await teardown();
      assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
      assert.deepStrictEqual([...retained].sort(), [PAGE_A, PAGE_B], 'the SDK\'s own reader finds both');
      assert.deepStrictEqual([...(result.deleted.genpage || [])].sort(), [PAGE_A, PAGE_B]);
      assert.deepStrictEqual(pagesWritten(writes()).sort(), [PAGE_A, PAGE_B]);
    });
  }
}

// A published app costs exactly what it cost before: the same reads, in the same order, and the same writes — its sitemap is read in the published layer, and in the saved layer only for a page the published one does not
// name, and a saved layer that cannot be read is tried again by the client and then reported. The three sequences are in golden/teardown-published-requests.txt (one section each, `METHOD path`, a `$batch` change set
// taken apart). They were recorded from the teardown as it ran before the proof of a page was changed to read the entries of the navigation, so an extra look, or a lookup that is not needed, makes this fail. A teardown of
// an app that was never published is the one that grew a read: its saved layer.
const requestLog = (org) => org.requests.map((r) => (r.operations ? `${r.method} ${r.path} [${r.operations.map((op) => `${op.method} ${op.path}`).join(', ')}]` : `${r.method} ${r.path}`));
const REFUSED_SAVED_LAYER = (req) => (req.method === 'GET' && req.path.startsWith('/sitemaps/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple')
  ? json(503, { error: { message: 'Offline refusal' } }) : null);
const PUBLISHED_SCENARIOS = [
  ['its published navigation names both pages', { published: true }, { requests: 32, ok: true }],
  ['its published navigation names one page and its saved navigation, which is read for the other, names both', { published: true, xml: navigation(entry(PAGE_A)), answer: savedLayer(navigation(entry(PAGE_A), entry(PAGE_B))) }, { requests: 36, ok: true }],
  ['its published navigation names one page and its saved navigation cannot be read', { published: true, xml: navigation(entry(PAGE_A)), answer: REFUSED_SAVED_LAYER }, { requests: 18, ok: false }],
];

test('REAL BUNDLE: the requests a teardown of a published app makes — the reads of its sitemap in both layers, and every write — are exactly the ones it made before', async (t) => {
  const sections = [];
  for (const [what, options, expected] of PUBLISHED_SCENARIOS) {
    const w = await world(t, options);
    const result = await w.teardown();
    assert.strictEqual(result.ok, expected.ok, `${what}: ${JSON.stringify(result.errors)}`);
    assert.deepStrictEqual(w.org.unexpected, [], `${what}: the fake org knew every request`);
    const log = requestLog(w.org);
    assert.strictEqual(log.length, expected.requests, what);
    sections.push(`## ${what} (${log.length} requests)\n${log.join('\n')}`);
  }
  assertGolden('teardown-published-requests.txt', `${sections.join('\n\n')}\n`);
});
