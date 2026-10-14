'use strict';
// The page backend's operations behind scripts/genpage.js — `describe`, `delete`, `removeFromApp`, `runtimeTypes`, `defaultViews`, `baseLanguage` — and the
// placement a caller asks to finish only when the app does not show the page (`placeInApp` with `finishIfUnpublished`), against the in-memory stand-in for the
// SDK (helpers/fake-genpage-sdk.js). The stand-in can give the answers a real SDK gives only now and then — a delete whose answer is lost, a publish that was
// accepted and has not taken effect, an app whose navigation cannot be read — so every guard these operations hold is exercised here by the state it guards
// against. genpage-verbs-real-bundle.test.js runs the same operations through the real vendored bundle.
const { test } = require('node:test');
const assert = require('node:assert');
const { makeGenpageSdk, genPagesOfSiteMap } = require('../lib/genpage-sdk.js');
const { genPageSubArea, genPageSubAreaId } = require('../lib/genpage-subarea.js');
const { FakeSdk, sdkError, connectionError } = require('./helpers/fake-genpage-sdk.js');

const ENV = 'https://contoso.crm.dynamics.com';
const APP = '22222222-0000-4000-8000-0000000000bb';
const LAYER = '33333333-0000-4000-8000-0000000000cc';
const SITEMAP = '44444444-0000-4000-8000-0000000000dd';
const P1 = '11111111-0000-4000-8000-000000000001';
const P2 = '11111111-0000-4000-8000-000000000002';
const P3 = '11111111-0000-4000-8000-000000000003';
const V_ACCOUNT = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const V_CONTACT = 'aaaaaaaa-0000-4000-8000-0000000000a2';
const backend = (sdk, deps = {}) => makeGenpageSdk(ENV, { sdk, ...deps });
const turns = async (n = 10) => { for (let i = 0; i < n; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

// ── an app, as the SDK holds it and as the platform publishes it ───────────────────────────────────────────────────

const pageEntry = (pageId, title = 'Page') => genPageSubArea({ id: genPageSubAreaId(pageId), title }, pageId);
const entityEntry = { id: 'sub_accounts', type: 'Entity', entity: 'account', title: 'Accounts' };
const navApp = (areas) => ({ id: APP, name: 'App', siteMap: { areas } });
const oneGroup = (...subAreas) => navApp([{ id: 'area_1', title: 'Main', groups: [{ id: 'group_1', title: 'Records', subAreas }] }]);
const xmlOf = (ids) => `<SiteMap><Area Id="a"><Group Id="g">${ids.map((id, i) => `<SubArea Id="s${i}" GenPageId="${id}" Title="Page ${i}"/>`).join('')}</Group></Area></SiteMap>`;
const layerGet = async (url) => (/RetrieveUnpublishedMultiple/.test(url)
  ? { status: 200, body: { value: [{ appmoduleid: APP, appmoduleidunique: LAYER, componentstate: 0 }] } }
  : { status: 404, body: null });

// An app whose SAVED navigation is `app.siteMap` and whose PUBLISHED one names the pages in `published` — until the app is published, which copies the saved navigation to the
// published one as PublishXml does. `takesEffect: false` is a publish the service accepted and the published navigation has not caught up with; `unreadable` an app whose published
// sitemap cannot be read; `neverPublished` an app with no published form at all until it is published.
function appWorld(app, { published = [], takesEffect = true, unreadable = false, neverPublished = false } = {}) {
  const state = { published: [...published], neverPublished };
  const sdk = new FakeSdk({
    records: {
      appmodule: (o) => (/^appmoduleid eq /.test(o.filter) ? (state.neverPublished ? [] : [{ uniquename: 'contoso_app' }]) : [{ appmoduleid: APP, appmoduleidunique: LAYER }]),
      appmodulecomponent: () => [{ objectid: SITEMAP, componenttype: 62 }],
      sitemap: () => (unreadable ? [] : [{ sitemapxml: xmlOf(state.published) }]),
    },
    onGet: layerGet,
    onPublish: async (type, id, fake) => {
      if (type !== 'app' || !takesEffect) return;
      state.neverPublished = false;
      state.published = genPagesOfSiteMap(fake.apps.get(id).siteMap).map((p) => p.pageId);
    },
  }).seedApp(app);
  return { sdk, state };
}
const writes = (sdk) => sdk.count('updateElement') + sdk.count('addElement') + sdk.count('pushArtifact') + sdk.count('publishArtifact');
const savedIds = (sdk) => genPagesOfSiteMap(sdk.apps.get(APP).siteMap).map((p) => p.pageId);

// ── describe ─────────────────────────────────────────────────────────────────────────────────────────────────────

const folderOf = (over = {}) => ({
  id: P1,
  name: 'Overview',
  source: 'export default function Page() { return null; }',
  dataSources: ['account', 'contact'],
  conversation: [{ sender: 'user', message: 'Make an overview' }, { sender: 'agent', message: 'Done' }, { sender: 'user', message: 'Add a chart' }],
  bag: { rows: { source: 'row-1', output: 'row-2', config: 'row-3', prompt: 'row-4' } },
  files: [{ name: 'styles.css' }, { name: 'logo.svg' }],
  ...over,
});

test('describe: a page\'s identity, its tables and its size — the rows of its folder and the messages of its conversation, counted', async () => {
  const sdk = new FakeSdk().seedPage(folderOf());
  const out = await backend(sdk).describe(P1.toUpperCase());
  assert.deepStrictEqual(out, { pageId: P1, name: 'Overview', editable: true, dataSources: ['account', 'contact'], fileRows: 6, conversationMessages: 3 });
  assert.deepStrictEqual(sdk.of('fetchArtifact').map((c) => c.args), [['genPage', P1, { overwrite: true }]], 'the server\'s copy, read once, by the id in lower case');
});

test('describe: a page the SDK holds as raw files is answered — not editable, its tables not known (null, which is not "none") — where read refuses it', async () => {
  const sdk = new FakeSdk().seedPage({ id: P1, name: 'Hand made', source: undefined, files: [{ name: 'a.tsx' }, { name: 'b.tsx' }], conversation: [] });
  const genpage = backend(sdk);
  assert.deepStrictEqual(await genpage.describe(P1), { pageId: P1, name: 'Hand made', editable: false, dataSources: null, fileRows: 2, conversationMessages: 0 });
  await assert.rejects(genpage.read(P1), (e) => e.code === 'GENPAGE_NO_SOURCE');
  // A page with a source that reads no table has an empty list, which is a different fact from "not known".
  const none = new FakeSdk().seedPage(folderOf({ dataSources: [] }));
  assert.deepStrictEqual((await backend(none).describe(P1)).dataSources, []);
});

test('describe: a page that is not there, one that cannot be read, and an id that is no page id each fail with their own code — the last before any request', async () => {
  await assert.rejects(backend(new FakeSdk()).describe(P1), (e) => e.code === 'GENPAGE_NOT_FOUND' && /does not exist in this environment/.test(e.message));
  const unreadable = new FakeSdk().seedPage(folderOf()).script('fetch', new Error('HTTP 500'));
  await assert.rejects(backend(unreadable).describe(P1), (e) => e.code === 'GENPAGE_UNREADABLE' && /HTTP 500/.test(e.message));
  const untouched = new FakeSdk();
  await assert.rejects(backend(untouched).describe('../etc'), (e) => e.code === 'GENPAGE_ID_INVALID' && e.outcome === 'nothing');
  assert.strictEqual(untouched.calls.length, 0);
});

// ── removeFromApp ────────────────────────────────────────────────────────────────────────────────────────────────

test('removeFromApp: the page\'s entry goes, every other entry stays — one edit, one push, one publish — and the published navigation is read back to prove it', async () => {
  const { sdk } = appWorld(oneGroup(entityEntry, pageEntry(P1, 'One'), pageEntry(P2, 'Two')), { published: [P1, P2] });
  const out = await backend(sdk).removeFromApp(APP, P1.toUpperCase());
  assert.deepStrictEqual(out, { removed: [{ area: 'Main', group: 'Records', count: 1 }], wasInNavigation: true, appEdited: true, published: true, entriesLeft: 2, provedPublished: true, warnings: [] });
  assert.deepStrictEqual(sdk.of('updateElement').map((c) => c.args), [['app', APP, '/siteMap/areas/0/groups/0/subAreas', [entityEntry, pageEntry(P2, 'Two')]]]);
  assert.deepStrictEqual([sdk.count('pushArtifact'), sdk.count('publishArtifact'), sdk.count('addElement')], [1, 1, 0], 'one push and one publish, and nothing else of the app was edited (the views stay)');
  assert.deepStrictEqual(sdk.of('publishArtifact').map((c) => c.args), [['app', APP, undefined]]);
  assert.strictEqual(sdk.count('deleteRemoteArtifact') + sdk.of('fetchArtifact').filter((c) => c.args[0] === 'genPage').length, 0, 'the page itself is not touched');
  assert.deepStrictEqual(savedIds(sdk), [P2]);
});

test('removeFromApp: every entry that names the page goes, whichever area and group it sits in and however its id is spelled — and an emptied group is left as it is', async () => {
  // Hex letters, so that the letter case of an id is something an entry can differ in.
  const LETTERS = 'abcdef12-0000-4000-8000-00000000000a';
  const upper = { ...pageEntry(LETTERS, 'Upper'), id: 'sub_upper', genPageId: LETTERS.toUpperCase() };
  const twice = { ...pageEntry(LETTERS, 'Twice'), id: 'sub_twice' };
  const third = { ...pageEntry(LETTERS, 'Third'), id: 'sub_third', genPageId: LETTERS.toUpperCase() };
  const app = navApp([
    { id: 'area_1', title: 'Main', groups: [
      { id: 'group_1', title: 'First', subAreas: [pageEntry(LETTERS, 'One'), twice, pageEntry(P2, 'Two')] },
      { id: 'group_2', title: 'Second', subAreas: [upper, entityEntry] },
    ] },
    { id: 'area_2', title: 'More', groups: [{ id: 'group_3', title: 'Third', subAreas: [third] }] },
  ]);
  const { sdk } = appWorld(app, { published: [LETTERS, P2] });
  const out = await backend(sdk).removeFromApp(APP, LETTERS.toUpperCase());
  assert.deepStrictEqual(out.removed, [{ area: 'Main', group: 'First', count: 2 }, { area: 'Main', group: 'Second', count: 1 }, { area: 'More', group: 'Third', count: 1 }]);
  assert.strictEqual(out.entriesLeft, 2);
  assert.deepStrictEqual(sdk.of('updateElement').map((c) => c.args[2]), ['/siteMap/areas/0/groups/0/subAreas', '/siteMap/areas/0/groups/1/subAreas', '/siteMap/areas/1/groups/0/subAreas']);
  assert.strictEqual(sdk.count('pushArtifact'), 1, 'several entries are still one edit');
  assert.deepStrictEqual(savedIds(sdk), [P2]);
  const saved = sdk.apps.get(APP).siteMap.areas;
  assert.deepStrictEqual(saved[1].groups[0].subAreas, [], 'the group that held only the page is kept, empty — the platform accepts it');
  assert.deepStrictEqual(saved[0].groups[1].subAreas, [entityEntry]);
});

test('removeFromApp: only an entry that targets the page as a generative page goes — an entry of another kind, or another page, that merely carries the same words stays', async () => {
  const lookalike = { id: 'sub_custom', type: 'CustomPage', genPageId: P1, title: 'Not a generative page entry' };
  const { sdk } = appWorld(oneGroup(lookalike, pageEntry(P1, 'One'), pageEntry(P2, 'Two')), { published: [P1] });
  const out = await backend(sdk).removeFromApp(APP, P1);
  assert.strictEqual(out.entriesLeft, 2);
  assert.deepStrictEqual(sdk.of('updateElement')[0].args[3], [lookalike, pageEntry(P2, 'Two')]);
});

test('removeFromApp: a page neither layer names is reported as not in the navigation — and nothing is written, nothing published', async () => {
  const { sdk } = appWorld(oneGroup(entityEntry, pageEntry(P2, 'Two')), { published: [P2] });
  const out = await backend(sdk).removeFromApp(APP, P1);
  assert.deepStrictEqual(out, { removed: [], wasInNavigation: false, appEdited: false, published: false, entriesLeft: 2, warnings: [] });
  assert.strictEqual(writes(sdk), 0);
  // An app whose navigation has no entry at all is the same: a page that is not there is not "removed", and it is not the empty-navigation refusal either.
  const empty = appWorld(oneGroup(), { published: [] });
  const none = await backend(empty.sdk).removeFromApp(APP, P1);
  assert.deepStrictEqual([none.wasInNavigation, none.entriesLeft, writes(empty.sdk)], [false, 0, 0]);
});

test('removeFromApp: a removal that was saved and never published is published — the page is gone from the app that runs, which is what "removed" says — with nothing left to write', async () => {
  // The saved navigation has dropped the page (a maker saved the removal), the published one still names it.
  const { sdk, state } = appWorld(oneGroup(entityEntry, pageEntry(P2, 'Two')), { published: [P1, P2] });
  const out = await backend(sdk).removeFromApp(APP, P1);
  assert.deepStrictEqual(out, { removed: [], wasInNavigation: true, appEdited: false, published: true, entriesLeft: 2, provedPublished: true, warnings: [] });
  assert.deepStrictEqual([sdk.count('updateElement'), sdk.count('pushArtifact'), sdk.count('publishArtifact')], [0, 0, 1]);
  assert.deepStrictEqual(state.published, [P2], 'and what runs no longer names the page');
});

test('removeFromApp: when the published navigation cannot be read the page is not known to be gone from it — a page the saved navigation does not name is reported, with the reason, and nothing is written', async () => {
  const { sdk } = appWorld(oneGroup(entityEntry), { unreadable: true });
  const out = await backend(sdk).removeFromApp(APP, P1);
  assert.strictEqual(out.wasInNavigation, false);
  assert.strictEqual(writes(sdk), 0);
  assert.strictEqual(out.warnings.length, 1);
  assert.match(out.warnings[0], new RegExp(`the published navigation of app ${APP} could not be read \\(.*sitemap-xml-unreadable.*\\), so it is not known whether page ${P1} still shows in the app that runs`));
});

test('removeFromApp: an app\'s last entry is not taken out unless that is asked for — nothing is written before the refusal, and the platform would have accepted it', async () => {
  const { sdk } = appWorld(oneGroup(pageEntry(P1, 'Only')), { published: [P1] });
  await assert.rejects(backend(sdk).removeFromApp(APP, P1), (e) => {
    assert.strictEqual(e.code, 'GENPAGE_NAVIGATION_WOULD_BE_EMPTY');
    assert.strictEqual(e.outcome, 'nothing');
    assert.strictEqual(e.transient, false);
    assert.deepStrictEqual([e.appId, e.pageId], [APP, P1]);
    assert.match(e.message, /would leave its navigation with no entry/);
    assert.match(e.message, /--allow-empty-navigation/);
    return true;
  });
  assert.strictEqual(writes(sdk), 0, 'refused before the app was touched');
  assert.deepStrictEqual(savedIds(sdk), [P1]);

  const allowed = appWorld(oneGroup(pageEntry(P1, 'Only')), { published: [P1] });
  const out = await backend(allowed.sdk).removeFromApp(APP, P1, { allowEmpty: true });
  assert.deepStrictEqual([out.entriesLeft, out.appEdited, out.provedPublished], [0, true, true]);
  assert.deepStrictEqual(allowed.sdk.of('updateElement')[0].args[3], [], 'the entries of the group, none');
  assert.deepStrictEqual(allowed.state.published, []);
});

test('removeFromApp: an entry of any other kind keeps the navigation from being empty, and only `allowEmpty: true` — not a truthy word — lifts the refusal', async () => {
  const { sdk } = appWorld(oneGroup(entityEntry, pageEntry(P1, 'One')), { published: [P1] });
  assert.strictEqual((await backend(sdk).removeFromApp(APP, P1)).entriesLeft, 1);
  const only = appWorld(oneGroup(pageEntry(P1, 'Only')), { published: [P1] });
  await assert.rejects(backend(only.sdk).removeFromApp(APP, P1, { allowEmpty: 'yes' }), (e) => e.code === 'GENPAGE_NAVIGATION_WOULD_BE_EMPTY');
});

test('removeFromApp: a navigation whose last entry is the page, still named by the PUBLISHED layer only, is refused too — the saved layer has nothing to take out, and publishing it would empty what runs', async () => {
  const { sdk } = appWorld(oneGroup(), { published: [P1] });
  await assert.rejects(backend(sdk).removeFromApp(APP, P1), (e) => e.code === 'GENPAGE_NAVIGATION_WOULD_BE_EMPTY');
  assert.strictEqual(writes(sdk), 0);
});

test('removeFromApp: a publish that fails says the removal WAS saved — and one that is accepted and has not taken effect is not a finished removal: the page is named, nothing is proved', async () => {
  const failing = appWorld(oneGroup(entityEntry, pageEntry(P1, 'One')), { published: [P1] });
  failing.sdk.script('publish', { publish: { kind: 'failed', error: new Error('PublishXml refused') } });
  await assert.rejects(backend(failing.sdk).removeFromApp(APP, P1), (e) => {
    assert.strictEqual(e.code, 'GENPAGE_APP_PUBLISH_FAILED');
    assert.strictEqual(e.saved, true);
    assert.deepStrictEqual([e.appId, e.pageId], [APP, P1]);
    assert.match(e.message, /was taken out of the saved navigation of app .*, but publishing the app failed \(PublishXml refused\) — it still shows in the app that runs until the app is published/);
    return true;
  });
  assert.strictEqual(failing.sdk.of('queryRecords').filter((c) => c.args[0] === 'sitemap').length, 0, 'a publish that failed proves nothing and is not read back');

  // The removal had been saved by someone else: the same failure says so in its own words.
  const earlier = appWorld(oneGroup(entityEntry), { published: [P1] });
  earlier.sdk.script('publish', { publish: { kind: 'failed', error: new Error('PublishXml refused') } });
  await assert.rejects(backend(earlier.sdk).removeFromApp(APP, P1), (e) => e.code === 'GENPAGE_APP_PUBLISH_FAILED' && /already out of the saved navigation of app/.test(e.message));

  const slow = appWorld(oneGroup(entityEntry, pageEntry(P1, 'One')), { published: [P1], takesEffect: false });
  await assert.rejects(backend(slow.sdk).removeFromApp(APP, P1), (e) => {
    assert.strictEqual(e.code, 'GENPAGE_APP_PUBLISH_UNPROVEN');
    assert.strictEqual(e.saved, true);
    assert.match(e.message, new RegExp(`app ${APP} was published, but its published navigation still names page ${P1}`));
    assert.match(e.message, /Run the same command again/);
    return true;
  });
  assert.strictEqual(slow.sdk.count('publishArtifact'), 1, 'the app was published');
});

test('removeFromApp: a published navigation that cannot be read after the publish contradicts nothing — it answers with a warning and says it proved nothing', async () => {
  const { sdk } = appWorld(oneGroup(entityEntry, pageEntry(P1, 'One')), { published: [P1] });
  // The publish takes effect, and the published navigation is then unreadable (the world serves it from this state).
  const publishArtifact = sdk.publishArtifact.bind(sdk);
  sdk.publishArtifact = async (...args) => { const answer = await publishArtifact(...args); sdk.records.sitemap = () => []; return answer; };
  const out = await backend(sdk).removeFromApp(APP, P1);
  assert.strictEqual(out.provedPublished, false);
  assert.strictEqual(out.published, true);
  assert.strictEqual(out.warnings.length, 1);
  assert.match(out.warnings[0], new RegExp(`app ${APP} was published, but its published navigation could not be read back to confirm that page ${P1} no longer shows \\(.*sitemap-xml-unreadable.*\\) — treat it as gone only once seen to be`));
});

test('a published navigation whose read THROWS — an SDK failure, not an unreadable sitemap — is a fact the operation reports, never a failure of what it had done: the removal, the placement and the not-in-navigation answer all go on', async () => {
  const unavailable = () => { throw connectionError(503, 'service unavailable'); };

  // After a publish that worked: the removal is reported published, and not proved.
  const removal = appWorld(oneGroup(entityEntry, pageEntry(P1, 'One')), { published: [P1] });
  const publishRemoval = removal.sdk.publishArtifact.bind(removal.sdk);
  removal.sdk.publishArtifact = async (...args) => { const answer = await publishRemoval(...args); removal.sdk.records.appmodule = unavailable; return answer; };
  const removed = await backend(removal.sdk).removeFromApp(APP, P1);
  assert.deepStrictEqual([removed.published, removed.provedPublished], [true, false]);
  assert.match(removed.warnings[0], /was published, but its published navigation could not be read back to confirm that page .* no longer shows \(could not read the published navigation of app .*: .*service unavailable.*\)/);

  // The same after a placement that finishes.
  const placement = appWorld(oneGroup(entityEntry), { published: [] });
  const publishPlacement = placement.sdk.publishArtifact.bind(placement.sdk);
  placement.sdk.publishArtifact = async (...args) => { const answer = await publishPlacement(...args); placement.sdk.records.appmodule = unavailable; return answer; };
  const placed = await backend(placement.sdk).placeInApp(APP, { pages: [{ pageId: P1, title: 'One' }], finishIfUnpublished: true });
  assert.deepStrictEqual([placed.appEdited, placed.provedPublished], [true, false]);
  assert.match(placed.warnings[0], /was published again, but its published navigation could not be read back to confirm that the page shows \(could not read the published navigation of app .*service unavailable/);

  // Before anything is done: a page the saved navigation does not name, whose published navigation cannot be read, is "not known to still show" — not a failure.
  const unread = appWorld(oneGroup(entityEntry), { published: [] });
  unread.sdk.records.appmodule = unavailable;
  const none = await backend(unread.sdk).removeFromApp(APP, P1);
  assert.deepStrictEqual([none.wasInNavigation, none.published, writes(unread.sdk)], [false, false, 0]);
  assert.match(none.warnings[0], /could not be read \(could not read the published navigation of app .*service unavailable.*\), so it is not known whether page/);

  // A page the saved navigation names, whose published navigation cannot be read: the app is published, and the placement proved when it can be.
  const saved = appWorld(oneGroup(pageEntry(P1, 'One')), { published: [] });
  saved.sdk.records.appmodule = (o) => { if (/^appmoduleid eq /.test(o.filter) && saved.sdk.count('publishArtifact') === 0) throw connectionError(503, 'service unavailable'); return /^appmoduleid eq /.test(o.filter) ? [{ uniquename: 'contoso_app' }] : [{ appmoduleid: APP, appmoduleidunique: LAYER }]; };
  const finished = await backend(saved.sdk).placeInApp(APP, { pages: [{ pageId: P1 }], finishIfUnpublished: true });
  assert.deepStrictEqual([finished.alreadyPlaced, finished.provedPublished, saved.sdk.count('publishArtifact')], [[P1], true, 1]);
});

test('removeFromApp: an app that cannot be read, a push that is not saved and an edit the SDK refuses each fail with the page still in the app — and nothing is published', async () => {
  await assert.rejects(backend(new FakeSdk()).removeFromApp(APP, P1), (e) => /cannot read app .* to take page .* out of it/.test(e.message));

  const notSaved = appWorld(oneGroup(entityEntry, pageEntry(P1, 'One')), { published: [P1] });
  notSaved.sdk.script('push', { report: { saved: false, error: sdkError('VERSION_CONFLICT', 'the app changed') } });
  await assert.rejects(backend(notSaved.sdk).removeFromApp(APP, P1), (e) => e.code === 'VERSION_CONFLICT' && /app .* was not changed: the app changed/.test(e.message));
  assert.strictEqual(notSaved.sdk.count('publishArtifact'), 0);

  const refused = appWorld(oneGroup(entityEntry, pageEntry(P1, 'One')), { published: [P1] });
  refused.sdk.script('update', sdkError('VALIDATION_ERROR', 'SiteMap is not valid'));
  await assert.rejects(backend(refused.sdk).removeFromApp(APP, P1), (e) => e.code === 'VALIDATION_ERROR');
  assert.deepStrictEqual([refused.sdk.count('pushArtifact'), refused.sdk.count('publishArtifact')], [0, 0]);
});

test('removeFromApp: an id that is not an app id or a page id is refused before any request — and the ids are taken in any letter case', async () => {
  const sdk = new FakeSdk();
  await assert.rejects(backend(sdk).removeFromApp('nope', P1), (e) => e.code === 'GENPAGE_ID_INVALID' && /not an app id/.test(e.message));
  await assert.rejects(backend(sdk).removeFromApp(APP, '../etc'), (e) => e.code === 'GENPAGE_ID_INVALID' && /not a page id/.test(e.message));
  assert.strictEqual(sdk.calls.length, 0);
});

// ── placeInApp with `finishIfUnpublished` ──────────────────────────────────────────────────────────────────────────

test('placeInApp finishIfUnpublished: a page both layers name is left exactly as it is — one read of the published navigation, no publish, nothing written', async () => {
  const { sdk } = appWorld(oneGroup(entityEntry, pageEntry(P1, 'One')), { published: [P1] });
  const out = await backend(sdk).placeInApp(APP, { pages: [{ pageId: P1 }], finishIfUnpublished: true });
  assert.deepStrictEqual(out, { added: [], alreadyPlaced: [P1], pinnedViews: [], warnings: [], appEdited: false });
  assert.strictEqual(writes(sdk), 0);
  assert.strictEqual(sdk.of('queryRecords').filter((c) => c.args[0] === 'sitemap').length, 1, 'the published navigation was read once');
});

test('placeInApp finishIfUnpublished: a page only the SAVED navigation names is published and proved — the placement an earlier run saved and could not publish is completed', async () => {
  const { sdk, state } = appWorld(oneGroup(entityEntry, pageEntry(P1, 'One')), { published: [] });
  const out = await backend(sdk).placeInApp(APP, { pages: [{ pageId: P1 }], finishIfUnpublished: true });
  assert.deepStrictEqual(out, { added: [], alreadyPlaced: [P1], pinnedViews: [], warnings: [], appEdited: false, provedPublished: true });
  assert.deepStrictEqual([sdk.count('updateElement'), sdk.count('pushArtifact'), sdk.count('publishArtifact')], [0, 0, 1], 'published, and nothing to write');
  assert.deepStrictEqual(state.published, [P1]);
});

test('placeInApp finishIfUnpublished: an app that was never published has no published navigation to show the page — it is published, and the page proved', async () => {
  const { sdk, state } = appWorld(oneGroup(pageEntry(P1, 'One')), { neverPublished: true });
  const out = await backend(sdk).placeInApp(APP, { pages: [{ pageId: P1 }], finishIfUnpublished: true });
  assert.strictEqual(out.provedPublished, true);
  assert.strictEqual(sdk.count('publishArtifact'), 1);
  assert.strictEqual(state.neverPublished, false);
});

test('placeInApp finishIfUnpublished: one page of several that the published navigation does not show is enough to publish the app — all of them are then proved', async () => {
  const { sdk } = appWorld(oneGroup(pageEntry(P1, 'One'), pageEntry(P2, 'Two')), { published: [P1] });
  const out = await backend(sdk).placeInApp(APP, { pages: [{ pageId: P1 }, { pageId: P2 }], finishIfUnpublished: true });
  assert.deepStrictEqual([out.alreadyPlaced, out.provedPublished, sdk.count('publishArtifact')], [[P1, P2], true, 1]);
});

test('placeInApp finishIfUnpublished: a page this call adds is pushed, published and proved as any completion is', async () => {
  const { sdk } = appWorld(oneGroup(entityEntry), { published: [] });
  const out = await backend(sdk).placeInApp(APP, { pages: [{ pageId: P1, title: 'One' }], finishIfUnpublished: true });
  assert.deepStrictEqual([out.added, out.alreadyPlaced, out.appEdited, out.provedPublished], [[P1], [], true, true]);
  assert.deepStrictEqual([sdk.count('updateElement'), sdk.count('pushArtifact'), sdk.count('publishArtifact')], [1, 1, 1]);
});

test('placeInApp finishIfUnpublished: a publish that was accepted and has not taken effect is not a finished placement — the page is named and nothing is proved', async () => {
  const { sdk } = appWorld(oneGroup(pageEntry(P1, 'One')), { published: [], takesEffect: false });
  await assert.rejects(backend(sdk).placeInApp(APP, { pages: [{ pageId: P1 }], finishIfUnpublished: true }), (e) => e.code === 'GENPAGE_APP_PUBLISH_UNPROVEN' && e.saved === true && e.message.includes(P1));
});

test('placeInApp finishIfUnpublished: with no page asked for there is nothing to finish — nothing is read, written or published', async () => {
  const { sdk } = appWorld(oneGroup(pageEntry(P1, 'One')), { published: [] });
  const out = await backend(sdk).placeInApp(APP, { pages: [], finishIfUnpublished: true });
  assert.deepStrictEqual(out, { added: [], alreadyPlaced: [], pinnedViews: [], warnings: [], appEdited: false });
  assert.strictEqual(writes(sdk), 0);
  assert.strictEqual(sdk.of('queryRecords').length, 0);
});

test('placeInApp without finishIfUnpublished: the same saved-only page is an ordinary placement with nothing to do', async () => {
  const { sdk } = appWorld(oneGroup(pageEntry(P1, 'One')), { published: [] });
  const out = await backend(sdk).placeInApp(APP, { pages: [{ pageId: P1 }] });
  assert.deepStrictEqual(out, { added: [], alreadyPlaced: [P1], pinnedViews: [], warnings: [], appEdited: false });
  assert.strictEqual(writes(sdk), 0);
});

// ── delete ───────────────────────────────────────────────────────────────────────────────────────────────────────

const appIdOf = (i) => `a0000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const layerOf = (i) => `c0ffee00-0000-4000-8000-${String(i).padStart(12, '0')}`;
const sitemapIdOf = (i) => `5111e0f2-0000-4000-8000-${String(i).padStart(12, '0')}`;

// The environment's apps, as the scan a delete makes reads them: [{ unique, name?, published: [page ids], saved?: [page ids], unreadable? }]. `saved` is a draft of the app's
// navigation that is not published yet (undefined: nothing pending), `unreadable` an app whose published sitemap cannot be read. `lookup: false` makes the read of the apps'
// ids and display names fail, `listFails` the list of apps.
//   GET /appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=appmoduleid,appmoduleidunique,uniquename,componentstate     the apps' current layers
//   GET /appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=appmoduleid,name,uniquename&$filter=…                          the apps that name the page
//   GET /sitemaps/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=sitemapid,sitemapxml,componentstate,sitemapnameunique          every sitemap's saved layer
function appsWorld(apps, { lookup = true, listFails = false } = {}) {
  const rows = apps.map((a, i) => ({ appmoduleid: appIdOf(i), appmoduleidunique: layerOf(i), uniquename: a.unique }));
  const tail = (text) => Number(/(\d{12})\b/.exec(text)[1]);
  return {
    records: {
      appmodule: (o) => {
        if (listFails) throw connectionError(503, 'the list of apps is unavailable');
        const named = /uniquename eq '([^']+)'/.exec(o.filter || '');
        return named ? rows.filter((r) => r.uniquename === named[1]) : rows;
      },
      appmodulecomponent: (o) => [{ objectid: sitemapIdOf(tail(o.filter)), componenttype: 62 }],
      sitemap: (o) => {
        const app = apps[tail(o.filter)];
        return app.unreadable ? [] : [{ sitemapxml: xmlOf(app.published) }];
      },
    },
    onGet: async (url) => {
      if (/\$select=appmoduleid,name,uniquename/.test(url)) {
        if (!lookup) return { status: 500, body: null };
        return { status: 200, body: { value: apps.map((a, i) => ({ appmoduleid: appIdOf(i), name: a.name, uniquename: a.unique })) } };
      }
      if (url.startsWith('/appmodules/')) return { status: 200, body: { value: rows.map((r) => ({ ...r, componentstate: 0 })) } };
      if (url.startsWith('/sitemaps/')) {
        const value = [];
        apps.forEach((a, i) => {
          value.push({ sitemapid: sitemapIdOf(i), sitemapnameunique: a.unique, sitemapxml: xmlOf(a.published), componentstate: 0 });
          if (a.saved) value.push({ sitemapid: sitemapIdOf(i), sitemapnameunique: a.unique, sitemapxml: xmlOf(a.saved), componentstate: 1 });
        });
        return { status: 200, body: { value } };
      }
      return { status: 404, body: null };
    },
  };
}
// A page of a folder like a maker's, in an environment that has `apps` — and the SDK stand-in over it.
const deletable = (apps = [{ unique: 'contoso_sales', name: 'Sales', published: [] }], options = {}, page = folderOf()) => {
  const world = appsWorld(apps, options);
  return new FakeSdk({ records: world.records, onGet: world.onGet }).seedPage(page);
};
const GONE = { pageId: P1, name: 'Overview', deleted: true, fileRows: 6, conversationMessages: 3, historyRemoved: true, verified: true, warnings: [] };

test('delete: the page and its conversation are deleted, after the apps were looked at, and the page is read back as gone — what is reported as deleted is what was counted before', async () => {
  const sdk = deletable();
  const out = await backend(sdk).delete(P1.toUpperCase());
  assert.deepStrictEqual(out, GONE);
  assert.deepStrictEqual(sdk.of('deleteRemoteArtifact').map((c) => c.args), [['genPage', P1]]);
  assert.ok(!sdk.pages.has(P1), 'the page is gone from the server');
  const order = sdk.calls.map((c) => c.name);
  assert.ok(order.indexOf('fetchArtifact') < order.indexOf('queryRecords') && order.indexOf('queryRecords') < order.indexOf('deleteRemoteArtifact'), 'read the page, look at the apps, delete');
  assert.strictEqual(order.lastIndexOf('fetchArtifact') > order.indexOf('deleteRemoteArtifact'), true, 'and read it again once it is deleted');
  assert.deepStrictEqual(sdk.of('fetchArtifact').map((c) => c.args[2]), [{ overwrite: true }, { overwrite: true }], 'from the server, not from a working copy');
});

test('delete: a page that is not there is refused before the apps are looked at, and a bad id before any request', async () => {
  const sdk = deletable([{ unique: 'contoso_sales', published: [] }], {}, folderOf({ id: P2 }));
  await assert.rejects(backend(sdk).delete(P1), (e) => e.code === 'GENPAGE_NOT_FOUND');
  assert.strictEqual(sdk.count('deleteRemoteArtifact') + sdk.count('queryRecords'), 0);
  const untouched = new FakeSdk();
  await assert.rejects(backend(untouched).delete('not-a-page'), (e) => e.code === 'GENPAGE_ID_INVALID' && e.outcome === 'nothing');
  assert.strictEqual(untouched.calls.length, 0);
});

test('delete: a page an app\'s navigation names is not deleted — the refusal names the app (its display name, unique name and id), nothing is deleted, and the page is still there', async () => {
  const sdk = deletable([{ unique: 'contoso_sales', name: 'Sales', published: [P1] }, { unique: 'contoso_ops', name: 'Operations', published: [P2] }]);
  await assert.rejects(backend(sdk).delete(P1), (e) => {
    assert.strictEqual(e.code, 'GENPAGE_IN_APP');
    assert.strictEqual(e.outcome, 'nothing');
    assert.strictEqual(e.pageId, P1);
    assert.strictEqual(e.transient, false);
    assert.deepStrictEqual(e.apps, [{ uniqueName: 'contoso_sales', savedOnly: false, appId: appIdOf(0), name: 'Sales' }]);
    assert.match(e.message, new RegExp(`the navigation of this app names it — "Sales" \\(contoso_sales, id ${appIdOf(0)}\\)`));
    assert.match(e.message, /Dataverse refuses to delete a page an app still names/);
    assert.match(e.message, /remove-from-app/);
    return true;
  });
  assert.strictEqual(sdk.count('deleteRemoteArtifact'), 0);
  assert.ok(sdk.pages.has(P1));
});

test('delete: EVERY app is looked at — one that only SAVED the page into its navigation counts, and each app that names it is named', async () => {
  const sdk = deletable([
    { unique: 'contoso_sales', name: 'Sales', published: [P1] },
    { unique: 'contoso_ops', name: 'Operations', published: [], saved: [P1] },
    { unique: 'contoso_hr', name: 'People', published: [P2] },
    { unique: 'contoso_fin', name: 'Finance', published: [P1] },
  ]);
  await assert.rejects(backend(sdk).delete(P1), (e) => {
    assert.strictEqual(e.code, 'GENPAGE_IN_APP');
    assert.deepStrictEqual(e.apps.map((a) => [a.uniqueName, a.savedOnly]).sort((x, y) => (x[0] < y[0] ? -1 : 1)), [['contoso_fin', false], ['contoso_ops', true], ['contoso_sales', false]]);
    assert.match(e.message, /the navigation of these 3 apps names it/);
    assert.match(e.message, /"Operations" \(contoso_ops, id [0-9a-f-]+\) \[saved, not published\]/);
    assert.doesNotMatch(e.message, /contoso_sales[^,]*\[saved/);
    return true;
  });
  assert.strictEqual(sdk.count('deleteRemoteArtifact'), 0);
});

test('delete: when the display names and ids of the apps cannot be read the refusal names them by unique name — it does not stop being a refusal', async () => {
  const sdk = deletable([{ unique: 'contoso_sales', name: 'Sales', published: [P1] }], { lookup: false });
  await assert.rejects(backend(sdk).delete(P1), (e) => {
    assert.strictEqual(e.code, 'GENPAGE_IN_APP');
    assert.deepStrictEqual(e.apps, [{ uniqueName: 'contoso_sales', savedOnly: false }]);
    assert.match(e.message, /names it — contoso_sales\. Dataverse refuses/);
    return true;
  });
});

test('delete: a scan that cannot run, and an app whose navigation cannot be read while none that can be read names the page, are refusals — an app that cannot be read could be the one that holds it', async () => {
  const noList = deletable([{ unique: 'contoso_sales', published: [] }], { listFails: true });
  await assert.rejects(backend(noList).delete(P1), (e) => {
    assert.strictEqual(e.code, 'GENPAGE_APPS_UNREADABLE');
    assert.strictEqual(e.outcome, 'nothing');
    assert.match(e.message, new RegExp(`could not look for the apps whose navigation names page ${P1}`));
    assert.match(e.message, /nothing was deleted/);
    return true;
  });
  assert.strictEqual(noList.count('deleteRemoteArtifact'), 0);

  const broken = deletable([{ unique: 'contoso_sales', published: [] }, { unique: 'contoso_broken', published: [], unreadable: true }]);
  await assert.rejects(backend(broken).delete(P1), (e) => {
    assert.strictEqual(e.code, 'GENPAGE_APPS_UNREADABLE');
    assert.deepStrictEqual(e.unreadableApps, ['contoso_broken']);
    assert.match(e.message, /no app that could be read names it, but the navigation of this app could not be read — contoso_broken/);
    return true;
  });
  assert.strictEqual(broken.count('deleteRemoteArtifact'), 0);
});

test('delete: an app that IS found to name the page is the answer even when another app cannot be read — the refusal names the one it found', async () => {
  const sdk = deletable([{ unique: 'contoso_sales', name: 'Sales', published: [P1] }, { unique: 'contoso_broken', published: [], unreadable: true }]);
  await assert.rejects(backend(sdk).delete(P1), (e) => e.code === 'GENPAGE_IN_APP' && e.apps.length === 1 && e.apps[0].uniqueName === 'contoso_sales');
});

test('delete: an environment whose apps do not name the page is the one case that deletes — and the answer to "an app that is not published" is the same as to any other', async () => {
  const sdk = deletable([{ unique: 'contoso_sales', published: [P2] }, { unique: 'contoso_ops', published: [], saved: [P2, P3] }]);
  assert.deepStrictEqual(await backend(sdk).delete(P1), GONE);
});

test('delete: the SDK\'s "history not fully removed" is a warning — the page is gone, the conversation messages that remain are said, and the page is still read back', async () => {
  const sdk = deletable().script('delete', { after: sdkError('GENPAGE_HISTORY_NOT_DELETED', '2 of 3 conversation messages could not be deleted') });
  const out = await backend(sdk).delete(P1);
  assert.deepStrictEqual({ ...out, warnings: undefined }, { ...GONE, historyRemoved: false, warnings: undefined });
  assert.strictEqual(out.warnings.length, 1);
  assert.match(out.warnings[0], /page "Overview" \(.*\) was deleted, but its conversation history was not fully removed: 2 of 3 conversation messages could not be deleted/);
  assert.strictEqual(sdk.of('fetchArtifact').length, 2, 'the read-back still ran');
});

test('delete: a failure that is not that one is judged by reading the page — still there: nothing was deleted, and the SDK\'s code and error are what the caller gets', async () => {
  const refusal = connectionError(400, 'The record is referenced by 1 other components');
  const sdk = deletable().script('delete', refusal);
  await assert.rejects(backend(sdk).delete(P1), (e) => {
    assert.strictEqual(e.code, 'CONNECTION_ERROR');
    assert.strictEqual(e.outcome, 'nothing');
    assert.strictEqual(e.pageId, P1);
    assert.strictEqual(e.cause, refusal);
    assert.match(e.message, /page "Overview" \(.*\) was not deleted: .*referenced by 1 other components/);
    return true;
  });
  assert.ok(sdk.pages.has(P1));
});

test('delete: a failure after which the page is gone is a delete whose answer was lost — it is reported deleted, verified, and the conversation messages that may remain are said', async () => {
  const sdk = deletable().script('delete', { lose: connectionError(0, 'socket hang up') });
  const out = await backend(sdk).delete(P1);
  assert.deepStrictEqual({ ...out, warnings: undefined }, { ...GONE, historyRemoved: false, warnings: undefined });
  assert.strictEqual(out.warnings.length, 1);
  assert.match(out.warnings[0], /the answer to deleting page "Overview" \(.*\) was lost \(.*socket hang up.*\), but the page is gone — the conversation messages are deleted after the page, so this call did not remove its 3 message\(s\), and they may remain/);
});

test('delete: a failure whose outcome cannot be read is an unknown one — the caller is told to look for the page before trying again', async () => {
  const sdk = deletable().script('delete', connectionError(0, 'reset')).script('fetch', 'read', new Error('HTTP 500'));
  await assert.rejects(backend(sdk).delete(P1), (e) => {
    assert.strictEqual(e.outcome, 'unknown');
    assert.strictEqual(e.pageId, P1);
    assert.match(e.message, /deleting page "Overview" \(.*\) failed \(.*reset.*\), and reading the page to see whether it is gone failed too \(HTTP 500\) — it is not known whether it was deleted\. Look for page .* before running this again/);
    return true;
  });
});

test('delete: a delete that was accepted is not reported until the page is read back as gone — one that can still be read is not proven deleted', async () => {
  const sdk = deletable().script('delete', { keep: true });
  await assert.rejects(backend(sdk).delete(P1), (e) => {
    assert.strictEqual(e.code, 'GENPAGE_DELETE_UNPROVEN');
    assert.strictEqual(e.outcome, 'unknown');
    assert.match(e.message, /the delete of page .* was accepted, but the page can still be read — it is not proven deleted/);
    return true;
  });
});

test('delete: a read-back that fails after a delete that worked is a warning on a delete that is reported, but not as verified', async () => {
  const sdk = deletable().script('fetch', 'read', new Error('HTTP 500'));
  const out = await backend(sdk).delete(P1);
  assert.strictEqual(out.deleted, true);
  assert.strictEqual(out.verified, false);
  assert.strictEqual(out.warnings.length, 1);
  assert.match(out.warnings[0], /was deleted, but reading it back to confirm failed \(HTTP 500\)/);
});

// ── runtimeTypes, defaultViews, baseLanguage ─────────────────────────────────────────────────────────────────────────

test('runtimeTypes: the tables are made the way a page\'s data sources are — trimmed, lower-cased, each once — and the SDK\'s text is returned exactly as it answered it', async () => {
  const text = '\n// ---- types ----\r\nexport type X = 1;\n';
  const sdk = new FakeSdk().script('types', text);
  assert.strictEqual(await backend(sdk).runtimeTypes([' Account', 'contact ', 'ACCOUNT']), text, 'not trimmed, not re-lined');
  assert.deepStrictEqual(sdk.of('generateGenPageRuntimeTypes').map((c) => c.args), [[['account', 'contact'], undefined]]);
  const csv = new FakeSdk();
  await backend(csv).runtimeTypes('Account, contact');
  assert.deepStrictEqual(csv.of('generateGenPageRuntimeTypes')[0].args[0], ['account', 'contact'], 'a typed list is accepted as the page\'s own is');
});

test('runtimeTypes: the level of detail is the SDK\'s own option, passed on only when asked for', async () => {
  const sdk = new FakeSdk();
  await backend(sdk).runtimeTypes(['account'], { detail: 'ColorsDefaultsConstraintsDescriptions' });
  await backend(sdk).runtimeTypes(['account'], {});
  assert.deepStrictEqual(sdk.of('generateGenPageRuntimeTypes').map((c) => c.args[1]), [{ detail: 'ColorsDefaultsConstraintsDescriptions' }, undefined]);
});

test('runtimeTypes: a list with no table is refused — the SDK would answer the base declarations alone, which is not what asking for a table\'s types means — before any request', async () => {
  for (const empty of [[], '', '  ', ' , ,', [' '], undefined, null]) {
    const sdk = new FakeSdk();
    await assert.rejects(backend(sdk).runtimeTypes(empty), (e) => e.code === 'GENPAGE_DATA_SOURCES_REQUIRED' && e.outcome === 'nothing', JSON.stringify(empty));
    assert.strictEqual(sdk.calls.length, 0, JSON.stringify(empty));
  }
});

test('runtimeTypes: what the SDK refuses is the caller\'s — an unknown table or a name it would not accept — as the SDK\'s own error', async () => {
  const refusal = sdkError('INVALID_ARGUMENT', 'table names must be lower case');
  await assert.rejects(backend(new FakeSdk().script('types', refusal)).runtimeTypes(['account']), (e) => e === refusal);
});

const viewRecords = (views = { account: V_ACCOUNT, contact: V_CONTACT }) => ({
  savedquery: (o) => {
    const table = /returnedtypecode eq '([^']+)'/.exec(o.filter)[1];
    return views[table] ? [{ savedqueryid: views[table].toUpperCase() }] : [];
  },
});

test('defaultViews: the default public view of each table, lower-cased, in the order of the tables, each table once — the view a page\'s app pins for it', async () => {
  const sdk = new FakeSdk({ records: viewRecords() });
  assert.deepStrictEqual(await backend(sdk).defaultViews(['account', 'Contact', 'ACCOUNT']), { views: [{ table: 'account', viewId: V_ACCOUNT }, { table: 'contact', viewId: V_CONTACT }], warnings: [] });
  assert.deepStrictEqual(sdk.of('queryRecords').map((c) => c.args[1].filter), [
    "returnedtypecode eq 'account' and querytype eq 0 and isdefault eq true",
    "returnedtypecode eq 'contact' and querytype eq 0 and isdefault eq true",
  ], 'a PUBLIC (querytype 0) view that is the table\'s DEFAULT, each table asked once');
});

test('defaultViews: a table with no default public view is a warning and is left out — never a refusal — and no table is no read', async () => {
  const sdk = new FakeSdk({ records: viewRecords({ account: V_ACCOUNT }) });
  const out = await backend(sdk).defaultViews(['account', 'contact']);
  assert.deepStrictEqual(out.views, [{ table: 'account', viewId: V_ACCOUNT }]);
  assert.strictEqual(out.warnings.length, 1);
  assert.match(out.warnings[0], /table contact has no default public view to pin into the app/);
  const none = new FakeSdk();
  assert.deepStrictEqual(await backend(none).defaultViews([]), { views: [], warnings: [] });
  assert.deepStrictEqual(await backend(none).defaultViews(undefined), { views: [], warnings: [] });
  assert.strictEqual(none.calls.length, 0);
});

test('defaultViews: a read that fails is the failure — never a table without a view', async () => {
  const sdk = new FakeSdk({ records: { savedquery: () => { throw connectionError(503, 'unavailable'); } } });
  await assert.rejects(backend(sdk).defaultViews(['account']), (e) => e.code === 'CONNECTION_ERROR');
});

test('baseLanguage: the environment\'s base language, as the SDK reads it — and a read that fails is a failure, never an English default', async () => {
  const sdk = new FakeSdk().script('languages', { baseLanguage: 1031, available: [1031, 1033], provisioned: [1031] });
  assert.strictEqual(await backend(sdk).baseLanguage(), 1031);
  await assert.rejects(backend(new FakeSdk().script('languages', connectionError(403, 'forbidden'))).baseLanguage(), (e) => e.code === 'CONNECTION_ERROR');
});

// ── the listings carry the SDK's code ────────────────────────────────────────────────────────────────────────────────

test('enumerateEnv and enumeratePages: a listing that failed with a typed error carries its code — and one that failed some other way has none', async () => {
  const typed = await backend(new FakeSdk().script('list', connectionError(403, 'forbidden'))).enumerateEnv();
  assert.strictEqual(typed.ok, false);
  assert.strictEqual(typed.code, 'CONNECTION_ERROR');
  const plain = await backend(new FakeSdk().script('list', new Error('HTTP 503'))).enumerateEnv();
  assert.strictEqual(plain.ok, false);
  assert.ok(!('code' in plain), 'a plain failure has no code to print');
  const navigation = await backend(new FakeSdk().script('fetch', connectionError(404, 'not found'))).enumeratePages(APP, { includeUnpublished: true });
  assert.deepStrictEqual([navigation.ok, navigation.code], [false, 'CONNECTION_ERROR']);
});

// ── the backend's lifetime covers the new operations ─────────────────────────────────────────────────────────────────

test('dispose: a closed backend starts none of the new operations, and none reaches the SDK', async () => {
  const sdk = new FakeSdk();
  const genpage = backend(sdk);
  await genpage.dispose();
  const attempts = {
    describe: () => genpage.describe(P1),
    delete: () => genpage.delete(P1),
    removeFromApp: () => genpage.removeFromApp(APP, P1),
    runtimeTypes: () => genpage.runtimeTypes(['account']),
    defaultViews: () => genpage.defaultViews(['account']),
    baseLanguage: () => genpage.baseLanguage(),
  };
  for (const [name, attempt] of Object.entries(attempts)) await assert.rejects(attempt(), (e) => e.code === 'GENPAGE_BACKEND_CLOSED', name);
  assert.strictEqual(sdk.calls.length, 0);
});

// A lent SDK keeps its workspace where the backend cannot close it, so the backend waits for the operations still running on it: that is what counting them while they run is for.
test('discardWorkspaces: each of the new operations is waited for while it runs on a lent SDK', { timeout: 30000 }, async () => {
  const operations = {
    describe: { holds: 'fetchArtifact', run: (g) => g.describe(P1) },
    delete: { holds: 'fetchArtifact', run: (g) => g.delete(P1) },
    removeFromApp: { holds: 'fetchArtifact', run: (g) => g.removeFromApp(APP, P1) },
    runtimeTypes: { holds: 'generateGenPageRuntimeTypes', run: (g) => g.runtimeTypes(['account']) },
    defaultViews: { holds: 'queryRecords', run: (g) => g.defaultViews(['account']) },
    baseLanguage: { holds: 'getEnvironmentLanguages', run: (g) => g.baseLanguage() },
  };
  for (const [name, { holds, run }] of Object.entries(operations)) {
    const sdk = new FakeSdk().seedPage(folderOf()).seedApp(oneGroup(pageEntry(P1, 'One')));
    let open;
    const held = new Promise((resolve) => { open = resolve; });
    const original = sdk[holds].bind(sdk);
    sdk[holds] = async (...args) => { await held; return original(...args); };
    const genpage = backend(sdk, { drainMs: 60000 });
    const running = run(genpage).catch(() => {});
    await turns();
    let discarded = false;
    const discarding = genpage.discardWorkspaces().then(() => { discarded = true; });
    await turns();
    assert.strictEqual(discarded, false, `${name}: it is still running on the lent SDK, so the discard waits for it`);
    open();
    await running;
    await discarding;
    assert.strictEqual(discarded, true, name);
  }
});
