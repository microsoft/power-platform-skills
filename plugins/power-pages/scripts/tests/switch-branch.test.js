'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { switchBranch } = require('../lib/switch-branch');

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

function envBindingRow(branch = 'main', overrides = {}) {
  return {
    gitintegrationid: 'binding-1',
    connectiontype: 1,
    organizationname: 'contoso',
    projectname: 'pp-site',
    repositoryname: 'pp-repo',
    branchname: branch,
    gitfolder: '/site-name',
    ...overrides,
  };
}

// ===== Arg validation =====

test('throws when --envUrl is missing', async () => {
  await assert.rejects(() => switchBranch({ newBranch: 'b' }), /envUrl is required/);
});

test('throws when --newBranch is missing', async () => {
  await assert.rejects(() => switchBranch({ envUrl: 'http://x' }), /newBranch is required/);
});

// ===== Pre-check failures =====

test('returns error when no existing binding is found', async () => {
  const { server } = await createQueuedServer([
    { statusCode: 200, body: { value: [] } }, // detect → no binding
  ]);
  try {
    const r = await switchBranch({ envUrl: url(server), token: 'tok', newBranch: 'feature/x' });
    assert.ok(r.error);
    assert.match(r.error, /setup-git-integration/);
  } finally { server.close(); }
});

test('returns error when existing binding is a solution binding (not env)', async () => {
  const { server } = await createQueuedServer([
    {
      statusCode: 200,
      body: {
        value: [envBindingRow('main', {
          connectiontype: 0,
          solutionuniquename: 'cre48_PowerPagesSite',
        })],
      },
    },
  ]);
  try {
    const r = await switchBranch({ envUrl: url(server), token: 'tok', newBranch: 'feature/x' });
    assert.ok(r.error);
    assert.match(r.error, /environment bindings|solution bindings/);
  } finally { server.close(); }
});

test('returns error when already on the requested branch', async () => {
  const { server } = await createQueuedServer([
    { statusCode: 200, body: { value: [envBindingRow('main')] } },
  ]);
  try {
    const r = await switchBranch({ envUrl: url(server), token: 'tok', newBranch: 'main' });
    assert.ok(r.error);
    assert.match(r.error, /Already bound/);
  } finally { server.close(); }
});

// ===== Happy path =====

test('happy path: detect → disconnect → reconnect → returns switched:true with both timestamps', async () => {
  const { server } = await createQueuedServer([
    { statusCode: 200, body: { value: [envBindingRow('main')] } }, // detect
    { statusCode: 204, body: '' }, // disconnect
    { statusCode: 204, body: '' }, // reconnect (new branch)
  ]);
  try {
    const r = await switchBranch({
      envUrl: url(server), token: 'tok',
      newBranch: 'feature/about-page',
    });
    assert.equal(r.switched, true);
    assert.equal(r.previousBranch, 'main');
    assert.equal(r.newBranch, 'feature/about-page');
    assert.equal(r.organization, 'contoso');
    assert.equal(r.project, 'pp-site');
    assert.equal(r.repository, 'pp-repo');
    assert.equal(r.gitFolder, '/site-name');
    assert.ok(r.disconnectedAt);
    assert.ok(r.reconnectedAt);
  } finally { server.close(); }
});

// ===== Failure during disconnect =====

test('disconnect fails: returns error with phase:"disconnect", does NOT attempt reconnect', async () => {
  const { server, received } = await createQueuedServer([
    { statusCode: 200, body: { value: [envBindingRow('main')] } }, // detect
    { statusCode: 500, body: { error: { message: 'service unavailable' } } }, // disconnect fail
  ]);
  try {
    const r = await switchBranch({
      envUrl: url(server), token: 'tok',
      newBranch: 'feature/x',
    });
    assert.ok(r.error);
    assert.equal(r.phase, 'disconnect');
    assert.equal(received.length, 2, 'should not attempt the reconnect after disconnect fails');
  } finally { server.close(); }
});

// ===== Failure during reconnect with successful rollback =====

test('reconnect fails: attempts rollback to the original branch', async () => {
  const { server, received } = await createQueuedServer([
    { statusCode: 200, body: { value: [envBindingRow('main')] } }, // detect
    { statusCode: 204, body: '' }, // disconnect ok
    { statusCode: 400, body: { error: { message: 'branch not found' } } }, // reconnect fails
    { statusCode: 204, body: '' }, // rollback succeeds
  ]);
  try {
    const r = await switchBranch({
      envUrl: url(server), token: 'tok',
      newBranch: 'feature/nonexistent',
    });
    assert.ok(r.error);
    assert.equal(r.phase, 'reconnect');
    assert.equal(r.rolledBack, true);
    assert.equal(r.previousBranch, 'main');
    assert.equal(r.attemptedBranch, 'feature/nonexistent');
    assert.equal(received.length, 4, 'should make 4 requests: detect + disconnect + reconnect + rollback');

    // Verify rollback request used the original branch.
    const rollbackBody = JSON.parse(received[3].body);
    assert.equal(rollbackBody.Branch, 'main');
  } finally { server.close(); }
});

test('reconnect fails AND rollback fails: surfaces both errors', async () => {
  const { server } = await createQueuedServer([
    { statusCode: 200, body: { value: [envBindingRow('main')] } },
    { statusCode: 204, body: '' }, // disconnect ok
    { statusCode: 400, body: { error: { message: 'reconnect fail' } } },
    { statusCode: 500, body: { error: { message: 'rollback fail' } } },
  ]);
  try {
    const r = await switchBranch({
      envUrl: url(server), token: 'tok',
      newBranch: 'feature/x',
    });
    assert.ok(r.error);
    assert.equal(r.phase, 'reconnect');
    assert.equal(r.rolledBack, false);
    assert.ok(r.rollbackError);
    assert.match(r.rollbackError, /rollback fail/);
  } finally { server.close(); }
});

test('network error on initial detect → returns pre-check error', async () => {
  const r = await switchBranch({
    envUrl: 'http://127.0.0.1:1', token: 'tok', newBranch: 'feature/x',
  });
  assert.ok(r.error);
  assert.match(r.error, /Pre-check failed/);
});
