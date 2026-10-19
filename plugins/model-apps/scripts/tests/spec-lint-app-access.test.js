'use strict';
// The lint's access advice, for an app that is EXTENDED rather than built: a maker downloads an app that already has usable security roles
// and adds a table, leaving `personas[]` out on purpose (a persona's role is converged to the privileges the spec declares, so it is not
// how to add one table to somebody else's role) and planning the additive grants with `roleGrants[]`.
//
// Two things were wrong. "no personas[]" told that maker the app "opens only for system administrators" — a claim about the DEPLOYED app that a
// spec which authors no role cannot make — and the only way to silence it was to redefine the existing roles. And nothing said what is
// true of that spec: the new table is held by no role this spec grants, so users of the app's roles cannot use it until a grant is made.
//
// The checks are offline, so what they can know is what the spec carries: a download writes the app's unique name and the ids of its pages and
// dashboards, and a spec for a new app writes none of them. Nothing in a spec PROVES the app is new, so the advice for a spec with no such mark
// is worded as a condition.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lintAppSpec } = require('../lib/spec-lint.js');
const { lintSpec } = require('../lint-app-spec.js');
const { extensionSpec, newAppSpec, grant, persona } = require('./helpers/app-access-specs.js');

// Every way the plugin has put "this app is administrator-only" into a sentence.
const ADMIN_ONLY = /only for (system )?admin|opens only|administrator-only|admin-only|only administrators/i;

const noRoles = (r) => r.warnings.find((w) => /^no personas\[\]/.test(w));
const noAccess = (r) => r.warnings.filter((w) => /no access declared/.test(w));

test('an extension of an existing app that leaves personas[] empty is not told its app is administrator-only', () => {
  const r = lintAppSpec(extensionSpec());
  const w = noRoles(r);
  assert.ok(w, `still says the jobs are not recorded: ${JSON.stringify(r.warnings)}`);
  assert.doesNotMatch(w, ADMIN_ONLY, 'a spec that authors no role cannot say who can open the deployed app');
  assert.match(w, /authors no security role/, 'what IS true of the spec');
});

test('the advice for an extension says the app already exists and its roles are left as they are, and points at roleGrants[]', () => {
  const w = noRoles(lintAppSpec(extensionSpec()));
  assert.match(w, /already exists/);
  assert.match(w, /leaves the roles/);
  assert.match(w, /roleGrants\[\]/, 'the way to give an existing role a new table');
  assert.match(w, /app\.uniqueName/, 'names what the spec carries that says so');
});

test('a spec that carries nothing of a deployed app words the answer as a condition, never as a fact', () => {
  const r = lintAppSpec(newAppSpec());
  const w = noRoles(r);
  assert.ok(w, JSON.stringify(r.warnings));
  assert.match(w, /\bIf the app is new\b/, 'conditional');
  assert.match(w, /System Administrator role only/, 'what a new app is associated with');
  assert.match(w, /already exists, it keeps the roles it has/, 'and what an existing one keeps');
  assert.doesNotMatch(w, ADMIN_ONLY);
});

test('each mark a download writes is read as a mark of an existing app', () => {
  for (const [what, edit] of [
    ['app.uniqueName', (s) => { s.app.uniqueName = 'contoso_support'; }],
    ['pages[].pageId', (s) => { s.pages = [{ key: 'home', name: 'Home', pageId: '11111111-2222-3333-4444-555555555555', source: { kind: 'tsx', codeFile: 'home.tsx' } }]; }],
    ['dashboards[].dashboardId', (s) => { s.dashboards = [{ name: 'Overview', dashboardId: '11111111-2222-3333-4444-555555555555', tiles: [] }]; }],
  ]) {
    const s = newAppSpec();
    edit(s);
    const w = noRoles(lintAppSpec(s));
    assert.match(w, /already exists/, what);
    assert.match(w, new RegExp(what.replace(/[[\]]/g, '\\$&')), `${what} is named`);
  }
});

test('a new table that no persona and no roleGrants[] entry grants a privilege on is flagged', () => {
  const r = lintAppSpec(extensionSpec());
  const flagged = noAccess(r);
  assert.equal(flagged.length, 1, JSON.stringify(r.warnings));
  assert.match(flagged[0], /contoso_baseline/);
  assert.match(flagged[0], /roleGrants\[\]/, 'says how to give an existing role the table');
  assert.match(flagged[0], /cannot use it until a grant is made/);
  assert.doesNotMatch(flagged[0], /contoso_project/, 'a table the app already holds is not introduced by this spec');
  assert.equal(r.ok, true, 'advice, never an error');
  assert.deepEqual(r.errors, []);
});

test('a roleGrants[] entry that covers the new table satisfies the check, and the neutral note about the roles stays', () => {
  const s = extensionSpec();
  s.roleGrants = [grant('Contoso PM - Project Manager', 'contoso_baseline', ['create', 'read', 'write'])];
  const r = lintAppSpec(s);
  assert.deepEqual(noAccess(r), [], JSON.stringify(r.warnings));
  assert.ok(noRoles(r), 'the spec still records no jobs');
  assert.doesNotMatch(noRoles(r), ADMIN_ONLY);
});

test('a grant given by role id covers the table the same way', () => {
  const s = extensionSpec();
  s.roleGrants = [grant('33333333-3333-3333-3333-333333333333', 'contoso_baseline')];
  assert.deepEqual(noAccess(lintAppSpec(s)), []);
});

test('a persona privilege — on a job or in additionalPrivileges — covers the table too', () => {
  const onJob = newAppSpec();
  onJob.personas = [persona('Agent', [{ entity: 'contoso_ticket', access: ['read'], scope: 'user' }])];
  assert.deepEqual(noAccess(lintAppSpec(onJob)), []);

  const additional = newAppSpec();
  additional.personas = [persona('Agent', [{ entity: 'account', access: ['read'] }], { additionalPrivileges: [{ entity: 'contoso_ticket', access: ['read'] }] })];
  assert.deepEqual(noAccess(lintAppSpec(additional)), []);
});

test('personas that exist but leave a new table without a privilege still get that table flagged', () => {
  const s = newAppSpec({ tables: ['contoso_ticket', 'contoso_note'] });
  s.personas = [persona('Agent', [{ entity: 'contoso_ticket', access: ['read'] }])];
  const flagged = noAccess(lintAppSpec(s));
  assert.equal(flagged.length, 1);
  assert.match(flagged[0], /contoso_note/);
  assert.doesNotMatch(flagged[0], /contoso_ticket/);
});

test('one warning names every uncovered new table and none that is covered', () => {
  const s = extensionSpec({ newTables: ['contoso_baseline', 'contoso_risk', 'contoso_issue'] });
  s.roleGrants = [grant('Contoso PM - Viewer', 'contoso_risk')];
  const flagged = noAccess(lintAppSpec(s));
  assert.equal(flagged.length, 1, 'one warning for the spec, not one per table');
  assert.match(flagged[0], /contoso_baseline/);
  assert.match(flagged[0], /contoso_issue/);
  assert.doesNotMatch(flagged[0], /contoso_risk/);
});

test('the table is matched by its logical name in any letter case, and a grant of no access covers nothing', () => {
  const upper = extensionSpec();
  upper.entities[1].schemaName = 'Contoso_Baseline';
  upper.roleGrants = [grant('Contoso PM - Viewer', 'CONTOSO_BASELINE')];
  assert.deepEqual(noAccess(lintAppSpec(upper)), []);

  const empty = extensionSpec();
  empty.roleGrants = [{ role: 'Contoso PM - Viewer', privileges: [{ entity: 'contoso_baseline', access: [] }] }];
  assert.equal(noAccess(lintAppSpec(empty)).length, 1, 'an empty access[] grants nothing');
});

test('a table the app already holds is never flagged, whatever grants the spec has', () => {
  const s = extensionSpec({ newTables: [] });
  assert.deepEqual(noAccess(lintAppSpec(s)), []);
});

test('a spec whose personas cover every table gets none of the access advice — nothing it already passed now warns', () => {
  const s = newAppSpec();
  s.pages = [{ key: 'overview', name: 'Overview', source: { kind: 'intent' } }];
  s.personas = [persona('Agent', [{ entity: 'contoso_ticket', access: ['read', 'write'], scope: 'user' }])];
  const r = lintAppSpec(s);
  assert.deepEqual(noAccess(r), []);
  assert.equal(noRoles(r), undefined);
  assert.ok(!r.warnings.some((w) => ADMIN_ONLY.test(w)));
});

test('half-typed grants and tables do not stop the lint', () => {
  for (const edit of [
    (s) => { s.roleGrants = {}; },
    (s) => { s.roleGrants = [null, 'x', { role: 'R' }, { role: 'R', privileges: 'x' }, { role: 'R', privileges: [null, { entity: 5 }] }]; },
    (s) => { s.entities.push(null, 'x', { displayName: 'no schema name' }); },
    (s) => { s.personas = [{ persona: 'P', jobs: [{ name: 'j', privileges: [null, { entity: 'contoso_baseline' }] }], additionalPrivileges: 'x' }]; },
  ]) {
    const s = extensionSpec();
    edit(s);
    assert.doesNotThrow(() => lintAppSpec(s), JSON.stringify(s));
  }
});

test('lint-app-spec reports the same advice, tagged lint: and without failing the run', () => {
  const r = lintSpec(extensionSpec());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.ok(r.warnings.some((w) => /^lint: no personas\[\]/.test(w) && !ADMIN_ONLY.test(w)), JSON.stringify(r.warnings));
  assert.ok(r.warnings.some((w) => /^lint: .*contoso_baseline.*no access declared/.test(w)), JSON.stringify(r.warnings));
});
