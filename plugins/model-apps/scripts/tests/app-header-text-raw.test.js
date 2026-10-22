'use strict';
// lib/app-header-text.js — the ways an app's header can be written that are not the SDK's own `patch`, and how the guard stands between the SDK and its client.
//
// The SDK writes through more than one door. Its `dataverse.postBatch(body, boundary)` sends a change set the CALLER rendered, through the client's `postRaw`; its `dataverse.post`
// sends text as it is; its `dataverse.patchRaw` sends bytes. A PATCH of an app module row that rides in any of them is the same write as a `patch` of it, so a name or description that
// is not a string must not leave the process that way either — and a change set the guard cannot read must not be sent as long as it names the table, because the guard exists to say
// what a request writes. The guard also must not change what it does not judge: every other method and accessor of the client runs on the client itself (a client whose methods keep
// private state breaks on any other receiver), and a request it has nothing to say about reaches the client with the very arguments it was given.
// The same over the real bundle and the plugin's own HTTP client is in app-header-text-transport.test.js; the reading of the batch itself is in batch-request.test.js.
const test = require('node:test');
const assert = require('node:assert');
const { guardAppHeaderWrites, APP_HEADER_NOT_PLAIN_TEXT } = require('../lib/app-header-text.js');
const { API, APP, renderChangeSet, renderDocumentedBatch } = require('./helpers/batch-bodies.js');

const BATCH = `${API}/$batch`;
const ROW = `${API}/appmodules(${APP})`;
const OTHER = '22222222-3333-4444-5555-666666666666';
const localized = { 1033: 'Probe', 1036: 'Sonde' };
// What the SDK's postBatch hands the client: the multipart Content-Type, with the boundary it was given, in the options.
const mixed = (boundary = 'batch_test') => ({ headers: { 'Content-Type': `multipart/mixed;boundary=${boundary}` } });
const PLAIN = { name: 'Help Desk', description: 'Track tickets' };

// A client that records what it is asked and answers like the plugin's, with every method the SDK may use on a client.
function rawClient() {
  const calls = [];
  const answer = { status: 200, headers: {}, body: '--batchresponse_x--' };
  const client = {};
  for (const verb of ['get', 'post', 'patch', 'put', 'delete', 'postRaw', 'patchRaw']) client[verb] = async (...args) => { calls.push({ verb, args }); return answer; };
  return { client, calls, answer };
}

// The refusal is the one a PATCH gets: an error the caller's factory makes, typed, marked never to be run again on its own — and the client is never asked.
async function assertRefused(send, message) {
  const { client, calls } = rawClient();
  const made = [];
  const guarded = guardAppHeaderWrites(client, (code, text) => { const error = Object.assign(new Error(text), { code }); made.push(error); return error; });
  await assert.rejects(send(guarded), (e) => {
    assert.strictEqual(e, made[0], 'the error the factory made');
    assert.strictEqual(e.code, APP_HEADER_NOT_PLAIN_TEXT);
    assert.strictEqual(e.transient, false, 'the build\'s own re-run of a halt it takes for transient reads this marker on the error');
    if (message) assert.match(e.message, message);
    return true;
  });
  assert.deepStrictEqual(calls, [], 'the client was not asked, so no token was either');
}

// What the guard has nothing to say about reaches the client as it was: the very arguments, three of them as the SDK passes them, and the client's own answer back.
async function assertPassedOn(verb, args) {
  const { client, calls, answer } = rawClient();
  const guarded = guardAppHeaderWrites(client);
  assert.strictEqual(await guarded[verb](...args), answer, 'the client\'s own answer');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].verb, verb);
  assert.strictEqual(calls[0].args.length, 3);
  args.forEach((arg, index) => assert.strictEqual(calls[0].args[index], arg, `argument ${index} is the very one that was handed over`));
}

const rowPatch = (header, extra = {}) => ({ method: 'PATCH', path: `/appmodules(${APP})`, body: header, etag: 'W/"1"', ...extra });

// --- a change set that PATCHes an app module row ----------------------------------------------------------------------------------------------------------

const NOT_PLAIN = [
  ['a text per language', { name: localized, description: 'Tickets' }],
  ['a number', { name: 'Probe', description: 7 }],
  ['a list', { name: ['Probe'], description: 'Tickets' }],
  ['null', { name: 'Probe', description: null }],
  ['a boolean', { name: true }],
  ['an empty object', { name: 'Probe', description: {} }],
];
for (const verb of ['postRaw', 'post']) {
  for (const [what, header] of NOT_PLAIN) {
    test(`${verb}: a change set whose PATCH of an app module row carries ${what} is refused before the client is asked — the same typed error, nothing re-runs on its own`, async () => {
      const { body, boundary } = renderChangeSet([rowPatch(header)], { solution: 'Probe' });
      await assertRefused((guarded) => guarded[verb](BATCH, body, mixed(boundary)), /^Refused before anything was sent: a \$batch request would have written app 11111111-2222-3333-4444-555555555555's header with a text that is not plain — the app's (name|description) /);
    });
  }
}

test('the refusal names the app, both texts when both are not plain, that nothing in the batch was sent, and what to send instead', async () => {
  const { body, boundary } = renderChangeSet([{ method: 'DELETE', path: `/sitemaps(${APP})` }, rowPatch({ name: localized, description: ['Tickets'] })]);
  await assertRefused((guarded) => guarded.postRaw(BATCH, body, mixed(boundary)), /^Refused before anything was sent: a \$batch request would have written app 11111111-2222-3333-4444-555555555555's header with a text that is not plain — the app's name is localized \(2 languages: 1033, 1036\) and its description could not be read as plain text \(it came back as a list\)\. Nothing in the batch was sent, so no operation in it ran\. Send the app's name and description as plain text\.$/);
});

// The same write, however the batch is laid out and the row is addressed. Each is a batch the service reads as a PATCH of an app module row.
const LAYOUTS = [
  ['it is the second of three operations, between a write to another table and a delete', () => renderChangeSet([{ method: 'PATCH', path: `/sitemaps(${APP})`, body: { sitemapxml: '<SiteMap />' }, etag: 'W/"2"' }, rowPatch({ name: localized }), { method: 'DELETE', path: `/appmodulecomponents(${OTHER})` }], { solution: 'Probe' })],
  ['it is written the way the platform documents a batch (a quoted boundary, a blank line before each delimiter)', () => renderDocumentedBatch({ changeSets: [[{ method: 'PATCH', target: ROW, contentId: '1', body: { name: localized } }]] })],
  ['it is in the second change set of the batch', () => renderDocumentedBatch({ changeSets: [[{ method: 'POST', target: '/api/data/v9.2/tasks', contentId: '1', body: { subject: 's' } }], [{ method: 'PATCH', target: ROW, contentId: '2', body: { description: 7 } }]] })],
  ['it is a request outside any change set', () => renderDocumentedBatch({ changeSets: [], singles: [{ method: 'GET', target: '/api/data/v9.2/accounts' }, { method: 'PATCH', target: ROW, body: { name: localized } }] })],
  ['its address is relative to the service root', () => renderDocumentedBatch({ changeSets: [[{ method: 'PATCH', target: `appmodules(${APP})`, body: { name: localized } }]] })],
  ['its address is relative to the host', () => renderDocumentedBatch({ changeSets: [[{ method: 'PATCH', target: `/api/data/v9.2/appmodules(${APP})`, body: { name: localized } }]] })],
  ['its table name is escaped (%61 is "a")', () => renderDocumentedBatch({ changeSets: [[{ method: 'PATCH', target: `${API}/%61ppmodules(${APP})`, body: { name: localized } }]] })],
  ['its table name is in another case', () => renderDocumentedBatch({ changeSets: [[{ method: 'PATCH', target: `${API}/AppModules(${APP.toUpperCase()})`, body: { name: localized } }]] })],
  ['its row is named by an alternate key', () => renderDocumentedBatch({ changeSets: [[{ method: 'PATCH', target: `${API}/appmodules(uniquename='new_probe')`, body: { name: localized } }]] })],
  ['its address has a query string', () => renderDocumentedBatch({ changeSets: [[{ method: 'PATCH', target: `${ROW}?$select=appmoduleid`, body: { name: localized } }]] })],
  ['its method is spelled in lower case', () => renderDocumentedBatch({ changeSets: [[{ method: 'patch', target: ROW, body: { name: localized } }]] })],
  ['its body is pretty-printed JSON', () => renderDocumentedBatch({ changeSets: [[{ method: 'PATCH', target: ROW, body: '\n{\n  "name": {\n    "1033": "Probe"\n  },\n  "description": "Tickets"\n}\n' }]] })],
  ['the batch has bare line feeds', () => renderDocumentedBatch({ changeSets: [[{ method: 'PATCH', target: ROW, body: { name: localized } }]] }, { eol: '\n' })],
  ['it follows the create of the app in the same change set and addresses it by its Content-ID', () => renderDocumentedBatch({ changeSets: [[{ method: 'POST', target: `${API}/appmodules`, contentId: '1', body: { name: 'Probe', uniquename: 'new_probe' } }, { method: 'PATCH', target: '$1', contentId: '2', body: { description: ['x'] } }]] })],
];
for (const [what, render] of LAYOUTS) {
  test(`a change set is refused when ${what}`, async () => {
    const batch = render();
    const options = batch.contentType ? { headers: { 'content-type': batch.contentType } } : mixed(batch.boundary);
    await assertRefused((guarded) => guarded.postRaw(BATCH, batch.body, options), /would have written app .+'s header with a text that is not plain/);
  });
}

test('a change set is refused with no Content-Type in the options too: the batch then opens with its own delimiter', async () => {
  const { body } = renderChangeSet([rowPatch({ name: localized })]);
  await assertRefused((guarded) => guarded.postRaw(BATCH, body), /would have written app/);
  await assertRefused((guarded) => guarded.post(BATCH, body, undefined), /would have written app/);
  await assertRefused((guarded) => guarded.postRaw(BATCH, body, { headers: {} }), /would have written app/);
});

test('bytes are read as the UTF-8 they spell: a client that sends a Buffer verbatim is guarded too', async () => {
  const { body, boundary } = renderChangeSet([rowPatch({ name: localized })]);
  await assertRefused((guarded) => guarded.postRaw(BATCH, Buffer.from(body, 'utf8'), mixed(boundary)), /would have written app/);
  await assertRefused((guarded) => guarded.postRaw(BATCH, new Uint8Array(Buffer.from(body, 'utf8')), mixed(boundary)), /would have written app/);
  const plain = renderChangeSet([rowPatch(PLAIN)]);
  await assertPassedOn('postRaw', [BATCH, Buffer.from(plain.body, 'utf8'), mixed(plain.boundary)]);
});

test('the address of the batch may be written the way the service reads it: any case, escaped, with a query string or a trailing slash, as text or as a URL object', async () => {
  const { body, boundary } = renderChangeSet([rowPatch({ name: localized })]);
  for (const url of [`${API}/$BATCH`, `${API}/%24batch`, `${API}/$batch?x=1`, `${API}/$batch/`, new URL(BATCH), '/$batch']) {
    await assertRefused((guarded) => guarded.postRaw(url, body, mixed(boundary)), /would have written app/);
  }
});

// --- a change set that is passed on as it is -------------------------------------------------------------------------------------------------------------

const HEALTHY = [
  ['both texts are strings', PLAIN],
  ['the description is the empty string', { name: 'Help Desk', description: '' }],
  ['only one text is written', { description: 'Only the description' }],
  ['a text is absent or undefined', { name: 'Help Desk', description: undefined }],
  ['a routing description is beside them', { ...PLAIN, aiappdescription: 'Route tickets here.' }],
  ['the body has no header text', { aiappdescription: 'Route tickets here.' }],
];
for (const verb of ['postRaw', 'post']) {
  for (const [what, header] of HEALTHY) {
    test(`${verb}: a change set that PATCHes an app module row where ${what} goes on exactly as it is`, async () => {
      const { body, boundary } = renderChangeSet([rowPatch(header), { method: 'DELETE', path: `/appmodulecomponents(${OTHER})`, etag: 'W/"3"' }], { solution: 'Probe' });
      const options = mixed(boundary);
      await assertPassedOn(verb, [BATCH, body, options]);
    });
  }
}

test('a change set of another table is the client\'s whatever its bodies hold — a name that is a map is no business of the app header\'s guard', async () => {
  const { body, boundary } = renderChangeSet([
    { method: 'PATCH', path: `/workflows(${APP})`, body: { name: localized, description: ['x'] }, etag: 'W/"1"' },
    { method: 'PATCH', path: `/savedqueries(${APP})`, body: { name: 7 }, etag: 'W/"1"' },
    { method: 'POST', path: '/systemforms', body: { name: { x: 1 } } },
  ]);
  await assertPassedOn('postRaw', [BATCH, body, mixed(boundary)]);
  await assertPassedOn('post', [BATCH, body, mixed(boundary)]);
});

test('a change set that names the app module table without PATCHing a row of it is the client\'s: the SDK\'s own app delete, a create, a read, a PUT, a sub-resource, another component table', async () => {
  const notPlain = { name: localized, description: ['x'] };
  const shapes = [
    renderChangeSet([{ method: 'DELETE', path: `/appmodules(${APP})`, etag: 'W/"7"' }, { method: 'DELETE', path: `/sitemaps(${OTHER})`, etag: 'W/"8"' }]),
    renderChangeSet([{ method: 'POST', path: '/appmodules', body: notPlain }]),
    renderChangeSet([{ method: 'PUT', path: `/appmodules(${APP})`, body: notPlain }]),
    renderChangeSet([{ method: 'PATCH', path: `/appmodules(${APP})/appmodule_something`, body: notPlain }]),
    renderChangeSet([{ method: 'PATCH', path: `/appmodulecomponents(${APP})`, body: notPlain }]),
    renderChangeSet([{ method: 'PATCH', path: '/appmodules', body: notPlain }]),
    renderChangeSet([{ method: 'PATCH', path: `/appmodule(${APP})`, body: notPlain }]),
    renderDocumentedBatch({ singles: [{ method: 'GET', target: `/api/data/v9.2/appmodules(${APP})?$select=name` }] }),
    // A PATCH of an app module row with no body writes no text.
    renderChangeSet([{ method: 'PATCH', path: `/appmodules(${APP})`, etag: 'W/"1"' }]),
    // A body that is not an object has no `name` to be wrong.
    renderChangeSet([{ method: 'PATCH', path: `/appmodules(${APP})`, rawBody: '[1,2]', contentType: 'application/json', etag: 'W/"1"' }]),
    // A reference to a row that is not an app module.
    renderDocumentedBatch({ changeSets: [[{ method: 'POST', target: `${API}/workflows`, contentId: '1', body: { name: 'w' } }, { method: 'PATCH', target: '$1', contentId: '2', body: { name: localized } }, { method: 'DELETE', target: ROW, contentId: '3' }]] }),
  ];
  for (const shape of shapes) await assertPassedOn('postRaw', [BATCH, shape.body, shape.contentType ? { headers: { 'Content-Type': shape.contentType } } : mixed(shape.boundary)]);
});

test('a text of the body that only looks like a request is data: a page file that mentions the table, with a line that reads as a PATCH of one, is not a PATCH of it', async () => {
  const content = ['// the page reads the app module table', `PATCH ${ROW} HTTP/1.1`, '', `{"name":{"1033":"x"}}`, '--changeset_other', 'Content-Type: application/http'].join('\r\n');
  const { body, boundary } = renderChangeSet([
    { method: 'PATCH', path: `/uxagentprojectfiles(${APP})/filecontent`, rawBody: content, contentType: 'text/plain', etag: '*' },
    { method: 'PATCH', path: `/appmodules(${APP})`, body: PLAIN, etag: 'W/"1"' },
  ]);
  await assertPassedOn('postRaw', [BATCH, body, mixed(boundary)]);
});

test('what does not name the app module table is not read at all: a body that is no batch, a batch cut short, no body, no options', async () => {
  const cut = renderChangeSet([{ method: 'PATCH', path: `/workflows(${APP})`, body: { name: localized }, etag: 'W/"1"' }]).body.replace(/--batch_test--\r\n$/, '');
  for (const body of ['this is not a batch', '{"requests":[]}', '', cut, '--only a delimiter']) await assertPassedOn('postRaw', [BATCH, body, mixed()]);
  for (const verb of ['postRaw', 'post']) {
    await assertPassedOn(verb, [BATCH, undefined, undefined]);
    await assertPassedOn(verb, [BATCH, null, { headers: {} }]);
  }
});

test('only a request to the batch endpoint is read: the same text anywhere else is the client\'s', async () => {
  const text = 'not a batch, but it names appmodules(11111111-2222-3333-4444-555555555555)';
  for (const url of [`${API}/appmodules`, `${API}/$batcher`, `${API}/other/$batch/more`, `${API}/accounts?$batch=1`, `${API}/accounts?x=/$batch`]) {
    await assertPassedOn('postRaw', [url, text, mixed()]);
    await assertPassedOn('post', [url, { name: localized }, undefined]);
  }
});

// --- a change set the guard cannot read, which names the table ------------------------------------------------------------------------------------------------

// The guard says what a request writes by reading it as the service does. A request it cannot read cannot be told from the write it exists to stop, so while it names the table it is
// refused with the same typed error; one that does not name the table is not its business (above).
const GOOD = renderChangeSet([rowPatch(PLAIN)]);
const UNREADABLE = [
  ['it is cut short (no closing delimiter)', GOOD.body.replace(/--batch_test--\r\n$/, ''), mixed(), /closing delimiter --batch_test-- is missing/],
  ['its change set is cut short', GOOD.body.replace('--changeset_test--\r\n', ''), mixed(), /--changeset_test-- is missing/],
  ['its delimiters are not the ones its Content-Type declares', GOOD.body, mixed('batch_elsewhere'), /no delimiter line --batch_elsewhere/],
  ['its Content-Type declares no boundary', GOOD.body, { headers: { 'Content-Type': 'application/json' } }, /declares no boundary/],
  ['it is a JSON batch', JSON.stringify({ requests: [{ id: '1', method: 'PATCH', url: `appmodules(${APP})`, body: { name: localized } }] }), { headers: { 'Content-Type': 'application/json' } }, /declares no boundary/],
  ['it is a JSON batch that spells the table with an escape', '{"requests":[{"id":"1","method":"PATCH","url":"\\u0061ppmodules(1)","body":{"name":{"1033":"x"}}}]}', undefined, /declares no boundary/],
  ['a part declares no content type', GOOD.body.replace('Content-Type: application/http\r\n', ''), mixed(), /declares no content type/],
  ['a part is something other than a request', GOOD.body.replace('Content-Type: application/http', 'Content-Type: text/plain'), mixed(), /text\/plain/],
  ['a part is encoded', GOOD.body.replace('Content-Transfer-Encoding: binary', 'Content-Transfer-Encoding: base64'), mixed(), /base64/],
  ['a change set holds another change set', ['--batch_test', 'Content-Type: multipart/mixed;boundary=c1', '', '--c1', 'Content-Type: multipart/mixed;boundary=c2', '', '--c2', 'Content-Type: application/http', '', `PATCH ${ROW} HTTP/1.1`, '', '{"name":{"1":"x"}}', '--c2--', '--c1--', '--batch_test--', ''].join('\r\n'), mixed(), /not a request/],
  ['another batch follows the closing delimiter', `${GOOD.body}--batch_test\r\nContent-Type: application/http\r\n\r\nPATCH ${ROW} HTTP/1.1\r\n\r\n{"name":{"1":"x"}}\r\n--batch_test--\r\n`, mixed(), /follows the closing delimiter/],
  ['a request line is not one', GOOD.body.replace(/PATCH \S+ HTTP\/1\.1/, `PATCH ${ROW}`), mixed(), /request line/],
  ['a part has no empty line after its headers', '--batch_test\r\nContent-Type: application/http\r\n--batch_test--\r\n' + `// ${ROW}`, mixed(), /no empty line/],
];
for (const verb of ['postRaw', 'post']) {
  for (const [what, body, options, reason] of UNREADABLE) {
    test(`${verb}: a batch that names the app module table is refused when ${what}, and the reason is in the message`, async () => {
      await assertRefused((guarded) => guarded[verb](BATCH, body, options), new RegExp(`^Refused before anything was sent: a \\$batch request that names the app module table could not be read as a multipart batch \\([^)]*${reason.source}[^)]*\\), so it cannot be told from one that writes an app's name or description as something that is not plain text\\. Nothing was sent\\. `));
    });
  }
}

test('a PATCH of an app module row whose body the guard cannot read as JSON is refused: it cannot be told from one whose texts are not plain', async () => {
  const unreadable = ['{"name":{"1033":"x"}', '\uFEFF{"name":{"1033":"x"}}', '{"name":{"1033":"x"}}{"name":"y"}', 'name=Probe', '{name: 1}'];
  for (const content of unreadable) {
    const { body, boundary } = renderChangeSet([{ method: 'PATCH', path: `/appmodules(${APP})`, rawBody: content, contentType: 'application/json', etag: 'W/"1"' }]);
    await assertRefused((guarded) => guarded.postRaw(BATCH, body, mixed(boundary)), /^Refused before anything was sent: a \$batch request would have written app 11111111-2222-3333-4444-555555555555's header with a body that is not JSON this plugin can read, so it cannot be told from one whose name or description is not plain text\. Nothing was sent\.$/);
  }
});

// --- a raw PATCH of the row -----------------------------------------------------------------------------------------------------------------------------

test('patchRaw: a PATCH of an app module row whose bytes carry a text that is not plain is refused; its address is read as a PATCH\'s is', async () => {
  const bytes = (value) => Buffer.from(JSON.stringify(value), 'utf8');
  const options = { headers: { 'Content-Type': 'application/json' } };
  await assertRefused((guarded) => guarded.patchRaw(ROW, bytes({ name: localized, description: 'Tickets' }), options), /^Refused before anything was sent: a raw PATCH would have written app 11111111-2222-3333-4444-555555555555's header with a text that is not plain — the app's name is localized \(2 languages: 1033, 1036\)\. Nothing was sent\. Send the app's name and description as plain text\.$/);
  await assertRefused((guarded) => guarded.patchRaw(`${ROW}?$select=appmoduleid`, bytes({ description: 7 }), options), /the app's description could not be read as plain text \(it came back as a number\)/);
  await assertRefused((guarded) => guarded.patchRaw(`/api/data/v9.0/%61ppmodules(${APP})`, new Uint8Array(bytes({ name: ['x'] })), options), /would have written app/);
  await assertRefused((guarded) => guarded.patchRaw(ROW, JSON.stringify({ name: localized }), options), /would have written app/);
  await assertRefused((guarded) => guarded.patchRaw(ROW, Buffer.from('{"name":', 'utf8'), options), /with a body that is not JSON this plugin can read/);
  for (const body of [bytes(PLAIN), bytes({}), Buffer.alloc(0), undefined, null, bytes([1])]) await assertPassedOn('patchRaw', [ROW, body, options]);
  // A file column of the row, any other row, and a PATCH of the table without a row are not a write of the header's texts.
  const file = Buffer.from('not a header', 'utf8');
  for (const url of [`${ROW}/appmodule_icon`, `${API}/uxagentprojectfiles(${APP})/filecontent`, `${API}/workflows(${APP})`, `${API}/appmodules`]) await assertPassedOn('patchRaw', [url, bytes({ name: localized }), options]);
  await assertPassedOn('patchRaw', [`${API}/uxagentprojectfiles(${APP})/filecontent`, file, { headers: { 'Content-Type': 'application/octet-stream', 'If-Match': '*' } }]);
});

// --- the receiver of every other member ------------------------------------------------------------------------------------------------------------------

// A valid HttpClient may be a class whose methods and accessors keep their state in private fields. Such a method runs only on an instance of the class, so the guard must call
// every member on the client itself — not on an object that merely inherits from it.
class PrivateStateClient {
  #calls = [];
  #answer = { status: 204, headers: {}, body: {} };
  get recorded() { return this.#calls; }
  get supportsAtomicBatch() { return this.#calls.length >= 0; }
  #record(verb, args) { this.#calls.push({ verb, args }); return this.#answer; }
  async get(...args) { return this.#record('get', args); }
  async post(...args) { return this.#record('post', args); }
  async patch(...args) { return this.#record('patch', args); }
  async put(...args) { return this.#record('put', args); }
  async delete(...args) { return this.#record('delete', args); }
  async postRaw(...args) { return this.#record('postRaw', args); }
  async patchRaw(...args) { return this.#record('patchRaw', args); }
}

test('a client whose methods and accessors keep private state is driven through the guard: every verb runs on the client, so none fails its brand check', async () => {
  const client = new PrivateStateClient();
  const guarded = guardAppHeaderWrites(client);
  const batch = renderChangeSet([rowPatch(PLAIN)]);
  const calls = [
    ['get', [`${API}/accounts`, undefined]], ['post', [`${API}/accounts`, { name: 'x' }, undefined]], ['put', [`${API}/accounts(${APP})`, { name: 'x' }, undefined]],
    ['delete', [`${API}/accounts(${APP})`, undefined]], ['patch', [ROW, PLAIN, undefined]], ['patch', [`${API}/accounts(${APP})`, { name: 'x' }, undefined]],
    ['postRaw', [BATCH, batch.body, mixed(batch.boundary)]], ['postRaw', [`${API}/other`, 'text', undefined]], ['patchRaw', [ROW, Buffer.from(JSON.stringify(PLAIN)), undefined]],
    ['patchRaw', [`${API}/uxagentprojectfiles(${APP})/filecontent`, Buffer.from('x'), undefined]], ['post', [BATCH, batch.body, mixed(batch.boundary)]],
  ];
  for (const [verb, args] of calls) assert.ok(await guarded[verb](...args), verb);
  assert.deepStrictEqual(client.recorded.map((c) => c.verb), calls.map(([verb]) => verb));
  assert.strictEqual(guarded.recorded, client.recorded, 'an accessor is read on the client');
  assert.strictEqual(guarded.supportsAtomicBatch, true);
  assert.ok(guarded instanceof PrivateStateClient, 'it is still an instance of the client\'s class, as it was when the guard inherited from the client');
  // The guard still stops what it exists to stop, in front of such a client.
  await assert.rejects(guarded.patch(ROW, { name: localized }), (e) => e.code === APP_HEADER_NOT_PLAIN_TEXT);
  await assert.rejects(guarded.postRaw(BATCH, renderChangeSet([rowPatch({ name: localized })]).body, mixed('batch_test')), (e) => e.code === APP_HEADER_NOT_PLAIN_TEXT);
  assert.strictEqual(client.recorded.length, calls.length, 'and nothing of it reached the client');
});

test('every member of the client runs with the client as its receiver, the ones the guard judges and the ones it does not', async () => {
  const receivers = [];
  const client = {};
  for (const verb of ['get', 'post', 'patch', 'put', 'delete', 'postRaw', 'patchRaw']) client[verb] = function seen() { receivers.push([verb, this]); return Promise.resolve(verb); };
  Object.defineProperty(client, 'accessor', { get() { receivers.push(['accessor', this]); return 'read'; }, enumerable: true });
  client.helper = function helper() { receivers.push(['helper', this]); return 'helped'; };
  const guarded = guardAppHeaderWrites(client);
  for (const verb of ['get', 'post', 'patch', 'put', 'delete', 'postRaw', 'patchRaw']) assert.strictEqual(await guarded[verb](`${API}/accounts`, undefined, undefined), verb);
  assert.strictEqual(guarded.accessor, 'read');
  assert.strictEqual(guarded.helper(), 'helped');
  assert.strictEqual(receivers.length, 9);
  for (const [member, receiver] of receivers) assert.strictEqual(receiver, client, `${member} ran on the client`);
});

test('a member the client lacks is still lacking, one it gains or is given later is seen, and a frozen client is guarded', async () => {
  const { client, calls } = rawClient();
  delete client.postRaw;
  delete client.patchRaw;
  const guarded = guardAppHeaderWrites(client);
  for (const member of ['postRaw', 'patchRaw']) {
    assert.strictEqual(guarded[member], undefined, `the SDK reads the absence of ${member}`);
    assert.strictEqual(member in guarded, false);
  }
  assert.strictEqual('post' in guarded, true);
  client.postRaw = async (...args) => { calls.push({ verb: 'postRaw', args }); return 'raw'; };
  assert.strictEqual(typeof guarded.postRaw, 'function', 'a member it gains later is seen');
  assert.strictEqual(await guarded.postRaw(`${API}/other`, 'b'), 'raw');
  const batch = renderChangeSet([rowPatch({ name: localized })]);
  await assert.rejects(guarded.postRaw(BATCH, batch.body, mixed(batch.boundary)), (e) => e.code === APP_HEADER_NOT_PLAIN_TEXT, 'and it is guarded');
  client.post = async () => 'replaced';
  assert.strictEqual(await guarded.post(`${API}/accounts`, {}), 'replaced', 'a method that is replaced after the wrap is the one that runs');
  const frozen = Object.freeze({ get: async () => 'g', patch: async () => 'p', post: async () => 'q', postRaw: async () => 'r', patchRaw: async () => 's' });
  const guardedFrozen = guardAppHeaderWrites(frozen);
  assert.strictEqual(Object.getPrototypeOf(guardedFrozen), Object.prototype, 'the prototype it reports is the client\'s');
  assert.deepStrictEqual([await guardedFrozen.get('u'), await guardedFrozen.post(`${API}/accounts`, {}), await guardedFrozen.postRaw(`${API}/other`, 'x'), await guardedFrozen.patchRaw(`${API}/other`, 'x')], ['g', 'q', 'r', 's']);
  await assert.rejects(guardedFrozen.postRaw(BATCH, batch.body, mixed(batch.boundary)), (e) => e.code === APP_HEADER_NOT_PLAIN_TEXT);
});

test('what a caller layers on top of a guarded client keeps the guard, and a guarded client is never guarded again', async () => {
  const { client, calls } = rawClient();
  const once = guardAppHeaderWrites(client);
  assert.strictEqual(guardAppHeaderWrites(once), once);
  const layered = Object.assign(Object.create(once), { get: async () => 'layer' });
  assert.strictEqual(guardAppHeaderWrites(layered), layered);
  const batch = renderChangeSet([rowPatch({ name: localized })]);
  await assert.rejects(layered.postRaw(BATCH, batch.body, mixed(batch.boundary)), (e) => e.code === APP_HEADER_NOT_PLAIN_TEXT);
  assert.strictEqual(await layered.get('u'), 'layer');
  assert.deepStrictEqual(calls, []);
});
