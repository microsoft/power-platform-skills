// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import test from 'node:test';
import assert from 'node:assert/strict';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { authenticatedFetch } from '../src/http-auth.mjs';
import { CorrelationSession } from '../src/correlation.mjs';
const endpoint = 'https://fixture.example/processmining/mcp?api-version=2024-10-01';
const marker = '11111111-1111-1111-1111-111111111111';
const claims = '{"access_token":{"acrs":{"value":"c1"}}}';
for (const transportMode of ['streamable-http', 'post-only']) for (const withCorrelation of [false, true])
test(`every outbound MCP request has the exact marker (${transportMode}, correlation: ${withCorrelation})`, async () => {
  const correlation = withCorrelation ? new CorrelationSession() : undefined;
  const sent = [];
  const fetch = authenticatedFetch(endpoint, async () => 'synthetic', async request => {
    sent.push(new Headers(request.headers));
    return new Response(null, { status: 200 });
  }, { correlation, transportMode });
  const methods = transportMode === 'post-only' ? ['POST', 'DELETE'] : ['POST', 'GET', 'DELETE'];
  for (const method of methods) for (const injected of [false, true]) {
    const headers = new Headers({ 'mcp-session-id': 'server-session' });
    if (injected) headers.set('X-MS-CLIENT-REQUEST-ID', 'caller-supplied');
    const input = new Request(endpoint, { method, headers });
    const send = () => fetch(input);
    await send();
    if (correlation) {
      await correlation.request(send);
      await correlation.request(() => correlation.sessionOnly(send));
      const retired = correlation.newRequest();
      correlation.retire(retired);
      await correlation.run(retired, send);
    }
    assert.equal(input.headers.get('x-ms-client-request-id'), injected ? 'caller-supplied' : null);
  }
  assert.equal(sent.length, methods.length * 2 * (withCorrelation ? 4 : 1));
  for (const headers of sent) {
    assert.equal(headers.get('x-ms-client-request-id'), marker);
    assert.equal(headers.get('mcp-session-id'), 'server-session');
    assert.equal(headers.get('x-ms-client-session-id'), correlation?.clientSessionId ?? null);
  }
});
for (const header of [
  `Bearer error="insufficient_claims", claims="${Buffer.from(claims).toString('base64')}"`,
  'Bearer error="insufficient_claims"',
  'Bearer CLAIMS = "private-invalid-payload"',
  'Bearer authorization_uri="https://untrusted.example", claims="private-one", claims="private-two"',
  `Bearer claims="${'x'.repeat(33000)}"`
]) {
  test(`claims challenge requests manual login without parsing or replay (${header.length} characters)`, async () => {
    let sent = 0, acquisitions = 0, cancelled = false;
    const fetch = authenticatedFetch(endpoint, async () => { acquisitions++; return 'synthetic'; }, async () => {
      sent++;
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }),
        { status: 401, headers: { 'www-authenticate': header } });
    });
    await assert.rejects(fetch(endpoint, { method: 'POST', body: '{"id":1}' }), error => {
      assert.equal(error.errorCode, 'CLAIMS_LOGIN_REQUIRED');
      assert.match(error.message, /Conditional Access.*CAE/);
      assert.match(error.message, /login --profile NAME --sign-in true/);
      assert.match(error.message, /pi_activate_profile/);
      assert.doesNotMatch(error.message, /private-|untrusted\.example|acrs|2\.80/);
      return true;
    });
    assert.equal(sent, 1);
    assert.equal(acquisitions, 1);
    assert.equal(cancelled, true);
  });
}
test('a claims challenge on the plain-401 retry still requests manual login', async () => {
  let sent = 0;
  const fetch = authenticatedFetch(endpoint, async () => 'synthetic', async () => {
    sent++;
    return new Response(null, { status: 401,
      headers: sent === 2 ? { 'www-authenticate': 'Bearer error="insufficient_claims"' } : {} });
  });
  await assert.rejects(fetch(endpoint), { errorCode: 'CLAIMS_LOGIN_REQUIRED' });
  assert.equal(sent, 2);
});
test('one plain 401 retry preserves bytes and headers', async () => {
  const tokens = [], requests = [];
  const fetch = authenticatedFetch(endpoint, async (...args) => { tokens.push(args); return `fake-${tokens.length}`; }, async req => {
    requests.push({ body: await req.text(), auth: req.headers.get('authorization'), marker: req.headers.get('x-marker'),
      requestId: req.headers.get('x-ms-client-request-id') });
    return requests.length === 1 ? new Response('', { status: 401 }) : new Response('ok');
  }, { transportMode: 'post-only' });
  assert.equal(await (await fetch(endpoint, { method: 'POST', body: '{"id":1}', headers: { 'x-marker': 'present' } })).text(), 'ok');
  assert.deepEqual(tokens.map(t => t[0]), [false, true]);
  assert.deepEqual(requests.map(r => r.body), ['{"id":1}', '{"id":1}']);
  assert.equal(requests[1].marker, 'present');
  assert.ok(requests.every(request => request.requestId === marker));
});
test('bounded plain 401, no redirects, no 403 replay, no transport replay', async () => {
  for (const status of [401, 302, 403]) {
    let calls = 0;
    const fetch = authenticatedFetch(endpoint, async () => 'fake', async () => { calls++; return new Response('', { status }); });
    await assert.rejects(fetch(endpoint));
    assert.equal(calls, status === 401 ? 2 : 1);
  }
  let calls = 0;
  await assert.rejects(authenticatedFetch(endpoint, async () => 'fake', async () => { calls++; throw new TypeError('private'); })(endpoint));
  assert.equal(calls, 1);
});
test('refuses every different destination before token acquisition', async () => {
  for (const transportMode of ['streamable-http', 'post-only']) {
    const fetch = authenticatedFetch(endpoint, async () => assert.fail('must not acquire'), async () => assert.fail('must not send'), { transportMode });
    for (const url of ['http://fixture.example/', 'https://evil.example/', endpoint + '&evil=1'])
      await assert.rejects(fetch(url, { headers: { accept: 'text/event-stream' } }), e => e.errorCode === 'ENDPOINT_REJECTED');
    await assert.rejects(fetch(endpoint, { headers: { host: 'evil.example', accept: 'text/event-stream' } }),
      e => e.errorCode === 'ENDPOINT_REJECTED');
  }
});
test('POST-only probe returns local empty 405 without acquiring a token or sending HTTP', async () => {
  let acquisitions = 0, sent = 0;
  const fetch = authenticatedFetch(endpoint, async () => { acquisitions++; return 'synthetic'; },
    async () => { sent++; return Response.json({ error: { code: 'RouteNotFound' } }, { status: 404 }); },
    { transportMode: 'post-only' });
  for (const session of [null, 'synthetic-session']) {
    const headers = new Headers({ accept: 'text/event-stream' });
    if (session) headers.set('mcp-session-id', session);
    const response = await fetch(endpoint, { headers });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'POST');
    assert.equal(response.body, null);
  }
  assert.equal(acquisitions, 0); assert.equal(sent, 0);
});
test('POST-only probe honors abort and rejects resumption and non-SSE GET explicitly', async () => {
  const fetch = authenticatedFetch(endpoint, () => assert.fail('must not acquire'), () => assert.fail('must not send'),
    { transportMode: 'post-only' });
  const signal = AbortSignal.abort();
  await assert.rejects(fetch(endpoint, { headers: { accept: 'text/event-stream' }, signal }), e => e === signal.reason);
  for (const eventId of ['synthetic-event', ''])
    await assert.rejects(fetch(endpoint, { headers: { accept: 'text/event-stream', 'last-event-id': eventId } }),
      e => e.errorCode === 'MCP_RESUMPTION_UNSUPPORTED' && /not replayed/.test(e.message));
  await assert.rejects(fetch(endpoint), e => e.errorCode === 'MCP_GET_UNSUPPORTED');
});
test('ordinary transport does not reinterpret server GET404 and passes through GET405', async () => {
  for (const status of [404, 405]) {
    let sent = 0;
    const response = new Response(null, { status });
    const fetch = authenticatedFetch(endpoint, async () => 'synthetic', async () => { sent++; return response; });
    if (status === 404) await assert.rejects(fetch(endpoint), e => e.status === 404);
    else assert.equal(await fetch(endpoint), response);
    assert.equal(sent, 1);
  }
});
test('POST-only mode preserves real POST failures, bounded authentication retry and no replay', async () => {
  for (const status of [302, 401, 403, 404, 405, 500]) {
    let sent = 0, acquisitions = 0;
    const fetch = authenticatedFetch(endpoint, async () => { acquisitions++; return 'synthetic'; },
      async request => {
        assert.equal(request.headers.get('x-ms-client-request-id'), marker);
        sent++; return new Response('private failure detail', { status });
      }, { transportMode: 'post-only' });
    await assert.rejects(fetch(endpoint, { method: 'POST', body: '{"id":1}', headers: { accept: 'application/json, text/event-stream' } }),
      e => !e.message.includes('private') && (status === 302 ? e.errorCode === 'REDIRECT_BLOCKED'
        : e.errorCode === 'HTTP_FAILURE'));
    assert.equal(sent, status === 401 ? 2 : 1); assert.equal(acquisitions, sent);
  }
});
test('unknown transport mode cannot silently fall back to network GET', () => {
  assert.throws(() => authenticatedFetch(endpoint, () => assert.fail('must not acquire'), () => assert.fail('must not send'),
    { transportMode: 'post-typo' }), e => e.errorCode === 'INVALID_CONFIGURATION');
});
test('SDK public resumeStream surfaces POST-only rejection without token acquisition or HTTP', async t => {
  const failures = [];
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    fetch: authenticatedFetch(endpoint, () => assert.fail('must not acquire'), () => assert.fail('must not send'),
      { transportMode: 'post-only' }),
    reconnectionOptions: { maxRetries: 0 }
  });
  t.after(() => transport.close());
  transport.onerror = error => failures.push(error);
  await transport.start();
  await assert.rejects(transport.resumeStream('synthetic-event'), e => e.errorCode === 'MCP_RESUMPTION_UNSUPPORTED');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].errorCode, 'MCP_RESUMPTION_UNSUPPORTED');
});
