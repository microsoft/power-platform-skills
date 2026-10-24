'use strict';
// The two reviewed built-in Dataverse operations (WhoAmI, RetrieveVersion) as page bindings through the REAL vendored SDK, over the stateful fake of the tables behind a page
// (helpers/fake-genpage-server.js).
//
// What only the real bundle can say: the four-key entries lib/dataverse-operations.js projects (toActionBinding), written beside an unrelated Custom API binding, are persisted in the page's
// config.json exactly — no property added, none dropped, the order kept — they are read back the same, a download states the whole list in the spec (no descriptor key reached the wire, so the
// list is not left out) and names them apart from the Custom APIs, and a rebuild that sends back what the download stated writes nothing. This proves persistence, not the player: no call of
// either operation is made or simulated here.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { makeGenpageSdk, pageFolderFiles } = require('../lib/genpage-sdk.js');
const { statedPageBindings } = require('../lib/app-spec.js');
const { getReviewedDataverseOperation, toActionBinding } = require('../lib/dataverse-operations.js');
const { parseDownloadedPages, pageBindingsReport, pageBindingsNote } = require('../download-model-app.js');
const { FakeGenPageServer, INSTANCE, ACCOUNT_TABLE, appTransport } = require('./helpers/fake-genpage-server.js');
const { makeTempDir } = require('./helpers/temp-dirs.js');

const SOURCE = "import * as React from 'react';\nexport default function Page() { return <div>Operations</div>; }\n";
const APPROVE = { name: 'contoso_ApproveOrder', isFunction: false, boundEntityLogicalName: 'account', displayName: 'Approve order', parameterKinds: { Comment: 'String' } };
const BINDINGS = [APPROVE, toActionBinding(getReviewedDataverseOperation('WhoAmI')), toActionBinding(getReviewedDataverseOperation('RetrieveVersion'))];

function makeServer() {
  const server = new FakeGenPageServer();
  server.serveTable(ACCOUNT_TABLE);
  return server;
}

async function withBackend(server, fn, { apps = false } = {}) {
  // A delete scans every app's navigation for the page first, so a cleanup runs over the fake's app tables too (appTransport).
  const genpage = makeGenpageSdk(INSTANCE, { httpClient: apps ? appTransport(server).http : server.http() });
  try {
    return await fn(genpage);
  } finally {
    await genpage.dispose();
  }
}

// What a download makes of a page the backend read: the folder it writes, read back as the spec's page entry.
function downloaded(page, unkept = []) {
  const root = makeTempDir('dv-ops-real-');
  const dir = path.join(root, page.id);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(pageFolderFiles(page))) fs.writeFileSync(path.join(dir, name), text, 'utf8');
  const [entry] = parseDownloadedPages(root, root, null, [], [], unkept);
  return entry;
}

const rows = (server, id) => Object.fromEntries(server.filesOf(id).map((f) => [f.filename, server.fileText(f.id)]));
const changeWrites = (server) => server.writes().filter((w) => !/PublishXml/.test(w));

test('REAL BUNDLE: both built-in projections beside a Custom API are persisted exactly, read back, stated whole by a download, and a rebuild of what it stated writes nothing', async () => {
  assert.deepStrictEqual(BINDINGS.slice(1), [
    { name: 'WhoAmI', isFunction: true, displayName: 'Current Dataverse identity', parameterKinds: {} },
    { name: 'RetrieveVersion', isFunction: true, displayName: 'Dataverse server version', parameterKinds: {} },
  ]);
  const server = makeServer();
  await withBackend(server, async (genpage) => {
    const made = await genpage.create({ name: 'Operations', source: SOURCE, dataSources: ['account'], model: 'gpt-4.1', actionBindings: BINDINGS, prompt: 'Show who I am', agentMessage: 'Shown' });
    const id = made.pageId;
    // Persisted: the page's own config.json row holds the list exactly, in its order, with nothing added.
    const config = JSON.parse(rows(server, id)['config.json']);
    assert.deepStrictEqual(config.actionBindings, BINDINGS);
    assert.deepStrictEqual(config.actionBindings.map((entry) => Object.keys(entry)), [
      ['name', 'isFunction', 'boundEntityLogicalName', 'displayName', 'parameterKinds'],
      ['name', 'isFunction', 'displayName', 'parameterKinds'],
      ['name', 'isFunction', 'displayName', 'parameterKinds'],
    ]);
    // Read back the same.
    const page = await genpage.read(id);
    assert.deepStrictEqual(page.actionBindings, BINDINGS);
    // Downloaded: the whole list is stated (a descriptor key on the wire would have left it out), and the report names the built-ins apart from the Custom API.
    const unkept = [];
    const entry = downloaded(page, unkept);
    assert.deepStrictEqual(unkept, []);
    assert.deepStrictEqual(entry.actionBindings, BINDINGS);
    const report = pageBindingsReport([{ ...entry, key: 'operations', name: 'Operations' }], unkept);
    assert.deepStrictEqual(report.neededInTarget, { customApis: ['contoso_ApproveOrder'], dataverseOperations: ['RetrieveVersion', 'WhoAmI'] });
    assert.doesNotMatch(pageBindingsNote(report).split('\n').find((line) => /built-in Dataverse operation/.test(line)), /deploy/i);
    // Rebuilt from what the download stated: nothing changes, so nothing is written.
    const before = rows(server, id);
    server.requests.length = 0;
    const out = await genpage.update(id, { source: SOURCE, name: 'Operations', dataSources: entry.dataSources, model: entry.model, ...statedPageBindings(entry), prompt: 'again', agentMessage: 'again' });
    assert.strictEqual(out.unchanged, true);
    assert.deepStrictEqual(changeWrites(server), [], 'the page already holds what the spec states');
    assert.deepStrictEqual(rows(server, id), before);
  });
});

test('REAL BUNDLE: an update that leaves the list out keeps the page\'s built-in bindings — nothing strips, repairs or reorders them — and a legacy entry is carried as it is', async () => {
  const legacy = [APPROVE, { name: 'WhoAmI' }];
  const server = makeServer();
  await withBackend(server, async (genpage) => {
    const made = await genpage.create({ name: 'Legacy', source: SOURCE, dataSources: ['account'], model: 'gpt-4.1', actionBindings: legacy, prompt: 'p', agentMessage: 'r' });
    // An unrelated edit: the update states no action list, so the page keeps its own.
    await genpage.update(made.pageId, { source: SOURCE.replace('Operations', 'Operations!'), name: 'Legacy', dataSources: ['account'], model: 'gpt-4.1', prompt: 'edit', agentMessage: 'edited' });
    assert.deepStrictEqual(JSON.parse(rows(server, made.pageId)['config.json']).actionBindings, legacy, 'no isFunction, display name or parameterKinds added');
    const entry = downloaded(await genpage.read(made.pageId));
    assert.deepStrictEqual(entry.actionBindings, legacy);
    assert.deepStrictEqual(pageBindingsReport([{ ...entry, key: 'legacy', name: 'Legacy' }], []).neededInTarget, { customApis: ['contoso_ApproveOrder'], dataverseOperations: ['WhoAmI'] });
  });
});

// ── Cleanup of a page that binds them, as a live check must prove it ─────────────────────────────────────────────────────────────────
// What a create answers is the page's identity, not an inventory: its file rows and conversation messages exist although the answer names none of
// them. So a cleanup starts from the page id, reads what the page holds (describe), deletes through the supported path, and reads every class back —
// and a child that survives keeps the cleanup incomplete, whatever the page's own read says.
test('REAL BUNDLE: a cleanup inventories a page\'s children by reading them, not from the create\'s answer, and proves each absent by reading it back', async () => {
  const server = makeServer();
  await withBackend(server, async (genpage) => {
    const made = await genpage.create({ name: 'Operations', source: SOURCE, dataSources: ['account'], model: 'gpt-4.1', actionBindings: BINDINGS, prompt: 'Show who I am', agentMessage: 'Shown' });
    const id = made.pageId;
    // The answer carries no list of the rows it made…
    assert.ok(!['files', 'fileRows', 'conversation', 'conversationMessages', 'messages'].some((key) => Object.hasOwn(made, key)), JSON.stringify(Object.keys(made)));
    // …and yet there are some: an omitted field is no evidence that nothing was made.
    assert.ok(server.filesOf(id).length > 0 && server.messagesOf(id).length > 0, 'the page has file rows and a conversation');
    const inventory = await genpage.describe(id);
    assert.ok(inventory.fileRows > 0 && inventory.conversationMessages === server.messagesOf(id).length, JSON.stringify(inventory));
    const removed = await genpage.delete(id, { allowDestructive: true });
    assert.deepStrictEqual([removed.deleted, removed.verified, removed.historyRemoved], [true, true, true]);
    // ALL ABSENT only by reads, class by class.
    assert.deepStrictEqual([server.filesOf(id).length, server.messagesOf(id).length], [0, 0]);
    await assert.rejects(genpage.describe(id), (error) => error.code === 'GENPAGE_NOT_FOUND');
  }, { apps: true });
});

test('REAL BUNDLE: a child the delete could not remove keeps the cleanup incomplete — the page reads as gone, its conversation does not', async () => {
  const server = makeServer();
  await withBackend(server, async (genpage) => {
    const made = await genpage.create({ name: 'Operations', source: SOURCE, dataSources: ['account'], model: 'gpt-4.1', actionBindings: BINDINGS, prompt: 'Show who I am', agentMessage: 'Shown' });
    const id = made.pageId;
    const messages = server.messagesOf(id).length;
    assert.ok(messages > 0);
    // The service refuses every delete of a conversation message: the page goes, its history stays.
    server.failOn = (method, path) => (method === 'DELETE' && /^\/agentconversationmessages\(/.test(path) ? 403 : undefined);
    const removed = await genpage.delete(id, { allowDestructive: true });
    assert.strictEqual(removed.verified, true, 'the page itself reads as gone');
    assert.strictEqual(removed.historyRemoved, false, 'and the result does not claim its history went with it');
    assert.ok(removed.warnings.some((warning) => /conversation history was not fully removed|may remain/.test(warning)), JSON.stringify(removed.warnings));
    assert.strictEqual(server.messagesOf(id).length, messages, 'a known child remains: the cleanup is not all absent until it is resolved and removed');
  }, { apps: true });
});
