'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// Stub list-incoming-updates + list-conflicts before requiring the helper.
const updatesPath = require.resolve('../lib/list-incoming-updates');
const conflictsPath = require.resolve('../lib/list-conflicts');
let updatesQueue = [];
let conflictsQueue = [];
require.cache[updatesPath] = {
  id: updatesPath, filename: updatesPath, loaded: true,
  exports: { listIncomingUpdates: async () => updatesQueue.shift() || { count: 0, items: [] } },
};
require.cache[conflictsPath] = {
  id: conflictsPath, filename: conflictsPath, loaded: true,
  exports: { listConflicts: async () => conflictsQueue.shift() || { count: 0, items: [] } },
};

const { refreshChangesFromGit } = require('../lib/refresh-changes-from-git');

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

test('refresh-changes-from-git: missing envUrl rejects', async () => {
  await assert.rejects(refreshChangesFromGit({ token: 't', solutionUniqueName: 's' }), /envUrl/);
});

test('refresh-changes-from-git: missing solutionUniqueName rejects', async () => {
  await assert.rejects(refreshChangesFromGit({ envUrl: 'http://x', token: 't' }), /solutionUniqueName/);
});

test('refresh-changes-from-git: happy path returns 204', async () => {
  const s = await createQueuedServer([{ status: 204, body: '' }]);
  const r = await refreshChangesFromGit({
    envUrl: serverUrl(s), token: 'tok', solutionUniqueName: 'MySol',
  });
  await closeAll(s);
  assert.equal(r.refreshed, true);
  assert.equal(r.solutionUniqueName, 'MySol');
  assert.equal(r.polled, null);
  assert.equal(s.received[0].method, 'POST');
  assert.match(s.received[0].url, /\/api\/data\/v9\.2\/RefreshChangesFromGit$/);
  const body = JSON.parse(s.received[0].body);
  assert.equal(body.SolutionUniqueName, 'MySol');
});

test('refresh-changes-from-git: 200 also treated as success', async () => {
  const s = await createQueuedServer([{ status: 200, body: '' }]);
  const r = await refreshChangesFromGit({
    envUrl: serverUrl(s), token: 'tok', solutionUniqueName: 'S',
  });
  await closeAll(s);
  assert.equal(r.refreshed, true);
});

test('refresh-changes-from-git: HTTP error surfaces envelope', async () => {
  const s = await createQueuedServer([
    { status: 404, body: JSON.stringify({ error: { message: 'Solution not bound', code: 'IL_NOT_BOUND' } }) },
  ]);
  const r = await refreshChangesFromGit({
    envUrl: serverUrl(s), token: 'tok', solutionUniqueName: 'S',
  });
  await closeAll(s);
  assert.equal(r.error, 'Solution not bound');
  assert.equal(r.statusCode, 404);
  assert.equal(r.errorCode, 'IL_NOT_BOUND');
});

test('refresh-changes-from-git: --waitForPopulation polls and stops when updates appear', async () => {
  const s = await createQueuedServer([{ status: 204, body: '' }]);
  updatesQueue = [{ count: 0, items: [] }, { count: 3, items: [] }];
  conflictsQueue = [{ count: 0, items: [] }, { count: 0, items: [] }];
  const r = await refreshChangesFromGit({
    envUrl: serverUrl(s), token: 'tok', solutionUniqueName: 'S',
    waitForPopulation: 5,
  });
  await closeAll(s);
  assert.equal(r.refreshed, true);
  assert.equal(r.polled.reached, true);
  assert.equal(r.polled.finalValue.updatesCount, 3);
});

test('refresh-changes-from-git: --waitForPopulation polls and times out when nothing appears', async () => {
  const s = await createQueuedServer([{ status: 204, body: '' }]);
  updatesQueue = Array(20).fill({ count: 0, items: [] });
  conflictsQueue = Array(20).fill({ count: 0, items: [] });
  const r = await refreshChangesFromGit({
    envUrl: serverUrl(s), token: 'tok', solutionUniqueName: 'S',
    waitForPopulation: 0.01,
  });
  await closeAll(s);
  assert.equal(r.polled.reached, false);
});
