'use strict';
// The page backend's `publishedDiffers`: what a page's PUBLISHED copy differs from the content a caller asks about. The build brackets it with two reads of `fileVersions` before it records a publish
// (lib/sdk-build.js, lib/page-publish-records.js): the versions are recorded only when the copy read back holds the content that was sent and the two reads of the versions are the same set.
// Its LOGIC runs against the in-memory SDK stand-in (which reads it makes, how it reads a page's layout, what it refuses to judge); the real bundle runs over the stateful fake of the page tables, which
// serves the published layer as `PublishXml` last left it and a draft to a read that asks for it.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { makeGenpageSdk, contentFingerprint } = require('../lib/genpage-sdk.js');
const { FakeSdk, connectionError } = require('./helpers/fake-genpage-sdk.js');
const { FakeGenPageServer, INSTANCE } = require('./helpers/fake-genpage-server.js');

const ENV = 'https://contoso.crm.dynamics.com';
const PAGE = '11111111-0000-4000-8000-000000000001';
const ROW = (n) => `f0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SOURCE = 'export default function Page() { return null; }\n';
const TEXT = 200000000;
const OUTPUT = 200000001;
const SETTINGS = JSON.stringify({ dataSources: ['account'], model: 'gpt-4.1', enabledTools: [] });
// What the build asks about, and what the page below holds: the same content.
const CONTENT = { source: SOURCE, name: 'Overview', dataSources: ['account'], model: 'gpt-4.1' };
const backend = (sdk) => makeGenpageSdk(ENV, { sdk });

// A page as the published layer serves it, through the three reads `publishedDiffers` makes: the page's row, the rows of its files, and the bytes of the ones that hold text. `files` is { name: [filetype, content] }
// in row order (the first row has id ROW(1)); `served.gets` is every URL read through the client, in order.
function served(overrides = {}) {
  const files = overrides.files || {
    'src/pages/page.tsx': [TEXT, SOURCE],
    'src/pages/page.compiled': [OUTPUT, '"use strict";\n'],
    'config.json': [TEXT, SETTINGS],
    'firstPrompt.json': [TEXT, '{"userMessage":"Hi"}'],
  };
  const rows = overrides.rows || Object.entries(files).map(([filename, [filetype]], i) => ({ uxagentprojectfileid: ROW(i + 1), filename, filetype }));
  const content = new Map(Object.entries(files).map(([, [, text]], i) => [ROW(i + 1), text]));
  const gets = [];
  const sdk = new FakeSdk({
    records: { uxagentprojectfile: () => rows },
    onGet: async (url) => {
      gets.push(url);
      if (overrides.onGet) {
        const answer = await overrides.onGet(url);
        if (answer) return answer;
      }
      if (url.startsWith(`/uxagentprojects(${PAGE})`)) return { status: 200, body: { uxagentprojectid: PAGE, name: overrides.name === undefined ? 'Overview' : overrides.name } };
      const file = /^\/uxagentprojectfiles\(([0-9a-f-]{36})\)\/filecontent\/\$value$/.exec(url);
      if (file && content.has(file[1])) return { status: 200, body: typeof content.get(file[1]) === 'string' ? Buffer.from(content.get(file[1]), 'utf8') : content.get(file[1]) };
      return { status: 404, body: null };
    },
  });
  return { sdk, gets };
}

test('publishedDiffers: three plain reads — the page\'s row, the rows of its files, and the bytes of the source and the settings, nothing else — and a copy that holds the content differs in nothing', async () => {
  const { sdk, gets } = served();
  const out = await backend(sdk).publishedDiffers(PAGE.toUpperCase(), CONTENT);
  assert.deepStrictEqual(out, { ok: true, differing: [], fingerprint: contentFingerprint(CONTENT) });
  assert.deepStrictEqual(gets, [
    `/uxagentprojects(${PAGE})?$select=uxagentprojectid,name`,
    `/uxagentprojectfiles(${ROW(1)})/filecontent/$value`,
    `/uxagentprojectfiles(${ROW(3)})/filecontent/$value`,
  ], 'the compiled output and the first prompt are not read');
  assert.deepStrictEqual(sdk.of('queryRecords').map((c) => c.args), [['uxagentprojectfile', {
    select: ['uxagentprojectfileid', 'filename', 'filetype'],
    filter: `_uxagentprojectid_value eq ${PAGE}`,
    paginate: true,
  }]], 'the rows of the page\'s files, followed to the last page, through the plain collection');
});

test('publishedDiffers: each field the published copy does not hold is named, in planEdits\' own words — and a field the caller leaves out is the page\'s own and cannot differ', async () => {
  const overrides = {
    source: { source: `${SOURCE}// edited\n` },
    name: { name: 'Another name' },
    dataSources: { dataSources: ['contact'] },
    model: { model: 'gpt-5' },
    connectorBindings: { connectorBindings: [{ id: 1 }] },
    actionBindings: { actionBindings: [{ id: 2 }] },
  };
  for (const [field, change] of Object.entries(overrides)) {
    const out = await backend(served().sdk).publishedDiffers(PAGE, { ...CONTENT, ...change });
    assert.deepStrictEqual(out.differing, [field], field);
    assert.strictEqual(out.fingerprint, contentFingerprint({ ...CONTENT, ...change }), `${field}: the hash is that of the content that was asked about`);
  }
  const all = await backend(served().sdk).publishedDiffers(PAGE, { ...CONTENT, ...Object.assign({}, ...Object.values(overrides)) });
  assert.deepStrictEqual(all.differing, ['source', 'name', 'dataSources', 'model', 'connectorBindings', 'actionBindings']);
  assert.deepStrictEqual((await backend(served().sdk).publishedDiffers(PAGE, { source: SOURCE })).differing, [], 'only the source was asked about');
  // The arguments are normalized as an update normalizes them: a CSV of table names, trimmed and in lower case.
  assert.deepStrictEqual((await backend(served().sdk).publishedDiffers(PAGE, { ...CONTENT, dataSources: ' Account ' })).differing, []);
});

test('publishedDiffers: the settings and the source are read as the SDK reads them — no settings row is no data sources, a leading mark is ignored in the settings and is content in the source, bindings are compared as they are', async () => {
  const without = served({ files: { 'src/pages/page.tsx': [TEXT, SOURCE], 'src/pages/page.compiled': [OUTPUT, 'x'] } });
  assert.deepStrictEqual((await backend(without.sdk).publishedDiffers(PAGE, { source: SOURCE, dataSources: [] })).differing, []);
  assert.deepStrictEqual((await backend(without.sdk).publishedDiffers(PAGE, { source: SOURCE, dataSources: ['account'] })).differing, ['dataSources']);
  assert.strictEqual(without.gets.filter((url) => url.includes('/filecontent/')).length, 2, 'only the source is read when there is no settings row');

  const marked = served({ files: { 'src/pages/page.tsx': [TEXT, `\uFEFF${SOURCE}`], 'config.json': [TEXT, `\uFEFF${JSON.stringify({ connectorBindings: [{ a: 1 }], actionBindings: [] })}`] } });
  assert.deepStrictEqual((await backend(marked.sdk).publishedDiffers(PAGE, { source: `\uFEFF${SOURCE}`, connectorBindings: [{ a: 1 }], actionBindings: [] })).differing, [], 'the mark of the source is part of it; the settings\' is not');
  assert.deepStrictEqual((await backend(marked.sdk).publishedDiffers(PAGE, { source: SOURCE })).differing, ['source'], 'so a source without it differs');
  assert.deepStrictEqual((await backend(marked.sdk).publishedDiffers(PAGE, { source: `\uFEFF${SOURCE}`, connectorBindings: [{ a: 2 }] })).differing, ['connectorBindings']);
});

test('publishedDiffers: a copy it cannot judge is `ok: false` — never "holds it": no published copy, a read that fails, a page that is not laid out as a page is, bytes it cannot read', async () => {
  const text = (name, content) => [name, [TEXT, content]];
  const files = (...rows) => ({ files: Object.fromEntries(rows) });
  const cases = {
    'a page with no published copy': [{ onGet: (url) => (url.startsWith('/uxagentprojects(') ? { status: 404, body: null } : undefined) }, /has no published copy/],
    'a refused read of the page\'s row': [{ onGet: (url) => (url.startsWith('/uxagentprojects(') ? { status: 503, body: null } : undefined) }, /could not read the published copy of page \S+: the page's row: HTTP 503/],
    'a refused read of a file\'s content': [{ onGet: (url) => (url.includes('/filecontent/') ? { status: 429, body: null } : undefined) }, /the source row: HTTP 429/],
    'a page with no source row': [files(text('config.json', SETTINGS)), /not laid out as a page is \(0 source rows, 1 settings rows\)/],
    'a page with two source rows': [files(text('src/pages/page.tsx', SOURCE), text('src/other/page.tsx', SOURCE)), /\(2 source rows, 0 settings rows\)/],
    'a page with two settings rows': [{ rows: [{ uxagentprojectfileid: ROW(1), filename: 'src/pages/page.tsx', filetype: TEXT }, { uxagentprojectfileid: ROW(2), filename: 'config.json', filetype: TEXT }, { uxagentprojectfileid: ROW(3), filename: 'config.json', filetype: TEXT }] }, /\(1 source rows, 2 settings rows\)/],
    'a source row with no file behind it': [{ onGet: (url) => (url.endsWith(`${ROW(1)})/filecontent/$value`) ? { status: 404, body: null } : undefined) }, /the source row has no readable content/],
    'a body that is neither bytes nor text': [{ onGet: (url) => (url.endsWith(`${ROW(1)})/filecontent/$value`) ? { status: 200, body: { not: 'bytes' } } : undefined) }, /the source row has no readable content/],
    'a source that is not UTF-8': [files(text('src/pages/page.tsx', Buffer.from([0x41, 0xff, 0xfe]))), /could not read the published copy/],
    'settings that are not JSON': [files(text('src/pages/page.tsx', SOURCE), text('config.json', '{ nope')), /could not read the published copy/],
    'settings that are a list': [files(text('src/pages/page.tsx', SOURCE), text('config.json', '[]')), /config\.json is not a JSON object/],
    'data sources that are not a list of names': [files(text('src/pages/page.tsx', SOURCE), text('config.json', '{"dataSources":"account"}')), /dataSources that are not a list of names/],
    'a model that is not a text': [files(text('src/pages/page.tsx', SOURCE), text('config.json', '{"model":7}')), /a model that is not a text/],
  };
  for (const [what, [overrides, says]] of Object.entries(cases)) {
    const out = await backend(served(overrides).sdk).publishedDiffers(PAGE, CONTENT);
    assert.strictEqual(out.ok, false, what);
    assert.match(out.error, says, what);
    assert.ok(!('differing' in out) && !('fingerprint' in out), `${what}: no answer is given beside the failure`);
  }
  const failing = new FakeSdk({ records: { uxagentprojectfile: () => { throw connectionError(503, 'unavailable'); } }, onGet: async () => ({ status: 200, body: { name: 'Overview' } }) });
  const failed = await backend(failing).publishedDiffers(PAGE, CONTENT);
  assert.strictEqual(failed.ok, false);
  assert.strictEqual(failed.code, 'CONNECTION_ERROR', 'a failure of the SDK carries its code');
  assert.match(failed.error, /unavailable/);
});

test('publishedDiffers: what is not a page id or not a page\'s content is refused before any request, and an SDK with no Dataverse client cannot judge', async () => {
  const untouched = served();
  const bad = await backend(untouched.sdk).publishedDiffers('../etc', CONTENT);
  assert.deepStrictEqual(bad, { ok: false, error: "'../etc' is not a page id" });
  const notText = await backend(untouched.sdk).publishedDiffers(PAGE, { source: 42 });
  assert.strictEqual(notText.ok, false);
  assert.strictEqual(notText.code, 'GENPAGE_SOURCE_INVALID');
  assert.strictEqual(untouched.sdk.calls.length, 0);
  const bare = makeGenpageSdk(ENV, { sdk: { queryRecords: async () => [] } });
  const out = await bare.publishedDiffers(PAGE, CONTENT);
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /no Dataverse client/);
});

test('publishedDiffers: it is counted while it runs — a closed backend reads nothing, and a discard waits for a read under way on a lent SDK', async () => {
  const lent = served();
  const genpage = makeGenpageSdk(ENV, { sdk: lent.sdk, drainMs: 60000 });
  let open;
  const held = new Promise((resolve) => { open = resolve; });
  const original = lent.sdk.queryRecords.bind(lent.sdk);
  lent.sdk.queryRecords = async (...args) => { await held; return original(...args); };
  const running = genpage.publishedDiffers(PAGE, CONTENT);
  await new Promise((resolve) => setImmediate(resolve));
  let discarded = false;
  const discarding = genpage.discardWorkspaces().then(() => { discarded = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(discarded, false, 'it is still running on the lent SDK, so the discard waits for it');
  open();
  assert.strictEqual((await running).ok, true);
  await discarding;
  await genpage.dispose();
  const closed = await genpage.publishedDiffers(PAGE, CONTENT);
  assert.strictEqual(closed.ok, false, 'a closed backend answers a failure, never "holds it"');
  assert.strictEqual(closed.code, 'GENPAGE_BACKEND_CLOSED');
});

test('REAL BUNDLE: publishedDiffers reads the layer a publish writes — a draft that is not published does not change the answer, another writer\'s publish does, and its hash is the one create and update answer', async () => {
  const server = new FakeGenPageServer();
  const made = [];
  const track = { httpClient: server.http(), mkdtempSync: (prefix) => { const dir = fs.mkdtempSync(prefix); made.push(dir); return dir; } };
  const genpage = makeGenpageSdk(INSTANCE, track);
  const writer = makeGenpageSdk(INSTANCE, { httpClient: server.http(), mkdtempSync: track.mkdtempSync });
  try {
    const content = { name: 'Overview', source: SOURCE, dataSources: [], model: 'gpt-4.1' };
    const created = await genpage.create(content);
    assert.strictEqual(created.publish.kind, 'verified');
    assert.deepStrictEqual(await genpage.publishedDiffers(created.pageId, content), { ok: true, differing: [], fingerprint: created.fingerprint }, 'what a create published, and the hash the create answered');

    // A draft that is not published: the page that runs is the one that was published.
    const draft = `${SOURCE}// a maker's save\n`;
    server.otherWorkspaceDraft(created.pageId, 'src/pages/page.tsx', draft);
    assert.deepStrictEqual((await genpage.publishedDiffers(created.pageId, content)).differing, [], 'the published copy still holds the content');
    assert.deepStrictEqual((await genpage.publishedDiffers(created.pageId, { ...content, source: draft })).differing, ['source'], 'and does not hold the draft');

    // Another writer publishes other content under another name.
    const wrote = await writer.update(created.pageId, { source: `${SOURCE}// somebody else\n`, name: 'Renamed' });
    assert.strictEqual(wrote.publish.kind, 'verified');
    const after = await genpage.publishedDiffers(created.pageId, content);
    assert.deepStrictEqual(after.differing, ['source', 'name']);
    // The same content through an update is the same hash, whatever the published copy holds.
    const updated = await genpage.update(created.pageId, content);
    assert.strictEqual(updated.publish.kind, 'verified');
    assert.strictEqual(after.fingerprint, updated.fingerprint);
    assert.deepStrictEqual(await genpage.publishedDiffers(created.pageId, content), { ok: true, differing: [], fingerprint: updated.fingerprint }, 'and once the update is published the copy holds the content again');

    // A page that exists only as a draft has no published copy.
    const draftOnly = '99999999-0000-4000-8000-000000000009';
    server.seedPage(draftOnly, { name: 'Draft only' });
    const none = await genpage.publishedDiffers(draftOnly, content);
    assert.strictEqual(none.ok, false);
    assert.match(none.error, /has no published copy/);
  } finally {
    await genpage.dispose();
    await writer.dispose();
    for (const dir of made) assert.ok(!fs.existsSync(dir), 'the throwaway workspace is removed');
  }
});
