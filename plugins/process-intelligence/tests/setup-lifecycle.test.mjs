// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { run } from '../src/cli.mjs';
import { ConnectionSession } from '../src/connection-session.mjs';
import { StateStore } from '../src/state.mjs';
import { sample, FakeAz } from './helpers.mjs';
import { FakeRemote } from './fake-remote.mjs';

const plugin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
test('setup directs agent binding and native activation after integration confirmation, not parent environment edits', async () => {
  const skill = await fs.readFile(path.join(plugin, 'skills', 'setup', 'SKILL.md'), 'utf8');
  assert.match(skill, /agent.*run.*login --profile work/i);
  assert.match(skill, /pi_activate_profile/);
  assert.match(skill, /pi_connection_status/);
  assert.match(skill, /remember/);
  assert.ok(skill.indexOf('explicit instruction') < skill.indexOf('pi_activate_profile'));
  assert.doesNotMatch(skill, /Ask the user to run `node|Set `PM_BRIDGE_PROFILE|then restart MCP|config, login and restart/);
});

test('synthetic approved setup trace binds without TTY, activates in place and reuses the selection', async t => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'pi-setup-trace-'));
  const store = new StateStore(path.join(root, 'state')), cli = new FakeAz(), remote = new FakeRemote();
  const options = { store, cli, installationRoot: root, env: {}, fetchImpl: req => remote.fetch(req) };
  const session = new ConnectionSession(options);
  const trace = [];
  t.after(async () => { await session.close(); await remote.close(); await fs.rm(root, { recursive: true, force: true }); });
  await session.initialize({ name: 'setup-fixture', version: '1' });
  trace.push((await session.call({ name: 'pi_connection_status' })).structuredContent.state);
  assert.equal(cli.calls.length, 0); assert.equal(remote.requests.length, 0);
  trace.push('explicit-host-environment-integration-confirmed');
  const shell = { store, cli, terminalAvailable: false, stdout: new PassThrough(), stderr: new PassThrough() };
  assert.equal(await run(['config', '--profile', 'work', '--cloud', 'Public',
    '--tenant', sample.TenantId, '--environment', sample.EnvironmentId], shell), 0);
  trace.push('offline-config');
  assert.equal(cli.calls.length, 0);
  assert.equal(await run(['login', '--profile', 'work'], shell), 0);
  trace.push('silent-binding');
  await session.call({ name: 'pi_activate_profile', arguments: { profile: 'work' } });
  trace.push((await session.call({ name: 'pi_connection_status' })).structuredContent.state);
  assert.ok((await session.list()).tools.some(tool => tool.name === 'fixture_query'));
  const next = new ConnectionSession(options);
  t.after(() => next.close());
  await next.initialize({ name: 'setup-fixture', version: '2' });
  trace.push((await next.call({ name: 'pi_connection_status' })).structuredContent.state);
  assert.deepEqual(trace, ['setup-required', 'explicit-host-environment-integration-confirmed',
    'offline-config', 'silent-binding', 'active', 'active']);
  assert.equal(cli.calls.some(args => args[0] === 'login'), false);
  assert.equal(remote.calls, 0);
});
