'use strict';
// lib/sdk-http-client.js — the access token is taken out of what a service or a transport says before it can become an SDK message. The SDK turns an answer that is not
// a success into a `ConnectionError` that QUOTES the body, and the scripts print that message, so an authorization layer or a gateway that repeats the token it rejected — whole
// or in part — would print it. The Power Apps client has always done this for its own answers (tests/power-apps-service-client.test.js); this is the same, shared, rule for the
// Dataverse client, with one difference that is the point of its tests: the bytes of a SUCCESS are the caller's data and are never touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createAzHttpClient, scrub, scrubAnswer, completeBatchStatus } = require('../lib/sdk-http-client.js');

const ORIGIN = 'https://contoso.crm.dynamics.com';
const API = `${ORIGIN}/api/data/v9.0`;
// A token the way Azure issues one — three base64url parts joined by dots — and synthetic: every part is at least 24 characters, so each is taken out on its own.
const PARTS = ['syntheticHeaderPartNotARealCredential', 'syntheticPayloadPartNotARealCredential', 'syntheticSignaturePartNotARealCredential'];
const TOKEN = PARTS.join('.');
const OLD_TOKEN = ['syntheticOldHeaderNotARealCredentialAAA', 'syntheticOldPayloadNotARealCredentialBBB', 'syntheticOldSignatureNotARealCredentialCC'].join('.');
const GUID = '11111111-1111-4111-8111-111111111111';

const answer = (statusCode, body, headers = {}) => ({ statusCode, headers, body: typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body) });
// The client over a transport that answers in turn (`answers`: a response or a function of the request); `tokens` are what `getToken` gives, in order — the last one again after that.
// `once` is a client that sends every request once (as solution-settings.js's does for its long actions), for an answer the plain client would send again: a 401, a 429 or a 5xx.
function clientOver(answers, tokens = [TOKEN], { once = false } = {}) {
  const sent = [];
  const reads = [];
  const client = createAzHttpClient(ORIGIN, {
    getToken: (origin, options) => { reads.push(options); return tokens[Math.min(reads.length - 1, tokens.length - 1)]; },
    sleep: async () => {},
    ...(once ? { sendOnce: () => true } : {}),
    request: async (options) => {
      sent.push(options);
      const next = answers.shift();
      return typeof next === 'function' ? next(options) : next;
    },
  });
  return { client, sent, reads };
}

test('a refusal that repeats the token is returned without it — the status, the typed code and the rest of the message are what they were', async () => {
  const { client } = clientOver([answer(403, { error: { code: 'InvalidAuthenticationToken', message: `Rejected bearer ${TOKEN} for this request` } })]);
  const res = await client.post(`${API}/ImportSolution`, {});
  assert.deepEqual([res.status, res.body.error.code, res.body.error.message], [403, 'InvalidAuthenticationToken', 'Rejected bearer <token> for this request']);
  assert.ok(!JSON.stringify(res).includes(TOKEN));
});

test('what a service repeats of a token is often one PART of it — each part is taken out on its own, wherever the answer has it: a value, a list, a nested object, a key', async () => {
  for (const part of PARTS) {
    const { client } = clientOver([answer(400, { error: { code: '0x80060891', message: `the part ${part} is not valid`, details: [`list ${part}`, { note: part }] }, [part]: 'as a key', status: 400 })]);
    const res = await client.patch(`${API}/accounts(${GUID})`, {});
    assert.deepEqual(res.body.error, { code: '0x80060891', message: 'the part <token> is not valid', details: ['list <token>', { note: '<token>' }] }, part);
    assert.equal(res.body['<token>'], 'as a key', 'a key is taken out too');
    assert.equal(res.body.status, 400, 'the rest of the answer is left as it is');
  }
  // A part shorter than 24 characters would be taken out of ordinary words, so it is left alone — the Power Apps client's own limit.
  const { client } = clientOver([answer(400, { error: { message: 'aaa and bbb and ccc' } })], ['aaa.bbb.ccc-and-a-longer-opaque-token-value']);
  assert.equal((await client.post(`${API}/ImportSolution`, {})).body.error.message, 'aaa and bbb and ccc');
});

test('an answer that is not JSON — an error page — is scrubbed as the text it is, and its headers are scrubbed too: the status and every other header survive', async () => {
  const page = clientOver([answer(502, `<html>Bad gateway. Authorization: Bearer ${TOKEN}</html>`, { 'content-type': 'text/html' })], [TOKEN], { once: true });
  assert.deepEqual(await page.client.post(`${API}/ImportSolution`, {}), { status: 502, headers: { 'content-type': 'text/html' }, body: '<html>Bad gateway. Authorization: Bearer <token></html>' });
  const headed = clientOver([answer(401, { error: { message: 'no' } }, { 'www-authenticate': `Bearer error="invalid_token", error_description="${TOKEN} was rejected"`, 'x-ms-request-id': GUID })], [TOKEN], { once: true });
  const res = await headed.client.get(`${API}/WhoAmI`);
  assert.equal(res.status, 401);
  assert.equal(res.headers['www-authenticate'], 'Bearer error="invalid_token", error_description="<token> was rejected"');
  assert.equal(res.headers['x-ms-request-id'], GUID);
});

test('a transport failure that repeats the token — a socket error that holds the request it was sending — says it without the token, however the client reports it', async () => {
  const text = `socket hang up while sending Authorization: Bearer ${TOKEN}`;
  // A GET that got no answer is sent six times and then reported.
  const read = clientOver(Array.from({ length: 6 }, () => ({ error: text })));
  await assert.rejects(read.client.get(`${API}/WhoAmI`), (err) => {
    assert.equal(err.message, 'Request failed: socket hang up while sending Authorization: Bearer <token>');
    return true;
  });
  // A conditional write that got no answer is not sent again, and says why.
  const conditional = clientOver([{ error: text }]);
  await assert.rejects(conditional.client.patch(`${API}/appmodules(${GUID})`, {}, { headers: { 'If-Match': 'W/"1"' } }), (err) => {
    assert.ok(!err.message.includes(TOKEN) && /Bearer <token> — this conditional PATCH was not re-sent/.test(err.message), err.message);
    return true;
  });
  // A POST whose answer began and was cut off is reported as an uncertain outcome.
  const cut = clientOver([{ error: text, incompleteResponse: true, statusCode: 200 }]);
  await assert.rejects(cut.client.post(`${API}/appmodules`, {}), (err) => {
    assert.ok(!err.message.includes(TOKEN) && /Bearer <token> — the server had already answered 200/.test(err.message), err.message);
    return true;
  });
  // A request that was sent once on purpose, and got no answer.
  const once = createAzHttpClient(ORIGIN, { getToken: () => TOKEN, sleep: async () => {}, sendOnce: () => true, request: async () => ({ error: text }) });
  await assert.rejects(once.post(`${API}/ImportSolution`, {}), (err) => err.message === 'Request failed: socket hang up while sending Authorization: Bearer <token>');
});

// Node's own code for a failure of the transport (lib/dataverse-auth.js makeRequest reports it beside the words) decides whether the client sends the request again, and rides on the error
// the client throws (transportError) for the build's retry to read; the words beside it are what a script prints, so they lose the token as every transport failure's words do. One error
// carries both: the code as Node gave it, and the words without the token.
test('a transport failure that carries Node\'s code and repeats the token: the code decides and stays on the error, the words lose the token — a reset is sent again, a certificate once', async () => {
  const words = (what) => `${what} while sending the request that carried ${TOKEN}`;
  // A reset, with its code: sent six times, as every reset is, then thrown with the code and without the token.
  const reset = clientOver(Array.from({ length: 6 }, () => ({ error: words('read ECONNRESET'), code: 'ECONNRESET' })));
  await assert.rejects(reset.client.get(`${API}/WhoAmI`), (err) => {
    assert.equal(err.message, 'Request failed: read ECONNRESET while sending the request that carried <token>');
    assert.equal(err.code, 'ECONNRESET');
    return true;
  });
  assert.equal(reset.sent.length, 6);
  // A certificate that does not verify, whose words name a host that spells a reset and hold the token: its code is final, so it is sent once, and thrown with the code and without the token.
  const cert = clientOver([{ error: words('Hostname/IP does not match certificate\'s altnames: DNS:ECONNRESET.example.com'), code: 'ERR_TLS_CERT_ALTNAME_INVALID' }]);
  await assert.rejects(cert.client.get(`${API}/WhoAmI`), (err) => {
    assert.equal(err.code, 'ERR_TLS_CERT_ALTNAME_INVALID');
    assert.ok(!err.message.includes(TOKEN) && err.message.endsWith('carried <token>'), err.message);
    return true;
  });
  assert.equal(cert.sent.length, 1, 'a certificate that does not verify is not sent again');
  // The writes a failure of the transport never sends again — a conditional write, and a POST whose answer began and was cut off — keep the code and lose the token as well.
  const conditional = clientOver([{ error: words('write EPIPE'), code: 'EPIPE' }]);
  await assert.rejects(conditional.client.patch(`${API}/appmodules(${GUID})`, {}, { headers: { 'If-Match': 'W/"1"' } }), (err) => err.code === 'EPIPE' && !err.message.includes(TOKEN) && /carried <token> — this conditional PATCH was not re-sent/.test(err.message));
  const cut = clientOver([{ error: words('aborted'), code: 'ECONNRESET', incompleteResponse: true, statusCode: 200 }]);
  await assert.rejects(cut.client.post(`${API}/appmodules`, {}), (err) => err.code === 'ECONNRESET' && !err.message.includes(TOKEN) && /carried <token> — the server had already answered 200/.test(err.message));
});

test('a token the client replaced after a 401 is taken out as well as the one it sent last — a service may repeat either', async () => {
  const { client, sent } = clientOver([
    answer(401, { error: { message: 'expired' } }),
    answer(403, { error: { code: 'InvalidAuthenticationToken', message: `first ${OLD_TOKEN} then ${TOKEN}` } }),
  ], [OLD_TOKEN, TOKEN]);
  const res = await client.get(`${API}/WhoAmI`);
  assert.equal(sent.length, 2, 'the 401 was answered with one send more');
  assert.equal(res.body.error.message, 'first <token> then <token>');
});

test('a SUCCESS is never touched: its JSON, its raw text and its bytes are returned as they came, even when they hold the very text of the token', async () => {
  const record = { name: `holds ${TOKEN}`, list: [TOKEN], [TOKEN]: 'key' };
  const json = clientOver([answer(200, record)]);
  assert.deepEqual((await json.client.get(`${API}/accounts(${GUID})`)).body, record);
  const created = clientOver([answer(204, '')]);
  assert.equal((await created.client.post(`${API}/accounts`, {})).body, undefined);
  const multipart = `--batchresponse_x\r\nContent-Type: application/http\r\n\r\nHTTP/1.1 200 OK\r\n\r\n{"echo":"${TOKEN}"}\r\n--batchresponse_x--`;
  const raw = clientOver([answer(200, multipart)]);
  assert.equal((await raw.client.postRaw(`${API}/$batch`, 'x')).body, multipart);
  const bytes = Buffer.from(`file content with ${TOKEN} in it`);
  const file = clientOver([answer(200, bytes)]);
  assert.equal((await file.client.get(`${API}/uxagentprojectfiles(${GUID})/filecontent/$value`)).body, bytes, 'the very Buffer that arrived');
  // The headers of a success are left as they are, too.
  const headed = clientOver([answer(200, {}, { 'x-echo': TOKEN })]);
  assert.equal((await headed.client.get(`${API}/WhoAmI`)).headers['x-echo'], TOKEN);
});

test('a change set the service refuses as a whole is a SUCCESS to the client — HTTP 200, the failed part inside — and is returned as it came, token and all: the strict readers count its bytes, and the token is taken out of what the SDK makes of it (lib/sdk-failure-scrub.js)', async () => {
  const detail = JSON.stringify({ error: { code: '0x80040220', message: `Principal user rejected bearer ${TOKEN} for this write` } });
  const refused = ['--batchresponse_x', 'Content-Type: multipart/mixed; boundary=changesetresponse_x', '', '--changesetresponse_x', 'Content-Type: application/http', 'Content-Transfer-Encoding: binary', 'Content-ID: 1', '',
    'HTTP/1.1 403 Forbidden', 'Content-Type: application/json', `Content-Length: ${Buffer.byteLength(detail)}`, '', detail, '--changesetresponse_x--', '--batchresponse_x--', ''].join('\r\n');
  const { client, sent } = clientOver([answer(200, refused)]);
  const res = await client.postRaw(`${API}/$batch`, 'x');
  assert.equal(sent.length, 1, 'it is sent once');
  assert.equal(res.status, 200);
  assert.equal(res.body, refused, 'the very text the service sent');
  assert.ok(res.body.includes(TOKEN), 'with the token in it');
  assert.equal(completeBatchStatus({ body: res.body }), 403, 'and the strict reader proves the refusal from it, as it does from the service\'s own');
});

test('an answer that is not a success is scrubbed in every mode the client reads in — raw text and bytes as well — and one that holds no token is returned as the same text and the same Buffer', async () => {
  const refusedBatch = answer(400, `{"error":{"message":"batch refused: ${TOKEN}"}}`);
  const raw = clientOver([refusedBatch]);
  assert.equal((await raw.client.postRaw(`${API}/$batch`, 'x')).body, '{"error":{"message":"batch refused: <token>"}}');
  const clean = '{"error":{"message":"batch refused"}}';
  assert.equal((await clientOver([answer(400, clean)]).client.postRaw(`${API}/$batch`, 'x')).body, clean);
  const refusedFile = clientOver([answer(404, Buffer.from(`{"error":{"message":"no content for ${TOKEN}"}}`))]);
  const scrubbed = (await refusedFile.client.get(`${API}/uxagentprojectfiles(${GUID})/filecontent/$value`)).body;
  assert.ok(Buffer.isBuffer(scrubbed));
  assert.equal(scrubbed.toString('utf8'), '{"error":{"message":"no content for <token>"}}');
  const untouched = Buffer.from('{"error":{"message":"not found"}}');
  assert.equal((await clientOver([answer(404, untouched)]).client.get(`${API}/uxagentprojectfiles(${GUID})/filecontent/$value`)).body, untouched, 'the very Buffer that arrived');
  // Bytes that are not text and hold no token are not decoded into something else.
  const binary = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x81]);
  assert.equal((await clientOver([answer(500, binary)], [TOKEN], { once: true }).client.get(`${API}/uxagentprojectfiles(${GUID})/filecontent/$value`)).body, binary);
});

test('every status outside 2xx is an answer a message can be made of, and is scrubbed: a redirect, a client error, a server error', async () => {
  for (const status of [301, 302, 400, 401, 403, 404, 409, 412, 429, 500, 502, 503, 504]) {
    const { client } = clientOver([answer(status, { error: { message: `status ${status} ${TOKEN}` } })], [TOKEN], { once: true });
    const res = await client.post(`${API}/ImportSolution`, {});
    assert.equal(res.status, status);
    assert.equal(res.body.error.message, `status ${status} <token>`, String(status));
  }
});

test('a value too short to be an access token is not taken out of anything — it would blank every message that has the same few letters', async () => {
  const { client } = clientOver([answer(400, { error: { message: 'the token was not valid' } })], ['t']);
  assert.equal((await client.post(`${API}/ImportSolution`, {})).body.error.message, 'the token was not valid');
});

test('the scrubber is the one the Power Apps client uses — shared, exported, and unchanged: parts of 24 characters or more, keys too, and a depth no real answer has — never a second copy', () => {
  assert.equal(scrub(`a ${TOKEN} b`, TOKEN), 'a <token> b');
  assert.equal(scrub(`a ${PARTS[1]} b`, TOKEN), 'a <token> b');
  assert.equal(scrub('a b', ''), 'a b');
  assert.deepEqual(scrubAnswer({ [TOKEN]: [TOKEN, 1, null, true, { deeper: TOKEN }] }, TOKEN), { '<token>': ['<token>', 1, null, true, { deeper: '<token>' }] });
  let nested = { token: TOKEN };
  for (let i = 0; i < 300; i += 1) nested = { next: nested };
  assert.match(JSON.stringify(scrubAnswer(nested, TOKEN)), /too deeply nested to scrub/);
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'power-apps-service-client.js'), 'utf8');
  assert.match(source, /require\('\.\/sdk-http-client\.js'\)/, 'the Power Apps client takes the scrubber from the shared module');
  assert.doesNotMatch(source, /function scrub(Answer)?\(/, 'and does not define one of its own');
});
