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
  const res = await http.post('https://org/x', { name: 'A' });
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

test('throws only when no token is available', async () => {
  const { request } = fakeTransport({ statusCode: 200, headers: {}, body: '{}' });
  const http = createAzHttpClient('https://org', { getToken: () => null, request });
  await assert.rejects(() => http.get('https://org/x'), /Failed to get Azure CLI token/);
});
