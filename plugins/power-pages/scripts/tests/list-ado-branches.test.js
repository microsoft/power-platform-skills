'use strict';

const { withNoAdoAcquire } = require('./ado-test-helpers');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { listAdoBranches, stripHeads } = require('../lib/list-ado-branches');

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

test('stripHeads removes refs/heads/ prefix', () => {
  assert.equal(stripHeads('refs/heads/main'), 'main');
  assert.equal(stripHeads('refs/heads/feature/x'), 'feature/x');
  assert.equal(stripHeads('main'), 'main');
});

test('list-ado-branches: missing args reject', async () => {
  await assert.rejects(listAdoBranches({ project: 'p', repository: 'r', pat: 'P' }), /organization/);
  await assert.rejects(listAdoBranches({ organization: 'o', repository: 'r', pat: 'P' }), /project/);
  await assert.rejects(listAdoBranches({ organization: 'o', project: 'p', pat: 'P' }), /repository/);
  await assert.rejects(withNoAdoAcquire(() => listAdoBranches({ organization: 'o', project: 'p', repository: 'r' })), /pat or --token/);
});

test('list-ado-branches: happy path returns sorted short names', async () => {
  const s = await createQueuedServer([
    {
      status: 200,
      body: JSON.stringify({
        value: [
          { name: 'refs/heads/main', objectId: 'a' },
          { name: 'refs/heads/feature/zeta', objectId: 'b' },
          { name: 'refs/heads/feature/alpha', objectId: 'c' },
        ],
        count: 3,
      }),
    },
  ]);
  const r = await listAdoBranches({
    organization: 'o', project: 'p', repository: 'r',
    pat: 'P', baseUrl: serverUrl(s),
  });
  await closeAll(s);
  assert.equal(r.ok, true);
  assert.equal(r.count, 3);
  assert.deepEqual(r.branches, ['feature/alpha', 'feature/zeta', 'main']);
  assert.match(s.received[0].url, /\/refs/);
  assert.match(s.received[0].url, /filter=heads/);
});

test('list-ado-branches: echoes the default branch (short) for picker default-marking', async () => {
  const s = await createQueuedServer([
    { status: 200, body: JSON.stringify({ value: [{ name: 'refs/heads/main' }], count: 1 }) },
  ]);
  const r = await listAdoBranches({
    organization: 'o', project: 'p', repository: 'r',
    pat: 'P', baseUrl: serverUrl(s), defaultBranch: 'refs/heads/main',
  });
  await closeAll(s);
  assert.equal(r.defaultBranch, 'main');
});

test('list-ado-branches: empty repo (no heads) returns emptyRepo:true', async () => {
  const s = await createQueuedServer([
    { status: 200, body: JSON.stringify({ value: [], count: 0 }) },
  ]);
  const r = await listAdoBranches({
    organization: 'o', project: 'p', repository: 'r',
    pat: 'P', baseUrl: serverUrl(s),
  });
  await closeAll(s);
  assert.equal(r.ok, true);
  assert.equal(r.count, 0);
  assert.deepEqual(r.branches, []);
  assert.equal(r.emptyRepo, true);
});

test('list-ado-branches: non-2xx returns ok:false error envelope', async () => {
  const s = await createQueuedServer([
    { status: 404, body: JSON.stringify({ message: 'repo not found', typeKey: 'GitRepositoryNotFoundException' }) },
  ]);
  const r = await listAdoBranches({
    organization: 'o', project: 'p', repository: 'r',
    pat: 'P', baseUrl: serverUrl(s),
  });
  await closeAll(s);
  assert.equal(r.ok, false);
  assert.equal(r.statusCode, 404);
  assert.match(r.error, /repo not found/);
});

test('list-ado-branches: resolves token via --tokenFile envelope (no --pat)', async () => {
  const s = await createQueuedServer([
    { status: 200, body: JSON.stringify({ value: [{ name: 'refs/heads/main' }], count: 1 }) },
  ]);
  // Reuse the ADO_TOKEN env path to exercise resolve-ado-token without a real file.
  const prev = process.env.ADO_TOKEN;
  process.env.ADO_TOKEN = 'env-bearer';
  try {
    const r = await listAdoBranches({
      organization: 'o', project: 'p', repository: 'r', baseUrl: serverUrl(s),
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.branches, ['main']);
  } finally {
    if (prev === undefined) delete process.env.ADO_TOKEN; else process.env.ADO_TOKEN = prev;
    await closeAll(s);
  }
});
