// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as state from '../src/state.mjs';
import { run } from '../src/cli.mjs';
import { PassThrough } from 'node:stream';
import { sample, bound, FakeAz } from './helpers.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'pi-preference-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('profile preference stores only an explicit name and survives a new instance', async t => {
  assert.equal(typeof state.ProfilePreferences, 'function');
  const root = await fixture(t);
  const scope = state.preferenceScope({ name: 'copilot-cli', version: '1' }, root, {});
  const preferences = new state.ProfilePreferences(path.join(root, 'clients'), scope);
  assert.equal(await preferences.load(), null);
  await assert.rejects(fs.access(preferences.root), { code: 'ENOENT' });
  await preferences.save('chosen');
  assert.deepEqual(JSON.parse(await fs.readFile(preferences.file, 'utf8')), { profile: 'chosen' });
  assert.equal(await new state.ProfilePreferences(preferences.root, scope).load(), 'chosen');
  assert.deepEqual(await fs.readdir(preferences.root), [scope + '.json']);
});

test('preference scopes separate host installations and clients, not versions or sessions', async t => {
  assert.equal(typeof state.preferenceScope, 'function');
  const root = await fixture(t);
  const scope = (name, version, installation, env) =>
    state.preferenceScope({ name, version }, installation, env);
  const original = scope('copilot-cli', '1', root, { COPILOT_HOME: path.join(root, 'host-a') });
  assert.equal(scope('copilot-cli', '2', root, { COPILOT_HOME: path.join(root, 'host-a') }), original);
  for (const other of [
    scope('other-client', '1', root, {}),
    scope('copilot-cli', '1', path.join(root, 'other-install'), { COPILOT_HOME: path.join(root, 'host-a') }),
    scope('copilot-cli', '1', root, { COPILOT_HOME: path.join(root, 'host-b') })
  ]) assert.notEqual(other, original);
  assert.match(original, /^[0-9a-f]{64}$/);
});

test('invalid or linked preference fails explicitly and never supplies a different profile', async t => {
  assert.equal(typeof state.ProfilePreferences, 'function');
  const root = await fixture(t);
  const p = new state.ProfilePreferences(root, 'a'.repeat(64));
  for (const value of [{ profile: '../escape' }, { profile: 'valid', account: 'unwanted' }, {}, []]) {
    await fs.writeFile(p.file, JSON.stringify(value));
    await assert.rejects(p.load());
  }
  await p.save('repaired');
  assert.equal(await p.load(), 'repaired');
  const target = path.join(root, 'target.json');
  await fs.rename(p.file, target);
  await fs.link(target, p.file);
  await assert.rejects(p.load(), /hard link/);
  await assert.rejects(p.save('other'), /hard link/);
});

test('repeated unchanged config and silent binding preserve binding, revision and profile bytes', async t => {
  const root = await fixture(t);
  const store = new state.StateStore(root);
  await store.save(bound);
  const before = await fs.readFile(store.file('sample'), 'utf8');
  const cli = new FakeAz(), stdout = new PassThrough(), stderr = new PassThrough();
  const options = { store, cli, stdout, stderr, terminalAvailable: false };
  assert.equal(await run(['config', '--profile', 'sample', '--cloud', 'Public',
    '--tenant', sample.TenantId, '--environment', sample.EnvironmentId], options), 0);
  assert.equal(await fs.readFile(store.file('sample'), 'utf8'), before);
  assert.equal(await run(['login', '--profile', 'sample'], options), 0);
  assert.equal(await fs.readFile(store.file('sample'), 'utf8'), before);
  assert.equal(cli.calls.some(args => args[0] === 'login'), false);
  assert.equal(await run(['config', '--profile', 'sample', '--cloud', 'Public',
    '--tenant', sample.TenantId, '--environment', 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'], options), 0);
  assert.equal((await store.load('sample')).HomeAccountId, null);
  assert.notEqual(await fs.readFile(store.file('sample'), 'utf8'), before);
});

test('explicit config repairs malformed profile data while retaining structural file protections', async t => {
  const root = await fixture(t), store = new state.StateStore(root);
  for (const content of ['not-json', JSON.stringify({ ...bound, HomeAccountId: 'invalid' })]) {
    await fs.writeFile(store.file('sample'), content);
    await store.configure(sample);
    assert.equal((await store.load('sample')).HomeAccountId, null);
  }
  const target = path.join(root, 'target.json');
  await fs.rename(store.file('sample'), target);
  await fs.link(target, store.file('sample'));
  await assert.rejects(store.configure(sample), /hard link/);
});
