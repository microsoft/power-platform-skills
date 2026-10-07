// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtemp, realpath, readFile, writeFile, readdir, rm, stat, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { StateStore, defaultStateRoot } from '../src/state.mjs';
import { sample, bound, assertProfileBytes } from './helpers.mjs';
async function store(t) {
  const parent = await mkdtemp(path.join(await realpath(os.tmpdir()), 'pm-state-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  return new StateStore(path.join(parent, 'profiles'));
}

test('cold profile reads do not prepare directories or change missing-state behavior', async t => {
  const s = await store(t);
  await assert.rejects(s.load('sample'), { errorCode: 'PROFILE_MISSING' });
  await assert.rejects(stat(s.root), { code: 'ENOENT' });
  const selected = await s.save(bound);
  const cold = new StateStore(s.root);
  t.mock.method(cold, 'prepare', () => assert.fail('Reading a profile must not prepare its directory'));
  assert.deepEqual(await cold.load('sample'), selected);
});

test('platform state paths stay in the designated per-user data locations', () => {
  assert.equal(defaultStateRoot('win32', { LOCALAPPDATA: 'C:\\Users\\fixture\\AppData\\Local' }, 'C:\\Users\\fixture'),
    'C:\\Users\\fixture\\AppData\\Local\\ProcessIntelligenceBridgeAzureCli');
  assert.equal(defaultStateRoot('darwin', {}, '/home/fixture'), '/home/fixture/Library/Application Support/ProcessIntelligenceBridgeAzureCli');
  assert.equal(defaultStateRoot('linux', {}, '/home/fixture'), '/home/fixture/.local/share/ProcessIntelligenceBridgeAzureCli');
  assert.equal(defaultStateRoot('linux', { XDG_DATA_HOME: '/user-data' }, '/home/fixture'), '/user-data/ProcessIntelligenceBridgeAzureCli');
  assert.equal(defaultStateRoot('linux', { XDG_DATA_HOME: 'relative' }, '/home/fixture'),
    '/home/fixture/.local/share/ProcessIntelligenceBridgeAzureCli');
  assert.throws(() => defaultStateRoot('win32', { LOCALAPPDATA: 'relative' }, 'C:\\Users\\fixture'));
  assert.throws(() => defaultStateRoot('linux', {}, 'relative'));
});

test('atomic profile publication keeps revision guards and removes temporary files', async t => {
  const s = await store(t), first = await s.save(sample);
  await s.ensureCurrent(first);
  const next = await s.save({ ...first, HomeAccountId: bound.HomeAccountId }, first.Revision);
  assertProfileBytes(await readFile(s.file('sample'), 'utf8'), bound.HomeAccountId);
  await assert.rejects(s.ensureCurrent(first), /changed/);
  await assert.rejects(s.save(first, first.Revision), /changed/);
  assert.equal((await s.load('sample')).Revision, next.Revision);
  assert.deepEqual(await readdir(s.root), ['sample.json']);
});

test('exclusive Node lock, stale-owner diagnosis, no destructive stale recovery', async t => {
  const s = await store(t); await s.save(sample);
  let release, entered;
  const entry = new Promise(resolve => { entered = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  const mutation = s.withLock('sample', async () => { entered(); await hold; });
  await entry;
  await assert.rejects(new StateStore(s.root).save(sample), /Another Node/);
  release(); await mutation;
  const file = path.join(s.root, 'sample.node-lock');
  await writeFile(file, JSON.stringify({ pid: 2147483647, nonce: 'fixture' }));
  await assert.rejects(s.save(sample), /Stale Node/);
  assert.equal(JSON.parse(await readFile(file)).nonce, 'fixture');
});

test('traversal, missing/invalid JSON and links fail explicitly', async t => {
  const s = await store(t); await s.prepare();
  await assert.rejects(s.load('../escape')); await assert.rejects(s.load('missing'), /not configured/);
  await writeFile(path.join(s.root, 'sample.json'), 'not-json');
  await assert.rejects(s.load('sample'), /invalid/);
  const linked = new StateStore(path.join(path.dirname(s.root), 'linked'));
  await symlink(s.root, linked.root, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(linked.prepare(), /link|reparse/);
});

test('profile mutations affect only the selected profile', async t => {
  const s = await store(t);
  const another = await s.save({ ...bound, Name: 'another' });
  const otherBytes = await readFile(s.file('another'));
  const selected = await s.save(bound);
  await s.save({ ...selected, HomeAccountId: null }, selected.Revision);
  assert.deepEqual(await readFile(s.file('another')), otherBytes);
  assert.deepEqual(await s.load('another'), another);
  assert.deepEqual(await readdir(s.root), ['another.json', 'sample.json']);
});

test('failed publication preserves the profile and releases the mutation lock', async t => {
  const s = await store(t);
  const selected = await s.save(bound);
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === s.file('sample')) throw Object.assign(new Error('synthetic failure'), { code: 'EACCES' });
    return rename(from, to);
  });
  await assert.rejects(s.save(selected, selected.Revision), { code: 'EACCES' });
  assert.deepEqual(await s.load('sample'), selected);
  assert.deepEqual(await readdir(s.root), ['sample.json']);
});
