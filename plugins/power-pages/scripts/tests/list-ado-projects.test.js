'use strict';

const { withNoAdoAcquire } = require('./ado-test-helpers');

const test = require('node:test');
const assert = require('node:assert/strict');
const { listAdoProjects, API_VERSION } = require('../lib/list-ado-projects');

// All tests use the _makeRequestImpl DI hook so they run entirely offline.

// ===== constants =====

test('API_VERSION is stable 7.1', () => { assert.equal(API_VERSION, '7.1'); });

// ===== argument validation =====

test('required-arg validation: --organization missing', async () => {
  const r = await listAdoProjects({ token: 't' });
  assert.equal(r.ok, false);
  assert.match(r.error, /organization/);
});

test('required-arg validation: --token missing', async () => {
  const r = await withNoAdoAcquire(() => listAdoProjects({ organization: 'o' }));
  assert.equal(r.ok, false);
  assert.match(r.error, /token/);
});

// ===== happy path =====

test('happy path with multi-project response', async () => {
  const r = await listAdoProjects({ organization: 'org', token: 'jwt.a.b', _makeRequestImpl: async () => ({ statusCode: 200, body: JSON.stringify({ value: [ { id: 'p1', name: 'One', description: 'd', state: 'wellFormed', visibility: 'private' }, { id: 'p2', name: 'Two', state: 'wellFormed' } ] }) }) });
  assert.equal(r.ok, true);
  assert.equal(r.count, 2);
  assert.equal(r.projects[0].name, 'One');
  assert.equal(r.projects[1].visibility, undefined);
});

test('empty value array → projects:[]', async () => {
  const r = await listAdoProjects({ organization: 'org', token: 't', _makeRequestImpl: async () => ({ statusCode: 200, body: JSON.stringify({ value: [] }) }) });
  assert.equal(r.ok, true);
  assert.deepEqual(r.projects, []);
});

test('DI-captured URL includes encoded org', async () => {
  let url;
  await listAdoProjects({ organization: 'org with space', token: 't', _makeRequestImpl: async (opts) => { url = opts.url; return { statusCode: 200, body: JSON.stringify({ value: [] }) }; } });
  assert.match(url, /dev\.azure\.com\/org%20with%20space\/_apis\/projects/);
});

test('DI-captured Authorization header uses Bearer for JWT', async () => {
  let header;
  await listAdoProjects({ organization: 'org', token: 'a.b.c', _makeRequestImpl: async (opts) => { header = opts.headers.Authorization; return { statusCode: 200, body: JSON.stringify({ value: [] }) }; } });
  assert.equal(header, 'Bearer a.b.c');
});

// ===== error paths =====

test('401 → token scope hint', async () => {
  const r = await listAdoProjects({ organization: 'org', token: 't', _makeRequestImpl: async () => ({ statusCode: 401, body: JSON.stringify({ message: 'Unauthorized' }) }) });
  assert.equal(r.ok, false);
  assert.match(r.hint, /Token rejected/);
});

test('404 → organization not found hint', async () => {
  const r = await listAdoProjects({ organization: 'missing', token: 't', _makeRequestImpl: async () => ({ statusCode: 404, body: '{}' }) });
  assert.equal(r.ok, false);
  assert.equal(r.statusCode, 404);
  assert.match(r.hint, /Organization "missing" not found/);
});

test('non-JSON body → ok:false', async () => {
  const r = await listAdoProjects({ organization: 'org', token: 't', _makeRequestImpl: async () => ({ statusCode: 200, body: 'nope' }) });
  assert.equal(r.ok, false);
  assert.match(r.error, /parse projects/);
});

test('response missing value array → ok:false', async () => {
  const r = await listAdoProjects({ organization: 'org', token: 't', _makeRequestImpl: async () => ({ statusCode: 200, body: '{}' }) });
  assert.equal(r.ok, false);
  assert.match(r.error, /value array/);
});

test('network error → ok:false statusCode:null', async () => {
  const r = await listAdoProjects({ organization: 'org', token: 't', _makeRequestImpl: async () => ({ error: 'ECONNRESET' }) });
  assert.equal(r.ok, false);
  assert.equal(r.statusCode, null);
  assert.match(r.error, /ECONNRESET/);
});

test('list-ado-projects: --tokenFile JSON envelope resolves for Authorization header', async () => {
  const fs = require('node:fs'); const path = require('node:path');
  const tokenFile = path.join(__dirname, '.ado-token-list-ado-projects.json');
  fs.writeFileSync(tokenFile, JSON.stringify({ token: 'header.payload.sig' }));
  try {
    let header;
    const r = await listAdoProjects({ organization: 'org', tokenFile, _makeRequestImpl: async (opts) => { header = opts.headers.Authorization; return { statusCode: 200, body: JSON.stringify({ value: [] }) }; } });
    assert.equal(r.ok, true);
    assert.equal(header, 'Bearer header.payload.sig');
  } finally { fs.rmSync(tokenFile, { force: true }); }
});
