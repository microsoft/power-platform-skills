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
const { validateAppSpec, bpfUniqueName, BPF_ROLE_ACCESS, SDK_ROLE_MARKER } = require('../lib/app-spec.js');
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

test('the COLUMN existence probe is a narrow read too — the reuse path was missed first time', async () => {
  // The table probe fix above was INCOMPLETE. `findColumns` poisons `createColumn` identically, and
  // it is called on the table-REUSE branch — i.e. adding a column to a table that already exists,
  // which is exactly the scenario AB#6686428 was reported against. A fresh-table build never reaches
  // it, which is why both the first fix and the end-to-end verification missed it.
  //
  // Order-controlled, 8 columns, C,F,F,C,C,F,F,C:
  //     createColumn only          kept both languages 4/4
  //     findColumns + createColumn kept both languages 0/4
  // After the fix, the plugin's reuse path measured 4/4 against the same org.
  const { provisionDataModel } = require('../lib/entity-provision.js');
  const gets = [];
  const runner = {
    run: async (p, l, fn, o = {}) => { try { return await fn(); } catch (e) { if (o.skipIf && o.skipIf(e)) return undefined; throw e; } },
    skip: () => {},
    mapLimit: async (items, _n, fn) => { const out = []; for (const it of items) out.push(await fn(it)); return out; },
  };
  const createdColumns = [];
  const sdk = {
    createTable: async () => { throw new Error('the table exists — the reuse branch must not create it'); },
    createColumn: async (e, o) => { createdColumns.push(o); return { logicalName: o.schemaName.toLowerCase() }; },
    updateTable: async () => undefined,
    updateColumn: async () => undefined,
  };
  const provision = {
    dataverse: {
      get: async (url) => {
        gets.push(url);
        if (/^\/EntityDefinitions\(LogicalName='contoso_probe'\)\?/.test(url)) {
          return { status: 200, headers: {}, body: { LogicalName: 'contoso_probe', EntitySetName: 'contoso_probes' } };
        }
        if (/\/Attributes\?/.test(url)) {
          return { status: 200, headers: {}, body: { value: [{ LogicalName: 'contoso_name', RequiredLevel: { Value: 'ApplicationRequired' } }] } };
        }
        return { status: 404, headers: {}, body: {} };
      },
    },
    findColumns: async () => { throw new Error('findColumns must NOT be used before createColumn — it drops non-base-language labels'); },
    findTables: async () => { throw new Error('findTables must NOT be used before a create'); },
    fetchEntityMetadata: async (l) => ({ logicalName: l, entitySetName: 'contoso_probes', relationships: [] }),
    queryRecords: async () => [],
  };
  await provisionDataModel({
    spec: {
      solution: { uniqueName: 'contoso', publisherPrefix: 'contoso' },
      languageCode: 1033,
      entities: [{ schemaName: 'contoso_probe', displayName: 'Probe', primaryAttribute: { schemaName: 'contoso_name' }, columns: [{ schemaName: 'contoso_note', type: 'Text', displayName: { 1033: 'Note', 3082: 'Nota' } }] }],
      relationships: [],
    },
    sdk, provision, runner, preResolvedLanguageCode: 1033,
  });
  assert.ok(gets.some((u) => /^\/EntityDefinitions\(LogicalName='contoso_probe'\)\/Attributes\?\$select=LogicalName,RequiredLevel$/.test(u)), JSON.stringify(gets));
  const note = createdColumns.find((c) => c.schemaName === 'contoso_note');
  assert.ok(note, JSON.stringify(createdColumns));
  assert.deepStrictEqual(note.displayName, { 1033: 'Note', 3082: 'Nota' });
});

test('an unreadable column list does NOT fall back to findColumns — that would re-poison the labels', async () => {
  // The obvious fallback is exactly the bug. `findColumns` is the poisoning read this function
  // exists to avoid, and this branch is the one where `createColumn` is guaranteed to run next, so
  // falling back would silently restore the defect on the very path it targets. Instead: warn, treat
  // every column as new, and let the create's already-exists handling de-duplicate.
  const { provisionDataModel } = require('../lib/entity-provision.js');
  let findColumnsCalled = 0;
  const createdColumns = [];
  const warnings = [];
  const runner = {
    run: async (p, l, fn, o = {}) => { try { return await fn(); } catch (e) { if (o.skipIf && o.skipIf(e)) return undefined; throw e; } },
    skip: () => {},
    mapLimit: async (items, _n, fn) => { const out = []; for (const it of items) out.push(await fn(it)); return out; },
  };
  await provisionDataModel({
    spec: {
      solution: { uniqueName: 'contoso', publisherPrefix: 'contoso' },
      languageCode: 1033,
      entities: [{ schemaName: 'contoso_probe', displayName: 'Probe', primaryAttribute: { schemaName: 'contoso_name' }, columns: [{ schemaName: 'contoso_note', type: 'Text', displayName: 'Note' }] }],
      relationships: [],
    },
    sdk: { createColumn: async (e, o) => { createdColumns.push(o); return { logicalName: o.schemaName }; }, updateTable: async () => undefined, updateColumn: async () => undefined },
    provision: {
      dataverse: {
        get: async (url) => {
          if (/^\/EntityDefinitions\(LogicalName='contoso_probe'\)\?/.test(url)) return { status: 200, headers: {}, body: { LogicalName: 'contoso_probe', EntitySetName: 'contoso_probes' } };
          return { status: 503, headers: {}, body: {} };
        },
      },
      findColumns: async () => { findColumnsCalled += 1; return [{ logicalName: 'contoso_note' }]; },
      fetchEntityMetadata: async (l) => ({ logicalName: l, entitySetName: 'contoso_probes', relationships: [] }),
      queryRecords: async () => [],
    },
    runner,
    warn: (m) => warnings.push(String(m)),
    preResolvedLanguageCode: 1033,
  });
  assert.strictEqual(findColumnsCalled, 0, 'the poisoning fallback must NOT run when a raw client is present');
  assert.strictEqual(createdColumns.length, 1, 'every column looks new, and create de-duplicates the existing one');
  assert.ok(
    warnings.some((w) => /could not read existing columns for contoso_probe/.test(w) && /503/.test(w)),
    `the degradation must be warned about, not silent — got ${JSON.stringify(warnings)}`,
  );
});

test('a raw read that THROWS is handled too — the client throws only on a persistent transport error', async () => {
  // `findExistingTable` and `findExistingColumns` must behave identically here. The az-backed client
  // resolves `{status}` for 404s and even persistent 5xx, and throws only when the transport itself
  // never produced a response; letting that propagate would abort a build over a blip that the
  // documented fallbacks are designed to survive.
  const { provisionDataModel } = require('../lib/entity-provision.js');
  const createdColumns = [];
  const warnings = [];
  let findTablesCalled = 0;
  const runner = {
    run: async (p, l, fn, o = {}) => { try { return await fn(); } catch (e) { if (o.skipIf && o.skipIf(e)) return undefined; throw e; } },
    skip: () => {},
    mapLimit: async (items, _n, fn) => { const out = []; for (const it of items) out.push(await fn(it)); return out; },
  };
  await provisionDataModel({
    spec: {
      solution: { uniqueName: 'contoso', publisherPrefix: 'contoso' },
      languageCode: 1033,
      entities: [{ schemaName: 'contoso_probe', displayName: 'Probe', primaryAttribute: { schemaName: 'contoso_name' }, columns: [{ schemaName: 'contoso_note', type: 'Text', displayName: 'Note' }] }],
      relationships: [],
    },
    sdk: {
      createTable: async () => ({ logicalName: 'contoso_probe', entitySetName: 'contoso_probes' }),
      createColumn: async (e, o) => { createdColumns.push(o); return { logicalName: o.schemaName }; },
      updateTable: async () => undefined,
      updateColumn: async () => undefined,
    },
    provision: {
      dataverse: { get: async () => { throw new Error('ECONNRESET'); } },
      findTables: async () => { findTablesCalled += 1; return []; },
      fetchEntityMetadata: async (l) => ({ logicalName: l, entitySetName: 'contoso_probes', relationships: [] }),
      queryRecords: async () => [],
    },
    runner,
    warn: (m) => warnings.push(String(m)),
    preResolvedLanguageCode: 1033,
  });
  // The table probe threw, so it fell back to findTables (which cannot poison a table that is about
  // to be CREATED — the poisoning is read-then-create on the SAME object, and this table is absent).
  assert.strictEqual(findTablesCalled, 1, 'a thrown table probe must fall back rather than abort the build');
  assert.strictEqual(createdColumns.length, 1, 'and the build proceeded to create the column');
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

test('#513 a persona is matched CASE-INSENSITIVELY — the author types the display name twice', async () => {
  // A persona is a DISPLAY name repeated by hand in two unrelated sections of the spec
  // (`personas[].persona` and `businessProcessFlows[].securityRoles.personas[]`). An exact-case
  // Map lookup made "dispatcher" vs "Dispatcher" silently grant nothing while the build reported
  // success — the worst failure mode for a security feature. The SPEC GATE also accepts the
  // mismatch, so a case-sensitive apply would contradict its own validator.
  const s = base({ securityRoles: { personas: ['dispatcher'] } }); // persona is declared as 'Dispatcher'
  assert.deepStrictEqual(validateAppSpec(s, { profile: 'plan' }).errors || [], [], 'the gate must accept it too');
  const sdk = securitySdk({
    queryRecords: async (entity) => {
      if (entity === 'businessunit') return [{ businessunitid: '44444444-4444-4444-4444-444444444444' }];
      if (entity === 'workflow') return [];
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
  assert.strictEqual(sdk.calls.addEntityPrivilegesToRole.length, 1, 'the case-differing persona must still be granted');
  assert.deepStrictEqual(
    sdk.calls.addEntityPrivilegesToRole[0].privileges,
    [{ entity: 'new_tickethandling', access: ['create', 'read', 'write', 'delete'], scope: 'organization' }],
  );
});

test('#513 verify resolves the persona case-insensitively too, or it would report a false failure', async () => {
  // build and verify must agree. If build grants a case-differing persona but verify queries
  // `role` by the AS-WRITTEN casing, verify reports a missing grant that is actually present —
  // which is worse than no check, because it trains the operator to ignore the check.
  const { verifySpec } = require('../lib/verify-spec.js');
  const BACKING = 'new_tickethandling';
  const privs = BPF_ROLE_ACCESS.map((a) => ({
    Name: `prv${a[0].toUpperCase()}${a.slice(1)}${BACKING}`, PrivilegeId: `bpf-${a}`, PrivilegeType: a[0].toUpperCase() + a.slice(1),
  }));
  const queried = [];
  const read = {
    findTable: async () => null,
    findColumns: async () => [],
    sitemapXml: async () => '',
    queryRecords: async (set, o) => {
      if (set === 'businessunit') return [{ businessunitid: '44444444-4444-4444-4444-444444444444' }];
      if (set === 'role') {
        queried.push((o && o.filter) || '');
        // The DEPLOYED role carries the persona's own casing, and OData `eq` on a string is
        // case-INsensitive in Dataverse — but the row is only returned for the canonical name here,
        // so this asserts the resolver picked it rather than relying on server-side collation.
        return /'Dispatcher'/.test((o && o.filter) || '') ? [{ roleid: 'role-1', name: 'Dispatcher', description: SDK_ROLE_MARKER }] : [];
      }
      if (set === 'workflow') return [{ workflowid: 'w1', statecode: 1 }];
      return [];
    },
    entityPrivileges: async (t) => (t === BACKING ? privs : []),
    rolePrivileges: async () => BPF_ROLE_ACCESS.map((a) => ({ privilegeId: `bpf-${a}`, depth: 'Global' })),
  };
  const s = base({ securityRoles: { personas: ['DISPATCHER'] } });
  const r = await verifySpec(s, read);
  const c = r.checks.find((x) => x.kind === 'bpf-roles');
  assert.ok(c && c.present, `expected a passing bpf-roles check; filters=${JSON.stringify(queried)} check=${JSON.stringify(c)}`);
});

test('#513 verify FAILS when the flow does not exist, instead of probing a derived table name', async () => {
  // The fail-open this closes: with no workflow row, `deployed` was falsy and the DERIVED backing
  // name (`bpfUniqueName(flow.name)`) stayed in place. If an unrelated table happened to hold that
  // name and the persona happened to hold privileges on it, verify reported PASS for a business
  // process flow that does not exist at all. A successful query returning NO ROWS is positive
  // evidence of absence — quite different from a read that threw, where the derivation still stands
  // and the privilege read fails closed on its own.
  const { verifySpec } = require('../lib/verify-spec.js');
  const asked = [];
  const read = {
    findTable: async () => null,
    findColumns: async () => [],
    sitemapXml: async () => '',
    queryRecords: async (set) => {
      if (set === 'businessunit') return [{ businessunitid: '44444444-4444-4444-4444-444444444444' }];
      if (set === 'role') return [{ roleid: 'role-1', name: 'Dispatcher', description: SDK_ROLE_MARKER }];
      if (set === 'workflow') return []; // the flow was never created
      return [];
    },
    // The trap: a DIFFERENT table happens to carry the derived name and grants everything.
    entityPrivileges: async (t) => {
      asked.push(t);
      return BPF_ROLE_ACCESS.map((a) => ({ Name: `prv${a}`, PrivilegeId: `bpf-${a}`, PrivilegeType: a[0].toUpperCase() + a.slice(1) }));
    },
    rolePrivileges: async () => BPF_ROLE_ACCESS.map((a) => ({ privilegeId: `bpf-${a}`, depth: 'Global' })),
  };
  const r = await verifySpec(base({ securityRoles: { personas: ['Dispatcher'] } }), read);
  const c = r.checks.find((x) => x.kind === 'bpf-roles');
  assert.ok(c, 'a bpf-roles check must still be recorded');
  assert.strictEqual(c.present, false, `an absent flow must FAIL: ${JSON.stringify(c)}`);
  assert.match(c.detail, /no business process flow named/, c.detail);
  // Scoped to the DERIVED backing-table name. The persona role-privileges check legitimately reads
  // privileges for the spec's own entities, so asserting "nothing was asked" would fail for an
  // unrelated reason and prove nothing about this fix.
  const derived = require('../lib/app-spec.js').bpfUniqueName(FLOW.name);
  assert.ok(!asked.includes(derived),
    `it must not read privileges on '${derived}' — a name it could not confirm belongs to the flow; asked=${JSON.stringify(asked)}`);
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
// --- the backing table is READ BACK, not derived -------------------------------------------------

test('#513 a REUSED flow grants on its DEPLOYED uniquename, not the derivation', async () => {
  // A flow authored in Maker (or renamed after creation) keeps a `uniquename` unrelated to its
  // display name -- and that name IS the backing table. Deriving would grant on a table that does
  // not exist, or on an unrelated one that happens to hold the derived name.
  const s = base({ securityRoles: { personas: ['Dispatcher'] } });
  const sdk = securitySdk({
    queryRecords: async (entity) => {
      if (entity === 'businessunit') return [{ businessunitid: '44444444-4444-4444-4444-444444444444' }];
      if (entity === 'workflow') return [{ workflowid: 'w-existing', statecode: 1, createdon: '2020-01-01', uniquename: 'contoso_ticketprocess' }];
      return [];
    },
    updateRecord: async () => ({}),
  });
  const r = await runSdkBuild(s, {
    sdk, provisionSdk: sdk, apply: true,
    phases: ['business-process-flows', 'security'], emit: () => undefined, warn: () => undefined,
  });
  assert.strictEqual(r.ok, true, JSON.stringify(r).slice(0, 400));
  assert.strictEqual(sdk.calls.addEntityPrivilegesToRole.length, 1, JSON.stringify(sdk.calls.addEntityPrivilegesToRole));
  assert.strictEqual(sdk.calls.addEntityPrivilegesToRole[0].privileges[0].entity, 'contoso_ticketprocess',
    'the DEPLOYED unique name, not bpfUniqueName("Ticket Handling")');
  assert.notStrictEqual(sdk.calls.addEntityPrivilegesToRole[0].privileges[0].entity, bpfUniqueName('Ticket Handling'),
    'and the derivation really is different here, so this asserts something');
  assert.strictEqual(r.created.bpfRoleGrants['Ticket Handling'].backingTable, 'contoso_ticketprocess');
});

test('#513 a row with no uniquename falls back to the derivation rather than granting on undefined', async () => {
  // Older projections and test doubles do not model the field. The derivation is the right answer
  // for anything this tool created, so the fallback must stay -- but it must be a FALLBACK.
  const s = base({ securityRoles: { personas: ['Dispatcher'] } });
  const sdk = securitySdk({
    queryRecords: async (entity) => {
      if (entity === 'businessunit') return [{ businessunitid: '44444444-4444-4444-4444-444444444444' }];
      if (entity === 'workflow') return [{ workflowid: 'w-existing', statecode: 1, createdon: '2020-01-01' }];
      return [];
    },
    updateRecord: async () => ({}),
  });
  const r = await runSdkBuild(s, {
    sdk, provisionSdk: sdk, apply: true,
    phases: ['business-process-flows', 'security'], emit: () => undefined, warn: () => undefined,
  });
  assert.strictEqual(sdk.calls.addEntityPrivilegesToRole[0].privileges[0].entity, bpfUniqueName('Ticket Handling'));
});

test('#513 verify reads the deployed uniquename too, or build and verify disagree', async () => {
  const { verifySpec } = require('../lib/verify-spec.js');
  const DEPLOYED = 'contoso_ticketprocess';
  const privs = BPF_ROLE_ACCESS.map((a) => ({
    Name: `prv${a[0].toUpperCase()}${a.slice(1)}${DEPLOYED}`, PrivilegeId: `bpf-${a}`, PrivilegeType: a[0].toUpperCase() + a.slice(1),
  }));
  const asked = [];
  const read = {
    findTable: async () => null,
    findColumns: async () => [],
    sitemapXml: async () => '',
    queryRecords: async (set) => {
      if (set === 'businessunit') return [{ businessunitid: '44444444-4444-4444-4444-444444444444' }];
      if (set === 'role') return [{ roleid: 'role-1', name: 'Dispatcher', description: SDK_ROLE_MARKER }];
      if (set === 'workflow') return [{ workflowid: 'w1', statecode: 1, uniquename: DEPLOYED }];
      return [];
    },
    entityPrivileges: async (t) => { asked.push(t); return t === DEPLOYED ? privs : []; },
    rolePrivileges: async () => BPF_ROLE_ACCESS.map((a) => ({ privilegeId: `bpf-${a}`, depth: 'Global' })),
  };
  const r = await verifySpec(base({ securityRoles: { personas: ['Dispatcher'] } }), read);
  const c = r.checks.find((x) => x.kind === 'bpf-roles');
  assert.ok(c && c.present, `asked for: ${JSON.stringify(asked)}; check=${JSON.stringify(c)}`);
  assert.ok(asked.includes(DEPLOYED), 'verify must ask about the DEPLOYED table');
  assert.strictEqual(asked.includes(bpfUniqueName('Ticket Handling')), false, 'and never about the derivation');
});
