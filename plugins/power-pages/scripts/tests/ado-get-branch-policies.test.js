'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { getBranchPolicies } = require('../lib/ado-get-branch-policies');

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

test('ado-get-branch-policies: missing args reject', async () => {
  await assert.rejects(getBranchPolicies({ project: 'p', repositoryId: 'guid', branch: 'main', pat: 'P' }), /organization/);
  await assert.rejects(getBranchPolicies({ organization: 'o', repositoryId: 'guid', branch: 'main', pat: 'P' }), /project/);
  await assert.rejects(getBranchPolicies({ organization: 'o', project: 'p', branch: 'main', pat: 'P' }), /repositoryId/);
  await assert.rejects(getBranchPolicies({ organization: 'o', project: 'p', repositoryId: 'guid', pat: 'P' }), /branch/);
  await assert.rejects(getBranchPolicies({ organization: 'o', project: 'p', repositoryId: 'guid', branch: 'main' }), /pat or --token/);
});

test('ado-get-branch-policies: happy path parses blocking + non-blocking policies', async () => {
  const s = await createQueuedServer([
    {
      status: 200,
      body: JSON.stringify({
        count: 2,
        value: [
          {
            id: 1,
            isBlocking: true, isEnabled: true,
            type: { id: 'fa4ab', displayName: 'Minimum number of reviewers' },
            settings: { minimumApproverCount: 2 },
          },
          {
            id: 2,
            isBlocking: false, isEnabled: true,
            type: { id: '40e92', displayName: 'Build validation' },
            settings: { buildDefinitionId: 99 },
          },
        ],
      }),
    },
  ]);
  const r = await getBranchPolicies({
    organization: 'o', project: 'p',
    repositoryId: '11111111-2222-3333-4444-555555555555',
    branch: 'main', pat: 'P', baseUrl: serverUrl(s),
  });
  await closeAll(s);
  assert.equal(r.count, 2);
  assert.equal(r.hasBlockingPullRequestPolicy, true);
  assert.equal(r.policies[0].displayName, 'Minimum number of reviewers');
  assert.equal(r.policies[0].requiresMinReviewers, 2);
  assert.equal(r.policies[1].requiresBuild, true);
  // Verify the request URL: /<org>/<proj>/_apis/policy/configurations
  // with repositoryId + refName + api-version query
  assert.match(s.received[0].url, /policy\/configurations/);
  assert.match(s.received[0].url, /repositoryId=11111111/);
  assert.match(s.received[0].url, /refName=refs%2Fheads%2Fmain/);
  assert.match(s.received[0].url, /api-version=7\.0/);
});

test('ado-get-branch-policies: branch prefixed with refs/heads/ is accepted as-is', async () => {
  const s = await createQueuedServer([
    { status: 200, body: JSON.stringify({ count: 0, value: [] }) },
  ]);
  await getBranchPolicies({
    organization: 'o', project: 'p',
    repositoryId: 'guid', branch: 'refs/heads/feature/x',
    pat: 'P', baseUrl: serverUrl(s),
  });
  await closeAll(s);
  assert.match(s.received[0].url, /refName=refs%2Fheads%2Ffeature%2Fx/);
});

test('ado-get-branch-policies: no policies → hasBlockingPullRequestPolicy=false', async () => {
  const s = await createQueuedServer([
    { status: 200, body: JSON.stringify({ count: 0, value: [] }) },
  ]);
  const r = await getBranchPolicies({
    organization: 'o', project: 'p',
    repositoryId: 'guid', branch: 'main', pat: 'P', baseUrl: serverUrl(s),
  });
  await closeAll(s);
  assert.equal(r.count, 0);
  assert.equal(r.hasBlockingPullRequestPolicy, false);
});

test('ado-get-branch-policies: blocking-but-disabled does NOT trip hasBlockingPullRequestPolicy', async () => {
  const s = await createQueuedServer([
    {
      status: 200,
      body: JSON.stringify({
        count: 1,
        value: [
          { id: 1, isBlocking: true, isEnabled: false,
            type: { id: 'fa4ab', displayName: 'Minimum number of reviewers' }, settings: {} },
        ],
      }),
    },
  ]);
  const r = await getBranchPolicies({
    organization: 'o', project: 'p',
    repositoryId: 'guid', branch: 'main', pat: 'P', baseUrl: serverUrl(s),
  });
  await closeAll(s);
  assert.equal(r.hasBlockingPullRequestPolicy, false);
});

test('ado-get-branch-policies: --tokenFile JSON envelope resolves for Authorization header', async () => {
  const fs = require('node:fs'); const path = require('node:path');
  const tokenFile = path.join(__dirname, '.ado-token-ado-get-branch-policies.json');
  fs.writeFileSync(tokenFile, JSON.stringify({ token: 'header.payload.sig' }));
  const s = await createQueuedServer([{ status: 200, body: JSON.stringify({ value: [] }) }]);
  try {
    const r = await getBranchPolicies({ organization: 'o', project: 'p', repositoryId: 'rid', branch: 'main', tokenFile, baseUrl: serverUrl(s) });
    assert.equal(r.count, 0);
    assert.equal(s.received[0].headers.authorization, 'Bearer header.payload.sig');
  } finally { await closeAll(s); fs.rmSync(tokenFile, { force: true }); }
});
