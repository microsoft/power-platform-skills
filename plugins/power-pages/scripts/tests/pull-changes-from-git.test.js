'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const updatesPath = require.resolve('../lib/list-incoming-updates');
let updatesQueue = [];
require.cache[updatesPath] = {
  id: updatesPath, filename: updatesPath, loaded: true,
  exports: { listIncomingUpdates: async () => updatesQueue.shift() || { count: 0, items: [] } },
};

const { pullChangesFromGit } = require('../lib/pull-changes-from-git');

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

test('pull-changes-from-git: missing envUrl rejects', async () => {
  await assert.rejects(pullChangesFromGit({ token: 't', solutionUniqueName: 's' }), /envUrl/);
});

test('pull-changes-from-git: missing solutionUniqueName rejects', async () => {
  await assert.rejects(pullChangesFromGit({ envUrl: 'http://x', token: 't' }), /solutionUniqueName/);
});

test('pull-changes-from-git: happy path with poll-success (updates drop to 0)', async () => {
  const s = await createQueuedServer([{ status: 204, body: '' }]);
  updatesQueue = [{ count: 2, items: [] }, { count: 0, items: [] }];
  const r = await pullChangesFromGit({
    envUrl: serverUrl(s), token: 'tok', solutionUniqueName: 'MySol',
    pollIntervalMs: 1, pollMaxAttempts: 5,
  });
  await closeAll(s);
  assert.equal(r.pulled, true);
  assert.equal(r.deletedDeletedComponents, false);
  assert.equal(r.polled.reached, true);
  assert.equal(r.polled.finalValue.updatesCount, 0);

  assert.match(s.received[0].url, /\/api\/data\/v9\.2\/PullChangesFromGit$/);
  const body = JSON.parse(s.received[0].body);
  assert.equal(body.SolutionUniqueName, 'MySol');
  assert.equal(body.AdditionalParameters, undefined);
});

test('pull-changes-from-git: --deleteDeletedComponents adds AdditionalParameters', async () => {
  const s = await createQueuedServer([{ status: 204, body: '' }]);
  updatesQueue = [{ count: 0, items: [] }];
  const r = await pullChangesFromGit({
    envUrl: serverUrl(s), token: 'tok', solutionUniqueName: 'S',
    deleteDeletedComponents: true,
    pollIntervalMs: 1, pollMaxAttempts: 2,
  });
  await closeAll(s);
  assert.equal(r.pulled, true);
  assert.equal(r.deletedDeletedComponents, true);
  const body = JSON.parse(s.received[0].body);
  assert.equal(body.AdditionalParameters.DeleteDeletedComponents, true);
});

test('pull-changes-from-git: --skipPoll returns immediately', async () => {
  const s = await createQueuedServer([{ status: 204, body: '' }]);
  updatesQueue = []; // would error if polled
  const r = await pullChangesFromGit({
    envUrl: serverUrl(s), token: 'tok', solutionUniqueName: 'S',
    skipPoll: true,
  });
  await closeAll(s);
  assert.equal(r.polled, null);
});

test('pull-changes-from-git: poll-timeout adds pollWarning', async () => {
  const s = await createQueuedServer([{ status: 204, body: '' }]);
  updatesQueue = Array(10).fill({ count: 3, items: [] });
  const r = await pullChangesFromGit({
    envUrl: serverUrl(s), token: 'tok', solutionUniqueName: 'S',
    pollIntervalMs: 1, pollMaxAttempts: 3,
  });
  await closeAll(s);
  assert.equal(r.polled.reached, false);
  assert.match(r.pollWarning, /did not drop to 0/);
});

test('pull-changes-from-git: HTTP error surfaces envelope', async () => {
  const s = await createQueuedServer([
    { status: 409, body: JSON.stringify({ error: { message: 'Conflicts present', code: 'IL_CONFLICTS' } }) },
  ]);
  const r = await pullChangesFromGit({
    envUrl: serverUrl(s), token: 'tok', solutionUniqueName: 'S',
    skipPoll: true,
  });
  await closeAll(s);
  assert.equal(r.error, 'Conflicts present');
  assert.equal(r.statusCode, 409);
  assert.equal(r.errorCode, 'IL_CONFLICTS');
});
