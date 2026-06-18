'use strict';

const { withNoAdoAcquire } = require('./ado-test-helpers');

const test = require('node:test');
const assert = require('node:assert/strict');
const { listAdoRepos, API_VERSION } = require('../lib/list-ado-repos');

// All tests use the _makeRequestImpl DI hook so they run entirely offline.

// ===== constants =====

test('API_VERSION is stable 7.1', () => assert.equal(API_VERSION, '7.1'));

// ===== argument validation =====

test('required-arg validation: --organization missing', async () => {
  const r = await listAdoRepos({ project: 'p', token: 't' });
  assert.equal(r.ok, false); assert.match(r.error, /organization/);
});
test('required-arg validation: --project missing', async () => {
  const r = await listAdoRepos({ organization: 'o', token: 't' });
  assert.equal(r.ok, false); assert.match(r.error, /project/);
});
test('required-arg validation: --token missing', async () => {
  const r = await withNoAdoAcquire(() => listAdoRepos({ organization: 'o', project: 'p' }));
  assert.equal(r.ok, false); assert.match(r.error, /token/);
});

// ===== happy path =====

test('happy path with mixed initialized + empty repos', async () => {
  const r = await listAdoRepos({ organization: 'o', project: 'p', token: 't', _makeRequestImpl: async () => ({ statusCode: 200, body: JSON.stringify({ value: [ { id: 'r1', name: 'init', defaultBranch: 'refs/heads/main', size: 10, webUrl: 'u1' }, { id: 'r2', name: 'empty', size: 0 } ] }) }) });
  assert.equal(r.ok, true);
  assert.equal(r.count, 2);
  assert.equal(r.repos[0].defaultBranch, 'refs/heads/main');
  assert.equal(r.repos[1].defaultBranch, null);
});

test('empty repos array', async () => {
  const r = await listAdoRepos({ organization: 'o', project: 'p', token: 't', _makeRequestImpl: async () => ({ statusCode: 200, body: JSON.stringify({ value: [] }) }) });
  assert.equal(r.ok, true); assert.deepEqual(r.repos, []);
});

test('DI URL encoding includes encoded org and project', async () => {
  let url;
  await listAdoRepos({ organization: 'org space', project: 'proj space', token: 't', _makeRequestImpl: async (opts) => { url=opts.url; return { statusCode: 200, body: JSON.stringify({ value: [] }) }; } });
  assert.match(url, /dev\.azure\.com\/org%20space\/proj%20space\/_apis\/git\/repositories/);
});

test('repo with isDisabled:true still appears in list', async () => {
  const r = await listAdoRepos({ organization:'o', project:'p', token:'t', _makeRequestImpl: async () => ({ statusCode: 200, body: JSON.stringify({ value: [{ id:'r', name:'disabled', isDisabled:true }] }) }) });
  assert.equal(r.ok, true); assert.equal(r.repos[0].isDisabled, true);
});

test('DI Authorization header uses Basic for PAT', async () => {
  let header;
  await listAdoRepos({ organization:'o', project:'p', token:'pat', _makeRequestImpl: async (opts) => { header=opts.headers.Authorization; return { statusCode: 200, body: JSON.stringify({ value: [] }) }; } });
  assert.match(header, /^Basic /);
});

// ===== error paths =====

test('401 → ok:false with hint', async () => {
  const r = await listAdoRepos({ organization:'o', project:'p', token:'t', _makeRequestImpl: async () => ({ statusCode: 401, body: '{}' }) });
  assert.equal(r.ok, false); assert.match(r.hint, /Token rejected/);
});

test('404 project not found → ok:false with hint', async () => {
  const r = await listAdoRepos({ organization:'o', project:'missing', token:'t', _makeRequestImpl: async () => ({ statusCode: 404, body: '{}' }) });
  assert.equal(r.ok, false); assert.match(r.hint, /Project "missing" not found/);
});

test('non-JSON body → ok:false', async () => {
  const r = await listAdoRepos({ organization:'o', project:'p', token:'t', _makeRequestImpl: async () => ({ statusCode: 200, body: 'not-json' }) });
  assert.equal(r.ok, false); assert.match(r.error, /parse repositories/);
});

test('missing value array → ok:false', async () => {
  const r = await listAdoRepos({ organization:'o', project:'p', token:'t', _makeRequestImpl: async () => ({ statusCode: 200, body: '{}' }) });
  assert.equal(r.ok, false); assert.match(r.error, /value array/);
});

test('list-ado-repos: --tokenFile JSON envelope resolves for Authorization header', async () => {
  const fs = require('node:fs'); const path = require('node:path');
  const tokenFile = path.join(__dirname, '.ado-token-list-ado-repos.json');
  fs.writeFileSync(tokenFile, JSON.stringify({ token: 'header.payload.sig' }));
  try {
    let header;
    const r = await listAdoRepos({ organization: 'org', project: 'proj', tokenFile, _makeRequestImpl: async (opts) => { header = opts.headers.Authorization; return { statusCode: 200, body: JSON.stringify({ value: [] }) }; } });
    assert.equal(r.ok, true);
    assert.equal(header, 'Bearer header.payload.sig');
  } finally { fs.rmSync(tokenFile, { force: true }); }
});
