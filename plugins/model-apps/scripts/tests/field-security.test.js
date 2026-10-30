'use strict';
// Field security profiles (C03): plan, create through the create port, assign to users and teams, verify — against SDK doubles that
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

// The create port double: reserves the ids up front (as the B1 port does) and answers `created` when the create resolves.
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

test('a profile that does not exist is planned as a create whose preconditions are its secured columns', async () => {
  const sdk = sdkDouble();
  const plan = await fls.planFieldSecurity({ fieldSecurityProfiles: [HR] }, { sdk });
  assert.equal(plan.operations.length, 1);
  assert.deepEqual(plan.operations[0].preconditions, ['isSecured:new_employee.new_bonus', 'isSecured:new_employee.new_salary']);
  assert.deepEqual(sdk.calls.map((c) => c[0]), ['findArtifact']);
});

test('a profile found exactly as declared is unchanged and bound as adopted, never created', async () => {
  const sdk = sdkDouble({ found: PROFILE_ID.toUpperCase() });
  const plan = await fls.planFieldSecurity({ fieldSecurityProfiles: [HR] }, { sdk });
  assert.deepEqual(plan.operations, []);
  const r = await fls.applyFieldSecurity(plan, { sdk, creates: createsDouble() });
  assert.deepEqual(r.managedBindings, [{ kind: 'fieldSecurityProfile', key: 'hr', id: PROFILE_ID, origin: 'adopted' }]);
  assert.ok(!sdk.calls.some((c) => c[0] === 'createArtifact'));
});

test('a found profile that differs in any way is refused and named, never changed', async () => {
  for (const [actual, why] of [
    [actualOf({ permissions: [actualOf().permissions[1]] }), /no permission on new_employee\.new_bonus/],
    [actualOf({ permissions: [...actualOf().permissions, { table: 'new_employee', column: 'new_ssn', read: true }] }), /also holds a permission on new_employee\.new_ssn/],
    [actualOf({ permissions: [actualOf().permissions[0], { ...actualOf().permissions[1], create: true }] }), /create on new_employee\.new_salary is true/],
    [actualOf({ permissions: [actualOf().permissions[0], { ...actualOf().permissions[1], readUnmasked: 'all' }] }), /unmasked reads of new_employee\.new_salary/],
  ]) {
    const sdk = sdkDouble({ found: PROFILE_ID, actual });
    const plan = await fls.planFieldSecurity({ fieldSecurityProfiles: [HR] }, { sdk });
    assert.equal(plan.refused[0].code, 'FIELD_SECURITY_PROFILE_DIFFERS');
    assert.match(plan.refused[0].reason, why);
  }
  const described = await fls.planFieldSecurity({ fieldSecurityProfiles: [{ ...HR, description: 'Pay' }] }, { sdk: sdkDouble({ found: PROFILE_ID }) });
  assert.match(described.refused[0].reason, /description differs/);
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
  const provision = {
    dataverse: {
      get: async (p) => {
        if (/IsSecured/.test(p)) return { status: 200, body: { value: [{ LogicalName: 'new_salary', IsSecured: true }, { LogicalName: 'new_bonus', IsSecured: false }] } };
        if (/teamprofiles/.test(p)) return { status: 503, body: {} };
        return { status: 200, body: { value: [{ systemuserid: USER_ID }] } };
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
});

// ---------------------------------------------------------------- real bundle (measured wire evidence)

const BUNDLE = path.resolve(__dirname, '..', 'vendor', 'cds-maker-sdk.cjs');

function realSdk() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fls-real-'));
  const requests = [];
  const rec = (verb) => async (url, body) => { requests.push({ verb, url, body }); return { status: 204, headers: {}, body: verb === 'post' ? { MetadataId: '55555555-5555-5555-5555-555555555555' } : {} }; };
  const B = require(BUNDLE);
  const sdk = B.createMakerSdk({
    workspaceStorage: B.createNodeWorkspaceStorage(dir),
    instanceUrl: 'https://contoso.crm.dynamics.com',
    httpClient: { get: rec('get'), post: rec('post'), patch: rec('patch'), put: rec('put'), delete: rec('delete') },
  });
  return { sdk, requests, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('REAL BUNDLE: a planned profile is created as one deep insert carrying the reserved ids and the declared flags', async () => {
  const r = realSdk();
  try {
    await r.sdk.initWorkspace();
    const plan = { operations: [{ key: 'fieldSecurityProfile:hr', kind: 'fieldSecurityProfile', target: 'hr', desired: fls.desiredProfile(HR) }] };
    const result = await fls.applyFieldSecurity(plan, { sdk: r.sdk, creates: createsDouble() });
    assert.deepEqual(result.saved, ['fieldSecurityProfile:hr']);
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
