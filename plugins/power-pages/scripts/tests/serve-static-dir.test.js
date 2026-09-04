'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { EventEmitter } = require('events');

const { parseArgs, safeResolve, contentType, isServableFile, streamFile } = require('../serve-static-dir');

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
  const originalExistsSync = require('fs').existsSync;
  const originalStatSync = require('fs').statSync;
  try {
    require('fs').existsSync = () => true;
    require('fs').statSync = () => { throw new Error('permission denied'); };
    assert.equal(isServableFile('/tmp/import/status.json'), false);
  } finally {
    require('fs').existsSync = originalExistsSync;
    require('fs').statSync = originalStatSync;
  }
});

test('contentType returns useful types for import status assets', () => {
  assert.equal(contentType('index.html'), 'text/html; charset=utf-8');
  assert.equal(contentType('status.json'), 'application/json; charset=utf-8');
  assert.equal(contentType('preview.png'), 'image/png');
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
