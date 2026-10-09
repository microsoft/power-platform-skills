// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Test process only. The distributed bridge has no endpoint/token injection switch.
import { writeFileSync } from 'node:fs';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { FakeRemote, contractTools } from './fake-remote.mjs';
const remote = new FakeRemote({ postOnly: true, stateless: true, enableJsonResponse: process.env.FIXTURE_POST_JSON === '1' });
if (process.env.FIXTURE_CONTRACT_TOOLS === '1') remote.tools = contractTools;
const clientNames = [], requests = [];
let fetches = 0;
remote.duringCall = async (server, request, extra) => {
  if (request.params.name === 'fixture_protocol') throw new McpError(-32042, 'Fixture failure', { detail: 'preserved' });
  if (request.params.name === 'fixture_changed') await extra.sendNotification({ method: 'notifications/tools/list_changed' });
  if (request.params._meta?.progressToken !== undefined)
    await extra.sendNotification({ method: 'notifications/progress', params: {
      progressToken: request.params._meta.progressToken, progress: 1, total: 2, _meta: { fixture: true }
    } });
  if (request.params.name === 'fixture_wait') await new Promise(resolve => setTimeout(resolve, 300));
};
globalThis.fetch = async request => {
  fetches++;
  const observation = { method: request.method, session: request.headers.get('x-ms-client-session-id'),
    request: request.headers.get('x-ms-client-request-id'), protocolSession: request.headers.get('mcp-session-id') };
  requests.push(observation);
  if (request.method === 'POST') {
    const message = await request.clone().json();
    // Record only synthetic protocol identity, never tool arguments or authentication data.
    observation.rpcMethod = message.method;
    observation.rpcId = message.id;
    if (message.method === 'notifications/cancelled') observation.cancelRequestId = message.params?.requestId;
    if (message.method === 'initialize') clientNames.push(message.params.clientInfo.name);
    if (message.method === 'tools/call' && message.params.name === 'fixture_disconnect') {
      remote.calls++; throw new Error('Synthetic uncertain execution');
    }
  }
  return remote.fetch(request);
};
process.once('exit', () => {
  if (process.env.FIXTURE_REPORT) writeFileSync(process.env.FIXTURE_REPORT, JSON.stringify({ calls: remote.calls, initializes: remote.initializations, clientNames, fetches, requests }));
});
