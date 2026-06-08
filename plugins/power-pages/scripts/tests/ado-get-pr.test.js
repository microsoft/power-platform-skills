'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { getPullRequest } = require('../lib/ado-get-pr');

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

test('ado-get-pr: missing args reject', async () => {
  await assert.rejects(getPullRequest({ project: 'p', repository: 'r', pullRequestId: 1, pat: 'P' }), /organization/);
  await assert.rejects(getPullRequest({ organization: 'o', repository: 'r', pullRequestId: 1, pat: 'P' }), /project/);
  await assert.rejects(getPullRequest({ organization: 'o', project: 'p', pullRequestId: 1, pat: 'P' }), /repository/);
  await assert.rejects(getPullRequest({ organization: 'o', project: 'p', repository: 'r', pat: 'P' }), /pullRequestId/);
  await assert.rejects(getPullRequest({ organization: 'o', project: 'p', repository: 'r', pullRequestId: 1 }), /pat or --token/);
});

test('ado-get-pr: happy path returns flattened summary', async () => {
  const s = await createQueuedServer([
    {
      status: 200,
      body: JSON.stringify({
        pullRequestId: 42,
        status: 'active',
        mergeStatus: 'succeeded',
        sourceRefName: 'refs/heads/feature/x',
        targetRefName: 'refs/heads/main',
        title: 'Add foo',
        description: 'Body',
        createdBy: { displayName: 'Alice', uniqueName: 'alice@contoso.com' },
        creationDate: '2026-01-01T00:00:00Z',
        _links: { web: { href: 'https://dev.azure.com/o/p/_git/r/pullrequest/42' } },
      }),
    },
  ]);
  const r = await getPullRequest({
    organization: 'o', project: 'p', repository: 'r',
    pullRequestId: 42, pat: 'P', baseUrl: serverUrl(s),
  });
  await closeAll(s);
  assert.equal(r.found, true);
  assert.equal(r.pullRequestId, 42);
  assert.equal(r.status, 'active');
  assert.equal(r.mergeStatus, 'succeeded');
  assert.equal(r.sourceBranch, 'refs/heads/feature/x');
  assert.equal(r.title, 'Add foo');
  assert.equal(r.createdBy.displayName, 'Alice');
  assert.equal(r.url, 'https://dev.azure.com/o/p/_git/r/pullrequest/42');

  assert.match(s.received[0].url, /\/p\/_apis\/git\/repositories\/r\/pullrequests\/42\?api-version=7\.0$/);
  assert.equal(s.received[0].method, 'GET');
});

test('ado-get-pr: 404 returns found=false (not an error)', async () => {
  const s = await createQueuedServer([
    { status: 404, body: JSON.stringify({ message: 'not found' }) },
  ]);
  const r = await getPullRequest({
    organization: 'o', project: 'p', repository: 'r',
    pullRequestId: 999, pat: 'P', baseUrl: serverUrl(s),
  });
  await closeAll(s);
  assert.equal(r.found, false);
  assert.equal(r.pullRequestId, 999);
  assert.equal(r.error, undefined);
});

test('ado-get-pr: builds fallback URL when _links missing', async () => {
  const s = await createQueuedServer([
    { status: 200, body: JSON.stringify({ pullRequestId: 7, status: 'completed' }) },
  ]);
  const r = await getPullRequest({
    organization: 'myorg', project: 'myproj', repository: 'myrepo',
    pullRequestId: 7, pat: 'P', baseUrl: serverUrl(s),
  });
  await closeAll(s);
  assert.equal(r.url, 'https://dev.azure.com/myorg/myproj/_git/myrepo/pullrequest/7');
});

test('ado-get-pr: 500 surfaces error envelope', async () => {
  // Default retryAttempts=3 → 4 requests max. Queue same 500 for each.
  const errorBody = JSON.stringify({ message: 'Internal', typeKey: 'X' });
  const s = await createQueuedServer([
    { status: 500, body: errorBody },
    { status: 500, body: errorBody },
    { status: 500, body: errorBody },
    { status: 500, body: errorBody },
  ]);
  const r = await getPullRequest({
    organization: 'o', project: 'p', repository: 'r',
    pullRequestId: 1, pat: 'P', baseUrl: serverUrl(s),
  });
  await closeAll(s);
  assert.equal(r.error, 'Internal');
  assert.equal(r.statusCode, 500);
});
