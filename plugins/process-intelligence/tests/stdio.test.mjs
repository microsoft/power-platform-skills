// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import test from 'node:test';
import assert from 'node:assert/strict';
import { rm, readFile, access, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { sample, bound, claim, assertProfileBytes, removedClouds } from './helpers.mjs';
import { richTool, richResult, contractTools } from './fake-remote.mjs';
import { bundleFixture as fixture, pluginRoot as root } from './bundle-fixtures.mjs';

const resultSchema = z.looseObject({});
const requestMarker = '11111111-1111-1111-1111-111111111111';
function assertRequestMarkers(report) {
  assert.ok(report.requests.length > 0);
  for (const request of report.requests) {
    assert.equal(request.request, requestMarker);
    assert.match(request.session, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
    assert.notEqual(request.session, requestMarker);
    assert.equal(request.protocolSession, null, 'the stateless fixture supplies no MCP session ID');
  }
}
test('actual isolated bundle resolves tenant without a profile and gates unsupported discovery clouds', async t => {
  const f = await fixture(t), entry = path.join(f.plugin, 'server', 'mcp.mjs');
  await rm(f.state.root, { recursive: true });
  const preload = pathToFileURL(path.join(root, 'tests', 'environment-bundle-preload.mjs')).href;
  const env = { ...f.env, PM_BRIDGE_PROFILE: '', FIXTURE_AZ_REPORT: path.join(f.temp, 'az-report.jsonl') };
  const invoke = cloud => spawnSync(process.execPath, ['--import', preload, entry,
    'resolve-environment', '--cloud', cloud, '--environment', sample.EnvironmentId],
  { env, cwd: f.temp, encoding: 'utf8', timeout: 15000 });
  const unsupported = invoke('Gcc');
  assert.equal(unsupported.status, 2, unsupported.stderr);
  assert.match(unsupported.stderr, /Public/);
  await assert.rejects(access(env.FIXTURE_AZ_REPORT), { code: 'ENOENT' });
  assert.equal(JSON.parse(await readFile(env.FIXTURE_REPORT, 'utf8')).fetches, 0);
  const output = invoke('Public');
  assert.equal(output.status, 0, output.stderr);
  assert.equal(output.stdout, '');
  assert.deepEqual(JSON.parse(output.stderr), { cloud: 'Public', environmentId: sample.EnvironmentId,
    tenantId: sample.TenantId, source: 'environment-metadata' });
  assert.equal(JSON.parse(await readFile(env.FIXTURE_REPORT, 'utf8')).fetches, 1);
  await assert.rejects(access(f.state.root), { code: 'ENOENT' });
  await assert.rejects(access(f.configDir), { code: 'ENOENT' });
  await assert.rejects(access(path.join(f.plugin, 'src')), { code: 'ENOENT' });
  await assert.rejects(access(path.join(f.plugin, 'node_modules')), { code: 'ENOENT' });
});
test('actual isolated no-dotnet bundle supports direct help/config, import without autostart and missing prerequisites', async t => {
  const f = await fixture(t), entry = path.join(f.plugin, 'server', 'mcp.mjs');
  await assert.rejects(access(path.join(f.plugin, 'src'))); await assert.rejects(access(path.join(f.plugin, 'node_modules')));
  for (const args of [['--help'],
    ...['Public', 'Mooncake'].map(cloud => ['config', '--profile', cloud.toLowerCase(), '--cloud', cloud,
      '--tenant', sample.TenantId, '--environment', sample.EnvironmentId])]) {
    const output = spawnSync(process.execPath, [entry, ...args], { env: f.env, cwd: f.temp, encoding: 'utf8', timeout: 15000 });
    assert.equal(output.status, 0, output.stderr); assert.equal(output.stdout, '');
    if (args[0] === '--help') assert.match(output.stderr, /Process Intelligence Azure CLI bridge/);
  }
  assert.equal((await f.state.load('mooncake')).Cloud, 'Mooncake');
  const imported = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(pathToFileURL(entry).href)})`],
    { env: f.env, cwd: f.temp, encoding: 'utf8', timeout: 10000 });
  assert.equal(imported.status, 0); assert.equal(imported.stdout + imported.stderr, '');
  await rm(f.az);
  const missing = spawnSync(process.execPath, [entry, 'diagnostics', '--profile', 'sample'],
    { env: f.env, encoding: 'utf8', timeout: 15000 });
  assert.equal(missing.status, 3); assert.match(missing.stderr, /Azure CLI executable/); assert.equal(missing.stdout, '');
});
test('actual isolated bundle persists canonical environment aliases without auth or HTTP', async t => {
  const f = await fixture(t);
  const entry = path.join(f.plugin, 'server', 'mcp.mjs');
  const preload = pathToFileURL(path.join(root, 'tests', 'bundle-preload.mjs')).href;
  const env = { ...f.env, FIXTURE_AZ_REPORT: path.join(f.temp, 'az-report.jsonl') };
  for (const prefix of ['', 'Default', 'Legacy', 'Primary']) {
    const environment = prefix.toLowerCase() + sample.EnvironmentId.replaceAll('-', '').toUpperCase();
    const output = spawnSync(process.execPath, ['--import', preload, entry, 'config',
      '--profile', 'sample', '--cloud', 'Public', '--tenant', sample.TenantId,
      '--environment', environment], { env, cwd: f.temp, encoding: 'utf8', timeout: 15000 });
    assert.equal(output.status, 0, output.stderr);
    assert.equal(output.stdout, '');
    const saved = JSON.parse(await readFile(path.join(f.state.root, 'sample.json'), 'utf8'));
    assert.equal(saved.EnvironmentId, (prefix ? prefix + '-' : '') + sample.EnvironmentId);
    assert.equal(JSON.parse(await readFile(env.FIXTURE_REPORT, 'utf8')).fetches, 0);
  }
  await assert.rejects(access(env.FIXTURE_AZ_REPORT), { code: 'ENOENT' });
  await assert.rejects(access(f.configDir), { code: 'ENOENT' });
});
test('actual bundle requests manual login for a claims challenge without state changes or replay', async t => {
  const f = await fixture(t);
  const entry = pathToFileURL(path.join(f.plugin, 'server', 'mcp.mjs')).href;
  const report = path.join(f.temp, 'challenge-report.json');
  const profileBefore = await readFile(f.state.file('sample'));
  const env = { ...f.env, FIXTURE_AZ_REPORT: path.join(f.temp, 'az-report.jsonl') };
  const header = `Bearer error="insufficient_claims", claims="${Buffer.from(claim).toString('base64')}"`;
  const code = `const {launch}=await import(${JSON.stringify(entry)});
    const {writeFile}=await import('node:fs/promises');let sent=0;
    await launch(['diagnostics','--profile','sample','--remote','true'],{
      fetchImpl:async()=>{sent++;return new Response(null,{status:401,
        headers:{'www-authenticate':${JSON.stringify(header)}}});}
    });
    await writeFile(${JSON.stringify(report)},JSON.stringify({sent}));`;
  const output = spawnSync(process.execPath, ['--input-type=module', '-e', code],
    { env, cwd: f.temp, encoding: 'utf8', timeout: 15000 });
  assert.equal(output.status, 3, output.stderr);
  assert.match(output.stderr, /Conditional Access.*CAE/);
  assert.match(output.stderr, /login --profile NAME --sign-in true/);
  assert.doesNotMatch(output.stderr, /acrs|fixture@example|2\.80|--claims-challenge/);
  assert.equal(output.stdout, '');
  assert.equal(JSON.parse(await readFile(report)).sent, 1);
  assert.deepEqual(await readdir(f.state.root), ['sample.json']);
  assert.deepEqual(await readFile(f.state.file('sample')), profileBefore);
  const calls = (await readFile(env.FIXTURE_AZ_REPORT, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(calls.every(args => args[0] !== 'login' && !args.includes('--claims-challenge')));
});
test('actual isolated bundle rejects malformed stored OID before authentication or HTTP', async t => {
  const f = await fixture(t);
  const entry = path.join(f.plugin, 'server', 'mcp.mjs');
  const preload = pathToFileURL(path.join(root, 'tests', 'bundle-preload.mjs')).href;
  const env = { ...f.env, FIXTURE_AZ_REPORT: path.join(f.temp, 'az-report.jsonl') };
  const file = f.state.file('sample');
  const content = JSON.stringify({ ...await f.state.load('sample'), HomeAccountId: 'not-an-oid' });
  await writeFile(file, content);
  for (const args of [['diagnostics'], ['diagnostics', '--remote', 'true'], ['login'], ['serve']]) {
    const output = spawnSync(process.execPath, ['--import', preload, entry, ...args, '--profile', 'sample'],
      { env, cwd: f.temp, encoding: 'utf8', timeout: 15000 });
    assert.equal(output.status, 2, output.stderr);
    assert.match(output.stderr, /account selection.*OID GUID or null/);
    assert.doesNotMatch(output.stderr, /not-an-oid|account-selected|TOKEN_ACQUIRED/);
    assert.equal(output.stdout, '');
    await assert.rejects(access(env.FIXTURE_AZ_REPORT), { code: 'ENOENT' });
    assert.equal(JSON.parse(await readFile(env.FIXTURE_REPORT, 'utf8')).fetches, 0);
    assert.equal(await readFile(file, 'utf8'), content);
  }
});
test('actual bundle token-free diagnostics defer OID verification and remote acquisition rejects another principal', async t => {
  const f = await fixture(t);
  const entry = pathToFileURL(path.join(f.plugin, 'server', 'mcp.mjs')).href;
  const helper = pathToFileURL(path.join(root, 'tests', 'helpers.mjs')).href;
  const preload = pathToFileURL(path.join(root, 'tests', 'bundle-preload.mjs')).href;
  const before = await readFile(f.state.file('sample'), 'utf8');
  for (const remote of [false, true]) {
    const args = ['diagnostics', '--profile', 'sample', '--remote', String(remote)];
    const code = `const {launch}=await import(${JSON.stringify(entry)});
      const {FakeAz,token}=await import(${JSON.stringify(helper)});
      const cli=new FakeAz();cli.user='another@example.invalid';
      cli.tokenOutput=token({oid:'44444444-4444-4444-4444-444444444444',unique_name:cli.user});
      await launch(${JSON.stringify(args)},{cli});`;
    const output = spawnSync(process.execPath, ['--import', preload, '--input-type=module', '-e', code],
      { env: f.env, cwd: f.temp, encoding: 'utf8', timeout: 15000 });
    assert.equal(output.status, remote ? 3 : 0, output.stderr);
    if (remote) assert.match(output.stderr, /different account|account changed/i);
    else {
      const local = JSON.parse(output.stderr);
      assert.equal(local.sessionCheckScope, 'cloud-tenant-user-shape');
      assert.equal(local.boundAccountVerified, false);
      assert.equal(local.tokenAcquired, false);
    }
    assert.equal(output.stdout, '');
    assert.doesNotMatch(output.stderr, /another@example|44444444|accessToken|eyJ/);
    assert.equal(JSON.parse(await readFile(f.env.FIXTURE_REPORT, 'utf8')).fetches, 0);
    assert.equal(await readFile(f.state.file('sample'), 'utf8'), before);
  }
});
test('actual bundle warm username drift blocks further MCP traffic without persisting the username', async t => {
  const f = await fixture(t);
  const entry = pathToFileURL(path.join(f.plugin, 'server', 'mcp.mjs')).href;
  const helper = pathToFileURL(path.join(root, 'tests', 'helpers.mjs')).href;
  const preload = pathToFileURL(path.join(root, 'tests', 'bundle-preload.mjs')).href;
  const before = await readFile(f.state.file('sample'), 'utf8');
  const code = `const {launch}=await import(${JSON.stringify(entry)});
    const {FakeAz}=await import(${JSON.stringify(helper)});const cli=new FakeAz();
    const fetch=globalThis.fetch;
    globalThis.fetch=async request=>{
      const message=await request.clone().json();const response=await fetch(request);
      if(message.method==='tools/list')cli.user='switched@example.invalid';
      return response;
    };
    await launch(['serve','--profile','sample'],{cli});`;
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ['--import', preload, '--input-type=module', '-e', code],
    env: f.env, cwd: f.temp, stderr: 'pipe' });
  const client = new Client({ name: 'fixture-client', version: '1' });
  let stderr = '';
  transport.stderr.on('data', bytes => { stderr += bytes; });
  f.cleanup.push(() => client.close());
  await client.connect(transport);
  await client.request({ method: 'tools/list' }, resultSchema);
  await assert.rejects(client.request({ method: 'tools/call', params: { name: 'fixture_query' } }, resultSchema),
    error => /account changed/i.test(error.message) && !error.message.includes('switched@example'));
  await client.close();
  const report = JSON.parse(await readFile(f.env.FIXTURE_REPORT, 'utf8'));
  assertRequestMarkers(report);
  assert.equal(report.calls, 0);
  assert.deepEqual(report.requests.map(request => request.rpcMethod),
    ['initialize', 'notifications/initialized', 'tools/list']);
  assert.equal(await readFile(f.state.file('sample'), 'utf8'), before);
  assert.equal(stderr, '');
});
test('actual bundle keeps its early unsupported-Node guard without accessing private settings', async t => {
  const f = await fixture(t), entry = pathToFileURL(path.join(f.plugin, 'server', 'mcp.mjs')).href;
  const result = spawnSync(process.execPath, ['-e',
    `Object.defineProperty(process.versions,'node',{value:'20.0.0'});import(${JSON.stringify(entry)}).then(m=>m.launch(['serve']))`],
  { env: { ...f.env, PM_BRIDGE_PROFILE: '' }, cwd: f.temp, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 1, result.stderr); assert.equal(result.stdout, '');
  assert.match(result.stderr, /requires supported Node.js 22 or 24/);
  await assert.rejects(access(f.configDir), { code: 'ENOENT' });
});
test('actual bundle and manifest reject removed clouds before auth, fetch or profile mutation', async t => {
  const f = await fixture(t), entry = path.join(f.plugin, 'server', 'mcp.mjs');
  const preload = pathToFileURL(path.join(root, 'tests', 'bundle-preload.mjs')).href;
  const manifest = JSON.parse(await readFile(path.join(f.plugin, '.mcp.json'), 'utf8')).mcpServers['process-intelligence'];
  const env = { ...f.env, FIXTURE_AZ_REPORT: path.join(f.temp, 'az-report.jsonl') };
  const file = path.join(f.state.root, 'sample.json'), original = await readFile(file, 'utf8');
  for (const Cloud of removedClouds) {
    for (const name of ['new', 'sample']) {
      const output = spawnSync(process.execPath, ['--import', preload, entry, 'config', '--profile', name,
        '--cloud', Cloud, '--tenant', sample.TenantId, '--environment', sample.EnvironmentId],
      { env, cwd: f.temp, encoding: 'utf8', timeout: 15000 });
      assert.equal(output.status, 2, output.stderr);
      assert.match(output.stderr, /Choose Public, Gcc, GccHigh, DoD or Mooncake\./);
      assert.equal(output.stdout, '');
      assert.deepEqual(await readdir(f.state.root), ['sample.json']);
      assert.equal(await readFile(file, 'utf8'), original);
      assert.equal(JSON.parse(await readFile(env.FIXTURE_REPORT, 'utf8')).fetches, 0);
      await assert.rejects(access(env.FIXTURE_AZ_REPORT), { code: 'ENOENT' });
    }
    const saved = JSON.stringify({ ...JSON.parse(original), Cloud });
    await writeFile(file, saved);
    for (const args of [
      [entry, 'diagnostics', '--profile', 'sample'],
      [entry, 'diagnostics', '--profile', 'sample', '--remote', 'true'],
      [entry, 'login', '--profile', 'sample'],
      [entry, 'logout', '--profile', 'sample'],
      manifest.args
    ]) {
      const output = spawnSync(process.execPath, ['--import', preload, ...args],
        { env, cwd: f.temp, encoding: 'utf8', timeout: 15000 });
      assert.equal(output.status, 2, output.stderr);
      assert.match(output.stderr, /Choose Public, Gcc, GccHigh, DoD or Mooncake\./);
      assert.equal(output.stdout, '');
      assert.equal(await readFile(file, 'utf8'), saved);
      assert.deepEqual(await readdir(f.state.root), ['sample.json']);
      assert.equal(JSON.parse(await readFile(env.FIXTURE_REPORT, 'utf8')).fetches, 0);
      await assert.rejects(access(env.FIXTURE_AZ_REPORT), { code: 'ENOENT' });
      await assert.rejects(access(f.configDir), { code: 'ENOENT' });
    }
    await writeFile(file, original);
  }
});
test('actual manifest -> isolated bundle -> official SDK HTTP preserves rich data, errors, progress, cursors and reconnect', async t => {
  const f = await fixture(t), manifest = JSON.parse(await readFile(path.join(f.plugin, '.mcp.json'), 'utf8')).mcpServers['process-intelligence'];
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ['--import', pathToFileURL(path.join(root, 'tests', 'bundle-preload.mjs')).href, ...manifest.args],
    env: f.env, cwd: f.temp, stderr: 'pipe' });
  const client = new Client({ name: 'fixture-client', version: '1' });
  let stderr = '', changed = 0; const progress = [];
  transport.stderr.on('data', b => { stderr += b; });
  client.setNotificationHandler(z.looseObject({ method: z.literal('notifications/tools/list_changed') }), () => { changed++; });
  client.setNotificationHandler(z.looseObject({ method: z.literal('notifications/progress'), params: z.looseObject({}) }), n => { progress.push(n); });
  f.cleanup.push(() => client.close());
  await client.connect(transport);
  assert.equal(client.getServerVersion().name, 'local-process-intelligence-bridge');
  assert.deepEqual(client.getServerCapabilities().tools, {});
  const first = await client.request({ method: 'tools/list', params: { _meta: { trace: 'fixture' } } }, resultSchema);
  assert.deepEqual(first.tools, [richTool]); assert.equal(first.nextCursor, 'upstream-cursor');
  assert.equal((await client.request({ method: 'tools/list', params: { cursor: first.nextCursor } }, resultSchema)).nextCursor, undefined);
  assert.deepEqual(await client.request({ method: 'tools/call', params: { name: 'fixture_query', _meta: { progressToken: 'test-token' } } }, resultSchema), richResult);
  assert.equal(progress[0].params.progressToken, 'test-token');
  await assert.rejects(client.request({ method: 'tools/call', params: { name: 'fixture_protocol' } }, resultSchema),
    e => e.code === -32042 && e.data.detail === 'preserved');
  await client.request({ method: 'tools/call', params: { name: 'fixture_changed' } }, resultSchema);
  assert.equal((await client.request({ method: 'tools/list',
    params: { cursor: first.nextCursor } }, resultSchema)).nextCursor, undefined);
  await assert.rejects(client.request({ method: 'tools/call', params: { name: 'fixture_disconnect' } }, resultSchema), /not replayed/);
  await client.request({ method: 'tools/list' }, resultSchema);
  assert.equal(changed, 0); assert.equal(stderr, '');
  await client.close();
  const report = JSON.parse(await readFile(f.env.FIXTURE_REPORT, 'utf8')); assert.equal(report.calls, 4); assert.equal(report.initializes, 2);
  assert.deepEqual(report.clientNames, ['local-process-intelligence-bridge', 'local-process-intelligence-bridge']);
  assertRequestMarkers(report);
  for (const method of ['initialize', 'notifications/initialized', 'tools/list', 'tools/call'])
    assert.ok(report.requests.some(request => request.rpcMethod === method), method);
  const rpcRequests = report.requests.filter(request => ['tools/list', 'tools/call'].includes(request.rpcMethod));
  assert.ok(rpcRequests.every(request => Number.isInteger(request.rpcId)));
  assert.ok(new Set(rpcRequests.map(request => request.rpcId)).size > 1);
  assert.ok(report.requests.every(r => r.method === 'POST'));
  assert.equal(new Set(report.requests.map(r => r.session)).size, 1);
  await assert.rejects(access(f.configDir), { code: 'ENOENT' });
});
test('actual stdio cancellation leaves no replay and allows a separate reconnect', async t => {
  const f = await fixture(t), transport = new StdioClientTransport({ command: process.execPath,
    args: ['--import', pathToFileURL(path.join(root, 'tests', 'bundle-preload.mjs')).href, path.join(f.plugin, 'server', 'mcp.mjs')],
    env: f.env, cwd: f.temp, stderr: 'pipe' });
  const client = new Client({ name: 'fixture-client', version: '1' }); f.cleanup.push(() => client.close());
  await client.connect(transport); await client.request({ method: 'tools/list' }, resultSchema);
  const controller = new AbortController();
  const pending = client.request({ method: 'tools/call', params: { name: 'fixture_wait' } }, resultSchema,
    { signal: controller.signal, onprogress: () => controller.abort(), timeout: 10000 });
  await assert.rejects(pending);
  await client.request({ method: 'tools/list' }, resultSchema);
  await client.close(); const report = JSON.parse(await readFile(f.env.FIXTURE_REPORT, 'utf8'));
  assert.equal(report.calls, 1); assert.equal(report.initializes, 2);
  assertRequestMarkers(report);
  const call = report.requests.find(request => request.rpcMethod === 'tools/call');
  for (const request of report.requests.filter(request => request.rpcMethod === 'notifications/cancelled'))
    assert.equal(request.cancelRequestId, call.rpcId);
});
test('actual bundle exposes lifecycle/search guidance and forwards other tools unchanged', async t => {
  const f = await fixture(t);
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ['--import', pathToFileURL(path.join(root, 'tests', 'bundle-preload.mjs')).href, path.join(f.plugin, 'server', 'mcp.mjs')],
    env: { ...f.env, FIXTURE_CONTRACT_TOOLS: '1' }, cwd: f.temp, stderr: 'pipe' });
  const client = new Client({ name: 'fixture-contract-client', version: '1' });
  f.cleanup.push(() => client.close());
  let stderr = ''; transport.stderr.on('data', b => { stderr += b; });
  await client.connect(transport);
  assert.match(client.getInstructions(), /1800 seconds.*original submission/);
  assert.match(client.getInstructions(), /Never automatically resubmit/);
  assert.match(client.getInstructions(), /schemas take precedence/);
  for (const metricToSortBy of contractTools[2].inputSchema.properties.metricToSortBy.enum) {
    for (const sortOrder of ['Ascending', 'Descending']) {
      assert.deepEqual(await client.request({ method: 'tools/call', params: { name: 'get_cases_with_metrics_v2',
        arguments: { metricToSortBy, sortOrder } } }, resultSchema), richResult);
    }
  }
  const result = await client.request({ method: 'tools/list' }, resultSchema);
  assert.equal(result.tools.length, 4);
  assert.match(result.tools[0].description, /Never automatically resubmit/);
  assert.doesNotMatch(JSON.stringify(result.tools[1]), /functionNames/);
  assert.deepEqual(result.tools[2], contractTools[2]);
  assert.deepEqual(result.tools[3], richTool);
  await client.close();
  const report = JSON.parse(await readFile(f.env.FIXTURE_REPORT, 'utf8'));
  assert.equal(report.calls, 6); assert.equal(report.initializes, 1); assert.equal(stderr, '');
  assertRequestMarkers(report);
  await assert.rejects(access(f.configDir), { code: 'ENOENT' });
});
for (const json of ['0', '1']) test(`actual isolated bundle diagnostics uses POST-only ${json === '1' ? 'JSON' : 'SSE'} without business calls`, async t => {
  const f = await fixture(t);
  const output = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(root, 'tests', 'bundle-preload.mjs')).href,
    path.join(f.plugin, 'server', 'mcp.mjs'), 'diagnostics', '--profile', 'sample', '--remote', 'true'],
  { env: { ...f.env, FIXTURE_POST_JSON: json }, cwd: f.temp, encoding: 'utf8', timeout: 15000 });
  assert.equal(output.status, 0, output.stderr);
  assert.equal(output.stdout, '');
  assert.match(output.stderr, /MCP_TRANSPORT: post-only/);
  assert.match(output.stderr, /MCP_INITIALIZE_AND_LIST_OK/);
  const report = JSON.parse(await readFile(f.env.FIXTURE_REPORT, 'utf8'));
  assert.equal(report.calls, 0); assert.equal(report.initializes, 1);
  assert.equal(report.requests.length, 4);
  assertRequestMarkers(report);
  assert.deepEqual(report.requests.map(request => request.rpcMethod),
    ['initialize', 'notifications/initialized', 'tools/list', 'tools/list']);
  assert.ok(report.requests.every(r => r.method === 'POST'));
  await assert.rejects(access(f.configDir), { code: 'ENOENT' });
});
