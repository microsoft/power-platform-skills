'use strict';
// lib/app-component-scope.js: the limit a page edit puts on the AddAppComponents the SDK posts after it writes an app's sitemap. The real bundle's requests are pinned in
// genpage-app-edit-real-bundle.test.js; these hold the limit itself, against a transport that only records — what it reads exactly, and that what it cannot read is refused,
// never forwarded whole and never answered as if it had been done.
const { test } = require('node:test');
const assert = require('node:assert');
const { makeAppComponentScope } = require('../lib/app-component-scope.js');
const { createAzHttpClient } = require('../lib/sdk-http-client.js');
const { SdkError } = require('../lib/maker-sdk.js');
const { effectiveContentLength } = require('./helpers/wire-framing.js');

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

test('a post that holds nothing but what the edit owns is sent whole — as the plain JSON data it was read as: equal to the body, and not the object the caller holds', async () => {
  const scope = makeAppComponentScope();
  const { client, calls } = transport();
  const wrapped = scope.wrap(client);
  const body = { AppId: APP, Components: [view(VIEW)] };
  await scope.limit(APP, { views: [VIEW] }, () => wrapped.post(ADD, body));
  assert.deepStrictEqual(calls[0][2], body);
  assert.notStrictEqual(calls[0][2], body, 'what is sent is what was decided on, and an object can answer differently when it is serialized again');
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
  assert.deepStrictEqual(calls[0][2], elsewhere);
  assert.notStrictEqual(calls[0][2], elsewhere, 'what goes on is what was read, not the object the caller holds');
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

// How an address names the action, as the tests below tell them apart — for a `post` and for a raw post alike, which are classified by the same rule.
//   the action, as the SDK or a client that adds the API root itself would address it
const ACTION_ADDRESSES = [ADD, `${ADD}?x=1`, ADD.replace('v9.0', 'v9.2'), '/AddAppComponents', new URL(ADD), new URL(`${ADD}?x=1#top`), 'https://crm.contoso.com/org/api/data/v9.0/AddAppComponents'];
//   not the action: its path is another one, whatever the query string or the fragment says
const OTHER_ADDRESSES = [
  `${ROOT}/OtherAction?note=/AddAppComponents`,
  `${ROOT}/OtherAction#x=/AddAppComponents`,
  `${ROOT}/accounts?$filter=name eq '/AddAppComponents'`,
  `${ROOT}/AddAppComponentsLog`,
  `${ROOT}/AddAppComponents/extra`,
];
//   the action in a spelling the limit does not read, which the service may well accept as the action
const LOOKALIKE_ADDRESSES = [
  ADD.replace('AddAppComponents', 'addappcomponents'),
  ADD.replace('AddAppComponents', '%41ddAppComponents'),
  `${ADD}/`,
  `${ADD}//`,
  ADD.replace('/AddAppComponents', '//AddAppComponents'),
  `${ROOT}/Microsoft.Dynamics.CRM.AddAppComponents`,
  `${ROOT}/ADDAPPCOMPONENTS?x=1`,
  new URL(ADD.replace('AddAppComponents', 'addappcomponents')),
];

test('the request is found by its PATH — in the SDK\'s spelling, at any API version or host, with a query string or without, whether the address is text or a URL', async () => {
  for (const address of ACTION_ADDRESSES) {
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
  for (const address of OTHER_ADDRESSES) {
    const scope = makeAppComponentScope();
    const { client, calls } = transport(() => ({ status: 200, headers: {}, body: { answeredBy: 'the service' } }));
    const body = derived();
    const answer = await scope.limit(APP, { views: [] }, () => scope.wrap(client).post(address, body));
    assert.strictEqual(calls.length, 1, `sent: ${address}`);
    assert.deepStrictEqual(calls[0][2], body, `as it was: ${address}`);
    assert.notStrictEqual(calls[0][2], body, `as it was read, and not the object the caller holds: ${address}`);
    assert.deepStrictEqual(answer.body, { answeredBy: 'the service' }, `not answered by this tool: ${address}`);
  }
});

test('the action in a spelling the limit does not read is REFUSED while an edit is open — not sent whole, not answered as done, and nothing reaches the service', async () => {
  for (const address of LOOKALIKE_ADDRESSES) {
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

// ── A raw POST is told by its address as a post is ───────────────────────────────────────────────────────────────────────────────────────────────────
// `postRaw` is a real POST, not only the SDK's `$batch`: the plugin's transport sends it as `call('POST', url, body, options, { rawBody: true })`, with a body that is text, or the bytes of it, that it
// does not touch. The bundle sends the action through `post` today. A request to the action's address through `postRaw` — a drift of the bundle, or another caller — is limited exactly as the object
// form is when its body is JSON text of the same { AppId, Components } (or the bytes of it), and is refused as the object form is when it is not. It is never forwarded whole.

// A transport whose `postRaw` records what reaches it, as `transport` does for `post`.
function rawTransport(answer = () => ({ status: 204, headers: {}, body: '' })) {
  const calls = [];
  const client = {
    get: async () => ({ status: 200, headers: {}, body: {} }),
    post: async () => ({ status: 204, headers: {}, body: undefined }),
    postRaw: async (url, body, options) => { calls.push([url, body, options]); return answer(url, body); },
  };
  return { client, calls };
}
// A request as each form of body a raw POST may have is made — [label, encode(request), decode(what was forwarded) -> the request it carries]. An object is no raw body by the SDK's contract, but the
// plugin's transport serializes it as it does for `post`, so it is the same request. What goes on is always a form the transport sends AS IT IS — the JSON text, or the plain object an object was: the transport
// sends text as it is and JSON-serializes every body that is not text, so a Buffer or a Uint8Array would reach the service as `{"type":"Buffer","data":[…]}`, which is not the action's parameters. Bytes go on as the text of them.
const RAW_FORMS = [
  ['JSON text', (request) => JSON.stringify(request), (sent) => { assert.strictEqual(typeof sent, 'string'); return JSON.parse(sent); }],
  ['a Buffer', (request) => Buffer.from(JSON.stringify(request)), (sent) => { assert.strictEqual(typeof sent, 'string', 'bytes go on as the text of them'); return JSON.parse(sent); }],
  ['a Uint8Array', (request) => new Uint8Array(Buffer.from(JSON.stringify(request))), (sent) => { assert.strictEqual(typeof sent, 'string', 'bytes go on as the text of them'); return JSON.parse(sent); }],
  ['an object', (request) => request, (sent) => sent],
];

test('a raw POST to the action\'s address is limited as a post is — to the views the edit owns, as JSON text (or the plain object an object body was), to the address and with the options it had', async () => {
  const options = { headers: { 'Content-Type': 'application/json' } };
  for (const address of ACTION_ADDRESSES) {
    for (const [label, encode, decode] of RAW_FORMS) {
      const scope = makeAppComponentScope();
      const { client, calls } = rawTransport();
      const answer = await scope.limit(APP, { views: [VIEW] }, () => scope.wrap(client).postRaw(address, encode(derived()), options));
      assert.strictEqual(answer.status, 204, `${label}: ${address}`);
      assert.strictEqual(calls.length, 1, `${label}: ${address}`);
      assert.strictEqual(calls[0][0], String(address), `${label}: addressed as it was — as the text of the address, which is read once`);
      assert.deepStrictEqual(decode(calls[0][1]), { AppId: APP, Components: [view(VIEW)] }, `${label}: the table, the form, the other view and the chart are not sent: ${address}`);
      assert.strictEqual(calls[0][2], options, `${label}: the options are the caller's`);
    }
  }
});

test('a raw POST that holds nothing but what the edit owns is sent whole — the same text, the text of the same bytes, a plain copy of the same object', async () => {
  const only = { AppId: APP, Components: [view(VIEW)] };
  for (const [label, encode, decode] of RAW_FORMS) {
    const body = encode(only);
    const scope = makeAppComponentScope();
    const { client, calls } = rawTransport();
    await scope.limit(APP, { views: [VIEW] }, () => scope.wrap(client).postRaw(ADD, body));
    assert.deepStrictEqual(decode(calls[0][1]), only, label);
    if (typeof body === 'string') assert.strictEqual(calls[0][1], body, `${label}: the very text`);
    if (typeof body === 'object' && !(body instanceof Uint8Array)) assert.notStrictEqual(calls[0][1], body, `${label}: what is sent is what was read, not the object that can answer differently`);
  }
});

test('a raw POST that is cut is shorter — a Content-Length the caller wrote for the whole of it is written again, the other options are the caller\'s and not changed — and one that is not cut keeps its options', async () => {
  for (const [label, encode] of RAW_FORMS.slice(0, 3)) {
    const options = { headers: { 'content-length': String(Buffer.byteLength(encode(derived()))), 'Content-Type': 'application/json', 'If-Match': '1' } };
    const before = JSON.stringify(options);
    const scope = makeAppComponentScope();
    const { client, calls } = rawTransport();
    await scope.limit(APP, { views: [VIEW] }, () => scope.wrap(client).postRaw(ADD, encode(derived()), options));
    const [, sent, forwarded] = calls[0];
    assert.strictEqual(forwarded.headers['content-length'], String(Buffer.byteLength(sent)), `${label}: the length of what is sent`);
    assert.notStrictEqual(forwarded.headers['content-length'], options.headers['content-length'], `${label}: not the whole body's`);
    assert.deepStrictEqual({ ...forwarded.headers, 'content-length': '' }, { ...options.headers, 'content-length': '' }, `${label}: the other headers are as they were`);
    assert.strictEqual(JSON.stringify(options), before, `${label}: the caller's options are not changed`);
  }
  const only = JSON.stringify({ AppId: APP, Components: [view(VIEW)] });
  const same = { headers: { 'Content-Length': String(Buffer.byteLength(only)) } };
  const scope = makeAppComponentScope();
  const { client, calls } = rawTransport();
  await scope.limit(APP, { views: [VIEW] }, () => scope.wrap(client).postRaw(ADD, only, same));
  assert.strictEqual(calls[0][2], same, 'nothing was cut: the options are the caller\'s own');
});

test('an edit that owns no view posts nothing through postRaw either — the SDK is answered with the service\'s 204, whose raw body is empty, and no request is made', async () => {
  for (const [label, encode] of RAW_FORMS) {
    const scope = makeAppComponentScope();
    const { client, calls } = rawTransport();
    const answer = await scope.limit(APP, { views: [] }, () => scope.wrap(client).postRaw(ADD, encode(derived())));
    assert.deepStrictEqual(answer, { status: 204, headers: {}, body: '' }, label);
    assert.deepStrictEqual(calls, [], label);
  }
});

test('another app\'s raw request to the action goes through as it was read, in any shape — the same text, a copy of the same bytes, a plain copy of the object — an edit of one app does not limit another\'s', async () => {
  const scope = makeAppComponentScope();
  const { client, calls } = rawTransport();
  const wrapped = scope.wrap(client);
  const sent = [JSON.stringify(derived(OTHER_APP)), Buffer.from(JSON.stringify({ AppId: OTHER_APP })), JSON.stringify({ AppId: OTHER_APP, Components: 'x' }), derived(OTHER_APP)];
  await scope.limit(APP, { views: [VIEW] }, async () => { for (const body of sent) await wrapped.postRaw(ADD, body); });
  assert.strictEqual(calls.length, sent.length);
  calls.forEach((call, i) => {
    assert.deepStrictEqual(call[1], sent[i], `as it was read: ${i}`);
    if (typeof sent[i] === 'string') assert.strictEqual(call[1], sent[i], `the very text: ${i}`);
    else assert.notStrictEqual(call[1], sent[i], `a copy, not what the caller holds: ${i}`);
  });
});

test('a raw body the limit cannot read is REFUSED as a post\'s is — not JSON, not an object, nobody\'s app, no list — and nothing is sent', async () => {
  for (const [label, body] of [
    ['text that is not JSON', 'AppId=22222222&Components=x'],
    ['JSON text cut short', JSON.stringify(derived()).slice(0, -3)],
    ['an empty text', ''],
    ['no body', undefined],
    ['null', null],
    ['JSON text of null', 'null'],
    ['JSON text of an array', JSON.stringify([derived()])],
    ['JSON text of a number', '7'],
    ['JSON text with no app', JSON.stringify({ Components: derived().Components })],
    ['JSON text with an app that is not text', JSON.stringify({ AppId: 7, Components: derived().Components })],
    ['JSON text with no list', JSON.stringify({ AppId: APP })],
    ['JSON text with a list that is not one', JSON.stringify({ AppId: APP, Components: 'x' })],
    ['bytes that are not JSON', Buffer.from([0xff, 0xfe, 0x00, 0x7b])],
    ['the bytes of JSON text in UTF-16', Buffer.from(JSON.stringify(derived()), 'utf16le')],
    ['text with a byte order mark', `\ufeff${JSON.stringify(derived())}`],
    ['bytes with a byte order mark', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(derived()))])],
    // Read leniently these bytes are JSON that carries the pin (the é becomes U+FFFD); what is sent is what was read, so bytes that are not UTF-8 are not read at all.
    ['bytes of JSON that are not valid UTF-8', Buffer.concat([Buffer.from(`{"AppId":"${APP}","Components":[{"savedqueryid":"${VIEW}","name":"`), Buffer.from([0xe9]), Buffer.from('"}]}')])],
    ['a body of a kind no transport sends', new ArrayBuffer(8)],
    ['a number', 7],
  ]) {
    const scope = makeAppComponentScope();
    const { client, calls } = rawTransport();
    await refused(scope.limit(APP, { views: [VIEW] }, () => scope.wrap(client).postRaw(ADD, body)));
    assert.deepStrictEqual(calls, [], `nothing was sent: ${label}`);
  }
});

test('a raw POST to the action in a spelling the limit does not read is REFUSED too — whatever its body is, even one it could read — and nothing is sent', async () => {
  const bodies = [JSON.stringify(derived()), JSON.stringify(derived(OTHER_APP)), Buffer.from(JSON.stringify(derived())), derived(), 'not JSON', undefined];
  for (const address of LOOKALIKE_ADDRESSES) {
    for (const body of bodies) {
      const scope = makeAppComponentScope();
      const { client, calls } = rawTransport();
      await refused(scope.limit(APP, { views: [VIEW] }, () => scope.wrap(client).postRaw(address, body)));
      assert.deepStrictEqual(calls, [], `nothing was sent: ${address}`);
    }
  }
});

test('a pin a raw request does not carry is a failure and never a no-op — the view is only a reference, or is not in the list, or only some of the views are', async () => {
  const MISSING = '66666666-6666-4666-8666-66666666666a';
  for (const [label, views, components, absent] of [
    ['a view that is an OData reference', [VIEW], [{ '@odata.id': `savedqueries(${VIEW})` }], [VIEW]],
    ['a view that is not in the list', [VIEW], [table, form(FORM), chart(CHART)], [VIEW]],
    ['one of two views', [VIEW, MISSING], [table, view(VIEW)], [MISSING]],
  ]) {
    for (const [shape, encode] of RAW_FORMS) {
      const scope = makeAppComponentScope();
      const { client, calls } = rawTransport();
      await assert.rejects(scope.limit(APP, { views }, () => scope.wrap(client).postRaw(ADD, encode({ AppId: APP, Components: components }))), (error) => {
        assert.strictEqual(error.code, 'APP_COMPONENTS_NOT_LIMITED', `${label}, ${shape}`);
        assert.match(error.message, /was NOT sent/, `${label}, ${shape}`);
        for (const id of absent) assert.ok(error.message.includes(id), `${label}, ${shape}: names ${id}: ${error.message}`);
        return true;
      });
      assert.deepStrictEqual(calls, [], `nothing was sent: ${label}, ${shape}`);
    }
  }
});

test('a raw POST to another address is not taken for the action because its query or its fragment says so — it is sent as it is, whatever its body, unless the body is a batch that names the action', async () => {
  for (const address of OTHER_ADDRESSES) {
    const scope = makeAppComponentScope();
    const { client, calls } = rawTransport(() => ({ status: 200, headers: {}, body: 'answered by the service' }));
    const body = 'a body nobody reads';
    const answer = await scope.limit(APP, { views: [] }, () => scope.wrap(client).postRaw(address, body));
    assert.strictEqual(calls.length, 1, `sent: ${address}`);
    assert.strictEqual(calls[0][1], body, `as it was: ${address}`);
    assert.strictEqual(answer.body, 'answered by the service', `not answered by this tool: ${address}`);
    await refused(scope.limit(APP, { views: [] }, () => scope.wrap(client).postRaw(address, `POST ${ADD} HTTP/1.1`)));
    assert.strictEqual(calls.length, 1, `a batch that names the action is not sent: ${address}`);
  }
});

test('with no edit open a raw request is not read at all — whatever its address or body, it is sent as it is', async () => {
  const scope = makeAppComponentScope();
  const { client, calls } = rawTransport();
  const wrapped = scope.wrap(client);
  const sent = [[LOOKALIKE_ADDRESSES[0], JSON.stringify(derived())], [ADD, 'not JSON'], [ADD, JSON.stringify(derived())], [ADD, undefined], [new URL(ADD), Buffer.from('x')], [`${ROOT}/$batch`, `POST ${ADD} HTTP/1.1`]];
  for (const [address, body] of sent) await wrapped.postRaw(address, body);
  assert.strictEqual(calls.length, sent.length);
  calls.forEach((call, i) => assert.ok(call[0] === sent[i][0] && call[1] === sent[i][1], `sent as it was: ${i}`));
});

// Over the plugin's own transport (lib/sdk-http-client.js), with only the token and the network replaced: what reaches `request` is what would go on the wire.
function overTheWire() {
  const wire = [];
  const scope = makeAppComponentScope();
  const client = scope.wrap(createAzHttpClient('https://contoso.crm.dynamics.com', {
    getToken: () => 'token-for-the-test',
    request: async ({ url, method, headers, body }) => {
      wire.push({ url: String(url), method, headers: Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'authorization')), body });
      return { statusCode: 204, headers: {}, body: '' };
    },
    sleep: async () => {},
  }));
  return { scope, client, wire };
}

test('over the plugin\'s own transport, a raw POST of the action as JSON text puts on the wire only the views the edit owns — and nothing at all for an edit that owns none', async () => {
  const options = { headers: { 'Content-Type': 'application/json' } };
  const body = JSON.stringify(derived());
  const owner = overTheWire();
  const answer = await owner.scope.limit(APP, { views: [VIEW] }, () => owner.client.postRaw(ADD, body, options));
  assert.strictEqual(answer.status, 204);
  assert.strictEqual(owner.wire.length, 1, 'one request');
  assert.deepStrictEqual({ method: owner.wire[0].method, url: owner.wire[0].url }, { method: 'POST', url: ADD });
  assert.deepStrictEqual(JSON.parse(owner.wire[0].body), { AppId: APP, Components: [view(VIEW)] });
  for (const id of [FORM, VIEW_2, CHART]) assert.ok(!owner.wire[0].body.includes(id), `${id} is not on the wire`);

  const none = overTheWire();
  assert.strictEqual((await none.scope.limit(APP, { views: [] }, () => none.client.postRaw(ADD, body, options))).status, 204);
  assert.deepStrictEqual(none.wire, [], 'an edit that owns no view sends nothing');

  // With no edit open the build's own request goes on the wire whole.
  const build = overTheWire();
  await build.client.postRaw(ADD, body, options);
  assert.strictEqual(build.wire.length, 1);
  assert.deepStrictEqual(JSON.parse(build.wire[0].body), derived());
});

test('over the plugin\'s own transport what cannot be limited stays off the wire — the action as JSON text through post, a $batch that names it, a raw action whose body is not JSON', async () => {
  const { scope, client, wire } = overTheWire();
  const batch = `--batch_1\r\nContent-Type: application/http\r\n\r\nPOST ${ADD} HTTP/1.1\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(derived())}\r\n--batch_1--\r\n`;
  await refused(scope.limit(APP, { views: [VIEW] }, () => client.post(ADD, JSON.stringify(derived()))));
  await refused(scope.limit(APP, { views: [VIEW] }, () => client.postRaw(`${ROOT}/$batch`, batch, { headers: { 'Content-Type': 'multipart/mixed;boundary=batch_1' } })));
  await refused(scope.limit(APP, { views: [VIEW] }, () => client.postRaw(ADD, 'not JSON', { headers: { 'Content-Type': 'application/json' } })));
  assert.deepStrictEqual(wire, []);
});

// ── What is decided on is what the transport sends ───────────────────────────────────────────────────────────────────────────────────────────────────
// A request is put into its CANONICAL form before anything is read from it, and what goes on is that form — never the object, text or bytes the caller handed over. lib/sdk-http-client.js sends text as it is and
// JSON-serializes every other body, and JSON.stringify runs a `toJSON` (own, inherited, on a component or on the list) and every getter, so the object a limit inspected need not be the one the transport serializes;
// a Buffer is sent as `{"type":"Buffer","data":[…]}`. A request that cannot be put into the form the transport will send is refused, never forwarded and never answered as done.

// A transport that records both methods: which one was used, and what it was given.
function bothTransport() {
  const calls = [];
  const client = {
    get: async () => ({ status: 200, headers: {}, body: {} }),
    post: async (url, body, options) => { calls.push({ method: 'post', url, body, options }); return { status: 204, headers: {}, body: undefined }; },
    postRaw: async (url, body, options) => { calls.push({ method: 'postRaw', url, body, options }); return { status: 204, headers: {}, body: '' }; },
  };
  return { client, calls };
}
const METHODS = ['post', 'postRaw'];

// What reaches the transport is plain data — a plain object or list of plain data, with no accessor and no function — so nothing in it can answer differently when the transport serializes it.
function assertPlain(value, label) {
  if (value === null || typeof value !== 'object') return;
  const prototype = Object.getPrototypeOf(value);
  assert.ok(prototype === Object.prototype || prototype === Array.prototype, `${label}: a plain object or list`);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    assert.ok('value' in descriptor, `${label}: ${String(key)} is data, not an accessor`);
    assert.notStrictEqual(typeof descriptor.value, 'function', `${label}: ${String(key)} is not a function`);
    assertPlain(descriptor.value, `${label}.${String(key)}`);
  }
}

// Objects that serialize themselves as the WHOLE request, though the object a limit can see holds the one view the edit pins (or a getter that does not show the list until it is read).
const HOOKS = [
  ['an own toJSON that answers the whole request', () => ({ AppId: APP, Components: [view(VIEW)], toJSON() { return derived(); } })],
  ['an inherited toJSON that answers the whole request', () => Object.assign(Object.create({ toJSON() { return derived(); } }), { AppId: APP, Components: [view(VIEW)] })],
  ['a toJSON on the list that answers the whole list', () => ({ AppId: APP, Components: Object.assign([view(VIEW)], { toJSON() { return derived().Components; } }) })],
  ['a getter that answers the whole list', () => ({ AppId: APP, get Components() { return derived().Components; } })],
];

test('an object body that serializes itself — an own toJSON, an inherited one, one on the list, a getter — cannot undo the limit: it is put into the plain JSON data the transport would make of it BEFORE it is read, and that data is what is sent', async () => {
  for (const method of METHODS) {
    for (const [label, make] of HOOKS) {
      const scope = makeAppComponentScope();
      const { client, calls } = bothTransport();
      await scope.limit(APP, { views: [VIEW] }, () => scope.wrap(client)[method](ADD, make()));
      assert.strictEqual(calls.length, 1, `${method}, ${label}`);
      assert.deepStrictEqual(calls[0].body, { AppId: APP, Components: [view(VIEW)] }, `${method}, ${label}: only the view the edit owns`);
      assertPlain(calls[0].body, `${method}, ${label}`);
    }
  }
});

test('a hook on a component is read as the component it makes — a view that serializes itself as the form is not the view the edit pins, and a form that serializes itself as the view is', async () => {
  for (const method of METHODS) {
    let scope = makeAppComponentScope();
    let { client, calls } = bothTransport();
    const asForm = { AppId: APP, Components: [{ ...view(VIEW), toJSON() { return form(FORM); } }] };
    await refused(scope.limit(APP, { views: [VIEW] }, () => scope.wrap(client)[method](ADD, asForm)));
    assert.deepStrictEqual(calls, [], `${method}: the pin is not in what would be sent, so nothing is`);

    scope = makeAppComponentScope();
    ({ client, calls } = bothTransport());
    const asView = { AppId: APP, Components: [{ ...form(FORM), toJSON() { return view(VIEW); } }, form(FORM)] };
    await scope.limit(APP, { views: [VIEW] }, () => scope.wrap(client)[method](ADD, asView));
    assert.deepStrictEqual(calls.map((call) => call.body), [{ AppId: APP, Components: [view(VIEW)] }], `${method}: the entry that is the view once serialized, and nothing of the form`);
  }
});

test('a body that cannot be put into plain JSON data is REFUSED — a cycle, a BigInt, a hook that throws or answers nothing, text or a list — and nothing is sent', async () => {
  const cycle = { AppId: APP, Components: [view(VIEW)] };
  cycle.self = cycle;
  for (const [label, body] of [
    ['a cycle', cycle],
    ['a BigInt', { AppId: APP, Components: [view(VIEW)], size: 1n }],
    ['a toJSON that throws', { AppId: APP, Components: [view(VIEW)], toJSON() { throw new Error('no'); } }],
    ['a toJSON that answers nothing', { AppId: APP, Components: [view(VIEW)], toJSON() { return undefined; } }],
    ['a toJSON that answers the request as text', { AppId: APP, Components: [view(VIEW)], toJSON() { return JSON.stringify(derived()); } }],
    ['a toJSON that answers a list', { AppId: APP, Components: [view(VIEW)], toJSON() { return derived().Components; } }],
  ]) {
    for (const method of METHODS) {
      const scope = makeAppComponentScope();
      const { client, calls } = bothTransport();
      await refused(scope.limit(APP, { views: [VIEW] }, () => scope.wrap(client)[method](ADD, body)));
      assert.deepStrictEqual(calls, [], `nothing was sent: ${method}, ${label}`);
    }
  }
});

test('an object is read ONCE — a hook that answers differently the second time cannot show the limit one request and the transport another', async () => {
  for (const method of METHODS) {
    let reads = 0;
    const body = { AppId: APP, Components: [view(VIEW)], toJSON() { reads += 1; return reads === 1 ? derived() : { AppId: APP, Components: [view(VIEW)] }; } };
    const scope = makeAppComponentScope();
    const { client, calls } = bothTransport();
    await scope.limit(APP, { views: [VIEW] }, () => scope.wrap(client)[method](ADD, body));
    assert.strictEqual(reads, 1, `${method}: serialized once, by the limit`);
    assert.strictEqual(JSON.stringify(calls[0].body), JSON.stringify({ AppId: APP, Components: [view(VIEW)] }), `${method}: what the transport serializes is what was decided on`);
    assert.strictEqual(reads, 1, `${method}: and nothing in it is called when the transport serializes it`);
  }
});

test('a hook that changes the app is read as the app it makes — the request it serializes to is the one limited, or the one left alone', async () => {
  for (const method of METHODS) {
    let scope = makeAppComponentScope();
    let { client, calls } = bothTransport();
    await scope.limit(APP, { views: [VIEW] }, () => scope.wrap(client)[method](ADD, { AppId: OTHER_APP, toJSON() { return derived(APP); } }));
    assert.deepStrictEqual(calls.map((call) => call.body), [{ AppId: APP, Components: [view(VIEW)] }], `${method}: it serializes to this edit's app, so it is cut`);

    scope = makeAppComponentScope();
    ({ client, calls } = bothTransport());
    const elsewhere = { AppId: APP, Components: derived().Components, toJSON() { return derived(OTHER_APP); } };
    await scope.limit(APP, { views: [VIEW] }, () => scope.wrap(client)[method](ADD, elsewhere));
    assert.strictEqual(calls.length, 1, method);
    assert.deepStrictEqual(calls[0].body, derived(OTHER_APP), `${method}: it serializes to another app's request, which is not this edit's, so it goes on as it was read — the plain data it serialized to, without its serializer`);
    assertPlain(calls[0].body, method);
  }
});

test('over the plugin\'s own transport, an object that serializes itself puts only the views the edit owns on the wire', async () => {
  for (const method of METHODS) {
    for (const [label, make] of HOOKS) {
      const { scope, client, wire } = overTheWire();
      await scope.limit(APP, { views: [VIEW] }, () => client[method](ADD, make()));
      assert.strictEqual(wire.length, 1, `${method}, ${label}`);
      assert.deepStrictEqual(JSON.parse(wire[0].body), { AppId: APP, Components: [view(VIEW)] }, `${method}, ${label}`);
    }
  }
});

// ── The Content-Length that goes on is the length of the body that goes on ──────────────────────────────────────────────────────────────────────────
// The transport writes the headers the caller gave it and does not count the body (a body written with `write` and `end` is sent chunked unless a Content-Length is declared), so a Content-Length the caller declared
// for the whole request survives, and is wrong for the cut one: the receiver waits for bytes that never come, or reads the rest as the next request. Node's client keeps ONE header per name, whatever the case, and
// the later one wins (helpers/wire-framing.js), so a spelling that is not rewritten can restore the old length. The limit therefore writes the final body and, when the caller declared a length, ONE header with
// the exact length of that body.

const lengthHeaders = (headers) => Object.keys(headers || {}).filter((name) => name.toLowerCase() === 'content-length');
const byteLengthOf = (input) => Buffer.byteLength(typeof input === 'string' ? input : input instanceof Uint8Array ? Buffer.from(input.buffer, input.byteOffset, input.byteLength) : JSON.stringify(input));

// The multibyte name makes the length of the text differ from its length in bytes.
const named = (id) => ({ ...view(id), name: 'Täg 🦊 閲覧' });
const wholeRequest = () => ({ AppId: APP, Components: [table, form(FORM), named(VIEW), view(VIEW_2), chart(CHART)] });
const viewOnly = () => ({ AppId: APP, Components: [named(VIEW)] });
// Bytes that are a view of a larger buffer, as a slice of a pool or of a read is.
const viewOf = (text) => {
  const before = Buffer.from('NOT THE BODY ');
  const after = Buffer.from(' NOR THIS');
  const joined = Buffer.concat([before, Buffer.from(text), after]);
  return joined.subarray(before.length, joined.length - after.length);
};
const BODY_FORMS = [
  ['JSON text', (request) => JSON.stringify(request)],
  ['JSON text with white space', (request) => JSON.stringify(request, null, 2)],
  ['a Buffer', (request) => Buffer.from(JSON.stringify(request))],
  ['a Uint8Array', (request) => new Uint8Array(Buffer.from(JSON.stringify(request)))],
  ['a Buffer that is a view of a larger one', (request) => viewOf(JSON.stringify(request))],
  ['a Uint8Array that is a view of a larger buffer', (request) => { const bytes = viewOf(JSON.stringify(request)); return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength); }],
  ['an object', (request) => request],
];
// [label, the headers for a request whose whole length is `n`, whether a Content-Length is declared]
const LENGTH_HEADERS = [
  ['no Content-Length', () => ({ 'Content-Type': 'application/json' }), false],
  ['a Content-Length for the whole request', (n) => ({ 'Content-Type': 'application/json', 'Content-Length': n }), true],
  ['a content-length in lower case', (n) => ({ 'content-length': n }), true],
  ['both spellings, the same value', (n) => ({ 'Content-Length': n, 'content-length': n }), true],
  ['both spellings, one of them stale', (n) => ({ 'Content-Length': '1', 'content-length': n }), true],
  ['a number', (n) => ({ 'Content-Length': Number(n) }), true],
];

function assertFramed(sent, label) {
  assert.deepStrictEqual(JSON.parse(sent.body), viewOnly(), `${label}: the wire carries the one view the edit pins, as the action's JSON`);
  for (const id of [FORM, VIEW_2, CHART]) assert.ok(!sent.body.includes(id), `${label}: ${id} is not on the wire`);
  assert.ok(lengthHeaders(sent.headers).length <= 1, `${label}: one Content-Length, not one per spelling: ${JSON.stringify(sent.headers)}`);
}

test('over the plugin\'s own transport the wire carries the one JSON the limit decided on, whatever form the raw request came in — and a Content-Length the caller declared is that body\'s exact length, as a single header', async () => {
  for (const [formLabel, encode] of BODY_FORMS) {
    for (const [headerLabel, headersOf, declares] of LENGTH_HEADERS) {
      const label = `${formLabel}, ${headerLabel}`;
      const input = encode(wholeRequest());
      const options = Object.freeze({ headers: Object.freeze(headersOf(String(byteLengthOf(input)))), marker: 'the caller\'s' });
      const { scope, client, wire } = overTheWire();
      await scope.limit(APP, { views: [VIEW] }, () => client.postRaw(ADD, input, options));
      assert.strictEqual(wire.length, 1, label);
      assertFramed(wire[0], label);
      assert.strictEqual(effectiveContentLength(wire[0].headers), declares ? String(Buffer.byteLength(wire[0].body)) : undefined, `${label}: the length Node's client declares is the length of the bytes it writes`);
      assert.strictEqual(wire[0].headers['Content-Type'], options.headers['Content-Type'] || 'application/json; charset=utf-8', `${label}: the caller's Content-Type`);
    }
  }
});

test('over the plugin\'s own transport a Content-Length declared for a post is the exact length of the object the limit sent — in whatever case it was written', async () => {
  for (const [headerLabel, headersOf, declares] of LENGTH_HEADERS) {
    const request = wholeRequest();
    const options = Object.freeze({ headers: Object.freeze(headersOf(String(byteLengthOf(request)))) });
    const { scope, client, wire } = overTheWire();
    await scope.limit(APP, { views: [VIEW] }, () => client.post(ADD, request, options));
    assert.strictEqual(wire.length, 1, headerLabel);
    assertFramed(wire[0], headerLabel);
    assert.strictEqual(effectiveContentLength(wire[0].headers), declares ? String(Buffer.byteLength(wire[0].body)) : undefined, headerLabel);
  }
});

test('the options are the caller\'s own when no header has to change — no Content-Length was declared, or the one declared is already the exact length of what is sent', async () => {
  const only = { AppId: APP, Components: [view(VIEW)] };
  const exact = String(Buffer.byteLength(JSON.stringify(only)));
  for (const [label, encode] of RAW_FORMS) {
    for (const options of [undefined, { headers: { 'Content-Type': 'application/json' } }, { headers: { 'Content-Length': exact } }, { headers: { 'content-length': Number(exact) } }]) {
      const scope = makeAppComponentScope();
      const { client, calls } = rawTransport();
      await scope.limit(APP, { views: [VIEW] }, () => scope.wrap(client).postRaw(ADD, encode(only), options));
      assert.strictEqual(calls[0][2], options, `${label}: ${JSON.stringify(options)}`);
    }
  }
});

// ── An address is decoded before it is read ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// The whole path is percent-decoded first — every segment, so an escaped separator is a separator — and only then are its trailing slashes dropped and its last segment compared with the action's name. A path that
// cannot be decoded cannot be told from the action's, so it is refused as the lookalikes are. https://www.rfc-editor.org/rfc/rfc3986#section-2.3 (an escaped unreserved character is the character).

//   the action with a letter, a dot or the trailing separator written as percent-escapes, which a server that decodes the path reads as the action
const ENCODED_LOOKALIKE_ADDRESSES = [
  `${ADD}%2F`,
  `${ADD}%2f%2f`,
  ADD.replace('AddAppComponents', '%41ddAppComponents%2F'),
  `${ROOT}/Microsoft.Dynamics.CRM.AddAppComponents%2F`,
  `${ROOT}/Microsoft%2EDynamics%2ECRM%2EAddAppComponents`,
  `${ROOT}/x%2FAddAppComponents`,
  `${ROOT}/%41%64%64%41%70%70%43%6F%6D%70%6F%6E%65%6E%74%73`,
  `${ROOT}%2FAddAppComponents`,
  '/api%2Fdata%2Fv9.0%2FAddAppComponents',
  new URL(`${ADD}%2F`),
];
//   an address, or a path, that cannot be read: a malformed escape, bytes that are not UTF-8 (an overlong `/`), something that is no URL
const UNREADABLE_ADDRESSES = [`${ROOT}/%ZZ`, `${ROOT}/accounts%`, `${ROOT}/%C0%AF`, `${ROOT}/%FF`, `${ROOT}/x%E0%A4%A`, 'https://', 'http://exa mple.com/x'];
//   escapes that decode to something else: no concern of the limit
const ESCAPED_OTHER_ADDRESSES = [`${ROOT}/accounts(%27a%20b%27)`, `${ROOT}/OtherAction%2F`, `${ROOT}/%41ccounts`, `${ROOT}/EntityDefinitions(LogicalName=%27account%27)/Attributes`, `${ROOT}/AddAppComponentsLog%2F`, `${ROOT}/AddAppComponents%2Fextra`, `${ROOT}/%E2%82%AC`];

test('the action written with percent-escapes is REFUSED while an edit is open — whatever else the address is, for a post and a raw POST alike, with any body — and nothing is sent', async () => {
  const bodies = [derived(), JSON.stringify(derived()), Buffer.from(JSON.stringify(derived())), derived(OTHER_APP), 'not JSON', undefined];
  for (const address of ENCODED_LOOKALIKE_ADDRESSES) {
    for (const method of METHODS) {
      for (const body of bodies) {
        const scope = makeAppComponentScope();
        const { client, calls } = bothTransport();
        await refused(scope.limit(APP, { views: [VIEW] }, () => scope.wrap(client)[method](address, body)));
        assert.deepStrictEqual(calls, [], `nothing was sent: ${method} ${address}`);
      }
    }
  }
});

test('an address that cannot be read is REFUSED while an edit is open — whatever its body — and is the transport\'s own when none is, or when the request is not a POST', async () => {
  const bodies = [derived(), JSON.stringify(derived()), 'a body nobody reads', undefined];
  for (const address of UNREADABLE_ADDRESSES) {
    for (const method of METHODS) {
      for (const body of bodies) {
        const scope = makeAppComponentScope();
        const { client, calls } = bothTransport();
        await refused(scope.limit(APP, { views: [VIEW] }, () => scope.wrap(client)[method](address, body)));
        assert.deepStrictEqual(calls, [], `nothing was sent: ${method} ${address}`);
      }
    }
    // With no edit open nothing is read, and an edit's limit is for a POST: every other method is the transport's own.
    const scope = makeAppComponentScope();
    const { client, calls } = bothTransport();
    const wrapped = scope.wrap(client);
    await wrapped.post(address, derived());
    await wrapped.postRaw(address, 'not read');
    await scope.limit(APP, { views: [VIEW] }, async () => { await wrapped.get(address); });
    assert.deepStrictEqual(calls.map((call) => call.method), ['post', 'postRaw'], `no edit open: ${address}`);
  }
});

test('an address whose escapes decode to something else is no concern of the limit — it is sent as it is and answered by the service', async () => {
  for (const address of ESCAPED_OTHER_ADDRESSES) {
    for (const method of METHODS) {
      const scope = makeAppComponentScope();
      const { client, calls } = bothTransport();
      const body = method === 'post' ? derived() : 'a body nobody reads';
      await scope.limit(APP, { views: [VIEW] }, () => scope.wrap(client)[method](address, body));
      assert.strictEqual(calls.length, 1, `sent: ${method} ${address}`);
      assert.deepStrictEqual(calls[0].body, body, `as it was: ${method} ${address}`);
    }
  }
});

test('over the plugin\'s own transport the action written with percent-escapes, and an address that cannot be read, stay off the wire', async () => {
  for (const address of [...ENCODED_LOOKALIKE_ADDRESSES, ...UNREADABLE_ADDRESSES]) {
    for (const [label, send] of [['post', (client) => client.post(address, wholeRequest())], ['raw text', (client) => client.postRaw(address, JSON.stringify(wholeRequest()))]]) {
      const { scope, client, wire } = overTheWire();
      await refused(scope.limit(APP, { views: [VIEW] }, () => send(client)));
      assert.deepStrictEqual(wire, [], `${label}: ${address}`);
    }
  }
});

// ── A $batch is read as its addresses are ────────────────────────────────────────────────────────────────────────────────────────────────────────────
// A multipart `$batch` names each request on a request line — `POST <address> HTTP/1.1` — and a part cannot be limited, so a batch that may carry the action is refused while an edit is open. Its lines are decoded
// as an address is (`kindOf`), so the name cannot hide in an escape; a JSON batch is read after its JSON is (an escaped letter, an object, a serializer); one whose lines or text cannot be read is refused.
const batchOf = (line, body = JSON.stringify({ AppId: APP, Components: [form(FORM)] })) => ['--batch_1', 'Content-Type: multipart/mixed;boundary=changeset_1', '', '--changeset_1', 'Content-Type: application/http', 'Content-Transfer-Encoding: binary', '', line, 'Content-Type: application/json', '', body, '--changeset_1--', '--batch_1--', ''].join('\r\n');
const BATCH_FORMS = [['text', (text) => text], ['a Buffer', (text) => Buffer.from(text)], ['a Uint8Array', (text) => new Uint8Array(Buffer.from(text))], ['text with bare line feeds', (text) => text.replace(/\r\n/g, '\n')]];
const MULTIPART = { headers: { 'Content-Type': 'multipart/mixed;boundary=batch_1' } };

test('a $batch whose request line writes the action with percent-escapes is REFUSED while an edit is open — its lines are decoded as an address is, before the batch is read', async () => {
  for (const line of [
    `POST ${ROOT}/%41ddAppComponents HTTP/1.1`,
    `POST ${ADD}%2F HTTP/1.1`,
    'POST %41ddAppComponents HTTP/1.1',
    `POST ${ROOT}/Microsoft.Dynamics.CRM.%41ddAppComponents HTTP/1.1`,
    `POST ${ROOT}/%41%64%64%41%70%70%43%6F%6D%70%6F%6E%65%6E%74%73 HTTP/1.1`,
  ]) {
    for (const [label, encode] of BATCH_FORMS) {
      const scope = makeAppComponentScope();
      const { client, calls } = rawTransport();
      await refused(scope.limit(APP, { views: [VIEW] }, () => scope.wrap(client).postRaw(`${ROOT}/$batch`, encode(batchOf(line)), MULTIPART)));
      assert.deepStrictEqual(calls, [], `nothing was sent: ${label}: ${line}`);
    }
  }
});

test('a $batch with a request line whose address cannot be read is REFUSED, and one whose CONTENT merely holds stray percent signs is not — a page\'s rows are no address', async () => {
  for (const line of [`POST ${ROOT}/%ZZ HTTP/1.1`, `PATCH ${ROOT}/accounts%(1) HTTP/1.1`, `POST ${ROOT}/%C0%AF HTTP/1.1`]) {
    const scope = makeAppComponentScope();
    const { client, calls } = rawTransport();
    await assert.rejects(scope.limit(APP, { views: [VIEW] }, () => scope.wrap(client).postRaw(`${ROOT}/$batch`, batchOf(line), MULTIPART)), (error) => {
      assert.strictEqual(error.code, 'APP_COMPONENTS_NOT_LIMITED', line);
      assert.match(error.message, /was NOT sent: .*cannot be read/, line);
      return true;
    });
    assert.deepStrictEqual(calls, [], `nothing was sent: ${line}`);
  }
  const scope = makeAppComponentScope();
  const { client, calls } = rawTransport();
  const rows = [
    batchOf(`POST ${ROOT}/uxagentprojects HTTP/1.1`, '{"name":"100% done %ZZ %C0%AF %41"}'),
    batchOf(`POST ${ROOT}/uxagentprojects?$filter=name%20eq%20%27x%27 HTTP/1.1`),
    batchOf(`PATCH ${ROOT}/uxagentprojectfiles(11111111-2222-4333-8444-555555555555)/filecontent HTTP/1.1`, 'bytes: %'),
  ];
  await scope.limit(APP, { views: [VIEW] }, async () => { for (const body of rows) await scope.wrap(client).postRaw(`${ROOT}/$batch`, body, MULTIPART); });
  assert.deepStrictEqual(calls.map((call) => call[1]), rows, 'every batch that does not name the action goes through as it is');
});

test('a JSON batch is read as JSON is — an escaped letter, an object, a percent-escaped address, a serializer — and refused when it names the action; a JSON batch of anything else goes through as it is', async () => {
  const request = (url) => ({ requests: [{ id: '1', method: 'POST', url, body: derived() }] });
  const escaped = JSON.stringify(request('AddAppComponents')).replace('AddAppComponents', '\\u0041ddAppComponents');
  for (const [label, body] of [
    ['text with an escaped letter', escaped],
    ['the bytes of text with an escaped letter', Buffer.from(escaped)],
    ['text with a percent-escaped address', JSON.stringify(request('%41ddAppComponents'))],
    ['an object', request('AddAppComponents')],
    ['an object with a percent-escaped address', request('%41ddAppComponents%2F')],
    ['an object that serializes itself as a batch that names it', { requests: [], toJSON() { return request('AddAppComponents'); } }],
  ]) {
    const scope = makeAppComponentScope();
    const { client, calls } = rawTransport();
    await refused(scope.limit(APP, { views: [VIEW] }, () => scope.wrap(client).postRaw(`${ROOT}/$batch`, body, { headers: { 'Content-Type': 'application/json' } })));
    assert.deepStrictEqual(calls, [], `nothing was sent: ${label}`);
  }

  const rows = { requests: [{ id: '1', method: 'POST', url: 'uxagentprojects', body: { name: 'Page' } }] };
  const scope = makeAppComponentScope();
  const { client, calls } = rawTransport();
  const sent = [JSON.stringify(rows), rows, undefined];
  await scope.limit(APP, { views: [VIEW] }, async () => { for (const body of sent) await scope.wrap(client).postRaw(`${ROOT}/$batch`, body); });
  assert.deepStrictEqual(calls.map((call) => call[1]), sent, 'a batch that does not name the action goes through as it was read');
  calls.forEach((call, i) => {
    if (typeof sent[i] === 'object') assert.notStrictEqual(call[1], sent[i], `a plain copy of the object, not the object the caller holds: ${i}`);
    else assert.strictEqual(call[1], sent[i], `the very ${typeof sent[i]}: ${i}`);
  });
});

test('a body that cannot be read as the text it will be sent as is REFUSED where a batch could hide the action — an object with a cycle, a BigInt, or one whose serializer throws — through post as through postRaw', async () => {
  const cycle = { requests: [] };
  cycle.requests.push(cycle);
  for (const [label, body] of [['an object with a cycle', cycle], ['a BigInt', { requests: [], size: 1n }], ['a serializer that throws', { toJSON() { throw new Error('no'); } }]]) {
    for (const method of METHODS) {
      const scope = makeAppComponentScope();
      const { client, calls } = bothTransport();
      await refused(scope.limit(APP, { views: [VIEW] }, () => scope.wrap(client)[method](`${ROOT}/$batch`, body)));
      assert.deepStrictEqual(calls, [], `nothing was sent: ${method}, ${label}`);
    }
  }
});

test('over the plugin\'s own transport a batch that hides the action in an escape stays off the wire', async () => {
  const escaped = JSON.stringify({ requests: [{ id: '1', method: 'POST', url: 'AddAppComponents', body: derived() }] }).replace('AddAppComponents', '\\u0041ddAppComponents');
  for (const [label, body, headers] of [
    ['a percent-escaped request line', batchOf(`POST ${ROOT}/%41ddAppComponents HTTP/1.1`), MULTIPART.headers],
    ['a request line that cannot be read', batchOf(`POST ${ROOT}/%ZZ HTTP/1.1`), MULTIPART.headers],
    ['a JSON batch with an escaped letter', escaped, { 'Content-Type': 'application/json' }],
    ['a JSON batch as an object', { requests: [{ id: '1', method: 'POST', url: 'AddAppComponents', body: derived() }] }, { 'Content-Type': 'application/json' }],
  ]) {
    const { scope, client, wire } = overTheWire();
    await refused(scope.limit(APP, { views: [VIEW] }, () => client.postRaw(`${ROOT}/$batch`, body, { headers })));
    assert.deepStrictEqual(wire, [], label);
  }
});

// ── Every request is read ONCE, and what goes on is what was read ───────────────────────────────────────────────────────────────────────────────────
// While an edit is open the limit reads each POST — its address and its body — exactly once, decides on that reading and sends THAT, in every branch: the action it cuts, another app's request, a request to another
// address, a `$batch`. It never sends the object, the array or the address the caller holds, because the transport reads what it is given again — lib/sdk-http-client.js serializes an object with JSON.stringify and
// turns an address that is an object into text each time it needs the text — so something that answers differently the second time would show the limit one request and put another on the wire.

// What the transport of a recorder is given when `request` is sent through `method` to `address` while an edit of APP is open.
async function sentThrough(method, address, body, options) {
  const scope = makeAppComponentScope();
  const { client, calls } = bothTransport();
  await scope.limit(APP, { views: [VIEW] }, () => scope.wrap(client)[method](address, body, options));
  assert.strictEqual(calls.length, 1, `${method} ${String(address)}: one request`);
  return calls[0];
}

// A request that is not the edit's own, as the plain data it is, and how a caller may hand it over: [label, the request as a body, whether it is text or bytes — only a raw POST may carry those to the action itself].
const GIVEN = [
  ['an object', (request) => request, false],
  ['an object with a toJSON', (request) => ({ ignored: true, toJSON() { return request; } }), false],
  ['an object with getters', (request) => Object.defineProperties({}, Object.fromEntries(Object.keys(request).map((key) => [key, { enumerable: true, get: () => request[key] }]))), false],
  ['JSON text', (request) => JSON.stringify(request), true],
  ['a Buffer', (request) => Buffer.from(JSON.stringify(request)), true],
  ['a Uint8Array', (request) => new Uint8Array(Buffer.from(JSON.stringify(request))), true],
  ['a Buffer with a toJSON of its own', (request) => Object.assign(Buffer.from(JSON.stringify(request)), { toJSON: () => derived() }), true],
  ['a Buffer with a valueOf of its own', (request) => Object.assign(Buffer.from(JSON.stringify(request)), { valueOf: () => 'not these bytes' }), true],
];
const PASSED_ON = [
  // [label, address, the request as plain data, whether the address is the action's — which a post can carry only as an object]
  ['another address', `${ROOT}/accounts`, { name: 'Contoso', tags: ['a', 'b'], owner: { id: 1 } }, false],
  ['another address that mentions the action only in its query', OTHER_ADDRESSES[0], { name: 'x' }, false],
  ['the action of another app', ADD, derived(OTHER_APP), true],
  ['a $batch that does not name the action', `${ROOT}/$batch`, { requests: [{ id: '1', method: 'POST', url: 'uxagentprojects', body: { name: 'Page' } }] }, false],
];

function assertSentAsRead(given, request, sent, label) {
  if (typeof given === 'string') {
    assert.strictEqual(sent, given, `${label}: the very text`);
  } else if (given instanceof Uint8Array) {
    assert.ok(sent instanceof Uint8Array && Buffer.isBuffer(sent) === Buffer.isBuffer(given), `${label}: bytes, of the kind they were`);
    assert.notStrictEqual(sent, given, `${label}: a copy of the bytes, not the array the caller holds, which can be changed or serialize itself`);
    assert.ok(!Object.hasOwn(sent, 'toJSON'), `${label}: the copy has no serializer of its own`);
    assert.ok(Buffer.from(sent.buffer, sent.byteOffset, sent.byteLength).equals(Buffer.from(given.buffer, given.byteOffset, given.byteLength)), `${label}: the same bytes`);
  } else {
    assertPlain(sent, label);
    assert.deepStrictEqual(sent, request, `${label}: what the object serializes as`);
    assert.notStrictEqual(sent, given, `${label}: not the object that can answer differently when it is serialized again`);
  }
}

test('what a limit lets through is what it read — the text it was given, a copy of the bytes, the plain data an object serializes as — and never the object or the array the caller holds', async () => {
  const options = { headers: { 'Content-Type': 'application/json', 'If-Match': '1' } };
  for (const [caseLabel, address, request, isAction] of PASSED_ON) {
    for (const method of METHODS) {
      for (const [formLabel, give, isBytesOrText] of GIVEN) {
        // The SDK gives a post an object, and a post of text or bytes to the action itself is refused: nothing is passed on there.
        if (isAction && isBytesOrText && method === 'post') continue;
        const given = give(request);
        const label = `${method}, ${caseLabel}, ${formLabel}`;
        const sent = await sentThrough(method, address, given, options);
        assert.strictEqual(sent.url, address, `${label}: the address`);
        assert.strictEqual(sent.options, options, `${label}: the options are the caller's own`);
        assertSentAsRead(given, request, sent.body, label);
      }
    }
  }
  // Nothing to read is nothing to send.
  for (const method of METHODS) {
    for (const body of [undefined, null]) assert.strictEqual((await sentThrough(method, `${ROOT}/accounts`, body)).body, body, `${method}: ${body}`);
  }
});

test('a body is serialized exactly once in every branch — another address, another app\'s action, a $batch and the edit\'s own action', async () => {
  for (const [label, address, request] of [...PASSED_ON.map(([name, at, plain]) => [name, at, plain]), ['the edit\'s own action', ADD, derived()]]) {
    for (const method of METHODS) {
      let reads = 0;
      await sentThrough(method, address, { toJSON() { reads += 1; return request; } });
      assert.strictEqual(reads, 1, `${method}, ${label}`);
    }
  }
});

test('a request refused for its address is refused without its body being read — what the address already decides is not asked of the body', async () => {
  for (const address of [...LOOKALIKE_ADDRESSES, ...ENCODED_LOOKALIKE_ADDRESSES, ...UNREADABLE_ADDRESSES]) {
    for (const method of METHODS) {
      let reads = 0;
      const scope = makeAppComponentScope();
      const { client, calls } = bothTransport();
      await refused(scope.limit(APP, { views: [VIEW] }, () => scope.wrap(client)[method](address, { toJSON() { reads += 1; return derived(); } })));
      assert.strictEqual(reads, 0, `${method} ${address}: the body was not read`);
      assert.deepStrictEqual(calls, [], `${method} ${address}: nothing was sent`);
    }
  }
});

test('what goes on the wire for a request the limit lets through is what the transport writes without it — byte for byte, whatever the body is', async () => {
  const bodies = [
    ['a plain object', { name: 'Contoso', list: [1, 2, { x: null }], nested: { a: 'ü 🦊 \u2028 "quoted"' } }],
    ['integer-like keys', { b: 1, 2: 'two', 1: 'one' }],
    ['undefined values, functions and symbols', { a: undefined, b: [undefined, () => 1, Symbol('x')], c: 1 }],
    ['a Date', new Date(Date.UTC(2020, 0, 2, 3, 4, 5))],
    ['numbers', { n: [0, -0, 1e21, 1.5e-7, NaN, Infinity] }],
    ['a toJSON that answers a text', { toJSON: () => 'abc' }],
    ['a toJSON that answers a number', { toJSON: () => 5 }],
    ['a toJSON that answers null', { toJSON: () => null }],
    ['a toJSON that answers nothing', { toJSON: () => undefined }],
    ['text', '{"already":"text"}'],
    ['a list', [1, 'two', { three: 3 }]],
    ['a number', 7],
    ['a boolean', false],
    ['a Buffer', Buffer.from('bytes')],
    ['a Uint8Array', new Uint8Array([1, 2, 3])],
    ['nothing', undefined],
    ['null', null],
  ];
  // No body is `null` or `undefined` for the transport alike: it writes nothing for either.
  const written = (wire) => wire.map((sent) => ({ ...sent, body: sent.body === undefined ? null : sent.body }));
  for (const method of METHODS) {
    for (const [label, body] of bodies) {
      const without = overTheWire();
      await without.client[method](`${ROOT}/accounts`, body);
      const limited = overTheWire();
      await limited.scope.limit(APP, { views: [VIEW] }, () => limited.client[method](`${ROOT}/accounts`, body));
      assert.deepStrictEqual(written(limited.wire), written(without.wire), `${method}, ${label}`);
    }
  }
});

test('an object that names another app the first time it is serialized and the edit\'s app the second cannot put the whole request on the wire — it is read once, and the transport is given what was read', async () => {
  const hooks = [
    ['a toJSON', (read) => ({ toJSON() { return derived(read() === 1 ? OTHER_APP : APP); } })],
    ['a getter', (read) => ({ get AppId() { return read() === 1 ? OTHER_APP : APP; }, Components: derived().Components })],
  ];
  for (const method of METHODS) {
    for (const [label, make] of hooks) {
      let reads = 0;
      const { scope, client, wire } = overTheWire();
      await scope.limit(APP, { views: [VIEW] }, () => client[method](ADD, make(() => (reads += 1))));
      assert.strictEqual(reads, 1, `${method}, ${label}: serialized once`);
      assert.strictEqual(wire.length, 1, `${method}, ${label}: one request`);
      assert.deepStrictEqual(JSON.parse(wire[0].body), derived(OTHER_APP), `${method}, ${label}: the request that was read — another app's, which is not this edit's to limit — and no other`);
    }
  }
  // The same object, read as the edit's own the first time, is cut, and never read again.
  for (const method of METHODS) {
    let reads = 0;
    const { scope, client, wire } = overTheWire();
    await scope.limit(APP, { views: [VIEW] }, () => client[method](ADD, { toJSON() { reads += 1; return reads === 1 ? derived() : derived(OTHER_APP); } }));
    assert.strictEqual(reads, 1, method);
    assert.deepStrictEqual(wire.map((sent) => JSON.parse(sent.body)), [{ AppId: APP, Components: [view(VIEW)] }], method);
  }
});

test('a body that serializes as nothing, or as an empty batch, the first time and as a batch that names the action the second is read once — the batch never reaches the wire', async () => {
  const batch = { requests: [{ id: '1', method: 'POST', url: 'AddAppComponents', body: derived() }] };
  for (const method of METHODS) {
    for (const [label, first, expected] of [['an empty batch', { requests: [] }, '{"requests":[]}'], ['nothing', undefined, undefined]]) {
      let reads = 0;
      const { scope, client, wire } = overTheWire();
      await scope.limit(APP, { views: [VIEW] }, () => client[method](`${ROOT}/$batch`, { toJSON() { reads += 1; return reads === 1 ? first : batch; } }, { headers: { 'Content-Type': 'application/json' } }));
      assert.strictEqual(reads, 1, `${method}, ${label}: serialized once`);
      assert.strictEqual(wire.length, 1, `${method}, ${label}`);
      assert.ok(!String(wire[0].body || '').includes(FORM), `${method}, ${label}: the excluded form is not on the wire`);
      assert.strictEqual(wire[0].body ?? undefined, expected, `${method}, ${label}: what was read is what was sent`);
    }
  }
});

test('bytes that serialize themselves are not sent as what they say — a Buffer with a toJSON of its own is sent as the bytes the limit read', async () => {
  for (const method of METHODS) {
    for (const address of [`${ROOT}/accounts`, ADD]) {
      // The SDK gives a post an object: bytes to the action itself are a raw POST's, and a post of them is refused.
      if (address === ADD && method === 'post') continue;
      const bytes = Buffer.from(address === ADD ? JSON.stringify(derived(OTHER_APP)) : 'ordinary bytes');
      const expected = JSON.stringify(Buffer.from(bytes));
      bytes.toJSON = () => derived();
      const { scope, client, wire } = overTheWire();
      await scope.limit(APP, { views: [VIEW] }, () => client[method](address, bytes));
      assert.deepStrictEqual(wire.map((sent) => sent.body), [expected], `${method} ${address}: the bytes, not what their serializer answers`);
    }
  }
});

test('an address given as an object is read once — the transport is given the text the limit read, whatever the object says the next time', async () => {
  for (const method of METHODS) {
    let reads = 0;
    const address = { toString() { reads += 1; return reads === 1 ? `${ROOT}/accounts` : ADD; } };
    const { scope, client, wire } = overTheWire();
    await scope.limit(APP, { views: [VIEW] }, () => client[method](address, derived(), { headers: {} }));
    assert.strictEqual(reads, 1, `${method}: read once`);
    assert.deepStrictEqual(wire.map((sent) => sent.url), [`${ROOT}/accounts`], `${method}: where the limit read it to be`);
  }
  // A URL is handed on as the text of it; a text is handed on as it is.
  for (const method of METHODS) {
    for (const address of [new URL(`${ROOT}/accounts?$top=1`), `${ROOT}/accounts?$top=1`]) {
      const sent = await sentThrough(method, address, 'text');
      assert.strictEqual(sent.url, `${ROOT}/accounts?$top=1`, method);
      assert.strictEqual(typeof sent.url, 'string', method);
    }
  }
  // An address with no text form is one that cannot be read.
  for (const address of [Object.create(null), { toString() { throw new Error('no'); } }]) {
    const scope = makeAppComponentScope();
    const { client, calls } = bothTransport();
    await refused(scope.limit(APP, { views: [VIEW] }, () => scope.wrap(client).post(address, derived())));
    assert.deepStrictEqual(calls, []);
  }
});

test('with no edit open nothing is read — an address, a body and options whose conversion would throw are delegated as they are, and a body is serialized once, by the transport', async () => {
  const scope = makeAppComponentScope();
  const { client, calls } = bothTransport();
  const wrapped = scope.wrap(client);
  let reads = 0;
  const address = { toString() { reads += 1; throw new Error('the address was read'); } };
  const body = { toJSON() { reads += 1; throw new Error('the body was serialized'); } };
  const options = { get headers() { reads += 1; throw new Error('the options were read'); } };
  for (const method of METHODS) await wrapped[method](address, body, options);
  assert.strictEqual(reads, 0);
  assert.strictEqual(calls.length, 2);
  for (const call of calls) assert.ok(call.url === address && call.body === body && call.options === options, `${call.method}: the very references`);

  let serializations = 0;
  const { client: wired, wire } = overTheWire();
  await wired.post(ADD, { toJSON() { serializations += 1; return derived(); } });
  assert.strictEqual(serializations, 1);
  assert.deepStrictEqual(JSON.parse(wire[0].body), derived());
});

test('requests that are no concern of the limit go through post as they were read — the check of a batch reads them and changes nothing, and a url that is no batch entry is nobody\'s address', async () => {
  const sent = [
    [`${ROOT}/PublishXml`, { ParameterXml: '<importexportxml><appmodules><appmodule>22222222-2222-4222-8222-222222222222</appmodule></appmodules></importexportxml>' }],
    [`${ROOT}/appmodules`, { name: 'Sales', uniquename: 'contoso_sales' }],
    [`${ROOT}/webresourceset`, { name: 'x', url: 'https://example.com/100%' }],
    [`${ROOT}/accounts`, { name: '100% done %ZZ %C0%AF %41' }],
    [`${ROOT}/RemoveAppComponents`, derived()],
    [`${ROOT}/accounts`, '{"name":"as text"}'],
    [`${ROOT}/$batch`, { requests: [1, 'x', null, { id: '2' }, { id: '3', url: 7 }] }],
  ];
  for (const method of METHODS) {
    const scope = makeAppComponentScope();
    const { client, calls } = bothTransport();
    await scope.limit(APP, { views: [VIEW] }, async () => { for (const [address, body] of sent) await scope.wrap(client)[method](address, body); });
    assert.strictEqual(calls.length, sent.length, method);
    calls.forEach((call, i) => {
      assert.strictEqual(call.url, sent[i][0], `${method}: ${i}`);
      assert.deepStrictEqual(call.body, sent[i][1], `${method}: ${i}`);
    });
  }
});

// ── A $batch is classified in one way, whichever method carries it and whichever way it is written ─────────────────────────────────────────────────────────────────────
// lib/sdk-http-client.js sends `post` and `postRaw` as the same POST — `postRaw` only reads the answer as text — so a batch that may carry the action is refused through both, and its requests are decoded in
// one way: a multipart request line and an entry of a JSON batch are each an address, read as any address is.
const jsonBatchOf = (url, body = derived()) => ({ requests: [{ id: '1', method: 'POST', url, body }] });
const asText = (batch) => (typeof batch === 'string' ? [['text', batch], ['a Buffer', Buffer.from(batch)], ['a Uint8Array', new Uint8Array(Buffer.from(batch))]] : [['an object', batch]]);
const JSON_HEADERS = { headers: { 'Content-Type': 'application/json' } };

test('a $batch that names the action is refused through post as it is through postRaw — a multipart one, a JSON one as text, as bytes and as an object, with an escape, a serializer or an address that cannot be read', async () => {
  const escaped = JSON.stringify(jsonBatchOf('AddAppComponents')).replace('AddAppComponents', '\\u0041ddAppComponents');
  for (const [label, batch, options] of [
    ['a multipart batch', batchOf(`POST ${ADD} HTTP/1.1`), MULTIPART],
    ['a multipart batch with bare line feeds', batchOf(`POST ${ADD} HTTP/1.1`).replace(/\r\n/g, '\n'), MULTIPART],
    ['a multipart batch whose request line is percent-escaped', batchOf(`POST ${ROOT}/%41ddAppComponents HTTP/1.1`), MULTIPART],
    ['a multipart batch whose request line cannot be read', batchOf(`POST ${ROOT}/%ZZ HTTP/1.1`), MULTIPART],
    ['a JSON batch', JSON.stringify(jsonBatchOf('AddAppComponents')), JSON_HEADERS],
    ['a JSON batch with an escaped letter', escaped, JSON_HEADERS],
    ['a JSON text that names the action with an escaped letter outside any request entry', '{"actions":[{"name":"\\u0041ddAppComponents"}]}', JSON_HEADERS],
    ['a JSON batch', jsonBatchOf('AddAppComponents'), JSON_HEADERS],
    ['an object that serializes itself as a batch that names the action', { requests: [], toJSON() { return jsonBatchOf('AddAppComponents'); } }, JSON_HEADERS],
  ]) {
    for (const [formLabel, body] of asText(batch)) {
      for (const method of METHODS) {
        const scope = makeAppComponentScope();
        const { client, calls } = bothTransport();
        await refused(scope.limit(APP, { views: [VIEW] }, () => scope.wrap(client)[method](`${ROOT}/$batch`, body, options)));
        assert.deepStrictEqual(calls, [], `nothing was sent: ${method}, ${label}, ${formLabel}`);
      }
    }
  }
});

test('a JSON batch is read entry by entry as a multipart one is read line by line — an entry whose address cannot be read is refused, whichever way the batch is given', async () => {
  for (const url of [`${ROOT}/%FF%41ddAppComponents`, `${ROOT}/%ZZ`, `${ROOT}/%C0%AF`, `${ROOT}/accounts%`, 'accounts%2']) {
    for (const [formLabel, body] of [...asText(JSON.stringify(jsonBatchOf(url, { name: 'Page' }))), ...asText(jsonBatchOf(url, { name: 'Page' }))]) {
      for (const method of METHODS) {
        const scope = makeAppComponentScope();
        const { client, calls } = bothTransport();
        await assert.rejects(scope.limit(APP, { views: [VIEW] }, () => scope.wrap(client)[method](`${ROOT}/$batch`, body, JSON_HEADERS)), (error) => {
          assert.strictEqual(error.code, 'APP_COMPONENTS_NOT_LIMITED', `${method}, ${formLabel}: ${url}`);
          assert.match(error.message, /was NOT sent: .*cannot be read/, `${method}, ${formLabel}: ${url}`);
          assert.ok(error.message.includes(url), `${method}, ${formLabel}: names the address that cannot be read: ${error.message}`);
          return true;
        });
        assert.deepStrictEqual(calls, [], `nothing was sent: ${method}, ${formLabel}, ${url}`);
      }
    }
  }
  // The entries that name the action in a spelling that is read are refused as the request lines are.
  for (const url of ['AddAppComponents', `${ROOT}/AddAppComponents`, '/api/data/v9.0/addappcomponents', `${ROOT}/%41ddAppComponents%2F`, `${ROOT}/Microsoft.Dynamics.CRM.AddAppComponents`]) {
    for (const method of METHODS) {
      const scope = makeAppComponentScope();
      const { client, calls } = bothTransport();
      await refused(scope.limit(APP, { views: [VIEW] }, () => scope.wrap(client)[method](`${ROOT}/$batch`, jsonBatchOf(url, { name: 'Page' }), JSON_HEADERS)));
      assert.deepStrictEqual(calls, [], `nothing was sent: ${method}, ${url}`);
    }
  }
});

test('a JSON batch whose entries are no concern of the limit goes through as it was read — through post and postRaw, whatever its addresses spell, unless one cannot be read', async () => {
  const rows = [
    jsonBatchOf('uxagentprojects', { name: 'Page' }),
    jsonBatchOf(`${ROOT}/uxagentprojectfiles(11111111-2222-4333-8444-555555555555)/filecontent`, { name: 'Page' }),
    jsonBatchOf(`${ROOT}/accounts?$filter=name%20eq%20%27x%27`, { name: 'Page' }),
    jsonBatchOf(`${ROOT}/accounts?$filter=name eq '100%'`, { name: 'Page' }),
    jsonBatchOf('uxagentprojects', { name: '100% done %ZZ %C0%AF %41' }),
    { requests: [jsonBatchOf('uxagentprojects').requests[0], jsonBatchOf('accounts').requests[0]] },
  ];
  for (const method of METHODS) {
    for (const [formLabel, convert] of [['an object', (rows_) => rows_], ['text', (rows_) => JSON.stringify(rows_)], ['bytes', (rows_) => Buffer.from(JSON.stringify(rows_))]]) {
      const scope = makeAppComponentScope();
      const { client, calls } = bothTransport();
      await scope.limit(APP, { views: [VIEW] }, async () => { for (const batch of rows) await scope.wrap(client)[method](`${ROOT}/$batch`, convert(batch), JSON_HEADERS); });
      assert.strictEqual(calls.length, rows.length, `${method}, ${formLabel}`);
      calls.forEach((call, i) => {
        const given = convert(rows[i]);
        assertSentAsRead(given, rows[i], call.body, `${method}, ${formLabel}: ${i}`);
      });
    }
  }
});

test('over the plugin\'s own transport a batch stays off the wire through post as through postRaw — a multipart one, a JSON one as an object and with an escape, and an entry whose address cannot be read', async () => {
  const escaped = JSON.stringify(jsonBatchOf('AddAppComponents')).replace('AddAppComponents', '\\u0041ddAppComponents');
  for (const [label, body, headers] of [
    ['a multipart batch', batchOf(`POST ${ADD} HTTP/1.1`), MULTIPART.headers],
    ['a JSON batch as an object', jsonBatchOf('AddAppComponents'), JSON_HEADERS.headers],
    ['a JSON batch with an escaped letter', escaped, JSON_HEADERS.headers],
    ['a JSON batch with an entry whose address cannot be read', JSON.stringify(jsonBatchOf(`${ROOT}/%FF%41ddAppComponents`)), JSON_HEADERS.headers],
  ]) {
    for (const method of METHODS) {
      const { scope, client, wire } = overTheWire();
      await refused(scope.limit(APP, { views: [VIEW] }, () => client[method](`${ROOT}/$batch`, body, { headers })));
      assert.deepStrictEqual(wire, [], `${method}, ${label}`);
    }
  }
  // A batch of the page's own rows goes on the wire as it is, through either method.
  const rows = batchOf(`POST ${ROOT}/uxagentprojects HTTP/1.1`, '{"name":"Page"}');
  for (const method of METHODS) {
    const { scope, client, wire } = overTheWire();
    await scope.limit(APP, { views: [VIEW] }, () => client[method](`${ROOT}/$batch`, rows, MULTIPART));
    assert.deepStrictEqual(wire.map((sent) => sent.body), [rows], method);
  }
});
