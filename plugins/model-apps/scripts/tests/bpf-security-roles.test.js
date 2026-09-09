'use strict';
// Two things that came out of the same live-verification session, kept together because the second
// is what made the first testable:
//
//   1. #513 — Business Process Flow security-role grants.
//   2. The table existence probe defect (AB#6686428): the plugin's `findTables` idempotency probe
//      silently dropped every non-base-language label on the real build path. See the dedicated
//      section below; the localized-label surface itself is tested in localized-labels.test.js.
//
// The issue asked for live measurement BEFORE designing the surface ("assume the role path has its
// own such surprise"). It had two, and both shaped what is implemented:
//
//   1. The backing table's logical name is EXACTLY `bpfUniqueName(flow.name)` — the derivation this
//      repo already duplicates for its collision check. The issue expected it to need resolving from
//      the deployed workflow's `uniquename`; measured, they are the same string, so the grant needs
//      no id plumbing and can be planned before the flow exists.
//   2. The backing table is ORGANIZATION-OWNED and every privilege reports CanBeGlobal only
//      (Local/Deep/Basic all false). So there is no `scope` to author.
//
// Measured on a live org, on a flow named "Probe Flow 217190":
//   backing table new_probeflow217190  ownership=OrganizationOwned  isCustom=true
//   privileges Create(G) Read(G) Write(G) Delete(G) Append(G) AppendTo(G)
//   addEntityPrivilegesToRole(...) -> role held prvReadnew_probeflow217190 afterwards (was false)
const { test } = require('node:test');
const assert = require('node:assert');
const { validateAppSpec, bpfUniqueName, BPF_ROLE_ACCESS } = require('../lib/app-spec.js');
const { planFor, runSdkBuild } = require('../lib/sdk-build.js');

const PERSONA = { persona: 'Dispatcher', jobs: [{ name: 'Dispatch', privileges: [{ entity: 'contoso_ticket', access: ['read'] }] }] };
const FLOW = {
  name: 'Ticket Handling',
  entity: 'contoso_ticket',
  status: 'Active',
  stages: [{ name: 'Triage', steps: [{ name: 'Notes', field: 'contoso_notes' }] }],
};

function base(flowExtra = {}) {
  return {
    schemaVersion: 2,
    solution: { uniqueName: 'contoso', publisherPrefix: 'contoso' },
    app: { name: 'Contoso' },
    entities: [{ schemaName: 'contoso_ticket', displayName: 'Ticket', primaryAttribute: { schemaName: 'contoso_name' }, columns: [{ schemaName: 'contoso_notes', type: 'Text' }] }],
    personas: [PERSONA],
    businessProcessFlows: [{ ...FLOW, ...flowExtra }],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Main', subAreas: [] }] }] },
  };
}
const errorsFor = (flowExtra) => validateAppSpec(base(flowExtra), { profile: 'plan' }).errors || [];

// --- shape ----------------------------------------------------------------------------------------

test('#513 a flow may name the personas that can run it', () => {
  const s = base({ securityRoles: { personas: ['Dispatcher'] } });
  const r = validateAppSpec(s, { profile: 'deploy' });
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});

test('#513 absent stays valid — the block is optional', () => {
  assert.strictEqual(validateAppSpec(base(), { profile: 'deploy' }).ok, true);
});

test('#513 an unknown persona is rejected, like forms[].securityRoles', () => {
  assert.ok(errorsFor({ securityRoles: { personas: ['Nobody'] } }).some((e) => /is not declared in personas\[\]/.test(e)));
});

test('#513 a duplicate persona is rejected', () => {
  assert.ok(errorsFor({ securityRoles: { personas: ['Dispatcher', 'dispatcher'] } }).some((e) => /more than once/.test(e)));
});

test('#513 the FORM-only knobs are rejected BY NAME, explaining why', () => {
  // `everyone` / `fallbackForm` / `order` are formxml concepts. A flow's access is a privilege on a
  // table, so there is no <Everyone /> equivalent and no ordering — saying so is the whole point,
  // because the author reasonably expects one idiom to work everywhere.
  for (const k of ['everyone', 'fallbackForm', 'order']) {
    const errs = errorsFor({ securityRoles: { personas: ['Dispatcher'], [k]: true } });
    const hit = errs.find((e) => new RegExp(`securityRoles has unknown key '${k}'`).test(e));
    assert.ok(hit, `${k}: ${JSON.stringify(errs)}`);
    assert.match(hit, /PRIVILEGE on its backing table/);
  }
});

test('#513 an EMPTY personas[] is rejected — unlike a form, a flow defaults to nobody', () => {
  // A form with no assignment is offered to EVERY role, so an empty list there is a narrowing. A
  // flow's backing table grants to nobody by default, so an empty list is a request that cannot be
  // satisfied — silently granting nothing would leave the flow unusable with a green build.
  const errs = errorsFor({ securityRoles: { personas: [] } });
  const hit = errs.find((e) => /securityRoles.personas is empty/.test(e));
  assert.ok(hit, JSON.stringify(errs));
  assert.match(hit, /grants access to nobody by default/);
});

test('#513 securityRoles on a DRAFT flow is rejected — activation creates the table', () => {
  // Measured: the backing table is created by ACTIVATION. A Draft flow has none, so the grant would
  // target a table that does not exist. That is an authoring error, catchable before any write.
  const errs = errorsFor({ status: 'Draft', securityRoles: { personas: ['Dispatcher'] } });
  const hit = errs.find((e) => /cannot be applied to a Draft flow/.test(e));
  assert.ok(hit, JSON.stringify(errs));
  assert.match(hit, /created by ACTIVATION/);
});

test('#513 there is no scope knob, because the platform allows only one depth', () => {
  // The backing table is organization-owned and its privileges report CanBeGlobal only. Offering a
  // `scope` the platform rejects would be a knob that cannot work.
  assert.deepStrictEqual(BPF_ROLE_ACCESS, ['create', 'read', 'write', 'delete']);
  const errs = errorsFor({ securityRoles: { personas: ['Dispatcher'], scope: 'user' } });
  assert.ok(errs.some((e) => /securityRoles has unknown key 'scope'/.test(e)), JSON.stringify(errs));
});

// --- plan -----------------------------------------------------------------------------------------

test('#513 the plan names the flow AND its backing table', () => {
  // The backing table is the thing actually granted on, and its name is derived rather than written
  // by the author — so a dry run has to show it, or the author cannot tell what will be touched.
  const labels = planFor(base({ securityRoles: { personas: ['Dispatcher'] } }), {}).map((p) => p.label);
  assert.ok(labels.some((l) => /flow roles for Ticket Handling \(backing table new_tickethandling\)/.test(l)), labels.join(' | '));
  assert.strictEqual(bpfUniqueName('Ticket Handling'), 'new_tickethandling');
});

// --- the label-loss defect found while live-verifying (AB#6686428) --------------------------------

test('the table existence probe is a NARROW metadata read, not findTables', async () => {
  // FOUND BY LIVE VERIFICATION, and it made the whole localized-label feature a no-op on the real
  // build path while every unit test passed. Order-controlled measurement, 8 tables in the sequence
  // C,F,F,C,C,F,F,C so each arm appears early and late:
  //
  //     create only         kept both languages 4/4
  //     findTables + create kept both languages 0/4
  //
  // The outgoing EntityDefinitions body is byte-identical either way, so the loss is caused by the
  // preceding unfiltered `EntityDefinitions?$select=...DisplayName...` read that `findTables` issues,
  // not by the create payload. Switching the probe to a narrow single-table read took the plugin
  // path from 0/4 to 4/4 against the same org.
  //
  // This test pins the MECHANISM (which read is issued), because the consequence is only observable
  // against an org with two languages provisioned.
  const { provisionDataModel } = require('../lib/entity-provision.js');
  const gets = [];
  const runner = {
    run: async (p, l, fn, o = {}) => { try { return await fn(); } catch (e) { if (o.skipIf && o.skipIf(e)) return undefined; throw e; } },
    skip: () => {},
    mapLimit: async (items, _n, fn) => { const out = []; for (const it of items) out.push(await fn(it)); return out; },
  };
  const created = [];
  const sdk = {
    createTable: async (o) => { created.push(o); return { logicalName: o.schemaName.toLowerCase(), entitySetName: `${o.schemaName.toLowerCase()}s` }; },
    createColumn: async (e, o) => ({ logicalName: o.schemaName.toLowerCase() }),
    updateTable: async () => undefined,
  };
  const provision = {
    dataverse: { get: async (url) => { gets.push(url); return { status: 404, headers: {}, body: {} }; } },
    findTables: async () => { throw new Error('findTables must NOT be used before createTable — it drops non-base-language labels'); },
    findColumns: async () => [],
    fetchEntityMetadata: async (l) => ({ logicalName: l, entitySetName: `${l}s`, relationships: [] }),
    queryRecords: async () => [],
  };
  const spec = {
    solution: { uniqueName: 'contoso', publisherPrefix: 'contoso' },
    languageCode: 1033,
    entities: [{ schemaName: 'contoso_probe', displayName: { 1033: 'Probe', 3082: 'Sonda' }, pluralName: { 1033: 'Probes', 3082: 'Sondas' }, primaryAttribute: { schemaName: 'contoso_name' }, columns: [] }],
    relationships: [],
  };
  await provisionDataModel({ spec, sdk, provision, runner, preResolvedLanguageCode: 1033 });
  assert.strictEqual(gets.length, 1, JSON.stringify(gets));
  assert.match(gets[0], /^\/EntityDefinitions\(LogicalName='contoso_probe'\)\?\$select=LogicalName,EntitySetName$/, gets[0]);
  // ...and the create still carried BOTH languages, unflattened.
  assert.deepStrictEqual(created[0].displayName, { 1033: 'Probe', 3082: 'Sonda' });
});

test('a 404 from the narrow probe means "absent", and a 200 means "reuse"', async () => {
  const { provisionDataModel } = require('../lib/entity-provision.js');
  const runner = {
    run: async (p, l, fn, o = {}) => { try { return await fn(); } catch (e) { if (o.skipIf && o.skipIf(e)) return undefined; throw e; } },
    skip: () => {},
    mapLimit: async (items, _n, fn) => { const out = []; for (const it of items) out.push(await fn(it)); return out; },
  };
  const mk = (status, body) => {
    const created = [];
    return {
      created,
      sdk: { createTable: async (o) => { created.push(o); return { logicalName: o.schemaName.toLowerCase(), entitySetName: 'xs' }; }, createColumn: async (e, o) => ({ logicalName: o.schemaName }), updateTable: async () => undefined },
      provision: {
        dataverse: { get: async () => ({ status, headers: {}, body }) },
        findColumns: async () => [],
        fetchEntityMetadata: async (l) => ({ logicalName: l, entitySetName: 'xs', relationships: [] }),
        queryRecords: async () => [],
      },
    };
  };
  const spec = () => ({
    solution: { uniqueName: 'contoso', publisherPrefix: 'contoso' },
    languageCode: 1033,
    entities: [{ schemaName: 'contoso_probe', displayName: 'Probe', primaryAttribute: { schemaName: 'contoso_name' }, columns: [] }],
    relationships: [],
  });

  const absent = mk(404, {});
  await provisionDataModel({ spec: spec(), sdk: absent.sdk, provision: absent.provision, runner, preResolvedLanguageCode: 1033 });
  assert.strictEqual(absent.created.length, 1, 'a 404 must take the create path');

  const present = mk(200, { LogicalName: 'contoso_probe', EntitySetName: 'contoso_probes' });
  await provisionDataModel({ spec: spec(), sdk: present.sdk, provision: present.provision, runner, preResolvedLanguageCode: 1033 });
  assert.strictEqual(present.created.length, 0, 'a 200 must take the reuse path, not create a duplicate');
});

test('an INCONCLUSIVE probe falls back to findTables rather than assuming absent', async () => {
  // Assuming "absent" on a 500 would turn a transient read failure into a duplicate-create attempt.
  const { provisionDataModel } = require('../lib/entity-provision.js');
  const runner = {
    run: async (p, l, fn, o = {}) => { try { return await fn(); } catch (e) { if (o.skipIf && o.skipIf(e)) return undefined; throw e; } },
    skip: () => {},
    mapLimit: async (items, _n, fn) => { const out = []; for (const it of items) out.push(await fn(it)); return out; },
  };
  let findTablesCalled = 0;
  const created = [];
  await provisionDataModel({
    spec: {
      solution: { uniqueName: 'contoso', publisherPrefix: 'contoso' },
      languageCode: 1033,
      entities: [{ schemaName: 'contoso_probe', displayName: 'Probe', primaryAttribute: { schemaName: 'contoso_name' }, columns: [] }],
      relationships: [],
    },
    sdk: { createTable: async (o) => { created.push(o); return { logicalName: 'contoso_probe', entitySetName: 'xs' }; }, createColumn: async () => ({}), updateTable: async () => undefined },
    provision: {
      dataverse: { get: async () => ({ status: 503, headers: {}, body: {} }) },
      findTables: async () => { findTablesCalled += 1; return [{ logicalName: 'contoso_probe', entitySetName: 'contoso_probes' }]; },
      findColumns: async () => [],
      fetchEntityMetadata: async (l) => ({ logicalName: l, entitySetName: 'xs', relationships: [] }),
      queryRecords: async () => [],
    },
    runner,
    preResolvedLanguageCode: 1033,
  });
  assert.strictEqual(findTablesCalled, 1, 'an inconclusive status must fall back');
  assert.strictEqual(created.length, 0, 'and the fallback found it, so no duplicate create');
});

function securitySdk(over = {}) {
  const calls = { addEntityPrivilegesToRole: [] };
  return {
    calls,
    queryRecords: async (entity) => {
      if (entity === 'businessunit') return [{ businessunitid: '44444444-4444-4444-4444-444444444444' }];
      return [];
    },
    createPersonaRole: async (s) => ({ roleId: '55555555-5555-5555-5555-555555555555', name: s.name, reused: false, appliedPrivileges: [] }),
    addEntityPrivilegesToRole: async (roleId, privileges) => { calls.addEntityPrivilegesToRole.push({ roleId, privileges }); return []; },
    addSolutionComponent: async () => ({}),
    associateRecords: async () => ({}),
    disassociateRecords: async () => ({}),
    ...over,
  };
}

async function applySecurity(spec, sdk, seedFlow = true) {
  return runSdkBuild(spec, {
    sdk, provisionSdk: sdk, apply: true, phases: ['security'],
    // The security phase reads `created.businessProcessFlows`, which the flow phase fills. Seed it
    // the way a full build would, so this exercises the grant rather than the skip path.
    ...(seedFlow ? { changedOnly: undefined } : {}),
  });
}

test('#513 apply grants the fixed access set on the BACKING TABLE at organization scope', async () => {
  // Runs the flow phase too, so `created.businessProcessFlows` is populated the way a real build
  // does — otherwise this would only ever exercise the skip path below.
  const s = base({ securityRoles: { personas: ['Dispatcher'] } });
  const sdk = securitySdk({
    queryRecords: async (entity) => {
      if (entity === 'businessunit') return [{ businessunitid: '44444444-4444-4444-4444-444444444444' }];
      if (entity === 'workflow') return []; // no existing flow -> create path
      return [];
    },
    createArtifact: (type, def) => ({ id: '66666666-6666-6666-6666-666666666666', type, def }),
    pushArtifact: async (type, id) => ({ ok: true, id }),
    activateArtifact: async () => ({ ok: true }),
    updateRecord: async () => ({}),
  });
  const r = await runSdkBuild(s, {
    sdk, provisionSdk: sdk, apply: true,
    phases: ['business-process-flows', 'security'], emit: () => undefined,
  });
  assert.strictEqual(r.ok, true, JSON.stringify(r).slice(0, 400));
  assert.strictEqual(sdk.calls.addEntityPrivilegesToRole.length, 1, JSON.stringify(sdk.calls.addEntityPrivilegesToRole));
  const call = sdk.calls.addEntityPrivilegesToRole[0];
  assert.strictEqual(call.roleId, '55555555-5555-5555-5555-555555555555');
  // The DERIVED backing table, not the flow name and not the flow's own entity.
  assert.deepStrictEqual(call.privileges, [{ entity: 'new_tickethandling', access: ['create', 'read', 'write', 'delete'], scope: 'organization' }]);
  assert.deepStrictEqual(r.created.bpfRoleGrants['Ticket Handling'], { backingTable: 'new_tickethandling', personas: ['Dispatcher'] });
});

test('#513 a flow the phase did not build is SKIPPED with a reason, never granted blind', async () => {
  // The backing table only exists once the flow is activated. Granting anyway would fail against a
  // missing table; skipping SILENTLY would report success while nobody can run the process.
  const s = base({ securityRoles: { personas: ['Dispatcher'] } });
  const sdk = securitySdk();
  const emitted = [];
  await runSdkBuild(s, { sdk, provisionSdk: sdk, apply: true, phases: ['security'], emit: (e) => emitted.push(e) });
  assert.strictEqual(sdk.calls.addEntityPrivilegesToRole.length, 0, 'must not grant when the flow was not built in this run');
  // The REASON has to reach the operator. runner.run does not emit a returned value, so this is
  // reported as a labelled SKIP — assert on that, not on a message that never leaves the closure.
  const skipped = emitted.find((e) => e.status === 'skip' && /flow roles for Ticket Handling/.test(e.label || ''));
  assert.ok(skipped, JSON.stringify(emitted.map((e) => `${e.status} ${e.label}`)));
  assert.match(skipped.label, /did not run in this invocation/);
});
