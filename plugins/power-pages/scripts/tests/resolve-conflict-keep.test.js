'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { resolveConflictKeep, RESOLUTION_KEEP_ENV } = require('../lib/resolve-conflict-keep');

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

test('resolve-conflict-keep: RESOLUTION_KEEP_ENV constant is 0', () => {
  assert.equal(RESOLUTION_KEEP_ENV, 0);
});

test('resolve-conflict-keep: missing envUrl rejects', async () => {
  await assert.rejects(resolveConflictKeep({ token: 't', conflictId: 'c' }), /envUrl/);
});

test('resolve-conflict-keep: missing conflictId rejects', async () => {
  await assert.rejects(resolveConflictKeep({ envUrl: 'http://x', token: 't' }), /conflictId/);
});

test('resolve-conflict-keep: happy path returns 204', async () => {
  const s = await createQueuedServer([{ status: 204, body: '' }]);
  const r = await resolveConflictKeep({
    envUrl: serverUrl(s), token: 'tok', conflictId: 'conf-1',
    solutionUniqueName: 'MySol',
  });
  await closeAll(s);
  assert.equal(r.resolved, true);
  assert.equal(r.conflictId, 'conf-1');
  assert.equal(r.outcome, 'keep-environment');
  assert.equal(r.action, 'ResolveGitConflict');
  assert.equal(r.via, 'resolvegitconflict');

  const body = JSON.parse(s.received[0].body);
  assert.equal(body.ConflictId, 'conf-1');
  assert.equal(body.Resolution, 0);
  assert.equal(body.SolutionUniqueName, 'MySol');
  assert.match(s.received[0].url, /\/api\/data\/v9\.2\/ResolveGitConflict$/);
});

test('resolve-conflict-keep: --action override changes endpoint', async () => {
  const s = await createQueuedServer([{ status: 204, body: '' }]);
  const r = await resolveConflictKeep({
    envUrl: serverUrl(s), token: 'tok', conflictId: 'c',
    action: 'KeepEnvironmentVersion',
  });
  await closeAll(s);
  assert.equal(r.resolved, true);
  assert.equal(r.action, 'KeepEnvironmentVersion');
  assert.equal(r.via, 'resolvegitconflict');
  assert.match(s.received[0].url, /\/api\/data\/v9\.2\/KeepEnvironmentVersion$/);
});

test('resolve-conflict-keep: useraction primary path succeeds with resolved solution name', async () => {
  const s = await createQueuedServer([
    { status: 200, body: JSON.stringify({ value: [{ solutionid: 'sol-keep' }] }) },
  ]);
  const calls = [];
  const r = await resolveConflictKeep({
    envUrl: serverUrl(s),
    token: 'tok',
    conflictId: 'keep-ua',
    solutionUniqueName: 'KeepSol',
    componentId: 'component-keep',
    _resolveUserAction: async (args) => {
      calls.push(args);
      return { ok: true, resolved: true, sourceControlComponentId: 'scc-keep', useraction: 1, statusCode: 200 };
    },
  });
  await closeAll(s);
  assert.equal(r.resolved, true);
  assert.equal(r.via, 'useraction');
  assert.equal(r.sourceControlComponentId, 'scc-keep');
  assert.equal(r.useraction, 1);
  assert.deepEqual(calls[0], {
    envUrl: serverUrl(s),
    token: 'tok',
    solutionId: 'sol-keep',
    componentId: 'component-keep',
    decision: 'keep-current',
  });
  assert.equal(s.received.length, 1);
  assert.match(s.received[0].url, /\/api\/data\/v9\.2\/solutions\?/);
});

test('resolve-conflict-keep: useraction notFound falls back to ResolveGitConflict', async () => {
  const s = await createQueuedServer([{ status: 204, body: '' }]);
  const r = await resolveConflictKeep({
    envUrl: serverUrl(s),
    token: 'tok',
    conflictId: 'keep-fallback',
    solutionId: 'sol-keep-2',
    componentId: 'component-keep-2',
    _resolveUserAction: async () => ({ ok: false, notFound: true, error: 'No matching conflict row' }),
  });
  await closeAll(s);
  assert.equal(r.resolved, true);
  assert.equal(r.via, 'resolvegitconflict');
  const body = JSON.parse(s.received[0].body);
  assert.equal(body.ConflictId, 'keep-fallback');
  assert.equal(body.Resolution, 0);
});

test('resolve-conflict-keep: absent ResolveGitConflict action 404 is still surfaced', async () => {
  const s = await createQueuedServer([
    { status: 404, body: JSON.stringify({ error: { message: "Resource not found for the segment 'ResolveGitConflict'.", code: '0x0' } }) },
  ]);
  const r = await resolveConflictKeep({
    envUrl: serverUrl(s), token: 'tok', conflictId: 'keep-404',
  });
  await closeAll(s);
  assert.match(r.error, /Resource not found/);
  assert.equal(r.statusCode, 404);
  assert.equal(r.errorCode, '0x0');
  assert.equal(r.via, 'resolvegitconflict');
});

test('resolve-conflict-keep: HTTP error surfaces envelope', async () => {
  const s = await createQueuedServer([
    { status: 404, body: JSON.stringify({ error: { message: 'Conflict not found', code: 'IL_CONFLICT_404' } }) },
  ]);
  const r = await resolveConflictKeep({
    envUrl: serverUrl(s), token: 'tok', conflictId: 'gone',
  });
  await closeAll(s);
  assert.equal(r.error, 'Conflict not found');
  assert.equal(r.statusCode, 404);
  assert.equal(r.errorCode, 'IL_CONFLICT_404');
  assert.equal(r.via, 'resolvegitconflict');
});
