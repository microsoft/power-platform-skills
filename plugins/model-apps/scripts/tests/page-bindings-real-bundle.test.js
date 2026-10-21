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
const { makeGenpageSdk, pageFolderFiles, contentFingerprint } = require('../lib/genpage-sdk.js');
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
// The reads of a page's rows that are NOT of the draft: a read without `MSCRM.IncludeUnpublished` is served the published layer.
const publishedLayerReads = (server) => server.requests.filter((r) => r.method === 'GET' && /^\/uxagentproject/.test(r.path) && !('MSCRM.IncludeUnpublished' in r.headers));
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

// ── a page that holds more than a spec states ────────────────────────────────────────────────────────────────────────────────
// A binding a page holds can carry what a spec does not state: a connection id of the environment it was made in, a credential someone wrote into a connectors.json, a property a later runtime adds. A download
// leaves such a list out of the spec WHOLE (page-bindings.js), so a rebuild sends nothing for it and the page keeps it. A list an AUTHOR states for such a page is read by the build as "what the page already
// holds" (`specBindings: true`): a binding the spec changes is changed, and what the spec does not state stays on the entry. The backend's other callers replace a list with what they give, as they always did.
const WEATHER_ON_PAGE = { ...WEATHER, connectionId: 'env-local-connection-placeholder', futureProperty: { kept: true } };
const SHAREPOINT_ON_PAGE = { ...SHAREPOINT, apiKey: 'SYNTHETIC_TEST_SECRET' };
const APPROVE_ON_PAGE = { ...APPROVE, headers: { note: 'kept' } };
const pageHolding = () => seededServer({ connectorBindings: [WEATHER_ON_PAGE, SHAREPOINT_ON_PAGE], actionBindings: [APPROVE_ON_PAGE] });
const SENT = { source: SOURCE, name: 'Weather', dataSources: ['account'], model: 'gpt-4.1', prompt: 'again', agentMessage: 'again' };
// What an author states for that page: the documented properties of each binding.
const AUTHORED = { connectorBindings: [WEATHER, SHAREPOINT], actionBindings: [APPROVE] };

// An identity a spec cannot state, beside a property a spec does not state, in BOTH kinds of list: a projection that kept the rest would write an entry with no identity, and a rebuild would REPLACE the
// page's entry with it — identity, connection id and all. The download leaves both lists out instead; the rebuild of that spec, with the record of the page's last publish, writes and publishes nothing.
test('REAL BUNDLE: a page whose lists hold an identity a spec cannot state is downloaded without those lists, and a rebuild of that spec writes nothing, publishes nothing, and keeps every entry as it was', async () => {
  const connector = { ...WEATHER, logicalName: 'Bearer SYNTHETIC_TEST_ACCESS_TOKEN', connectionId: 'env-local-connection-placeholder', futureProperty: { kept: true } };
  const action = { ...APPROVE, name: `ghp_${'R'.repeat(36)}`, headers: { note: 'kept' } };
  const server = seededServer({ connectorBindings: [connector, SHAREPOINT], actionBindings: [action] });
  await withBackend(server, async (genpage) => {
    const unkept = [];
    const { entry } = downloaded(await genpage.read(ID), unkept);
    assert.ok(!('connectorBindings' in entry) && !('actionBindings' in entry), 'neither list is in the spec: nothing is projected out of them');
    assert.deepStrictEqual(unkept.map((u) => [u.field, u.reason]), [
      ['connectorBindings', 'connectorBindings[0].logicalName must be an identifier (a letter, then letters, digits, _ . -)'],
      ['actionBindings', 'actionBindings[0].name must be an identifier (a letter, then letters, digits, _ . -)'],
    ]);
    assert.ok(!/SYNTHETIC|ghp_/.test(JSON.stringify(unkept)), 'the reason never quotes the value');

    // The build's record of the page's last publish, made by a build whose spec stated no lists — what a download into the same folder meets.
    const record = (await genpage.update(ID, { ...SENT })).fingerprint;
    const before = rows(server, ID);
    server.requests.length = 0;
    server.published.length = 0;
    const out = await genpage.update(ID, { ...SENT, ...statedPageBindings(entry), specBindings: true, publishedFingerprint: record });
    assert.deepStrictEqual([out.unchanged, out.publish.kind], [true, 'skipped']);
    assert.deepStrictEqual(server.writes(), [], 'not a row written and no PublishXml');
    assert.deepStrictEqual(server.published, []);
    assert.deepStrictEqual(rows(server, ID), before, 'every entry as it was: identity, connection id, the property no spec states');
    const held = JSON.parse(rows(server, ID)['config.json']);
    assert.deepStrictEqual([held.connectorBindings, held.actionBindings], [[connector, SHAREPOINT], [action]]);
  });
});

test('REAL BUNDLE: a list an author states for a page that holds more changes nothing when the page holds it — not one row is written — and other callers still replace a list', async () => {
  const server = pageHolding();
  await withBackend(server, async (genpage) => {
    const before = rows(server, ID);
    server.requests.length = 0;
    const out = await genpage.update(ID, { ...SENT, ...AUTHORED, specBindings: true });
    assert.strictEqual(out.unchanged, true, 'the page already holds what the spec states');
    assert.deepStrictEqual(changeWrites(server), [], 'not a row written');
    assert.deepStrictEqual(rows(server, ID), before, 'the page keeps what the spec does not state');
    // The other callers of the backend replace a list with the one they give, as they always did.
    await genpage.update(ID, { ...SENT, ...AUTHORED, prompt: 'replaced', agentMessage: 'replaced' });
    const replaced = JSON.parse(rows(server, ID)['config.json']);
    assert.deepStrictEqual([replaced.connectorBindings, replaced.actionBindings], [[WEATHER, SHAREPOINT], [APPROVE]]);
  });
});

test('REAL BUNDLE: a spec that changes one binding changes that binding, and the page keeps the rest of its entries as they were — what a spec does not state included', async () => {
  const server = pageHolding();
  await withBackend(server, async (genpage) => {
    const entry = AUTHORED;
    const messages = server.messagesOf(ID).length;
    // Weather's operations change, SharePoint is dropped, and the Custom API list is as it was.
    await genpage.update(ID, { ...SENT, connectorBindings: [{ ...entry.connectorBindings[0], operations: ['Forecast'] }], actionBindings: entry.actionBindings, specBindings: true });
    const config = JSON.parse(rows(server, ID)['config.json']);
    assert.deepStrictEqual(config.connectorBindings, [{ ...WEATHER_ON_PAGE, operations: ['Forecast'] }], 'the edited entry keeps its connection id and its property no spec states; the dropped entry is gone');
    assert.deepStrictEqual(config.actionBindings, [APPROVE_ON_PAGE], 'a list the edit left as the page held it is not rewritten');
    assert.deepStrictEqual(config.futureSetting, { kept: true });
    assert.strictEqual(server.messagesOf(ID).length, messages + 2, 'and the change is a turn of the conversation, as any update is');

    // A binding the spec adds is written as the spec states it; one whose name is changed is a new binding, and takes nothing of the old one's.
    const added = { logicalName: 'contoso_new', connectorId: '/providers/Microsoft.PowerApps/apis/shared_new', operations: ['Do'] };
    await genpage.update(ID, { ...SENT, connectorBindings: [{ ...WEATHER, operations: ['Forecast'] }, added], actionBindings: [{ ...APPROVE, name: 'contoso_Renamed' }], specBindings: true });
    const next = JSON.parse(rows(server, ID)['config.json']);
    assert.deepStrictEqual(next.connectorBindings, [{ ...WEATHER_ON_PAGE, operations: ['Forecast'] }, added]);
    assert.deepStrictEqual(next.actionBindings, [{ ...APPROVE, name: 'contoso_Renamed' }]);

    // `[]` is still a statement: it clears the list, and the entries with it.
    await genpage.update(ID, { ...SENT, connectorBindings: [], specBindings: true });
    assert.deepStrictEqual(JSON.parse(rows(server, ID)['config.json']).connectorBindings, []);
  });
});

test('REAL BUNDLE: the published copy of a page that holds more is read as holding the spec\'s lists, when the build says they are a spec\'s — no false "published again from elsewhere"', async () => {
  const server = pageHolding();
  await withBackend(server, async (genpage) => {
    const asked = { ...SENT, ...AUTHORED };
    // A first publish of the page as it is: the build's rebuild of a page nobody recorded.
    const first = await genpage.update(ID, { ...asked, specBindings: true });
    assert.strictEqual(first.publish.kind, 'verified');
    const plain = await genpage.publishedDiffers(ID, asked);
    assert.deepStrictEqual(plain.differing, ['connectorBindings', 'actionBindings'], 'read as another caller reads it, the published copy holds more than the spec states');
    const spec = await genpage.publishedDiffers(ID, { ...asked, specBindings: true });
    assert.deepStrictEqual(spec.differing, [], 'read as the build\'s lists, it holds them');
    assert.strictEqual(spec.fingerprint, first.fingerprint, 'and the fingerprint is the one an update answers for the same arguments');
    const changed = await genpage.publishedDiffers(ID, { ...asked, connectorBindings: [{ ...WEATHER, operations: ['Forecast'] }], specBindings: true });
    assert.deepStrictEqual(changed.differing, ['connectorBindings'], 'a list that differs from what was published still does');
  });
});

// ── a record of a publish made before a download stated the bindings ─────────────────────────────────────────────────────────
// The build keeps, per page, the hash of the content it published (contentFingerprint) and hands it back to the next update, which then does not publish a page it finds already holding that content. The hash covers
// the lists a caller states, so a record made when the build stated none (every record before a download states them) is the hash of the same content WITHOUT them. A page that holds those lists, rebuilt by the
// spec the download wrote, is the same content: it must not be written, and it must not be published again — only when the published copy is READ and holds the lists too.
const asPublishedByAnOlderBuild = async (genpage) => (await genpage.update(ID, { ...SENT })).fingerprint;

test('REAL BUNDLE: a record of a publish made before the lists were stated still stands for the page when a spec states them — nothing is written, nothing is published, and the record is renewed', async () => {
  const cases = [
    ['a page that holds exactly what the spec states', seededServer({ connectorBindings: [WEATHER], actionBindings: [APPROVE] }), { connectorBindings: [WEATHER], actionBindings: [APPROVE] }],
    ['a page that holds more', pageHolding(), { connectorBindings: [WEATHER, SHAREPOINT], actionBindings: [APPROVE] }],
  ];
  for (const [label, server, stated] of cases) {
    await withBackend(server, async (genpage) => {
      const legacy = await asPublishedByAnOlderBuild(genpage);
      assert.notStrictEqual(contentFingerprint({ source: SOURCE, name: 'Weather', dataSources: ['account'], model: 'gpt-4.1', ...stated }), legacy, `${label}: the lists are part of the hash`);
      server.requests.length = 0;
      server.published.length = 0;
      const out = await genpage.update(ID, { ...SENT, ...stated, specBindings: true, publishedFingerprint: legacy });
      assert.strictEqual(out.unchanged, true, label);
      assert.strictEqual(out.publish.kind, 'skipped', label);
      assert.strictEqual(out.receiptUpgraded, true, `${label}: the caller is told the record it holds can be renewed`);
      assert.strictEqual(out.fingerprint, contentFingerprint({ source: SOURCE, name: 'Weather', dataSources: ['account'], model: 'gpt-4.1', ...stated }), 'the renewed record is the hash of what the spec states');
      assert.deepStrictEqual(server.writes(), [], `${label}: no row written and no PublishXml`);
      assert.deepStrictEqual(server.published, [], label);
      assert.ok(publishedLayerReads(server).length > 0, `${label}: the published copy was read, to see that it holds the lists`);

      // The renewed record is the one a later update finds: it matches the hash as it is, and reads nothing of the published copy.
      server.requests.length = 0;
      const later = await genpage.update(ID, { ...SENT, ...stated, specBindings: true, publishedFingerprint: out.fingerprint });
      assert.deepStrictEqual([later.publish.kind, later.receiptUpgraded], ['skipped', undefined], label);
      assert.deepStrictEqual(server.writes(), [], label);
      assert.deepStrictEqual(publishedLayerReads(server), [], `${label}: the published copy is not read again`);
    });
  }
});

// A record can name ONE of the lists: a build whose spec stated a page's connector bindings and not its Custom API bindings (a list a download could not state, or one the author took out of the spec to keep the
// page's own) published the page with the hash of its content and that one list. A spec that then states the other list too, which the page holds, is the same content again: stating a list for the first time is
// not a change to the page, whichever list it is.
test('REAL BUNDLE: a record of a publish made when the spec stated ONE of the lists still stands when a spec states the other for the first time — nothing is written, nothing is published', async () => {
  const stated = { connectorBindings: [WEATHER], actionBindings: [APPROVE] };
  for (const [earlierList, newList] of [['connectorBindings', 'actionBindings'], ['actionBindings', 'connectorBindings']]) {
    const server = seededServer(stated);
    await withBackend(server, async (genpage) => {
      const earlier = await genpage.update(ID, { ...SENT, [earlierList]: stated[earlierList], specBindings: true });
      assert.strictEqual(earlier.publish.kind, 'verified', 'the earlier build published the page, and its record names one list');
      server.requests.length = 0;
      server.published.length = 0;
      const out = await genpage.update(ID, { ...SENT, ...stated, specBindings: true, publishedFingerprint: earlier.fingerprint });
      assert.deepStrictEqual([out.unchanged, out.publish.kind, out.receiptUpgraded], [true, 'skipped', true], `${newList} stated for the first time`);
      assert.strictEqual(out.fingerprint, contentFingerprint({ source: SOURCE, name: 'Weather', dataSources: ['account'], model: 'gpt-4.1', ...stated }), 'the renewed record names both lists');
      assert.deepStrictEqual(server.writes(), [], `${newList}: no row written and no PublishXml`);
      assert.deepStrictEqual(server.published, []);
      assert.ok(publishedLayerReads(server).length > 0, 'the published copy was read, to see that it holds the list the record does not name');
    });
  }

  // A record of OTHER content — the one list as it was before the spec changed it — is no record of this content, whatever the spec states now: the page is published, as it always was.
  const server = seededServer(stated);
  await withBackend(server, async (genpage) => {
    const other = contentFingerprint({ source: SOURCE, name: 'Weather', dataSources: ['account'], model: 'gpt-4.1', connectorBindings: [{ ...WEATHER, operations: ['Forecast'] }] });
    server.published.length = 0;
    const out = await genpage.update(ID, { ...SENT, ...stated, specBindings: true, publishedFingerprint: other });
    assert.deepStrictEqual([out.publish.kind, out.receiptUpgraded], ['verified', undefined]);
    assert.deepStrictEqual(server.published, [ID]);
  });
});

test('REAL BUNDLE: the record of an older publish is not taken for the lists when the published copy does not hold them — the page is published, as it always was', async () => {
  const server = seededServer({ connectorBindings: undefined, actionBindings: undefined });
  await withBackend(server, async (genpage) => {
    const legacy = await asPublishedByAnOlderBuild(genpage);
    // Another writer adds the lists to the draft of the page and does not publish: the published copy holds none, and the page's draft holds what the spec states.
    const config = JSON.parse(rows(server, ID)['config.json']);
    server.otherWorkspaceDraft(ID, 'config.json', JSON.stringify({ ...config, connectorBindings: [WEATHER], actionBindings: [APPROVE] }));
    server.requests.length = 0;
    server.published.length = 0;
    const out = await genpage.update(ID, { ...SENT, connectorBindings: [WEATHER], actionBindings: [APPROVE], specBindings: true, publishedFingerprint: legacy });
    assert.strictEqual(out.unchanged, true, 'the draft already holds the lists: nothing to write');
    assert.strictEqual(out.publish.kind, 'verified', 'but they were never published, and the record of the older publish says nothing of them');
    assert.strictEqual(out.receiptUpgraded, undefined);
    assert.deepStrictEqual(server.published, [ID]);
    assert.deepStrictEqual(server.writes(), ['POST /PublishXml'], 'the publish, and nothing else');
  });
});

test('REAL BUNDLE: a record of an older publish is a reason not to publish only for a page that already holds the content — one the spec changes is written and published whatever was recorded', async () => {
  const server = pageHolding();
  await withBackend(server, async (genpage) => {
    const legacy = await asPublishedByAnOlderBuild(genpage);
    server.requests.length = 0;
    server.published.length = 0;
    const out = await genpage.update(ID, { ...SENT, connectorBindings: [{ ...WEATHER, operations: ['Forecast'] }], actionBindings: [APPROVE], specBindings: true, publishedFingerprint: legacy });
    assert.strictEqual(out.unchanged, undefined);
    assert.strictEqual(out.publish.kind, 'verified');
    assert.deepStrictEqual(server.published, [ID]);
    assert.deepStrictEqual(JSON.parse(rows(server, ID)['config.json']).connectorBindings.map((b) => b.operations), [['Forecast']]);
  });
});

test('REAL BUNDLE: the record of an older publish is read as one that names the lists only for a caller that says its lists are a spec\'s — any other keeps what the record has always meant', async () => {
  const server = seededServer({ connectorBindings: [WEATHER], actionBindings: [APPROVE] });
  await withBackend(server, async (genpage) => {
    const legacy = await asPublishedByAnOlderBuild(genpage);
    server.requests.length = 0;
    server.published.length = 0;
    const out = await genpage.update(ID, { ...SENT, connectorBindings: [WEATHER], actionBindings: [APPROVE], publishedFingerprint: legacy });
    assert.strictEqual(out.publish.kind, 'verified', 'the hash is another content\'s: the page is published');
    assert.deepStrictEqual(server.published, [ID]);
  });
});
