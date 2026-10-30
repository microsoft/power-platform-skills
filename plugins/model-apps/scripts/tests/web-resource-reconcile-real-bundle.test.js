'use strict';
// Declared web-resource reconciliation through the REAL vendored SDK over an in-memory webresourceset:
// differing content is written, published and read back once; identical content writes and publishes
// nothing; an external or unapproved shared row is never written; an unconfirmed publication is an
// unknown outcome handed to the build's recovery record.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRowTableServer } = require('./helpers/row-table-server.js');
const { fakeManaged } = require('./helpers/feature-ports.js');
const { webResourceOpts } = require('../lib/sdk-build.js');
const { planWebResourceUpdate, applyWebResourceUpdate, createdWebResourceBinding } = require('../lib/web-resource-reconcile.js');

const WID = '88888888-0000-4000-8000-000000000001';
const NAME = 'contoso_/scripts/form.js';
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

function server(content = 'var v = 1;') {
  const srv = createRowTableServer({ tables: { webresourceset: 'webresourceid' } });
  srv.seed('webresourceset', { webresourceid: WID, name: NAME, displayname: NAME, webresourcetype: 3, content: b64(content) });
  return srv;
}
const declared = (content, over = {}) => ({ name: NAME, type: 'js', content, reconcile: 'declared', ...over });

async function run(srv, wr, ctx = {}, extra = {}) {
  const sdk = await srv.newSdk();
  const row = srv.rowOf('webresourceset', WID);
  const plan = await planWebResourceUpdate({ webResource: wr, existingId: WID, deployed: row && row.content, options: webResourceOpts(wr, '.'), ...extra }, ctx);
  const result = await applyWebResourceUpdate(plan, { sdk }, ctx);
  return { plan, result };
}
const publishes = (srv) => srv.writes.filter((w) => /PublishXml/.test(w.url));
const patches = (srv) => srv.writes.filter((w) => w.verb === 'patch');

test('changed content is written once, published by the write itself and read back; a rerun writes and publishes nothing', async () => {
  const srv = server();
  const managed = fakeManaged();
  const { result } = await run(srv, declared('var v = 2;'), { authorizedAdoption: true, managed });
  assert.deepEqual(result.saved.map((s) => s.id), [WID]);
  assert.equal(patches(srv).length, 1);
  assert.equal(publishes(srv).length, 1);
  assert.equal(Buffer.from(srv.rowOf('webresourceset', WID).content, 'base64').toString('utf8'), 'var v = 2;');
  managed.persist(result.managedBindings);

  srv.clearLog();
  const second = await run(srv, declared('var v = 2;'), { managed });
  assert.equal(second.plan.action, 'noChange');
  assert.equal(srv.writes.length, 0, 'identical content: no write and no publish');
});

test('an external web resource is never written, even when its content differs', async () => {
  const srv = server();
  const { result } = await run(srv, declared('var v = 2;', { external: true }), { authorizedAdoption: true });
  assert.deepEqual(result.refused.map((r) => r.code), ['web-resource-external']);
  assert.equal(srv.writes.length, 0);
});

test('a shared row this spec does not manage yet is refused until adoption is approved, and the plan names its dependents', async () => {
  const srv = server();
  const readDependents = async () => [{ componentType: 60 }, { componentType: 60 }, { componentType: 24 }];
  const { plan, result } = await run(srv, declared('var v = 2;'), {}, { readDependents });
  assert.deepEqual(result.refused.map((r) => r.code), ['web-resource-adoption-not-authorized']);
  assert.deepEqual(plan.dependents, { count: 3, byComponentType: { 24: 1, 60: 2 } });
  assert.equal(srv.writes.length, 0);
});

test('content changed outside the spec since the last build is refused until the overwrite is approved', async () => {
  const srv = server();
  const managed = fakeManaged();
  const first = await run(srv, declared('var v = 2;'), { authorizedAdoption: true, managed });
  managed.persist(first.result.managedBindings);
  srv.rowOf('webresourceset', WID).content = b64('var v = 99; // hotfix');
  srv.clearLog();
  const refused = await run(srv, declared('var v = 3;'), { managed });
  assert.deepEqual(refused.result.refused.map((r) => r.code), ['web-resource-drift']);
  assert.equal(srv.writes.length, 0);
  // Someone else made it exactly what the spec now says: converged, nothing to write.
  srv.rowOf('webresourceset', WID).content = b64('var v = 3;');
  const converged = await run(srv, declared('var v = 3;'), { managed });
  assert.equal(converged.plan.action, 'noChange');
  assert.equal(srv.writes.length, 0);
});

test('an unconfirmed publication is unknown, never saved, and is handed to the recovery record', async () => {
  const srv = server();
  const post = srv.httpClient.post;
  srv.httpClient.post = async (url, body) => (/PublishXml/.test(String(url))
    ? { status: 500, headers: {}, body: { error: { code: '0x80040216', message: 'publish failed' } } }
    : post(url, body));
  const noted = [];
  const { result } = await run(srv, declared('var v = 2;'), { authorizedAdoption: true, unconfirmed: { note: (name, id) => noted.push([name, id]) } });
  assert.deepEqual(result.unknown.map((u) => u.code), ['web-resource-publication-unconfirmed']);
  assert.deepEqual(result.saved, []);
  assert.deepEqual(result.managedBindings, [], 'an unproven write is not recorded as applied');
  assert.deepEqual(noted, [[NAME, WID]]);
});

test('a source or deployed content that cannot be read is unknown and writes nothing', async () => {
  const srv = server();
  const sdk = await srv.newSdk();
  const noSource = await planWebResourceUpdate({ webResource: declared('x'), existingId: WID, deployed: b64('y'), options: null });
  assert.deepEqual(noSource.unknown.map((u) => u.code), ['web-resource-source-unreadable']);
  const noContent = await planWebResourceUpdate({ webResource: declared('x'), existingId: WID, deployed: undefined, options: webResourceOpts(declared('x'), '.') });
  assert.deepEqual(noContent.unknown.map((u) => u.code), ['web-resource-content-unreadable']);
  await applyWebResourceUpdate(noContent, { sdk });
  assert.equal(srv.writes.length, 0);
});

test('a created web resource binds to the bytes the build wrote, so the next build is a no-op', async () => {
  const srv = server('var v = 7;');
  const managed = fakeManaged([createdWebResourceBinding(declared('var v = 7;'), WID, webResourceOpts(declared('var v = 7;'), '.'))]);
  const { plan } = await run(srv, declared('var v = 7;'), { managed });
  assert.equal(plan.action, 'noChange');
  assert.equal(plan.origin, 'created');
});
