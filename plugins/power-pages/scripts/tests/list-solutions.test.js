'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { listSolutions, SYSTEM_SOLUTIONS, buildBindingMap } = require('../lib/list-solutions');

function solutionsServer(body) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}
function serverUrl(s) { const { address, port } = s.address(); return `http://${address}:${port}`; }

// ===== buildBindingMap =====

test('buildBindingMap maps solution uniqueName → binding coords', () => {
  const discovery = {
    ok: true,
    knownRepos: [{
      organizationname: 'Org', projectname: 'Proj', repositoryname: 'Repo',
      branchConfigs: [
        { bindingType: 'solution', solutionUniqueName: 'RetailOS', branchname: 'main', rootfolderpath: 'solutions/RetailOS' },
        { bindingType: 'environment', solutionUniqueName: null, branchname: 'main', rootfolderpath: 'solutions' },
      ],
    }],
  };
  const map = buildBindingMap(discovery);
  assert.equal(map.size, 1, 'only the solution binding is mapped, not the env binding');
  assert.deepEqual(map.get('RetailOS'), {
    organization: 'Org', project: 'Proj', repository: 'Repo', branch: 'main', rootfolderpath: 'solutions/RetailOS',
  });
});

test('SYSTEM_SOLUTIONS contains the four system solutions', () => {
  for (const s of ['Active', 'Basic', 'Default', 'CommonDataServiceDefault']) {
    assert.ok(SYSTEM_SOLUTIONS.has(s));
  }
});

// ===== listSolutions =====

const SOLUTIONS_BODY = {
  value: [
    { solutionid: 's1', uniquename: 'RetailOS',     friendlyname: 'Retail OS',     version: '1.0.0.0', publisherid: { customizationprefix: 'ros' } },
    { solutionid: 's2', uniquename: 'InternLearning', friendlyname: 'Intern Learning', version: '2.1.0.0', publisherid: { customizationprefix: 'sri' } },
    { solutionid: 's3', uniquename: 'Active',        friendlyname: 'Active',        version: '1.0', publisherid: { customizationprefix: 'cds' } },
  ],
};

test('excludes system solutions and maps the clean shape', async (t) => {
  const server = await solutionsServer(SOLUTIONS_BODY);
  t.after(() => server.close());
  const r = await listSolutions({
    envUrl: serverUrl(server), token: 'tok',
    _discoverImpl: async () => ({ ok: true, knownRepos: [] }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.count, 2, 'Active excluded');
  const names = r.solutions.map((s) => s.uniqueName);
  assert.deepEqual(names, ['RetailOS', 'InternLearning']);
  assert.equal(r.solutions[0].publisherPrefix, 'ros');
  assert.equal(r.solutions[0].version, '1.0.0.0');
});

test('annotates boundTo for already-bound solutions', async (t) => {
  const server = await solutionsServer(SOLUTIONS_BODY);
  t.after(() => server.close());
  const r = await listSolutions({
    envUrl: serverUrl(server), token: 'tok',
    _discoverImpl: async () => ({
      ok: true,
      knownRepos: [{
        organizationname: 'GitIntegration22', projectname: 'srijan-pp-alm', repositoryname: 'srijan-pp-alm',
        branchConfigs: [{ bindingType: 'solution', solutionUniqueName: 'RetailOS', branchname: 'main', rootfolderpath: 'solutions/RetailOS' }],
      }],
    }),
  });
  const retail = r.solutions.find((s) => s.uniqueName === 'RetailOS');
  const intern = r.solutions.find((s) => s.uniqueName === 'InternLearning');
  assert.ok(retail.boundTo, 'RetailOS is bound');
  assert.equal(retail.boundTo.repository, 'srijan-pp-alm');
  assert.equal(intern.boundTo, null, 'InternLearning is not bound');
});

test('listing still succeeds when binding discovery throws (best-effort)', async (t) => {
  const server = await solutionsServer(SOLUTIONS_BODY);
  t.after(() => server.close());
  const r = await listSolutions({
    envUrl: serverUrl(server), token: 'tok',
    _discoverImpl: async () => { throw new Error('discovery exploded'); },
  });
  assert.equal(r.ok, true);
  assert.equal(r.count, 2);
  assert.equal(r.solutions[0].boundTo, null, 'boundTo defaults to null when discovery fails');
});

test('--no-bindings path skips discovery entirely', async (t) => {
  const server = await solutionsServer(SOLUTIONS_BODY);
  t.after(() => server.close());
  let discoverCalled = false;
  const r = await listSolutions({
    envUrl: serverUrl(server), token: 'tok', includeBindings: false,
    _discoverImpl: async () => { discoverCalled = true; return { ok: true, knownRepos: [] }; },
  });
  assert.equal(r.ok, true);
  assert.equal(discoverCalled, false, 'discovery must not run when includeBindings=false');
});

test('surfaces error + statusCode when the solutions query fails', async (t) => {
  const server = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Unauthorized' } }));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => server.close());
  const r = await listSolutions({ envUrl: serverUrl(server), token: 'tok' });
  assert.equal(r.ok, false);
  assert.equal(r.statusCode, 401);
});
