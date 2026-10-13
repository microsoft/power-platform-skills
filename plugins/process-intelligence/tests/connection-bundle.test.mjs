// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { bundleFixture, pluginRoot } from './bundle-fixtures.mjs';
import { sample, bound, removedClouds } from './helpers.mjs';
import { CONNECTION_TOOLS } from '../src/connection-session.mjs';

const schema = z.looseObject({});
const localNames = CONNECTION_TOOLS.map(tool => tool.name);
const request = (client, name, args = {}) =>
  client.request({ method: 'tools/call', params: { name, arguments: args } }, schema);

async function connect(f, profileName, name = 'fixture-client') {
  const manifest = JSON.parse(await fs.readFile(path.join(f.plugin, '.mcp.json'), 'utf8')).mcpServers['process-intelligence'];
  const args = profileName === undefined ? manifest.args :
    [path.join(f.plugin, 'server', 'mcp.mjs'), 'serve', '--profile', profileName];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', pathToFileURL(path.join(pluginRoot, 'tests', 'bundle-preload.mjs')).href, ...args],
    env: { ...f.env, PM_BRIDGE_PROFILE: '', FIXTURE_AZ_REPORT: path.join(f.temp, 'az.jsonl') },
    cwd: f.temp, stderr: 'pipe'
  });
  const client = new Client({ name, version: '1' });
  let stderr = '';
  transport.stderr.on('data', bytes => { stderr += bytes; });
  f.cleanup.push(() => client.close());
  await client.connect(transport);
  return { client, get stderr() { return stderr; } };
}

test('packaged MCP survives absent setup, permits agent binding, activates and remembers across a new process', async t => {
  const f = await bundleFixture(t);
  await fs.rm(f.state.file('sample'));
  const first = await connect(f);
  assert.deepEqual((await first.client.listTools()).tools.map(tool => tool.name), localNames);
  assert.equal((await request(first.client, localNames[0])).structuredContent.state, 'setup-required');
  await assert.rejects(fs.access(path.join(f.temp, 'az.jsonl')), { code: 'ENOENT' });
  let notifications = 0;
  first.client.setNotificationHandler(z.looseObject({ method: z.literal('notifications/tools/list_changed') }),
    () => { notifications++; });
  const entry = path.join(f.plugin, 'server', 'mcp.mjs');
  for (const args of [
    ['config', '--profile', 'sample', '--cloud', 'Public', '--tenant', sample.TenantId, '--environment', sample.EnvironmentId],
    ['login', '--profile', 'sample']
  ]) {
    const result = spawnSync(process.execPath, [entry, ...args], {
      env: { ...f.env, PM_BRIDGE_PROFILE: '' }, cwd: f.temp, encoding: 'utf8', timeout: 15000
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
  }
  assert.equal((await request(first.client, localNames[1], { profile: 'sample' })).structuredContent.state, 'active');
  const catalog = await first.client.listTools();
  assert.ok(catalog.tools.some(tool => tool.name === 'fixture_query'));
  await request(first.client, 'fixture_query');
  assert.equal(notifications, 1);
  const before = await fs.readFile(f.state.file('sample'), 'utf8');
  await first.client.close();
  const next = await connect(f);
  assert.ok((await next.client.listTools()).tools.some(tool => tool.name === 'fixture_query'));
  await request(next.client, 'fixture_query');
  assert.equal((await request(next.client, localNames[0])).structuredContent.profile, 'sample');
  assert.equal(await fs.readFile(f.state.file('sample'), 'utf8'), before);
  await next.client.close();
  const calls = (await fs.readFile(path.join(f.temp, 'az.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(calls.some(args => args[0] === 'login'), false);
  assert.equal(first.stderr + next.stderr, '');
});

for (const [label, transform, expected] of [
  ['unbound', () => sample, 'LOGIN_REQUIRED'],
  ['invalid OID', selected => ({ ...selected, HomeAccountId: 'not-an-oid' }), 'INVALID_CONFIGURATION'],
  ...removedClouds.map(Cloud => [Cloud, selected => ({ ...selected, Cloud }), 'INVALID_CONFIGURATION'])
]) test(`packaged ${label} profile leaves local recovery available without auth or HTTP`, async t => {
  const f = await bundleFixture(t);
  const content = JSON.stringify(transform(await f.state.load('sample')));
  await fs.writeFile(f.state.file('sample'), content);
  const { client } = await connect(f, 'sample');
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), localNames);
  const status = (await request(client, localNames[0])).structuredContent;
  assert.equal(status.state, 'recovery-required');
  assert.equal(status.errorCode, expected);
  await assert.rejects(fs.access(path.join(f.temp, 'az.jsonl')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(f.state.file('sample'), 'utf8'), content);
  await client.close();
  assert.equal(JSON.parse(await fs.readFile(f.env.FIXTURE_REPORT, 'utf8')).fetches, 0);
});
