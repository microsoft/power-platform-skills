// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { RemoteBridge, createBridgeServer, ObservedTransport } from '../src/bridge.mjs';
import { CorrelationSession } from '../src/correlation.mjs';
import { run } from '../src/cli.mjs';
import { authenticatedFetch } from '../src/http-auth.mjs';
import { FakeRemote, richResult } from './fake-remote.mjs';
import { bound, FakeAz } from './helpers.mjs';

function fixture(t) {
  const background = [], remote = new FakeRemote(), correlation = new CorrelationSession();
  const observed = [];
  const bridge = new RemoteBridge(bound, { getToken: async () => 'synthetic' }, {
    correlation, connectTimeout: 100, timeout: 500,
    fetchImpl: async request => {
      if (request.method === 'GET') background.push(new Headers(request.headers));
      if (request.method === 'POST') observed.push({
        owner: correlation.capture(), message: await request.clone().json()
      });
      return remote.fetch(request);
    }
  });
  const server = createBridgeServer(bridge);
  // Direct handler fixture; actual stdio notification delivery is tested separately.
  bridge.progress = async () => {};
  t.after(async () => { await bridge.close(); await remote.close(); });
  const invoke = (method, params = {}, signal) => server.fallbackRequestHandler({ method, params }, { signal });
  return { correlation, background, observed, remote, bridge, invoke };
}
const requestId = request => request.headers.get('x-ms-client-request-id');
const marker = '11111111-1111-1111-1111-111111111111';

test('SDK retries and calls share the wire marker but retain distinct internal owners and rich results', async t => {
  const f = fixture(t); f.remote.initializeFailures = [500];
  await f.invoke('tools/list');
  assert.deepEqual(await f.invoke('tools/call', { name: 'get_processes', arguments: { private: 'unchanged' } }), richResult);
  const list = f.remote.requests.find(r => r.message.method === 'tools/list');
  const call = f.remote.requests.find(r => r.message.method === 'tools/call');
  assert.equal(requestId(list), marker); assert.equal(requestId(call), marker);
  assert.notEqual(list.message.id, call.message.id);
  const listOwner = f.observed.find(r => r.message.method === 'tools/list').owner;
  const callOwner = f.observed.find(r => r.message.method === 'tools/call').owner;
  assert.notEqual(listOwner.clientRequestId, callOwner.clientRequestId);
  assert.equal(f.remote.requests.filter(r => r.message.method === 'initialize').length, 2);
  for (const req of f.remote.requests) {
    assert.equal(req.headers.get('x-ms-client-session-id'), f.correlation.clientSessionId);
    assert.equal(requestId(req), marker);
    if (req.message.method !== 'initialize')
      assert.equal(req.headers.get('mcp-session-id'), f.remote.latest.transport.sessionId);
  }
  for (const req of f.observed)
    assert.equal(req.owner, req.message.method === 'tools/call' ? callOwner : listOwner);
  assert.equal(f.background.length, 0);
});
test('invalid requests stay local and remote errors preserve code and data', async t => {
  const f = fixture(t);
  await assert.rejects(f.invoke('tools/call', {}), e => e.code === -32602);
  assert.equal(f.remote.requests.length, 0);
  f.remote.callFailure = new McpError(-32042, 'remote-protocol-error', { detail: 'unchanged' });
  await assert.rejects(f.invoke('tools/call', { name: 'unknown-tool-name' }),
    e => e.code === -32042 && e.data.detail === 'unchanged');
});
test('queued cancellation sends no HTTP and later requests reconnect without replay', async t => {
  const f = fixture(t), gate = Promise.withResolvers(), reached = Promise.withResolvers();
  f.remote.duringCall = async () => { reached.resolve(); await gate.promise; };
  const a = f.invoke('tools/call', { name: 'get_processes' }); await reached.promise;
  const count = f.remote.requests.length, cancelled = new AbortController();
  const b = f.invoke('tools/list', {}, cancelled.signal);
  cancelled.abort(); await assert.rejects(b);
  assert.equal(f.remote.requests.length, count);
  gate.resolve(); await a;
  f.remote.duringCall = null; f.remote.callFailure = 'transport';
  await assert.rejects(f.invoke('tools/call', { name: 'get_processes' }));
  assert.equal(f.remote.calls, 1);
  const initializations = f.remote.requests.filter(r => r.message.method === 'initialize').length;
  f.remote.callFailure = null; await f.invoke('tools/list');
  assert.equal(f.remote.requests.filter(r => r.message.method === 'initialize').length, initializations + 1);
});
test('401 retry and background traffic keep the marker and independent session IDs', async () => {
  const correlation = new CorrelationSession(), sent = [], endpoint = 'https://fixture.example/mcp';
  const fetch = authenticatedFetch(endpoint, async () => 'synthetic', async request => {
    sent.push(new Headers(request.headers)); return new Response('', { status: sent.length === 1 ? 401 : 200 });
  }, { correlation });
  let owner;
  await correlation.request(() => {
    owner = correlation.capture();
    return fetch(endpoint, { method: 'POST', body: '{}', headers: { 'mcp-session-id': 'remote-protocol-id' } });
  });
  assert.equal(sent.length, 2);
  assert.ok(sent.every(h => h.get('x-ms-client-request-id') === marker));
  assert.ok(sent.every(h => h.get('x-ms-client-session-id') === owner.clientSessionId));
  assert.ok(sent.every(h => h.get('mcp-session-id') === 'remote-protocol-id'));
  await correlation.request(() => fetch(endpoint, { headers: { 'x-ms-client-request-id': 'untrusted' } }));
  assert.equal(sent.at(-1).get('x-ms-client-request-id'), marker);
});
test('CLI remote diagnostics pages carry the marker and local serving starts without authentication', async () => {
  const correlation = new CorrelationSession();
  const store = { async load() { return bound; }, async ensureCurrent() {}, async loadChallenge() { return null; } };
  const remote = new FakeRemote({ stateless: true, postOnly: true }), stderr = new PassThrough(), stdout = new PassThrough();
  let diagnostics = ''; stderr.on('data', b => { diagnostics += b; });
  try {
    assert.equal(await run(['diagnostics', '--profile', 'sample', '--remote', 'true'], {
      correlation, store, cli: new FakeAz(), stderr, stdout, fetchImpl: r => remote.fetch(r)
    }), 0);
    assert.equal(remote.lists, 2);
    assert.equal(new Set(remote.requests.map(requestId)).size, 1);
    assert.equal(requestId(remote.requests[0]), marker);
    assert.match(diagnostics, /MCP_TRANSPORT: post-only/);
    assert.match(diagnostics, /MCP_INITIALIZE_AND_LIST_OK/);
    assert.equal(remote.getRequests.length, 0);
  } finally { await remote.close(); }
  const stdin = new PassThrough();
  await run(['serve', '--profile', 'sample'], { correlation, store, stdin, stderr, stdout,
    onReady: () => stdin.end(), cli: { run: () => assert.fail('startup does not acquire') } });
});
test('late POST SSE notification cannot borrow a completed or currently active request ID', async t => {
  const f = fixture(t), reached = Promise.withResolvers(), release = Promise.withResolvers(), notification = Promise.withResolvers();
  await f.invoke('tools/list');
  const a = f.observed.find(r => r.message.method === 'tools/list').owner;
  let sendNotification;
  f.remote.duringCall = async (server, request, extra) => { sendNotification = extra.sendNotification; reached.resolve(); await release.promise; };
  f.bridge.progress = () => notification.resolve(f.correlation.capture());
  const b = f.invoke('tools/call', { name: 'get_processes' }); await reached.promise;
  await sendNotification({ method: 'notifications/progress', params: { progressToken: 'late-A', progress: 1 } });
  const owner = await notification.promise; assert.equal(owner.clientRequestId, undefined);
  release.resolve(); await b;
  assert.notEqual(a.clientRequestId, f.observed.find(r => r.message.method === 'tools/call').owner.clientRequestId);
  assert.ok(f.remote.requests.every(r => requestId(r) === marker));
  assert.equal(f.background.length, 0);
});
test('SDK timeout does not replay the call and cancellation keeps its request owner', async t => {
  const f = fixture(t); await f.invoke('tools/list');
  f.bridge.timeout = 30;
  f.remote.duringCall = () => new Promise(resolve => setTimeout(resolve, 80));
  await assert.rejects(f.invoke('tools/call', { name: 'get_processes' }));
  const call = f.remote.requests.find(r => r.message.method === 'tools/call');
  const cancellation = f.remote.requests.find(r => r.message.method === 'notifications/cancelled');
  assert.equal(requestId(call), marker);
  if (cancellation) {
    assert.equal(requestId(cancellation), marker);
    assert.equal(cancellation.message.params.requestId, call.message.id);
    assert.equal(f.observed.find(r => r.message.method === 'notifications/cancelled').owner,
      f.observed.find(r => r.message.method === 'tools/call').owner);
  }
  assert.equal(f.remote.calls, 1);
});
test('transport cancellation resolves the outstanding request owner, not the current caller', async () => {
  const correlation = new CorrelationSession(), a = correlation.newRequest(), b = correlation.newRequest();
  const sent = [], inner = { async send() { sent.push(correlation.capture()); } };
  const transport = new ObservedTransport(inner, correlation);
  await correlation.run(a, () => transport.send({ method: 'tools/list', id: 10 }));
  await correlation.run(b, () => transport.send({ method: 'notifications/cancelled', params: { requestId: 10 } }));
  assert.equal(sent[1], a);
  await correlation.run(b, () => transport.send({ method: 'notifications/cancelled', params: { requestId: 10 } }));
  assert.equal(sent[2].clientRequestId, undefined);
  let callback;
  transport.onmessage = () => { callback = correlation.capture(); };
  correlation.run(b, () => inner.onmessage({ method: 'notifications/progress' }));
  assert.equal(callback.clientRequestId, undefined);
});
