'use strict';
// lib/app-roles.js: what the environment says about who can OPEN an app — the security roles associated with it (the `appmoduleroles` relationship) —
// read through the SDK, read-only. verify-model-app.js reads the same relationship for the roles its personas author, and the design document reads it
// for the roles the app already has, so the read is in one place; verify's own readers (appIdFor, appRoleIdsFor) moved there unchanged.
const test = require('node:test');
const assert = require('node:assert');
const { createAzHttpClient } = require('../lib/sdk-http-client.js');
const { withThrowawaySdk } = require('../lib/throwaway-sdk.js');
const { createFakeAppsOrg, json } = require('./helpers/fake-apps-org.js');
const roles = require('../lib/app-roles.js');

const { appIdFor, appRoleIdsFor, readAppRoleRows, appRolesOf } = roles;
const ORIGIN = 'https://contoso.crm.dynamics.com';
const APP_ID = '22222222-2222-4222-8222-222222222222';
const ROLE_A = '00000000-0000-4000-8000-0000000000AA';
const ROLE_B = '00000000-0000-4000-8000-0000000000bb';

// An SDK stand-in. `rows` answers the association read; `get` may replace it. Every call is recorded.
function fakeSdk({ appRows = [{ appmoduleid: APP_ID }], rows = [], status = 200, get, find } = {}) {
  const calls = [];
  return {
    calls,
    queryRecords: async (set, options) => { calls.push({ method: 'queryRecords', set, options }); return appRows; },
    findArtifact: async (type, query) => { calls.push({ method: 'findArtifact', type, query }); return find ? find(type, query) : APP_ID; },
    dataverse: {
      get: async (url) => {
        calls.push({ method: 'get', url });
        return get ? get(url) : { status, headers: {}, body: status < 300 ? { value: rows } : { error: { message: 'denied' } } };
      },
    },
  };
}

// --- verify's readers, moved ----------------------------------------------------------------------------------------------------------

test('appIdFor and appRoleIdsFor are verify-model-app.js\u2019s own exports, now defined here', () => {
  const verify = require('../verify-model-app.js');
  assert.strictEqual(verify.appIdFor, appIdFor);
  assert.strictEqual(verify.appRoleIdsFor, appRoleIdsFor);
});

test('appIdFor finds the app by its unique name in the published layer — the lookup verify always made', async () => {
  const sdk = fakeSdk();
  assert.strictEqual(await appIdFor(sdk, "contoso's_app"), APP_ID);
  assert.deepStrictEqual(sdk.calls, [{ method: 'queryRecords', set: 'appmodule', options: { select: ['appmoduleid'], filter: "uniquename eq 'contoso''s_app'", top: 1 } }]);
  assert.strictEqual(await appIdFor(fakeSdk({ appRows: [] }), 'missing_app'), undefined);
});

test('appRoleIdsFor answers { ok, roleIds } in lower case, from one read of the association with only the role id selected', async () => {
  const sdk = fakeSdk({ rows: [{ roleid: ROLE_A }, { roleid: ROLE_B }, { roleid: null }, null, {}] });
  assert.deepStrictEqual(await appRoleIdsFor(sdk, 'contoso_app'), { ok: true, roleIds: [ROLE_A.toLowerCase(), ROLE_B.toLowerCase()] });
  assert.deepStrictEqual(sdk.calls.filter((c) => c.method === 'get'), [{ method: 'get', url: `/appmodules(${APP_ID})/appmoduleroles_association?$select=roleid` }]);
});

test('appRoleIdsFor fails closed with the reasons verify has always given', async () => {
  assert.deepStrictEqual(await appRoleIdsFor(fakeSdk({ appRows: [] }), 'gone_app'), { ok: false, reason: "app 'gone_app' could not be resolved" });
  assert.deepStrictEqual(await appRoleIdsFor(fakeSdk({ status: 403 }), 'a'), { ok: false, reason: 'HTTP 403' });
  assert.deepStrictEqual(await appRoleIdsFor({ queryRecords: async () => [{ appmoduleid: APP_ID }] }, 'a'), { ok: false, reason: 'SDK dataverse reader is unavailable' });
  const thrown = await appRoleIdsFor(fakeSdk({ get: async () => { throw new Error('x'.repeat(300)); } }), 'a');
  assert.strictEqual(thrown.ok, false);
  assert.strictEqual(thrown.reason.length, 200, 'the reason is cut at 200 characters');
  assert.strictEqual((await appRoleIdsFor({ queryRecords: async () => { throw new Error(); } }, 'a')).reason, 'read failed');
});

// --- the read the design document makes -----------------------------------------------------------------------------------------------

test('readAppRoleRows reads the app\u2019s association rows with the columns it is asked for and nothing else', async () => {
  const sdk = fakeSdk({ rows: [{ roleid: ROLE_A, name: 'Viewer' }] });
  assert.deepStrictEqual(await readAppRoleRows(sdk, APP_ID, ['roleid', 'name', 'ismanaged']), { ok: true, rows: [{ roleid: ROLE_A, name: 'Viewer' }] });
  assert.deepStrictEqual(sdk.calls, [{ method: 'get', url: `/appmodules(${APP_ID})/appmoduleroles_association?$select=roleid,name,ismanaged` }]);
  assert.deepStrictEqual(await readAppRoleRows(fakeSdk({ status: 404 }), APP_ID, ['roleid']), { ok: false, reason: 'HTTP 404' });
  assert.deepStrictEqual(await readAppRoleRows({}, APP_ID, ['roleid']), { ok: false, reason: 'SDK dataverse reader is unavailable' });
  assert.deepStrictEqual(await readAppRoleRows(fakeSdk({ get: async () => undefined }), APP_ID, ['roleid']), { ok: false, reason: 'HTTP undefined' });
});

test('appRolesOf finds the app as the build does — findArtifact — and lists its roles, by name', async () => {
  const sdk = fakeSdk({ rows: [
    { roleid: ROLE_B, name: 'Zeta', ismanaged: true },
    { roleid: ROLE_A, name: 'alpha', ismanaged: false },
    { roleid: '00000000-0000-4000-8000-0000000000cc', name: 'Alpha' },
    { name: 'no id' },
    null,
  ] });
  const answer = await appRolesOf(sdk, 'contoso_pm');
  assert.deepStrictEqual(sdk.calls.map((c) => c.method), ['findArtifact', 'get'], 'not the published-layer lookup verify makes');
  assert.deepStrictEqual(sdk.calls[0], { method: 'findArtifact', type: 'app', query: { uniqueName: 'contoso_pm' } });
  assert.strictEqual(answer.state, 'read');
  assert.strictEqual(answer.appUnique, 'contoso_pm');
  assert.strictEqual(answer.appId, APP_ID);
  // By name with the letter case ignored, then by the name as written (code units: a capital first), then by id: the same order on every machine.
  assert.deepStrictEqual(answer.roles, [
    { roleId: '00000000-0000-4000-8000-0000000000cc', name: 'Alpha', managed: false },
    { roleId: ROLE_A.toLowerCase(), name: 'alpha', managed: false },
    { roleId: ROLE_B.toLowerCase(), name: 'Zeta', managed: true },
  ]);
});

test('appRolesOf says an app with no row is absent, and reads no association', async () => {
  const sdk = fakeSdk({ find: async () => null });
  assert.deepStrictEqual(await appRolesOf(sdk, 'contoso_pm'), { state: 'absent', appUnique: 'contoso_pm' });
  assert.deepStrictEqual(sdk.calls.map((c) => c.method), ['findArtifact']);
});

test('appRolesOf never throws: a refused read, a failed lookup and an SDK without the method are all "unreadable", with the reason', async () => {
  assert.deepStrictEqual(await appRolesOf(fakeSdk({ status: 403 }), 'a'), { state: 'unreadable', appUnique: 'a', reason: 'HTTP 403' });
  assert.deepStrictEqual(await appRolesOf(fakeSdk({ find: async () => { throw new Error('two apps share the unique name'); } }), 'a'), { state: 'unreadable', appUnique: 'a', reason: 'two apps share the unique name' });
  assert.deepStrictEqual(await appRolesOf({ dataverse: { get: async () => ({ status: 200, body: { value: [] } }) } }, 'a'), { state: 'unreadable', appUnique: 'a', reason: 'the SDK has no app lookup' });
  const long = await appRolesOf(fakeSdk({ get: async () => { throw new Error('y'.repeat(500)); } }), 'a');
  assert.strictEqual(long.state, 'unreadable');
  assert.strictEqual(long.reason.length, 200);
  assert.strictEqual((await appRolesOf(fakeSdk({ rows: 'x', get: async () => ({ status: 200, body: { value: 'x' } }) }), 'a')).state, 'read', 'an answer with no list of roles is no roles');
});

// --- the real bundle ---------------------------------------------------------------------------------------------------------------------

const client = (org) => createAzHttpClient(ORIGIN, { getToken: () => 'test-token', request: org.request, sleep: async () => {} });
const association = (rows) => (req) => (req.method === 'GET' && /\/appmoduleroles_association\?/.test(req.path) ? json(200, { value: rows }) : undefined);

test('REAL BUNDLE: a published app is found the way the build finds it, its roles are read with one GET, and nothing is written', async () => {
  const org = createFakeAppsOrg({
    apps: [{ appmoduleid: APP_ID, name: 'Contoso PM', uniquename: 'contoso_pm', componentstate: 0 }],
    answer: association([{ roleid: ROLE_A, name: 'Contoso PM - Viewer', ismanaged: false }, { roleid: ROLE_B, name: 'Contoso PM - Project Manager', ismanaged: true }]),
  });
  const answer = await withThrowawaySdk({ env: ORIGIN, prefix: 'app-roles-test-', httpClient: client(org) }, (make) => appRolesOf(make(), 'contoso_pm'));
  assert.strictEqual(answer.state, 'read', JSON.stringify(answer));
  assert.deepStrictEqual(answer.roles.map((r) => [r.name, r.managed]), [['Contoso PM - Project Manager', true], ['Contoso PM - Viewer', false]]);
  assert.deepStrictEqual(org.writes(), []);
  assert.deepStrictEqual(org.unexpected, []);
  const gets = org.requests.filter((r) => /appmoduleroles_association/.test(r.path));
  assert.deepStrictEqual(gets.map((r) => `${r.method} ${r.path}`), [`GET /appmodules(${APP_ID})/appmoduleroles_association?$select=roleid,name,ismanaged`]);
});

test('REAL BUNDLE: an app the environment does not have is absent — a draft that was never published too, as it is to the build\u2019s own probe', async () => {
  for (const apps of [[], [{ appmoduleid: APP_ID, name: 'Contoso PM', uniquename: 'contoso_pm', componentstate: 1 }]]) {
    const org = createFakeAppsOrg({ apps, answer: association([{ roleid: ROLE_A, name: 'R' }]) });
    assert.deepStrictEqual(
      await withThrowawaySdk({ env: ORIGIN, prefix: 'app-roles-test-', httpClient: client(org) }, (make) => appRolesOf(make(), 'contoso_pm')),
      { state: 'absent', appUnique: 'contoso_pm' },
    );
    assert.deepStrictEqual(org.writes(), []);
    assert.ok(!org.requests.some((r) => /appmoduleroles_association/.test(r.path)), 'no app, no association read');
  }
});

test('REAL BUNDLE: a refused association read is unreadable with its status, and writes nothing', async () => {
  const refused = createFakeAppsOrg({
    apps: [{ appmoduleid: APP_ID, name: 'Contoso PM', uniquename: 'contoso_pm', componentstate: 0 }],
    answer: (req) => (/appmoduleroles_association/.test(req.path) ? json(403, { error: { code: '0x80040220', message: 'denied' } }) : undefined),
  });
  const answer = await withThrowawaySdk({ env: ORIGIN, prefix: 'app-roles-test-', httpClient: client(refused) }, (make) => appRolesOf(make(), 'contoso_pm'));
  assert.strictEqual(answer.state, 'unreadable', JSON.stringify(answer));
  assert.match(answer.reason, /403|denied/);
  assert.deepStrictEqual(refused.writes(), []);
});

test('REAL BUNDLE: verify\u2019s published-layer reader still answers what it did, over the same fake', async () => {
  const org = createFakeAppsOrg({
    apps: [{ appmoduleid: APP_ID, name: 'Contoso PM', uniquename: 'contoso_pm', componentstate: 0 }],
    answer: association([{ roleid: ROLE_A }, { roleid: ROLE_B }]),
  });
  const answer = await withThrowawaySdk({ env: ORIGIN, prefix: 'app-roles-test-', httpClient: client(org) }, (make) => appRoleIdsFor(make(), 'contoso_pm'));
  assert.deepStrictEqual(answer, { ok: true, roleIds: [ROLE_A.toLowerCase(), ROLE_B.toLowerCase()] });
  assert.ok(org.requests.some((r) => r.path === `/appmodules(${APP_ID})/appmoduleroles_association?$select=roleid`));
  assert.deepStrictEqual(org.writes(), []);
});
