// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { PrivateDirectory, readJson } from '../src/private-files.mjs';
import { StateStore } from '../src/state.mjs';
import { bound } from './helpers.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'pi-state-files-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

for (const platform of ['win32', 'darwin', 'linux']) {
  test(`state operations use standard filesystem APIs on ${platform}`, async t => {
    const root = await fixture(t);
    const previous = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { ...previous, value: platform });
    t.after(() => Object.defineProperty(process, 'platform', previous));
    const spawn = t.mock.method(childProcess, 'spawn', () => assert.fail('No state subprocess is permitted'));
    syncBuiltinESMExports();
    t.after(() => { spawn.mock.restore(); syncBuiltinESMExports(); });
    for (const operation of ['chmod', 'chown']) {
      t.mock.method(fs, operation, () => assert.fail('State permissions must not be rewritten'));
    }
    const mkdir = fs.mkdir;
    const open = fs.open;
    t.mock.method(fs, 'mkdir', async (file, options) => {
      assert.equal(options?.mode, undefined, 'Directory creation must use OS defaults');
      return mkdir(file, options);
    });
    t.mock.method(fs, 'open', async (file, flags, mode) => {
      assert.equal(mode, undefined, 'Profile, temporary and lock files must use OS defaults');
      const handle = await open(file, flags, mode);
      if (previous.value === 'win32' && platform !== 'win32' &&
          file === path.join(root, 'profiles') && flags === 'r') {
        // Windows cannot fsync a directory. Model that Unix-only capability
        // here; native Unix runs still exercise the real directory fsync.
        t.mock.method(handle, 'sync', async () => {});
      }
      return handle;
    });
    const store = new StateStore(path.join(root, 'profiles'));
    const selected = await store.save(bound);
    assert.deepEqual(await new StateStore(store.root).load('sample'), selected);
    await store.save(selected, selected.Revision);
    assert.deepEqual(await fs.readdir(store.root), ['sample.json']);
    assert.equal(spawn.mock.callCount(), 0);
  });
}

test('native state creation matches ordinary filesystem defaults and preserves existing directory permissions', async t => {
  const root = await fixture(t);
  const control = path.join(root, 'ordinary');
  await fs.mkdir(control);
  await fs.writeFile(path.join(control, 'file.json'), '{}');
  const store = new StateStore(path.join(root, 'profiles'));
  const selected = await store.save(bound);
  assert.deepEqual(await store.load('sample'), selected);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(store.root)).mode & 0o777, (await fs.stat(control)).mode & 0o777);
    assert.equal((await fs.stat(store.file('sample'))).mode & 0o777,
      (await fs.stat(path.join(control, 'file.json'))).mode & 0o777);
    await fs.chmod(store.root, 0o775);
    await fs.chmod(store.file('sample'), 0o664);
    const cold = new StateStore(store.root);
    assert.deepEqual(await cold.load('sample'), selected);
    await cold.prepare();
    assert.equal((await fs.stat(store.root)).mode & 0o777, 0o775);
    assert.equal((await fs.stat(store.file('sample'))).mode & 0o777, 0o664);
  }
});

test('directory preparation honors cancellation and rejects non-directory paths', async t => {
  const root = await fixture(t);
  const cancelled = new PrivateDirectory(path.join(root, 'cancelled'));
  await assert.rejects(cancelled.prepare({ signal: AbortSignal.abort() }), { name: 'AbortError' });
  await assert.rejects(fs.stat(cancelled.root), { code: 'ENOENT' });
  const file = path.join(root, 'file');
  await fs.writeFile(file, 'unchanged');
  await assert.rejects(new PrivateDirectory(file).prepare());
  assert.equal(await fs.readFile(file, 'utf8'), 'unchanged');
});

test('profile readers retain regular-file, size and hard-link checks', async t => {
  const root = await fixture(t);
  const file = path.join(root, 'profile.json');
  await fs.writeFile(file, '{"Name":"sample"}');
  assert.deepEqual(await readJson(file), { Name: 'sample' });
  const linked = path.join(root, 'linked.json');
  await fs.link(file, linked);
  await assert.rejects(readJson(linked), { errorCode: 'STATE_ACCESS_DENIED' });
  await fs.unlink(linked);
  await fs.writeFile(file, 'x'.repeat(65537));
  await assert.rejects(readJson(file), { errorCode: 'STATE_INVALID' });
  await assert.rejects(readJson(root), { errorCode: 'STATE_INVALID' });
});
