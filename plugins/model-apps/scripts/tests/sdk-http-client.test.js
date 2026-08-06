'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createAzHttpClient } = require('../lib/sdk-http-client.js');

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
  const http = createAzHttpClient('https://org', { getToken: () => 'TOK', request });
  await http.patch('https://org/x', { a: 1 }, { headers: { 'MSCRM.SolutionUniqueName': 'MyS', 'If-Match': 'W/"7"' } });
  assert.strictEqual(calls[0].headers['MSCRM.SolutionUniqueName'], 'MyS');
  assert.strictEqual(calls[0].headers['If-Match'], 'W/"7"');
});

test('does NOT throw on non-2xx — passes status/body through (412 version conflict)', async () => {
  const { request } = fakeTransport({ statusCode: 412, headers: {}, body: '{"error":{"message":"conflict"}}' });
  const http = createAzHttpClient('https://org', { getToken: () => 'TOK', request });
  const res = await http.put('https://org/x', { a: 1 });
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
  const http = createAzHttpClient('https://org', { getToken: () => `T${++tokens}`, request });
  const res = await http.get('https://org/x');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].headers.Authorization, 'Bearer T1');
  assert.strictEqual(calls[1].headers.Authorization, 'Bearer T2'); // refreshed
});

test('retries a transient 500 (SQL deadlock) with backoff, then succeeds', async () => {
  const { request, calls } = fakeTransport(() =>
    calls.length <= 2 ? { statusCode: 500, headers: {}, body: 'deadlock 1205' } : { statusCode: 200, headers: {}, body: '{"ok":true}' }
  );
  const http = createAzHttpClient('https://org', { getToken: () => 'TOK', request, sleep: async () => {} });
  const res = await http.post('https://org/x', { a: 1 });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(calls.length, 3); // 500, 500, 200
});

test('gives up after max attempts on a persistent 500 — surfaces it (no throw)', async () => {
  const { request, calls } = fakeTransport({ statusCode: 500, headers: {}, body: 'boom' });
  const http = createAzHttpClient('https://org', { getToken: () => 'TOK', request, sleep: async () => {} });
  const res = await http.get('https://org/x');
  assert.strictEqual(res.status, 500); // the SDK decides what to do with it
  assert.strictEqual(calls.length, 6);
});

test('retries a 429 EntityCustomization lock and eventually succeeds', async () => {
  const { request, calls } = fakeTransport(() =>
    calls.length <= 4
      ? { statusCode: 429, headers: {}, body: 'Cannot start another [EntityCustomization]' }
      : { statusCode: 200, headers: {}, body: '{"ok":true}' }
  );
  const http = createAzHttpClient('https://org', { getToken: () => 'TOK', request, sleep: async () => {} });
  const res = await http.post('https://org/x', { a: 1 });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(calls.length, 5); // 429 x4, then 200 — needs the extra attempts (>4)
});

test('applies jittered, capped backoff on transient retries (de-syncs lockstep collisions)', async () => {
  const slept = [];
  // random() = 0.5 -> +12.5% jitter; caps exponential at 8000ms.
  const { request } = fakeTransport({ statusCode: 503, headers: {}, body: '' });
  const http = createAzHttpClient('https://org', {
    getToken: () => 'TOK', request, random: () => 0.5,
    sleep: async (ms) => { slept.push(ms); },
  });
  await http.get('https://org/x');
  // 5 sleeps before the 6th (final) attempt: base 1s,2s,4s,8s,8s each + 12.5% jitter.
  assert.deepStrictEqual(slept, [1125, 2250, 4500, 9000, 9000]);
});

test('does NOT retry a RECORD delete on a transient status (avoids the async concurrent-delete wedge)', async () => {
  const { request, calls } = fakeTransport({ statusCode: 503, headers: {}, body: '' });
  const http = createAzHttpClient('https://org', { getToken: () => 'TOK', request, sleep: async () => {} });
  const res = await http.delete('https://org/api/data/v9.0/webresourceset(1)');
  assert.strictEqual(res.status, 503, 'the transient status surfaces instead of being retried');
  assert.strictEqual(calls.length, 1, 'exactly one record DELETE was sent (no retry)');
});

test('does NOT retry a RECORD delete on a network error either (single delete, no wedge)', async () => {
  let calls = 0;
  const request = async () => { calls += 1; return { error: 'ETIMEDOUT' }; };
  const http = createAzHttpClient('https://org', { getToken: () => 'TOK', request, sleep: async () => {} });
  await assert.rejects(() => http.delete('https://org/api/data/v9.0/webresourceset(1)'), /Request failed: ETIMEDOUT/);
  assert.strictEqual(calls, 1, 'exactly one record DELETE was sent (no network-error retry)');
});

test('DOES retry a METADATA delete (EntityDefinitions) on a network error — async-idempotent, gets cosmetic 404', async () => {
  const { request, calls } = fakeTransport(() =>
    calls.length <= 1 ? { error: 'ETIMEDOUT' } : { statusCode: 404, headers: {}, body: '' }
  );
  const http = createAzHttpClient('https://org', { getToken: () => 'TOK', request, sleep: async () => {} });
  const res = await http.delete("https://org/api/data/v9.0/EntityDefinitions(LogicalName='new_x')");
  assert.strictEqual(res.status, 404, 'a slow metadata delete is retried rather than surfacing a false timeout');
  assert.strictEqual(calls.length, 2);
});

test('throws only when no token is available', async () => {
  const { request } = fakeTransport({ statusCode: 200, headers: {}, body: '{}' });
  const http = createAzHttpClient('https://org', { getToken: () => null, request });
  await assert.rejects(() => http.get('https://org/x'), /Failed to get Azure CLI token/);
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
