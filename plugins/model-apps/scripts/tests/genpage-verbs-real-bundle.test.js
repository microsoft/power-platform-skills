'use strict';
// The page backend's operations behind scripts/genpage.js — describe, delete, removeFromApp, runtimeTypes, defaultViews, baseLanguage, and the placement that finishes
// itself when the app does not show the page — through the REAL vendored SDK bundle, over the stateful fake of the page tables with one app laid over it
// (helpers/fake-genpage-server.js `appTransport`: the app's saved and published navigation, its component rows, `PublishXml`). What these prove that genpage-sdk-verbs.test.js
// cannot: the bundle itself accepts what the backend sends (an edit that empties a group, a delete of the project and then of its messages), the requests the
// operations make leave the state the fake holds as the operation says, and the two layers of an app — saved and published — move as the operations claim.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { makeGenpageSdk } = require('../lib/genpage-sdk.js');
const { FakeGenPageServer, INSTANCE, ACCOUNT_TABLE, appTransport, APP_ID, APP_EXISTING_PAGE_ID, APP_VIEW_ID } = require('./helpers/fake-genpage-server.js');

const OTHER = '77777777-7777-4777-8777-777777777777';
const EXTRA_ROW = 'f0000000-0000-4000-8000-0000000000aa';

// The app (APP_ID, unique name contoso_review) names APP_EXISTING_PAGE_ID in both layers. OTHER is a page no app names.
async function inWorld(fn, { appOptions } = {}) {
  const server = new FakeGenPageServer();
  server.serveTable(ACCOUNT_TABLE);
  server.seedPage(APP_EXISTING_PAGE_ID, { name: 'Existing', config: { dataSources: ['account'], model: '' } });
  server.seedPage(OTHER, { name: 'Other', config: { dataSources: ['account'], model: '' }, prompt: 'Make it' });
  const app = appTransport(server, appOptions);
  const made = [];
  const genpage = makeGenpageSdk(INSTANCE, {
    httpClient: app.http,
    mkdtempSync: (prefix) => { const dir = fs.mkdtempSync(prefix); made.push(dir); return dir; },
  });
  try {
    return await fn({ server, app, genpage });
  } finally {
    await genpage.dispose();
    for (const dir of made) assert.ok(!fs.existsSync(dir), `the throwaway workspace ${dir} is removed by dispose()`);
  }
}

const namesPage = (xml, id) => xml.toLowerCase().includes(`genpageid="${id}"`);
const deletes = (server) => server.writes().filter((write) => /DELETE/.test(write));

test('REAL BUNDLE: describe counts the rows of a page\'s folder and the messages of its conversation — the four the maker lays out, and any other row — and writes nothing', async () => {
  await inWorld(async ({ server, app, genpage }) => {
    assert.deepStrictEqual(await genpage.describe(OTHER), { pageId: OTHER, name: 'Other', editable: true, dataSources: ['account'], fileRows: 4, conversationMessages: 2 });
    server.seedFile(OTHER, EXTRA_ROW, 'src/styles.css', 200000000, 'body { margin: 0 }');
    assert.strictEqual((await genpage.describe(OTHER.toUpperCase())).fileRows, 5, 'a row the maker does not lay out is a row of the folder too');
    await assert.rejects(genpage.describe('99999999-9999-4999-8999-999999999999'), (e) => e.code === 'GENPAGE_NOT_FOUND');
    assert.deepStrictEqual([server.writes(), app.state.writes], [[], []]);
  });
});

test('REAL BUNDLE: delete removes the page — its project row, the rows of its folder and the messages of its conversation — and nothing of any other page, and says what it removed', async () => {
  await inWorld(async ({ server, genpage }) => {
    const before = { files: server.filesOf(APP_EXISTING_PAGE_ID).length, messages: server.messagesOf(APP_EXISTING_PAGE_ID).length };
    const out = await genpage.delete(OTHER);
    assert.deepStrictEqual(out, { pageId: OTHER, name: 'Other', deleted: true, fileRows: 4, conversationMessages: 2, historyRemoved: true, verified: true, warnings: [] });
    assert.ok(!server.state.projects.has(OTHER));
    assert.deepStrictEqual([server.filesOf(OTHER).length, server.messagesOf(OTHER).length], [0, 0], 'the folder\'s rows and the conversation are gone');
    assert.deepStrictEqual({ files: server.filesOf(APP_EXISTING_PAGE_ID).length, messages: server.messagesOf(APP_EXISTING_PAGE_ID).length }, before, 'the other page is as it was');
    await assert.rejects(genpage.read(OTHER), (e) => e.code === 'GENPAGE_NOT_FOUND');
    await assert.rejects(genpage.delete(OTHER), (e) => e.code === 'GENPAGE_NOT_FOUND', 'a second delete finds nothing to delete');
  });
});

test('REAL BUNDLE: a page the app\'s published navigation names is not deleted — the refusal names the app, and not one delete request is sent', async () => {
  await inWorld(async ({ server, genpage }) => {
    await assert.rejects(genpage.delete(APP_EXISTING_PAGE_ID), (e) => {
      assert.strictEqual(e.code, 'GENPAGE_IN_APP');
      assert.strictEqual(e.outcome, 'nothing');
      assert.deepStrictEqual(e.apps, [{ uniqueName: 'contoso_review', savedOnly: false, appId: APP_ID, name: 'Review' }]);
      assert.match(e.message, /"Review" \(contoso_review, id 22222222-2222-4222-8222-222222222222\)/);
      return true;
    });
    assert.deepStrictEqual(deletes(server), []);
    assert.ok(server.state.projects.has(APP_EXISTING_PAGE_ID));
  });
});

test('REAL BUNDLE: a page an app only SAVED into its navigation is not deleted either — the refusal says it is saved and not published; once taken out of the app the delete goes through', async () => {
  await inWorld(async ({ server, app, genpage }) => {
    // The placement is saved, and the publish that would have shown it fails: the page is in the app's saved navigation alone.
    await assert.rejects(genpage.placeInApp(APP_ID, { pages: [{ pageId: OTHER, title: 'Other' }], finishIfUnpublished: true }), (e) => e.code === 'GENPAGE_APP_PUBLISH_FAILED' && e.saved === true);
    assert.ok(namesPage(app.state.xml, OTHER) && !namesPage(app.state.publishedXml, OTHER));
    await assert.rejects(genpage.delete(OTHER), (e) => {
      assert.strictEqual(e.code, 'GENPAGE_IN_APP');
      assert.deepStrictEqual(e.apps, [{ uniqueName: 'contoso_review', savedOnly: true, appId: APP_ID, name: 'Review' }]);
      assert.match(e.message, /\[saved, not published\]/);
      return true;
    });
    assert.deepStrictEqual(deletes(server), []);

    // Taking it out of the app (its saved navigation does not name it any more, and the published one never did) leaves the delete free to go.
    const removed = await genpage.removeFromApp(APP_ID, OTHER);
    assert.deepStrictEqual([removed.wasInNavigation, removed.appEdited], [true, true]);
    assert.strictEqual((await genpage.delete(OTHER)).deleted, true);
  }, { appOptions: { publishFailures: 1 } });
});

test('REAL BUNDLE: removeFromApp takes the page out of the saved AND the published navigation — the other entries, the views and the page itself stay — and the page can then be deleted', async () => {
  await inWorld(async ({ server, app, genpage }) => {
    const placed = await genpage.placeInApp(APP_ID, { pages: [{ pageId: OTHER, title: 'Other' }], dataSources: ['account'], finishIfUnpublished: true });
    assert.deepStrictEqual([placed.added, placed.pinnedViews, placed.provedPublished], [[OTHER], [APP_VIEW_ID], true]);
    assert.ok(namesPage(app.state.xml, OTHER) && namesPage(app.state.publishedXml, OTHER));

    const out = await genpage.removeFromApp(APP_ID, OTHER.toUpperCase());
    assert.deepStrictEqual(out, { removed: [{ area: 'Main', group: 'Pages', count: 1 }], wasInNavigation: true, appEdited: true, published: true, entriesLeft: 1, provedPublished: true, warnings: [] });
    for (const [layer, xml] of [['saved', app.state.xml], ['published', app.state.publishedXml]]) {
      assert.ok(!namesPage(xml, OTHER), `${layer}: the page's entry is gone`);
      assert.ok(namesPage(xml, APP_EXISTING_PAGE_ID), `${layer}: the other entry stays`);
    }
    assert.ok(app.state.views.has(APP_VIEW_ID), 'the view that was pinned for the page\'s table stays');
    assert.ok(server.state.projects.has(OTHER), 'the page itself stays');

    assert.deepStrictEqual(await genpage.removeFromApp(APP_ID, OTHER), { removed: [], wasInNavigation: false, appEdited: false, published: false, entriesLeft: 1, warnings: [] }, 'a second removal finds nothing to do');
    assert.strictEqual((await genpage.delete(OTHER)).deleted, true);
    assert.ok(!server.state.projects.has(OTHER));
    assert.ok(server.state.projects.has(APP_EXISTING_PAGE_ID));
  });
});

test('REAL BUNDLE: the entry that is the app\'s last is not taken out unless it is asked for — nothing is written before the refusal — and the SDK accepts the empty navigation when it is', async () => {
  await inWorld(async ({ app, genpage }) => {
    await assert.rejects(genpage.removeFromApp(APP_ID, APP_EXISTING_PAGE_ID), (e) => e.code === 'GENPAGE_NAVIGATION_WOULD_BE_EMPTY' && e.outcome === 'nothing');
    assert.deepStrictEqual([app.state.writes, app.state.publishAttempts], [[], 0], 'refused before the app was touched');
    assert.ok(namesPage(app.state.xml, APP_EXISTING_PAGE_ID));

    const out = await genpage.removeFromApp(APP_ID, APP_EXISTING_PAGE_ID, { allowEmpty: true });
    assert.deepStrictEqual([out.entriesLeft, out.appEdited, out.provedPublished], [0, true, true]);
    assert.ok(!app.state.xml.includes('GenPageId') && !app.state.publishedXml.includes('GenPageId'), 'neither layer names a page');
  });
});

test('REAL BUNDLE: a removal that was saved and could not be published is finished by running it again — the app is published, nothing is written, and the page is proved gone from what runs', async () => {
  await inWorld(async ({ app, genpage }) => {
    await genpage.placeInApp(APP_ID, { pages: [{ pageId: OTHER, title: 'Other' }], finishIfUnpublished: true });
    app.state.failures = 1;
    await assert.rejects(genpage.removeFromApp(APP_ID, OTHER), (e) => e.code === 'GENPAGE_APP_PUBLISH_FAILED' && e.saved === true && /was taken out of the saved navigation/.test(e.message));
    assert.ok(!namesPage(app.state.xml, OTHER) && namesPage(app.state.publishedXml, OTHER), 'saved without the page, and still published with it');

    const writesBefore = app.state.writes.length;
    const again = await genpage.removeFromApp(APP_ID, OTHER);
    assert.deepStrictEqual([again.wasInNavigation, again.appEdited, again.published, again.provedPublished, again.removed], [true, false, true, true, []]);
    assert.strictEqual(app.state.writes.length, writesBefore, 'nothing was written: the removal had been saved');
    assert.ok(!namesPage(app.state.publishedXml, OTHER));
    assert.strictEqual((await genpage.removeFromApp(APP_ID, OTHER)).wasInNavigation, false, 'and a third run has nothing to do');
  });
});

test('REAL BUNDLE: placeInApp finishIfUnpublished completes a placement that was saved and not published — and leaves one that is shown alone: no publish is sent', async () => {
  await inWorld(async ({ app, genpage }) => {
    const place = () => genpage.placeInApp(APP_ID, { pages: [{ pageId: OTHER, title: 'Other' }], finishIfUnpublished: true });
    await assert.rejects(place(), (e) => e.code === 'GENPAGE_APP_PUBLISH_FAILED' && e.saved === true);
    assert.ok(namesPage(app.state.xml, OTHER) && !namesPage(app.state.publishedXml, OTHER));
    const attempts = app.state.publishAttempts;

    const finished = await place();
    assert.deepStrictEqual([finished.added, finished.alreadyPlaced, finished.appEdited, finished.provedPublished], [[], [OTHER], false, true]);
    assert.strictEqual(app.state.publishAttempts, attempts + 1, 'the app was published once');
    assert.ok(namesPage(app.state.publishedXml, OTHER));

    const settled = await place();
    assert.deepStrictEqual([settled.alreadyPlaced, settled.appEdited, settled.provedPublished], [[OTHER], false, undefined]);
    assert.strictEqual(app.state.publishAttempts, attempts + 1, 'a page both layers name is left alone');
  }, { appOptions: { publishFailures: 1 } });
});

test('REAL BUNDLE: runtimeTypes is the SDK\'s generator — a self-contained module with the table\'s row type and its enum, LF and no byte order mark — read from the environment, and nothing is written', async () => {
  await inWorld(async ({ server, app, genpage }) => {
    const text = await genpage.runtimeTypes(['account']);
    assert.ok(text.startsWith('\n// ---------------- Type Definitions which can be imported from ./RuntimeTypes'), 'starts with a blank line, as the SDK writes it');
    assert.ok(text.endsWith('\n}\n'));
    assert.ok(!text.includes('\r') && text.charCodeAt(0) !== 0xFEFF, 'LF, and no byte order mark');
    for (const part of ['export interface TableRegistrations extends BaseTableRegistrations', '"account": account,', 'export type account = TableRow<{', 'readonly accountid: string,', 'const enum account_accountcategorycode {', '"Preferred Customer" = 1,', 'export interface GeneratedComponentProps', 'pageInput?: PageInput;', 'export type DataColumnValue']) {
      assert.ok(text.includes(part), `the module holds ${part}`);
    }
    assert.deepStrictEqual([server.writes(), app.state.writes], [[], []]);
  });
});

test('REAL BUNDLE: runtimeTypes types a table named twice, or in another letter case, once — and the level of detail only adds comments', async () => {
  await inWorld(async ({ genpage }) => {
    const plain = await genpage.runtimeTypes(['account']);
    assert.strictEqual(await genpage.runtimeTypes([' Account', 'ACCOUNT', 'account']), plain);
    const detailed = await genpage.runtimeTypes(['account'], { detail: 'ColorsDefaultsConstraints' });
    assert.ok(detailed.includes('// Maximum length: 160') && !plain.includes('// Maximum length: 160'));
    assert.strictEqual(detailed.split('\n').filter((line) => !/^\s*\/\/ Maximum length/.test(line)).join('\n'), plain, 'the same module with its comments');
  });
});

test('REAL BUNDLE: runtimeTypes of a table the environment does not have is the SDK\'s own 404; an empty list is refused before any request', async () => {
  await inWorld(async ({ server, genpage }) => {
    await assert.rejects(genpage.runtimeTypes(['nosuchtable']), (e) => e.code === 'CONNECTION_ERROR' && e.statusCode === 404);
    const sent = server.requests.length;
    await assert.rejects(genpage.runtimeTypes([]), (e) => e.code === 'GENPAGE_DATA_SOURCES_REQUIRED');
    assert.strictEqual(server.requests.length, sent, 'no request');
  });
});

test('REAL BUNDLE: defaultViews names the table\'s default public view, and baseLanguage the environment\'s base language — read, nothing written', async () => {
  await inWorld(async ({ server, app, genpage }) => {
    assert.deepStrictEqual(await genpage.defaultViews(['account', 'Account']), { views: [{ table: 'account', viewId: APP_VIEW_ID }], warnings: [] });
    assert.strictEqual(await genpage.baseLanguage(), 1033);
    server.languages = { base: 1031, provisioned: [1031, 1033], available: [1031, 1033, 1036] };
    assert.strictEqual(await genpage.baseLanguage(), 1031);
    assert.deepStrictEqual([server.writes(), app.state.writes], [[], []]);
  });
});
