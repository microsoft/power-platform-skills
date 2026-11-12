'use strict';
// The page backend's `fileVersions`: the versionnumber of every file row of each page, from one plain query — what the build's publish record (lib/page-publish-records.js) is made and checked with.
// Its LOGIC runs against the in-memory SDK stand-in (what it asks, how it chunks, which answers it will not take as a set); the real bundle runs over the stateful fake of the page tables, whose file rows
// carry versions that move as measured on a real environment (a draft-only write moves one, a publish moves the rows whose content changed).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { makeGenpageSdk } = require('../lib/genpage-sdk.js');
const { FakeSdk, connectionError } = require('./helpers/fake-genpage-sdk.js');
const { FakeGenPageServer, INSTANCE } = require('./helpers/fake-genpage-server.js');

const ENV = 'https://contoso.crm.dynamics.com';
const P1 = '11111111-0000-4000-8000-000000000001';
const P2 = '11111111-0000-4000-8000-000000000002';
const ROW = (n) => `f0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const backend = (sdk) => makeGenpageSdk(ENV, { sdk });
const row = (id, parent, version) => ({ uxagentprojectfileid: ROW(id), _uxagentprojectid_value: parent, versionnumber: version });

test('fileVersions: one plain query for the pages, with the columns and the filter that name them — each page\'s rows as Map<row id, version>, ids in lower case', async () => {
  const sdk = new FakeSdk({ records: { uxagentprojectfile: () => [row(1, P1.toUpperCase(), 1001), row(2, P1, 1002), row(3, `{${P2}}`, '2001')] } });
  const out = await backend(sdk).fileVersions([P1.toUpperCase(), P2, P1]);
  assert.deepStrictEqual(out, { ok: true, versions: new Map([[P1, new Map([[ROW(1), '1001'], [ROW(2), '1002']])], [P2, new Map([[ROW(3), '2001']])]]) });
  assert.deepStrictEqual(sdk.of('queryRecords').map((c) => c.args), [['uxagentprojectfile', {
    select: ['uxagentprojectfileid', 'versionnumber', '_uxagentprojectid_value'],
    filter: `_uxagentprojectid_value eq ${P1} or _uxagentprojectid_value eq ${P2}`,
    paginate: true,
  }]], 'one query, each page once, followed to its last page');
});

test('fileVersions: pages are asked for fifty at a time, so the request line stays short however many pages an app has — and no pages is no request', async () => {
  const ids = Array.from({ length: 120 }, (_, i) => `22222222-0000-4000-8000-${String(i).padStart(12, '0')}`);
  const sdk = new FakeSdk({ records: { uxagentprojectfile: (o) => [...o.filter.matchAll(/eq ([0-9a-f-]{36})/g)].map((m, i) => row(i + 1, m[1], 5000 + i)) } });
  const out = await backend(sdk).fileVersions(ids);
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(sdk.of('queryRecords').map((c) => (c.args[1].filter.match(/ or /g) || []).length + 1), [50, 50, 20]);
  assert.strictEqual(out.versions.size, 120);
  const none = new FakeSdk();
  assert.deepStrictEqual(await backend(none).fileVersions([]), { ok: true, versions: new Map() });
  assert.deepStrictEqual(await backend(none).fileVersions(undefined), { ok: true, versions: new Map() });
  assert.strictEqual(none.calls.length, 0);
});

test('fileVersions: a row of a page that was not asked for is left out — it is not that page\'s', async () => {
  const sdk = new FakeSdk({ records: { uxagentprojectfile: () => [row(1, P1, 1001), row(2, P2, 2001)] } });
  assert.deepStrictEqual((await backend(sdk).fileVersions([P1])).versions, new Map([[P1, new Map([[ROW(1), '1001']])]]));
});

test('fileVersions: a page whose rows are not ONE consistent set is null — "not known" — and the pages beside it are read all the same', async () => {
  const cases = {
    'no rows at all (a page always has file rows)': [],
    'a row with no id': [{ _uxagentprojectid_value: P1, versionnumber: 1 }, row(2, P1, 1002)],
    'a row whose id is not a GUID': [{ uxagentprojectfileid: 'nope', _uxagentprojectid_value: P1, versionnumber: 1 }, row(2, P1, 1002)],
    'a row with no version': [{ uxagentprojectfileid: ROW(1), _uxagentprojectid_value: P1 }, row(2, P1, 1002)],
    'a version that is null': [row(1, P1, null), row(2, P1, 1002)],
    'a version that is no whole number': [row(1, P1, 10.5), row(2, P1, 1002)],
    'a version that is negative': [row(1, P1, -1), row(2, P1, 1002)],
    'a version too large to be held as a number exactly': [row(1, P1, 2 ** 60), row(2, P1, 1002)],
    'a version written as text that is no number': [row(1, P1, 'abc'), row(2, P1, 1002)],
    'a row listed twice': [row(1, P1, 1001), row(1, P1, 1001), row(2, P1, 1002)],
  };
  for (const [what, rows] of Object.entries(cases)) {
    const sdk = new FakeSdk({ records: { uxagentprojectfile: () => [...rows, row(9, P2, 9001)] } });
    const out = await backend(sdk).fileVersions([P1, P2]);
    assert.strictEqual(out.ok, true, what);
    assert.strictEqual(out.versions.get(P1), null, what);
    assert.deepStrictEqual(out.versions.get(P2), new Map([[ROW(9), '9001']]), `${what}: the other page is read`);
  }
  // A version of zero, and one written as the digits it has, are versions.
  const fine = new FakeSdk({ records: { uxagentprojectfile: () => [row(1, P1, 0), row(2, P1, '1234567890123456789')] } });
  assert.deepStrictEqual((await backend(fine).fileVersions([P1])).versions.get(P1), new Map([[ROW(1), '0'], [ROW(2), '1234567890123456789']]));
});

test('fileVersions: a read that fails is a failure with the SDK\'s code — never an empty answer — and an id that is no page id is refused before any request', async () => {
  const failing = new FakeSdk({ records: { uxagentprojectfile: () => { throw connectionError(503, 'unavailable'); } } });
  const out = await backend(failing).fileVersions([P1]);
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.code, 'CONNECTION_ERROR');
  assert.match(out.error, /^could not read the versions of the pages' files: .*unavailable/);
  assert.ok(!('versions' in out));
  const untouched = new FakeSdk();
  const bad = await backend(untouched).fileVersions([P1, '../etc']);
  assert.deepStrictEqual(bad, { ok: false, error: "'../etc' is not a page id" });
  assert.strictEqual(untouched.calls.length, 0);
});

test('fileVersions: it is counted while it runs — a closed backend starts none, and a discard waits for one under way on a lent SDK', async () => {
  const sdk = new FakeSdk({ records: { uxagentprojectfile: () => [row(1, P1, 1)] } });
  const genpage = makeGenpageSdk(ENV, { sdk, drainMs: 60000 });
  let open;
  const held = new Promise((resolve) => { open = resolve; });
  const original = sdk.queryRecords.bind(sdk);
  sdk.queryRecords = async (...args) => { await held; return original(...args); };
  const running = genpage.fileVersions([P1]);
  await new Promise((resolve) => setImmediate(resolve));
  let discarded = false;
  const discarding = genpage.discardWorkspaces().then(() => { discarded = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(discarded, false, 'it is still running on the lent SDK, so the discard waits for it');
  open();
  assert.strictEqual((await running).ok, true);
  await discarding;
  await genpage.dispose();
  const closed = await genpage.fileVersions([P1]);
  assert.strictEqual(closed.ok, false, 'a closed backend answers a failure, not an empty set');
  assert.strictEqual(closed.code, 'GENPAGE_BACKEND_CLOSED');
});

test('REAL BUNDLE: fileVersions reads the version of every file row through the plain collection, and it moves as measured — a draft-only write moves one, a publish moves the rows that changed', async () => {
  const server = new FakeGenPageServer();
  server.seedPage(P1, { name: 'One' });
  server.seedPage(P2, { name: 'Two' });
  const made = [];
  const genpage = makeGenpageSdk(INSTANCE, { httpClient: server.http(), mkdtempSync: (prefix) => { const dir = fs.mkdtempSync(prefix); made.push(dir); return dir; } });
  try {
    server.otherWorkspacePublishes(P1);
    server.otherWorkspacePublishes(P2);
    const read = async () => (await genpage.fileVersions([P1, P2])).versions;
    const live = (id) => new Map(server.filesOf(id).map((f) => [f.id, String(f.version)]));
    const before = await read();
    assert.deepStrictEqual(before.get(P1), live(P1), 'one version per file row of the page: the four rows the maker lays out');
    assert.strictEqual(before.get(P1).size, 4);
    assert.deepStrictEqual(before.get(P2), live(P2));
    assert.deepStrictEqual(await read(), before, 'nothing moves on its own');

    // A draft-only write of one file's content: that row's version moves in the plain read, and no other row's.
    const text = server.rowText(P1, 'src/pages/page.tsx');
    server.otherWorkspaceDraft(P1, 'src/pages/page.tsx', text);
    const drafted = await read();
    const moved = [...drafted.get(P1)].filter(([id, version]) => version !== before.get(P1).get(id)).map(([id]) => id);
    assert.deepStrictEqual(moved, [server.filesOf(P1).find((f) => f.filename === 'src/pages/page.tsx').id]);
    assert.deepStrictEqual(drafted.get(P2), before.get(P2), 'the other page is as it was');

    // Publishing that draft moves it again; the rows whose content did not change keep theirs.
    server.otherWorkspacePublishes(P1);
    const published = await read();
    const pageRow = server.filesOf(P1).find((f) => f.filename === 'src/pages/page.tsx').id;
    assert.notStrictEqual(published.get(P1).get(pageRow), drafted.get(P1).get(pageRow));
    for (const [id, version] of published.get(P1)) if (id !== pageRow) assert.strictEqual(version, before.get(P1).get(id), 'a row that did not change keeps its version');

    // A row added and published is a row more; a page that is not there has no rows.
    server.seedFile(P2, ROW(77), 'src/styles.css', 200000000, 'body {}');
    server.otherWorkspacePublishes(P2);
    assert.strictEqual((await read()).get(P2).size, 5);
    const absent = await genpage.fileVersions(['99999999-0000-4000-8000-000000000009']);
    assert.deepStrictEqual(absent, { ok: true, versions: new Map([['99999999-0000-4000-8000-000000000009', null]]) });
  } finally {
    await genpage.dispose();
    for (const dir of made) assert.ok(!fs.existsSync(dir), 'the throwaway workspace is removed');
  }
});
