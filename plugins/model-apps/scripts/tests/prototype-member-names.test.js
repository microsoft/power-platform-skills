'use strict';
// A name a maker writes freely can be exactly a member of Object.prototype: a dashboard, a persona (its security role), a business process
// flow and a status reason called `__proto__`, `constructor`, `toString` or `hasOwnProperty`, a page whose key is `constructor`, a Custom API
// parameter called `constructor` or `toString` (Dataverse refuses a parameter called `__proto__`: its name must begin with a letter). Each is a
// legal name, and the plugin must treat it as one more name.
//
// A plain object `{}` used as a map gets both directions wrong for such a name:
//   - a READ of a name nobody stored answers the inherited member — the Object function, a function, the prototype itself — and each is
//     truthy, so "was it built?" answers yes and the member is used as the id;
//   - a WRITE of `__proto__` calls the inherited prototype setter: the entry is never stored (JSON.stringify leaves it out), and an object
//     value becomes the map's prototype.
// These tests hold the maps the plugin builds from such names, and the reads of them, to the plain-name contract: every name is an own
// entry, a name that was not stored reads as absent, and what is written for ordinary names is byte for byte what it was. The same
// tests over the real bundle and a fake environment are in prototype-member-names-real-bundle.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
// An apply that names no app folder and no workspace gets an app folder of its own: it holds its build lease in its workspace (helpers/own-app-folder.js).
const { inOwnFolder } = require('./helpers/own-app-folder.js');
const { appDef, commandsByEntity, runSdkBuild: runSdkBuildInPlace } = require('../lib/sdk-build.js');
const runSdkBuild = inOwnFolder(runSdkBuildInPlace);
const { indexArtifacts } = require('../lib/apply-snapshot-index.js');
const flow = require('../lib/changed-only-flow.js');
const snap = require('../lib/apply-snapshot.js');
const { buildSeedGroup, statusReasonTargets } = require('../lib/entity-provision.js');
const { validateAppSpec } = require('../lib/app-spec.js');
const { validateProvisionInput } = require('../lib/provision-input.js');
const { parameterKindsFromRows, toCustomApiEntry } = require('../list-custom-apis.js');

const NAMES = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'];
// A map holding each of `names` as its OWN key, as JSON.parse makes it: a plain object literal cannot (`{ __proto__: x }` and
// `{ '__proto__': x }` both mean the prototype, not an entry), and assigning to a plain object calls the setter.
const ownMap = (names, valueOf) => JSON.parse(`{${names.map((name) => `${JSON.stringify(name)}:${JSON.stringify(valueOf(name))}`).join(',')}}`);
const GUIDS = ['11111111-aaaa-4aaa-8aaa-111111111111', '22222222-bbbb-4bbb-8bbb-222222222222', '33333333-cccc-4ccc-8ccc-333333333333', '44444444-dddd-4ddd-8ddd-444444444444'];
const ID = ownMap(NAMES, (name) => GUIDS[NAMES.indexOf(name)]);
// The JSON a map writes — the bytes a result, a snapshot or a record holds.
const json = (value) => JSON.stringify(value);

// --- the shared reader -------------------------------------------------------------------------------------------------------------------------------------

test('ownValue answers only an entry a map holds: an inherited member is absent, and an own __proto__ key is an entry like any other', () => {
  // Loaded here, so that the other tests of this file fail on their own assertions when the module is not there.
  const { ownValue } = require('../lib/own-keys.js');
  const held = ownMap([...NAMES, 'Ops Overview'], (name) => `id of ${name}`);
  for (const name of [...NAMES, 'Ops Overview']) assert.equal(ownValue(held, name), `id of ${name}`, `${name}: the entry held`);
  for (const name of NAMES) {
    assert.equal(ownValue({}, name), undefined, `${name}: a plain object holds no such entry`);
    assert.equal(ownValue(Object.create(null), name), undefined, `${name}: nor does a null-prototype one`);
  }
  for (const notAMap of [undefined, null, 0, '', 'constructor', true]) assert.equal(ownValue(notAMap, 'constructor'), undefined, `${JSON.stringify(notAMap)} is no map`);
  assert.equal(ownValue(['a'], 0), 'a', 'an array is read by its own indices, as before');
  assert.equal(Object.getPrototypeOf(held), Object.prototype, 'reading changes no prototype');
});

// --- the app's navigation (sdk-build.js appDef) ------------------------------------------------------------------------------------------------------------

const appSpec = (subAreas) => ({
  schemaVersion: 2,
  solution: { uniqueName: 'ContosoBoards', publisherPrefix: 'contoso' },
  app: { name: 'Boards', uniqueName: 'contoso_boards' },
  appShell: { areas: [{ label: 'Work', groups: [{ label: 'Boards', subAreas }] }] },
});
const entriesOf = (def) => def.siteMap.areas[0].groups[0].subAreas;

test('a navigation entry opens the dashboard of its name when that name is a member of Object.prototype, and is refused when no such dashboard was built', () => {
  const spec = appSpec(NAMES.map((name) => ({ dashboard: name, title: `Board ${name}` })));
  const built = entriesOf(appDef(spec, { dashboards: ownMap(NAMES, (name) => ID[name]) }));
  assert.deepEqual(built.map((s) => [s.type, s.dashboardId]), NAMES.map((name) => ['DashBoard', ID[name]]), 'each entry opens the dashboard built under its name');
  for (const name of NAMES) {
    const one = appSpec([{ dashboard: name, title: 'Board' }]);
    for (const [what, result] of [['none was built', { dashboards: {} }], ['no dashboard map at all', {}], ['the build wrote a null-prototype map', { dashboards: Object.create(null) }]]) {
      assert.throws(() => appDef(one, result), (e) => e.message.includes(`references dashboard '${name}' which wasn't built`), `${name}, ${what}: refused, never opened as the inherited member`);
    }
  }
});

test('a navigation entry of a page keyed or named like a member of Object.prototype is left out of an app\'s first create while its page is not built, and refused at the finalize', () => {
  for (const name of NAMES) {
    const spec = appSpec([{ entity: 'contact', title: 'Contacts' }, { page: name, title: 'The page' }]);
    for (const pages of [{}, Object.create(null)]) {
      const first = entriesOf(appDef(spec, { pages }, { omitUnbuiltPages: true }));
      assert.deepEqual(first.map((s) => s.type), ['Entity'], `${name}: the page entry waits for its page, as any unbuilt page's does`);
      assert.throws(() => appDef(spec, { pages }), (e) => e.message.includes(`references page '${name}' which wasn't built`), `${name}: at the finalize, an unbuilt page is refused`);
    }
    const built = entriesOf(appDef(spec, { pages: ownMap([name], () => ID.constructor) }));
    assert.deepEqual(built.map((s) => [s.type, s.genPageId || s.entity]), [['Entity', 'contact'], ['GenPage', ID.constructor]], `${name}: once built, the entry opens that page`);
  }
});

test('navigation entries of ordinary dashboard and page names are built, left out or refused exactly as before', () => {
  const spec = appSpec([{ dashboard: 'Ops Overview', title: 'Ops' }, { entity: 'contact', title: 'Contacts' }, { page: 'overview', title: 'Overview' }]);
  const result = { dashboards: { 'Ops Overview': ID.toString }, pages: { overview: ID.hasOwnProperty } };
  assert.deepEqual(entriesOf(appDef(spec, result)).map((s) => [s.type, s.dashboardId || s.genPageId || s.entity]),
    [['DashBoard', ID.toString], ['Entity', 'contact'], ['GenPage', ID.hasOwnProperty]]);
  assert.deepEqual(entriesOf(appDef(spec, { dashboards: result.dashboards, pages: {} }, { omitUnbuiltPages: true })).map((s) => s.type), ['DashBoard', 'Entity']);
  assert.throws(() => appDef(spec, { dashboards: {}, pages: result.pages }), /references dashboard 'Ops Overview' which wasn't built/);
  assert.throws(() => appDef(spec, { dashboards: result.dashboards, pages: {} }), /references page 'overview' which wasn't built/);
});

// --- grouping by a table the spec names (sdk-build.js commandsByEntity, app-spec.js validateAppSpec) ----------------------------------------------------------

test('commands are grouped by the table they name, whatever that name is, and nothing throws', () => {
  const spec = { commands: NAMES.map((name, i) => ({ entity: name, label: `Go ${i}` })).concat([{ entity: 'contoso_item', label: 'Approve' }, { entity: 'CONTOSO_ITEM', label: 'Reject' }]) };
  const grouped = commandsByEntity(spec);
  assert.deepEqual(Object.keys(grouped), ['__proto__', 'constructor', 'tostring', 'hasownproperty', 'contoso_item'], 'one group per table, lower-cased, in the spec\'s order');
  assert.deepEqual(Object.values(grouped).map((cmds) => cmds.map((c) => c.label)), [['Go 0'], ['Go 1'], ['Go 2'], ['Go 3'], ['Approve', 'Reject']]);
});

test('the spec gate reports a form whose table is called like a member of Object.prototype, and never throws on it', () => {
  for (const name of ['__proto__', 'constructor']) {
    let report;
    assert.doesNotThrow(() => { report = validateAppSpec({ ...appSpec([]), forms: [{ entity: name, name: 'Main', isDefault: true }] }); }, `${name}: isDefault`);
    assert.ok(report.errors.includes(`form references unknown entity '${name}'`), `${name}: ${JSON.stringify(report.errors)}`);
    // Two Main forms that each deactivate the other are refused for any table, as for a table the spec declares.
    const both = validateAppSpec({ ...appSpec([]), forms: [{ entity: name, name: 'A', deactivateOtherMainForms: true }, { entity: name, name: 'B', deactivateOtherMainForms: true }] });
    assert.ok(both.errors.includes(`entity '${name}': 2 Main forms set deactivateOtherMainForms — at most one may (two would deactivate each other)`), `${name}: ${JSON.stringify(both.errors)}`);
  }
  // The same rules for an ordinary table, unchanged.
  const ordinary = validateAppSpec({ ...appSpec([]), forms: [{ entity: 'contoso_ghost', name: 'A', deactivateOtherMainForms: true }, { entity: 'contoso_ghost', name: 'B', deactivateOtherMainForms: true }] });
  assert.ok(ordinary.errors.includes("entity 'contoso_ghost': 2 Main forms set deactivateOtherMainForms — at most one may (two would deactivate each other)"), JSON.stringify(ordinary.errors));
});

test('a column type called like a member of Object.prototype is an unknown type, at both gates', () => {
  const entity = (type) => ({ schemaName: 'contoso_item', displayName: 'Item', primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' }, columns: [{ schemaName: 'contoso_note', displayName: 'Note', type }] });
  for (const type of NAMES) {
    const spec = validateAppSpec({ ...appSpec([{ entity: 'contoso_item', title: 'Items' }]), entities: [entity(type)] });
    assert.ok(spec.errors.includes(`entity contoso_item: column contoso_note has unknown type '${type}'`), `${type}: the App Spec gate — ${JSON.stringify(spec.errors)}`);
    const input = validateProvisionInput({ solution: { uniqueName: 'S', publisherPrefix: 'contoso' }, entities: [entity(type)] });
    assert.ok(input.errors.includes(`entity 'contoso_item': column 'contoso_note' has unknown type '${type}'`), `${type}: the provisioning input gate — ${JSON.stringify(input.errors)}`);
  }
  for (const type of ['Text', 'Memo', 'Choice', 'Lookup']) {
    const spec = validateAppSpec({ ...appSpec([{ entity: 'contoso_item', title: 'Items' }]), entities: [entity(type)] });
    assert.ok(!spec.errors.some((e) => e.includes('unknown type')), `${type} is still a type: ${JSON.stringify(spec.errors)}`);
  }
});

test('names that are members of Object.prototype are valid names: the spec gate accepts them for dashboards, pages, personas, flows and status reasons', () => {
  const spec = {
    ...appSpec(NAMES.map((name) => ({ dashboard: name, title: `Board ${name}` })).concat([{ page: 'constructor', title: 'Constructor' }, { entity: 'contoso_ticket', title: 'Tickets' }])),
    entities: [{
      schemaName: 'contoso_ticket', displayName: 'Ticket', primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' },
      statusReasons: NAMES.map((label) => ({ label, state: 'Active' })),
      columns: [{ schemaName: 'contoso_notes', displayName: 'Notes', type: 'Text' }],
    }],
    dashboards: NAMES.map((name) => ({ name, tiles: [{ type: 'iframe', url: 'https://contoso.example/status', name: 'Status' }] })),
    pages: [{ key: 'constructor', name: 'Constructor', source: { kind: 'intent' } }],
    personas: NAMES.map((persona) => ({ persona, jobs: [{ name: 'Work', privileges: [{ entity: 'contoso_ticket', access: ['read'] }] }] })),
    businessProcessFlows: [{ name: '__proto__', entity: 'contoso_ticket', status: 'Active', stages: [{ name: 'Triage', steps: [{ name: 'Notes', field: 'contoso_notes' }] }], securityRoles: { personas: NAMES } }],
    sampleData: { contoso_ticket: NAMES.map((statusReason, i) => ({ contoso_name: `T${i}`, statusReason })) },
  };
  assert.deepEqual(validateAppSpec(spec, { profile: 'plan' }).errors, []);
});

// --- the changed-only snapshot (apply-snapshot-index.js, changed-only-flow.js) -------------------------------------------------------------------------------

test('the snapshot index records a dashboard of each of these names under its own name, and none that was not built', () => {
  const spec = { dashboards: NAMES.map((name) => ({ name })) };
  const built = indexArtifacts(spec, { dashboards: ownMap(NAMES, (name) => ID[name]) });
  assert.equal(json(built.dashboards), json(ownMap(NAMES, (name) => ({ id: ID[name] }))), 'every dashboard, in the spec\'s order');
  for (const created of [{ dashboards: {} }, {}, { dashboards: Object.create(null) }]) {
    const none = indexArtifacts(spec, created);
    assert.deepEqual(Object.keys(none.dashboards), [], `nothing built, nothing recorded (${json(created)})`);
    assert.equal(json(none.dashboards), '{}');
  }
});

test('the snapshot index records a page keyed constructor only when it was deployed, with its source hash standing for the deployed one', () => {
  const spec = { pages: [{ key: 'constructor', name: 'Constructor', __contentSha: 'sha-constructor' }] };
  const deployed = indexArtifacts(spec, { pages: ownMap(['constructor'], () => ID.constructor) });
  assert.deepEqual({ ...deployed.pages.constructor }, { pageId: ID.constructor, sourceSha: 'sha-constructor', deployedSha: 'sha-constructor' });
  assert.equal(json(deployed.pages), `{"constructor":{"pageId":"${ID.constructor}","sourceSha":"sha-constructor","deployedSha":"sha-constructor"}}`);
  const staged = indexArtifacts(spec, { pages: ownMap(['constructor'], () => ID.constructor) }, { pageDeployedShas: ownMap(['constructor'], () => 'sha-deployed') });
  assert.equal(staged.pages.constructor.deployedSha, 'sha-deployed', 'a staged deployed hash still wins');
  for (const pages of [{}, Object.create(null)]) assert.equal(json(indexArtifacts(spec, { pages }).pages), '{}', 'an undeployed page is not recorded');
});

test('the snapshot index of ordinary names is byte for byte what it was', () => {
  const spec = {
    entities: [{ schemaName: 'new_x', primaryAttribute: { schemaName: 'new_name' } }],
    views: [{ entity: 'new_x', name: 'Active X', columns: ['new_name'] }],
    forms: [{ entity: 'new_x', name: 'Main', formType: 'Main', layout: 'auto' }],
    charts: [{ entity: 'new_x', name: 'By Status' }],
    commands: [{ entity: 'new_x', name: 'Approve' }],
    dashboards: [{ name: 'Ops' }, { name: 'Sales Overview' }],
    webResources: [{ name: 'wr_a', __contentSha: 'wsha1' }],
    pages: [{ key: 'overview', name: 'Overview', __contentSha: 'psha1' }, { key: 'detail', name: 'Detail', __contentSha: 'psha2' }],
  };
  const created = { entities: { new_x: 'ent-1' }, views: { 'new_x|Active X': 'view-1' }, forms: { new_x: 'form-1' }, charts: { 'new_x|By Status': 'chart-1' }, commands: { new_x: 'cmd-1' }, dashboards: { Ops: 'dash-1', 'Sales Overview': 'dash-2' }, webResources: { wr_a: 'wr-1' }, app: 'app-1', pages: { overview: 'page-1', detail: 'page-2' } };
  assert.equal(json(indexArtifacts(spec, created, { pageDeployedShas: { detail: 'deployed-2' }, sitemapSha: 'smap' })),
    '{"pages":{"overview":{"pageId":"page-1","sourceSha":"psha1","deployedSha":"psha1"},"detail":{"pageId":"page-2","sourceSha":"psha2","deployedSha":"deployed-2"}},'
    + '"forms":{"new_x|Main|Main":{"formId":"form-1"}},"views":{"new_x|Active X":{"viewId":"view-1"}},"app":{"appId":"app-1","sitemapSha":"smap"},'
    + '"webResources":{"wr_a":{"id":"wr-1","sourceSha":"wsha1"}},"entities":{"new_x":{"id":"ent-1"}},"charts":{"new_x|By Status":{"id":"chart-1"}},'
    + '"commands":{"new_x|Approve":{"id":"cmd-1"}},"dashboards":{"Ops":{"id":"dash-1"},"Sales Overview":{"id":"dash-2"}}}');
});

const LIVE = { orgId: 'org-1', envUrl: 'https://contoso.crm.dynamics.com', appUniqueName: 'contoso_boards', appId: 'app-1' };
// An eligible snapshot of an app with one page keyed constructor — recorded or not — refreshed after a fast apply that re-uploaded it.
function fastSnapshot({ recorded, created }) {
  const annotatedSpec = { pages: [{ key: 'constructor', name: 'Constructor', source: { kind: 'tsx', codeFile: 'constructor.tsx' }, __contentSha: 'sha-v2' }] };
  const snapshot = snap.makeEnvelope(LIVE, { generation: 'g0' });
  snapshot.priorSpec = annotatedSpec;
  snapshot.artifacts = { pages: recorded ? ownMap(['constructor'], () => ({ pageId: ID.constructor, sourceSha: 'sha-v1', deployedSha: 'sha-v1' })) : {} };
  snap.markEligible(snapshot);
  return flow.assembleFastSnapshot({ snapshot, annotatedSpec, created, pageKeys: ['constructor'], generation: 'g1' });
}

test('a fast apply of a page keyed constructor records its hashes and id, and takes the source hash when no deployed one was measured', () => {
  for (const [what, recorded, created, pageId] of [
    ['the build answered its id', false, { pages: ownMap(['constructor'], () => ID.constructor) }, ID.constructor],
    ['the build answered no id, the snapshot holds it', true, { pages: {} }, ID.constructor],
    ['no id anywhere', false, { pages: {} }, null],
    ['a result with no page maps', false, {}, null],
  ]) {
    const env = fastSnapshot({ recorded, created });
    const entry = { pageId, sourceSha: 'sha-v2', deployedSha: 'sha-v2' };
    assert.deepEqual({ ...env.artifacts.pages.constructor }, entry, what);
    assert.deepEqual(snap.parseEnvelope(snap.serializeEnvelope(env)).artifacts.pages.constructor, entry, `${what}: and so does the snapshot written to disk`);
  }
  const measured = fastSnapshot({ recorded: true, created: { pages: ownMap(['constructor'], () => ID.constructor), pageDeployedShas: ownMap(['constructor'], () => 'sha-deployed') } });
  assert.equal(measured.artifacts.pages.constructor.deployedSha, 'sha-deployed', 'a measured deployed hash still wins');
});

// --- status reasons (entity-provision.js) ---------------------------------------------------------------------------------------------------------------------

const ticketSpec = () => ({
  solution: { uniqueName: 'S', publisherPrefix: 'contoso' },
  entities: [{ schemaName: 'contoso_ticket', displayName: 'Ticket', primaryAttribute: { schemaName: 'contoso_name' }, statusReasons: NAMES.map((label) => ({ label, state: 'Active' })), columns: [] }],
  sampleData: { contoso_ticket: NAMES.map((statusReason, i) => ({ contoso_name: `T${i}`, statusReason })) },
});

test('a sample record whose status reason is called like a member of Object.prototype halts when its value was not captured, as any status reason does', () => {
  const spec = ticketSpec();
  for (const [i, name] of NAMES.entries()) {
    for (const statusReasonValues of [{}, { contoso_ticket: {} }, { contoso_ticket: Object.create(null) }]) {
      assert.throws(() => buildSeedGroup({ spec, e: spec.entities[0], records: [spec.sampleData.contoso_ticket[i]], statusReasonValues }),
        (e) => e.message.includes(`record sets statusReason '${name}' on contoso_ticket, but its status value wasn't captured`), `${name}: ${json(statusReasonValues)}`);
    }
  }
});

test('a sample record whose status reason is called like a member of Object.prototype gets the value captured for it', () => {
  const spec = ticketSpec();
  const captured = { contoso_ticket: ownMap(NAMES, (name) => ({ value: 100000000 + NAMES.indexOf(name), stateCode: 0 })) };
  const group = buildSeedGroup({ spec, e: spec.entities[0], records: spec.sampleData.contoso_ticket, statusReasonValues: captured });
  assert.deepEqual(group.records.map((r) => [r.body.statuscode, r.body.statecode]), NAMES.map((name, i) => [100000000 + i, 0]));
});

test('a status reason whose state is a member of Object.prototype is placed in the state a reason of an unknown state is placed in', () => {
  const targets = statusReasonTargets({ statusReasons: [...NAMES, 'Pending', 'Inactive', 'Active'].map((state, i) => ({ label: `R${i}`, state })) });
  assert.deepEqual(targets.map((t) => t.stateCode), [0, 0, 0, 0, 0, 1, 0], 'Active (0) as for any state it does not know; Inactive is still 1');
});

// --- Custom API parameters (list-custom-apis.js) -------------------------------------------------------------------------------------------------------------

// `__proto__` cannot name a parameter (Dataverse requires a letter first); it stays in NAMES because the maps are null-prototype as a defence,
// and must hold it all the same.
test('a Custom API parameter called like a member of Object.prototype is listed with its kind, and a lookup one with its table', () => {
  const primitives = NAMES.map((uniquename, i) => ({ uniquename, type: [10, 7, 0, 12][i], isoptional: false }));
  const kinds = parameterKindsFromRows(primitives);
  assert.deepEqual(Object.keys(kinds), NAMES, 'every parameter, in the order read');
  assert.equal(json(kinds), json(ownMap(NAMES, (name) => ['String', 'Integer', 'Boolean', 'Guid'][NAMES.indexOf(name)])));
  // A lookup (type 5) declares no kind; it is listed with its table and whether it is optional.
  const lookups = NAMES.map((uniquename) => ({ uniquename, type: 5, isoptional: uniquename === 'toString', logicalentityname: 'account' }));
  const entry = toCustomApiEntry({ uniquename: 'contoso_Approve', bindingtype: 0, CustomAPIRequestParameters: lookups }, parameterKindsFromRows(lookups));
  assert.deepEqual(Object.keys(entry.lookupParameters || {}), NAMES, 'every lookup, in the order read');
  assert.equal(json(entry.lookupParameters), json(ownMap(NAMES, (name) => ({ isOptional: name === 'toString', logicalEntityName: 'account' }))));
  assert.equal(json(entry.parameterKinds), '{}', 'a lookup declares no kind, as before');
});

// --- the persona roles and flow role grants of a build (sdk-build.js security phase) -------------------------------------------------------------------------

const ROLE_ID = '55555555-5555-4555-8555-555555555555';
function securityFlowSdk() {
  const calls = { addEntityPrivilegesToRole: [] };
  return {
    calls,
    queryRecords: async (entity) => (entity === 'businessunit' ? [{ businessunitid: '66666666-6666-4666-8666-666666666666' }] : []),
    createPersonaRole: async (s) => ({ roleId: ROLE_ID, name: s.name, reused: false, appliedPrivileges: [] }),
    addEntityPrivilegesToRole: async (roleId, privileges) => { calls.addEntityPrivilegesToRole.push({ roleId, privileges }); return []; },
    addSolutionComponent: async () => ({}),
    associateRecords: async () => ({}),
    disassociateRecords: async () => ({}),
    createArtifact: (type, def) => ({ id: '77777777-7777-4777-8777-777777777777', type, def }),
    pushArtifact: async (type, id) => ({ ok: true, id }),
    activateArtifact: async () => ({ ok: true }),
    updateRecord: async () => ({}),
  };
}
const flowSpec = (persona, flowName) => ({
  schemaVersion: 2,
  solution: { uniqueName: 'contoso', publisherPrefix: 'contoso' },
  app: { name: 'Contoso' },
  entities: [{ schemaName: 'contoso_ticket', displayName: 'Ticket', primaryAttribute: { schemaName: 'contoso_name' }, columns: [{ schemaName: 'contoso_notes', type: 'Text' }] }],
  personas: [{ persona, jobs: [{ name: 'Dispatch', privileges: [{ entity: 'contoso_ticket', access: ['read'] }] }] }],
  businessProcessFlows: [{ name: flowName, entity: 'contoso_ticket', status: 'Active', stages: [{ name: 'Triage', steps: [{ name: 'Notes', field: 'contoso_notes' }] }], securityRoles: { personas: [persona] } }],
  appShell: { areas: [{ label: 'Main', groups: [{ label: 'Main', subAreas: [] }] }] },
});

test('a persona and a business process flow called like members of Object.prototype: the role is recorded under the persona\'s name, the flow grants it, and the grant is recorded under the flow\'s name', async () => {
  for (const name of NAMES) {
    const spec = flowSpec(name, name);
    assert.deepEqual(validateAppSpec(spec, { profile: 'plan' }).errors, [], `${name}: a valid spec`);
    const sdk = securityFlowSdk();
    const r = await runSdkBuild(spec, { sdk, provisionSdk: sdk, apply: true, phases: ['business-process-flows', 'security'], emit: () => undefined });
    assert.equal(r.ok, true, `${name}: ${json(r).slice(0, 400)}`);
    assert.deepEqual(sdk.calls.addEntityPrivilegesToRole.map((c) => c.roleId), [ROLE_ID], `${name}: the flow's backing table is granted to the persona's role`);
    assert.deepEqual(Object.keys(r.created.roles), [name], `${name}: the role, under the persona's name`);
    assert.equal(r.created.roles[name].roleId, ROLE_ID);
    assert.deepEqual(Object.keys(r.created.bpfRoleGrants), [name], `${name}: the grant, under the flow's name`);
    const written = JSON.parse(json(r.created));
    assert.equal(written.roles[name].roleId, ROLE_ID, `${name}: and the result's JSON holds both`);
    assert.deepEqual(written.bpfRoleGrants[name].personas, [name]);
  }
});
