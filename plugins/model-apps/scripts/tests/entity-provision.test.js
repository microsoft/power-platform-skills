'use strict';
// Also guards AB#6648517 — RequiredLevel (Business Required) could not be set on an EXISTING
// column, so an explicit `required` change never converged on rebuild.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { makeRunner, requireSuccessfulPush, reportPartialPush, errorCodeChain, BuildHalt, provisionDataModel, provisionSampleData, provisionSolution, buildSeedGroup } = require(path.join(__dirname, '..', 'lib', 'entity-provision.js'));

function mockSdk(existing = {}) {
  const calls = [];
  return {
    calls,
    sdk: {
      createTable: async (o) => { calls.push(['createTable', o.schemaName]); return { logicalName: o.schemaName.toLowerCase(), entitySetName: `${o.schemaName.toLowerCase()}s`, metadataId: `tbl-${o.schemaName}` }; },
      updateTable: async (l, o) => { calls.push(['updateTable', l, o]); return {}; },
      createColumn: async (l, o) => { calls.push(['createColumn', l, o.schemaName]); return { logicalName: o.schemaName.toLowerCase(), metadataId: `col-${o.schemaName}` }; },
      updateColumn: async (l, c, o) => { calls.push(['updateColumn', l, c, o]); return {}; },
      createCustomerColumn: async (l, o) => { calls.push(['createCustomerColumn', l, o.schemaName]); return { logicalName: o.schemaName.toLowerCase(), metadataId: `col-${o.schemaName}` }; },
      createRelationship: async (o) => { calls.push(['createRelationship', o.schemaName]); return { schemaName: o.schemaName, metadataId: `rel-${o.schemaName}`, lookupLogicalName: o.lookupSchemaName ? o.lookupSchemaName.toLowerCase() : undefined }; },
      createGlobalOptionSet: async (o) => { calls.push(['createGlobalOptionSet', o.name]); return { metadataId: `gc-${o.name}` }; },
      insertStatusValue: async () => 100000000,
      createAlternateKey: async () => ({}),
    },
    provision: {
      findTables: async (s) => (existing[s.toLowerCase()] ? [{ logicalName: s.toLowerCase(), entitySetName: `${s.toLowerCase()}s` }] : []),
      findColumns: async () => [],
      fetchEntityMetadata: async (l) => ({ logicalName: l, entitySetName: `${l}s`, relationships: [] }),
    },
  };
}

test('provisionDataModel creates missing tables + columns and captures entitySetName', async () => {
  const m = mockSdk();
  const spec = { solution: { uniqueName: 'S', publisherPrefix: 'new' }, entities: [
    { schemaName: 'new_ticket', displayName: 'Ticket', primaryAttribute: { schemaName: 'new_name' },
      columns: [{ schemaName: 'new_priority', type: 'Choice', options: ['Low', 'High'] }] },
  ], relationships: [] };
  const runner = makeRunner({ emit: () => {}, total: 10 });
  const dm = await provisionDataModel({ sdk: m.sdk, provision: m.provision, runner, spec, apply: true, concurrency: 2 });
  assert.ok(dm.entities['new_ticket'], 'new_ticket entity present');
  assert.strictEqual(dm.entities['new_ticket'].entitySetName, 'new_tickets');
  assert.strictEqual(dm.entities['new_ticket'].metadataId, 'tbl-new_ticket', 'table metadataId captured');
  assert.ok(m.calls.some((c) => c[0] === 'createTable' && c[1] === 'new_ticket'), 'createTable called');
  assert.ok(m.calls.some((c) => c[0] === 'createColumn' && c[2] === 'new_priority'), 'createColumn called');
  assert.ok(Array.isArray(dm.columns['new_ticket']), 'columns captured as array');
  assert.strictEqual(dm.columns['new_ticket'][0].schemaName, 'new_priority', 'column schemaName captured');
  assert.strictEqual(dm.columns['new_ticket'][0].logicalName, 'new_priority', 'column logicalName captured');
  assert.strictEqual(dm.columns['new_ticket'][0].metadataId, 'col-new_priority', 'column metadataId captured');
});

test('provisionDataModel skips an existing table (idempotent)', async () => {
  const m = mockSdk({ new_ticket: true });
  const spec = { solution: { uniqueName: 'S', publisherPrefix: 'new' }, entities: [
    { schemaName: 'new_ticket', displayName: 'Ticket', primaryAttribute: { schemaName: 'new_name' }, columns: [] },
  ], relationships: [] };
  const runner = makeRunner({ emit: () => {}, total: 10 });
  await provisionDataModel({ sdk: m.sdk, provision: m.provision, runner, spec, apply: true, concurrency: 2 });
  assert.ok(!m.calls.some((c) => c[0] === 'createTable'), 'existing table not re-created');
});

test('provisionDataModel recovers from createTable already-exists error and rediscovers entitySetName', async () => {
  const m = mockSdk();
  // createTable throws an already-exists error
  m.sdk.createTable = async () => {
    const err = new Error('Entity with the specified name already exists');
    err.statusCode = 409;
    throw err;
  };
  // findTables returns the existing table with entitySetName
  m.provision.findTables = async (s) => [{ logicalName: s.toLowerCase(), entitySetName: `${s.toLowerCase()}s_custom` }];

  const spec = { solution: { uniqueName: 'S', publisherPrefix: 'new' }, entities: [
    { schemaName: 'new_ticket', displayName: 'Ticket', primaryAttribute: { schemaName: 'new_name' }, columns: [] },
  ], relationships: [] };
  const runner = makeRunner({ emit: () => {}, total: 10 });
  const dm = await provisionDataModel({ sdk: m.sdk, provision: m.provision, runner, spec, apply: true, concurrency: 2 });

  assert.ok(dm.entities['new_ticket'], 'new_ticket entity present');
  assert.strictEqual(dm.entities['new_ticket'].entitySetName, 'new_tickets_custom', 'entitySetName recovered from findTables');
  assert.strictEqual(dm.entities['new_ticket'].logicalName, 'new_ticket', 'logicalName captured');
});

test('provisionDataModel recovers from a transient-retry table duplicate ("Entities already exist" 400)', async () => {
  const m = mockSdk();
  // A transient network retry can leave the table created server-side; the retried POST then
  // gets Dataverse's plural 400 message "Entities already exist: <name>" (note: "exist", no 's').
  m.sdk.createTable = async () => {
    const err = new Error('Entities already exist: new_ticket');
    err.statusCode = 400;
    throw err;
  };
  m.provision.findTables = async (s) => [{ logicalName: s.toLowerCase(), entitySetName: `${s.toLowerCase()}s` }];
  const spec = { solution: { uniqueName: 'S', publisherPrefix: 'new' }, entities: [
    { schemaName: 'new_ticket', displayName: 'Ticket', primaryAttribute: { schemaName: 'new_name' }, columns: [] },
  ], relationships: [] };
  const runner = makeRunner({ emit: () => {}, total: 10 });
  const dm = await provisionDataModel({ sdk: m.sdk, provision: m.provision, runner, spec, apply: true });
  assert.ok(dm.entities['new_ticket'], 'recovered — table not re-created, entitySetName rediscovered');
  assert.strictEqual(dm.entities['new_ticket'].entitySetName, 'new_tickets');
});

test('provisionDataModel recovers from createColumn already-exists error', async () => {
  const m = mockSdk();
  // createColumn throws an already-exists error
  m.sdk.createColumn = async () => {
    const err = new Error('Column already exists');
    err.statusCode = 409;
    throw err;
  };

  const spec = { solution: { uniqueName: 'S', publisherPrefix: 'new' }, entities: [
    { schemaName: 'new_ticket', displayName: 'Ticket', primaryAttribute: { schemaName: 'new_name' },
      columns: [{ schemaName: 'new_priority', type: 'Text' }] },
  ], relationships: [] };
  const runner = makeRunner({ emit: () => {}, total: 10 });

  // Should not throw - column create should skip on already-exists
  const dm = await provisionDataModel({ sdk: m.sdk, provision: m.provision, runner, spec, apply: true, concurrency: 2 });

  assert.ok(dm.entities['new_ticket'], 'table created despite column error');
  // Column not captured because skipIf returned undefined
  assert.ok(!dm.columns['new_ticket'] || dm.columns['new_ticket'].length === 0, 'column not captured on skip');
});

test('provisionDataModel serializes column creation within an entity (per-entity EntityCustomization lock)', async () => {
  const m = mockSdk();
  let inFlight = 0;
  let maxInFlight = 0;
  m.sdk.createColumn = async (l, o) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    m.calls.push(['createColumn', l, o.schemaName]);
    return { logicalName: o.schemaName.toLowerCase(), metadataId: `col-${o.schemaName}` };
  };
  const spec = { solution: { uniqueName: 'S', publisherPrefix: 'new' }, entities: [
    { schemaName: 'new_ticket', displayName: 'Ticket', primaryAttribute: { schemaName: 'new_name' },
      columns: [{ schemaName: 'new_a', type: 'Text' }, { schemaName: 'new_b', type: 'Text' }, { schemaName: 'new_c', type: 'Text' }] },
  ], relationships: [] };
  const runner = makeRunner({ emit: () => {}, total: 10 });
  await provisionDataModel({ sdk: m.sdk, provision: m.provision, runner, spec, apply: true });
  assert.strictEqual(maxInFlight, 1, 'never more than one column create in flight per entity');
  assert.strictEqual(m.calls.filter((c) => c[0] === 'createColumn').length, 3, 'all three columns created');
});

test('provisionDataModel updates an existing column when explicit required:true differs', async () => {
  const m = mockSdk({ new_ticket: true });
  m.provision.findColumns = async () => [
    { logicalName: 'new_priority', schemaName: 'new_priority', requiredLevel: 'None' },
  ];
  const spec = { solution: { uniqueName: 'S', publisherPrefix: 'new' }, entities: [
    { schemaName: 'new_ticket', displayName: 'Ticket', primaryAttribute: { schemaName: 'new_name' },
      columns: [{ schemaName: 'new_priority', type: 'Text', required: true }] },
  ], relationships: [] };
  const runner = makeRunner({ emit: () => {}, total: 10 });
  await provisionDataModel({ sdk: m.sdk, provision: m.provision, runner, spec, apply: true });
  assert.deepStrictEqual(
    m.calls.find((c) => c[0] === 'updateColumn'),
    ['updateColumn', 'new_ticket', 'new_priority', { required: 'ApplicationRequired' }]
  );
});

test('provisionDataModel updates an existing column when explicit required:"recommended" differs', async () => {
  const m = mockSdk({ new_ticket: true });
  m.provision.findColumns = async () => [
    { logicalName: 'new_priority', schemaName: 'new_priority', RequiredLevel: { Value: 'None' } },
  ];
  const spec = { solution: { uniqueName: 'S', publisherPrefix: 'new' }, entities: [
    { schemaName: 'new_ticket', displayName: 'Ticket', primaryAttribute: { schemaName: 'new_name' },
      columns: [{ schemaName: 'new_priority', type: 'Text', required: 'recommended' }] },
  ], relationships: [] };
  const runner = makeRunner({ emit: () => {}, total: 10 });
  await provisionDataModel({ sdk: m.sdk, provision: m.provision, runner, spec, apply: true });
  assert.deepStrictEqual(
    m.calls.find((c) => c[0] === 'updateColumn'),
    ['updateColumn', 'new_ticket', 'new_priority', { required: 'Recommended' }]
  );
});

test('provisionDataModel skips the required update when an existing column already matches', async () => {
  const events = [];
  const m = mockSdk({ new_ticket: true });
  m.provision.findColumns = async () => [
    { logicalName: 'new_priority', schemaName: 'new_priority', RequiredLevel: { Value: 'ApplicationRequired' } },
  ];
  const spec = { solution: { uniqueName: 'S', publisherPrefix: 'new' }, entities: [
    { schemaName: 'new_ticket', displayName: 'Ticket', primaryAttribute: { schemaName: 'new_name' },
      columns: [{ schemaName: 'new_priority', type: 'Text', required: true }] },
  ], relationships: [] };
  const runner = makeRunner({ emit: (e) => events.push(e), total: 10 });
  await provisionDataModel({ sdk: m.sdk, provision: m.provision, runner, spec, apply: true });
  assert.ok(!m.calls.some((c) => c[0] === 'updateColumn'), 'no metadata PUT when RequiredLevel already matches');
  assert.ok(events.some((e) => e.status === 'skip' && /required new_ticket\.new_priority \(already ApplicationRequired\)/.test(e.label)));
});

test('provisionDataModel does not demote an existing required column when the spec omits required', async () => {
  const m = mockSdk({ new_ticket: true });
  m.provision.findColumns = async () => [
    { logicalName: 'new_priority', schemaName: 'new_priority', RequiredLevel: { Value: 'ApplicationRequired' } },
  ];
  const spec = { solution: { uniqueName: 'S', publisherPrefix: 'new' }, entities: [
    { schemaName: 'new_ticket', displayName: 'Ticket', primaryAttribute: { schemaName: 'new_name' },
      columns: [{ schemaName: 'new_priority', type: 'Text' }] },
  ], relationships: [] };
  const runner = makeRunner({ emit: () => {}, total: 10 });
  await provisionDataModel({ sdk: m.sdk, provision: m.provision, runner, spec, apply: true });
  assert.ok(!m.calls.some((c) => c[0] === 'updateColumn'), 'omitted required is not interpreted as None on an existing column');
});

test('provisionDataModel leaves a new required column on the create path without updateColumn', async () => {
  const m = mockSdk();
  const spec = { solution: { uniqueName: 'S', publisherPrefix: 'new' }, entities: [
    { schemaName: 'new_ticket', displayName: 'Ticket', primaryAttribute: { schemaName: 'new_name' },
      columns: [{ schemaName: 'new_priority', type: 'Text', required: true }] },
  ], relationships: [] };
  const runner = makeRunner({ emit: () => {}, total: 10 });
  await provisionDataModel({ sdk: m.sdk, provision: m.provision, runner, spec, apply: true });
  assert.ok(m.calls.some((c) => c[0] === 'createColumn' && c[2] === 'new_priority'), 'new column still uses createColumn');
  assert.ok(!m.calls.some((c) => c[0] === 'updateColumn'), 'new column required is handled by createColumn only');
});

test('provisionDataModel warns and continues when an existing-column required update fails', async () => {
  const warnings = [];
  const events = [];
  const m = mockSdk({ new_ticket: true });
  m.provision.findColumns = async () => [
    { logicalName: 'new_priority', schemaName: 'new_priority', RequiredLevel: { Value: 'None' } },
  ];
  m.sdk.updateColumn = async (l, c, o) => {
    m.calls.push(['updateColumn', l, c, o]);
    const err = new Error('metadata lock busy');
    err.statusCode = 429;
    throw err;
  };
  const spec = { solution: { uniqueName: 'S', publisherPrefix: 'new' }, entities: [
    { schemaName: 'new_ticket', displayName: 'Ticket', primaryAttribute: { schemaName: 'new_name' },
      columns: [{ schemaName: 'new_priority', type: 'Text', required: true }] },
  ], relationships: [] };
  const runner = makeRunner({ emit: (e) => events.push(e), total: 10 });
  await provisionDataModel({ sdk: m.sdk, provision: m.provision, runner, spec, apply: true, warn: (m) => warnings.push(m) });
  assert.ok(m.calls.some((c) => c[0] === 'updateColumn'), 'the reconcile was attempted');
  assert.ok(events.some((e) => e.status === 'error' && /required new_ticket\.new_priority/.test(e.label)), 'the failed best-effort step is visible');
  assert.ok(warnings.some((w) => /could not update required level for new_ticket\.new_priority/.test(w)));
});

test('provisionDataModel serializes required-level updates within an entity', async () => {
  const m = mockSdk({ new_ticket: true });
  const mapLimits = [];
  m.provision.findColumns = async () => [
    { logicalName: 'new_a', schemaName: 'new_a', RequiredLevel: { Value: 'None' } },
    { logicalName: 'new_b', schemaName: 'new_b', RequiredLevel: { Value: 'None' } },
  ];
  const spec = { solution: { uniqueName: 'S', publisherPrefix: 'new' }, entities: [
    { schemaName: 'new_ticket', displayName: 'Ticket', primaryAttribute: { schemaName: 'new_name' },
      columns: [
        { schemaName: 'new_a', type: 'Text', required: true },
        { schemaName: 'new_b', type: 'Text', required: 'recommended' },
      ] },
  ], relationships: [] };
  const runner = makeRunner({ emit: () => {}, total: 10 });
  const realMapLimit = runner.mapLimit;
  runner.mapLimit = async (items, limit, fn) => { mapLimits.push({ count: items.length, limit }); return realMapLimit(items, limit, fn); };
  await provisionDataModel({ sdk: m.sdk, provision: m.provision, runner, spec, apply: true });
  assert.ok(mapLimits.some((m) => m.count === 2 && m.limit === 1), 'required-level metadata PUTs must be serialized');
  assert.strictEqual(m.calls.filter((c) => c[0] === 'updateColumn').length, 2);
});

test('provisionDataModel can reconcile required on the primary name column of an existing table', async () => {
  const m = mockSdk({ new_ticket: true });
  m.provision.findColumns = async () => [
    { logicalName: 'new_name', schemaName: 'new_name', RequiredLevel: { Value: 'None' } },
  ];
  const spec = { solution: { uniqueName: 'S', publisherPrefix: 'new' }, entities: [
    { schemaName: 'new_ticket', displayName: 'Ticket',
      primaryAttribute: { schemaName: 'new_name', displayName: 'Name', required: true }, columns: [] },
  ], relationships: [] };
  const runner = makeRunner({ emit: () => {}, total: 10 });
  await provisionDataModel({ sdk: m.sdk, provision: m.provision, runner, spec, apply: true });
  assert.deepStrictEqual(
    m.calls.find((c) => c[0] === 'updateColumn'),
    ['updateColumn', 'new_ticket', 'new_name', { required: 'ApplicationRequired' }]
  );
});

test('provisionDataModel reads RequiredLevel once when discovery omits it', async () => {
  const m = mockSdk({ new_ticket: true });
  const rawGets = [];
  m.provision.findColumns = async () => [
    { logicalName: 'new_priority', schemaName: 'new_priority' },
  ];
  m.sdk.dataverse = {
    get: async (url) => {
      rawGets.push(url);
      return {
        status: 200,
        body: { value: [{ LogicalName: 'new_priority', RequiredLevel: { Value: 'None' } }] },
      };
    },
  };
  const spec = { solution: { uniqueName: 'S', publisherPrefix: 'new' }, entities: [
    { schemaName: 'new_ticket', displayName: 'Ticket', primaryAttribute: { schemaName: 'new_name' },
      columns: [{ schemaName: 'new_priority', type: 'Text', required: true }] },
  ], relationships: [] };
  const runner = makeRunner({ emit: () => {}, total: 10 });
  await provisionDataModel({ sdk: m.sdk, provision: m.provision, runner, spec, apply: true });
  assert.strictEqual(rawGets.length, 1, 'one entity-level metadata read supplies all required levels');
  assert.match(rawGets[0], /\/EntityDefinitions\(LogicalName='new_ticket'\)\/Attributes\?\$select=LogicalName,RequiredLevel/);
  assert.ok(m.calls.some((c) => c[0] === 'updateColumn' && c[3].required === 'ApplicationRequired'));
});

test('provisionDataModel binds the reused global-choice metadataId on an idempotent re-run (SDK probe-then-reuse)', async () => {
  const m = mockSdk();
  // The global option set already exists. The SDK's createGlobalOptionSet is now IDEMPOTENT: it probes
  // by Name and RETURNS the existing set's { name, metadataId } instead of throwing a duplicate-Name
  // error. So the engine captures that id and the column binds to it (globalChoiceMetadataId) — the fix
  // for the old bug where the id was lost on a rebuild and every column fell back to inline options.
  m.sdk.createGlobalOptionSet = async ({ name }) => ({ name, metadataId: 'gc-existing' });
  const seen = {};
  m.sdk.createColumn = async (l, o) => { seen[o.schemaName] = o; return { logicalName: o.schemaName.toLowerCase(), metadataId: `col-${o.schemaName}` }; };
  const spec = {
    solution: { uniqueName: 'S', publisherPrefix: 'new' },
    globalChoices: [{ name: 'new_sev', displayName: 'Sev', options: ['Low', 'High', 'Critical'] }],
    entities: [
      { schemaName: 'new_ticket', displayName: 'Ticket', primaryAttribute: { schemaName: 'new_name' },
        columns: [{ schemaName: 'new_severity', type: 'Choice', globalChoice: 'new_sev' }] },
    ],
    relationships: [],
  };
  const runner = makeRunner({ emit: () => {}, total: 10 });
  await provisionDataModel({ sdk: m.sdk, provision: m.provision, runner, spec, apply: true });
  assert.ok(seen['new_severity'], 'severity column still created');
  assert.strictEqual(seen['new_severity'].globalChoiceMetadataId, 'gc-existing', 'column bound to the reused global-choice metadataId (no fallback to inline options)');
  assert.ok(!seen['new_severity'].options, 'no inline options — it bound to the global choice by id');
});

test('provisionDataModel halts the phase on a REAL global-choice failure (no longer swallowed)', async () => {
  const m = mockSdk();
  // A genuine failure (400 validation / auth) is NOT an "already exists" — the idempotent SDK only
  // reuses on a name collision, so a real error must surface as a clean phase halt, not be swallowed
  // (the old catch swallowed ALL errors, hiding real failures).
  m.sdk.createGlobalOptionSet = async () => { const e = new Error('Invalid option set name'); e.statusCode = 400; throw e; };
  const spec = {
    solution: { uniqueName: 'S', publisherPrefix: 'new' },
    globalChoices: [{ name: 'new_sev', displayName: 'Sev', options: ['Low', 'High'] }],
    entities: [
      { schemaName: 'new_ticket', displayName: 'Ticket', primaryAttribute: { schemaName: 'new_name' }, columns: [] },
    ],
    relationships: [],
  };
  const runner = makeRunner({ emit: () => {}, total: 10 });
  await assert.rejects(
    () => provisionDataModel({ sdk: m.sdk, provision: m.provision, runner, spec, apply: true }),
    /data-model failed.*Invalid option set name/,
    'a real global-choice error halts the data-model phase'
  );
});

test('provisionDataModel enables quick-create when entities[].quickCreate is true (updateTable IsQuickCreateEnabled)', async () => {
  const m = mockSdk();
  const spec = { solution: { uniqueName: 'S', publisherPrefix: 'new' }, entities: [
    { schemaName: 'new_ticket', displayName: 'Ticket', primaryAttribute: { schemaName: 'new_name' }, columns: [], quickCreate: true },
  ], relationships: [] };
  const runner = makeRunner({ emit: () => {}, total: 10 });
  await provisionDataModel({ sdk: m.sdk, provision: m.provision, runner, spec, apply: true });
  const call = m.calls.find((c) => c[0] === 'updateTable');
  assert.ok(call, 'updateTable was called to enable quick create');
  assert.strictEqual(call[1], 'new_ticket', 'updateTable targeted the table logical name');
  assert.strictEqual(call[2].quickCreateEnabled, true, 'quickCreateEnabled:true passed to updateTable');
});

test('provisionDataModel enables quick-create when an authored QuickCreate form exists (derived, no explicit flag)', async () => {
  const m = mockSdk();
  // No explicit entities[].quickCreate, but the spec authors a QuickCreate form → the flag is derived
  // so the authored form is actually reachable from the inline "+ New" (footgun removal).
  const spec = { solution: { uniqueName: 'S', publisherPrefix: 'new' }, entities: [
    { schemaName: 'new_ticket', displayName: 'Ticket', primaryAttribute: { schemaName: 'new_name' }, columns: [] },
  ], forms: [{ entity: 'new_ticket', name: 'QC', formType: 'QuickCreate' }], relationships: [] };
  const runner = makeRunner({ emit: () => {}, total: 10 });
  await provisionDataModel({ sdk: m.sdk, provision: m.provision, runner, spec, apply: true });
  assert.ok(m.calls.some((c) => c[0] === 'updateTable' && c[1] === 'new_ticket' && c[2].quickCreateEnabled === true), 'quick-create enabled from the authored QuickCreate form');
});

test('provisionDataModel does NOT enable quick-create when neither the flag nor a QuickCreate form is present', async () => {
  const m = mockSdk();
  const spec = { solution: { uniqueName: 'S', publisherPrefix: 'new' }, entities: [
    { schemaName: 'new_ticket', displayName: 'Ticket', primaryAttribute: { schemaName: 'new_name' }, columns: [] },
  ], forms: [{ entity: 'new_ticket', name: 'Main' }], relationships: [] };
  const runner = makeRunner({ emit: () => {}, total: 10 });
  await provisionDataModel({ sdk: m.sdk, provision: m.provision, runner, spec, apply: true });
  assert.ok(!m.calls.some((c) => c[0] === 'updateTable'), 'updateTable is not called without an opt-in');
});

test('provisionDataModel enables quick-create even for an EXISTING (reused) table (idempotent flag)', async () => {
  const m = mockSdk({ new_ticket: true });
  const spec = { solution: { uniqueName: 'S', publisherPrefix: 'new' }, entities: [
    { schemaName: 'new_ticket', displayName: 'Ticket', primaryAttribute: { schemaName: 'new_name' }, columns: [], quickCreate: true },
  ], relationships: [] };
  const runner = makeRunner({ emit: () => {}, total: 10 });
  await provisionDataModel({ sdk: m.sdk, provision: m.provision, runner, spec, apply: true });
  assert.ok(!m.calls.some((c) => c[0] === 'createTable'), 'existing table not re-created');
  assert.ok(m.calls.some((c) => c[0] === 'updateTable' && c[2].quickCreateEnabled === true), 'quick-create flag still applied to the reused table');
});

test('provisionDataModel still throws on NON-already-exists createTable error', async () => {
  const m = mockSdk();
  // createTable throws a different error (bad request, not already-exists)
  m.sdk.createTable = async () => {
    const err = new Error('Invalid schema name');
    err.statusCode = 400;
    throw err;
  };

  const spec = { solution: { uniqueName: 'S', publisherPrefix: 'new' }, entities: [
    { schemaName: 'new_ticket', displayName: 'Ticket', primaryAttribute: { schemaName: 'new_name' }, columns: [] },
  ], relationships: [] };
  const runner = makeRunner({ emit: () => {}, total: 10 });

  // Should throw - this is NOT an already-exists error
  await assert.rejects(
    async () => await provisionDataModel({ sdk: m.sdk, provision: m.provision, runner, spec, apply: true, concurrency: 2 }),
    /Invalid schema name/,
    'non-already-exists error should still halt'
  );
});

test('provisionDataModel recovers from createRelationship already-exists error (1:N)', async () => {
  const m = mockSdk({ new_ticket: true, new_customer: true });
  // createRelationship throws an already-exists error
  m.sdk.createRelationship = async () => {
    const err = new Error('Relationship with the same name already exists');
    err.statusCode = 409;
    throw err;
  };

  const spec = {
    solution: { uniqueName: 'S', publisherPrefix: 'new' },
    entities: [
      { schemaName: 'new_ticket', displayName: 'Ticket', primaryAttribute: { schemaName: 'new_name' }, columns: [] },
      { schemaName: 'new_customer', displayName: 'Customer', primaryAttribute: { schemaName: 'new_name' }, columns: [] }
    ],
    relationships: [
      { type: 'OneToMany', referenced: 'new_customer', referencing: 'new_ticket',
        lookup: { schemaName: 'new_customerId', displayName: 'Customer' } }
    ]
  };
  const runner = makeRunner({ emit: () => {}, total: 10 });

  // Should not throw - relationship create should skip on already-exists
  const dm = await provisionDataModel({ sdk: m.sdk, provision: m.provision, runner, spec, apply: true, concurrency: 2 });

  assert.ok(dm.entities['new_ticket'], 'tables created despite relationship error');
  // Relationship not captured because skipIf returned undefined
  assert.strictEqual(dm.relationships.length, 0, 'relationship not captured on skip');
});

// --- buildSeedGroup: App Spec -> seedRecordGraph group translation -----------------------------

const seedSpec = () => ({
  solution: { uniqueName: 'S', publisherPrefix: 'new' },
  entities: [
    { schemaName: 'new_customer', displayName: 'Customer', primaryAttribute: { schemaName: 'new_name' }, columns: [{ schemaName: 'new_tier', type: 'Choice', options: ['Free', 'Pro'] }] },
    { schemaName: 'new_ticket', displayName: 'Ticket', primaryAttribute: { schemaName: 'new_name' }, columns: [] },
  ],
  relationships: [
    { type: 'OneToMany', referenced: 'new_customer', referencing: 'new_ticket', lookup: { schemaName: 'new_CustomerId', displayName: 'Customer' } },
  ],
  sampleData: {
    new_customer: [{ new_name: 'Acme', new_tier: 'Pro' }],
    new_ticket: [{ new_name: 'T1', $parent: { entity: 'new_customer', match: { new_name: 'Acme' } } }],
  },
});

test('buildSeedGroup resolves choice labels to option ints in the body', () => {
  const spec = seedSpec();
  const group = buildSeedGroup({ spec, e: spec.entities[0], records: spec.sampleData.new_customer, statusReasonValues: {} });
  assert.strictEqual(group.entityLogical, 'new_customer');
  // matchOn (opt-in idempotency key) replaced the retired primaryAttribute. new_customer's sample
  // record sets a non-empty new_name, and the entity declares no alternate key, so the primary name
  // column is the backward-compatible key.
  assert.strictEqual(group.matchOn, 'new_name');
  assert.strictEqual(group.primaryAttribute, undefined, 'retired key must not be emitted');
  assert.strictEqual(group.records[0].body.new_tier, 100000001, 'Pro -> 100000001');
  assert.deepStrictEqual(group.records[0].binds, []);
});

test('buildSeedGroup translates $parent.match into a lookup bind (parentIndex) and strips the sentinel', () => {
  const spec = seedSpec();
  const group = buildSeedGroup({ spec, e: spec.entities[1], records: spec.sampleData.new_ticket, statusReasonValues: {} });
  assert.deepStrictEqual(group.records[0].binds, [{ navProperty: 'new_CustomerId', parentEntity: 'new_customer', parentIndex: 0 }]);
  assert.strictEqual(group.records[0].body.$parent, undefined, 'sentinel stripped from body');
  assert.strictEqual(group.records[0].body['new_CustomerId@odata.bind'], undefined, 'no @odata.bind baked in (SDK forms it)');
});

test('#1 buildSeedGroup THROWS (not silently drops) when a $parent.match resolves to no parent row', () => {
  const spec = seedSpec();
  // No new_customer row matches this -> the bind cannot be formed. Before #1 this was a silent skip
  // that created the ticket with new_CustomerId UNSET while still reporting success.
  spec.sampleData.new_ticket[0].$parent = { entity: 'new_customer', match: { new_name: 'Ghost' } };
  assert.throws(
    () => buildSeedGroup({ spec, e: spec.entities[1], records: spec.sampleData.new_ticket, statusReasonValues: {} }),
    /found no 'new_customer' sample record|left unset/,
  );
});

test('#1 buildSeedGroup THROWS when a declared $parent has no OneToMany relationship to the child', () => {
  const spec = seedSpec();
  spec.relationships = []; // remove the customer->ticket relationship
  assert.throws(
    () => buildSeedGroup({ spec, e: spec.entities[1], records: spec.sampleData.new_ticket, statusReasonValues: {} }),
    /no OneToMany relationship/,
  );
});

test('buildSeedGroup resolves a custom statusReason to statuscode/statecode', () => {
  const spec = seedSpec();
  spec.sampleData.new_ticket[0].statusReason = 'Escalated';
  const statusReasonValues = { new_ticket: { Escalated: { value: 100000005, stateCode: 0 } } };
  const group = buildSeedGroup({ spec, e: spec.entities[1], records: spec.sampleData.new_ticket, statusReasonValues });
  assert.strictEqual(group.records[0].body.statuscode, 100000005);
  assert.strictEqual(group.records[0].body.statecode, 0);
  assert.strictEqual(group.records[0].body.statusReason, undefined, 'sentinel stripped');
});

test('buildSeedGroup halts when a statusReason value was not captured (data-model phase skipped)', () => {
  const spec = seedSpec();
  spec.sampleData.new_ticket[0].statusReason = 'Escalated';
  assert.throws(
    () => buildSeedGroup({ spec, e: spec.entities[1], records: spec.sampleData.new_ticket, statusReasonValues: {} }),
    /status value wasn't captured/
  );
});

test('buildSeedGroup prefers a single-column alternate key as matchOn over the primary name', () => {
  const spec = seedSpec();
  // Declare a single-column alternate key on new_customer; its column is set (non-empty) in the sample.
  spec.entities[0].alternateKeys = [{ schemaName: 'new_codekey', columns: ['new_code'] }];
  spec.sampleData.new_customer = [{ new_name: 'Acme', new_tier: 'Pro', new_code: 'AC-1' }];
  const group = buildSeedGroup({ spec, e: spec.entities[0], records: spec.sampleData.new_customer, statusReasonValues: {} });
  assert.strictEqual(group.matchOn, 'new_code', 'alt-key column wins over primary name');
});

test('buildSeedGroup omits matchOn (no dedup) when the key value is empty in a record', () => {
  const spec = seedSpec();
  // A record with no primary name value and no alternate key -> no safe dedup key -> omit matchOn.
  spec.sampleData.new_customer = [{ new_tier: 'Pro' }];
  const group = buildSeedGroup({ spec, e: spec.entities[0], records: spec.sampleData.new_customer, statusReasonValues: {} });
  assert.strictEqual(group.matchOn, undefined, 'no non-empty key -> every record inserted');
  assert.ok(!('primaryAttribute' in group));
});

// --- provisionSampleData: F9 keyless-seeding warning ------------------------------------------
function runSample(spec) {
  // The F9 warning goes to stderr (non-fatal), so capture stderr for the duration of the run.
  const origWrite = process.stderr.write.bind(process.stderr);
  const warnings = [];
  process.stderr.write = (s) => { warnings.push(String(s)); return true; };
  const runner = makeRunner({ emit: () => {}, total: 1 });
  const sdk = { seedRecordGraph: async () => ({ createdIds: { new_log: ['id1', 'id2'] } }) };
  const dataModel = { entities: { new_log: { logicalName: 'new_log', entitySetName: 'new_logs' } }, statusReasonValues: {} };
  return provisionSampleData({ sdk, provision: {}, runner, spec, dataModel })
    .then(() => warnings)
    .finally(() => { process.stderr.write = origWrite; });
}

test('provisionSampleData WARNS in the op label when a group has no idempotency key — a re-run would duplicate (F9)', async () => {
  const spec = {
    solution: { uniqueName: 'S', publisherPrefix: 'new' },
    entities: [{ schemaName: 'new_log', displayName: 'Log', primaryAttribute: { schemaName: 'new_name' }, columns: [] }],
    relationships: [],
    sampleData: { new_log: [{ new_tier: 'x' }, {}] }, // no non-empty new_name + no alt-key -> matchOn undefined
  };
  const labels = await runSample(spec);
  assert.ok(labels.some((l) => /no idempotency key/.test(l)), `expected a keyless-seeding warning; got ${JSON.stringify(labels)}`);
});

test('provisionSampleData does NOT warn when the primary name gives a stable key (F9)', async () => {
  const spec = {
    solution: { uniqueName: 'S', publisherPrefix: 'new' },
    entities: [{ schemaName: 'new_log', displayName: 'Log', primaryAttribute: { schemaName: 'new_name' }, columns: [] }],
    relationships: [],
    sampleData: { new_log: [{ new_name: 'A' }, { new_name: 'B' }] },
  };
  const labels = await runSample(spec);
  assert.ok(!labels.some((l) => /no idempotency key/.test(l)), 'a keyed spec must not warn');
});

test('provisionSolution ESCAPES the solution uniquename in the OData filter (F12 — no injection/break)', async () => {
  const calls = [];
  const provision = { queryRecords: async (set, opts) => { calls.push({ set, filter: opts.filter }); return set === 'solution' ? [{ solutionid: 's' }] : []; } };
  const runner = makeRunner({ emit: () => {}, total: 1 });
  await provisionSolution({ sdk: {}, provision, runner, solution: { uniqueName: "O'Brien", publisherPrefix: 'new' } });
  const q = calls.find((c) => c.set === 'solution');
  assert.match(q.filter, /uniquename eq 'O''Brien'/, "single quote must be doubled (OData string-literal escaping)");
});

test('requireSuccessfulPush passes a successful result through unchanged', () => {
  const ok = { type: 'form', id: 'f1', success: true };
  assert.strictEqual(requireSuccessfulPush(ok, 'form f1'), ok);
});

test('requireSuccessfulPush halts (BuildHalt) on a 412 version-conflict result', () => {
  const conflict = { type: 'app', id: 'a1', success: false, error: new Error('version conflict') };
  assert.throws(
    () => requireSuccessfulPush(conflict, 'app a1'),
    (err) => err.name === 'BuildHalt' && /re-download the app and rebuild/.test(err.message) && err.code === 'version-conflict'
  );
});

// The SDK renamed `PushResult.success` to `saved` deliberately — its own type comment says the
// rename exists to "force every existing call site to be looked at once". This guard is such a call
// site, and it is the ONLY thing standing between a 412 and a silently dropped Maker edit.
//
// The danger is that the rename is invisible at runtime: a `success === false` check against a
// bundle that returns `saved` reads `undefined === false` -> false, so the guard just stops firing.
// Nothing fails, nothing logs, and a concurrent edit is overwritten. These pin BOTH spellings so the
// guard cannot be silently disarmed by a re-vendor in either direction.
test('requireSuccessfulPush halts on the RENAMED PushResult shape (saved:false), not just success:false', () => {
  const conflict = { type: 'form', id: 'f9', saved: false, shipped: false, error: new Error('Version conflict (412)') };
  assert.throws(
    () => requireSuccessfulPush(conflict, 'form f9'),
    (err) => err.name === 'BuildHalt' && err.code === 'version-conflict' && /Version conflict \(412\)/.test(err.message),
    'a saved:false result MUST halt — otherwise a 412 silently drops the edit'
  );
});

test('requireSuccessfulPush accepts a saved:true result and does not confuse saved with shipped', () => {
  // `shipped:false` is normal — it means the change is committed but the runtime still serves the
  // previously published copy. That is NOT a push failure and must not halt the build; the publish
  // phase is what makes it live.
  const saved = { type: 'view', id: 'v1', saved: true, shipped: false, publish: { kind: 'notRequested' } };
  assert.strictEqual(requireSuccessfulPush(saved, 'view v1'), saved);
});

test('requireSuccessfulPush halts on a result that carries an error but neither flag', () => {
  // Fail closed: an unrecognised shape that still reports an error must not be treated as success.
  const odd = { type: 'chart', id: 'c1', error: new Error('boom') };
  assert.throws(() => requireSuccessfulPush(odd, 'chart c1'), (err) => err.name === 'BuildHalt');
});

// #447 regression net. The bug this fixes was a SINGLE label-emitting call that forgot to pass a
// language, and it stayed invisible until a user in a German org filed a bug — CI runs offline mocks
// and nobody's CI runs against a non-1033 org. So pinning only the two call sites that happened to be
// mutation-tested leaves the same detection gap for the other six.
//
// This asserts GENERICALLY: every recorded SDK call that carries a label must carry the resolved LCID.
// A new label-emitting call added later is therefore covered by construction rather than by someone
// remembering to extend a list.
test('EVERY label-emitting SDK call carries the resolved language code (#447)', async () => {
  const seen = [];
  const rec = (name) => (...args) => {
    // The options object is the last argument for every one of these SDK signatures.
    seen.push({ name, opts: args[args.length - 1] });
    return {};
  };

  const sdk = {
    createGlobalOptionSet: async (...a) => { seen.push({ name: 'createGlobalOptionSet', opts: a[0] }); return { metadataId: 'g1' }; },
    createTable: async (...a) => { seen.push({ name: 'createTable', opts: a[0] }); return { logicalName: a[0].schemaName.toLowerCase(), entitySetName: a[0].schemaName.toLowerCase() + 's', metadataId: 't1' }; },
    createColumn: async (...a) => { seen.push({ name: 'createColumn', opts: a[1] }); return { logicalName: a[1].schemaName.toLowerCase(), metadataId: 'c1' }; },
    createCustomerColumn: async (...a) => { seen.push({ name: 'createCustomerColumn', opts: a[1] }); return { logicalName: a[1].schemaName.toLowerCase(), metadataId: 'c2' }; },
    insertStatusValue: async (...a) => { seen.push({ name: 'insertStatusValue', opts: a[1] }); return 100000000; },
    createAlternateKey: async (...a) => { seen.push({ name: 'createAlternateKey', opts: a[1] }); return {}; },
    createRelationship: async (...a) => { seen.push({ name: 'createRelationship', opts: a[0] }); return { schemaName: a[0].schemaName, metadataId: 'r1' }; },
    updateTable: rec('updateTable'),
  };
  const provision = {
    findTables: async () => [],
    findColumns: async () => [],
    fetchEntityMetadata: async (l) => ({ logicalName: l, entitySetName: l + 's', relationships: [] }),
    queryRecords: async (set) => (set === 'organization' ? [{ languagecode: 1031 }] : [{ solutionid: 's' }]),
  };

  // A spec that reaches all seven call sites in one pass.
  const spec = {
    solution: { uniqueName: 'Cover', publisherPrefix: 'cr' },
    globalChoices: [{ name: 'cr_pri', displayName: 'Priority', options: ['Low', 'High'] }],
    entities: [
      { schemaName: 'cr_parent', displayName: 'Parent', pluralName: 'Parents',
        primaryAttribute: { schemaName: 'cr_name', displayName: 'Name' },
        columns: [
          { schemaName: 'cr_when', displayName: 'When', type: 'DateTime' },
          { schemaName: 'cr_cust', displayName: 'Cust', type: 'Customer' },
        ],
        statusReasons: [{ label: 'Open', state: 'Active' }],
        alternateKeys: [{ schemaName: 'cr_key', displayName: 'Key', columns: ['cr_name'] }] },
      { schemaName: 'cr_child', displayName: 'Child', pluralName: 'Children',
        primaryAttribute: { schemaName: 'cr_cname', displayName: 'CName' }, columns: [] },
      { schemaName: 'cr_tag', displayName: 'Tag', pluralName: 'Tags',
        primaryAttribute: { schemaName: 'cr_tname', displayName: 'TName' }, columns: [] },
    ],
    relationships: [
      { type: 'OneToMany', referenced: 'cr_parent', referencing: 'cr_child', lookup: { schemaName: 'cr_ParentId', displayName: 'Parent' } },
      { type: 'ManyToMany', entity1: 'cr_parent', entity2: 'cr_tag' },
    ],
  };

  const runner = makeRunner({ emit: () => {}, total: 99 });
  await provisionDataModel({ sdk, provision, runner, spec, apply: true });

  // `updateTable` is deliberately excluded: with only `quickCreateEnabled` the SDK builds no Label at
  // all, it round-trips Dataverse's own labels under MSCRM.MergeLabels. Passing a language there would
  // be noise, not safety.
  const LABEL_EMITTING = new Set([
    'createGlobalOptionSet', 'createTable', 'createColumn', 'createCustomerColumn',
    'insertStatusValue', 'createAlternateKey', 'createRelationship',
  ]);

  const emitted = seen.filter((c) => LABEL_EMITTING.has(c.name));
  const names = new Set(emitted.map((c) => c.name));
  for (const expected of LABEL_EMITTING) {
    assert.ok(names.has(expected), `${expected} was never exercised — this test no longer covers it`);
  }

  const missing = emitted.filter((c) => !c.opts || c.opts.languageCode !== 1031);
  assert.deepStrictEqual(
    missing.map((c) => c.name), [],
    'these label-emitting calls did not carry the resolved LCID: ' + JSON.stringify(missing.map((c) => c.name))
  );
});

// The SDK moved publishArtifact from THROWING to reporting by value, exactly as it did for
// pushArtifact. Nothing in the engine read the result, so every publish failure vanished into a
// build that reported ok:true -- and because those failures no longer throw, the transient-retry
// path (429 / 503 / customization-lock, which is the everyday PublishXml failure in a real tenant)
// became unreachable for them. These pin the reporting so it cannot silently regress again.
test('a FAILED publish is reported, not swallowed', () => {
  const warnings = [];
  const result = { type: 'form', id: 'f1', shipped: false, publish: { kind: 'failed', error: new Error('PublishXml 503') } };
  reportPartialPush(result, 'form Contact Main', (m) => warnings.push(m));
  assert.strictEqual(warnings.length, 1, 'a failed publish must produce exactly one warning');
  assert.match(warnings[0], /publish form Contact Main FAILED/);
  assert.match(warnings[0], /PublishXml 503/, 'the underlying cause is named');
  assert.match(warnings[0], /SAVED but/, 'it must say the write survived — this is not a lost edit');
});

test('an UNVERIFIABLE publish is reported as unproven rather than as success', () => {
  const warnings = [];
  reportPartialPush({ type: 'app', id: 'a1', shipped: false, publish: { kind: 'unverifiable', reason: 'projection not readable' } }, 'app Contoso', (m) => warnings.push(m));
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /could not be CONFIRMED/);
  assert.match(warnings[0], /projection not readable/);
});

test('a verified publish and a not-requested publish are both silent', () => {
  const warnings = [];
  reportPartialPush({ type: 'view', id: 'v1', shipped: true, publish: { kind: 'verified' } }, 'view V', (m) => warnings.push(m));
  reportPartialPush({ type: 'view', id: 'v2', shipped: false, publish: { kind: 'notRequested' } }, 'view V2', (m) => warnings.push(m));
  assert.deepStrictEqual(warnings, [], 'success and no-publish-requested must not warn');
});

// PushResult.warnings exists specifically so a partial success is not read as a clean one. The SDK's
// own comment on the app path says a failed system-admin role assignment "must not fail app creation,
// but it is reported so a create that produced an UNOPENABLE app is not read as a clean success".
test('a push that COMMITTED but carries warnings surfaces them (an unopenable app is not a clean success)', () => {
  const warnings = [];
  const result = {
    type: 'app', id: 'a2', saved: true, shipped: false, publish: { kind: 'notRequested' },
    warnings: ['one or more components were not pinned', 'system administrator role could not be assigned'],
  };
  assert.strictEqual(requireSuccessfulPush(result, 'app Contoso', (m) => warnings.push(m)), result, 'it still passes — the write committed');
  assert.strictEqual(warnings.length, 2, 'both warnings surface: ' + JSON.stringify(warnings));
  assert.ok(warnings.every((w) => /^app Contoso: /.test(w)), 'each names the artifact');
});

test('a saved push whose publish failed is reported even though the push itself passes', () => {
  // App CREATE publishes inside the SDK, so this arrives as saved:true + publish:failed with no
  // top-level error — the shape the push guard alone would wave straight through.
  const warnings = [];
  const result = { type: 'app', id: 'a3', saved: true, shipped: false, publish: { kind: 'failed', error: new Error('saved, but publishing failed') } };
  requireSuccessfulPush(result, 'app Contoso', (m) => warnings.push(m));
  assert.ok(warnings.some((w) => /publish app Contoso FAILED/.test(w)), JSON.stringify(warnings));
});

test('requireSuccessfulPush distinguishes an already-exists collision from a version conflict', () => {
  // Both are by-value failures, but the remedies are opposite: re-download for a concurrent edit,
  // adopt-the-existing-row for a replayed create. Reporting one as the other sends the operator
  // to re-download when nothing changed under them.
  const err = new Error('a record already exists at that id');
  err.code = 'ARTIFACT_ALREADY_EXISTS';
  assert.throws(
    () => requireSuccessfulPush({ type: 'view', id: 'v9', saved: false, error: err }, 'view V9'),
    (e) => e.name === 'BuildHalt' && e.code === 'already-exists' && /adopt it/.test(e.message) && !/re-download the app/.test(e.message)
  );
});

// The set of by-value push failures is OPEN and it grows: the SDK keeps moving failures from a throw
// to a return. Every newly-returned one used to land on the "changed in Maker" wording, which named
// a cause that could not possibly apply and sent the operator to re-download an untouched app.
test('requireSuccessfulPush reports an UNRECOGNISED SDK code verbatim, and propagates the code', () => {
  const err = new Error("Business-rule authoring (preview) is not enabled on this environment yet: it does not expose 'Microsoft.Dynamics.CRM.CreateProcessWithWfomJson'.");
  err.code = 'BUSINESS_RULE_API_UNAVAILABLE';
  assert.throws(
    () => requireSuccessfulPush({ type: 'businessRule', id: 'br1', saved: false, error: err }, 'business rule R'),
    (e) => {
      assert.strictEqual(e.name, 'BuildHalt');
      // The code is propagated so a phase-level `skipIf` can still match on it after the wrap.
      assert.strictEqual(e.code, 'BUSINESS_RULE_API_UNAVAILABLE', `got ${e.code}`);
      assert.strictEqual(e.cause, err, 'the SdkError must remain reachable as the cause');
      assert.match(e.message, /not enabled on this environment/, 'the SDK\'s own diagnosis is what the operator needs');
      assert.doesNotMatch(e.message, /changed in Maker since it was fetched/,
        'a cause the SDK named must not be overwritten with a guess');
      return true;
    }
  );
});

test('errorCodeChain reads codes through the cause chain, and cannot spin on a cycle', () => {
  // `skipIf` predicates are handed whatever reached the runner. A failure the SDK reports BY VALUE
  // arrives wrapped in a BuildHalt, so the SDK's own code is one level down; reading only the top
  // level silently misses it.
  const inner = Object.assign(new Error('inner'), { code: 'SDK_CODE' });
  const outer = new BuildHalt('outer', { code: 'push-failed', cause: inner });
  assert.deepStrictEqual(errorCodeChain(outer), ['push-failed', 'SDK_CODE']);
  assert.deepStrictEqual(errorCodeChain(inner), ['SDK_CODE']);
  assert.deepStrictEqual(errorCodeChain(new Error('no code')), []);
  assert.deepStrictEqual(errorCodeChain(null), []);
  assert.deepStrictEqual(errorCodeChain(undefined), []);

  // A self-referential cause is not hypothetical — it happens when an error is re-wrapped with
  // itself — and an unbounded walk would hang the build rather than fail it.
  const loop = Object.assign(new Error('loop'), { code: 'A' });
  loop.cause = loop;
  assert.deepStrictEqual(errorCodeChain(loop), ['A']);

  // Depth is bounded even for a long, non-cyclic chain.
  let deep = Object.assign(new Error('d0'), { code: 'C0' });
  for (let i = 1; i < 10; i += 1) deep = Object.assign(new Error(`d${i}`), { code: `C${i}`, cause: deep });
  assert.strictEqual(errorCodeChain(deep).length, 5, 'the walk stops at maxDepth');
});

// #455 wiring: the CLI resolves the authoring LCID BEFORE constructing the SDK (because
// MakerSdkOptions.languageCode is a construction-time option) and then hands the SAME value to the
// data-model phase. Two things must hold, and neither is covered by testing resolveLanguageCode
// alone: the pre-resolved value must be USED, and it must NOT be re-resolved.
//
// Re-resolution is not merely wasteful — the data-model phase would repeat the org read and the
// provisioned-languages probe, and any disagreement would label columns in one language while the
// SDK stamps FormXML and sitemap titles in another.
test('a pre-resolved authoring language is used verbatim by the data-model phase', async () => {
  const spec = {
    solution: { uniqueName: 'S', publisherPrefix: 'cr' },
    entities: [{ schemaName: 'cr_t', displayName: 'T', pluralName: 'Ts', primaryAttribute: { schemaName: 'cr_name' }, columns: [{ schemaName: 'cr_note', displayName: 'Note', type: 'text' }] }],
    relationships: [],
  };
  const seen = [];
  let orgReads = 0;
  let probes = 0;
  const sdk = {
    createTable: async (o) => { seen.push(['createTable', o]); return { logicalName: 'cr_t', metadataId: 't' }; },
    createColumn: async (l, o) => { seen.push(['createColumn', o]); return { logicalName: (o.schemaName || '').toLowerCase(), metadataId: 'c' }; },
  };
  const provision = {
    queryRecords: async (set) => { if (set === 'organization') { orgReads += 1; return [{ languagecode: 1033 }]; } return []; },
    findTables: async () => [], findColumns: async () => [], fetchEntityMetadata: async () => ({}),
  };
  const runner = makeRunner({ emit: () => {}, total: 10 });

  await provisionDataModel({
    sdk, provision, runner, spec, apply: true,
    preResolvedLanguageCode: 3082,
    // Deliberately CONTRADICTORY inputs: if the pre-resolved value is honoured, neither of these is
    // consulted. If it is ignored, the explicit 1031 would win and the probe would fire.
    languageCode: 1031,
    provisionedLanguages: async () => { probes += 1; return [1031, 1033]; },
  });

  const withLang = seen.filter(([, o]) => o && o.languageCode !== undefined);
  assert.ok(withLang.length > 0, 'at least one label-bearing write happened');
  for (const [what, o] of withLang) {
    assert.strictEqual(o.languageCode, 3082, `${what} must use the pre-resolved LCID, not re-resolve one`);
  }
  assert.strictEqual(orgReads, 0, 'the org language must NOT be read again once it is already resolved');
  assert.strictEqual(probes, 0, 'the provisioned-languages probe must NOT fire again');
});

test('without a pre-resolved language the data-model phase still resolves one itself', async () => {
  // The self-resolving path is not dead code: provision-entities.js and every existing unit test
  // reach provisionDataModel without a pre-resolved value, so removing it would break them.
  const spec = {
    solution: { uniqueName: 'S', publisherPrefix: 'cr' },
    entities: [{ schemaName: 'cr_t', displayName: 'T', pluralName: 'Ts', primaryAttribute: { schemaName: 'cr_name' }, columns: [] }],
    relationships: [],
  };
  const seen = [];
  const sdk = {
    createTable: async (o) => { seen.push(o); return { logicalName: 'cr_t', metadataId: 't' }; },
    createColumn: async (l, o) => { seen.push(o); return { logicalName: 'x', metadataId: 'c' }; },
  };
  const provision = {
    queryRecords: async (set) => (set === 'organization' ? [{ languagecode: 1031 }] : []),
    findTables: async () => [], findColumns: async () => [], fetchEntityMetadata: async () => ({}),
  };
  await provisionDataModel({ sdk, provision, runner: makeRunner({ emit: () => {}, total: 10 }), spec, apply: true });
  const withLang = seen.filter((o) => o && o.languageCode !== undefined);
  assert.ok(withLang.length > 0 && withLang.every((o) => o.languageCode === 1031),
    'the org base language is still resolved when nothing was pre-resolved');
});
