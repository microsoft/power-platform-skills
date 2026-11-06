// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { RemoteBridge } from '../src/bridge.mjs';
import { resolveConnection } from '../src/configuration.mjs';
import { FakeRemote, richTool, richResult } from './fake-remote.mjs';
import { bound } from './helpers.mjs';

function setup(t, profile = bound) {
  const remote = new FakeRemote();
  const bridge = new RemoteBridge(profile, { getToken: async () => 'fixture-access' }, {
    fetchImpl: req => remote.fetch(req), timeout: 1500, connectTimeout: 500
  });
  t.after(async () => { await bridge.close(); await remote.close(); });
  return { remote, bridge };
}
test('official HTTP transport preserves tools, pages, schemas, content, metadata and negotiated version', async t => {
  const { remote, bridge } = setup(t);
  const first = await bridge.list({ _meta: { trace: 'fixture' } });
  assert.deepEqual(first.tools, [richTool]); assert.equal(first.nextCursor, 'upstream-cursor');
  assert.deepEqual(first._meta, { fixture: 'page' });
  const next = await bridge.list({ cursor: first.nextCursor }); assert.equal(next.nextCursor, undefined);
  const args = { name: 'fixture_query', arguments: { value: null }, _meta: { trace: 'call', progressToken: 'visible' } };
  assert.deepEqual(await bridge.call(args), richResult);
  const sent = remote.requests.filter(r => r.message.method === 'tools/call')[0];
  assert.deepEqual(sent.message.params, args);
  assert.equal(sent.headers.get('mcp-protocol-version'), '2025-06-18');
  assert.equal(sent.headers.get('authorization'), 'Bearer fixture-access');
  assert.equal(remote.requests.find(r => r.message.method === 'tools/list').message.params._meta.trace, 'fixture');
});
test('only transient initialization retries once; failures remain sanitized', async t => {
  for (const status of [500, 408, 403, 404]) {
    const { bridge, remote } = setup(t); remote.initializeFailures = [status];
    if (status === 500 || status === 408) { await bridge.list(); assert.equal(remote.initializations, 2); }
    else { await assert.rejects(bridge.list(), e => !e.message.includes('private')); assert.equal(remote.initializations, 1); }
  }
  const { bridge, remote } = setup(t); remote.initializeFailures = [500, 500, 500];
  await assert.rejects(bridge.list()); assert.equal(remote.initializations, 2);
});
test('uncertain tools are never replayed; next separate request reconnects', async t => {
  const { remote, bridge } = setup(t); remote.callFailure = 'transport';
  await assert.rejects(bridge.call({ name: 'fixture_query' }), /not replayed/);
  assert.equal(remote.requests.filter(r => r.message.method === 'tools/call').length, 1);
  remote.callFailure = null; await bridge.call({ name: 'fixture_query' }); assert.equal(remote.initializations, 2);
});
test('remote protocol errors keep code/data and do not become tool results', async t => {
  const { remote, bridge } = setup(t);
  remote.callFailure = new McpError(-32042, 'Fixture protocol error', { fixture: 'data' });
  await assert.rejects(bridge.call({ name: 'fixture_query' }), e => e.code === -32042 && e.data.fixture === 'data');
  assert.equal(remote.initializations, 1);
});
test('backend list changes do not interrupt discovery or trigger automatic rediscovery', async t => {
  const { bridge, remote } = setup(t);
  remote.duringList = async (server, request, extra) => {
    await extra.sendNotification({ method: 'notifications/tools/list_changed' });
    await delay(20);
  };
  const first = await bridge.list();
  assert.deepEqual(first.tools, [richTool]);
  const next = await bridge.list({ cursor: first.nextCursor });
  assert.equal(next.nextCursor, undefined);
  assert.equal(remote.requests.at(-1).message.params.cursor, 'upstream-cursor');
  assert.equal(remote.lists, 2);
  assert.equal(remote.initializations, 1);
});
for (const EnvironmentId of [bound.EnvironmentId, 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'])
test(`a new bridge session discovers the updated catalog for ${EnvironmentId}`, async t => {
  const selected = { ...bound, EnvironmentId };
  const { bridge, remote } = setup(t, selected);
  assert.equal(remote.initializations, 0, 'Discovery starts when the host requests tools');
  assert.deepEqual((await bridge.list()).tools, [richTool]);
  const added = { name: 'fixture_added', inputSchema: { type: 'object' } };
  remote.tools = [richTool, added];
  await bridge.call({ name: richTool.name });
  assert.equal(remote.lists, 1, 'Ordinary calls do not refresh the catalog');
  await bridge.close();

  const requests = [];
  const next = new RemoteBridge(selected, { getToken: async () => 'fixture-access' }, {
    fetchImpl: request => {
      requests.push(request.url);
      return remote.fetch(request);
    }
  });
  t.after(() => next.close());
  assert.deepEqual((await next.list()).tools, [richTool, added]);
  assert.ok(requests.every(url => url === resolveConnection(selected).endpoint));
  assert.equal(remote.initializations, 2);
  assert.equal(remote.lists, 2);
});
test('backend validates opaque list cursors and its errors remain transparent', async t => {
  const { bridge, remote } = setup(t);
  const expired = new McpError(-32602, 'Fixture cursor expired', { restart: true });
  remote.duringList = async (server, request) => {
    if (request.params?.cursor === 'expired-cursor') {
      throw expired;
    }
  };
  await assert.rejects(bridge.list({ cursor: 'expired-cursor' }),
    error => error.code === expired.code && error.message === expired.message && error.data.restart);
  assert.equal(remote.requests.at(-1).message.params.cursor, 'expired-cursor');
  assert.deepEqual((await bridge.list()).tools, [richTool]);
  assert.equal(remote.initializations, 1);
});
test('progress is forwarded without replacing the caller token or stripping metadata', async t => {
  const { bridge, remote } = setup(t); const seen = [];
  bridge.progress = async value => { seen.push(value); };
  remote.duringCall = async (server, request, extra) => {
    await extra.sendNotification({ method: 'notifications/progress', params: {
      progressToken: request.params._meta.progressToken, progress: 1, total: 2, _meta: { fixture: true }, custom: 'preserved'
    } }); await delay(20);
  };
  await bridge.call({ name: 'fixture_query', _meta: { progressToken: 'local-token' } });
  assert.deepEqual(seen[0].params, { progressToken: 'local-token', progress: 1, total: 2, _meta: { fixture: true }, custom: 'preserved' });
});
test('cancellation stops the owned transport and does not replay; later request reconnects', async t => {
  const { bridge, remote } = setup(t); const controller = new AbortController();
  let reached; const started = new Promise(r => { reached = r; });
  remote.duringCall = async () => { reached(); await delay(300); };
  const pending = bridge.call({ name: 'fixture_query' }, controller.signal);
  await started; controller.abort();
  await assert.rejects(pending);
  remote.duringCall = null; await bridge.list();
  assert.equal(remote.calls, 1); assert.equal(remote.initializations, 2);
});
for (const enableJsonResponse of [true, false]) {
  for (const timing of ['early', 'late']) test(`POST-only ${enableJsonResponse ? 'JSON' : 'SSE'} discovery and operation polling never send ${timing} GET404`, async t => {
    const remote = new FakeRemote({ postOnly: true, stateless: true, enableJsonResponse });
    const release = Promise.withResolvers(), methods = []; let acquisitions = 0;
    const bridge = new RemoteBridge(bound, { getToken: async () => { acquisitions++; return 'synthetic'; } }, {
      timeout: 1500, connectTimeout: 500,
      fetchImpl: async request => {
        methods.push(request.method);
        if (request.method === 'GET' && timing === 'late') await release.promise;
        // Make the initial GET failure win before discovery; the late case releases it
        // after discovery, reproducing the former diagnostic-success race.
        if (request.method === 'POST' && timing === 'early' && (await request.clone().json()).method === 'tools/list') await delay(10);
        return remote.fetch(request);
      }
    });
    t.after(async () => { release.resolve(); await bridge.close(); await remote.close(); });
    remote.tools = [
      { name: 'fixture_submit', inputSchema: { type: 'object' } },
      { name: 'fixture_operation_result', inputSchema: { type: 'object' } }
    ];
    const first = await bridge.list();
    assert.deepEqual(first.tools, remote.tools);
    const next = await bridge.list({ cursor: first.nextCursor });
    assert.equal(next.nextCursor, undefined);
    release.resolve(); await delay(10);
    remote.result = { content: [], structuredContent: { status: 'pending', operationId: 'synthetic-operation', retryAfter: 0 } };
    const pending = await bridge.call({ name: first.tools[0].name, arguments: {} });
    remote.result = richResult;
    assert.deepEqual(await bridge.call({ name: first.tools[1].name, arguments: { operationId: pending.structuredContent.operationId } }), richResult);
    assert.deepEqual(methods, ['POST', 'POST', 'POST', 'POST', 'POST', 'POST']);
    assert.equal(acquisitions, methods.length);
    assert.equal(remote.initializations, 1); assert.equal(remote.calls, 2);
    assert.equal(remote.getRequests.length, 0);
    assert.equal(remote.responses.find(r => r.method === 'notifications/initialized').status, 202);
    assert.ok(remote.responses.filter(r => ['tools/list', 'tools/call'].includes(r.method))
      .every(r => r.contentType.startsWith(enableJsonResponse ? 'application/json' : 'text/event-stream')));
    assert.ok(remote.requests.every(r => !r.headers.has('mcp-session-id')));
    assert.ok(remote.requests.filter(r => r.message.method !== 'initialize')
      .every(r => r.headers.get('mcp-protocol-version') === '2025-06-18'));
    assert.deepEqual(remote.requests.at(-1).message.params.arguments, { operationId: 'synthetic-operation' });
  });
}
test('POST-only bridge does not hide or replay real tool-call HTTP failures', async t => {
  for (const status of [401, 403, 404, 405, 500]) {
    const remote = new FakeRemote({ postOnly: true, stateless: true }); let calls = 0;
    const bridge = new RemoteBridge(bound, { getToken: async () => 'synthetic' }, {
      timeout: 1500, connectTimeout: 500,
      fetchImpl: async request => {
        if (request.method === 'POST' && (await request.clone().json()).method === 'tools/call') {
          calls++; return new Response('private HTTP failure body', { status });
        }
        return remote.fetch(request);
      }
    });
    t.after(async () => { await bridge.close(); await remote.close(); });
    await bridge.list();
    await assert.rejects(bridge.call({ name: 'fixture_query' }), e => e.errorCode === 'HTTP_FAILURE' && !e.message.includes('private'));
    assert.equal(calls, status === 401 ? 2 : 1);
    assert.equal(remote.initializations, 1);
    assert.equal(remote.getRequests.length, 0);
  }
});
test('interrupted POST SSE fails without GET resumption or business-call replay', async t => {
  const remote = new FakeRemote({ postOnly: true, stateless: true }), reached = Promise.withResolvers();
  let controller, calls = 0;
  const bridge = new RemoteBridge(bound, { getToken: async () => 'synthetic' }, {
    timeout: 1500, connectTimeout: 500,
    fetchImpl: async request => {
      if (request.method === 'POST' && (await request.clone().json()).method === 'tools/call') {
        calls++;
        // A resumable POST stream supplies an event ID before the connection fails.
        const notification = { jsonrpc: '2.0', method: 'notifications/progress',
          params: { progressToken: 'fixture-progress', progress: 1 } };
        return new Response(new ReadableStream({ start(stream) {
          controller = stream;
          stream.enqueue(new TextEncoder().encode(`id: synthetic-event\nevent: message\ndata: ${JSON.stringify(notification)}\n\n`));
        } }), { headers: { 'content-type': 'text/event-stream' } });
      }
      return remote.fetch(request);
    }
  });
  t.after(async () => { await bridge.close(); await remote.close(); });
  bridge.progress = () => reached.resolve();
  const pending = bridge.call({ name: 'fixture_query', _meta: { progressToken: 'fixture-progress' } });
  const failed = assert.rejects(pending, /not replayed/);
  await reached.promise;
  controller.error(new Error('private stream failure detail'));
  await failed;
  await delay(10);
  assert.equal(calls, 1);
  assert.equal(remote.initializations, 1);
  assert.equal(remote.getRequests.length, 0);
});
