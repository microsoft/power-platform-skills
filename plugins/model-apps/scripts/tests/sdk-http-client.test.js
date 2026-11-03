'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createAzHttpClient, retryAfterMs, isBatchThrottled, isBatchDeadlockVictim, completeBatchStatus, isColumnCreateBatch, batchRetryAfterMs, throttleBackoffMs, RETRY_AFTER_CAP_MS } = require('../lib/sdk-http-client.js');

// A fake transport that records the last request and returns a scripted response.
function fakeTransport(scripted) {
  const calls = [];
  const request = async (opts) => {
    calls.push(opts);
    const r = typeof scripted === 'function' ? scripted(opts, calls.length) : scripted;
    return r;
  };
  return { request, calls };
}

test('shapes a GET with bearer token + OData headers and parses JSON body', async () => {
  const { request, calls } = fakeTransport({ statusCode: 200, headers: { etag: 'W/"1"' }, body: '{"value":[1,2]}' });
  const http = createAzHttpClient('https://org.crm.dynamics.com/', { getToken: () => 'TOK', request });
  const res = await http.get('https://org.crm.dynamics.com/api/data/v9.2/accounts');
  assert.strictEqual(calls[0].method, 'GET');
  assert.strictEqual(calls[0].headers.Authorization, 'Bearer TOK');
  assert.strictEqual(calls[0].headers['OData-Version'], '4.0');
  assert.strictEqual(calls[0].body, null); // no body on GET
  assert.deepStrictEqual(res, { status: 200, headers: { etag: 'W/"1"' }, body: { value: [1, 2] } });
});

test('POST stringifies the body and sets Content-Type', async () => {
  const { request, calls } = fakeTransport({ statusCode: 204, headers: {}, body: '' });
  const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request });
  const res = await http.post('https://org.crm.dynamics.com/x', { name: 'A' });
  assert.strictEqual(calls[0].method, 'POST');
  assert.strictEqual(calls[0].body, '{"name":"A"}');
  assert.match(calls[0].headers['Content-Type'], /application\/json/);
  assert.strictEqual(res.status, 204);
  assert.strictEqual(res.body, undefined); // empty body -> undefined
});

test('merges per-call headers (solution + If-Match) and keeps caller Content-Type', async () => {
  const { request, calls } = fakeTransport({ statusCode: 204, headers: {}, body: '' });
  const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request });
  await http.patch('https://org.crm.dynamics.com/x', { a: 1 }, { headers: { 'MSCRM.SolutionUniqueName': 'MyS', 'If-Match': 'W/"7"' } });
  assert.strictEqual(calls[0].headers['MSCRM.SolutionUniqueName'], 'MyS');
  assert.strictEqual(calls[0].headers['If-Match'], 'W/"7"');
});

// A file's CONTENT (`…/filecontent/$value`) is bytes — a generative page's rows, an image — and the SDK takes it as bytes. Parsed as JSON, a page's
// `config.json` came back as an object and the SDK refused every page read (GENPAGE_CONTENT_UNREADABLE, measured live); decoded as text, bytes that are not
// UTF-8 would be corrupted. Any other read is parsed as before.
test('a read of a file\'s content ($value) answers the bytes as they arrived; any other read is still parsed', async () => {
  const configJson = Buffer.from('{"dataSources":["account"],"model":"m"}', 'utf8');
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0xc3, 0x28]);
  const { request, calls } = fakeTransport((opts) => ({ statusCode: 200, headers: {}, body: opts.binary ? (/img/.test(opts.url) ? image : configJson) : '{"value":[]}' }));
  const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request });
  const config = await http.get('https://org.crm.dynamics.com/api/data/v9.0/uxagentprojectfiles(1)/filecontent/$value', { headers: { 'MSCRM.IncludeUnpublished': 'true' } });
  assert.ok(Buffer.isBuffer(config.body) && config.body.equals(configJson), 'a JSON row stays bytes, never an object');
  assert.strictEqual(calls[0].binary, true, 'the transport is asked for bytes');
  assert.strictEqual(calls[0].headers.Accept, '*/*', 'the content, of whatever type');
  assert.strictEqual(calls[0].headers['MSCRM.IncludeUnpublished'], 'true', 'the caller\'s headers ride along');
  const img = await http.get('https://org.crm.dynamics.com/api/data/v9.0/uxagentprojectfiles(2)/filecontent/$value?img=1');
  assert.ok(img.body.equals(image), 'bytes that are not UTF-8 come back unchanged');
  const list = await http.get('https://org.crm.dynamics.com/api/data/v9.0/uxagentprojectfiles?$select=filename');
  assert.deepStrictEqual(list.body, { value: [] }, 'a query is parsed, as before');
  assert.notStrictEqual(calls[2].binary, true);
  await assert.rejects(http.get('https://evil.example.com/api/data/v9.0/x/filecontent/$value'), /different origin/, 'the same-origin guard holds for a content read');
});

// patchRaw (cds-maker-sdk HttpClient): a PATCH whose body is a file's bytes, sent verbatim — never JSON.stringify'd — with its length and the caller's
// Content-Type. The SDK adds `If-Match: *` only when it replaces the content of an EXISTING row, and such a PATCH that got no answer is not re-sent:
// it may still commit.
test('patchRaw sends a file\'s bytes verbatim with their length and the caller\'s headers, and with If-Match is not re-sent when no answer came', async () => {
  const bytes = new Uint8Array([0x3c, 0x64, 0x69, 0x76, 0x3e, 0xff, 0x00]);
  const { request, calls } = fakeTransport({ statusCode: 204, headers: {}, body: '' });
  const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request });
  const res = await http.patchRaw('https://org.crm.dynamics.com/api/data/v9.0/uxagentprojectfiles(1)/filecontent', bytes,
    { headers: { 'Content-Type': 'application/octet-stream; charset=utf-8', 'x-ms-file-name': 'page.tsx', 'If-Match': '*' } });
  assert.strictEqual(res.status, 204);
  assert.ok(Buffer.isBuffer(calls[0].body) && calls[0].body.equals(Buffer.from(bytes)), 'the bytes, as they are');
  assert.strictEqual(calls[0].headers['Content-Length'], String(bytes.length));
  assert.strictEqual(calls[0].headers['Content-Type'], 'application/octet-stream; charset=utf-8', 'the caller\'s type, not a JSON default');
  assert.strictEqual(calls[0].headers['x-ms-file-name'], 'page.tsx');
  const bare = fakeTransport({ statusCode: 204, headers: {}, body: '' });
  await createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request: bare.request }).patchRaw('https://org.crm.dynamics.com/x', bytes);
  assert.strictEqual(bare.calls[0].headers['Content-Type'], 'application/octet-stream', 'bytes with no type given are octets');
  const lost = fakeTransport({ error: 'socket hang up' });
  const client = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request: lost.request, sleep: async () => {} });
  await assert.rejects(client.patchRaw('https://org.crm.dynamics.com/x', bytes, { headers: { 'If-Match': '*' } }), /was not re-sent/);
  assert.strictEqual(lost.calls.length, 1, 'one send');
});

// A new row's content PATCH is unconditional (no If-Match) and writes the same bytes to the same row, so it is idempotent and keeps the transport retry.
test('patchRaw without If-Match — the content of a new row — keeps its transport retry', async () => {
  const bytes = new Uint8Array([0x3c, 0x64, 0x69, 0x76, 0x3e]);
  const lost = fakeTransport({ error: 'socket hang up' });
  const client = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request: lost.request, sleep: async () => {} });
  await assert.rejects(client.patchRaw('https://org.crm.dynamics.com/api/data/v9.0/uxagentprojectfiles(1)/filecontent', bytes), /Request failed: socket hang up$/);
  assert.strictEqual(lost.calls.length, 6, 'six attempts in all, as for any write that is not conditional');
});

test('does NOT throw on non-2xx — passes status/body through (412 version conflict)', async () => {
  const { request } = fakeTransport({ statusCode: 412, headers: {}, body: '{"error":{"message":"conflict"}}' });
  const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request });
  const res = await http.put('https://org.crm.dynamics.com/x', { a: 1 });
  assert.strictEqual(res.status, 412);
  assert.strictEqual(res.body.error.message, 'conflict');
});

test('refreshes token once on 401 then succeeds', async () => {
  let tokens = 0;
  const { request, calls } = fakeTransport((opts) => {
    return calls.length === 1
      ? { statusCode: 401, headers: {}, body: '' }
      : { statusCode: 200, headers: {}, body: '{"ok":true}' };
  });
  const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => `T${++tokens}`, request });
  const res = await http.get('https://org.crm.dynamics.com/x');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].headers.Authorization, 'Bearer T1');
  assert.strictEqual(calls[1].headers.Authorization, 'Bearer T2'); // refreshed
});


test('a POST whose response was cut off after the server answered is not re-sent', async () => {
  // makeRequest reports a body cut off after the status line as incompleteResponse: the server
  // answered, so the create may already exist and a re-send could make a second row.
  const { request, calls } = fakeTransport({ error: 'Connection closed before the response completed', incompleteResponse: true, statusCode: 201 });
  const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request, sleep: async () => {} });
  await assert.rejects(http.post('https://org.crm.dynamics.com/api/data/v9.2/accounts', { name: 'A' }), /already answered 201, so this POST may have been applied; it was not re-sent/);
  assert.strictEqual(calls.length, 1);
});

test('a cut-off GET is retried, and a POST that never got an answer keeps its transport retry', async () => {
  const cut = { error: 'Connection closed before the response completed', incompleteResponse: true, statusCode: 200 };
  const read = fakeTransport((opts, n) => (n === 1 ? cut : { statusCode: 200, headers: {}, body: '{"value":[]}' }));
  const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request: read.request, sleep: async () => {} });
  assert.strictEqual((await http.get('https://org.crm.dynamics.com/api/data/v9.2/accounts')).status, 200);
  assert.strictEqual(read.calls.length, 2);
  const write = fakeTransport((opts, n) => (n === 1 ? { error: 'connect ECONNRESET' } : { statusCode: 204, headers: {}, body: '' }));
  const http2 = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request: write.request, sleep: async () => {} });
  assert.strictEqual((await http2.post('https://org.crm.dynamics.com/api/data/v9.2/accounts', { name: 'A' })).status, 204);
  assert.strictEqual(write.calls.length, 2, 'unchanged: a request-level failure is still retried');
});

test('refreshes token with a fresh acquire on 401, bypassing any process memo', async () => {
  const tokenCalls = [];
  const { request, calls } = fakeTransport(() => {
    return calls.length === 1
      ? { statusCode: 401, headers: {}, body: '' }
      : { statusCode: 200, headers: {}, body: '{"ok":true}' };
  });
  const http = createAzHttpClient('https://org.crm.dynamics.com', {
    getToken: (_url, options) => {
      tokenCalls.push(Boolean(options && options.fresh));
      return tokenCalls.length === 1 ? 'OLD' : 'NEW';
    },
    request,
  });
  const res = await http.get('https://org.crm.dynamics.com/api/data/v9.2/accounts');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(tokenCalls, [false, true]);
  assert.deepStrictEqual(calls.map((c) => c.headers.Authorization), ['Bearer OLD', 'Bearer NEW']);
});

// The refresh after a 401 can fail too. That stops the request with the token failure — worded like every other one —
// and nothing is re-sent with the rejected token.
test('a 401 whose token refresh fails stops with the token failure and re-sends nothing', async () => {
  const { request, calls } = fakeTransport({ statusCode: 401, headers: {}, body: '' });
  let acquired = 0;
  const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => (++acquired === 1 ? 'OLD' : null), request });
  await assert.rejects(http.get('https://org.crm.dynamics.com/x'), /Failed to refresh Azure CLI token for https:\/\/org\.crm\.dynamics\.com\. Run 'az login' first\./);
  assert.deepStrictEqual([calls.length, acquired], [1, 2]);
});

// `deps.sendOnce(method, url)`: the caller's word that a request is sent exactly once. A solution import is one — the platform runs it to its end, so an answer that
// comes from a gateway after it began (a 504, a dropped connection, a 401 from an expired token) says nothing about whether it ran, and a second send does the work twice.
const IMPORT_URL = 'https://org.crm.dynamics.com/api/data/v9.2/ImportSolution';
const onlyImport = (method, url) => method === 'POST' && /\/ImportSolution$/.test(url);

test('a request the caller marks sendOnce is sent once whatever answers it — a 5xx, a 429, a 401 — and that first answer reaches the caller as it came', async () => {
  for (const statusCode of [500, 502, 503, 504, 429, 401]) {
    const { request, calls } = fakeTransport({ statusCode, headers: { 'retry-after': '1' }, body: JSON.stringify({ error: { code: '0x1', message: `answered ${statusCode}` } }) });
    const tokens = [];
    const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: (_url, options) => { tokens.push(Boolean(options && options.fresh)); return 'TOK'; }, request, sleep: async () => {}, sendOnce: onlyImport });
    const res = await http.post(IMPORT_URL, { CustomizationFile: 'x' });
    assert.deepStrictEqual([res.status, res.body.error.message], [statusCode, `answered ${statusCode}`], String(statusCode));
    assert.strictEqual(calls.length, 1, `${statusCode}: one send, not a retry`);
    assert.deepStrictEqual(tokens, [false], `${statusCode}: no second token read`);
  }
});

test('a sendOnce request that got NO answer — a transport failure, a timeout — is not sent again either', async () => {
  for (const error of ['connect ECONNRESET', 'Request timed out']) {
    const { request, calls } = fakeTransport({ error });
    const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request, sleep: async () => {}, sendOnce: onlyImport });
    await assert.rejects(http.post(IMPORT_URL, { CustomizationFile: 'x' }), new RegExp(`^Error: Request failed: ${error}$`));
    assert.strictEqual(calls.length, 1, error);
  }
});

test('sendOnce is asked about each request — its method and URL — and only the requests it names lose their retries', async () => {
  const asked = [];
  const sendOnce = (method, url) => { asked.push([method, url]); return onlyImport(method, url); };
  const answer = { statusCode: 503, headers: {}, body: 'busy' };
  const once = fakeTransport(answer);
  const other = fakeTransport(answer);
  const slow = fakeTransport(answer);
  const make = (transport) => createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request: transport.request, sleep: async () => {}, sendOnce });
  assert.strictEqual((await make(once).post(IMPORT_URL, {})).status, 503);
  assert.strictEqual((await make(other).post('https://org.crm.dynamics.com/api/data/v9.2/StageSolution', {})).status, 503);
  assert.strictEqual((await make(slow).get(IMPORT_URL)).status, 503);
  assert.deepStrictEqual([once.calls.length, other.calls.length, slow.calls.length], [1, 6, 6], 'the same URL by another method, and another URL by the same method, keep the retry');
  assert.deepStrictEqual(asked.slice(0, 2), [['POST', IMPORT_URL], ['POST', 'https://org.crm.dynamics.com/api/data/v9.2/StageSolution']]);
});

test('without a sendOnce policy nothing changes: the same 504 on the same POST is retried on the usual schedule', async () => {
  const { request, calls } = fakeTransport({ statusCode: 504, headers: {}, body: 'gateway timeout' });
  const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request, sleep: async () => {} });
  assert.strictEqual((await http.post(IMPORT_URL, {})).status, 504);
  assert.strictEqual(calls.length, 6);
});

test('retries a transient 500 (SQL deadlock) with backoff, then succeeds', async () => {
  const { request, calls } = fakeTransport(() =>
    calls.length <= 2 ? { statusCode: 500, headers: {}, body: 'deadlock 1205' } : { statusCode: 200, headers: {}, body: '{"ok":true}' }
  );
  const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request, sleep: async () => {} });
  const res = await http.post('https://org.crm.dynamics.com/x', { a: 1 });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(calls.length, 3); // 500, 500, 200
});

test('gives up after max attempts on a persistent 500 — surfaces it (no throw)', async () => {
  const { request, calls } = fakeTransport({ statusCode: 500, headers: {}, body: 'boom' });
  const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request, sleep: async () => {} });
  const res = await http.get('https://org.crm.dynamics.com/x');
  assert.strictEqual(res.status, 500); // the SDK decides what to do with it
  assert.strictEqual(calls.length, 6);
});

test('retries a 429 EntityCustomization lock and eventually succeeds', async () => {
  const { request, calls } = fakeTransport(() =>
    calls.length <= 4
      ? { statusCode: 429, headers: {}, body: 'Cannot start another [EntityCustomization]' }
      : { statusCode: 200, headers: {}, body: '{"ok":true}' }
  );
  const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request, sleep: async () => {} });
  const res = await http.post('https://org.crm.dynamics.com/x', { a: 1 });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(calls.length, 5); // 429 x4, then 200 — needs the extra attempts (>4)
});

test('applies jittered, capped backoff on transient retries (de-syncs lockstep collisions)', async () => {
  const slept = [];
  // random() = 0.5 -> +12.5% jitter; caps exponential at 8000ms.
  const { request } = fakeTransport({ statusCode: 503, headers: {}, body: '' });
  const http = createAzHttpClient('https://org.crm.dynamics.com', {
    getToken: () => 'TOK', request, random: () => 0.5,
    sleep: async (ms) => { slept.push(ms); },
  });
  await http.get('https://org.crm.dynamics.com/x');
  // 5 sleeps before the 6th (final) attempt: base 1s,2s,4s,8s,8s each + 12.5% jitter.
  assert.deepStrictEqual(slept, [1125, 2250, 4500, 9000, 9000]);
});

test('does NOT retry a RECORD delete on a transient status (avoids the async concurrent-delete wedge)', async () => {
  const { request, calls } = fakeTransport({ statusCode: 503, headers: {}, body: '' });
  const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request, sleep: async () => {} });
  const res = await http.delete('https://org.crm.dynamics.com/api/data/v9.0/webresourceset(1)');
  assert.strictEqual(res.status, 503, 'the transient status surfaces instead of being retried');
  assert.strictEqual(calls.length, 1, 'exactly one record DELETE was sent (no retry)');
});

test('does NOT retry a RECORD delete on a network error either (single delete, no wedge)', async () => {
  let calls = 0;
  const request = async () => { calls += 1; return { error: 'ETIMEDOUT' }; };
  const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request, sleep: async () => {} });
  await assert.rejects(() => http.delete('https://org.crm.dynamics.com/api/data/v9.0/webresourceset(1)'), /Request failed: ETIMEDOUT/);
  assert.strictEqual(calls, 1, 'exactly one record DELETE was sent (no network-error retry)');
});

// ── What a failure of the transport is worth sending a request again for ──
// A reset or a timeout can be gone on the next send. A failure to VERIFY the server's certificate is a fact about this machine's trust store and the server, and is the same on every send: sending
// the request again six times only waited 23 s for the same refusal (1 s + 2 s + 4 s + 8 s + 8 s). `makeRequest` (lib/dataverse-auth.js) reports Node's own message, so the family is read from
// the message: OpenSSL's text for each verification result (https://docs.openssl.org/3.0/man1/openssl-verification-flags/ and the Node errors list, https://nodejs.org/api/errors.html), the
// code that names it, and Node's own wording for a host the certificate does not name.
const CERTIFICATE_FAILURES = [
  'unable to verify the first certificate', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'unable to get local issuer certificate', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'certificate has expired', 'CERT_HAS_EXPIRED',
  'certificate is not yet valid', 'CERT_NOT_YET_VALID',
  'self-signed certificate', 'self signed certificate', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'self-signed certificate in certificate chain', 'self signed certificate in certificate chain', 'SELF_SIGNED_CERT_IN_CHAIN',
  'certificate revoked', 'certificate not trusted',
  "Hostname/IP does not match certificate's altnames: Host: contoso.crm.dynamics.com. is not in the cert's altnames: DNS:other.example", 'ERR_TLS_CERT_ALTNAME_INVALID',
  'error:0A000086:SSL routines:tls_post_process_server_certificate:certificate verify failed',
  // The names a certificate carries — and Node quotes — can be any text, a transport code included: a failure to verify is not a blip because of a word in the names it quotes.
  "Hostname/IP does not match certificate's altnames: Host: contoso.crm.dynamics.com. is not in the cert's altnames: DNS:ECONNRESET.example.com",
  "Hostname/IP does not match certificate's altnames: Host: contoso.crm.dynamics.com. is not cert's CN: socket hang up",
  'unable to verify the first certificate (the issuer of etimedout.example.com is not trusted: connection timed out)',
];
// Node's own list of the codes a certificate error carries, and the one of a name that does not match — https://nodejs.org/api/tls.html#x509-certificate-error-codes, https://nodejs.org/api/errors.html#err_tls_cert_altname_invalid.
const X509_CODES = [
  'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_CRL', 'UNABLE_TO_DECRYPT_CERT_SIGNATURE', 'UNABLE_TO_DECRYPT_CRL_SIGNATURE', 'UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY', 'CERT_SIGNATURE_FAILURE', 'CRL_SIGNATURE_FAILURE',
  'CERT_NOT_YET_VALID', 'CERT_HAS_EXPIRED', 'CRL_NOT_YET_VALID', 'CRL_HAS_EXPIRED', 'ERROR_IN_CERT_NOT_BEFORE_FIELD', 'ERROR_IN_CERT_NOT_AFTER_FIELD', 'ERROR_IN_CRL_LAST_UPDATE_FIELD', 'ERROR_IN_CRL_NEXT_UPDATE_FIELD',
  'OUT_OF_MEM', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_CHAIN_TOO_LONG', 'CERT_REVOKED', 'INVALID_CA',
  'PATH_LENGTH_EXCEEDED', 'INVALID_PURPOSE', 'CERT_UNTRUSTED', 'CERT_REJECTED', 'HOSTNAME_MISMATCH', 'ERR_TLS_CERT_ALTNAME_INVALID',
];
// What the transport says when a connection is reset, or a request or its answer times out or is cut off — the failures the build's own retry policy calls transient too (lib/retry-policy.js).
const TRANSIENT_TRANSPORT_FAILURES = [
  'read ECONNRESET', 'write EPIPE', 'connect ETIMEDOUT 10.0.0.1:443', 'ESOCKETTIMEDOUT', 'ECONNABORTED', 'getaddrinfo EAI_AGAIN contoso.crm.dynamics.com',
  'Request timed out', 'socket hang up', 'Response aborted before it completed', 'Response failed before it completed: aborted',
  'Connection closed before the response completed', 'Client network socket disconnected before secure TLS connection was established',
];

test('a failure to verify the server\'s certificate is sent ONCE — a read, an unconditional write and a metadata delete alike — and never waited for', async () => {
  const sends = [
    ['a read', (http) => http.get('https://org.crm.dynamics.com/api/data/v9.0/uxagentprojects')],
    ['an unconditional write', (http) => http.patch('https://org.crm.dynamics.com/api/data/v9.0/uxagentprojects(1)', { name: 'A' })],
    ['a metadata delete', (http) => http.delete("https://org.crm.dynamics.com/api/data/v9.0/EntityDefinitions(LogicalName='new_x')")],
    ['a read that asks for bytes', (http) => http.get('https://org.crm.dynamics.com/api/data/v9.0/uxagentprojectfiles(1)/filecontent/$value')],
  ];
  for (const failure of CERTIFICATE_FAILURES) {
    for (const [what, send] of sends) {
      const slept = [];
      const { request, calls } = fakeTransport({ error: failure });
      const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request, sleep: async (ms) => { slept.push(ms); } });
      await assert.rejects(send(http), (error) => error.message === `Request failed: ${failure}`, `${what}: ${failure}`);
      assert.strictEqual(calls.length, 1, `${what}: ${failure} — sent once`);
      assert.deepStrictEqual(slept, [], `${what}: ${failure} — nothing waited for`);
    }
  }
});

test('a reset, a timeout, a cut-off answer and a temporary DNS failure are still sent again on the schedule — six sends, 1 s, 2 s, 4 s, 8 s, 8 s', async () => {
  for (const failure of TRANSIENT_TRANSPORT_FAILURES) {
    const slept = [];
    const { request, calls } = fakeTransport({ error: failure });
    const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request, sleep: async (ms) => { slept.push(ms); }, random: () => 0 });
    await assert.rejects(http.get('https://org.crm.dynamics.com/api/data/v9.0/uxagentprojects'), (error) => error.message === `Request failed: ${failure}`, failure);
    assert.strictEqual(calls.length, 6, `${failure}: six sends`);
    assert.deepStrictEqual(slept, [1000, 2000, 4000, 8000, 8000], failure);
  }
  // …and one that clears is a request that succeeds.
  const { request, calls } = fakeTransport((opts, n) => (n <= 2 ? { error: 'read ECONNRESET' } : { statusCode: 200, headers: {}, body: '{"value":[]}' }));
  const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request, sleep: async () => {} });
  assert.deepStrictEqual((await http.get('https://org.crm.dynamics.com/api/data/v9.0/uxagentprojects')).body, { value: [] });
  assert.strictEqual(calls.length, 3);
});

// Only what the build's own policy calls a blip is sent again, so the two layers agree about one failure: a host that does not exist, a refused connection and a message nothing here recognises are sent once too.
test('a failure that is not a blip — an unknown host, a refused connection, a message nothing recognises — is sent once, as the build\'s retry policy would not run it again either', async () => {
  for (const failure of ['getaddrinfo ENOTFOUND contoso.invalid', 'connect ECONNREFUSED 127.0.0.1:443', 'connect EHOSTUNREACH 10.0.0.1:443', 'connect ENETUNREACH 10.0.0.1:443', 'boom']) {
    const { request, calls } = fakeTransport({ error: failure });
    const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request, sleep: async () => {} });
    await assert.rejects(http.get('https://org.crm.dynamics.com/api/data/v9.0/uxagentprojects'), (error) => error.message === `Request failed: ${failure}`, failure);
    assert.strictEqual(calls.length, 1, failure);
  }
});

// There is ONE definition of "a blip": the client's and the policy's are written apart (the client is copied into the pcf plugin, which has no policy), so this holds them together.
test('the transport failures this client sends again are exactly the ones lib/retry-policy.js calls a blip — a message either decides the same way', () => {
  const { judgeFailure } = require('../lib/retry-policy.js');
  const blip = (words) => judgeFailure(Object.assign(new Error(`Transport failure reaching https://org.crm.dynamics.com/api/data/v9.0/x: Request failed: ${words}`), { code: 'CONNECTION_ERROR', statusCode: 0, url: 'https://org.crm.dynamics.com/api/data/v9.0/x' })).transport;
  const { isTransientTransportFailure } = require('../lib/sdk-http-client.js');
  for (const words of [...TRANSIENT_TRANSPORT_FAILURES, ...CERTIFICATE_FAILURES, 'getaddrinfo ENOTFOUND contoso.invalid', 'connect ECONNREFUSED 127.0.0.1:443', 'boom']) {
    assert.strictEqual(isTransientTransportFailure(words), blip(words), words);
  }
});

// ── What decides a failure of the transport is Node's own CODE when it gave one, and the words only when it gave none ───────────────────────────────────────────────────────────
// `makeRequest` (lib/dataverse-auth.js) reports `code` beside the message of a request that failed. The code is the fact: a failure to verify a certificate quotes the host and the certificate's names, a name can spell anything
// (`DNS:ECONNRESET.example.com` is a valid one), and a transient word found ANYWHERE in such a message sent the request six times — 23 s of waiting for the same refusal. So a code that is not one of the transient ones is final
// whatever the words say; a failure that arrived with no code (one this module words itself — a timeout, a connection closed — or a transport that reports none) is read by its words, and there the phrases of a certificate that
// does not verify are read first.
test('a certificate that does not verify is sent ONCE by its code — each code of Node\'s own list — whatever the words beside it quote', async () => {
  const quoting = 'a problem with econnreset.example.com: ETIMEDOUT, EAI_AGAIN, socket hang up, connection timed out, Response aborted before it completed';
  for (const code of X509_CODES) {
    for (const [what, send] of [
      ['a read', (http) => http.get('https://org.crm.dynamics.com/api/data/v9.0/uxagentprojects')],
      ['an unconditional write', (http) => http.patch('https://org.crm.dynamics.com/api/data/v9.0/uxagentprojects(1)', { name: 'A' })],
      ['a metadata delete', (http) => http.delete("https://org.crm.dynamics.com/api/data/v9.0/EntityDefinitions(LogicalName='new_x')")],
    ]) {
      const slept = [];
      const { request, calls } = fakeTransport({ error: quoting, code });
      const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request, sleep: async (ms) => { slept.push(ms); } });
      await assert.rejects(send(http), (error) => error.message === `Request failed: ${quoting}` && error.code === code, `${what}: ${code}`);
      assert.strictEqual(calls.length, 1, `${what}: ${code} — sent once`);
      assert.deepStrictEqual(slept, [], `${what}: ${code} — nothing waited for`);
    }
  }
});

test('Node\'s own verification error for a certificate whose alternative name spells a transport code is sent once — by its code, and by its words when no code arrived', async () => {
  const tls = require('node:tls');
  // No fabricated wording and no connection: Node makes this error itself for a certificate that does not name the host.
  const failure = tls.checkServerIdentity('contoso.crm.dynamics.com', { subjectaltname: 'DNS:ECONNRESET.example.com' });
  assert.strictEqual(failure.code, 'ERR_TLS_CERT_ALTNAME_INVALID');
  assert.match(failure.message, /ECONNRESET/, 'the control: the words do hold a transport code');
  for (const [what, answer] of [['the code beside the words', { error: failure.message, code: failure.code }], ['the words alone', { error: failure.message }]]) {
    const slept = [];
    const { request, calls } = fakeTransport(answer);
    const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request, sleep: async (ms) => { slept.push(ms); }, random: () => 0 });
    await assert.rejects(http.get('https://org.crm.dynamics.com/api/data/v9.0/uxagentprojects'), /Hostname\/IP does not match certificate's altnames/, what);
    assert.strictEqual(calls.length, 1, `${what}: sent once`);
    assert.deepStrictEqual(slept, [], `${what}: nothing waited for`);
  }
});

test('a transient code is sent again whatever the words say — the six the module treats as transient — and any other code is final even when the words sound transient', async () => {
  const { TRANSIENT_TRANSPORT_CODES } = require('../lib/sdk-http-client.js');
  assert.deepStrictEqual([...TRANSIENT_TRANSPORT_CODES].sort(), ['EAI_AGAIN', 'ECONNABORTED', 'ECONNRESET', 'EPIPE', 'ESOCKETTIMEDOUT', 'ETIMEDOUT']);
  for (const code of TRANSIENT_TRANSPORT_CODES) {
    const slept = [];
    const { request, calls } = fakeTransport({ error: 'nothing here that a word list would recognise', code });
    const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request, sleep: async (ms) => { slept.push(ms); }, random: () => 0 });
    await assert.rejects(http.get('https://org.crm.dynamics.com/api/data/v9.0/uxagentprojects'), (error) => error.code === code, code);
    assert.strictEqual(calls.length, 6, `${code}: six sends`);
    assert.deepStrictEqual(slept, [1000, 2000, 4000, 8000, 8000], code);
  }
  for (const code of ['ENOTFOUND', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ERR_SOCKET_CLOSED', 'ERR_SSL_WRONG_VERSION_NUMBER']) {
    const { request, calls } = fakeTransport({ error: 'read ECONNRESET, socket hang up, timed out', code });
    const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request, sleep: async () => {}, random: () => 0 });
    await assert.rejects(http.get('https://org.crm.dynamics.com/api/data/v9.0/uxagentprojects'), (error) => error.code === code, code);
    assert.strictEqual(calls.length, 1, `${code}: the code is final, and the words are not read`);
  }
});

test('the error the client throws for a failed request carries Node\'s code beside the same message — the SDK keeps it as the cause of its own error, and the build reads it from there — and carries none when none arrived', async () => {
  const cases = [
    ['an ordinary failure', { error: 'connect ECONNREFUSED 127.0.0.1:443', code: 'ECONNREFUSED' }, (http) => http.get('https://org.crm.dynamics.com/x'), 'Request failed: connect ECONNREFUSED 127.0.0.1:443'],
    ['a conditional write that is not re-sent', { error: 'read ECONNRESET', code: 'ECONNRESET' }, (http) => http.patch('https://org.crm.dynamics.com/x', { a: 1 }, { headers: { 'If-Match': 'W/"1"' } }), /^Request failed: read ECONNRESET — this conditional PATCH was not re-sent/],
    ['a POST whose answer was cut off', { error: 'socket hang up', code: 'ECONNRESET', incompleteResponse: true, statusCode: 201 }, (http) => http.post('https://org.crm.dynamics.com/x', { a: 1 }), /^Request failed: socket hang up — the server had already answered 201, so this POST may have been applied/],
  ];
  for (const [what, answer, send, message] of cases) {
    const { request } = fakeTransport(answer);
    const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request, sleep: async () => {}, random: () => 0 });
    const error = await send(http).then(() => null, (e) => e);
    assert.ok(error instanceof Error, what);
    if (typeof message === 'string') assert.strictEqual(error.message, message, what); else assert.match(error.message, message, what);
    assert.strictEqual(error.code, answer.code, `${what}: Node's code`);
  }
  const { request } = fakeTransport({ error: 'Request timed out' });
  const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request, sleep: async () => {}, random: () => 0, sendOnce: () => true });
  const bare = await http.get('https://org.crm.dynamics.com/x').then(() => null, (e) => e);
  assert.strictEqual(bare.message, 'Request failed: Request timed out');
  assert.ok(!('code' in bare), 'a failure Node gave no code for has none');
});

// The client and the build's policy are written apart (the client is copied into the pcf plugin, which has no policy), so these hold them together for the code, as the test above holds the words: a failure either calls a blip is a blip for both.
test('the client and lib/retry-policy.js decide a failure alike by its code — with the words beside it, whatever they quote', () => {
  const { judgeFailure, TRANSPORT_CODES } = require('../lib/retry-policy.js');
  const { ConnectionError } = require('../lib/maker-sdk.js');
  const { isTransientTransportFailure, TRANSIENT_TRANSPORT_CODES } = require('../lib/sdk-http-client.js');
  const url = 'https://org.crm.dynamics.com/api/data/v9.0/x';
  // What the SDK does with the error the client throws: a ConnectionError of status 0 that keeps it as its cause (cds-maker-sdk DataverseClient.send).
  const blip = (words, code) => {
    const thrown = Object.assign(new Error(`Request failed: ${words}`), code ? { code } : {});
    return judgeFailure(new ConnectionError(url, 0, thrown.message, thrown)).transport;
  };
  for (const code of [...TRANSIENT_TRANSPORT_CODES, ...X509_CODES, 'ENOTFOUND', 'ECONNREFUSED', 'EHOSTUNREACH', 'ERR_SOCKET_CLOSED']) {
    for (const words of ['read ECONNRESET', 'nothing to recognise', "Hostname/IP does not match certificate's altnames: Host: contoso.crm.dynamics.com. is not in the cert's altnames: DNS:ECONNRESET.example.com"]) {
      assert.strictEqual(isTransientTransportFailure(words, code), blip(words, code), `${code}: ${words}`);
      assert.strictEqual(isTransientTransportFailure(words, code), TRANSIENT_TRANSPORT_CODES.has(code), `${code}: the code alone decides: ${words}`);
    }
  }
  // The policy's list is the client's, and the codes of undici's own errors — which the plugin's https transport never raises, and a fetch-based caller can.
  assert.deepStrictEqual([...TRANSPORT_CODES].filter((code) => !TRANSIENT_TRANSPORT_CODES.has(code)).sort(), ['UND_ERR_BODY_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET']);
  for (const code of TRANSIENT_TRANSPORT_CODES) assert.ok(TRANSPORT_CODES.has(code), code);
});

// A record delete that LOST A SQL DEADLOCK is the exception: the server answered that it rolled the
// transaction back, so nothing is in flight to race and nothing was deleted. Captured live on a
// teardown's process-flow delete.
const DEADLOCK_500 = { statusCode: 500, headers: {}, body: JSON.stringify({ error: { code: '0x80044150', message: ' Sql error: Generic SQL error. CRM ErrorCode: -2147204784 Sql ErrorCode: -2146232060 Sql Number: 1205' } }) };
test('DOES re-send a RECORD delete that lost a SQL deadlock (1205), at most three times, 1 s / 2 s / 4 s', async () => {
  const slept = [];
  const { request, calls } = fakeTransport(() => (calls.length <= 2 ? DEADLOCK_500 : { statusCode: 204, headers: {}, body: '' }));
  const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request, sleep: async (ms) => { slept.push(ms); } });
  const res = await http.delete('https://org.crm.dynamics.com/api/data/v9.0/workflows(1)');
  assert.strictEqual(res.status, 204);
  assert.strictEqual(calls.length, 3);
  assert.deepStrictEqual(slept, [1000, 2000]);

  const { request: always, calls: calls2 } = fakeTransport(DEADLOCK_500);
  const slept2 = [];
  const http2 = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request: always, sleep: async (ms) => { slept2.push(ms); } });
  const gaveUp = await http2.delete('https://org.crm.dynamics.com/api/data/v9.0/workflows(1)');
  assert.strictEqual(gaveUp.status, 500, 'after the last re-send the deadlock surfaces unchanged');
  assert.strictEqual(calls2.length, 4, 'four attempts in all');
  assert.deepStrictEqual(slept2, [1000, 2000, 4000]);
});

test('a 500 that is NOT a deadlock victim, or a $batch, still gets exactly one record delete', async () => {
  for (const body of ['', JSON.stringify({ error: { message: 'Sql error: Generic SQL error. Sql Number: 12050' } }), JSON.stringify({ error: { message: 'The transaction was rolled back or committed' } })]) {
    const { request, calls } = fakeTransport({ statusCode: 500, headers: {}, body });
    const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request, sleep: async () => {} });
    await http.delete('https://org.crm.dynamics.com/api/data/v9.0/workflows(1)');
    assert.strictEqual(calls.length, 1, `not re-sent for ${JSON.stringify(body)}`);
  }
  const { request, calls } = fakeTransport(DEADLOCK_500);
  const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request, sleep: async () => {} });
  await http.postRaw('https://org.crm.dynamics.com/api/data/v9.0/$batch', '--b\r\n', { headers: { 'Content-Type': 'multipart/mixed;boundary=b' } });
  assert.strictEqual(calls.length, 1, 'a $batch answer that does not show its operations\u2019 results is not re-sent');
});

// What makes a 500 a deadlock victim is the SQL number the service gives LAST. The platform writes its own diagnostic at the end of a SQL error's message, after the SQL text, and the SQL text can quote what a maker named — a duplicate-key
// error (SQL 2627) quotes the value that collided:
//   Sql error: Violation of UNIQUE KEY constraint 'ndx_name'. Cannot insert duplicate key. The duplicate key value is (Sql Number: 1205). CRM ErrorCode: -2147204784 Sql ErrorCode: -2146232060 Sql Number: 2627
// A name spelled `Sql Number: 1205` is in that answer and no deadlock happened, so a name in front of the diagnostic decides nothing — whether it spells the deadlock's number in front of another one, or another number in front of the deadlock's.
const DIAGNOSTIC = (number) => ` CRM ErrorCode: -2147204784 Sql ErrorCode: -2146232060 Sql Number: ${number}`;
const QUOTING = (number, name = 'Sql Number: 1205') => ` Sql error: Violation of UNIQUE KEY constraint 'ndx_name'. Cannot insert duplicate key. The duplicate key value is (${name}).${DIAGNOSTIC(number)}`;
test('the deadlock signature is the LAST SQL number an answer gives — a maker\'s name that quotes 1205 cannot make a unique-key violation a deadlock victim, nor hide a real one', () => {
  const { SQL_DEADLOCK_VICTIM } = require('../lib/sdk-http-client.js');
  const victims = [
    ['the platform\'s own answer', ` Sql error: Generic SQL error.${DIAGNOSTIC(1205)}`],
    ['the number alone', 'Sql Number: 1205'],
    ['in any case, with no space after the colon', 'SQL NUMBER:1205'],
    ['text after the number', `Sql error: Generic SQL error.${DIAGNOSTIC(1205)}. Rerun the transaction.`],
    ['the number twice, the same one both times', 'Sql Number: 1205 (inner: Sql Number: 1205)'],
    ['a later "Sql Number:" that gives no number', 'Sql Number: 1205 (Sql Number: unknown)'],
    ['a name in front of it that quotes another SQL number', QUOTING(1205, 'Sql Number: 547')],
    ['a name in front of it that quotes the same number', QUOTING(1205)],
    ['the answer as the client reads it: the JSON of its body', JSON.stringify({ error: { code: '0x80044150', message: QUOTING(1205) } })],
  ];
  const others = [
    ['another number', ` Sql error: Generic SQL error.${DIAGNOSTIC(547)}`],
    ['a unique key (2627) after a name that quotes the deadlock\'s number', QUOTING(2627)],
    ['a constraint (547) after a name that quotes it', QUOTING(547)],
    ['a lock timeout (1222) after a name that quotes it', QUOTING(1222)],
    ['the same, as the client reads it: the JSON of the body', JSON.stringify({ error: { code: '0x80044150', message: QUOTING(2627) } })],
    ['a number that only starts with 1205', ` Sql error: Generic SQL error.${DIAGNOSTIC(12050)}`],
    ['the deadlock\'s number in front of another', 'Sql Number: 1205 (inner: Sql Number: 547)'],
    ['no SQL number at all', ' Sql error: Generic SQL error.'],
  ];
  for (const [what, text] of victims) assert.strictEqual(SQL_DEADLOCK_VICTIM.test(text), true, `a deadlock victim: ${what}`);
  for (const [what, text] of others) assert.strictEqual(SQL_DEADLOCK_VICTIM.test(text), false, `not a deadlock victim: ${what}`);
  // The check is linear in the text: a message that repeats the marker tens of thousands of times is read in a moment (a few milliseconds), not in a time that grows with the square of its length (seconds).
  const flood = 'Sql Number: 1205 '.repeat(40000);
  const started = Date.now();
  assert.strictEqual(SQL_DEADLOCK_VICTIM.test(flood), true);
  assert.strictEqual(SQL_DEADLOCK_VICTIM.test(`${flood}Sql Number: 547`), false);
  assert.ok(Date.now() - started < 3000, `a flood of markers took ${Date.now() - started} ms`);
});

test('a RECORD delete whose 500 only quotes the deadlock\'s number in a name is sent ONCE — and the platform\'s own deadlock after the same quote is still re-sent', async () => {
  for (const number of [547, 2627, 1222]) {
    const slept = [];
    const { request, calls } = fakeTransport({ statusCode: 500, headers: {}, body: JSON.stringify({ error: { code: '0x80044150', message: QUOTING(number) } }) });
    const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request, sleep: async (ms) => { slept.push(ms); } });
    const res = await http.delete('https://org.crm.dynamics.com/api/data/v9.0/roles(1)');
    assert.strictEqual(res.status, 500, `SQL ${number}`);
    assert.strictEqual(calls.length, 1, `SQL ${number}: not re-sent`);
    assert.deepStrictEqual(slept, [], `SQL ${number}: and nothing waited for`);
  }
  const slept = [];
  const { request, calls } = fakeTransport(() => (calls.length <= 1 ? { statusCode: 500, headers: {}, body: JSON.stringify({ error: { code: '0x80044150', message: QUOTING(1205) } }) } : { statusCode: 204, headers: {}, body: '' }));
  const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request, sleep: async (ms) => { slept.push(ms); } });
  const res = await http.delete('https://org.crm.dynamics.com/api/data/v9.0/roles(1)');
  assert.strictEqual(res.status, 204, 'the platform\'s own deadlock diagnostic is a deadlock, whatever the name in front of it says');
  assert.strictEqual(calls.length, 2);
  assert.deepStrictEqual(slept, [1000]);
});

test('DOES retry a METADATA delete (EntityDefinitions) on a network error — async-idempotent, gets cosmetic 404', async () => {
  const { request, calls } = fakeTransport(() =>
    calls.length <= 1 ? { error: 'ETIMEDOUT' } : { statusCode: 404, headers: {}, body: '' }
  );
  const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request, sleep: async () => {} });
  const res = await http.delete("https://org.crm.dynamics.com/api/data/v9.0/EntityDefinitions(LogicalName='new_x')");
  assert.strictEqual(res.status, 404, 'a slow metadata delete is retried rather than surfacing a false timeout');
  assert.strictEqual(calls.length, 2);
});

// A write we stop waiting for is an UNKNOWN outcome, not a failure, so writes wait far longer than
// reads. Measured live: a business process flow activation on a fresh table ran past the old 60 s.
test('a WRITE waits far longer than a read before giving up', async () => {
  const { request, calls } = fakeTransport({ statusCode: 204, headers: {}, body: '' });
  const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request });
  await http.get('https://org.crm.dynamics.com/x');
  await http.post('https://org.crm.dynamics.com/x', { a: 1 });
  await http.patch('https://org.crm.dynamics.com/x', { a: 1 });
  await http.put('https://org.crm.dynamics.com/x', { a: 1 });
  await http.delete('https://org.crm.dynamics.com/x');
  const [get, ...writes] = calls.map((c) => c.timeout);
  assert.strictEqual(get, 60000, 'a read keeps the short timeout — it is safe to abandon and re-issue');
  for (const t of writes) assert.ok(t >= 120000, `every write must wait well past 60 s; got ${t}`);
});

// The retry that failed a build live: the activation committed after the client gave up, and the
// re-send — carrying the token the activation had just superseded — was refused with a 412.
test('a CONDITIONAL write that got no answer is NOT re-sent (it may still commit)', async () => {
  for (const header of ['If-Match', 'if-match']) {
    const { request, calls } = fakeTransport({ error: 'Request timed out' });
    const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request, sleep: async () => {} });
    await assert.rejects(
      () => http.patch('https://org.crm.dynamics.com/api/data/v9.2/workflows(1)', { statecode: 1 }, { headers: { [header]: 'W/"5"' } }),
      /Request failed: Request timed out .*not re-sent/);
    assert.strictEqual(calls.length, 1, `exactly one conditional PATCH may be sent (header spelled ${header})`);
  }
});

test('the no-re-send rule is scoped: an UNCONDITIONAL write that got no answer is still retried', async () => {
  const { request, calls } = fakeTransport(() => (calls.length <= 1 ? { error: 'ETIMEDOUT' } : { statusCode: 204, headers: {}, body: '' }));
  const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request, sleep: async () => {} });
  const res = await http.patch('https://org.crm.dynamics.com/api/data/v9.2/workflows(1)', { statecode: 1 });
  assert.strictEqual(res.status, 204);
  assert.strictEqual(calls.length, 2);
});

test('a CONDITIONAL write that got an ANSWER keeps the status retry (429 means it was never processed)', async () => {
  const { request, calls } = fakeTransport(() => (calls.length <= 1 ? { statusCode: 429, headers: {}, body: '' } : { statusCode: 204, headers: {}, body: '' }));
  const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request, sleep: async () => {} });
  const res = await http.patch('https://org.crm.dynamics.com/x', { a: 1 }, { headers: { 'If-Match': 'W/"5"' } });
  assert.strictEqual(res.status, 204, 'a throttled conditional write is retried');
  assert.strictEqual(calls.length, 2);
});

test('throws only when no token is available', async () => {
  const { request } = fakeTransport({ statusCode: 200, headers: {}, body: '{}' });
  const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => null, request });
  await assert.rejects(() => http.get('https://org.crm.dynamics.com/x'), /Failed to get Azure CLI token/);
});

test('refuses to send the Dataverse token to a different origin (same-origin guard)', async () => {
  const { request, calls } = fakeTransport({ statusCode: 200, headers: {}, body: '{}' });
  const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request });
  // A URL under a DIFFERENT origin must be rejected before any request/token is sent.
  await assert.rejects(() => http.get('https://evil.example.com/api/data/v9.2/accounts'), /different origin/);
  assert.strictEqual(calls.length, 0, 'no request is sent to a foreign origin');
  // A same-origin URL still works.
  const res = await http.get('https://org.crm.dynamics.com/api/data/v9.2/accounts');
  assert.strictEqual(res.status, 200);
});

test('rejects a non-https or malformed org URL at construction (fail-closed credential boundary)', () => {
  // A malformed/hostile --env must fail loudly at construction rather than silently disable the guard.
  assert.throws(() => createAzHttpClient('http://org.crm.dynamics.com', { getToken: () => 'TOK' }), /https/);
  assert.throws(() => createAzHttpClient('not-a-url', { getToken: () => 'TOK' }), /https/);
});

// --- postRaw: the multipart/mixed $batch transport ------------------------------------------
// The SDK makes multi-row writes atomic via an OData `$batch` change set, and it will NOT
// degrade to sequential requests: without postRaw, deleting an app that owns a sitemap fails
// with APP_DELETE_NOT_ATOMIC rather than risk stranding a row between two calls.
// See the HttpClient contract in the SDK: src/types/httpClient.ts.

// A realistic multipart/mixed $batch response. The SDK parses each operation's status line out
// of this string, so the envelope must survive the transport byte-for-byte:
//   --batchresponse_<guid>
//   Content-Type: multipart/mixed; boundary=changesetresponse_<guid>
//
//   --changesetresponse_<guid>
//   Content-Type: application/http
//   Content-ID: 1
//
//   HTTP/1.1 204 No Content
//   ...
const BATCH_RESPONSE = [
  '--batchresponse_b1',
  'Content-Type: multipart/mixed; boundary=changesetresponse_c1',
  '',
  '--changesetresponse_c1',
  'Content-Type: application/http',
  'Content-ID: 1',
  '',
  'HTTP/1.1 204 No Content',
  '',
  '--changesetresponse_c1--',
  '',
  '--batchresponse_b1--',
  '',
].join('\r\n');

test('postRaw sends the body VERBATIM and returns the multipart response as a raw STRING', async () => {
  const { request, calls } = fakeTransport({ statusCode: 200, headers: {}, body: BATCH_RESPONSE });
  const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request });
  const body = '--batch_a1\r\nContent-Type: application/http\r\n\r\nDELETE /x HTTP/1.1\r\n\r\n--batch_a1--';
  const res = await http.postRaw('https://org.crm.dynamics.com/api/data/v9.2/$batch', body, {
    headers: { 'Content-Type': 'multipart/mixed;boundary=batch_a1' },
  });
  assert.strictEqual(calls[0].method, 'POST');
  assert.strictEqual(calls[0].body, body, 'the multipart payload must not be re-serialized');
  assert.strictEqual(
    calls[0].headers['Content-Type'],
    'multipart/mixed;boundary=batch_a1',
    "the caller's boundary-bearing Content-Type must win over the JSON default"
  );
  assert.strictEqual(typeof res.body, 'string', 'the SDK reads status lines out of the raw envelope');
  assert.strictEqual(res.body, BATCH_RESPONSE);
  assert.strictEqual(res.status, 200);
});

test('postRaw never JSON-parses a body that happens to be valid JSON', async () => {
  // parseBody() would turn this into an object and the SDK would throw ConnectionError
  // ("body is not a string"). postRaw must bypass parsing unconditionally, not by accident.
  const { request } = fakeTransport({ statusCode: 200, headers: {}, body: '{"not":"multipart"}' });
  const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request });
  const res = await http.postRaw('https://org.crm.dynamics.com/api/data/v9.2/$batch', 'x', { headers: { 'Content-Type': 'multipart/mixed;boundary=b' } });
  assert.strictEqual(typeof res.body, 'string');
  assert.strictEqual(res.body, '{"not":"multipart"}');
});

test('postRaw does NOT retry a $batch on a transient status (the change set contains DELETEs)', async () => {
  // Same hazard as a bare record DELETE: Dataverse's "More than one concurrent Delete requests
  // detected" guard permanently wedges a row when a retry races the still-in-flight first delete.
  // A $batch carries DELETEs inside a POST, so the method-based noRetry rule must cover it too.
  const { request, calls } = fakeTransport({ statusCode: 503, headers: {}, body: 'busy' });
  const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request, sleep: async () => {} });
  const res = await http.postRaw('https://org.crm.dynamics.com/api/data/v9.2/$batch', 'x', { headers: { 'Content-Type': 'multipart/mixed;boundary=b' } });
  assert.strictEqual(calls.length, 1, 'a $batch is issued exactly once');
  assert.strictEqual(res.status, 503, 'the transient status is surfaced, not retried away');
});

test('postRaw does NOT retry a $batch on a network error either', async () => {
  const { request, calls } = fakeTransport({ error: 'ETIMEDOUT' });
  const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request, sleep: async () => {} });
  await assert.rejects(
    () => http.postRaw('https://org.crm.dynamics.com/api/data/v9.2/$batch', 'x', { headers: { 'Content-Type': 'multipart/mixed;boundary=b' } }),
    /Request failed/
  );
  assert.strictEqual(calls.length, 1, 'an ambiguous batch outcome is never re-issued blindly');
});

// An ANSWERED batch whose change set lost a SQL deadlock is the exception, when the batch is made of
// conditional deletes: a change set is atomic, so the answer proves nothing in it committed, and a second
// send meets the rows as the first did or is refused with 412. Captured live on a teardown's app delete
// (the app and its sitemap in one change set); the whole teardown stopped on it with nothing removed.
const batchAnswer = (...parts) => [
  '--batchresponse_b1',
  'Content-Type: multipart/mixed; boundary=changesetresponse_c1',
  '',
  ...parts.flatMap(([status, json], i) => [
    '--changesetresponse_c1', 'Content-Type: application/http', 'Content-Transfer-Encoding: binary', `Content-ID: ${i + 1}`, '',
    status, 'REQ_ID: 00000000-0000-0000-0000-000000000000', 'Content-Type: application/json; odata.metadata=minimal', 'OData-Version: 4.0', '',
    json || '',
  ]),
  '--changesetresponse_c1--',
  '--batchresponse_b1--',
  '',
].join('\r\n');
const DEADLOCK_PART = ['HTTP/1.1 500 Internal Server Error', JSON.stringify({ error: { code: '0x80044150', message: ' Sql error: Generic SQL error. CRM ErrorCode: -2147204784 Sql ErrorCode: -2146232060 Sql Number: 1205' } })];
const BATCH_DEADLOCK_500 = { statusCode: 500, headers: {}, body: batchAnswer(DEADLOCK_PART) };
// What a malformed answer looks like that STILL closes its outer boundary: the change set's own closing delimiter is missing, or a part follows the others that is cut off. `withPart` adds a part after the ones
// `batchAnswer` made — `lines` is what follows its delimiter: the part's headers, a blank line, what it says — and `unclosed` takes the change set's closing delimiter away.
const withPart = (answer, lines) => answer.replace('--changesetresponse_c1--', ['--changesetresponse_c1', ...lines, '--changesetresponse_c1--'].join('\r\n'));
const unclosed = (answer) => answer.replace('--changesetresponse_c1--\r\n', '');
const CUT_OFF_PART = ['Content-Type: application/http', 'Content-Transfer-Encoding: binary', '', 'HTTP/1.1 20'];
// A batch request as the SDK renders one: `ops` are [method, url, extra header lines].
const batchRequest = (...ops) => [
  '--batch_b', 'Content-Type: multipart/mixed;boundary=changeset_c', '',
  ...ops.flatMap(([method, url, headers = []], i) => ['--changeset_c', 'Content-Type: application/http', 'Content-Transfer-Encoding: binary', `Content-ID: ${i + 1}`, '', `${method} ${url} HTTP/1.1`, ...headers, '']),
  '--changeset_c--', '--batch_b--', '',
].join('\r\n');
// The SDK's atomic app delete: the app and its sitemap, each conditioned on the row version it read.
const APP_DELETE = batchRequest(
  ['DELETE', 'https://org.crm.dynamics.com/api/data/v9.0/appmodules(11111111-1111-1111-1111-111111111111)', ['If-Match: W/"1001"']],
  ['DELETE', 'https://org.crm.dynamics.com/api/data/v9.0/sitemaps(33333333-3333-3333-3333-333333333333)', ['If-Match: W/"2002"']],
);
const postBatch = (http, body = APP_DELETE) => http.postRaw('https://org.crm.dynamics.com/api/data/v9.0/$batch', body, { headers: { 'Content-Type': 'multipart/mixed;boundary=batch_b' } });

test('postRaw DOES re-send a $batch whose change set lost a SQL deadlock, at most three times, 1 s / 2 s / 4 s', async () => {
  const slept = [];
  const { request, calls } = fakeTransport(() => (calls.length <= 1 ? BATCH_DEADLOCK_500 : { statusCode: 200, headers: {}, body: BATCH_RESPONSE }));
  const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request, sleep: async (ms) => { slept.push(ms); } });
  const res = await postBatch(http);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body, BATCH_RESPONSE, 'the SDK reads the re-sent batch\u2019s own answer, raw');
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[1].body, calls[0].body, 'the same change set, byte for byte');
  assert.deepStrictEqual(slept, [1000]);

  const { request: always, calls: calls2 } = fakeTransport(BATCH_DEADLOCK_500);
  const slept2 = [];
  const http2 = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request: always, sleep: async (ms) => { slept2.push(ms); } });
  const gaveUp = await postBatch(http2);
  assert.strictEqual(gaveUp.status, 500, 'after the last re-send the deadlock surfaces unchanged');
  assert.strictEqual(gaveUp.body, BATCH_DEADLOCK_500.body);
  assert.strictEqual(calls2.length, 4, 'four attempts in all');
  assert.deepStrictEqual(slept2, [1000, 2000, 4000]);
});

test('postRaw DOES re-send a $batch whose change set lost a SQL deadlock after a name that quotes another SQL number — the last number is the service\'s own', async () => {
  const body = batchAnswer(['HTTP/1.1 500 Internal Server Error', JSON.stringify({ error: { code: '0x80044150', message: QUOTING(1205, 'Sql Number: 547') } })]);
  const slept = [];
  const { request, calls } = fakeTransport(() => (calls.length <= 1 ? { statusCode: 500, headers: {}, body } : { statusCode: 200, headers: {}, body: BATCH_RESPONSE }));
  const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request, sleep: async (ms) => { slept.push(ms); } });
  const res = await postBatch(http);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(calls.length, 2);
  assert.deepStrictEqual(slept, [1000]);
});

test('postRaw re-sends a $batch ONLY when its answer proves every operation was rolled back as a deadlock victim', async () => {
  const answers = {
    'an operation that committed beside the deadlocked one': batchAnswer(['HTTP/1.1 204 No Content'], DEADLOCK_PART),
    // A nested SQL error can repeat the marker, so counting markers alone is not the proof: a committed
    // operation beside it still means the batch must not be sent again.
    'an operation that committed beside a failure that names the deadlock twice': batchAnswer(['HTTP/1.1 204 No Content'], ['HTTP/1.1 500 Internal Server Error', JSON.stringify({ error: { message: 'Sql Number: 1205 (inner: Sql Number: 1205)' } })]),
    'a failure that is not a deadlock': batchAnswer(['HTTP/1.1 412 Precondition Failed', JSON.stringify({ error: { code: '0x80060882', message: 'The version of the existing record doesn\'t match' } })]),
    'a 500 without the deadlock number': batchAnswer(['HTTP/1.1 500 Internal Server Error', JSON.stringify({ error: { message: 'Sql error: Generic SQL error. Sql Number: 12050' } })]),
    'two failed operations, only one of them a deadlock': batchAnswer(DEADLOCK_PART, ['HTTP/1.1 500 Internal Server Error', JSON.stringify({ error: { message: 'Generic SQL error' } })]),
    // Each operation must name the deadlock in its OWN part: one part repeating the marker proves nothing
    // about the other (independent operations can be answered separately).
    'the marker twice in one operation, none in the other': batchAnswer(['HTTP/1.1 500 Internal Server Error', JSON.stringify({ error: { message: 'Sql Number: 1205 (inner: Sql Number: 1205)' } })], ['HTTP/1.1 500 Internal Server Error', JSON.stringify({ error: { message: 'Generic SQL error' } })]),
    'a truncated answer (no closing delimiter)': batchAnswer(DEADLOCK_PART).replace(/--batchresponse_b1--\r\n$/, ''),
    // Closed at the OUTER boundary and still incomplete inside: nothing proves the deadlock was the answer of every operation, so the one complete part that says so is not taken for the whole.
    'an answer closed at its outer boundary whose change set is never closed': unclosed(batchAnswer(DEADLOCK_PART)),
    'an answer closed at its outer boundary with a part cut off after the deadlocked one': withPart(batchAnswer(DEADLOCK_PART), CUT_OFF_PART),
    // Only a 500 is a rolled-back deadlock victim; another status whose message quotes one is not.
    'another status whose error quotes the deadlock': batchAnswer(['HTTP/1.1 400 Bad Request', JSON.stringify({ error: { message: 'Validation failed (inner: Sql Number: 1205)' } })]),
    // The number that counts is the last the answer gives: a name that quotes 1205 in front of the service's own other number is not a deadlock.
    'a failure whose own SQL number is another, after a name that quotes the deadlock\u2019s': batchAnswer(['HTTP/1.1 500 Internal Server Error', JSON.stringify({ error: { code: '0x80044150', message: QUOTING(2627) } })]),
    'the same for every operation of the change set': batchAnswer(['HTTP/1.1 500 Internal Server Error', JSON.stringify({ error: { code: '0x80044150', message: QUOTING(547) } })], ['HTTP/1.1 500 Internal Server Error', JSON.stringify({ error: { code: '0x80044150', message: QUOTING(2627) } })]),
    'a complete answer with no operation results': '--batchresponse_b1\r\n--batchresponse_b1--\r\n',
  };
  for (const [what, body] of Object.entries(answers)) {
    const { request, calls } = fakeTransport({ statusCode: 500, headers: {}, body });
    const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request, sleep: async () => {} });
    const res = await postBatch(http);
    assert.strictEqual(calls.length, 1, `not re-sent: ${what}`);
    assert.strictEqual(res.body, body, `and the answer reaches the SDK as it came: ${what}`);
  }
  // A batch that is not made of conditional deletes is never sent again, whatever its answer. The SDK
  // updates a generative page's files with `If-Match: *` after checking their versions itself: a second
  // send after the backoff would skip that check and overwrite another maker's edit.
  const requests = {
    'unconditional writes (a generative page update)': batchRequest(['PATCH', 'https://org.crm.dynamics.com/api/data/v9.0/uxagentprojectfiles(1)', ['If-Match: *']]),
    'a DELETE with no condition (the SDK\u2019s create rollback)': batchRequest(['DELETE', 'https://org.crm.dynamics.com/api/data/v9.0/appmodules(1)']),
    'a DELETE conditioned on anything': batchRequest(['DELETE', 'https://org.crm.dynamics.com/api/data/v9.0/appmodules(1)', ['If-Match: *']]),
    'a conditional DELETE beside a write': batchRequest(['DELETE', 'https://org.crm.dynamics.com/api/data/v9.0/appmodules(1)', ['If-Match: W/"1"']], ['POST', 'https://org.crm.dynamics.com/api/data/v9.0/sitemaps', []]),
    // Deliberately only DELETEs: a write conditioned on its own row can still rest on rows the batch does
    // not condition on, which a second send would not look at again.
    'writes each conditioned on a row version': batchRequest(['PATCH', 'https://org.crm.dynamics.com/api/data/v9.0/appmodules(1)', ['If-Match: W/"1"']], ['PATCH', 'https://org.crm.dynamics.com/api/data/v9.0/sitemaps(2)', ['If-Match: W/"2"']]),
    'no operation at all': '--b\r\n',
  };
  for (const [what, body] of Object.entries(requests)) {
    const { request, calls } = fakeTransport(BATCH_DEADLOCK_500);
    const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request, sleep: async () => {} });
    await postBatch(http, body);
    assert.strictEqual(calls.length, 1, `not re-sent: ${what}`);
  }
  // The same deadlocked answer to anything but a $batch or a record delete is left to the status retry.
  const { request, calls } = fakeTransport(() => (calls.length <= 1 ? BATCH_DEADLOCK_500 : { statusCode: 200, headers: {}, body: '{}' }));
  const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request, sleep: async () => {} });
  await http.get('https://org.crm.dynamics.com/api/data/v9.0/accounts');
  assert.strictEqual(calls.length, 2, 'a GET keeps its ordinary transient retry');
});

// A 429 is the other answer that proves a delete did not run: the server refused to START it. Captured live
// at the end of two teardowns — the solution delete, refused while the platform was still finishing the
// teardown's own table delete — and both teardowns stopped with the solution left behind.
const UNINSTALL_429 = { statusCode: 429, headers: {}, body: JSON.stringify({ error: { code: '0x80071151', message: 'Cannot start the requested operation [Uninstall] because there is another [EntityCustomization] running at this moment. Use Solution History for more details. -- The solution installation or removal failed due to the installation or removal of another solution at the same time. Please try again later.' } }) };
test('DOES re-send a RECORD delete refused with 429 (it was never started), on the throttle schedule', async () => {
  const slept = [];
  const { request, calls } = fakeTransport(() => (calls.length <= 2 ? UNINSTALL_429 : { statusCode: 204, headers: {}, body: '' }));
  const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request, random: () => 0.5, sleep: async (ms) => { slept.push(ms); } });
  const res = await http.delete('https://org.crm.dynamics.com/api/data/v9.0/solutions(1)');
  assert.strictEqual(res.status, 204);
  assert.strictEqual(calls.length, 3);
  assert.deepStrictEqual(slept, [1125, 2250], 'the jittered backoff every other throttled request gets');

  const { request: always, calls: calls2 } = fakeTransport(UNINSTALL_429);
  const http2 = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request: always, sleep: async () => {} });
  const gaveUp = await http2.delete('https://org.crm.dynamics.com/api/data/v9.0/solutions(1)');
  assert.strictEqual(gaveUp.status, 429, 'after the last attempt the refusal surfaces unchanged');
  assert.strictEqual(gaveUp.body.error.code, '0x80071151');
  assert.strictEqual(calls2.length, 6, 'six attempts in all, like any other throttled request');
});

test('postRaw DOES re-send a $batch of conditional deletes that was refused with 429, in either shape', async () => {
  const answers = {
    // Service protection refuses the whole request before reading an operation: a plain error answer.
    'the whole request refused': { statusCode: 429, headers: {}, body: JSON.stringify({ error: { code: '0x80072322', message: 'Number of requests exceeded the limit of 6000 over time window of 300 seconds.' } }) },
    'the whole request refused, no body': { statusCode: 429, headers: {}, body: '' },
    'its change set refused': { statusCode: 429, headers: {}, body: batchAnswer(['HTTP/1.1 429 Too Many Requests', UNINSTALL_429.body]) },
    'every operation refused, whatever the outer status': { statusCode: 200, headers: {}, body: batchAnswer(['HTTP/1.1 429 Too Many Requests', '{}'], ['HTTP/1.1 429 Too Many Requests', '{}']) },
  };
  for (const [what, refused] of Object.entries(answers)) {
    const { request, calls } = fakeTransport(() => (calls.length <= 1 ? refused : { statusCode: 200, headers: {}, body: BATCH_RESPONSE }));
    const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request, sleep: async () => {} });
    const res = await postBatch(http);
    assert.strictEqual(calls.length, 2, `re-sent: ${what}`);
    assert.strictEqual(calls[1].body, calls[0].body, `the same change set, byte for byte: ${what}`);
    assert.strictEqual(res.body, BATCH_RESPONSE, `the SDK reads the re-sent batch's own answer: ${what}`);
  }
});

test('postRaw re-sends a 429 $batch ONLY when it is made of conditional deletes (or of column creates, below) and the answer proves nothing ran', async () => {
  const answers = {
    'an operation that committed beside the refused one': batchAnswer(['HTTP/1.1 204 No Content'], ['HTTP/1.1 429 Too Many Requests', '{}']),
    'a refusal beside another failure': batchAnswer(['HTTP/1.1 429 Too Many Requests', '{}'], ['HTTP/1.1 500 Internal Server Error', '{}']),
    'a multipart answer cut short': batchAnswer(['HTTP/1.1 429 Too Many Requests', '{}']).replace(/--batchresponse_b1--\r\n$/, ''),
    // Closed at the OUTER boundary and still incomplete inside: the refusal is not the whole story, so the batch is not sent again on its word.
    'an answer closed at its outer boundary whose change set is never closed': unclosed(batchAnswer(['HTTP/1.1 429 Too Many Requests', '{}'])),
    'an answer closed at its outer boundary with a part cut off beside the refused one': withPart(batchAnswer(['HTTP/1.1 429 Too Many Requests', '{}']), CUT_OFF_PART),
    'a complete answer with no operation results': '--batchresponse_b1\r\n--batchresponse_b1--\r\n',
  };
  for (const [what, body] of Object.entries(answers)) {
    const { request, calls } = fakeTransport({ statusCode: 429, headers: {}, body });
    const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request, sleep: async () => {} });
    const res = await postBatch(http);
    assert.strictEqual(calls.length, 1, `not re-sent: ${what}`);
    assert.strictEqual(res.body, body, `and the answer reaches the SDK as it came: ${what}`);
  }
  // A 429 cannot make an unsafe batch safe: a second send of a generative page's `If-Match: *` update
  // after the wait would skip the version check the SDK made before the first.
  const requests = {
    'unconditional writes (a generative page update)': batchRequest(['PATCH', 'https://org.crm.dynamics.com/api/data/v9.0/uxagentprojectfiles(1)', ['If-Match: *']]),
    'a DELETE with no condition (the SDK\u2019s create rollback)': batchRequest(['DELETE', 'https://org.crm.dynamics.com/api/data/v9.0/appmodules(1)']),
  };
  for (const [what, body] of Object.entries(requests)) {
    const { request, calls } = fakeTransport({ statusCode: 429, headers: {}, body: '' });
    const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request, sleep: async () => {} });
    await postBatch(http, body);
    assert.strictEqual(calls.length, 1, `not re-sent: ${what}`);
  }
  // Only a 429 proves the record delete was not started; the other throttling-like statuses do not.
  for (const status of [500, 502, 503, 504]) {
    const { request, calls } = fakeTransport({ statusCode: status, headers: {}, body: '' });
    const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request, sleep: async () => {} });
    await http.delete('https://org.crm.dynamics.com/api/data/v9.0/solutions(1)');
    assert.strictEqual(calls.length, 1, `a record delete answered ${status} is sent once`);
  }
});

// The ordinary columns of a new table go in one change set (the SDK's createColumns): a POST of each column's definition to the
// table's `Attributes` collection, with the solution header on each operation. It carries no delete and no conditional write, so a
// 429 — the server refused to START it, as it can while the table the columns were just created in is still held by its
// customization lock — proves nothing in it ran, and sending it again cannot remove or overwrite anything.
const columnChangeSet = (...names) => [
  '--batch_b', 'Content-Type: multipart/mixed;boundary=changeset_c', '',
  ...names.flatMap((name, i) => [
    '--changeset_c', 'Content-Type: application/http', 'Content-Transfer-Encoding: binary', `Content-ID: ${i + 1}`, '',
    "POST https://org.crm.dynamics.com/api/data/v9.0/EntityDefinitions(LogicalName='new_ticket')/Attributes HTTP/1.1",
    'Content-Type: application/json;type=entry', 'MSCRM.SolutionUniqueName: Tickets', '',
    JSON.stringify({ '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata', SchemaName: name }),
  ]),
  '--changeset_c--', '--batch_b--', '',
].join('\r\n');
const COLUMNS = columnChangeSet('new_a', 'new_b');
const TABLE_LOCKED_429 = { statusCode: 429, headers: {}, body: JSON.stringify({ error: { code: '0x80072322', message: 'Cannot start the requested operation [Publish] because there is another [EntityCustomization] running at this moment.' } }) };

test('postRaw DOES re-send a $batch that only creates columns when it was refused with 429, in either shape, on the throttle schedule', async () => {
  const answers = {
    'the whole request refused': TABLE_LOCKED_429,
    'the whole request refused, no body': { statusCode: 429, headers: {}, body: '' },
    'its change set refused': { statusCode: 429, headers: {}, body: batchAnswer(['HTTP/1.1 429 Too Many Requests', TABLE_LOCKED_429.body]) },
    'every operation refused, whatever the outer status': { statusCode: 200, headers: {}, body: batchAnswer(['HTTP/1.1 429 Too Many Requests', '{}'], ['HTTP/1.1 429 Too Many Requests', '{}']) },
  };
  for (const [what, refused] of Object.entries(answers)) {
    const slept = [];
    const { request, calls } = fakeTransport(() => (calls.length <= 2 ? refused : { statusCode: 200, headers: {}, body: BATCH_RESPONSE }));
    const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request, random: () => 0.5, sleep: async (ms) => { slept.push(ms); } });
    const res = await postBatch(http, COLUMNS);
    assert.strictEqual(calls.length, 3, `re-sent twice: ${what}`);
    assert.ok(calls.every((c) => c.body === COLUMNS), `the same change set, byte for byte, each time: ${what}`);
    assert.deepStrictEqual(slept, [1125, 2250], `the jittered backoff every other throttled request gets: ${what}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body, BATCH_RESPONSE, `the SDK reads the re-sent batch's own answer: ${what}`);
  }
  // It does not give up early, and it stops where every other throttled request stops: six sends in all.
  const slept = [];
  const { request, calls } = fakeTransport(TABLE_LOCKED_429);
  const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request, random: () => 0, sleep: async (ms) => { slept.push(ms); } });
  const gaveUp = await postBatch(http, COLUMNS);
  assert.strictEqual(calls.length, 6, 'six attempts in all');
  assert.deepStrictEqual(slept, [1000, 2000, 4000, 8000, 8000]);
  assert.strictEqual(gaveUp.status, 429, 'after the last attempt the refusal surfaces unchanged');
  assert.strictEqual(gaveUp.body, TABLE_LOCKED_429.body, 'raw, as the SDK reads it');
});

test('postRaw sends a $batch of column creates ONCE after every answer but a 429 that proves nothing in it ran', async () => {
  const answers = {
    'a 500': { statusCode: 500, headers: {}, body: '{"error":{"message":"An unexpected error occurred."}}' },
    'a 502': { statusCode: 502, headers: {}, body: 'bad gateway' },
    'a 503': { statusCode: 503, headers: {}, body: 'busy' },
    'a 504': { statusCode: 504, headers: {}, body: '' },
    'a refused change set (the failing operation only)': { statusCode: 400, headers: {}, body: batchAnswer(['HTTP/1.1 400 Bad Request', JSON.stringify({ error: { code: '0x80060304', message: 'Attribute createdon already exists for entity new_ticket.' } })]) },
    'a plain 400': { statusCode: 400, headers: {}, body: '{"error":{"message":"The attribute metadata is not valid for this table"}}' },
    // A change set can commit behind any of these.
    'an accepted change set': { statusCode: 200, headers: {}, body: BATCH_RESPONSE },
    'a SQL deadlock victim (re-sent for conditional deletes only)': BATCH_DEADLOCK_500,
    'an operation that committed beside the refused one': { statusCode: 429, headers: {}, body: batchAnswer(['HTTP/1.1 204 No Content'], ['HTTP/1.1 429 Too Many Requests', '{}']) },
    'a refusal beside another failure': { statusCode: 429, headers: {}, body: batchAnswer(['HTTP/1.1 429 Too Many Requests', '{}'], ['HTTP/1.1 500 Internal Server Error', '{}']) },
    'a multipart answer cut short': { statusCode: 429, headers: {}, body: batchAnswer(['HTTP/1.1 429 Too Many Requests', '{}']).replace(/--batchresponse_b1--\r\n$/, '') },
    'an answer closed at its outer boundary whose change set is never closed': { statusCode: 429, headers: {}, body: unclosed(batchAnswer(['HTTP/1.1 429 Too Many Requests', '{}'])) },
    'an answer closed at its outer boundary with a part cut off beside the refused one': { statusCode: 429, headers: {}, body: withPart(batchAnswer(['HTTP/1.1 429 Too Many Requests', '{}']), CUT_OFF_PART) },
    'a complete answer with no operation results': { statusCode: 429, headers: {}, body: '--batchresponse_b1\r\n--batchresponse_b1--\r\n' },
  };
  for (const [what, answer] of Object.entries(answers)) {
    const { request, calls } = fakeTransport(answer);
    const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request, sleep: async () => {} });
    const res = await postBatch(http, COLUMNS);
    assert.strictEqual(calls.length, 1, `sent once: ${what}`);
    assert.strictEqual(res.body, answer.body, `and the answer reaches the SDK as it came: ${what}`);
  }
  // No answer at all, or one cut off after the server had answered: the outcome is unknown, so nothing is sent again.
  for (const [what, outcome] of [['a transport failure', { error: 'ETIMEDOUT' }], ['an answer cut off after the server answered', { error: 'Connection closed before the response completed', incompleteResponse: true, statusCode: 200 }]]) {
    const { request, calls } = fakeTransport(outcome);
    const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request, sleep: async () => {} });
    await assert.rejects(postBatch(http, COLUMNS), /Request failed/, what);
    assert.strictEqual(calls.length, 1, `sent once: ${what}`);
  }
});

test('postRaw never re-sends a 429 $batch that does more than create columns', async () => {
  const column = ['POST', "https://org.crm.dynamics.com/api/data/v9.0/EntityDefinitions(LogicalName='new_ticket')/Attributes"];
  const requests = {
    'a column create beside an update': batchRequest(column, ['PATCH', 'https://org.crm.dynamics.com/api/data/v9.0/appmodules(1)', ['If-Match: *']]),
    'a column create beside a delete': batchRequest(column, ['DELETE', 'https://org.crm.dynamics.com/api/data/v9.0/appmodules(1)']),
    'a column create beside a conditional delete': batchRequest(column, ['DELETE', 'https://org.crm.dynamics.com/api/data/v9.0/appmodules(1)', ['If-Match: W/"1"']]),
    'a table create': batchRequest(['POST', 'https://org.crm.dynamics.com/api/data/v9.0/EntityDefinitions']),
    'a create in a record collection': batchRequest(['POST', 'https://org.crm.dynamics.com/api/data/v9.0/appmodules']),
    'a POST to one column, not to the collection': batchRequest(['POST', "https://org.crm.dynamics.com/api/data/v9.0/EntityDefinitions(LogicalName='new_ticket')/Attributes(11111111-1111-1111-1111-111111111111)"]),
    'an update of one column': batchRequest(['PATCH', "https://org.crm.dynamics.com/api/data/v9.0/EntityDefinitions(LogicalName='new_ticket')/Attributes"]),
    'no operation at all': '--b\r\n',
  };
  for (const [what, body] of Object.entries(requests)) {
    const { request, calls } = fakeTransport(TABLE_LOCKED_429);
    const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request, sleep: async () => {} });
    await postBatch(http, body);
    assert.strictEqual(calls.length, 1, `not re-sent: ${what}`);
  }
});

test('isColumnCreateBatch accepts a batch only when EVERY operation is a POST to a table\'s Attributes collection', () => {
  assert.strictEqual(isColumnCreateBatch(COLUMNS), true);
  assert.strictEqual(isColumnCreateBatch(columnChangeSet('new_a')), true);
  assert.strictEqual(isColumnCreateBatch(columnChangeSet(...Array.from({ length: 25 }, (_, i) => `new_c${i}`))), true);
  assert.strictEqual(isColumnCreateBatch(COLUMNS.replace(/\r\n/g, '\n')), true, 'line endings do not matter');
  assert.strictEqual(isColumnCreateBatch(APP_DELETE), false);
  assert.strictEqual(isColumnCreateBatch(''), false);
  assert.strictEqual(isColumnCreateBatch(undefined), false);
  assert.strictEqual(isColumnCreateBatch(Buffer.from(COLUMNS)), false, 'a body that is not text');
  assert.strictEqual(isColumnCreateBatch(COLUMNS.replace("POST https://org.crm.dynamics.com/api/data/v9.0/EntityDefinitions(LogicalName='new_ticket')/Attributes HTTP/1.1", "PUT https://org.crm.dynamics.com/api/data/v9.0/EntityDefinitions(LogicalName='new_ticket')/Attributes HTTP/1.1")), false, 'one operation of another method');
});

test('a throttled answer\u2019s Retry-After is honoured, up to a cap, when it asks for longer than the backoff', async () => {
  const NOW = Date.parse('2026-09-30T10:00:00Z');
  const cases = [
    ['20', 20000],
    ['600', RETRY_AFTER_CAP_MS],
    ['Wed, 30 Sep 2026 10:00:30 GMT', 30000],
    ['Wed, 30 Sep 2026 09:59:00 GMT', 1125], // already past: the backoff
    ['0', 1125],
    ['soon', 1125],
    ['1', 1125], // shorter than the backoff: the backoff
  ];
  for (const [value, want] of cases) {
    for (const [what, send] of [['a GET', (h) => h.get('https://org.crm.dynamics.com/x')], ['a record delete', (h) => h.delete('https://org.crm.dynamics.com/api/data/v9.0/solutions(1)')], ['a change set of column creates', (h) => postBatch(h, COLUMNS)]]) {
      const slept = [];
      const { request, calls } = fakeTransport(() => (calls.length <= 1 ? { statusCode: 429, headers: { 'retry-after': value }, body: '' } : { statusCode: 204, headers: {}, body: '' }));
      const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request, random: () => 0.5, now: () => NOW, sleep: async (ms) => { slept.push(ms); } });
      await send(http);
      assert.deepStrictEqual(slept, [want], `${what}, Retry-After: ${value}`);
    }
  }
  assert.strictEqual(retryAfterMs({ 'Retry-After': '7' }), 7000, 'the header name is matched case-insensitively');
  assert.strictEqual(retryAfterMs({ 'retry-after': ['9'] }), 9000);
  assert.strictEqual(retryAfterMs({}), 0);
  assert.strictEqual(retryAfterMs(undefined), 0);
  assert.strictEqual(retryAfterMs({ 'retry-after': '-5' }), 0);
});

// A caller that has its own bound on the whole wait — solution-settings.js, when it sends a refused import again — asks for the platform's request as it is, with no cap of its own, and
// decides for itself whether the wait fits. The default is what it always was.
test('retryAfterMs: the cap is a default a caller may lift — both forms, whole — and what cannot be read is still no request', () => {
  const NOW = Date.parse('2026-09-30T10:00:00Z');
  const date = (seconds) => new Date(NOW + seconds * 1000).toUTCString();
  assert.strictEqual(retryAfterMs({ 'retry-after': '180' }, NOW), RETRY_AFTER_CAP_MS, 'capped by default');
  assert.strictEqual(retryAfterMs({ 'retry-after': date(180) }, NOW), RETRY_AFTER_CAP_MS, 'the date form, capped by default');
  assert.strictEqual(retryAfterMs({ 'retry-after': '180' }, NOW, Infinity), 180000);
  assert.strictEqual(retryAfterMs({ 'retry-after': date(180) }, NOW, Infinity), 180000);
  assert.strictEqual(retryAfterMs({ 'Retry-After': ['3600'] }, NOW, Infinity), 3600000);
  assert.strictEqual(retryAfterMs({ 'retry-after': '20' }, NOW, Infinity), 20000, 'a short request is the same either way');
  assert.strictEqual(retryAfterMs({ 'retry-after': '180' }, NOW, 90000), 90000, 'any other cap');
  for (const unread of ['soon', '', '-5', '0', date(-30), '1e3']) {
    assert.strictEqual(retryAfterMs({ 'retry-after': unread }, NOW, Infinity), 0, JSON.stringify(unread));
  }
  assert.strictEqual(retryAfterMs({}, NOW, Infinity), 0);
  assert.strictEqual(retryAfterMs(undefined, NOW, Infinity), 0);
});

// An operation refused inside a batch is answered with its own headers, so its Retry-After can sit in the
// part rather than on the outer response. Ignoring it spent the six attempts in ~23 s while the server had
// asked for 30.
test('a batch refused operation by operation waits for the Retry-After in the refused operation\u2019s own headers', async () => {
  const NOW = Date.parse('2026-09-30T10:00:00Z');
  const part = (retryAfter) => ['HTTP/1.1 429 Too Many Requests' + (retryAfter ? `\r\nRetry-After: ${retryAfter}` : ''), '{}'];
  const cases = [
    ['30 in the part, none outside', { headers: {}, parts: [part('30')] }, 30000],
    ['an HTTP date in the part', { headers: {}, parts: [part('Wed, 30 Sep 2026 10:00:45 GMT')] }, 45000],
    ['the longest of two parts', { headers: {}, parts: [part('5'), part('40')] }, 40000],
    ['capped', { headers: {}, parts: [part('600')] }, RETRY_AFTER_CAP_MS],
    ['the outer header when it asks for longer', { headers: { 'retry-after': '50' }, parts: [part('10')] }, 50000],
    ['the backoff when neither asks for longer', { headers: {}, parts: [part()] }, 1125],
  ];
  for (const [what, { headers, parts }, want] of cases) {
    for (const [kind, batch] of [['conditional deletes', APP_DELETE], ['column creates', COLUMNS]]) {
      const slept = [];
      const refused = { statusCode: 429, headers, body: batchAnswer(...parts) };
      const { request, calls } = fakeTransport(() => (calls.length <= 1 ? refused : { statusCode: 200, headers: {}, body: BATCH_RESPONSE }));
      const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request, random: () => 0.5, now: () => NOW, sleep: async (ms) => { slept.push(ms); } });
      await postBatch(http, batch);
      assert.deepStrictEqual(slept, [want], `${what} (${kind})`);
    }
  }
  assert.strictEqual(batchRetryAfterMs({ body: batchAnswer(['HTTP/1.1 204 No Content\r\nRetry-After: 30']) }), 0, 'only a refused operation\u2019s wait counts');
  assert.strictEqual(batchRetryAfterMs({ body: '{"error":{}}' }), 0, 'a plain answer has no parts');
  assert.strictEqual(batchRetryAfterMs(undefined), 0);
});

// The page backend waits out a throttled page write on this very schedule (a page's change set is not re-sent by the client: lib/genpage-sdk.js), so it is one function the client and the backend share.
test('throttleBackoffMs is the schedule every throttled request waits on: 1 s, 2 s, 4 s, 8 s, 8 s — and up to a quarter more in jitter', () => {
  assert.deepStrictEqual([0, 1, 2, 3, 4, 5, 6].map((attempt) => throttleBackoffMs(attempt, () => 0)), [1000, 2000, 4000, 8000, 8000, 8000, 8000]);
  assert.deepStrictEqual([0, 1, 3, 4].map((attempt) => throttleBackoffMs(attempt, () => 0.5)), [1125, 2250, 9000, 9000], 'the jitter is on top of the capped base, so a wait can pass 8 s');
  assert.strictEqual(throttleBackoffMs(0, () => 0.999999), 1249, 'and stays under a quarter of the base');
  const real = throttleBackoffMs(2);
  assert.ok(real >= 4000 && real < 5000, `the default source of randomness: ${real}`);
});

test('isBatchThrottled reads the answer, not the outer status alone', () => {
  assert.strictEqual(isBatchThrottled({ statusCode: 429, body: '{"error":{}}' }), true);
  assert.strictEqual(isBatchThrottled({ statusCode: 503, body: '{"error":{}}' }), false);
  assert.strictEqual(isBatchThrottled({ statusCode: 429, body: batchAnswer(['HTTP/1.1 204 No Content']) }), false);
  assert.strictEqual(isBatchThrottled({ statusCode: 500, body: batchAnswer(['HTTP/1.1 429 Too Many Requests', '{}']) }), true);
  assert.strictEqual(isBatchThrottled(undefined), false);
});

// A change set the service refuses answers HTTP 200 with ONE failing part (the SDK cannot account for it: one result for N operations). The page backend asks which status that part carries, with the same strict parser
// that tells a complete throttle from a cut-off answer: only an answer whose every part is read, and says one thing, is a status.
test('completeBatchStatus: the one status a COMPLETE multipart answer reports for every operation it answers — and nothing for a mixed, an incomplete or an empty one', () => {
  assert.strictEqual(completeBatchStatus({ body: batchAnswer(['HTTP/1.1 403 Forbidden', '{}']) }), 403);
  assert.strictEqual(completeBatchStatus({ statusCode: 200, body: batchAnswer(['HTTP/1.1 429 Too Many Requests\r\nRetry-After: 7']) }), 429);
  assert.strictEqual(completeBatchStatus({ body: batchAnswer(['HTTP/1.1 404 Not Found'], ['HTTP/1.1 404 Not Found']) }), 404, 'every part the same');
  assert.strictEqual(completeBatchStatus({ body: batchAnswer(['HTTP/1.1 204 No Content'], ['HTTP/1.1 204 No Content']) }), 204, 'a change set that succeeded is uniform too: the caller decides which statuses it is looking for');
  assert.strictEqual(completeBatchStatus({ body: batchAnswer(['HTTP/1.1 403 Forbidden'], ['HTTP/1.1 429 Too Many Requests']) }), 0, 'a mix');
  assert.strictEqual(completeBatchStatus({ body: batchAnswer(['HTTP/1.1 204 No Content'], ['HTTP/1.1 403 Forbidden']) }), 0, 'some succeeded');
  assert.strictEqual(completeBatchStatus({ body: batchAnswer(['HTTP/1.1 403 Forbidden']).replace(/--batchresponse_b1--\r\n$/, '') }), 0, 'an answer cut short before its closing boundary proves nothing');
  for (const body of ['', '{"error":{}}', undefined, null, 5, Buffer.from('x')]) assert.strictEqual(completeBatchStatus({ body }), 0, String(body));
  assert.strictEqual(completeBatchStatus(undefined), 0);
});

// ── The parser is strict: every part is a complete response, and every boundary a part opens is closed ────────────────────────────────────────────────
// What proves a change set was refused — or rolled back as a deadlock victim — is an answer that SAYS so for every operation it answers. An envelope that closes its OUTER boundary can still be incomplete inside: a change set whose own
// closing delimiter is missing, a part cut off in its status line. A parser that dropped what it could not read would prove the whole from the part it could — the one complete 429 beside a part that may have been a success. So anything
// missing or malformed makes the WHOLE answer unproven; an answer that is not proven reaches the SDK as it came, and the write behind it stays an outcome nobody knows.
const REFUSED_429 = ['HTTP/1.1 429 Too Many Requests\r\nRetry-After: 7', '{"error":{"message":"throttled"}}'];
const MALFORMED_ENVELOPES = {
  'a change set whose closing delimiter is missing, the outer boundary closed': (part) => unclosed(batchAnswer(part)),
  'a part whose status line is cut off': (part) => withPart(batchAnswer(part), CUT_OFF_PART),
  'a part with no status line at all': (part) => withPart(batchAnswer(part), ['Content-Type: application/http', '', '{"error":{"message":"there is no status line"}}']),
  'a part that is only headers': (part) => withPart(batchAnswer(part), ['Content-Type: application/http', 'Content-ID: 2']),
  'a part that is not an HTTP response, whatever it quotes': (part) => withPart(batchAnswer(part), ['Content-Type: application/json', '', 'HTTP/1.1 429 Too Many Requests']),
  'a closing delimiter for a change set that was never opened': (part) => batchAnswer(part).replace('--batchresponse_b1--', '--changesetresponse_other--\r\n--batchresponse_b1--'),
  'a second change set opened inside the first and never closed': (part) => batchAnswer(part).replace('--changesetresponse_c1--', ['--changesetresponse_inner', 'Content-Type: application/http', '', 'HTTP/1.1 429 Too Many Requests', '', '--changesetresponse_c1--'].join('\r\n')),
  'text after the change set\'s closing delimiter': (part) => batchAnswer(part).replace('--changesetresponse_c1--\r\n', '--changesetresponse_c1--\r\nunexpected text\r\n'),
  'a complete response after the change set\'s closing delimiter that no delimiter opens': (part) => batchAnswer(part).replace('--changesetresponse_c1--\r\n', `--changesetresponse_c1--\r\n${part[0]}\r\n`),
  'a change set closed after the outer boundary': (part) => batchAnswer(part).replace('--changesetresponse_c1--\r\n--batchresponse_b1--', '--batchresponse_b1--\r\n--changesetresponse_c1--'),
};

test('the parser is strict: an envelope that closes its outer boundary but is incomplete inside — a part with no status line, a change set never closed — proves nothing, whatever its complete parts say', () => {
  const NOW = Date.parse('2026-09-30T10:00:00Z');
  for (const [what, make] of Object.entries(MALFORMED_ENVELOPES)) {
    const refused = make(REFUSED_429);
    assert.strictEqual(completeBatchStatus({ body: refused }), 0, `${what}: no status`);
    for (const statusCode of [200, 429]) assert.strictEqual(isBatchThrottled({ statusCode, body: refused }), false, `${what}: not a throttle, under HTTP ${statusCode} either`);
    assert.strictEqual(batchRetryAfterMs({ body: refused }, NOW, Infinity), 0, `${what}: what it asks for is not heard`);
    assert.strictEqual(isBatchDeadlockVictim({ body: make(DEADLOCK_PART) }), false, `${what}: not a deadlock victim`);
  }
  // The controls: the same parts in an envelope that IS complete say what they say.
  assert.strictEqual(completeBatchStatus({ body: batchAnswer(REFUSED_429) }), 429);
  assert.strictEqual(isBatchThrottled({ statusCode: 200, body: batchAnswer(REFUSED_429) }), true);
  assert.strictEqual(batchRetryAfterMs({ body: batchAnswer(REFUSED_429) }, NOW, Infinity), 7000);
  assert.strictEqual(isBatchDeadlockVictim({ body: batchAnswer(DEADLOCK_PART) }), true);
});

// ── What a delimiter-complete answer can still get wrong: the state of its parts ────────────────────────────────────────────────────────────────────────────
// An answer can close every boundary it opens and still hold a part that is not what its delimiters say: an operation that holds no response at all, a part that declares a change set the answer never contains (or one whose delimiters are
// another's), a body that is not as long as its response says, a delimiter damaged so that the next part sits inside this one's body. Each leaves a neighbouring complete 429 to speak for an operation nobody saw, so none may be a proof — and
// these are asserted OUTRIGHT, not as "no more than the old parser proved": the old parser proved every one of them.
const OUTER = 'batchresponse_shapes';
const CHANGE_SET = 'changesetresponse_shapes';
const CRLF = '\r\n';
// One response as a part: its MIME headers, the status line, the response's own headers (`Content-Length` counts the body; `null` leaves it out; `headers` adds lines), the blank line that ends them, and the body.
const responseOf = (status, { id = 1, body = '', length = Buffer.byteLength(body), headers = [] } = {}) => [
  'Content-Type: application/http', 'Content-Transfer-Encoding: binary', `Content-ID: ${id}`, '',
  `HTTP/1.1 ${status} ${status === 204 ? 'No Content' : 'Status'}`, ...(status === 429 ? ['Retry-After: 7'] : []), 'OData-Version: 4.0',
  ...(length === null ? [] : [`Content-Length: ${length}`]), ...headers, '', body,
];
// An answer made of such parts: inside the change set the answer announces (the shape the service uses), or directly under the outer boundary.
const answerOf = (parts, { changeSet = true } = {}) => {
  const lines = [`--${OUTER}`];
  if (changeSet) lines.push(`Content-Type: multipart/mixed; boundary=${CHANGE_SET}`, '');
  parts.forEach((part, i) => {
    if (changeSet || i > 0) lines.push(`--${changeSet ? CHANGE_SET : OUTER}`);
    lines.push(...part);
  });
  if (changeSet) lines.push(`--${CHANGE_SET}--`);
  lines.push(`--${OUTER}--`, '');
  return lines.join(CRLF);
};
const proofOf = (body, now = Date.parse('2026-09-30T10:00:00Z')) => ({
  status: completeBatchStatus({ body }),
  throttled: isBatchThrottled({ statusCode: 200, body }),
  retryAfter: batchRetryAfterMs({ body }, now, Infinity),
  deadlock: isBatchDeadlockVictim({ body }),
});
const UNPROVEN = { status: 0, throttled: false, retryAfter: 0, deadlock: false };
const DEADLOCK_BODY = JSON.stringify({ error: { code: '0x80044150', message: ' Sql error: Generic SQL error. Sql Number: 1205' } });
// Each builds an answer that holds a COMPLETE response of `status` (a 429 with a Retry-After, or a 500 that names the deadlock, with `options.body`) and the broken structure beside it — or, where the break is in the response itself, as that response.
const INCOMPLETE_STRUCTURES = {
  'an operation part with no response at all, after a complete refusal': (s, o) => answerOf([responseOf(s, o), []]),
  'an operation part that is only a blank line, after a complete refusal': (s, o) => answerOf([responseOf(s, o), ['']]),
  'an operation part with no response at all, before a complete refusal': (s, o) => answerOf([[], responseOf(s, o)]),
  'a part that declares a change set the answer never contains': (s, o) => answerOf([responseOf(s, o)]).replace(`--${OUTER}--`, [`--${OUTER}`, 'Content-Type: multipart/mixed; boundary=changesetresponse_missing', '', `--${OUTER}--`].join(CRLF)),
  'a part that declares a change set and opens it with no operation in it': (s, o) => answerOf([responseOf(s, o)]).replace(`--${OUTER}--`, [`--${OUTER}`, 'Content-Type: multipart/mixed; boundary=changesetresponse_second', '', '--changesetresponse_second', '--changesetresponse_second--', `--${OUTER}--`].join(CRLF)),
  'a part that declares a change set that is opened and never closed': (s, o) => answerOf([responseOf(s, o)]).replace(`--${OUTER}--`, [`--${OUTER}`, 'Content-Type: multipart/mixed; boundary=changesetresponse_second', '', '--changesetresponse_second', ...responseOf(s, { ...o, id: 2 }), `--${OUTER}--`].join(CRLF)),
  'a declared change-set boundary that the delimiters do not use': (s, o) => answerOf([responseOf(s, o)]).replace(`boundary=${CHANGE_SET}`, 'boundary=changesetresponse_missing'),
  'a part that declares a multipart body and no boundary': (s, o) => answerOf([responseOf(s, o)]).replace(`; boundary=${CHANGE_SET}`, ''),
  'a part that declares a multipart body and no boundary, beside a complete response': (s, o) => answerOf([responseOf(s, o)]).replace(`--${OUTER}--`, [`--${OUTER}`, 'Content-Type: multipart/mixed', '', `--${OUTER}--`].join(CRLF)),
  'a change set inside a change set': (s, o) => answerOf([responseOf(s, o), ['Content-Type: multipart/mixed; boundary=changesetresponse_inner', '', '--changesetresponse_inner', ...responseOf(s, { ...o, id: 3 }), '--changesetresponse_inner--']]),
  'a change set with no announcement (its delimiters follow the outer boundary directly)': (s, o) => [`--${OUTER}`, `--${CHANGE_SET}`, ...responseOf(s, o), `--${CHANGE_SET}--`, `--${OUTER}--`, ''].join(CRLF),
  'a body shorter than its Content-Length': (s, o) => answerOf([responseOf(s, { ...o, length: Buffer.byteLength(o.body || '{') + 200, body: o.body || '{' })]),
  'a body longer than its Content-Length': (s, o) => answerOf([responseOf(s, { ...o, length: 1, body: o.body || '{"a":1}' })]),
  'a Content-Length that is not a length': (s, o) => answerOf([responseOf(s, { ...o, length: 'many' })]),
  'two different Content-Lengths': (s, o) => answerOf([responseOf(s, { ...o, headers: ['Content-Length: 7'] })]),
  'a Content-Length where the response ends with its headers': (s) => answerOf([['Content-Type: application/http', '', `HTTP/1.1 ${s} Status`, 'Content-Length: 5']]),
  'a delimiter between two operations replaced by text, so the second response is in the first\'s body': (s, o) => [`--${OUTER}`, `Content-Type: multipart/mixed; boundary=${CHANGE_SET}`, '', `--${CHANGE_SET}`, ...responseOf(s, { ...o, length: null }), 'x', ...responseOf(s, { ...o, id: 2, length: null }), `--${CHANGE_SET}--`, `--${OUTER}--`, ''].join(CRLF),
  'a delimiter between two operations cut in half, so it is text in the first\'s body': (s, o) => [`--${OUTER}`, `Content-Type: multipart/mixed; boundary=${CHANGE_SET}`, '', `--${CHANGE_SET}`, ...responseOf(s, { ...o, length: null }), '--changesetrespo', ...responseOf(s, { ...o, id: 2, length: null }), `--${CHANGE_SET}--`, `--${OUTER}--`, ''].join(CRLF),
  'a delimiter cut in half in front of an operation that has no status line': (s, o) => [`--${OUTER}`, `Content-Type: multipart/mixed; boundary=${CHANGE_SET}`, '', `--${CHANGE_SET}`, ...responseOf(s, { ...o, length: null }), '--changesetrespo', 'Content-Type: application/http', 'Content-ID: 2', '', '{"error":{"message":"x"}}', `--${CHANGE_SET}--`, `--${OUTER}--`, ''].join(CRLF),
  'a change set that is closed and never opened': (s, o) => answerOf([responseOf(s, o)]).replace(`--${OUTER}--`, [`--${OUTER}`, 'Content-Type: multipart/mixed; boundary=changesetresponse_second', '', '--changesetresponse_second--', `--${OUTER}--`].join(CRLF)),
  'text in front of the first delimiter of a change set': (s, o) => answerOf([responseOf(s, o)]).replace(`--${CHANGE_SET}${CRLF}`, `stray${CRLF}--${CHANGE_SET}${CRLF}`),
  'text after the closing delimiter of a change set': (s, o) => answerOf([responseOf(s, o)]).replace(`--${CHANGE_SET}--${CRLF}`, `--${CHANGE_SET}--${CRLF}stray${CRLF}`),
  'two responses in one part': (s, o) => answerOf([responseOf(s, { ...o, length: null, headers: ['HTTP/1.1 204 No Content'] })]),
};

// A response that says `Transfer-Encoding: chunked` has a chunk stream for a body — `<size in hex>[;extension]`, a line break, that many bytes, a line break, …, `0`, a line break, the trailer fields and a blank line
// (https://www.rfc-editor.org/rfc/rfc9112#section-7.1) — and the delimiters around the part say nothing of whether the stream is whole. Nothing here reads one: a part that declares any transfer coding is not read at all, so it never
// certifies a refusal or a deadlock victim. The five ways a chunk stream is left unfinished are in the table, each inside a part that is otherwise complete, with a complete refusal beside them; so are the streams that ARE whole.
const CHUNKED = ['Transfer-Encoding: chunked'];
const THROTTLED_TEXT = '{"error":{"message":"throttled"}}';
const bodyOf = (o) => o.body || THROTTLED_TEXT;
const sizeOf = (text) => Buffer.byteLength(text).toString(16);
const chunkStream = (text, { extension = '', trailer = '' } = {}) => `${sizeOf(text)}${extension}${CRLF}${text}${CRLF}0${CRLF}${trailer}${CRLF}`;
// A response of `status` that declares `headers` and has no length of its own (a chunked response has none).
const codedResponse = (status, options, headers, body) => responseOf(status, { ...options, length: null, headers, body });
const TRANSFER_CODED = {
  'a chunked body with no terminal chunk': (s, o) => answerOf([codedResponse(s, o, CHUNKED, `${sizeOf(bodyOf(o))}${CRLF}${bodyOf(o)}${CRLF}`)]),
  'a chunk that is longer than the body that follows it': (s, o) => answerOf([codedResponse(s, o, CHUNKED, `200${CRLF}${bodyOf(o)}`)]),
  'a chunked response with no chunk stream at all': (s, o) => answerOf([codedResponse(s, o, CHUNKED, '')]),
  'a chunk size that is not hexadecimal': (s, o) => answerOf([codedResponse(s, o, CHUNKED, `xyz${CRLF}${bodyOf(o)}${CRLF}0${CRLF}${CRLF}`)]),
  'a chunked body whose trailer is cut off': (s, o) => answerOf([codedResponse(s, o, CHUNKED, `${sizeOf(bodyOf(o))}${CRLF}${bodyOf(o)}${CRLF}0${CRLF}X-Trace:`)]),
  'a complete chunked body': (s, o) => answerOf([codedResponse(s, o, CHUNKED, chunkStream(bodyOf(o)))]),
  'a complete chunked body with a chunk extension and a trailer': (s, o) => answerOf([codedResponse(s, o, CHUNKED, chunkStream(bodyOf(o), { extension: ';key=value', trailer: `X-Trace: done${CRLF}` }))]),
  'an empty chunked body': (s, o) => answerOf([codedResponse(s, o, CHUNKED, `0${CRLF}${CRLF}`)]),
  'a chunked body that also counts its own bytes': (s, o) => answerOf([responseOf(s, { ...o, headers: CHUNKED, body: chunkStream(bodyOf(o)), length: Buffer.byteLength(chunkStream(bodyOf(o))) })]),
  'a transfer coding that is not chunked': (s, o) => answerOf([codedResponse(s, o, ['Transfer-Encoding: gzip'], bodyOf(o))]),
  'a transfer coding named in lower case': (s, o) => answerOf([codedResponse(s, o, ['transfer-encoding: chunked'], chunkStream(bodyOf(o)))]),
  'a transfer coding with white space before the colon': (s, o) => answerOf([codedResponse(s, o, ['Transfer-Encoding : chunked'], chunkStream(bodyOf(o)))]),
  'a transfer coding folded onto the next line': (s, o) => answerOf([codedResponse(s, o, ['Transfer-Encoding:', ' chunked'], chunkStream(bodyOf(o)))]),
  'a transfer coding on the second of two responses, the first complete': (s, o) => answerOf([responseOf(s, o), codedResponse(s, { ...o, id: 2 }, CHUNKED, chunkStream(bodyOf(o)))]),
};

test('a delimiter-complete answer whose parts are not what its delimiters say proves nothing — an operation with no response, a change set declared and absent, a body not as long as its response says, a delimiter damaged, a body whose transfer coding is not read — and the same parts in a sound answer say what they say', () => {
  for (const [what, make] of Object.entries({ ...INCOMPLETE_STRUCTURES, ...TRANSFER_CODED })) {
    const refused = make(429, {});
    assert.deepStrictEqual(proofOf(refused), UNPROVEN, `${what}: a refusal`);
    assert.strictEqual(isBatchThrottled({ statusCode: 429, body: refused }), false, `${what}: not even under an outer 429`);
    assert.deepStrictEqual(proofOf(make(403, {})), UNPROVEN, `${what}: a 403`);
    assert.deepStrictEqual(proofOf(make(500, { body: DEADLOCK_BODY })), UNPROVEN, `${what}: a deadlock victim`);
  }
  // The controls: the same responses, in a sound answer, say what they say.
  assert.deepStrictEqual(proofOf(answerOf([responseOf(429), responseOf(429, { id: 2 })])), { status: 429, throttled: true, retryAfter: 7000, deadlock: false });
  assert.deepStrictEqual(proofOf(answerOf([responseOf(403)])), { status: 403, throttled: false, retryAfter: 0, deadlock: false });
  assert.deepStrictEqual(proofOf(answerOf([responseOf(500, { body: DEADLOCK_BODY })])), { status: 500, throttled: false, retryAfter: 0, deadlock: true });
});

for (const eol of ['CRLF', 'LF']) {
  test(`the strict parser goes on reading every complete shape the service and the fakes answer with — empty bodies, counted bodies, Content-ID, direct parts, two change sets (${eol})`, () => {
    const { batchEnvelope } = require('./helpers/fake-genpage-server.js');
    const twoChangeSets = [
      `--${OUTER}`, `Content-Type: multipart/mixed; boundary=${CHANGE_SET}`, '', `--${CHANGE_SET}`, ...responseOf(429, { id: 1 }), `--${CHANGE_SET}--`,
      `--${OUTER}`, 'Content-Type: multipart/mixed; boundary=changesetresponse_second', '', '--changesetresponse_second', ...responseOf(429, { id: 2 }), '--changesetresponse_second--', `--${OUTER}--`, '',
    ].join(CRLF);
    const cases = [
      ['page writes with an empty body and a Content-ID each', batchEnvelope([{ contentId: 1, status: 204 }, { contentId: 2, status: 204 }]), 204, 0],
      ['a refusal the service words with a Retry-After of its own', batchEnvelope([{ contentId: 1, status: 429, headers: { 'Retry-After': '7' } }]), 429, 7000],
      ['column creates, each response counting its empty body', answerOf([responseOf(201, { id: 1 }), responseOf(201, { id: 2 })]), 201, 0],
      ['conditional deletes, each response counting its empty body', answerOf([responseOf(204, { id: 1 }), responseOf(204, { id: 2 })]), 204, 0],
      ['a refusal with an empty body, counted', answerOf([responseOf(429)]), 429, 7000],
      ['a refusal with a body, counted exactly', answerOf([responseOf(400, { body: '{"error":{"message":"refused"}}' })]), 400, 0],
      ['a counted body followed by the blank line before the next delimiter', answerOf([[...responseOf(403, { body: '{}' }), '']]), 403, 0],
      ['a body that is not counted', answerOf([responseOf(403, { length: null, body: '{"error":{}}' })]), 403, 0],
      ['a response that is only a status line', answerOf([['Content-Type: application/http', '', 'HTTP/1.1 429 Too Many Requests']]), 429, 0],
      ['a response that ends with its headers: no blank line, no body', answerOf([['Content-Type: application/http', '', 'HTTP/1.1 429 Too Many Requests', 'Retry-After: 7']]), 429, 7000],
      ['a response with no type of its own', answerOf([['', 'HTTP/1.1 403 Forbidden', '']]), 403, 0],
      // Every part names its own `Content-Transfer-Encoding: binary` in its MIME headers (responseOf does), and that is not the response's transfer coding; and a BODY line that is spelled like one is a body, not a header.
      ['a body with a line spelled like a transfer coding', answerOf([responseOf(403, { length: null, body: 'Transfer-Encoding: chunked' })]), 403, 0],
      ['a response whose own headers name a Content-Transfer-Encoding: that is a MIME header, not a transfer coding', answerOf([responseOf(403, { headers: ['Content-Transfer-Encoding: binary'] })]), 403, 0],
      ['an answer with a byte order mark in front of it', `\uFEFF${answerOf([responseOf(429)])}`, 429, 7000],
      ['a change set whose Content-Type is folded onto the next line', answerOf([responseOf(429)]).replace(`; boundary=${CHANGE_SET}`, `;${CRLF} boundary=${CHANGE_SET}`), 429, 7000],
      ['a change set whose boundary is quoted', answerOf([responseOf(429)]).replace(`boundary=${CHANGE_SET}`, `BOUNDARY="${CHANGE_SET}"`), 429, 7000],
      ['a response directly under the outer boundary, no change set', answerOf([responseOf(403)], { changeSet: false }), 403, 0],
      ['two responses directly under the outer boundary', answerOf([responseOf(429, { id: 1 }), responseOf(429, { id: 2 })], { changeSet: false }), 429, 7000],
      ['two change sets', twoChangeSets, 429, 7000],
      ['a success beside a refusal: said once, and not one status', answerOf([responseOf(204, { id: 1 }), responseOf(429, { id: 2 })]), 0, 7000],
    ];
    for (const [what, text, status, retryAfter] of cases) {
      const body = eol === 'LF' ? text.replace(/\r\n/g, '\n') : text;
      assert.strictEqual(completeBatchStatus({ body }), status, what);
      assert.strictEqual(isBatchThrottled({ statusCode: 200, body }), status === 429, what);
      assert.strictEqual(batchRetryAfterMs({ body }, Date.now(), Infinity), retryAfter, what);
    }
  });
}

// The line breaks inside a counted body are the ones the answer has: `Content-Length` counts the bytes, and a CRLF is two of them.
test('a body is counted by the line breaks the answer really has — four bytes for a CRLF body of two lines, three for an LF one — and is not the body that was counted once its breaks are another kind', () => {
  const crlf = answerOf([responseOf(400, { body: 'a\r\nb' })]);
  const lf = answerOf([responseOf(400, { body: 'a\nb' })]);
  assert.strictEqual(completeBatchStatus({ body: crlf }), 400);
  assert.strictEqual(completeBatchStatus({ body: lf }), 400);
  assert.strictEqual(completeBatchStatus({ body: crlf.replace(/\r?\n/g, '\n') }), 0);
  assert.strictEqual(completeBatchStatus({ body: lf.replace(/\r?\n/g, '\r\n') }), 0);
});

// The client's own re-sends rest on the same reading: a conditional-delete batch is sent again after a SQL deadlock victim or a 429, and a column-create batch after a 429, only when the answer proves nothing in it ran.
test('postRaw sends a conditional-delete or column-create batch ONCE for an answer whose parts are not what its delimiters say, whatever its complete parts say — each way an answer can be incomplete inside', async () => {
  const slept = [];
  // The shapes of the first strict-parser test, taking the same arguments as the table above: a status and the options of the complete response.
  const every = {
    ...Object.fromEntries(Object.entries(MALFORMED_ENVELOPES).map(([what, make]) => [what, (s) => make(s === 500 ? DEADLOCK_PART : REFUSED_429)])),
    ...INCOMPLETE_STRUCTURES,
    ...TRANSFER_CODED,
  };
  for (const [what, make] of Object.entries(every)) {
    const answers = [
      ['a 429 on a batch of conditional deletes', APP_DELETE, [429, 200].map((statusCode) => ({ statusCode, headers: {}, body: make(429, {}) }))],
      ['a SQL deadlock victim on a batch of conditional deletes', APP_DELETE, [{ statusCode: 500, headers: {}, body: make(500, { body: DEADLOCK_BODY }) }]],
      ['a 429 on a batch of column creates', COLUMNS, [429, 200].map((statusCode) => ({ statusCode, headers: {}, body: make(429, {}) }))],
    ];
    for (const [kind, request, list] of answers) {
      for (const answer of list) {
        const { request: send, calls } = fakeTransport(answer);
        const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request: send, sleep: async (ms) => { slept.push(ms); }, random: () => 0 });
        const res = await postBatch(http, request);
        assert.strictEqual(calls.length, 1, `${what}: ${kind} (HTTP ${answer.statusCode}) — sent once`);
        assert.strictEqual(res.body, answer.body, `${what}: ${kind} — and the answer reaches the SDK as it came`);
      }
    }
  }
  assert.deepStrictEqual(slept, [], 'and nothing was waited for');
});

// The parser as it stood before it checked what it dropped, kept here as the reference the strict one is held to — as a guard IN ADDITION to the absolute tests above, which hold what the strict parser must refuse outright even where
// the old one proved it. On every well-formed answer the two agree; on every damaged one — a line gone, a line cut in half, a line replaced — the strict parser may prove LESS than the old one did, never more: nothing a caller
// re-sends a request for, or reads a refusal from, is proven on weaker evidence than before.
function referenceResults(res) {
  const lines = res.body.split(/\r?\n/);
  const nonEmpty = lines.map((l) => l.trim()).filter(Boolean);
  const outer = /^--(\S+)$/.exec(nonEmpty[0] || '');
  if (!outer || nonEmpty[nonEmpty.length - 1] !== `--${outer[1]}--`) return null;
  const parts = [];
  let part = null;
  for (const line of lines) {
    if (/^--\S/.test(line)) {
      if (part) parts.push(part);
      part = [];
    } else if (part) {
      part.push(line);
    }
  }
  return parts
    .map((p) => ({ status: (p.map((l) => /^HTTP\/1\.1 (\d{3})\b/.exec(l)).find(Boolean) || [])[1], text: p.join('\n') }))
    .filter((r) => r.status);
}
function reference(body, now) {
  const results = referenceResults({ body });
  const multipart = /^--\S/.test(body.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '');
  const asked = (results || []).filter((r) => r.status === '429').map((r) => { const m = /^Retry-After:[ \t]*(\S.*?)[ \t]*$/im.exec(r.text); return m ? retryAfterMs({ 'retry-after': m[1] }, now, Infinity) : 0; });
  return {
    status: !results || results.length === 0 || !results.every((r) => r.status === results[0].status) ? 0 : Number(results[0].status),
    throttled: multipart && !!results && results.length > 0 && results.every((r) => r.status === '429'),
    deadlock: !!results && results.length > 0 && results.every((r) => r.status === '500' && /\bSql Number:\s*1205\b/i.test(r.text)),
    retryAfter: Math.max(0, ...asked),
  };
}
const strict = (body, now) => ({
  status: completeBatchStatus({ body }),
  throttled: isBatchThrottled({ statusCode: 200, body }),
  deadlock: isBatchDeadlockVictim({ body }),
  retryAfter: batchRetryAfterMs({ body }, now, Infinity),
});

test('the strict parser agrees with the old one on every well-formed answer, and proves nothing more than it on any damaged one — a line deleted, cut in half or replaced', (t) => {
  const { batchEnvelope } = require('./helpers/fake-genpage-server.js');
  const NOW = Date.parse('2026-09-30T10:00:00Z');
  const two = batchAnswer(REFUSED_429, ['HTTP/1.1 429 Too Many Requests\r\nRetry-After: 30', '{}']);
  const corpus = {
    'a change set that succeeded': batchAnswer(['HTTP/1.1 204 No Content'], ['HTTP/1.1 204 No Content']),
    'a refused change set, with a Retry-After in the part': batchAnswer(REFUSED_429),
    'two refused operations': two,
    'a deadlock victim': batchAnswer(DEADLOCK_PART),
    'a success beside a deadlock victim': batchAnswer(['HTTP/1.1 204 No Content'], DEADLOCK_PART),
    'a refusal beside another failure': batchAnswer(['HTTP/1.1 429 Too Many Requests', '{}'], ['HTTP/1.1 500 Internal Server Error', '{}']),
    'the sample the transport tests send': BATCH_RESPONSE,
    'what the page service answers (a change set that announces its own boundary)': batchEnvelope([{ contentId: 1, status: 429, headers: { 'Retry-After': '7' } }]),
    'the same, a 403': batchEnvelope([{ contentId: 1, status: 403 }]),
    'responses that count their bodies — empty, and exactly': answerOf([responseOf(429, { id: 1 }), responseOf(429, { id: 2, body: '{"error":{"message":"throttled"}}' })]),
    'a response that is only a status line': answerOf([['Content-Type: application/http', '', 'HTTP/1.1 403 Forbidden']]),
    'operations with no change set at all': ['--batchresponse_b1', 'Content-Type: application/http', 'Content-Transfer-Encoding: binary', '', 'HTTP/1.1 429 Too Many Requests', 'Retry-After: 3', '', '{}', '--batchresponse_b1--', ''].join('\r\n'),
    'two change sets': ['--batchresponse_b1', 'Content-Type: multipart/mixed; boundary=changesetresponse_c1', '', '--changesetresponse_c1', 'Content-Type: application/http', '', 'HTTP/1.1 429 Too Many Requests', '', '--changesetresponse_c1--', '--batchresponse_b1', 'Content-Type: multipart/mixed; boundary=changesetresponse_c2', '', '--changesetresponse_c2', 'Content-Type: application/http', '', 'HTTP/1.1 429 Too Many Requests', 'Retry-After: 11', '', '--changesetresponse_c2--', '--batchresponse_b1--', ''].join('\r\n'),
    'no operation at all': '--batchresponse_b1\r\n--batchresponse_b1--\r\n',
    'a plain error answer': '{"error":{"code":"0x80072322","message":"Number of requests exceeded the limit"}}',
  };
  const variants = {};
  for (const [what, body] of Object.entries(corpus)) {
    variants[what] = body;
    variants[`${what}, with LF line ends`] = body.replace(/\r\n/g, '\n');
    variants[`${what}, with blank lines after it`] = `${body}\r\n\r\n`;
  }
  let stricter = 0;
  for (const [what, body] of Object.entries(variants)) {
    assert.deepStrictEqual(strict(body, NOW), reference(body, NOW), `well-formed: ${what}`);
    const eol = body.includes('\r\n') ? '\r\n' : '\n';
    const lines = body.split(/\r?\n/);
    const damaged = [];
    lines.forEach((line, i) => {
      damaged.push(['deleted', lines.filter((_, j) => j !== i)]);
      damaged.push(['cut in half', lines.map((l, j) => (j === i ? l.slice(0, Math.floor(l.length / 2)) : l))]);
      damaged.push(['replaced', lines.map((l, j) => (j === i ? 'x' : l))]);
    });
    for (const [how, list] of damaged) {
      const damagedBody = list.join(eol);
      const was = reference(damagedBody, NOW);
      const now = strict(damagedBody, NOW);
      const where = `${what}: a line ${how} (${JSON.stringify(damagedBody.slice(0, 60))}…)`;
      if (now.status !== 0) assert.strictEqual(now.status, was.status, where);
      if (now.throttled) assert.strictEqual(was.throttled, true, where);
      if (now.deadlock) assert.strictEqual(was.deadlock, true, where);
      if (now.retryAfter > 0) assert.strictEqual(now.retryAfter, was.retryAfter, where);
      if (was.status !== now.status || was.throttled !== now.throttled || was.deadlock !== now.deadlock || was.retryAfter !== now.retryAfter) stricter += 1;
    }
  }
  t.diagnostic(`${Object.keys(variants).length} answers, ${stricter} damaged ones the old parser took for proof and this one does not`);
  assert.ok(stricter > 50, `the damaged answers the old parser took for proof, and this one does not: ${stricter}`);
});

// The page backend honours what a throttled answer asks for whole, inside a budget of its own (lib/throttle-budget.js); the client's own retries keep the cap.
test('retryAfterMs and batchRetryAfterMs cap what they read at RETRY_AFTER_CAP_MS unless a caller names another cap — a caller that decides for itself whether a wait fits passes Infinity', () => {
  const NOW = Date.parse('2026-09-30T10:00:00Z');
  assert.strictEqual(retryAfterMs({ 'retry-after': '600' }), RETRY_AFTER_CAP_MS);
  assert.strictEqual(retryAfterMs({ 'retry-after': '600' }, NOW, Infinity), 600000);
  assert.strictEqual(retryAfterMs({ 'retry-after': '600' }, NOW, 90000), 90000);
  assert.strictEqual(retryAfterMs({ 'retry-after': 'Wed, 30 Sep 2026 10:10:00 GMT' }, NOW), RETRY_AFTER_CAP_MS);
  assert.strictEqual(retryAfterMs({ 'retry-after': 'Wed, 30 Sep 2026 10:10:00 GMT' }, NOW, Infinity), 600000);
  const part = batchAnswer(['HTTP/1.1 429 Too Many Requests\r\nRetry-After: 600', '{}']);
  assert.strictEqual(batchRetryAfterMs({ body: part }, NOW), RETRY_AFTER_CAP_MS);
  assert.strictEqual(batchRetryAfterMs({ body: part }, NOW, Infinity), 600000);
});

// ── A run's throttle budget ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The client's waits for a THROTTLED answer — HTTP 429, alone or as every operation of a `$batch` — are drawn from the budget a run allows itself for waiting out a throttled service (lib/throttle-budget.js) when the caller
// gives one (`deps.throttle`; the pcf plugin, which keeps a copy of this file, has none, and a client made without one waits exactly as it always did). A budgeted client waits what the service asked WHOLE — the cap of a minute is for
// the client's own bound, which the budget now is — and a wait that does not fit is not taken: the throttled answer comes back as it came, as when the sends run out, and the budget is told what the service asked. What is not
// throttling keeps its own schedule and is never drawn: a 5xx (a customization lock, a SQL deadlock, a gateway), a transport failure. Every wait here runs on a clock the wait moves, as a real one does.
const { makeThrottleBudget, refusedWait } = require('../lib/throttle-budget.js');
const ORG = 'https://org.crm.dynamics.com';
const READ = `${ORG}/api/data/v9.2/accounts`;
const CLOCK_START = Date.parse('2026-09-30T10:00:00Z');
// A budget, and the deps of a client that waits on a clock its waits move: what the waits were, and the lines the budget said.
function budgeted({ totalMs, spent = 0 } = {}) {
  let clock = CLOCK_START;
  const lines = [];
  const slept = [];
  const throttle = makeThrottleBudget({ ...(totalMs ? { totalMs } : {}), warn: (message) => lines.push(message) });
  if (spent) throttle.spend(spent);
  return { throttle, lines, slept, clock: () => clock, deps: { throttle, now: () => clock, random: () => 0, sleep: async (ms) => { slept.push(ms); clock += ms; } } };
}
const throttledAnswer = (retryAfter) => ({
  statusCode: 429,
  headers: retryAfter === undefined ? {} : { 'retry-after': String(retryAfter) },
  body: JSON.stringify({ error: { code: '0x80072322', message: 'Number of requests exceeded the limit of 6000 over time window of 300 seconds.' } }),
});
const taken = { statusCode: 200, headers: {}, body: '{"ok":true}' };
const clientOf = (transport, run, extra = {}) => createAzHttpClient(ORG, { getToken: () => 'TOK', request: transport.request, ...run.deps, ...extra });
const partRefused = (retryAfter) => ['HTTP/1.1 429 Too Many Requests' + (retryAfter ? `\r\nRetry-After: ${retryAfter}` : ''), '{}'];
// Lets the requests that are under way run to the point where they wait: each of them takes a few turns of the event loop to get its answer.
const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

test('budgeted: a throttled read draws each wait from the budget — the schedule\'s, or the answer\'s Retry-After WHOLE even past the client\'s cap — and the long ones are said on the warn seam', async () => {
  // No Retry-After: the schedule (1 s, 2 s), which is quiet.
  const quiet = budgeted();
  const t1 = fakeTransport(() => (t1.calls.length <= 2 ? throttledAnswer() : taken));
  assert.strictEqual((await clientOf(t1, quiet).get(READ)).status, 200);
  assert.deepStrictEqual(quiet.slept, [1000, 2000]);
  assert.strictEqual(quiet.throttle.spentMs(), 3000, 'each wait is counted, and the budget holds exactly what was waited');
  assert.deepStrictEqual(quiet.lines, [], 'waits of up to five seconds are not worth a line');
  // A minute and a half: longer than the cap of a minute the client keeps for itself, and it is waited whole.
  const long = budgeted();
  const t2 = fakeTransport(() => (t2.calls.length <= 1 ? throttledAnswer(90) : taken));
  assert.strictEqual((await clientOf(t2, long).get(READ)).status, 200);
  assert.deepStrictEqual(long.slept, [90000], 'what the service asked, whole');
  assert.strictEqual(long.throttle.spentMs(), 90000);
  assert.deepStrictEqual(long.lines, ['the service throttled GET /api/data/v9.2/accounts (HTTP 429); waiting 90 s before sending it again (90 s of the 5 minutes a run allows itself for waiting out a throttled service are spent)']);
  // The date form of Retry-After is read against the clock of the client.
  const dated = budgeted();
  const t3 = fakeTransport(() => (t3.calls.length <= 1 ? { ...throttledAnswer(), headers: { 'retry-after': 'Wed, 30 Sep 2026 10:01:15 GMT' } } : taken));
  await clientOf(t3, dated).get(READ);
  assert.deepStrictEqual(dated.slept, [75000]);
  assert.strictEqual(dated.throttle.spentMs(), 75000);
  // The schedule is the floor: a short ask waits the schedule's wait, as ever.
  const short = budgeted();
  const t4 = fakeTransport(() => (t4.calls.length <= 1 ? throttledAnswer(1) : taken));
  await clientOf(t4, short).get(READ);
  assert.deepStrictEqual(short.slept, [1000]);
  const longer = budgeted();
  const t5 = fakeTransport(() => (t5.calls.length <= 3 ? throttledAnswer(1) : taken));
  await clientOf(t5, longer).get(READ);
  assert.deepStrictEqual(longer.slept, [1000, 2000, 4000], 'the schedule goes on growing under a short ask, and the budget holds all of it');
  assert.strictEqual(longer.throttle.spentMs(), 7000);
});

test('budgeted: a wait that does not fit is not taken — the throttled answer comes back as it came, nothing is sent again, and the budget is told what the service asked', async () => {
  const run = budgeted({ spent: 250000 });
  const t = fakeTransport(throttledAnswer(120));
  const res = await clientOf(t, run).get(READ);
  assert.strictEqual(t.calls.length, 1, 'the request was sent once, and not again');
  assert.deepStrictEqual(run.slept, [], 'and nothing was waited for');
  assert.strictEqual(res.status, 429, 'the answer is the 429 the service gave, which the SDK reports as what it is');
  assert.deepStrictEqual(res.body, JSON.parse(throttledAnswer().body), 'its body is as it came, parsed as any answer\'s is');
  assert.strictEqual(res.headers['retry-after'], '120', 'and its headers');
  assert.strictEqual(run.throttle.spentMs(), 250000, 'nothing is spent on a wait that was not taken');
  assert.deepStrictEqual(run.throttle.declined(), { count: 1, askedMs: 120000, waitMs: 120000 });
  assert.deepStrictEqual(run.lines, [refusedWait(run.throttle, { askedMs: 120000, waitMs: 120000 })], 'and the line says what the service asked and that the request was not sent again');
  assert.doesNotMatch(run.lines[0], /same command|again later|Nothing more is sent now/, 'and gives no advice on what to run: the client does not know what the caller has done before this request');
  // An ask longer than the whole budget stops the request at once, with nothing spent.
  const huge = budgeted();
  const th = fakeTransport(throttledAnswer(3600));
  assert.strictEqual((await clientOf(th, huge).get(READ)).status, 429);
  assert.strictEqual(th.calls.length, 1);
  assert.deepStrictEqual([huge.slept, huge.throttle.spentMs(), huge.throttle.declined().askedMs], [[], 0, 3600000]);
  // The same answer from a client with no budget is waited out on the schedule it always had: a minute at most per wait.
  const slept = [];
  const plain = fakeTransport(() => (plain.calls.length <= 1 ? throttledAnswer(3600) : taken));
  const unbudgeted = createAzHttpClient(ORG, { getToken: () => 'TOK', request: plain.request, random: () => 0, sleep: async (ms) => { slept.push(ms); } });
  assert.strictEqual((await unbudgeted.get(READ)).status, 200);
  assert.deepStrictEqual(slept, [RETRY_AFTER_CAP_MS]);
});

test('budgeted: the budget ends a throttled request where the schedule would have gone on — what fits is waited, the first wait that does not fit is not, and the sends that were left are not made', async () => {
  const run = budgeted({ totalMs: 20000 });
  const t = fakeTransport(throttledAnswer());
  const res = await clientOf(t, run).get(READ);
  assert.deepStrictEqual(run.slept, [1000, 2000, 4000, 8000], '1, 2, 4 and 8 s are 15 of the 20 s');
  assert.strictEqual(t.calls.length, 5, 'five sends; the sixth is not made, because the 8 s before it do not fit in the 5 that are left');
  assert.strictEqual(res.status, 429);
  assert.deepStrictEqual(run.throttle.declined(), { count: 1, askedMs: 0, waitMs: 8000 }, 'the service asked for nothing: the wait that did not fit is the schedule\'s');
  assert.strictEqual(run.lines.length, 2);
  assert.match(run.lines[0], /^the service throttled GET \/api\/data\/v9\.2\/accounts \(HTTP 429\); waiting 8 s before sending it again \(15 s of the 20 seconds a run allows itself/);
  assert.match(run.lines[1], /^the next wait before this request is sent again, 8 s, does not fit in what is left of the 20 seconds a run allows itself for waiting out a throttled service \(15 s are spent\), so it was not sent again\.$/);
  // When the schedule ends first it is the sends that ran out, as ever, and the budget is not told of anything.
  const roomy = budgeted();
  const t2 = fakeTransport(throttledAnswer());
  assert.strictEqual((await clientOf(t2, roomy).get(READ)).status, 429);
  assert.strictEqual(t2.calls.length, 6, 'six sends in all');
  assert.deepStrictEqual(roomy.slept, [1000, 2000, 4000, 8000, 8000]);
  assert.strictEqual(roomy.throttle.spentMs(), 23000);
  assert.strictEqual(roomy.throttle.declined().count, 0, 'the budget did not stop it');
});

test('budgeted: every wait of a throttled request is drawn — a record delete refused with 429, and a $batch of conditional deletes or of column creates refused in either shape, whole or by the Retry-After of one operation', async () => {
  const batchHeaders = { headers: { 'Content-Type': 'multipart/mixed;boundary=batch_b' } };
  const sends = [
    ['a record delete', (http) => http.delete(`${ORG}/api/data/v9.0/solutions(1)`), UNINSTALL_429, 204],
    ['conditional deletes, the whole request refused', (http) => postBatch(http, APP_DELETE), { statusCode: 429, headers: {}, body: '' }, 200],
    ['conditional deletes, every operation refused', (http) => postBatch(http, APP_DELETE), { statusCode: 200, headers: {}, body: batchAnswer(partRefused(), partRefused()) }, 200],
    ['column creates, the whole request refused', (http) => postBatch(http, COLUMNS), TABLE_LOCKED_429, 200],
    ['column creates, every operation refused', (http) => postBatch(http, COLUMNS), { statusCode: 429, headers: {}, body: batchAnswer(partRefused(), partRefused()) }, 200],
  ];
  for (const [what, send, refused, then] of sends) {
    const run = budgeted();
    const t = fakeTransport(() => (t.calls.length <= 2 ? refused : { statusCode: then, headers: {}, body: then === 204 ? '' : BATCH_RESPONSE }));
    const res = await send(clientOf(t, run));
    assert.strictEqual(res.status, then, what);
    assert.strictEqual(t.calls.length, 3, `${what}: sent again twice`);
    assert.deepStrictEqual(run.slept, [1000, 2000], `${what}: on the schedule`);
    assert.strictEqual(run.throttle.spentMs(), 3000, `${what}: and drawn from the budget`);
  }
  // The wait a refused operation asks for in its own headers is honoured whole, as the outer one is.
  for (const [kind, batch] of [['conditional deletes', APP_DELETE], ['column creates', COLUMNS]]) {
    const run = budgeted();
    const t = fakeTransport(() => (t.calls.length <= 1 ? { statusCode: 429, headers: { 'retry-after': '10' }, body: batchAnswer(partRefused('150')) } : { statusCode: 200, headers: {}, body: BATCH_RESPONSE }));
    await postBatch(clientOf(t, run), batch);
    assert.deepStrictEqual(run.slept, [150000], `${kind}: the longer of the outer and the operation's, whole, past the cap of a minute`);
    assert.strictEqual(run.throttle.spentMs(), 150000);
    // And one that does not fit comes back as it came, with what it asked said.
    const full = budgeted({ spent: 200000 });
    const t2 = fakeTransport({ statusCode: 429, headers: {}, body: batchAnswer(partRefused('150')) });
    const res = await postBatch(clientOf(t2, full), batch);
    assert.strictEqual(t2.calls.length, 1, `${kind}: not sent again`);
    assert.strictEqual(res.status, 429);
    assert.strictEqual(res.body, batchAnswer(partRefused('150')), `${kind}: and the answer is the raw envelope, as it came`);
    assert.deepStrictEqual(full.throttle.declined(), { count: 1, askedMs: 150000, waitMs: 150000 });
  }
});

test('budgeted: what is not throttling keeps its own schedule and is never drawn — a 5xx whatever Retry-After it carries, a transport failure, a SQL deadlock victim — even when the budget has nothing left', async () => {
  const spentAll = () => budgeted({ spent: 300000 });
  // A 5xx waits as it did: the schedule, or the Retry-After it carries up to the cap of a minute, and the budget does not hear of it.
  for (const status of [500, 502, 503, 504]) {
    const run = spentAll();
    const t = fakeTransport(() => (t.calls.length <= 2 ? { statusCode: status, headers: { 'retry-after': '30' }, body: '' } : taken));
    assert.strictEqual((await clientOf(t, run).get(READ)).status, 200, String(status));
    assert.deepStrictEqual(run.slept, [30000, 30000], `${status}: the Retry-After it carried, capped as ever`);
    assert.deepStrictEqual([run.throttle.spentMs(), run.throttle.declined().count], [300000, 0], `${status}: nothing was drawn, and nothing declined`);
    const capped = spentAll();
    const t2 = fakeTransport(() => (t2.calls.length <= 1 ? { statusCode: status, headers: { 'retry-after': '600' }, body: '' } : taken));
    await clientOf(t2, capped).get(READ);
    assert.deepStrictEqual(capped.slept, [RETRY_AFTER_CAP_MS], `${status}: a long Retry-After is capped at a minute, because it is not a throttle's`);
  }
  // A transport failure (a reset) waits the schedule and sends again.
  const reset = spentAll();
  const t3 = fakeTransport(() => (t3.calls.length <= 2 ? { error: 'read ECONNRESET', code: 'ECONNRESET' } : taken));
  assert.strictEqual((await clientOf(t3, reset).get(READ)).status, 200);
  assert.deepStrictEqual(reset.slept, [1000, 2000]);
  assert.strictEqual(reset.throttle.spentMs(), 300000);
  // A record delete and a change set of conditional deletes that lost a SQL deadlock are sent again on the deadlock's own schedule.
  for (const [what, send, lost] of [['a record delete', (http) => http.delete(`${ORG}/api/data/v9.0/workflows(1)`), DEADLOCK_500], ['conditional deletes', (http) => postBatch(http, APP_DELETE), BATCH_DEADLOCK_500]]) {
    const run = spentAll();
    const t4 = fakeTransport(() => (t4.calls.length <= 3 ? lost : { statusCode: 204, headers: {}, body: '' }));
    await send(clientOf(t4, run));
    assert.strictEqual(t4.calls.length, 4, what);
    assert.deepStrictEqual(run.slept, [1000, 2000, 4000], `${what}: 1 s, 2 s and 4 s`);
    assert.deepStrictEqual([run.throttle.spentMs(), run.throttle.declined().count], [300000, 0], `${what}: none of it drawn`);
  }
});

test('budgeted: a request the caller sends once is sent once — a 429 is handed back with nothing waited for, nothing drawn and nothing declined', async () => {
  const run = budgeted();
  const t = fakeTransport(() => (t.calls.length <= 1 ? throttledAnswer(30) : taken));
  const res = await clientOf(t, run, { sendOnce: () => true }).get(READ);
  assert.strictEqual(res.status, 429);
  assert.strictEqual(t.calls.length, 1);
  assert.deepStrictEqual([run.slept, run.throttle.spentMs(), run.throttle.declined().count], [[], 0, 0]);
});

test('budgeted: a client given nothing that is a budget waits as it always did', async () => {
  for (const throttle of [undefined, null, {}, 'five minutes', { fits: true }]) {
    const slept = [];
    const t = fakeTransport(() => (t.calls.length <= 1 ? throttledAnswer(600) : taken));
    const http = createAzHttpClient(ORG, { getToken: () => 'TOK', request: t.request, random: () => 0, sleep: async (ms) => { slept.push(ms); }, throttle });
    assert.strictEqual((await http.get(READ)).status, 200, String(throttle));
    assert.deepStrictEqual(slept, [RETRY_AFTER_CAP_MS], `${JSON.stringify(throttle)}: the cap of a minute, as ever`);
  }
});

test('budgeted: requests that are throttled together wake together — their waits overlap, and the budget is charged for the time the run waited and not for the sum', async () => {
  let clock = CLOCK_START;
  const pending = [];
  const throttle = makeThrottleBudget({ totalMs: 100000 });
  // The first send of each read is refused with a minute to wait; the send that follows the wait is taken.
  const seen = new Set();
  const request = async (opts) => (seen.has(opts.url) ? taken : (seen.add(opts.url), throttledAnswer(60)));
  const http = createAzHttpClient(ORG, { getToken: () => 'TOK', request, throttle, now: () => clock, random: () => 0, sleep: (ms) => new Promise((resolve) => pending.push({ ms, resolve })) });
  const reads = [1, 2, 3, 4].map((n) => http.get(`${READ}${n}`));
  await settle();
  assert.deepStrictEqual(pending.map((p) => p.ms), [60000, 60000, 60000, 60000], 'all four are waiting a minute');
  assert.strictEqual(throttle.spentMs(), 60000, 'which is a minute of the run\'s waiting, and not four');
  clock += 60000;
  for (const p of pending.splice(0)) p.resolve();
  assert.deepStrictEqual((await Promise.all(reads)).map((r) => r.status), [200, 200, 200, 200]);
  assert.strictEqual(throttle.spentMs(), 60000);
  assert.strictEqual(throttle.declined().count, 0);
});

test('budgeted: requests throttled together are each judged by what they would add — the ones that end inside the wait under way fit, the one that runs past what is left does not', async () => {
  let clock = CLOCK_START;
  const pending = [];
  const throttle = makeThrottleBudget({ totalMs: 100000 });
  const asks = { a: 60, b: 90, c: 120 };
  const seen = new Set();
  const request = async (opts) => {
    const key = opts.url.slice(-1);
    if (seen.has(key)) return taken;
    seen.add(key);
    return throttledAnswer(asks[key]);
  };
  const http = createAzHttpClient(ORG, { getToken: () => 'TOK', request, throttle, now: () => clock, random: () => 0, sleep: (ms) => new Promise((resolve) => pending.push({ ms, resolve })) });
  const reads = ['a', 'b', 'c'].map((key) => http.get(`${READ}/${key}`));
  await settle();
  assert.deepStrictEqual(pending.map((p) => p.ms), [60000, 90000], 'a minute, and a minute and a half, which ends 30 s after the first');
  assert.strictEqual(throttle.spentMs(), 90000, '60 s, and the 30 s the second runs past the first');
  assert.deepStrictEqual(throttle.declined(), { count: 1, askedMs: 120000, waitMs: 120000 }, 'the third would run 30 s more past the second, and only 10 s are left');
  clock += 90000;
  for (const p of pending.splice(0)) p.resolve();
  assert.deepStrictEqual((await Promise.all(reads)).map((r) => r.status), [200, 200, 429], 'the third was handed back as it came');
});

test('budgeted: the answer a declined wait hands back is cleaned like any answer that is not a success — the token is out of its body and its headers', async () => {
  const TOKEN = `tok-${'x'.repeat(40)}`;
  const run = budgeted({ spent: 300000 });
  const answer = { statusCode: 429, headers: { 'retry-after': '30', 'x-echo': `Bearer ${TOKEN}` }, body: JSON.stringify({ error: { message: `rejected ${TOKEN}` } }) };
  const t = fakeTransport(answer);
  const res = await clientOf(t, run, { getToken: () => TOKEN }).get(READ);
  assert.strictEqual(t.calls.length, 1);
  assert.strictEqual(res.status, 429);
  assert.doesNotMatch(JSON.stringify(res), new RegExp(TOKEN));
  assert.strictEqual(res.body.error.message, 'rejected <token>');
  // A raw answer (a `$batch`, whose answer the SDK reads as text) is cleaned the same way.
  const raw = fakeTransport({ statusCode: 429, headers: {}, body: `${TOKEN} refused` });
  const refused = await postBatch(clientOf(raw, budgeted({ spent: 300000 }), { getToken: () => TOKEN }), COLUMNS);
  assert.strictEqual(refused.body, '<token> refused');
});

test('postRaw still refreshes the token once on 401 (rejected before processing, so it is safe)', async () => {
  const { request, calls } = fakeTransport(() =>
    calls.length <= 1 ? { statusCode: 401, headers: {}, body: '' } : { statusCode: 200, headers: {}, body: BATCH_RESPONSE }
  );
  let tokens = 0;
  const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => `TOK${++tokens}`, request, sleep: async () => {} });
  const res = await http.postRaw('https://org.crm.dynamics.com/api/data/v9.2/$batch', 'x', { headers: { 'Content-Type': 'multipart/mixed;boundary=b' } });
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[1].headers.Authorization, 'Bearer TOK2', 'the retry carries a fresh token');
  assert.strictEqual(res.body, BATCH_RESPONSE);
});

test('postRaw enforces the same-origin credential guard', async () => {
  const { request, calls } = fakeTransport({ statusCode: 200, headers: {}, body: BATCH_RESPONSE });
  const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request });
  await assert.rejects(
    () => http.postRaw('https://evil.example.com/api/data/v9.2/$batch', 'x', { headers: { 'Content-Type': 'multipart/mixed;boundary=b' } }),
    /different origin/
  );
  assert.strictEqual(calls.length, 0);
});

// `sendOnce` is the caller's word that a request is sent exactly once, and it dominates EVERY way the loop sends one again — the two answers on which a record DELETE or a `$batch`
// is re-sent in spite of their own rule included (a 429 that shows the server never started the request, and a SQL deadlock victim). Each is a thing the server can answer AFTER it
// accepted work, so a caller that says "once" must get its first answer; a caller that does not keeps the exceptions exactly as they were.
const REPLAYABLE = [
  ['a record DELETE refused with 429', (http) => http.delete('https://org.crm.dynamics.com/api/data/v9.0/solutions(1)'), UNINSTALL_429],
  ['a record DELETE that lost a SQL deadlock', (http) => http.delete('https://org.crm.dynamics.com/api/data/v9.0/workflows(1)'), DEADLOCK_500],
  ['a $batch of conditional deletes refused with 429', (http) => postBatch(http, APP_DELETE), { statusCode: 429, headers: {}, body: batchAnswer(['HTTP/1.1 429 Too Many Requests', UNINSTALL_429.body]) }],
  ['a $batch of conditional deletes whose change set lost a SQL deadlock', (http) => postBatch(http, APP_DELETE), BATCH_DEADLOCK_500],
  ['a $batch of column creates refused with 429', (http) => postBatch(http, COLUMNS), TABLE_LOCKED_429],
];
const afterwards = { statusCode: 204, headers: {}, body: '' };

test('sendOnce dominates the record-DELETE and $batch exceptions too: a 429 or a SQL deadlock victim is not answered with a second send — the first answer reaches the caller as it came', async () => {
  for (const [what, send, first] of REPLAYABLE) {
    const slept = [];
    const { request, calls } = fakeTransport(() => (calls.length <= 1 ? first : afterwards));
    const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request, sleep: async (ms) => { slept.push(ms); }, sendOnce: () => true });
    const res = await send(http);
    assert.strictEqual(calls.length, 1, `${what}: sent once`);
    assert.strictEqual(res.status, first.statusCode, `${what}: the first answer is the answer`);
    assert.deepStrictEqual(slept, [], `${what}: and nothing waited for a second send`);
  }
});

test('a request the caller does not name keeps those exceptions — the same answers ARE re-sent, after a wait — with no policy and with a policy that says no', async () => {
  for (const [what, send, first] of REPLAYABLE) {
    for (const policy of [undefined, () => false]) {
      const slept = [];
      const { request, calls } = fakeTransport(() => (calls.length <= 1 ? first : afterwards));
      const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request, sleep: async (ms) => { slept.push(ms); }, ...(policy ? { sendOnce: policy } : {}) });
      await send(http);
      assert.strictEqual(calls.length, 2, `${what}: re-sent (${policy ? 'a policy that says no' : 'no policy'})`);
      assert.strictEqual(slept.length, 1, `${what}: after one wait`);
    }
  }
});

test('sendOnce names a request by its method and URL, so a record DELETE it does not name keeps its exceptions while the one it names is sent once', async () => {
  const named = 'https://org.crm.dynamics.com/api/data/v9.0/solutions(1)';
  const policy = (method, url) => method === 'DELETE' && url === named;
  const sendTo = async (url) => {
    const { request, calls } = fakeTransport(() => (calls.length <= 1 ? UNINSTALL_429 : afterwards));
    const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request, sleep: async () => {}, sendOnce: policy });
    await http.delete(url);
    return calls.length;
  };
  assert.strictEqual(await sendTo(named), 1, 'the named delete: once');
  assert.strictEqual(await sendTo('https://org.crm.dynamics.com/api/data/v9.0/solutions(2)'), 2, 'another one: its 429 exception as before');
});

// --- a publish is sent ONCE ---------------------------------------------------------------------------------------------------------------------------------------
// `POST …/PublishXml` is never sent again by this client for a 429 of the customization lock, a 5xx or a failure of the transport: a publish the lock refused
// is not shown to have changed nothing, and an accepted re-send of one was measured publishing old content. Only the two answers that prove the platform never
// started it are answered with a second send: a 401 (the token is refreshed) and a 429 of the service protection limits, whose documented codes ask for it.
// A deadlock victim is re-sent by the layer above (the SDK's publishXml, or lib/publish-xml.js), never here (sdk-resend-layers.test.js counts the layers).
const { scrub: scrubToken, SERVICE_PROTECTION_CODES, isServiceProtectionRefusal } = require('../lib/sdk-http-client.js');
const PUBLISH = `${ORG}/api/data/v9.2/PublishXml`;
const PUBLISH_BODY = { ParameterXml: '<importexportxml><entities><entity>contoso_task</entity></entities></importexportxml>' };
const PUBLISH_TOKEN = 'eyJ0eXAiOiJKV1QifQ.eyJhdWQiOiJodHRwczovL2NvbnRvc28ifQ.c2lnbmF0dXJlLW9mLXRoZS10b2tlbg';
const LOCK_WORDS = 'Cannot start the requested operation [Publish] because there is another [WorkflowSetState] running at this moment.';
const lockAnswer = (statusCode, code) => ({ statusCode, headers: {}, body: JSON.stringify({ error: { code, message: `${LOCK_WORDS} (sent with ${PUBLISH_TOKEN})` } }) });
const PUBLISH_ONCE_ANSWERS = [
  ['a 429 of the customization lock (0x80071151)', () => lockAnswer(429, '0x80071151')],
  ['a 429 of another lock code (0x8004F064)', () => lockAnswer(429, '0x8004F064')],
  ['a 429 with no code', () => ({ statusCode: 429, headers: { 'retry-after': '1' }, body: '{"error":{"message":"Too many requests"}}' })],
  ['a 429 whose body is not JSON', () => ({ statusCode: 429, headers: {}, body: '<html>busy</html>' })],
  ['a 500 that carries a lock code', () => lockAnswer(500, '0x80071151')],
  ['a 500 SQL deadlock victim', () => ({ statusCode: 500, headers: {}, body: JSON.stringify({ error: { code: '0x80044150', message: ' Sql error: Generic SQL error. CRM ErrorCode: -2147204784 Sql ErrorCode: -2146232060 Sql Number: 1205' } }) })],
  ['a 502', () => ({ statusCode: 502, headers: {}, body: 'Bad Gateway' })],
  ['a 503', () => ({ statusCode: 503, headers: { 'retry-after': '1' }, body: 'Service Unavailable' })],
  ['a 504', () => ({ statusCode: 504, headers: {}, body: 'Gateway Timeout' })],
];

test('publish once: a PublishXml answered 429 by the lock or a 5xx — a lock code, a deadlock victim, a gateway — is sent ONCE, and its answer reaches the caller as it came, the token taken out', async () => {
  for (const [what, answer] of PUBLISH_ONCE_ANSWERS) {
    const slept = [];
    const { request, calls } = fakeTransport(() => (calls.length <= 1 ? answer() : { statusCode: 204, headers: {}, body: '' }));
    const http = createAzHttpClient(ORG, { getToken: () => PUBLISH_TOKEN, request, sleep: async (ms) => { slept.push(ms); } });
    const res = await http.post(PUBLISH, PUBLISH_BODY);
    const first = answer();
    assert.strictEqual(calls.length, 1, `${what}: one send`);
    assert.deepStrictEqual(slept, [], `${what}: nothing waited for`);
    assert.strictEqual(res.status, first.statusCode, `${what}: the status it was answered with`);
    let sent;
    try { sent = JSON.parse(first.body); } catch { sent = first.body; }
    assert.deepStrictEqual(res.body, typeof sent === 'string' ? sent : JSON.parse(scrubToken(first.body, PUBLISH_TOKEN)), `${what}: the body it was answered with — its code and its words — with the token taken out`);
    assert.ok(!JSON.stringify(res.body).includes(PUBLISH_TOKEN), `${what}: no access token in what the caller is given`);
  }
});

test('publish once: a PublishXml that got no answer — a reset, a timeout, an answer cut off — is not sent again', async () => {
  for (const failure of [{ error: 'read ECONNRESET', code: 'ECONNRESET' }, { error: 'Request timed out' }, { error: 'socket hang up', code: 'ECONNRESET' }, { error: 'Response aborted before it completed', incompleteResponse: true, statusCode: 204 }]) {
    const { request, calls } = fakeTransport(() => (calls.length <= 1 ? failure : { statusCode: 204, headers: {}, body: '' }));
    const http = createAzHttpClient(ORG, { getToken: () => 'TOK', request, sleep: async () => {} });
    await assert.rejects(http.post(PUBLISH, PUBLISH_BODY), /^Error: Request failed: /, failure.error);
    assert.strictEqual(calls.length, 1, `${failure.error}: one send`);
  }
});

test('publish once: a 401 is refused before the publish ran — the token is refreshed and the publish sent again, once', async () => {
  const tokens = [];
  const { request, calls } = fakeTransport(() => (calls.length <= 1 ? { statusCode: 401, headers: {}, body: '' } : { statusCode: 204, headers: {}, body: '' }));
  const http = createAzHttpClient(ORG, { getToken: (_url, options) => { tokens.push(Boolean(options && options.fresh)); return 'TOK'; }, request, sleep: async () => {} });
  const res = await http.post(PUBLISH, PUBLISH_BODY);
  assert.strictEqual(res.status, 204);
  assert.strictEqual(calls.length, 2, 'the refused send and the one with the new token');
  assert.deepStrictEqual(tokens, [false, true], 'a fresh token for the second');
});

test('publish once: a 429 of the service protection limits — each of the three documented codes — is waited out and sent again, as any throttled request is', async () => {
  for (const code of ['0x80072322', '0x80072321', '0x80072326', '0X80072322']) {
    const slept = [];
    const refused = { statusCode: 429, headers: { 'retry-after': '20' }, body: JSON.stringify({ error: { code, message: 'Number of requests exceeded the limit of 6000 over time window of 300 seconds.' } }) };
    const { request, calls } = fakeTransport(() => (calls.length <= 2 ? refused : { statusCode: 204, headers: {}, body: '' }));
    const http = createAzHttpClient(ORG, { getToken: () => 'TOK', request, random: () => 0, sleep: async (ms) => { slept.push(ms); } });
    assert.strictEqual((await http.post(PUBLISH, PUBLISH_BODY)).status, 204, code);
    assert.strictEqual(calls.length, 3, `${code}: two refusals, then the send that was accepted`);
    assert.deepStrictEqual(slept, [20000, 20000], `${code}: the Retry-After it asked for`);
  }
  // Inside a run's budget, as every throttled request of a budgeted client.
  const run = budgeted();
  const t = fakeTransport(() => (t.calls.length <= 1 ? throttledAnswer(30) : { statusCode: 204, headers: {}, body: '' }));
  assert.strictEqual((await clientOf(t, run).post(PUBLISH, PUBLISH_BODY)).status, 204);
  assert.deepStrictEqual([t.calls.length, run.slept, run.throttle.spentMs()], [2, [30000], 30000], 'drawn from the budget');
  // And a budget with no room for the wait hands the 429 back, as for any request.
  const spent = budgeted({ spent: 300000 });
  const t2 = fakeTransport(() => throttledAnswer(30));
  assert.strictEqual((await clientOf(t2, spent).post(PUBLISH, PUBLISH_BODY)).status, 429);
  assert.strictEqual(t2.calls.length, 1);
});

test('publish once: PublishAllXml and the action named with its namespace are publishes too; a custom action whose name ends the same way, a read, and every other POST keep the retry', async () => {
  const answer = lockAnswer(429, '0x80071151');
  const sends = async (url, method = 'post') => {
    const { request, calls } = fakeTransport(() => (calls.length <= 1 ? answer : { statusCode: 204, headers: {}, body: '' }));
    const http = createAzHttpClient(ORG, { getToken: () => 'TOK', request, sleep: async () => {} });
    if (method === 'get') await http.get(url);
    else await http.post(url, {});
    return calls.length;
  };
  assert.strictEqual(await sends(`${ORG}/api/data/v9.2/PublishAllXml`), 1, 'PublishAllXml');
  assert.strictEqual(await sends(`${ORG}/api/data/v9.0/Microsoft.Dynamics.CRM.PublishXml`), 1, 'the namespace-qualified PublishXml');
  assert.strictEqual(await sends(`${ORG}/api/data/v9.2/new_PublishXml`), 2, 'a custom action is not a publish');
  assert.strictEqual(await sends(`${ORG}/api/data/v9.2/systemforms`), 2, 'a form create is re-sent after the lock, as before');
  assert.strictEqual(await sends(PUBLISH, 'get'), 2, 'a read of the same address is not a publish');
});

test('publish once: a form create refused by the lock, or answered 503, is still re-sent on its schedule — six sends at most, as before', async () => {
  for (const answer of [lockAnswer(429, '0x80071151'), { statusCode: 503, headers: {}, body: 'busy' }]) {
    const { request, calls } = fakeTransport(answer);
    const http = createAzHttpClient(ORG, { getToken: () => 'TOK', request, sleep: async () => {} });
    assert.strictEqual((await http.post(`${ORG}/api/data/v9.2/systemforms`, { name: 'Main' })).status, answer.statusCode);
    assert.strictEqual(calls.length, 6, String(answer.statusCode));
  }
});

test('publish once: the service protection codes are the three the api-limits page documents, and a 429 is one only by its code', () => {
  assert.deepStrictEqual([...SERVICE_PROTECTION_CODES].sort(), ['0x80072321', '0x80072322', '0x80072326']);
  const answer = (statusCode, body) => ({ statusCode, headers: {}, body });
  assert.strictEqual(isServiceProtectionRefusal(answer(429, '{"error":{"code":"0x80072326","message":"Number of concurrent requests exceeded the limit of 52."}}')), true);
  assert.strictEqual(isServiceProtectionRefusal(answer(429, { error: { code: '0x80072321' } })), true, 'a body already parsed');
  for (const [what, res] of [
    ['the lock', answer(429, '{"error":{"code":"0x80071151","message":"Number of requests exceeded the limit of 6000 over time window of 300 seconds."}}')],
    ['the words alone', answer(429, '{"error":{"message":"Number of requests exceeded the limit of 6000 over time window of 300 seconds. 0x80072322"}}')],
    ['the code on another status', answer(503, '{"error":{"code":"0x80072322"}}')],
    ['a code that is not a string', answer(429, '{"error":{"code":2147015902}}')],
    ['no body', answer(429, '')],
    ['nothing', null],
  ]) assert.strictEqual(isServiceProtectionRefusal(res), false, what);
});

// A failure's body carries the history of the sends that led to it, so a caller that would read a later answer as a definitive refusal (the business-rule gate in
// lib/sdk-build.js) can tell it is not one when an earlier send of the same request may have run. The marker is not enumerable: nothing that compares or prints a body sees it.
const { HTTP_SEND_HISTORY } = require('../lib/sdk-http-client.js');
const MEMBER_POST = 'https://org.crm.dynamics.com/api/data/v9.0/workflows(00000000-0000-0000-0000-000000000000)/Microsoft.Dynamics.CRM.CreateProcessWithWfomJson';
const REFUSED = { statusCode: 400, headers: {}, body: '{"error":{"code":"0x80040216","message":"An unexpected error occurred."}}' };
const clientOver = (scripted) => {
  const { request, calls } = fakeTransport(scripted);
  return { calls, http: createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request, sleep: async () => {} }) };
};

test('a failure answered on the first send carries { sends: 1, earlierAmbiguous: false }, and the marker is invisible to a comparison', async () => {
  const { http } = clientOver(REFUSED);
  const res = await http.post(MEMBER_POST, {});
  assert.deepStrictEqual(res.body[HTTP_SEND_HISTORY], { sends: 1, earlierAmbiguous: false });
  assert.deepStrictEqual(res.body, { error: { code: '0x80040216', message: 'An unexpected error occurred.' } });
});

test('a 503 re-sent by the client and then answered 400 says an earlier send was ambiguous', async () => {
  const { http, calls } = clientOver((opts, n) => (n === 1 ? { statusCode: 503, headers: {}, body: '{"error":{"code":"x","message":"gateway"}}' } : REFUSED));
  const res = await http.post(MEMBER_POST, {});
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(res.status, 400);
  assert.deepStrictEqual(res.body[HTTP_SEND_HISTORY], { sends: 2, earlierAmbiguous: true });
});

test('a send that got no answer, re-sent and then refused, says so as well', async () => {
  const { http } = clientOver((opts, n) => (n === 1 ? { error: 'socket hang up', code: 'ECONNRESET' } : REFUSED));
  const res = await http.post(MEMBER_POST, {});
  assert.deepStrictEqual(res.body[HTTP_SEND_HISTORY], { sends: 2, earlierAmbiguous: true });
});

test('the same request called again by the caller after a 5xx it gave up on is refused as one whose earlier send was ambiguous', async () => {
  // The SDK re-calls a request itself: the second call is a first send of this client's loop, and only the ledger knows of the first.
  const { http } = clientOver((opts, n) => (n <= 6 ? { statusCode: 503, headers: {}, body: '' } : REFUSED));
  assert.strictEqual((await http.post(MEMBER_POST, {})).status, 503);
  const second = await http.post(MEMBER_POST, {});
  assert.strictEqual(second.status, 400);
  assert.deepStrictEqual(second.body[HTTP_SEND_HISTORY], { sends: 1, earlierAmbiguous: true });
});

test('what proves a send did not run is not ambiguity: a 401 refresh and a service protection 429 leave earlierAmbiguous false', async () => {
  const protection = { statusCode: 429, headers: {}, body: '{"error":{"code":"0x80072322","message":"Number of requests exceeded the limit"}}' };
  for (const first of [{ statusCode: 401, headers: {}, body: '' }, protection]) {
    const { http } = clientOver((opts, n) => (n === 1 ? first : REFUSED));
    const res = await http.post(MEMBER_POST, {});
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body[HTTP_SEND_HISTORY].earlierAmbiguous, false, String(first.statusCode));
    assert.strictEqual(res.body[HTTP_SEND_HISTORY].sends, 2);
  }
});

test('the ledger is per request: another URL, and a read of the same URL, are not poisoned by an ambiguous write', async () => {
  const { http } = clientOver((opts) => (opts.url.endsWith('/poisoned') ? { statusCode: 503, headers: {}, body: '' } : REFUSED));
  await http.post('https://org.crm.dynamics.com/api/data/v9.0/poisoned', {});
  assert.strictEqual((await http.post(MEMBER_POST, {})).body[HTTP_SEND_HISTORY].earlierAmbiguous, false);
  assert.strictEqual((await http.get('https://org.crm.dynamics.com/api/data/v9.0/poisoned')).status, 503);
  assert.strictEqual((await http.get(MEMBER_POST)).body[HTTP_SEND_HISTORY].earlierAmbiguous, false);
});

test('a success carries no history', async () => {
  const { http } = clientOver({ statusCode: 200, headers: {}, body: '{"ok":true}' });
  const res = await http.post(MEMBER_POST, {});
  assert.deepStrictEqual(Object.getOwnPropertySymbols(res.body), []);
});
