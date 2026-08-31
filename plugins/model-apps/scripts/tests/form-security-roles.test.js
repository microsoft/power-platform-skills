'use strict';
// `forms[].securityRoles` — offering a form to specific security roles. AB#6648526.
//
// This capability was documented in SKILL.md as **impossible through any API**, with detailed live
// evidence, and that documentation was correct about the platform and wrong about the conclusion.
// The roles are not a relationship — `systemform` reports
// `CanBeInManyToMany: { Value: false, CanBeChanged: false }`, declares no many-to-many relationships,
// and there is no `systemformrole` entity — so every `associateRecords` shape genuinely does fail.
// They live INSIDE `formxml`, as a `<DisplayConditions>` child of `<form>`, and the vendored SDK now
// writes them there through `setFormSecurityRoles`.
//
// Two things make this surface easy to get silently wrong, so both are pinned here:
//
//   1. ORDERING. Roles do not exist until the `security` phase (13th), and forms are built at the
//      `forms` phase (7th). Applying this in the forms phase would resolve every persona to nothing.
//   2. DIRECTION. A form with no `<DisplayConditions>` is offered to EVERY role. So declaring
//      `securityRoles` RESTRICTS a form. A typo that silently resolved to an empty role list would
//      hide the form from everyone — which is why an unresolvable persona halts rather than warns.
const test = require('node:test');
const assert = require('node:assert');

const { runSdkBuild } = require('../lib/sdk-build.js');
const { makeSimpleMockSdk } = require('./helpers/mock-sdk.js');

const ROLE_DISPATCHER = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const ROLE_TECH = 'tttttttt-tttt-tttt-tttt-tttttttttttt';

function specWithFormRoles(securityRoles, extra = {}) {
  return {
    solution: { uniqueName: 'FR', displayName: 'FR', publisherPrefix: 'new' },
    app: { name: 'FR App', description: 'd' },
    entities: [{
      schemaName: 'new_ticket', displayName: 'Ticket', pluralName: 'Tickets',
      primaryAttribute: { schemaName: 'new_subject', displayName: 'Subject' },
      columns: [{ schemaName: 'new_notes', displayName: 'Notes', type: 'Memo' }],
    }],
    forms: [{ entity: 'new_ticket', name: 'Main', formType: 'Main', ...(securityRoles ? { securityRoles } : {}) }],
    personas: [
      { persona: 'Dispatcher', jobs: [{ name: 'Assign', privileges: [{ entity: 'new_ticket', access: ['read'] }] }] },
      { persona: 'Technician', jobs: [{ name: 'Work', privileges: [{ entity: 'new_ticket', access: ['read'] }] }] },
    ],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'R', subAreas: [{ entity: 'new_ticket', title: 'Tickets' }] }] }] },
    ...extra,
  };
}

// The provisioning client the security phase talks to. It must be a FULL mock SDK, because the same
// client drives the forms phase in these tests; layering only the two calls under test on top keeps
// the recorder honest without stubbing away the machinery that produces the form id.
//
// `setFormSecurityRoles` is RECORDED rather than stubbed away, because "was it called, with what,
// and after which role existed" is the entire contract.
function provisionForRoles({ failSet } = {}) {
  const calls = [];
  const { sdk } = makeSimpleMockSdk();
  const provision = Object.create(sdk);
  // The shared mock answers EVERY queryRecords with a truthy row, which makes `resolveExistingFormId`
  // believe a form already exists and reconcile onto an id of `undefined` — every form then gets the
  // same non-id, and an assertion that two forms differ passes vacuously. Answer `systemform`
  // honestly so the forms phase takes the CREATE path and mints distinct ids.
  provision.queryRecords = async (entity) => {
    if (entity === 'solution') return [];
    if (entity === 'systemform') return [];
    return [{ publisherid: 'pub-1' }];
  };
  provision.createPersonaRole = async (roleSpec) => {
    const name = roleSpec && (roleSpec.name || roleSpec.persona || roleSpec.displayName);
    calls.push(['createPersonaRole', name]);
    const id = /Dispatcher/i.test(JSON.stringify(roleSpec)) ? ROLE_DISPATCHER : ROLE_TECH;
    return { roleId: id, reused: false, appliedPrivileges: [], assignedTeams: [], assignedUsers: [] };
  };
  provision.addSolutionComponent = async () => undefined;
  provision.setFormSecurityRoles = async (formId, opts) => {
    calls.push(['setFormSecurityRoles', formId, opts]);
    if (failSet) throw new Error('setFormSecurityRoles exploded');
  };
  return { calls, provision };
}

// Drive forms THEN security so the form id exists, exactly as a real build does.
async function build(spec, { failSet } = {}) {
  const { sdk } = makeSimpleMockSdk();
  const { provision, calls } = provisionForRoles({ failSet });
  const events = [];
  const res = await runSdkBuild(spec, {
    sdk, provisionSdk: provision, apply: true,
    phases: ['forms', 'security'], emit: (e) => events.push(e), warn: () => {},
  });
  return { res, calls, events };
}

test('a form offered to two personas resolves them to the roles this build created', async () => {
  const { res, calls } = await build(specWithFormRoles({ personas: ['Dispatcher', 'Technician'] }));
  assert.strictEqual(res.ok, true);

  const set = calls.find((c) => c[0] === 'setFormSecurityRoles');
  assert.ok(set, `setFormSecurityRoles must be called; calls: ${JSON.stringify(calls.map((c) => c[0]))}`);
  assert.deepStrictEqual(set[2], { roleIds: [ROLE_DISPATCHER, ROLE_TECH] });

  // The id must be the FORM's, not the entity's or the app's.
  assert.strictEqual(set[1], res.created.forms['new_ticket']);
});

test('role assignment runs AFTER the roles are created, never before', async () => {
  // The ordering bug this surface invites: applied in the forms phase, every persona resolves to
  // nothing and the form is offered to no one. Assert on call ORDER, which is the only thing that
  // distinguishes the correct implementation from the broken one.
  const { calls } = await build(specWithFormRoles({ personas: ['Dispatcher'] }));
  const firstRole = calls.findIndex((c) => c[0] === 'createPersonaRole');
  const set = calls.findIndex((c) => c[0] === 'setFormSecurityRoles');
  assert.ok(firstRole > -1 && set > -1, JSON.stringify(calls.map((c) => c[0])));
  assert.ok(set > firstRole, 'the form may only be assigned once the role it names exists');
});

test('everyone: true emits the Everyone shape and no role list', async () => {
  const { calls } = await build(specWithFormRoles({ everyone: true }));
  const set = calls.find((c) => c[0] === 'setFormSecurityRoles');
  assert.deepStrictEqual(set[2], { everyone: true });
  assert.strictEqual('roleIds' in set[2], false,
    'the platform models <Everyone /> as a REPLACEMENT for the role list, and the SDK rejects both together');
});

test('fallbackForm and order are sent only when the author set them', async () => {
  // The SDK PRESERVES both when omitted. Sending `undefined` would be indistinguishable from
  // "reset it" if that ever changes, so omission must stay omission.
  const bare = await build(specWithFormRoles({ personas: ['Dispatcher'] }));
  const bareOpts = bare.calls.find((c) => c[0] === 'setFormSecurityRoles')[2];
  assert.deepStrictEqual(Object.keys(bareOpts).sort(), ['roleIds']);

  const full = await build(specWithFormRoles({ personas: ['Dispatcher'], fallbackForm: true, order: 3 }));
  const fullOpts = full.calls.find((c) => c[0] === 'setFormSecurityRoles')[2];
  assert.deepStrictEqual(fullOpts, { roleIds: [ROLE_DISPATCHER], fallbackForm: true, order: 3 });

  // `false` and `0` must SURVIVE — they are meaningful values, not absence.
  const falsy = await build(specWithFormRoles({ personas: ['Dispatcher'], fallbackForm: false, order: 0 }));
  const falsyOpts = falsy.calls.find((c) => c[0] === 'setFormSecurityRoles')[2];
  assert.strictEqual(falsyOpts.fallbackForm, false);
  assert.strictEqual(falsyOpts.order, 0);
});

test('a persona the build did not create HALTS — it must never silently hide the form', async () => {
  // A form with no DisplayConditions is visible to every role, so an unresolved name that produced
  // an empty role list would REMOVE access rather than fail to add it. That is the one outcome this
  // surface must not reach quietly.
  await assert.rejects(
    () => build(specWithFormRoles({ personas: ['Dispatcher', 'Ghost'] })),
    (err) => /Ghost/.test(String(err.message)) && /personas\[\]/.test(String(err.message)),
    'the halt must name the offending persona and how to fix it');
});

test('a form without securityRoles is left alone entirely', async () => {
  const { calls } = await build(specWithFormRoles(null));
  assert.strictEqual(calls.some((c) => c[0] === 'setFormSecurityRoles'), false,
    'omitting securityRoles must not touch the form — every role can see it, which is the default');
});

test('a failure to assign roles HALTS the build', async () => {
  // Not a warning: the author asked for a restriction, and reporting success while the form stays
  // universally visible is a security-relevant lie.
  await assert.rejects(() => build(specWithFormRoles({ personas: ['Dispatcher'] }), { failSet: true }));
});

test('the dry-run plan lists form role assignment under security, not forms', async () => {
  const { sdk } = makeSimpleMockSdk();
  const events = [];
  const res = await runSdkBuild(specWithFormRoles({ personas: ['Dispatcher'] }), {
    sdk, apply: false, emit: (e) => events.push(e),
  });
  const item = res.plan.find((l) => /form roles for/.test(l));
  assert.ok(item, `the plan must mention it; plan: ${JSON.stringify(res.plan)}`);
  const ev = events.find((e) => /form roles for/.test(e.label || ''));
  assert.strictEqual(ev.phase, 'security',
    'planning it under `forms` would put it before the roles exist, which is the bug this ordering avoids');
});

test('a non-Main form is addressed by its own identity, not the entity default', async () => {
  // `created.forms` is keyed by ENTITY and holds only the Main form. A QuickCreate form annotated
  // with securityRoles must resolve to ITS id — binding to the Main form would restrict the wrong
  // form, and every structural assertion would still pass.
  const spec = specWithFormRoles(null);
  spec.forms = [
    { entity: 'new_ticket', name: 'Main', formType: 'Main' },
    { entity: 'new_ticket', name: 'Quick', formType: 'QuickCreate', securityRoles: { personas: ['Dispatcher'] } },
  ];
  const { res, calls } = await build(spec);
  const set = calls.find((c) => c[0] === 'setFormSecurityRoles');
  assert.ok(set, 'the QuickCreate form must still be assignable');
  assert.notStrictEqual(set[1], res.created.forms['new_ticket'],
    'it must NOT resolve to the entity Main form');
  assert.strictEqual(set[1], res.created.formIds['new_ticket|QuickCreate|Quick']);
});

// --- spec-gate validation -----------------------------------------------------------------------
//
// Every failure here is ACCESS-relevant, because the direction is counter-intuitive: a form with no
// assignment is offered to EVERY role, so a malformed or empty assignment REMOVES access rather than
// failing to add it. They are therefore hard errors, not warnings.

const { validateAppSpec } = require('../lib/app-spec.js');
const errorsFor = (securityRoles, mutate) => {
  const spec = specWithFormRoles(securityRoles);
  if (mutate) mutate(spec);
  return validateAppSpec(spec, { profile: 'plan' }).errors || [];
};

test('a well-formed assignment validates', () => {
  assert.deepStrictEqual(errorsFor({ personas: ['Dispatcher'] }), []);
  assert.deepStrictEqual(errorsFor({ everyone: true }), []);
  assert.deepStrictEqual(errorsFor({ personas: ['Dispatcher'], fallbackForm: true, order: 2 }), []);
});

test('a persona not declared in personas[] is caught at the GATE, not two minutes into a build', () => {
  const errs = errorsFor({ personas: ['Ghost'] });
  assert.ok(errs.some((e) => /'Ghost'/.test(e) && /not declared in personas\[\]/.test(e)),
    `expected a persona error, got ${JSON.stringify(errs)}`);
});

test('an EMPTY persona list is rejected — it would offer the form to nobody', () => {
  const errs = errorsFor({ personas: [] });
  assert.ok(errs.some((e) => /offer the form to NO role/.test(e)), JSON.stringify(errs));
});

test('everyone and personas together are rejected — the platform treats them as exclusive', () => {
  const errs = errorsFor({ everyone: true, personas: ['Dispatcher'] });
  assert.ok(errs.some((e) => /cannot set both/.test(e)), JSON.stringify(errs));
});

test('everyone: false is rejected, and the message names the way to actually undo a restriction', () => {
  // It looks like "restrict to nobody" and means nothing. The fix an author needs is
  // `everyone: true` — deleting the block does NOT undo a deployed restriction, because the build
  // only visits forms that declare `securityRoles`. Steering them to "just omit it" was wrong.
  const errs = errorsFor({ everyone: false });
  assert.ok(errs.some((e) => /does nothing/.test(e) && /"everyone": true/.test(e)), JSON.stringify(errs));
});

test('an assignment that says nothing at all is rejected', () => {
  const errs = errorsFor({ fallbackForm: true });
  assert.ok(errs.some((e) => /must say who the form is for/.test(e)), JSON.stringify(errs));
});

test('wrong types are rejected rather than coerced', () => {
  assert.ok(errorsFor(['Dispatcher']).some((e) => /securityRoles must be an object/.test(e)));
  assert.ok(errorsFor({ personas: 'Dispatcher' }).some((e) => /must be an array of persona names/.test(e)));
  assert.ok(errorsFor({ personas: ['Dispatcher'], fallbackForm: 'true' }).some((e) => /fallbackForm must be a boolean/.test(e)),
    'the string "true" is truthy in JS, so coercing it would hide the mistake');
  assert.ok(errorsFor({ personas: ['Dispatcher'], order: -1 }).some((e) => /non-negative integer/.test(e)));
  assert.ok(errorsFor({ personas: ['Dispatcher'], order: 1.5 }).some((e) => /non-negative integer/.test(e)));
});

test('an unknown key is reported instead of silently ignored', () => {
  // A typo like `roles` instead of `personas` would otherwise validate, build, and restrict nothing.
  const errs = errorsFor({ personas: ['Dispatcher'], roles: ['Dispatcher'] });
  assert.ok(errs.some((e) => /unknown key 'roles'/.test(e)), JSON.stringify(errs));
});

test('a duplicated persona is reported', () => {
  const errs = errorsFor({ personas: ['Dispatcher', 'dispatcher'] });
  assert.ok(errs.some((e) => /more than once/.test(e)), JSON.stringify(errs));
});

test('an AMBIGUOUS form identity is rejected rather than resolved by build order', () => {
  // Only QuickView forms are checked for a unique (entity, name); Main and Card may both be called
  // "Information" harmlessly. Harmless, that is, until one declares securityRoles — the build's
  // (entity, formType, name) map would keep whichever was built last, so the restriction would land
  // on the WRONG form while every structural check passed and the build reported success.
  const spec = specWithFormRoles(null);
  spec.forms = [
    { entity: 'new_ticket', name: 'Information', formType: 'Main', securityRoles: { personas: ['Dispatcher'] } },
    { entity: 'new_ticket', name: 'Information', formType: 'Main' },
  ];
  const errs = validateAppSpec(spec, { profile: 'plan' }).errors || [];
  assert.ok(errs.some((e) => /unambiguously/.test(e) && /Information/.test(e)),
    `expected an ambiguity error naming the form, got ${JSON.stringify(errs)}`);
});

test('two forms with the SAME name but different types are fine', () => {
  // The identity includes formType, so this pair is unambiguous and must not be rejected — that is
  // exactly the Main/Card "Information" case the QuickView-only check was written to permit.
  const spec = specWithFormRoles(null);
  spec.forms = [
    { entity: 'new_ticket', name: 'Information', formType: 'Main', securityRoles: { personas: ['Dispatcher'] } },
    { entity: 'new_ticket', name: 'Information', formType: 'QuickCreate' },
  ];
  assert.deepStrictEqual(validateAppSpec(spec, { profile: 'plan' }).errors || [], []);
});

test('a persona named in a DIFFERENT CASE resolves — the gate and the build must agree', async () => {
  // Found in review. The spec gate lower-cases both sides; the build looked the role up in a
  // case-SENSITIVE map keyed by the persona's own casing. So `personas: ["dispatcher"]` against a
  // declared "Dispatcher" passed validation and then threw inside the security phase — which is the
  // LAST thing a build does, after every table, column, form, view, chart, dashboard, page and role
  // already exists. Exactly the half-built outcome the business-rule skip was written to avoid, and
  // it falsified this surface's own promise that a bad name is caught at the gate.
  const spec = specWithFormRoles({ personas: ['dispatcher'] });   // declared as 'Dispatcher'
  assert.deepStrictEqual(validateAppSpec(spec, { profile: 'plan' }).errors || [], [],
    'the gate accepts it case-insensitively');

  const { res, calls } = await build(spec);
  assert.strictEqual(res.ok, true, 'so the build must too, rather than halting at the last phase');
  const set = calls.find((c) => c[0] === 'setFormSecurityRoles');
  assert.deepStrictEqual(set[2], { roleIds: [ROLE_DISPATCHER] });
});

test('surrounding whitespace in a persona name also resolves', async () => {
  // canonicalPersonaName trims, and the roles map is keyed by the trimmed name — so the lookup has
  // to trim too or this is the same bug wearing a different hat.
  const spec = specWithFormRoles({ personas: ['  Dispatcher  '] });
  const { res, calls } = await build(spec);
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(calls.find((c) => c[0] === 'setFormSecurityRoles')[2], { roleIds: [ROLE_DISPATCHER] });
});
