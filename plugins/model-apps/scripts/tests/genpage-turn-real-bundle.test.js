'use strict';
// The caller-held page turn id (`turnId`) of the page backend (lib/genpage-sdk.js), through the REAL vendored SDK bundle over the stateful fake of the page tables
// (helpers/fake-genpage-server.js), with the turn record store on disk (lib/page-turn-store.js). What these pin:
//   - a turn id is bound to the COMPLETE request — content, whether a stated binding list is merged into the page's entries or replaces them, the messages, publication,
//     the publish receipt, the compiler and the environment — and any later use of it, from this backend or another, that asks for anything else is refused with nothing
//     written and nothing published (GENPAGE_TURN_ID_REUSED);
//   - the same request retried under its id after an answer was lost leaves ONE turn in the page's history, and a create retried without the page id resumes the page its
//     record names;
//   - a record that cannot establish the original request (an earlier format, a broken file, a malformed adapter answer) and a store that cannot be reached or cannot keep
//     the first record are refused with nothing written, and the record is left as it was;
//   - without a turn id nothing changes: no store is needed, no `turn` is answered, and the update mints its own identity as before.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { makeGenpageSdk, makeTurnBindingStore } = require('../lib/genpage-sdk.js');
const { sha256 } = require('../lib/hash.js');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { FakeGenPageServer, INSTANCE, ACCOUNT_TABLE, appTransport, APP_EXISTING_PAGE_ID } = require('./helpers/fake-genpage-server.js');

const OTHER = '77777777-7777-4777-8777-777777777777';
const TURN = '6f1c2a4e-9b3d-47a1-b85c-0e2f7d914a63';
const TURN_2 = '0d3c1b2a-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const SOURCE = "import * as React from 'react';\nexport default function Page() { return <div>Turn</div>; }\n";
const SOURCE_2 = "import * as React from 'react';\nexport default function Page() { return <div>Second</div>; }\n";
const CONNECTOR = '/providers/Microsoft.PowerApps/apis/shared_contoso';
const CONNECTION = '00000000-0000-4000-8000-000000000321';

async function inWorld(fn) {
  const server = new FakeGenPageServer();
  server.serveTable(ACCOUNT_TABLE);
  server.seedPage(APP_EXISTING_PAGE_ID, { name: 'Existing', config: { dataSources: ['account'], model: '' } });
  server.seedPage(OTHER, { name: 'Other', config: { dataSources: ['account'], model: '' }, prompt: 'Make it' });
  const app = appTransport(server);
  const made = [];
  // Every backend of one world binds turn ids in the same folder, through a store object of its own: what one backend (or process) bound, another is held to.
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

const lostResponse = () => { throw new Error('Request failed: read ECONNRESET'); };
// The commit lands and its answer is lost, and every read after it fails: the run cannot tell what happened.
const loseTheAnswer = (server) => {
  server.afterCommit = () => {
    server.failOn = (method) => (method === 'GET' ? 403 : undefined);
    lostResponse();
  };
};
const heal = (server) => { server.afterCommit = undefined; server.failOn = undefined; };
const recordFile = (turnsDir, turnId = TURN) => path.join(turnsDir, `${turnId}.json`);
const sourceOf = (server, id) => server.rowText(id, 'src/pages/page.tsx');
// What a refusal before any write leaves: no write request and no publish since `mark`.
const mark = (server) => ({ writes: server.writes().length, published: server.published.length });
const assertNothingWritten = (server, at, why) => assert.deepStrictEqual(mark(server), at, why || 'nothing written and nothing published');
const reused = (e) => e.code === 'GENPAGE_TURN_ID_REUSED' && e.outcome === 'nothing' && e.turnId === TURN;

// ── The binding mode is part of the request ──

test('REAL BUNDLE: a turn bound to a spec-merge of the binding lists is refused, from another backend, for a replacement of them — nothing written, the connection kept', async () => {
  await inWorld(async ({ server, genpage, open }) => {
    const held = { logicalName: 'contoso_service', connectorId: CONNECTOR, dataset: 'before', connectionId: CONNECTION };
    await genpage.update(OTHER, { source: SOURCE, connectorBindings: [held] });
    const stated = { logicalName: 'contoso_service', connectorId: CONNECTOR, dataset: 'after' };
    const first = await genpage.update(OTHER, { source: SOURCE_2, connectorBindings: [stated], specBindings: true, prompt: 'change', turnId: TURN });
    assert.match(first.turn.intent, /^[0-9a-f]{64}$/);
    assert.deepStrictEqual((await genpage.read(OTHER)).connectorBindings, [{ ...held, dataset: 'after' }], 'the merge kept the connection the spec could not state');
    const at = mark(server);
    const messages = server.messagesOf(OTHER).length;

    await assert.rejects(open().update(OTHER, { source: SOURCE_2, connectorBindings: [stated], specBindings: false, prompt: 'change', turnId: TURN }), reused);
    // Leaving the flag out is a replacement too.
    await assert.rejects(open().update(OTHER, { source: SOURCE_2, connectorBindings: [stated], prompt: 'change', turnId: TURN }), reused);
    assertNothingWritten(server, at);
    assert.strictEqual(server.messagesOf(OTHER).length, messages);
    assert.deepStrictEqual((await genpage.read(OTHER)).connectorBindings, [{ ...held, dataset: 'after' }], 'the connection is still there');
  });
});

test('REAL BUNDLE: a turn bound to a replacement of the binding lists is refused for a spec-merge of them', async () => {
  await inWorld(async ({ server, genpage, open }) => {
    const list = [{ logicalName: 'contoso_service', connectorId: CONNECTOR, dataset: 'only' }];
    await genpage.update(OTHER, { source: SOURCE, connectorBindings: list, prompt: 'change', turnId: TURN });
    const at = mark(server);
    await assert.rejects(open().update(OTHER, { source: SOURCE, connectorBindings: list, specBindings: true, prompt: 'change', turnId: TURN }), reused);
    assertNothingWritten(server, at);
  });
});

// ── The rest of the request ──

test('REAL BUNDLE: the same turn id for other content, messages, publication, receipt or page is refused before anything is written, with or without a kept intent', async () => {
  await inWorld(async ({ server, genpage, open }) => {
    const args = { source: SOURCE, prompt: 'change', turnId: TURN };
    const first = await genpage.update(OTHER, args);
    const at = mark(server);
    const others = [
      { ...args, source: SOURCE_2 },
      { ...args, prompt: 'another' },
      { ...args, agentMessage: 'Other reply' },
      { ...args, dataSources: [] },
      { ...args, connectorBindings: [] },
      { ...args, model: 'gpt' },
      { ...args, name: 'Renamed' },
      { ...args, publish: false },
      { ...args, publishedFingerprint: 'f'.repeat(64) },
      { ...args, turnIntent: 'f'.repeat(64) },
    ];
    for (const other of others) await assert.rejects(open().update(OTHER, other), reused, JSON.stringify(Object.keys(other)));
    await assert.rejects(open().update(APP_EXISTING_PAGE_ID, args), (e) => reused(e) && e.boundPageId === OTHER && e.message.includes(`page ${OTHER}`));
    await assert.rejects(open().create({ name: 'X', ...args }), reused, 'an update\'s turn is not a create\'s');
    assertNothingWritten(server, at);
    assert.strictEqual(sourceOf(server, OTHER), SOURCE, 'the page still holds the first request\'s source');

    // The same request again — from any backend, with the intent a result gave or without it — is the same turn: found there, nothing sent twice.
    for (const extra of [{}, { turnIntent: first.turn.intent }, { turnId: `{${TURN.toUpperCase()}}` }]) {
      const again = await open().update(OTHER, { ...args, ...extra });
      assert.deepStrictEqual([again.unchanged, again.turn.id, again.turn.intent], [true, TURN, first.turn.intent]);
    }
  });
});

test('REAL BUNDLE: a default the turn resolved from the page is bound too — the default prompt made from a name that changed since is another request', async () => {
  await inWorld(async ({ server, genpage, open }) => {
    await genpage.update(OTHER, { source: SOURCE, turnId: TURN });
    assert.deepStrictEqual(server.messagesOf(OTHER).map((m) => m.message).slice(-2), ['Generative page Other', 'Authored by app-builder']);
    await genpage.update(OTHER, { source: SOURCE, name: 'Renamed' });
    const at = mark(server);
    await assert.rejects(open().update(OTHER, { source: SOURCE, turnId: TURN }), (e) => reused(e) && /resolved messages/.test(e.message));
    assertNothingWritten(server, at);
  });
});

test('REAL BUNDLE: a turn bound in one environment is refused in another before anything is read', async () => {
  await inWorld(async ({ server, app, genpage, turnsDir }) => {
    await genpage.update(OTHER, { source: SOURCE, prompt: 'change', turnId: TURN });
    const requests = server.requests.length;
    const elsewhere = makeGenpageSdk('https://fabrikam.crm.dynamics.com', { httpClient: app.http, turnBindings: makeTurnBindingStore(turnsDir) });
    try {
      await assert.rejects(elsewhere.update(OTHER, { source: SOURCE, prompt: 'change', turnId: TURN }), (e) => reused(e) && /another environment/.test(e.message));
    } finally {
      await elsewhere.dispose();
    }
    assert.strictEqual(server.requests.length, requests, 'not one request');
  });
});

// ── A lost answer, retried ──

test('REAL BUNDLE: an update whose answer was lost, retried by a later run with the same turn id, leaves ONE turn in the page\'s history', async () => {
  await inWorld(async ({ server, genpage, open, turnsDir }) => {
    const turnsBefore = server.messagesOf(OTHER).length;
    loseTheAnswer(server);
    const args = { source: SOURCE, prompt: 'change', turnId: TURN };
    await assert.rejects(genpage.update(OTHER, args), (e) => e.outcome === 'unknown');
    heal(server);
    assert.strictEqual(server.messagesOf(OTHER).length, turnsBefore + 2, 'the first send landed');
    const record = JSON.parse(fs.readFileSync(recordFile(turnsDir), 'utf8'));

    const retried = await open().update(OTHER, args);
    assert.strictEqual(retried.unchanged, true, 'the retry reads the page and finds the update there');
    assert.deepStrictEqual(retried.turn, { id: TURN, intent: record.intentSha256, formatVersion: 2 });
    assert.strictEqual(server.messagesOf(OTHER).length, turnsBefore + 2, 'one turn in the history, not two');
  });
});

test('REAL BUNDLE: an update whose first send is stranded and lands late, after a retry under the same turn, leaves ONE turn — the turn\'s message rows are the ones the id names', async () => {
  await inWorld(async ({ server, genpage, open }) => {
    const known = new Set(server.messagesOf(OTHER).map((m) => m.id));
    // The first change set never reaches the server while anyone waits for it, and every read after it fails: the run cannot settle it.
    const first = server.batches.length + 1;
    server.strandBatch = (n) => {
      if (n !== first) return false;
      server.failOn = (method) => (method === 'GET' ? 403 : undefined);
      return true;
    };
    await assert.rejects(genpage.update(OTHER, { source: SOURCE, prompt: 'change', turnId: TURN }), (e) => e.outcome === 'unknown');
    server.strandBatch = undefined;
    server.failOn = undefined;
    const retried = await open().update(OTHER, { source: SOURCE, prompt: 'change', turnId: TURN });
    assert.ok(!retried.unchanged, 'the retry sent the turn');
    assert.strictEqual(retried.turn.id, TURN);
    // The stranded first send lands now: it addresses the same message rows, so its change set collides and is rolled back whole.
    await server.landStranded();
    const added = server.messagesOf(OTHER).filter((m) => !known.has(m.id));
    assert.deepStrictEqual(added.map((m) => m.message), ['change', 'Authored by app-builder'], 'one turn');
    assert.strictEqual(sourceOf(server, OTHER), SOURCE);
  });
});
test('REAL BUNDLE: an update that changes nothing records no turn — but binds the id, so the same id for other content is still refused', async () => {
  await inWorld(async ({ server, genpage, open }) => {
    await genpage.update(OTHER, { source: SOURCE, prompt: 'first' });
    const messages = server.messagesOf(OTHER).length;
    const out = await genpage.update(OTHER, { source: SOURCE, prompt: 'nothing to do', turnId: TURN });
    assert.deepStrictEqual([out.unchanged, out.turn.id], [true, TURN]);
    assert.strictEqual(server.messagesOf(OTHER).length, messages, 'no message was added');
    await assert.rejects(open().update(OTHER, { source: SOURCE_2, prompt: 'nothing to do', turnId: TURN }), reused);
  });
});

// ── Creates ──

test('REAL BUNDLE: a create whose answer was lost is resumed by a retry WITHOUT the page id — the record names it — giving one page and one turn', async () => {
  await inWorld(async ({ server, open, turnsDir }) => {
    const pages = server.state.projects.size;
    loseTheAnswer(server);
    const args = { name: 'Lost', source: SOURCE, dataSources: ['account'], prompt: 'make it', turnId: TURN };
    let sentUnder;
    await assert.rejects(open().create(args), (e) => { sentUnder = e.pageId; return e.outcome === 'unknown'; });
    heal(server);
    assert.strictEqual(server.state.projects.size, pages + 1, 'the first send landed');
    assert.strictEqual(JSON.parse(fs.readFileSync(recordFile(turnsDir), 'utf8')).pageId, sentUnder, 'the record names the page the create was sent under');

    const retried = await open({ newId: () => { throw new Error('a resumed create makes no new page id'); } }).create(args);
    assert.strictEqual(retried.pageId, sentUnder);
    assert.strictEqual(retried.turn.id, TURN);
    assert.strictEqual(server.state.projects.size, pages + 1, 'one page, not two');
    assert.strictEqual(server.messagesOf(sentUnder).filter((m) => m.message === 'make it').length, 1, 'one turn in the history');
    // And the page id is held to: the same request naming another page is another request.
    await assert.rejects(open().create({ ...args, pageId: OTHER }), (e) => reused(e) && e.boundPageId === sentUnder);
  });
});

test('REAL BUNDLE: a create binds before it makes the SDK — and with the page id it was given, a retry with the returned id and intent is the same request', async () => {
  await inWorld(async ({ server, genpage, open }) => {
    const args = { name: 'Turned', source: SOURCE, dataSources: ['account'], prompt: 'make it', turnId: TURN };
    const created = await genpage.create(args);
    const pages = server.state.projects.size;
    const messages = server.messagesOf(created.pageId).length;
    const retried = await open().create({ ...args, pageId: created.pageId, turnIntent: created.turn.intent });
    assert.deepStrictEqual([retried.pageId, retried.turn.intent], [created.pageId, created.turn.intent]);
    assert.deepStrictEqual([server.state.projects.size, server.messagesOf(created.pageId).length], [pages, messages], 'no second page, no second turn');
  });
});

test('REAL BUNDLE: a create that finds its page holding an earlier create\'s bindings merges a spec\'s lists into them, as its turn bound — the connection is kept', async () => {
  await inWorld(async ({ server, genpage, open }) => {
    const id = '12121212-3434-4565-8787-909090909090';
    const held = { logicalName: 'contoso_service', connectorId: CONNECTOR, dataset: 'before', connectionId: CONNECTION };
    // An earlier create under this id (a run that lost its answer, without a turn id) wrote the page with a connection bound.
    const earlier = await genpage.create({ pageId: id, name: 'Bound', source: SOURCE, dataSources: ['account'], connectorBindings: [held] });
    assert.strictEqual(earlier.pageId, id);
    const stated = { logicalName: 'contoso_service', connectorId: CONNECTOR, dataset: 'after' };
    // A later run: a backend of its own, whose workspace has never held the page.
    const created = await open().create({ pageId: id, name: 'Bound', source: SOURCE, dataSources: ['account'], connectorBindings: [stated], specBindings: true, prompt: 'again', turnId: TURN, sentBefore: [{ name: 'Bound', sourceSha256: sha256(SOURCE) }] });
    assert.strictEqual(created.turn.id, TURN);
    assert.ok(created.warnings.some((w) => /differing from this create in connectorBindings/.test(w)), 'brought to what this create asks for by the update');
    assert.deepStrictEqual((await open().read(id)).connectorBindings, [{ ...held, dataset: 'after' }], 'the spec\'s list was merged, not put in place of the page\'s');
    assert.strictEqual(server.messagesOf(id).filter((m) => m.message === 'again').length, 1);
  });
});

// ── Refusals before anything is written ──

test('a turn id is checked before anything is read — only a GUID (braces and capitals taken) — and a turn intent or context without one is refused', async () => {
  await inWorld(async ({ server, genpage }) => {
    for (const bad of [null, '', '   ', 'not-a-guid', `{${TURN}`, 42]) {
      await assert.rejects(genpage.update(OTHER, { source: SOURCE, turnId: bad }), (e) => e.code === 'GENPAGE_TURN_ID_INVALID' && e.outcome === 'nothing', JSON.stringify(bad));
      await assert.rejects(genpage.create({ name: 'X', source: SOURCE, turnId: bad }), (e) => e.code === 'GENPAGE_TURN_ID_INVALID' && e.outcome === 'nothing', JSON.stringify(bad));
    }
    await assert.rejects(genpage.update(OTHER, { source: SOURCE, turnIntent: 'a'.repeat(64) }), (e) => e.code === 'GENPAGE_TURN_ID_INVALID');
    await assert.rejects(genpage.create({ source: SOURCE, turnContext: { operation: 'upload-create' } }), (e) => e.code === 'GENPAGE_TURN_ID_INVALID');
    await assert.rejects(genpage.update(OTHER, { source: SOURCE, turnId: TURN, turnIntent: 'not hex' }), (e) => e.code === 'GENPAGE_ARGUMENT_INVALID');
    await assert.rejects(genpage.update(OTHER, { source: SOURCE, turnId: TURN, specBindings: 'yes' }), (e) => e.code === 'GENPAGE_ARGUMENT_INVALID');
    await assert.rejects(genpage.update(OTHER, { source: SOURCE, turnId: TURN, publishedFingerprint: 7 }), (e) => e.code === 'GENPAGE_ARGUMENT_INVALID');
    const sparse = [];
    sparse[1] = { logicalName: 'x' };
    await assert.rejects(genpage.update(OTHER, { source: SOURCE, turnId: TURN, connectorBindings: sparse }), (e) => e.code === 'GENPAGE_BINDING_INVALID' && e.outcome === 'nothing');
    assert.deepStrictEqual([server.requests.length, server.writes()], [0, []], 'not one request');
  });
});

test('a turn record that cannot establish the original request — an earlier format, a broken file, a malformed adapter answer — is refused, nothing written, the record kept', async () => {
  await inWorld(async ({ server, open, turnsDir }) => {
    fs.mkdirSync(turnsDir, { recursive: true });
    const v1 = `${JSON.stringify({ formatVersion: 1, turnId: TURN, pageId: OTHER, intent: 'a'.repeat(64) })}\n`;
    for (const text of [v1, '', '{"formatVersion":2', `${JSON.stringify({ formatVersion: 2, turnId: TURN })}\n`]) {
      fs.writeFileSync(recordFile(turnsDir), text);
      await assert.rejects(open().update(OTHER, { source: SOURCE, prompt: 'change', turnId: TURN }), (e) => e.code === 'GENPAGE_TURN_STATE_INCOMPLETE' && e.outcome === 'nothing' && /Do not use a new ID merely to retry an unresolved create/.test(e.message), JSON.stringify(text));
      await assert.rejects(open().create({ name: 'X', source: SOURCE, turnId: TURN }), (e) => e.code === 'GENPAGE_TURN_STATE_INCOMPLETE');
      assert.strictEqual(fs.readFileSync(recordFile(turnsDir), 'utf8'), text, 'the record is left exactly as it was');
    }
    const adapters = [
      { get: () => ({ formatVersion: 2, extra: true }), bind: () => null },
      { get: () => null, bind: (id, record) => ({ ...record, pageId: 'not-a-page' }) },
      { get: () => null, bind: (id, record) => ({ ...record, intentSha256: 'b'.repeat(64) }) },
      { get: () => null, bind: () => undefined },
    ];
    for (const turnBindings of adapters) {
      await assert.rejects(open({ turnBindings }).update(OTHER, { source: SOURCE, prompt: 'change', turnId: TURN }), (e) => e.code === 'GENPAGE_TURN_STATE_INCOMPLETE' && e.outcome === 'nothing');
    }
    assert.deepStrictEqual(server.writes(), [], 'nothing written');
  });
});

test('a turn id with no store, a store that cannot be reached, or one that cannot keep the first record is refused with nothing written', async () => {
  await inWorld(async ({ server, open, turnsDir }) => {
    const refusals = [
      [{ turnBindings: undefined }, /no turn record store/],
      [{ turnBindings: { get: () => { throw new Error('disk gone'); }, bind: () => null } }, /disk gone/],
      [{ turnBindings: { get: () => null, bind: () => { throw new Error('disk full'); } } }, /disk full/],
      [{ turnBindings: makeTurnBindingStore(turnsDir, { fs: { ...fs, linkSync: () => { throw Object.assign(new Error('no hard links here'), { code: 'EPERM' }); } } }) }, /second name for a file/],
    ];
    for (const [extra, says] of refusals) {
      const backend = open(extra);
      await assert.rejects(backend.update(OTHER, { source: SOURCE, prompt: 'change', turnId: TURN }), (e) => e.code === 'GENPAGE_TURN_STATE_UNAVAILABLE' && e.outcome === 'nothing' && says.test(e.message), String(says));
      await assert.rejects(backend.create({ name: 'X', source: SOURCE, turnId: TURN }), (e) => e.code === 'GENPAGE_TURN_STATE_UNAVAILABLE' && e.outcome === 'nothing', String(says));
    }
    assert.deepStrictEqual(server.writes(), [], 'nothing written');
    assert.ok(!fs.existsSync(recordFile(turnsDir)), 'no record was left');
    // A backend lent its SDK or compiler cannot name the compiler itself: its owner must.
    await assert.rejects(open({ createSdk: async () => { throw new Error('never made'); } }).update(OTHER, { source: SOURCE, turnId: TURN }), (e) => e.code === 'GENPAGE_TURN_STATE_UNAVAILABLE' && /turnCompilerIdentity/.test(e.message));
  });
});

// ── Without a turn id, nothing changes ──

test('REAL BUNDLE: without a turn id no store is needed, no turn is answered, and an update mints its own turn identity as before', async () => {
  await inWorld(async ({ server, open, turnsDir }) => {
    let minted = 0;
    const bare = open({ turnBindings: undefined, newTurnId: () => { minted += 1; return TURN_2; } });
    const updated = await bare.update(OTHER, { source: SOURCE, prompt: 'change', turnIntent: null, turnContext: null, turnId: undefined });
    assert.strictEqual('turn' in updated, false);
    assert.strictEqual(minted, 1, 'one identity minted for the update');
    const created = await bare.create({ name: 'Plain', source: SOURCE, dataSources: ['account'] });
    assert.strictEqual('turn' in created, false);
    assert.ok(server.state.projects.has(created.pageId));
    assert.ok(!fs.existsSync(turnsDir), 'nothing was recorded');
  });
});

test('REAL BUNDLE: a turn id changes nothing that is sent but the turn\'s identity — the same update with and without one sends the same requests', async () => {
  const run = (extra) => inWorld(async ({ server, open }) => {
    const out = await open({ newTurnId: () => TURN }).update(OTHER, { source: SOURCE, prompt: 'change', ...extra });
    return { requests: server.requests.map((r) => `${r.method} ${r.path}`), messages: server.messagesOf(OTHER).map((m) => [m.id, m.message]), publish: out.publish.kind };
  });
  assert.deepStrictEqual(await run({ turnId: TURN }), await run({}));
});
