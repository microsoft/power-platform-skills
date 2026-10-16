'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createAzHttpClient, retryAfterMs, isBatchThrottled, completeBatchStatus, isColumnCreateBatch, batchRetryAfterMs, throttleBackoffMs, RETRY_AFTER_CAP_MS } = require('../lib/sdk-http-client.js');

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
    // Only a 500 is a rolled-back deadlock victim; another status whose message quotes one is not.
    'another status whose error quotes the deadlock': batchAnswer(['HTTP/1.1 400 Bad Request', JSON.stringify({ error: { message: 'Validation failed (inner: Sql Number: 1205)' } })]),
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
