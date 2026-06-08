'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const listPendingChangesPath = require.resolve('../lib/list-pending-changes');
let stubResponses = [];
require.cache[listPendingChangesPath] = {
  id: listPendingChangesPath, filename: listPendingChangesPath, loaded: true,
  exports: { listPendingChanges: async () => stubResponses.shift() || { count: 0, items: [] } },
};

const { revertWorkspace, DEFAULT_ACTION } = require('../lib/revert-workspace');

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

test('revert-workspace: DEFAULT_ACTION export', () => {
  assert.equal(DEFAULT_ACTION, 'RevertGitWorkspace');
});

test('revert-workspace: missing args reject', async () => {
  await assert.rejects(revertWorkspace({ token: 't', solutionUniqueName: 's' }), /envUrl/);
  await assert.rejects(revertWorkspace({ envUrl: 'http://x', token: 't' }), /solutionUniqueName/);
});

test('revert-workspace: happy path polls until changes=0', async () => {
  const s = await createQueuedServer([{ status: 204, body: '' }]);
  stubResponses = [{ count: 5, items: [] }, { count: 0, items: [] }];
  const r = await revertWorkspace({
    envUrl: serverUrl(s), token: 'tok', solutionUniqueName: 'MySol',
    pollIntervalMs: 1, pollMaxAttempts: 5,
  });
  await closeAll(s);
  assert.equal(r.reverted, true);
  assert.equal(r.action, 'RevertGitWorkspace');
  assert.equal(r.polled.reached, true);
  assert.equal(r.polled.finalValue.changesCount, 0);

  const body = JSON.parse(s.received[0].body);
  assert.equal(body.SolutionUniqueName, 'MySol');
  assert.match(s.received[0].url, /\/api\/data\/v9\.2\/RevertGitWorkspace$/);
});

test('revert-workspace: --action override changes endpoint', async () => {
  const s = await createQueuedServer([{ status: 204, body: '' }]);
  stubResponses = [{ count: 0, items: [] }];
  const r = await revertWorkspace({
    envUrl: serverUrl(s), token: 'tok', solutionUniqueName: 'S',
    action: 'DiscardPendingChanges',
    pollIntervalMs: 1, pollMaxAttempts: 2,
  });
  await closeAll(s);
  assert.equal(r.reverted, true);
  assert.match(s.received[0].url, /\/DiscardPendingChanges$/);
});

test('revert-workspace: --skipPoll returns immediately', async () => {
  const s = await createQueuedServer([{ status: 204, body: '' }]);
  stubResponses = [];
  const r = await revertWorkspace({
    envUrl: serverUrl(s), token: 'tok', solutionUniqueName: 'S',
    skipPoll: true,
  });
  await closeAll(s);
  assert.equal(r.polled, null);
});

test('revert-workspace: poll-timeout adds pollWarning', async () => {
  const s = await createQueuedServer([{ status: 204, body: '' }]);
  stubResponses = Array(10).fill({ count: 7, items: [] });
  const r = await revertWorkspace({
    envUrl: serverUrl(s), token: 'tok', solutionUniqueName: 'S',
    pollIntervalMs: 1, pollMaxAttempts: 3,
  });
  await closeAll(s);
  assert.equal(r.polled.reached, false);
  assert.match(r.pollWarning, /did not drop to 0/);
});

test('revert-workspace: HTTP error surfaces envelope', async () => {
  const s = await createQueuedServer([
    { status: 400, body: JSON.stringify({ error: { message: 'Nothing to revert', code: 'IL_NOOP' } }) },
  ]);
  const r = await revertWorkspace({
    envUrl: serverUrl(s), token: 'tok', solutionUniqueName: 'S',
    skipPoll: true,
  });
  await closeAll(s);
  assert.equal(r.error, 'Nothing to revert');
  assert.equal(r.statusCode, 400);
  assert.equal(r.errorCode, 'IL_NOOP');
});
