'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  DIR_MODE,
  FILE_MODE,
  prepareCacheDirs,
  hardenDir,
  hardenFile,
  wipeClone,
  scanForSecrets,
} = require('../lib/clone-cache-store');

function withTempDir(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-clone-cache-store-'));
  try {
    return fn(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- prepareCacheDirs ----

test('prepareCacheDirs: creates cloneDir, repoDir, and ppMergeDir', () => withTempDir((tmp) => {
  const cloneDir = path.join(tmp, 'my-clone');
  const repoDir = path.join(cloneDir, 'repo');
  const ppMergeDir = path.join(cloneDir, '.pp-merge');

  const result = prepareCacheDirs({ cloneDir, repoDir, ppMergeDir });

  assert.deepEqual(result, { cloneDir, repoDir, ppMergeDir });
  assert.equal(fs.statSync(cloneDir).isDirectory(), true);
  assert.equal(fs.statSync(repoDir).isDirectory(), true);
  assert.equal(fs.statSync(ppMergeDir).isDirectory(), true);
}));

test('prepareCacheDirs: calls hardenDir (chmodSync) on each directory', () => {
  const chmodCalls = [];
  const mockFs = {
    mkdirSync: () => {},
    chmodSync: (p, mode) => chmodCalls.push({ p, mode }),
  };
  const layout = { cloneDir: 'C:\\clones\\x', repoDir: 'C:\\clones\\x\\repo', ppMergeDir: 'C:\\clones\\x\\.pp-merge' };
  prepareCacheDirs(layout, mockFs);

  assert.equal(chmodCalls.length, 3);
  assert.ok(chmodCalls.every(c => c.mode === DIR_MODE));
});

test('prepareCacheDirs: throws when any directory field is missing', () => {
  assert.throws(
    () => prepareCacheDirs({ cloneDir: null, repoDir: 'a', ppMergeDir: 'b' }),
    /cloneDir, repoDir, and ppMergeDir are required/
  );
});

// ---- hardenDir / hardenFile ----

test('hardenDir: calls chmodSync with DIR_MODE', () => {
  let called = null;
  const mockFs = { chmodSync: (p, mode) => { called = { p, mode }; } };
  hardenDir('C:\\some\\dir', mockFs);
  assert.deepEqual(called, { p: 'C:\\some\\dir', mode: DIR_MODE });
});

test('hardenDir: silently ignores chmodSync errors (best-effort on Windows)', () => {
  const mockFs = { chmodSync: () => { throw new Error('EPERM'); } };
  assert.doesNotThrow(() => hardenDir('C:\\some\\dir', mockFs));
});

test('hardenFile: calls chmodSync with FILE_MODE', () => {
  let called = null;
  const mockFs = { chmodSync: (p, mode) => { called = { p, mode }; } };
  hardenFile('C:\\some\\file.json', mockFs);
  assert.deepEqual(called, { p: 'C:\\some\\file.json', mode: FILE_MODE });
});

test('hardenFile: silently ignores chmodSync errors (best-effort on Windows)', () => {
  const mockFs = { chmodSync: () => { throw new Error('EPERM'); } };
  assert.doesNotThrow(() => hardenFile('C:\\some\\file.json', mockFs));
});

// ---- wipeClone ----

test('wipeClone: removes the cloneDir and returns { wiped: true }', () => withTempDir((tmp) => {
  const cloneDir = path.join(tmp, 'to-wipe');
  fs.mkdirSync(cloneDir, { recursive: true });
  fs.writeFileSync(path.join(cloneDir, 'data.txt'), 'hello');

  const result = wipeClone({ cloneDir });

  assert.deepEqual(result, { wiped: true });
  assert.equal(fs.existsSync(cloneDir), false);
}));

test('wipeClone: returns { wiped: false } when cloneDir is not provided', () => {
  assert.deepEqual(wipeClone({}), { wiped: false });
  assert.deepEqual(wipeClone(), { wiped: false });
});

test('wipeClone: throws on a relative cloneDir', () => {
  assert.throws(
    () => wipeClone({ cloneDir: 'relative/path' }),
    /cloneDir must be absolute/
  );
});

test('wipeClone: returns { wiped: false } when rmSync throws', () => {
  const mockFs = { rmSync: () => { throw new Error('EBUSY'); } };
  const result = wipeClone({ cloneDir: path.resolve('C:\\some\\absolute\\dir') }, mockFs);
  assert.deepEqual(result, { wiped: false });
});

// ---- scanForSecrets ----

test('scanForSecrets: flags AWS access key and bearer JWT', () => {
  const hits = scanForSecrets([
    'aws = "AKIAABCDEFGHIJKLMNOP"',
    'Authorization: Bearer eyJabcdefghij.eyJklmnopqrst.eyJuvwxyzABC"',
  ].join('\n'));

  assert.deepEqual(hits.sort(), ['aws-access-key', 'bearer-jwt'].sort());
});

test('scanForSecrets: returns empty array for clean text', () => {
  assert.deepEqual(scanForSecrets('ordinary site content with no credentials'), []);
});

test('scanForSecrets: returns empty array for null/empty input', () => {
  assert.deepEqual(scanForSecrets(null), []);
  assert.deepEqual(scanForSecrets(''), []);
  assert.deepEqual(scanForSecrets(undefined), []);
});
