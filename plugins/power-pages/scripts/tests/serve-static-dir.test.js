'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { parseArgs, safeResolve, contentType } = require('../serve-static-dir');

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

test('contentType returns useful types for import status assets', () => {
  assert.equal(contentType('index.html'), 'text/html; charset=utf-8');
  assert.equal(contentType('status.json'), 'application/json; charset=utf-8');
  assert.equal(contentType('preview.png'), 'image/png');
});
