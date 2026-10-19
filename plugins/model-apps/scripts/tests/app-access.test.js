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
