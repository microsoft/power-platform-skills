'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { getCommit } = require('../lib/ado-get-commit');

function createQueuedServer(responses) {
  const queue = [...responses];
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, headers: req.headers, body });
      const next = queue.shift() || { status: 500, body: '' };
      res.writeHead(next.status, next.headers || { 'Content-Type': 'application/json' });
      res.end(next.body || '');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, received }));
  });
}
function serverUrl(s) { return `http://127.0.0.1:${s.port}`; }
function closeAll(...servers) { return Promise.all(servers.map(s => new Promise(r => s.server.close(r)))); }

test('ado-get-commit: missing args reject', async () => {
  await assert.rejects(getCommit({ project: 'p', repository: 'r', commitId: 'abc1234', pat: 'P' }), /organization/);
  await assert.rejects(getCommit({ organization: 'o', repository: 'r', commitId: 'abc1234', pat: 'P' }), /project/);
  await assert.rejects(getCommit({ organization: 'o', project: 'p', commitId: 'abc1234', pat: 'P' }), /repository/);
  await assert.rejects(getCommit({ organization: 'o', project: 'p', repository: 'r', pat: 'P' }), /commitId/);
  await assert.rejects(getCommit({ organization: 'o', project: 'p', repository: 'r', commitId: 'abc1234' }), /pat or --token/);
});

test('ado-get-commit: rejects non-hex / too-short SHAs', async () => {
  await assert.rejects(
    getCommit({ organization: 'o', project: 'p', repository: 'r', commitId: 'xyz', pat: 'P' }),
    /must be a hex SHA/,
  );
  await assert.rejects(
    getCommit({ organization: 'o', project: 'p', repository: 'r', commitId: 'ABC', pat: 'P' }),
    /must be a hex SHA/,
  );
});

test('ado-get-commit: happy path returns parsed commit + appends changeCount=0', async () => {
  const s = await createQueuedServer([
    {
      status: 200,
      body: JSON.stringify({
        commitId: 'a'.repeat(40),
        comment: 'feat: thing',
        author: { name: 'Alice', email: 'a@x', date: '2026-01-01T00:00:00Z' },
        committer: { name: 'Alice', email: 'a@x', date: '2026-01-01T00:00:00Z' },
        parents: ['b'.repeat(40)],
        remoteUrl: 'https://dev.azure.com/o/_git/r/commit/aaa',
      }),
    },
  ]);
  const r = await getCommit({
    organization: 'o', project: 'p', repository: 'r',
    commitId: 'a'.repeat(40), pat: 'P', baseUrl: serverUrl(s),
  });
  await closeAll(s);
  assert.equal(r.found, true);
  assert.equal(r.commitId, 'a'.repeat(40));
  assert.equal(r.comment, 'feat: thing');
  assert.deepEqual(r.parents, ['b'.repeat(40)]);
  assert.equal(r.url, 'https://dev.azure.com/o/_git/r/commit/aaa');
  // Verify changeCount=0 was appended (saves bandwidth on the round-trip)
  assert.match(s.received[0].url, /changeCount=0/);
  // Verify api-version was added
  assert.match(s.received[0].url, /api-version=7\.0/);
  // Verify URL targets /commits/<sha>
  assert.match(s.received[0].url, /\/commits\/a{40}/);
});

test('ado-get-commit: 404 returns { found: false, statusCode: 404 } NOT a thrown error', async () => {
  const s = await createQueuedServer([
    { status: 404, body: JSON.stringify({ message: 'TF401019: Commit not found' }) },
  ]);
  const r = await getCommit({
    organization: 'o', project: 'p', repository: 'r',
    commitId: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    pat: 'P', baseUrl: serverUrl(s),
  });
  await closeAll(s);
  assert.equal(r.found, false);
  assert.equal(r.statusCode, 404);
  assert.equal(r.error, 'Commit not found');
});

test('ado-get-commit: 500 returns error envelope', async () => {
  const s = await createQueuedServer([
    { status: 500, body: JSON.stringify({ message: 'oops' }) },
    { status: 500, body: JSON.stringify({ message: 'oops' }) },
    { status: 500, body: JSON.stringify({ message: 'oops' }) },
    { status: 500, body: JSON.stringify({ message: 'oops' }) },
  ]);
  const r = await getCommit({
    organization: 'o', project: 'p', repository: 'r',
    commitId: 'abc1234', pat: 'P', baseUrl: serverUrl(s),
  });
  await closeAll(s);
  assert.equal(r.statusCode, 500);
  assert.match(r.error, /oops/);
});

test('ado-get-commit: accepts short (7-char) SHAs', async () => {
  const s = await createQueuedServer([
    {
      status: 200,
      body: JSON.stringify({
        commitId: 'a'.repeat(40),
        comment: 'short ref',
      }),
    },
  ]);
  const r = await getCommit({
    organization: 'o', project: 'p', repository: 'r',
    commitId: 'abc1234', pat: 'P', baseUrl: serverUrl(s),
  });
  await closeAll(s);
  assert.equal(r.found, true);
  assert.match(s.received[0].url, /\/commits\/abc1234/);
});
