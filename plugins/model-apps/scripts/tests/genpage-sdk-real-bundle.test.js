'use strict';
// lib/genpage-sdk.js against the REAL vendored SDK bundle (not a stand-in), over a stateful fake of the Dataverse tables behind a page
// (helpers/fake-genpage-server.js — a port of the fake the SDK's own tests drive). What these prove that the logic tests cannot: the
// SDK itself accepts what the backend sends, the rows it writes are the ones a page is made of, an untouched push writes nothing, an
// update writes only the rows that changed, a page that does not compile writes nothing, and a lost response on the one atomic
// change set leaves exactly the two states the backend's settling logic assumes — landed, or nothing.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeGenpageSdk, pageFolderFiles, contentFingerprint } = require('../lib/genpage-sdk.js');
const { FakeGenPageServer, INSTANCE, ACCOUNT_TABLE: accountTable } = require('./helpers/fake-genpage-server.js');
const { sha256 } = require('../lib/hash.js');

const SOURCE = "import * as React from 'react';\nexport default function Page() { return <div>Hello</div>; }\n";
const PAGE_TSX = 'src/pages/page.tsx';
const PAGE_COMPILED = 'src/pages/page.compiled';

function makeServer() {
  const server = new FakeGenPageServer();
  server.serveTable(accountTable);
  return server;
}

// A backend on the default path — the real bundle through lib/maker-sdk.js, on a throwaway workspace folder — whose folders are
// recorded, so a test can prove they exist while it works and are gone after dispose().
function harness(server, deps = {}) {
  const made = [];
  const genpage = makeGenpageSdk(INSTANCE, {
    httpClient: server.http(),
    mkdtempSync: (prefix) => { const dir = fs.mkdtempSync(prefix); made.push(dir); return dir; },
    ...deps,
  });
  return { genpage, made };
}

async function withBackend(server, fn, deps) {
  const { genpage, made } = harness(server, deps);
  try {
    return await fn(genpage);
  } finally {
    await genpage.dispose();
    for (const dir of made) assert.ok(!fs.existsSync(dir), `the throwaway workspace ${dir} is removed by dispose()`);
  }
}

// What the server holds of a page: the text of the rows of its folder and its conversation. Not the etags: a publish rotates the token of the
// project and of every row without changing a byte (measured), so a token proves nothing about a write — the requests that were made do.
const snapshot = (server, id) => ({
  files: Object.fromEntries(server.filesOf(id).map((f) => [f.filename, server.fileText(f.id)])),
  messages: server.messagesOf(id).map((m) => m.message),
});
const changeWrites = (server) => server.writes().filter((w) => !/PublishXml/.test(w));
// The writes as a test can read them — `PATCH /uxagentprojectfiles(<id>)/filecontent` becomes `PATCH file src/pages/page.tsx`.
const describeWrites = (server, pageId) => {
  const names = Object.fromEntries(server.filesOf(pageId).map((f) => [f.id, f.filename]));
  return changeWrites(server).map((w) => w
    .replace(/\/uxagentprojectfiles\(([^)]+)\)\/filecontent/, (m, id) => `file ${names[id]}`)
    .replace(/\/uxagentprojects\([^)]+\)/, 'project'));
};
const lostResponse = () => { throw new Error('Request failed: read ECONNRESET'); };

test('REAL BUNDLE: create writes the rows a page is made of, byte for byte, and publishes it; fetching it back round-trips every field', async () => {
  const server = makeServer();
  await withBackend(server, async (genpage) => {
    const out = await genpage.create({ name: 'Overview', source: Buffer.from(`\uFEFF${SOURCE}`, 'utf8'), dataSources: 'Account', model: 'gpt-4.1', prompt: 'Make an overview', agentMessage: 'Made it' });
    assert.match(out.pageId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'a lower-case v4 id minted on the client');
    assert.strictEqual(out.publish.kind, 'verified');
    assert.deepStrictEqual(out.warnings, []);
    assert.deepStrictEqual(server.published, [out.pageId], 'published once, by id');

    const held = snapshot(server, out.pageId);
    assert.strictEqual(held.files[PAGE_TSX], SOURCE, 'the bytes given, less the BOM — and no CRLF appended');
    assert.ok(held.files[PAGE_COMPILED].length > 0, 'the SDK compiled the page with the vendored compiler');
    assert.deepStrictEqual(JSON.parse(held.files['config.json']), { dataSources: ['account'], model: 'gpt-4.1' });
    assert.deepStrictEqual(JSON.parse(held.files['firstPrompt.json']), { userMessage: 'Make an overview', agentMessage: 'Made it' });
    assert.deepStrictEqual(held.messages, ['Make an overview', 'Made it']);

    const page = await genpage.read(out.pageId);
    assert.strictEqual(page.name, 'Overview');
    assert.strictEqual(page.source, SOURCE);
    assert.deepStrictEqual(page.dataSources, ['account']);
    assert.strictEqual(page.model, 'gpt-4.1');
    assert.strictEqual(page.firstPrompt, 'Make an overview');
    assert.deepStrictEqual(page.conversation.map((m) => `${m.sender}:${m.message}`), ['user:Make an overview', 'agent:Made it']);

    // What a download writes from it: the files a rebuild reads back.
    assert.deepStrictEqual(pageFolderFiles(page), {
      'page.tsx': SOURCE,
      'config.json': '{"dataSources":["account"],"model":"gpt-4.1"}',
      'prompt.txt': 'Make an overview',
    });
    assert.deepStrictEqual((await genpage.enumerateEnv()).ids, [out.pageId]);
  });
});

test('REAL BUNDLE: an update that changes nothing writes nothing — no row, no turn — and still publishes', async () => {
  const server = makeServer();
  await withBackend(server, async (genpage) => {
    const { pageId } = await genpage.create({ name: 'Overview', source: SOURCE, dataSources: 'account', model: 'm1', prompt: 'first', agentMessage: 'ok' });
    const before = snapshot(server, pageId);
    server.requests.length = 0;
    server.published.length = 0;
    const out = await genpage.update(pageId, { source: SOURCE, name: 'Overview', dataSources: ['account'], model: 'm1', prompt: 'again', agentMessage: 'again' });
    assert.strictEqual(out.unchanged, true);
    assert.deepStrictEqual(changeWrites(server), [], 'not one row was written');
    assert.deepStrictEqual(snapshot(server, pageId), before, 'rows and conversation are untouched');
    assert.deepStrictEqual(server.published, [pageId], 'but the page is published, so a page whose earlier publish failed converges');
  });
});

// A caller that kept what it published — the build, in its workspace — hands the fingerprint of that content back, and an update that finds the page already holding the content does not publish it
// again: no PublishXml at all. The page is what says it holds the content (it is read), so the hash is only ever a reason to leave out a publish that was owed to nothing.
test('REAL BUNDLE: an update given the fingerprint of the content the page holds sends no PublishXml and no write; given any other fingerprint, or none, it publishes — and a page that differs is written and published whatever it is given', async () => {
  const server = makeServer();
  await withBackend(server, async (genpage) => {
    const asked = { source: SOURCE, name: 'Overview', dataSources: ['account'], model: 'm1', prompt: 'again', agentMessage: 'again' };
    const created = await genpage.create({ name: 'Overview', source: SOURCE, dataSources: 'account', model: 'm1', prompt: 'first', agentMessage: 'ok' });
    assert.strictEqual(created.publish.kind, 'verified');
    assert.strictEqual(created.fingerprint, contentFingerprint({ source: SOURCE, name: 'Overview', dataSources: ['account'], model: 'm1' }), 'the create says what content it published');
    const { pageId } = created;
    const before = snapshot(server, pageId);

    server.requests.length = 0;
    server.published.length = 0;
    const skipped = await genpage.update(pageId, { ...asked, publishedFingerprint: created.fingerprint });
    assert.deepStrictEqual([skipped.unchanged, skipped.publish.kind, skipped.fingerprint], [true, 'skipped', created.fingerprint]);
    assert.deepStrictEqual(server.published, [], 'the page was not published again');
    assert.deepStrictEqual(server.requests.filter((r) => r.method !== 'GET'), [], 'and nothing at all was written or published: the update only read');
    assert.deepStrictEqual(snapshot(server, pageId), before);

    for (const stale of [undefined, '0'.repeat(64), 'not a hash']) {
      server.published.length = 0;
      const published = await genpage.update(pageId, { ...asked, publishedFingerprint: stale });
      assert.strictEqual(published.publish.kind, 'verified', `a fingerprint of ${JSON.stringify(stale)} is "not known to be published"`);
      assert.deepStrictEqual(server.published, [pageId]);
    }

    // A record is not a reason to leave a CHANGE unpublished: the page differs, so it is written and published.
    const edited = SOURCE.replace('Hello', 'Hello again');
    server.published.length = 0;
    const changed = await genpage.update(pageId, { ...asked, source: edited, publishedFingerprint: created.fingerprint });
    assert.strictEqual(changed.publish.kind, 'verified');
    assert.deepStrictEqual(server.published, [pageId]);
    assert.strictEqual(snapshot(server, pageId).files[PAGE_TSX], edited);
    assert.notStrictEqual(changed.fingerprint, created.fingerprint, 'and what it published is other content');
  });
});

test('REAL BUNDLE: an update writes only page.tsx and its compiled output — config.json and firstPrompt.json are not touched — and records the turn after the first', async () => {
  const server = makeServer();
  await withBackend(server, async (genpage) => {
    const { pageId } = await genpage.create({ name: 'Overview', source: SOURCE, dataSources: 'account', prompt: 'first prompt', agentMessage: 'first reply' });
    const before = snapshot(server, pageId);
    server.requests.length = 0;
    const next = SOURCE.replace('Hello', 'Goodbye');
    const out = await genpage.update(pageId, { source: next, prompt: 'swap the greeting', agentMessage: 'swapped' });
    assert.ok(!out.unchanged);
    assert.strictEqual(out.publish.kind, 'verified');

    assert.deepStrictEqual(describeWrites(server, pageId), [
      '[batch] PATCH file src/pages/page.tsx',
      '[batch] PATCH file src/pages/page.compiled',
      '[batch] PATCH project',
      '[batch] POST /agentconversationmessages',
      '[batch] POST /agentconversationmessages',
    ], 'the source, its compiled output, the project row, and the two messages of the turn — in ONE change set — and no other row');
    const after = snapshot(server, pageId);
    assert.strictEqual(after.files[PAGE_TSX], next);
    assert.notStrictEqual(after.files[PAGE_COMPILED], before.files[PAGE_COMPILED], 'the compiled output follows the source');
    for (const untouched of ['config.json', 'firstPrompt.json']) {
      assert.strictEqual(after.files[untouched], before.files[untouched], `${untouched} is not rewritten`);
    }
    assert.deepStrictEqual(after.messages, ['first prompt', 'first reply', 'swap the greeting', 'swapped'], 'the new prompt is a turn; the first prompt is kept');
    const page = await genpage.read(pageId);
    assert.strictEqual(page.firstPrompt, 'first prompt', 'pac overwrote this on every upload; the SDK keeps it');
  });
});

test('REAL BUNDLE: a field the update leaves out is the page\'s own, and an empty list clears it', async () => {
  const server = makeServer();
  await withBackend(server, async (genpage) => {
    const { pageId } = await genpage.create({ name: 'Overview', source: SOURCE, dataSources: 'account', model: 'm1', connectorBindings: [{ connector: 'x' }], prompt: 'p', agentMessage: 'r' });
    await genpage.update(pageId, { source: SOURCE.replace('Hello', 'Hi'), prompt: 'p2', agentMessage: 'r2' });
    let page = await genpage.read(pageId);
    assert.strictEqual(page.name, 'Overview');
    assert.deepStrictEqual(page.dataSources, ['account']);
    assert.strictEqual(page.model, 'm1');
    assert.deepStrictEqual(page.connectorBindings, [{ connector: 'x' }]);

    await genpage.update(pageId, { source: SOURCE.replace('Hello', 'Hi'), dataSources: [], connectorBindings: [], name: 'Renamed', prompt: 'p3', agentMessage: 'r3' });
    page = await genpage.read(pageId);
    assert.strictEqual(page.name, 'Renamed');
    assert.deepStrictEqual(page.dataSources, []);
    assert.deepStrictEqual(page.connectorBindings, []);
    assert.strictEqual(page.model, 'm1');
  });
});

test('REAL BUNDLE: a page that does not compile is refused BEFORE anything is written — on create and on update — and the error is final', async () => {
  const server = makeServer();
  await withBackend(server, async (genpage) => {
    await assert.rejects(genpage.create({ name: 'Bad', source: 'export default function () { return <div>; }', prompt: 'p' }), (e) => {
      assert.strictEqual(e.outcome, 'nothing');
      assert.strictEqual(e.transient, false);
      assert.match(e.message, /was not created \(nothing was written\)/);
      assert.strictEqual(typeof e.code, 'string', 'the SDK\'s own code is kept');
      return true;
    });
    assert.deepStrictEqual(server.writes(), [], 'not one request changed anything');
    assert.strictEqual(server.state.projects.size, 0);

    const { pageId } = await genpage.create({ name: 'Good', source: SOURCE, prompt: 'p', agentMessage: 'r' });
    const before = snapshot(server, pageId);
    server.requests.length = 0;
    await assert.rejects(genpage.update(pageId, { source: 'export default function () { return <div>; }', prompt: 'p2' }), (e) => e.outcome === 'nothing' && e.transient === false);
    assert.deepStrictEqual(changeWrites(server), []);
    assert.deepStrictEqual(snapshot(server, pageId), before, 'the page is as it was');
  });
});

// The SDK compiles a page when it writes it — TypeScript's `transpileModule`, with a checker only to resolve the page's enum names — so the compile is a transpile, not a type check. The page-builder's
// Step 2.6 says so (genpage-dispatch-contract.test.js pins the sentence): a worker that took a clean compile for a type check would ship unchecked types with false confidence. What the compile
// refuses is a page the runtime could not load.
const TYPE_ERRORS = [
  "import * as React from 'react';",
  "import type { account } from './RuntimeTypes';",
  "const count: number = 'three';",
  'const flag: boolean = 42;',
  'export default function Page() {',
  '  const row = {} as account;',
  '  return <div>{count}{String(flag)}{row.nosuchcolumn}</div>;',
  '}',
  '',
].join('\n');

test('REAL BUNDLE: the compile is a transpile, not a type check — a page with type errors and a column its table does not have is written and compiled; one that does not parse, has no default export or imports a value RuntimeTypes lacks is refused', async () => {
  const server = makeServer();
  await withBackend(server, async (genpage) => {
    const out = await genpage.create({ name: 'Typos', source: TYPE_ERRORS, dataSources: 'account', prompt: 'p', agentMessage: 'r' });
    const held = snapshot(server, out.pageId);
    assert.strictEqual(held.files[PAGE_TSX], TYPE_ERRORS, 'stored as written');
    // The compiled output is JavaScript with the wrong types simply gone and the missing column still read.
    assert.ok(held.files[PAGE_COMPILED].includes("var count = 'three';") && held.files[PAGE_COMPILED].includes('var flag = 42;') && held.files[PAGE_COMPILED].includes('row.nosuchcolumn'));
    assert.deepStrictEqual(await genpage.update(out.pageId, { source: TYPE_ERRORS.replace("'three'", "'four'"), prompt: 'p2', agentMessage: 'r2' }).then((u) => [u.unchanged === true, u.publish.kind]), [false, 'verified'], 'an update compiles it the same way');

    const refused = {
      'one that does not parse': 'export default function () { return <div>; }',
      'one with no default export': "import * as React from 'react';\nexport function Page() { return <div>Hello</div>; }\n",
      'one that imports a value RuntimeTypes does not hold': "import * as React from 'react';\nimport { nosuchenum } from './RuntimeTypes';\nexport default function Page() { return <div>{String(nosuchenum)}</div>; }\n",
    };
    const before = server.writes().length;
    for (const [what, source] of Object.entries(refused)) {
      await assert.rejects(genpage.create({ name: 'Bad', source, dataSources: 'account', prompt: 'p' }), (e) => e.code === 'VALIDATION_ERROR' && e.outcome === 'nothing', what);
    }
    assert.strictEqual(server.writes().length, before, 'and not one request changed anything');
  });
});

test('REAL BUNDLE: bytes that are not UTF-8 are refused before the SDK sends a single request', async () => {
  const server = makeServer();
  await withBackend(server, async (genpage) => {
    await assert.rejects(genpage.create({ name: 'P', source: Buffer.from([0xff, 0xfe, 0x41]), prompt: 'p' }), (e) => e.code === 'GENPAGE_SOURCE_NOT_UTF8');
    assert.strictEqual(server.requests.length, 0);
  });
});

test('REAL BUNDLE: a create whose RESPONSE is lost leaves the page written — the minted id is read, found, published, and no second page exists', async () => {
  const server = makeServer();
  server.afterCommit = lostResponse;
  await withBackend(server, async (genpage) => {
    const out = await genpage.create({ name: 'Overview', source: SOURCE, prompt: 'p', agentMessage: 'r' });
    server.afterCommit = undefined;
    assert.strictEqual(server.state.projects.size, 1, 'exactly one page — it was not sent again');
    assert.strictEqual(out.pageId, [...server.state.projects.keys()][0]);
    assert.match(out.warnings.join('\n'), /was lost.*had been written/s);
    assert.deepStrictEqual(server.published, [out.pageId]);
    assert.deepStrictEqual(snapshot(server, out.pageId).messages, ['p', 'r'], 'the turn is recorded once');
  });
});

test('REAL BUNDLE: a create that NEVER ARRIVED is sent once more under the same id, and one page results; two that never arrive end as "unknown", with nothing written', async () => {
  const server = makeServer();
  let arrivals = 0;
  server.beforeBatch = () => { arrivals += 1; if (arrivals === 1) throw new Error('Request failed: connect ETIMEDOUT'); };
  await withBackend(server, async (genpage) => {
    const out = await genpage.create({ name: 'Overview', source: SOURCE, prompt: 'p', agentMessage: 'r' });
    assert.strictEqual(arrivals, 2, 'sent twice');
    assert.strictEqual(server.state.projects.size, 1);
    assert.strictEqual(out.pageId, [...server.state.projects.keys()][0]);
  });

  const down = makeServer();
  let attempts = 0;
  down.beforeBatch = () => { attempts += 1; throw new Error('Request failed: connect ETIMEDOUT'); };
  await withBackend(down, async (genpage) => {
    await assert.rejects(genpage.create({ name: 'Overview', source: SOURCE, prompt: 'p' }), (e) => e.outcome === 'unknown' && e.transient === false && /sent twice/.test(e.message) && Boolean(e.pageId));
    assert.strictEqual(attempts, 2, 'never a third send');
    assert.strictEqual(down.state.projects.size, 0);
  });
});

test('REAL BUNDLE: an update whose RESPONSE is lost landed once — it is not sent again and its turn is recorded once', async () => {
  const server = makeServer();
  await withBackend(server, async (genpage) => {
    const { pageId } = await genpage.create({ name: 'Overview', source: SOURCE, prompt: 'first', agentMessage: 'ok' });
    server.afterCommit = lostResponse;
    const out = await genpage.update(pageId, { source: SOURCE.replace('Hello', 'Third'), prompt: 'third', agentMessage: 'done' });
    server.afterCommit = undefined;
    assert.match(out.warnings.join('\n'), /was lost.*had been written — so it was not sent again/s);
    assert.deepStrictEqual(snapshot(server, pageId).messages, ['first', 'ok', 'third', 'done']);
    assert.strictEqual(snapshot(server, pageId).files[PAGE_TSX], SOURCE.replace('Hello', 'Third'));
  });
});

test('REAL BUNDLE: an update that NEVER ARRIVED is sent once more from what the page holds, and lands once', async () => {
  const server = makeServer();
  await withBackend(server, async (genpage) => {
    const { pageId } = await genpage.create({ name: 'Overview', source: SOURCE, prompt: 'first', agentMessage: 'ok' });
    let arrivals = 0;
    server.beforeBatch = () => { arrivals += 1; if (arrivals === 1) throw new Error('Request failed: connect ETIMEDOUT'); };
    const out = await genpage.update(pageId, { source: SOURCE.replace('Hello', 'Fourth'), prompt: 'fourth', agentMessage: 'done' });
    server.beforeBatch = undefined;
    assert.strictEqual(arrivals, 2);
    assert.deepStrictEqual(out.warnings, []);
    assert.deepStrictEqual(snapshot(server, pageId).messages, ['first', 'ok', 'fourth', 'done'], 'the turn is recorded once, not twice');
  });
});

test('REAL BUNDLE: an update that was OVERTAKEN by another writer while its answer was lost is refused and not sent again', async () => {
  const server = makeServer();
  await withBackend(server, async (genpage) => {
    const { pageId } = await genpage.create({ name: 'Overview', source: SOURCE, prompt: 'first', agentMessage: 'ok' });
    // The update never arrives, and while it was in flight someone else saved the page.
    server.beforeBatch = () => {
      server.beforeBatch = undefined;
      const row = server.filesOf(pageId).find((f) => f.filename === PAGE_TSX);
      row.content = Buffer.from('export default function Theirs() { return null; }\n', 'utf8');
      row.etag = server.nextEtag();
      throw new Error('Request failed: connect ETIMEDOUT');
    };
    await assert.rejects(genpage.update(pageId, { source: SOURCE.replace('Hello', 'Mine'), prompt: 'mine', agentMessage: 'x' }), (e) => {
      assert.strictEqual(e.outcome, 'unknown');
      assert.strictEqual(e.transient, false);
      assert.match(e.message, /MAY HAVE LANDED or been overtaken/);
      return true;
    });
    assert.strictEqual(server.rowText(pageId, PAGE_TSX), 'export default function Theirs() { return null; }\n', 'the other writer\'s save was not overwritten');
  });
});

test('REAL BUNDLE: a page whose publish fails is still written and listed — a DRAFT — and the failure is returned with its id; an update then publishes it', async () => {
  const server = makeServer();
  server.failOn = (method, requestPath) => (/PublishXml/.test(requestPath) ? 500 : undefined);
  await withBackend(server, async (genpage) => {
    const out = await genpage.create({ name: 'Draft', source: SOURCE, prompt: 'p', agentMessage: 'r' });
    assert.strictEqual(out.publish.kind, 'failed');
    assert.strictEqual((await genpage.enumerateEnv()).ids.includes(out.pageId), true, 'a draft is listed');
    assert.strictEqual((await genpage.read(out.pageId)).source, SOURCE, 'and readable');

    server.failOn = undefined;
    const again = await genpage.update(out.pageId, { source: SOURCE });
    assert.strictEqual(again.unchanged, true);
    assert.strictEqual(again.publish.kind, 'verified', 'the page that already holds the content is published, not rewritten');
    assert.deepStrictEqual(server.published, [out.pageId]);
  });
});

test('REAL BUNDLE: a page the SDK cannot project as a page (no page source) is reported, never answered as an empty page', async () => {
  const server = makeServer();
  const id = 'd0000000-0000-4000-8000-000000000001';
  server.seedProject(id, 'Hand made');
  server.seedFile(id, 'f0000000-0000-4000-8000-00000000f001', 'notes/readme.txt', 200000000, 'not a page');
  await withBackend(server, async (genpage) => {
    await assert.rejects(genpage.read(id), (e) => e.code === 'GENPAGE_NO_SOURCE' && /Hand made/.test(e.message));
    await assert.rejects(genpage.update(id, { source: SOURCE }), (e) => e.code === 'GENPAGE_NO_SOURCE' && e.outcome === 'nothing');
    assert.deepStrictEqual(server.writes(), []);
    assert.deepStrictEqual((await genpage.enumerateEnv()).ids, [id], 'it is still listed — it exists');
  });
});

test('REAL BUNDLE: a page that is not there is GENPAGE_NOT_FOUND for read and for update', async () => {
  const server = makeServer();
  await withBackend(server, async (genpage) => {
    const missing = 'd0000000-0000-4000-8000-000000000009';
    await assert.rejects(genpage.read(missing), (e) => e.code === 'GENPAGE_NOT_FOUND');
    await assert.rejects(genpage.update(missing, { source: SOURCE }), (e) => e.code === 'GENPAGE_NOT_FOUND' && e.outcome === 'nothing');
    assert.deepStrictEqual(server.writes(), []);
  });
});

test('REAL BUNDLE: a page made the way the maker lays it out is read as one — name, source, data sources, model, bindings, the whole conversation', async () => {
  const server = makeServer();
  const id = 'd0000000-0000-4000-8000-000000000002';
  server.seedPage(id, { name: 'Say \\"hi\\"', source: SOURCE, config: { dataSources: ['account'], model: 'gpt-4.1', actionBindings: [{ a: 1 }] }, prompt: 'Show a greeting', agentMessage: 'Shown' });
  server.seedMessage(id, 'Make it blue', 200000000);
  await withBackend(server, async (genpage) => {
    const page = await genpage.read(id);
    assert.strictEqual(page.name, 'Say \\"hi\\"', 'as pac stored it');
    assert.deepStrictEqual(page.dataSources, ['account']);
    assert.deepStrictEqual(page.actionBindings, [{ a: 1 }]);
    const files = pageFolderFiles(page);
    assert.strictEqual(files['config.json'], '{"dataSources":["account"],"model":"gpt-4.1","actionBindings":[{"a":1}]}');
    assert.match(files['prompt.txt'], /^Conversation with 2 prompts:\r\n1\. Show a greeting\r\n2\. Make it blue$/);
  });
});

// ── The source is normalized once ─────────────────────────────────────────────────────────────────────────────────────────────

// A caller turns the bytes of its file into text once (sourceText) and checks, hashes and sends that text. The backend used to normalize it again, so a
// file that started with two byte order marks was sent with neither, and what the build recorded as deployed was not what the SDK stored.
test('REAL BUNDLE: text that starts with a byte order mark is stored with it — create and update — because the one normalization already ran on the bytes', async () => {
  const { sourceText } = require('../lib/genpage-sdk.js');
  const server = makeServer();
  await withBackend(server, async (genpage) => {
    const canonical = sourceText(Buffer.from(`\uFEFF\uFEFF${SOURCE}`, 'utf8'));
    assert.strictEqual(canonical, `\uFEFF${SOURCE}`, 'the file\'s first mark was the encoding marker; the second is content');
    const { pageId } = await genpage.create({ name: 'Overview', source: canonical, prompt: 'p', agentMessage: 'r' });
    assert.strictEqual(snapshot(server, pageId).files[PAGE_TSX], canonical, 'create stores exactly the text it was given');

    const next = `\uFEFF${SOURCE.replace('Hello', 'Again')}`;
    await genpage.update(pageId, { source: next, prompt: 'p2', agentMessage: 'r2' });
    assert.strictEqual(snapshot(server, pageId).files[PAGE_TSX], next, 'and so does update');

    // Bytes handed to the backend directly are normalized there, once: the same two files, the same stored text.
    const direct = await genpage.create({ name: 'Direct', source: Buffer.from(`\uFEFF\uFEFF${SOURCE}`, 'utf8'), prompt: 'p' });
    assert.strictEqual(snapshot(server, direct.pageId).files[PAGE_TSX], canonical);
  });
});

test('REAL BUNDLE: dispose() removes the throwaway workspace the SDK worked in — once, and any number of times', async () => {
  const server = makeServer();
  const { genpage, made } = harness(server);
  await genpage.create({ name: 'Overview', source: SOURCE, prompt: 'p' });
  assert.strictEqual(made.length, 1);
  assert.ok(fs.existsSync(made[0]), 'the workspace exists while the backend works');
  assert.ok(path.basename(made[0]).startsWith('genpage-'));
  assert.strictEqual(path.dirname(made[0]), os.tmpdir(), 'in the temp directory, never the app folder');
  genpage.dispose();
  assert.ok(!fs.existsSync(made[0]));
  genpage.dispose();
});

test('REAL BUNDLE: the backend never touches the app folder: nothing is written outside its own workspace', async () => {
  const server = makeServer();
  const before = new Set(fs.readdirSync(process.cwd()));
  await withBackend(server, async (genpage) => { await genpage.create({ name: 'Overview', source: SOURCE, prompt: 'p' }); });
  assert.deepStrictEqual(new Set(fs.readdirSync(process.cwd())), before, 'the working directory is unchanged');
});

// ── What a failed send proves, and what a read proves ───────────────────────────────────────────────────────────────────────────
// A workspace storage the test can fill up or stop: what the SDK's disk does. `control.full` is how many of the next writes fail with ENOSPC
// (Infinity: all of them); `control.hold(method)` returns a promise to await first, to stop a call part-way.
const { createNodeWorkspaceStorage } = require('../lib/maker-sdk.js');
function flakyStorage(dir, control) {
  const inner = createNodeWorkspaceStorage(dir);
  const storage = {};
  for (const method of ['readText', 'writeTextAtomic', 'deleteFile', 'deleteByPrefix', 'ensureContainer', 'exists']) {
    if (typeof inner[method] !== 'function') continue;
    storage[method] = async (...args) => {
      if (control.hold) await control.hold(method, args);
      if (method === 'writeTextAtomic' && control.full > 0) {
        control.full -= 1;
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC', errno: -28, syscall: 'write' });
      }
      return inner[method](...args);
    };
  }
  return storage;
}
const turns = async (n = 10) => { for (let i = 0; i < n; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const projectIds = (server) => [...server.state.projects.keys()];

// The race: the SDK persists its workspace once the change set has committed, the disk is full, and pushArtifact throws ENOSPC for a
// page the server holds whole. That used to be reported as "nothing was written", with no page id, beside a complete page on the server.
test('REAL BUNDLE: a create whose workspace write fails with ENOSPC AFTER the change set committed is settled by reading the id — the page is found and published, not "nothing written"', async () => {
  const server = makeServer();
  const disk = { full: 0 };
  server.afterCommit = () => { disk.full = 1; };
  await withBackend(server, async (genpage) => {
    const out = await genpage.create({ name: 'Overview', source: SOURCE, prompt: 'p', agentMessage: 'r' });
    assert.deepStrictEqual(projectIds(server), [out.pageId], 'one page — it was not created again');
    assert.strictEqual(server.batches.length, 1, 'one change set was sent');
    assert.strictEqual(out.publish.kind, 'verified');
    assert.match(out.warnings.join('\n'), /ENOSPC/);
    assert.deepStrictEqual(snapshot(server, out.pageId).messages, ['p', 'r']);
  }, { createStorage: (dir) => flakyStorage(dir, disk) });
});

test('REAL BUNDLE: a create whose disk stays full cannot read the page it wrote — UNKNOWN, with the id, beside the complete page on the server', async () => {
  const server = makeServer();
  const disk = { full: 0 };
  server.afterCommit = () => { disk.full = Infinity; };
  await withBackend(server, async (genpage) => {
    const error = await genpage.create({ name: 'Overview', source: SOURCE, prompt: 'p', agentMessage: 'r' }).then(() => null, (e) => e);
    assert.ok(error, 'the create is reported as failed');
    assert.strictEqual(error.outcome, 'unknown', 'the page is complete on the server, so "nothing was written" is false');
    assert.ok(error.pageId, 'the page id is kept');
    assert.strictEqual(error.code, 'ENOSPC');
    assert.strictEqual(error.transient, false);
    assert.deepStrictEqual(projectIds(server), [error.pageId], 'and that is the page the server holds');
    assert.strictEqual(snapshot(server, error.pageId).files[PAGE_TSX], SOURCE);
  }, { createStorage: (dir) => flakyStorage(dir, disk) });
});

test('REAL BUNDLE: an update whose workspace write fails with ENOSPC after the change set committed landed once — read, found with its turn, published', async () => {
  const server = makeServer();
  const disk = { full: 0 };
  await withBackend(server, async (genpage) => {
    const { pageId } = await genpage.create({ name: 'Overview', source: SOURCE, prompt: 'first', agentMessage: 'ok' });
    server.afterCommit = () => { disk.full = 1; };
    const out = await genpage.update(pageId, { source: SOURCE.replace('Hello', 'Fifth'), prompt: 'fifth', agentMessage: 'done' });
    server.afterCommit = undefined;
    assert.match(out.warnings.join('\n'), /ENOSPC.*had been written/s);
    assert.deepStrictEqual(snapshot(server, pageId).messages, ['first', 'ok', 'fifth', 'done'], 'the turn is recorded once');
    assert.strictEqual(server.batches.length, 2, 'two change sets in all: the create and the update — not sent again');
  }, { createStorage: (dir) => flakyStorage(dir, disk) });
});

// The race: the first create is held in flight, the read for it finds no page, then the first request commits while the retry is rejected
// (HTTP 429). A rejected retry is a known failure of the retry only: the page the first request wrote is complete on the server.
test('REAL BUNDLE: a create whose first send is still in flight lands while its resend is refused (429) — the read that follows the refusal finds the page; it is adopted and published, never "nothing written"', async () => {
  const server = makeServer();
  server.strandBatch = (n) => n === 1;
  server.failBatch = (n) => { if (n === 2) { server.landStranded(); return 429; } return undefined; };
  await withBackend(server, async (genpage) => {
    const out = await genpage.create({ name: 'Overview', source: SOURCE, prompt: 'p', agentMessage: 'r' });
    assert.deepStrictEqual(projectIds(server), [out.pageId], 'exactly one page, and it is the one reported');
    assert.strictEqual(server.batches.length, 2);
    assert.strictEqual(out.publish.kind, 'verified');
    assert.match(out.warnings.join('\n'), /429/);
    assert.deepStrictEqual(snapshot(server, out.pageId).messages, ['p', 'r']);
  });
});

// The same race with the other answer a rejected resend can give: the first request lands immediately BEFORE the resend's change set, so the resend collides on the
// project id and is rolled back whole (a 412 part). That is the page existing — read, adopted and published — and not "nothing was written".
test('REAL BUNDLE: a create whose first send lands immediately before its resend — the resend collides on the id and is rolled back (412) — is adopted and published: one page, one turn', async () => {
  const server = makeServer();
  server.strandBatch = (n) => n === 1;
  server.beforeBatch = () => { if (server.batches.length === 2) server.landStranded(); };
  await withBackend(server, async (genpage) => {
    const out = await genpage.create({ name: 'Overview', source: SOURCE, prompt: 'p', agentMessage: 'r' });
    assert.deepStrictEqual(projectIds(server), [out.pageId], 'one page');
    assert.strictEqual(server.batches.length, 2, 'the create went out twice');
    assert.strictEqual(out.publish.kind, 'verified');
    assert.match(out.warnings.join('\n'), /had been written — so it was not sent again/);
    assert.deepStrictEqual(snapshot(server, out.pageId).messages, ['p', 'r'], 'the conversation holds the turn once');
  });
});

// A create that RESUMES an earlier one — the caller names the id the earlier one was sent under (the build's pending record) — meets that request when it has landed meanwhile.
test('REAL BUNDLE: a create under an id an earlier request has already created collides (412) and is adopted — not reported as "nothing was written", and not a second page', async () => {
  const server = makeServer();
  const id = 'd0000000-0000-4000-8000-0000000000b7';
  await withBackend(server, async (earlier) => {
    // The earlier build gave up: both sends of its create timed out in flight.
    server.strandBatch = (n) => n <= 2;
    const sent = await earlier.create({ name: 'Overview', source: SOURCE, prompt: 'p', agentMessage: 'r', pageId: id, beforeSend: async () => {} }).then(() => null, (e) => e);
    assert.ok(sent && sent.outcome === 'unknown' && sent.pageId === id, 'its create did not finish; it names the id');
    server.strandBatch = undefined;
  });
  await server.landStranded();
  assert.deepStrictEqual(projectIds(server), [id], 'the earlier request has landed meanwhile');
  const batches = server.batches.length;
  await withBackend(server, async (genpage) => {
    const out = await genpage.create({ name: 'Overview', source: SOURCE, prompt: 'p', agentMessage: 'r', pageId: id });
    assert.strictEqual(out.pageId, id);
    assert.strictEqual(server.batches.length, batches + 1, 'one change set was sent, and it collided');
    assert.deepStrictEqual(projectIds(server), [id], 'still one page');
    assert.deepStrictEqual(snapshot(server, id).messages, ['p', 'r']);
    assert.strictEqual(out.publish.kind, 'verified');
  });
});

// ── A create that RESUMES an earlier one recognises the page it finds by what was sent under the id ─────────────────────────────────────────
// The build records the name and the source hash of every create it sends (`sentBefore` on the next one). A page found under the id is adopted only when it holds
// a name and a source a create under the id sent; whatever else it still holds of an earlier create is brought to what this one asks for by the ordinary update.

// An earlier build's create under `id`, both of whose sends were still in flight when it gave up — and that then land, as a request in a gateway does.
async function earlierCreateLandedLate(server, id, args) {
  await withBackend(server, async (earlier) => {
    server.strandBatch = (n) => n <= 2;
    const gaveUp = await earlier.create({ prompt: 'p', agentMessage: 'r', ...args, pageId: id }).then(() => null, (e) => e);
    assert.ok(gaveUp && gaveUp.outcome === 'unknown' && gaveUp.pageId === id, 'the earlier create did not finish, and named the id');
    server.strandBatch = undefined;
  });
  await server.landStranded();
  assert.deepStrictEqual(projectIds(server), [id], 'the earlier request has landed meanwhile');
}

test('REAL BUNDLE: a resumed create that finds the page an earlier create made under ANOTHER NAME — one it recorded — brings it to the name asked for and publishes it once: one page', async () => {
  const server = makeServer();
  const id = 'd0000000-0000-4000-8000-0000000000c1';
  await earlierCreateLandedLate(server, id, { name: 'Old name', source: SOURCE });
  await withBackend(server, async (genpage) => {
    const out = await genpage.create({ name: 'New name', source: SOURCE, prompt: 'p2', agentMessage: 'r2', pageId: id, sentBefore: [{ name: 'Old name', sourceSha256: sha256(SOURCE) }] });
    assert.strictEqual(out.pageId, id);
    assert.deepStrictEqual(projectIds(server), [id], 'still one page');
    assert.strictEqual((await genpage.read(id)).name, 'New name', 'the page has the name this create asked for');
    assert.strictEqual(out.publish.kind, 'verified');
    assert.deepStrictEqual(server.published, [id], 'published once, after it was brought up to date');
    assert.match(out.warnings.join('\n'), /differing from this create in name/);
  });
});

// The earlier create sent another MODEL, and the page it made is not what this create asks for. Publishing it as it is would put the old model live under the new create's name.
test('REAL BUNDLE: a resumed create that finds the page an earlier create made with ANOTHER MODEL writes the model it asks for BEFORE the page is published — never publishes the page as it was', async () => {
  const server = makeServer();
  const id = 'd0000000-0000-4000-8000-0000000000c2';
  await earlierCreateLandedLate(server, id, { name: 'Overview', source: SOURCE, model: 'model-one' });
  const heldAtPublish = [];
  server.failOn = (method, requestPath) => {
    if (/PublishXml/.test(requestPath)) heldAtPublish.push(JSON.parse(server.rowText(id, 'config.json')).model);
    return undefined;
  };
  await withBackend(server, async (genpage) => {
    const out = await genpage.create({ name: 'Overview', source: SOURCE, model: 'model-two', prompt: 'p2', agentMessage: 'r2', pageId: id, sentBefore: [] });
    assert.deepStrictEqual(projectIds(server), [id]);
    assert.deepStrictEqual(heldAtPublish, ['model-two'], 'the page held the model asked for at the only publish');
    assert.strictEqual((await genpage.read(id)).model, 'model-two');
    assert.strictEqual(out.publish.kind, 'verified');
    assert.match(out.warnings.join('\n'), /differing from this create in model/);
  });
});

test('REAL BUNDLE: a resumed create that finds a page under its id that holds NO name and NO source any create under it sent is GENPAGE_CREATE_DIVERGED — not adopted, not updated, not published', async () => {
  const server = makeServer();
  const id = 'd0000000-0000-4000-8000-0000000000c3';
  const theirs = 'export default function Theirs() { return null; }\n';
  server.seedPage(id, { name: 'Somebody else\'s page', source: theirs });
  const before = snapshot(server, id);
  await withBackend(server, async (genpage) => {
    const error = await genpage.create({ name: 'Overview', source: SOURCE, prompt: 'p', agentMessage: 'r', pageId: id, sentBefore: [] }).then(() => null, (e) => e);
    assert.ok(error, 'the create is refused');
    assert.strictEqual(error.code, 'GENPAGE_CREATE_DIVERGED');
    assert.strictEqual(error.outcome, 'unknown');
    assert.strictEqual(error.pageId, id);
    assert.strictEqual(error.transient, false);
    assert.match(error.message, /not a page any create under this id sent: it is named "Somebody else's page", and the create sent "Overview"/);
  });
  assert.deepStrictEqual(snapshot(server, id), before, 'the page is as it was: nothing was written to it');
  assert.deepStrictEqual(server.published, [], 'and it was not published');
});

// A page that holds the NAME a create sent but not a source any of them sent was edited after it was made: a name is not proof of identity on its own.
test('REAL BUNDLE: a resumed create that finds a page with the name it sent but a source NO create sent is GENPAGE_CREATE_DIVERGED', async () => {
  const server = makeServer();
  const id = 'd0000000-0000-4000-8000-0000000000c4';
  server.seedPage(id, { name: 'Overview', source: 'export default function Edited() { return null; }\n' });
  const before = snapshot(server, id);
  await withBackend(server, async (genpage) => {
    const error = await genpage.create({ name: 'Overview', source: SOURCE, prompt: 'p', agentMessage: 'r', pageId: id, sentBefore: [] }).then(() => null, (e) => e);
    assert.ok(error);
    assert.strictEqual(error.code, 'GENPAGE_CREATE_DIVERGED');
    assert.match(error.message, /its source is not the one that was sent/);
  });
  assert.deepStrictEqual(snapshot(server, id), before);
  assert.deepStrictEqual(server.published, []);
});

// A resumed create that is refused before it sends anything is not "nothing was written": the request an earlier build sent under the id can still land.
test('REAL BUNDLE: a resumed create whose page does not compile is UNKNOWN, with the id — the earlier request can still land — and a new create under no id says nothing was written', async () => {
  const server = makeServer();
  const id = 'd0000000-0000-4000-8000-0000000000c5';
  const broken = 'export default function Page( { return <div>;\n';
  await withBackend(server, async (genpage) => {
    const batches = server.batches.length;
    const resumed = await genpage.create({ name: 'Broken', source: broken, prompt: 'p', agentMessage: 'r', pageId: id, sentBefore: [{ name: 'Broken', sourceSha256: sha256('an earlier source') }] }).then(() => null, (e) => e);
    assert.ok(resumed);
    assert.strictEqual(resumed.outcome, 'unknown');
    assert.strictEqual(resumed.pageId, id);
    assert.strictEqual(resumed.transient, false);
    assert.doesNotMatch(resumed.message, /nothing was written/);
    assert.strictEqual(server.batches.length, batches, 'nothing was sent');

    const fresh = await genpage.create({ name: 'Broken', source: broken, prompt: 'p', agentMessage: 'r' }).then(() => null, (e) => e);
    assert.ok(fresh);
    assert.strictEqual(fresh.outcome, 'nothing');
    assert.match(fresh.message, /nothing was written/);
    assert.strictEqual(fresh.pageId, undefined);
  });
});

// The service answers a create of an id that exists with a 412. The SDK reports that as `ARTIFACT_ALREADY_EXISTS` — it does not throw it — and a page that cannot be read afterwards
// is not "nothing was written": a request that carried the id can still be in flight. So the outcome is unknown, with the id to look for, and the create is not sent again.
test('REAL BUNDLE: a create the service answers with a 412 (the id exists) but whose page cannot be read is UNKNOWN, with the id — never "nothing was written"', async () => {
  const server = makeServer();
  server.failBatch = (n) => (n === 1 ? 412 : undefined);
  const id = 'd0000000-0000-4000-8000-0000000000b8';
  await withBackend(server, async (genpage) => {
    const error = await genpage.create({ name: 'Overview', source: SOURCE, prompt: 'p', agentMessage: 'r', pageId: id }).then(() => null, (e) => e);
    assert.ok(error);
    assert.strictEqual(error.outcome, 'unknown');
    assert.strictEqual(error.code, 'ARTIFACT_ALREADY_EXISTS');
    assert.strictEqual(error.pageId, id);
    assert.strictEqual(error.transient, false);
    assert.match(error.message, /already exists, but no page .* can be read/);
    assert.strictEqual(server.batches.length, 1, 'it is not sent again');
    assert.deepStrictEqual(projectIds(server), []);
  });
});

test('REAL BUNDLE: a create whose resend is refused (429) while the first send has not landed is UNKNOWN, with the id — and the page IS there once the first send lands', async () => {
  const server = makeServer();
  server.strandBatch = (n) => n === 1;
  server.failBatch = (n) => (n === 2 ? 429 : undefined);
  await withBackend(server, async (genpage) => {
    const error = await genpage.create({ name: 'Overview', source: SOURCE, prompt: 'p', agentMessage: 'r' }).then(() => null, (e) => e);
    assert.ok(error);
    assert.strictEqual(error.outcome, 'unknown', 'a refused resend does not settle the send that is still in flight');
    assert.ok(error.pageId, 'the id to look for is kept');
    assert.match(error.message, /429/);
    assert.strictEqual(error.transient, false);
    assert.deepStrictEqual(projectIds(server), [], 'nothing has landed yet…');
    await server.landStranded();
    assert.deepStrictEqual(projectIds(server), [error.pageId], '…and now it has, under exactly the id the error named');
  });
});

// The race: the first update is held in flight; the read for it finds the page as it was; the first commits immediately before the resend's
// change set. The resend recorded the turn under new message ids, so both change sets committed and the conversation held the prompt and the reply twice.
test('REAL BUNDLE: an update whose first send lands immediately before its resend records its turn ONCE — the resend reuses the first send\'s turn identity, so its message rows collide and the change set is rolled back', async () => {
  const server = makeServer();
  await withBackend(server, async (genpage) => {
    const { pageId } = await genpage.create({ name: 'Overview', source: SOURCE, prompt: 'first', agentMessage: 'ok' });
    server.strandBatch = (n) => n === 2;
    server.beforeBatch = () => { if (server.batches.length === 3) server.landStranded(); };
    const out = await genpage.update(pageId, { source: SOURCE.replace('Hello', 'Sixth'), prompt: 'sixth', agentMessage: 'done' });
    server.strandBatch = undefined;
    server.beforeBatch = undefined;
    assert.strictEqual(server.batches.length, 3, 'the update went out twice');
    assert.deepStrictEqual(snapshot(server, pageId).messages, ['first', 'ok', 'sixth', 'done'], 'the prompt and the reply are in the conversation once');
    assert.strictEqual(snapshot(server, pageId).files[PAGE_TSX], SOURCE.replace('Hello', 'Sixth'));
    assert.strictEqual(server.messagesOf(pageId).length, 4);
    assert.strictEqual(out.publish.kind, 'verified');
    assert.match(out.warnings.join('\n'), /had been written — so it was not sent again/);
  });
});

test('REAL BUNDLE: an update whose resend is refused (429) while the first send lands is read, found with its turn and published; with nothing landed it is UNKNOWN', async () => {
  const server = makeServer();
  await withBackend(server, async (genpage) => {
    const { pageId } = await genpage.create({ name: 'Overview', source: SOURCE, prompt: 'first', agentMessage: 'ok' });
    server.strandBatch = (n) => n === 2;
    server.failBatch = (n) => { if (n === 3) { server.landStranded(); return 429; } return undefined; };
    const out = await genpage.update(pageId, { source: SOURCE.replace('Hello', 'Seventh'), prompt: 'seventh', agentMessage: 'done' });
    assert.deepStrictEqual(snapshot(server, pageId).messages, ['first', 'ok', 'seventh', 'done']);
    assert.match(out.warnings.join('\n'), /429|was lost/);

    // Now the same, with the first send never arriving: the refusal leaves it open.
    const calls = server.batches.length;
    server.strandBatch = (n) => n === calls + 1;
    server.failBatch = (n) => (n === calls + 2 ? 429 : undefined);
    const error = await genpage.update(pageId, { source: SOURCE.replace('Hello', 'Eighth'), prompt: 'eighth', agentMessage: 'done' }).then(() => null, (e) => e);
    assert.ok(error);
    assert.strictEqual(error.outcome, 'unknown');
    assert.strictEqual(error.pageId, pageId);
    assert.match(error.message, /can still land/);
    assert.strictEqual(snapshot(server, pageId).files[PAGE_TSX], SOURCE.replace('Hello', 'Seventh'), 'nothing has landed yet');
    await server.landStranded();
    assert.strictEqual(snapshot(server, pageId).files[PAGE_TSX], SOURCE.replace('Hello', 'Eighth'), 'and it does: the error said where to look');
  });
});

// ── A write the service REFUSES with a throttle (HTTP 429) is waited out and sent again ─────────────────────────────────────────────
// What makes the second send safe: a 429 is the service declining to start the request, so the atomic change set committed nothing; the page's id and the turn's identity were minted before the first send, so a
// request that WAS processed would collide on them and be rolled back whole; and the SDK's own version check runs again on the resend, so a page someone changed during the wait is refused, not overwritten.
// `sleep` and `random` are the backend's seams: the waits are recorded and not taken.
const quickly = () => {
  const slept = [];
  return { slept, deps: { sleep: async (ms) => { slept.push(ms); }, random: () => 0 } };
};

test('REAL BUNDLE: a create the service refuses with a throttle (429) wrote nothing — it waits what the answer\'s Retry-After asks, and goes again: one page, one turn, one publish', async () => {
  const server = makeServer();
  server.failBatch = (n) => (n === 1 ? { status: 429, headers: { 'retry-after': '7' } } : undefined);
  const { slept, deps } = quickly();
  await withBackend(server, async (genpage) => {
    const out = await genpage.create({ name: 'Overview', source: SOURCE, prompt: 'p', agentMessage: 'r' });
    assert.deepStrictEqual(projectIds(server), [out.pageId], 'one page');
    assert.strictEqual(server.batches.length, 2, 'the change set went out twice: the first refused, the second taken');
    assert.deepStrictEqual(slept, [7000], 'the wait the service asked for, which is longer than the schedule\'s first');
    assert.deepStrictEqual(snapshot(server, out.pageId).messages, ['p', 'r'], 'the turn is in the conversation once');
    assert.strictEqual(out.publish.kind, 'verified');
    assert.deepStrictEqual(server.published, [out.pageId]);
    assert.deepStrictEqual(out.warnings, ['the service throttled the write of generative page "Overview" (HTTP 429) once: a refused request writes nothing, so it was sent again after waiting 7 s, and written once'], 'the result says why it was slow');
  }, deps);
});

test('REAL BUNDLE: what a throttled answer asks for is waited out whole, and the schedule is the floor — no header, a short one, one longer than the HTTP client\'s cap', async () => {
  for (const [what, answer, waits] of [
    ['no Retry-After', 429, [1000]],
    ['one shorter than the schedule', { status: 429, headers: { 'retry-after': '0' } }, [1000]],
    ['one longer than the client\'s cap of a minute, which fits the budget', { status: 429, headers: { 'Retry-After': '240' } }, [240000]],
  ]) {
    const server = makeServer();
    server.failBatch = (n) => (n === 1 ? answer : undefined);
    const { slept, deps } = quickly();
    await withBackend(server, async (genpage) => {
      const out = await genpage.create({ name: 'Overview', source: SOURCE, prompt: 'p', agentMessage: 'r' });
      assert.deepStrictEqual(projectIds(server), [out.pageId], what);
      assert.deepStrictEqual(slept, waits, what);
    }, deps);
  }
});

// Each wait is the LONGER of the schedule (which grows with every refusal) and what the answer asks, so a Retry-After shorter than the schedule does not hold it back, and one longer than it is not cut short.
test('REAL BUNDLE: every wait is the longer of the schedule and the Retry-After — three refusals asking for one second wait 1 s, 2 s and 4 s; three asking for thirty wait thirty each', async () => {
  for (const [header, waits] of [['1', [1000, 2000, 4000]], ['30', [30000, 30000, 30000]]]) {
    const server = makeServer();
    server.failBatch = (n) => (n <= 3 ? { status: 429, headers: { 'retry-after': header } } : undefined);
    const { slept, deps } = quickly();
    await withBackend(server, async (genpage) => {
      const out = await genpage.create({ name: 'Overview', source: SOURCE, prompt: 'p', agentMessage: 'r' });
      assert.deepStrictEqual(projectIds(server), [out.pageId], `Retry-After: ${header}`);
      assert.strictEqual(server.batches.length, 4);
      assert.deepStrictEqual(slept, waits, `Retry-After: ${header}`);
    }, deps);
  }
});

test('REAL BUNDLE: an update the service refuses with a throttle (429) waits and goes again — the turn is recorded once and only what differs is written', async () => {
  const server = makeServer();
  const { slept, deps } = quickly();
  await withBackend(server, async (genpage) => {
    const { pageId } = await genpage.create({ name: 'Overview', source: SOURCE, prompt: 'first', agentMessage: 'ok' });
    server.failBatch = (n) => (n === 2 ? { status: 429, headers: { 'retry-after': '3' } } : undefined);
    server.requests.length = 0;
    const out = await genpage.update(pageId, { source: SOURCE.replace('Hello', 'Ninth'), prompt: 'ninth', agentMessage: 'done' });
    assert.deepStrictEqual(slept, [3000]);
    assert.strictEqual(server.batches.length, 3, 'the create, the update that was refused, and the update that was taken');
    assert.deepStrictEqual(snapshot(server, pageId).messages, ['first', 'ok', 'ninth', 'done'], 'the turn is recorded once');
    assert.strictEqual(snapshot(server, pageId).files[PAGE_TSX], SOURCE.replace('Hello', 'Ninth'));
    assert.strictEqual(out.publish.kind, 'verified');
    assert.match(out.warnings.join('\n'), /^the service throttled the write of generative page "Overview" \([0-9a-f-]{36}\) \(HTTP 429\) once: a refused request writes nothing, so it was sent again after waiting 3 s, and written once$/);
    assert.deepStrictEqual(describeWrites(server, pageId), [
      '[batch] PATCH file src/pages/page.tsx',
      '[batch] PATCH file src/pages/page.compiled',
      '[batch] PATCH project',
      '[batch] POST /agentconversationmessages',
      '[batch] POST /agentconversationmessages',
    ], 'what the change set that was taken wrote — the refused one wrote nothing — and no other row');
  }, deps);
});

// The wait is a window in which someone else can save the page. The SDK compares the version tokens of the page's rows with the ones this operation read first, on EVERY push — so the resend is refused when they
// moved, and nothing is written over what the other writer saved. (An HTTP-level resend of the same request could not do this: its `If-Match: *` writes carry no version, and the check had already been made.)
test('REAL BUNDLE: a page another writer saves while an update waits out a throttle is NOT overwritten — the SDK\'s version check refuses the resend, and no second change set is sent', async () => {
  const server = makeServer();
  const theirs = 'export default function Theirs() { return null; }\n';
  let pageId;
  const slept = [];
  await withBackend(server, async (genpage) => {
    ({ pageId } = await genpage.create({ name: 'Overview', source: SOURCE, prompt: 'first', agentMessage: 'ok' }));
    server.failBatch = (n) => (n === 2 ? 429 : undefined);
    const batches = server.batches.length;
    const error = await genpage.update(pageId, { source: SOURCE.replace('Hello', 'Tenth'), prompt: 'tenth', agentMessage: 'done', caller: 'build' }).then(() => null, (e) => e);
    assert.ok(error, 'the update is refused');
    assert.strictEqual(error.code, 'VERSION_CONFLICT');
    assert.strictEqual(error.outcome, 'nothing', 'the SDK compared the version tokens before it wrote anything');
    assert.strictEqual(error.transient, false, 'a page someone else changed is read again by the next run, not sent over by this one');
    assert.strictEqual(server.batches.length, batches + 1, 'only the refused change set was ever sent: the resend stopped at the version check');
    assert.strictEqual(snapshot(server, pageId).files[PAGE_TSX], theirs, 'the other writer\'s save is what the page holds');
    assert.deepStrictEqual(snapshot(server, pageId).messages, ['first', 'ok'], 'and no turn was recorded');
  }, { sleep: async (ms) => { slept.push(ms); server.otherWorkspaceDraft(pageId, PAGE_TSX, theirs); }, random: () => 0 });
  assert.deepStrictEqual(slept, [1000]);
});

test('REAL BUNDLE: a throttle that outlasts the waits writes nothing and is not final — six change sets were sent and refused, no page exists, and a healthy run afterwards creates it', async () => {
  const server = makeServer();
  server.failBatch = () => 429;
  const { slept, deps } = quickly();
  await withBackend(server, async (genpage) => {
    const error = await genpage.create({ name: 'Overview', source: SOURCE, prompt: 'p', agentMessage: 'r' }).then(() => null, (e) => e);
    assert.ok(error);
    assert.strictEqual(error.outcome, 'nothing');
    assert.strictEqual(error.pageId, undefined);
    assert.notStrictEqual(error.transient, false);
    assert.strictEqual(error.cause.statusCode, 429);
    assert.strictEqual(server.batches.length, 6);
    assert.deepStrictEqual(slept, [1000, 2000, 4000, 8000, 8000]);
    assert.deepStrictEqual(projectIds(server), [], 'nothing was written');

    server.failBatch = undefined;
    const out = await genpage.create({ name: 'Overview', source: SOURCE, prompt: 'p', agentMessage: 'r' });
    assert.deepStrictEqual(projectIds(server), [out.pageId]);
    assert.deepStrictEqual(snapshot(server, out.pageId).messages, ['p', 'r']);
  }, deps);
});

// The wait is the real one here (no `sleep` seam), and a minute long: dispose() ends it, the create stops with the backend's own "closed" error instead of sleeping on, and it sends nothing after the wake-up — a build that is
// told to stop must not write a page a minute later, into a workspace that is gone.
test('REAL BUNDLE: dispose() while a throttle is being waited out ends the wait at once — the create stops, sends nothing more, and leaves no timer behind', async () => {
  const server = makeServer();
  server.failBatch = (n) => (n === 1 ? { status: 429, headers: { 'retry-after': '60' } } : undefined);
  const { genpage, made } = harness(server);
  const creating = genpage.create({ name: 'Overview', source: SOURCE, prompt: 'p', agentMessage: 'r' }).then(() => null, (e) => e);
  while (server.batches.length < 1) await turns(1);
  // The refusal is answered and the backend is asleep for the minute the answer asked for (the wait starts a few turns after the refused change set was received).
  await turns(200);
  assert.strictEqual(server.batches.length, 1, 'the change set was refused, and the wait began');
  const ended = await Promise.race([
    genpage.dispose().then(() => creating),
    new Promise((resolve) => { setTimeout(() => resolve('the wait was not ended'), 10000).unref(); }),
  ]);
  assert.ok(ended && ended.code === 'GENPAGE_BACKEND_CLOSED', `the create ended with the backend's closed error: ${ended && (ended.code || ended)}`);
  assert.strictEqual(server.batches.length, 1, 'and nothing was sent after the wait ended');
  assert.deepStrictEqual(projectIds(server), []);
  for (const dir of made) assert.ok(!fs.existsSync(dir), 'the workspace is gone');
});

// A 503 is a different answer: it comes from something between the caller and the service, so the request may have committed. It is settled the way every unknown outcome is — the page is read, and it is sent once
// more only if it is not there — and when the answer asks to wait (Retry-After) the wait comes BEFORE that read, so a request still on its way has had the time to land. Without a Retry-After nothing is waited for.
test('REAL BUNDLE: a send the gateway answers 503 with a Retry-After is read for only after the wait — and, not found, sent once more under the same id', async () => {
  const server = makeServer();
  server.failBatch = (n) => (n === 1 ? { status: 503, headers: { 'retry-after': '3' } } : undefined);
  const before = [];
  const slept = [];
  await withBackend(server, async (genpage) => {
    const out = await genpage.create({ name: 'Overview', source: SOURCE, prompt: 'p', agentMessage: 'r' });
    assert.deepStrictEqual(slept, [3000]);
    assert.deepStrictEqual(before, ['POST /$batch'], 'the last thing the service heard before the wait was the refused change set: the read comes after it');
    assert.strictEqual(server.batches.length, 2);
    const sends = server.requests.map((r, at) => (r.path === '/$batch' ? at : -1)).filter((at) => at >= 0);
    assert.ok(server.requests.slice(sends[0] + 1, sends[1]).some((r) => r.method === 'GET' && /^\/uxagentprojects\(/.test(r.path)), 'the page was read between the two sends: a 503 may have committed, so it is reconciled and not simply sent again');
    assert.deepStrictEqual(projectIds(server), [out.pageId], 'one page');
    assert.deepStrictEqual(snapshot(server, out.pageId).messages, ['p', 'r']);
  }, { sleep: async (ms) => { slept.push(ms); before.push(`${server.requests[server.requests.length - 1].method} ${server.requests[server.requests.length - 1].path}`); }, random: () => 0 });

  // No Retry-After: the unknown outcome is read for at once, as it always was.
  const plain = makeServer();
  plain.failBatch = (n) => (n === 1 ? 503 : undefined);
  const { slept: none, deps } = quickly();
  await withBackend(plain, async (genpage) => {
    const out = await genpage.create({ name: 'Overview', source: SOURCE, prompt: 'p', agentMessage: 'r' });
    assert.deepStrictEqual(projectIds(plain), [out.pageId]);
    assert.strictEqual(plain.batches.length, 2);
  }, deps);
  assert.deepStrictEqual(none, [], 'nothing to wait for');

  // What an answer asks for is the business of that answer alone: a throttle that asked for 7 s, then a 503 that asked for nothing, is not waited for a second time before the page is read.
  const mixed = makeServer();
  mixed.failBatch = (n) => (n === 1 ? { status: 429, headers: { 'retry-after': '7' } } : n === 2 ? 503 : undefined);
  const { slept: once, deps: onceDeps } = quickly();
  await withBackend(mixed, async (genpage) => {
    const out = await genpage.create({ name: 'Overview', source: SOURCE, prompt: 'p', agentMessage: 'r' });
    assert.deepStrictEqual(projectIds(mixed), [out.pageId]);
    assert.strictEqual(mixed.batches.length, 3, 'refused, lost, and the one more that was sent after the page was read');
  }, onceDeps);
  assert.deepStrictEqual(once, [7000], 'the throttle\'s wait, and no other');
});

test('REAL BUNDLE: an update the gateway answers 503 with a Retry-After is read for only after the wait — and, found as it was, sent once more with the same turn', async () => {
  const server = makeServer();
  const before = [];
  const slept = [];
  await withBackend(server, async (genpage) => {
    const { pageId } = await genpage.create({ name: 'Overview', source: SOURCE, prompt: 'first', agentMessage: 'ok' });
    server.failBatch = (n) => (n === 2 ? { status: 503, headers: { 'retry-after': '4' } } : undefined);
    const mark = server.requests.length;
    const out = await genpage.update(pageId, { source: SOURCE.replace('Hello', 'Eleventh'), prompt: 'eleventh', agentMessage: 'done' });
    assert.deepStrictEqual(slept, [4000]);
    assert.deepStrictEqual(before, ['POST /$batch'], 'the last thing the service heard before the wait was the refused change set');
    const sends = server.requests.map((r, at) => (r.path === '/$batch' && at >= mark ? at : -1)).filter((at) => at >= 0);
    assert.strictEqual(sends.length, 2, 'the update was sent twice');
    assert.ok(server.requests.slice(sends[0] + 1, sends[1]).some((r) => r.method === 'GET' && /^\/uxagentprojects\(/.test(r.path)), 'and the page was read between the two sends');
    assert.deepStrictEqual(snapshot(server, pageId).messages, ['first', 'ok', 'eleventh', 'done'], 'the turn is recorded once');
    assert.strictEqual(snapshot(server, pageId).files[PAGE_TSX], SOURCE.replace('Hello', 'Eleventh'));
    assert.strictEqual(out.publish.kind, 'verified');
  }, { sleep: async (ms) => { slept.push(ms); const last = server.requests[server.requests.length - 1]; before.push(`${last.method} ${last.path}`); }, random: () => 0 });
});

// The production client does not send a page's `$batch` again itself (sdk-http-client.test.js holds that: an update's `If-Match: *` writes would skip the SDK's version check), so the throttle reaches the backend, with the
// headers its answer carried: that is what the backend reads Retry-After from.
test('REAL BUNDLE: through the production HTTP client a throttled page write is not re-sent by the client — the backend waits what the answer\'s Retry-After asked, and sends it again', async () => {
  const { createAzHttpClient } = require('../lib/sdk-http-client.js');
  const server = makeServer();
  server.failBatch = (n) => (n === 1 ? { status: 429, headers: { 'retry-after': '5' } } : undefined);
  const raw = server.http();
  const clientSleeps = [];
  const client = createAzHttpClient(INSTANCE, {
    getToken: () => 'TOK', sleep: async (ms) => { clientSleeps.push(ms); }, random: () => 0,
    request: async ({ url, method, headers, body }) => {
      const answer = method === 'POST' && url.endsWith('/$batch') ? await raw.postRaw(url, body, { headers })
        : method === 'GET' ? await raw.get(url, { headers })
          : method === 'DELETE' ? await raw.delete(url, { headers })
            : method === 'PATCH' && Buffer.isBuffer(body) ? await raw.patchRaw(url, body, { headers })
              : await raw[method.toLowerCase()](url, typeof body === 'string' ? JSON.parse(body) : body, { headers });
      const text = typeof answer.body === 'string' || Buffer.isBuffer(answer.body) ? answer.body : JSON.stringify(answer.body === undefined ? null : answer.body);
      return { statusCode: answer.status, headers: answer.headers || {}, body: text };
    },
  });
  const { slept, deps } = quickly();
  await withBackend(server, async (genpage) => {
    const out = await genpage.create({ name: 'Overview', source: SOURCE, prompt: 'p', agentMessage: 'r' });
    assert.deepStrictEqual(projectIds(server), [out.pageId]);
    assert.strictEqual(server.batches.length, 2);
    assert.deepStrictEqual(clientSleeps, [], 'the client did not back off and re-send: a page\'s change set is the backend\'s to send again');
    assert.deepStrictEqual(slept, [5000], 'the backend waited what the answer asked');
  }, { ...deps, httpClient: client });
});

// ── A change set the service refuses AS A WHOLE ─────────────────────────────────────────────────────────────────────────────────
// A refused atomic change set is answered HTTP 200 with the ONE part that failed, and the SDK reports it as an answer it cannot account for (a ConnectionError of status 200: "the change set reported 1 result(s) for 12 operation(s)").
// That says nothing of WHY, so the backend used to take every such answer for an unknown outcome: read the page, send once more, and end "sent twice and neither answer could be used" — for a 403 that no send could change, and for a 429
// whose next send would have been taken. The backend reads the parts where the answer passes (watchThrottles), with the HTTP client's own strict parser: a COMPLETE answer whose every part is one 400, 403 or 404 proves the change set wrote
// nothing and is sent once; one whose every part is a 429 is waited out on the page's throttle path — the same sends, the same waits, the SDK's version check on every one. Anything else (a mix, an answer cut off, a collision, a 500) is
// exactly what it was: an unknown outcome, read for before anything is sent again.
const { batchEnvelope } = require('./helpers/fake-genpage-server.js');

test('REAL BUNDLE: a change set refused as a whole with a 400, a 403 or a 404 — an HTTP 200 whose one part says so — wrote nothing and is sent ONCE, whether it creates a page or updates one', async () => {
  const { isTransientHalt } = require('../build-model-app.js');
  for (const mode of ['create', 'update']) {
    for (const status of [400, 403, 404]) {
      const server = makeServer();
      const { slept, deps } = quickly();
      await withBackend(server, async (genpage) => {
        let pageId;
        if (mode === 'update') ({ pageId } = await genpage.create({ name: 'Overview', source: SOURCE, prompt: 'first', agentMessage: 'ok' }));
        const before = server.batches.length;
        server.failOn = (_method, _path, batched) => (batched ? status : undefined);
        const error = await (mode === 'create'
          ? genpage.create({ name: 'Overview', source: SOURCE, prompt: 'p', agentMessage: 'r' })
          : genpage.update(pageId, { source: SOURCE.replace('Hello', 'Second'), prompt: 'second', agentMessage: 'done' })).then(() => null, (e) => e);
        const where = `${mode} refused with ${status}`;
        assert.ok(error, where);
        assert.strictEqual(server.batches.length - before, 1, `${where}: one change set was sent, and no other`);
        assert.deepStrictEqual(slept, [], `${where}: nothing waited for`);
        assert.strictEqual(error.outcome, 'nothing', where);
        assert.strictEqual(error.transient, false, `${where}: nothing a run again can change`);
        assert.strictEqual(error.code, 'CONNECTION_ERROR', where);
        assert.strictEqual(isTransientHalt(error), false, where);
        assert.match(error.message, new RegExp(`the service refused the change set with HTTP ${status}`), `${where}: the message says what the answer proved`);
        assert.match(error.message, mode === 'create' ? /was not created \(nothing was written\)/ : /failed and wrote nothing/, where);
        if (mode === 'create') {
          assert.strictEqual(error.pageId, undefined, where);
          assert.deepStrictEqual(projectIds(server), [], `${where}: no page`);
        } else {
          assert.strictEqual(error.pageId, pageId, where);
          assert.deepStrictEqual(snapshot(server, pageId).messages, ['first', 'ok'], `${where}: no turn was recorded`);
          assert.strictEqual(snapshot(server, pageId).files[PAGE_TSX], SOURCE, `${where}: the page is as it was`);
        }
      }, deps);
    }
  }
});

test('REAL BUNDLE: a change set refused as a whole with a 429 inside its HTTP 200 is waited out — the refused part\'s own Retry-After — and sent again: one page, one turn, and the update\'s version check on the send that is taken', async () => {
  for (const mode of ['create', 'update']) {
    const server = makeServer();
    const { slept, deps } = quickly();
    await withBackend(server, async (genpage) => {
      let pageId;
      if (mode === 'update') ({ pageId } = await genpage.create({ name: 'Overview', source: SOURCE, prompt: 'first', agentMessage: 'ok' }));
      const before = server.batches.length;
      let refused = 0;
      server.failOn = (_method, _path, batched) => (batched && refused++ < 2 ? { status: 429, headers: { 'Retry-After': '7' } } : undefined);
      const out = mode === 'create'
        ? await genpage.create({ name: 'Overview', source: SOURCE, prompt: 'p', agentMessage: 'r' })
        : await genpage.update(pageId, { source: SOURCE.replace('Hello', 'Second'), prompt: 'second', agentMessage: 'done' });
      assert.strictEqual(server.batches.length - before, 3, `${mode}: two refusals, and the change set that was taken`);
      assert.deepStrictEqual(slept, [7000, 7000], `${mode}: what the refused part asked for, each time`);
      assert.deepStrictEqual(projectIds(server), [out.pageId], `${mode}: one page`);
      assert.deepStrictEqual(snapshot(server, out.pageId).messages, mode === 'create' ? ['p', 'r'] : ['first', 'ok', 'second', 'done'], `${mode}: the turn is in the conversation once`);
      assert.strictEqual(out.publish.kind, 'verified');
      assert.match(out.warnings.join('\n'), /the service throttled the write of generative page .* \(HTTP 429\) 2 times: a refused request writes nothing, so it was sent again after waiting 7 s, 7 s, and written once$/, mode);
    }, deps);
  }
});

test('REAL BUNDLE: an update whose change set is refused with a 429 inside HTTP 200 meets the SDK\'s version check again — a page another writer saves during the wait is NOT overwritten', async () => {
  const server = makeServer();
  const theirs = 'export default function Theirs() { return null; }\n';
  const slept = [];
  await withBackend(server, async (genpage) => {
    const { pageId } = await genpage.create({ name: 'Overview', source: SOURCE, prompt: 'first', agentMessage: 'ok' });
    let refused = 0;
    server.failOn = (_method, _path, batched) => (batched && refused++ < 1 ? { status: 429, headers: { 'Retry-After': '3' } } : undefined);
    const batches = server.batches.length;
    const error = await genpage.update(pageId, { source: SOURCE.replace('Hello', 'Tenth'), prompt: 'tenth', agentMessage: 'done', caller: 'build' }).then(() => null, (e) => e);
    assert.ok(error, 'the update is refused');
    assert.strictEqual(error.code, 'VERSION_CONFLICT');
    assert.strictEqual(error.outcome, 'nothing');
    assert.strictEqual(error.transient, false);
    assert.strictEqual(server.batches.length, batches + 1, 'only the refused change set was ever sent: the resend stopped at the version check');
    assert.strictEqual(snapshot(server, pageId).files[PAGE_TSX], theirs, 'the other writer\'s save is what the page holds');
    assert.deepStrictEqual(snapshot(server, pageId).messages, ['first', 'ok'], 'and no turn was recorded');
    assert.deepStrictEqual(slept, [3000]);
  }, { sleep: async (ms) => { slept.push(ms); server.otherWorkspaceDraft(projectIds(server)[0], PAGE_TSX, theirs); }, random: () => 0 });
});

// What the answer does NOT prove stays what it was. `crafted` rewrites the answer the service gave, the way a mix, a cut-off and a collision look on the wire.
test('REAL BUNDLE: a refused change set that is not a COMPLETE refusal — a mix of statuses, an answer cut off, a part or a change set left incomplete inside a closed envelope (an operation with no response, a change set declared and absent, a body shorter than its Content-Length, a body that declares a transfer coding), a collision (409, 412) or an internal error (500) — is still an unknown outcome: read for, sent once more, and never "nothing was written"', async () => {
  const { isTransientHalt } = require('../build-model-app.js');
  const mix = (answer) => ({ ...answer, body: batchEnvelope([{ contentId: 1, status: 403 }, { contentId: 2, status: 429, headers: { 'Retry-After': '7' } }]) });
  const cut = (answer) => ({ ...answer, body: answer.body.replace(/--batchresponse_[^\r\n]+--\r\n$/, '') });
  // Closed at the OUTER boundary and still incomplete inside: the one complete refusal in it is not taken for the whole answer.
  const unclosed = (answer) => ({ ...answer, body: answer.body.replace(/--changesetresponse_[^\r\n]+--\r\n/, '') });
  const partCutOff = (answer) => ({ ...answer, body: answer.body.replace(/(--changesetresponse_[^\r\n]+)--\r\n/, '$1\r\nContent-Type: application/http\r\n\r\nHTTP/1.1 20\r\n$1--\r\n') });
  // Complete at EVERY delimiter, and still not what the delimiters say: an operation part with no response at all, a part that declares a change set the answer never contains, a declared boundary the delimiters do not use, a body not as long as its
  // response says. Each leaves a neighbouring complete refusal to speak for the whole answer, and none of them is a proof.
  const emptyPart = (answer) => ({ ...answer, body: answer.body.replace(/(--changesetresponse_[^\r\n]+)--\r\n/, '$1\r\n$1--\r\n') });
  const declaredAbsent = (answer) => ({ ...answer, body: answer.body.replace(/(--batchresponse_[^\r\n]+)--\r\n$/, '$1\r\nContent-Type: multipart/mixed; boundary=changesetresponse_missing\r\n\r\n$1--\r\n') });
  const otherBoundary = (answer) => ({ ...answer, body: answer.body.replace(/boundary=changesetresponse_[^\r\n]+/, 'boundary=changesetresponse_missing') });
  const shortBody = (answer) => ({ ...answer, body: answer.body.replace('OData-Version: 4.0\r\n\r\n', 'OData-Version: 4.0\r\nContent-Length: 200\r\n\r\n{\r\n') });
  // A part that declares a transfer coding is not read, whole or not: the delimiters around it say nothing of whether its chunk stream is finished. The five ways a chunk stream is unfinished — and one that is whole — each inside a part
  // that is otherwise complete, so a complete refusal sits in the answer.
  const chunked = (stream) => (answer) => ({ ...answer, body: answer.body.replace('OData-Version: 4.0\r\n\r\n', `OData-Version: 4.0\r\nTransfer-Encoding: chunked\r\n\r\n${stream}`) });
  const noTerminalChunk = chunked('2\r\n{}\r\n');
  const longChunk = chunked('200\r\n{\r\n');
  const noChunkStream = chunked('');
  const badChunkSize = chunked('xyz\r\n{}\r\n0\r\n\r\n');
  const cutTrailer = chunked('2\r\n{}\r\n0\r\nX-Trace:\r\n');
  const wholeChunks = chunked('2\r\n{}\r\n0\r\n\r\n');
  const RETRY_429 = { status: 429, headers: { 'Retry-After': '7' } };
  const CASES = [
    ['a mix of a 403 and a 429', 403, mix],
    ['an answer cut off before its closing boundary', 403, cut],
    ['an answer closed at its outer boundary whose change set is never closed, beside a 429', RETRY_429, unclosed],
    ['an answer closed at its outer boundary with a part cut off in its status line, beside a 429', RETRY_429, partCutOff],
    ['the same beside a 403', 403, partCutOff],
    ['an operation part with no response at all, after a complete 429', RETRY_429, emptyPart],
    ['an operation part with no response at all, after a complete 403', 403, emptyPart],
    ['a part that declares a change set the answer never contains, beside a complete 429', RETRY_429, declaredAbsent],
    ['the same beside a 403', 403, declaredAbsent],
    ['a declared change-set boundary the delimiters do not use, around a complete 429', RETRY_429, otherBoundary],
    ['a body shorter than the Content-Length its response declares, on a 429', RETRY_429, shortBody],
    ['a body shorter than the Content-Length its response declares, on a 403', 403, shortBody],
    ['a chunked body with no terminal chunk, on a 429', RETRY_429, noTerminalChunk],
    ['the same on a 403', 403, noTerminalChunk],
    ['a first chunk longer than the body that follows it, on a 429', RETRY_429, longChunk],
    ['the same on a 403', 403, longChunk],
    ['a response that says it is chunked and has no chunk stream, on a 429', RETRY_429, noChunkStream],
    ['the same on a 403', 403, noChunkStream],
    ['a chunk size that is not hexadecimal, on a 429', RETRY_429, badChunkSize],
    ['the same on a 403', 403, badChunkSize],
    ['a chunked trailer that is cut off, on a 429', RETRY_429, cutTrailer],
    ['the same on a 403', 403, cutTrailer],
    ['a chunked body that is whole, on a 429 — a transfer coding is not read', RETRY_429, wholeChunks],
    ['the same on a 403', 403, wholeChunks],
    ['a 409', 409, (answer) => answer],
    ['a 412', 412, (answer) => answer],
    ['a 500', 500, (answer) => answer],
  ];
  for (const mode of ['create', 'update']) {
    for (const [what, status, rewrite] of CASES) {
      const server = makeServer();
      const { slept, deps } = quickly();
      const raw = server.http();
      const crafted = { ...raw, postRaw: async (url, body, options) => rewrite(await raw.postRaw(url, body, options)) };
      await withBackend(server, async (genpage) => {
        let pageId;
        if (mode === 'update') ({ pageId } = await genpage.create({ name: 'Overview', source: SOURCE, prompt: 'first', agentMessage: 'ok' }));
        const before = server.batches.length;
        server.failOn = (_method, _path, batched) => (batched ? status : undefined);
        const error = await (mode === 'create'
          ? genpage.create({ name: 'Overview', source: SOURCE, prompt: 'p', agentMessage: 'r' })
          : genpage.update(pageId, { source: SOURCE.replace('Hello', 'Second'), prompt: 'second', agentMessage: 'done' })).then(() => null, (e) => e);
        const where = `${mode}, ${what}`;
        assert.ok(error, where);
        assert.strictEqual(error.outcome, 'unknown', `${where}: the answer proves nothing, so nothing is said to be unwritten`);
        assert.strictEqual(error.transient, false, where);
        assert.strictEqual(isTransientHalt(error), false, `${where}: the build does not run it again either — a third send would be made on no proof`);
        assert.strictEqual(server.batches.length - before, 2, `${where}: sent, read for, and sent once more — never a third time`);
        assert.deepStrictEqual(slept, [], `${where}: and no throttle was waited out`);
        assert.doesNotMatch(error.message, /the service refused the change set with/, where);
      }, { ...deps, httpClient: crafted });
    }
  }
});

// The production client hands the backend the answer as a string, with the headers it carried: this is the shape the parts are read from.
test('REAL BUNDLE: through the production HTTP client a change set refused with a 403, or a 429 inside HTTP 200, is read the same way — once, or waited out whole', async () => {
  const { createAzHttpClient } = require('../lib/sdk-http-client.js');
  // `rewrite` changes the text of a `$batch` answer on its way out of the transport, the way a gateway can damage one.
  const productionClient = (server, rewrite = (text) => text) => {
    const raw = server.http();
    return createAzHttpClient(INSTANCE, {
      getToken: () => 'TOK', sleep: async () => {}, random: () => 0,
      request: async ({ url, method, headers, body }) => {
        const answer = method === 'POST' && url.endsWith('/$batch') ? await raw.postRaw(url, body, { headers })
          : method === 'GET' ? await raw.get(url, { headers })
            : method === 'DELETE' ? await raw.delete(url, { headers })
              : method === 'PATCH' && Buffer.isBuffer(body) ? await raw.patchRaw(url, body, { headers })
                : await raw[method.toLowerCase()](url, typeof body === 'string' ? JSON.parse(body) : body, { headers });
        const text = typeof answer.body === 'string' || Buffer.isBuffer(answer.body) ? answer.body : JSON.stringify(answer.body === undefined ? null : answer.body);
        return { statusCode: answer.status, headers: answer.headers || {}, body: method === 'POST' && url.endsWith('/$batch') ? rewrite(text) : text };
      },
    });
  };
  const forbidden = makeServer();
  forbidden.failOn = (_method, _path, batched) => (batched ? 403 : undefined);
  const first = quickly();
  await withBackend(forbidden, async (genpage) => {
    const error = await genpage.create({ name: 'Overview', source: SOURCE, prompt: 'p', agentMessage: 'r' }).then(() => null, (e) => e);
    assert.strictEqual(error.outcome, 'nothing');
    assert.strictEqual(forbidden.batches.length, 1);
  }, { ...first.deps, httpClient: productionClient(forbidden) });
  assert.deepStrictEqual(first.slept, []);

  const throttled = makeServer();
  let refused = 0;
  throttled.failOn = (_method, _path, batched) => (batched && refused++ < 1 ? { status: 429, headers: { 'Retry-After': '5' } } : undefined);
  const second = quickly();
  await withBackend(throttled, async (genpage) => {
    const out = await genpage.create({ name: 'Overview', source: SOURCE, prompt: 'p', agentMessage: 'r' });
    assert.deepStrictEqual(projectIds(throttled), [out.pageId]);
    assert.strictEqual(throttled.batches.length, 2);
  }, { ...second.deps, httpClient: productionClient(throttled) });
  assert.deepStrictEqual(second.slept, [5000]);

  // The same answer with its change set's closing delimiter taken away — the outer boundary still closes — proves nothing through the production client either: the 429 in it is not waited out, and the write is an unknown outcome.
  const damaged = makeServer();
  damaged.failOn = (_method, _path, batched) => (batched ? { status: 429, headers: { 'Retry-After': '5' } } : undefined);
  const third = quickly();
  await withBackend(damaged, async (genpage) => {
    const error = await genpage.create({ name: 'Overview', source: SOURCE, prompt: 'p', agentMessage: 'r' }).then(() => null, (e) => e);
    assert.strictEqual(error.outcome, 'unknown');
    assert.strictEqual(error.transient, false);
    assert.strictEqual(damaged.batches.length, 2, 'sent, read for, and sent once more — never a third time');
  }, { ...third.deps, httpClient: productionClient(damaged, (text) => text.replace(/--changesetresponse_[^\r\n]+--\r\n/, '')) });
  assert.deepStrictEqual(third.slept, []);
});

// An envelope that closes its OUTER boundary and is incomplete inside, answered to EVERY send by a service that answers nothing else: the backend still ends the create as an unknown outcome, sent twice under the same id and never
// waited out, and the build does not run it again.
const incompleteEnvelope = (shape) => {
  const lines = [
    '--batchresponse_incomplete', 'Content-Type: multipart/mixed; boundary=changesetresponse_incomplete', '',
    '--changesetresponse_incomplete', 'Content-Type: application/http', 'Content-Transfer-Encoding: binary', '',
    'HTTP/1.1 429 Too Many Requests', 'Retry-After: 7', 'Content-Type: application/json', '', '{"error":{"message":"throttled"}}',
  ];
  if (shape === 'a part cut off in its status line') lines.push('--changesetresponse_incomplete', 'Content-Type: application/http', '', 'HTTP/1.1 20', '--changesetresponse_incomplete--');
  lines.push('--batchresponse_incomplete--', '');
  return lines.join('\r\n');
};
for (const shape of ['a change set that is never closed', 'a part cut off in its status line']) {
  test(`REAL BUNDLE: an HTTP 200 that closes its outer boundary but holds ${shape}, beside a complete 429, is an unknown outcome — never a throttle and never "nothing was written"`, async () => {
    const { isTransientHalt } = require('../build-model-app.js');
    const { completeBatchStatus, isBatchThrottled } = require('../lib/sdk-http-client.js');
    const body = incompleteEnvelope(shape);
    assert.strictEqual(completeBatchStatus({ body }), 0, 'the parser proves no status');
    assert.strictEqual(isBatchThrottled({ statusCode: 200, body }), false, 'and no throttle');
    const server = makeServer();
    const raw = server.http();
    let sends = 0;
    const { slept, deps } = quickly();
    await withBackend(server, async (genpage) => {
      const error = await genpage.create({ name: 'Overview', source: SOURCE, prompt: 'p', agentMessage: 'r' }).then(() => null, (e) => e);
      assert.ok(error, 'the malformed answer cannot prove success');
      assert.strictEqual(error.outcome, 'unknown', 'an incomplete change set answer does not prove that nothing was written');
      assert.strictEqual(error.transient, false);
      assert.strictEqual(isTransientHalt(error), false, 'the build does not replay an unaccounted page create');
      assert.strictEqual(sends, 2, 'only the id-preserving reconciliation resends it, once');
      assert.deepStrictEqual(slept, [], 'and no throttle is waited out');
      assert.match(error.message, /sent twice and neither answer could be used/);
      assert.match(error.pageId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'the error names the id the create was sent under, so the page can be looked for');
    }, { ...deps, httpClient: { ...raw, postRaw: async () => { sends += 1; return { status: 200, headers: {}, body }; } } });
  });
}

// ── The waits of a throttled page write are one budget, and what the service asked travels with the error ─────────────────────────────────────────────
// A throttled answer's Retry-After is waited out WHOLE — the HTTP client's cap is for its own retries — but inside the budget a run allows its own retry layers for waiting out a throttle (lib/throttle-budget.js: five minutes). When the next
// wait does not fit, the write stops: nothing more is sent, and the error says what the service asked and carries the moment before which nothing may be sent (`retryNotBefore`), for the layer that runs the build again.
const { makeThrottleBudget } = require('../lib/throttle-budget.js');
const asking = (seconds, until = Infinity) => (n) => (n <= until ? { status: 429, headers: { 'retry-after': String(seconds) } } : undefined);

test('REAL BUNDLE: a Retry-After longer than the HTTP client\'s cap is waited out whole when it fits the budget — two minutes are two minutes', async () => {
  const server = makeServer();
  server.failBatch = asking(120, 1);
  const { slept, deps } = quickly();
  const budget = makeThrottleBudget();
  await withBackend(server, async (genpage) => {
    const out = await genpage.create({ name: 'Overview', source: SOURCE, prompt: 'p', agentMessage: 'r', throttle: budget });
    assert.deepStrictEqual(projectIds(server), [out.pageId]);
    assert.deepStrictEqual(slept, [120000], 'the whole of it');
    assert.strictEqual(budget.spentMs(), 120000, 'and it came out of the budget');
    assert.match(out.warnings.join('\n'), /after waiting 120 s, and written once$/);
  }, deps);
});

test('REAL BUNDLE: an ask that does not fit the budget stops the write — nothing is waited for or sent again — and the error says what the service asked and carries the moment before which nothing may be sent', async () => {
  const { isTransientHalt } = require('../build-model-app.js');
  for (const mode of ['create', 'update']) {
    const server = makeServer();
    const { slept, deps } = quickly();
    const budget = makeThrottleBudget();
    await withBackend(server, async (genpage) => {
      let pageId;
      if (mode === 'update') ({ pageId } = await genpage.create({ name: 'Overview', source: SOURCE, prompt: 'first', agentMessage: 'ok' }));
      const before = server.batches.length;
      server.failBatch = (n) => (n === before + 1 ? { status: 429, headers: { 'retry-after': '600' } } : undefined);
      const error = await (mode === 'create'
        ? genpage.create({ name: 'Overview', source: SOURCE, prompt: 'p', agentMessage: 'r', throttle: budget })
        : genpage.update(pageId, { source: SOURCE.replace('Hello', 'Second'), prompt: 'second', agentMessage: 'done', throttle: budget })).then(() => null, (e) => e);
      assert.ok(error, mode);
      assert.strictEqual(server.batches.length - before, 1, `${mode}: the change set was sent once, and not again`);
      assert.deepStrictEqual(slept, [], `${mode}: and nothing was waited for`);
      assert.strictEqual(budget.spentMs(), 0, mode);
      assert.strictEqual(error.outcome, 'nothing', mode);
      assert.notStrictEqual(error.transient, false, `${mode}: a throttle is the service's to say, and a later run can go on`);
      assert.strictEqual(isTransientHalt(error), true, mode);
      assert.strictEqual(error.statusCode, 429, mode);
      assert.strictEqual(error.cause.statusCode, 429, `${mode}: the SDK's own error is the cause`);
      assert.strictEqual(error.retryAfterMs, 600000, `${mode}: what the service asked, whole`);
      assert.ok(Math.abs(error.retryNotBefore - (Date.now() + 600000)) < 5000, `${mode}: the moment before which nothing may be sent`);
      assert.match(error.message, /the service asked to wait 600 s before the next send, which does not fit in what is left of the 5 minutes a run allows itself for waiting out a throttled service \(0 s are spent\)/, mode);
      assert.match(error.message, /run the same command again later, and it continues from here/, mode);
      assert.match(error.message, mode === 'create' ? /was not created \(nothing was written\)/ : /failed and wrote nothing/, mode);
      if (mode === 'create') assert.deepStrictEqual(projectIds(server), [], 'no page');
      else assert.deepStrictEqual(snapshot(server, pageId).messages, ['first', 'ok'], 'no turn was recorded');
    }, deps);
  }
});

test('REAL BUNDLE: a throttle that outlasts the sends carries the last ask and its moment — six refusals asking for 7 s wait 7, 7, 7, 8 and 8 s, and the next send is not before 7 s after the sixth answer', async () => {
  const server = makeServer();
  server.failBatch = asking(7);
  const { slept, deps } = quickly();
  const budget = makeThrottleBudget();
  await withBackend(server, async (genpage) => {
    const error = await genpage.create({ name: 'Overview', source: SOURCE, prompt: 'p', agentMessage: 'r', throttle: budget }).then(() => null, (e) => e);
    assert.ok(error);
    assert.strictEqual(server.batches.length, 6);
    assert.deepStrictEqual(slept, [7000, 7000, 7000, 8000, 8000], 'the longer of the schedule and the ask, each time');
    assert.strictEqual(budget.spentMs(), 37000);
    assert.strictEqual(error.retryAfterMs, 7000, 'the last answer\'s ask — the one the next send waits for');
    assert.ok(Math.abs(error.retryNotBefore - (Date.now() + 7000)) < 5000);
    assert.strictEqual(error.statusCode, 429);
    assert.doesNotMatch(error.message, /does not fit/, 'the sends ran out, not the budget');
  }, deps);
  // A throttle that never said how long carries no ask — the build's own backoff is then all there is.
  const bare = makeServer();
  bare.failBatch = () => 429;
  const plain = quickly();
  await withBackend(bare, async (genpage) => {
    const error = await genpage.create({ name: 'Overview', source: SOURCE, prompt: 'p', agentMessage: 'r' }).then(() => null, (e) => e);
    assert.strictEqual(error.retryAfterMs, undefined);
    assert.strictEqual(error.retryNotBefore, undefined);
    assert.strictEqual(error.statusCode, 429);
  }, plain.deps);
  assert.deepStrictEqual(plain.slept, [1000, 2000, 4000, 8000, 8000]);
});

test('REAL BUNDLE: the budget is one for everything that uses it — what the first page spent is not there for the second, whose ask then does not fit', async () => {
  const server = makeServer();
  server.failBatch = (n) => (n === 1 || n >= 3 ? { status: 429, headers: { 'retry-after': '60' } } : undefined);
  const { slept, deps } = quickly();
  const budget = makeThrottleBudget({ totalMs: 100000 });
  await withBackend(server, async (genpage) => {
    const first = await genpage.create({ name: 'First', source: SOURCE, prompt: 'p', agentMessage: 'r', throttle: budget });
    assert.deepStrictEqual(slept, [60000]);
    assert.strictEqual(budget.remainingMs(), 40000);
    const error = await genpage.create({ name: 'Second', source: SOURCE.replace('Hello', 'Other'), prompt: 'p', agentMessage: 'r', throttle: budget }).then(() => null, (e) => e);
    assert.ok(error, 'the second page is stopped');
    assert.deepStrictEqual(slept, [60000], 'nothing more was waited for');
    assert.match(error.message, /the service asked to wait 60 s before the next send, which does not fit in what is left of the 100 seconds a run allows itself for waiting out a throttled service \(60 s are spent\)/);
    assert.deepStrictEqual(projectIds(server), [first.pageId], 'only the first page exists');
  }, deps);
  // With no budget given an operation has one of its own: five minutes for this write, and no more.
  const lone = makeServer();
  lone.failBatch = asking(100);
  const alone = quickly();
  await withBackend(lone, async (genpage) => {
    const error = await genpage.create({ name: 'Overview', source: SOURCE, prompt: 'p', agentMessage: 'r' }).then(() => null, (e) => e);
    assert.deepStrictEqual(alone.slept, [100000, 100000, 100000], 'three waits of 100 s are 300 s, and the fourth does not fit');
    assert.strictEqual(lone.batches.length, 4);
    assert.match(error.message, /the service asked to wait 100 s before the next send, which does not fit in what is left of the 5 minutes a run allows itself for waiting out a throttled service \(300 s are spent\)/);
  }, alone.deps);
});

test('REAL BUNDLE: a wait longer than five seconds is announced on the budget\'s warn seam — a shorter one is not — and what the build writes there is a line, never a result', async () => {
  const server = makeServer();
  server.failBatch = (n) => (n === 1 ? { status: 429, headers: { 'retry-after': '2' } } : n === 2 ? { status: 429, headers: { 'retry-after': '45' } } : undefined);
  const { slept, deps } = quickly();
  const lines = [];
  const budget = makeThrottleBudget({ warn: (m) => lines.push(m) });
  await withBackend(server, async (genpage) => {
    await genpage.create({ name: 'Overview', source: SOURCE, prompt: 'p', agentMessage: 'r', throttle: budget });
    assert.deepStrictEqual(slept, [2000, 45000]);
    assert.strictEqual(lines.length, 1, 'only the wait of 45 s is long enough to be worth a line');
    assert.match(lines[0], /^generative page "Overview": the service throttled the write \(HTTP 429\); waiting 45 s before sending it again \(47 s of the 5 minutes a run allows itself for waiting out a throttled service are spent\)$/);
  }, deps);
});

// A 503's Retry-After is waited for before the page is read, so a request still on its way has had the time to land (that read decides whether the page is sent again). It is not a refusal and nothing stops for it, but it is a wait the
// service asked for, so it is counted: what the budget has left is the most it takes, and the client's own cap of a minute is the most it ever took.
test('REAL BUNDLE: the wait before the read that follows a 503 with a Retry-After counts against the budget — at most a minute, and at most what is left — and never stops the write', async () => {
  for (const [what, asked, left, want] of [['a long ask is cut to a minute', 600, 300000, [60000]], ['and to what the budget has left', 600, 10000, [10000]], ['a short one is waited whole', 3, 300000, [3000]], ['nothing left, nothing waited', 30, 0, []]]) {
    const server = makeServer();
    server.failBatch = (n) => (n === 1 ? { status: 503, headers: { 'retry-after': String(asked) } } : undefined);
    const { slept, deps } = quickly();
    const budget = makeThrottleBudget();
    budget.spend(300000 - left);
    await withBackend(server, async (genpage) => {
      const out = await genpage.create({ name: 'Overview', source: SOURCE, prompt: 'p', agentMessage: 'r', throttle: budget });
      assert.deepStrictEqual(projectIds(server), [out.pageId], `${what}: the page was read for, found absent, and sent once more`);
      assert.deepStrictEqual(slept, want, what);
      assert.strictEqual(budget.spentMs(), 300000 - left + want.reduce((sum, ms) => sum + ms, 0), what);
    }, deps);
  }
});

// ── A resumed create that brings an earlier payload up to date spends the budget it was given ───────────────────────────────────────────────────────
// The page a resumed create finds under its id may hold what an earlier create under it sent (another model, say), and the create then brings it to what it asks for through the ordinary update (above). That update is one more page
// write of the same run: its waits come out of the budget the create was given — or, when it was given none, of the one the create made for itself — not out of a new five minutes.
test('REAL BUNDLE: a resumed create that brings an earlier payload up to date spends the budget it was given in that update — what the run spent before is not there for it, and a wait that does not fit stops it', async () => {
  const id = 'd0000000-0000-4000-8000-0000000000e4';
  for (const [what, askSeconds, fits] of [['a wait that does not fit what is left', 7, false], ['a wait that does', 3, true]]) {
    const server = makeServer();
    await earlierCreateLandedLate(server, id, { name: 'Overview', source: SOURCE, model: 'model-one' });
    const prior = server.batches.length;
    // The run's first page is throttled for 295 of its 300 seconds; the update inside the resumed create is throttled after that.
    server.failBatch = (n) => (n === prior + 1 ? { status: 429, headers: { 'retry-after': '295' } } : n === prior + 4 ? { status: 429, headers: { 'retry-after': String(askSeconds) } } : undefined);
    const { slept, deps } = quickly();
    const budget = makeThrottleBudget();
    await withBackend(server, async (genpage) => {
      const first = await genpage.create({ name: 'First', source: SOURCE.replace('Hello', 'First'), prompt: 'p', agentMessage: 'r', throttle: budget });
      assert.strictEqual(budget.spentMs(), 295000, `${what}: the first page's wait is the run's`);
      const resumed = genpage.create({ name: 'Overview', source: SOURCE, model: 'model-two', prompt: 'p2', agentMessage: 'r2', pageId: id, sentBefore: [], throttle: budget });
      if (fits) {
        const out = await resumed;
        assert.deepStrictEqual(slept, [295000, askSeconds * 1000], `${what}: both waits were taken`);
        assert.strictEqual(budget.spentMs(), 295000 + askSeconds * 1000, `${what}: and the update's is in the run's count`);
        assert.strictEqual((await genpage.read(id)).model, 'model-two', `${what}: the page was brought to the model asked for`);
        assert.strictEqual(out.publish.kind, 'verified', what);
        assert.deepStrictEqual(server.published, [first.pageId, id], `${what}: published once, after it was brought up to date`);
      } else {
        const error = await resumed.then(() => null, (e) => e);
        assert.ok(error, `${what}: the update is stopped`);
        assert.deepStrictEqual(slept, [295000], `${what}: the second wait is refused, not taken`);
        assert.strictEqual(budget.spentMs(), 295000, `${what}: and nothing is added to the run's count`);
        assert.strictEqual(error.outcome, 'unknown', `${what}: the page exists, so this create is not "nothing"`);
        assert.strictEqual(error.pageId, id, what);
        assert.strictEqual(error.cause.statusCode, 429, `${what}: the update's own error, a throttle, is the cause`);
        assert.strictEqual(error.cause.retryAfterMs, askSeconds * 1000, `${what}: what the service asked`);
        assert.match(error.message, /bringing it to what this create asks for failed: .*the service asked to wait 7 s before the next send, which does not fit in what is left of the 5 minutes .* \(295 s are spent\)/, what);
        assert.strictEqual(server.batches.length, prior + 4, `${what}: the update's one change set was refused and no other was sent`);
        assert.strictEqual((await genpage.read(id)).model, 'model-one', `${what}: the page is as the earlier create left it`);
        assert.deepStrictEqual(server.published, [first.pageId], `${what}: and was not published`);
      }
    }, deps);
  }
});

test('REAL BUNDLE: a resumed create that was given no budget spends the one it made for itself in that update — the pause before its read and the update\'s wait are one count, and the update\'s long wait says so', async () => {
  const id = 'd0000000-0000-4000-8000-0000000000e5';
  for (const [what, askSeconds, fits] of [['a wait that fits', 100, true], ['a wait that does not', 250, false]]) {
    const server = makeServer();
    await earlierCreateLandedLate(server, id, { name: 'Overview', source: SOURCE, model: 'model-one' });
    const prior = server.batches.length;
    // The resumed create's own send is answered by a gateway that asks to wait (the pause before the page is read, a minute at most); the update that follows is throttled.
    server.failBatch = (n) => (n === prior + 1 ? { status: 503, headers: { 'retry-after': '100' } } : n === prior + 2 ? { status: 429, headers: { 'retry-after': String(askSeconds) } } : undefined);
    const { slept, deps } = quickly();
    const lines = [];
    await withBackend(server, async (genpage) => {
      const resumed = genpage.create({ name: 'Overview', source: SOURCE, model: 'model-two', prompt: 'p2', agentMessage: 'r2', pageId: id, sentBefore: [] });
      if (fits) {
        const out = await resumed;
        assert.deepStrictEqual(slept, [60000, 100000], `${what}: the pause before the read, then the update's wait`);
        assert.strictEqual(lines.length, 2, `${what}: both are long enough to be announced`);
        assert.match(lines[0], /^generative page "Overview": the service asked to wait 60 s before the page is read to see whether the write landed; waiting \(60 s of the 5 minutes /, what);
        assert.match(lines[1], /^generative page "Overview" \(d0000000-[0-9a-f-]+\): the service throttled the write \(HTTP 429\); waiting 100 s before sending it again \(160 s of the 5 minutes /, `${what}: the update's line counts the pause too`);
        assert.strictEqual((await genpage.read(id)).model, 'model-two', what);
        assert.strictEqual(out.publish.kind, 'verified', what);
      } else {
        const error = await resumed.then(() => null, (e) => e);
        assert.ok(error, `${what}: the update is stopped`);
        assert.deepStrictEqual(slept, [60000], `${what}: only the pause was taken`);
        assert.strictEqual(error.outcome, 'unknown', what);
        assert.strictEqual(error.cause.retryAfterMs, 250000, what);
        assert.match(error.message, /the service asked to wait 250 s before the next send, which does not fit in what is left of the 5 minutes .* \(60 s are spent\)/, `${what}: the pause is already spent`);
        assert.strictEqual((await genpage.read(id)).model, 'model-one', `${what}: the page is as the earlier create left it`);
        assert.strictEqual(lines.length, 1, `${what}: the pause was announced, and a refusal is no wait`);
      }
    }, { ...deps, warn: (line) => lines.push(line) });
  }
});

// ── dispose() coordinates with what is still running ──────────────────────────────────────────────────────────────────────────

// The race: the SDK's initialization is stopped at its first storage write, the reads are ended and the backend disposed, and the write is
// released. The SDK then wrote its manifest, the page artifact and a metadata snapshot into the folder dispose() had just removed: the page's source
// stayed in the temp directory.
test('REAL BUNDLE: dispose() while the SDK is still being initialized waits for the write that is under way, then removes the workspace — and nothing the SDK does after that puts it back', async () => {
  const server = makeServer();
  const id = 'd0000000-0000-4000-8000-0000000000a1';
  server.seedPage(id, { name: 'Overview', source: SOURCE });
  let release;
  let reached;
  const held = new Promise((resolve) => { release = resolve; });
  const arrived = new Promise((resolve) => { reached = resolve; });
  let first = true;
  const control = { hold: async (method) => { if (first && (method === 'writeTextAtomic' || method === 'ensureContainer')) { first = false; reached(); await held; } } };
  const { genpage, made } = harness(server, { createStorage: (dir) => flakyStorage(dir, control) });
  const reading = genpage.read(id).then(() => null, (e) => e);
  await arrived;
  assert.strictEqual(made.length, 1);
  assert.ok(fs.existsSync(made[0]), 'the workspace is there while the SDK is starting');

  let finished = false;
  const disposed = Promise.resolve(genpage.dispose()).then(() => { finished = true; });
  await turns();
  assert.strictEqual(finished, false, 'dispose() does not remove a folder while a write to it is under way');
  release();
  await disposed;
  assert.ok(!fs.existsSync(made[0]), 'the workspace is gone when dispose() has finished');

  const error = await reading;
  assert.ok(error, 'the read that was cut short fails instead of finishing');
  assert.strictEqual(error.code, 'GENPAGE_BACKEND_CLOSED');
  await turns(30);
  assert.ok(!fs.existsSync(made[0]), 'nothing the SDK did afterwards recreated it: no manifest, no page artifact, no page source');
  assert.strictEqual(made.length, 1, 'and no second workspace was made');
  await assert.rejects(genpage.read(id), (e) => e.code === 'GENPAGE_BACKEND_CLOSED');
  await assert.rejects(genpage.create({ name: 'N', source: SOURCE, prompt: 'p' }), (e) => e.code === 'GENPAGE_BACKEND_CLOSED');
  assert.strictEqual((await genpage.enumerateEnv()).ok, false, 'a listing after close is a failed listing, not an empty environment');
  assert.strictEqual(made.length, 1);
});

test('REAL BUNDLE: dispose() while a page read is writing the page into its workspace waits for that write, removes the workspace, and the rest of the read cannot put anything back', async () => {
  const server = makeServer();
  const id = 'd0000000-0000-4000-8000-0000000000a2';
  server.seedPage(id, { name: 'Overview', source: SOURCE });
  let release;
  let reached;
  const held = new Promise((resolve) => { release = resolve; });
  const arrived = new Promise((resolve) => { reached = resolve; });
  // The write that stores the page's artifact — its source included — under `gen-pages/<id>.json`: the SDK's first write once it has been initialized.
  const control = { hold: async (method, args) => { if (method === 'writeTextAtomic' && args[0][0] === 'gen-pages') { reached(); await held; } } };
  const { genpage, made } = harness(server, { createStorage: (dir) => flakyStorage(dir, control) });
  const reading = genpage.read(id).then(() => null, (e) => e);
  await arrived;
  assert.ok(fs.existsSync(made[0]));
  const disposing = Promise.resolve(genpage.dispose());
  release();
  await disposing;
  assert.ok(!fs.existsSync(made[0]), 'the workspace is gone when dispose() has finished — the page source it was writing went with it');
  const error = await reading;
  assert.ok(error, 'the read is cut short');
  assert.match(error.message, /disposed/, 'and says why');
  assert.strictEqual(error.cause && error.cause.code, 'GENPAGE_BACKEND_CLOSED');
  await turns(30);
  assert.ok(!fs.existsSync(made[0]), 'and the manifest and metadata writes that followed it did not recreate the folder');
});

// ── discardWorkspaces(): the workspaces go, the backend stays ────────────────────────────────────────────────────────────────────
// What a verification pass that gave up on its page reads asks for (verify-model-app.js endPageReads): the workspace they were writing into is closed and
// removed, and the backend — which another pass may still use — makes a new one when it is next needed.

test('REAL BUNDLE: discardWorkspaces() removes the workspace made so far and leaves the backend open — the next operation works in a new workspace, and the discarded one stays gone', async () => {
  const server = makeServer();
  const id = 'd0000000-0000-4000-8000-0000000000a3';
  server.seedPage(id, { name: 'Overview', source: SOURCE });
  const { genpage, made } = harness(server);
  try {
    assert.strictEqual((await genpage.read(id)).source, SOURCE);
    assert.strictEqual(made.length, 1);
    assert.ok(fs.existsSync(made[0]), 'the workspace exists while the backend has worked in it');
    await genpage.discardWorkspaces();
    assert.ok(!fs.existsSync(made[0]), 'it is gone');
    assert.strictEqual((await genpage.read(id)).source, SOURCE, 'and the backend is not closed');
    assert.strictEqual(made.length, 2, 'it worked in a workspace of its own');
    assert.ok(!fs.existsSync(made[0]), 'the discarded workspace was not put back');
    assert.ok(fs.existsSync(made[1]));
    await genpage.discardWorkspaces();
    await genpage.discardWorkspaces();
    assert.ok(!fs.existsSync(made[1]), 'again, and any number of times');
  } finally {
    await genpage.dispose();
  }
  assert.ok(made.every((dir) => !fs.existsSync(dir)));
  await assert.rejects(genpage.read(id), (e) => e.code === 'GENPAGE_BACKEND_CLOSED', 'dispose() is the one that closes it');
});

test('REAL BUNDLE: discardWorkspaces() while a page read is writing into its workspace waits for the write, removes the workspace and cuts that read short — the next read works in a new one', async () => {
  const server = makeServer();
  const id = 'd0000000-0000-4000-8000-0000000000a4';
  server.seedPage(id, { name: 'Overview', source: SOURCE });
  let release;
  let reached;
  const held = new Promise((resolve) => { release = resolve; });
  const arrived = new Promise((resolve) => { reached = resolve; });
  let first = true;
  const control = { hold: async (method, args) => { if (first && method === 'writeTextAtomic' && args[0][0] === 'gen-pages') { first = false; reached(); await held; } } };
  const { genpage, made } = harness(server, { createStorage: (dir) => flakyStorage(dir, control) });
  try {
    const reading = genpage.read(id).then(() => null, (e) => e);
    await arrived;
    let finished = false;
    const discarding = genpage.discardWorkspaces().then(() => { finished = true; });
    await turns();
    assert.strictEqual(finished, false, 'the folder is not removed while a write to it is under way');
    release();
    await discarding;
    assert.ok(!fs.existsSync(made[0]), 'the workspace is gone once the write has settled');
    const error = await reading;
    assert.ok(error && error.cause && error.cause.code === 'GENPAGE_BACKEND_CLOSED', 'the read is cut short');
    await turns(30);
    assert.ok(!fs.existsSync(made[0]), 'and nothing it did afterwards put the folder back');
    assert.strictEqual((await genpage.read(id)).source, SOURCE, 'the backend is open: the next read goes through a new workspace');
    assert.strictEqual(made.length, 2);
  } finally {
    await genpage.dispose();
  }
  assert.ok(made.every((dir) => !fs.existsSync(dir)));
});

// ── dispose() answers for EVERY workspace the backend made, including one an earlier discard is still clearing ─────────────────────────────
// discardWorkspaces() hands its folders to a cleanup that waits for the storage calls under way, and forgets them; a dispose() that only looked at the
// workspaces it still knew would answer at once while that cleanup was waiting — and a process that ended on that answer left the page's source on disk.

// A page read stopped at the write that puts the page's artifact — its source included — into the workspace. Returns what a test needs to drive it.
function readStoppedAtItsWrite(server, id, deps = {}) {
  let release;
  let reached;
  const held = new Promise((resolve) => { release = resolve; });
  const arrived = new Promise((resolve) => { reached = resolve; });
  let first = true;
  const control = { hold: async (method, args) => { if (first && method === 'writeTextAtomic' && args[0][0] === 'gen-pages') { first = false; reached(); await held; } } };
  const { genpage, made } = harness(server, { createStorage: (dir) => flakyStorage(dir, control), ...deps });
  const reading = genpage.read(id).then(() => null, (e) => e);
  return { genpage, made, reading, arrived, release };
}

test('REAL BUNDLE: dispose() joins the cleanup an earlier discardWorkspaces() left draining — it answers only once the workspace, and the page source in it, are gone', { timeout: 30000 }, async () => {
  const server = makeServer();
  const id = 'd0000000-0000-4000-8000-0000000000a5';
  server.seedPage(id, { name: 'Overview', source: SOURCE });
  const { genpage, made, reading, arrived, release } = readStoppedAtItsWrite(server, id);
  await arrived;
  // The discard is not waited for, as when its caller's bound ran out; it goes on waiting for the write that is under way.
  const discarding = genpage.discardWorkspaces();
  await turns();
  assert.ok(fs.existsSync(made[0]), 'the cleanup is still waiting for the write: the folder is there');
  let answered = false;
  const disposing = genpage.dispose().then((outcome) => { answered = true; return outcome; });
  await turns(30);
  assert.strictEqual(answered, false, 'dispose() has not answered: a workspace this backend made is still on disk');
  assert.ok(fs.existsSync(made[0]), 'the workspace is still there');
  release();
  assert.deepStrictEqual(await disposing, { left: [] }, 'once the cleanup has finished, nothing is left');
  assert.ok(!fs.existsSync(made[0]), 'the workspace is gone when dispose() answers');
  assert.deepStrictEqual(await discarding, { left: [] });
  assert.ok(await reading, 'the read that was cut short failed');
  await turns(30);
  assert.ok(!fs.existsSync(made[0]), 'and nothing it did afterwards put the folder back');
});

test('REAL BUNDLE: dispose() within the caller\'s bound says which workspace it could not remove yet — it never reports done while one is on disk — and a later dispose() finishes what was started', { timeout: 30000 }, async () => {
  const server = makeServer();
  const id = 'd0000000-0000-4000-8000-0000000000a6';
  server.seedPage(id, { name: 'Overview', source: SOURCE });
  const { genpage, made, reading, arrived, release } = readStoppedAtItsWrite(server, id);
  await arrived;
  const startedAt = Date.now();
  const first = await genpage.dispose({ waitMs: 40 });
  assert.ok(Date.now() - startedAt < 10000, 'it answered at the caller\'s bound, not when the write settled');
  assert.deepStrictEqual(first, { left: [made[0]] }, 'and named the workspace that is still there');
  assert.ok(fs.existsSync(made[0]));
  // The cleanup was not abandoned: the write settles, the folder goes, and the next answer is clean.
  release();
  assert.deepStrictEqual(await genpage.dispose(), { left: [] });
  assert.ok(!fs.existsSync(made[0]));
  await reading;
});

test('REAL BUNDLE: a workspace that cannot be removed is reported by dispose() — and reported again by the next one — instead of being answered as gone', async () => {
  const server = makeServer();
  const id = 'd0000000-0000-4000-8000-0000000000a7';
  server.seedPage(id, { name: 'Overview', source: SOURCE });
  let locked = true;
  const refused = [];
  const { genpage, made } = harness(server, {
    rmSync: (dir, options) => {
      if (locked) { refused.push(dir); throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }); }
      fs.rmSync(dir, options);
    },
  });
  await genpage.read(id);
  assert.deepStrictEqual(await genpage.dispose(), { left: [made[0]] }, 'the folder is still on disk, and dispose() says so');
  assert.deepStrictEqual(await genpage.dispose(), { left: [made[0]] }, 'every later answer says so too');
  assert.ok(fs.existsSync(made[0]));
  locked = false;
  assert.deepStrictEqual(await genpage.dispose(), { left: [] }, 'and a call made once what held the folder has let go removes it');
  assert.ok(!fs.existsSync(made[0]));
  assert.strictEqual(refused.length, 2, 'it was tried on each call while it was held, not once more after it was removed');
});
