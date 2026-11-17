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
const { makeGenpageSdk, makeTurnBindingStore, readTurnRecord } = require('../lib/genpage-sdk.js');
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

// ── Every backend that can write under a turn bound to a spec-merge ──
// The binding mode is a part of the request on every path that can write under the turn: the backend that wrote the page before (its workspace still knows the page, so a
// create there would be sent as a change to it), a backend of a later run, a create resumed under the id its record names, an update after the create, and the update a create
// hands a page it found to. Each keeps the mode it bound, and each refuses another mode with nothing written.

const PINNED = '12121212-3434-4565-8787-909090909090';
const HELD = { logicalName: 'contoso_service', connectorId: CONNECTOR, dataset: 'before', connectionId: CONNECTION };
const STATED = { logicalName: 'contoso_service', connectorId: CONNECTOR, dataset: 'after' };
const MERGED = [{ ...HELD, dataset: 'after' }];
const pinnedCreate = (extra) => ({ pageId: PINNED, name: 'Bound', source: SOURCE, dataSources: ['account'], connectorBindings: [STATED], prompt: 'again', ...extra });

test('REAL BUNDLE: a create under a spec-merge turn, from the backend that wrote the page before, merges the spec\'s lists — and every backend refuses that turn in another mode, nothing written', async () => {
  await inWorld(async ({ server, genpage, open }) => {
    // An earlier create under this id, from THIS backend: its workspace still holds the page.
    await genpage.create({ pageId: PINNED, name: 'Bound', source: SOURCE, dataSources: ['account'], connectorBindings: [HELD] });
    const created = await genpage.create(pinnedCreate({ specBindings: true, turnId: TURN }));
    assert.strictEqual(created.turn.id, TURN);
    assert.strictEqual(created.publish.kind, 'verified');
    assert.deepStrictEqual((await open().read(PINNED)).connectorBindings, MERGED, 'the spec\'s list was merged into the page\'s, not put in its place: the connection is kept');
    assert.deepStrictEqual((await open().publishedDiffers(PINNED, { name: 'Bound', source: SOURCE, dataSources: ['account'], connectorBindings: MERGED })).differing, [], 'and that is what was published');
    assert.strictEqual(server.messagesOf(PINNED).filter((m) => m.message === 'again').length, 1);

    const at = mark(server);
    const messages = server.messagesOf(PINNED).length;
    for (const backend of [genpage, open()]) {
      for (const flip of [{ specBindings: false }, {}]) {
        await assert.rejects(backend.create(pinnedCreate({ ...flip, turnId: TURN })), reused, `create ${JSON.stringify(flip)}`);
        await assert.rejects(backend.create(pinnedCreate({ ...flip, pageId: undefined, turnId: TURN })), reused, `create without the page id ${JSON.stringify(flip)}`);
        await assert.rejects(backend.update(PINNED, pinnedCreate({ ...flip, pageId: undefined, turnId: TURN })), reused, `update ${JSON.stringify(flip)}`);
      }
    }
    assertNothingWritten(server, at);
    assert.strictEqual(server.messagesOf(PINNED).length, messages);
    assert.deepStrictEqual((await open().read(PINNED)).connectorBindings, MERGED, 'the connection is still there');

    // The same request again, from either backend, with or without the page id, is the same turn: nothing sent twice, the connection kept.
    for (const backend of [genpage, open()]) {
      for (const extra of [{}, { pageId: undefined }]) {
        const again = await backend.create(pinnedCreate({ specBindings: true, turnId: TURN, ...extra }));
        assert.deepStrictEqual([again.pageId, again.turn.intent], [PINNED, created.turn.intent]);
      }
    }
    assert.strictEqual(server.messagesOf(PINNED).length, messages, 'one turn in the history');
    assert.deepStrictEqual((await open().read(PINNED)).connectorBindings, MERGED);
  });
});

test('REAL BUNDLE: a create under a replacement turn, from the backend that wrote the page before, replaces the lists as it bound — the mode is the turn\'s, not a default', async () => {
  await inWorld(async ({ server, genpage, open }) => {
    await genpage.create({ pageId: PINNED, name: 'Bound', source: SOURCE, dataSources: ['account'], connectorBindings: [HELD] });
    await genpage.create(pinnedCreate({ turnId: TURN }));
    assert.deepStrictEqual((await open().read(PINNED)).connectorBindings, [STATED], 'the list given is the page\'s list');
    const at = mark(server);
    await assert.rejects(genpage.create(pinnedCreate({ specBindings: true, turnId: TURN })), reused);
    assertNothingWritten(server, at);
  });
});

// A create under a turn that finds its page before sending (the read above) still sends nothing the caller's `beforeSend` refuses: the gate runs once, after the page is
// known to be this create's and before the update or the publish that takes it over.
const refusingGate = () => {
  const gate = { calls: 0 };
  gate.beforeSend = async () => { gate.calls += 1; throw Object.assign(new Error('host refused send'), { code: 'HOST_REFUSED' }); };
  return gate;
};
test('REAL BUNDLE: a beforeSend that refuses stops a create under a turn that found its page — one that differs (an update) and one that matches (a publish) — with nothing written or published', async () => {
  const cases = [
    ['differs: brought to the request by an update', [HELD], { specBindings: true }],
    ['matches: published as it is', [STATED], {}],
  ];
  for (const [what, held, mode] of cases) {
    await inWorld(async ({ server, genpage, open }) => {
      await genpage.create({ pageId: PINNED, name: 'Bound', source: SOURCE, dataSources: ['account'], connectorBindings: held });
      const at = mark(server);
      const messages = server.messagesOf(PINNED).length;
      const gate = refusingGate();
      await assert.rejects(genpage.create(pinnedCreate({ ...mode, turnId: TURN, beforeSend: gate.beforeSend })), (e) => e.code === 'HOST_REFUSED' && e.pageId === PINNED, what);
      assert.strictEqual(gate.calls, 1, `${what}: the gate is called once`);
      assertNothingWritten(server, at, `${what}: nothing written and nothing published`);
      assert.strictEqual(server.messagesOf(PINNED).length, messages, what);
      assert.deepStrictEqual((await open().read(PINNED)).connectorBindings, held, `${what}: the page is as it was`);
    });
  }
});

test('REAL BUNDLE: a beforeSend that accepts is called once on every create path — a turn create that finds its page (differs or matches), one that does not, and a create without a turn', async () => {
  const counting = () => { const gate = { calls: [], beforeSend: async (id, sent) => { gate.calls.push([id, sent.name]); } }; return gate; };
  await inWorld(async ({ server, genpage, open }) => {
    await genpage.create({ pageId: PINNED, name: 'Bound', source: SOURCE, dataSources: ['account'], connectorBindings: [HELD] });
    const differs = counting();
    const merged = await genpage.create(pinnedCreate({ specBindings: true, turnId: TURN, beforeSend: differs.beforeSend }));
    assert.deepStrictEqual(differs.calls, [[PINNED, 'Bound']]);
    assert.strictEqual(merged.publish.kind, 'verified');
    assert.deepStrictEqual((await open().read(PINNED)).connectorBindings, MERGED);
    const matches = counting();
    await genpage.create(pinnedCreate({ specBindings: true, turnId: TURN, beforeSend: matches.beforeSend }));
    assert.deepStrictEqual(matches.calls, [[PINNED, 'Bound']], 'the same request again: the gate before its publish');
    const absent = counting();
    const fresh = await genpage.create({ pageId: '34343434-5656-4787-8989-010101010101', name: 'Fresh', source: SOURCE, turnId: TURN_2, beforeSend: absent.beforeSend });
    assert.deepStrictEqual(absent.calls, [[fresh.pageId, 'Fresh']]);
    const plain = counting();
    const made = await genpage.create({ name: 'Plain', source: SOURCE, beforeSend: plain.beforeSend });
    assert.deepStrictEqual(plain.calls, [[made.pageId, 'Plain']]);
    assert.ok(server.published.includes(made.pageId));
  });
});
test('REAL BUNDLE: a spec-merge create whose answer was lost, retried from the same backend and from another, leaves one turn and keeps the connection', async () => {
  await inWorld(async ({ server, genpage, open }) => {
    await genpage.create({ pageId: PINNED, name: 'Bound', source: SOURCE, dataSources: ['account'], connectorBindings: [HELD] });
    loseTheAnswer(server);
    const args = pinnedCreate({ specBindings: true, turnId: TURN });
    await assert.rejects(genpage.create(args), (e) => e.outcome === 'unknown' && e.pageId === PINNED);
    heal(server);
    assert.deepStrictEqual((await open().read(PINNED)).connectorBindings, MERGED, 'the send that landed merged');
    const again = await genpage.create(args);
    assert.strictEqual(again.turn.id, TURN);
    await open().create({ ...args, pageId: undefined });
    assert.strictEqual(server.messagesOf(PINNED).filter((m) => m.message === 'again').length, 1, 'one turn');
    assert.deepStrictEqual((await open().read(PINNED)).connectorBindings, MERGED);
  });
});

test('REAL BUNDLE: a spec-merge create whose page an earlier create lands on just before its own send merges into what landed, from the backend that staged the page', async () => {
  await inWorld(async ({ server, genpage, open }) => {
    const earlier = open();
    // The page is not there when the create looks, so it stages it — and an earlier create under the id lands before the staged page is sent.
    const created = await genpage.create(pinnedCreate({
      specBindings: true, turnId: TURN, sentBefore: [{ name: 'Bound', sourceSha256: sha256(SOURCE) }],
      beforeSend: async () => { await earlier.create({ pageId: PINNED, name: 'Bound', source: SOURCE, dataSources: ['account'], connectorBindings: [HELD] }); },
    }));
    assert.strictEqual(created.turn.id, TURN);
    assert.deepStrictEqual((await open().read(PINNED)).connectorBindings, MERGED, 'merged into what landed: the connection is kept');
    assert.deepStrictEqual((await open().publishedDiffers(PINNED, { name: 'Bound', source: SOURCE, dataSources: ['account'], connectorBindings: MERGED })).differing, []);
    assert.strictEqual(server.messagesOf(PINNED).filter((m) => m.message === 'again').length, 1);
  });
});
test('REAL BUNDLE: a create under a turn, from a backend that holds a copy of a page since deleted under the id, makes the page new — it is not sent as a change to the copy', async () => {
  await inWorld(async ({ server, genpage, open }) => {
    await genpage.create({ pageId: PINNED, name: 'Bound', source: SOURCE, dataSources: ['account'], connectorBindings: [HELD] });
    await open().delete(PINNED, { allowDestructive: true });
    assert.ok(!server.state.projects.has(PINNED));
    const created = await genpage.create(pinnedCreate({ specBindings: true, turnId: TURN }));
    assert.deepStrictEqual([created.pageId, created.turn.id, created.publish.kind], [PINNED, TURN, 'verified']);
    const page = await open().read(PINNED);
    assert.deepStrictEqual([page.name, page.connectorBindings], ['Bound', [STATED]], 'a new page holds the list as given: there is nothing to merge into');
    assert.strictEqual(server.messagesOf(PINNED).filter((m) => m.message === 'again').length, 1);
  });
});
test('REAL BUNDLE: a create under a turn whose page cannot be read first sends nothing — from the backend that knows the page, too — and says the page may exist', async () => {
  await inWorld(async ({ server, genpage }) => {
    await genpage.create({ pageId: PINNED, name: 'Bound', source: SOURCE, dataSources: ['account'], connectorBindings: [HELD] });
    const at = mark(server);
    server.failOn = (method) => (method === 'GET' ? 403 : undefined);
    await assert.rejects(genpage.create(pinnedCreate({ specBindings: true, turnId: TURN })), (e) => e.code === 'GENPAGE_UNREADABLE' && e.outcome === 'unknown' && e.pageId === PINNED);
    heal(server);
    assertNothingWritten(server, at);
    assert.deepStrictEqual((await genpage.read(PINNED)).connectorBindings, [HELD]);
  });
});
test('REAL BUNDLE: an upload create retried with the page id its unfinished first attempt returned is the same create — one page, one turn — and the same turn as an upload update is refused', async () => {
  await inWorld(async ({ server, open }) => {
    const context = { operation: 'upload-create', appId: null, solution: null, overwriteDeployed: false, navigation: null };
    const args = { name: 'Upload', source: SOURCE, prompt: 'make', turnId: TURN, turnContext: context };
    const pages = server.state.projects.size;
    loseTheAnswer(server);
    let returned;
    await assert.rejects(open().create(args), (e) => { returned = e.pageId; return e.outcome === 'unknown'; });
    heal(server);
    const at = mark(server);
    // The caller dispatches by the turn's record: a create stays a create, under the id it returned.
    await assert.rejects(open().update(returned, { ...args, turnContext: { ...context, operation: 'upload-update' } }), (e) => reused(e) && /bound to a page upload-create, and this is a page upload-update/.test(e.message));
    await assert.rejects(open().update(returned, args), (e) => e.code === 'GENPAGE_ARGUMENT_INVALID' && e.outcome === 'nothing', 'an update cannot carry a create\'s context');
    assertNothingWritten(server, at);
    const resumed = await open({ newId: () => { throw new Error('a resumed create makes no new page id'); } }).create({ ...args, pageId: returned });
    assert.deepStrictEqual([resumed.pageId, resumed.turn.id], [returned, TURN]);
    assert.strictEqual(server.state.projects.size, pages + 1, 'one page');
    assert.strictEqual(server.messagesOf(returned).filter((m) => m.message === 'make').length, 1, 'one turn');
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

test('a store that answers a read with nothing at all (undefined) is a malformed answer, not "no record": refused before a bind, nothing written — only null is "no record"', async () => {
  await inWorld(async ({ server, open }) => {
    let binds = 0;
    const counting = (get) => ({ get, bind: (id, record) => { binds += 1; return record; } });
    await assert.rejects(open({ turnBindings: counting(() => undefined) }).update(OTHER, { source: SOURCE, turnId: TURN }), (e) => e.code === 'GENPAGE_TURN_STATE_INCOMPLETE' && e.outcome === 'nothing');
    await assert.rejects(open({ turnBindings: counting(async () => undefined) }).create({ name: 'X', source: SOURCE, turnId: TURN }), (e) => e.code === 'GENPAGE_TURN_STATE_INCOMPLETE' && e.outcome === 'nothing');
    assert.deepStrictEqual([binds, server.writes()], [0, []], 'nothing bound, nothing written');
    // null is "no record": the first use binds the id and writes.
    const first = await open({ turnBindings: counting(() => null) }).update(OTHER, { source: SOURCE, turnId: TURN });
    assert.deepStrictEqual([binds, first.turn.id], [1, TURN]);
  });
});

test('a turn record that cannot be reached, after a create whose outcome is unknown, is advised to be made reachable again or resolved — never to be retried without its id or under a new one', async () => {
  await inWorld(async ({ server, open, turnsDir }) => {
    const args = { name: 'Lost result', source: SOURCE, turnId: TURN };
    loseTheAnswer(server);
    await assert.rejects(open().create(args), (e) => e.outcome === 'unknown');
    heal(server);
    const unreachable = [
      { turnBindings: { get: () => { throw Object.assign(new Error('disk unavailable'), { code: 'EIO' }); }, bind: () => null } },
      { turnBindings: { get: () => null, bind: () => { throw new Error('disk full'); } } },
      { turnBindings: undefined },
      // A store with no record of the turn (another folder) that cannot keep a first one either.
      { turnBindings: makeTurnBindingStore(path.join(path.dirname(turnsDir), 'elsewhere'), { fs: { ...fs, linkSync: () => { throw Object.assign(new Error('no hard links here'), { code: 'EPERM' }); } } }) },
      { createSdk: async () => { throw new Error('never made'); } },
    ];
    for (const extra of unreachable) {
      await assert.rejects(open(extra).create(args), (e) => {
        assert.strictEqual(e.code, 'GENPAGE_TURN_STATE_UNAVAILABLE');
        assert.doesNotMatch(e.message, /leave the turn id out/i);
        assert.match(e.message, /Nothing was changed by this attempt/);
        assert.match(e.message, /may still be unresolved/);
        assert.match(e.message, /Do not run it without its turn id or under a new one/);
        return true;
      }, Object.keys(extra).join());
    }
  });
});
test('readTurnRecord — for a caller that decides what its run is by the turn — answers the record or null, and refuses what a write under the turn would refuse, in the same words', async () => {
  await inWorld(async ({ genpage, turnsDir }) => {
    const store = makeTurnBindingStore(turnsDir);
    assert.strictEqual(await readTurnRecord(store, TURN), null);
    const context = { operation: 'upload-create', appId: null, solution: null, overwriteDeployed: false, navigation: null };
    const created = await genpage.create({ name: 'Read', source: SOURCE, turnId: TURN, turnContext: context });
    const record = await readTurnRecord(store, `{${TURN.toUpperCase()}}`);
    assert.deepStrictEqual([record.operation, record.pageId, record.intentSha256], ['upload-create', created.pageId, created.turn.intent]);
    const refusals = [
      [{ get: () => { throw Object.assign(new Error('disk unavailable'), { code: 'EIO' }); } }, 'GENPAGE_TURN_STATE_UNAVAILABLE'],
      [undefined, 'GENPAGE_TURN_STATE_UNAVAILABLE'],
      [{ get: () => undefined }, 'GENPAGE_TURN_STATE_INCOMPLETE'],
      [{ get: () => ({ formatVersion: 1, turnId: TURN }) }, 'GENPAGE_TURN_STATE_INCOMPLETE'],
    ];
    for (const [given, code] of refusals) {
      await assert.rejects(readTurnRecord(given, TURN), (e) => e.code === code && e.outcome === 'nothing' && !/leave the turn id out/i.test(e.message), code);
    }
    await assert.rejects(readTurnRecord(store, 'not-a-guid'), (e) => e.code === 'GENPAGE_TURN_ID_INVALID');
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
