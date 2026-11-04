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
const { ENV, API, REQ, URL_API, URL_MEMBER, open, apiPlan, apiExpected, apiBody, apiClassifier } = require('./helpers/managed-rows.js');

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
  assert.equal(answerOf({ statusCode: 201, headers: { Location: `${URL_API}(uniquename='contoso_api')` } }, API).outcome, 'unknown', 'an alternate-key answer names no id');
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

// The identity a protected Custom API create is answered under: its own row and the one request parameter it carries.
const EXPECT = { id: API, table: 'customapis', key: 'customapiid', children: [{ id: REQ, at: 'CustomAPIRequestParameters', key: 'customapirequestparameterid', match: { uniquename: 'p' } }] };
const at = (id = API, table = 'customapis') => `${ENV}/api/data/v9.2/${table}(${id})`;
const child = (over = {}) => ({ uniquename: 'p', customapirequestparameterid: REQ, ...over });

test('every identity an answer carries must agree with the prepared row: a second, folded or other-table header is never read past', () => {
  const cases = [
    ['one matching OData-EntityId', { statusCode: 204, headers: { 'OData-EntityId': at() }, body: '' }, 'acknowledged'],
    ['OData-EntityId and Location agree', { statusCode: 204, headers: { 'odata-entityid': at(), LOCATION: at() } }, 'acknowledged'],
    ['the key spelled as name=value', { statusCode: 204, headers: { 'odata-entityid': `${ENV}/api/data/v9.2/customapis(customapiid=${API})` } }, 'acknowledged'],
    ['the empty 204 with no identity', { statusCode: 204, headers: {}, body: '' }, 'acknowledged'],
    ['one header in two spellings', { statusCode: 204, headers: { 'OData-EntityId': at(), 'odata-entityid': at() } }, 'unknown'],
    ['a header folded with a comma', { statusCode: 204, headers: { 'odata-entityid': `${at()}, ${at()}` } }, 'unknown'],
    ['a header given as two values', { statusCode: 204, headers: { 'odata-entityid': [at(), at()] } }, 'unknown'],
    ['an alternate-key URL', { statusCode: 204, headers: { Location: `${ENV}/api/data/v9.2/customapis(uniquename='contoso_api')` } }, 'unknown'],
    ['a header that names no row', { statusCode: 204, headers: { Location: `${ENV}/api/data/v9.2/customapis` } }, 'unknown'],
    ['a 202, which only queued the request', { statusCode: 202, headers: { 'odata-entityid': at() } }, 'unknown'],
    ['a 201 with no identity at all', { statusCode: 201, headers: {} }, 'unknown'],
    ['a 200 whose body names no key', { statusCode: 200, headers: {}, body: '{}' }, 'unknown'],
    ['the first header agrees, the second names another row', { statusCode: 204, headers: { 'odata-entityid': at(), location: at(REQ) } }, 'conflict'],
    ['a header under another table', { statusCode: 204, headers: { 'odata-entityid': at(API, 'accounts') } }, 'conflict'],
    ['another row wins over a folded header', { statusCode: 204, headers: { 'odata-entityid': `${at()}, ${at()}`, location: at(REQ) } }, 'conflict'],
  ];
  for (const [name, res, want] of cases) assert.equal(answerOf(res, EXPECT).outcome, want, name);
  assert.equal(answerOf({ statusCode: 204, headers: { location: at(REQ) } }, EXPECT).answeredId, REQ, 'the id that disagrees is the one reported');
});

test('a body is read for the prepared key and each named child only, and any doubt about it is unknown', () => {
  const ok = { customapiid: API, uniquename: 'contoso_api', CustomAPIRequestParameters: [child()] };
  const res = (body, headers = { 'odata-entityid': at() }) => ({ statusCode: 201, headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const cases = [
    ['the body agrees with the header', res(ok), 'acknowledged'],
    ['the body alone, as an object', { statusCode: 201, headers: {}, body: ok }, 'acknowledged'],
    ['a lookup to another row is not an identity', res({ ...ok, _parentid_value: REQ }), 'acknowledged'],
    ['no child array: the child is not answered for', res({ customapiid: API }), 'acknowledged'],
    ['the body names another row', res({ ...ok, customapiid: REQ }), 'conflict'],
    ['the child is answered under another id', res({ ...ok, CustomAPIRequestParameters: [child({ customapirequestparameterid: API })] }), 'conflict'],
    ['the key twice in the text (JSON.parse keeps the last)', res(`{"customapiid":"${REQ}","customapiid":"${API}"}`), 'unknown'],
    ['a key that is not a string', res({ ...ok, customapiid: 7 }), 'unknown'],
    ['an OData error envelope under a 2xx', res({ error: { code: '0x80040217', message: 'no' } }), 'unknown'],
    ['a body that is not JSON', res('<html/>'), 'unknown'],
    ['a body that is an array', res([ok]), 'unknown'],
    ['no child matches', res({ ...ok, CustomAPIRequestParameters: [] }), 'unknown'],
    ['two children match', res({ ...ok, CustomAPIRequestParameters: [child(), child()] }), 'unknown'],
    ['the child array is not an array', res({ ...ok, CustomAPIRequestParameters: {} }), 'unknown'],
    ['the child id is not a GUID', res({ ...ok, CustomAPIRequestParameters: [child({ customapirequestparameterid: 'x' })] }), 'unknown'],
  ];
  for (const [name, r, want] of cases) assert.equal(answerOf(r, EXPECT).outcome, want, name);
});

test('a deep insert whose answer names another child id is a conflict for every row it carried', async () => {
  const h = harness({ answer: () => ({ statusCode: 201, headers: { 'odata-entityid': at() }, body: JSON.stringify({ customapiid: API, CustomAPIRequestParameters: [child({ customapirequestparameterid: OTHER })] }) }) });
  const out = await runWithManagedCreateSet(h.set, () => h.client.post(URL_API, JSON.stringify(apiBody()), { headers: { Prefer: 'return=representation' } }));
  assert.equal(h.sent.length, 1);
  assert.deepEqual(out.facts.map((f) => [f.kind, f.outcome]), [['customApi', 'conflict'], ['customApiRequestParameter', 'conflict']]);
});

test('a row request that does not say which table and key its answer is read against, or where a child is found, is refused unsent', async () => {
  const variants = [
    (c) => ({ ...c, expectTable: undefined }),
    (c) => ({ ...c, expectKey: 'not a field' }),
    (c) => ({ ...c, rows: c.rows.map((r, i) => (i ? { ...r, answer: { at: 'CustomAPIRequestParameters', key: 'customapirequestparameterid', match: {} } } : r)) }),
  ];
  for (const change of variants) {
    const h = harness();
    const base = apiClassifier(h.token);
    h.set.classify = (req) => { const c = base(req); return c && c.type === 'rows' ? change(c) : c; };
    const before = JSON.stringify(diskOf(h.dir));
    const out = await runWithManagedCreateSet(h.set, () => swallow(h.client.post(URL_API, JSON.stringify(apiBody()))));
    assert.equal(out.localError.code, MISMATCH);
    assert.equal(h.sent.length, 0);
    assert.equal(JSON.stringify(diskOf(h.dir)), before);
  }
  const control = harness();
  control.set.classify = apiClassifier(control.token);
  const sent = await runWithManagedCreateSet(control.set, () => control.client.post(URL_API, JSON.stringify(apiBody())));
  assert.deepEqual([sent.localError, control.sent.length], [null, 1], 'the same request with its descriptor whole is sent');
});

test('a request still unanswered when its set settles is an unknown fact; its late answer, or a second one, is not read', async () => {
  let release;
  const h = harness({ answer: () => new Promise((resolve) => { release = resolve; }) });
  let pending;
  const out = await runWithManagedCreateSet(h.set, async () => {
    pending = swallow(h.client.post(URL_API, JSON.stringify(apiBody())));
    while (h.sent.length === 0) await new Promise((resolve) => setImmediate(resolve));
    return 'the SDK did not wait';
  });
  assert.equal(h.sent.length, 1);
  assert.deepEqual(out.facts.map((f) => [f.kind, f.outcome, f.status, f.unanswered]), [['customApi', 'unknown', null, true], ['customApiRequestParameter', 'unknown', null, true]]);
  release({ statusCode: 204, headers: { 'odata-entityid': at() }, body: '' });
  await pending;
  assert.equal(out.facts.length, 2);
  const twice = harness();
  const t = await runWithManagedCreateSet(twice.set, async () => {
    const hd = twice.gate.screen({ method: 'POST', url: URL_API, body: JSON.stringify(apiBody()), headers: {} });
    hd.dispatching();
    hd.answered({ statusCode: 204, headers: { 'odata-entityid': at() }, body: '' });
    hd.answered({ statusCode: 204, headers: { 'odata-entityid': at(OTHER) }, body: '' });
  });
  assert.deepEqual(t.facts.map((f) => f.outcome), ['acknowledged', 'acknowledged']);
});

test('inside a set, a refusal anywhere in the composed boundary is kept as the local failure, in either gate order', async () => {
  const refusal = () => Object.assign(new Error('no'), { code: 'managed-workflow-effect-mismatch' });
  const refusing = { screen: () => { throw refusal(); } };
  for (const order of [(g) => [refusing, g], (g) => [g, refusing]]) {
    const h = harness();
    const out = await runWithManagedCreateSet(h.set, async () => {
      try { composeWriteGates(...order(h.gate)).screen({ method: 'POST', url: URL_API, body: JSON.stringify(apiBody()), headers: {} }); } catch { /* the SDK swallowed it */ }
      return 'saved';
    });
    assert.equal(out.value, 'saved');
    assert.equal(out.localError && out.localError.code, 'managed-workflow-effect-mismatch');
  }
  const thrown = refusal();
  const owner = { dispatching() { throw thrown; }, answered() {} };
  const workflow = { screen: () => owner };
  const out = await runWithManagedCreateSet(harness().set, async () => {
    const hd = composeWriteGates(workflow).screen({ method: 'POST', url: `${ENV}/api/data/v9.2/workflows`, body: '{}' });
    try { hd.dispatching(); } catch { /* the SDK swallowed it */ }
    return 'saved';
  });
  assert.equal(out.localError, thrown, 'a handle that refuses at dispatch is latched too');
  assert.equal(composeWriteGates(workflow).screen({ method: 'POST', url: `${ENV}/api/data/v9.2/workflows` }), owner, 'outside a set the handle is the gate\'s own');
  assert.throws(() => composeWriteGates(refusing).screen({ method: 'POST', url: URL_API }), { code: 'managed-workflow-effect-mismatch' });
});