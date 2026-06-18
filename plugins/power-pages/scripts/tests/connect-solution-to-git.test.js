'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { connectSolutionToGit, CONNECTION_TYPE_SOLUTION } = require('../lib/connect-solution-to-git');

function createQueuedServer(responses) {
  const queue = [...responses];
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, body });
      const next = queue.shift();
      if (!next) {
        res.writeHead(500); res.end('{}'); return;
      }
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

test('CONNECTION_TYPE_SOLUTION === 0', () => {
  assert.equal(CONNECTION_TYPE_SOLUTION, 0);
});

// ===== Required-arg validation =====

test('throws when --solutionUniqueName is missing', async () => {
  await assert.rejects(
    () => connectSolutionToGit({ envUrl: 'http://x', branch: 'b', gitFolder: 'f' }),
    /solutionUniqueName is required/,
  );
});

test('throws when --branch is missing', async () => {
  await assert.rejects(
    () => connectSolutionToGit({ envUrl: 'http://x', solutionUniqueName: 's', gitFolder: 'f' }),
    /branch is required/,
  );
});

// ===== First binding (no existing connection) =====

test('first solution binding: requires --organization/--project/--repository/--rootFolder', async () => {
  const r = await connectSolutionToGit({
    envUrl: 'http://x', token: 'tok',
    solutionUniqueName: 's', branch: 'b', gitFolder: 'f',
    _forceFirstBinding: true,
    // missing org/project/repo/rootFolder
  });
  assert.ok(r.error);
  assert.match(r.error, /organization.*project.*repository.*rootFolder/i);
});

test('first solution binding: sends the full envelope and returns bound:true', async () => {
  const { server, received } = await createQueuedServer([
    { statusCode: 204, body: '' }, // ConnectToGit POST
  ]);
  try {
    const r = await connectSolutionToGit({
      envUrl: url(server), token: 'tok',
      solutionUniqueName: 'cre48_PowerPagesSite',
      branch: 'main', gitFolder: '/solutions/cre48_PowerPagesSite',
      organization: 'contoso', project: 'pp-site', repository: 'pp-repo',
      rootFolder: '/solutions',
      _forceFirstBinding: true,
    });
    assert.equal(r.bound, true);
    assert.equal(r.bindingType, 'solution');
    assert.equal(r.isFirstSolutionBinding, true);
    assert.equal(r.solutionUniqueName, 'cre48_PowerPagesSite');
    assert.equal(r.rootFolder, '/solutions');
    const sentBody = JSON.parse(received[0].body);
    assert.equal(sentBody.ConnectionType, 0);
    assert.equal(sentBody.GitProvider, 0);
    assert.equal(sentBody.Organization, 'contoso');
    assert.equal(sentBody.RootFolder, '/solutions');
    assert.equal(sentBody.SolutionUniqueName, 'cre48_PowerPagesSite');
  } finally { server.close(); }
});

// ===== Subsequent binding (existing connection inherits values) =====

test('subsequent solution binding: minimal body, inherits org/project/repo/rootFolder', async () => {
  const { server, received } = await createQueuedServer([
    // detectGitBinding GET — returns an existing solution binding
    {
      statusCode: 200,
      body: {
        value: [{
          gitintegrationid: 'existing-1',
          connectiontype: 0,
          organizationname: 'inherited-org',
          projectname: 'inherited-proj',
          repositoryname: 'inherited-repo',
          rootfolder: '/inherited-root',
          solutionuniquename: 'FirstSolution',
          branchname: 'main',
          gitfolder: '/x',
        }],
      },
    },
    { statusCode: 204, body: '' }, // ConnectToGit POST
  ]);
  try {
    const r = await connectSolutionToGit({
      envUrl: url(server), token: 'tok',
      solutionUniqueName: 'SecondSolution',
      branch: 'feature/second',
      gitFolder: '/solutions/SecondSolution',
      // no org/project/repo/rootFolder — must inherit
    });
    assert.equal(r.bound, true);
    assert.equal(r.isFirstSolutionBinding, false);
    assert.equal(r.organization, 'inherited-org');
    assert.equal(r.project, 'inherited-proj');
    assert.equal(r.repository, 'inherited-repo');
    assert.equal(r.rootFolder, '/inherited-root');

    // The body of the POST (received[1]) should be minimal — no Organization etc.
    const postBody = JSON.parse(received[1].body);
    assert.equal(postBody.SolutionUniqueName, 'SecondSolution');
    assert.equal(postBody.Branch, 'feature/second');
    assert.equal(postBody.GitFolder, '/solutions/SecondSolution');
    assert.equal(postBody.Organization, undefined, 'subsequent body must NOT include Organization');
    assert.equal(postBody.ConnectionType, undefined, 'subsequent body must NOT include ConnectionType');
  } finally { server.close(); }
});

// ===== Error paths =====

test('400 response on POST → propagates error message + code', async () => {
  const { server } = await createQueuedServer([
    { statusCode: 400, body: { error: { code: '0x80060002', message: 'Solution not found' } } },
  ]);
  try {
    const r = await connectSolutionToGit({
      envUrl: url(server), token: 'tok',
      solutionUniqueName: 's', branch: 'b', gitFolder: 'f',
      organization: 'o', project: 'p', repository: 'r', rootFolder: '/root',
      _forceFirstBinding: true,
    });
    assert.ok(r.error);
    assert.equal(r.errorCode, '0x80060002');
    assert.equal(r.statusCode, 400);
  } finally { server.close(); }
});

test('pre-check network failure propagates with phase context', async () => {
  // No _forceFirstBinding → detection step runs and fails because the host
  // is unreachable.
  const r = await connectSolutionToGit({
    envUrl: 'http://127.0.0.1:1', token: 'tok',
    solutionUniqueName: 's', branch: 'b', gitFolder: 'f',
  });
  assert.ok(r.error);
  assert.match(r.error, /pre-check|Pre-check/i);
});
