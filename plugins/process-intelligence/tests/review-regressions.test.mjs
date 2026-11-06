// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { Gate } from '../src/errors.mjs';
import { RemoteBridge, createBridgeServer } from '../src/bridge.mjs';
import { FakeRemote } from './fake-remote.mjs';
import { bound } from './helpers.mjs';

test('queued cancellation rejects promptly without letting a successor overtake its predecessor', async () => {
  const gate = new Gate(), controller = new AbortController(); let release, started;
  const reached = new Promise(resolve => { started = resolve; });
  const holding = gate.run(async () => { started(); await new Promise(resolve => { release = resolve; }); });
  await reached;
  let executed = false;
  const queued = gate.run(() => { executed = true; }, controller.signal).then(() => 'resolved', e => e.name);
  controller.abort();
  try {
    assert.equal(await Promise.race([queued, delay(100, 'blocked')]), 'AbortError');
    let successor = false; const last = gate.run(() => { successor = true; });
    await delay(10); assert.equal(successor, false);
    release(); await holding; await last; assert.equal(executed, false);
  } finally { release(); await holding; }
});
test('outgoing fetch retains abort propagation after temporary request clones are garbage-collected', () => {
  const module = new URL('../src/http-auth.mjs', import.meta.url).href;
  const script = `
    import {authenticatedFetch} from ${JSON.stringify(module)};
    const controller=new AbortController(); let outgoing;
    const fetch=authenticatedFetch('https://fixture.invalid/mcp',async()=> 'fixture',
      async request=>{outgoing=request;return new Promise(resolve=>{
        request.signal.addEventListener('abort',()=>resolve(new Response('{}')));
        setTimeout(()=>resolve(new Response('{}')),200);
      })});
    const pending=fetch('https://fixture.invalid/mcp',{method:'POST',body:'{}',signal:controller.signal});
    for(let i=0;i<5;i++){await new Promise(resolve=>setImmediate(resolve));global.gc();}
    controller.abort(); await pending;
    if(!outgoing.signal.aborted)process.exitCode=1;`;
  const result = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
});
for (const code of [-32000, -32001, -32042]) test(`wire protocol error ${code} retains all data through local server`, async t => {
  const remote = new FakeRemote(), data = { sibling: 'must survive', elicitations: [{ mode: 'url',
    message: 'Fixture', elicitationId: 'fixture-id', url: 'https://example.invalid/fixture' }] };
  remote.callFailure = new McpError(code, 'Fixture protocol failure', data);
  const bridge = new RemoteBridge(bound, { getToken: async () => 'fixture' }, { fetchImpl: req => remote.fetch(req) });
  const server = createBridgeServer(bridge);
  t.after(async () => { await bridge.close(); await remote.close(); });
  await assert.rejects(server.fallbackRequestHandler({ method: 'tools/call', params: { name: 'fixture_query' } },
    { signal: new AbortController().signal }), error => error.code === code && JSON.stringify(error.data) === JSON.stringify(data));
});
test('initialization deadline also covers the initialized notification and closes owned HTTP requests', async t => {
  const remote = new FakeRemote(); let aborted = 0;
  const events = [], requests = [], start = Date.now();
  const bridge = new RemoteBridge(bound, { getToken: async () => 'fixture' }, { connectTimeout: 200, fetchImpl: async request => {
    const method = request.method === 'POST' ? (await request.clone().json()).method : request.method;
    events.push({ method, elapsed: Date.now() - start, aborted: request.signal.aborted });
    if (method === 'notifications/initialized') {
      // A real pending HTTP operation retains its request; a bare Promise would not.
      requests.push(request);
      return new Promise((resolve, reject) => {
        request.signal.addEventListener('abort', () => { events.push({ method: 'abort', elapsed: Date.now() - start }); aborted++; reject(request.signal.reason); }, { once: true });
      });
    }
    return remote.fetch(request);
  } });
  t.after(async () => { await bridge.close(); await remote.close(); });
  const pending = bridge.list().then(() => 'resolved', () => 'rejected');
  try {
    assert.equal(await Promise.race([pending, delay(1500, 'blocked')]), 'rejected');
    assert.equal(remote.initializations, 2, JSON.stringify(events)); assert.equal(aborted, 2, JSON.stringify(events));
    assert.ok(requests.every(request => request.signal.aborted));
  } finally { await bridge.close(); }
});
