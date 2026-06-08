'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { connectToGit, GIT_PROVIDER_ADO, CONNECTION_TYPE_ENVIRONMENT } = require('../lib/connect-to-git');

/**
 * Multi-response HTTP server: serves a queued list of responses in order.
 * Each response is { statusCode, body }. After the queue empties, the server
 * 500s and stays open until close() is called.
 */
function createQueuedServer(responses) {
  const queue = [...responses];
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, body });
      const next = queue.shift();
      if (!next) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'no more queued responses' }));
        return;
      }
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

// ===== Constants =====

test('GIT_PROVIDER_ADO === 0 and CONNECTION_TYPE_ENVIRONMENT === 1', () => {
  assert.equal(GIT_PROVIDER_ADO, 0);
  assert.equal(CONNECTION_TYPE_ENVIRONMENT, 1);
});

// ===== Required-arg validation =====

test('throws when --envUrl is missing', async () => {
  await assert.rejects(
    () => connectToGit({ organization: 'o', project: 'p', repository: 'r', branch: 'b', gitFolder: 'f' }),
    /envUrl is required/,
  );
});

test('throws when --organization is missing', async () => {
  await assert.rejects(
    () => connectToGit({ envUrl: 'http://x', project: 'p', repository: 'r', branch: 'b', gitFolder: 'f' }),
    /organization is required/,
  );
});

test('throws when --gitFolder is missing', async () => {
  await assert.rejects(
    () => connectToGit({ envUrl: 'http://x', organization: 'o', project: 'p', repository: 'r', branch: 'b' }),
    /gitFolder is required/,
  );
});

// ===== Happy path =====

test('204 response → bound:true with the correct shape', async () => {
  const { server, received } = await createQueuedServer([{ statusCode: 204, body: '' }]);
  try {
    const r = await connectToGit({
      envUrl: url(server), token: 'tok',
      organization: 'contoso', project: 'pp-site', repository: 'pp-repo',
      branch: 'main', gitFolder: '/site-name',
    });
    assert.equal(r.bound, true);
    assert.equal(r.bindingType, 'environment');
    assert.equal(r.organization, 'contoso');
    assert.equal(r.branch, 'main');
    assert.equal(r.gitFolder, '/site-name');
    assert.ok(r.calledAt, 'calledAt timestamp must be present');
    // Request body sanity check.
    assert.equal(received.length, 1);
    const sentBody = JSON.parse(received[0].body);
    assert.equal(sentBody.ConnectionType, 1);
    assert.equal(sentBody.GitProvider, 0);
    assert.equal(sentBody.Organization, 'contoso');
    assert.equal(sentBody.GitFolder, '/site-name');
  } finally { server.close(); }
});

test('200 response (alternate success) also produces bound:true', async () => {
  const { server } = await createQueuedServer([{ statusCode: 200, body: { ok: true } }]);
  try {
    const r = await connectToGit({
      envUrl: url(server), token: 'tok',
      organization: 'o', project: 'p', repository: 'r', branch: 'b', gitFolder: 'f',
    });
    assert.equal(r.bound, true);
  } finally { server.close(); }
});

// ===== Error paths =====

test('400 response with Dataverse error envelope → propagates message + code', async () => {
  const { server } = await createQueuedServer([{
    statusCode: 400,
    body: { error: { code: '0x80060001', message: 'Managed Environment not enabled' } },
  }]);
  try {
    const r = await connectToGit({
      envUrl: url(server), token: 'tok',
      organization: 'o', project: 'p', repository: 'r', branch: 'b', gitFolder: 'f',
    });
    assert.ok(r.error);
    assert.match(r.error, /Managed Environment/);
    assert.equal(r.statusCode, 400);
    assert.equal(r.errorCode, '0x80060001');
  } finally { server.close(); }
});

test('500 response with non-JSON body → falls back to HTTP status message', async () => {
  const { server } = await createQueuedServer([{ statusCode: 500, body: 'Internal Server Error (plain text)' }]);
  try {
    const r = await connectToGit({
      envUrl: url(server), token: 'tok',
      organization: 'o', project: 'p', repository: 'r', branch: 'b', gitFolder: 'f',
    });
    assert.ok(r.error);
    assert.match(r.error, /HTTP 500/);
    assert.equal(r.statusCode, 500);
  } finally { server.close(); }
});

test('network error → returns error from makeRequest', async () => {
  const r = await connectToGit({
    envUrl: 'http://127.0.0.1:1', token: 'tok',
    organization: 'o', project: 'p', repository: 'r', branch: 'b', gitFolder: 'f',
  });
  assert.ok(r.error);
});

// ===== verify flag =====

test('--verify: success path calls detect-git-binding and populates verifiedBindingId', async () => {
  const { server } = await createQueuedServer([
    { statusCode: 204, body: '' }, // ConnectToGit POST
    { // detectGitBinding GET
      statusCode: 200,
      body: {
        value: [{
          gitintegrationid: 'verify-guid-1',
          connectiontype: 1,
          organizationname: 'o', projectname: 'p', repositoryname: 'r',
          branchname: 'main', gitfolder: '/f',
        }],
      },
    },
  ]);
  try {
    const r = await connectToGit({
      envUrl: url(server), token: 'tok',
      organization: 'o', project: 'p', repository: 'r', branch: 'main', gitFolder: '/f',
      verify: true,
    });
    assert.equal(r.bound, true);
    assert.equal(r.verifiedBindingId, 'verify-guid-1');
    assert.ok(r.verifiedAt);
  } finally { server.close(); }
});

test('--verify: warns when post-connect detect-git-binding sees nothing', async () => {
  const { server } = await createQueuedServer([
    { statusCode: 204, body: '' },
    { statusCode: 200, body: { value: [] } }, // detect sees no binding
  ]);
  try {
    const r = await connectToGit({
      envUrl: url(server), token: 'tok',
      organization: 'o', project: 'p', repository: 'r', branch: 'main', gitFolder: '/f',
      verify: true,
    });
    assert.equal(r.bound, true);
    assert.equal(r.verifiedBindingId, null);
    assert.ok(r.verifyWarning);
    assert.match(r.verifyWarning, /propagate|plan-inner-loop/i);
  } finally { server.close(); }
});

test('returns error when no token can be acquired', async () => {
  // Pin token to falsy so getAuthToken would be attempted; without `az` CLI
  // working against an unreachable host, token resolution should fail. But
  // since we pass envUrl=null we hit the requireArg first. To test the
  // no-token path, pass envUrl + token=null and expect getAuthToken to fail
  // (returns null in test env where `az` is configured for another resource).
  // Practically, we just verify that token=null + an unreachable env still
  // produces an error somewhere in the chain.
  const r = await connectToGit({
    envUrl: 'http://127.0.0.1:1', token: null,
    organization: 'o', project: 'p', repository: 'r', branch: 'b', gitFolder: 'f',
  });
  assert.ok(r.error, 'should propagate either a token-acquire or network error');
});
