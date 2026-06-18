'use strict';

const { withNoAdoAcquire } = require('./ado-test-helpers');

const test = require('node:test');
const assert = require('node:assert/strict');

const { listAdoOrgs, API_VERSION, GUID_RE } = require('../lib/list-ado-orgs');

// All tests use the _makeRequestImpl DI hook so they run entirely offline.

// ===== constants =====

test('API_VERSION is stable 7.1 and GUID_RE accepts GUIDs', () => {
  assert.equal(API_VERSION, '7.1');
  assert.ok(GUID_RE.test('11111111-2222-3333-4444-555555555555'));
});

// ===== argument validation =====

test('required-arg validation: --token missing', async () => {
  const r = await withNoAdoAcquire(() => listAdoOrgs({}));
  assert.equal(r.ok, false);
  assert.equal(r.statusCode, null);
  assert.match(r.error, /token/i);
});

// ===== happy path =====

test('valid 2-step happy path captures profile and accounts URLs', async () => {
  const calls = [];
  const fakeMake = async (opts) => {
    calls.push(opts);
    if (opts.url.includes('/profiles/me')) return { statusCode: 200, body: JSON.stringify({ id: '11111111-2222-3333-4444-555555555555' }) };
    return { statusCode: 200, body: JSON.stringify({ value: [{ accountId: 'a1', accountName: 'org1', accountUri: 'https://dev.azure.com/org1' }] }) };
  };
  const r = await listAdoOrgs({ token: 'tok', _makeRequestImpl: fakeMake });
  assert.equal(r.ok, true);
  assert.equal(r.memberId, '11111111-2222-3333-4444-555555555555');
  assert.equal(r.count, 1);
  assert.deepEqual(r.orgs[0], { accountId: 'a1', accountName: 'org1', accountUri: 'https://dev.azure.com/org1' });
  assert.match(calls[0].url, /profiles\/me\?api-version=7\.1/);
  assert.match(calls[1].url, /accounts\?api-version=7\.1&memberId=11111111-2222-3333-4444-555555555555/);
});

test('DI receives Authorization header on both requests', async () => {
  const headers = [];
  const fakeMake = async (opts) => {
    headers.push(opts.headers.Authorization);
    if (headers.length === 1) return { statusCode: 200, body: JSON.stringify({ id: '11111111-2222-3333-4444-555555555555' }) };
    return { statusCode: 200, body: JSON.stringify({ value: [] }) };
  };
  await listAdoOrgs({ token: 'plainPAT', _makeRequestImpl: fakeMake });
  assert.equal(headers.length, 2);
  assert.ok(headers.every((h) => h.startsWith('Basic ')));
});

test('empty accounts array → orgs:[]', async () => {
  let n = 0;
  const r = await listAdoOrgs({ token: 't', _makeRequestImpl: async () => (++n === 1 ? { statusCode: 200, body: JSON.stringify({ id: '11111111-2222-3333-4444-555555555555' }) } : { statusCode: 200, body: JSON.stringify({ value: [] }) }) });
  assert.equal(r.ok, true);
  assert.equal(r.count, 0);
  assert.deepEqual(r.orgs, []);
});

// ===== error paths =====

test('401 on profile → ok:false with profile scope hint', async () => {
  const r = await listAdoOrgs({ token: 't', _makeRequestImpl: async () => ({ statusCode: 401, body: JSON.stringify({ message: 'Unauthorized' }) }) });
  assert.equal(r.ok, false);
  assert.equal(r.statusCode, 401);
  assert.match(r.hint, /User Profile/);
});

test('401 on accounts → ok:false with accounts hint', async () => {
  let n = 0;
  const r = await listAdoOrgs({ token: 't', _makeRequestImpl: async () => (++n === 1 ? { statusCode: 200, body: JSON.stringify({ id: '11111111-2222-3333-4444-555555555555' }) } : { statusCode: 401, body: JSON.stringify({ message: 'Nope' }) }) });
  assert.equal(r.ok, false);
  assert.equal(r.statusCode, 401);
  assert.match(r.hint, /Accounts API/);
});

test('404 on accounts → signed-in hint', async () => {
  let n = 0;
  const r = await listAdoOrgs({ token: 't', _makeRequestImpl: async () => (++n === 1 ? { statusCode: 200, body: JSON.stringify({ id: '11111111-2222-3333-4444-555555555555' }) } : { statusCode: 404, body: '{}' }) });
  assert.equal(r.ok, false);
  assert.match(r.hint, /dev.azure.com/);
});

test('accounts response missing value → ok:false', async () => {
  let n = 0;
  const r = await listAdoOrgs({ token: 't', _makeRequestImpl: async () => (++n === 1 ? { statusCode: 200, body: JSON.stringify({ id: '11111111-2222-3333-4444-555555555555' }) } : { statusCode: 200, body: JSON.stringify({ count: 0 }) }) });
  assert.equal(r.ok, false);
  assert.match(r.error, /value array/);
});

test('memberId-not-GUID flagged', async () => {
  const r = await listAdoOrgs({ token: 't', _makeRequestImpl: async () => ({ statusCode: 200, body: JSON.stringify({ id: 'not-guid' }) }) });
  assert.equal(r.ok, false);
  assert.match(r.error, /GUID/);
});

test('profile non-JSON body → ok:false', async () => {
  const r = await listAdoOrgs({ token: 't', _makeRequestImpl: async () => ({ statusCode: 200, body: 'nope' }) });
  assert.equal(r.ok, false);
  assert.match(r.error, /parse profile/);
});

test('list-ado-orgs: --tokenFile JSON envelope resolves for Authorization header', async () => {
  const fs = require('node:fs'); const path = require('node:path');
  const tokenFile = path.join(__dirname, '.ado-token-list-ado-orgs.json');
  fs.writeFileSync(tokenFile, JSON.stringify({ token: 'header.payload.sig' }));
  try {
    const headers = [];
    const r = await listAdoOrgs({ tokenFile, _makeRequestImpl: async (opts) => { headers.push(opts.headers.Authorization); return headers.length === 1 ? { statusCode: 200, body: JSON.stringify({ id: '11111111-2222-3333-4444-555555555555' }) } : { statusCode: 200, body: JSON.stringify({ value: [] }) }; } });
    assert.equal(r.ok, true);
    assert.deepEqual(headers, ['Bearer header.payload.sig', 'Bearer header.payload.sig']);
  } finally { fs.rmSync(tokenFile, { force: true }); }
});
