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

function runWithBatchSize(batchSize) {
  return spawnSync(
    process.execPath,
    [scriptPath, 'https://example.crm.dynamics.com', 'accounts', '--body', '[]', '--batch-size', String(batchSize)],
    { encoding: 'utf8' },
  );
}

test('create-record.js: rejects non-numeric --batch-size', () => {
  const res = runWithBatchSize('abc');
  assert.equal(res.status, 1);
  assert.match(res.stderr, /--batch-size/);
});

test('create-record.js: rejects --batch-size 0', () => {
  const res = runWithBatchSize(0);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /--batch-size/);
});

test('create-record.js: rejects negative --batch-size', () => {
  const res = runWithBatchSize(-5);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /--batch-size/);
});

test('create-record.js: rejects fractional --batch-size', () => {
  const res = runWithBatchSize('2.5');
  assert.equal(res.status, 1);
  assert.match(res.stderr, /--batch-size/);
});

test('create-record.js: rejects --batch-size above 1000', () => {
  const res = runWithBatchSize(1001);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /--batch-size/);
});

test('create-record.js: accepts valid --batch-size (empty array no-op)', () => {
  // With --body '[]', createBatch loop body never executes (no auth, no network).
  // The script should exit 0 with count=0.
  const res = runWithBatchSize(100);
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}. stderr: ${res.stderr}`);
  const parsed = JSON.parse(res.stdout.trim());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.count, 0);
});
