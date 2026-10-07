// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteBridge, createBridgeServer } from '../src/bridge.mjs';
import { FakeRemote, richTool, contractTools } from './fake-remote.mjs';
import { bound } from './helpers.mjs';

function setup(t, Cloud = 'Public') {
  const remote = new FakeRemote({ stateless: true, postOnly: true });
  remote.tools = structuredClone(contractTools);
  const bridge = new RemoteBridge({ ...bound, Cloud }, { getToken: async () => 'synthetic' },
    { fetchImpl: req => remote.fetch(req) });
  t.after(async () => { await bridge.close(); await remote.close(); });
  return { remote, bridge };
}
test('discovery exposes one safe operation lifecycle without changing unrelated metadata', async t => {
  const { remote, bridge } = setup(t);
  const original = structuredClone(remote.tools), page = await bridge.list();
  assert.equal(page.tools.length, original.length);
  assert.match(page.tools[0].description, /1800/);
  assert.match(page.tools[0].description, /original submission/);
  assert.match(page.tools[0].description, /same operation ID/);
  assert.match(page.tools[0].description, /Never automatically resubmit/);
  assert.doesNotMatch(page.tools[0].description, /six polls|results are cached/);
  for (const key of ['inputSchema', 'outputSchema', 'annotations', '_meta', 'vendor'])
    assert.deepEqual(page.tools[0][key], original[0][key]);
  assert.deepEqual(page.tools[3], richTool);
  assert.deepEqual(remote.tools, original, 'Do not mutate the received catalog');
  const next = await bridge.list({ cursor: page.nextCursor });
  assert.equal(next.tools[0].description, page.tools[0].description);
});
test('formula guidance uses only advertised query modes and preserves future exact-name support', async t => {
  const { remote, bridge } = setup(t);
  const tool = (await bridge.list()).tools[1];
  assert.match(tool.description, /search/);
  assert.doesNotMatch(JSON.stringify(tool), /functionNames/);
  assert.deepEqual(tool.inputSchema.properties.search, remote.tools[1].inputSchema.properties.search);
  assert.deepEqual(tool.inputSchema.properties.category, remote.tools[1].inputSchema.properties.category);
  remote.tools[1].inputSchema.properties.functionNames = { type: 'array', items: { type: 'string' } };
  assert.deepEqual((await bridge.list()).tools[1], remote.tools[1]);
});
const clouds = ['Public', 'Gcc', 'GccHigh', 'DoD', 'Mooncake', 'public', 'PUBLIC', 'pUbLiC'];
test('ordinary tool metadata and schema defaults are preserved across configured clouds', async t => {
  for (const cloud of clouds) {
    const { remote, bridge } = setup(t, cloud);
    for (const value of remote.tools[2].inputSchema.properties.metricToSortBy.enum) {
      remote.tools[2].inputSchema.properties.metricToSortBy.default = value;
      const original = structuredClone(remote.tools[2]);
      assert.deepEqual((await bridge.list()).tools[2], original);
      assert.deepEqual(remote.tools[2], original);
    }
  }
});
test('tool arguments and original results are forwarded unchanged across configured clouds', async t => {
  for (const cloud of clouds) {
    const { remote, bridge } = setup(t, cloud);
    const server = createBridgeServer(bridge);
    remote.result = { content: [], structuredContent: { Items: [{ Index: 41 }, { Index: 9 }, { Index: 25 }], Offset: 0, TotalCount: 9 } };
    for (const metricToSortBy of remote.tools[2].inputSchema.properties.metricToSortBy.enum) {
      for (const sortOrder of ['Ascending', 'Descending']) {
        const params = { name: 'get_cases_with_metrics_v2', arguments: { processId: 'synthetic-process',
          filterOptions: { caseMetricConditionFilters: [{ metric: 'CaseDuration', comparisonOperator: 'EqualTo', values: ['00:00:00'] }] },
          metricToSortBy, sortOrder, itemsPerPage: 3, itemsToSkip: 0 } };
        assert.deepEqual(await bridge.call(params), remote.result);
        assert.deepEqual(remote.requests.at(-1).message.params, params);
        assert.deepEqual(await server.fallbackRequestHandler({ method: 'tools/call', params }, {}), remote.result);
        assert.deepEqual(remote.requests.at(-1).message.params, params);
      }
    }
  }
});
test('multi-page responses retain ordering, filters, counts and unknown tool inputs', async t => {
  const { remote, bridge } = setup(t);
  const source = [{ Index: 41, Name: 'C', Duration: '03:00:00' }, { Index: 9, Name: 'A', Duration: '01:00:00' },
    { Index: 25, Name: 'B', Duration: '02:00:00' }, { Index: 7, Name: 'D', Duration: '04:00:00' }];
  for (const metricToSortBy of ['Name', 'Duration']) for (const sortOrder of ['Ascending', 'Descending']) {
    const expected = [...source].sort((a, b) => a[metricToSortBy].localeCompare(b[metricToSortBy]) * (sortOrder === 'Ascending' ? 1 : -1));
    const received = [];
    for (const itemsToSkip of [0, 2]) {
      const params = { name: 'get_cases_with_metrics_v2', arguments: { processId: 'synthetic-process',
        filterOptions: { attributeValueFilters: [{ attributeName: 'Group', attributeValues: ['Example'] }] },
        metricToSortBy, sortOrder, itemsPerPage: 2, itemsToSkip }, _meta: { trace: 'unchanged' } };
      remote.result = { content: [], structuredContent: { Items: expected.slice(itemsToSkip, itemsToSkip + 2), Offset: itemsToSkip, TotalCount: 4 } };
      const result = await bridge.call(params);
      assert.deepEqual(result, remote.result); assert.deepEqual(remote.requests.at(-1).message.params, params);
      received.push(...result.structuredContent.Items);
    }
    assert.deepEqual(received, expected); assert.equal(new Set(received.map(row => row.Index)).size, 4);
  }
  const params = { name: 'new_discovered_tool', arguments: { metricToSortBy: 'Index', nested: { value: null } } };
  await bridge.call(params); assert.deepEqual(remote.requests.at(-1).message.params, params);
});
test('Processing payloads stay intact and aborted requests never become a replacement query', async t => {
  const { remote, bridge } = setup(t);
  remote.result = { content: [{ type: 'text', text: 'Synthetic response' }],
    structuredContent: { status: 'Processing', operationId: 'synthetic-operation', retryAfterSeconds: 240,
      instructions: 'retry original operation', custom: 'keep' } };
  assert.deepEqual(await bridge.call({ name: 'new_discovered_tool' }), remote.result);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(bridge.call({ name: 'get_operation_result', arguments: { operationId: 'synthetic-operation' } }, controller.signal),
    { name: 'AbortError' });
  assert.equal(remote.calls, 1);
});
