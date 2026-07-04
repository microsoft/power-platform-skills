'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { disconnectFromGit } = require('../lib/disconnect-from-git');

function createQueuedServer(responses) {
  const queue = [...responses];
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, body });
      const next = queue.shift();
      if (!next) { res.writeHead(500); res.end('{}'); return; }
      const respBody = typeof next.body === 'string' ? next.body : JSON.stringify(next.body || {});
      res.writeHead(next.statusCode, { 'Content-Type': 'application/json' });
      res.end(respBody);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, received }));
  });
}
function url(s) { const { address, port } = s.address(); return `http://${address}:${port}`; }

test('throws when --envUrl is missing', async () => {
  await assert.rejects(() => disconnectFromGit({}), /envUrl is required/);
});

test('env disconnect: sends empty body and returns scope:"environment"', async () => {
  const { server, received } = await createQueuedServer([{ statusCode: 204, body: '' }]);
  try {
    const r = await disconnectFromGit({ envUrl: url(server), token: 'tok' });
    assert.equal(r.disconnected, true);
    assert.equal(r.scope, 'environment');
    assert.equal(r.solutionUniqueName, null);
    assert.ok(r.calledAt);
    assert.equal(received[0].body, '{}', 'env-scope body must be {}');
  } finally { server.close(); }
});

test('solution disconnect: sends { SolutionUniqueName } and returns scope:"solution"', async () => {
  const { server, received } = await createQueuedServer([{ statusCode: 204, body: '' }]);
  try {
    const r = await disconnectFromGit({
      envUrl: url(server), token: 'tok',
      solutionUniqueName: 'cre48_PowerPagesSite',
    });
    assert.equal(r.scope, 'solution');
    assert.equal(r.solutionUniqueName, 'cre48_PowerPagesSite');
    const sentBody = JSON.parse(received[0].body);
    assert.equal(sentBody.SolutionUniqueName, 'cre48_PowerPagesSite');
  } finally { server.close(); }
});

test('200 response (alt success) also returns disconnected:true', async () => {
  const { server } = await createQueuedServer([{ statusCode: 200, body: { ok: 1 } }]);
  try {
    const r = await disconnectFromGit({ envUrl: url(server), token: 'tok' });
    assert.equal(r.disconnected, true);
  } finally { server.close(); }
});

test('400 response with Dataverse error → propagates message + code', async () => {
  const { server } = await createQueuedServer([{
    statusCode: 400,
    body: { error: { code: '0x80060003', message: 'No active binding to disconnect' } },
  }]);
  try {
    const r = await disconnectFromGit({ envUrl: url(server), token: 'tok' });
    assert.ok(r.error);
    assert.match(r.error, /No active binding/);
    assert.equal(r.statusCode, 400);
    assert.equal(r.errorCode, '0x80060003');
  } finally { server.close(); }
});

test('--verify: confirms binding is gone and sets verifiedUnbound:true', async () => {
  const { server } = await createQueuedServer([
    { statusCode: 204, body: '' }, // disconnect POST
    { statusCode: 200, body: { value: [] } }, // detect-git-binding GET sees no binding
  ]);
  try {
    const r = await disconnectFromGit({ envUrl: url(server), token: 'tok', verify: true });
    assert.equal(r.disconnected, true);
    assert.equal(r.verifiedUnbound, true);
    assert.ok(r.verifiedAt);
  } finally { server.close(); }
});

test('--verify: warns when post-disconnect a binding is still visible (solution-scope partial unbind)', async () => {
  const { server } = await createQueuedServer([
    { statusCode: 204, body: '' },
    {
      statusCode: 200,
      body: {
        value: [{
          gitintegrationid: 'other-sol',
          connectiontype: 0,
          organizationname: 'o', projectname: 'p', repositoryname: 'r',
          branchname: 'main', gitfolder: '/x',
          solutionuniquename: 'OtherSolution',
        }],
      },
    },
  ]);
  try {
    const r = await disconnectFromGit({
      envUrl: url(server), token: 'tok',
      solutionUniqueName: 'cre48_PowerPagesSite',
      verify: true,
    });
    assert.equal(r.disconnected, true);
    assert.equal(r.verifiedUnbound, false);
    assert.ok(r.verifyWarning);
    assert.match(r.verifyWarning, /OTHER solutions|git-sync/);
  } finally { server.close(); }
});

test('network error → returns error', async () => {
  const r = await disconnectFromGit({ envUrl: 'http://127.0.0.1:1', token: 'tok' });
  assert.ok(r.error);
});
