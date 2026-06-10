'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// Stub out list-pending-changes BEFORE requiring commit-to-git so the poll loop
// uses our stub instead of making real HTTP calls.
const listPendingChangesPath = require.resolve('../lib/list-pending-changes');
let stubResponses = [];
require.cache[listPendingChangesPath] = {
  id: listPendingChangesPath,
  filename: listPendingChangesPath,
  loaded: true,
  exports: {
    listPendingChanges: async () => {
      const next = stubResponses.shift();
      if (!next) return { count: 0, items: [] };
      return next;
    },
  },
};

const { commitToGit } = require('../lib/commit-to-git');

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

test('commit-to-git: missing solutionUniqueName rejects', async () => {
  await assert.rejects(
    commitToGit({ envUrl: 'http://x', token: 't', commitMessage: 'm' }),
    /--solutionUniqueName is required/,
  );
});

test('commit-to-git: missing commitMessage rejects', async () => {
  await assert.rejects(
    commitToGit({ envUrl: 'http://x', token: 't', solutionUniqueName: 's' }),
    /--commitMessage is required/,
  );
});

test('commit-to-git: missing envUrl rejects', async () => {
  await assert.rejects(
    commitToGit({ token: 't', solutionUniqueName: 's', commitMessage: 'm' }),
    /--envUrl is required/,
  );
});

test('commit-to-git: happy path with poll-success (changes drop to 0)', async () => {
  const s = await createQueuedServer([
    { status: 200, body: JSON.stringify({ CommitId: 'abc123', Type: 1 }) },
  ]);
  stubResponses = [{ count: 1, items: [] }, { count: 0, items: [] }];
  const r = await commitToGit({
    envUrl: serverUrl(s), token: 'tok',
    solutionUniqueName: 'MySol', commitMessage: 'feat: x',
    pollIntervalMs: 1, pollMaxAttempts: 5,
  });
  await closeAll(s);
  assert.equal(r.committed, true);
  assert.equal(r.commitId, 'abc123');
  assert.equal(r.type, 1);
  assert.equal(r.polled.reached, true);
  assert.equal(r.polled.finalValue.changesCount, 0);

  // Verify request shape
  assert.equal(s.received.length, 1);
  assert.equal(s.received[0].method, 'POST');
  assert.match(s.received[0].url, /\/api\/data\/v9\.2\/CommitToGit$/);
  const body = JSON.parse(s.received[0].body);
  assert.equal(body.CommitMessage, 'feat: x');
  assert.equal(body.SolutionUniqueName, 'MySol');
});

test('commit-to-git: --skipPoll returns immediately without polling', async () => {
  const s = await createQueuedServer([
    { status: 200, body: JSON.stringify({ CommitId: 'def', Type: 0 }) },
  ]);
  stubResponses = []; // would error if polled
  const r = await commitToGit({
    envUrl: serverUrl(s), token: 'tok',
    solutionUniqueName: 'S', commitMessage: 'm',
    skipPoll: true,
  });
  await closeAll(s);
  assert.equal(r.committed, true);
  assert.equal(r.polled, null);
});

test('commit-to-git: poll-timeout adds pollWarning', async () => {
  const s = await createQueuedServer([
    { status: 200, body: JSON.stringify({ CommitId: 'x', Type: 0 }) },
  ]);
  stubResponses = Array(10).fill({ count: 5, items: [] });
  const r = await commitToGit({
    envUrl: serverUrl(s), token: 'tok',
    solutionUniqueName: 'S', commitMessage: 'm',
    pollIntervalMs: 1, pollMaxAttempts: 3,
  });
  await closeAll(s);
  assert.equal(r.committed, true);
  assert.equal(r.polled.reached, false);
  assert.match(r.pollWarning, /did not drop to 0/);
});

test('commit-to-git: HTTP error surfaces error envelope', async () => {
  const s = await createQueuedServer([
    { status: 400, body: JSON.stringify({ error: { message: 'No pending changes', code: '0x80048d05' } }) },
  ]);
  const r = await commitToGit({
    envUrl: serverUrl(s), token: 'tok',
    solutionUniqueName: 'S', commitMessage: 'm',
    skipPoll: true,
  });
  await closeAll(s);
  assert.equal(r.error, 'No pending changes');
  assert.equal(r.statusCode, 400);
  assert.equal(r.errorCode, '0x80048d05');
});

test('commit-to-git: non-JSON 200 body returns parse error', async () => {
  const s = await createQueuedServer([
    { status: 200, body: 'not json' },
  ]);
  const r = await commitToGit({
    envUrl: serverUrl(s), token: 'tok',
    solutionUniqueName: 'S', commitMessage: 'm',
    skipPoll: true,
  });
  await closeAll(s);
  assert.match(r.error, /returned 200 but body was not JSON/);
});

test('commit-to-git: accepts lower-cased commitid field', async () => {
  const s = await createQueuedServer([
    { status: 200, body: JSON.stringify({ commitid: 'lower', type: 0 }) },
  ]);
  const r = await commitToGit({
    envUrl: serverUrl(s), token: 'tok',
    solutionUniqueName: 'S', commitMessage: 'm',
    skipPoll: true,
  });
  await closeAll(s);
  assert.equal(r.commitId, 'lower');
  assert.equal(r.type, 0);
});

// Regression for the 2026-06 "helper gives up before the server is done" bug.
// Before the fix, commit-to-git.js called makeRequest without overriding the
// 15 s default socket timeout — a CommitToGit POST that took 25 s to write a
// small first-commit returned { error: 'Request timed out' } even though the
// server had succeeded. This test pins the helper-level fix: the source MUST
// import LONG_RUNNING_GIT_ACTION_TIMEOUT_MS from validation-helpers AND pass
// it as socketTimeoutMs on the /CommitToGit POST.
test('commit-to-git: passes socketTimeoutMs: LONG_RUNNING_GIT_ACTION_TIMEOUT_MS to makeRequest (regression for the 15 s helper timeout false-fail)', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('../lib/commit-to-git.js'), 'utf8');

  assert.match(
    src,
    /\{[^}]*\bLONG_RUNNING_GIT_ACTION_TIMEOUT_MS\b[^}]*\}\s*=\s*require\(['"]\.\/validation-helpers['"]\)/,
    'commit-to-git.js must destructure LONG_RUNNING_GIT_ACTION_TIMEOUT_MS from validation-helpers — otherwise the long-running override would be undefined at runtime.',
  );
  assert.match(
    src,
    /makeRequest\(\{[\s\S]*?\bsocketTimeoutMs:\s*LONG_RUNNING_GIT_ACTION_TIMEOUT_MS\b[\s\S]*?\}\)/,
    'commit-to-git.js must pass socketTimeoutMs: LONG_RUNNING_GIT_ACTION_TIMEOUT_MS to the CommitToGit POST. Removing this line re-introduces the bug where a 25-s+ server reply surfaces { error: "Request timed out" } even after the commit succeeded.',
  );
});
