'use strict';
// A page's connector and Custom API bindings through the REAL vendored SDK, over the stateful fake of the tables behind a page (helpers/fake-genpage-server.js).
//
// page-bindings.test.js holds the logic with a stand-in for the page backend. What only the real bundle can say, and what a download and a rebuild rest on:
//   - a page the maker laid out, with `connectorBindings` and `actionBindings` in its config.json, is read with both lists, and the folder a download writes holds them;
//   - the lists the download projects, sent back as the spec states them, change nothing — not one row is written — so a rebuild of a downloaded spec costs a page no write;
//   - a list that is changed is written, and what the page holds beside it (a property of config.json the SDK does not model, its prompt, its conversation) is kept;
//   - the same lists, given to a create in another environment, are in the config.json of the page that is made there.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeGenpageSdk, pageFolderFiles } = require('../lib/genpage-sdk.js');
const { statedPageBindings } = require('../lib/app-spec.js');
const { parseDownloadedPages, pageBindingsReport } = require('../download-model-app.js');
const { FakeGenPageServer, INSTANCE, ACCOUNT_TABLE } = require('./helpers/fake-genpage-server.js');

const SOURCE = "import * as React from 'react';\nexport default function Page() { return <div>Hello</div>; }\n";
const ID = 'd0000000-0000-4000-8000-000000000042';
const WEATHER = { logicalName: 'contoso_msnweather', connectorId: '/providers/Microsoft.PowerApps/apis/shared_msnweather', dataset: '', operations: ['CurrentWeather'] };
const SHAREPOINT = { logicalName: 'contoso_sharepoint', connectorId: '/providers/Microsoft.PowerApps/apis/shared_sharepointonline', dataset: 'https://contoso.sharepoint.com/sites/x', tables: ['11111111-2222-3333-4444-555555555555'], tableDisplayNames: ['Pets'] };
const APPROVE = { name: 'contoso_ApproveOrder', isFunction: false, boundEntityLogicalName: 'account', displayName: 'Approve order', parameterKinds: { Comment: 'String' } };

const tempDirs = [];
test.after(() => { for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true }); });

function makeServer() {
  const server = new FakeGenPageServer();
  server.serveTable(ACCOUNT_TABLE);
  return server;
}

// A backend over the real bundle, on a throwaway workspace that dispose() removes.
async function withBackend(server, fn) {
  const genpage = makeGenpageSdk(INSTANCE, { httpClient: server.http() });
  try {
    return await fn(genpage);
  } finally {
    await genpage.dispose();
  }
}

// What a download makes of a page the backend read: the folder it writes (lib/genpage-sdk.js pageFolderFiles), read back as the spec's page entry.
function downloaded(page, unkept = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'page-bindings-real-'));
  tempDirs.push(root);
  const dir = path.join(root, page.id);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(pageFolderFiles(page))) fs.writeFileSync(path.join(dir, name), text, 'utf8');
  const [entry] = parseDownloadedPages(root, root, null, [], [], unkept);
  return { entry, configText: fs.readFileSync(path.join(dir, 'config.json'), 'utf8') };
}

const changeWrites = (server) => server.writes().filter((w) => !/PublishXml/.test(w));
const rows = (server, id) => Object.fromEntries(server.filesOf(id).map((f) => [f.filename, server.fileText(f.id)]));

// The page the maker laid out: two lists, a data source, a model, and a property of config.json that the SDK has no field for.
function seededServer(config = {}) {
  const server = makeServer();
  server.seedPage(ID, {
    name: 'Weather', source: SOURCE, prompt: 'Show the weather', agentMessage: 'Shown',
    config: { dataSources: ['account'], model: 'gpt-4.1', connectorBindings: [WEATHER, SHAREPOINT], futureSetting: { kept: true }, actionBindings: [APPROVE], ...config },
  });
  return server;
}

test('REAL BUNDLE: a page the maker laid out is read with both binding lists, and the spec\'s page entry holds exactly what its config.json does', async () => {
  const server = seededServer();
  await withBackend(server, async (genpage) => {
    const page = await genpage.read(ID);
    assert.deepStrictEqual(page.connectorBindings, [WEATHER, SHAREPOINT]);
    assert.deepStrictEqual(page.actionBindings, [APPROVE]);
    const unkept = [];
    const { entry, configText } = downloaded(page, unkept);
    assert.deepStrictEqual(entry.connectorBindings, [WEATHER, SHAREPOINT]);
    assert.deepStrictEqual(entry.actionBindings, [APPROVE]);
    assert.deepStrictEqual(unkept, []);
    // The folder keeps the whole config.json, the property the spec has no field for included.
    assert.deepStrictEqual(JSON.parse(configText), { dataSources: ['account'], model: 'gpt-4.1', connectorBindings: [WEATHER, SHAREPOINT], futureSetting: { kept: true }, actionBindings: [APPROVE] });
    assert.deepStrictEqual(pageBindingsReport([{ ...entry, key: 'weather', name: 'Weather' }], []).neededInTarget, {
      connectionReferences: ['contoso_msnweather', 'contoso_sharepoint'], customApis: ['contoso_ApproveOrder'], serviceResources: ['contoso_sharepoint'],
    });
  });
});

test('REAL BUNDLE: the lists a download states, sent back by a rebuild, change nothing — not one row is written, and the page is not read as different', async () => {
  const server = seededServer();
  await withBackend(server, async (genpage) => {
    const { entry } = downloaded(await genpage.read(ID));
    const before = rows(server, ID);
    server.requests.length = 0;
    const out = await genpage.update(ID, { source: SOURCE, name: 'Weather', dataSources: entry.dataSources, model: entry.model, ...statedPageBindings(entry), prompt: 'again', agentMessage: 'again' });
    assert.strictEqual(out.unchanged, true);
    assert.deepStrictEqual(changeWrites(server), [], 'the page already holds what the spec states');
    assert.deepStrictEqual(rows(server, ID), before);
  });
});

test('REAL BUNDLE: a list that is changed is written, and everything else the page holds — a property the SDK does not model, the other list, its prompt and its conversation — is kept', async () => {
  const server = seededServer();
  await withBackend(server, async (genpage) => {
    const { entry } = downloaded(await genpage.read(ID));
    const messages = server.messagesOf(ID).map((m) => m.message);
    // The spec drops SharePoint from the connector list and clears nothing else: the Custom API list is not stated, so it is the page's own.
    await genpage.update(ID, { source: SOURCE, name: 'Weather', dataSources: entry.dataSources, model: entry.model, connectorBindings: [WEATHER], prompt: 'again', agentMessage: 'again' });
    const config = JSON.parse(rows(server, ID)['config.json']);
    assert.deepStrictEqual(config.connectorBindings, [WEATHER], 'the stated list is the page\'s now');
    assert.deepStrictEqual(config.actionBindings, [APPROVE], 'a list the update does not state is the page\'s own');
    assert.deepStrictEqual(config.futureSetting, { kept: true }, 'a property the SDK does not model is kept');
    assert.deepStrictEqual([config.dataSources, config.model], [['account'], 'gpt-4.1']);
    assert.deepStrictEqual(JSON.parse(rows(server, ID)['firstPrompt.json']), { userMessage: 'Show the weather', agentMessage: 'Shown' }, 'the first prompt is not rewritten');
    assert.deepStrictEqual(server.messagesOf(ID).map((m) => m.message).slice(0, messages.length), messages, 'the conversation it had is kept');

    // `[]` is a statement: it clears the list.
    await genpage.update(ID, { source: SOURCE, name: 'Weather', dataSources: entry.dataSources, model: entry.model, actionBindings: [], prompt: 'cleared', agentMessage: 'cleared' });
    const cleared = JSON.parse(rows(server, ID)['config.json']);
    assert.deepStrictEqual([cleared.actionBindings, cleared.connectorBindings], [[], [WEATHER]]);
  });
});

test('REAL BUNDLE: the lists a download stated, given to a create in ANOTHER environment, are in the config.json of the page that is made there — and a download of that page states them again', async () => {
  const source = seededServer();
  let entry;
  await withBackend(source, async (genpage) => { ({ entry } = downloaded(await genpage.read(ID))); });

  const target = makeServer();
  await withBackend(target, async (genpage) => {
    const out = await genpage.create({ name: 'Weather', source: SOURCE, dataSources: entry.dataSources, model: entry.model, ...statedPageBindings(entry), prompt: 'Show the weather', agentMessage: 'Shown' });
    const config = JSON.parse(rows(target, out.pageId)['config.json']);
    assert.deepStrictEqual(config, { dataSources: ['account'], model: 'gpt-4.1', connectorBindings: [WEATHER, SHAREPOINT], actionBindings: [APPROVE] });
    const again = downloaded(await genpage.read(out.pageId)).entry;
    assert.deepStrictEqual([again.connectorBindings, again.actionBindings], [entry.connectorBindings, entry.actionBindings]);
  });

  // And a create that is given none writes none: no key, no empty list.
  const plain = makeServer();
  await withBackend(plain, async (genpage) => {
    const out = await genpage.create({ name: 'Plain', source: SOURCE, dataSources: ['account'], model: 'gpt-4.1', prompt: 'p', agentMessage: 'r', ...statedPageBindings({ key: 'plain' }) });
    assert.deepStrictEqual(JSON.parse(rows(plain, out.pageId)['config.json']), { dataSources: ['account'], model: 'gpt-4.1' });
  });
});

test('REAL BUNDLE: a page whose config.json holds null, or an empty list, for a binding list is downloaded as a page that holds none — nothing is stated and nothing is reported', async () => {
  const server = seededServer({ connectorBindings: null, actionBindings: [] });
  await withBackend(server, async (genpage) => {
    const unkept = [];
    const { entry } = downloaded(await genpage.read(ID), unkept);
    assert.ok(!('connectorBindings' in entry) && !('actionBindings' in entry));
    assert.deepStrictEqual(unkept, []);
    assert.strictEqual(pageBindingsReport([{ ...entry, key: 'weather', name: 'Weather' }], unkept), null);
  });
});
