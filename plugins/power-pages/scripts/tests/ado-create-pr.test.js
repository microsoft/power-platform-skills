'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createPullRequest, normalizeRef } = require('../lib/ado-create-pr');

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

test('ado-create-pr: normalizeRef adds refs/heads/ prefix when missing', () => {
  assert.equal(normalizeRef('main'), 'refs/heads/main');
  assert.equal(normalizeRef('refs/heads/feature/x'), 'refs/heads/feature/x');
  assert.equal(normalizeRef('refs/tags/v1'), 'refs/tags/v1');
});

test('ado-create-pr: missing required args reject', async () => {
  await assert.rejects(createPullRequest({ project: 'p', repository: 'r', sourceBranch: 's', targetBranch: 't', title: 'x', pat: 'p' }), /organization/);
  await assert.rejects(createPullRequest({ organization: 'o', repository: 'r', sourceBranch: 's', targetBranch: 't', title: 'x', pat: 'p' }), /project/);
  await assert.rejects(createPullRequest({ organization: 'o', project: 'p', sourceBranch: 's', targetBranch: 't', title: 'x', pat: 'p' }), /repository/);
  await assert.rejects(createPullRequest({ organization: 'o', project: 'p', repository: 'r', targetBranch: 't', title: 'x', pat: 'p' }), /sourceBranch/);
  await assert.rejects(createPullRequest({ organization: 'o', project: 'p', repository: 'r', sourceBranch: 's', title: 'x', pat: 'p' }), /targetBranch/);
  await assert.rejects(createPullRequest({ organization: 'o', project: 'p', repository: 'r', sourceBranch: 's', targetBranch: 't', pat: 'p' }), /title/);
  await assert.rejects(createPullRequest({ organization: 'o', project: 'p', repository: 'r', sourceBranch: 's', targetBranch: 't', title: 'x' }), /pat or --token/);
});

test('ado-create-pr: happy path creates PR with full payload', async () => {
  const s = await createQueuedServer([
    {
      status: 201,
      body: JSON.stringify({
        pullRequestId: 42,
        status: 'active',
        sourceRefName: 'refs/heads/feature/foo',
        targetRefName: 'refs/heads/main',
        title: 'My PR',
        _links: { web: { href: 'https://dev.azure.com/myorg/myproj/_git/myrepo/pullrequest/42' } },
      }),
    },
  ]);
  const r = await createPullRequest({
    organization: 'myorg', project: 'myproj', repository: 'myrepo',
    sourceBranch: 'feature/foo', targetBranch: 'main',
    title: 'My PR', description: 'Body markdown',
    pat: 'PAT',
    baseUrl: serverUrl(s),
  });
  await closeAll(s);
  assert.equal(r.created, true);
  assert.equal(r.pullRequestId, 42);
  assert.equal(r.status, 'active');
  assert.equal(r.url, 'https://dev.azure.com/myorg/myproj/_git/myrepo/pullrequest/42');
  assert.equal(r.sourceBranch, 'refs/heads/feature/foo');

  const req = s.received[0];
  assert.equal(req.method, 'POST');
  assert.match(req.url, /\/myproj\/_apis\/git\/repositories\/myrepo\/pullrequests\?api-version=7\.0$/);
  const body = JSON.parse(req.body);
  assert.equal(body.sourceRefName, 'refs/heads/feature/foo');
  assert.equal(body.targetRefName, 'refs/heads/main');
  assert.equal(body.title, 'My PR');
  assert.equal(body.description, 'Body markdown');
});

test('ado-create-pr: reviewers + workItems are forwarded', async () => {
  const s = await createQueuedServer([
    { status: 201, body: JSON.stringify({ pullRequestId: 7, status: 'active' }) },
  ]);
  await createPullRequest({
    organization: 'o', project: 'p', repository: 'r',
    sourceBranch: 'src', targetBranch: 'tgt',
    title: 't',
    reviewers: 'guid-a,guid-b',
    workItems: '1234,5678',
    pat: 'P',
    baseUrl: serverUrl(s),
  });
  await closeAll(s);
  const body = JSON.parse(s.received[0].body);
  assert.deepEqual(body.reviewers, [{ id: 'guid-a' }, { id: 'guid-b' }]);
  assert.deepEqual(body.workItemRefs, [{ id: '1234' }, { id: '5678' }]);
});

test('ado-create-pr: empty description still sends empty string field', async () => {
  const s = await createQueuedServer([
    { status: 201, body: JSON.stringify({ pullRequestId: 1, status: 'active' }) },
  ]);
  await createPullRequest({
    organization: 'o', project: 'p', repository: 'r',
    sourceBranch: 'src', targetBranch: 'tgt', title: 't',
    pat: 'P', baseUrl: serverUrl(s),
  });
  await closeAll(s);
  const body = JSON.parse(s.received[0].body);
  assert.equal(body.description, '');
});

test('ado-create-pr: builds fallback URL when _links missing', async () => {
  const s = await createQueuedServer([
    { status: 201, body: JSON.stringify({ pullRequestId: 99, status: 'active' }) },
  ]);
  const r = await createPullRequest({
    organization: 'myorg', project: 'myproj', repository: 'myrepo',
    sourceBranch: 'src', targetBranch: 'tgt', title: 't',
    pat: 'P', baseUrl: serverUrl(s),
  });
  await closeAll(s);
  assert.equal(r.url, 'https://dev.azure.com/myorg/myproj/_git/myrepo/pullrequest/99');
});

test('ado-create-pr: 409 conflict (e.g. PR already exists) surfaces error', async () => {
  const s = await createQueuedServer([
    { status: 409, body: JSON.stringify({ message: 'PR already exists', typeKey: 'GitPullRequestExistsException' }) },
  ]);
  const r = await createPullRequest({
    organization: 'o', project: 'p', repository: 'r',
    sourceBranch: 'src', targetBranch: 'tgt', title: 't',
    pat: 'P', baseUrl: serverUrl(s),
  });
  await closeAll(s);
  assert.equal(r.error, 'PR already exists');
  assert.equal(r.statusCode, 409);
  assert.equal(r.errorCode, 'GitPullRequestExistsException');
});
