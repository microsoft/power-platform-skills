'use strict';
// The design document and its design-gap warnings, for the same two situations the lint is told apart by (spec-lint-app-access.test.js): a
// downloaded app extended with a new table while `personas[]` is left empty on purpose, and a spec for an app that does not exist yet.
//
// The document used to say, for every spec with no personas, that the app "will open only for system administrators". Who can open a DEPLOYED app
// is decided by the roles associated with it, which a spec that authors no role does not change — so the document now says what the spec
// authors, keeps two questions apart (who can open the APP; who can use the TABLES the spec introduces), and — when the environment is read with
// --env — says what the environment holds.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { renderAppSpecDoc } = require('../lib/app-spec-doc.js');
const { designGaps } = require('../write-app-spec-doc.js');
const { extensionSpec, newAppSpec, grant, persona, appWithRoles } = require('./helpers/app-access-specs.js');

const CLI = path.join(__dirname, '..', 'write-app-spec-doc.js');
const ENV = 'https://contoso.crm.dynamics.com';
const ADMIN_ONLY = /only for (system )?admin|opens only|administrator-only|admin-only|only administrators/i;

// The text between a heading and the next heading of the same or a higher level, or null when the document has no such heading.
function findSection(md, heading) {
  const level = heading.match(/^#+/)[0].length;
  const start = md.indexOf(`\n${heading}\n`);
  if (start === -1) return null;
  const rest = md.slice(start + heading.length + 2);
  const end = rest.search(new RegExp(`\\n#{1,${level}} `));
  return end === -1 ? rest : rest.slice(0, end);
}

// The same, for a section the document must have: a missing one fails here, with the document, and not as a match against null.
function section(md, heading) {
  const found = findSection(md, heading);
  assert.notEqual(found, null, `the document has no "${heading}" section:\n${md}`);
  return found;
}

// --- what the document says about a spec that authors no role -------------------------------------------------------------------------------

test('the no-personas callout does not say an extension of an existing app opens only for administrators', () => {
  const md = renderAppSpecDoc(extensionSpec());
  const jobs = section(md, '## Jobs to be done');
  assert.match(jobs, /> ⚠ No `personas\[\]` were captured/, 'still says no jobs were recorded');
  assert.match(jobs, /authors no security role/);
  assert.doesNotMatch(md, ADMIN_ONLY, 'nowhere in the document');
});

test('a spec that authors no role gets a Security section that says so and says what a new or an existing app does', () => {
  const md = renderAppSpecDoc(extensionSpec());
  assert.match(section(md, '## Security'), /This spec authors no security role/, 'the section is there although there are no personas');
  const access = section(md, '### Access to the app');
  assert.match(access, /already exists/);
  assert.match(access, /not by this spec/);
  assert.match(access, /--env/, 'says how to read the roles the app has');

  const fresh = renderAppSpecDoc(newAppSpec());
  assert.match(section(fresh, '### Access to the app'), /If the app is new, it is associated with the System Administrator role only/);
  assert.match(section(fresh, '### Access to the app'), /if it already exists, it keeps the roles it has/);
});

test('the design gap for no jobs says the spec authors no role, not that the app is administrator-only', () => {
  for (const spec of [extensionSpec(), newAppSpec()]) {
    const gaps = designGaps(spec);
    const noJobs = gaps.find((g) => /no jobs-to-be-done captured/.test(g));
    assert.ok(noJobs, JSON.stringify(gaps));
    assert.doesNotMatch(noJobs, ADMIN_ONLY);
    assert.match(noJobs, /authors no security role/);
  }
});

// --- the tables the spec introduces -------------------------------------------------------------------------------------------------

test('a new table nothing grants is a design gap and is called out in the document', () => {
  const spec = extensionSpec();
  const gaps = designGaps(spec);
  const flagged = gaps.filter((g) => /no access declared/.test(g));
  assert.equal(flagged.length, 1, JSON.stringify(gaps));
  assert.match(flagged[0], /contoso_baseline/);
  assert.match(flagged[0], /cannot use it until a grant is made/);

  const md = renderAppSpecDoc(spec);
  const callout = section(md, '### Tables with no access declared');
  assert.ok(callout, 'a sub-heading of the Security section');
  assert.match(callout, /> ⚠ `contoso_baseline` is introduced by this spec/);
  assert.match(callout, /roleGrants\[\]/);
  assert.doesNotMatch(callout, /contoso_project/, 'a table the app already holds is not introduced by this spec');
});

test('a roleGrants[] entry that covers the new table clears the gap, and the extended role and its privileges are in the document', () => {
  const spec = extensionSpec();
  spec.roleGrants = [grant('Contoso PM - Project Manager', 'contoso_baseline', ['create', 'read', 'write'], 'organization')];
  assert.deepEqual(designGaps(spec).filter((g) => /no access declared/.test(g)), []);

  const md = renderAppSpecDoc(spec);
  assert.equal(findSection(md, '### Tables with no access declared'), null);
  const extended = section(md, '### Roles extended by `roleGrants[]`');
  assert.ok(extended);
  assert.match(extended, /ADDS the privileges below and removes none/);
  assert.match(extended, /does not associate the role with the app/);
  assert.match(extended, /\| Contoso PM - Project Manager \| contoso_baseline \| create, read, write \| organization \|/);
});

test('a grant given by role id is shown by its id, and a split of scopes stays two rows', () => {
  const spec = extensionSpec();
  spec.roleGrants = [{
    roleId: '33333333-3333-3333-3333-333333333333',
    privileges: [
      { entity: 'contoso_baseline', access: ['read'], scope: 'organization' },
      { entity: 'contoso_baseline', access: ['write'], scope: 'user' },
    ],
  }];
  const extended = section(renderAppSpecDoc(spec), '### Roles extended by `roleGrants[]`');
  assert.match(extended, /\| 33333333-3333-3333-3333-333333333333 \| contoso_baseline \| read \| organization \|/);
  assert.match(extended, /\| 33333333-3333-3333-3333-333333333333 \| contoso_baseline \| write \| user \|/);
});

test('personas that cover every table leave the Security section as it was: no new sub-section', () => {
  const spec = newAppSpec();
  spec.pages = [{ key: 'overview', name: 'Overview', source: { kind: 'intent' } }];
  spec.personas = [persona('Agent', [{ entity: 'contoso_ticket', access: ['read', 'write'], scope: 'user' }])];
  const md = renderAppSpecDoc(spec);
  const security = section(md, '## Security');
  assert.match(security, /### Role: Agent/);
  assert.doesNotMatch(security, /### Access to the app/);
  assert.doesNotMatch(security, /### Tables with no access declared/);
  assert.doesNotMatch(security, /### Roles extended by/);
  assert.deepEqual(designGaps(spec).filter((g) => /access|role/i.test(g)), []);
});

test('personas that leave one table without a privilege get that table called out beside the roles they author', () => {
  const spec = newAppSpec({ tables: ['contoso_ticket', 'contoso_note'] });
  spec.personas = [persona('Agent', [{ entity: 'contoso_ticket', access: ['read'] }])];
  const security = section(renderAppSpecDoc(spec), '## Security');
  assert.match(security, /### Role: Agent/);
  assert.match(section(renderAppSpecDoc(spec), '### Tables with no access declared'), /`contoso_note`/);
  assert.equal(designGaps(spec).filter((g) => /no access declared/.test(g)).length, 1);
});

// --- what the environment says (--env) ------------------------------------------------------------------------------------------------

test('with a read of the environment, the roles associated with the app are listed apart from the privileges on the new tables', () => {
  const spec = extensionSpec();
  spec.roleGrants = [grant('Contoso PM - Project Manager', 'contoso_baseline')];
  const md = renderAppSpecDoc(spec, { envUrl: ENV, appAccess: appWithRoles('Contoso PM - Project Manager', 'Contoso PM - Viewer') });
  const access = section(md, '### Access to the app');
  assert.ok(access);
  assert.match(access, /The app `contoso_pm` already exists in https:\/\/contoso\.crm\.dynamics\.com and these roles are associated with it/);
  assert.match(access, /\| Contoso PM - Project Manager \| extended by `roleGrants\[\]` \|/);
  assert.match(access, /\| Contoso PM - Viewer \| not touched by this spec \|/);
  assert.match(access, /leaves these associations as they are/);
  assert.match(access, /privileges on the tables this spec introduces are declared separately/);
  assert.doesNotMatch(md, ADMIN_ONLY);
  // The two questions are two sections: the roles are in one, the privileges for the new table in the other.
  assert.ok(md.indexOf('### Access to the app') < md.indexOf('### Roles extended by'));
  assert.doesNotMatch(section(md, '### Roles extended by `roleGrants[]`'), /Contoso PM - Viewer/);
});

test('a persona authored by the spec is marked as such among the roles the app has', () => {
  const spec = newAppSpec();
  spec.personas = [persona('Agent', [{ entity: 'contoso_ticket', access: ['read'] }])];
  const access = section(renderAppSpecDoc(spec, { envUrl: ENV, appAccess: appWithRoles('agent', 'Contoso Auditor') }), '### Access to the app');
  assert.match(access, /\| agent \| persona \(authored by this spec\) \|/, 'matched by name in any letter case');
  assert.match(access, /\| Contoso Auditor \| not touched by this spec \|/);
});

test('an existing app with no role associated with it is the one case the document may call administrator-only — it has read the environment', () => {
  const spec = extensionSpec();
  const md = renderAppSpecDoc(spec, { envUrl: ENV, appAccess: appWithRoles() });
  const access = section(md, '### Access to the app');
  assert.match(access, /no role is associated with it, so only administrators and other makers/);
  assert.match(access, /This spec authors no role to change that/);
  const gaps = designGaps(spec, { envUrl: ENV, appAccess: appWithRoles() });
  assert.ok(gaps.some((g) => /exists in https:\/\/contoso\.crm\.dynamics\.com with no role associated with it/.test(g)), JSON.stringify(gaps));
});

test('an app the environment does not have yet is, with no personas, one that only administrators can open once built', () => {
  const spec = newAppSpec();
  const appAccess = { state: 'absent', appUnique: 'contoso_support' };
  const access = section(renderAppSpecDoc(spec, { envUrl: ENV, appAccess }), '### Access to the app');
  assert.match(access, /does not exist in https:\/\/contoso\.crm\.dynamics\.com yet/);
  assert.match(access, /associates the System Administrator role with it/);
  assert.match(access, /users without a maker-level role cannot open it until a role is associated with it/);
  const gaps = designGaps(spec, { envUrl: ENV, appAccess });
  assert.ok(gaps.some((g) => /does not exist in https:\/\/contoso\.crm\.dynamics\.com yet/.test(g)), JSON.stringify(gaps));

  // With a persona that gets the app, the build associates its role, and nothing needs saying.
  spec.personas = [persona('Agent', [{ entity: 'contoso_ticket', access: ['read'] }])];
  assert.deepEqual(designGaps(spec, { envUrl: ENV, appAccess }).filter((g) => /does not exist/.test(g)), []);
  assert.match(section(renderAppSpecDoc(spec, { envUrl: ENV, appAccess }), '### Access to the app'), /and the roles authored above/);
});

test('a read that failed is said to be unchecked, in the document and in the warnings, and it states nothing about the roles', () => {
  const spec = extensionSpec();
  const appAccess = { state: 'unreadable', appUnique: 'contoso_pm', reason: 'HTTP 403' };
  const md = renderAppSpecDoc(spec, { envUrl: ENV, appAccess });
  const access = section(md, '### Access to the app');
  assert.match(access, /> ⚠ The roles associated with the app could not be read from https:\/\/contoso\.crm\.dynamics\.com \(HTTP 403\), so who can open it was not checked/);
  assert.match(access, /already exists/, 'falls back to what the spec itself can say');
  assert.doesNotMatch(md, ADMIN_ONLY);
  const gaps = designGaps(spec, { envUrl: ENV, appAccess });
  assert.ok(gaps.some((g) => /could not be read from https:\/\/contoso\.crm\.dynamics\.com \(HTTP 403\) — who can open it was not checked/.test(g)), JSON.stringify(gaps));
});

test('a roleGrants[] role the app does not have is named: its users get the privileges but may not be able to open the app', () => {
  const spec = extensionSpec();
  spec.roleGrants = [
    grant('Contoso PM - Project Manager', 'contoso_baseline'),
    grant('Contoso PM - Auditor', 'contoso_baseline'),
    grant('00000000-0000-4000-8000-000000000002', 'contoso_baseline'),
    grant('99999999-9999-4999-8999-999999999999', 'contoso_baseline'),
  ];
  // The grants are one per role in a valid spec; this checks the cross-reading, not the validator.
  const appAccess = appWithRoles('contoso pm - project manager', 'Contoso PM - Viewer');
  const md = renderAppSpecDoc(spec, { envUrl: ENV, appAccess });
  const extended = section(md, '### Roles extended by `roleGrants[]`');
  assert.match(extended, /> ⚠ Role "Contoso PM - Auditor" is not among the roles associated with the app/);
  assert.match(extended, /> ⚠ Role "99999999-9999-4999-8999-999999999999" is not among the roles associated with the app/);
  assert.doesNotMatch(extended, /Role "Contoso PM - Project Manager" is not among/, 'matched by name in any letter case');
  assert.doesNotMatch(extended, /Role "00000000-0000-4000-8000-000000000002" is not among/, 'matched by id');
  const gaps = designGaps(spec, { envUrl: ENV, appAccess });
  assert.equal(gaps.filter((g) => /is not among the roles associated with app 'contoso_pm'/.test(g)).length, 2, JSON.stringify(gaps));
  // Offline there is nothing to compare with, so nothing is said.
  assert.deepEqual(designGaps(spec).filter((g) => /is not among the roles/.test(g)), []);
});

test('a malformed discovery answer or spec renders instead of throwing', () => {
  for (const appAccess of [null, {}, { state: 'read' }, { state: 'read', roles: 'x' }, { state: 'read', roles: [null, {}, { name: 5 }] }, { state: 'nonsense' }]) {
    assert.doesNotThrow(() => renderAppSpecDoc(extensionSpec(), { envUrl: ENV, appAccess }), JSON.stringify(appAccess));
    assert.doesNotThrow(() => designGaps(extensionSpec(), { envUrl: ENV, appAccess }), JSON.stringify(appAccess));
  }
  for (const spec of [{ roleGrants: {} }, { roleGrants: [null, 'x'] }, { entities: [null, 'x', {}] }, { entities: {}, roleGrants: [{ role: 'R', privileges: 'x' }] }]) {
    assert.doesNotThrow(() => renderAppSpecDoc(spec, { appAccess: appWithRoles('R') }), JSON.stringify(spec));
    assert.doesNotThrow(() => designGaps(spec, { appAccess: appWithRoles('R') }), JSON.stringify(spec));
  }
});

// --- the command, offline ---------------------------------------------------------------------------------------------------------------

test('the command with no --env makes the same findings and reads no environment', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appdoc-access-'));
  try {
    const specPath = path.join(dir, 'app-spec.json');
    fs.writeFileSync(specPath, JSON.stringify(extensionSpec()), 'utf8');
    const out = JSON.parse(execFileSync(process.execPath, [CLI, '--spec', `@${specPath}`], { encoding: 'utf8' }));
    assert.equal(out.ok, true);
    assert.ok(out.warnings.some((w) => /no jobs-to-be-done captured/.test(w) && !ADMIN_ONLY.test(w)), JSON.stringify(out.warnings));
    assert.ok(out.warnings.some((w) => /contoso_baseline.*no access declared/.test(w)), JSON.stringify(out.warnings));
    const md = fs.readFileSync(out.docPath, 'utf8');
    assert.doesNotMatch(md, ADMIN_ONLY);
    assert.match(md, /### Tables with no access declared/);
    assert.match(md, /The roles associated with the app were not read: pass `--env <envUrl>` to read them\./);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
