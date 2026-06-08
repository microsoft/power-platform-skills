'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { revertBranch, SHA_REGEX } = require('../lib/revert-branch');

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

const FORTY = 'a'.repeat(40);
const FORTY_B = 'b'.repeat(40);

test('revert-branch: SHA_REGEX matches 40-char hex', () => {
  assert.ok(SHA_REGEX.test(FORTY));
  assert.ok(!SHA_REGEX.test('short'));
  assert.ok(!SHA_REGEX.test('z'.repeat(40)));
});

test('revert-branch: missing organization rejects', async () => {
  await assert.rejects(
    revertBranch({ project: 'p', repository: 'r', branch: 'b', currentSha: FORTY, targetSha: FORTY_B, pat: 'x' }),
    /organization/,
  );
});

test('revert-branch: missing project rejects', async () => {
  await assert.rejects(
    revertBranch({ organization: 'o', repository: 'r', branch: 'b', currentSha: FORTY, targetSha: FORTY_B, pat: 'x' }),
    /project/,
  );
});

test('revert-branch: missing currentSha rejects', async () => {
  await assert.rejects(
    revertBranch({ organization: 'o', project: 'p', repository: 'r', branch: 'b', targetSha: FORTY_B, pat: 'x' }),
    /currentSha/,
  );
});

test('revert-branch: invalid SHA rejects', async () => {
  await assert.rejects(
    revertBranch({ organization: 'o', project: 'p', repository: 'r', branch: 'b', currentSha: 'short', targetSha: FORTY_B, pat: 'x' }),
    /currentSha must be a 40-character SHA/,
  );
});

test('revert-branch: missing both pat and token rejects', async () => {
  await assert.rejects(
    revertBranch({ organization: 'o', project: 'p', repository: 'r', branch: 'b', currentSha: FORTY, targetSha: FORTY_B }),
    /Either --pat or --token is required/,
  );
});

test('revert-branch: happy path with PAT', async () => {
  const s = await createQueuedServer([
    { status: 200, body: JSON.stringify({ value: [{ success: true, repositoryId: 'repo-guid', oldObjectId: FORTY, newObjectId: FORTY_B }] }) },
  ]);
  const r = await revertBranch({
    organization: 'myorg', project: 'myproj', repository: 'myrepo', branch: 'feature/x',
    currentSha: FORTY, targetSha: FORTY_B,
    pat: 'PAT-XYZ',
    baseUrl: serverUrl(s),
  });
  await closeAll(s);
  assert.equal(r.reset, true);
  assert.equal(r.branch, 'refs/heads/feature/x');
  assert.equal(r.organization, 'myorg');
  assert.equal(r.oldSha, FORTY);
  assert.equal(r.newSha, FORTY_B);

  const req = s.received[0];
  assert.equal(req.method, 'POST');
  assert.match(req.url, /\/myproj\/_apis\/git\/repositories\/myrepo\/refs\?api-version=7\.0$/);
  // PAT: base64("user:PAT") wrapped in "Basic"
  assert.match(req.headers.authorization, /^Basic /);
  const decoded = Buffer.from(req.headers.authorization.slice('Basic '.length), 'base64').toString('utf8');
  assert.match(decoded, /:PAT-XYZ$/);
  const body = JSON.parse(req.body);
  assert.equal(body.length, 1);
  assert.equal(body[0].name, 'refs/heads/feature/x');
  assert.equal(body[0].oldObjectId, FORTY);
  assert.equal(body[0].newObjectId, FORTY_B);
});

test('revert-branch: bearer token sends Authorization: Bearer', async () => {
  const s = await createQueuedServer([
    { status: 200, body: JSON.stringify({ value: [{ success: true }] }) },
  ]);
  // JWT-shaped token (≥2 dots) so buildAuthHeader detects OAuth not PAT
  const jwt = 'eyJhbGciOi.eyJzdWIi.SIG';
  const r = await revertBranch({
    organization: 'o', project: 'p', repository: 'r', branch: 'main',
    currentSha: FORTY, targetSha: FORTY_B,
    token: jwt,
    baseUrl: serverUrl(s),
  });
  await closeAll(s);
  assert.equal(r.reset, true);
  assert.equal(s.received[0].headers.authorization, `Bearer ${jwt}`);
});

test('revert-branch: refs/heads/ prefix is preserved', async () => {
  const s = await createQueuedServer([
    { status: 200, body: JSON.stringify({ value: [{ success: true }] }) },
  ]);
  const r = await revertBranch({
    organization: 'o', project: 'p', repository: 'r', branch: 'refs/heads/already-prefixed',
    currentSha: FORTY, targetSha: FORTY_B,
    pat: 'P',
    baseUrl: serverUrl(s),
  });
  await closeAll(s);
  assert.equal(r.branch, 'refs/heads/already-prefixed');
});

test('revert-branch: ADO error with per-ref success=false surfaces', async () => {
  const s = await createQueuedServer([
    {
      status: 200, // ADO returns 200 even for failed updates; per-ref result has success=false
      body: JSON.stringify({
        value: [{
          success: false,
          customMessage: 'Cannot update because newObjectId is not a descendant of oldObjectId',
        }],
      }),
    },
  ]);
  const r = await revertBranch({
    organization: 'o', project: 'p', repository: 'r', branch: 'main',
    currentSha: FORTY, targetSha: FORTY_B,
    pat: 'P',
    baseUrl: serverUrl(s),
  });
  await closeAll(s);
  assert.match(r.error, /not a descendant/);
  assert.equal(r.adoResult.success, false);
});

test('revert-branch: HTTP 404 surfaces error envelope', async () => {
  const s = await createQueuedServer([
    { status: 404, body: JSON.stringify({ message: 'Repository not found', typeKey: 'RepositoryNotFoundException' }) },
  ]);
  const r = await revertBranch({
    organization: 'o', project: 'p', repository: 'r', branch: 'main',
    currentSha: FORTY, targetSha: FORTY_B,
    pat: 'P',
    baseUrl: serverUrl(s),
  });
  await closeAll(s);
  assert.equal(r.error, 'Repository not found');
  assert.equal(r.statusCode, 404);
  assert.equal(r.errorCode, 'RepositoryNotFoundException');
});
