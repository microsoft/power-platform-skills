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
