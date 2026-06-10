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

// Mirrors envBindingRow but for solution bindings (connectiontype=0). The
// legacy `gitintegrations` detection path returns a row with `solutionuniquename`
// populated and exposes per-solution `branchname` / `gitfolder` directly, so
// tests can stay at "1 HTTP call per detect probe" — matching the env shape.
function solutionBindingRow(solutionUniqueName, branch = 'main', overrides = {}) {
  return {
    gitintegrationid: `solbind-${solutionUniqueName}`,
    connectiontype: 0,
    organizationname: 'contoso',
    projectname: 'pp-site',
    repositoryname: 'pp-repo',
    branchname: branch,
    gitfolder: solutionUniqueName,
    rootfolder: 'solutions',
    solutionuniquename: solutionUniqueName,
    ...overrides,
  };
}

// Fast test hooks so polling/retry loops don't slow the suite.
const FAST = { _pollDelayMs: 1, _maxPollMs: 50, _retryDelayMs: 1, _maxReconnectRetries: 3 };

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
    const r = await switchBranch({ envUrl: url(server), token: 'tok', newBranch: 'feature/x', ...FAST });
    assert.ok(r.error);
    assert.match(r.error, /setup-git-integration/);
  } finally { server.close(); }
});

test('returns error when already on the requested branch', async () => {
  const { server } = await createQueuedServer([
    { statusCode: 200, body: { value: [envBindingRow('main')] } },
  ]);
  try {
    const r = await switchBranch({ envUrl: url(server), token: 'tok', newBranch: 'main', ...FAST });
    assert.ok(r.error);
    assert.match(r.error, /Already bound/);
  } finally { server.close(); }
});

// ===== Happy path — environment binding =====

test('env binding happy path: detect → disconnect → reconnect → returns switched:true with both timestamps', async () => {
  const { server } = await createQueuedServer([
    { statusCode: 200, body: { value: [envBindingRow('main')] } }, // detect
    { statusCode: 204, body: '' }, // disconnect
    { statusCode: 204, body: '' }, // reconnect (new branch)
  ]);
  try {
    const r = await switchBranch({
      envUrl: url(server), token: 'tok',
      newBranch: 'feature/about-page',
      ...FAST,
    });
    assert.equal(r.switched, true);
    assert.equal(r.bindingType, 'environment');
    assert.equal(r.solutionUniqueName, null);
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
      ...FAST,
    });
    assert.ok(r.error);
    assert.equal(r.phase, 'disconnect');
    assert.equal(received.length, 2, 'should not attempt the reconnect after disconnect fails');
  } finally { server.close(); }
});

// ===== Failure during reconnect with successful rollback (env binding) =====

test('env binding reconnect fails: attempts rollback to the original branch', async () => {
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
      ...FAST,
    });
    assert.ok(r.error);
    assert.equal(r.phase, 'reconnect');
    assert.equal(r.bindingType, 'environment');
    assert.equal(r.rolledBack, true);
    assert.equal(r.previousBranch, 'main');
    assert.equal(r.attemptedBranch, 'feature/nonexistent');
    assert.equal(received.length, 4, 'should make 4 requests: detect + disconnect + reconnect + rollback');

    const rollbackBody = JSON.parse(received[3].body);
    assert.equal(rollbackBody.Branch, 'main');
  } finally { server.close(); }
});

test('env binding reconnect fails AND rollback fails: surfaces both errors', async () => {
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
      ...FAST,
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
    ...FAST,
  });
  assert.ok(r.error);
  assert.match(r.error, /Pre-check failed/);
});

// =====================================================================
// ===== Solution binding tests ========================================
// =====================================================================
//
// HTTP-call accounting for the legacy `gitintegrations` detect path:
//   1. detect (env-scoped, no filter)                          → 1 call
//   2. detect (scoped to resolvedSolution)                     → 1 call
//   3. disconnect                                              → 1 call
//   4. detect after disconnect (scoped, returns bound:false)   → 1 call  ← poll-clear
//   5. connectSolutionToGit → detectGitBinding (subsequent?)   → 1 call
//   6. connectSolutionToGit → POST                             → 1 call
//                                                       TOTAL: 6 calls

test('solution binding happy path (single solution): auto-picks solution, switches branch', async () => {
  const { server, received } = await createQueuedServer([
    // 1. detect (env-scoped) — only SolutionA is bound
    { statusCode: 200, body: { value: [solutionBindingRow('SolutionA', 'main')] } },
    // 2. detect (scoped to SolutionA)
    { statusCode: 200, body: { value: [solutionBindingRow('SolutionA', 'main')] } },
    // 3. disconnect
    { statusCode: 204, body: '' },
    // 4. detect after disconnect (poll-clear)
    { statusCode: 200, body: { value: [] } },
    // 5. connectSolutionToGit's internal detectGitBinding (no other bindings → first-binding shape)
    { statusCode: 200, body: { value: [] } },
    // 6. connectSolutionToGit POST
    { statusCode: 204, body: '' },
  ]);
  try {
    const r = await switchBranch({
      envUrl: url(server), token: 'tok',
      newBranch: 'feature/intern-learning-data-model',
      ...FAST,
    });
    assert.equal(r.switched, true, `expected switched:true, got ${JSON.stringify(r)}`);
    assert.equal(r.bindingType, 'solution');
    assert.equal(r.solutionUniqueName, 'SolutionA');
    assert.equal(r.previousBranch, 'main');
    assert.equal(r.newBranch, 'feature/intern-learning-data-model');
    assert.equal(r.gitFolder, 'SolutionA');
    assert.equal(r.rootFolder, 'solutions');
    assert.ok(r.disconnectedAt);
    assert.ok(r.reconnectedAt);

    // Disconnect body must include SolutionUniqueName so we don't unbind the env.
    const disconnectBody = JSON.parse(received[2].body);
    assert.equal(disconnectBody.SolutionUniqueName, 'SolutionA');

    // Reconnect body must include SolutionUniqueName + new branch.
    const reconnectBody = JSON.parse(received[5].body);
    assert.equal(reconnectBody.SolutionUniqueName, 'SolutionA');
    assert.equal(reconnectBody.Branch, 'feature/intern-learning-data-model');
    assert.equal(reconnectBody.GitFolder, 'SolutionA');
  } finally { server.close(); }
});

test('solution binding requires --solutionUniqueName when multiple solutions are bound', async () => {
  // Detect call (1 only — we should hard-stop before any subsequent HTTP).
  const { server, received } = await createQueuedServer([
    {
      statusCode: 200,
      body: {
        value: [
          solutionBindingRow('SolutionB', 'main'),
          solutionBindingRow('SolutionA', 'main'),
        ],
      },
    },
  ]);
  try {
    const r = await switchBranch({
      envUrl: url(server), token: 'tok',
      newBranch: 'feature/x',
      ...FAST,
    });
    assert.ok(r.error);
    assert.match(r.error, /--solutionUniqueName/);
    assert.equal(r.bindingType, 'solution');
    assert.ok(Array.isArray(r.boundSolutions));
    assert.ok(r.boundSolutions.includes('SolutionB'));
    assert.ok(r.boundSolutions.includes('SolutionA'));
    assert.equal(received.length, 1, 'should hard-stop after the initial detect');
  } finally { server.close(); }
});

test('solution binding rejects --solutionUniqueName naming an unbound solution', async () => {
  const { server, received } = await createQueuedServer([
    { statusCode: 200, body: { value: [solutionBindingRow('SolutionA', 'main')] } },
  ]);
  try {
    const r = await switchBranch({
      envUrl: url(server), token: 'tok',
      newBranch: 'feature/x',
      solutionUniqueName: 'NotBoundSolution',
      ...FAST,
    });
    assert.ok(r.error);
    assert.match(r.error, /NotBoundSolution.*not Git-bound/);
    assert.equal(r.bindingType, 'solution');
    assert.equal(received.length, 1, 'should hard-stop after the initial detect');
  } finally { server.close(); }
});

test('solution binding: --solutionUniqueName selects the requested solution when multiple are bound', async () => {
  const { server, received } = await createQueuedServer([
    // 1. env-scoped detect — both solutions bound
    {
      statusCode: 200,
      body: {
        value: [
          solutionBindingRow('SolutionB', 'main'),
          solutionBindingRow('SolutionA', 'main'),
        ],
      },
    },
    // 2. scoped detect for SolutionA — legacy path filters to that row
    { statusCode: 200, body: { value: [solutionBindingRow('SolutionA', 'main')] } },
    // 3. disconnect
    { statusCode: 204, body: '' },
    // 4. poll-clear — scoped probe returns empty
    { statusCode: 200, body: { value: [] } },
    // 5. connectSolutionToGit internal detect — SolutionB still bound → subsequent-binding shape
    { statusCode: 200, body: { value: [solutionBindingRow('SolutionB', 'main')] } },
    // 6. connectSolutionToGit POST
    { statusCode: 204, body: '' },
  ]);
  try {
    const r = await switchBranch({
      envUrl: url(server), token: 'tok',
      newBranch: 'feature/intern',
      solutionUniqueName: 'SolutionA',
      ...FAST,
    });
    assert.equal(r.switched, true, `expected switched:true, got ${JSON.stringify(r)}`);
    assert.equal(r.solutionUniqueName, 'SolutionA');

    // Reconnect (subsequent-binding shape) must not include Organization/Project/Repository fields.
    const reconnectBody = JSON.parse(received[5].body);
    assert.equal(reconnectBody.SolutionUniqueName, 'SolutionA');
    assert.equal(reconnectBody.Branch, 'feature/intern');
    assert.equal(reconnectBody.Organization, undefined,
      'subsequent solution binding should not re-send Organization');
  } finally { server.close(); }
});

test('solution binding reconnect fails: rolls back via connectSolutionToGit to original branch', async () => {
  const { server, received } = await createQueuedServer([
    // 1. detect (env-scoped)
    { statusCode: 200, body: { value: [solutionBindingRow('SolutionA', 'main')] } },
    // 2. detect (scoped)
    { statusCode: 200, body: { value: [solutionBindingRow('SolutionA', 'main')] } },
    // 3. disconnect
    { statusCode: 204, body: '' },
    // 4. poll-clear
    { statusCode: 200, body: { value: [] } },
    // 5. connectSolutionToGit internal detect (first-binding)
    { statusCode: 200, body: { value: [] } },
    // 6. connectSolutionToGit POST → fails with non-retriable error
    { statusCode: 400, body: { error: { message: 'branch not found', code: '0x80048d05' } } },
    // 7. rollback: connectSolutionToGit internal detect (first-binding)
    { statusCode: 200, body: { value: [] } },
    // 8. rollback: connectSolutionToGit POST → success
    { statusCode: 204, body: '' },
  ]);
  try {
    const r = await switchBranch({
      envUrl: url(server), token: 'tok',
      newBranch: 'feature/nonexistent',
      ...FAST,
    });
    assert.ok(r.error);
    assert.equal(r.phase, 'reconnect');
    assert.equal(r.bindingType, 'solution');
    assert.equal(r.solutionUniqueName, 'SolutionA');
    assert.equal(r.rolledBack, true);
    assert.equal(r.previousBranch, 'main');
    assert.equal(r.attemptedBranch, 'feature/nonexistent');

    const rollbackPostBody = JSON.parse(received[7].body);
    assert.equal(rollbackPostBody.Branch, 'main');
    assert.equal(rollbackPostBody.SolutionUniqueName, 'SolutionA');
  } finally { server.close(); }
});

test('solution binding reconnect: retries on 0x80040265 (disconnect-in-progress) and succeeds', async () => {
  const { server, received } = await createQueuedServer([
    // 1. detect (env-scoped)
    { statusCode: 200, body: { value: [solutionBindingRow('SolutionA', 'main')] } },
    // 2. detect (scoped)
    { statusCode: 200, body: { value: [solutionBindingRow('SolutionA', 'main')] } },
    // 3. disconnect
    { statusCode: 204, body: '' },
    // 4. poll-clear
    { statusCode: 200, body: { value: [] } },
    // 5. first reconnect attempt: internal detect
    { statusCode: 200, body: { value: [] } },
    // 6. first reconnect attempt: POST → 0x80040265 (transient race)
    { statusCode: 400, body: { error: { message: 'A disconnect operation is already in progress.', code: '0x80040265' } } },
    // 7. second reconnect attempt: internal detect
    { statusCode: 200, body: { value: [] } },
    // 8. second reconnect attempt: POST → success
    { statusCode: 204, body: '' },
  ]);
  try {
    const r = await switchBranch({
      envUrl: url(server), token: 'tok',
      newBranch: 'feature/intern',
      ...FAST,
    });
    assert.equal(r.switched, true, `expected switched:true after retry, got ${JSON.stringify(r)}`);
    assert.equal(r.bindingType, 'solution');
    assert.equal(r.solutionUniqueName, 'SolutionA');
    assert.equal(received.length, 8, 'should make 8 requests with one retry on 0x80040265');
  } finally { server.close(); }
});

test('solution binding reconnect: gives up after exhausting retries on persistent 0x80040265', async () => {
  // _maxReconnectRetries=3 means up to 4 attempts (initial + 3 retries). Each
  // attempt is 2 HTTP calls (detect + POST). All fail with 0x80040265.
  // Then rollback runs the same retry loop, also all 0x80040265 → fails.
  //   detect + scoped-detect + disconnect + poll-clear           = 4 calls
  // + reconnect attempts (4 × 2)                                  = 8 calls
  // + rollback attempts (4 × 2)                                   = 8 calls
  //                                                       TOTAL  = 20 calls
  const responses = [
    { statusCode: 200, body: { value: [solutionBindingRow('SolutionA', 'main')] } },
    { statusCode: 200, body: { value: [solutionBindingRow('SolutionA', 'main')] } },
    { statusCode: 204, body: '' },
    { statusCode: 200, body: { value: [] } },
  ];
  for (let i = 0; i < 4; i++) {
    responses.push({ statusCode: 200, body: { value: [] } });
    responses.push({ statusCode: 400, body: { error: { message: 'A disconnect operation is already in progress.', code: '0x80040265' } } });
  }
  for (let i = 0; i < 4; i++) {
    responses.push({ statusCode: 200, body: { value: [] } });
    responses.push({ statusCode: 400, body: { error: { message: 'A disconnect operation is already in progress.', code: '0x80040265' } } });
  }

  const { server } = await createQueuedServer(responses);
  try {
    const r = await switchBranch({
      envUrl: url(server), token: 'tok',
      newBranch: 'feature/intern',
      ...FAST,
    });
    assert.ok(r.error);
    assert.equal(r.phase, 'reconnect');
    assert.match(r.error, /disconnect operation is already in progress/);
    assert.equal(r.bindingType, 'solution');
    assert.equal(r.solutionUniqueName, 'SolutionA');
    assert.equal(r.rolledBack, false);
    assert.ok(r.rollbackError);
  } finally { server.close(); }
});
