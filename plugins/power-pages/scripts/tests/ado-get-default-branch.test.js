'use strict';

const { withNoAdoAcquire } = require('./ado-test-helpers');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { getDefaultBranch } = require('../lib/ado-get-default-branch');

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

test('ado-get-default-branch: missing args reject', async () => {
  await assert.rejects(getDefaultBranch({ project: 'p', repository: 'r', pat: 'P' }), /organization/);
  await assert.rejects(getDefaultBranch({ organization: 'o', repository: 'r', pat: 'P' }), /project/);
  await assert.rejects(getDefaultBranch({ organization: 'o', project: 'p', pat: 'P' }), /repository/);
  await assert.rejects(withNoAdoAcquire(() => getDefaultBranch({ organization: 'o', project: 'p', repository: 'r' })), /pat or --token/);
});

test('ado-get-default-branch: happy path returns short branch name + GUID', async () => {
  const s = await createQueuedServer([
    {
      status: 200,
      body: JSON.stringify({
        id: '11111111-2222-3333-4444-555555555555',
        name: 'srijan-pp-alm',
        defaultBranch: 'refs/heads/main',
      }),
    },
  ]);
  const r = await getDefaultBranch({
    organization: 'o', project: 'p', repository: 'r',
    pat: 'P', baseUrl: serverUrl(s),
  });
  await closeAll(s);
  assert.equal(r.defaultBranch, 'main');
  assert.equal(r.defaultBranchRef, 'refs/heads/main');
  assert.equal(r.repositoryId, '11111111-2222-3333-4444-555555555555');
});

test('ado-get-default-branch: defaultBranch missing returns null (not error)', async () => {
  const s = await createQueuedServer([
    { status: 200, body: JSON.stringify({ id: 'guid', name: 'r' }) },
  ]);
  const r = await getDefaultBranch({
    organization: 'o', project: 'p', repository: 'r',
    pat: 'P', baseUrl: serverUrl(s),
  });
  await closeAll(s);
  assert.equal(r.defaultBranch, null);
  assert.equal(r.defaultBranchRef, null);
});

test('ado-get-default-branch: 404 returns error envelope', async () => {
  const s = await createQueuedServer([
    { status: 404, body: JSON.stringify({ message: 'TF401019: repo not found' }) },
  ]);
  const r = await getDefaultBranch({
    organization: 'o', project: 'p', repository: 'r',
    pat: 'P', baseUrl: serverUrl(s),
  });
  await closeAll(s);
  assert.equal(r.statusCode, 404);
  assert.match(r.error, /repo not found/);
});

test('ado-get-default-branch: --tokenFile JSON envelope resolves for Authorization header', async () => {
  const fs = require('node:fs'); const path = require('node:path');
  const tokenFile = path.join(__dirname, '.ado-token-ado-get-default-branch.json');
  fs.writeFileSync(tokenFile, JSON.stringify({ token: 'header.payload.sig' }));
  const s = await createQueuedServer([{ status: 200, body: JSON.stringify({ id: 'rid', defaultBranch: 'refs/heads/main' }) }]);
  try {
    const r = await getDefaultBranch({ organization: 'o', project: 'p', repository: 'r', tokenFile, baseUrl: serverUrl(s) });
    assert.equal(r.defaultBranch, 'main');
    assert.equal(s.received[0].headers.authorization, 'Bearer header.payload.sig');
  } finally { await closeAll(s); fs.rmSync(tokenFile, { force: true }); }
});
