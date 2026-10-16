'use strict';
// Logic tests of lib/genpage-sdk.js — the reads (the environment's pages, an app's navigation, one page) and the placement of pages into an
// app — against the in-memory stand-in for the SDK (helpers/fake-genpage-sdk.js). The write paths are in genpage-sdk.test.js.
const { test } = require('node:test');
const assert = require('node:assert');
const { makeGenpageSdk, entityTablesOfSiteMap } = require('../lib/genpage-sdk.js');
const { genPageSubArea, genPageSubAreaId } = require('../lib/genpage-subarea.js');
const { FakeSdk, sdkError } = require('./helpers/fake-genpage-sdk.js');

const ENV = 'https://contoso.crm.dynamics.com';
const APP = '22222222-0000-4000-8000-0000000000bb';
const P1 = '11111111-0000-4000-8000-000000000001';
const P2 = '11111111-0000-4000-8000-000000000002';
const P3 = '11111111-0000-4000-8000-000000000003';
const LAYER = '33333333-0000-4000-8000-0000000000cc';
const V_ACCOUNT = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const V_CONTACT = 'aaaaaaaa-0000-4000-8000-0000000000a2';
const V_HELD = 'bbbbbbbb-0000-4000-8000-0000000000b1';
const backend = (sdk, deps = {}) => makeGenpageSdk(ENV, { sdk, ...deps });

// ── enumerateEnv ─────────────────────────────────────────────────────────────────────────────────────────────────

test('enumerateEnv: every page of the environment, drafts included, ids lower-cased, names exactly as stored', async () => {
  const sdk = new FakeSdk()
    .seedPage({ id: 'AAAAAAAA-0000-4000-8000-000000000001', name: 'Overview', source: 'a' })
    .seedPage({ id: P2, name: 'Say \\"hi\\"', source: 'b' });
  const out = await backend(sdk).enumerateEnv();
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(out.ids, ['aaaaaaaa-0000-4000-8000-000000000001', P2], 'lower-cased, for case-insensitive set membership');
  assert.deepStrictEqual(out.pages, [
    { pageId: 'AAAAAAAA-0000-4000-8000-000000000001', name: 'Overview' },
    { pageId: P2, name: 'Say \\"hi\\"' },
  ], 'the name as the page\'s row holds it — a caller reading a page an earlier release made unescapes it');
  assert.deepStrictEqual(sdk.of('fetchArtifactList').map((c) => c.args), [['genPage']]);
});

test('enumerateEnv: a listing that cannot be read is { ok: false }, never an empty environment', async () => {
  const sdk = new FakeSdk().script('list', new Error('HTTP 503'));
  const out = await backend(sdk).enumerateEnv();
  assert.strictEqual(out.ok, false);
  assert.deepStrictEqual(out.ids, []);
  assert.match(out.error, /could not list the environment's generative pages: HTTP 503/);
});

// ── enumeratePages ───────────────────────────────────────────────────────────────────────────────────────────────

const navApp = () => ({
  id: APP, name: 'App',
  siteMap: { areas: [{ id: 'a', title: 'Main', groups: [{ id: 'g', title: 'G', subAreas: [
    { id: 's0', type: 'Entity', entity: 'account', title: 'Accounts' },
    { id: 's1', type: 'GenPage', genPageId: P1, title: 'One' },
    { id: 's2', type: 'GenPage', genPageId: P1.toUpperCase(), title: 'One in a second place' },
    { id: 's3', type: 'GenPage', genPageId: P2, title: 'Two' },
  ] }] }] },
});

test('enumeratePages (saved layer): the pages the app\'s SAVED navigation names, once each, titled as the navigation titles them', async () => {
  const sdk = new FakeSdk().seedApp(navApp());
  const out = await backend(sdk).enumeratePages(APP, { includeUnpublished: true });
  assert.deepStrictEqual(out, { ok: true, pages: [{ pageId: P1, name: 'One' }, { pageId: P2, name: 'Two' }], empty: false });
  assert.deepStrictEqual(sdk.of('fetchArtifact')[0].args, ['app', APP, { overwrite: true }], 'the server\'s copy, not a working copy');
});

test('enumeratePages (saved layer): an app whose navigation names no page is { ok: true, empty: true }', async () => {
  const sdk = new FakeSdk().seedApp({ id: APP, siteMap: { areas: [{ id: 'a', groups: [{ id: 'g', subAreas: [{ type: 'Entity', entity: 'account', title: 'A' }] }] }] } });
  assert.deepStrictEqual(await backend(sdk).enumeratePages(APP, { includeUnpublished: true }), { ok: true, pages: [], empty: true });
});

test('enumeratePages: an id that is not an app id and an app that cannot be read are { ok: false } with the reason', async () => {
  assert.deepStrictEqual(await backend(new FakeSdk()).enumeratePages('nope'), { ok: false, pages: [], error: "'nope' is not an app id" });
  const out = await backend(new FakeSdk()).enumeratePages(APP, { includeUnpublished: true });
  assert.strictEqual(out.ok, false);
  assert.match(out.error, new RegExp(`could not read the navigation of app ${APP}: .*not found`));
});

const publishedRecords = (xml, { app = [{ uniquename: 'contoso_app' }], sitemap } = {}) => ({
  appmodule: (o) => (/^appmoduleid eq /.test(o.filter) ? app : [{ appmoduleid: APP, appmoduleidunique: LAYER }]),
  appmodulecomponent: () => [{ objectid: '44444444-0000-4000-8000-0000000000dd', componenttype: 62 }],
  sitemap: () => (sitemap !== undefined ? sitemap : [{ sitemapxml: xml }]),
});

test('enumeratePages (published layer): the app\'s PUBLISHED navigation — appmodule, its sitemap component, the sitemap XML — with entity-decoded titles', async () => {
  const xml = `<SiteMap><Area Id="a"><Group Id="g"><SubArea Id="s1" GenPageId="${P1}" Title="One &amp; Two"/><SubArea Id="s2" Entity="account"/><SubArea Id="s3" GenPageId="${P2}" Title="Two"/></Group></Area></SiteMap>`;
  const sdk = new FakeSdk({ records: publishedRecords(xml) });
  const out = await backend(sdk).enumeratePages(APP);
  assert.deepStrictEqual(out, { ok: true, pages: [{ pageId: P1, name: 'One & Two' }, { pageId: P2, name: 'Two' }], empty: false });
  assert.strictEqual(sdk.count('fetchArtifact'), 0, 'the saved layer is not read');
});

test('enumeratePages (published layer): an app that was never published says so, and an unreadable sitemap is a failure — neither is an empty app', async () => {
  const never = new FakeSdk({ records: publishedRecords('', { app: [] }) });
  const a = await backend(never).enumeratePages(APP);
  assert.strictEqual(a.ok, false);
  assert.match(a.error, /has no published form — it was never published, or does not exist/);

  const unreadable = new FakeSdk({ records: publishedRecords('', { sitemap: [] }) });
  const b = await backend(unreadable).enumeratePages(APP);
  assert.strictEqual(b.ok, false);
  assert.match(b.error, /could not read the published navigation of app .*sitemap-xml-unreadable/);

  const empty = new FakeSdk({ records: publishedRecords('<SiteMap><Area Id="a"><Group Id="g"/></Area></SiteMap>') });
  assert.deepStrictEqual(await backend(empty).enumeratePages(APP), { ok: true, pages: [], empty: true });
});

// ── read ─────────────────────────────────────────────────────────────────────────────────────────────────────────

test('read: the page as the SDK projects it, fetched from the SERVER — a working copy holding unpushed edits cannot answer', async () => {
  const sdk = new FakeSdk().seedPage({ id: P1, name: 'One', source: 'server source', dataSources: ['account'] });
  await sdk.fetchArtifact('genPage', P1);
  sdk.local.get(`genPage:${P1}`).source = 'unpushed local edit';
  const page = await backend(sdk).read(P1.toUpperCase());
  assert.strictEqual(page.source, 'server source');
  assert.deepStrictEqual(sdk.of('fetchArtifact').pop().args, ['genPage', P1.toUpperCase(), { overwrite: true }]);
});

test('read: a page that is not there, one that cannot be read, a raw-file page and a bad id each fail with their own code — never an empty source', async () => {
  await assert.rejects(backend(new FakeSdk()).read(P1), (e) => e.code === 'GENPAGE_NOT_FOUND' && /does not exist in this environment/.test(e.message) && e.transient === false);
  const unreadable = new FakeSdk().seedPage({ id: P1, name: 'One', source: 's' }).script('fetch', new Error('HTTP 500'));
  await assert.rejects(backend(unreadable).read(P1), (e) => e.code === 'GENPAGE_UNREADABLE' && /HTTP 500/.test(e.message));
  const raw = new FakeSdk().seedPage({ id: P1, name: 'Hand made', source: undefined });
  await assert.rejects(backend(raw).read(P1), (e) => e.code === 'GENPAGE_NO_SOURCE' && /held as raw files/.test(e.message) && /Hand made/.test(e.message));
  await assert.rejects(backend(new FakeSdk()).read('../etc'), (e) => e.code === 'GENPAGE_ID_INVALID');
});

// ── placeInApp ───────────────────────────────────────────────────────────────────────────────────────────────────

const appArtifact = (over = {}) => ({
  id: APP, name: 'App',
  siteMap: { areas: [{ id: 'area_1', title: 'Main', groups: [{ id: 'group_1', title: 'Records', subAreas: [{ id: 'sub_1', type: 'Entity', entity: 'account', title: 'Accounts' }] }] }] },
  ...over,
});
const layerGet = async (url) => (/RetrieveUnpublishedMultiple/.test(url)
  ? { status: 200, body: { value: [{ appmoduleid: APP, appmoduleidunique: LAYER, componentstate: 0 }] } }
  : { status: 404, body: null });
const placing = (app, records = {}) => new FakeSdk({ records, onGet: layerGet }).seedApp(app);
const subAreaFor = (pageId, title) => genPageSubArea({ id: genPageSubAreaId(pageId), title }, pageId);

test('placeInApp: a page becomes a sub-area of the shape the build writes — in the first group of the first area when no group holds a page yet — then the app is pushed and published', async () => {
  const sdk = placing(appArtifact());
  const out = await backend(sdk).placeInApp(APP, { pages: [{ pageId: P1, title: 'Overview' }] });
  assert.deepStrictEqual(out, { added: [P1], alreadyPlaced: [], pinnedViews: [], warnings: [], appEdited: true });
  assert.deepStrictEqual(sdk.of('updateElement').map((c) => c.args), [['app', APP, '/siteMap/areas/0/groups/0/subAreas', [
    { id: 'sub_1', type: 'Entity', entity: 'account', title: 'Accounts' },
    { id: `genpage_${P1.replace(/-/g, '')}`, title: 'Overview', type: 'GenPage', genPageId: P1 },
  ]]]);
  assert.deepStrictEqual(sdk.apps.get(APP).siteMap.areas[0].groups[0].subAreas[1], subAreaFor(P1, 'Overview'));
  assert.deepStrictEqual(sdk.of('pushArtifact').map((c) => c.args), [['app', APP]]);
  assert.deepStrictEqual(sdk.of('publishArtifact').map((c) => c.args), [['app', APP, undefined]]);
});

test('placeInApp: the page goes in the first group that ALREADY holds a page', async () => {
  const app = appArtifact();
  app.siteMap.areas[0].groups.push({ id: 'group_2', title: 'Pages', subAreas: [{ id: 'sub_p0', type: 'GenPage', genPageId: P3, title: 'Existing' }] });
  const sdk = placing(app);
  await backend(sdk).placeInApp(APP, { pages: [{ pageId: P1, title: 'New' }] });
  const [call] = sdk.of('updateElement');
  assert.strictEqual(call.args[2], '/siteMap/areas/0/groups/1/subAreas');
  assert.deepStrictEqual(call.args[3].map((s) => s.id), ['sub_p0', genPageSubAreaId(P1)], 'appended after the page that was there');
});

test('placeInApp: a group with no subAreas array gets one; an app with no area gets one — the SDK refuses a navigation without an area that holds a group', async () => {
  const bare = placing({ id: APP, name: 'App', siteMap: { areas: [{ id: 'area_1', title: 'Main', groups: [{ id: 'group_1', title: 'Records' }] }] } });
  await backend(bare).placeInApp(APP, { pages: [{ pageId: P1, title: 'One' }] });
  assert.deepStrictEqual(bare.of('addElement').map((c) => c.args), [['app', APP, '/siteMap/areas/0/groups/0', { subAreas: [subAreaFor(P1, 'One')] }]]);

  const noArea = placing({ id: APP, name: 'App', siteMap: { areas: [] } });
  await backend(noArea).placeInApp(APP, { pages: [{ pageId: P1, title: 'One' }] });
  assert.deepStrictEqual(noArea.of('updateElement').map((c) => c.args), [['app', APP, '/siteMap/areas', [
    { id: 'area_genpages', title: 'Pages', groups: [{ id: 'group_genpages', title: 'Pages', subAreas: [subAreaFor(P1, 'One')] }] },
  ]]]);

  const noMap = placing({ id: APP, name: 'App' });
  await backend(noMap).placeInApp(APP, { pages: [{ pageId: P1, title: 'One' }] });
  assert.deepStrictEqual(noMap.of('addElement').map((c) => c.args), [['app', APP, '', { siteMap: { areas: [
    { id: 'area_genpages', title: 'Pages', groups: [{ id: 'group_genpages', title: 'Pages', subAreas: [subAreaFor(P1, 'One')] }] },
  ] } }]]);
});

test('placeInApp: a page the navigation already names (any case) is left alone — when nothing is missing, nothing is written, not even a push', async () => {
  const app = appArtifact();
  app.siteMap.areas[0].groups[0].subAreas.push({ id: 'sub_p', type: 'GenPage', genPageId: P1, title: 'Overview' });
  const sdk = placing(app);
  const out = await backend(sdk).placeInApp(APP, { pages: [{ pageId: P1.toUpperCase(), title: 'Overview' }] });
  assert.deepStrictEqual(out, { added: [], alreadyPlaced: [P1.toUpperCase()], pinnedViews: [], warnings: [], appEdited: false });
  assert.strictEqual(sdk.count('updateElement') + sdk.count('addElement') + sdk.count('pushArtifact') + sdk.count('publishArtifact'), 0);
});

test('placeInApp: several pages are ONE edit, one push and one publish; a page without a title is titled by its name, else "Generative page"', async () => {
  const sdk = placing(appArtifact());
  const out = await backend(sdk).placeInApp(APP, { pages: [{ pageId: P1, title: 'One' }, { pageId: P2, name: 'Named' }, { pageId: P3 }] });
  assert.deepStrictEqual(out.added, [P1, P2, P3]);
  assert.strictEqual(sdk.count('updateElement'), 1);
  assert.strictEqual(sdk.count('pushArtifact'), 1);
  assert.strictEqual(sdk.count('publishArtifact'), 1);
  assert.deepStrictEqual(sdk.apps.get(APP).siteMap.areas[0].groups[0].subAreas.slice(1).map((s) => s.title), ['One', 'Named', 'Generative page']);
});

test('placeInApp: an app that cannot be read, a push that is not saved, and a publish that fails each throw — the failed publish says the navigation WAS saved', async () => {
  await assert.rejects(backend(new FakeSdk()).placeInApp(APP, { pages: [{ pageId: P1 }] }), (e) => /cannot read app .* to place pages in it/.test(e.message) && e.transient === false);
  await assert.rejects(backend(new FakeSdk()).placeInApp('nope', { pages: [{ pageId: P1 }] }), (e) => e.code === 'GENPAGE_ID_INVALID');

  const refused = placing(appArtifact()).script('push', { report: { saved: false, error: sdkError('VALIDATION_ERROR', 'SiteMap needs a non-empty Area with a non-empty Group') } });
  await assert.rejects(backend(refused).placeInApp(APP, { pages: [{ pageId: P1 }] }), (e) => e.code === 'VALIDATION_ERROR' && /app .* was not changed: SiteMap needs a non-empty Area/.test(e.message));
  assert.strictEqual(refused.count('publishArtifact'), 0);

  const unpublished = placing(appArtifact()).script('publish', { publish: { kind: 'failed', error: new Error('PublishXml refused') } });
  await assert.rejects(backend(unpublished).placeInApp(APP, { pages: [{ pageId: P1 }] }), (e) => {
    assert.strictEqual(e.code, 'GENPAGE_APP_PUBLISH_FAILED');
    assert.strictEqual(e.saved, true);
    assert.deepStrictEqual([e.appId, e.pageId, e.pageIds], [APP, P1, undefined], 'the failure says which app and which page — a caller that prints it can go on from it');
    assert.match(e.message, /saved, but publishing the app failed \(PublishXml refused\)/);
    return true;
  });
  const several = placing(appArtifact()).script('publish', { publish: { kind: 'failed', error: new Error('PublishXml refused') } });
  await assert.rejects(backend(several).placeInApp(APP, { pages: [{ pageId: P1 }, { pageId: P2 }] }), (e) => e.appId === APP && e.pageId === undefined && JSON.stringify(e.pageIds) === JSON.stringify([P1, P2]));
});

// What a failed publish says was SAVED is what this call saved: the navigation when it added a page (or finished a placement an earlier run saved), the default views of the tables when it pinned any —
// and a call that only pinned views, for a page the navigation already names, has not touched the navigation.
test('placeInApp: a publish that fails says what was saved — views only is not "the navigation" — and the unproven publish carries the ids too', async () => {
  const placed = appArtifact();
  placed.siteMap.areas[0].groups[0].subAreas.push({ id: 'sub_p', type: 'GenPage', genPageId: P1, title: 'Overview' });
  const refuse = (sdk) => sdk.script('publish', { publish: { kind: 'failed', error: new Error('PublishXml refused') } });

  const viewsOnly = refuse(placing(placed, viewRecords()));
  await assert.rejects(backend(viewsOnly).placeInApp(APP, { pages: [{ pageId: P1, title: 'Overview' }], dataSources: ['account'] }), (e) => {
    assert.strictEqual(e.code, 'GENPAGE_APP_PUBLISH_FAILED');
    assert.match(e.message, new RegExp(`^the default views of the tables the pages read were saved in app ${APP}, but publishing the app failed \\(PublishXml refused\\) — they take effect once the app is published$`));
    assert.doesNotMatch(e.message, /navigation/, 'the navigation was not touched');
    assert.deepStrictEqual([e.saved, e.appId, e.pageId], [true, APP, P1]);
    return true;
  });

  const both = refuse(placing(appArtifact(), viewRecords()));
  await assert.rejects(backend(both).placeInApp(APP, { pages: [{ pageId: P1, title: 'Overview' }], dataSources: ['account'] }), (e) => e.code === 'GENPAGE_APP_PUBLISH_FAILED'
    && new RegExp(`^the navigation of app ${APP} and the default views of the tables the pages read were saved, but publishing the app failed \\(PublishXml refused\\) — the pages are in the app's saved navigation and show once it is published$`).test(e.message));

  const navigationOnly = refuse(placing(appArtifact()));
  await assert.rejects(backend(navigationOnly).placeInApp(APP, { pages: [{ pageId: P1, title: 'Overview' }] }), (e) => new RegExp(`^the navigation of app ${APP} was saved, but publishing the app failed \\(PublishXml refused\\) — the pages are in the app's saved navigation`).test(e.message));

  const slow = savedButUnpublished({ takesEffect: false });
  await assert.rejects(backend(slow.sdk).placeInApp(APP, { pages: [{ pageId: P1, title: 'Overview' }], finish: true }), (e) => e.code === 'GENPAGE_APP_PUBLISH_UNPROVEN' && e.appId === APP && e.pageId === P1);
});

// ── placeInApp: completing a placement an earlier run began (`finish`) ──────────────────────────────────────────────────────────────
// A run that SAVED the app's navigation and could not publish the app leaves the page in the app's saved navigation and out of the one that runs. Placing it again finds
// it there, has nothing to write — and, without `finish`, answered as if there were nothing to do. A completion has to publish the app and see the page in what runs.
const navXml = (...ids) => `<SiteMap><Area Id="a"><Group Id="g">${ids.map((id) => `<SubArea Id="s${id.slice(-3)}" GenPageId="${id}"/>`).join('')}</Group></Area></SiteMap>`;
// An app whose SAVED navigation names P1 and whose PUBLISHED navigation does not — until the app is published, which copies the one to the other as PublishXml does
// (`takesEffect: false`: a publish the service accepted and the published navigation has not caught up with).
function savedButUnpublished({ takesEffect = true, records } = {}) {
  const app = appArtifact();
  app.siteMap.areas[0].groups[0].subAreas.push({ id: 'sub_p', type: 'GenPage', genPageId: P1, title: 'Overview' });
  const published = { xml: navXml() };
  const sdk = new FakeSdk({ records: records || { ...publishedRecords(''), sitemap: () => [{ sitemapxml: published.xml }] }, onGet: layerGet }).seedApp(app);
  const publishArtifact = sdk.publishArtifact.bind(sdk);
  sdk.publishArtifact = async (type, id, options) => {
    const answer = await publishArtifact(type, id, options);
    if (type === 'app' && takesEffect && !(answer && answer.publish && answer.publish.kind === 'failed')) published.xml = navXml(P1);
    return answer;
  };
  return { sdk, published };
}

test('placeInApp finish: a page the SAVED navigation already names is published again and seen in the PUBLISHED navigation — nothing is written, and it says it proved it', async () => {
  const { sdk, published } = savedButUnpublished();
  const out = await backend(sdk).placeInApp(APP, { pages: [{ pageId: P1, title: 'Overview' }], finish: true });
  assert.deepStrictEqual(out, { added: [], alreadyPlaced: [P1], pinnedViews: [], warnings: [], appEdited: false, provedPublished: true });
  assert.deepStrictEqual(sdk.of('publishArtifact').map((c) => c.args), [['app', APP, undefined]], 'the app is published');
  assert.strictEqual(sdk.count('pushArtifact') + sdk.count('updateElement') + sdk.count('addElement'), 0, 'and nothing was written: the placement was saved already');
  assert.ok(published.xml.includes(P1), 'the page is in what runs');
});

test('placeInApp without finish: the same state is an ordinary placement with nothing to do — nothing is written and nothing is published', async () => {
  const { sdk, published } = savedButUnpublished();
  const out = await backend(sdk).placeInApp(APP, { pages: [{ pageId: P1, title: 'Overview' }] });
  assert.deepStrictEqual(out, { added: [], alreadyPlaced: [P1], pinnedViews: [], warnings: [], appEdited: false });
  assert.strictEqual(sdk.count('publishArtifact') + sdk.count('pushArtifact') + sdk.count('updateElement') + sdk.count('addElement'), 0);
  assert.ok(!published.xml.includes(P1), 'it is what it was');
});

test('placeInApp finish: an app publish that took no effect is not a finished placement — it says the placement is saved, names the page, and proves nothing', async () => {
  const { sdk } = savedButUnpublished({ takesEffect: false });
  await assert.rejects(backend(sdk).placeInApp(APP, { pages: [{ pageId: P1, title: 'Overview' }], finish: true }), (e) => {
    assert.strictEqual(e.code, 'GENPAGE_APP_PUBLISH_UNPROVEN');
    assert.strictEqual(e.saved, true);
    assert.strictEqual(e.transient, false);
    assert.match(e.message, new RegExp(`app ${APP} was published, but its published navigation does not show page ${P1} yet \\(it is not listed\\)`));
    assert.match(e.message, /Run the same command again/);
    return true;
  });
  assert.strictEqual(sdk.count('publishArtifact'), 1, 'the app was published');
});

test('placeInApp finish: a published navigation that cannot be read contradicts nothing — the app WAS published, so it answers with a warning and says it proved nothing — and a publish that fails is the failure it always was, with nothing read back', async () => {
  const unreadable = savedButUnpublished({ records: { ...publishedRecords(''), sitemap: () => [] } });
  const out = await backend(unreadable.sdk).placeInApp(APP, { pages: [{ pageId: P1 }], finish: true });
  assert.strictEqual(out.provedPublished, false);
  assert.strictEqual(out.appEdited, false);
  assert.strictEqual(unreadable.sdk.count('publishArtifact'), 1, 'the app was published');
  assert.strictEqual(out.warnings.length, 1);
  assert.match(out.warnings[0], new RegExp(`app ${APP} was published again, but its published navigation could not be read back to confirm that the page shows \\(.*sitemap-xml-unreadable.*\\) — treat it as live only once seen to be`));

  const failing = savedButUnpublished();
  failing.sdk.script('publish', { publish: { kind: 'failed', error: new Error('PublishXml refused') } });
  await assert.rejects(backend(failing.sdk).placeInApp(APP, { pages: [{ pageId: P1 }], finish: true }), (e) => e.code === 'GENPAGE_APP_PUBLISH_FAILED' && e.saved === true && /PublishXml refused/.test(e.message)
    && new RegExp(`^the navigation of app ${APP} was saved, but publishing the app failed`).test(e.message), 'a placement saved earlier and finished now: what is left unpublished is the navigation, though nothing was edited');
  assert.strictEqual(failing.sdk.of('queryRecords').filter((c) => c.args[0] === 'appmodule').length, 0, 'a publish that failed proves nothing and is not read back');
});

test('placeInApp finish: a page the saved navigation does not hold yet is added, pushed and published as any placement is — and proved like a completion', async () => {
  const app = appArtifact();
  const published = { xml: navXml() };
  const sdk = new FakeSdk({ records: { ...publishedRecords(''), sitemap: () => [{ sitemapxml: published.xml }] }, onGet: layerGet }).seedApp(app);
  const publishArtifact = sdk.publishArtifact.bind(sdk);
  sdk.publishArtifact = async (type, id, options) => { const answer = await publishArtifact(type, id, options); published.xml = navXml(P1); return answer; };
  const out = await backend(sdk).placeInApp(APP, { pages: [{ pageId: P1, title: 'Overview' }], finish: true });
  assert.deepStrictEqual([out.added, out.alreadyPlaced, out.appEdited, out.provedPublished], [[P1], [], true, true]);
  assert.deepStrictEqual([sdk.count('updateElement'), sdk.count('pushArtifact'), sdk.count('publishArtifact')], [1, 1, 1]);
});

test('placeInApp: the sitemap title language is the SDK\'s construction-time option — one SDK per language, made on first use, and the default language for every other operation', async () => {
  const made = [];
  const sdk = placing(appArtifact()).seedPage({ id: P2, name: 'Two', source: 's' });
  const genpage = makeGenpageSdk(ENV, { createSdk: async (options) => { made.push(options.languageCode); return sdk; } });
  await genpage.placeInApp(APP, { pages: [{ pageId: P1, title: 'Eins' }], languageCode: 1031 });
  await genpage.enumerateEnv();
  await genpage.placeInApp(APP, { pages: [{ pageId: P3, title: 'Drei' }], languageCode: 1031 });
  assert.deepStrictEqual(made, [1031, undefined], 'one SDK for 1031 (reused), one with the SDK\'s own language');

  const defaulted = [];
  const other = makeGenpageSdk(ENV, { languageCode: 1036, createSdk: async (options) => { defaulted.push(options.languageCode); return placing(appArtifact()); } });
  await other.placeInApp(APP, { pages: [{ pageId: P1, title: 'Un' }] });
  assert.deepStrictEqual(defaulted, [1036], 'deps.languageCode applies when the call names none');
});

// ── placeInApp: pinning the default views ───────────────────────────────────────────────────────────────────────

const viewRecords = ({ held = [], views = { account: V_ACCOUNT, contact: V_CONTACT } } = {}) => ({
  savedquery: (o) => {
    const table = /returnedtypecode eq '([^']+)'/.exec(o.filter)[1];
    return views[table] ? [{ savedqueryid: views[table].toUpperCase() }] : [];
  },
  appmodulecomponent: () => held.map((objectid) => ({ objectid: `{${objectid}}`, componenttype: 26 })),
});

test('pinning: the default public view of each data source joins the app\'s components, and the app is pushed and published', async () => {
  const sdk = placing(appArtifact(), viewRecords());
  const out = await backend(sdk).placeInApp(APP, { pages: [], dataSources: ['account', 'Contact', 'ACCOUNT'] });
  assert.deepStrictEqual(out.pinnedViews, [V_ACCOUNT, V_CONTACT], 'lower-cased, each table once');
  assert.deepStrictEqual(out.added, []);
  assert.deepStrictEqual(sdk.of('addElement').map((c) => c.args), [['app', APP, '', { components: { views: [V_ACCOUNT, V_CONTACT] } }]]);
  assert.strictEqual(sdk.count('pushArtifact'), 1);
  assert.strictEqual(sdk.count('publishArtifact'), 1);
  const asked = sdk.of('queryRecords').filter((c) => c.args[0] === 'savedquery').map((c) => c.args[1].filter);
  assert.deepStrictEqual(asked, [
    "returnedtypecode eq 'account' and querytype eq 0 and isdefault eq true",
    "returnedtypecode eq 'contact' and querytype eq 0 and isdefault eq true",
  ], 'a PUBLIC (querytype 0) view that is the table\'s DEFAULT');
});

test('pinning: a view the app\'s CURRENT layer already holds is not pinned again — and when nothing is missing nothing is written', async () => {
  const sdk = placing(appArtifact(), viewRecords({ held: [V_ACCOUNT] }));
  const out = await backend(sdk).placeInApp(APP, { pages: [], dataSources: ['account'] });
  assert.deepStrictEqual(out, { added: [], alreadyPlaced: [], pinnedViews: [], warnings: [], appEdited: false });
  assert.strictEqual(sdk.count('pushArtifact'), 0);
  const asked = sdk.of('queryRecords').find((c) => c.args[0] === 'appmodulecomponent').args[1].filter;
  assert.ok(asked.includes(`_appmoduleidunique_value eq ${LAYER}`) && asked.includes('componenttype eq 26'), 'membership is read from the layer an edit would change');
});

test('pinning: the page and its tables\' views are ONE app edit — one push, one publish', async () => {
  const sdk = placing(appArtifact(), viewRecords({ held: [V_HELD] }));
  const out = await backend(sdk).placeInApp(APP, { pages: [{ pageId: P1, title: 'One' }], dataSources: 'account' });
  assert.deepStrictEqual(out.added, [P1]);
  assert.deepStrictEqual(out.pinnedViews, [V_ACCOUNT]);
  assert.strictEqual(sdk.count('pushArtifact'), 1);
  assert.strictEqual(sdk.count('publishArtifact'), 1);
});

test('pinning: a table with no default public view is a warning, never a refusal', async () => {
  const sdk = placing(appArtifact(), viewRecords({ views: { account: V_ACCOUNT } }));
  const out = await backend(sdk).placeInApp(APP, { pages: [], dataSources: ['account', 'contact'] });
  assert.deepStrictEqual(out.pinnedViews, [V_ACCOUNT]);
  assert.strictEqual(out.warnings.length, 1);
  assert.match(out.warnings[0], /table contact has no default public view to pin into the app/);
});

test('pinning: an app that already carries components.views is extended in place; one with components but no views gets the list added', async () => {
  const withViews = placing(appArtifact({ components: { views: [V_HELD] } }), viewRecords());
  await backend(withViews).placeInApp(APP, { pages: [], dataSources: ['account'] });
  assert.deepStrictEqual(withViews.of('updateElement').map((c) => c.args), [['app', APP, '/components/views', [V_HELD, V_ACCOUNT]]]);

  const noViews = placing(appArtifact({ components: { tables: [] } }), viewRecords());
  await backend(noViews).placeInApp(APP, { pages: [], dataSources: ['account'] });
  assert.deepStrictEqual(noViews.of('addElement').map((c) => c.args), [['app', APP, '/components', { views: [V_ACCOUNT] }]]);
});

test('pinning: a layer that cannot be read leaves every view to pin — AddAppComponents is additive, so the worst case is a push that changes nothing', async () => {
  const sdk = new FakeSdk({ records: viewRecords({ held: [V_ACCOUNT] }), onGet: async () => ({ status: 500, body: null }) }).seedApp(appArtifact());
  const out = await backend(sdk).placeInApp(APP, { pages: [], dataSources: ['account'] });
  assert.deepStrictEqual(out.pinnedViews, [V_ACCOUNT]);
});

test('pinning: a table name is escaped into the OData filter as a literal', async () => {
  const seen = [];
  const sdk = placing(appArtifact(), { savedquery: (o) => { seen.push(o.filter); return []; } });
  await backend(sdk).placeInApp(APP, { pages: [], dataSources: ["o'brien"] });
  assert.match(seen[0], /returnedtypecode eq 'o''brien' and/);
});

// ── placeInApp: the caller's last word before the app is written (`beforeAppWrite`) ──────────────────────────────────────────────
// The build publishes the tables whose forms the app's publish would otherwise strand, and a placement pushes and publishes the app by itself, inside this backend, only when it
// finds something to write. So the build hands the placement that request, and the placement awaits it right before its first write, and not at all when it writes nothing.

test('placeInApp: beforeAppWrite is awaited once, after the edits are made and before the app is pushed or published, and nothing is sent while it is outstanding', async () => {
  const sdk = placing(appArtifact(), viewRecords());
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let called = 0;
  const beforeAppWrite = async () => {
    called += 1;
    sdk.calls.push({ name: 'beforeAppWrite', args: [] });
    await gate;
  };
  const placement = backend(sdk).placeInApp(APP, { pages: [{ pageId: P1, title: 'One' }], dataSources: ['account'], beforeAppWrite });
  for (let i = 0; i < 50 && called === 0; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(called, 1, 'the hook is called');
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(sdk.count('pushArtifact') + sdk.count('publishArtifact'), 0, 'the app is neither pushed nor published while the hook is outstanding');
  release();
  const out = await placement;
  assert.strictEqual(called, 1, 'once, for one push and one publish');
  assert.deepStrictEqual(out.added, [P1]);
  const order = sdk.calls.map((c) => c.name).filter((name) => ['updateElement', 'addElement', 'beforeAppWrite', 'pushArtifact', 'publishArtifact'].includes(name));
  assert.deepStrictEqual(order, ['updateElement', 'addElement', 'beforeAppWrite', 'pushArtifact', 'publishArtifact'], 'the edits are in the workspace copy, then the hook, then the first thing sent');
});

test('placeInApp: a placement with nothing to write — every page placed, every view pinned — does not call beforeAppWrite: the request is not made for a write that is not', async () => {
  const app = appArtifact();
  app.siteMap.areas[0].groups[0].subAreas.push({ id: 'sub_p', type: 'GenPage', genPageId: P1, title: 'Overview' });
  const sdk = placing(app, viewRecords({ held: [V_ACCOUNT] }));
  let called = 0;
  const out = await backend(sdk).placeInApp(APP, { pages: [{ pageId: P1, title: 'Overview' }], dataSources: ['account'], beforeAppWrite: async () => { called += 1; } });
  assert.strictEqual(out.appEdited, false);
  assert.strictEqual(called, 0);
  assert.strictEqual(sdk.count('pushArtifact') + sdk.count('publishArtifact'), 0);
});

test('placeInApp finish: a completion that only publishes the app, with nothing to write, calls beforeAppWrite before that publish', async () => {
  const { sdk } = savedButUnpublished();
  const order = [];
  const publish = sdk.publishArtifact.bind(sdk);
  sdk.publishArtifact = async (type, id, options) => { order.push('publishArtifact'); return publish(type, id, options); };
  const out = await backend(sdk).placeInApp(APP, { pages: [{ pageId: P1, title: 'Overview' }], finish: true, beforeAppWrite: async () => { order.push('beforeAppWrite'); } });
  assert.strictEqual(out.provedPublished, true);
  assert.deepStrictEqual(order, ['beforeAppWrite', 'publishArtifact'], 'the publish is a write of the app too');
  assert.strictEqual(sdk.count('pushArtifact'), 0, 'and there is no push to put it before');
});

test('placeInApp: a beforeAppWrite that throws stops the placement before anything is sent, and its own error is what the caller sees', async () => {
  const sdk = placing(appArtifact(), viewRecords());
  const refusal = new Error('the request before the app failed');
  await assert.rejects(backend(sdk).placeInApp(APP, { pages: [{ pageId: P1, title: 'One' }], dataSources: ['account'], beforeAppWrite: async () => { throw refusal; } }), (e) => e === refusal);
  assert.strictEqual(sdk.count('pushArtifact') + sdk.count('publishArtifact'), 0, 'the edits stay in the throwaway workspace copy, which the next fetch replaces');
  assert.deepStrictEqual(sdk.apps.get(APP).siteMap.areas[0].groups[0].subAreas.map((s) => s.id), ['sub_1'], 'and the server still holds the navigation it had');
});

test('placeInApp: without beforeAppWrite the placement is what it was, and a value that is no function is ignored', async () => {
  for (const hook of [undefined, null, 'later', {}]) {
    const sdk = placing(appArtifact());
    const out = await backend(sdk).placeInApp(APP, { pages: [{ pageId: P1, title: 'One' }], beforeAppWrite: hook });
    assert.deepStrictEqual(out.added, [P1]);
    assert.deepStrictEqual([sdk.count('pushArtifact'), sdk.count('publishArtifact')], [1, 1]);
  }
});

// ── placeInApp: what the caller is told about the write (`beforeAppWrite`'s argument) ───────────────────────────────────────────────────────────────
// The build decides from it which tables to publish before the app. The placement is the one that knows what it sends: the app as the server holds it, plus the page entries and the views
// this call adds. The SDK expands the Entity entries of the navigation it pushes into their active Main forms (and only those: a page entry, a link or a dashboard adds none), and applies the
// Main-form list the pushed app carries, so these are the Entity entries of the FETCHED navigation and the fetched app's list — never the spec's, which this push does not send.
const holds = (...subAreas) => {
  const app = appArtifact();
  app.siteMap.areas[0].groups[0].subAreas.push(...subAreas);
  return app;
};
const toldBy = async (sdk, options) => {
  const told = [];
  await backend(sdk).placeInApp(APP, { ...options, beforeAppWrite: async (write) => { told.push(write); } });
  return told;
};

test('placeInApp: beforeAppWrite is told what the push sends — the tables of the Entity entries of the navigation the server holds, lower-cased and once each, and that it pushes', async () => {
  const sdk = placing(holds(
    { id: 'sub_2', type: 'Entity', entity: 'Contact', title: 'Contacts' },
    { id: 'sub_3', type: 'Entity', entity: 'ACCOUNT', title: 'Accounts again' },
    { id: 'sub_4', type: 'GenPage', genPageId: P2, title: 'A page' },
    { id: 'sub_5', type: 'URL', url: 'https://contoso.example', title: 'Documentation' },
    { id: 'sub_6', type: 'DashBoard', dashboardId: V_HELD, title: 'Dashboard' },
    { id: 'sub_7', type: 'Entity', title: 'An entry with no table' },
  ));
  assert.deepStrictEqual(await toldBy(sdk, { pages: [{ pageId: P1, title: 'One' }] }), [{ pushes: true, entityTables: ['account', 'contact'], mainFormsByTable: undefined }]);
});

test('placeInApp: beforeAppWrite is told the Main-form list the pushed app carries, when it carries one', async () => {
  const lists = { account: ['33333333-0000-4000-8000-000000000001'] };
  const sdk = placing(appArtifact({ components: { views: [], mainFormsByTable: lists } }));
  assert.deepStrictEqual(await toldBy(sdk, { pages: [{ pageId: P1, title: 'One' }] }), [{ pushes: true, entityTables: ['account'], mainFormsByTable: lists }]);
});

test('placeInApp: the pages and views this call adds change neither the tables it reports nor the list: they are page entries and view components, which the SDK does not expand', async () => {
  const sdk = placing(appArtifact(), viewRecords());
  const told = await toldBy(sdk, { pages: [{ pageId: P1, title: 'One' }, { pageId: P2, title: 'Two' }], dataSources: ['account', 'contact'] });
  assert.deepStrictEqual(told, [{ pushes: true, entityTables: ['account'], mainFormsByTable: undefined }]);
  assert.strictEqual(sdk.count('pushArtifact'), 1);
});

test('placeInApp finish: a completion that only publishes the app says it pushes nothing, so it adds no Main form whatever the navigation holds', async () => {
  const { sdk } = savedButUnpublished();
  assert.deepStrictEqual(await toldBy(sdk, { pages: [{ pageId: P1, title: 'Overview' }], finish: true }), [{ pushes: false, entityTables: ['account'], mainFormsByTable: undefined }]);
  assert.strictEqual(sdk.count('pushArtifact'), 0);
});

test('placeInApp: an app with no navigation of its own reports no table', async () => {
  assert.deepStrictEqual(await toldBy(placing({ id: APP, name: 'App' }), { pages: [{ pageId: P1, title: 'One' }] }), [{ pushes: true, entityTables: [], mainFormsByTable: undefined }]);
});

test('entityTablesOfSiteMap: the tables of the Entity entries of a navigation of any shape — a type and a table name, as the SDK reads them — lower-cased, once each, in navigation order', () => {
  const siteMap = { areas: [
    { id: 'a', groups: [{ id: 'g', subAreas: [{ type: 'Entity', entity: 'Contact' }, { type: 'GenPage', genPageId: P1, entity: 'ignored' }, { type: 'Entity', entity: 'account' }] }, { id: 'h', subAreas: [{ type: 'Entity', entity: 'CONTACT' }] }] },
    { id: 'b', groups: [{ id: 'i', subAreas: [{ type: 'Entity', entity: 'lead' }, null, { type: 'Entity', entity: '' }, { type: 'Entity', entity: 5 }, { entity: 'untyped' }] }] },
  ] };
  assert.deepStrictEqual(entityTablesOfSiteMap(siteMap), ['contact', 'account', 'lead']);
  for (const shape of [undefined, null, {}, { areas: null }, { areas: [null, {}, { groups: null }, { groups: [null, {}, { subAreas: 'nope' }] }] }, 'x']) assert.deepStrictEqual(entityTablesOfSiteMap(shape), [], JSON.stringify(shape));
});

test('dispose: an SDK that is lent (or injected) leaves nothing for dispose() to remove, and dispose() may be called any number of times', () => {
  const removed = [];
  const lent = makeGenpageSdk(ENV, { sdk: new FakeSdk(), rmSync: (dir) => removed.push(dir) });
  lent.dispose();
  lent.dispose();
  assert.deepStrictEqual(removed, [], 'nothing was made, so nothing is removed');
});

const turns = async (n = 10) => { for (let i = 0; i < n; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

// A lent SDK keeps its workspace where this backend cannot close it, so the backend gives its owner — who removes the folder after dispose() — the
// time the operations still running on it need to end: dispose() answers when they have, and after `drainMs` at the latest.
test('dispose / discardWorkspaces: an SDK that is lent is given the time the operations running on it need — they are waited for, up to a bound — and a disposed backend starts no operation', { timeout: 30000 }, async () => {
  const sdk = new FakeSdk().seedPage({ id: P1, name: 'One', source: 'a' });
  let open;
  const held = new Promise((resolve) => { open = resolve; });
  sdk.script('fetch', () => held);
  const genpage = backend(sdk, { drainMs: 60000 });
  const reading = genpage.read(P1);
  await turns();
  assert.strictEqual(sdk.count('fetchArtifact'), 1, 'the read is out');

  let discarded = false;
  const discarding = genpage.discardWorkspaces().then(() => { discarded = true; });
  await turns();
  assert.strictEqual(discarded, false, 'a read is still running on the lent SDK, so the discard waits for it');
  open();
  assert.strictEqual((await reading).source, 'a');
  await discarding;
  assert.strictEqual(discarded, true);
  assert.strictEqual((await genpage.read(P1)).source, 'a', 'discarding is not closing: the backend is still open');

  let finished = false;
  const second = genpage.read(P1);
  const disposing = genpage.dispose().then(() => { finished = true; });
  await second;
  await disposing;
  assert.strictEqual(finished, true);
  await assert.rejects(genpage.read(P1), (e) => e.code === 'GENPAGE_BACKEND_CLOSED');
  await assert.rejects(genpage.update(P1, { source: 'b' }), (e) => e.code === 'GENPAGE_BACKEND_CLOSED');
  await assert.rejects(genpage.placeInApp(APP, { pages: [] }), (e) => e.code === 'GENPAGE_BACKEND_CLOSED');
  assert.strictEqual((await genpage.enumerateEnv()).ok, false, 'a listing on a closed backend is a failed listing, not an empty environment');
  assert.strictEqual(sdk.count('fetchArtifact'), 3, 'and none of them reached the SDK');

  // A read that never ends does not hold the owner for ever.
  const stuck = new FakeSdk().seedPage({ id: P1, name: 'One', source: 'a' }).script('fetch', () => new Promise(() => {}));
  const hung = backend(stuck, { drainMs: 40 });
  hung.read(P1).catch(() => {});
  await turns();
  const startedAt = Date.now();
  await hung.dispose();
  assert.ok(Date.now() - startedAt < 2000, 'dispose() answered after the bound');
});
