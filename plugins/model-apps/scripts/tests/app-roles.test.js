'use strict';
// lib/app-roles.js: what the environment says about who can OPEN an app — the security roles associated with it (the `appmoduleroles` relationship) —
// read through the SDK, read-only. verify-model-app.js reads the same relationship for the roles its personas author (appIdFor, appRoleIdsFor: moved there
// unchanged), and the design document reads it for the roles the app already has (appRolesOf).
//
// What the document reads must be an ANSWER, never a guess: an app is absent only when neither layer has it, and a list of roles is "no roles" only when the
// platform answered a list with nothing in it — a draft that was never published, a refused read and an answer that is no list are each "not checked".
const test = require('node:test');
const assert = require('node:assert');
const { createAzHttpClient } = require('../lib/sdk-http-client.js');
const { withThrowawaySdk } = require('../lib/throwaway-sdk.js');
const { createFakeAppsOrg, json } = require('./helpers/fake-apps-org.js');
const roles = require('../lib/app-roles.js');

const { appIdFor, appRoleIdsFor, appRolesOf } = roles;
const ORIGIN = 'https://contoso.crm.dynamics.com';
const APP_ID = '22222222-2222-4222-8222-222222222222';
const ROLE_A = '00000000-0000-4000-8000-0000000000AA';
const ROLE_B = '00000000-0000-4000-8000-0000000000bb';
const ASSOCIATION = `/appmodules(${APP_ID})/appmoduleroles_association?$select=roleid,name,ismanaged`;

// An SDK stand-in. `appRows` answers the published-layer lookup verify makes; `resolve` the SDK's lookup in the saved layer (a draft is in it); `rows` answers
// the association read, `body` replaces the whole answer's body and `get` the whole answer. Every call is recorded. A method the code may not call is not there.
function fakeSdk({ appRows = [{ appmoduleid: APP_ID }], resolve, rows = [], body, status = 200, get } = {}) {
  const calls = [];
  return {
    calls,
    queryRecords: async (set, options) => { calls.push({ method: 'queryRecords', set, options }); return appRows; },
    resolveArtifact: async (type, query) => {
      calls.push({ method: 'resolveArtifact', type, query });
      return resolve ? resolve(type, query) : [{ id: APP_ID, name: 'Contoso PM', appModuleIdUnique: '33333333-3333-4333-8333-333333333333' }];
    },
    dataverse: {
      get: async (url) => {
        calls.push({ method: 'get', url });
        if (get) return get(url);
        return { status, headers: {}, body: status >= 300 ? { error: { message: 'denied' } } : (body !== undefined ? body : { value: rows }) };
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

test('appRoleIdsFor reads an answer that is not a list exactly as verify always did: no body is no ids, a value that is no list is the TypeError verify has always reported', async () => {
  for (const body of [{}, null, { value: null }]) assert.deepStrictEqual(await appRoleIdsFor(fakeSdk({ get: async () => ({ status: 200, body }) }), 'a'), { ok: true, roleIds: [] }, JSON.stringify(body));
  assert.deepStrictEqual(
    await appRoleIdsFor(fakeSdk({ body: { value: 'malformed' } }), 'a'),
    { ok: false, reason: '((res.body && res.body.value) || []).map is not a function' },
    'the reason verify gave before the design document read the same relationship',
  );
});

// --- the read the design document makes -----------------------------------------------------------------------------------------------

test('appRolesOf finds the app in the SAVED layer — the SDK\u2019s own lookup, which finds a draft — and lists its roles, by name', async () => {
  const sdk = fakeSdk({ rows: [
    { roleid: ROLE_B, name: 'Zeta', ismanaged: true },
    { roleid: ROLE_A, name: 'alpha', ismanaged: false },
    { roleid: '00000000-0000-4000-8000-0000000000cc', name: 'Alpha' },
  ] });
  const answer = await appRolesOf(sdk, 'contoso_pm');
  assert.deepStrictEqual(sdk.calls.map((c) => c.method), ['resolveArtifact', 'get'], 'not the published-layer lookup verify makes');
  assert.deepStrictEqual(sdk.calls[0], { method: 'resolveArtifact', type: 'app', query: { uniqueName: 'contoso_pm' } });
  assert.deepStrictEqual(sdk.calls[1], { method: 'get', url: ASSOCIATION });
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

test('appRolesOf says an app is absent only when the saved layer has no app, and reads no association', async () => {
  const sdk = fakeSdk({ resolve: async () => [] });
  assert.deepStrictEqual(await appRolesOf(sdk, 'contoso_pm'), { state: 'absent', appUnique: 'contoso_pm' });
  assert.deepStrictEqual(sdk.calls.map((c) => c.method), ['resolveArtifact']);
});

test('a draft app — saved, never published — is found, so it is never "absent": its roles are read if the platform answers, and not checked if it does not', async () => {
  // The published-layer lookup finds nothing for a draft (a draft answers 404 by id); the saved layer holds it.
  const answered = fakeSdk({ appRows: [], rows: [{ roleid: ROLE_A, name: 'Viewer' }] });
  assert.strictEqual((await appRolesOf(answered, 'contoso_pm')).state, 'read');
  assert.deepStrictEqual(answered.calls.map((c) => c.method), ['resolveArtifact', 'get'], 'the published layer is not asked');
  const refused = await appRolesOf(fakeSdk({ appRows: [], status: 404 }), 'contoso_pm');
  assert.deepStrictEqual(refused, { state: 'unreadable', appUnique: 'contoso_pm', reason: 'HTTP 404' });
});

test('a malformed or partial answer is "not checked", never evidence of no roles — only a list with nothing in it is', async () => {
  const bad = [
    ['no body', null],
    ['an empty object', {}],
    ['a value that is no list', { value: 'malformed' }],
    ['a null value', { value: null }],
    ['a row that is no object', { value: [null] }],
    ['a row with no role id', { value: [{ name: 'Viewer' }] }],
    ['a role id that is no text', { value: [{ roleid: 5 }] }],
    ['an empty role id', { value: [{ roleid: '' }] }],
    ['one good row beside a bad one', { value: [{ roleid: ROLE_A, name: 'Viewer' }, {}] }],
    ['a continuation link that is no link', { value: [{ roleid: ROLE_A, name: 'Viewer' }], '@odata.nextLink': 5 }],
  ];
  for (const [what, body] of bad) {
    const answer = await appRolesOf(fakeSdk({ get: async () => ({ status: 200, headers: {}, body }) }), 'contoso_pm');
    assert.strictEqual(answer.state, 'unreadable', `${what}: ${JSON.stringify(answer)}`);
    assert.ok(answer.reason && answer.reason.length <= 200, `${what}: it says why`);
  }
  assert.deepStrictEqual(await appRolesOf(fakeSdk({ rows: [] }), 'contoso_pm'), { state: 'read', appUnique: 'contoso_pm', appId: APP_ID, roles: [] }, 'a list with nothing in it is the one answer that says there are none');
});

test('a role the answer lists without a name is still a role: it is listed with the empty name, and found by its id', async () => {
  const answer = await appRolesOf(fakeSdk({ rows: [{ roleid: ROLE_A }] }), 'contoso_pm');
  assert.deepStrictEqual(answer.roles, [{ roleId: ROLE_A.toLowerCase(), name: '', managed: false }]);
});

test('a list the platform answers a page at a time is read to its end, and a link that repeats is not checked', async () => {
  const next = `${ORIGIN}/api/data/v9.0/appmodules(${APP_ID})/appmoduleroles_association?$select=roleid,name,ismanaged&$skiptoken=2`;
  const pages = fakeSdk({ get: async (url) => (/skiptoken=2/.test(url)
    ? { status: 200, body: { value: [{ roleid: ROLE_B, name: 'Beta' }] } }
    : { status: 200, body: { value: [{ roleid: ROLE_A, name: 'Alpha' }], '@odata.nextLink': next } }) });
  const answer = await appRolesOf(pages, 'contoso_pm');
  assert.deepStrictEqual(answer.roles.map((r) => r.name), ['Alpha', 'Beta']);
  assert.deepStrictEqual(pages.calls.filter((c) => c.method === 'get').map((c) => c.url), [ASSOCIATION, next]);
  const loop = await appRolesOf(fakeSdk({ get: async () => ({ status: 200, body: { value: [{ roleid: ROLE_A }], '@odata.nextLink': ASSOCIATION } }) }), 'contoso_pm');
  assert.strictEqual(loop.state, 'unreadable');
  assert.match(loop.reason, /repeated/);
});

test('appRolesOf never throws: a refused read, a failed lookup and an SDK without the methods are all "unreadable", with the reason', async () => {
  assert.deepStrictEqual(await appRolesOf(fakeSdk({ status: 403 }), 'a'), { state: 'unreadable', appUnique: 'a', reason: 'HTTP 403' });
  assert.deepStrictEqual(await appRolesOf(fakeSdk({ resolve: async () => { throw new Error('the lookup was refused'); } }), 'a'), { state: 'unreadable', appUnique: 'a', reason: 'the lookup was refused' });
  assert.deepStrictEqual(await appRolesOf({ dataverse: { get: async () => ({ status: 200, body: { value: [] } }) } }, 'a'), { state: 'unreadable', appUnique: 'a', reason: 'the SDK has no app lookup' });
  assert.deepStrictEqual(await appRolesOf({ resolveArtifact: async () => [{ id: APP_ID }] }, 'a'), { state: 'unreadable', appUnique: 'a', reason: 'SDK dataverse reader is unavailable' });
  for (const answer of [null, 'x', {}, [null], [{}], [{ id: '' }]]) {
    assert.strictEqual((await appRolesOf(fakeSdk({ resolve: async () => answer }), 'a')).state, 'unreadable', `a lookup that answers ${JSON.stringify(answer)} did not find an app`);
  }
  const long = await appRolesOf(fakeSdk({ get: async () => { throw new Error('y'.repeat(500)); } }), 'a');
  assert.strictEqual(long.state, 'unreadable');
  assert.strictEqual(long.reason.length, 200);
});

// --- the real bundle ---------------------------------------------------------------------------------------------------------------------

const client = (org) => createAzHttpClient(ORIGIN, { getToken: () => 'test-token', request: org.request, sleep: async () => {} });
const association = (rows) => (req) => (req.method === 'GET' && /\/appmoduleroles_association\?/.test(req.path) ? json(200, { value: rows }) : undefined);
const read = (org) => withThrowawaySdk({ env: ORIGIN, prefix: 'app-roles-test-', httpClient: client(org) }, (make) => appRolesOf(make(), 'contoso_pm'));
const published = { appmoduleid: APP_ID, name: 'Contoso PM', uniquename: 'contoso_pm', componentstate: 0 };
const draft = { ...published, componentstate: 1 };

test('REAL BUNDLE: a published app is found, its roles are read with one GET, and nothing is written', async () => {
  const org = createFakeAppsOrg({
    apps: [published],
    answer: association([{ roleid: ROLE_A, name: 'Contoso PM - Viewer', ismanaged: false }, { roleid: ROLE_B, name: 'Contoso PM - Project Manager', ismanaged: true }]),
  });
  const answer = await read(org);
  assert.strictEqual(answer.state, 'read', JSON.stringify(answer));
  assert.deepStrictEqual(answer.roles.map((r) => [r.name, r.managed]), [['Contoso PM - Project Manager', true], ['Contoso PM - Viewer', false]]);
  assert.deepStrictEqual(org.writes(), []);
  assert.deepStrictEqual(org.unexpected, []);
  const gets = org.requests.filter((r) => /appmoduleroles_association/.test(r.path));
  assert.deepStrictEqual(gets.map((r) => `${r.method} ${r.path}`), [`GET ${ASSOCIATION}`]);
});

test('REAL BUNDLE: a draft app — saved, never published — is not absent: it is in the list apps.js shows, its roles are read when the platform answers them', async () => {
  const org = createFakeAppsOrg({ apps: [draft], answer: association([{ roleid: ROLE_A, name: 'Viewer' }]) });
  const answer = await read(org);
  assert.strictEqual(answer.state, 'read', JSON.stringify(answer));
  assert.deepStrictEqual(answer.roles.map((r) => r.name), ['Viewer']);
  assert.deepStrictEqual(org.writes(), []);
  const { listApps } = require('../apps.js');
  const listed = await listApps(ORIGIN, {}, client(org));
  assert.deepStrictEqual(listed.apps.map((a) => [a.uniqueName, a.published, a.unpublishedChanges]), [['contoso_pm', false, true]], 'the same app, as the plugin\u2019s own listing sees it');
});

test('REAL BUNDLE: a draft whose roles the platform will not read is "not checked" with its status — never "absent"', async () => {
  const org = createFakeAppsOrg({ apps: [draft], answer: (req) => (/appmoduleroles_association/.test(req.path) ? json(404, { error: { message: 'appmodule With Id does not exist' } }) : undefined) });
  const answer = await read(org);
  assert.deepStrictEqual(answer, { state: 'unreadable', appUnique: 'contoso_pm', reason: 'HTTP 404' });
  assert.deepStrictEqual(org.writes(), []);
});

test('REAL BUNDLE: an app neither layer has is absent, and no association is read', async () => {
  const org = createFakeAppsOrg({ apps: [], answer: association([{ roleid: ROLE_A, name: 'R' }]) });
  assert.deepStrictEqual(await read(org), { state: 'absent', appUnique: 'contoso_pm' });
  assert.deepStrictEqual(org.writes(), []);
  assert.ok(!org.requests.some((r) => /appmoduleroles_association/.test(r.path)), 'no app, no association read');
});

test('REAL BUNDLE: a refused association read is unreadable with its status, and writes nothing', async () => {
  const refused = createFakeAppsOrg({
    apps: [published],
    answer: (req) => (/appmoduleroles_association/.test(req.path) ? json(403, { error: { code: '0x80040220', message: 'denied' } }) : undefined),
  });
  const answer = await read(refused);
  assert.deepStrictEqual(answer, { state: 'unreadable', appUnique: 'contoso_pm', reason: 'HTTP 403' });
  assert.deepStrictEqual(refused.writes(), []);
});

test('REAL BUNDLE: a lookup the platform refuses is "not checked", not "absent"', async () => {
  for (const status of [403, 404, 500]) {
    const org = createFakeAppsOrg({ answer: (req) => (req.path.startsWith('/appmodules/') ? json(status, { error: { message: 'lookup denied' } }) : undefined) });
    const answer = await read(org);
    assert.strictEqual(answer.state, 'unreadable', `${status}: ${JSON.stringify(answer)}`);
    assert.deepStrictEqual(org.writes(), []);
  }
});

test('REAL BUNDLE: a 200 that carries no list of roles is "not checked", not "no roles"', async () => {
  for (const body of [{}, { value: 'malformed' }, { value: [{}] }]) {
    const org = createFakeAppsOrg({ apps: [published], answer: (req) => (/appmoduleroles_association/.test(req.path) ? json(200, body) : undefined) });
    const answer = await read(org);
    assert.strictEqual(answer.state, 'unreadable', `${JSON.stringify(body)}: ${JSON.stringify(answer)}`);
    assert.deepStrictEqual(org.writes(), []);
  }
});

test('REAL BUNDLE: a list the platform answers a page at a time is read to its end through the client\u2019s own continuation', async () => {
  const link = `${ORIGIN}/api/data/v9.0/appmodules(${APP_ID})/appmoduleroles_association?$select=roleid,name,ismanaged&$skiptoken=2`;
  const org = createFakeAppsOrg({
    apps: [published],
    answer: (req) => {
      if (!/appmoduleroles_association/.test(req.path)) return undefined;
      return /skiptoken=2/.test(req.path)
        ? json(200, { value: [{ roleid: ROLE_B, name: 'Beta' }] })
        : json(200, { value: [{ roleid: ROLE_A, name: 'Alpha' }], '@odata.nextLink': link });
    },
  });
  const answer = await read(org);
  assert.deepStrictEqual(answer.roles && answer.roles.map((r) => r.name), ['Alpha', 'Beta'], JSON.stringify(answer));
  assert.deepStrictEqual(org.writes(), []);
});

test('REAL BUNDLE: verify\u2019s published-layer reader still answers what it did, over the same fake', async () => {
  const org = createFakeAppsOrg({ apps: [published], answer: association([{ roleid: ROLE_A }, { roleid: ROLE_B }]) });
  const answer = await withThrowawaySdk({ env: ORIGIN, prefix: 'app-roles-test-', httpClient: client(org) }, (make) => appRoleIdsFor(make(), 'contoso_pm'));
  assert.deepStrictEqual(answer, { ok: true, roleIds: [ROLE_A.toLowerCase(), ROLE_B.toLowerCase()] });
  assert.ok(org.requests.some((r) => r.path === `/appmodules(${APP_ID})/appmoduleroles_association?$select=roleid`));
  assert.deepStrictEqual(org.writes(), []);
});

test('REAL BUNDLE: verify reads an answer that carries no list as it always did', async () => {
  for (const [body, expected] of [[{}, { ok: true, roleIds: [] }], [{ value: 'malformed' }, { ok: false, reason: '((res.body && res.body.value) || []).map is not a function' }]]) {
    const org = createFakeAppsOrg({ apps: [published], answer: (req) => (/appmoduleroles_association/.test(req.path) ? json(200, body) : undefined) });
    const answer = await withThrowawaySdk({ env: ORIGIN, prefix: 'app-roles-test-', httpClient: client(org) }, (make) => appRoleIdsFor(make(), 'contoso_pm'));
    assert.deepStrictEqual(answer, expected, JSON.stringify(body));
  }
});
