'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { listAdoFolders, API_VERSION, isEmptyRepo404 } = require('../lib/list-ado-folders');

// All tests use the _makeRequestImpl DI hook so they run entirely offline.

// ===== constants =====

test('API_VERSION is stable 7.1 and empty repo detector recognizes TF401174', () => {
  assert.equal(API_VERSION, '7.1');
  assert.equal(isEmptyRepo404({ statusCode: 404, body: 'TF401174 does not exist' }), true);
});

// ===== argument validation =====

test('required-arg validation: --organization missing', async () => {
  const r = await listAdoFolders({ project:'p', repository:'r', token:'t' });
  assert.equal(r.ok, false); assert.match(r.error, /organization/);
});
test('required-arg validation: --project missing', async () => {
  const r = await listAdoFolders({ organization:'o', repository:'r', token:'t' });
  assert.equal(r.ok, false); assert.match(r.error, /project/);
});
test('required-arg validation: --repository missing', async () => {
  const r = await listAdoFolders({ organization:'o', project:'p', token:'t' });
  assert.equal(r.ok, false); assert.match(r.error, /repository/);
});
test('required-arg validation: --token missing', async () => {
  const r = await listAdoFolders({ organization:'o', project:'p', repository:'r' });
  assert.equal(r.ok, false); assert.match(r.error, /token/);
});

// ===== happy path =====

test('happy path with mixed folders + files returns only folders', async () => {
  const r = await listAdoFolders({ organization:'o', project:'p', repository:'r', token:'t', _makeRequestImpl: async () => ({ statusCode: 200, body: JSON.stringify({ value: [ { path:'/solutions', isFolder:true, gitObjectType:'tree' }, { path:'/README.md', isFolder:false, gitObjectType:'blob' }, { path:'/weird', isFolder:true, gitObjectType:'blob' } ] }) }) });
  assert.equal(r.ok, true); assert.equal(r.count, 1); assert.equal(r.folders[0].path, '/solutions');
});

test('empty-repo 404 → ok:true folders:[] emptyRepo:true', async () => {
  const r = await listAdoFolders({ organization:'o', project:'p', repository:'r', token:'t', _makeRequestImpl: async () => ({ statusCode: 404, body: 'TF401174: The item does not exist' }) });
  assert.equal(r.ok, true); assert.equal(r.emptyRepo, true); assert.deepEqual(r.folders, []);
});

test('file-only response → folders:[]', async () => {
  const r = await listAdoFolders({ organization:'o', project:'p', repository:'r', token:'t', _makeRequestImpl: async () => ({ statusCode: 200, body: JSON.stringify({ value: [{ path:'/a.txt', isFolder:false, gitObjectType:'blob' }] }) }) });
  assert.equal(r.ok, true); assert.deepEqual(r.folders, []);
});

test('DI-captured query params include scopePath=/ and recursionLevel=OneLevel', async () => {
  let url;
  await listAdoFolders({ organization:'o', project:'p', repository:'r', token:'t', _makeRequestImpl: async (opts) => { url=opts.url; return { statusCode: 200, body: JSON.stringify({ value: [] }) }; } });
  assert.match(url, /scopePath=\//); assert.match(url, /recursionLevel=OneLevel/);
});

// ===== error paths =====

test('generic 404 with non-empty-repo signal → ok:false', async () => {
  const r = await listAdoFolders({ organization:'o', project:'p', repository:'r', token:'t', _makeRequestImpl: async () => ({ statusCode: 404, body: 'not found' }) });
  assert.equal(r.ok, false); assert.equal(r.statusCode, 404);
});

test('401 → ok:false', async () => {
  const r = await listAdoFolders({ organization:'o', project:'p', repository:'r', token:'t', _makeRequestImpl: async () => ({ statusCode: 401, body: '{}' }) });
  assert.equal(r.ok, false); assert.match(r.hint, /Token rejected/);
});

test('response missing value array → ok:false', async () => {
  const r = await listAdoFolders({ organization:'o', project:'p', repository:'r', token:'t', _makeRequestImpl: async () => ({ statusCode: 200, body: '{}' }) });
  assert.equal(r.ok, false); assert.match(r.error, /value array/);
});

test('non-JSON response → ok:false', async () => {
  const r = await listAdoFolders({ organization:'o', project:'p', repository:'r', token:'t', _makeRequestImpl: async () => ({ statusCode: 200, body: 'nope' }) });
  assert.equal(r.ok, false); assert.match(r.error, /parse items/);
});

test('list-ado-folders: --tokenFile JSON envelope resolves for Authorization header', async () => {
  const fs = require('node:fs'); const path = require('node:path');
  const tokenFile = path.join(__dirname, '.ado-token-list-ado-folders.json');
  fs.writeFileSync(tokenFile, JSON.stringify({ token: 'header.payload.sig' }));
  try {
    let header;
    const r = await listAdoFolders({ organization: 'org', project: 'proj', repository: 'repo', tokenFile, _makeRequestImpl: async (opts) => { header = opts.headers.Authorization; return { statusCode: 200, body: JSON.stringify({ value: [] }) }; } });
    assert.equal(r.ok, true);
    assert.equal(header, 'Bearer header.payload.sig');
  } finally { fs.rmSync(tokenFile, { force: true }); }
});
