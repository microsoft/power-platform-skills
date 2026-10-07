// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtemp, realpath, readFile, writeFile, readdir, rm, stat, symlink, link, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { StateStore, defaultStateRoot } from '../src/state.mjs';
import { sample, bound, claim, assertProfileBytes } from './helpers.mjs';
async function store(t) {
  const parent = await mkdtemp(path.join(await realpath(os.tmpdir()), 'pm-state-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  return new StateStore(path.join(parent, 'private'));
}
test('platform state paths use the new Process Intelligence store', () => {
  assert.equal(defaultStateRoot('win32', { LOCALAPPDATA: 'C:\\Users\\fixture\\AppData\\Local' }, 'C:\\Users\\fixture'),
    'C:\\Users\\fixture\\AppData\\Local\\ProcessIntelligenceBridgeAzureCli');
  assert.equal(defaultStateRoot('darwin', {}, '/home/fixture'), '/home/fixture/Library/Application Support/ProcessIntelligenceBridgeAzureCli');
  assert.equal(defaultStateRoot('linux', {}, '/home/fixture'), '/home/fixture/.local/share/ProcessIntelligenceBridgeAzureCli');
  assert.equal(defaultStateRoot('linux', { XDG_DATA_HOME: '/private-data' }, '/home/fixture'), '/private-data/ProcessIntelligenceBridgeAzureCli');
});
test('old PascalCase profile and persistent .NET lock remain compatible', async t => {
  const s = await store(t); await s.prepare();
  await writeFile(path.join(s.root, 'sample.json'), JSON.stringify({ ...bound, Revision: 'legacy-revision' }));
  await writeFile(path.join(s.root, 'sample.lock'), '');
  const old = await s.load('sample'); assert.equal(old.HomeAccountId, bound.HomeAccountId);
  const next = await s.save(old, old.Revision); assert.notEqual(next.Revision, old.Revision);
  assert.equal(await readFile(path.join(s.root, 'sample.lock'), 'utf8'), '');
  assert.deepEqual(Object.keys(JSON.parse(await readFile(path.join(s.root, 'sample.json'), 'utf8'))), Object.keys(next));
});
test('atomic revision guards and private permissions', async t => {
  const s = await store(t), first = await s.save(sample);
  await s.ensureCurrent(first);
  const next = await s.save({ ...first, HomeAccountId: bound.HomeAccountId }, first.Revision);
  assertProfileBytes(await readFile(s.file('sample'), 'utf8'), bound.HomeAccountId);
  await assert.rejects(s.ensureCurrent(first), /changed/);
  await assert.rejects(s.save(first, first.Revision), /changed/);
  assert.equal((await s.load('sample')).Revision, next.Revision);
  assert.equal((await readdir(s.root)).some(f => /\.tmp|node-lock/.test(f)), false);
  await s.verifyPrivate();
  if (process.platform !== 'win32') {
    assert.equal((await stat(s.root)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(s.root, 'sample.json'))).mode & 0o777, 0o600);
  }
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
test('revision-bound challenges survive and stale login cannot erase newer challenge', async t => {
  const s = await store(t), first = await s.save(sample);
  await s.saveChallenge(first, claim); assert.equal(await s.loadChallenge(first), claim);
  const next = await s.save({ ...first, ...bound }, first.Revision);
  assert.equal(await s.loadChallenge(next), null);
  await s.saveChallenge(next, claim);
  await assert.rejects(s.save(first, first.Revision), { errorCode: 'PROFILE_CHANGED' });
  await assert.rejects(s.saveChallenge(first, claim), { errorCode: 'PROFILE_CHANGED' });
  assert.equal(await s.loadChallenge(next), claim);
  const current = await s.save(next, next.Revision);
  assert.equal(await s.loadChallenge(current), null);
  await assert.rejects(s.saveChallenge(next, '{}'));
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

test('profile revision changes remove current and legacy unusable challenges without parsing their contents', async t => {
  const s = await store(t);
  let selected = await s.save(bound);
  const file = s.file('sample', '.challenge.json');
  for (const pending of [
    JSON.stringify({ Revision: selected.Revision, Claims: claim }),
    JSON.stringify({ Revision: 'older-revision', Claims: claim }),
    '{"Revision":"older-revision","Claims":',
    'null',
    JSON.stringify({ Claims: 'unusable-private-content' }),
    'x'.repeat(65537)
  ]) {
    await writeFile(file, pending);
    selected = await s.save(selected, selected.Revision);
    await assert.rejects(readFile(file), { code: 'ENOENT' });
  }
});

test('first configuration removes an orphan challenge only for that exact profile', async t => {
  const s = await store(t);
  const other = await s.save({ ...bound, Name: 'another' });
  await s.saveChallenge(other, claim);
  const otherProfile = await readFile(s.file('another'));
  const otherChallenge = await readFile(s.file('another', '.challenge.json'));
  await writeFile(s.file('sample', '.challenge.json'), 'old unusable state');
  await writeFile(s.file('sample', '.lock'), 'legacy lock');
  await s.save(sample);
  await assert.rejects(readFile(s.file('sample', '.challenge.json')), { code: 'ENOENT' });
  assert.deepEqual(await readFile(s.file('another')), otherProfile);
  assert.deepEqual(await readFile(s.file('another', '.challenge.json')), otherChallenge);
  assert.equal(await readFile(s.file('sample', '.lock'), 'utf8'), 'legacy lock');
});

test('challenge cleanup occurs after profile publication but before releasing its mutation lock', async t => {
  const s = await store(t);
  const selected = await s.save(bound);
  await s.saveChallenge(selected, claim);
  const another = await s.save({ ...bound, Name: 'another' });
  const contender = new StateStore(s.root);
  await contender.prepare();
  const unlink = fs.unlink;
  let observed = false;
  t.mock.method(fs, 'unlink', async file => {
    if (file === s.file('sample', '.challenge.json')) {
      observed = true;
      const current = await s.load('sample');
      assert.notEqual(current.Revision, selected.Revision);
      await assert.rejects(contender.saveChallenge(current, claim), { errorCode: 'STATE_LOCKED' });
      await contender.saveChallenge(another, claim);
    }
    return unlink(file);
  });
  await s.save(selected, selected.Revision);
  assert.equal(observed, true);
  assert.equal(await s.loadChallenge(another), claim);
});

test('failed profile publication retains the required challenge and releases the lock', async t => {
  const s = await store(t);
  const selected = await s.save(bound);
  await s.saveChallenge(selected, claim);
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === s.file('sample')) throw Object.assign(new Error('synthetic failure'), { code: 'EACCES' });
    return rename(from, to);
  });
  await assert.rejects(s.save(selected, selected.Revision), { code: 'EACCES' });
  assert.deepEqual(await s.load('sample'), selected);
  assert.equal(await s.loadChallenge(selected), claim);
  await assert.rejects(readFile(s.file('sample', '.node-lock')), { code: 'ENOENT' });
});

test('cleanup failures are explicit and can be retried without exposing private file content', async t => {
  const s = await store(t);
  const selected = await s.save(bound);
  const file = s.file('sample', '.challenge.json');
  await s.saveChallenge(selected, claim);
  const unlink = fs.unlink;
  const denied = t.mock.method(fs, 'unlink', async target => {
    if (target === file) throw Object.assign(new Error('private-path private-claims'), { code: 'EACCES' });
    return unlink(target);
  });
  await assert.rejects(s.save(selected, selected.Revision), error => {
    assert.equal(error.errorCode, 'STATE_ACCESS_DENIED');
    assert.match(error.message, /saved.*cleanup failed/i);
    assert.doesNotMatch(error.message, /private-path|private-claims/);
    return true;
  });
  const current = await s.load('sample');
  assert.notEqual(current.Revision, selected.Revision);
  assert.equal(await s.loadChallenge(current), null);
  assert.ok(await readFile(file));
  await assert.rejects(readFile(s.file('sample', '.node-lock')), { code: 'ENOENT' });
  denied.mock.restore();
  await s.save(current, current.Revision);
  await assert.rejects(readFile(file), { code: 'ENOENT' });
});

test('cleanup rejects linked and non-file challenges without deleting their targets', async t => {
  const s = await store(t);
  const sentinel = path.join(path.dirname(s.root), 'untouched.json');
  await writeFile(sentinel, 'private-other-file');
  for (const kind of ['hardlink', 'directory', 'junction']) {
    const name = kind;
    const selected = await s.save({ ...bound, Name: name });
    const file = s.file(name, '.challenge.json');
    if (kind === 'hardlink') await link(sentinel, file);
    else if (kind === 'directory') await mkdir(file);
    else await symlink(path.dirname(s.root), file, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(s.save(selected, selected.Revision), { errorCode: 'STATE_ACCESS_DENIED' });
    assert.equal(await readFile(sentinel, 'utf8'), 'private-other-file');
    assert.ok(await fs.lstat(file));
    await assert.rejects(readFile(s.file(name, '.node-lock')), { code: 'ENOENT' });
  }
});
