'use strict';
// lib/app-component-scope.js: the limit a page edit puts on the AddAppComponents the SDK posts after it writes an app's sitemap. The real bundle's requests are pinned in
// genpage-app-edit-real-bundle.test.js; these hold the limit itself, against a transport that only records.
const { test } = require('node:test');
const assert = require('node:assert');
const { makeAppComponentScope } = require('../lib/app-component-scope.js');

const APP = '22222222-2222-4222-8222-222222222222';
const OTHER_APP = '33333333-3333-4333-8333-333333333333';
const VIEW = '66666666-6666-4666-8666-666666666666';
const VIEW_2 = '66666666-6666-4666-8666-666666666667';
const FORM = '99999999-9999-4999-8999-999999999991';
const CHART = '99999999-9999-4999-8999-999999999993';
const ADD = 'https://contoso.crm.dynamics.com/api/data/v9.2/AddAppComponents';

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
    await wrapped.post('https://contoso.crm.dynamics.com/api/data/v9.2/PublishXml', { ParameterXml: '<importexportxml/>' });
    // Another action, with a body of the same shape.
    await wrapped.post('https://contoso.crm.dynamics.com/api/data/v9.2/RemoveAppComponents', derived());
    // A body that is not the SDK's: no list.
    await wrapped.post(ADD, { AppId: APP });
    await wrapped.get('https://contoso.crm.dynamics.com/api/data/v9.2/appmodules');
    await wrapped.patch('https://contoso.crm.dynamics.com/api/data/v9.2/sitemaps(1)', { sitemapxml: '<SiteMap/>' });
  });
  assert.strictEqual(calls[0][2], elsewhere);
  assert.deepStrictEqual(calls.map(([method]) => method), ['post', 'post', 'post', 'post', 'get', 'patch']);
  assert.deepStrictEqual(calls[2][2], derived(), 'another action keeps its whole list');
});

test('the transport keeps what it had — every method it offered, and the answers of the posts that go through', async () => {
  const scope = makeAppComponentScope();
  const { client } = transport(() => ({ status: 201, headers: { 'odata-entityid': 'x' }, body: { id: 1 } }));
  const wrapped = scope.wrap(client);
  for (const key of Object.keys(client)) assert.ok(key in wrapped && typeof wrapped[key] === 'function', `${key} is offered`);
  assert.deepStrictEqual(await wrapped.get('https://contoso.crm.dynamics.com/api/data/v9.2/appmodules'), { status: 200, headers: {}, body: { value: [] } });
  assert.strictEqual(typeof wrapped.postRaw, 'function', 'a client that does batches still does: the SDK asks for postRaw');
  assert.deepStrictEqual(await wrapped.post('https://contoso.crm.dynamics.com/api/data/v9.2/appmodules', { name: 'x' }), { status: 201, headers: { 'odata-entityid': 'x' }, body: { id: 1 } });
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
  await wrapped.get('https://contoso.crm.dynamics.com/api/data/v9.2/appmodules');
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
