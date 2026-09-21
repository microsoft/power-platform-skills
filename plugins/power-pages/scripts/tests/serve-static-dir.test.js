'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const {
  cleanupOwnedRoot,
  contentType,
  createCleanupOwnership,
  isServableFile,
  main,
  parseArgs,
  resolveNewFileWithinRoot,
  requestsServerShutdown,
  safeResolve,
  serverUrl,
  startServer,
  streamFile,
  waitForChildReady,
} = require('../serve-static-dir');

test('parseArgs reads static server options', () => {
  assert.deepEqual(parseArgs(['--root', '/tmp/import', '--urlFile', '/tmp/url.txt', '--port', '8123']), {
    root: '/tmp/import',
    urlFile: '/tmp/url.txt',
    host: '127.0.0.1',
    port: 8123,
  });
});

test('safeResolve keeps requests inside the served root', () => {
  const root = path.resolve('/tmp/import');
  assert.equal(safeResolve(root, '/status.json'), path.join(root, 'status.json'));
  assert.equal(safeResolve(root, '/'), path.join(root, 'index.html'));
  assert.equal(safeResolve(root, '/../secret.txt'), null);
});

test('safeResolve rejects malformed percent-encoding without throwing', () => {
  const root = path.resolve('/tmp/import');
  assert.equal(safeResolve(root, '/%E0%A4%A'), null);
});

test('isServableFile treats stat failures as not found', () => {
  const originalExistsSync = fs.existsSync;
  const originalLstatSync = fs.lstatSync;
  try {
    fs.existsSync = () => true;
    fs.lstatSync = () => { throw new Error('permission denied'); };
    assert.equal(isServableFile('/tmp/import/status.json'), false);
  } finally {
    fs.existsSync = originalExistsSync;
    fs.lstatSync = originalLstatSync;
  }
});

test('isServableFile rejects symbolic links', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-static-dir-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'target.json');
  const link = path.join(dir, 'status.json');
  fs.writeFileSync(target, '{}');
  try {
    fs.symlinkSync(target, link);
  } catch (err) {
    if (err.code === 'EPERM') {
      t.skip('File symlinks require additional privileges on this platform');
      return;
    }
    throw err;
  }

  assert.equal(isServableFile(target), true);
  assert.equal(isServableFile(link), false);
});

test('isServableFile rejects files reached through a symlinked parent', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-static-dir-root-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-static-dir-outside-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(outside, 'secret.json'), '{"secret":true}');
  const linkedDir = path.join(root, 'linked-dir');
  try {
    fs.symlinkSync(outside, linkedDir, 'dir');
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EACCES') {
      t.skip(`directory symlinks are unavailable: ${err.code}`);
      return;
    }
    throw err;
  }

  assert.equal(
    isServableFile(path.join(linkedDir, 'secret.json'), { root }),
    false
  );
});

test('contentType returns useful types for import status assets', () => {
  assert.equal(contentType('index.html'), 'text/html; charset=utf-8');
  assert.equal(contentType('status.json'), 'application/json; charset=utf-8');
  assert.equal(contentType('preview.png'), 'image/png');
});

test('serverUrl brackets IPv6 literals without changing IPv4 hosts', () => {
  assert.equal(serverUrl('127.0.0.1', 8123), 'http://127.0.0.1:8123/');
  assert.equal(serverUrl('::1', 8123), 'http://[::1]:8123/');
});

test('server shutdown requires the final workflow success marker', () => {
  assert.equal(requestsServerShutdown({ state: 'succeeded' }), false);
  assert.equal(requestsServerShutdown({ state: 'failed', shutdownServer: true }), false);
  assert.equal(requestsServerShutdown({ state: 'succeeded', shutdownServer: true }), true);
});

test('streamFile ends the response when read stream creation throws', () => {
  const writes = [];
  const res = {
    headersSent: false,
    writeHead: (status) => writes.push(['head', status]),
    end: (body) => writes.push(['end', body]),
  };

  streamFile('/tmp/import/status.json', res, {
    fs: {
      createReadStream: () => { throw new Error('gone'); },
    },
  });

  assert.deepEqual(writes, [['head', 404], ['end', 'Not found']]);
});

test('streamFile handles stream errors after headers are written', () => {
  const stream = new EventEmitter();
  stream.pipe = () => {};
  const writes = [];
  const res = {
    headersSent: true,
    writeHead: (status) => writes.push(['head', status]),
    end: (body) => writes.push(['end', body]),
  };

  streamFile('/tmp/import/status.json', res, {
    fs: {
      createReadStream: () => stream,
    },
  });
  stream.emit('error', new Error('gone'));

  assert.deepEqual(writes, [['end', undefined]]);
});

test('waitForChildReady resolves only after the child reports a listening URL', async () => {
  const child = new EventEmitter();
  const pending = waitForChildReady(child, 1000);
  process.nextTick(() => child.emit('message', { type: 'ready', url: 'http://127.0.0.1:8123/' }));
  assert.deepEqual(await pending, { type: 'ready', url: 'http://127.0.0.1:8123/' });
});

test('waitForChildReady rejects child startup errors', async () => {
  const child = new EventEmitter();
  const pending = waitForChildReady(child, 1000);
  process.nextTick(() => child.emit('message', { type: 'error', error: 'bind failed' }));
  await assert.rejects(pending, /bind failed/);
});

test('main waits for child readiness before writing the URL file', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-static-dir-main-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'index.html'), '<html></html>');
  fs.writeFileSync(path.join(root, 'status.json'), '{"state":"running"}');
  const child = new EventEmitter();
  child.pid = 1234;
  child.unref = () => {};
  child.kill = () => {};
  const urlFile = path.join(root, 'url.txt');
  const pending = main(['--root', root, '--urlFile', urlFile], {
    fork() {
      process.nextTick(() => child.emit('message', { type: 'ready', url: 'http://127.0.0.1:8123/' }));
      return child;
    },
  });

  assert.equal(fs.existsSync(urlFile), false);
  assert.deepEqual(await pending, { ok: true, url: 'http://127.0.0.1:8123/', pid: 1234 });
  assert.equal(fs.readFileSync(urlFile, 'utf8'), 'http://127.0.0.1:8123/');
});

test('URL file creation rejects a symlinked parent directory', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-static-dir-url-root-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-static-dir-url-outside-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  const linkedDir = path.join(root, 'linked-dir');
  try {
    fs.symlinkSync(outside, linkedDir, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EACCES') {
      t.skip(`directory symlinks are unavailable: ${err.code}`);
      return;
    }
    throw err;
  }

  assert.throws(
    () => resolveNewFileWithinRoot(root, path.join(linkedDir, 'url.txt')),
    /parent directories must be regular directories/
  );
  assert.equal(fs.existsSync(path.join(outside, 'url.txt')), false);
});

test('cleanup ownership removes only the owned temporary root', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-static-dir-owned-'));
  const ownership = createCleanupOwnership(root);
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(ownership.markerPath, { force: true });
  });
  fs.writeFileSync(path.join(root, 'status.json'), '{"state":"running"}');

  assert.equal(cleanupOwnedRoot({
    root: ownership.root,
    cleanupMarker: ownership.markerPath,
    cleanupToken: ownership.token,
  }), true);
  assert.equal(fs.existsSync(root), false);
  assert.equal(fs.existsSync(ownership.markerPath), false);
});

test('startServer closes and removes its temporary root after success', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-static-dir-success-'));
  fs.writeFileSync(path.join(root, 'index.html'), '<html></html>');
  const statusPath = path.join(root, 'status.json');
  fs.writeFileSync(statusPath, '{"state":"running"}');
  const ownership = createCleanupOwnership(root);
  const started = await startServer({
    root,
    host: '127.0.0.1',
    port: 0,
    statusPath,
    cleanupMarker: ownership.markerPath,
    cleanupToken: ownership.token,
    idleTimeoutMs: 2000,
    maxLifetimeMs: 2000,
    successGraceMs: 20,
    statusPollMs: 10,
  });
  t.after(() => {
    started.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(ownership.markerPath, { force: true });
  });

  fs.writeFileSync(statusPath, '{"state":"succeeded","shutdownServer":true}');
  await started.closed;
  assert.equal(fs.existsSync(root), false);
  assert.equal(fs.existsSync(ownership.markerPath), false);
});
