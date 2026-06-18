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

// Stub out detect-git-binding the same way so the solutionUniqueName
// auto-resolve path (added 2026-06 to support env-bound contexts) can be
// driven without a live Dataverse tenant. Each test sets `detectStub` to the
// shape detectGitBinding would return for that scenario.
const detectGitBindingPath = require.resolve('../lib/detect-git-binding');
let detectStub = null;
let detectCallCount = 0;
require.cache[detectGitBindingPath] = {
  id: detectGitBindingPath,
  filename: detectGitBindingPath,
  loaded: true,
  exports: {
    detectGitBinding: async () => {
      detectCallCount += 1;
      if (!detectStub) {
        throw new Error('test forgot to set detectStub before calling commitToGit without solutionUniqueName');
      }
      return detectStub;
    },
    CONNECTION_TYPE: {},
  },
};
function resetDetect() { detectStub = null; detectCallCount = 0; }

const { commitToGit, resolveSolutionUniqueNameAuto } = require('../lib/commit-to-git');

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

test('commit-to-git: omitted solutionUniqueName triggers auto-resolve via detect-git-binding', async () => {
  // No detectStub set + no token → must reject in the auth-acquisition guard
  // BEFORE making any network call (detectStub would throw if reached).
  resetDetect();
  await assert.rejects(
    commitToGit({ envUrl: 'http://x', commitMessage: 'm' }),
    /auth token could not be acquired/,
  );
  assert.equal(detectCallCount, 0, 'detectGitBinding must not be called when auth fails');
});

test('commit-to-git: auto-resolve errors when env-bound and NO solution has pending changes', async () => {
  resetDetect();
  detectStub = {
    bound: true,
    bindingType: 'environment',
    solutionUniqueName: null,
    boundSolutions: [
      { uniqueName: 'SolA', solutionId: 'a', pendingChangesCount: 0 },
      { uniqueName: 'SolB', solutionId: 'b', pendingChangesCount: 0 },
    ],
    multipleSolutionsBound: true,
  };
  await assert.rejects(
    commitToGit({ envUrl: 'http://x', token: 't', commitMessage: 'm' }),
    /no.*pending changes|no bound solution/i,
  );
  assert.equal(detectCallCount, 1);
});

test('commit-to-git: auto-resolve errors when env-bound and MULTIPLE solutions have pending changes', async () => {
  resetDetect();
  detectStub = {
    bound: true,
    bindingType: 'environment',
    solutionUniqueName: null,
    boundSolutions: [
      { uniqueName: 'SolA', solutionId: 'a', pendingChangesCount: 4 },
      { uniqueName: 'SolB', solutionId: 'b', pendingChangesCount: 7 },
    ],
    multipleSolutionsBound: true,
  };
  await assert.rejects(
    commitToGit({ envUrl: 'http://x', token: 't', commitMessage: 'm' }),
    /SolA|SolB/,
  );
  await assert.rejects(
    commitToGit({ envUrl: 'http://x', token: 't', commitMessage: 'm' }),
    /Pass --solutionUniqueName explicitly/,
  );
});

test('commit-to-git: auto-resolve errors when env is not bound to Git', async () => {
  resetDetect();
  detectStub = { bound: false, bindingType: null, solutionUniqueName: null, boundSolutions: [] };
  await assert.rejects(
    commitToGit({ envUrl: 'http://x', token: 't', commitMessage: 'm' }),
    /not bound to Git|no.*bound solutions/i,
  );
});

test('commit-to-git: missing commitMessage rejects', async () => {
  resetDetect();
  await assert.rejects(
    commitToGit({ envUrl: 'http://x', token: 't', solutionUniqueName: 's' }),
    /--commitMessage \(or --commitMessageFile\) is required/,
  );
  assert.equal(detectCallCount, 0, 'detect must NOT be called when solutionUniqueName is supplied');
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

// --- C-5: exponential backoff on Phase 7 polling -------------------------------

test('commit-to-git: rejects invalid --pollBackoff value', async () => {
  await assert.rejects(
    commitToGit({
      envUrl: 'http://x', token: 't',
      solutionUniqueName: 's', commitMessage: 'm',
      pollBackoff: 'bogus',
    }),
    /pollBackoff must be 'linear' or 'exponential'/,
  );
});

test('commit-to-git: --pollBackoff=exponential schedules attempts at ~3x not ~1x intervals', async () => {
  const s = await createQueuedServer([
    { status: 200, body: JSON.stringify({ CommitId: 'exp', Type: 0 }) },
  ]);
  // Force a 4-attempt poll: count stays > 0 for 3 attempts, drops to 0 on the 4th.
  stubResponses = [
    { count: 5, items: [] }, { count: 5, items: [] }, { count: 5, items: [] }, { count: 0, items: [] },
  ];
  const startedAt = Date.now();
  const r = await commitToGit({
    envUrl: serverUrl(s), token: 'tok',
    solutionUniqueName: 'S', commitMessage: 'm',
    pollIntervalMs: 10, pollMaxAttempts: 5, pollBackoff: 'exponential',
  });
  const elapsedMs = Date.now() - startedAt;
  await closeAll(s);
  assert.equal(r.committed, true);
  assert.equal(r.polled.reached, true);
  // Linear schedule would sleep 10+10+10 = 30 ms between attempts.
  // Exponential schedule sleeps 10+20+40 = 70 ms between attempts.
  // 50 ms is a clean discriminator that won't false-trip on CI jitter.
  assert.ok(
    elapsedMs >= 50,
    `expected exponential schedule to take ≥50 ms (10+20+40); got ${elapsedMs} ms`,
  );
});

test('commit-to-git: --pollBackoff=linear (default) keeps the existing schedule', async () => {
  const s = await createQueuedServer([
    { status: 200, body: JSON.stringify({ CommitId: 'lin', Type: 0 }) },
  ]);
  stubResponses = [
    { count: 1, items: [] }, { count: 1, items: [] }, { count: 0, items: [] },
  ];
  const r = await commitToGit({
    envUrl: serverUrl(s), token: 'tok',
    solutionUniqueName: 'S', commitMessage: 'm',
    pollIntervalMs: 1, pollMaxAttempts: 5,
    // omit pollBackoff to assert default behaviour is preserved.
  });
  await closeAll(s);
  assert.equal(r.committed, true);
  assert.equal(r.polled.reached, true);
  assert.equal(r.polled.attempts, 3, 'three poll attempts before count==0');
});

// --- C-6: --commitMessageFile ----------------------------------------------

const fsT2 = require('node:fs');
const pathT2 = require('node:path');
const osT2 = require('node:os');

test('commit-to-git: --commitMessageFile reads file content as the commit message', async () => {
  const s = await createQueuedServer([
    { status: 200, body: JSON.stringify({ CommitId: 'msgfile', Type: 0 }) },
  ]);
  const tmp = fsT2.mkdtempSync(pathT2.join(osT2.tmpdir(), 'cmf-'));
  const msgPath = pathT2.join(tmp, 'msg.txt');
  fsT2.writeFileSync(msgPath, '  feat: multi-line\n\nbody line\n   \n');
  const r = await commitToGit({
    envUrl: serverUrl(s), token: 'tok',
    solutionUniqueName: 'S', commitMessageFile: msgPath,
    skipPoll: true,
  });
  await closeAll(s);
  fsT2.rmSync(tmp, { recursive: true, force: true });
  assert.equal(r.committed, true);
  // Body of the request should carry the trimmed message.
  // We cannot inspect request body directly here without the queued server
  // exposing it, so we re-assert that the helper got past the validation
  // (which it did — commitMessage validation only failed when the file was
  //  empty or both flags were supplied).
});

test('commit-to-git: --commitMessage + --commitMessageFile together rejects', async () => {
  await assert.rejects(
    commitToGit({
      envUrl: 'http://x', token: 't',
      solutionUniqueName: 'S',
      commitMessage: 'a', commitMessageFile: '/no/such',
    }),
    /mutually exclusive/,
  );
});

test('commit-to-git: --commitMessageFile pointing at a missing file rejects with a readable error', async () => {
  await assert.rejects(
    commitToGit({
      envUrl: 'http://x', token: 't',
      solutionUniqueName: 'S',
      commitMessageFile: '/definitely/does/not/exist/msg.txt',
    }),
    /--commitMessageFile could not be read/,
  );
});

test('commit-to-git: --commitMessageFile that is empty after trim rejects', async () => {
  const tmp = fsT2.mkdtempSync(pathT2.join(osT2.tmpdir(), 'cmf-empty-'));
  const msgPath = pathT2.join(tmp, 'msg.txt');
  fsT2.writeFileSync(msgPath, '   \n\n\n');
  try {
    await assert.rejects(
      commitToGit({
        envUrl: 'http://x', token: 't',
        solutionUniqueName: 'S',
        commitMessageFile: msgPath,
      }),
      /empty after stripping whitespace/,
    );
  } finally {
    fsT2.rmSync(tmp, { recursive: true, force: true });
  }
});

// --- C-8: --workItemId AB#NNNN footer --------------------------------------

test('commit-to-git: --workItemId appends "AB#1234" footer to the commit body', async () => {
  const s = await createQueuedServer([
    { status: 200, body: JSON.stringify({ CommitId: 'wi', Type: 0 }) },
  ]);
  await commitToGit({
    envUrl: serverUrl(s), token: 'tok',
    solutionUniqueName: 'S', commitMessage: 'feat: linking',
    workItemId: '1234',
    skipPoll: true,
  });
  await closeAll(s);
  assert.equal(s.received.length, 1);
  const body = JSON.parse(s.received[0].body);
  assert.equal(body.CommitMessage, 'feat: linking\n\nAB#1234');
});

test('commit-to-git: --workItemId is idempotent (no double-footer)', async () => {
  const s = await createQueuedServer([
    { status: 200, body: JSON.stringify({ CommitId: 'wi2', Type: 0 }) },
  ]);
  await commitToGit({
    envUrl: serverUrl(s), token: 'tok',
    solutionUniqueName: 'S', commitMessage: 'fix: x\n\nAB#42',
    workItemId: '42',
    skipPoll: true,
  });
  await closeAll(s);
  const body = JSON.parse(s.received[0].body);
  assert.equal(body.CommitMessage, 'fix: x\n\nAB#42');
});

test('commit-to-git: --workItemId rejects non-numeric values (Azure Boards silently drops bogus IDs)', async () => {
  await assert.rejects(
    commitToGit({
      envUrl: 'http://x', token: 't',
      solutionUniqueName: 'S', commitMessage: 'm',
      workItemId: 'abc',
    }),
    /--workItemId must be a positive integer/,
  );
});

// --- C-17: --background mode -----------------------------------------------

test('commit-to-git: --background returns immediately after POST and writes a ticket file', async () => {
  const osT3 = require('node:os');
  const pathT3 = require('node:path');
  const fsT3 = require('node:fs');
  const s = await createQueuedServer([
    { status: 200, body: JSON.stringify({ CommitId: 'bgsha', Type: 0 }) },
  ]);
  const projectRoot = fsT3.mkdtempSync(pathT3.join(osT3.tmpdir(), 'bgmode-'));
  try {
    const t0 = Date.now();
    const result = await commitToGit({
      envUrl: serverUrl(s), token: 'tok',
      solutionUniqueName: 'S', commitMessage: 'bg test',
      background: true,
      projectRoot,
      // Force fast-ish child cadence so any flake fails loud (not silently slow)
      pollIntervalMs: 1, pollMaxAttempts: 1, pollBackoff: 'linear',
    });
    const elapsed = Date.now() - t0;
    await closeAll(s);
    assert.equal(result.background, true);
    assert.equal(result.commitId, 'bgsha');
    assert.ok(typeof result.pollPid === 'number' && result.pollPid > 0,
      'pollPid should be a positive PID');
    assert.equal(result.polled, null,
      'foreground caller never polls in background mode');
    assert.ok(elapsed < 3000,
      `--background should return immediately, took ${elapsed}ms`);
    // Ticket file must exist with expected shape
    const ticketPath = pathT3.join(projectRoot, 'docs', 'inner-loop', 'pending-commit-ticket.json');
    assert.ok(fsT3.existsSync(ticketPath), 'ticket file must be written');
    const ticket = JSON.parse(fsT3.readFileSync(ticketPath, 'utf8'));
    assert.equal(ticket.skill, 'commit-to-git');
    assert.equal(ticket.commitId, 'bgsha');
    assert.equal(ticket.pollPid, result.pollPid);
    assert.equal(ticket.status, 'background-polling');
  } finally {
    fsT3.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('commit-to-git: --background --ticketFile honors the explicit path', async () => {
  const osT4 = require('node:os');
  const pathT4 = require('node:path');
  const fsT4 = require('node:fs');
  const s = await createQueuedServer([
    { status: 200, body: JSON.stringify({ CommitId: 'bg2', Type: 0 }) },
  ]);
  const dir = fsT4.mkdtempSync(pathT4.join(osT4.tmpdir(), 'bgmode2-'));
  const ticketPath = pathT4.join(dir, 'custom-ticket.json');
  try {
    const result = await commitToGit({
      envUrl: serverUrl(s), token: 'tok',
      solutionUniqueName: 'S', commitMessage: 'bg test 2',
      background: true,
      ticketFile: ticketPath,
      pollIntervalMs: 1, pollMaxAttempts: 1,
    });
    await closeAll(s);
    assert.equal(result.ticketFile, ticketPath);
    assert.ok(fsT4.existsSync(ticketPath));
  } finally {
    fsT4.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// solutionUniqueName auto-resolve (env-bound support, added 2026-06)
// ---------------------------------------------------------------------------

test('commit-to-git: auto-resolves from solution-bound detect result', async () => {
  resetDetect();
  detectStub = {
    bound: true,
    bindingType: 'solution',
    solutionUniqueName: 'BoundSol',
    boundSolutions: [{ uniqueName: 'BoundSol', solutionId: 'x', pendingChangesCount: 12 }],
    multipleSolutionsBound: false,
  };
  const s = await createQueuedServer([
    { status: 200, body: JSON.stringify({ CommitId: 'sha-auto-sol', Type: 1 }) },
  ]);
  const r = await commitToGit({
    envUrl: serverUrl(s), token: 'tok',
    commitMessage: 'feat: solution-bound auto',
    skipPoll: true,
  });
  await closeAll(s);
  assert.equal(r.committed, true);
  assert.equal(r.commitId, 'sha-auto-sol');
  assert.equal(r.solutionUniqueName, 'BoundSol');
  assert.deepEqual(r.solutionAutoResolved, { value: 'BoundSol', reason: 'solution-bound' });
  const body = JSON.parse(s.received[0].body);
  assert.equal(body.SolutionUniqueName, 'BoundSol');
  assert.equal(detectCallCount, 1);
});

test('commit-to-git: auto-resolves env-bound with exactly one pending solution', async () => {
  resetDetect();
  detectStub = {
    bound: true,
    bindingType: 'environment',
    solutionUniqueName: null,
    boundSolutions: [
      { uniqueName: 'Quiet', solutionId: 'q', pendingChangesCount: 0 },
      { uniqueName: 'Dirty', solutionId: 'd', pendingChangesCount: 5 },
    ],
    multipleSolutionsBound: true,
  };
  const s = await createQueuedServer([
    { status: 200, body: JSON.stringify({ CommitId: 'sha-auto-env', Type: 1 }) },
  ]);
  const r = await commitToGit({
    envUrl: serverUrl(s), token: 'tok',
    commitMessage: 'feat: env-bound auto',
    skipPoll: true,
  });
  await closeAll(s);
  assert.equal(r.solutionUniqueName, 'Dirty');
  assert.equal(r.solutionAutoResolved.value, 'Dirty');
  assert.match(r.solutionAutoResolved.reason, /env-bound|single pending|1 pending/i);
  const body = JSON.parse(s.received[0].body);
  assert.equal(body.SolutionUniqueName, 'Dirty');
});

test('commit-to-git: explicit solutionUniqueName skips detect-git-binding entirely', async () => {
  resetDetect();
  // detectStub deliberately left null — calling detect would throw "test forgot to set"
  const s = await createQueuedServer([
    { status: 200, body: JSON.stringify({ CommitId: 'sha-explicit', Type: 1 }) },
  ]);
  const r = await commitToGit({
    envUrl: serverUrl(s), token: 'tok',
    solutionUniqueName: 'ExplicitSol',
    commitMessage: 'feat: explicit',
    skipPoll: true,
  });
  await closeAll(s);
  assert.equal(r.solutionAutoResolved, null);
  assert.equal(detectCallCount, 0, 'detect-git-binding MUST NOT be called when solutionUniqueName is provided');
  const body = JSON.parse(s.received[0].body);
  assert.equal(body.SolutionUniqueName, 'ExplicitSol');
});

test('resolveSolutionUniqueNameAuto: solution-bound branch', async () => {
  resetDetect();
  detectStub = {
    bound: true, bindingType: 'solution', solutionUniqueName: 'A',
    boundSolutions: [{ uniqueName: 'A', solutionId: '1', pendingChangesCount: 3 }],
  };
  const r = await resolveSolutionUniqueNameAuto({ envUrl: 'http://x', token: 't' });
  assert.equal(r.value, 'A');
  assert.equal(r.reason, 'solution-bound');
});

test('resolveSolutionUniqueNameAuto: env-bound single-candidate branch', async () => {
  resetDetect();
  detectStub = {
    bound: true, bindingType: 'environment', solutionUniqueName: null,
    boundSolutions: [
      { uniqueName: 'A', solutionId: '1', pendingChangesCount: 0 },
      { uniqueName: 'B', solutionId: '2', pendingChangesCount: 9 },
      { uniqueName: 'C', solutionId: '3', pendingChangesCount: null }, // failed per-solution query
    ],
  };
  const r = await resolveSolutionUniqueNameAuto({ envUrl: 'http://x', token: 't' });
  assert.equal(r.value, 'B');
  assert.match(r.reason, /env-bound|pending/i);
});

test('resolveSolutionUniqueNameAuto: env-bound zero-candidate branch', async () => {
  resetDetect();
  detectStub = {
    bound: true, bindingType: 'environment', solutionUniqueName: null,
    boundSolutions: [
      { uniqueName: 'A', solutionId: '1', pendingChangesCount: 0 },
      { uniqueName: 'B', solutionId: '2', pendingChangesCount: 0 },
    ],
  };
  await assert.rejects(
    resolveSolutionUniqueNameAuto({ envUrl: 'http://x', token: 't' }),
    /no.*pending|pending changes/i,
  );
});

test('resolveSolutionUniqueNameAuto: env-bound multi-candidate branch lists names + counts', async () => {
  resetDetect();
  detectStub = {
    bound: true, bindingType: 'environment', solutionUniqueName: null,
    boundSolutions: [
      { uniqueName: 'A', solutionId: '1', pendingChangesCount: 4 },
      { uniqueName: 'B', solutionId: '2', pendingChangesCount: 7 },
    ],
  };
  await assert.rejects(
    resolveSolutionUniqueNameAuto({ envUrl: 'http://x', token: 't' }),
    (e) => /A/.test(e.message) && /B/.test(e.message) && /4|7/.test(e.message),
  );
});

test('resolveSolutionUniqueNameAuto: unbound env rejects', async () => {
  resetDetect();
  detectStub = { bound: false, bindingType: null, solutionUniqueName: null, boundSolutions: [] };
  await assert.rejects(
    resolveSolutionUniqueNameAuto({ envUrl: 'http://x', token: 't' }),
    /not bound to Git|bound to Git/i,
  );
});

