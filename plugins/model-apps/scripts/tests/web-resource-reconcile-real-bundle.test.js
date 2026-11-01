'use strict';
// Declared web-resource reconciliation through the REAL vendored SDK over an in-memory webresourceset: what is read before
// a row is first bound (its saved identity, its published bytes, its platform-reported dependents), what is written (one
// PATCH that the SDK publishes and reads back, or a create whose id is the one the service acknowledged), and what an
// unconfirmed publication leaves behind (a receipt that makes the next run write the same row again by id).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRowTableServer } = require('./helpers/row-table-server.js');
const { fakeManaged, passThroughCreates } = require('./helpers/feature-ports.js');
const { stableCreates } = require('./helpers/stable-creates.js');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { webResourceOpts } = require('../lib/sdk-build.js');
const { openUnconfirmedWebResources, readUnconfirmedWebResources } = require('../lib/web-resource-records.js');
const { sha256 } = require('../lib/hash.js');
const {
  webResourceReads, readWebResourceDependents, planWebResourceUpdate, applyWebResourceUpdate, settleWebResourceReceipt,
} = require('../lib/web-resource-reconcile.js');

const API = 'https://contoso.crm.dynamics.com/api/data/v9.0';
const WID = '88888888-0000-4000-8000-000000000001';
const OTHER = '88888888-0000-4000-8000-000000000002';
const NAME = 'contoso_/scripts/form.js';
const DEP = '99999999-0000-4000-8000-000000000001';
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const shaOf = (s) => sha256(b64(s));

function server(content = 'var v = 1;', over = {}) {
  const srv = createRowTableServer({ tables: { webresourceset: 'webresourceid' } });
  if (content !== null) srv.seed('webresourceset', { webresourceid: WID, name: NAME, displayname: NAME, webresourcetype: 3, content: b64(content), ...over });
  return srv;
}
// The SDK's Dataverse client prefixes the API root; an absolute continuation goes through getAbsolute.
const clientOf = (srv) => ({ get: (p) => srv.httpClient.get(API + p), getAbsolute: (u) => srv.httpClient.get(u) });
const declared = (content, over = {}) => ({ name: NAME, type: 'js', content, reconcile: 'declared', ...over });
const noDependents = async () => [];

async function run(srv, wr, ctx = {}, extra = {}) {
  const sdk = await srv.newSdk();
  srv.clearLog();
  const plan = await planWebResourceUpdate({ webResource: wr, options: webResourceOpts(wr, '.'), reads: webResourceReads(clientOf(srv)), readDependents: noDependents, ...extra }, ctx);
  const result = await applyWebResourceUpdate(plan, { sdk }, ctx);
  return { plan, result };
}
const publishes = (srv) => srv.writes.filter((w) => /PublishXml/.test(w.url));
const patches = (srv) => srv.writes.filter((w) => w.verb === 'patch');
const posts = (srv) => srv.writes.filter((w) => w.verb === 'post' && /webresourceset/.test(w.url));
const codes = (list) => list.map((r) => r.code);
const boundTo = (id) => ({ lookup: async () => ({ id, intentSha256: shaOf('var v = 1;'), origin: 'adopted' }) });
function failPublish(srv) {
  const post = srv.httpClient.post;
  srv.httpClient.post = async (url, body) => (/PublishXml/.test(String(url)) ? { status: 500, headers: {}, body: { error: { code: '0x80040216', message: 'publish failed' } } } : post(url, body));
}

test('bound content that differs is written once, published by the write and read back; a rerun writes and publishes nothing', async () => {
  const srv = server();
  const managed = fakeManaged();
  const first = await run(srv, declared('var v = 2;'), { authorizedAdoption: true, managed });
  assert.deepEqual(first.result.saved.map((s) => s.id), [WID]);
  assert.equal(patches(srv).length, 1);
  assert.equal(publishes(srv).length, 1);
  assert.equal(first.result.pendingPublish.length, 0, 'a web resource publishes inline, never through the barrier');
  managed.persist(first.result.managedBindings);
  const second = await run(srv, declared('var v = 2;'), { managed });
  assert.equal(second.plan.action, 'noChange');
  assert.equal(srv.writes.length, 0, 'identical content: no write and no publish');
});

test('an external web resource is refused in declared mode, even when its content differs', async () => {
  const srv = server();
  const { result } = await run(srv, declared('var v = 2;', { external: true }), { authorizedAdoption: true });
  assert.deepEqual(codes(result.refused), ['web-resource-external']);
  assert.equal(srv.writes.length, 0);
});

test('an unbound row whose bytes already match is disclosed before it is bound, and binds only with approval', async () => {
  const srv = server('var v = 2;');
  let asked = 0;
  const readDependents = async (id) => { asked += 1; assert.equal(id, WID); return [{ componentType: 60, objectId: DEP }]; };
  const plain = await run(srv, declared('var v = 2;'), { managed: fakeManaged() }, { readDependents });
  assert.equal(asked, 1, 'the dependents are read before an equal-bytes row is considered at all');
  assert.equal(plain.plan.action, 'noChange');
  assert.equal(plain.result.managedBindings.length, 0, 'equal bytes alone transfer no ownership');
  assert.equal(plain.plan.dependents.count, 1);
  assert.match(plain.plan.dependents.note, /direct dependents only/);
  const approved = await run(srv, declared('var v = 2;'), { managed: fakeManaged(), authorizedAdoption: true }, { readDependents });
  assert.deepEqual(approved.result.managedBindings.map((b) => [b.id, b.origin]), [[WID, 'adopted']]);
  assert.equal(srv.writes.length, 0);
});

test('a dependents answer that cannot be read completely binds and writes nothing; an empty list is a real answer', async () => {
  for (const readDependents of [
    async () => { throw new Error('HTTP 500'); },
    async () => null,
    async () => [{ componentType: 60 }],
    async () => [{ componentType: '60', objectId: DEP }],
  ]) {
    const srv = server('var v = 2;');
    const { plan, result } = await run(srv, declared('var v = 3;'), { authorizedAdoption: true }, { readDependents });
    assert.deepEqual(codes(result.unknown), ['web-resource-dependents-unreadable']);
    assert.equal(plan.dependents, null);
    assert.equal(result.managedBindings.length, 0);
    assert.equal(srv.writes.length, 0);
  }
  const srv = server('var v = 2;');
  const { plan, result } = await run(srv, declared('var v = 3;'), { authorizedAdoption: true }, { readDependents: noDependents });
  assert.equal(plan.dependents.count, 0);
  assert.deepEqual(result.saved.map((s) => s.id), [WID]);
});

test('the dependents reader follows every page, deduplicates and refuses a malformed page or entry', async () => {
  const pages = {
    first: { value: [{ dependentcomponenttype: 60, dependentcomponentobjectid: DEP }], '@odata.nextLink': `${API}/RetrieveDependentComponents(page=2)` },
    second: { value: [{ dependentcomponenttype: 60, dependentcomponentobjectid: DEP.toUpperCase() }, { dependentcomponenttype: 24, dependentcomponentobjectid: OTHER }] },
  };
  const urls = [];
  const client = (second) => ({
    get: async (p) => { urls.push(p); return { status: 200, body: pages.first }; },
    getAbsolute: async (u) => { urls.push(u); return { status: 200, body: second }; },
  });
  const list = await readWebResourceDependents(client(pages.second))(WID);
  assert.match(urls[0], /RetrieveDependentComponents\(ObjectId=@p1,ComponentType=@p2\)\?@p1=88888888-0000-4000-8000-000000000001&@p2=61/);
  assert.deepEqual(list, [{ componentType: 60, objectId: DEP }, { componentType: 24, objectId: OTHER }]);
  await assert.rejects(readWebResourceDependents(client({ nothing: true }))(WID), { code: 'WEB_RESOURCE_DEPENDENTS_UNREADABLE' });
  await assert.rejects(readWebResourceDependents(client({ value: [{ dependentcomponenttype: 60 }] }))(WID), { code: 'WEB_RESOURCE_DEPENDENTS_UNREADABLE' });
});

test('a receipt wins over equal bytes: the recorded row is written again by its id, and the receipt clears only after settlement', async () => {
  const srv = server('var v = 2;');
  const cleared = [];
  const unconfirmed = { note: () => true, clear: (n) => cleared.push(n) };
  const ctx = { managed: fakeManaged(), authorizedAdoption: true, unconfirmed };
  const { plan, result } = await run(srv, declared('var v = 2;'), ctx, { recordedId: WID });
  assert.equal(plan.action, 'rewrite');
  assert.deepEqual(patches(srv).map((w) => w.url), [`${API}/webresourceset(${WID})`]);
  assert.equal(posts(srv).length, 0, 'never a fresh-name create');
  assert.equal(cleared.length, 0, 'apply never clears the receipt itself');
  assert.equal(settleWebResourceReceipt(ctx, plan, result), true);
  assert.deepEqual(cleared, [NAME]);
});

test('an unconfirmed publication is noted at once and stays unknown; a note that cannot be recorded says so', async () => {
  for (const recorded of [true, false]) {
    const srv = server('var v = 1;');
    failPublish(srv);
    const noted = [];
    const unconfirmed = { note: (n, id) => { noted.push([n, id]); return recorded; }, clear: () => assert.fail('nothing to clear') };
    const { result } = await run(srv, declared('var v = 2;'), { managed: { lookup: boundTo(WID).lookup }, unconfirmed });
    assert.deepEqual(noted, [[NAME, WID]]);
    assert.deepEqual(codes(result.unknown), recorded ? ['web-resource-publication-unconfirmed'] : ['web-resource-publication-unconfirmed', 'web-resource-recovery-record-failed']);
    assert.equal(result.unknown[0].possiblyPublished, true);
    assert.equal(result.managedBindings.length, 0);
  }
});

test('the row a binding names is checked by id: a missing row is never recreated, a renamed or retyped row is refused', async () => {
  const missing = server(null);
  const gone = await run(missing, declared('var v = 2;'), { managed: boundTo(WID), authorizedOverwrite: true });
  assert.deepEqual(codes(gone.result.refused), ['web-resource-bound-row-missing']);
  assert.equal(missing.writes.length, 0);
  const renamed = server('var v = 1;', { name: 'contoso_/scripts/other.js' });
  assert.deepEqual(codes((await run(renamed, declared('var v = 2;'), { managed: boundTo(WID), authorizedOverwrite: true })).result.refused), ['web-resource-identity-conflict']);
  const retyped = server('var v = 1;', { webresourcetype: 1 });
  assert.deepEqual(codes((await run(retyped, declared('var v = 2;'), { managed: boundTo(WID), authorizedOverwrite: true })).result.refused), ['web-resource-type-mismatch']);
  const conflict = server('var v = 1;');
  assert.deepEqual(codes((await run(conflict, declared('var v = 2;'), { managed: boundTo(WID) }, { recordedId: OTHER })).result.refused), ['web-resource-binding-mismatch']);
  for (const s of [renamed, retyped, conflict]) assert.equal(s.writes.length, 0);
});

test('drift, adoption and clearing each need their own approval', async () => {
  const drift = server('var v = 9;');
  assert.deepEqual(codes((await run(drift, declared('var v = 2;'), { managed: boundTo(WID) })).result.refused), ['web-resource-drift']);
  const overwritten = await run(drift, declared('var v = 2;'), { managed: boundTo(WID), authorizedOverwrite: true });
  assert.deepEqual(overwritten.result.saved.map((s) => s.id), [WID]);
  const unbound = server('var v = 9;');
  assert.deepEqual(codes((await run(unbound, declared('var v = 2;'), {})).result.refused), ['web-resource-adoption-not-authorized']);
  const clear = server('var v = 1;');
  assert.deepEqual(codes((await run(clear, declared(''), { managed: boundTo(WID) })).result.refused), ['web-resource-clear-not-authorized']);
  for (const s of [unbound, clear]) assert.equal(s.writes.length, 0);
});

test('a new resource is created through the creation port and bound to the id the service acknowledged', async () => {
  for (const creates of [passThroughCreates(), stableCreates()]) {
    const srv = server(null);
    const { plan, result } = await run(srv, declared('var v = 2;'), { managed: fakeManaged(), creates });
    assert.equal(plan.action, 'create');
    assert.equal(posts(srv).length, 1);
    const created = [...srv.store.get('webresourceset').values()][0];
    assert.deepEqual(result.saved.map((s) => [s.id, s.created]), [[created.webresourceid, true]]);
    assert.deepEqual(result.managedBindings.map((b) => [b.id, b.origin]), [[created.webresourceid, 'created']]);
  }
});

test('a create whose port answer fails after the SDK saved is unknown and possibly published, with no binding', async () => {
  const srv = server(null);
  const { result } = await run(srv, declared('var v = 2;'), { managed: fakeManaged(), creates: stableCreates({ failAfterExecute: true }) });
  assert.equal(posts(srv).length, 1);
  assert.equal(result.saved.length, 0);
  assert.equal(result.managedBindings.length, 0);
  assert.equal(result.unknown.length, 1);
  assert.equal(result.unknown[0].possiblyPublished, true);
  const noPort = server(null);
  const refused = await run(noPort, declared('var v = 2;'), { managed: fakeManaged() });
  assert.deepEqual(codes(refused.result.refused), ['web-resource-rejected']);
  assert.equal(noPort.writes.length, 0, 'no creation port: nothing is sent');
});

// A client whose published read of the row answers `answer` (the saved-layer and name reads are the server's own).
function publishedAnswers(srv, answer) {
  const base = clientOf(srv);
  return { ...base, get: (p) => (/^\/webresourceset\([^)]*\)\?\$select=webresourceid,content$/.test(p) ? Promise.resolve(answer) : base.get(p)) };
}
async function runWith(srv, client, wr, ctx = {}, extra = {}) {
  const sdk = await srv.newSdk();
  srv.clearLog();
  const plan = await planWebResourceUpdate({ webResource: wr, options: webResourceOpts(wr, '.'), reads: webResourceReads(client), readDependents: noDependents, ...extra }, ctx);
  return { plan, result: await applyWebResourceUpdate(plan, { sdk }, ctx) };
}

test('a receipt does not bypass the overwrite approval: content changed outside the spec since the last build is drift', async () => {
  const srv = server('external edit');
  const managed = { lookup: async () => ({ id: WID, intentSha256: shaOf('last applied'), origin: 'created' }) };
  const unconfirmed = { note: () => true, clear: () => {} };
  const { plan, result } = await run(srv, declared('wanted'), { managed, unconfirmed }, { recordedId: WID });
  assert.deepEqual(codes(result.refused), ['web-resource-drift']);
  assert.equal(plan.action, null);
  assert.equal(srv.writes.length, 0, 'nothing written over the other writer\'s content');
  assert.equal(Buffer.from(srv.rowOf('webresourceset', WID).content, 'base64').toString(), 'external edit');
  const approved = await run(srv, declared('wanted'), { managed, unconfirmed, authorizedOverwrite: true }, { recordedId: WID });
  assert.equal(approved.plan.action, 'rewrite');
  assert.deepEqual(approved.result.saved.map((s) => [s.id, s.clearsReceipt]), [[WID, true]]);
});

test('a receipt row whose published content cannot be read is unknown; one with no published layer is written again by id', async () => {
  const managed = { lookup: async () => ({ id: WID, intentSha256: shaOf('var v = 1;'), origin: 'created' }) };
  const unconfirmed = { note: () => true, clear: () => {} };
  for (const answer of [{ status: 500, headers: {}, body: { error: { code: '0x80040216', message: 'busy' } } }, { status: 200, headers: {}, body: { webresourceid: WID } }]) {
    const srv = server('var v = 1;');
    const { plan, result } = await runWith(srv, publishedAnswers(srv, answer), declared('var v = 2;'), { managed, unconfirmed }, { recordedId: WID });
    assert.deepEqual(codes(result.unknown), ['web-resource-content-unreadable']);
    assert.equal(plan.action, null);
    assert.equal(srv.writes.length, 0);
  }
  const srv = server('var v = 1;');
  const absent = { status: 404, headers: {}, body: { error: { code: '0x80040217', message: 'Does Not Exist' } } };
  const { plan, result } = await runWith(srv, publishedAnswers(srv, absent), declared('var v = 2;'), { managed, unconfirmed }, { recordedId: WID });
  assert.equal(plan.action, 'rewrite', 'a row the build created whose publication failed has no published layer yet');
  assert.deepEqual(result.saved.map((s) => s.id), [WID]);
  assert.deepEqual(patches(srv).map((w) => w.url), [`${API}/webresourceset(${WID})`]);
});

test('a create the service stored but answered without its id is unknown and keeps the find-by-name route, never "refused"', async () => {
  const srv = server(null);
  const post = srv.httpClient.post;
  // The SDK reads the new id from the OData-EntityId header (or the body); this answer has neither.
  srv.httpClient.post = async (url, body, options) => {
    const res = await post(url, body, options);
    return /\/webresourceset$/.test(String(url)) ? { status: 204, headers: {}, body: {} } : res;
  };
  const { result } = await run(srv, declared('wanted'), { managed: fakeManaged(), creates: stableCreates() });
  assert.equal(srv.store.get('webresourceset').size, 1, 'the row was written');
  assert.deepEqual(codes(result.refused), []);
  assert.deepEqual(codes(result.unknown), ['web-resource-write-unknown']);
  assert.equal(result.unknown[0].possiblyPublished, true);
  assert.match(result.unknown[0].message, /finds it by name/);
  assert.equal(result.managedBindings.length, 0);
});

test('clearing a receipt leaves a newer note of the same name that another build made since', () => {
  const workspaceDir = makeTempDir('wr-receipt-');
  const environment = 'https://contoso.crm.dynamics.com';
  const mine = openUnconfirmedWebResources({ workspaceDir, environment });
  assert.equal(mine.note(NAME, WID), true);
  const other = openUnconfirmedWebResources({ workspaceDir, environment });
  assert.equal(other.note(NAME, WID), true);
  settleWebResourceReceipt({ unconfirmed: mine }, { name: NAME }, { saved: [{ clearsReceipt: true }], refused: [], unknown: [] });
  const left = readUnconfirmedWebResources(workspaceDir, environment);
  assert.equal(left.size, 1, 'the newer revision survives');
  assert.ok(path.isAbsolute(workspaceDir));
});

// The platform answers an EMPTY web resource with the content property present and null (measured: a PATCH of content ""
// and a PublishXml, then GET /webresourceset(<id>)?$select=content answers { "content": null, ... }), in the SDK's read-back
// and in the build's own reads alike. This server stores "" for it; answer every row read of that row as the platform does.
function emptyAsNull(srv) {
  const get = srv.httpClient.get;
  srv.httpClient.get = async (url) => {
    const res = await get(url);
    if (/\/webresourceset\([^)]+\)/.test(String(url)) && res && res.body && res.body.content === '') return { ...res, body: { ...res.body, content: null } };
    return res;
  };
}
// One plan and apply whose apply is handed the build's reads too (as sdk-build does), so a write the SDK could not confirm
// can be confirmed by the published read.
async function runConfirming(srv, wr, ctx = {}, extra = {}, sdkOver = null) {
  const sdk = sdkOver || await srv.newSdk();
  srv.clearLog();
  const reads = webResourceReads(clientOf(srv));
  const plan = await planWebResourceUpdate({ webResource: wr, options: webResourceOpts(wr, '.'), reads, readDependents: noDependents, ...extra }, ctx);
  return { plan, result: await applyWebResourceUpdate(plan, { sdk, reads }, ctx) };
}

test('the published read takes a content of null as zero bytes; an answer without the content property, or of another type, stays unreadable', async () => {
  const answer = (body) => webResourceReads({ get: async () => ({ status: 200, body }) }).published(WID);
  assert.deepEqual(await answer({ webresourceid: WID, content: null }), { state: 'present', content: '' });
  assert.deepEqual(await answer({ webresourceid: WID, content: '' }), { state: 'present', content: '' });
  assert.deepEqual(await answer({ webresourceid: WID }), { state: 'unreadable' }, 'no property: nothing says what the bytes are');
  assert.deepEqual(await answer({ webresourceid: WID, content: 0 }), { state: 'unreadable' });
  assert.deepEqual(await answer({ webresourceid: OTHER, content: null }), { state: 'unreadable' }, 'another row\'s answer is never this row\'s');
});

test('real SDK: emptying a bound web resource that reads back as content null is confirmed by the build\'s own read, with no receipt; a rerun writes nothing', async () => {
  const srv = server('var v = 1;');
  emptyAsNull(srv);
  const managed = fakeManaged();
  const noted = [];
  const unconfirmed = { note: (n, id) => { noted.push([n, id]); return true; }, clear: () => {} };
  const first = await runConfirming(srv, declared(''), { managed: { ...managed, lookup: boundTo(WID).lookup }, unconfirmed, authorizedDestructive: true });
  assert.equal(first.plan.action, 'update');
  assert.deepEqual(patches(srv).map((w) => w.body.content), ['']);
  assert.equal(publishes(srv).length, 1);
  assert.deepEqual(codes(first.result.unknown), [], 'the SDK\'s WEB_RESOURCE_UNVERIFIED for a null read-back is settled by the published read');
  assert.deepEqual(first.result.saved.map((s) => [s.id, s.published]), [[WID, true]]);
  assert.deepEqual(noted, [], 'no receipt of an unconfirmed write');
  managed.persist(first.result.managedBindings);
  const again = await runConfirming(srv, declared(''), { managed, unconfirmed });
  assert.equal(again.plan.action, 'noChange');
  assert.equal(srv.writes.length, 0, 'an emptied resource is not written or published again');
});

test('real SDK: the receipt an earlier emptying write left (its read-back was null) is written again once, confirmed and cleared; the run after writes nothing', async () => {
  const srv = server('');
  emptyAsNull(srv);
  const cleared = [];
  const unconfirmed = { note: () => assert.fail('nothing is unconfirmed now'), clear: (n) => cleared.push(n) };
  const managed = fakeManaged();
  const ctx = { managed, unconfirmed, authorizedAdoption: true };
  const first = await runConfirming(srv, declared(''), ctx, { recordedId: WID });
  assert.equal(first.plan.action, 'rewrite', 'a receipt still wins over equal bytes: its row is written again by id');
  assert.deepEqual(codes(first.result.unknown), []);
  assert.deepEqual(first.result.saved.map((s) => [s.id, s.clearsReceipt]), [[WID, true]]);
  assert.equal(patches(srv).length, 1);
  assert.equal(settleWebResourceReceipt(ctx, first.plan, first.result), true);
  assert.deepEqual(cleared, [NAME]);
  managed.persist(first.result.managedBindings);
  const again = await runConfirming(srv, declared(''), { managed, unconfirmed });
  assert.equal(again.plan.action, 'noChange');
  assert.equal(srv.writes.length, 0);
});

test('real SDK: a new empty declared web resource that reads back as content null is a confirmed create, bound to its id', async () => {
  const srv = server(null);
  emptyAsNull(srv);
  const unconfirmed = { note: () => assert.fail('the create is confirmed'), clear: () => {} };
  const { plan, result } = await runConfirming(srv, declared(''), { managed: fakeManaged(), creates: stableCreates(), unconfirmed });
  assert.equal(plan.action, 'create');
  assert.equal(posts(srv).length, 1);
  const created = [...srv.store.get('webresourceset').values()][0];
  assert.deepEqual(codes(result.unknown), []);
  assert.deepEqual(result.saved.map((s) => [s.id, s.created]), [[created.webresourceid, true]]);
  assert.deepEqual(result.managedBindings.map((b) => [b.id, b.origin]), [[created.webresourceid, 'created']]);
});

test('an unconfirmed write is confirmed only after a publish that completed, by the row it wrote holding exactly the bytes it sent', async () => {
  // The SDK's error after its publish answered success and its read-back carried no content has NO cause; a refused
  // publish or a failed read-back carries that failure as a non-enumerable cause (the SDK's attachCause).
  const unverified = (id, cause) => {
    const e = Object.assign(new Error('was written and published, but the read-back carried no content'), { code: 'WEB_RESOURCE_UNVERIFIED', id });
    if (cause) Object.defineProperty(e, 'cause', { value: cause, enumerable: false, writable: true, configurable: true });
    return e;
  };
  const lock = Object.assign(new Error('Another customization operation holds the lock.'), { code: 'CONNECTION_ERROR', statusCode: 429 });
  // [what, the id the SDK names, its cause, whether the write reaches the row, whether the build's published read fails, confirmed]
  const cases = [
    ['the row written, its bytes published', WID, null, true, false, true],
    ['another row named by the SDK', OTHER, null, true, false, false],
    ['other published bytes', WID, null, false, false, false],
    ['a published read that fails', WID, null, true, true, false],
    ['a refused publish, though the row holds the bytes', WID, lock, true, false, false],
    ['a cause that is no error object, though the row holds the bytes', WID, 'refused', true, false, false],
  ];
  for (const [what, errId, cause, writes, readFails, confirmed] of cases) {
    const srv = server('var v = 1;');
    let written = false;
    const get = srv.httpClient.get;
    srv.httpClient.get = async (url) => (written && readFails && /\?\$select=webresourceid,content$/.test(String(url)) ? { status: 503, headers: {}, body: { error: { code: '0x80040216', message: 'busy' } } } : get(url));
    const sdk = {
      updateWebResource: async (id, c) => {
        if (writes) await srv.httpClient.patch(`${API}/webresourceset(${id})`, { content: b64(c.content) });
        written = true;
        throw unverified(errId, cause);
      },
    };
    const noted = [];
    const unconfirmed = { note: (n, id) => { noted.push(id); return true; }, clear: () => {} };
    const { result } = await runConfirming(srv, declared('var v = 2;'), { managed: { lookup: boundTo(WID).lookup }, unconfirmed }, {}, sdk);
    assert.deepEqual(codes(result.unknown), confirmed ? [] : ['web-resource-publication-unconfirmed'], what);
    assert.deepEqual(result.saved.map((s) => s.id), confirmed ? [WID] : [], what);
    assert.equal(noted.length, confirmed ? 0 : 1, `${what}: a receipt only for an unconfirmed write`);
  }
});