'use strict';
// `verifySpec`'s role check proved only that a role ROW exists carrying the SDK marker, never what
// it GRANTS. A role created with the wrong access — or one whose privilege write failed after the
// row landed — verified clean. This is a metadata read, not a runtime check.
const { test } = require('node:test');
const assert = require('node:assert');
const { declaredPrivileges, compareRolePrivileges } = require('../lib/role-privileges.js');
const { verifySpec } = require('../lib/verify-spec.js');

// A realistic privilege set as EntityDefinitions returns it.
const privsFor = (entity, id) => [
  { Name: `prvRead${entity}`, PrivilegeId: `${id}-read`, PrivilegeType: 'Read' },
  { Name: `prvWrite${entity}`, PrivilegeId: `${id}-write`, PrivilegeType: 'Write' },
  { Name: `prvCreate${entity}`, PrivilegeId: `${id}-create`, PrivilegeType: 'Create' },
];

const persona = (over = {}) => ({
  persona: 'Field Technician',
  jobs: [{ name: 'Complete work orders', privileges: [{ entity: 'msdyn_workorder', access: ['read', 'write'], scope: 'businessUnit' }] }],
  ...over,
});

test('declaredPrivileges flattens jobs and folds in the appmodule read appAccess injects', () => {
  const d = declaredPrivileges(persona());
  assert.deepStrictEqual(d.sort((a, b) => `${a.entity}${a.access}`.localeCompare(`${b.entity}${b.access}`)), [
    { entity: 'appmodule', access: 'read', scope: 'organization' },
    { entity: 'msdyn_workorder', access: 'read', scope: 'businessUnit' },
    { entity: 'msdyn_workorder', access: 'write', scope: 'businessUnit' },
  ]);
});

test('appAccess:false drops the appmodule privilege (a data-only role)', () => {
  assert.ok(!declaredPrivileges(persona({ appAccess: false })).some((d) => d.entity === 'appmodule'));
});

// Mirrors the builder's union rule, so the expectation matches what is actually written.
test('the MAX scope wins when several jobs declare the same entity+access', () => {
  const p = persona({ jobs: [
    { name: 'a', privileges: [{ entity: 'account', access: ['read'], scope: 'user' }] },
    { name: 'b', privileges: [{ entity: 'account', access: ['read'], scope: 'organization' }] },
  ] });
  const acct = declaredPrivileges(p).filter((d) => d.entity === 'account');
  assert.deepStrictEqual(acct, [{ entity: 'account', access: 'read', scope: 'organization' }]);
});

test('additionalPrivileges are folded in like a job\'s privileges', () => {
  const d = declaredPrivileges(persona({ additionalPrivileges: [{ entity: 'product', access: ['read'], scope: 'organization' }] }));
  assert.ok(d.some((x) => x.entity === 'product' && x.access === 'read'));
});

// --- comparison ---------------------------------------------------------------------------------

const entityPrivs = () => new Map([['msdyn_workorder', privsFor('Workorder', 'wo')], ['appmodule', privsFor('AppModule', 'app')]]);
const heldAll = () => new Map([['wo-read', 'Local'], ['wo-write', 'Local'], ['app-read', 'Global']]);

test('a role holding every declared privilege at the declared depth passes', () => {
  const r = compareRolePrivileges(declaredPrivileges(persona()), entityPrivs(), heldAll());
  assert.deepStrictEqual(r, { ok: true, missing: [] });
});

// SUBSET semantics: a deeper grant satisfies a shallower declaration. Equality would false-fail on
// the builder's own max-scope union and on shared Dataverse privileges.
test('a DEEPER grant than declared still passes', () => {
  const held = new Map([['wo-read', 'Global'], ['wo-write', 'Global'], ['app-read', 'Global']]);
  assert.strictEqual(compareRolePrivileges(declaredPrivileges(persona()), entityPrivs(), held).ok, true);
});

test('extra privileges the spec never declared are NOT a finding', () => {
  const held = heldAll();
  held.set('some-other-privilege', 'Global');
  assert.strictEqual(compareRolePrivileges(declaredPrivileges(persona()), entityPrivs(), held).ok, true);
});

// THE regression this check exists for.
test('a privilege the role does not hold is reported by name', () => {
  const held = heldAll();
  held.delete('wo-write');
  const r = compareRolePrivileges(declaredPrivileges(persona()), entityPrivs(), held);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.missing.length, 1);
  assert.strictEqual(r.missing[0].access, 'write');
  assert.match(r.missing[0].reason, /role does not hold prvWriteWorkorder/);
});

test('a privilege held at too SHALLOW a depth is reported with both depths', () => {
  const held = heldAll();
  held.set('wo-write', 'Basic'); // declared businessUnit => Local
  const r = compareRolePrivileges(declaredPrivileges(persona()), entityPrivs(), held);
  assert.strictEqual(r.ok, false);
  assert.match(r.missing[0].reason, /at Basic, below the declared Local/);
});

// Fail closed: an unreadable table must not read as "nothing missing".
test('an entity whose privilege metadata could not be read is a finding, not a skip', () => {
  const r = compareRolePrivileges(declaredPrivileges(persona()), new Map(), heldAll());
  assert.strictEqual(r.ok, false);
  assert.ok(r.missing.every((m) => /could not read privilege metadata/.test(m.reason)));
});

test('an access level the table does not expose is reported', () => {
  const p = persona({ jobs: [{ name: 'a', privileges: [{ entity: 'msdyn_workorder', access: ['delete'] }] }], appAccess: false });
  const r = compareRolePrivileges(declaredPrivileges(p), entityPrivs(), heldAll());
  assert.strictEqual(r.ok, false);
  assert.match(r.missing[0].reason, /exposes no 'delete' privilege/);
});

// --- verifySpec wiring --------------------------------------------------------------------------

const SDK_MARKER = 'Authored by @maker-studio/cds-maker-sdk (persona/security role).';
const specWith = (p) => ({ solution: { uniqueName: 'S' }, app: { name: 'A' }, entities: [], views: [], charts: [], forms: [], appShell: { areas: [] }, personas: [p] });

function readerWith({ rolePrivileges, entityPrivileges } = {}) {
  const base = {
    findTable: async () => null,
    findColumns: async () => [],
    sitemapXml: async () => '',
    queryRecords: async (set) => {
      if (set === 'businessunit') return [{ businessunitid: '11111111-1111-1111-1111-111111111111' }];
      if (set === 'role') return [{ roleid: 'role-1', description: SDK_MARKER, ismanaged: false }];
      return [];
    },
  };
  if (rolePrivileges) base.rolePrivileges = rolePrivileges;
  if (entityPrivileges) base.entityPrivileges = entityPrivileges;
  return base;
}

// Reader-gated, exactly like entityRelationships / commandBar: an existence-only reader must behave
// as it did before this check existed.
test('verifySpec does NOT emit a role-privileges check when the reader lacks the methods', async () => {
  const r = await verifySpec(specWith(persona()), readerWith());
  assert.ok(r.checks.some((c) => c.kind === 'role'), 'the existing role check still runs');
  assert.ok(!r.checks.some((c) => c.kind === 'role-privileges'), 'no privilege check without the readers');
});

test('verifySpec PASSES the privilege check when the role holds everything declared', async () => {
  const r = await verifySpec(specWith(persona()), readerWith({
    rolePrivileges: async () => [{ privilegeId: 'wo-read', depth: 'Local' }, { privilegeId: 'wo-write', depth: 'Local' }, { privilegeId: 'app-read', depth: 'Global' }],
    entityPrivileges: async (e) => entityPrivs().get(e) || null,
  }));
  const c = r.checks.find((x) => x.kind === 'role-privileges');
  assert.ok(c && c.present, JSON.stringify(c));
});

test('verifySpec FAILS when the role is missing a declared privilege', async () => {
  const r = await verifySpec(specWith(persona()), readerWith({
    rolePrivileges: async () => [{ privilegeId: 'wo-read', depth: 'Local' }, { privilegeId: 'app-read', depth: 'Global' }],
    entityPrivileges: async (e) => entityPrivs().get(e) || null,
  }));
  const c = r.checks.find((x) => x.kind === 'role-privileges');
  assert.ok(c && !c.present);
  assert.match(c.detail, /msdyn_workorder\.write/);
  assert.strictEqual(r.ok, false);
});

test('verifySpec fails CLOSED when the role privileges cannot be read', async () => {
  const r = await verifySpec(specWith(persona()), readerWith({
    rolePrivileges: async () => { throw new Error('429 throttled'); },
    entityPrivileges: async (e) => entityPrivs().get(e) || null,
  }));
  const c = r.checks.find((x) => x.kind === 'role-privileges');
  assert.ok(c && !c.present);
  assert.match(c.detail, /could not read/);
});
