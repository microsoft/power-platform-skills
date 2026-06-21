'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { resolveConflictAccept, RESOLUTION_ACCEPT_INCOMING } = require('../lib/resolve-conflict-accept');

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

test('resolve-conflict-accept: RESOLUTION_ACCEPT_INCOMING constant is 1', () => {
  assert.equal(RESOLUTION_ACCEPT_INCOMING, 1);
});

test('resolve-conflict-accept: missing args reject', async () => {
  await assert.rejects(resolveConflictAccept({ token: 't', conflictId: 'c' }), /envUrl/);
  await assert.rejects(resolveConflictAccept({ envUrl: 'http://x', token: 't' }), /conflictId/);
});

test('resolve-conflict-accept: happy path uses Resolution=1', async () => {
  const s = await createQueuedServer([{ status: 204, body: '' }]);
  const r = await resolveConflictAccept({
    envUrl: serverUrl(s), token: 'tok', conflictId: 'c-2',
    solutionUniqueName: 'S',
  });
  await closeAll(s);
  assert.equal(r.resolved, true);
  assert.equal(r.outcome, 'accept-incoming');
  assert.equal(r.via, 'resolvegitconflict');
  const body = JSON.parse(s.received[0].body);
  assert.equal(body.Resolution, 1);
  assert.equal(body.ConflictId, 'c-2');
});

test('resolve-conflict-accept: useraction primary path succeeds with resolved solution name', async () => {
  const s = await createQueuedServer([
    { status: 200, body: JSON.stringify({ value: [{ solutionid: 'sol-1' }] }) },
  ]);
  const calls = [];
  const r = await resolveConflictAccept({
    envUrl: serverUrl(s),
    token: 'tok',
    conflictId: 'c-ua',
    solutionUniqueName: 'MySol',
    componentId: 'component-1',
    _resolveUserAction: async (args) => {
      calls.push(args);
      return { ok: true, resolved: true, sourceControlComponentId: 'scc-1', useraction: 2, statusCode: 200 };
    },
  });
  await closeAll(s);
  assert.equal(r.resolved, true);
  assert.equal(r.via, 'useraction');
  assert.equal(r.sourceControlComponentId, 'scc-1');
  assert.equal(r.useraction, 2);
  assert.deepEqual(calls[0], {
    envUrl: serverUrl(s),
    token: 'tok',
    solutionId: 'sol-1',
    componentId: 'component-1',
    decision: 'accept-incoming',
  });
  assert.equal(s.received.length, 1);
  assert.match(s.received[0].url, /\/api\/data\/v9\.2\/solutions\?/);
});

test('resolve-conflict-accept: useraction notFound falls back to ResolveGitConflict', async () => {
  const s = await createQueuedServer([{ status: 204, body: '' }]);
  const r = await resolveConflictAccept({
    envUrl: serverUrl(s),
    token: 'tok',
    conflictId: 'c-fallback',
    solutionId: 'sol-2',
    componentId: 'component-2',
    _resolveUserAction: async () => ({ ok: false, notFound: true, error: 'No matching conflict row' }),
  });
  await closeAll(s);
  assert.equal(r.resolved, true);
  assert.equal(r.via, 'resolvegitconflict');
  const body = JSON.parse(s.received[0].body);
  assert.equal(body.ConflictId, 'c-fallback');
  assert.equal(body.Resolution, 1);
});

test('resolve-conflict-accept: absent ResolveGitConflict action 404 is still surfaced', async () => {
  const s = await createQueuedServer([
    { status: 404, body: JSON.stringify({ error: { message: "Resource not found for the segment 'ResolveGitConflict'.", code: '0x0' } }) },
  ]);
  const r = await resolveConflictAccept({
    envUrl: serverUrl(s), token: 'tok', conflictId: 'c-404',
  });
  await closeAll(s);
  assert.match(r.error, /Resource not found/);
  assert.equal(r.statusCode, 404);
  assert.equal(r.errorCode, '0x0');
  assert.equal(r.via, 'resolvegitconflict');
});

test('resolve-conflict-accept: HTTP error surfaces', async () => {
  const s = await createQueuedServer([
    { status: 500, body: JSON.stringify({ error: { message: 'Internal', code: 'X' } }) },
  ]);
  const r = await resolveConflictAccept({
    envUrl: serverUrl(s), token: 'tok', conflictId: 'c',
  });
  await closeAll(s);
  assert.equal(r.error, 'Internal');
  assert.equal(r.statusCode, 500);
  assert.equal(r.via, 'resolvegitconflict');
});
