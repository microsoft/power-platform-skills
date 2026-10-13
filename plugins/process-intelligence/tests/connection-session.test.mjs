// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as sessions from '../src/connection-session.mjs';
import { createBridgeServer } from '../src/bridge.mjs';
import { StateStore } from '../src/state.mjs';
import { sample, bound, FakeAz, token } from './helpers.mjs';
import { FakeRemote, richTool, richResult } from './fake-remote.mjs';

const localNames = ['pi_connection_status', 'pi_activate_profile', 'pi_deactivate_profile'];
const activation = (profile = 'sample', remember = true) =>
  ({ name: 'pi_activate_profile', arguments: { profile, remember } });
const status = async session => (await session.call({ name: 'pi_connection_status' })).structuredContent;

async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'pi-session-'));
  const store = new StateStore(path.join(root, 'state'));
  const cli = new FakeAz(), remote = new FakeRemote();
  const options = { store, cli, installationRoot: root, env: {}, fetchImpl: req => remote.fetch(req), ...overrides };
  const session = new sessions.ConnectionSession(options);
  let changed = 0;
  session.toolsChanged = async () => { changed++; };
  await session.initialize({ name: 'fixture-client', version: '1' });
  t.after(async () => { await session.close(); await remote.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, store, cli, remote, session, options, get changed() { return changed; } };
}

test('unconfigured local MCP initializes and lists recovery tools with no credentials or HTTP', async t => {
  const f = await fixture(t);
  const client = new Client({ name: 'fixture-client', version: '1' });
  const server = createBridgeServer(f.session);
  const [local, peer] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(local); await client.connect(peer);
  assert.equal(client.getServerCapabilities().tools.listChanged, true);
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), localNames);
  assert.equal((await status(f.session)).state, 'setup-required');
  assert.deepEqual(f.cli.calls, []);
  assert.equal(f.remote.requests.length, 0);
  await assert.rejects(fs.access(f.store.root), { code: 'ENOENT' });
});

test('activation publishes the dynamic catalog, preserves remote pages/results and is idempotent', async t => {
  const f = await fixture(t); await f.store.save(bound);
  const result = await f.session.call(activation());
  assert.equal(result.structuredContent.state, 'active');
  assert.equal(f.changed, 1);
  const first = await f.session.list({ _meta: { fixture: 'list' } });
  assert.deepEqual(first.tools, [...sessions.CONNECTION_TOOLS, richTool]);
  assert.equal(first.nextCursor, 'upstream-cursor');
  assert.deepEqual(first._meta, { fixture: 'page' });
  const second = await f.session.list({ cursor: first.nextCursor });
  assert.deepEqual(second.tools, f.remote.tools);
  const args = { name: richTool.name, arguments: { value: null }, _meta: { fixture: 'call' } };
  assert.deepEqual(await f.session.call(args), richResult);
  assert.deepEqual(f.remote.requests.find(r => r.message.method === 'tools/call').message.params, args);
  const previous = await fs.readFile(f.store.file('sample'), 'utf8');
  await f.session.call(activation());
  assert.equal(f.changed, 1);
  assert.equal(f.remote.initializations, 1);
  assert.equal(await fs.readFile(f.store.file('sample'), 'utf8'), previous);
  assert.equal(f.cli.calls.some(args => args[0] === 'login'), false);
  assert.equal(f.remote.getRequests.length, 0);
});

test('remembered selection survives new sessions, explicit launch wins and active sessions never retarget', async t => {
  const f = await fixture(t); await f.store.save(bound);
  await f.session.call(activation());
  await f.store.save({ ...bound, Name: 'second', EnvironmentId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff' });
  const second = new sessions.ConnectionSession({ ...f.options, profileName: 'second' });
  const fresh = new sessions.ConnectionSession(f.options);
  const explicitMissing = new sessions.ConnectionSession({ ...f.options, profileName: 'missing' });
  t.after(async () => { await second.close(); await fresh.close(); await explicitMissing.close(); });
  await second.initialize({ name: 'fixture-client', version: '2' });
  assert.equal((await status(second)).profile, 'second');
  await second.call(activation('second'));
  assert.equal((await status(f.session)).profile, 'sample');
  await fresh.initialize({ name: 'fixture-client', version: '3' });
  assert.equal((await status(fresh)).profile, 'second');
  await explicitMissing.initialize({ name: 'fixture-client', version: '1' });
  assert.equal((await status(explicitMissing)).errorCode, 'PROFILE_MISSING');
  assert.deepEqual((await explicitMissing.list()).tools.map(t => t.name), localNames);
});

test('invalid, unbound and wrong-account activations leave recovery available without preference changes', async t => {
  const f = await fixture(t);
  await f.store.save(sample);
  await assert.rejects(f.session.call(activation('../escape')));
  await assert.rejects(f.session.call(activation()), error => error.errorCode === 'LOGIN_REQUIRED');
  assert.equal(f.cli.calls.length, 0);
  assert.equal(f.remote.requests.length, 0);
  await f.store.save(bound);
  f.cli.tokenOutput = token({ oid: '44444444-4444-4444-4444-444444444444' });
  await assert.rejects(f.session.call(activation()), error => error.errorCode === 'ACCOUNT_CHANGED');
  assert.equal((await status(f.session)).state, 'recovery-required');
  assert.equal(f.remote.requests.length, 0);
  assert.deepEqual((await f.session.list()).tools.map(t => t.name), localNames);
  assert.equal(await f.session.preferences.load(), null);
});

test('revision invalidation cancels an in-flight tool, removes remote tools and requires explicit recovery', async t => {
  const f = await fixture(t); await f.store.save(bound); await f.session.call(activation());
  const started = Promise.withResolvers();
  f.remote.duringCall = async () => { started.resolve(); await delay(1000); };
  const pending = f.session.call({ name: richTool.name }).then(() => assert.fail('stale call succeeded'), error => error);
  await started.promise;
  await f.store.save(sample);
  const error = await pending;
  assert.equal(error.errorCode, 'PROFILE_CHANGED');
  assert.equal((await status(f.session)).state, 'recovery-required');
  assert.deepEqual((await f.session.list()).tools.map(t => t.name), localNames);
  assert.equal(f.remote.calls, 1);
  assert.equal(f.changed, 2);
  await f.store.save(bound);
  assert.deepEqual((await f.session.list()).tools.map(t => t.name), localNames);
  f.remote.duringCall = null;
  await f.session.call(activation());
  assert.equal((await status(f.session)).state, 'active');
});

test('cancelled activation before preference publication never remembers or publishes the candidate', async t => {
  const f = await fixture(t); await f.store.save(bound);
  const started = Promise.withResolvers(), controller = new AbortController();
  f.remote.duringList = async () => { started.resolve(); await delay(300); };
  const pending = f.session.call(activation(), controller.signal);
  await started.promise; controller.abort();
  await assert.rejects(pending);
  assert.equal(await f.session.preferences.load(), null);
  assert.deepEqual((await f.session.list()).tools.map(t => t.name), localNames);
});

test('local and remote name collisions fail closed while retaining local recovery', async t => {
  const f = await fixture(t); await f.store.save(bound);
  f.remote.tools = [{ ...richTool, name: localNames[0] }];
  await assert.rejects(f.session.call(activation()), error => error.errorCode === 'TOOL_NAME_CONFLICT');
  assert.equal((await status(f.session)).errorCode, 'TOOL_NAME_CONFLICT');
  assert.deepEqual((await f.session.list()).tools.map(t => t.name), localNames);
});

test('explicit activation reloads a newly bound revision immediately without waiting for the monitor', async t => {
  const f = await fixture(t); await f.store.save(bound); await f.session.call(activation());
  await f.store.save(bound);
  await f.session.call(activation());
  assert.equal((await status(f.session)).state, 'active');
  assert.equal(f.remote.initializations, 2);
});

test('a queued activation cannot let a cancelled old request invalidate the replacement connection', async t => {
  const f = await fixture(t); await f.store.save(bound); await f.session.call(activation());
  await f.store.save({ ...bound, Name: 'second', EnvironmentId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff' });
  const started = Promise.withResolvers();
  f.remote.duringCall = async () => { started.resolve(); await delay(500); };
  const old = f.session.call({ name: richTool.name }).then(() => assert.fail('old call succeeded'), error => error);
  await started.promise;
  await f.session.call(activation('second', false));
  await old;
  assert.equal((await status(f.session)).profile, 'second');
  assert.equal((await status(f.session)).state, 'active');
  assert.equal(await f.session.preferences.load(), 'sample');
  assert.equal(f.remote.calls, 1);
  f.remote.duringCall = null;
  assert.deepEqual(await f.session.call({ name: richTool.name }), richResult);
});

test('deactivation retains the preference but removes remote tools without logging out', async t => {
  const f = await fixture(t); await f.store.save(bound); await f.session.call(activation());
  const before = await fs.readFile(f.store.file('sample'), 'utf8');
  await f.session.call({ name: 'pi_deactivate_profile' });
  assert.equal((await status(f.session)).state, 'inactive');
  assert.deepEqual((await f.session.list()).tools.map(t => t.name), localNames);
  assert.equal(await f.session.preferences.load(), 'sample');
  assert.equal(await fs.readFile(f.store.file('sample'), 'utf8'), before);
  await assert.rejects(f.session.call({ name: richTool.name }), error => error.errorCode === 'CONNECTION_INACTIVE');
  assert.equal(f.cli.calls.some(args => ['login', 'logout'].includes(args[0])), false);
});

test('malformed preferences and revoked synthetic credentials expose actionable local status', async t => {
  const f = await fixture(t); await f.store.save(bound); await f.session.call(activation());
  f.cli.tokenError = 'AADSTS50173 synthetic revoked credential';
  const fresh = new sessions.ConnectionSession(f.options);
  t.after(() => fresh.close());
  await fresh.initialize({ name: 'fixture-client', version: '1' });
  assert.equal((await status(fresh)).errorCode, 'AADSTS_FAILURE');
  assert.deepEqual((await fresh.list()).tools.map(t => t.name), localNames);
  const before = f.remote.requests.length;
  await fs.writeFile(f.session.preferences.file, '{"profile":"../invalid"}');
  const broken = new sessions.ConnectionSession(f.options);
  t.after(() => broken.close());
  await broken.initialize({ name: 'fixture-client', version: '1' });
  assert.equal((await status(broken)).state, 'recovery-required');
  assert.equal(f.remote.requests.length, before);
  f.cli.tokenError = undefined;
  await broken.call(activation());
  assert.equal(await broken.preferences.load(), 'sample');
});

for (const alreadyActive of [false, true]) test(`shutdown during ${alreadyActive ? 'repeated' : 'initial'} activation cannot publish a late active context`, async t => {
  const f = await fixture(t); await f.store.save(bound);
  if (alreadyActive) await f.session.call(activation());
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  const save = f.session.preferences.save.bind(f.session.preferences);
  f.session.preferences.save = async name => {
    started.resolve();
    await release.promise;
    await save(name);
  };
  const pending = f.session.call(activation());
  await started.promise;
  await f.session.close();
  release.resolve();
  await assert.rejects(pending);
  assert.deepEqual((await f.session.list()).tools.map(tool => tool.name), localNames);
  assert.equal(f.changed, alreadyActive ? 1 : 0);
});

test('cancellation during the final revision check cannot return a stale remote result', async t => {
  const f = await fixture(t); await f.store.save(bound); await f.session.call(activation());
  const controller = new AbortController();
  const ensureCurrent = f.store.ensureCurrent.bind(f.store);
  let resultReceived = false;
  // Mark the completed synthetic tools/call response, not token or connect checks.
  f.remote.duringCall = async () => { resultReceived = true; };
  f.store.ensureCurrent = async selected => {
    await ensureCurrent(selected);
    if (resultReceived) controller.abort();
  };
  await assert.rejects(f.session.call({ name: richTool.name }, controller.signal));
  assert.equal(f.remote.calls, 1);
});
