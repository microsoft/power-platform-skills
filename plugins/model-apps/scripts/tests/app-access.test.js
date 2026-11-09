'use strict';
// lib/app-access.js: what an App Spec says about two different questions the plugin used to answer as one — who can open the APP (the roles
// associated with it) and who can use the TABLES the spec introduces (the privileges personas[] and roleGrants[] give). Pure: the lint and the design
// document both read the spec through it, so they cannot disagree about which tables nothing grants or which marks say an app already exists.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const access = require('../lib/app-access.js');
const { extensionSpec, newAppSpec, grant, persona } = require('./helpers/app-access-specs.js');

const { existingAppMarkers, introducedTables, tablePrivileges, uncoveredTables } = access;
const GUID = '11111111-2222-3333-4444-555555555555';

test('the marks of an existing app are the three a download writes — the app\u2019s unique name, a page id, a dashboard id — in a fixed order', () => {
  assert.deepEqual(existingAppMarkers(newAppSpec()), []);
  assert.deepEqual(existingAppMarkers(extensionSpec()), ['app.uniqueName']);
  const all = extensionSpec();
  all.dashboards = [{ name: 'Overview', dashboardId: GUID, tiles: [] }];
  all.pages = [{ key: 'home', name: 'Home', pageId: GUID }, { key: 'detail', name: 'Detail', pageId: GUID }];
  assert.deepEqual(existingAppMarkers(all), ['app.uniqueName', 'pages[].pageId', 'dashboards[].dashboardId'], 'each named once, whatever the count');
});

test('a mark counts only when it holds a value: a blank or non-string one is the shape of a spec still being typed', () => {
  const s = newAppSpec();
  s.app.uniqueName = '   ';
  s.pages = [{ key: 'a', name: 'A', pageId: '' }, { key: 'b', name: 'B', pageId: 42 }, null, 'x'];
  s.dashboards = [{ name: 'D', dashboardId: null }, null];
  assert.deepEqual(existingAppMarkers(s), []);
  for (const bad of [null, undefined, 'x', 7, [], { app: 'x' }, { pages: 'x', dashboards: {} }]) assert.deepEqual(existingAppMarkers(bad), []);
});

test('the tables a spec introduces are its entities that are not marked existing, named as written', () => {
  const s = extensionSpec({ newTables: ['Contoso_Baseline', 'contoso_risk'] });
  assert.deepEqual(introducedTables(s), ['Contoso_Baseline', 'contoso_risk']);
  s.entities.push(null, 'x', {}, { schemaName: '  ' }, { schemaName: 5 }, { schemaName: 'contoso_kept', existing: true });
  assert.deepEqual(introducedTables(s), ['Contoso_Baseline', 'contoso_risk']);
  for (const bad of [null, undefined, {}, { entities: {} }, { entities: 'x' }]) assert.deepEqual(introducedTables(bad), []);
});

test('privileges are read from persona jobs, persona additionalPrivileges and roleGrants[], by logical name', () => {
  const s = newAppSpec({ tables: ['contoso_ticket', 'contoso_note'] });
  s.personas = [persona(' Agent ', [{ entity: 'Contoso_Ticket', access: ['read', 'write'], scope: 'businessUnit' }], { additionalPrivileges: [{ entity: 'contoso_note', access: ['read'] }] })];
  s.roleGrants = [grant('Contoso PM - Viewer', 'contoso_note', ['read'], 'organization'), grant(GUID, 'contoso_ticket', ['append'])];
  const map = tablePrivileges(s);
  assert.deepEqual([...map.keys()].sort(), ['contoso_note', 'contoso_ticket']);
  assert.deepEqual(map.get('contoso_ticket'), [
    { via: 'persona', role: 'Agent', access: ['read', 'write'], scope: 'businessUnit' },
    { via: 'roleGrant', role: GUID, access: ['append'], scope: 'organization' },
  ]);
  assert.deepEqual(map.get('contoso_note'), [
    { via: 'persona', role: 'Agent', access: ['read'], scope: 'user' },
    { via: 'roleGrant', role: 'Contoso PM - Viewer', access: ['read'], scope: 'organization' },
  ]);
});

test('a privilege that grants nothing — no access, no table, not an object — is not a source', () => {
  const s = extensionSpec();
  s.personas = [{ persona: 'P', jobs: [{ name: 'j', privileges: [null, 'x', { entity: 'contoso_baseline' }, { entity: 'contoso_baseline', access: [] }, { entity: 5, access: ['read'] }, { access: ['read'] }] }], additionalPrivileges: 'x' }];
  s.roleGrants = [null, 'x', {}, { role: 'R' }, { role: 'R', privileges: 'x' }, { role: 'R', privileges: [{ entity: 'contoso_baseline', access: [] }] }];
  assert.equal(tablePrivileges(s).size, 0);
  assert.deepEqual(uncoveredTables(s), ['contoso_baseline']);
  assert.equal(tablePrivileges({ roleGrants: {} }).size, 0);
  assert.equal(tablePrivileges(null).size, 0);
});

test('an uncovered table is an introduced one that no source names, in the order the spec lists them', () => {
  const s = extensionSpec({ newTables: ['contoso_b', 'contoso_a', 'contoso_c'] });
  s.roleGrants = [grant('R', 'CONTOSO_A')];
  assert.deepEqual(uncoveredTables(s), ['contoso_b', 'contoso_c']);
  s.roleGrants.push({ role: 'S', privileges: [{ entity: 'contoso_b', access: ['read'] }, { entity: 'contoso_c', access: ['read'] }] });
  assert.deepEqual(uncoveredTables(s), []);
  assert.deepEqual(uncoveredTables(extensionSpec({ newTables: [] })), []);
});

test('the sentences the lint and the document share say the same thing in both', () => {
  const lint = require('../lib/spec-lint.js').lintAppSpec(extensionSpec());
  const gap = require('../write-app-spec-doc.js').designGaps(extensionSpec()).find((g) => /no access declared/.test(g));
  const flagged = lint.warnings.find((w) => /no access declared/.test(w));
  assert.ok(flagged && gap, 'both flag the table');
  assert.equal(gap, flagged, 'in the same words');
});

// --- the personas' share of who can open the app ------------------------------------------------------------------------------------------

const { personaAppAccess, appAccessModel, appAccessCondition } = access;
const ID_1 = '00000000-0000-4000-8000-000000000001';
const ID_2 = '00000000-0000-4000-8000-000000000002';
const ID_3 = '00000000-0000-4000-8000-000000000003';
const roleRows = (...rows) => ({ state: 'read', appUnique: 'contoso_pm', roles: rows.map(([roleId, name]) => ({ roleId, name, managed: false })) });

test('a persona gets the app unless its appAccess is false — the build\u2019s own rule — and is named by its trimmed name, once', () => {
  const s = newAppSpec();
  s.personas = [
    persona(' Agent ', []), persona('Planner', [], { appAccess: true }), persona('Reader', [], { appAccess: false }),
    persona('agent', []), persona('Odd', [], { appAccess: 'false' }),
    null, 'x', { persona: '  ' }, { jobs: [] },
  ];
  assert.deepEqual(personaAppAccess(s), { gets: ['Agent', 'Planner', 'Odd'], optedOut: ['Reader'] }, 'only a boolean false opts out, as in sdk-build.js: persona.appAccess !== false');
  for (const bad of [null, undefined, 'x', {}, { personas: {} }, { personas: 'x' }]) assert.deepEqual(personaAppAccess(bad), { gets: [], optedOut: [] });
});

test('the sentence on who can open the app says what a build does for the personas, and what it leaves, whether the spec has personas or not', () => {
  const marked = (spec) => { spec.app.uniqueName = 'contoso_support'; return spec; };
  const withPersonas = (...personas) => { const spec = newAppSpec(); spec.personas = personas; return spec; };
  // No personas: nothing is said of them.
  assert.match(appAccessCondition(newAppSpec()), /^If the app is new, it is associated with the System Administrator role only/);
  assert.doesNotMatch(appAccessCondition(newAppSpec()), /persona `/);
  // Personas that get the app, those that opt out, both: what a build does for them, then what it does for every other role.
  const gets = appAccessCondition(withPersonas(persona('Agent', [])));
  assert.match(gets, /^A build associates the app with the role of persona `Agent`\. Beyond that, a new app is associated with the System Administrator role only, and an existing app keeps the roles it has\.$/);
  assert.doesNotMatch(gets, /personas\[\] does that/, 'it has one');
  const out = appAccessCondition(withPersonas(persona('Reader', [], { appAccess: false })));
  assert.match(out, /^No persona gets the app: a build removes the app from the role of persona `Reader` \(`appAccess: false`\) if it has it\./);
  const both = appAccessCondition(withPersonas(persona('Agent', []), persona('Planner', []), persona('Reader', [], { appAccess: false })));
  assert.match(both, /^A build associates the app with the roles of personas `Agent` and `Planner`, and removes it from the role of persona `Reader` \(`appAccess: false`\) if it has it\./);
  // An app that carries a download's marks: the roles are left as they are, but for the personas'.
  assert.match(appAccessCondition(marked(withPersonas(persona('Agent', [])))), /A build associates the app with the role of persona `Agent`\. It carries app\.uniqueName, which a download writes, so it most likely edits an app that already exists — and a build changes the roles associated with an existing app only for its personas: who else can open the app is decided by the environment, not by this spec\.$/);
  assert.match(appAccessCondition(marked(newAppSpec())), /and a build leaves the roles associated with an existing app as they are: who can open the app is decided by the environment, not by this spec\.$/);
});

test('without an answer from the environment — or one that is not one — the model says so, and still says who gets the app', () => {
  const s = newAppSpec();
  s.personas = [persona('Agent', []), persona('Reader', [], { appAccess: false })];
  for (const answer of [undefined, null, 'x', 7, [], {}, { state: 'nonsense' }]) {
    assert.deepEqual(appAccessModel(s, answer), { state: 'unread', personas: { gets: ['Agent'], optedOut: ['Reader'] } }, JSON.stringify(answer));
  }
  assert.deepEqual(appAccessModel(s, { state: 'absent', appUnique: 'x' }), { state: 'absent', appUnique: 'x', personas: { gets: ['Agent'], optedOut: ['Reader'] } });
  assert.deepEqual(appAccessModel(s, { state: 'unreadable', appUnique: 'x', reason: 'HTTP 403' }), { state: 'unreadable', appUnique: 'x', reason: 'HTTP 403', personas: { gets: ['Agent'], optedOut: ['Reader'] } });
  assert.equal(appAccessModel(s, { state: 'unreadable' }).reason, 'unknown');
});

// --- which associated role a grant or a persona is --------------------------------------------------------------------------------------

test('a role a grant names by its id is that role; a role it names only by name is a candidate — never a certain match, and every candidate is listed', () => {
  const spec = extensionSpec();
  spec.roleGrants = [
    grant(ID_1, 'contoso_baseline'),
    { ...grant('Viewer', 'contoso_baseline'), businessUnitId: '11111111-1111-4111-8111-111111111111' },
  ];
  const model = appAccessModel(spec, roleRows([ID_1, 'Project Manager'], [ID_2, 'Viewer'], [ID_3, 'viewer'], ['00000000-0000-4000-8000-000000000004', 'Auditor']));
  assert.equal(model.state, 'read');
  assert.deepEqual(model.roles.map((r) => [r.name, r.sources]), [
    ['Project Manager', [{ kind: 'roleGrant', label: ID_1, by: 'id', certain: true }]],
    ['Viewer', [{ kind: 'roleGrant', label: 'Viewer', by: 'name', certain: false }]],
    ['viewer', [{ kind: 'roleGrant', label: 'Viewer', by: 'name', certain: false }]],
    ['Auditor', []],
  ]);
  assert.deepEqual(model.grants, [
    { label: ID_1, by: 'id', status: 'associated', candidates: [{ roleId: ID_1, name: 'Project Manager' }] },
    { label: 'Viewer', by: 'name', status: 'maybe', candidates: [{ roleId: ID_2, name: 'Viewer' }, { roleId: ID_3, name: 'viewer' }] },
  ]);
});

test('a grant by id never matches a role by its name, and a grant by name never matches by id: a role of that name in another business unit is not that role', () => {
  const spec = extensionSpec();
  spec.roleGrants = [grant(ID_1, 'contoso_baseline')];
  const model = appAccessModel(spec, roleRows([ID_2, 'Viewer']));
  assert.deepEqual(model.roles[0].sources, []);
  assert.deepEqual(model.grants, [{ label: ID_1, by: 'id', status: 'not-associated', candidates: [] }]);
  const byName = extensionSpec();
  byName.roleGrants = [grant('Auditor', 'contoso_baseline')];
  assert.deepEqual(appAccessModel(byName, roleRows([ID_2, 'Viewer'])).grants, [{ label: 'Auditor', by: 'name', status: 'not-associated', candidates: [] }]);
  assert.deepEqual(appAccessModel(byName, roleRows([ID_2, 'Auditor'])).grants.map((g) => g.status), ['maybe'], 'the id is no way to tell that grant\u2019s role from this one');
});

test('a persona is matched to an associated role by name only, so it is never a certain match, and what the build does to it follows the persona\u2019s appAccess', () => {
  const spec = newAppSpec();
  spec.personas = [persona('Agent', []), persona('Reader', [], { appAccess: false })];
  const model = appAccessModel(spec, roleRows([ID_1, 'AGENT'], [ID_2, 'reader'], [ID_3, 'Other']));
  assert.deepEqual(model.roles.map((r) => r.sources), [
    [{ kind: 'persona', label: 'Agent', getsApp: true, certain: false }],
    [{ kind: 'persona', label: 'Reader', getsApp: false, certain: false }],
    [],
  ]);
});

test('an answer that lists a role with no usable id is no answer: the model says it was not read, never that there are no roles', () => {
  for (const roles of ['x', [null], [{}], [{ name: 'Viewer' }], [{ roleId: 5, name: 'Viewer' }], [{ roleId: ID_1, name: 'Viewer' }, null]]) {
    const model = appAccessModel(extensionSpec(), { state: 'read', appUnique: 'contoso_pm', roles });
    assert.equal(model.state, 'unreadable', JSON.stringify(roles));
    assert.match(model.reason, /list of roles|names no role/, JSON.stringify(roles));
  }
  assert.deepEqual(appAccessModel(extensionSpec(), { state: 'read', appUnique: 'contoso_pm', roles: [] }).roles, [], 'a list with nothing in it is the one answer that says there are none');
});
