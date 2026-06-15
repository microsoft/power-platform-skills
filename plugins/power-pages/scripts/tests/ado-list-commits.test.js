'use strict';

const { withNoAdoAcquire } = require('./ado-test-helpers');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { listCommits, DEFAULT_TOP, MAX_TOP } = require('../lib/ado-list-commits');

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

test('ado-list-commits: constants', () => {
  assert.equal(DEFAULT_TOP, 20);
  assert.equal(MAX_TOP, 100);
});

test('ado-list-commits: missing args reject', async () => {
  await assert.rejects(listCommits({ project: 'p', repository: 'r', branch: 'b', pat: 'P' }), /organization/);
  await assert.rejects(listCommits({ organization: 'o', repository: 'r', branch: 'b', pat: 'P' }), /project/);
  await assert.rejects(listCommits({ organization: 'o', project: 'p', branch: 'b', pat: 'P' }), /repository/);
  await assert.rejects(listCommits({ organization: 'o', project: 'p', repository: 'r', pat: 'P' }), /branch/);
  await assert.rejects(withNoAdoAcquire(() => listCommits({ organization: 'o', project: 'p', repository: 'r', branch: 'b' })), /pat or --token/);
});

test('ado-list-commits: happy path with full commit list', async () => {
  const s = await createQueuedServer([
    {
      status: 200,
      body: JSON.stringify({
        count: 2,
        value: [
          {
            commitId: 'a'.repeat(40),
            comment: 'feat: x',
            author: { name: 'Alice', email: 'a@x', date: '2026-01-01T00:00:00Z' },
            committer: { name: 'Alice', email: 'a@x', date: '2026-01-01T00:00:00Z' },
            remoteUrl: 'https://dev.azure.com/o/_git/r/commit/aaa',
          },
          {
            commitId: 'b'.repeat(40),
            comment: 'fix: y',
            author: { name: 'Bob', email: 'b@x', date: '2026-01-02T00:00:00Z' },
          },
        ],
      }),
    },
  ]);
  const r = await listCommits({
    organization: 'o', project: 'p', repository: 'r',
    branch: 'main', pat: 'P', baseUrl: serverUrl(s),
  });
  await closeAll(s);
  assert.equal(r.count, 2);
  assert.equal(r.commits[0].commitId, 'a'.repeat(40));
  assert.equal(r.commits[0].comment, 'feat: x');
  assert.equal(r.commits[0].author.name, 'Alice');
  assert.equal(r.commits[0].url, 'https://dev.azure.com/o/_git/r/commit/aaa');
  assert.equal(r.commits[1].committer, null);
  assert.equal(r.branch, 'main');

  const url = s.received[0].url;
  assert.match(url, /searchCriteria\.itemVersion\.version=main/);
  assert.match(url, /searchCriteria\.itemVersion\.versionType=branch/);
  assert.match(url, /%24top=20/);
  assert.match(url, /api-version=7\.0/);
});

test('ado-list-commits: --top is capped at MAX_TOP', async () => {
  const s = await createQueuedServer([{ status: 200, body: JSON.stringify({ value: [] }) }]);
  await listCommits({
    organization: 'o', project: 'p', repository: 'r',
    branch: 'main', top: 500, pat: 'P', baseUrl: serverUrl(s),
  });
  await closeAll(s);
  assert.match(s.received[0].url, /%24top=100/);
});

test('ado-list-commits: --top of 0 is bumped to 1', async () => {
  const s = await createQueuedServer([{ status: 200, body: JSON.stringify({ value: [] }) }]);
  await listCommits({
    organization: 'o', project: 'p', repository: 'r',
    branch: 'main', top: 0, pat: 'P', baseUrl: serverUrl(s),
  });
  await closeAll(s);
  assert.match(s.received[0].url, /%24top=1/);
});

test('ado-list-commits: --author adds searchCriteria.author filter', async () => {
  const s = await createQueuedServer([{ status: 200, body: JSON.stringify({ value: [] }) }]);
  await listCommits({
    organization: 'o', project: 'p', repository: 'r',
    branch: 'main', author: 'alice@x', pat: 'P', baseUrl: serverUrl(s),
  });
  await closeAll(s);
  assert.match(s.received[0].url, /searchCriteria\.author=alice%40x/);
});

test('ado-list-commits: strips refs/heads/ prefix from branch param', async () => {
  const s = await createQueuedServer([{ status: 200, body: JSON.stringify({ value: [] }) }]);
  const r = await listCommits({
    organization: 'o', project: 'p', repository: 'r',
    branch: 'refs/heads/feature/bar', pat: 'P', baseUrl: serverUrl(s),
  });
  await closeAll(s);
  assert.equal(r.branch, 'feature/bar');
  assert.match(s.received[0].url, /searchCriteria\.itemVersion\.version=feature%2Fbar/);
});

test('ado-list-commits: empty result returns empty array', async () => {
  const s = await createQueuedServer([{ status: 200, body: JSON.stringify({ count: 0, value: [] }) }]);
  const r = await listCommits({
    organization: 'o', project: 'p', repository: 'r',
    branch: 'main', pat: 'P', baseUrl: serverUrl(s),
  });
  await closeAll(s);
  assert.equal(r.count, 0);
  assert.deepEqual(r.commits, []);
});

test('ado-list-commits: HTTP 404 surfaces error envelope', async () => {
  const s = await createQueuedServer([
    { status: 404, body: JSON.stringify({ message: 'Branch not found', typeKey: 'BranchNotFoundException' }) },
  ]);
  const r = await listCommits({
    organization: 'o', project: 'p', repository: 'r',
    branch: 'gone', pat: 'P', baseUrl: serverUrl(s),
  });
  await closeAll(s);
  assert.equal(r.error, 'Branch not found');
  assert.equal(r.statusCode, 404);
  assert.equal(r.errorCode, 'BranchNotFoundException');
});

test('ado-list-commits: --tokenFile JSON envelope resolves for Authorization header', async () => {
  const fs = require('node:fs'); const path = require('node:path');
  const tokenFile = path.join(__dirname, '.ado-token-ado-list-commits.json');
  fs.writeFileSync(tokenFile, JSON.stringify({ token: 'header.payload.sig' }));
  const s = await createQueuedServer([{ status: 200, body: JSON.stringify({ value: [] }) }]);
  try {
    const r = await listCommits({ organization: 'o', project: 'p', repository: 'r', branch: 'main', tokenFile, baseUrl: serverUrl(s) });
    assert.equal(r.count, 0);
    assert.equal(s.received[0].headers.authorization, 'Bearer header.payload.sig');
  } finally { await closeAll(s); fs.rmSync(tokenFile, { force: true }); }
});
