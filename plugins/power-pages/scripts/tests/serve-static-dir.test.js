'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const { parseArgs, safeResolve, contentType, isServableFile, streamFile, serverUrl } = require('../serve-static-dir');

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

test('contentType returns useful types for import status assets', () => {
  assert.equal(contentType('index.html'), 'text/html; charset=utf-8');
  assert.equal(contentType('status.json'), 'application/json; charset=utf-8');
  assert.equal(contentType('preview.png'), 'image/png');
});

test('serverUrl brackets IPv6 literals without changing IPv4 hosts', () => {
  assert.equal(serverUrl('127.0.0.1', 8123), 'http://127.0.0.1:8123/');
  assert.equal(serverUrl('::1', 8123), 'http://[::1]:8123/');
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
