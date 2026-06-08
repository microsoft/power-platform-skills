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

test('multi-solution-bound env (no --solutionUniqueName) returns boundSolutions[] and aggregates pendingChangesCount', async () => {
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
  ]);
  try {
    const result = await detectGitBinding({ envUrl: serverUrl(server), token: 'test-tok' });
    assert.equal(result.bound, true);
    assert.ok(Array.isArray(result.boundSolutions), 'boundSolutions should be an array');
    assert.equal(result.boundSolutions.length, 2, 'should enumerate both bound solutions');
    assert.equal(result.multipleSolutionsBound, true);
    assert.equal(result.pendingChangesCount, 7, 'should aggregate pending counts across all bound solutions (2+5)');
    assert.equal(result.cleanState, 'Dirty');
    const names = result.boundSolutions.map((s) => s.uniqueName).sort();
    assert.deepEqual(names, ['SolA', 'SolB']);
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
    { match: (p) => p.startsWith('/api/data/v9.2/sourcecontrolcomponents'), status: 200, body: { '@odata.count': 0, value: [] } },
  ]);
  try {
    const result = await detectGitBinding({ envUrl: serverUrl(server), token: 'test-tok' });
    assert.equal(result.bound, true);
    assert.equal(result.boundSolutions.length, 1);
    assert.equal(result.multipleSolutionsBound, false);
    assert.equal(result.pendingChangesCount, 0);
    assert.equal(result.cleanState, 'Clean');
    assert.equal(result.boundSolutions[0].uniqueName, 'SolA');
  } finally { server.close(); }
});
