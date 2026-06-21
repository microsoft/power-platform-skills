'use strict';

const { withNoAdoAcquire } = require('./ado-test-helpers');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { commitFiles, resolveBranchTip, normalizeBranchRef } = require('../lib/ado-commit-file');

function createQueuedServer(responses) {
  const queue = [...responses];
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, body });
      const next = queue.shift() || { status: 500, body: '' };
      res.writeHead(next.status, next.headers || { 'Content-Type': 'application/json' });
      res.end(next.body || '');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, received })));
}
const serverUrl = (s) => `http://127.0.0.1:${s.port}`;
const closeAll = (...ss) => Promise.all(ss.map(s => new Promise(r => s.server.close(r))));

const REFS = (sha) => ({ status: 200, body: JSON.stringify({ value: [{ name: 'refs/heads/feature/dev-a', objectId: sha }] }) });
const PUSH_OK = (commitId) => ({ status: 201, body: JSON.stringify({ pushId: 42, commits: [{ commitId }] }) });

test('normalizeBranchRef adds refs/heads', () => {
  assert.equal(normalizeBranchRef('feature/dev-a'), 'refs/heads/feature/dev-a');
  assert.equal(normalizeBranchRef('refs/heads/main'), 'refs/heads/main');
});

test('commitFiles: missing args reject', async () => {
  const base = { project: 'p', repository: 'r', branch: 'b', comment: 'c', changes: [{ path: '/a', content: 'x' }], pat: 'P' };
  await assert.rejects(commitFiles({ ...base, organization: undefined }), /organization/);
  await assert.rejects(commitFiles({ ...base, organization: 'o', project: undefined }), /project/);
  await assert.rejects(commitFiles({ organization: 'o', project: 'p', repository: 'r', branch: 'b', comment: 'c', pat: 'P', changes: [] }), /non-empty array/);
  await assert.rejects(commitFiles({ organization: 'o', project: 'p', repository: 'r', branch: 'b', comment: 'c', pat: 'P', changes: [{ content: 'x' }] }), /path is required/);
  await assert.rejects(commitFiles({ organization: 'o', project: 'p', repository: 'r', branch: 'b', comment: 'c', pat: 'P', changes: [{ path: '/a', content: 5 }] }), /content must be a string/);
  await assert.rejects(commitFiles({ organization: 'o', project: 'p', repository: 'r', branch: 'b', comment: 'c', pat: 'P', changes: [{ path: '/a', content: 'x', changeType: 'delete' }] }), /changeType must be edit\|add/);
  await assert.rejects(
    withNoAdoAcquire(() => commitFiles({ organization: 'o', project: 'p', repository: 'r', branch: 'b', comment: 'c', changes: [{ path: '/a', content: 'x' }] })),
    /pat or --token/,
  );
});

test('commitFiles: resolves branch tip then pushes with edit changeType + rawtext', async () => {
  const s = await createQueuedServer([REFS('a'.repeat(40)), PUSH_OK('c'.repeat(40))]);
  const r = await commitFiles({
    organization: 'o', project: 'p', repository: 'r', branch: 'feature/dev-a',
    comment: 'merge: Search', changes: [{ path: '/solutions/RetailOS/x.webtemplate.source.html', content: 'MERGED' }],
    pat: 'P', baseUrl: serverUrl(s),
  });
  await closeAll(s);
  assert.equal(r.ok, true);
  assert.equal(r.commitId, 'c'.repeat(40));
  assert.equal(r.pushId, 42);
  assert.equal(r.fileCount, 1);
  // refs resolved first, then push
  assert.match(s.received[0].url, /\/refs/);
  assert.match(s.received[1].url, /\/pushes/);
  const pushBody = JSON.parse(s.received[1].body);
  assert.equal(pushBody.refUpdates[0].oldObjectId, 'a'.repeat(40));
  assert.equal(pushBody.refUpdates[0].name, 'refs/heads/feature/dev-a');
  assert.equal(pushBody.commits[0].changes[0].changeType, 'edit');
  assert.equal(pushBody.commits[0].changes[0].newContent.contentType, 'rawtext');
  assert.equal(pushBody.commits[0].changes[0].item.path, '/solutions/RetailOS/x.webtemplate.source.html');
});

test('commitFiles: supplied oldObjectId skips the refs call', async () => {
  const s = await createQueuedServer([PUSH_OK('d'.repeat(40))]);
  const r = await commitFiles({
    organization: 'o', project: 'p', repository: 'r', branch: 'feature/dev-a',
    comment: 'm', changes: [{ path: '/a', content: 'X' }], oldObjectId: 'b'.repeat(40),
    pat: 'P', baseUrl: serverUrl(s),
  });
  await closeAll(s);
  assert.equal(r.ok, true);
  assert.match(s.received[0].url, /\/pushes/); // first call is the push (no refs lookup)
  const pushBody = JSON.parse(s.received[0].body);
  assert.equal(pushBody.refUpdates[0].oldObjectId, 'b'.repeat(40));
});

test('commitFiles: multiple files in one commit (single batch apply)', async () => {
  const s = await createQueuedServer([PUSH_OK('e'.repeat(40))]);
  const r = await commitFiles({
    organization: 'o', project: 'p', repository: 'r', branch: 'b', comment: 'batch',
    oldObjectId: 'f'.repeat(40), pat: 'P', baseUrl: serverUrl(s),
    changes: [
      { path: '/a.html', content: 'A' },
      { path: '/b.html', content: 'B', changeType: 'add' },
    ],
  });
  await closeAll(s);
  assert.equal(r.fileCount, 2);
  const pushBody = JSON.parse(s.received[0].body);
  assert.equal(pushBody.commits[0].changes.length, 2);
  assert.equal(pushBody.commits[0].changes[1].changeType, 'add');
});

test('commitFiles: path without leading slash gets one', async () => {
  const s = await createQueuedServer([PUSH_OK('1'.repeat(40))]);
  await commitFiles({
    organization: 'o', project: 'p', repository: 'r', branch: 'b', comment: 'm',
    oldObjectId: '2'.repeat(40), changes: [{ path: 'no/slash.html', content: 'X' }],
    pat: 'P', baseUrl: serverUrl(s),
  });
  await closeAll(s);
  const pushBody = JSON.parse(s.received[0].body);
  assert.equal(pushBody.commits[0].changes[0].item.path, '/no/slash.html');
});

test('commitFiles: push conflict (409) returns error envelope', async () => {
  const s = await createQueuedServer([
    { status: 409, body: JSON.stringify({ message: 'TF401028: The reference has already been updated', typeKey: 'GitConflictException' }) },
  ]);
  const r = await commitFiles({
    organization: 'o', project: 'p', repository: 'r', branch: 'b', comment: 'm',
    oldObjectId: '3'.repeat(40), changes: [{ path: '/a', content: 'X' }],
    pat: 'P', baseUrl: serverUrl(s),
  });
  await closeAll(s);
  assert.equal(r.ok, false);
  assert.equal(r.statusCode, 409);
  assert.match(r.error, /already been updated/);
  assert.equal(r.errorCode, 'GitConflictException');
});

test('commitFiles: branch tip not found surfaces a clear error', async () => {
  const s = await createQueuedServer([{ status: 200, body: JSON.stringify({ value: [] }) }]);
  const r = await commitFiles({
    organization: 'o', project: 'p', repository: 'r', branch: 'ghost', comment: 'm',
    changes: [{ path: '/a', content: 'X' }], pat: 'P', baseUrl: serverUrl(s),
  });
  await closeAll(s);
  assert.equal(r.ok, false);
  assert.match(r.error, /Could not resolve branch tip/);
});

test('resolveBranchTip: returns objectId for exact branch', async () => {
  const s = await createQueuedServer([REFS('9'.repeat(40))]);
  const { createAdoClient } = require('../lib/ado-client');
  const client = createAdoClient({ organization: 'o', project: 'p', repository: 'r', pat: 'P', baseUrl: serverUrl(s) });
  const t = await resolveBranchTip(client, 'feature/dev-a');
  await closeAll(s);
  assert.equal(t.found, true);
  assert.equal(t.objectId, '9'.repeat(40));
});
