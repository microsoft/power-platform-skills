'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAdoRepo, API_VERSION } = require('../lib/create-ado-repo');

// All tests use the _makeRequestImpl DI hook so they run entirely offline.

// ===== constants =====

test('API_VERSION is stable 7.1', () => assert.equal(API_VERSION, '7.1'));

// ===== argument validation =====

test('required-arg validation: --organization missing', async () => { const r=await createAdoRepo({ project:'p', projectId:'pid', name:'r', token:'t' }); assert.equal(r.ok,false); assert.match(r.error,/organization/); });
test('required-arg validation: --project missing', async () => { const r=await createAdoRepo({ organization:'o', projectId:'pid', name:'r', token:'t' }); assert.equal(r.ok,false); assert.match(r.error,/project/); });
test('required-arg validation: --projectId missing', async () => { const r=await createAdoRepo({ organization:'o', project:'p', name:'r', token:'t' }); assert.equal(r.ok,false); assert.match(r.error,/projectId/); });
test('required-arg validation: --name missing', async () => { const r=await createAdoRepo({ organization:'o', project:'p', projectId:'pid', token:'t' }); assert.equal(r.ok,false); assert.match(r.error,/name/); });
test('required-arg validation: --token missing', async () => { const r=await createAdoRepo({ organization:'o', project:'p', projectId:'pid', name:'r' }); assert.equal(r.ok,false); assert.match(r.error,/token/); });

// ===== happy path =====

test('happy path', async () => {
  const r = await createAdoRepo({ organization:'o', project:'p', projectId:'pid', name:'repo', token:'t', _makeRequestImpl: async () => ({ statusCode:201, body: JSON.stringify({ id:'rid', name:'repo', defaultBranch:null, webUrl:'web' }) }) });
  assert.equal(r.ok,true); assert.equal(r.repoId,'rid'); assert.equal(r.defaultBranch,null); assert.equal(r.webUrl,'web');
});

test('DI body matches spec', async () => {
  let body;
  await createAdoRepo({ organization:'o', project:'p', projectId:'pid', name:'repo', token:'t', _makeRequestImpl: async (opts) => { body=JSON.parse(opts.body); return { statusCode:201, body: JSON.stringify({ id:'rid', name:'repo' }) }; } });
  assert.deepEqual(body, { name:'repo', project:{ id:'pid' } });
});

test('project name URL-encoded in URL', async () => {
  let url;
  await createAdoRepo({ organization:'org', project:'project space', projectId:'pid', name:'repo', token:'t', _makeRequestImpl: async (opts) => { url=opts.url; return { statusCode:201, body: JSON.stringify({ id:'rid', name:'repo' }) }; } });
  assert.match(url, /org\/project%20space\/_apis\/git\/repositories/);
});

// ===== error paths =====

test('201 response missing id → ok:false', async () => {
  const r=await createAdoRepo({ organization:'o', project:'p', projectId:'pid', name:'repo', token:'t', _makeRequestImpl: async () => ({ statusCode:201, body: JSON.stringify({ name:'repo' }) }) });
  assert.equal(r.ok,false); assert.match(r.error,/id field/);
});

test('401 → ok:false', async () => { const r=await createAdoRepo({ organization:'o', project:'p', projectId:'pid', name:'repo', token:'t', _makeRequestImpl: async () => ({ statusCode:401, body:'{}' }) }); assert.equal(r.ok,false); assert.match(r.hint,/Token rejected/); });
test('403 with hint', async () => { const r=await createAdoRepo({ organization:'o', project:'p', projectId:'pid', name:'repo', token:'t', _makeRequestImpl: async () => ({ statusCode:403, body:'{}' }) }); assert.equal(r.ok,false); assert.match(r.hint,/Project Administrator/); });
test('409 with hint', async () => { const r=await createAdoRepo({ organization:'o', project:'p', projectId:'pid', name:'repo', token:'t', _makeRequestImpl: async () => ({ statusCode:409, body:'{}' }) }); assert.equal(r.ok,false); assert.match(r.hint,/already exists/); });
test('404 project not found', async () => { const r=await createAdoRepo({ organization:'o', project:'p', projectId:'pid', name:'repo', token:'t', _makeRequestImpl: async () => ({ statusCode:404, body:'{}' }) }); assert.equal(r.ok,false); assert.match(r.hint,/Project "p" not found/); });
