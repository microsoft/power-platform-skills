'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { makeRunner, requireSuccessfulPush, provisionDataModel, provisionSampleData, provisionSolution, buildSeedGroup } = require(path.join(__dirname, '..', 'lib', 'entity-provision.js'));

function mockSdk(existing = {}) {
  const calls = [];
  return {
    calls,
    sdk: {
      createTable: async (o) => { calls.push(['createTable', o.schemaName]); return { logicalName: o.schemaName.toLowerCase(), entitySetName: `${o.schemaName.toLowerCase()}s`, metadataId: `tbl-${o.schemaName}` }; },
      updateTable: async (l, o) => { calls.push(['updateTable', l, o]); return {}; },
      createColumn: async (l, o) => { calls.push(['createColumn', l, o.schemaName]); return { logicalName: o.schemaName.toLowerCase(), metadataId: `col-${o.schemaName}` }; },
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
