'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createAzHttpClient, retryAfterMs, isBatchThrottled, batchRetryAfterMs, RETRY_AFTER_CAP_MS } = require('../lib/sdk-http-client.js');

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

test('postRaw re-sends a 429 $batch ONLY when it is made of conditional deletes and the answer proves nothing ran', async () => {
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
    for (const [what, send] of [['a GET', (h) => h.get('https://org.crm.dynamics.com/x')], ['a record delete', (h) => h.delete('https://org.crm.dynamics.com/api/data/v9.0/solutions(1)')]]) {
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
    const slept = [];
    const refused = { statusCode: 429, headers, body: batchAnswer(...parts) };
    const { request, calls } = fakeTransport(() => (calls.length <= 1 ? refused : { statusCode: 200, headers: {}, body: BATCH_RESPONSE }));
    const http = createAzHttpClient('https://org.crm.dynamics.com', { getToken: () => 'TOK', request, random: () => 0.5, now: () => NOW, sleep: async (ms) => { slept.push(ms); } });
    await postBatch(http);
    assert.deepStrictEqual(slept, [want], what);
  }
  assert.strictEqual(batchRetryAfterMs({ body: batchAnswer(['HTTP/1.1 204 No Content\r\nRetry-After: 30']) }), 0, 'only a refused operation\u2019s wait counts');
  assert.strictEqual(batchRetryAfterMs({ body: '{"error":{}}' }), 0, 'a plain answer has no parts');
  assert.strictEqual(batchRetryAfterMs(undefined), 0);
});

test('isBatchThrottled reads the answer, not the outer status alone', () => {
  assert.strictEqual(isBatchThrottled({ statusCode: 429, body: '{"error":{}}' }), true);
  assert.strictEqual(isBatchThrottled({ statusCode: 503, body: '{"error":{}}' }), false);
  assert.strictEqual(isBatchThrottled({ statusCode: 429, body: batchAnswer(['HTTP/1.1 204 No Content']) }), false);
  assert.strictEqual(isBatchThrottled({ statusCode: 500, body: batchAnswer(['HTTP/1.1 429 Too Many Requests', '{}']) }), true);
  assert.strictEqual(isBatchThrottled(undefined), false);
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
