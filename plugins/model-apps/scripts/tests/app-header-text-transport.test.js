'use strict';
// REAL BUNDLE + REAL CLIENT: the app header's guard (lib/app-header-text.js) at the boundary that matters — the bundled SDK, made the way every script makes it
// (lib/maker-sdk.js), over the plugin's own HTTP client (createAzHttpClient) with only its two outside dependencies faked: the token and the HTTP request.
//
// The guard was first built for the SDK's own `patch`. The SDK writes through two more doors a caller can reach — `dataverse.postBatch(body, boundary)`, which sends a change set the
// caller rendered through the client's `postRaw`, and `dataverse.patchRaw` — and `dataverse.post` sends the same text a `postRaw` would, so a PATCH of an app module row whose name or
// description is not a string must be refused in each of them, before the request is asked for a token or sent. These tests drive each through the real SDK and the real client and look at
// what reaches the request dependency, which is the wire. They also pin what must not change: a healthy header, another table's change set and the SDK's own change sets go out byte for
// byte, and a client whose methods keep private state (a class with `#fields`) still works — the guard runs every member of it on the client itself.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMakerSdk, createNodeWorkspaceStorage, SdkError } = require('../lib/maker-sdk.js');
const { createAzHttpClient } = require('../lib/sdk-http-client.js');
const { API, APP, renderChangeSet } = require('./helpers/batch-bodies.js');

const ENV = 'https://contoso.crm.dynamics.com';
const NOT_PLAIN = 'APP_HEADER_NOT_PLAIN_TEXT';
const tempDirs = [];
test.after(() => { for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true }); });

// The plugin's own client over a request dependency that records every request that reaches it and answers 200. `tokens()` counts the token acquisitions: a refused write must
// cost none, because the client asks for the token only when it is asked to send.
function transport(answer = () => ({ statusCode: 200, headers: {}, body: '--batchresponse_x--\r\n' })) {
  const sent = [];
  let tokens = 0;
  const client = createAzHttpClient(ENV, {
    getToken: () => { tokens += 1; return 'OFFLINE_TEST_TOKEN'; },
    request: async (request) => { sent.push(request); return answer(request); },
    sleep: async () => {},
  });
  return { client, sent, tokens: () => tokens };
}

function makeSdk(httpClient) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-header-transport-'));
  tempDirs.push(dir);
  return createMakerSdk({ instanceUrl: ENV, httpClient, workspaceStorage: createNodeWorkspaceStorage(dir) });
}

// A change set as a caller writes one by hand (no solution header, a plain JSON content type), with one operation: a PATCH of `table`'s row.
function handWritten(table, header) {
  return [
    '--batch_hand', 'Content-Type: multipart/mixed;boundary=changeset_hand', '',
    '--changeset_hand', 'Content-Type: application/http', 'Content-Transfer-Encoding: binary', 'Content-ID: 1', '',
    `PATCH ${API}/${table}(${APP}) HTTP/1.1`, 'Content-Type: application/json', 'If-Match: W/"1"', '', JSON.stringify(header),
    '--changeset_hand--', '--batch_hand--', '',
  ].join('\r\n');
}
const REFUSED_HEADERS = [
  ['a localized app name', { name: { 1033: 'Probe', 1036: 'Sonde' }, description: 'Tickets' }],
  ['a numeric app description', { name: 'Probe', description: 7 }],
  ['a list for the name and a boolean for the description', { name: ['Probe'], description: true }],
];

const assertRefusal = (error, what) => {
  assert.ok(error instanceof SdkError, `${what}: the bundle's own SdkError, which the SDK rethrows as it is instead of wrapping it in a ConnectionError`);
  assert.strictEqual(error.code, NOT_PLAIN);
  assert.strictEqual(error.transient, false, `${what}: nothing re-runs on its own`);
  return true;
};

// --- postBatch: a change set the caller rendered ---------------------------------------------------------------------------------------------------------

for (const [what, header] of REFUSED_HEADERS) {
  test(`REAL BUNDLE + REAL CLIENT: sdk.dataverse.postBatch of a change set that PATCHes an app module row with ${what} sends nothing and asks for no token`, async () => {
    const { client, sent, tokens } = transport();
    const sdk = makeSdk(client);
    await assert.rejects(sdk.dataverse.postBatch(handWritten('appmodules', header), 'batch_hand'), (error) => assertRefusal(error, what));
    assert.deepStrictEqual([sent.length, tokens()], [0, 0], 'no request reached the wire, and the token was never asked for');
  });
}

test('REAL BUNDLE + REAL CLIENT: the same change set through sdk.dataverse.post — the same text on the wire — is refused too', async () => {
  const { client, sent, tokens } = transport();
  const sdk = makeSdk(client);
  const options = { headers: { 'Content-Type': 'multipart/mixed;boundary=batch_hand' } };
  for (const [what, header] of REFUSED_HEADERS) {
    await assert.rejects(sdk.dataverse.post('/$batch', handWritten('appmodules', header), options), (error) => assertRefusal(error, what));
  }
  assert.deepStrictEqual([sent.length, tokens()], [0, 0]);
});

test('REAL BUNDLE + REAL CLIENT: a healthy app header change set goes out once, byte for byte, with the boundary header and the token', async () => {
  const { client, sent, tokens } = transport();
  const sdk = makeSdk(client);
  const text = handWritten('appmodules', { name: 'Probe', description: 'Tickets' });
  const answer = await sdk.dataverse.postBatch(text, 'batch_hand');
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(tokens(), 1);
  assert.strictEqual(sent[0].method, 'POST');
  assert.strictEqual(sent[0].url, `${API}/$batch`);
  assert.strictEqual(sent[0].body, text, 'the very text that was handed over, not a copy that was read and written back');
  assert.strictEqual(sent[0].headers['Content-Type'], 'multipart/mixed;boundary=batch_hand');
  assert.match(sent[0].headers.Authorization, /^Bearer OFFLINE_TEST_TOKEN$/);
  assert.strictEqual(answer.status, 200, 'and the client\'s own answer comes back');
  // Through sdk.dataverse.post the same text is sent as it is as well.
  const viaPost = await sdk.dataverse.post('/$batch', text, { headers: { 'Content-Type': 'multipart/mixed;boundary=batch_hand' } });
  assert.strictEqual(sent.length, 2);
  assert.strictEqual(sent[1].body, text);
  assert.strictEqual(viaPost.status, 200);
});

test('REAL BUNDLE + REAL CLIENT: another table\'s change set is the client\'s whatever its body holds — it goes out untouched', async () => {
  const { client, sent } = transport();
  const sdk = makeSdk(client);
  const text = handWritten('workflows', { name: { 1033: 'Probe' }, description: 7 });
  await sdk.dataverse.postBatch(text, 'batch_hand');
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].body, text);
});

test('REAL BUNDLE + REAL CLIENT: a change set that names the app module table and does not PATCH a row of it — the shape of the SDK\'s own app delete — goes out untouched', async () => {
  const { client, sent } = transport();
  const sdk = makeSdk(client);
  const { body, boundary } = renderChangeSet([{ method: 'DELETE', path: `/appmodules(${APP})`, etag: 'W/"1001"' }, { method: 'DELETE', path: '/sitemaps(22222222-3333-4444-5555-666666666666)', etag: 'W/"7"' }]);
  await sdk.dataverse.postBatch(body, boundary);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].body, body);
});

test('REAL BUNDLE + REAL CLIENT: a change set the guard cannot read, which names the app module table, is refused with the same typed error; one that does not name it is not read', async () => {
  const { client, sent, tokens } = transport();
  const sdk = makeSdk(client);
  const cut = handWritten('appmodules', { name: 'Probe' }).replace('--batch_hand--\r\n', '');
  await assert.rejects(sdk.dataverse.postBatch(cut, 'batch_hand'), (error) => {
    assertRefusal(error, 'a batch cut short');
    assert.match(error.message, /could not be read as a multipart batch \(the closing delimiter --batch_hand-- is missing\)/);
    return true;
  });
  await assert.rejects(sdk.dataverse.postBatch(handWritten('appmodules', { name: { 1: 'x' } }), 'batch_elsewhere'), (error) => assertRefusal(error, 'another boundary'));
  assert.deepStrictEqual([sent.length, tokens()], [0, 0]);
  const unrelated = handWritten('workflows', { name: 'Probe' }).replace('--batch_hand--\r\n', '');
  await sdk.dataverse.postBatch(unrelated, 'batch_hand');
  assert.strictEqual(sent.length, 1, 'a batch that is no business of the guard\'s goes to the client even when it is cut short');
});

// --- the SDK's own change set, read back ----------------------------------------------------------------------------------------------------------------

// What the platform answers a change set with: one part per operation, correlated by Content-ID.
const changeSetAnswer = ({ body }) => ({
  statusCode: 200,
  headers: {},
  body: [
    '--batchresponse_x', 'Content-Type: multipart/mixed; boundary=changesetresponse_x', '',
    ...[...String(body).matchAll(/^Content-ID: (\S+)$/gm)].flatMap(([, id]) => ['--changesetresponse_x', 'Content-Type: application/http', 'Content-Transfer-Encoding: binary', `Content-ID: ${id}`, '', 'HTTP/1.1 204 No Content', 'OData-Version: 4.0', '']),
    '--changesetresponse_x--', '--batchresponse_x--', '',
  ].join('\r\n'),
});

test('REAL BUNDLE + REAL CLIENT: the change set the SDK itself renders (createColumns) goes out untouched, is read back operation by operation, and is what the test renderer renders', async () => {
  const { readBatchRequest } = require('../lib/batch-request.js');
  const { client, sent } = transport(changeSetAnswer);
  const sdk = makeSdk(client);
  await sdk.createColumns('new_ticket', [{ schemaName: 'new_a', displayName: 'A', type: 'string' }, { schemaName: 'new_b', displayName: 'B', type: 'integer' }]);
  assert.strictEqual(sent.length, 1);
  const { body, headers } = sent[0];
  assert.match(headers['Content-Type'], /^multipart\/mixed;boundary=batch_[0-9a-f-]{36}$/);
  const read = readBatchRequest(body, headers['Content-Type']);
  assert.strictEqual(read.problem, undefined);
  const target = `${API}/EntityDefinitions(LogicalName='new_ticket')/Attributes`;
  assert.deepStrictEqual(read.operations.map((op) => [op.method, op.target, op.contentId, JSON.parse(op.body).SchemaName]), [['POST', target, '1', 'new_a'], ['POST', target, '2', 'new_b']]);
  // The renderer the other tests use renders the same bytes as the bundle does for the same operations (but for its random ids), so it cannot drift from the bundle unseen.
  const normalized = body.replace(/batch_[0-9a-f-]{36}/g, 'batch_test').replace(/changeset_[0-9a-f-]{36}/g, 'changeset_test');
  assert.strictEqual(normalized, renderChangeSet(read.operations.map((op) => ({ method: op.method, url: op.target, body: JSON.parse(op.body) }))).body);
});

// --- the SDK's own change set that names the app module table ----------------------------------------------------------------------------------------------

// The SDK deletes an app and its sitemap in ONE change set, each under the row token it read, and so sends a batch that names the app module table without writing its texts. The bare bundle and the
// bundle made through the factory (which has the guard) are run over the same fake platform: what the guard lets through must be what the bundle sends, byte for byte but for the ids it makes up.
const BUNDLE = path.resolve(__dirname, '..', 'vendor', 'cds-maker-sdk.cjs');
const DELETE_APP_UNIQUE_ID = '22222222-2222-2222-2222-222222222222';
const DELETE_SITEMAP_ID = '33333333-3333-3333-3333-333333333333';
async function deleteAppOver(sdkModule) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-header-transport-'));
  tempDirs.push(dir);
  const wire = [];
  const appRow = { appmoduleid: APP, appmoduleidunique: DELETE_APP_UNIQUE_ID, uniquename: 'co_supportdesk', name: 'Support Desk', '@odata.etag': 'W/"1001"' };
  const sitemapRow = { '@odata.etag': 'W/"2003"', sitemapid: DELETE_SITEMAP_ID, sitemapnameunique: 'co_supportdesk', sitemapxml: '<SiteMap></SiteMap>' };
  const ok = (body, headers = {}) => ({ statusCode: 200, headers, body: JSON.stringify(body) });
  const request = async (req) => {
    wire.push(req);
    const meta = /EntityDefinitions\(LogicalName='([^']+)'\)/.exec(req.url);
    if (meta) return ok({ LogicalName: meta[1], EntitySetName: `${meta[1]}s` });
    if (/\/\$batch$/.test(req.url)) return changeSetAnswer(req);
    if (/\/appmodules\([^)]+\)/.test(req.url)) return ok(appRow);
    if (/\/sitemaps\([^)]+\)/.test(req.url)) return ok({ sitemapid: DELETE_SITEMAP_ID }, { etag: 'W/"2002"' });
    if (req.url.includes('/sitemaps')) return ok({ value: [sitemapRow] });
    return ok({ value: [] });
  };
  const httpClient = createAzHttpClient(ENV, { getToken: () => 'OFFLINE_TEST_TOKEN', request, sleep: async () => {} });
  const sdk = sdkModule.createMakerSdk({ instanceUrl: ENV, httpClient, workspaceStorage: sdkModule.createNodeWorkspaceStorage(dir) });
  await sdk.initWorkspace();
  const result = await sdk.deleteAppCascade(APP, DELETE_APP_UNIQUE_ID);
  return { result, wire };
}
const withoutIds = (text) => String(text).replace(/batch_[0-9a-f-]{36}/g, 'batch_X').replace(/changeset_[0-9a-f-]{36}/g, 'changeset_X');

test('REAL BUNDLE + REAL CLIENT: the SDK\'s own app delete — a change set that names the app module table — goes out exactly as the bare bundle sends it, and is read as two conditional deletes', async () => {
  const { readBatchRequest } = require('../lib/batch-request.js');
  const bare = await deleteAppOver(require(BUNDLE));
  const guarded = await deleteAppOver(require('../lib/maker-sdk.js'));
  assert.strictEqual(bare.result.success, true, JSON.stringify(bare.result.failures));
  assert.strictEqual(guarded.result.success, true, JSON.stringify(guarded.result.failures));
  const traffic = ({ wire }) => wire.map((req) => [req.method, req.url, withoutIds(req.body), withoutIds(req.headers['Content-Type'])]);
  assert.deepStrictEqual(traffic(guarded), traffic(bare), 'the same requests, in the same order, with the same bytes');
  const batch = guarded.wire.find((req) => /\/\$batch$/.test(req.url));
  assert.ok(batch && /appmodules\(/.test(batch.body), 'the change set names the app module table');
  const read = readBatchRequest(batch.body, batch.headers['Content-Type']);
  assert.strictEqual(read.problem, undefined);
  assert.deepStrictEqual(read.operations.map((op) => [op.method, op.target.replace(API, ''), op.contentId, op.body]), [
    ['DELETE', `/appmodules(${APP})`, '1', ''],
    ['DELETE', `/sitemaps(${DELETE_SITEMAP_ID})`, '2', ''],
  ]);
  assert.match(batch.body, /If-Match: W\/"1001"/, 'each delete is conditional, as the SDK renders it');
});

// --- patchRaw ---------------------------------------------------------------------------------------------------------------------------------------------

test('REAL BUNDLE + REAL CLIENT: sdk.dataverse.patchRaw of the app module row with a text that is not plain sends nothing; a plain one and any other row go out with the bytes as they are', async () => {
  const { client, sent, tokens } = transport();
  const sdk = makeSdk(client);
  const json = { headers: { 'Content-Type': 'application/json' } };
  for (const [what, header] of REFUSED_HEADERS) {
    await assert.rejects(sdk.dataverse.patchRaw(`/appmodules(${APP})`, Buffer.from(JSON.stringify(header), 'utf8'), json), (error) => assertRefusal(error, what));
  }
  assert.deepStrictEqual([sent.length, tokens()], [0, 0]);
  const plain = Buffer.from(JSON.stringify({ name: 'Probe', description: 'Tickets' }), 'utf8');
  await sdk.dataverse.patchRaw(`/appmodules(${APP})`, plain, json);
  const file = Buffer.from('export default 1;', 'utf8');
  await sdk.dataverse.patchRaw(`/uxagentprojectfiles(${APP})/filecontent`, file, { headers: { 'Content-Type': 'application/octet-stream', 'If-Match': '*' } });
  assert.strictEqual(sent.length, 2);
  assert.deepStrictEqual(sent.map((s) => [s.method, s.url]), [['PATCH', `${API}/appmodules(${APP})`], ['PATCH', `${API}/uxagentprojectfiles(${APP})/filecontent`]]);
  assert.ok(Buffer.from(sent[0].body).equals(plain) && Buffer.from(sent[1].body).equals(file), 'the bytes are sent verbatim');
});

// --- a client that keeps its state in private fields ----------------------------------------------------------------------------------------------------

// A valid HttpClient is any object with the methods the SDK calls; this one is a class whose methods read private fields, so each fails on any receiver that is not an instance.
class RecordingClient {
  #requests;
  constructor(requests) { this.#requests = requests; }
  #send(method, url, body) {
    this.#requests.push({ method, url, body });
    return Promise.resolve({ status: method === 'GET' ? 200 : 204, headers: {}, body: method === 'GET' ? { LogicalName: 'account', EntitySetName: 'accounts', value: [] } : {} });
  }
  get(url) { return this.#send('GET', url); }
  patch(url, body) { return this.#send('PATCH', url, body); }
  post(url, body) { return this.#send('POST', url, body); }
  put(url, body) { return this.#send('PUT', url, body); }
  delete(url) { return this.#send('DELETE', url); }
  postRaw(url, body) { return this.#send('POST-RAW', url, body); }
  patchRaw(url, body) { return this.#send('PATCH-RAW', url, body); }
}

const CONTROLS = [
  ['a GET of another table', (sdk) => sdk.dataverse.get('/accounts'), 'GET'],
  ['a POST to another table', (sdk) => sdk.dataverse.post('/accounts', { name: 'Probe' }), 'POST'],
  ['a PUT to another table', (sdk) => sdk.dataverse.put(`/accounts(${APP})`, { name: 'Probe' }), 'PUT'],
  ['a DELETE of another table\'s row', (sdk) => sdk.dataverse.delete(`/accounts(${APP})`), 'DELETE'],
  ['a raw change set', (sdk) => sdk.dataverse.postBatch('--empty--', 'empty'), 'POST-RAW'],
  ['a raw PATCH', (sdk) => sdk.dataverse.patchRaw(`/accounts(${APP})/entityimage`, Buffer.from('x'), {}), 'PATCH-RAW'],
  ['updateRecord of another table', (sdk) => sdk.updateRecord('account', APP, { name: 'Probe' }), 'PATCH'],
  ['a PATCH of an app header with plain texts', (sdk) => sdk.dataverse.patch(`/appmodules(${APP})`, { name: 'Probe', description: 'Tickets' }), 'PATCH'],
  ['a healthy header change set', (sdk) => sdk.dataverse.postBatch(handWritten('appmodules', { name: 'Probe', description: 'Tickets' }), 'batch_hand'), 'POST-RAW'],
];
for (const [what, run, method] of CONTROLS) {
  test(`REAL BUNDLE: a client that keeps private state works through the guard — ${what}`, async () => {
    const requests = [];
    const sdk = makeSdk(new RecordingClient(requests));
    await run(sdk);
    assert.ok(requests.some((r) => r.method === method), `the client received ${method}: ${JSON.stringify(requests.map((r) => r.method))}`);
  });
}

test('REAL BUNDLE: in front of such a client the guard still refuses, and the client is not asked', async () => {
  const requests = [];
  const sdk = makeSdk(new RecordingClient(requests));
  await assert.rejects(sdk.dataverse.patch(`/appmodules(${APP})`, { name: { 1033: 'Probe' } }), (error) => assertRefusal(error, 'a PATCH'));
  await assert.rejects(sdk.dataverse.postBatch(handWritten('appmodules', { name: { 1033: 'Probe' } }), 'batch_hand'), (error) => assertRefusal(error, 'a change set'));
  await assert.rejects(sdk.dataverse.patchRaw(`/appmodules(${APP})`, Buffer.from('{"description":7}'), {}), (error) => assertRefusal(error, 'a raw PATCH'));
  assert.deepStrictEqual(requests, []);
  assert.strictEqual(sdk.dataverse.supportsAtomicBatch, true, 'the SDK still reads the client\'s postRaw');
  assert.strictEqual(sdk.dataverse.supportsBinaryPatch, true, 'and its patchRaw');
});

test('REAL BUNDLE: a client without postRaw and patchRaw stays without them — the SDK reads their absence', () => {
  const bare = { get: async () => ({ status: 200, headers: {}, body: {} }), post: async () => ({}), patch: async () => ({}), delete: async () => ({}) };
  const sdk = makeSdk(bare);
  assert.strictEqual(sdk.dataverse.supportsAtomicBatch, false);
  assert.strictEqual(sdk.dataverse.supportsBinaryPatch, false);
});

// The transport sends the path `new URL(address)` makes of an address, which resolves dot segments and their `%2e` spellings and reads `\` as `/`: an address that spells the batch endpoint or
// an app module's row that way reaches the same endpoint, so it is read the same way and refused the same way — and the canonical spelling of a healthy request still goes out.
test('REAL BUNDLE + REAL CLIENT: an address that reaches the batch endpoint or an app module row through dot segments, %2e or a backslash is refused like the canonical one', async () => {
  const { client, sent, tokens } = transport();
  const sdk = makeSdk(client);
  const header = { name: { 1033: 'Probe', 1036: 'Sonde' }, description: 'Tickets' };
  const options = { headers: { 'Content-Type': 'multipart/mixed;boundary=batch_hand' } };
  for (const suffix of ['/.', '/%2e', '/child/..', '/%2E/', '\\']) {
    await assert.rejects(sdk.dataverse.post(`/$batch${suffix}`, handWritten('appmodules', header), options), (error) => assertRefusal(error, `$batch${suffix}`));
    await assert.rejects(sdk.dataverse.patch(`/appmodules(${APP})${suffix}`, header, { headers: { 'If-Match': 'W/"1"' } }), (error) => assertRefusal(error, `appmodules(…)${suffix}`));
  }
  assert.deepStrictEqual([sent.length, tokens()], [0, 0], 'nothing reached the wire, and the token was never asked for');
  await sdk.dataverse.patch(`/appmodules(${APP})/.`, { name: 'Probe', description: 'Tickets' }, { headers: { 'If-Match': 'W/"1"' } });
  assert.strictEqual(sent.length, 1, 'a plain header through the same spelling goes out');
});
