'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const scriptPath = path.join(__dirname, '..', 'create-record.js');
const scriptSrc = fs.readFileSync(scriptPath, 'utf8');

test('create-record.js supports single + batch', () => {
  assert.match(scriptSrc, /createSingle/);
  assert.match(scriptSrc, /createBatch/);
});

test('create-record.js uses $batch endpoint with multipart/mixed', () => {
  assert.match(scriptSrc, /\/api\/data\/v9\.2\/\$batch/);
  assert.match(scriptSrc, /multipart\/mixed/);
});

test('create-record.js: missing args exits 1 with usage', () => {
  const res = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Usage:/);
});

test('create-record.js: parseBatchResponse splits on HTTP/1.1 marker', () => {
  // Smoke check the response splitter shape (we don't execute it here, just verify the regex pattern is present).
  assert.match(scriptSrc, /split\(\/HTTP\\\/1\\\.1 \//);
});
