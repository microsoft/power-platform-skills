// `roleGrants[]` — extend a PRE-EXISTING security role with privileges for a table. AB#6686429.
//
// The reported failure: a table, its forms and its nav deployed into an app whose solution already
// shipped four data roles, and NONE of those roles received privileges on the new table. Every
// non-admin persona could be assigned the app and still not open the table, and nothing said so.
//
// These tests pin the three properties that make the fix safe rather than merely present:
//   1. it is ADDITIVE — it compiles to AddPrivilegesRole, never ReplacePrivilegesRole,
//   2. it FAILS CLOSED on any ambiguity about WHICH role it would grant on, and
//   3. it refuses the one authoring shape that silently self-destructs (extending a role the same
//      spec also authors as a persona, whose privileges the build converges).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { validateAppSpec } = require('../lib/app-spec.js');
const { planFor, runSdkBuild, roleGrantLabel, resolveRoleGrantTarget } = require('../lib/sdk-build.js');

function base() {
  return {
    schemaVersion: 2,
    solution: { uniqueName: 'contoso', publisherPrefix: 'contoso' },
    app: { name: 'Contoso' },
    entities: [{ schemaName: 'contoso_order', primaryAttribute: { schemaName: 'contoso_name' }, columns: [] }],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Main', subAreas: [] }] }] },
  };
}

const grant = (extra = {}) => ({ role: 'Contoso PM - Project Manager', privileges: [{ entity: 'contoso_order', access: ['read', 'write'], scope: 'organization' }], ...extra });

const errorsFor = (mutate, profile = 'plan') => {
  const s = base();
  mutate(s);
  return validateAppSpec(s, { profile }).errors || [];
};

// --- shape -------------------------------------------------------------------------------------

test('roleGrants: a well-formed grant validates on both profiles', () => {
  for (const profile of ['plan', 'deploy']) {
    const s = base();
    s.roleGrants = [grant()];
    const r = validateAppSpec(s, { profile });
    assert.strictEqual(r.ok, true, `${profile}: ${JSON.stringify(r.errors)}`);
  }
});

test('roleGrants: absent stays valid — the block is optional and additive', () => {
  assert.strictEqual(validateAppSpec(base(), { profile: 'deploy' }).ok, true);
});

test('roleGrants: must be an array', () => {
  const errs = errorsFor((s) => { s.roleGrants = { role: 'X' }; });
  assert.ok(errs.some((e) => /roleGrants must be an array/.test(e)), JSON.stringify(errs));
});

test('roleGrants: unknown keys are rejected, not silently dropped', () => {
  // The same silent-drop failure class as #537: a misspelled key that validates clean means the
  // author asked for something and got a green build with the request gone.
  const errs = errorsFor((s) => { s.roleGrants = [grant({ privilege: [] })]; });
  assert.ok(errs.some((e) => /unknown key 'privilege'/.test(e)), JSON.stringify(errs));
});

// --- identity: fail closed on WHICH role ---------------------------------------------------------

test('roleGrants: naming no role at all is rejected', () => {
  const errs = errorsFor((s) => { s.roleGrants = [{ privileges: [{ entity: 'contoso_order', access: ['read'] }] }]; });
  assert.ok(errs.some((e) => /name the existing role to extend/.test(e)), JSON.stringify(errs));
});

test('roleGrants: role and roleId together are rejected — they can disagree', () => {
  const errs = errorsFor((s) => { s.roleGrants = [grant({ roleId: '11111111-1111-1111-1111-111111111111' })]; });
  assert.ok(errs.some((e) => /not both/.test(e)), JSON.stringify(errs));
});

test('roleGrants: roleId must be a GUID', () => {
  const errs = errorsFor((s) => { s.roleGrants = [{ roleId: 'Project Manager', privileges: [{ entity: 'contoso_order', access: ['read'] }] }]; });
  assert.ok(errs.some((e) => /roleId must be a GUID/.test(e)), JSON.stringify(errs));
});

test('roleGrants: a blank role name is rejected rather than trimmed to nothing', () => {
  const errs = errorsFor((s) => { s.roleGrants = [grant({ role: '   ' })]; });
  assert.ok(errs.some((e) => /non-empty display name of an EXISTING security role/.test(e)), JSON.stringify(errs));
});

test('roleGrants: businessUnitId alongside roleId is rejected as dead configuration', () => {
  // It reads as if it constrains the lookup, but an id IS the identity — nothing would consult it.
  const errs = errorsFor((s) => {
    s.roleGrants = [{ roleId: '11111111-1111-1111-1111-111111111111', businessUnitId: '22222222-2222-2222-2222-222222222222', privileges: [{ entity: 'contoso_order', access: ['read'] }] }];
  });
  assert.ok(errs.some((e) => /businessUnitId only scopes a lookup by 'role' name/.test(e)), JSON.stringify(errs));
});

test('roleGrants: two grants on the same role are rejected — a split can hide a depth conflict', () => {
  // The SDK detects "these entities share one Dataverse privilege so they must request one depth"
  // only WITHIN a single call. Split across two entries, both writes succeed and the later wins.
  const errs = errorsFor((s) => { s.roleGrants = [grant(), grant({ privileges: [{ entity: 'contoso_order', access: ['delete'] }] })]; });
  assert.ok(errs.some((e) => /duplicate roleGrant for the same role/.test(e)), JSON.stringify(errs));
});

test('roleGrants: the duplicate check matches on the SDK role identity (trimmed, case-insensitive)', () => {
  const errs = errorsFor((s) => { s.roleGrants = [grant({ role: 'Project Manager' }), grant({ role: '  project manager  ' })]; });
  assert.ok(errs.some((e) => /duplicate roleGrant for the same role/.test(e)), JSON.stringify(errs));
});

// --- the self-destructing shape ------------------------------------------------------------------

test('roleGrants: extending a role this SAME spec authors as a persona is rejected', () => {
  // `personas[]` converges its role with ReplacePrivilegesRole, so a grant on it is added, removed by
  // the next build's persona pass, and re-added — churn that reads as an intermittent access bug.
  const errs = errorsFor((s) => {
    s.personas = [{ persona: 'Dispatcher', jobs: [{ name: 'Dispatch', privileges: [{ entity: 'contoso_order', access: ['read'] }] }] }];
    s.roleGrants = [grant({ role: 'Dispatcher' })];
  });
  const hit = errs.find((e) => /is a persona in this spec/.test(e));
  assert.ok(hit, JSON.stringify(errs));
  // The error must name the alternative, or the author has nowhere to go.
  assert.match(hit, /declare these privileges on that persona's job instead/);
});

test('roleGrants: the persona overlap check uses the trimmed, case-folded role identity', () => {
  // " Dispatcher " and "dispatcher" are ONE role to the SDK, so they must be one role to this check —
  // otherwise the guard is trivially bypassed by whitespace and the convergence churn returns.
  const errs = errorsFor((s) => {
    s.personas = [{ persona: '  Dispatcher  ', jobs: [{ name: 'Dispatch', privileges: [{ entity: 'contoso_order', access: ['read'] }] }] }];
    s.roleGrants = [grant({ role: 'dispatcher' })];
  });
  assert.ok(errs.some((e) => /is a persona in this spec/.test(e)), JSON.stringify(errs));
});

// --- privileges ----------------------------------------------------------------------------------

test('roleGrants: an empty privileges[] is rejected — the SDK rejects an empty grant too', () => {
  for (const privileges of [undefined, []]) {
    const errs = errorsFor((s) => { s.roleGrants = [grant({ privileges })]; });
    assert.ok(errs.some((e) => /privileges must be a non-empty array/.test(e)), `${JSON.stringify(privileges)}: ${JSON.stringify(errs)}`);
  }
});

test('roleGrants: access and scope tokens are validated against the Dataverse enums', () => {
  const bad = errorsFor((s) => { s.roleGrants = [grant({ privileges: [{ entity: 'contoso_order', access: ['reed'], scope: 'org' }] })]; });
  assert.ok(bad.some((e) => /unknown access 'reed'/.test(e)), JSON.stringify(bad));
  assert.ok(bad.some((e) => /unknown scope 'org'/.test(e)), JSON.stringify(bad));
});

test('roleGrants: every Dataverse access token the bug asked for is accepted', () => {
  // The reported matrix: Create, Read, Write, Delete, Append, AppendTo, Assign, Share at Organization.
  const s = base();
  s.roleGrants = [grant({ privileges: [{ entity: 'contoso_order', access: ['create', 'read', 'write', 'delete', 'append', 'appendTo', 'assign', 'share'], scope: 'organization' }] })];
  const r = validateAppSpec(s, { profile: 'deploy' });
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});

// --- plan ----------------------------------------------------------------------------------------

test('roleGrants: the plan names the role, so a dry run shows what would be granted', () => {
  const s = base();
  s.roleGrants = [grant()];
  const labels = planFor(s, {}).map((p) => p.label);
  assert.ok(labels.some((l) => /grant privileges on 1 table to existing role "Contoso PM - Project Manager"/.test(l)), labels.join(' | '));
});

test('roleGrantLabel falls back to the pinned id when there is no name', () => {
  assert.strictEqual(roleGrantLabel({ role: ' PM ' }), '"PM"');
  assert.strictEqual(roleGrantLabel({ roleId: 'abc' }), 'abc');
});

// --- resolution: fail closed ---------------------------------------------------------------------

const roleRow = (over = {}) => ({ roleid: '33333333-3333-3333-3333-333333333333', name: 'Contoso PM - Project Manager', ismanaged: false, ...over });

function fakeProvision(handlers) {
  return { queryRecords: async (entity, opts) => (handlers[entity] ? handlers[entity](opts) : []) };
}

test('resolveRoleGrantTarget: a name resolves within the root business unit', async () => {
  const seen = [];
  const p = fakeProvision({
    businessunit: () => [{ businessunitid: '44444444-4444-4444-4444-444444444444' }],
    role: (o) => { seen.push(o.filter); return [roleRow()]; },
  });
  const t = await resolveRoleGrantTarget(p, grant(), {});
  assert.strictEqual(t.roleId, '33333333-3333-3333-3333-333333333333');
  // The BU clause must be present, or a same-named role in another BU could be picked.
  assert.match(seen[0], /_businessunitid_value eq 44444444-4444-4444-4444-444444444444/);
});

test('resolveRoleGrantTarget: an unresolvable business unit FAILS rather than matching on name alone', async () => {
  // Teardown/verify fall back to a name-only match because a false negative there is only noisy.
  // Here a name-only match could grant privileges on a same-named role in a DIFFERENT business unit.
  const p = fakeProvision({ businessunit: () => [], role: () => [roleRow()] });
  await assert.rejects(() => resolveRoleGrantTarget(p, grant(), {}), /could not resolve the business unit/);
});

test('resolveRoleGrantTarget: no match and an ambiguous match are both errors', async () => {
  const bu = { businessunit: () => [{ businessunitid: '44444444-4444-4444-4444-444444444444' }] };
  await assert.rejects(
    () => resolveRoleGrantTarget(fakeProvision({ ...bu, role: () => [] }), grant(), {}),
    /no security role with that name exists/,
  );
  await assert.rejects(
    () => resolveRoleGrantTarget(fakeProvision({ ...bu, role: () => [roleRow(), roleRow({ roleid: '55555555-5555-5555-5555-555555555555' })] }), grant(), {}),
    /2 roles share that name/,
  );
});

test('resolveRoleGrantTarget: a stale pinned roleId is an error, never a create trigger', async () => {
  const p = fakeProvision({ role: () => [] });
  await assert.rejects(
    () => resolveRoleGrantTarget(p, { roleId: '11111111-1111-1111-1111-111111111111', privileges: [] }, {}),
    /does not exist on this environment/,
  );
});

test('resolveRoleGrantTarget: a MANAGED role resolves — extending a shipped role is the point', async () => {
  const p = fakeProvision({ role: () => [roleRow({ ismanaged: true })] });
  const t = await resolveRoleGrantTarget(p, { roleId: '33333333-3333-3333-3333-333333333333', privileges: [] }, {});
  assert.strictEqual(t.managed, true);
});

// --- apply: additive, and it halts rather than skipping ------------------------------------------

function buildSdk(over = {}) {
  const calls = { addEntityPrivilegesToRole: [], addSolutionComponent: [] };
  const sdk = {
    calls,
    queryRecords: async (entity) => {
      if (entity === 'businessunit') return [{ businessunitid: '44444444-4444-4444-4444-444444444444' }];
      if (entity === 'role') return [roleRow()];
      return [];
    },
    addEntityPrivilegesToRole: async (roleId, privileges) => {
      calls.addEntityPrivilegesToRole.push({ roleId, privileges });
      return [{ privilegeName: 'prvReadcontoso_order', scope: 'organization' }];
    },
    addSolutionComponent: async (o) => { calls.addSolutionComponent.push(o); },
    ...over,
  };
  return sdk;
}

async function applySecurity(spec, sdk) {
  return runSdkBuild(spec, { sdk, provisionSdk: sdk, apply: true, phases: ['security'] });
}

test('roleGrants: apply calls the ADDITIVE SDK surface, with the declared scope intact', async () => {
  const s = base();
  s.roleGrants = [grant()];
  const sdk = buildSdk();
  const r = await applySecurity(s, sdk);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(sdk.calls.addEntityPrivilegesToRole.length, 1);
  const call = sdk.calls.addEntityPrivilegesToRole[0];
  assert.strictEqual(call.roleId, '33333333-3333-3333-3333-333333333333');
  // The scope must survive the trip: the SDK maps it to Depth, and a dropped scope would silently
  // grant at Basic (user-owned records only) instead of the Organization access the author declared.
  assert.deepStrictEqual(call.privileges, [{ entity: 'contoso_order', access: ['read', 'write'], scope: 'organization' }]);
  assert.ok(r.created.roleGrants['Contoso PM - Project Manager']);
});

test('roleGrants: a foreign role is NOT added to this app solution', async () => {
  // A persona role is ours to place. A pre-existing (possibly managed) role already lives wherever
  // its owner put it, and moving it would be an ownership decision the author never asked for.
  const s = base();
  s.roleGrants = [grant()];
  const sdk = buildSdk();
  await applySecurity(s, sdk);
  assert.strictEqual(sdk.calls.addSolutionComponent.filter((c) => c.componentType === 20).length, 0, JSON.stringify(sdk.calls.addSolutionComponent));
});

test('roleGrants: an unresolvable role HALTS the build instead of skipping', async () => {
  // Skipping would report a successful build whose users still cannot open the table — the exact
  // failure this feature was filed for. A BuildHalt THROWS out of runSdkBuild; asserting on a
  // returned `ok:false` would pass even if the grant had been quietly swallowed.
  const s = base();
  s.roleGrants = [grant()];
  const sdk = buildSdk({ queryRecords: async (entity) => (entity === 'businessunit' ? [{ businessunitid: '44444444-4444-4444-4444-444444444444' }] : []) });
  await assert.rejects(() => applySecurity(s, sdk), (err) => {
    assert.strictEqual(err.code, 'role-grant-unresolved');
    assert.match(err.message, /no security role with that name exists/);
    return true;
  });
  // Nothing was granted — a failed resolution must not reach the write.
  assert.strictEqual(sdk.calls.addEntityPrivilegesToRole.length, 0);
});

test('roleGrants: an SDK apply failure HALTS and surfaces the SDK message', async () => {
  // The live-metadata guards (a table that exposes no such access; two tables sharing one prv* at
  // different depths) can only fire here, so their message has to reach the author verbatim.
  const s = base();
  s.roleGrants = [grant()];
  const sdk = buildSdk({ addEntityPrivilegesToRole: async () => { throw new Error("Entity 'contoso_order' does not support 'share' access."); } });
  await assert.rejects(() => applySecurity(s, sdk), (err) => {
    assert.strictEqual(err.code, 'role-grant-failed');
    assert.match(err.message, /does not support 'share' access/);
    return true;
  });
});

// --- verify --------------------------------------------------------------------------------------
//
// Verification matters MORE here than for a persona role. A persona role is converged by
// ReplacePrivilegesRole, so proving the row exists proves its content. A grant is additive onto a role
// that already existed and still exists whether or not the privileges landed — so without a privilege
// read, a grant that silently failed verifies clean.

const { verifySpec } = require('../lib/verify-spec.js');

const ORDER_PRIVS = [
  { Name: 'prvReadcontoso_order', PrivilegeId: 'ord-read', PrivilegeType: 'Read' },
  { Name: 'prvWritecontoso_order', PrivilegeId: 'ord-write', PrivilegeType: 'Write' },
];

function verifyReader({ role, rolePrivileges, entityPrivileges } = {}) {
  const r = {
    findTable: async () => null,
    findColumns: async () => [],
    sitemapXml: async () => '',
    queryRecords: async (set) => {
      if (set === 'businessunit') return [{ businessunitid: '44444444-4444-4444-4444-444444444444' }];
      if (set === 'role') return role === undefined ? [{ roleid: 'role-1', name: 'Contoso PM - Project Manager' }] : role;
      return [];
    },
  };
  if (rolePrivileges) r.rolePrivileges = rolePrivileges;
  if (entityPrivileges) r.entityPrivileges = entityPrivileges;
  return r;
}

const verifiableSpec = () => ({ solution: { uniqueName: 'S' }, app: { name: 'A' }, entities: [], views: [], charts: [], forms: [], appShell: { areas: [] }, roleGrants: [grant()] });

test('verifySpec PASSES a roleGrant whose privileges the role actually holds', async () => {
  const r = await verifySpec(verifiableSpec(), verifyReader({
    rolePrivileges: async () => [{ privilegeId: 'ord-read', depth: 'Global' }, { privilegeId: 'ord-write', depth: 'Global' }],
    entityPrivileges: async () => ORDER_PRIVS,
  }));
  const c = r.checks.find((x) => x.kind === 'role-grant-privileges');
  assert.ok(c && c.present, JSON.stringify(c));
});

test('verifySpec FAILS a roleGrant whose privileges never landed', async () => {
  // THE regression this check exists for: the grant silently failed, the role still exists, and
  // without a privilege read the build reports success while users still cannot open the table.
  const r = await verifySpec(verifiableSpec(), verifyReader({
    rolePrivileges: async () => [{ privilegeId: 'ord-read', depth: 'Global' }],
    entityPrivileges: async () => ORDER_PRIVS,
  }));
  const c = r.checks.find((x) => x.kind === 'role-grant-privileges');
  assert.ok(c && !c.present, JSON.stringify(c));
  assert.match(c.detail, /contoso_order\.write/);
  assert.strictEqual(r.ok, false);
});

test('verifySpec: a grant held at too SHALLOW a depth fails', async () => {
  // Declared `organization` (Global). Basic would restrict the persona to their own records — a real
  // access defect that an existence-only check reports as fine.
  const r = await verifySpec(verifiableSpec(), verifyReader({
    rolePrivileges: async () => [{ privilegeId: 'ord-read', depth: 'Basic' }, { privilegeId: 'ord-write', depth: 'Global' }],
    entityPrivileges: async () => ORDER_PRIVS,
  }));
  const c = r.checks.find((x) => x.kind === 'role-grant-privileges');
  assert.ok(c && !c.present);
  assert.match(c.detail, /at Basic, below the declared Global/);
});

test('verifySpec: privileges the role holds beyond the grant are NOT a finding', async () => {
  // Subset semantics are load-bearing here: every OTHER privilege on a foreign role belongs to
  // somebody else, and reporting them would make the check unusable on exactly its target scenario.
  const r = await verifySpec(verifiableSpec(), verifyReader({
    rolePrivileges: async () => [
      { privilegeId: 'ord-read', depth: 'Global' }, { privilegeId: 'ord-write', depth: 'Global' },
      { privilegeId: 'somebody-elses-privilege', depth: 'Global' },
    ],
    entityPrivileges: async () => ORDER_PRIVS,
  }));
  const c = r.checks.find((x) => x.kind === 'role-grant-privileges');
  assert.ok(c && c.present, JSON.stringify(c));
});

test('verifySpec: a roleGrant does NOT imply appmodule read', async () => {
  // `declaredPrivileges` folds an appmodule read into a PERSONA (without it the role exists but the
  // app does not open). A grant declares exactly what it declares; implying app access here would
  // fail every grant on a role that legitimately has none.
  const r = await verifySpec(verifiableSpec(), verifyReader({
    rolePrivileges: async () => [{ privilegeId: 'ord-read', depth: 'Global' }, { privilegeId: 'ord-write', depth: 'Global' }],
    entityPrivileges: async (e) => { assert.notStrictEqual(e, 'appmodule', 'a roleGrant must not read appmodule privileges'); return ORDER_PRIVS; },
  }));
  assert.ok(r.checks.find((x) => x.kind === 'role-grant-privileges').present);
});

test('verifySpec: an ambiguous role name is NOT proof — the grant check fails', async () => {
  // Two same-named roles in one BU: we cannot know which one was granted on, so "found" would be a lie.
  const r = await verifySpec(verifiableSpec(), verifyReader({
    role: [{ roleid: 'role-1', name: 'X' }, { roleid: 'role-2', name: 'X' }],
    rolePrivileges: async () => [],
    entityPrivileges: async () => ORDER_PRIVS,
  }));
  const c = r.checks.find((x) => x.kind === 'role-grant');
  assert.ok(c && !c.present, JSON.stringify(c));
});

test('verifySpec fails CLOSED when a granted role\'s privileges cannot be read', async () => {
  const r = await verifySpec(verifiableSpec(), verifyReader({
    rolePrivileges: async () => { throw new Error('429 throttled'); },
    entityPrivileges: async () => ORDER_PRIVS,
  }));
  const c = r.checks.find((x) => x.kind === 'role-grant-privileges');
  assert.ok(c && !c.present);
  assert.match(c.detail, /could not read/);
});

test('verifySpec: an existence-only reader emits no roleGrant privilege check', async () => {
  // Reader-gated, exactly like the persona check — an old reader must behave as it did before.
  const r = await verifySpec(verifiableSpec(), verifyReader());
  assert.ok(r.checks.some((c) => c.kind === 'role-grant'), 'the existence check still runs');
  assert.ok(!r.checks.some((c) => c.kind === 'role-grant-privileges'));
});

// --- teardown ------------------------------------------------------------------------------------

test('teardown plans NOTHING for a roleGrant — a grant is one-way by design', async () => {
  // The bug asks for "safe teardown semantics that do not remove pre-existing grants". AddPrivilegesRole
  // does not record WHO added a privilege, so a revoke could not distinguish a privilege this spec
  // granted from one the role already held — and stripping the latter is the outcome being guarded
  // against. This test exists so that adding a revoke step later is a deliberate, visible decision.
  const { planTeardown } = require('../lib/sdk-teardown.js');
  const s = base();
  s.roleGrants = [grant()];
  const steps = planTeardown(s, { allowDestructive: true });
  const list = Array.isArray(steps) ? steps : (steps && steps.steps) || [];
  const touching = list.filter((st) => /roleGrant|grant/i.test(`${st.kind} ${st.label}`));
  assert.deepStrictEqual(touching, [], `teardown must not plan any roleGrant step: ${JSON.stringify(touching)}`);
  // And it must not have planned a role deletion for the foreign role either.
  const roleSteps = list.filter((st) => st.kind === 'role');
  assert.deepStrictEqual(roleSteps, [], `a roleGrant target is not ours to delete: ${JSON.stringify(roleSteps)}`);
});
