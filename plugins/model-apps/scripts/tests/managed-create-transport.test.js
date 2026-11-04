'use strict';
// The send-once request boundary of a protected create set (lib/managed-create-transport.js), driven through the
// plugin's real HTTP client (lib/sdk-http-client.js) with a fake transport: inert outside a set's scope; inside one,
// every row is sealed in the store before its request leaves, sent at most once, and anything the set did not prepare —
// an unbound gate, a DELETE, a `$batch`, an unclassified write, another id or parent, a fenced epoch — is refused unsent
// and kept as the set's typed local failure, whatever the SDK does with the error.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { createAzHttpClient } = require('../lib/sdk-http-client.js');
const { CODES } = require('../lib/managed-bindings.js');
const { apiPath } = require('../lib/workflow-effect-context.js');
const { MISMATCH, createDeferredManagedCreateGate, runWithManagedCreateSet, composeWriteGates, answerOf } = require('../lib/managed-create-transport.js');
const { ENV, API, URL_API, URL_MEMBER, open, apiPlan, apiExpected, apiBody, apiClassifier } = require('./helpers/managed-rows.js');

const OTHER = '77777777-7777-4777-8777-777777777777';

// A store with one sending Custom API attempt, a gate bound to it, and a client whose every request is recorded with
// what the store file said at the moment it left.
function harness({ answer, bind = true } = {}) {
  const dir = makeTempDir('mc-transport-');
  const store = open(dir);
  const [token] = store.prepareAttemptSet([apiPlan()]);
  const [entry] = store.markAttemptSetSending([{ token, expected: apiExpected() }]);
  const gate = createDeferredManagedCreateGate();
  if (bind) gate.bind(store);
  const sent = [];
  const request = async (req) => {
    sent.push({ method: req.method, url: req.url, disk: diskOf(dir) });
    if (answer) return answer(req);
    return { statusCode: 204, headers: { 'OData-EntityId': `${URL_API}(${API})` }, body: '' };
  };
  const client = createAzHttpClient(ENV, { getToken: () => 'TOK', request, sleep: async () => {}, workflowEffectGate: gate });
  const set = { store, entries: [entry], classify: apiClassifier(token), deleteCode: 'configuration-protected-removal-unsupported' };
  return { dir, store, token, entry, gate, client, sent, set };
}
// What the store file holds now, read by a fresh handle.
const diskOf = (dir) => JSON.parse(JSON.stringify(open(dir).snapshot().envelope));
const swallow = (p) => p.then(() => null, (e) => e);

test('outside a create set the gate is inert, bound or not: every request is sent as before', async () => {
  const h = harness({ bind: false });
  await h.client.post(URL_API, apiBody());
  await h.client.delete(`${URL_API}(${API})`);
  assert.equal(h.sent.length, 2);
  assert.equal(h.gate.screen({ method: 'POST', url: URL_API, body: '{}' }), null);
});

test('inside a set an unbound gate refuses every write unsent, and reads still pass', async () => {
  const h = harness({ bind: false });
  const out = await runWithManagedCreateSet(h.set, async () => {
    await h.client.get(URL_API);
    return swallow(h.client.post(URL_API, JSON.stringify(apiBody())));
  });
  assert.deepEqual(h.sent.map((s) => s.method), ['GET']);
  assert.equal(out.localError.code, MISMATCH);
  assert.equal(out.value, out.localError, 'the SDK saw the same typed error');
});

test('a DELETE, a $batch and an unclassified write are refused unsent; after one refusal nothing further is sent', async () => {
  const h = harness();
  const out = await runWithManagedCreateSet(h.set, async () => {
    const del = await swallow(h.client.delete(`${URL_API}(${API})`));
    const batch = await swallow(h.client.post(`${ENV}/api/data/v9.2/$batch`, '--b\r\n'));
    const other = await swallow(h.client.patch(`${ENV}/api/data/v9.2/accounts(${OTHER})`, { name: 'x' }));
    const later = await swallow(h.client.post(URL_API, JSON.stringify(apiBody())));
    return [del, batch, other, later].map((e) => e && e.code);
  });
  assert.deepEqual(out.value, ['configuration-protected-removal-unsupported', MISMATCH, MISMATCH, MISMATCH]);
  assert.equal(h.sent.length, 0);
  assert.equal(out.localError.code, 'configuration-protected-removal-unsupported', 'the first local failure is the one surfaced');
});

test('a write the classifier does not recognise is refused even as the first request of the set', async () => {
  const h = harness();
  const out = await runWithManagedCreateSet(h.set, () => swallow(h.client.patch(`${ENV}/api/data/v9.2/accounts(${OTHER})`, { name: 'x' })));
  assert.equal(out.localError.code, MISMATCH);
  assert.equal(h.sent.length, 0);
});

test('every row of a request is sealed in the store before it leaves, sent once, and acknowledged in memory only', async () => {
  const h = harness();
  const out = await runWithManagedCreateSet(h.set, async () => {
    await h.client.post(URL_API, JSON.stringify(apiBody()));
    return swallow(h.client.post(URL_API, JSON.stringify(apiBody())));
  });
  assert.equal(h.sent.length, 1);
  const rows = h.sent[0].disk.attempts[0].rowProtocol.rows;
  assert.deepEqual(rows.map((r) => [r.dispatched, r.sentFields]), [[true, ['customapiid', 'uniquename']], [true, ['uniquename']]], 'sealed before the send');
  assert.equal(h.sent[0].disk.attempts[0].sendWindow.possible, 1);
  assert.equal(out.value.code, MISMATCH, 'the second send of the same rows is refused');
  assert.deepEqual(out.facts.map((f) => [f.kind, f.outcome, f.status]), [['customApi', 'acknowledged', 204], ['customApiRequestParameter', 'acknowledged', 204]]);
  assert.equal(diskOf(h.dir).attempts[0].acknowledgedRoot, false, 'an answer is never persisted as a receipt here');
});

test('a row under another id or another parent is refused before anything is written', async () => {
  for (const body of [apiBody(API, OTHER), apiBody(API, undefined, OTHER)]) {
    const h = harness();
    const before = JSON.stringify(diskOf(h.dir));
    const out = await runWithManagedCreateSet(h.set, () => swallow(h.client.post(URL_API, JSON.stringify(body))));
    assert.equal(out.localError.code, MISMATCH);
    assert.equal(h.sent.length, 0);
    assert.equal(JSON.stringify(diskOf(h.dir)), before);
  }
});

test('an answer naming another id is a conflict; a lost answer is unknown; neither is acknowledged', async () => {
  const conflict = harness({ answer: () => ({ statusCode: 204, headers: { 'odata-entityid': `${URL_API}(${OTHER})` }, body: '' }) });
  const c = await runWithManagedCreateSet(conflict.set, () => conflict.client.post(URL_API, JSON.stringify(apiBody())));
  assert.deepEqual([c.facts[0].outcome, c.facts[0].answeredId], ['conflict', OTHER]);
  const lost = harness({ answer: () => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); } });
  const l = await runWithManagedCreateSet(lost.set, () => swallow(lost.client.post(URL_API, JSON.stringify(apiBody()))));
  assert.equal(lost.sent.length, 1, 'a send-once request is not re-sent after a transport failure');
  assert.deepEqual(l.facts.map((f) => f.outcome), ['unknown', 'unknown']);
  assert.equal(l.localError, null, 'a remote failure is not a local one');
  assert.deepEqual(answerOf({ statusCode: 201, headers: { Location: `${URL_API}(uniquename='contoso_api')` } }, API), { outcome: 'acknowledged', status: 201 });
  assert.equal(answerOf({ statusCode: 409, headers: {} }, API).outcome, 'unknown');
});

test('a run whose attempt was claimed by another since it began is fenced at the store: unsent, and its failure kept even when swallowed', async () => {
  const h = harness();
  open(h.dir).markAttemptSetSending([{ token: h.token, expected: apiExpected() }], { claim: 'continue' });
  const out = await runWithManagedCreateSet(h.set, async () => { await swallow(h.client.post(URL_API, JSON.stringify(apiBody()))); return 'the SDK reported nothing'; });
  assert.equal(h.sent.length, 0);
  assert.equal(out.value, 'the SDK reported nothing');
  assert.equal(out.localError.code, CODES.pending);
});

test('a completion effect is marked dispatched before it leaves and sent once', async () => {
  const h = harness();
  const out = await runWithManagedCreateSet(h.set, async () => {
    await h.client.post(URL_MEMBER, JSON.stringify({ ComponentId: API, ComponentType: 10134 }));
    return swallow(h.client.post(URL_MEMBER, JSON.stringify({ ComponentId: API, ComponentType: 10134 })));
  });
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].disk.attempts[0].rowProtocol.effects.find((e) => e.id === API).dispatched, true);
  assert.equal(out.value.code, MISMATCH);
  assert.deepEqual(out.facts.map((f) => [f.type, f.kind, f.outcome]), [['effect', 'membership', 'acknowledged']]);
});

test('a request left running after its set ended is refused', async () => {
  const h = harness();
  let late;
  await runWithManagedCreateSet(h.set, async () => { late = new Promise((resolve) => setImmediate(resolve)).then(() => swallow(h.client.post(URL_API, JSON.stringify(apiBody())))); });
  assert.equal((await late).code, MISMATCH);
  assert.equal(h.sent.length, 0);
});

test('composed gates: a request one gate owns keeps that gate\'s handle; two owners or any refusal send nothing', async () => {
  const handle = { dispatching() {}, answered() {} };
  const workflow = { screen: (req) => (req.url.endsWith('/workflows') ? handle : null) };
  const h = harness();
  const both = composeWriteGates(workflow, null, h.gate);
  assert.equal(both.screen({ method: 'POST', url: `${ENV}/api/data/v9.2/workflows`, body: '{}' }), handle, 'outside a set the workflow gate alone decides');
  assert.equal(both.screen({ method: 'POST', url: URL_API, body: '{}' }), null);
  const out = await runWithManagedCreateSet(h.set, async () => {
    const owned = both.screen({ method: 'POST', url: URL_API, body: JSON.stringify(apiBody()), headers: {} });
    return typeof owned.dispatching;
  });
  assert.equal(out.value, 'function');
  const greedy = { screen: () => handle };
  const two = await runWithManagedCreateSet(harness().set, () => swallow(Promise.resolve().then(() => composeWriteGates(greedy, greedy).screen({ method: 'POST', url: URL_API }))));
  assert.equal(two.value.code, MISMATCH);
  assert.equal(two.localError, two.value);
  const refusing = { screen: () => { throw Object.assign(new Error('no'), { code: 'managed-workflow-effect-mismatch' }); } };
  assert.throws(() => composeWriteGates(refusing, h.gate).screen({ method: 'POST', url: URL_API }), { code: 'managed-workflow-effect-mismatch' });
});

test('the gate binds once, to one store', () => {
  const a = harness();
  assert.equal(a.gate.boundTo(a.store), true);
  a.gate.bind(a.store);
  assert.throws(() => a.gate.bind(open(makeTempDir('mc-transport-'))), /already bound/);
  assert.throws(() => a.gate.bind({}), TypeError);
});
