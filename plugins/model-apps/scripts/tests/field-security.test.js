'use strict';
// Field security profiles: plan, create through the create port, assign to users and teams, verify — against SDK doubles that
// record every call, and once against the real vendored bundle so its wire shape for a profile create is pinned.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const fls = require('../lib/field-security.js');

const PROFILE_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '33333333-3333-3333-3333-333333333333';
const TEAM_ID = '44444444-4444-4444-4444-444444444444';
const SYSADMIN = '572329c1-a042-4e22-be47-367c6374ea45';

const HR = {
  key: 'hr',
  name: 'HR Salary',
  permissions: [{ table: 'new_employee', column: 'new_salary', read: true, update: true }, { table: 'new_employee', column: 'new_bonus', read: true }],
  assignTo: { users: [USER_ID], teams: [TEAM_ID] },
};
const actualOf = (over = {}) => Object.assign({
  id: PROFILE_ID,
  name: 'HR Salary',
  description: null,
  permissions: [
    { table: 'new_employee', column: 'new_bonus', read: true, create: false, update: false },
    { table: 'new_employee', column: 'new_salary', read: true, create: false, update: true },
  ],
}, over);

function sdkDouble({ found = null, actual = actualOf(), findError, createError, associateError, pushed = { saved: true } } = {}) {
  const calls = [];
  return {
    calls,
    findArtifact: async (kind, q) => { calls.push(['findArtifact', kind, q]); if (findError) throw findError; return found; },
    getArtifact: async (kind, id) => { calls.push(['getArtifact', kind, id]); return actual; },
    createArtifact: async (kind, a) => { calls.push(['createArtifact', kind, a]); if (createError) throw createError; return a; },
    pushArtifact: async (kind, id) => { calls.push(['pushArtifact', kind, id]); return pushed; },
    associateRecords: async (e, id, o) => { calls.push(['associateRecords', e, id, o]); if (associateError) throw associateError; },
  };
}

// The create port double: reserves the ids up front (as the real create port does) and answers `created` when the create resolves.
function createsDouble(outcome = 'created') {
  const runs = [];
  return {
    runs,
    run: async (desc, fn) => {
      const childIds = Object.fromEntries(desc.childKeys.map((k, i) => [k, `2222222${i}-2222-2222-2222-222222222222`]));
      runs.push(desc);
      await fn({ id: PROFILE_ID, childIds });
      return { outcome, id: PROFILE_ID, childIds };
    },
  };
}

const err = (props) => Object.assign(new Error(props.message || 'failed'), props);

// The platform's wire values for a permission: 0 / 4 for the three access flags, 0 / 1 / 3 for unmasked reads.
const UNMASKED = { none: 0, oneRecord: 1, allRecords: 3 };
const wireRow = (x, i) => ({
  fieldpermissionid: `2222222${i}-2222-2222-2222-222222222222`,
  entityname: x.table,
  attributelogicalname: x.column,
  canread: x.read ? 4 : 0,
  cancreate: x.create ? 4 : 0,
  canupdate: x.update ? 4 : 0,
  canreadunmasked: UNMASKED[x.readUnmasked || 'none'],
});

// The server's answers to the profile read (header, then the permissions as a direct collection) and to the per-assignment
// existence read. `actual` is what the environment holds; `head` / `perms` override a status; `pages` splits the permission rows.
function serverOf({ actual = actualOf(), head = 200, perms = 200, rows, pages, held = false } = {}) {
  const gets = [];
  const absolute = [];
  const all = rows || actual.permissions.map(wireRow);
  const chunks = pages || [all];
  const pageAt = (n) => ({ status: 200, body: { value: chunks[n], ...(n + 1 < chunks.length ? { '@odata.nextLink': `https://contoso.crm.dynamics.com/api/data/v9.2/fieldpermissions?$skiptoken=${n + 1}` } : {}) } });
  return {
    gets,
    absolute,
    dataverse: {
      get: async (p) => {
        gets.push(p);
        if (/^\/fieldsecurityprofiles\([^)]*\)\?\$select=name,description$/.test(p)) return head === 200 ? { status: 200, body: { name: actual.name, description: actual.description } } : { status: head, body: {} };
        if (/^\/fieldpermissions\?/.test(p)) return perms === 200 ? pageAt(0) : { status: perms, body: {} };
        const h = typeof held === 'function' ? held(p) : held;
        if (h === null) return { status: 500, body: {} };
        const key = /teamprofiles/.test(p) ? 'teamid' : 'systemuserid';
        return { status: 200, body: { value: h ? [{ [key]: /teamprofiles/.test(p) ? TEAM_ID : USER_ID }] : [] } };
      },
      getAbsolute: async (url) => { absolute.push(url); return pageAt(Number(/skiptoken=(\d+)/.exec(url)[1])); },
    },
  };
}

test('a profile that does not exist is planned as a create whose preconditions are its secured columns', async () => {
  const sdk = sdkDouble();
  const plan = await fls.planFieldSecurity({ fieldSecurityProfiles: [HR] }, { sdk });
  assert.equal(plan.operations.length, 1);
  assert.deepEqual(plan.operations[0].preconditions, ['isSecured:new_employee.new_bonus', 'isSecured:new_employee.new_salary']);
  assert.deepEqual(sdk.calls.map((c) => c[0]), ['findArtifact']);
});

test('a profile found exactly as declared is unchanged and bound as adopted, never created', async () => {
  const sdk = sdkDouble({ found: PROFILE_ID.toUpperCase() });
  const provision = serverOf();
  const plan = await fls.planFieldSecurity({ fieldSecurityProfiles: [HR] }, { sdk, provision });
  assert.deepEqual(plan.operations, []);
  // Read from the server, never from the workspace copy.
  assert.deepEqual(provision.gets, [
    `/fieldsecurityprofiles(${PROFILE_ID})?$select=name,description`,
    `/fieldpermissions?$select=fieldpermissionid,entityname,attributelogicalname,canread,cancreate,canupdate,canreadunmasked&$filter=_fieldsecurityprofileid_value eq ${PROFILE_ID}&$orderby=fieldpermissionid`,
  ]);
  assert.ok(!sdk.calls.some((c) => c[0] === 'getArtifact'));
  const r = await fls.applyFieldSecurity(plan, { sdk, creates: createsDouble() });
  assert.deepEqual(r.managedBindings, [{ kind: 'fieldSecurityProfile', key: 'hr', id: PROFILE_ID, origin: 'adopted' }]);
  assert.ok(!sdk.calls.some((c) => c[0] === 'createArtifact'));
});

test('a found profile that differs in any way is refused and named, never changed', async () => {
  for (const [actual, why] of [
    [actualOf({ permissions: [actualOf().permissions[1]] }), /no permission on new_employee\.new_bonus/],
    [actualOf({ permissions: [...actualOf().permissions, { table: 'new_employee', column: 'new_ssn', read: true }] }), /also holds a permission on new_employee\.new_ssn/],
    [actualOf({ permissions: [actualOf().permissions[0], { ...actualOf().permissions[1], create: true }] }), /create on new_employee\.new_salary is true/],
    [actualOf({ permissions: [actualOf().permissions[0], { ...actualOf().permissions[1], readUnmasked: 'allRecords' }] }), /unmasked reads of new_employee\.new_salary/],
  ]) {
    const plan = await fls.planFieldSecurity({ fieldSecurityProfiles: [HR] }, { sdk: sdkDouble({ found: PROFILE_ID }), provision: serverOf({ actual }) });
    assert.equal(plan.refused[0].code, 'FIELD_SECURITY_PROFILE_DIFFERS');
    assert.match(plan.refused[0].reason, why);
  }
  const described = await fls.planFieldSecurity({ fieldSecurityProfiles: [{ ...HR, description: 'Pay' }] }, { sdk: sdkDouble({ found: PROFILE_ID }), provision: serverOf() });
  assert.match(described.refused[0].reason, /description differs/);
});

test('a found profile whose read is not whole is unknown, never compared or adopted', async () => {
  const cases = [
    ['header 403', serverOf({ head: 403 })],
    ['permissions 503', serverOf({ perms: 503 })],
    ['an access value that is not 0 or 4', serverOf({ rows: [{ ...wireRow(actualOf().permissions[0], 0), canread: 2 }, wireRow(actualOf().permissions[1], 1)] })],
    ['a null unmasked value', serverOf({ rows: [{ ...wireRow(actualOf().permissions[0], 0), canreadunmasked: null }, wireRow(actualOf().permissions[1], 1)] })],
    ['a column named twice', serverOf({ rows: [wireRow(actualOf().permissions[0], 0), wireRow(actualOf().permissions[0], 1), wireRow(actualOf().permissions[1], 2)] })],
    ['no reader', {}],
  ];
  for (const [name, provision] of cases) {
    const plan = await fls.planFieldSecurity({ fieldSecurityProfiles: [HR] }, { sdk: sdkDouble({ found: PROFILE_ID }), provision });
    assert.deepEqual([plan.unknown.map((u) => u.code), plan.unchanged, plan.refused, plan.operations], [['FIELD_SECURITY_PROFILE_UNREAD'], [], [], []], name);
  }
});

test('the permissions are followed across pages through the same-origin absolute read; a repeated link is not whole', async () => {
  const [bonus, salary] = actualOf().permissions.map(wireRow);
  const paged = serverOf({ pages: [[bonus], [salary]] });
  const plan = await fls.planFieldSecurity({ fieldSecurityProfiles: [HR] }, { sdk: sdkDouble({ found: PROFILE_ID }), provision: paged });
  assert.deepEqual(plan.unchanged.map((u) => u.key), ['fieldSecurityProfile:hr']);
  assert.deepEqual(paged.absolute, ['https://contoso.crm.dynamics.com/api/data/v9.2/fieldpermissions?$skiptoken=1']);
  // An extra grant on the second page is still a difference.
  const extra = serverOf({ pages: [[bonus, salary], [wireRow({ table: 'new_employee', column: 'new_ssn', read: true }, 2)]] });
  const refused = await fls.planFieldSecurity({ fieldSecurityProfiles: [HR] }, { sdk: sdkDouble({ found: PROFILE_ID }), provision: extra });
  assert.match(refused.refused[0].reason, /also holds a permission on new_employee\.new_ssn/);
  const looping = serverOf({ pages: [[bonus], [salary]] });
  looping.dataverse.getAbsolute = async (url) => ({ status: 200, body: { value: [], '@odata.nextLink': url } });
  const loop = await fls.planFieldSecurity({ fieldSecurityProfiles: [HR] }, { sdk: sdkDouble({ found: PROFILE_ID }), provision: looping });
  assert.equal(loop.unknown[0].code, 'FIELD_SECURITY_PROFILE_UNREAD');
  const noFollow = serverOf({ pages: [[bonus], [salary]] });
  delete noFollow.dataverse.getAbsolute;
  const unfollowed = await fls.planFieldSecurity({ fieldSecurityProfiles: [HR] }, { sdk: sdkDouble({ found: PROFILE_ID }), provision: noFollow });
  assert.equal(unfollowed.unknown[0].code, 'FIELD_SECURITY_PROFILE_UNREAD');
});

test('an ambiguous name and the System Administrator profile are refused', async () => {
  const amb = await fls.planFieldSecurity({ fieldSecurityProfiles: [HR] }, { sdk: sdkDouble({ findError: err({ name: 'AmbiguousArtifactError', code: 'AMBIGUOUS_ARTIFACT' }) }) });
  assert.equal(amb.refused[0].code, 'FIELD_SECURITY_PROFILE_AMBIGUOUS');
  const byName = await fls.planFieldSecurity({ fieldSecurityProfiles: [{ ...HR, name: 'system administrator' }] }, { sdk: sdkDouble() });
  assert.equal(byName.refused[0].code, 'FIELD_SECURITY_PROFILE_SYSTEM');
  const byId = await fls.planFieldSecurity({ fieldSecurityProfiles: [HR] }, { sdk: sdkDouble({ found: SYSADMIN }) });
  assert.equal(byId.refused[0].code, 'FIELD_SECURITY_PROFILE_SYSTEM');
});

test('a create goes through the create port with the reserved ids, and binds the profile as created', async () => {
  const sdk = sdkDouble();
  const creates = createsDouble();
  const plan = await fls.planFieldSecurity({ fieldSecurityProfiles: [HR] }, { sdk });
  const r = await fls.applyFieldSecurity(plan, { sdk, creates });
  assert.deepEqual(creates.runs, [{ kind: 'fieldSecurityProfile', key: 'hr', identity: { name: 'HR Salary' }, childKeys: ['new_employee.new_bonus', 'new_employee.new_salary'] }]);
  const created = sdk.calls.find((c) => c[0] === 'createArtifact')[2];
  assert.equal(created.id, PROFILE_ID);
  assert.deepEqual(created.permissions.map((x) => x.id), ['22222220-2222-2222-2222-222222222222', '22222221-2222-2222-2222-222222222222']);
  assert.deepEqual(created.permissions[1], { table: 'new_employee', column: 'new_salary', read: true, create: false, update: true, id: '22222221-2222-2222-2222-222222222222' });
  assert.deepEqual(r.saved, ['fieldSecurityProfile:hr']);
  assert.deepEqual(r.managedBindings, [{ kind: 'fieldSecurityProfile', key: 'hr', id: PROFILE_ID, origin: 'created' }]);
});

test('a create the port cannot confirm is unknown, not saved; a permission on an unsecured column is refused', async () => {
  const plan = await fls.planFieldSecurity({ fieldSecurityProfiles: [HR] }, { sdk: sdkDouble() });
  const unknown = await fls.applyFieldSecurity(plan, { sdk: sdkDouble(), creates: createsDouble('unknown') });
  assert.deepEqual(unknown.saved, []);
  assert.equal(unknown.unknown[0].code, 'FIELD_SECURITY_PROFILE_UNKNOWN');
  assert.deepEqual(unknown.managedBindings, []);

  const notSecured = await fls.applyFieldSecurity(plan, { sdk: sdkDouble({ createError: err({ code: 'FIELD_SECURITY_COLUMN_NOT_SECURED' }) }), creates: createsDouble() });
  assert.equal(notSecured.refused[0].code, 'FIELD_SECURITY_COLUMN_NOT_SECURED');
});

test('a push that did not save fails the create rather than binding it', async () => {
  const plan = await fls.planFieldSecurity({ fieldSecurityProfiles: [HR] }, { sdk: sdkDouble() });
  await assert.rejects(() => fls.applyFieldSecurity(plan, { sdk: sdkDouble({ pushed: { saved: false } }), creates: createsDouble() }), { code: 'FIELD_SECURITY_PROFILE_NOT_SAVED' });
});

test('a created profile is saved only when its push echoed it exactly, or a server read shows it as declared', async () => {
  const plan = await fls.planFieldSecurity({ fieldSecurityProfiles: [HR] }, { sdk: sdkDouble() });
  const created = [{ kind: 'fieldSecurityProfile', key: 'hr', id: PROFILE_ID, origin: 'created' }];
  // An exact echo (no warning) is the proof: no read.
  const exact = serverOf();
  const proven = await fls.applyFieldSecurity(plan, { sdk: sdkDouble(), creates: createsDouble(), provision: exact });
  assert.deepEqual([proven.saved, exact.gets], [['fieldSecurityProfile:hr'], []]);

  const unproven = { saved: true, warnings: ["Saved; the create's answer did not account for every permission"] };
  const asDeclared = serverOf();
  const read = await fls.applyFieldSecurity(plan, { sdk: sdkDouble({ pushed: unproven }), creates: createsDouble(), provision: asDeclared });
  assert.deepEqual([read.saved, read.managedBindings, asDeclared.gets.length], [['fieldSecurityProfile:hr'], created, 2]);

  const unreadable = await fls.applyFieldSecurity(plan, { sdk: sdkDouble({ pushed: unproven }), creates: createsDouble(), provision: serverOf({ perms: 500 }) });
  assert.deepEqual([unreadable.saved, unreadable.unknown.map((u) => u.code), unreadable.managedBindings], [[], ['FIELD_SECURITY_PROFILE_UNREAD'], created]);

  const extra = actualOf({ permissions: [...actualOf().permissions, { table: 'new_employee', column: 'new_ssn', read: true }] });
  const differs = await fls.applyFieldSecurity(plan, { sdk: sdkDouble({ pushed: unproven }), creates: createsDouble(), provision: serverOf({ actual: extra }) });
  assert.deepEqual([differs.saved, differs.refused.map((r) => r.code), differs.managedBindings], [[], ['FIELD_SECURITY_PROFILE_DIFFERS'], created]);
  assert.match(differs.refused[0].reason, /new_employee\.new_ssn/);

  // The port resolved the create from an earlier attempt: nothing was pushed here, so it is read back too — and never re-sent.
  const sdk = sdkDouble();
  const resolved = { runs: [], run: async () => ({ outcome: 'created', id: PROFILE_ID.toUpperCase(), childIds: {} }) };
  const unreadResolved = await fls.applyFieldSecurity(plan, { sdk, creates: resolved, provision: serverOf({ head: 404 }) });
  assert.deepEqual([unreadResolved.saved, unreadResolved.unknown.map((u) => u.code)], [[], ['FIELD_SECURITY_PROFILE_UNREAD']]);
  assert.ok(!sdk.calls.some((c) => c[0] === 'createArtifact' || c[0] === 'pushArtifact'));
});

// The provision double answers the per-assignment existence read with `held` (true, false, or a function of the path).
const provisionOf = (held) => {
  const gets = [];
  return {
    gets,
    dataverse: {
      get: async (p) => {
        gets.push(p);
        const h = typeof held === 'function' ? held(p) : held;
        if (h === null) return { status: 500, body: {} };
        const key = /teamprofiles/.test(p) ? 'teamid' : 'systemuserid';
        return { status: 200, body: { value: h ? [{ [key]: /teamprofiles/.test(p) ? TEAM_ID : USER_ID }] : [] } };
      },
    },
  };
};

test('assignments are additive: one existence read each, an association only where it is missing', async () => {
  const sdk = sdkDouble();
  const provision = provisionOf((p) => /teamprofiles/.test(p));
  const r = await fls.assignFieldSecurity({ fieldSecurityProfiles: [HR] }, { sdk, provision }, { profileIds: { hr: PROFILE_ID } });
  assert.deepEqual(provision.gets, [
    `/fieldsecurityprofiles(${PROFILE_ID})/systemuserprofiles_association?$select=systemuserid&$filter=systemuserid eq ${USER_ID}`,
    `/fieldsecurityprofiles(${PROFILE_ID})/teamprofiles_association?$select=teamid&$filter=teamid eq ${TEAM_ID}`,
  ]);
  assert.deepEqual(sdk.calls.map((c) => c.slice(0, 4)), [['associateRecords', 'fieldsecurityprofile', PROFILE_ID, { relationshipName: 'systemuserprofiles_association', targetEntity: 'systemuser', targetId: USER_ID }]]);
  assert.deepEqual(r.saved, [`fieldSecurityProfile:hr:users:${USER_ID}`]);
  assert.deepEqual(r.unchanged, [`fieldSecurityProfile:hr:teams:${TEAM_ID}`]);
});

test('an assignment of a profile with no id is unknown; a duplicate answer is unchanged; a missing principal is refused', async () => {
  const none = await fls.assignFieldSecurity({ fieldSecurityProfiles: [HR] }, { sdk: sdkDouble(), provision: provisionOf(false) }, { profileIds: {} });
  assert.deepEqual(none.unknown.map((u) => u.code), ['FIELD_SECURITY_PROFILE_UNRESOLVED', 'FIELD_SECURITY_PROFILE_UNRESOLVED']);

  // The SDK's ConnectionError for an answered request: the OData body rides in `cause`.
  const dup = err({ code: 'CONNECTION_ERROR', statusCode: 400, cause: { error: { code: '0x80040237', message: 'Cannot insert duplicate key.' } } });
  const dupResult = await fls.assignFieldSecurity({ fieldSecurityProfiles: [HR] }, { sdk: sdkDouble({ associateError: dup }), provision: provisionOf(null) }, { profileIds: new Map([['hr', PROFILE_ID]]) });
  assert.equal(dupResult.unchanged.length, 2);

  const missing = await fls.assignFieldSecurity({ fieldSecurityProfiles: [HR] }, { sdk: sdkDouble({ associateError: err({ code: 'CONNECTION_ERROR', statusCode: 404 }) }), provision: provisionOf(false) }, { profileIds: { hr: PROFILE_ID } });
  assert.deepEqual(missing.refused.map((r) => r.code), ['FIELD_SECURITY_PRINCIPAL_NOT_FOUND', 'FIELD_SECURITY_PRINCIPAL_NOT_FOUND']);
});

test('verify reports pass, fail and unknown, and an unreadable check is never a pass', async () => {
  const spec = { entities: [{ schemaName: 'new_employee', columns: [{ schemaName: 'new_salary', isSecured: true }, { schemaName: 'new_bonus', isSecured: true }] }], fieldSecurityProfiles: [HR] };
  const server = serverOf();
  const provision = {
    dataverse: {
      get: async (p) => {
        if (/IsSecured/.test(p)) return { status: 200, body: { value: [{ LogicalName: 'new_salary', IsSecured: true }, { LogicalName: 'new_bonus', IsSecured: false }] } };
        if (/teamprofiles/.test(p)) return { status: 503, body: {} };
        if (/systemuserprofiles/.test(p)) return { status: 200, body: { value: [{ systemuserid: USER_ID }] } };
        return server.dataverse.get(p);
      },
    },
  };
  const checks = await fls.verifyFieldSecurity(spec, { sdk: sdkDouble({ found: PROFILE_ID }), provision });
  assert.deepEqual(checks.map((c) => [c.key, c.status]), [
    ['isSecured:new_employee.new_salary', 'pass'],
    ['isSecured:new_employee.new_bonus', 'fail'],
    ['fieldSecurityProfile:hr', 'pass'],
    [`fieldSecurityProfile:hr:users:${USER_ID}`, 'pass'],
    [`fieldSecurityProfile:hr:teams:${TEAM_ID}`, 'unknown'],
  ]);
  // A profile that cannot be read whole is unknown, never a pass; one with an extra grant fails.
  const unread = await fls.verifyFieldSecurity({ fieldSecurityProfiles: [HR] }, { sdk: sdkDouble({ found: PROFILE_ID }), provision: serverOf({ perms: 503 }) });
  assert.equal(unread[0].status, 'unknown');
  const extra = actualOf({ permissions: [...actualOf().permissions, { table: 'new_employee', column: 'new_ssn', read: true }] });
  const failed = await fls.verifyFieldSecurity({ fieldSecurityProfiles: [HR] }, { sdk: sdkDouble({ found: PROFILE_ID }), provision: serverOf({ actual: extra }) });
  assert.deepEqual([failed[0].status, failed[0].detail], ['fail', 'it also holds a permission on new_employee.new_ssn']);
});

test('before a seed-only run, every declared secured column must be read as secured; a spec with none reads nothing', async () => {
  const spec = { entities: [
    { schemaName: 'new_employee', columns: [{ schemaName: 'new_salary', isSecured: true }, { schemaName: 'new_bonus', isSecured: true }, { schemaName: 'new_note' }] },
    { schemaName: 'new_ticket', columns: [{ schemaName: 'new_name' }, { schemaName: 'new_flag', isSecured: false }] },
  ] };
  const gets = [];
  const reader = (answer) => ({ dataverse: { get: async (p) => { gets.push(p); return answer; } } });
  const both = { status: 200, body: { value: [{ LogicalName: 'new_salary', IsSecured: true }, { LogicalName: 'new_bonus', IsSecured: true }] } };
  assert.deepEqual(await fls.securedBeforeSeed(spec, reader(both)), { ready: true, unsecured: [], unknown: [] });
  assert.deepEqual(gets, [fls.columnSecurityPath('new_employee')]);
  const one = { status: 200, body: { value: [{ LogicalName: 'new_salary', IsSecured: false }] } };
  assert.deepEqual(await fls.securedBeforeSeed(spec, reader(one)), { ready: false, unsecured: [{ target: 'new_employee.new_salary' }], unknown: [{ target: 'new_employee.new_bonus', reason: 'the column was not found' }] });
  const unread = await fls.securedBeforeSeed(spec, reader({ status: 503, body: {} }));
  assert.deepEqual([unread.ready, unread.unknown.map((u) => u.target)], [false, ['new_employee.new_salary', 'new_employee.new_bonus']]);
  gets.length = 0;
  assert.equal((await fls.securedBeforeSeed(spec, reader(one), { tables: new Set(['new_ticket']) })).ready, true);
  assert.equal((await fls.securedBeforeSeed({ entities: [{ schemaName: 'new_x', columns: [{ schemaName: 'new_a' }] }] }, reader(one))).ready, true);
  assert.deepEqual(gets, []);
});

// ---------------------------------------------------------------- real bundle (measured wire evidence)

const BUNDLE = path.resolve(__dirname, '..', 'vendor', 'cds-maker-sdk.cjs');

// The real SDK over a recording HTTP client. `route(verb, url, body)` answers a request, or returns undefined for the default
// (204, empty). Reads of the profile go through the SDK's own client (`sdk.dataverse`), so they arrive here as absolute URLs.
function realSdk(route = () => undefined) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fls-real-'));
  const requests = [];
  const rec = (verb) => async (url, body) => {
    requests.push({ verb, url, body });
    return (await route(verb, url, body)) || { status: 204, headers: {}, body: verb === 'post' ? { MetadataId: '55555555-5555-5555-5555-555555555555' } : {} };
  };
  const B = require(BUNDLE);
  const sdk = B.createMakerSdk({
    workspaceStorage: B.createNodeWorkspaceStorage(dir),
    instanceUrl: 'https://contoso.crm.dynamics.com',
    httpClient: { get: rec('get'), post: rec('post'), patch: rec('patch'), put: rec('put'), delete: rec('delete') },
  });
  return { sdk, requests, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// A server holding `actual` under PROFILE_ID: the name lookup finds it, and the profile read answers it.
const serverRoute = (actual = actualOf(), { perms = 200 } = {}) => (verb, url) => {
  if (verb !== 'get') return undefined;
  if (/\/fieldsecurityprofiles\?/.test(url) && /\$filter=/.test(url)) return { status: 200, headers: {}, body: { value: [{ fieldsecurityprofileid: PROFILE_ID, name: actual.name }] } };
  if (/\/fieldsecurityprofiles\([^)]*\)\?\$select=name,description$/.test(url)) return { status: 200, headers: { ETag: 'W/"900"' }, body: { name: actual.name, description: actual.description } };
  if (/\/fieldpermissions\?/.test(url)) return perms === 200 ? { status: 200, headers: {}, body: { value: actual.permissions.map(wireRow) } } : { status: perms, headers: {}, body: {} };
  return undefined;
};

// The create's answer: `exact` echoes every sent permission with its row version, as the SDK requires to hold the profile proven.
const echoOf = (kind) => (verb, url, body) => {
  if (verb !== 'post' || !/\/fieldsecurityprofiles\?/.test(url)) return undefined;
  if (kind === 'missing') return { status: 204, headers: {}, body: {} };
  const kids = body.lk_fieldpermission_fieldsecurityprofileid.map((k, i) => ({ ...k, canreadunmasked: 0, '@odata.etag': `W/"${1000 + i}"` }));
  return {
    status: 201,
    headers: { ETag: 'W/"999"' },
    body: {
      fieldsecurityprofileid: body.fieldsecurityprofileid, name: body.name, description: null,
      lk_fieldpermission_fieldsecurityprofileid: kind === 'partial' ? kids.slice(0, 1) : kids,
      ...(kind === 'continued' ? { 'lk_fieldpermission_fieldsecurityprofileid@odata.nextLink': 'https://contoso.crm.dynamics.com/api/data/v9.2/next' } : {}),
    },
  };
};
const either = (...routes) => async (...a) => { for (const r of routes) { const x = await r(...a); if (x) return x; } return undefined; };
const createPlan = () => ({ operations: [{ key: 'fieldSecurityProfile:hr', kind: 'fieldSecurityProfile', target: 'hr', desired: fls.desiredProfile(HR) }] });

test('REAL BUNDLE: a planned profile is created as one deep insert carrying the reserved ids and the declared flags', async () => {
  const r = realSdk(echoOf('exact'));
  try {
    await r.sdk.initWorkspace();
    const result = await fls.applyFieldSecurity(createPlan(), { sdk: r.sdk, creates: createsDouble() });
    assert.deepEqual(result.saved, ['fieldSecurityProfile:hr']);
    // The exact echo is the proof: nothing is read back.
    assert.deepEqual(r.requests.filter((x) => x.verb === 'get'), []);
    const posts = r.requests.filter((x) => x.verb === 'post');
    assert.equal(posts.length, 1);
    assert.match(posts[0].url, /\/fieldsecurityprofiles\?/);
    assert.equal(posts[0].body.fieldsecurityprofileid, PROFILE_ID);
    assert.equal(posts[0].body.name, 'HR Salary');
    // The platform's permission values are 0 (not allowed) and 4 (allowed).
    assert.deepEqual(posts[0].body.lk_fieldpermission_fieldsecurityprofileid.map((p) => [p.fieldpermissionid, p.attributelogicalname, p.canread, p.cancreate, p.canupdate]), [
      ['22222220-2222-2222-2222-222222222222', 'new_bonus', 4, 0, 0],
      ['22222221-2222-2222-2222-222222222222', 'new_salary', 4, 0, 4],
    ]);
  } finally {
    r.cleanup();
  }
});

test('REAL BUNDLE: a create whose answer does not echo every permission is read back from the server before it is saved', async () => {
  const extra = actualOf({ permissions: [...actualOf().permissions, { table: 'new_employee', column: 'new_ssn', read: true }] });
  for (const [echo, server, expected] of [
    ['missing', serverRoute(), { saved: ['fieldSecurityProfile:hr'], unknown: [], refused: [] }],
    ['partial', serverRoute(extra), { saved: [], unknown: [], refused: ['FIELD_SECURITY_PROFILE_DIFFERS'] }],
    ['continued', serverRoute(actualOf(), { perms: 500 }), { saved: [], unknown: ['FIELD_SECURITY_PROFILE_UNREAD'], refused: [] }],
  ]) {
    const r = realSdk(either(echoOf(echo), server));
    try {
      await r.sdk.initWorkspace();
      const result = await fls.applyFieldSecurity(createPlan(), { sdk: r.sdk, creates: createsDouble() });
      assert.deepEqual({ saved: result.saved, unknown: result.unknown.map((u) => u.code), refused: result.refused.map((x) => x.code) }, expected, echo);
      assert.deepEqual(result.managedBindings, [{ kind: 'fieldSecurityProfile', key: 'hr', id: PROFILE_ID, origin: 'created' }], echo);
      assert.deepEqual(r.requests.filter((x) => x.verb === 'get').map((x) => x.url.replace(/^https:\/\/contoso\.crm\.dynamics\.com\/api\/data\/v9\.\d+/, '').split('?')[0]), [`/fieldsecurityprofiles(${PROFILE_ID})`, '/fieldpermissions'], echo);
      assert.equal(r.requests.filter((x) => x.verb === 'post').length, 1, echo);
    } finally {
      r.cleanup();
    }
  }
});

test('REAL BUNDLE: a found profile is read from the server, in a fresh workspace and after a local create alike', async () => {
  // A fresh workspace has no copy of the profile: the plan still reads what the environment holds.
  const fresh = realSdk(serverRoute());
  try {
    await fresh.sdk.initWorkspace();
    const plan = await fls.planFieldSecurity({ fieldSecurityProfiles: [HR] }, { sdk: fresh.sdk });
    assert.deepEqual(plan.unchanged.map((u) => u.key), ['fieldSecurityProfile:hr']);
    const verified = await fls.verifyFieldSecurity({ fieldSecurityProfiles: [{ ...HR, assignTo: undefined }] }, { sdk: fresh.sdk });
    assert.deepEqual(verified.map((c) => c.status), ['pass']);
  } finally {
    fresh.cleanup();
  }
  // The workspace holds what this build sent; the server holds an extra grant. The server is what is compared.
  const extra = actualOf({ permissions: [...actualOf().permissions, { table: 'new_employee', column: 'new_ssn', read: true }] });
  const local = realSdk(either(echoOf('missing'), serverRoute(extra)));
  try {
    await local.sdk.initWorkspace();
    await fls.applyFieldSecurity(createPlan(), { sdk: local.sdk, creates: createsDouble() });
    const plan = await fls.planFieldSecurity({ fieldSecurityProfiles: [HR] }, { sdk: local.sdk });
    assert.deepEqual([plan.unchanged, plan.refused.map((x) => x.code)], [[], ['FIELD_SECURITY_PROFILE_DIFFERS']]);
    const verified = await fls.verifyFieldSecurity({ fieldSecurityProfiles: [{ ...HR, assignTo: undefined }] }, { sdk: local.sdk });
    assert.deepEqual(verified.map((c) => c.status), ['fail']);
  } finally {
    local.cleanup();
  }
});
test('REAL BUNDLE: createColumn sends IsSecured:true for isSecured, and no IsSecured when it is omitted', async () => {
  const r = realSdk();
  try {
    await r.sdk.createColumn('new_employee', { schemaName: 'new_salary', displayName: 'Salary', type: 'string', isSecured: true });
    await r.sdk.createColumn('new_employee', { schemaName: 'new_note', displayName: 'Note', type: 'string' });
    const [secured, plain] = r.requests.filter((x) => x.verb === 'post').map((x) => x.body);
    assert.equal(secured.IsSecured, true);
    assert.equal('IsSecured' in plain, false);
  } finally {
    r.cleanup();
  }
});
