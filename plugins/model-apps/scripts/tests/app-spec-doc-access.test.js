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
  assert.match(access, /\| Contoso PM - Project Manager \| may be the role `roleGrants\[\]` extends \(matched by name only\) \|/, 'the grant names the role, not its id');
  assert.match(access, /\| Contoso PM - Viewer \| not touched by this spec \|/);
  assert.match(access, /leaves these associations as they are/);
  assert.match(access, /privileges on the tables this spec introduces are declared separately/);
  assert.doesNotMatch(md, ADMIN_ONLY);
  // The two questions are two sections: the roles are in one, the privileges for the new table in the other.
  assert.ok(md.indexOf('### Access to the app') < md.indexOf('### Roles extended by'));
  assert.doesNotMatch(section(md, '### Roles extended by `roleGrants[]`'), /Contoso PM - Viewer/);
});

test('a role a grant names by its id is the role it extends: the one case the table says so without a "may"', () => {
  const spec = extensionSpec();
  spec.roleGrants = [grant('00000000-0000-4000-8000-000000000002', 'contoso_baseline')];
  const md = renderAppSpecDoc(spec, { envUrl: ENV, appAccess: appWithRoles('Viewer', 'Viewer') });
  const access = section(md, '### Access to the app');
  const rows = access.split('\n').filter((l) => /^\| Viewer \|/.test(l));
  assert.equal(rows.length, 2);
  assert.equal(rows.filter((l) => /\| extended by `roleGrants\[\]` \|/.test(l)).length, 1, 'only the role of that id, not the other that has its name');
  assert.equal(rows.filter((l) => /\| not touched by this spec \|/.test(l)).length, 1);
  const extended = section(md, '### Roles extended by `roleGrants[]`');
  assert.doesNotMatch(extended, /is named without a role id|is not among/);
});

test('a role a grant names only by name may be one of several: it is never named as the role the grant extends — roles are per business unit', () => {
  const BU = '11111111-1111-4111-8111-111111111111';
  const spec = extensionSpec();
  spec.roleGrants = [{ ...grant('Viewer', 'contoso_baseline'), businessUnitId: BU }];
  // One associated role has that name. The build resolves the grant's role by name AND business unit, and the answer carries no business unit.
  const one = renderAppSpecDoc(spec, { envUrl: ENV, appAccess: appWithRoles({ name: 'Viewer', roleId: '00000000-0000-4000-8000-000000000002' }) });
  const oneAccess = section(one, '### Access to the app');
  assert.doesNotMatch(oneAccess, /\| Viewer \| extended by `roleGrants\[\]` \|/);
  assert.match(oneAccess, /\| Viewer \| may be the role `roleGrants\[\]` extends \(matched by name only\) \|/);
  const oneNote = section(one, '### Roles extended by `roleGrants[]`');
  assert.match(oneNote, /Role "Viewer" is named without a role id: 1 associated role has that name \(id 00000000-0000-4000-8000-000000000002\), and roles are per business unit, so it may not be the role this grant extends\. Pin the role with `roleId` to be sure\./);
  assert.doesNotMatch(oneNote, /is not among the roles associated/, 'and it is not reported missing either');
  assert.deepEqual(designGaps(spec, { envUrl: ENV, appAccess: appWithRoles({ name: 'Viewer', roleId: '00000000-0000-4000-8000-000000000002' }) }).filter((g) => /Viewer/.test(g)), []);

  // Two associated roles have it: every candidate is listed, and neither is called the role the grant extends.
  const two = renderAppSpecDoc(spec, { envUrl: ENV, appAccess: appWithRoles('Viewer', 'Viewer') });
  const rows = section(two, '### Access to the app').split('\n').filter((l) => /^\| Viewer \|/.test(l));
  assert.equal(rows.length, 2);
  assert.ok(rows.every((l) => /may be the role `roleGrants\[\]` extends \(matched by name only\)/.test(l)), rows.join('\n'));
  assert.match(section(two, '### Roles extended by `roleGrants[]`'), /Role "Viewer" is named without a role id: 2 associated roles have that name \(ids 00000000-0000-4000-8000-000000000001, 00000000-0000-4000-8000-000000000002\), and roles are per business unit, so at most one of them is the role this grant extends\. Pin the role with `roleId` to be sure\./);
});

test('a persona is matched to an associated role by name only, so the role may be its own — and the build\u2019s action on it is said as what the persona asks', () => {
  const spec = newAppSpec();
  spec.personas = [persona('Agent', [{ entity: 'contoso_ticket', access: ['read'] }])];
  const access = section(renderAppSpecDoc(spec, { envUrl: ENV, appAccess: appWithRoles('agent', 'Contoso Auditor') }), '### Access to the app');
  assert.match(access, /\| agent \| may be the role of persona `Agent` \(matched by name\); if it is, a build keeps this association \|/, 'matched by name in any letter case');
  assert.match(access, /\| Contoso Auditor \| not touched by this spec \|/);
});

test('an existing app with no role associated with it is the one case the document may call administrator-only — it has read the environment', () => {
  const spec = extensionSpec();
  const md = renderAppSpecDoc(spec, { envUrl: ENV, appAccess: appWithRoles() });
  const access = section(md, '### Access to the app');
  assert.match(access, /no role is associated with it, so only administrators and other makers/);
  assert.match(access, /This spec associates none with it \(it authors no role\), so that does not change\./);
  const gaps = designGaps(spec, { envUrl: ENV, appAccess: appWithRoles() });
  assert.ok(gaps.some((g) => /exists in https:\/\/contoso\.crm\.dynamics\.com with no role associated with it/.test(g)), JSON.stringify(gaps));
});

test('an app the environment does not have yet is, with no persona that gets the app, one that only administrators can open once built', () => {
  const spec = newAppSpec();
  const appAccess = { state: 'absent', appUnique: 'contoso_support' };
  const access = section(renderAppSpecDoc(spec, { envUrl: ENV, appAccess }), '### Access to the app');
  assert.match(access, /does not exist in https:\/\/contoso\.crm\.dynamics\.com yet/);
  assert.match(access, /associates the System Administrator role with it/);
  assert.match(access, /users without a maker-level role cannot open it until a role is associated with it/);
  const gaps = designGaps(spec, { envUrl: ENV, appAccess });
  assert.ok(gaps.some((g) => /does not exist in https:\/\/contoso\.crm\.dynamics\.com yet/.test(g)), JSON.stringify(gaps));

  // With a persona that gets the app, the build associates its role, says which, and nothing needs warning of.
  spec.personas = [persona('Agent', [{ entity: 'contoso_ticket', access: ['read'] }])];
  assert.deepEqual(designGaps(spec, { envUrl: ENV, appAccess }).filter((g) => /does not exist/.test(g)), []);
  const withPersona = section(renderAppSpecDoc(spec, { envUrl: ENV, appAccess }), '### Access to the app');
  assert.match(withPersona, /and the role of persona `Agent`\./);
  assert.doesNotMatch(withPersona, /roles authored above/);
});

// --- a persona that opts out of the app, and a persona that gets it ------------------------------------------------------------------------
// A persona's role is associated with the app unless `appAccess: false` — which makes the build REMOVE the association (sdk-build.js, security phase). So what the document
// says of the roles a build associates follows the personas' `appAccess`, not whether there are personas at all.

const readerOptedOut = () => {
  const spec = newAppSpec();
  spec.personas = [persona('Reader', [{ entity: 'contoso_ticket', access: ['read'] }], { appAccess: false })];
  return spec;
};
const agentGetsApp = () => {
  const spec = newAppSpec();
  spec.personas = [persona('Agent', [{ entity: 'contoso_ticket', access: ['read'] }])];
  return spec;
};

test('a spec whose only persona opts out of the app associates no role with it: a new app is still administrator-only once built, and the document says so', () => {
  const spec = readerOptedOut();
  const absent = { state: 'absent', appUnique: 'contoso_support' };
  const md = renderAppSpecDoc(spec, { envUrl: ENV, appAccess: absent });
  assert.match(section(md, '## Security'), /_Data-only — the app is \*\*not\*\* granted to this role\._/);
  const access = section(md, '### Access to the app');
  assert.doesNotMatch(access, /roles authored above|and the role of persona/, 'the data-only persona gets no association');
  assert.match(access, /this spec associates no other role \(its personas are data-only: `appAccess: false`\), so users without a maker-level role cannot open it until a role is associated with it/);
  const gaps = designGaps(spec, { envUrl: ENV, appAccess: absent });
  assert.ok(gaps.some((g) => /does not exist in https:\/\/contoso\.crm\.dynamics\.com yet and this spec associates no role with it, so once built it opens only for administrators and other makers/.test(g)), JSON.stringify(gaps));
});

test('an existing app with no role associated with it, and a spec whose persona opts out, is still one nothing here associates a role with', () => {
  const spec = readerOptedOut();
  const md = renderAppSpecDoc(spec, { envUrl: ENV, appAccess: appWithRoles() });
  const access = section(md, '### Access to the app');
  assert.match(access, /no role is associated with it, so only administrators and other makers/);
  assert.doesNotMatch(access, /associates the app with the role/);
  assert.match(access, /This spec associates none with it \(its personas are data-only: `appAccess: false`\), so that does not change\./);
  const gaps = designGaps(spec, { envUrl: ENV, appAccess: appWithRoles() });
  assert.ok(gaps.some((g) => /with no role associated with it, so only administrators and other makers can open it, and this spec associates none with it/.test(g)), JSON.stringify(gaps));
});

test('a persona that gets the app is named where the document says what a build associates, and the gap that the app has no role is not raised', () => {
  const spec = agentGetsApp();
  const empty = section(renderAppSpecDoc(spec, { envUrl: ENV, appAccess: appWithRoles() }), '### Access to the app');
  assert.match(empty, /A build with this spec associates the app with the role of persona `Agent`\./);
  assert.deepEqual(designGaps(spec, { envUrl: ENV, appAccess: appWithRoles() }).filter((g) => /no role associated/.test(g)), []);
});

test('a failed read does not turn the words for a spec with no personas into the words for a spec that has some', () => {
  const unreadable = { state: 'unreadable', appUnique: 'contoso_support', reason: 'HTTP 403' };
  // A persona that gets the app: what the build does for it, not "personas[] does that" (it has one).
  const gets = section(renderAppSpecDoc(agentGetsApp(), { envUrl: ENV, appAccess: unreadable }), '### Access to the app');
  assert.match(gets, /A build associates the app with the role of persona `Agent`\./);
  assert.doesNotMatch(gets, /personas\[\] does that/);
  // A persona that opts out, on an app that exists: the build removes the association, so the roles are not simply "left as they are".
  const optedOut = readerOptedOut();
  optedOut.app.uniqueName = 'contoso_support';
  const removes = section(renderAppSpecDoc(optedOut, { envUrl: ENV, appAccess: unreadable }), '### Access to the app');
  assert.match(removes, /removes the app from the role of persona `Reader` \(`appAccess: false`\) if it has it/);
  assert.match(removes, /It carries app\.uniqueName/);
  assert.doesNotMatch(removes, /a build leaves the roles associated with an existing app as they are:/, 'the exception is part of the sentence');
  assert.match(removes, /changes the roles associated with an existing app only for its personas/);
});

test('with the roles read, the build\u2019s action on each persona is said by what the persona asks: it keeps the association of one that gets the app and removes that of one that opts out', () => {
  const spec = agentGetsApp();
  spec.personas.push(persona('Reader', [{ entity: 'contoso_ticket', access: ['read'] }], { appAccess: false }));
  const access = section(renderAppSpecDoc(spec, { envUrl: ENV, appAccess: appWithRoles('Agent', 'Reader', 'Contoso Auditor') }), '### Access to the app');
  assert.match(access, /\| Agent \| may be the role of persona `Agent` \(matched by name\); if it is, a build keeps this association \|/);
  assert.match(access, /\| Reader \| may be the role of persona `Reader` \(matched by name, `appAccess: false`\); if it is, a build removes this association \|/);
  assert.match(access, /A build with this spec associates the app with the role of persona `Agent`, removes it from the role of persona `Reader` \(`appAccess: false`\) where it is associated, and leaves every other association as it is\./);
  assert.match(access, /\| Contoso Auditor \| not touched by this spec \|/);
});

// --- every line of the access section follows the structured answer --------------------------------------------------------------------------
// The sentences are chosen from the personas' `appAccess` and from the read's state, in one place (lib/app-access.js appAccessModel): whichever way a spec and an
// answer combine, the document, the warnings and the model agree on who gets the app and on whether it is administrator-only.

test('across personas that get the app, personas that opt out, and every state of the read, the sentences agree with the model', () => {
  const { appAccessModel } = require('../lib/app-access.js');
  const personaSets = {
    none: () => [],
    gets: () => [persona('Agent', [{ entity: 'contoso_ticket', access: ['read'] }])],
    optedOut: () => [persona('Reader', [{ entity: 'contoso_ticket', access: ['read'] }], { appAccess: false })],
    both: () => [persona('Agent', [{ entity: 'contoso_ticket', access: ['read'] }]), persona('Reader', [{ entity: 'contoso_ticket', access: ['read'] }], { appAccess: false })],
  };
  const reads = {
    absent: { state: 'absent', appUnique: 'contoso_support' },
    empty: appWithRoles(),
    roles: appWithRoles('Contoso Auditor'),
    unreadable: { state: 'unreadable', appUnique: 'contoso_support', reason: 'HTTP 403' },
  };
  const CURRENTLY_ADMIN_ONLY = /no role is associated with it, so only administrators and other makers/;
  const STAYS_ADMIN_ONLY = /so that does not change\.|cannot open it until a role is associated with it\./;
  let combinations = 0;
  for (const [personaName, makePersonas] of Object.entries(personaSets)) {
    for (const [readName, appAccess] of Object.entries(reads)) {
      for (const marked of [false, true]) {
        const spec = newAppSpec();
        spec.personas = makePersonas();
        if (marked) spec.app.uniqueName = 'contoso_support';
        const what = `${personaName} / ${readName} / ${marked ? 'marked' : 'unmarked'}`;
        const model = appAccessModel(spec, appAccess);
        const md = renderAppSpecDoc(spec, { envUrl: ENV, appAccess });
        const access = section(md, '### Access to the app');
        const gaps = designGaps(spec, { envUrl: ENV, appAccess });
        const noneGet = model.personas.gets.length === 0;
        // Administrator-only stays so exactly when the environment shows the app has no role (or does not have it yet) and no persona gets the app.
        const staysAdminOnly = noneGet && (readName === 'absent' || readName === 'empty');
        combinations += 1;

        assert.deepEqual(model.personas.gets, personaName === 'gets' || personaName === 'both' ? ['Agent'] : [], what);
        assert.deepEqual(model.personas.optedOut, personaName === 'optedOut' || personaName === 'both' ? ['Reader'] : [], what);
        assert.equal(CURRENTLY_ADMIN_ONLY.test(access), readName === 'empty', `the document says the app has no role only when it was read to have none: ${what}\n${access}`);
        assert.equal(STAYS_ADMIN_ONLY.test(access) && readName !== 'unreadable', staysAdminOnly, `the document says it stays administrator-only only when no persona gets it: ${what}\n${access}`);
        assert.equal(gaps.some((g) => /opens only for administrators and other makers|only administrators and other makers can open it/.test(g)), staysAdminOnly, `the warnings: ${what}\n${gaps.join('\n')}`);
        // Every persona that gets the app is named where a build's associations are said; none of those that opt out is.
        for (const name of model.personas.gets) assert.match(access, new RegExp(`the role of persona \`${name}\``), `${what}: ${name} gets the app`);
        if (noneGet) assert.doesNotMatch(access, /associates the app with the role|and the role of persona/, `${what}: no persona gets the app`);
        // Where a build could remove an association — the app has roles, or is not known — the persona that opts out is named with what the build does.
        if (readName === 'roles' || readName === 'unreadable') {
          for (const name of model.personas.optedOut) assert.match(access, new RegExp(`removes (it|the app) from the role of persona \`${name}\` \\(\`appAccess: false\`\\)`), `${what}: ${name} opts out`);
        }
        if (staysAdminOnly && model.personas.optedOut.length) assert.match(access, /its personas are data-only: `appAccess: false`/, what);
        assert.doesNotMatch(access, /roles authored above/, what);
        // A failed read states nothing about the roles, whatever the spec holds.
        if (readName === 'unreadable') {
          assert.match(access, /could not be read from https:\/\/contoso\.crm\.dynamics\.com \(HTTP 403\), so who can open it was not checked/, what);
          assert.ok(gaps.some((g) => /who can open it was not checked/.test(g)), what);
        }
      }
    }
  }
  assert.equal(combinations, 32);
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

// --- a roleGrants[] entry the build refuses -------------------------------------------------------------------------------------------

// An entry that names its role twice (`role` and `roleId`), or not at all, is refused by the gate a build and lint-app-spec.js run. The
// document used to show it as a grant the build would make; it now says what lint says, in lint's words, and lists none of its privileges.
test('a roleGrants[] entry the build refuses is refused in the document and its warnings in the words lint uses, and nothing of it is shown as granted', () => {
  const { lintSpec } = require('../lint-app-spec.js');
  const spec = extensionSpec();
  spec.roleGrants = [
    grant('Contoso PM - Viewer', 'contoso_baseline'),
    { role: 'Contoso PM - Project Manager', roleId: '33333333-3333-3333-3333-333333333333', privileges: [{ entity: 'contoso_baseline', access: ['write'], scope: 'organization' }] },
    { privileges: [{ entity: 'contoso_baseline', access: ['delete'], scope: 'organization' }] },
  ];
  const refusals = lintSpec(spec).errors.filter((e) => /^schema: roleGrants\[[12]\]/.test(e)).map((e) => e.replace(/^schema: /, ''));
  assert.deepEqual(refusals, [
    "roleGrants[1] (role \"Contoso PM - Project Manager\"): set either 'role' (the existing role's display name) or 'roleId' (its GUID), not both — they can disagree and only one can be honoured",
    "roleGrants[2]: name the existing role to extend — set 'role' (display name) or 'roleId' (GUID)",
  ]);

  const gaps = designGaps(spec);
  for (const refusal of refusals) assert.ok(gaps.includes(refusal), `the warnings say what lint says: ${refusal}\n${JSON.stringify(gaps)}`);

  const extended = section(renderAppSpecDoc(spec), '### Roles extended by `roleGrants[]`');
  for (const refusal of refusals) assert.ok(extended.includes(`> ✗ ${refusal}`), `the document says what lint says: ${refusal}\n${extended}`);
  assert.match(extended, /\| Contoso PM - Viewer \| contoso_baseline \| read \| organization \|/, 'the entry the build makes is listed as before');
  assert.doesNotMatch(extended, /\| (Contoso PM - Project Manager|33333333-3333-3333-3333-333333333333|) \| contoso_baseline \|/, 'no row of a refused entry');
  assert.doesNotMatch(extended, /\| (write|delete) \|/);

  // Read against the environment, a refused entry names no role a build would extend: it is not matched to the app's roles either.
  const appAccess = appWithRoles('Contoso PM - Viewer');
  const read = section(renderAppSpecDoc(spec, { envUrl: ENV, appAccess }), '### Roles extended by `roleGrants[]`');
  assert.doesNotMatch(read, /Role "(Contoso PM - Project Manager|33333333-3333-3333-3333-333333333333)"/);
  assert.deepEqual(designGaps(spec, { envUrl: ENV, appAccess }).filter((g) => /is not among the roles/.test(g)), []);

  // A spec whose every entry names one role says nothing of the kind.
  const valid = extensionSpec();
  valid.roleGrants = [grant('Contoso PM - Viewer', 'contoso_baseline')];
  assert.doesNotMatch(renderAppSpecDoc(valid), /> ✗ /);
  assert.deepEqual(designGaps(valid).filter((g) => /^roleGrants\[/.test(g)), []);

  // The command still writes the document and exits 0 — the lint gate is what refuses the spec — and echoes the refusals.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appdoc-refused-grant-'));
  try {
    const specPath = path.join(dir, 'app-spec.json');
    fs.writeFileSync(specPath, JSON.stringify(spec), 'utf8');
    const out = JSON.parse(execFileSync(process.execPath, [CLI, '--spec', `@${specPath}`], { encoding: 'utf8' }));
    assert.equal(out.ok, true);
    for (const refusal of refusals) assert.ok(out.warnings.includes(refusal), JSON.stringify(out.warnings));
    assert.ok(fs.readFileSync(out.docPath, 'utf8').includes(`> ✗ ${refusals[0]}`));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
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
