'use strict';
// lib/app-component-scope.js: the limit a page edit puts on the AddAppComponents the SDK posts after it writes an app's sitemap. The real bundle's requests are pinned in
// genpage-app-edit-real-bundle.test.js; these hold the limit itself, against a transport that only records — what it reads exactly, and that what it cannot read is refused,
// never forwarded whole and never answered as if it had been done.
const { test } = require('node:test');
const assert = require('node:assert');
const { makeAppComponentScope } = require('../lib/app-component-scope.js');
const { createAzHttpClient } = require('../lib/sdk-http-client.js');
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
    assert.strictEqual(calls[0][2], body, `as it was: ${address}`);
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
// plugin's transport serializes it as it does for `post`, so it is the same request.
const RAW_FORMS = [
  ['JSON text', (request) => JSON.stringify(request), (sent) => { assert.strictEqual(typeof sent, 'string'); return JSON.parse(sent); }],
  ['a Buffer', (request) => Buffer.from(JSON.stringify(request)), (sent) => { assert.ok(Buffer.isBuffer(sent)); return JSON.parse(sent.toString('utf8')); }],
  ['a Uint8Array', (request) => new Uint8Array(Buffer.from(JSON.stringify(request))), (sent) => { assert.ok(sent instanceof Uint8Array); return JSON.parse(Buffer.from(sent).toString('utf8')); }],
  ['an object', (request) => request, (sent) => sent],
];

test('a raw POST to the action\'s address is limited as a post is — to the views the edit owns, in the form the body came in, to the address and with the options it had', async () => {
  const options = { headers: { 'Content-Type': 'application/json' } };
  for (const address of ACTION_ADDRESSES) {
    for (const [label, encode, decode] of RAW_FORMS) {
      const scope = makeAppComponentScope();
      const { client, calls } = rawTransport();
      const answer = await scope.limit(APP, { views: [VIEW] }, () => scope.wrap(client).postRaw(address, encode(derived()), options));
      assert.strictEqual(answer.status, 204, `${label}: ${address}`);
      assert.strictEqual(calls.length, 1, `${label}: ${address}`);
      assert.strictEqual(calls[0][0], address, `${label}: addressed as it was`);
      assert.deepStrictEqual(decode(calls[0][1]), { AppId: APP, Components: [view(VIEW)] }, `${label}: the table, the form, the other view and the chart are not sent: ${address}`);
      assert.strictEqual(calls[0][2], options, `${label}: the options are the caller's`);
    }
  }
});

test('a raw POST that holds nothing but what the edit owns is sent as it is — the same text, the same bytes, the same object, not a copy', async () => {
  const only = { AppId: APP, Components: [view(VIEW)] };
  for (const body of [JSON.stringify(only), Buffer.from(JSON.stringify(only)), new Uint8Array(Buffer.from(JSON.stringify(only))), only]) {
    const scope = makeAppComponentScope();
    const { client, calls } = rawTransport();
    await scope.limit(APP, { views: [VIEW] }, () => scope.wrap(client).postRaw(ADD, body));
    assert.strictEqual(calls[0][1], body);
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

test('another app\'s raw request to the action goes through as it is, in any shape — an edit of one app does not limit another\'s', async () => {
  const scope = makeAppComponentScope();
  const { client, calls } = rawTransport();
  const wrapped = scope.wrap(client);
  const sent = [JSON.stringify(derived(OTHER_APP)), Buffer.from(JSON.stringify({ AppId: OTHER_APP })), JSON.stringify({ AppId: OTHER_APP, Components: 'x' }), derived(OTHER_APP)];
  await scope.limit(APP, { views: [VIEW] }, async () => { for (const body of sent) await wrapped.postRaw(ADD, body); });
  assert.strictEqual(calls.length, sent.length);
  calls.forEach((call, i) => assert.strictEqual(call[1], sent[i], `as it was: ${i}`));
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
    request: async ({ url, method, body }) => { wire.push({ url: String(url), method, body }); return { statusCode: 204, headers: {}, body: '' }; },
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
