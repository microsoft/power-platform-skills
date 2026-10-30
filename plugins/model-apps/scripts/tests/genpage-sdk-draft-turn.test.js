'use strict';
// Drafts (`publish: false`) and the caller-held turn identity (`turnId`, `turnIntent`) of the page backend (lib/genpage-sdk.js), through the REAL vendored SDK bundle over
// the stateful fake of the page tables and one app (helpers/fake-genpage-server.js). What these pin:
//   - a draft create / update / placement / removal saves and sends NO PublishXml — neither the page's nor the app's — and says so apart from the publish
//     (`saved`, `pendingPublish`, `placementState`); its content hash is `draftFingerprint`, never the `fingerprint` a caller keeps as proof of a publish;
//   - a turn id is checked and normalized before anything is read or written, is the identity of the turn the page records, and a request retried with it after an answer
//     that was lost leaves ONE turn in the page's history; the same id for another request is refused before anything is written.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { makeGenpageSdk, makeTurnBindingStore, turnIntentOf, sourceText } = require('../lib/genpage-sdk.js');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { FakeGenPageServer, INSTANCE, ACCOUNT_TABLE, appTransport, APP_ID, APP_EXISTING_PAGE_ID } = require('./helpers/fake-genpage-server.js');

const OTHER = '77777777-7777-4777-8777-777777777777';
const TURN = '6f1c2a4e-9b3d-47a1-b85c-0e2f7d914a63';
const SOURCE = "import * as React from 'react';\nexport default function Page() { return <div>Draft</div>; }\n";
const SOURCE_2 = "import * as React from 'react';\nexport default function Page() { return <div>Second</div>; }\n";

async function inWorld(fn) {
  const server = new FakeGenPageServer();
  server.serveTable(ACCOUNT_TABLE);
  server.seedPage(APP_EXISTING_PAGE_ID, { name: 'Existing', config: { dataSources: ['account'], model: '' } });
  server.seedPage(OTHER, { name: 'Other', config: { dataSources: ['account'], model: '' }, prompt: 'Make it' });
  const app = appTransport(server);
  const made = [];
  // Every backend of one world records turn ids in the same folder, through a store object of its own: what one backend (or process) bound, another is held to.
  const turnsDir = path.join(makeTempDir('genpage-turns-'), 'turns');
  const backend = (extra = {}) => makeGenpageSdk(INSTANCE, {
    httpClient: app.http,
    turnBindings: makeTurnBindingStore(turnsDir),
    ...extra,
    mkdtempSync: (prefix) => { const dir = fs.mkdtempSync(prefix); made.push(dir); return dir; },
  });
  const opened = [];
  const open = (extra) => { const genpage = backend(extra); opened.push(genpage); return genpage; };
  try {
    return await fn({ server, app, genpage: open(), open, turnsDir });
  } finally {
    for (const genpage of opened) await genpage.dispose();
    for (const dir of made) assert.ok(!fs.existsSync(dir), `the throwaway workspace ${dir} is removed by dispose()`);
  }
}

const namesPage = (xml, id) => String(xml || '').toLowerCase().includes(`genpageid="${id}"`);
// Every PublishXml of the run, the page's and the app's: the fake server's own, and the app transport's.
const publishes = (server, app) => [...server.writes().filter((w) => /PublishXml/.test(w)), ...app.state.writes.filter((w) => /PublishXml/.test(String(w)))].length + server.published.length + app.state.publishAttempts;
const lostResponse = () => { throw new Error('Request failed: read ECONNRESET'); };

test('REAL BUNDLE: a draft create and a draft update save the page and send no PublishXml — the result says saved and pending, and its hash is not a published one', async () => {
  await inWorld(async ({ server, app, genpage }) => {
    const created = await genpage.create({ name: 'Draft page', source: SOURCE, dataSources: ['account'], prompt: 'p', publish: false });
    assert.deepStrictEqual([created.publish.kind, created.publish.reason, created.saved, created.pendingPublish], ['skipped', 'draft', true, true]);
    assert.strictEqual(created.fingerprint, undefined, 'a draft gives no fingerprint a caller would keep as proof of a publish');
    assert.match(created.draftFingerprint, /^[0-9a-f]{64}$/);
    assert.ok(server.state.projects.has(created.pageId), 'the page is saved');
    assert.strictEqual(publishes(server, app), 0, 'no PublishXml was sent');

    const updated = await genpage.update(created.pageId, { source: SOURCE_2, prompt: 'second', publish: false });
    assert.deepStrictEqual([updated.publish.kind, updated.publish.reason, updated.saved, updated.pendingPublish, updated.fingerprint], ['skipped', 'draft', true, true, undefined]);
    const again = await genpage.update(created.pageId, { source: SOURCE_2, publish: false });
    assert.deepStrictEqual([again.unchanged, again.publish.reason, again.saved, again.pendingPublish], [true, 'draft', false, null], 'a draft of what the page holds saves nothing and cannot say whether it is live');
    assert.strictEqual(publishes(server, app), 0, 'still no PublishXml');

    // The default is unchanged: the same update without `publish: false` publishes, and only then is there a fingerprint.
    const published = await genpage.update(created.pageId, { source: SOURCE_2 });
    assert.strictEqual(published.publish.kind === 'skipped', false);
    assert.match(published.fingerprint, /^[0-9a-f]{64}$/);
    assert.deepStrictEqual(server.published, [created.pageId]);
  });
});

test('REAL BUNDLE: a draft placement and a draft removal save the app\'s navigation and publish nothing — the app that runs is as it was, and the page stays', async () => {
  await inWorld(async ({ server, app, genpage }) => {
    const placed = await genpage.placeInApp(APP_ID, { pages: [{ pageId: OTHER, title: 'Other' }], publish: false });
    assert.deepStrictEqual([placed.added, placed.appEdited, placed.published, placed.pendingPublish, placed.placementState], [[OTHER], true, false, true, 'saved']);
    assert.ok(namesPage(app.state.xml, OTHER) && !namesPage(app.state.publishedXml, OTHER), 'saved, not published');
    assert.strictEqual(app.state.publishAttempts, 0);

    // Published now (as a maker would), then taken out as a draft: the saved navigation loses it, the published one still names it.
    await genpage.placeInApp(APP_ID, { pages: [{ pageId: OTHER, title: 'Other' }], finishIfUnpublished: true });
    const attempts = app.state.publishAttempts;
    assert.ok(namesPage(app.state.publishedXml, OTHER));
    const removed = await genpage.removeFromApp(APP_ID, OTHER, { publish: false });
    assert.deepStrictEqual([removed.appEdited, removed.published, removed.pendingPublish, removed.placementState, removed.wasInNavigation], [true, false, true, 'saved', true]);
    assert.ok(!namesPage(app.state.xml, OTHER) && namesPage(app.state.publishedXml, OTHER), 'saved without the page; the app that runs still shows it');
    assert.strictEqual(app.state.publishAttempts, attempts, 'the draft removal published nothing');
    assert.ok(server.state.projects.has(OTHER), 'a draft removal keeps the page');
    // The published navigation still names the page, so it cannot be deleted yet.
    await assert.rejects(genpage.delete(OTHER, { allowDestructive: true }), (e) => e.outcome === 'nothing');
    assert.ok(server.state.projects.has(OTHER));

    const nothingToSave = await genpage.removeFromApp(APP_ID, OTHER, { publish: false });
    assert.deepStrictEqual([nothingToSave.appEdited, nothingToSave.published, nothingToSave.pendingPublish], [false, false, true]);
    assert.strictEqual(app.state.publishAttempts, attempts);
  });
});

test('a draft is asked for with false only, and a draft placement cannot also finish a placement or publish before the app\'s write — all refused before anything is read', async () => {
  await inWorld(async ({ server, app, genpage }) => {
    const before = server.requests.length;
    await assert.rejects(genpage.update(OTHER, { source: SOURCE, publish: 'false' }), (e) => e.code === 'GENPAGE_ARGUMENT_INVALID' && e.outcome === 'nothing');
    for (const extra of [{ finish: true }, { finishIfUnpublished: true }, { beforeAppWrite: async () => {} }]) {
      await assert.rejects(genpage.placeInApp(APP_ID, { pages: [{ pageId: OTHER }], publish: false, ...extra }), (e) => e.code === 'GENPAGE_DRAFT_UNSUPPORTED' && e.outcome === 'nothing');
    }
    assert.strictEqual(server.requests.length, before, 'nothing was read');
    assert.deepStrictEqual([app.state.writes, server.writes()], [[], []]);
  });
});

test('REAL BUNDLE: a turn id is checked and normalized before anything is read — braces and capitals are taken, anything else is refused with nothing changed', async () => {
  await inWorld(async ({ server, genpage }) => {
    for (const bad of ['', '   ', 'not-a-guid', `{${TURN}`, 42]) {
      await assert.rejects(genpage.update(OTHER, { source: SOURCE, turnId: bad }), (e) => e.code === 'GENPAGE_TURN_ID_INVALID' && e.outcome === 'nothing', JSON.stringify(bad));
      await assert.rejects(genpage.create({ name: 'X', source: SOURCE, turnId: bad }), (e) => e.code === 'GENPAGE_TURN_ID_INVALID' && e.outcome === 'nothing', JSON.stringify(bad));
    }
    assert.deepStrictEqual([server.requests.length, server.writes()], [0, []], 'not one request');

    const out = await genpage.update(OTHER, { source: SOURCE, prompt: 'change', turnId: `{${TURN.toUpperCase()}}` });
    assert.strictEqual(out.turn.id, TURN, 'lower case, no braces');
    assert.match(out.turn.intent, /^[0-9a-f]{64}$/);
    assert.deepStrictEqual(server.messagesOf(OTHER).map((m) => m.message).slice(-2), ['change', 'Authored by app-builder']);
  });
});

test('REAL BUNDLE: the turn\'s message rows are named by the turn id — the same id gives the same rows on another server, another id other rows', async () => {
  const idsFor = (turnId) => inWorld(async ({ server, genpage }) => {
    const known = new Set(server.messagesOf(OTHER).map((m) => m.id));
    await genpage.update(OTHER, { source: SOURCE, prompt: 'change', turnId });
    return server.messagesOf(OTHER).map((m) => m.id).filter((id) => !known.has(id)).sort();
  });
  const first = await idsFor(TURN);
  assert.strictEqual(first.length, 2);
  assert.deepStrictEqual(await idsFor(TURN.toUpperCase()), first);
  assert.notDeepStrictEqual(await idsFor('0d3c1b2a-4e5f-4a6b-8c7d-9e0f1a2b3c4d'), first);
});

test('REAL BUNDLE: an update whose answer was lost, retried by a later run with the same turn id and intent, leaves ONE turn in the page\'s history', async () => {
  await inWorld(async ({ server, genpage, open }) => {
    const turnsBefore = server.messagesOf(OTHER).length;
    // The change set commits and its answer is lost, and every read after that fails: the run cannot tell what happened.
    server.afterCommit = () => {
      server.failOn = (method) => (method === 'GET' ? 403 : undefined);
      lostResponse();
    };
    const args = { source: SOURCE, prompt: 'change', turnId: TURN };
    await assert.rejects(genpage.update(OTHER, args), (e) => e.outcome === 'unknown');
    server.afterCommit = undefined;
    server.failOn = undefined;
    assert.strictEqual(server.messagesOf(OTHER).length, turnsBefore + 2, 'the first send landed');

    // What the caller kept with the turn id before the first send.
    const intent = turnIntentOf(OTHER, { source: sourceText(SOURCE) }, args);
    const retried = await open().update(OTHER, { ...args, turnIntent: intent });
    assert.strictEqual(retried.unchanged, true, 'the retry reads the page and finds the update there');
    assert.strictEqual(server.messagesOf(OTHER).length, turnsBefore + 2, 'one turn in the history, not two');
  });
});

test('REAL BUNDLE: a turn id kept for one request is refused for another before anything is written — by its intent here, and by its messages in the SDK', async () => {
  await inWorld(async ({ server, genpage }) => {
    const first = await genpage.update(OTHER, { source: SOURCE, prompt: 'change', turnId: TURN });
    const messages = server.messagesOf(OTHER).length;
    const writes = server.writes().length;

    await assert.rejects(genpage.update(OTHER, { source: SOURCE_2, prompt: 'change', turnId: TURN, turnIntent: first.turn.intent }), (e) => e.code === 'GENPAGE_TURN_ID_REUSED' && e.outcome === 'nothing' && e.turnId === TURN);
    assert.strictEqual(server.writes().length, writes, 'the other request was not sent');

    // Without the kept intent the turn's record still refuses it — before the SDK is asked — and nothing is written.
    await assert.rejects(genpage.update(OTHER, { source: SOURCE_2, prompt: 'another', turnId: TURN }), (e) => e.code === 'GENPAGE_TURN_ID_REUSED' && e.outcome === 'nothing');
    assert.strictEqual(server.messagesOf(OTHER).length, messages);
    assert.strictEqual(server.fileText(server.filesOf(OTHER).find((f) => /page\.tsx$/.test(f.filename)).id), SOURCE, 'the page still holds the first request\'s source');
  });
});

// ── A turn id is bound to its one request in a durable record, whatever the caller hands back ──

test('REAL BUNDLE: the same turn id with the same prompt and other source is refused before anything is written, even with no intent handed back — and from another backend', async () => {
  await inWorld(async ({ server, app, genpage, open }) => {
    await genpage.update(OTHER, { source: SOURCE, prompt: 'change', turnId: TURN });
    const writes = server.writes().length;
    const published = server.published.length;
    for (const [backend, extra] of [[genpage, {}], [open(), {}], [open(), { turnIntent: 'f'.repeat(64) }]]) {
      await assert.rejects(backend.update(OTHER, { source: SOURCE_2, prompt: 'change', turnId: TURN, ...extra }), (e) => e.code === 'GENPAGE_TURN_ID_REUSED' && e.outcome === 'nothing' && e.turnId === TURN);
    }
    // Other content that is not the source — the data sources, the bindings — is another request too; so is another page.
    await assert.rejects(genpage.update(OTHER, { source: SOURCE, prompt: 'change', dataSources: [], turnId: TURN }), (e) => e.code === 'GENPAGE_TURN_ID_REUSED');
    await assert.rejects(genpage.update(OTHER, { source: SOURCE, prompt: 'change', connectorBindings: [], turnId: TURN }), (e) => e.code === 'GENPAGE_TURN_ID_REUSED');
    await assert.rejects(genpage.update(APP_EXISTING_PAGE_ID, { source: SOURCE, prompt: 'change', turnId: TURN }), (e) => e.code === 'GENPAGE_TURN_ID_REUSED' && e.message.includes(`page ${OTHER}`));
    assert.deepStrictEqual([server.writes().length, server.published.length], [writes, published], 'nothing written, nothing published');
    assert.strictEqual(server.fileText(server.filesOf(OTHER).find((f) => /page\.tsx$/.test(f.filename)).id), SOURCE, 'the page still holds the first request\'s source');
    assert.strictEqual(app.state.publishAttempts, 0);

    // The SAME request again is the same intent, from any backend: read, found there, nothing sent twice.
    const again = await open().update(OTHER, { source: SOURCE, prompt: 'change', turnId: TURN });
    assert.strictEqual(again.unchanged, true);
  });
});

test('a caller turn id with no record store, or a store that cannot be read, is refused before anything is read; without a turn id no store is needed', async () => {
  await inWorld(async ({ server, open }) => {
    const bare = open({ turnBindings: undefined });
    await assert.rejects(bare.update(OTHER, { source: SOURCE, turnId: TURN }), (e) => e.code === 'GENPAGE_TURN_STATE_UNAVAILABLE' && e.outcome === 'nothing');
    await assert.rejects(bare.create({ name: 'X', source: SOURCE, turnId: TURN }), (e) => e.code === 'GENPAGE_TURN_STATE_UNAVAILABLE' && e.outcome === 'nothing');
    const broken = open({ turnBindings: { get: () => { throw new Error('disk gone'); }, bind: () => { throw new Error('disk gone'); } } });
    await assert.rejects(broken.update(OTHER, { source: SOURCE, turnId: TURN }), (e) => e.code === 'GENPAGE_TURN_STATE_UNAVAILABLE' && /disk gone/.test(e.message));
    await assert.rejects(broken.create({ name: 'X', source: SOURCE, turnId: TURN }), (e) => e.code === 'GENPAGE_TURN_STATE_UNAVAILABLE' && /disk gone/.test(e.message));
    assert.deepStrictEqual([server.requests.length, server.writes()], [0, []], 'not one request');

    const plain = await bare.update(OTHER, { source: SOURCE, prompt: 'change' });
    assert.strictEqual(plain.turn, undefined, 'the default identity is made here and needs no record');
  });
});

test('REAL BUNDLE: a create without a page id binds the id it made — a retry with the returned id and intent is the same request, not a reused turn', async () => {
  await inWorld(async ({ server, genpage, open }) => {
    const args = { name: 'Turned', source: SOURCE, dataSources: ['account'], prompt: 'make it', turnId: TURN };
    const created = await genpage.create(args);
    assert.strictEqual(created.turn.intent, turnIntentOf(created.pageId, { source: sourceText(SOURCE), name: 'Turned', dataSources: ['account'], model: undefined, connectorBindings: undefined, actionBindings: undefined }, args), 'the intent names the page id the create was sent under');
    const pages = server.state.projects.size;
    const messages = server.messagesOf(created.pageId).length;
    const retried = await open().create({ ...args, pageId: created.pageId, turnIntent: created.turn.intent });
    assert.strictEqual(retried.pageId, created.pageId);
    assert.deepStrictEqual([server.state.projects.size, server.messagesOf(created.pageId).length], [pages, messages], 'no second page, no second turn');
  });
});

test('REAL BUNDLE: a create whose answer was lost is resumed by a retry with the same turn id under the id it was sent under — never a second page under a new id', async () => {
  await inWorld(async ({ server, open }) => {
    const pages = server.state.projects.size;
    server.afterCommit = () => {
      server.failOn = (method) => (method === 'GET' ? 403 : undefined);
      lostResponse();
    };
    const args = { name: 'Lost', source: SOURCE, dataSources: ['account'], prompt: 'make it', turnId: TURN };
    let sentUnder;
    await assert.rejects(open().create(args), (e) => { sentUnder = e.pageId; return e.outcome === 'unknown'; });
    server.afterCommit = undefined;
    server.failOn = undefined;
    assert.strictEqual(server.state.projects.size, pages + 1, 'the first send landed');

    // A later run that never saw the id: the turn's record names it.
    const retried = await open().create(args);
    assert.strictEqual(retried.pageId, sentUnder);
    assert.strictEqual(server.state.projects.size, pages + 1, 'one page, not two');
    assert.strictEqual(server.messagesOf(sentUnder).filter((m) => m.message === 'make it').length, 1, 'one turn in the history');
  });
});

test('the file store of turn records keeps the FIRST record of an id, refuses a record it cannot read, and refuses a file system without hard links', () => {
  const dir = path.join(makeTempDir('genpage-turn-store-'), 'turns');
  const store = makeTurnBindingStore(dir);
  assert.strictEqual(store.get(TURN), null);
  assert.deepStrictEqual(store.bind(TURN, { pageId: OTHER, intent: 'a'.repeat(64) }), { formatVersion: 1, turnId: TURN, pageId: OTHER, intent: 'a'.repeat(64) });
  assert.strictEqual(makeTurnBindingStore(dir).bind(TURN, { pageId: OTHER, intent: 'b'.repeat(64) }).intent, 'a'.repeat(64), 'another store on the folder is held to the first record');
  assert.deepStrictEqual(fs.readdirSync(dir), [`${TURN}.json`], 'no temp file is left behind');

  const other = '0d3c1b2a-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
  fs.writeFileSync(path.join(dir, `${other}.json`), '');
  assert.throws(() => store.get(other));
  assert.throws(() => store.bind(other, { pageId: OTHER, intent: 'c'.repeat(64) }), 'a half-written record is never taken for a free id');

  const noLinks = makeTurnBindingStore(dir, { fs: { ...fs, linkSync: () => { throw Object.assign(new Error('no hard links here'), { code: 'EPERM' }); } } });
  const third = '11111111-2222-4333-8444-555555555555';
  assert.throws(() => noLinks.bind(third, { pageId: OTHER, intent: 'd'.repeat(64) }), (error) => error.reason === 'no-hard-links', 'a file system that cannot keep the first record is refused, never written around');
  assert.strictEqual(store.get(third), null, 'and no record of that id is left');
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), [`${other}.json`, `${TURN}.json`].sort(), 'nor any temp file');
});

// ── A draft never says more about the app that runs than was read ──

test('REAL BUNDLE: a draft of content the page already holds answers as a draft even when a publish receipt matches — no fingerprint, the draft reason', async () => {
  await inWorld(async ({ server, genpage }) => {
    const published = await genpage.update(OTHER, { source: SOURCE_2 });
    const attempts = server.published.length;
    const draft = await genpage.update(OTHER, { source: SOURCE_2, publish: false, publishedFingerprint: published.fingerprint });
    assert.deepStrictEqual([draft.unchanged, draft.publish.kind, draft.publish.reason, draft.saved, draft.pendingPublish, draft.fingerprint, draft.draftFingerprint], [true, 'skipped', 'draft', false, null, undefined, published.fingerprint]);
    assert.strictEqual(server.published.length, attempts);
  });
});

test('REAL BUNDLE: a draft removal of a page the app that runs never showed does not say that it still shows there — what it says is read from the published navigation', async () => {
  await inWorld(async ({ server, app, genpage }) => {
    await genpage.placeInApp(APP_ID, { pages: [{ pageId: OTHER, title: 'Other' }], publish: false });
    assert.ok(!namesPage(app.state.publishedXml, OTHER));
    const removed = await genpage.removeFromApp(APP_ID, OTHER, { publish: false });
    assert.deepStrictEqual([removed.appEdited, removed.published, removed.pendingPublish, removed.placementState, removed.liveState], [true, false, true, 'saved', 'not-shown']);
    assert.ok(!removed.warnings.some((w) => /still shows in the app that runs|cannot be deleted before then/.test(w)), removed.warnings.join(' | '));
    assert.ok(removed.warnings.some((w) => /the app that runs does not show it either/.test(w)));
    assert.strictEqual(app.state.publishAttempts, 0);

    // Published, then taken out as a draft: now the app that runs does show it, and the answer says so.
    await genpage.placeInApp(APP_ID, { pages: [{ pageId: OTHER, title: 'Other' }], finishIfUnpublished: true });
    const shown = await genpage.removeFromApp(APP_ID, OTHER, { publish: false });
    assert.strictEqual(shown.liveState, 'shown');
    assert.ok(shown.warnings.some((w) => /still shows in the app that runs until the app is published/.test(w)));
    const nothingToSave = await genpage.removeFromApp(APP_ID, OTHER, { publish: false });
    assert.deepStrictEqual([nothingToSave.placementState, nothingToSave.liveState, nothingToSave.pendingPublish], ['unchanged', 'shown', true]);
    assert.ok(server.state.projects.has(OTHER));
  });
});