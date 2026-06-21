'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  storeRoot, runDir, createRunStore, writeArtifact, readArtifact,
  secureWipeRun, reapStaleRuns, scanForSecrets,
} = require('../lib/merge-artifact-store');

function uid() { return 'test-' + crypto.randomUUID(); }
const crypto = require('node:crypto');

test('storeRoot is under the OS temp dir (not the project/session tree)', () => {
  assert.ok(storeRoot().startsWith(os.tmpdir()));
  assert.match(storeRoot(), /pp-merge$/);
});

test('runId must be path-safe', () => {
  assert.throws(() => runDir('a/b'), /path-safe/);
  assert.throws(() => runDir('a\\b'), /path-safe/);
  assert.throws(() => runDir(''), /path-safe/);
});

test('createRunStore makes an owner-only dir; write/read round-trips (plaintext)', () => {
  const id = uid();
  const store = createRunStore(id);
  try {
    assert.equal(store.encrypted, false);
    assert.equal(store.key, null);
    writeArtifact(store, 'units/x/ours.txt', 'hello\r\nworld');
    assert.equal(readArtifact(store, 'units/x/ours.txt'), 'hello\r\nworld');
    // dir exists under temp root
    assert.ok(fs.existsSync(store.dir));
    assert.ok(store.dir.startsWith(storeRoot()));
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(store.dir).mode & 0o777, 0o700);
      assert.equal(fs.statSync(path.join(store.dir, 'units/x/ours.txt')).mode & 0o777, 0o600);
    }
  } finally { secureWipeRun(id); }
});

test('encryption at rest: ciphertext on disk, plaintext via readArtifact', () => {
  const id = uid();
  const store = createRunStore(id, { encrypt: true });
  try {
    assert.equal(store.encrypted, true);
    assert.ok(Buffer.isBuffer(store.key) && store.key.length === 32);
    const secret = 'TOP-SECRET-LIQUID {{ x }}';
    writeArtifact(store, 'result.txt', secret);
    const onDisk = fs.readFileSync(path.join(store.dir, 'result.txt'));
    assert.ok(!onDisk.toString('utf8').includes('TOP-SECRET'), 'on-disk bytes must be ciphertext');
    assert.equal(onDisk.subarray(0, 4).toString(), 'PPM1', 'has the encrypted-file magic header');
    assert.equal(readArtifact(store, 'result.txt'), secret, 'decrypts via the in-memory key');
  } finally { secureWipeRun(id); }
});

test('encrypted artifact is unreadable without the key (wrong/no key)', () => {
  const id = uid();
  const store = createRunStore(id, { encrypt: true });
  try {
    writeArtifact(store, 'a.txt', 'plain');
    // simulate another process with no key
    const noKey = { dir: store.dir, key: null };
    const raw = readArtifact(noKey, 'a.txt');
    assert.notEqual(raw, 'plain'); // returns the raw ciphertext, not the secret
    // wrong key throws (auth tag mismatch) — guard it
    const wrong = { dir: store.dir, key: crypto.randomBytes(32) };
    assert.throws(() => readArtifact(wrong, 'a.txt'));
  } finally { secureWipeRun(id); }
});

test('path traversal is rejected', () => {
  const id = uid();
  const store = createRunStore(id);
  try {
    assert.throws(() => writeArtifact(store, '../escape.txt', 'x'), /escapes/);
    assert.throws(() => writeArtifact(store, '../../etc/passwd', 'x'), /escapes/);
  } finally { secureWipeRun(id); }
});

test('secureWipeRun overwrites + removes everything; readArtifact then null', () => {
  const id = uid();
  const store = createRunStore(id);
  writeArtifact(store, 'units/x/base.txt', 'aaaa');
  writeArtifact(store, 'units/x/result.txt', 'bbbb');
  const dir = store.dir;
  const r = secureWipeRun(id);
  assert.equal(r.wiped, true);
  assert.ok(r.files >= 2);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(readArtifact(store, 'units/x/base.txt'), null);
});

test('secureWipeRun is safe on a non-existent run (idempotent)', () => {
  const r = secureWipeRun('test-does-not-exist-' + Date.now());
  assert.equal(r.wiped, true);
});

test('reapStaleRuns removes only dirs older than the TTL', () => {
  const fresh = uid();
  const stale = uid();
  createRunStore(fresh);
  const staleStore = createRunStore(stale);
  // age the stale dir well past the TTL
  const old = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(staleStore.dir, old, old);
  try {
    const { reaped } = reapStaleRuns({ ttlMs: 60 * 1000 }); // 1 min TTL
    assert.ok(reaped.includes(stale), 'stale run reaped');
    assert.ok(!reaped.includes(fresh), 'fresh run kept');
    assert.equal(fs.existsSync(staleStore.dir), false);
  } finally { secureWipeRun(fresh); secureWipeRun(stale); }
});

test('scanForSecrets flags common credential patterns; clean content returns []', () => {
  assert.deepEqual(scanForSecrets('{% extends "Layout" %}\n<div>hi</div>'), []);
  assert.ok(scanForSecrets('password=SuperSecret123;').includes('connection-string-password'));
  assert.ok(scanForSecrets('client_secret: "abcd1234efgh5678"').length > 0);
  assert.ok(scanForSecrets('-----BEGIN PRIVATE KEY-----').includes('pem-private-key'));
  assert.ok(scanForSecrets('AKIAIOSFODNN7EXAMPLE').includes('aws-access-key'));
  // returns names only, never values
  const hits = scanForSecrets('password=hunter2hunter2;');
  assert.ok(hits.every((h) => typeof h === 'string' && !/hunter2/.test(h)));
});
