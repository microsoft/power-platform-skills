'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { discoverBindings, classifyBinding, gitProviderName, ZERO_GUID } = require('../lib/discover-bindings');

// Path-routed mock Dataverse: maps entity-set name → response body. Robust to
// the helper issuing a variable number of requests (the solutions lookup only
// fires when there is at least one solution binding).
function routedServer(routes) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const hit = Object.keys(routes).find((k) => req.url.includes(k));
      const body = hit ? routes[hit] : { value: [] };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}
function serverUrl(s) { const { address, port } = s.address(); return `http://${address}:${port}`; }

// ===== pure helpers =====

test('classifyBinding: null → environment', () => {
  assert.equal(classifyBinding(null), 'environment');
});

test('classifyBinding: ZERO_GUID → environment (the live POC-2 env-binding case)', () => {
  assert.equal(classifyBinding(ZERO_GUID), 'environment');
  assert.equal(classifyBinding('00000000-0000-0000-0000-000000000000'), 'environment');
});

test('classifyBinding: real solution GUID → solution', () => {
  assert.equal(classifyBinding('52cdfb68-415e-f111-a826-6045bd08be8b'), 'solution');
});

test('gitProviderName: 0 → AzureDevOps, others → Unknown(n)', () => {
  assert.equal(gitProviderName(0), 'AzureDevOps');
  assert.equal(gitProviderName(1), 'Unknown(1)');
});

// ===== discoverBindings =====

test('no Git integration: empty configs → ok:true with empty knownRepos', async () => {
  const server = await routedServer({
    sourcecontrolconfigurations: { value: [] },
    sourcecontrolbranchconfigurations: { value: [] },
  });
  try {
    const r = await discoverBindings({ envUrl: serverUrl(server), token: 'tok' });
    assert.equal(r.ok, true);
    assert.deepEqual(r.knownRepos, []);
    assert.deepEqual(r.summary, { repoCount: 0, activeBindingCount: 0, tornDownRepoCount: 0 });
  } finally { server.close(); }
});

test('env binding (zero-GUID partitionid) is classified as environment, no solution lookup needed', async () => {
  const cfgId = 'ad5593b5-7a0f-448c-a5f6-d764bcc028e9';
  const server = await routedServer({
    sourcecontrolconfigurations: { value: [
      { sourcecontrolconfigurationid: cfgId, organizationname: 'GitIntegration22', projectname: 'srijan-pp-alm', repositoryname: 'srijan-pp-alm', gitprovider: 0, createdon: '2026-06-13T14:13:39Z' },
    ] },
    sourcecontrolbranchconfigurations: { value: [
      { branchname: 'main', rootfolderpath: 'solutions', partitionid: ZERO_GUID, _sourcecontrolconfigurationid_value: cfgId, branchsyncedcommitid: '924ec73d' },
    ] },
  });
  try {
    const r = await discoverBindings({ envUrl: serverUrl(server), token: 'tok' });
    assert.equal(r.knownRepos.length, 1);
    const repo = r.knownRepos[0];
    assert.equal(repo.organizationname, 'GitIntegration22');
    assert.equal(repo.gitProviderName, 'AzureDevOps');
    assert.equal(repo.branchConfigs.length, 1);
    assert.equal(repo.branchConfigs[0].bindingType, 'environment');
    assert.equal(repo.branchConfigs[0].solutionId, null);
    assert.equal(repo.branchConfigs[0].solutionUniqueName, null);
    assert.equal(r.summary.activeBindingCount, 1);
  } finally { server.close(); }
});

test('solution binding resolves solutionUniqueName from the solutionid partitionid', async () => {
  const cfgId = 'ad5593b5-7a0f-448c-a5f6-d764bcc028e9';
  const solId = '52cdfb68-415e-f111-a826-6045bd08be8b';
  const server = await routedServer({
    sourcecontrolconfigurations: { value: [
      { sourcecontrolconfigurationid: cfgId, organizationname: 'GitIntegration22', projectname: 'srijan-pp-alm', repositoryname: 'srijan-pp-alm', gitprovider: 0, createdon: '2026-06-13T14:13:39Z' },
    ] },
    sourcecontrolbranchconfigurations: { value: [
      { branchname: 'main', rootfolderpath: 'solutions/RetailOS', partitionid: solId, _sourcecontrolconfigurationid_value: cfgId, branchsyncedcommitid: '887f7792' },
    ] },
    solutions: { value: [ { solutionid: solId, uniquename: 'RetailOS' } ] },
  });
  try {
    const r = await discoverBindings({ envUrl: serverUrl(server), token: 'tok' });
    const bc = r.knownRepos[0].branchConfigs[0];
    assert.equal(bc.bindingType, 'solution');
    assert.equal(bc.solutionId, solId);
    assert.equal(bc.solutionUniqueName, 'RetailOS');
    assert.equal(bc.rootfolderpath, 'solutions/RetailOS');
  } finally { server.close(); }
});

test('mixed env + solution rows on one config (the live POC-2 shape) both surface under one repo', async () => {
  const cfgId = 'ad5593b5-7a0f-448c-a5f6-d764bcc028e9';
  const solId = '52cdfb68-415e-f111-a826-6045bd08be8b';
  const server = await routedServer({
    sourcecontrolconfigurations: { value: [
      { sourcecontrolconfigurationid: cfgId, organizationname: 'GitIntegration22', projectname: 'srijan-pp-alm', repositoryname: 'srijan-pp-alm', gitprovider: 0, createdon: '2026-06-13T14:13:39Z' },
    ] },
    sourcecontrolbranchconfigurations: { value: [
      { branchname: 'main', rootfolderpath: 'solutions/RetailOS', partitionid: solId, _sourcecontrolconfigurationid_value: cfgId, branchsyncedcommitid: '887f7792' },
      { branchname: 'main', rootfolderpath: 'solutions', partitionid: ZERO_GUID, _sourcecontrolconfigurationid_value: cfgId, branchsyncedcommitid: '924ec73d' },
    ] },
    solutions: { value: [ { solutionid: solId, uniquename: 'RetailOS' } ] },
  });
  try {
    const r = await discoverBindings({ envUrl: serverUrl(server), token: 'tok' });
    assert.equal(r.knownRepos.length, 1, 'both branch rows group under one repo');
    const types = r.knownRepos[0].branchConfigs.map((b) => b.bindingType).sort();
    assert.deepEqual(types, ['environment', 'solution']);
    assert.equal(r.summary.activeBindingCount, 2);
    assert.equal(r.summary.tornDownRepoCount, 0);
  } finally { server.close(); }
});

test('torn-down repo (config row with no branch rows) is counted as tornDownRepoCount', async () => {
  const server = await routedServer({
    sourcecontrolconfigurations: { value: [
      { sourcecontrolconfigurationid: 'cfg-ghost', organizationname: 'Org', projectname: 'Proj', repositoryname: 'Repo', gitprovider: 0, createdon: '2026-01-01T00:00:00Z' },
    ] },
    sourcecontrolbranchconfigurations: { value: [] },
  });
  try {
    const r = await discoverBindings({ envUrl: serverUrl(server), token: 'tok' });
    assert.equal(r.knownRepos.length, 1);
    assert.equal(r.knownRepos[0].branchConfigs.length, 0);
    assert.equal(r.summary.activeBindingCount, 0);
    assert.equal(r.summary.tornDownRepoCount, 1);
  } finally { server.close(); }
});

test('surfaces ok:false with the error when the configs query fails', async () => {
  const server = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Forbidden' } }));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const r = await discoverBindings({ envUrl: serverUrl(server), token: 'tok' });
    assert.equal(r.ok, false);
    assert.equal(r.statusCode, 403);
  } finally { server.close(); }
});
