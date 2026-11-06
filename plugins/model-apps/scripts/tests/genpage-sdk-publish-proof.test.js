'use strict';
// What the page backend gives the build to PROVE a publish before it is recorded (lib/page-publish-records.js, sdk-build.js `provedVersions`), beyond the versions of a page's files:
//   projectVersions(pageIds)                  the versionnumber of each page's OWN row — its name lives there, in none of its files, so a rename moves no file's version
//   publishedDiffers(pageId, args, expected)  with `expected.runtimeSha256`, the published copy's COMPILED OUTPUT must be the one the draft held when it was published — the source does not say what runs
//   create / update with `runtimeEvidence`    the hash of the compiled output the draft holds just before the publish
// and the failure a by-value result carries (`cause`) so the build decides whether to run again from its structure, not from words that quote the maker's names.
// The logic runs against the in-memory SDK stand-in; the real bundle runs over the stateful fake of the page tables.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { makeGenpageSdk } = require('../lib/genpage-sdk.js');
const { sha256 } = require('../lib/hash.js');
const { FakeSdk, connectionError } = require('./helpers/fake-genpage-sdk.js');
const { FakeGenPageServer, INSTANCE } = require('./helpers/fake-genpage-server.js');

const ENV = 'https://contoso.crm.dynamics.com';
const P1 = '11111111-0000-4000-8000-000000000001';
const P2 = '11111111-0000-4000-8000-000000000002';
const backend = (sdk) => makeGenpageSdk(ENV, { sdk });
const row = (id, version) => ({ uxagentprojectid: id, versionnumber: version });
const COMPILED = 'src/pages/page.compiled';
const PAGE = 'src/pages/page.tsx';
const SOURCE = "import * as React from 'react';\nexport default function Page() { return <div>Page</div>; }\n";
const bytesHash = (text) => sha256(Buffer.from(text, 'utf8'));

// ── projectVersions ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('projectVersions: one plain query for the pages, with the columns and the filter that name them — each page\'s row version, ids in lower case', async () => {
  const sdk = new FakeSdk({ records: { uxagentproject: () => [row(P1.toUpperCase(), 1001), row(`{${P2}}`, '2001')] } });
  const out = await backend(sdk).projectVersions([P1.toUpperCase(), P2, P1]);
  assert.deepStrictEqual(out, { ok: true, versions: new Map([[P1, '1001'], [P2, '2001']]) });
  assert.deepStrictEqual(sdk.of('queryRecords').map((c) => c.args), [['uxagentproject', {
    select: ['uxagentprojectid', 'versionnumber'],
    filter: `uxagentprojectid eq ${P1} or uxagentprojectid eq ${P2}`,
    paginate: true,
  }]], 'one query, each page once, followed to its last page');
});

test('projectVersions: pages are asked for fifty at a time — and no pages is no request', async () => {
  const ids = Array.from({ length: 120 }, (_, i) => `22222222-0000-4000-8000-${String(i).padStart(12, '0')}`);
  const sdk = new FakeSdk({ records: { uxagentproject: (o) => [...o.filter.matchAll(/eq ([0-9a-f-]{36})/g)].map((m, i) => row(m[1], 5000 + i)) } });
  const out = await backend(sdk).projectVersions(ids);
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(sdk.of('queryRecords').map((c) => (c.args[1].filter.match(/ or /g) || []).length + 1), [50, 50, 20]);
  assert.strictEqual(out.versions.size, 120);
  const none = new FakeSdk();
  assert.deepStrictEqual(await backend(none).projectVersions([]), { ok: true, versions: new Map() });
  assert.deepStrictEqual(await backend(none).projectVersions(undefined), { ok: true, versions: new Map() });
  assert.strictEqual(none.calls.length, 0);
});

test('projectVersions: a page whose row is not ONE known version is null — none came back, a row listed twice, a version that is no whole number — and the pages beside it are read all the same', async () => {
  const cases = {
    'no row at all (a page with no published copy has none in the plain read)': [],
    'a row with no version': [{ uxagentprojectid: P1 }],
    'a version that is null': [row(P1, null)],
    'a version that is no whole number': [row(P1, 10.5)],
    'a version that is negative': [row(P1, -1)],
    'a version too large to be held as a number exactly': [row(P1, 2 ** 60)],
    'a version written as text that is no number': [row(P1, 'abc')],
    'a row listed twice': [row(P1, 1001), row(P1, 1001)],
  };
  for (const [what, rows] of Object.entries(cases)) {
    const sdk = new FakeSdk({ records: { uxagentproject: () => [...rows, row(P2, 9001), row('99999999-0000-4000-8000-000000000009', 1)] } });
    const out = await backend(sdk).projectVersions([P1, P2]);
    assert.strictEqual(out.ok, true, what);
    assert.strictEqual(out.versions.get(P1), null, what);
    assert.strictEqual(out.versions.get(P2), '9001', `${what}: the other page is read, and a page that was not asked for is left out`);
    assert.strictEqual(out.versions.size, 2, what);
  }
  const fine = new FakeSdk({ records: { uxagentproject: () => [row(P1, 0), row(P2, '1234567890123456789')] } });
  assert.deepStrictEqual((await backend(fine).projectVersions([P1, P2])).versions, new Map([[P1, '0'], [P2, '1234567890123456789']]), 'zero, and the digits of a large one, are versions');
});

test('projectVersions: a read that fails is a failure with the SDK\'s code — never an empty answer — an id that is no page id is refused before any request, and a closed backend answers a failure', async () => {
  const failing = new FakeSdk({ records: { uxagentproject: () => { throw connectionError(503, 'unavailable'); } } });
  const out = await backend(failing).projectVersions([P1]);
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.code, 'CONNECTION_ERROR');
  assert.match(out.error, /^could not read the versions of the pages' rows: .*unavailable/);
  assert.ok(!('versions' in out));
  const untouched = new FakeSdk();
  assert.deepStrictEqual(await backend(untouched).projectVersions([P1, '../etc']), { ok: false, error: "'../etc' is not a page id" });
  assert.strictEqual(untouched.calls.length, 0);
  const closed = makeGenpageSdk(ENV, { sdk: new FakeSdk() });
  await closed.dispose();
  const answer = await closed.projectVersions([P1]);
  assert.strictEqual(answer.ok, false);
  assert.strictEqual(answer.code, 'GENPAGE_BACKEND_CLOSED');
});

test('REAL BUNDLE: projectVersions reads the page\'s own row through the plain collection — a rename moves it, nothing else does, and a page with no published copy has none', async () => {
  const server = new FakeGenPageServer();
  const genpage = makeGenpageSdk(INSTANCE, { httpClient: server.http() });
  try {
    const made = await genpage.create({ name: 'Alpha', source: SOURCE });
    const id = made.pageId;
    const live = () => String(server.state.projects.get(id).version);
    const first = await genpage.projectVersions([id]);
    assert.deepStrictEqual(first, { ok: true, versions: new Map([[id, live()]]) });
    assert.deepStrictEqual(await genpage.projectVersions([id]), first, 'nothing moves on its own');
    // A change to a file and a publish leave the row alone (the measured fact the record's header keeps): only a write to the row moves its version.
    const beforeRename = first.versions.get(id);
    assert.strictEqual((await genpage.update(id, { name: 'Renamed', source: SOURCE })).publish.kind, 'verified');
    const renamed = await genpage.projectVersions([id]);
    assert.notStrictEqual(renamed.versions.get(id), beforeRename, 'a rename moved the row\'s version, though no file row did');
    assert.strictEqual(renamed.versions.get(id), live());
    // A page nobody published has no row in the plain read: "not known".
    server.seedPage(P2, { name: 'Draft only' });
    assert.deepStrictEqual((await genpage.projectVersions([P2])).versions, new Map([[P2, null]]));
  } finally { await genpage.dispose(); }
});

// ── the compiled output, in the evidence and in the published copy ────────────────────────────────────────────────────────────────────────────────

const compiledRowId = (server, pageId) => server.filesOf(pageId).find((f) => f.filename === COMPILED).id;
// The SDK's own reads of a page (and of its publish) read the compiled row as the draft too, so the evidence is counted as the reads it ADDS — and it is made before the publish, so those are counted there.
const draftCompiledReads = (server, pageId) => server.requests.filter((r) => r.method === 'GET' && r.headers['MSCRM.IncludeUnpublished'] === 'true' && r.path.includes(`/uxagentprojectfiles(${compiledRowId(server, pageId)})/filecontent/$value`));
const publishIndex = (server, pageId) => server.requests.findIndex((r) => r.method === 'POST' && /PublishXml/.test(r.path) && r.body && String(r.body.ParameterXml || '').includes(pageId));
const draftReadsBeforePublish = (server, pageId) => draftCompiledReads(server, pageId).filter((r) => server.requests.indexOf(r) < publishIndex(server, pageId)).length;

test('REAL BUNDLE: create with runtimeEvidence answers the hash of the compiled output the DRAFT held when it published — read with the header that makes a read answer the draft, before the publish — and without it nothing more is read', async () => {
  const server = new FakeGenPageServer();
  const genpage = makeGenpageSdk(INSTANCE, { httpClient: server.http() });
  try {
    const plain = await genpage.create({ name: 'Plain', source: SOURCE });
    assert.ok(!('runtimeSha256' in plain), 'no evidence unless it is asked for');
    const asked = draftCompiledReads(server, plain.pageId).length;
    const askedBefore = draftReadsBeforePublish(server, plain.pageId);

    const out = await genpage.create({ name: 'Alpha', source: SOURCE, runtimeEvidence: true });
    assert.strictEqual(out.publish.kind, 'verified');
    assert.strictEqual(out.runtimeSha256, bytesHash(server.rowText(out.pageId, COMPILED)), 'the hash of the compiled bytes the draft holds — and the publish copied');
    assert.strictEqual(draftCompiledReads(server, out.pageId).length, asked + 1, 'one read of the draft\'s compiled row more than a create that does not ask, made as the draft is asked for');
    assert.strictEqual(draftReadsBeforePublish(server, out.pageId), askedBefore + 1, 'and it is made before the publish, so it is what the publish copies');
    assert.strictEqual(bytesHash(Buffer.from(server.publishedPages.get(out.pageId).files.find((f) => f.filename === COMPILED).content).toString('utf8')), out.runtimeSha256, 'which the published copy holds');
  } finally { await genpage.dispose(); }
});

test('REAL BUNDLE: update with runtimeEvidence answers it for a page it writes and for a page it finds holding the content and publishes — and none for a publish it skips, which reads no more than an update that does not ask', async () => {
  const server = new FakeGenPageServer();
  const genpage = makeGenpageSdk(INSTANCE, { httpClient: server.http() });
  try {
    const made = await genpage.create({ name: 'Alpha', source: SOURCE });
    const id = made.pageId;
    const changed = await genpage.update(id, { name: 'Alpha', source: SOURCE.replace('>Page<', '>Changed<'), runtimeEvidence: true });
    assert.strictEqual(changed.publish.kind, 'verified');
    assert.ok(!changed.unchanged);
    assert.strictEqual(changed.runtimeSha256, bytesHash(server.rowText(id, COMPILED)), 'a page that was written');
    assert.match(server.rowText(id, COMPILED), /Changed/, 'the compiled output is the one of the new source');

    const unchanged = await genpage.update(id, { name: 'Alpha', source: SOURCE.replace('>Page<', '>Changed<'), runtimeEvidence: true });
    assert.strictEqual(unchanged.unchanged, true);
    assert.strictEqual(unchanged.publish.kind, 'verified', 'a page that holds the content is published all the same');
    assert.strictEqual(unchanged.runtimeSha256, bytesHash(server.rowText(id, COMPILED)), 'a page that was found holding the content');

    const skip = async (runtimeEvidence) => {
      const before = draftCompiledReads(server, id).length;
      const out = await genpage.update(id, { name: 'Alpha', source: SOURCE.replace('>Page<', '>Changed<'), runtimeEvidence, publishedFingerprint: unchanged.fingerprint });
      return { out, reads: draftCompiledReads(server, id).length - before };
    };
    const asking = await skip(true);
    const quiet = await skip(false);
    assert.strictEqual(asking.out.publish.kind, 'skipped');
    assert.ok(!('runtimeSha256' in asking.out), 'nothing was published, so there is nothing to give evidence of');
    assert.strictEqual(asking.reads, quiet.reads, 'and nothing more was read for it');
  } finally { await genpage.dispose(); }
});

test('REAL BUNDLE: evidence is only evidence — a compiled output that cannot be read leaves the publish as it was and the result without it, and a page with no compiled row has none', async () => {
  const server = new FakeGenPageServer();
  const genpage = makeGenpageSdk(INSTANCE, { httpClient: server.http() });
  try {
    server.failOn = (method, path, batched, headers) => (method === 'GET' && /filecontent\/\$value/.test(path) && headers['MSCRM.IncludeUnpublished'] === 'true' ? 503 : undefined);
    const out = await genpage.create({ name: 'Alpha', source: SOURCE, runtimeEvidence: true });
    assert.strictEqual(out.publish.kind, 'verified', 'the page is saved and published all the same');
    assert.ok(!('runtimeSha256' in out), 'with no evidence of what was published');
    server.failOn = undefined;

    // The row is gone: a page with no compiled output has none to certify.
    server.state.files.delete(compiledRowId(server, out.pageId));
    const second = await genpage.update(out.pageId, { name: 'Alpha', source: SOURCE, runtimeEvidence: true });
    assert.ok(!('runtimeSha256' in second));
  } finally { await genpage.dispose(); }
});

test('REAL BUNDLE: publishedDiffers holds the published copy\'s compiled output to the evidence — another writer\'s compiled bytes under the same source differ, the source and settings alone do not say so', async () => {
  const server = new FakeGenPageServer();
  const genpage = makeGenpageSdk(INSTANCE, { httpClient: server.http() });
  try {
    const out = await genpage.create({ name: 'Alpha', source: SOURCE, runtimeEvidence: true });
    const id = out.pageId;
    const args = { name: 'Alpha', source: SOURCE };
    const held = await genpage.publishedDiffers(id, args, { runtimeSha256: out.runtimeSha256 });
    assert.deepStrictEqual([held.ok, held.differing], [true, []], 'the copy that was just published holds the content and the runtime');
    assert.strictEqual(typeof held.fingerprint, 'string');
    assert.strictEqual(held.runtimeSha256, out.runtimeSha256, 'and the answer says which compiled output it read, so a caller can see the comparison was made');
    const other = await genpage.publishedDiffers(id, args, { runtimeSha256: bytesHash('other') });
    assert.deepStrictEqual(other.differing, ['compiled output'], 'evidence of other bytes: they differ');
    assert.strictEqual(other.runtimeSha256, out.runtimeSha256, 'and the answer is still what the published copy holds');
    assert.ok(!('runtimeSha256' in (await genpage.publishedDiffers(id, args))), 'with no evidence given, no compiled output is read, and none is answered');

    // Another writer publishes other compiled bytes under the SAME source, and puts the original back as a draft.
    const original = server.rowText(id, COMPILED);
    server.otherWorkspaceDraft(id, COMPILED, `${original}\n/* another writer */`);
    server.otherWorkspacePublishes(id);
    server.otherWorkspaceDraft(id, COMPILED, original);
    assert.deepStrictEqual((await genpage.publishedDiffers(id, args)).differing, [], 'the source and the settings say it holds the content: the proof used to stop here');
    assert.deepStrictEqual((await genpage.publishedDiffers(id, args, {})).differing, [], 'and a caller with no evidence is answered as before');
    assert.deepStrictEqual((await genpage.publishedDiffers(id, args, { runtimeSha256: out.runtimeSha256 })).differing, ['compiled output'], 'the evidence says what runs is not what was published');
    // A source that differs is named as it always was, beside it.
    assert.deepStrictEqual((await genpage.publishedDiffers(id, { ...args, source: SOURCE.replace('>Page<', '>Else<') }, { runtimeSha256: out.runtimeSha256 })).differing, ['source', 'compiled output']);
  } finally { await genpage.dispose(); }
});

test('REAL BUNDLE: a published copy with no compiled row differs from any evidence, and one whose compiled output cannot be read is "cannot be told" — never "holds it"', async () => {
  const server = new FakeGenPageServer();
  const genpage = makeGenpageSdk(INSTANCE, { httpClient: server.http() });
  try {
    const out = await genpage.create({ name: 'Alpha', source: SOURCE, runtimeEvidence: true });
    const id = out.pageId;
    const args = { name: 'Alpha', source: SOURCE };
    const rowId = compiledRowId(server, id);
    server.failOn = (method, path, batched, headers) => (method === 'GET' && path.includes(`/uxagentprojectfiles(${rowId})/filecontent/$value`) && headers['MSCRM.IncludeUnpublished'] !== 'true' ? 503 : undefined);
    const unreadable = await genpage.publishedDiffers(id, args, { runtimeSha256: out.runtimeSha256 });
    assert.strictEqual(unreadable.ok, false);
    assert.match(unreadable.error, /could not read the published copy of page/);
    assert.ok(!('differing' in unreadable));
    server.failOn = undefined;

    server.state.files.delete(rowId);
    server.otherWorkspacePublishes(id);
    assert.deepStrictEqual((await genpage.publishedDiffers(id, args, { runtimeSha256: out.runtimeSha256 })).differing, ['compiled output'], 'no compiled output is not the one that was published');
  } finally { await genpage.dispose(); }
});

// ── the failure a result reports by value ─────────────────────────────────────────────────────────────────────────────────────────────────────────

test('a publish that fails carries the failure itself as a `cause` that is not enumerable — the result prints and compares as it always did — whether the call threw or the SDK reported it', async () => {
  const thrown = connectionError(503, 'The service is unavailable.');
  const reported = Object.assign(new Error('PublishXml was refused'), { code: 'PUBLISH_REFUSED' });
  for (const [what, script, failure] of [['thrown', thrown, thrown], ['reported', { publish: { kind: 'failed', error: reported } }, reported]]) {
    const out = await backend(new FakeSdk().script('publish', script)).create({ name: 'P', source: 'src' });
    assert.strictEqual(out.publish.kind, 'failed', what);
    assert.strictEqual(out.publish.cause, failure, `${what}: the failure itself`);
    assert.deepStrictEqual(Object.keys(out.publish), ['kind', 'detail'], `${what}: the result keeps its shape`);
    assert.ok(!JSON.stringify(out.publish).includes('cause'), `${what}: and prints as it did`);
  }
  // A publish that took effect, or could not be proven, reports no failure.
  const verified = await backend(new FakeSdk()).create({ name: 'P', source: 'src' });
  assert.strictEqual(verified.publish.cause, undefined);
  const unproven = await backend(new FakeSdk().script('publish', { publish: { kind: 'unverifiable', reason: 'not shown yet' } })).create({ name: 'P', source: 'src' });
  assert.strictEqual(unproven.publish.cause, undefined);
});

test('REAL BUNDLE: a publish the service refuses is `publish.kind: failed` with the SDK\'s error as a non-enumerable `cause`, and a listing that cannot be read has it too', async () => {
  const server = new FakeGenPageServer();
  const genpage = makeGenpageSdk(INSTANCE, { httpClient: server.http() });
  try {
    server.failOn = (method, path) => (method === 'POST' && /PublishXml/.test(path) ? 503 : undefined);
    const out = await genpage.create({ name: 'Alpha', source: SOURCE });
    assert.strictEqual(out.publish.kind, 'failed');
    assert.deepStrictEqual(Object.keys(out.publish), ['kind', 'detail'], 'the result keeps its shape');
    assert.ok(!JSON.stringify(out.publish).includes('cause'), 'and prints as it did');
    assert.ok(out.publish.cause instanceof Error, 'the failure itself rides along');
    assert.strictEqual(out.publish.cause.statusCode, 503, 'with the status the service answered, which is what a run again is decided from');
    server.failOn = undefined;

    server.failOn = (method, path) => (method === 'GET' && /^\/uxagentprojects\?/.test(path) ? 503 : undefined);
    const listing = await genpage.enumerateEnv();
    assert.strictEqual(listing.ok, false);
    assert.match(listing.error, /^could not list the environment's generative pages: /);
    assert.ok(Object.keys(listing).includes('error') && !Object.keys(listing).includes('cause'));
    assert.strictEqual(listing.cause.statusCode, 503);
  } finally { await genpage.dispose(); }
});
