// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import test from 'node:test';
import assert from 'node:assert/strict';
import { access, copyFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { bundleFixture, pluginRoot } from './bundle-fixtures.mjs';
import { richTool, richResult } from './fake-remote.mjs';

const schema = kind => `https://agent-plugins.org/schemas/1.0.0/${kind}.schema.json`;
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const legacyManifest = await json(path.join(pluginRoot, '.plugin', 'plugin.json'));
const legacyMcp = await json(path.join(pluginRoot, '.mcp.json'));

test('dual-format package has matching portable metadata and one shared stdio registration', async () => {
  const portable = await json(path.join(pluginRoot, 'plugin.json'));
  assert.deepEqual(portable, { $schema: schema('plugin'), ...legacyManifest });
  assert.deepEqual(await json(path.join(pluginRoot, '.claude-plugin', 'plugin.json')), legacyManifest);
  assert.equal(portable.version, '0.7.0');
  const mcp = await json(path.join(pluginRoot, 'mcp.json'));
  assert.deepEqual(mcp, { $schema: schema('mcp'), mcpServers: {
    'process-intelligence': { type: 'stdio', ...legacyMcp.mcpServers['process-intelligence'] }
  } });
  // New-mode discovery uses fixed locations, not the union of the legacy components.
  // No second logical server or alternate skills/runtime tree is declared by the manifest.
  for (const field of ['skills', 'mcpServers', 'agents', 'hooks']) assert.equal(portable[field], undefined);
  assert.deepEqual(Object.keys(mcp.mcpServers), ['process-intelligence']);
  assert.deepEqual((await readdir(path.join(pluginRoot, 'server'))).sort(), ['bundle-meta.json', 'mcp.mjs']);
  for (const skill of await readdir(path.join(pluginRoot, 'skills'))) {
    await access(path.join(pluginRoot, 'skills', skill, 'SKILL.md'));
  }
});

test('hybrid documentation states precedence, no merging and version-specific client limits', async () => {
  for (const file of ['README.md', 'references/development.md']) {
    const text = (await readFile(path.join(pluginRoot, file), 'utf8')).replace(/\s+/g, ' ');
    assert.match(text, /Agent Plugins 1\.0\.0/);
    for (const name of ['plugin.json', 'mcp.json', '.plugin/plugin.json', '.claude-plugin/plugin.json', '.mcp.json'])
      assert.ok(text.includes(name), `${file}: ${name}`);
    assert.match(text, /precedence/);
    assert.match(text, /not merged/);
    assert.match(text, /unsupported.*schema.*reject/i);
    assert.match(text, /Claude.*legacy/i);
    assert.match(text, /shared.*skills.*server\/mcp\.mjs/i);
  }
});

for (const file of ['mcp.json', '.mcp.json']) for (const selection of ['PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT', 'cwd'])
test(`${file} launches the same isolated bundle through ${selection} exactly once`, async t => {
  const f = await bundleFixture(t);
  await copyFile(path.join(pluginRoot, file), path.join(f.plugin, file));
  const config = await json(path.join(f.plugin, file));
  assert.deepEqual(Object.keys(config.mcpServers), ['process-intelligence']);
  const server = config.mcpServers['process-intelligence'];
  assert.equal(server.command, 'node');
  const env = { ...f.env, ...server.env, PLUGIN_ROOT: '', CLAUDE_PLUGIN_ROOT: '' };
  if (selection !== 'cwd') env[selection] = f.plugin;
  if (selection === 'PLUGIN_ROOT') env.CLAUDE_PLUGIN_ROOT = path.join(f.temp, 'wrong root');
  const transport = new StdioClientTransport({
    // Resolve the manifest's node token to this test runner; the fake CLI owns PATH.
    command: process.execPath,
    args: ['--import', pathToFileURL(path.join(pluginRoot, 'tests', 'bundle-preload.mjs')).href, ...server.args],
    env, cwd: selection === 'cwd' ? f.plugin : f.temp, stderr: 'pipe'
  });
  const client = new Client({ name: 'hybrid-fixture', version: '1' });
  f.cleanup.push(() => client.close());
  let stderr = '';
  transport.stderr.on('data', data => { stderr += data; });
  await client.connect(transport);
  assert.equal(client.getServerVersion().name, 'local-process-intelligence-bridge');
  assert.deepEqual((await client.request({ method: 'tools/list' }, z.looseObject({}))).tools, [richTool]);
  assert.deepEqual(await client.request({ method: 'tools/call', params: { name: 'fixture_query' } },
    z.looseObject({})), richResult);
  await client.close();
  assert.equal(stderr, '');
  const report = await json(f.env.FIXTURE_REPORT);
  assert.equal(report.initializes, 1);
  assert.equal(report.calls, 1);
  assert.ok(report.requests.every(request => request.request === '11111111-1111-1111-1111-111111111111'));
  assert.ok(report.requests.every(request => request.method === 'POST'));
  await assert.rejects(access(path.join(f.plugin, 'src')), { code: 'ENOENT' });
  await assert.rejects(access(path.join(f.plugin, 'node_modules')), { code: 'ENOENT' });
  await assert.rejects(access(f.configDir), { code: 'ENOENT' });
});
