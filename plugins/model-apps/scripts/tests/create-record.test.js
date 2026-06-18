'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const scriptPath = path.join(__dirname, '..', 'create-record.js');
const scriptSrc = fs.readFileSync(scriptPath, 'utf8');
const { parseBatchResponse } = require(scriptPath);

// Build a realistic Dataverse $batch multipart response body with one part per
// (contentId, status) pair. Successful parts carry an OData-EntityId header; failed
// parts carry a JSON error body. Mirrors the shape parseBatchResponse must handle.
function buildBatchBody(parts, boundary = 'changesetresponse_x') {
  const lines = [];
  for (const p of parts) {
    lines.push(`--${boundary}`);
    lines.push('Content-Type: application/http');
    lines.push('Content-Transfer-Encoding: binary');
    lines.push(`Content-ID: ${p.contentId}`);
    lines.push('');
    if (p.status >= 200 && p.status < 300) {
      lines.push(`HTTP/1.1 ${p.status} Created`);
      lines.push(
        `OData-EntityId: https://x.crm.dynamics.com/api/data/v9.2/accounts(${p.id})`,
      );
      lines.push('');
      lines.push('');
    } else {
      lines.push(`HTTP/1.1 ${p.status} Bad Request`);
      lines.push('Content-Type: application/json; odata.metadata=minimal');
      lines.push('');
      lines.push(JSON.stringify({ error: { message: p.message || 'failed' } }));
    }
  }
  lines.push(`--${boundary}--`);
  return lines.join('\r\n');
}

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

test('parseBatchResponse: captures Content-ID and per-part status/headers/body', () => {
  const body = buildBatchBody([
    { contentId: 1, status: 204, id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
    { contentId: 2, status: 400, message: 'name is required' },
    { contentId: 3, status: 204, id: 'cccccccc-cccc-cccc-cccc-cccccccccccc' },
  ]);
  const parts = parseBatchResponse(body);
  assert.equal(parts.length, 3, 'one entry per response part');
  assert.deepEqual(parts.map((p) => p.contentId), [1, 2, 3], 'Content-ID echoed back per part');
  assert.deepEqual(parts.map((p) => p.status), [204, 400, 204], 'statuses parsed');
  assert.match(parts[0].headers, /OData-EntityId/i, 'success part keeps its headers');
  assert.match(parts[1].body, /name is required/, 'failure part keeps its error body');
});

test('parseBatchResponse: Content-ID maps results back even when parts are out of order', () => {
  // Dataverse does not guarantee response order. Reorder the parts and confirm the
  // Content-ID (not array position) is what identifies each record's slot. This is the
  // contract create-record.js relies on to keep `ids` positionally aligned 1:1 with the
  // input records (so a failed/middle record never shifts later records' ids).
  const body = buildBatchBody([
    { contentId: 3, status: 204, id: 'cccccccc-cccc-cccc-cccc-cccccccccccc' },
    { contentId: 1, status: 400, message: 'boom' },
    { contentId: 2, status: 204, id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' },
  ]);
  const parts = parseBatchResponse(body);
  // Reconstruct the positionally-aligned id array the way createBatch does.
  const ids = new Array(3).fill(null);
  for (const p of parts) {
    if (p.status >= 200 && p.status < 300) {
      const id = (p.headers.match(/\(([0-9a-f-]{36})\)/i) || [])[1];
      ids[p.contentId - 1] = id || null;
    }
  }
  assert.deepEqual(
    ids,
    [null, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'cccccccc-cccc-cccc-cccc-cccccccccccc'],
    'record 1 (failed) stays null; records 2 and 3 keep their own ids despite response reorder',
  );
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
