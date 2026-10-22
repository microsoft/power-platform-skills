'use strict';
// lib/collection-answers.js — the answer to a read of a collection, held to being one, at the HTTP client the SDK is given. The scripts' use of it, over the real client and the
// real bundle, is in unreadable-collection-answers.test.js (list-tables.js) and unreadable-table-list-callers.test.js (the build, the teardown, the verifier); this holds the helper itself,
// its table-list policy (`guardTableLists`), and how lib/maker-sdk.js hands it to every SDK a script makes.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { requireCollectionAnswers, unreadableAnswer, isCollection, describeAnswer, guardTableLists, TABLES_UNREADABLE } = require('../lib/collection-answers.js');
const bundle = require('../vendor/cds-maker-sdk.cjs');
const { createMakerSdk, createNodeWorkspaceStorage, SdkError, ConnectionError } = require('../lib/maker-sdk.js');

const TABLE_LIST = /\/EntityDefinitions\?/;
const URL_LIST = 'https://contoso.crm.dynamics.com/api/data/v9.0/EntityDefinitions?$select=LogicalName';
const URL_ONE = "https://contoso.crm.dynamics.com/api/data/v9.0/EntityDefinitions(LogicalName='account')";
const URL_OTHER = 'https://contoso.crm.dynamics.com/api/data/v9.0/appmodules?$select=appmoduleid';

const answerOf = (status, body) => ({ status, headers: {}, body });
// A client that answers every get with `response` and records what it was asked.
const fakeClient = (response) => {
  const asked = [];
  return { asked, get: async (url, options) => { asked.push([url, options]); return response; } };
};
const guard = (client, extra = {}) => requireCollectionAnswers(client, {
  reads: (url) => TABLE_LIST.test(url),
  unreadable: ({ status, shape, url }) => Object.assign(new Error(`unreadable ${status} ${shape}`), { code: 'UNREADABLE', url }),
  ...extra,
});

test('isCollection is a JSON object whose `value` is a list — an empty one included — and nothing else', () => {
  for (const body of [{ value: [] }, { value: [{ a: 1 }] }, { value: [], '@odata.nextLink': 'https://x' }, { '@odata.context': 'x', value: [] }]) assert.strictEqual(isCollection(body), true, JSON.stringify(body));
  for (const body of [undefined, null, '', '<html></html>', '{"value":[]}', {}, { value: null }, { value: {} }, { value: 'x' }, { value: 0 }, [], [{ value: [] }], 5, true]) {
    assert.strictEqual(isCollection(body), false, JSON.stringify(body));
  }
});

test('describeAnswer says what a body is without quoting it', () => {
  assert.strictEqual(describeAnswer(undefined), 'an empty body');
  assert.strictEqual(describeAnswer(null), 'JSON null');
  assert.strictEqual(describeAnswer('<html><body>Sign in</body></html>'), 'an HTML page');
  assert.strictEqual(describeAnswer('  <!DOCTYPE html><title>x</title>'), 'an HTML page');
  assert.strictEqual(describeAnswer('Service Unavailable'), 'text that is not JSON');
  assert.strictEqual(describeAnswer(''), 'text that is not JSON');
  assert.strictEqual(describeAnswer([]), 'a JSON array');
  assert.strictEqual(describeAnswer({}), 'a JSON object with no "value" list');
  assert.strictEqual(describeAnswer({ other: [] }), 'a JSON object with no "value" list');
  assert.strictEqual(describeAnswer({ value: null }), 'a JSON object whose "value" is not a list');
  assert.strictEqual(describeAnswer({ value: 'secret-looking-text' }), 'a JSON object whose "value" is not a list');
  assert.strictEqual(describeAnswer(5), 'a JSON number');
  assert.strictEqual(describeAnswer(false), 'a JSON boolean');
  for (const body of ['<html>token=abc123</html>', { value: 'token=abc123' }, { secret: 'token=abc123' }]) assert.ok(!describeAnswer(body).includes('abc123'), 'no text of the body is in what it says');
});

test('a 2xx answer to a selected read that is a collection is handed back as it is — the same object, never read into or copied', async () => {
  for (const body of [{ value: [] }, { value: [{ LogicalName: 'account' }], '@odata.nextLink': 'https://x' }]) {
    const response = answerOf(200, body);
    const client = fakeClient(response);
    assert.strictEqual(await guard(client).get(URL_LIST, { headers: { Prefer: 'x' } }), response);
    assert.deepStrictEqual(client.asked, [[URL_LIST, { headers: { Prefer: 'x' } }]], 'the url and the options reach the client as given');
  }
});

test('a 2xx answer to a selected read that is no collection throws what the script says, told the status, what the answer was and the url — in every 2xx status', async () => {
  for (const [status, body, shape] of [
    [200, {}, 'a JSON object with no "value" list'],
    [200, null, 'JSON null'],
    [200, undefined, 'an empty body'],
    [200, '<html>Sign in</html>', 'an HTML page'],
    [200, { value: null }, 'a JSON object whose "value" is not a list'],
    [200, [], 'a JSON array'],
    [204, undefined, 'an empty body'],
    [299, 'x', 'text that is not JSON'],
  ]) {
    await assert.rejects(guard(fakeClient(answerOf(status, body))).get(URL_LIST), (err) => {
      assert.strictEqual(err.message, `unreadable ${status} ${shape}`);
      assert.strictEqual(err.url, URL_LIST);
      return true;
    }, `${status} ${shape}`);
  }
});

test('a read the policy does not select, and an answer that is not a 2xx, are never judged — whatever the body', async () => {
  for (const [url, response] of [
    [URL_ONE, answerOf(200, '<html>not a collection, and not meant to be</html>')],
    [URL_OTHER, answerOf(200, {})],
    [URL_LIST, answerOf(403, '<html>Forbidden</html>')],
    [URL_LIST, answerOf(400, { error: { message: 'bad request' } })],
    [URL_LIST, answerOf(301, '')],
    [URL_LIST, answerOf(304, undefined)],
    [URL_LIST, answerOf(500, null)],
    [URL_LIST, answerOf(199, null)],
  ]) {
    assert.strictEqual(await guard(fakeClient(response)).get(url), response, `${url} ${response.status}`);
  }
  // No answer at all is the client's to explain (its own error), not this check's.
  assert.strictEqual(await guard(fakeClient(undefined)).get(URL_LIST), undefined);
});

test('what the client throws is the client\u2019s own: a transport failure passes through, and is no unreadable answer', async () => {
  const failure = new Error('socket hang up');
  const client = { get: async () => { throw failure; } };
  await assert.rejects(guard(client).get(URL_LIST), (err) => err === failure);
  assert.strictEqual(unreadableAnswer(failure), null);
});

test('every other method of the client is reached as it was — also on a client whose methods live on its prototype — and nothing is copied into the guard', async () => {
  const calls = [];
  class Client {
    constructor() { this.marker = 'a client'; }
    async get() { return answerOf(200, { value: [] }); }
    async post(url, body) { calls.push(['post', url, body]); return answerOf(201, undefined); }
    async postRaw(url, body) { calls.push(['postRaw', url, body]); return answerOf(200, 'raw'); }
    get supportsBatch() { return typeof this.postRaw === 'function'; }
  }
  const guarded = guard(new Client());
  assert.strictEqual(guarded.marker, 'a client');
  assert.strictEqual(typeof guarded.postRaw, 'function', 'the SDK checks for postRaw before it sends a batch');
  assert.strictEqual(guarded.supportsBatch, true);
  assert.strictEqual((await guarded.post(URL_ONE, { a: 1 })).status, 201);
  assert.strictEqual((await guarded.postRaw(URL_OTHER, 'body')).body, 'raw');
  assert.deepStrictEqual(calls, [['post', URL_ONE, { a: 1 }], ['postRaw', URL_OTHER, 'body']]);
});

test('a client with no `get` — a test\u2019s marker object, or nothing — is returned as it is', () => {
  const marker = { marker: 'az-client' };
  assert.strictEqual(requireCollectionAnswers(marker, { reads: () => true, unreadable: () => new Error('x') }), marker);
  assert.strictEqual(requireCollectionAnswers(undefined, { reads: () => true, unreadable: () => new Error('x') }), undefined);
  assert.strictEqual(requireCollectionAnswers(null, { reads: () => true, unreadable: () => new Error('x') }), null);
});

test('unreadableAnswer finds the guard\u2019s error itself and under the SDK\u2019s wrapper — within eight links of the chain, the SDK\u2019s own bound — and finds nothing else', async () => {
  let thrown;
  await guard(fakeClient(answerOf(200, '{}'))).get(URL_LIST).catch((err) => { thrown = err; });
  assert.strictEqual(unreadableAnswer(thrown), thrown, 'the error itself');
  const wrapper = (cause) => Object.defineProperty(new Error('Transport failure reaching x'), 'cause', { value: cause });
  assert.strictEqual(unreadableAnswer(wrapper(thrown)), thrown, 'as the cause of the SDK\u2019s ConnectionError');
  const wrapped = (times) => { let at = thrown; for (let i = 0; i < times; i += 1) at = wrapper(at); return at; };
  assert.strictEqual(unreadableAnswer(wrapped(7)), thrown, 'seven wrappers: the eighth link');
  assert.strictEqual(unreadableAnswer(wrapped(8)), null, 'eight wrappers: beyond the bound it is not looked for');
  for (const other of [new Error('plain'), wrapper(new Error('inner')), { code: 'UNREADABLE' }, null, undefined, 'text', 7]) assert.strictEqual(unreadableAnswer(other), null, String(other));
  // A cause that points back at its own error ends the walk.
  const loop = new Error('loop');
  Object.defineProperty(loop, 'cause', { value: loop });
  assert.strictEqual(unreadableAnswer(loop), null);
});

test('an error the script made is marked, and one a script made for something else is not mistaken for it', async () => {
  const marked = await guard(fakeClient(answerOf(200, null))).get(URL_LIST).catch((err) => err);
  assert.strictEqual(marked.code, 'UNREADABLE', 'the script\u2019s own error, with its own code');
  const [mark] = Object.getOwnPropertySymbols(marked);
  assert.ok(mark, 'it is marked');
  assert.strictEqual(Object.getOwnPropertyDescriptor(marked, mark).enumerable, false, 'and the mark is no enumerable property, which a spread or a serialiser would copy');
  assert.strictEqual(JSON.stringify(marked), `{"code":"UNREADABLE","url":"${URL_LIST}"}`);
  assert.strictEqual(unreadableAnswer(Object.assign(new Error('x'), { code: 'UNREADABLE' })), null);
});

// --- the table list ------------------------------------------------------------------------------------------------------------------------------

const answerHtml = answerOf(200, '<html><body>Sign in to your account</body></html>');

test('guardTableLists judges the table list and nothing else: not one table\u2019s definition, not a table\u2019s columns, not another collection', async () => {
  const client = fakeClient(answerHtml);
  const guarded = guardTableLists(client);
  await assert.rejects(guarded.get('https://contoso.crm.dynamics.com/api/data/v9.2/EntityDefinitions?$select=LogicalName,SchemaName,EntitySetName,DisplayName,IsCustomEntity'), (err) => err.code === TABLES_UNREADABLE);
  for (const url of [
    URL_ONE,
    "https://contoso.crm.dynamics.com/api/data/v9.2/EntityDefinitions(LogicalName='account')/Attributes?$select=LogicalName",
    "https://contoso.crm.dynamics.com/api/data/v9.2/EntityDefinitions(LogicalName='account')?$select=LogicalName,EntitySetName",
    URL_OTHER,
    'https://contoso.crm.dynamics.com/api/data/v9.2/RelationshipDefinitions?$select=SchemaName',
  ]) assert.strictEqual(await guarded.get(url), answerHtml, url);
});

test('guardTableLists: a list is handed back as it is — an empty one too — and a failure carries the code, says what the answer was and what it does not mean, and never quotes it', async () => {
  const empty = answerOf(200, { value: [] });
  assert.strictEqual(await guardTableLists(fakeClient(empty)).get(URL_LIST), empty);
  for (const [body, shape] of [['<html>token=abc123</html>', 'an HTML page'], [{}, 'a JSON object with no "value" list'], [null, 'JSON null'], ['token=abc123', 'text that is not JSON']]) {
    const err = await guardTableLists(fakeClient(answerOf(200, body))).get(URL_LIST).catch((e) => e);
    assert.strictEqual(err.code, 'TABLES_UNREADABLE');
    assert.ok(err.message.includes(`HTTP 200 with ${shape}, which is not a list of tables`), err.message);
    assert.match(err.message, /not an empty environment/);
    assert.match(err.message, /none is safe to delete/, 'the destructive callers are told too');
    assert.ok(!err.message.includes('abc123'), 'what the platform sent is not echoed');
    assert.strictEqual(unreadableAnswer(err), err, 'and it is the one the guard marks');
  }
  // Only a 2xx is judged: a refusal keeps the SDK\u2019s own words.
  const refused = answerOf(403, '<html>Forbidden</html>');
  assert.strictEqual(await guardTableLists(fakeClient(refused)).get(URL_LIST), refused);
});

test('guardTableLists makes the failure the caller asks for — the SDK factory\u2019s is an SdkError — and guarding a client twice is one guard', async () => {
  const made = [];
  const guarded = guardTableLists(fakeClient(answerHtml), (code, message) => { made.push([code, message]); return Object.assign(new RangeError('made by the caller'), { code }); });
  const err = await guarded.get(URL_LIST).catch((e) => e);
  assert.ok(err instanceof RangeError && err.code === 'TABLES_UNREADABLE');
  assert.strictEqual(made.length, 1);
  assert.match(made[0][1], /not a list of tables/);
  assert.strictEqual(guardTableLists(guarded), guarded, 'a guarded client comes back as it is');
  const asked = [];
  const inner = guardTableLists({ get: async (url) => { asked.push(url); return answerHtml; } });
  const twice = guardTableLists(inner, () => new Error('a second guard'));
  assert.strictEqual(twice, inner);
  await assert.rejects(twice.get(URL_LIST), (e) => e.code === 'TABLES_UNREADABLE' && e.message !== 'a second guard');
  assert.strictEqual(asked.length, 1, 'one read, one answer judged once');
  // No `get`: nothing to guard, nothing marked.
  const marker = { marker: 'az-client' };
  assert.strictEqual(guardTableLists(marker), marker);
  assert.strictEqual(guardTableLists(undefined), undefined);
});

// --- lib/maker-sdk.js: every SDK a script makes is given the guarded client ------------------------------------------------------------------

const ORIGIN = 'https://contoso.crm.dynamics.com';
const withWorkspace = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collection-answers-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return createNodeWorkspaceStorage(dir);
};
// An HTTP client that answers every read with `response`, and records each request in order.
const recording = (response) => {
  const requests = [];
  const answer = async (method, url) => { requests.push(`${method} ${url}`); return response; };
  return { requests, get: (url) => answer('GET', url), post: (url) => answer('POST', url), patch: (url) => answer('PATCH', url), delete: (url) => answer('DELETE', url), put: (url) => answer('PUT', url) };
};
const TABLE = { LogicalName: 'new_widget', SchemaName: 'new_Widget', EntitySetName: 'new_widgets', IsCustomEntity: true, DisplayName: { UserLocalizedLabel: { Label: 'Widget' } } };

test('REAL BUNDLE: an SDK made through lib/maker-sdk.js fails findTables() on an answer that is no list — as an SdkError with its own code, not the SDK\u2019s ConnectionError — and the bundle\u2019s own factory reads it as no tables', async (t) => {
  const noValue = [answerOf(200, '{}'), answerOf(200, null), answerHtml, answerOf(200, 'Service Unavailable')];
  for (const response of [...noValue, answerOf(200, { value: 'x' })]) {
    const sdk = createMakerSdk({ workspaceStorage: withWorkspace(t), instanceUrl: ORIGIN, httpClient: recording(response) });
    await assert.rejects(sdk.findTables('new_widget'), (err) => {
      assert.ok(err instanceof SdkError, 'rethrown by the SDK as it is');
      assert.ok(!(err instanceof ConnectionError), 'not wrapped in a "Transport failure"');
      assert.strictEqual(err.code, 'TABLES_UNREADABLE');
      assert.match(err.message, /^The environment's tables could not be read: the platform answered HTTP 200 with /);
      return true;
    }, JSON.stringify(response.body));
  }
  // The premise, which is the hole: the bundle on its own reads each of those answers as an environment with no table at all.
  for (const response of noValue) {
    const unguarded = bundle.createMakerSdk({ workspaceStorage: withWorkspace(t), instanceUrl: ORIGIN, httpClient: recording(response) });
    assert.deepStrictEqual(await unguarded.findTables('new_widget'), [], JSON.stringify(response.body));
  }
});

test('REAL BUNDLE: a list — an empty one too — is read as before, with the same requests as the bundle\u2019s own factory sends', async (t) => {
  for (const body of [{ value: [] }, { value: [TABLE] }]) {
    const guarded = recording(answerOf(200, body));
    const unguarded = recording(answerOf(200, body));
    const viaFactory = await createMakerSdk({ workspaceStorage: withWorkspace(t), instanceUrl: ORIGIN, httpClient: guarded }).findTables('new_widget', { top: 5 });
    const viaBundle = await bundle.createMakerSdk({ workspaceStorage: withWorkspace(t), instanceUrl: ORIGIN, httpClient: unguarded }).findTables('new_widget', { top: 5 });
    assert.deepStrictEqual(viaFactory, viaBundle, 'the same rows');
    assert.deepStrictEqual(guarded.requests, unguarded.requests, 'the same requests, in the same order');
    assert.strictEqual(guarded.requests.length, 1, 'one read');
  }
});

test('lib/maker-sdk.js hands the SDK a guarded client — once — and options with no HTTP client, or one with no `get`, are what they were', () => {
  const { withVendoredCompiler } = require('../lib/maker-sdk.js');
  const seen = [];
  const create = withVendoredCompiler((options) => { seen.push(options); return options; });
  const client = fakeClient(answerHtml);
  const made = create({ instanceUrl: ORIGIN, httpClient: client });
  assert.notStrictEqual(made.httpClient, client, 'the SDK is given the guarded client');
  // It delegates (a Proxy, as the app header guard is): every member but the table-list read is the client's own, run on the client itself.
  assert.ok(typeof made.httpClient.get === 'function' && made.httpClient.get !== client.get, 'its read of the table list is the guard\u2019s');
  for (const key of Object.keys(client).filter((k) => k !== 'get' && typeof client[k] === 'function')) assert.strictEqual(typeof made.httpClient[key], 'function', `${key} is the client\u2019s`);
  assert.strictEqual(create({ instanceUrl: ORIGIN, httpClient: made.httpClient }).httpClient, made.httpClient, 'a client already guarded is not guarded again');
  const marker = { marker: 'az-client' };
  assert.strictEqual(create({ instanceUrl: ORIGIN, httpClient: marker }).httpClient, marker, 'a client with no get is the caller\u2019s own');
  assert.deepStrictEqual(Object.keys(create({ instanceUrl: ORIGIN })).sort(), ['instanceUrl', 'typescript'], 'no HTTP client: no key the factory did not add before');
});
