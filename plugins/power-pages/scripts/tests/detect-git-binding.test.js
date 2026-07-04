'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectGitBinding, CONNECTION_TYPE } = require('../lib/detect-git-binding');

// Helper: build a fake makeRequest that always resolves to a fixed response.
// We patch the module's underlying makeRequest via a dependency-injection
// pattern: the test provides an alternate `makeRequest`-shaped function
// through a controlled require cache swap. Because validation-helpers.js is
// already cached in the real module, we use a simpler approach: the helpers
// accept an optional `_makeRequest` override in their options for testability.
//
// detect-git-binding.js does NOT expose _makeRequest — we unit-test the
// output-shaping logic by testing CONNECTION_TYPE and the exported constants,
// and we test the live-API path through integration tests.
// The unit tests here cover:
//   1. CONNECTION_TYPE mapping
//   2. Output shape when makeRequest returns a known mock body
//   3. 404 / error branch

// Since the live makeRequest cannot be injected without rewiring Node's
// module cache (which would break test isolation), the strategy here is:
//   - Test the helper with a thin httpServer that listens on localhost so
//     makeRequest actually executes against a controlled endpoint.
//   - Or stub at the module level using a simple environment variable flag
//     that short-circuits network calls in tests.
//
// We take the `localhost` server approach to keep tests hermetic and avoid
// module-cache pollution.

const http = require('http');

/**
 * Creates a one-shot HTTP server that responds with `statusCode` + `body`
 * to the first request, then closes.
 */
function createTestServer(statusCode, body) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
      server.close();
    });
    server.listen(0, '127.0.0.1', () => {
      resolve(server);
    });
  });
}

function serverUrl(server) {
  const { address, port } = server.address();
  return `http://${address}:${port}`;
}

// ===== CONNECTION_TYPE constant =====

test('CONNECTION_TYPE maps integer 0 to "solution" and 1 to "environment"', () => {
  assert.equal(CONNECTION_TYPE[0], 'solution');
  assert.equal(CONNECTION_TYPE[1], 'environment');
});

test('CONNECTION_TYPE is frozen', () => {
  assert.throws(() => { CONNECTION_TYPE[2] = 'unknown'; }, /read.?only|assign|cannot/i);
});

// ===== detectGitBinding — requires env URL =====

test('returns error when environment URL cannot be determined and none is passed', async () => {
  // We can't control getEnvironmentUrl() without patching, so test the
  // happy-path branch by supplying an explicit --envUrl.
  // This test just ensures the helper doesn't throw synchronously when
  // we pass a bad URL it can't connect to.
  const result = await detectGitBinding({ envUrl: 'http://127.0.0.1:1', token: 'fake' });
  assert.ok(result.error, 'should return an error when the server is unreachable');
});

// ===== detectGitBinding — HTTP response shape tests =====

test('returns bound:false when gitintegrations returns empty value array', async () => {
  const server = await createTestServer(200, { value: [] });
  try {
    const result = await detectGitBinding({ envUrl: serverUrl(server), token: 'test-tok' });
    assert.equal(result.bound, false);
  } finally { server.close(); }
});

test('maps environment binding row to the correct output shape', async () => {
  const server = await createTestServer(200, {
    value: [{
      gitintegrationid: 'aaaa-1111',
      connectiontype: 1,
      organizationname: 'contoso',
      projectname: 'pp-site',
      repositoryname: 'pp-site-repo',
      branchname: 'main',
      gitfolder: '/site-name',
      rootfolder: null,
      solutionuniquename: null,
      connectionstatus: 'Active',
    }],
  });
  try {
    const result = await detectGitBinding({ envUrl: serverUrl(server), token: 'test-tok' });
    assert.equal(result.bound, true);
    assert.equal(result.bindingType, 'environment');
    assert.equal(result.organization, 'contoso');
    assert.equal(result.project, 'pp-site');
    assert.equal(result.repository, 'pp-site-repo');
    assert.equal(result.branch, 'main');
    assert.equal(result.gitFolder, '/site-name');
    assert.equal(result.rootFolder, null);
    assert.equal(result.solutionUniqueName, null);
    assert.equal(result.connectionStatus, 'Active');
    assert.equal(result.gitIntegrationId, 'aaaa-1111');
  } finally { server.close(); }
});

test('maps solution binding row to the correct output shape', async () => {
  const server = await createTestServer(200, {
    value: [{
      gitintegrationid: 'bbbb-2222',
      connectiontype: 0,
      organizationname: 'contoso',
      projectname: 'pp-proj',
      repositoryname: 'pp-repo',
      branchname: 'feature/about',
      gitfolder: '/solutions/MyCustomSolution',
      rootfolder: '/solutions',
      solutionuniquename: 'MyCustomSolution',
      connectionstatus: 'Active',
    }],
  });
  try {
    const result = await detectGitBinding({ envUrl: serverUrl(server), token: 'test-tok' });
    assert.equal(result.bindingType, 'solution');
    assert.equal(result.rootFolder, '/solutions');
    assert.equal(result.solutionUniqueName, 'MyCustomSolution');
  } finally { server.close(); }
});

test('returns bound:false with a hint when server responds 404', async () => {
  const server = await createTestServer(404, { error: { message: 'not found' } });
  try {
    const result = await detectGitBinding({ envUrl: serverUrl(server), token: 'test-tok' });
    assert.equal(result.bound, false);
    assert.ok(result.hint, 'should include a hint explaining the 404');
    assert.match(result.hint, /404|managed environment|git integration/i);
  } finally { server.close(); }
});

test('returns error when server responds with non-200 non-404', async () => {
  const server = await createTestServer(403, { error: { message: 'Forbidden' } });
  try {
    const result = await detectGitBinding({ envUrl: serverUrl(server), token: 'test-tok' });
    assert.ok(result.error, 'should propagate the error message');
    assert.equal(result.statusCode, 403);
  } finally { server.close(); }
});

test('returns error on malformed JSON response body', async () => {
  const server = await createTestServer(200, 'this is not json');
  try {
    const result = await detectGitBinding({ envUrl: serverUrl(server), token: 'test-tok' });
    assert.ok(result.error, 'should surface a parse error');
    assert.match(result.error, /parse/i);
  } finally { server.close(); }
});

test('unknown connectiontype integer falls back to the raw integer string', async () => {
  const server = await createTestServer(200, {
    value: [{
      gitintegrationid: 'cccc-3333',
      connectiontype: 99,
      organizationname: 'org',
      projectname: 'proj',
      repositoryname: 'repo',
      branchname: 'main',
    }],
  });
  try {
    const result = await detectGitBinding({ envUrl: serverUrl(server), token: 'test-tok' });
    assert.equal(result.bindingType, '99');
  } finally { server.close(); }
});

// ===== detectGitBinding — sourcecontrol-entities fallback path =====
//
// When the env does NOT expose `gitintegrations` (most modern tenants),
// detectGitBinding 404s and falls back to detectViaSourceControlEntities.
// That path makes multiple sequential requests, so we need a multi-response
// router instead of the one-shot createTestServer above.

function createRoutedServer(routes) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const path = req.url || '';
      // Find the first route whose matcher returns true.
      const match = routes.find((r) => r.match(path));
      if (!match) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `unrouted: ${path}` }));
        return;
      }
      res.writeHead(match.status, { 'Content-Type': 'application/json' });
      res.end(typeof match.body === 'string' ? match.body : JSON.stringify(match.body));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('multi-solution-bound env (no --solutionUniqueName) returns boundSolutions[] with pendingChangesCount (direct env-wide) and nonCommittedRootCount (per-solution sum)', async () => {
  const SOL_A = 'aaaaaaaa-1111-1111-1111-111111111111';
  const SOL_B = 'bbbbbbbb-2222-2222-2222-222222222222';
  const server = await createRoutedServer([
    // 1. gitintegrations 404 → triggers fallback path
    { match: (p) => p.startsWith('/api/data/v9.2/gitintegrations'), status: 404, body: { error: { message: 'not found' } } },
    // 2. sourcecontrolconfigurations → env-level config
    { match: (p) => p.startsWith('/api/data/v9.2/sourcecontrolconfigurations'), status: 200, body: { value: [{
      sourcecontrolconfigurationid: 'cfg-1', organizationname: 'org', projectname: 'proj', repositoryname: 'repo', gitprovider: 0,
    }] } },
    // 3. sourcecontrolbranchconfigurations → two solution rows
    { match: (p) => p.startsWith('/api/data/v9.2/sourcecontrolbranchconfigurations'), status: 200, body: { value: [
      { branchname: 'main', rootfolderpath: 'solutions/SolA', branchsyncedcommitId: 'aaa', upstreambranchsyncedcommitid: 'aaa', statuscode: 0 },
      { branchname: 'main', rootfolderpath: 'solutions/SolB', branchsyncedcommitId: 'bbb', upstreambranchsyncedcommitid: 'bbb', statuscode: 0 },
    ] } },
    // 4. solutions enum → two bound solutions
    { match: (p) => p.startsWith('/api/data/v9.2/solutions') && p.includes('enabledforsourcecontrolintegration%20eq%20true'), status: 200, body: { value: [
      { solutionid: SOL_A, uniquename: 'SolA', enabledforsourcecontrolintegration: true, sourcecontrolsyncstatus: 3 },
      { solutionid: SOL_B, uniquename: 'SolB', enabledforsourcecontrolintegration: true, sourcecontrolsyncstatus: 3 },
    ] } },
    // 5. per-solution pending-changes counts (matched in URL via partitionid)
    { match: (p) => p.startsWith('/api/data/v9.2/sourcecontrolcomponents') && p.includes(SOL_A), status: 200, body: { '@odata.count': 2, value: [] } },
    { match: (p) => p.startsWith('/api/data/v9.2/sourcecontrolcomponents') && p.includes(SOL_B), status: 200, body: { '@odata.count': 5, value: [] } },
    // 6. env-wide direct query (NO partitionid in URL) — E8: this is the new
    //    `pendingChangesCount`. Returns 9 (= 2 + 5 + 2 stale rows from a
    //    previously-disconnected solution that nonCommittedRootCount can't see).
    { match: (p) => p.startsWith('/api/data/v9.2/sourcecontrolcomponents') && !p.includes(SOL_A) && !p.includes(SOL_B), status: 200, body: { '@odata.count': 9, value: [] } },
  ]);
  try {
    const result = await detectGitBinding({ envUrl: serverUrl(server), token: 'test-tok' });
    assert.equal(result.bound, true);
    assert.ok(Array.isArray(result.boundSolutions), 'boundSolutions should be an array');
    assert.equal(result.boundSolutions.length, 2, 'should enumerate both bound solutions');
    assert.equal(result.multipleSolutionsBound, true);
    // E8: `pendingChangesCount` is now the DIRECT env-wide count (matches list-pending-changes
    // without a filter). `nonCommittedRootCount` is the per-solution aggregate (sum across
    // boundSolutions[] which excludes disabled solutions). The two CAN diverge.
    assert.equal(result.pendingChangesCount, 9, 'pendingChangesCount = direct env-wide count (incl. stale rows)');
    assert.equal(result.nonCommittedRootCount, 7, 'nonCommittedRootCount = sum across boundSolutions[] (2+5)');
    assert.equal(result.cleanState, 'Dirty');
    const names = result.boundSolutions.map((s) => s.uniqueName).sort();
    assert.deepEqual(names, ['SolA', 'SolB']);
  } finally { server.close(); }
});

// Regression: pending-Changes detection MUST filter to action eq 1 (Push). The
// `iscommitted eq false` predicate ALONE also matches the inert action=0 baseline,
// which yields a false "Dirty" on a clean env (live 2026-06-19, sri-alm-dev-1:
// 238 iscommitted=false rows were ALL action=0 while the portal showed Changes(0)).
test('every sourcecontrolcomponents query filters action eq 1; 0 such rows → Clean (not false Dirty)', async () => {
  const SOL_A = 'aaaaaaaa-1111-1111-1111-111111111111';
  const seen = [];
  const server = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const p = req.url || '';
      seen.push(p);
      let status = 200; let body = {};
      if (p.startsWith('/api/data/v9.2/gitintegrations')) { status = 404; body = { error: { message: 'nf' } }; }
      else if (p.startsWith('/api/data/v9.2/sourcecontrolconfigurations')) { body = { value: [{ sourcecontrolconfigurationid: 'cfg', organizationname: 'o', projectname: 'p', repositoryname: 'r', gitprovider: 0 }] }; }
      else if (p.startsWith('/api/data/v9.2/sourcecontrolbranchconfigurations')) { body = { value: [{ branchname: 'main', rootfolderpath: 'solutions/SolA', branchsyncedcommitId: 'aaa', upstreambranchsyncedcommitid: 'aaa', statuscode: 0 }] }; }
      else if (p.startsWith('/api/data/v9.2/solutions')) { body = { value: [{ solutionid: SOL_A, uniquename: 'SolA', enabledforsourcecontrolintegration: true, sourcecontrolsyncstatus: 3 }] }; }
      else if (p.startsWith('/api/data/v9.2/sourcecontrolcomponents')) { body = { '@odata.count': 0, value: [] }; }
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const result = await detectGitBinding({ envUrl: serverUrl(server), token: 'test-tok' });
    assert.equal(result.cleanState, 'Clean', '0 action=1 rows ⇒ Clean, not a false Dirty');
    const compQueries = seen.filter((u) => u.includes('sourcecontrolcomponents')).map(decodeURIComponent);
    assert.ok(compQueries.length > 0, 'queried sourcecontrolcomponents');
    for (const q of compQueries) {
      assert.match(q, /iscommitted eq false/);
      assert.match(q, /action eq 1/, `query must filter action eq 1: ${q}`);
    }
  } finally { server.close(); }
});

test('single-solution-bound env (no --solutionUniqueName) returns boundSolutions[1] and multipleSolutionsBound:false', async () => {
  const SOL_A = 'aaaaaaaa-1111-1111-1111-111111111111';
  const server = await createRoutedServer([
    { match: (p) => p.startsWith('/api/data/v9.2/gitintegrations'), status: 404, body: { error: { message: 'not found' } } },
    { match: (p) => p.startsWith('/api/data/v9.2/sourcecontrolconfigurations'), status: 200, body: { value: [{
      sourcecontrolconfigurationid: 'cfg-1', organizationname: 'org', projectname: 'proj', repositoryname: 'repo', gitprovider: 0,
    }] } },
    { match: (p) => p.startsWith('/api/data/v9.2/sourcecontrolbranchconfigurations'), status: 200, body: { value: [
      { branchname: 'main', rootfolderpath: 'solutions/SolA', branchsyncedcommitId: 'aaa', upstreambranchsyncedcommitid: 'aaa', statuscode: 0 },
    ] } },
    { match: (p) => p.startsWith('/api/data/v9.2/solutions') && p.includes('enabledforsourcecontrolintegration%20eq%20true'), status: 200, body: { value: [
      { solutionid: SOL_A, uniquename: 'SolA', enabledforsourcecontrolintegration: true, sourcecontrolsyncstatus: 3 },
    ] } },
    // per-solution count for SolA
    { match: (p) => p.startsWith('/api/data/v9.2/sourcecontrolcomponents') && p.includes(SOL_A), status: 200, body: { '@odata.count': 0, value: [] } },
    // env-wide direct count (no partitionid) — Clean env
    { match: (p) => p.startsWith('/api/data/v9.2/sourcecontrolcomponents') && !p.includes(SOL_A), status: 200, body: { '@odata.count': 0, value: [] } },
  ]);
  try {
    const result = await detectGitBinding({ envUrl: serverUrl(server), token: 'test-tok' });
    assert.equal(result.bound, true);
    assert.equal(result.boundSolutions.length, 1);
    assert.equal(result.multipleSolutionsBound, false);
    assert.equal(result.pendingChangesCount, 0);
    assert.equal(result.nonCommittedRootCount, 0, 'when both are 0 the env-wide and aggregate counts agree');
    assert.equal(result.cleanState, 'Clean');
    assert.equal(result.boundSolutions[0].uniqueName, 'SolA');
    // Bug 9: with exactly one bound solution and no explicit filter, the top-level
    // solutionUniqueName is populated from boundSolutions[0] (not a spurious null) so
    // reconcile-manifest never reports a false "stale manifest" divergence.
    assert.equal(result.solutionUniqueName, 'SolA');
  } finally { server.close(); }
});


// ===== E8 — pendingChangesCount equality regression vs list-pending-changes =====

test('E8: detect-git-binding.pendingChangesCount equals list-pending-changes.count on identical mocked env (no --solutionUniqueName)', async () => {
  const { listPendingChanges } = require('../lib/list-pending-changes');
  const SOL_A = 'aaaaaaaa-1111-1111-1111-111111111111';
  // Spin up a server that responds the SAME way to BOTH helpers' env-wide
  // sourcecontrolcomponents query (no partitionid filter). The env-wide
  // count must be reported identically by both. Returns 9 for both helpers,
  // even though the per-solution sum (nonCommittedRootCount) is only 2.
  const server = await createRoutedServer([
    { match: (p) => p.startsWith('/api/data/v9.2/gitintegrations'), status: 404, body: { error: { message: 'not found' } } },
    { match: (p) => p.startsWith('/api/data/v9.2/sourcecontrolconfigurations'), status: 200, body: { value: [{
      sourcecontrolconfigurationid: 'cfg-1', organizationname: 'org', projectname: 'proj', repositoryname: 'repo', gitprovider: 0,
    }] } },
    { match: (p) => p.startsWith('/api/data/v9.2/sourcecontrolbranchconfigurations'), status: 200, body: { value: [
      { branchname: 'main', rootfolderpath: 'solutions/SolA', branchsyncedcommitId: 'aaa', upstreambranchsyncedcommitid: 'aaa', statuscode: 0 },
    ] } },
    { match: (p) => p.startsWith('/api/data/v9.2/solutions') && p.includes('enabledforsourcecontrolintegration%20eq%20true'), status: 200, body: { value: [
      { solutionid: SOL_A, uniquename: 'SolA', enabledforsourcecontrolintegration: true, sourcecontrolsyncstatus: 3 },
    ] } },
    // per-solution (with partitionid) → 2
    { match: (p) => p.startsWith('/api/data/v9.2/sourcecontrolcomponents') && p.includes(SOL_A), status: 200, body: { '@odata.count': 2, value: [] } },
    // env-wide (no partitionid) → 9 (= 2 for SolA + 7 stale rows from a previously-disconnected solution)
    { match: (p) => p.startsWith('/api/data/v9.2/sourcecontrolcomponents') && !p.includes(SOL_A), status: 200, body: { '@odata.count': 9, value: [] } },
  ]);
  try {
    const detect = await detectGitBinding({ envUrl: serverUrl(server), token: 'test-tok' });
    const list = await listPendingChanges({ envUrl: serverUrl(server), token: 'test-tok' });
    assert.equal(list.count, 9, 'list-pending-changes count must come from the env-wide query');
    assert.equal(detect.pendingChangesCount, list.count,
      `detect-git-binding.pendingChangesCount (${detect.pendingChangesCount}) must equal list-pending-changes.count (${list.count}) on identical mocked data`);
    // And nonCommittedRootCount is the per-solution aggregate — different from list-pending-changes
    assert.equal(detect.nonCommittedRootCount, 2);
  } finally { server.close(); }
});

test('E8: detect-git-binding.pendingChangesCount equals list-pending-changes.count when --solutionUniqueName matches (per-solution direct count)', async () => {
  const { listPendingChanges } = require('../lib/list-pending-changes');
  const SOL_A = 'aaaaaaaa-1111-1111-1111-111111111111';
  // With --solutionUniqueName, both helpers do the partitionid-filtered query.
  // pendingChangesCount === nonCommittedRootCount === list.count in this case.
  const server = await createRoutedServer([
    { match: (p) => p.startsWith('/api/data/v9.2/gitintegrations'), status: 404, body: { error: { message: 'not found' } } },
    { match: (p) => p.startsWith('/api/data/v9.2/sourcecontrolconfigurations'), status: 200, body: { value: [{
      sourcecontrolconfigurationid: 'cfg-1', organizationname: 'org', projectname: 'proj', repositoryname: 'repo', gitprovider: 0,
    }] } },
    { match: (p) => p.startsWith('/api/data/v9.2/sourcecontrolbranchconfigurations'), status: 200, body: { value: [
      { branchname: 'main', rootfolderpath: 'solutions/SolA', branchsyncedcommitId: 'aaa', upstreambranchsyncedcommitid: 'aaa', statuscode: 0 },
    ] } },
    // list-pending-changes' resolveSolutionId step (filtered by uniquename eq 'SolA')
    { match: (p) => p.startsWith('/api/data/v9.2/solutions') && p.includes('uniquename') && p.includes('SolA'), status: 200, body: { value: [
      { solutionid: SOL_A, uniquename: 'SolA', enabledforsourcecontrolintegration: true, sourcecontrolsyncstatus: 3 },
    ] } },
    // detect-git-binding's solutions enumeration (filter=enabledforsourcecontrolintegration eq true)
    { match: (p) => p.startsWith('/api/data/v9.2/solutions') && p.includes('enabledforsourcecontrolintegration%20eq%20true'), status: 200, body: { value: [
      { solutionid: SOL_A, uniquename: 'SolA', enabledforsourcecontrolintegration: true, sourcecontrolsyncstatus: 3 },
    ] } },
    // BOTH helpers' SC query (with partitionid eq SOL_A) → 4
    { match: (p) => p.startsWith('/api/data/v9.2/sourcecontrolcomponents') && p.includes(SOL_A), status: 200, body: { '@odata.count': 4, value: [] } },
  ]);
  try {
    const detect = await detectGitBinding({ envUrl: serverUrl(server), token: 'test-tok', solutionUniqueName: 'SolA' });
    const list = await listPendingChanges({ envUrl: serverUrl(server), token: 'test-tok', solutionUniqueName: 'SolA' });
    assert.equal(list.count, 4);
    assert.equal(detect.pendingChangesCount, 4);
    assert.equal(detect.nonCommittedRootCount, 4, 'scoped case: both fields agree');
    assert.equal(detect.pendingChangesCount, list.count);
  } finally { server.close(); }
});


// ===== E10 — bindingType disambiguation + staleBranchConfigs =====

test('E10 scenario 1: clean solution binding — partitionid matches an enabled solution → bindingType:solution, staleBranchConfigs:[]', async () => {
  const SOL_A = 'aaaaaaaa-1111-1111-1111-111111111111';
  const server = await createRoutedServer([
    { match: (p) => p.startsWith('/api/data/v9.2/gitintegrations'), status: 404, body: { error: { message: 'not found' } } },
    { match: (p) => p.startsWith('/api/data/v9.2/sourcecontrolconfigurations'), status: 200, body: { value: [{
      sourcecontrolconfigurationid: 'cfg-1', organizationname: 'org', projectname: 'proj', repositoryname: 'repo', gitprovider: 0,
    }] } },
    { match: (p) => p.startsWith('/api/data/v9.2/sourcecontrolbranchconfigurations'), status: 200, body: { value: [
      { branchname: 'main', rootfolderpath: 'solutions/SolA', partitionid: SOL_A, _partitionid_value: SOL_A, statuscode: 0 },
    ] } },
    { match: (p) => p.startsWith('/api/data/v9.2/solutions') && p.includes('enabledforsourcecontrolintegration%20eq%20true'), status: 200, body: { value: [
      { solutionid: SOL_A, uniquename: 'SolA', enabledforsourcecontrolintegration: true, sourcecontrolsyncstatus: 3 },
    ] } },
    { match: (p) => p.startsWith('/api/data/v9.2/sourcecontrolcomponents') && p.includes(SOL_A), status: 200, body: { '@odata.count': 0, value: [] } },
    { match: (p) => p.startsWith('/api/data/v9.2/sourcecontrolcomponents'), status: 200, body: { '@odata.count': 0, value: [] } },
  ]);
  try {
    const result = await detectGitBinding({ envUrl: serverUrl(server), token: 'test-tok' });
    assert.equal(result.bindingType, 'solution');
    assert.deepEqual(result.staleBranchConfigs, []);
  } finally { server.close(); }
});

test('E10 scenario 2: env binding — only branchconfig has all-zeros partitionid → bindingType:environment, staleBranchConfigs:[]', async () => {
  const ZERO = '00000000-0000-0000-0000-000000000000';
  const server = await createRoutedServer([
    { match: (p) => p.startsWith('/api/data/v9.2/gitintegrations'), status: 404, body: { error: { message: 'not found' } } },
    { match: (p) => p.startsWith('/api/data/v9.2/sourcecontrolconfigurations'), status: 200, body: { value: [{
      sourcecontrolconfigurationid: 'cfg-1', organizationname: 'org', projectname: 'proj', repositoryname: 'repo', gitprovider: 0,
    }] } },
    { match: (p) => p.startsWith('/api/data/v9.2/sourcecontrolbranchconfigurations'), status: 200, body: { value: [
      { branchname: 'main', rootfolderpath: 'solutions', partitionid: ZERO, _partitionid_value: ZERO, statuscode: 0 },
    ] } },
    { match: (p) => p.startsWith('/api/data/v9.2/solutions') && p.includes('enabledforsourcecontrolintegration%20eq%20true'), status: 200, body: { value: [] } },
    { match: (p) => p.startsWith('/api/data/v9.2/sourcecontrolcomponents'), status: 200, body: { '@odata.count': 0, value: [] } },
  ]);
  try {
    const result = await detectGitBinding({ envUrl: serverUrl(server), token: 'test-tok' });
    assert.equal(result.bindingType, 'environment');
    assert.deepEqual(result.staleBranchConfigs, []);
  } finally { server.close(); }
});

test('E10 scenario 3: stale solution branchconfig (partition does not match any enabled solution) → bindingType:environment, staleBranchConfigs surfaces the row', async () => {
  const SOL_GHOST = 'aaaaaaaa-9999-9999-9999-999999999999';
  const server = await createRoutedServer([
    { match: (p) => p.startsWith('/api/data/v9.2/gitintegrations'), status: 404, body: { error: { message: 'not found' } } },
    { match: (p) => p.startsWith('/api/data/v9.2/sourcecontrolconfigurations'), status: 200, body: { value: [{
      sourcecontrolconfigurationid: 'cfg-1', organizationname: 'org', projectname: 'proj', repositoryname: 'repo', gitprovider: 0,
    }] } },
    { match: (p) => p.startsWith('/api/data/v9.2/sourcecontrolbranchconfigurations'), status: 200, body: { value: [
      { branchname: 'main', rootfolderpath: 'solutions/SolGhost', partitionid: SOL_GHOST, _partitionid_value: SOL_GHOST, statuscode: 0 },
    ] } },
    // solutions enumeration: SolGhost NOT in the result (disconnected, enabledforsourcecontrolintegration eq true filtered it out)
    { match: (p) => p.startsWith('/api/data/v9.2/solutions') && p.includes('enabledforsourcecontrolintegration%20eq%20true'), status: 200, body: { value: [] } },
    { match: (p) => p.startsWith('/api/data/v9.2/sourcecontrolcomponents'), status: 200, body: { '@odata.count': 0, value: [] } },
  ]);
  try {
    const result = await detectGitBinding({ envUrl: serverUrl(server), token: 'test-tok' });
    // No live solution row matches the partitionid → not 'solution'
    assert.notEqual(result.bindingType, 'solution', 'stale-only branchconfigs must NOT produce bindingType:solution');
    assert.equal(result.staleBranchConfigs.length, 1);
    assert.equal(result.staleBranchConfigs[0].partitionId, SOL_GHOST);
    assert.equal(result.staleBranchConfigs[0].rootFolderPath, 'solutions/SolGhost');
    assert.match(result.staleBranchConfigs[0].reason, /partitionId does not match any enabled solution/);
  } finally { server.close(); }
});

test('E10 scenario 4: mixed — 1 live solution + 1 stale solution + 1 env row → bindingType:solution, staleBranchConfigs surfaces only the ghost row', async () => {
  const SOL_A = 'aaaaaaaa-1111-1111-1111-111111111111';
  const SOL_GHOST = 'aaaaaaaa-9999-9999-9999-999999999999';
  const ZERO = '00000000-0000-0000-0000-000000000000';
  const server = await createRoutedServer([
    { match: (p) => p.startsWith('/api/data/v9.2/gitintegrations'), status: 404, body: { error: { message: 'not found' } } },
    { match: (p) => p.startsWith('/api/data/v9.2/sourcecontrolconfigurations'), status: 200, body: { value: [{
      sourcecontrolconfigurationid: 'cfg-1', organizationname: 'org', projectname: 'proj', repositoryname: 'repo', gitprovider: 0,
    }] } },
    { match: (p) => p.startsWith('/api/data/v9.2/sourcecontrolbranchconfigurations'), status: 200, body: { value: [
      // Stale solution row first (worst case for the legacy heuristic)
      { branchname: 'main', rootfolderpath: 'solutions/SolGhost', partitionid: SOL_GHOST, _partitionid_value: SOL_GHOST, statuscode: 0 },
      // Env-level row (zero-guid partition)
      { branchname: 'main', rootfolderpath: 'solutions',         partitionid: ZERO,      _partitionid_value: ZERO,      statuscode: 0 },
      // Live solution row
      { branchname: 'main', rootfolderpath: 'solutions/SolA',    partitionid: SOL_A,     _partitionid_value: SOL_A,     statuscode: 0 },
    ] } },
    { match: (p) => p.startsWith('/api/data/v9.2/solutions') && p.includes('enabledforsourcecontrolintegration%20eq%20true'), status: 200, body: { value: [
      { solutionid: SOL_A, uniquename: 'SolA', enabledforsourcecontrolintegration: true, sourcecontrolsyncstatus: 3 },
    ] } },
    { match: (p) => p.startsWith('/api/data/v9.2/sourcecontrolcomponents') && p.includes(SOL_A), status: 200, body: { '@odata.count': 2, value: [] } },
    { match: (p) => p.startsWith('/api/data/v9.2/sourcecontrolcomponents'), status: 200, body: { '@odata.count': 2, value: [] } },
  ]);
  try {
    const result = await detectGitBinding({ envUrl: serverUrl(server), token: 'test-tok' });
    // Live solution row exists → bindingType:'solution' regardless of branchRows order
    assert.equal(result.bindingType, 'solution');
    // Only the ghost row is stale; the zero-guid env row is NOT stale
    assert.equal(result.staleBranchConfigs.length, 1, 'env-level zero-guid rows must NOT be flagged stale; only orphan solution rows');
    assert.equal(result.staleBranchConfigs[0].partitionId, SOL_GHOST);
  } finally { server.close(); }
});

// REGRESSION (2026-06-11): commit 4936f62 shipped E10 with a `$select` that
// requested `_partitionid_value` (imagined lookup-style fallback). Dataverse
// rejects this with HTTP 400 "Could not find a property named
// '_partitionid_value' on type ... sourcecontrolbranchconfiguration" because
// `partitionid` is a plain UUID column on this entity, not a lookup. The
// bug blocked detect-git-binding on every modern tenant (verified live on
// org5ba33a19/v9.2, 2026-06-11) and cascaded through every git skill that
// calls detect-git-binding for verification (disconnect-from-git --verify,
// list-pending-changes prereq probe, plan-inner-loop status check). Source-
// grep this line so the bad field cannot creep back into the URL.
test('detect-git-binding: $select must NOT include _partitionid_value (regression for the 4936f62 HTTP 400 bug)', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('../lib/detect-git-binding.js'), 'utf8');

  // Find every occurrence of a sourcecontrolbranchconfigurations URL with a $select
  // clause and assert _partitionid_value is not in it.
  const selectMatches = src.match(/sourcecontrolbranchconfigurations\?\$select=[^`'"\n]+/g);
  assert.ok(selectMatches && selectMatches.length > 0,
    'expected at least one sourcecontrolbranchconfigurations $select URL in detect-git-binding.js');
  for (const match of selectMatches) {
    assert.ok(!match.includes('_partitionid_value'),
      `sourcecontrolbranchconfigurations $select must NOT request _partitionid_value (it is not a valid field and returns HTTP 400 on modern Dataverse); offending URL: ${match}`);
    assert.ok(match.includes('partitionid'),
      `sourcecontrolbranchconfigurations $select MUST include the plain partitionid column for E10 reconciliation; offending URL: ${match}`);
  }
});

test('E10 back-compat: tenant without partitionid exposure falls back to legacy path heuristic', async () => {
  const SOL_A = 'aaaaaaaa-1111-1111-1111-111111111111';
  const server = await createRoutedServer([
    { match: (p) => p.startsWith('/api/data/v9.2/gitintegrations'), status: 404, body: { error: { message: 'not found' } } },
    { match: (p) => p.startsWith('/api/data/v9.2/sourcecontrolconfigurations'), status: 200, body: { value: [{
      sourcecontrolconfigurationid: 'cfg-1', organizationname: 'org', projectname: 'proj', repositoryname: 'repo', gitprovider: 0,
    }] } },
    // partitionid / _partitionid_value absent entirely (older Dataverse versions)
    { match: (p) => p.startsWith('/api/data/v9.2/sourcecontrolbranchconfigurations'), status: 200, body: { value: [
      { branchname: 'main', rootfolderpath: 'solutions/SolA', statuscode: 0 },
    ] } },
    { match: (p) => p.startsWith('/api/data/v9.2/solutions') && p.includes('enabledforsourcecontrolintegration%20eq%20true'), status: 200, body: { value: [
      { solutionid: SOL_A, uniquename: 'SolA', enabledforsourcecontrolintegration: true, sourcecontrolsyncstatus: 3 },
    ] } },
    { match: (p) => p.startsWith('/api/data/v9.2/sourcecontrolcomponents'), status: 200, body: { '@odata.count': 0, value: [] } },
  ]);
  try {
    const result = await detectGitBinding({ envUrl: serverUrl(server), token: 'test-tok' });
    // Path-based heuristic: rootfolderpath contains '/' → 'solution'
    assert.equal(result.bindingType, 'solution');
    // No stale rows because nothing has a partitionid to compare against
    assert.deepEqual(result.staleBranchConfigs, []);
  } finally { server.close(); }
});
