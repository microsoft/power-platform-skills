'use strict';
// lib/app-component-scope.js: the limit a page edit puts on the AddAppComponents the SDK posts after it writes an app's sitemap. The real bundle's requests are pinned in
// genpage-app-edit-real-bundle.test.js; these hold the limit itself, against a transport that only records — what it reads exactly, and that what it cannot read is refused,
// never forwarded whole and never answered as if it had been done.
const { test } = require('node:test');
const assert = require('node:assert');
const { makeAppComponentScope } = require('../lib/app-component-scope.js');
const { SdkError } = require('../lib/maker-sdk.js');

const APP = '22222222-2222-4222-8222-222222222222';
const OTHER_APP = '33333333-3333-4333-8333-333333333333';
const VIEW = '66666666-6666-4666-8666-666666666666';
const VIEW_2 = '66666666-6666-4666-8666-666666666667';
const FORM = '99999999-9999-4999-8999-999999999991';
const CHART = '99999999-9999-4999-8999-999999999993';
// The SDK's API root is api/data/v9.0.
const ROOT = 'https://contoso.crm.dynamics.com/api/data/v9.0';
const ADD = `${ROOT}/AddAppComponents`;

const table = { '@odata.id': 'accounts(88888888-8888-4888-8888-888888888888)' };
const form = (formid) => ({ '@odata.type': 'Microsoft.Dynamics.CRM.systemform', formid });
const view = (savedqueryid) => ({ '@odata.type': 'Microsoft.Dynamics.CRM.savedquery', savedqueryid });
const chart = (savedqueryvisualizationid) => ({ '@odata.type': 'Microsoft.Dynamics.CRM.savedqueryvisualization', savedqueryvisualizationid });
// What the SDK derives for an Entity sub-area, plus the view a page edit pinned.
const derived = (AppId = APP) => ({ AppId, Components: [table, form(FORM), view(VIEW), view(VIEW_2), chart(CHART)] });

// A transport that records what reaches it and answers 204, or the answer a test gives.
function transport(answer = () => ({ status: 204, headers: {}, body: undefined })) {
  const calls = [];
  const client = {
    get: async (url) => { calls.push(['get', url]); return { status: 200, headers: {}, body: { value: [] } }; },
    post: async (url, body, options) => { calls.push(['post', url, body, options]); return answer(url, body); },
    patch: async (url, body) => { calls.push(['patch', url, body]); return { status: 200, headers: {}, body: {} }; },
    postRaw: async () => ({ status: 200, headers: {}, body: '' }),
  };
  return { client, calls };
}

test('a post for an app with an edit open carries only the views that edit owns — the table, the forms, the other views and the charts the SDK derived are dropped', async () => {
  const scope = makeAppComponentScope();
  const { client, calls } = transport();
  const wrapped = scope.wrap(client);
  const answer = await scope.limit(APP, { views: [VIEW] }, () => wrapped.post(ADD, derived(), { headers: { 'If-Match': '1' } }));
  assert.deepStrictEqual(answer, { status: 204, headers: {}, body: undefined });
  assert.deepStrictEqual(calls, [['post', ADD, { AppId: APP, Components: [view(VIEW)] }, { headers: { 'If-Match': '1' } }]], 'the rest of the body and the options are as the SDK sent them');
});

test('the ids are compared as GUIDs — braces and letter case do not matter, on either side — and the entries keep the SDK\'s order', async () => {
  const scope = makeAppComponentScope();
  const { client, calls } = transport();
  const wrapped = scope.wrap(client);
  await scope.limit(APP.toUpperCase(), { views: [`{${VIEW_2.toUpperCase()}}`, VIEW] }, () => wrapped.post(ADD, derived(`{${APP}}`)));
  assert.deepStrictEqual(calls[0][2].Components, [view(VIEW), view(VIEW_2)]);
});

test('an edit that owns no view posts nothing — the SDK is answered with the service\'s 204, which it accepts, and no request is made', async () => {
  const scope = makeAppComponentScope();
  const { client, calls } = transport();
  const wrapped = scope.wrap(client);
  const answer = await scope.limit(APP, { views: [] }, () => wrapped.post(ADD, derived()));
  assert.deepStrictEqual(answer, { status: 204, headers: {}, body: undefined });
  assert.deepStrictEqual(calls, []);
  // `limit` with no list at all owns nothing either.
  assert.deepStrictEqual(await scope.limit(APP, undefined, () => wrapped.post(ADD, derived())), { status: 204, headers: {}, body: undefined });
  assert.deepStrictEqual(calls, []);
});

test('a post that holds nothing but what the edit owns is sent as it is — the same body, not a copy', async () => {
  const scope = makeAppComponentScope();
  const { client, calls } = transport();
  const wrapped = scope.wrap(client);
  const body = { AppId: APP, Components: [view(VIEW)] };
  await scope.limit(APP, { views: [VIEW] }, () => wrapped.post(ADD, body));
  assert.strictEqual(calls[0][2], body);
});

test('with no edit open nothing is limited — the SDK\'s own post goes through whole, which is what the build, that owns the whole app, relies on', async () => {
  const scope = makeAppComponentScope();
  const { client, calls } = transport();
  const wrapped = scope.wrap(client);
  const body = derived();
  await wrapped.post(ADD, body);
  assert.strictEqual(calls[0][2], body);
  // …and after an edit has ended, by an answer or by a failure.
  await scope.limit(APP, { views: [VIEW] }, async () => undefined);
  await assert.rejects(scope.limit(APP, { views: [VIEW] }, async () => { throw new Error('the push failed'); }), /the push failed/);
  await wrapped.post(ADD, body);
  assert.strictEqual(calls[1][2], body, 'the limit is lifted when the edit ends, whichever way');
});

test('an edit of one app does not limit another app\'s post, and every other request goes through untouched', async () => {
  const scope = makeAppComponentScope();
  const { client, calls } = transport();
  const wrapped = scope.wrap(client);
  const elsewhere = derived(OTHER_APP);
  await scope.limit(APP, { views: [VIEW] }, async () => {
    await wrapped.post(ADD, elsewhere);
    await wrapped.post(`${ROOT}/PublishXml`, { ParameterXml: '<importexportxml/>' });
    // Another action, with a body of the same shape.
    await wrapped.post(`${ROOT}/RemoveAppComponents`, derived());
    await wrapped.get(`${ROOT}/appmodules`);
    await wrapped.patch(`${ROOT}/sitemaps(1)`, { sitemapxml: '<SiteMap/>' });
  });
  assert.strictEqual(calls[0][2], elsewhere);
  assert.deepStrictEqual(calls.map(([method]) => method), ['post', 'post', 'post', 'get', 'patch']);
  assert.deepStrictEqual(calls[2][2], derived(), 'another action keeps its whole list');
});

test('the transport keeps what it had — every method it offered, and the answers of the posts that go through', async () => {
  const scope = makeAppComponentScope();
  const { client } = transport(() => ({ status: 201, headers: { 'odata-entityid': 'x' }, body: { id: 1 } }));
  const wrapped = scope.wrap(client);
  for (const key of Object.keys(client)) assert.ok(key in wrapped && typeof wrapped[key] === 'function', `${key} is offered`);
  assert.deepStrictEqual(await wrapped.get(`${ROOT}/appmodules`), { status: 200, headers: {}, body: { value: [] } });
  assert.strictEqual(typeof wrapped.postRaw, 'function', 'a client that does batches still does: the SDK asks for postRaw');
  assert.deepStrictEqual(await wrapped.post(`${ROOT}/appmodules`, { name: 'x' }), { status: 201, headers: { 'odata-entityid': 'x' }, body: { id: 1 } });
  // A transport with no post, or none at all, is handed back as it is.
  const readOnly = { get: async () => ({ status: 200, body: {} }) };
  assert.strictEqual(scope.wrap(readOnly), readOnly);
  assert.strictEqual(scope.wrap(undefined), undefined);
});

test('a transport whose methods are on a prototype, or that is frozen, is limited all the same — and its methods still see their own state', async () => {
  const scope = makeAppComponentScope();
  const sent = [];
  class Transport {
    constructor() { this.reads = 0; }
    async get() { this.reads += 1; return { status: 200, headers: {}, body: {} }; }
    async post(url, body) { sent.push(body); return { status: 204, headers: {}, body: undefined }; }
  }
  const owner = new Transport();
  const wrapped = scope.wrap(owner);
  await wrapped.get(`${ROOT}/appmodules`);
  assert.strictEqual(owner.reads, 1, 'a read made through the wrapper is counted by the transport it wraps');
  await scope.limit(APP, { views: [VIEW] }, () => wrapped.post(ADD, derived()));
  assert.deepStrictEqual(sent, [{ AppId: APP, Components: [view(VIEW)] }]);

  const calls = [];
  const watched = Object.freeze({
    get: async () => ({ status: 200, headers: {}, body: {} }),
    post: async (url, body) => { calls.push(body); return { status: 204, headers: {}, body: undefined }; },
  });
  await scope.limit(APP, { views: [VIEW] }, () => scope.wrap(watched).post(ADD, derived()));
  assert.deepStrictEqual(calls, [{ AppId: APP, Components: [view(VIEW)] }]);
});

test('a refusal the service gives the post that is sent is the SDK\'s to see — it is not swallowed', async () => {
  const scope = makeAppComponentScope();
  const { client } = transport(() => ({ status: 400, headers: {}, body: { error: { message: 'no such view' } } }));
  const wrapped = scope.wrap(client);
  const answer = await scope.limit(APP, { views: [VIEW] }, () => wrapped.post(ADD, derived()));
  assert.strictEqual(answer.status, 400);
});

test('edits of one app run one after the other — the second is held until the first is over, and neither reads the other\'s list; edits of two apps do not wait for each other', async () => {
  const scope = makeAppComponentScope();
  const { client, calls } = transport();
  const wrapped = scope.wrap(client);
  const order = [];
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const first = scope.limit(APP, { views: [VIEW] }, async () => {
    order.push('first starts');
    await held;
    await wrapped.post(ADD, derived());
    order.push('first ends');
  });
  const second = scope.limit(APP, { views: [VIEW_2] }, async () => {
    order.push('second starts');
    await wrapped.post(ADD, derived());
    order.push('second ends');
  });
  const elsewhere = scope.limit(OTHER_APP, { views: [] }, async () => { order.push('another app'); });
  await elsewhere;
  assert.deepStrictEqual(order, ['first starts', 'another app'], 'the other app\'s edit was not held');
  release();
  await Promise.all([first, second]);
  assert.deepStrictEqual(order, ['first starts', 'another app', 'first ends', 'second starts', 'second ends']);
  assert.deepStrictEqual(calls.map((c) => c[2].Components), [[view(VIEW)], [view(VIEW_2)]]);
  // A failed edit does not hold the next one.
  await assert.rejects(scope.limit(APP, {}, async () => { throw new Error('first'); }), /first/);
  assert.strictEqual(await scope.limit(APP, {}, async () => 'second'), 'second');
});

// ── What the limit reads exactly, and what it refuses ─────────────────────────────────────────────────────────────────────────────────────────────────
// The limit works on the one request the bundle is known to send. A request that IS the action but in a shape the limit does not read is not forwarded — that would send the SDK's whole
// derived list, the very thing it holds back — and is not answered as done either: a pin it dropped would be a success nobody was told was one. It is refused, with the bundle's SdkError,
// which the SDK reports as a warning of the push (as it reports every failure of that request), and nothing reaches the app.
const refused = (promise) => assert.rejects(promise, (error) => {
  assert.ok(error instanceof SdkError, `the bundle's own SdkError, which its client passes on as it is: ${error}`);
  assert.strictEqual(error.code, 'APP_COMPONENTS_NOT_LIMITED');
  assert.match(error.message, /was NOT sent/);
  return true;
});

test('the request is found by its PATH — in the SDK\'s spelling, at any API version or host, with a query string or without, whether the address is text or a URL', async () => {
  for (const address of [ADD, `${ADD}?x=1`, ADD.replace('v9.0', 'v9.2'), '/AddAppComponents', new URL(ADD), new URL(`${ADD}?x=1#top`), 'https://crm.contoso.com/org/api/data/v9.0/AddAppComponents']) {
    const scope = makeAppComponentScope();
    const { client, calls } = transport();
    await scope.limit(APP, { views: [VIEW] }, () => scope.wrap(client).post(address, derived()));
    assert.deepStrictEqual(calls.map((call) => call[2]), [{ AppId: APP, Components: [view(VIEW)] }], `limited: ${address}`);
  }
  // Only a POST is the action: every other method is the transport's own, whatever it is sent.
  const scope = makeAppComponentScope();
  const { client, calls } = transport();
  const wrapped = scope.wrap(client);
  const body = derived();
  await scope.limit(APP, { views: [] }, async () => { await wrapped.patch(ADD, body); await wrapped.get(ADD); });
  assert.deepStrictEqual(calls.map((call) => call[0]), ['patch', 'get']);
  assert.strictEqual(calls[0][2], body);
});

test('another request is not taken for the action because its query or its fragment says so — it is the service\'s to answer, and is sent as it is', async () => {
  for (const address of [
    `${ROOT}/OtherAction?note=/AddAppComponents`,
    `${ROOT}/OtherAction#x=/AddAppComponents`,
    `${ROOT}/accounts?$filter=name eq '/AddAppComponents'`,
    `${ROOT}/AddAppComponentsLog`,
    `${ROOT}/AddAppComponents/extra`,
  ]) {
    const scope = makeAppComponentScope();
    const { client, calls } = transport(() => ({ status: 200, headers: {}, body: { answeredBy: 'the service' } }));
    const body = derived();
    const answer = await scope.limit(APP, { views: [] }, () => scope.wrap(client).post(address, body));
    assert.strictEqual(calls.length, 1, `sent: ${address}`);
    assert.strictEqual(calls[0][2], body, `as it was: ${address}`);
    assert.deepStrictEqual(answer.body, { answeredBy: 'the service' }, `not answered by this tool: ${address}`);
  }
});

test('the action in a spelling the limit does not read is REFUSED while an edit is open — not sent whole, not answered as done, and nothing reaches the service', async () => {
  for (const address of [
    ADD.replace('AddAppComponents', 'addappcomponents'),
    ADD.replace('AddAppComponents', '%41ddAppComponents'),
    `${ADD}/`,
    `${ADD}//`,
    ADD.replace('/AddAppComponents', '//AddAppComponents'),
    `${ROOT}/Microsoft.Dynamics.CRM.AddAppComponents`,
    `${ROOT}/ADDAPPCOMPONENTS?x=1`,
    new URL(ADD.replace('AddAppComponents', 'addappcomponents')),
  ]) {
    for (const AppId of [APP, OTHER_APP]) {
      const scope = makeAppComponentScope();
      const { client, calls } = transport();
      await refused(scope.limit(APP, { views: [VIEW] }, () => scope.wrap(client).post(address, derived(AppId))));
      assert.deepStrictEqual(calls, [], `nothing was sent: ${address} for ${AppId}`);
    }
  }
});

test('a body is read to say whose it is and what it holds — another app\'s request goes through in any shape; one that is nobody\'s to be told, or an open edit\'s with no list, is REFUSED', async () => {
  const scope = makeAppComponentScope();
  const { client, calls } = transport();
  const wrapped = scope.wrap(client);
  await scope.limit(APP, { views: [VIEW] }, async () => {
    for (const body of [{ AppId: OTHER_APP }, { AppId: OTHER_APP, Components: 'x' }, { AppId: OTHER_APP, Components: [form(FORM)] }]) await wrapped.post(ADD, body);
  });
  assert.strictEqual(calls.length, 3, 'another app\'s edit is not this one\'s');

  for (const [label, body] of [
    ['JSON text', JSON.stringify(derived())],
    ['JSON text of another app', JSON.stringify(derived(OTHER_APP))],
    ['no body', undefined],
    ['null', null],
    ['an array', [derived()]],
    ['no app', { Components: derived().Components }],
    ['an app that is not text', { AppId: 7, Components: derived().Components }],
    ['no list', { AppId: APP }],
    ['a list that is not one', { AppId: APP, Components: 'x' }],
  ]) {
    calls.length = 0;
    await refused(scope.limit(APP, { views: [VIEW] }, () => wrapped.post(ADD, body)));
    assert.deepStrictEqual(calls, [], `nothing was sent: ${label}`);
  }
});

test('a pin the request does not carry is a failure and never a no-op — the view is only a reference, or is not in the list, or only some of the views are', async () => {
  const MISSING = '66666666-6666-4666-8666-66666666666a';
  for (const [label, views, components, absent] of [
    ['a view that is an OData reference', [VIEW], [{ '@odata.id': `savedqueries(${VIEW})` }], [VIEW]],
    ['a view that is not in the list', [VIEW], [table, form(FORM), chart(CHART)], [VIEW]],
    ['an empty list', [VIEW], [], [VIEW]],
    ['one of two views', [VIEW, MISSING], [table, view(VIEW)], [MISSING]],
    ['a view whose id is under another name', [VIEW], [{ '@odata.type': 'Microsoft.Dynamics.CRM.savedquery', id: VIEW }], [VIEW]],
  ]) {
    const scope = makeAppComponentScope();
    const { client, calls } = transport();
    await assert.rejects(scope.limit(APP, { views }, () => scope.wrap(client).post(ADD, { AppId: APP, Components: components })), (error) => {
      assert.strictEqual(error.code, 'APP_COMPONENTS_NOT_LIMITED', label);
      assert.match(error.message, /was NOT sent/, label);
      for (const id of absent) assert.ok(error.message.includes(id), `${label}: names ${id}: ${error.message}`);
      for (const id of views.filter((carried) => !absent.includes(carried))) assert.ok(!error.message.includes(id), `${label}: ${id} is carried, and is not named`);
      return true;
    });
    assert.deepStrictEqual(calls, [], `nothing was sent: ${label}`);
  }
  // An empty list for an edit that owns nothing is the no-op it looks like.
  const scope = makeAppComponentScope();
  const { client, calls } = transport();
  const answer = await scope.limit(APP, { views: [] }, () => scope.wrap(client).post(ADD, { AppId: APP, Components: [] }));
  assert.strictEqual(answer.status, 204);
  assert.deepStrictEqual(calls, []);
});

test('with no edit open the same spellings and bodies are not read at all — the build, which owns the whole app, sends what the SDK derives, whatever its shape', async () => {
  const scope = makeAppComponentScope();
  const { client, calls } = transport();
  const wrapped = scope.wrap(client);
  const sent = [
    [ADD.replace('AddAppComponents', 'addappcomponents'), derived()],
    [`${ADD}/`, JSON.stringify(derived())],
    [ADD, { AppId: APP }],
    [ADD, null],
    [new URL(ADD), derived()],
  ];
  for (const [address, body] of sent) await wrapped.post(address, body);
  assert.strictEqual(calls.length, sent.length);
  calls.forEach((call, i) => assert.ok(call[1] === sent[i][0] && call[2] === sent[i][1], `sent as it was: ${i}`));
  // An edit of one app ends: what it refused is not held against the next request.
  await refused(scope.limit(APP, { views: [VIEW] }, () => wrapped.post(`${ADD}/`, derived())));
  const body = JSON.stringify(derived());
  await wrapped.post(ADD, body);
  assert.strictEqual(calls.at(-1)[2], body);
});

test('a $batch that names the action is REFUSED while an edit is open — a part of a batch cannot be limited — and every other batch, and every batch with no edit open, is sent as it is', async () => {
  const scope = makeAppComponentScope();
  const sent = [];
  const client = {
    get: async () => ({ status: 200, headers: {}, body: {} }),
    post: async () => ({ status: 204, headers: {}, body: undefined }),
    postRaw: async (url, body, options) => { sent.push([url, body, options]); return { status: 200, headers: {}, body: '' }; },
  };
  const wrapped = scope.wrap(client);
  const envelope = (inner) => ['--batch_1', 'Content-Type: multipart/mixed; boundary=changeset_1', '', '--changeset_1', 'Content-Type: application/http', '', inner, '--changeset_1--', '--batch_1--', ''].join('\r\n');
  const action = envelope(`POST ${ADD} HTTP/1.1\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(derived())}`);
  const rows = envelope(`POST ${ROOT}/uxagentprojects HTTP/1.1\r\nContent-Type: application/json\r\n\r\n{"name":"Page"}`);
  const asJson = JSON.stringify({ requests: [{ id: '1', method: 'POST', url: 'addappcomponents', body: derived() }] });
  await scope.limit(APP, { views: [VIEW] }, async () => {
    for (const body of [action, Buffer.from(action), new Uint8Array(Buffer.from(action)), asJson]) {
      await refused(wrapped.postRaw(`${ROOT}/$batch`, body, { headers: { 'Content-Type': 'multipart/mixed; boundary=batch_1' } }));
    }
    assert.deepStrictEqual(sent, [], 'nothing was sent');
    const options = { headers: {} };
    await wrapped.postRaw(`${ROOT}/$batch`, rows, options);
    await wrapped.postRaw(`${ROOT}/$batch`, undefined, options);
    assert.deepStrictEqual(sent, [[`${ROOT}/$batch`, rows, options], [`${ROOT}/$batch`, undefined, options]], 'a batch that does not name it goes through as it is');
  });
  sent.length = 0;
  await wrapped.postRaw(`${ROOT}/$batch`, action, {});
  assert.strictEqual(sent.length, 1, 'with no edit open a batch is nobody\'s to read');
  // A client with no postRaw has none after it is wrapped: the SDK asks for it, and refuses what needs it, as it did.
  assert.strictEqual(scope.wrap({ post: async () => ({}) }).postRaw, undefined);
});
