'use strict';
// lib/genpage-sdk.js against the REAL vendored SDK bundle (not a stand-in), over a stateful fake of the Dataverse tables behind a page
// (helpers/fake-genpage-server.js — a port of the fake the SDK's own tests drive). What these prove that the logic tests cannot: the
// SDK itself accepts what the backend sends, the rows it writes are the ones a page is made of, an untouched push writes nothing, an
// update writes only the rows that changed, a page that does not compile writes nothing, and a lost response on the one atomic
// change set leaves exactly the two states the backend's settling logic assumes — landed, or nothing.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { makeGenpageSdk, pageFolderFiles, contentFingerprint } = require('../lib/genpage-sdk.js');
const { workspaceParent } = require('../lib/temp-workspace.js');
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
  assert.strictEqual(path.dirname(made[0]), workspaceParent(), 'in the plugin\u2019s own folder of the temp directory (lib/temp-workspace.js), never the app folder');
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
