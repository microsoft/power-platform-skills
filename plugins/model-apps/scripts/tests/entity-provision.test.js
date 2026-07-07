'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { makeRunner, provisionDataModel } = require(path.join(__dirname, '..', 'lib', 'entity-provision.js'));

function mockSdk(existing = {}) {
  const calls = [];
  return {
    calls,
    sdk: {
      createTable: async (o) => { calls.push(['createTable', o.schemaName]); return { logicalName: o.schemaName.toLowerCase(), entitySetName: `${o.schemaName.toLowerCase()}s`, metadataId: `tbl-${o.schemaName}` }; },
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

test('provisionDataModel falls back to global-choice options when the option set pre-exists (idempotent re-run)', async () => {
  const m = mockSdk();
  // The global option set already exists: createGlobalOptionSet throws already-exists, so its
  // metadataId is never captured (the SDK has no reader). A globalChoice column must still build.
  m.sdk.createGlobalOptionSet = async () => { const e = new Error('already exists'); e.statusCode = 409; throw e; };
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
  assert.ok(seen['new_severity'], 'severity column still created (no crash on pre-existing global choice)');
  assert.ok(!seen['new_severity'].globalChoiceMetadataId, 'no metadataId bound (option set was not captured)');
  assert.deepStrictEqual(
    seen['new_severity'].options.map((o) => o.label),
    ['Low', 'High', 'Critical'],
    'fell back to the global choice declared options, not the column empty list'
  );
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
