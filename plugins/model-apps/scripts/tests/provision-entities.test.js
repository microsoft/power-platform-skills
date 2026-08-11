'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { provisionEntities } = require(path.join(__dirname, '..', 'provision-entities.js'));

const input = { solution: { uniqueName: 'Default', publisherPrefix: 'cr' },
  entities: [{ schemaName: 'cr_candidate', displayName: 'Candidate', pluralName: 'Candidates', primaryAttribute: { schemaName: 'cr_name' },
    columns: [{ schemaName: 'cr_status', type: 'Choice', options: ['Applied', 'Hired'] }] }], relationships: [] };

function mockDeps() {
  const calls = [];
  const sdk = {
    queryRecords: async () => [{ solutionid: 's' }], createPublisher: async () => ({ id: 'p' }), createSolution: async () => ({ id: 's' }),
    createTable: async (o) => { calls.push('createTable'); return { logicalName: o.schemaName.toLowerCase(), entitySetName: `${o.schemaName.toLowerCase()}s`, metadataId: `tbl-${o.schemaName}` }; },
    updateTable: async () => { calls.push('updateTable'); return {}; },
    createColumn: async (l, o) => { calls.push('createColumn'); return { logicalName: o.schemaName.toLowerCase(), metadataId: `col-${o.schemaName}` }; },
    createGlobalOptionSet: async () => ({ metadataId: 'g' }), insertStatusValue: async () => 1, createAlternateKey: async () => ({}),
    createCustomerColumn: async (l, o) => ({ logicalName: o.schemaName.toLowerCase(), metadataId: `col-${o.schemaName}` }),
    createRecordsBulk: async (e, rows) => rows.map((_, i) => `${e}-${i}`),
    createRelationship: async (o) => ({ schemaName: o.schemaName, metadataId: `rel-${o.schemaName}` }),
  };
  const provision = { findTables: async () => [], findColumns: async () => [], fetchEntityMetadata: async (l) => ({ logicalName: l, entitySetName: `${l}s`, relationships: [] }), queryRecords: async () => [{ solutionid: 's' }] };
  return { sdk, provision, calls };
}

test('dry-run validates + plans, no SDK writes', async () => {
  const d = mockDeps();
  const r = await provisionEntities(input, { apply: false }, { sdk: d.sdk, provision: d.provision });
  assert.strictEqual(r.dryRun, true);
  assert.strictEqual(d.calls.length, 0);
});

test('apply provisions and returns resolved names', async () => {
  const d = mockDeps();
  const r = await provisionEntities(input, { apply: true }, { sdk: d.sdk, provision: d.provision });
  assert.strictEqual(r.ok, true);
  assert.ok(d.calls.includes('createTable'));
  assert.strictEqual(r.entities[0].logicalName, 'cr_candidate');
  assert.strictEqual(r.entities[0].entitySetName, 'cr_candidates');
  assert.strictEqual(r.entities[0].metadataId, 'tbl-cr_candidate', 'entity metadataId surfaced');
  assert.ok(r.columns.length > 0, 'columns returned');
  assert.strictEqual(r.columns[0].logicalName, 'cr_status', 'column logicalName is real SDK value');
  assert.strictEqual(r.columns[0].metadataId, 'col-cr_status', 'column metadataId surfaced');
});

test('rejects an invalid input before any write', async () => {
  const d = mockDeps();
  const r = await provisionEntities({ solution: { uniqueName: 'Default' }, entities: [] }, { apply: true }, { sdk: d.sdk, provision: d.provision });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(d.calls.length, 0);
});

test('quick-create: the enable step is planned AND counted so [n/total] never drifts', async () => {
  // The provision-entities CLI has its OWN plan/count separate from sdk-build's planFor; both must
  // account for the quick-create step the shared provisionDataModel executes. This CLI input has no
  // forms[], so quickCreateEnabledFor fires only on an explicit entities[].quickCreate === true.
  const qcInput = {
    solution: { uniqueName: 'Default', publisherPrefix: 'cr' },
    entities: [{ schemaName: 'cr_candidate', displayName: 'Candidate', primaryAttribute: { schemaName: 'cr_name' }, quickCreate: true, columns: [] }],
    relationships: [],
  };
  // dry-run: the plan lists the enable step
  const dry = await provisionEntities(qcInput, { apply: false }, mockDeps());
  assert.ok(dry.plan.some((p) => /enable quick create on cr_candidate/.test(p)), 'dry-run plan includes the quick-create step');

  // apply: capture the [n/total] stream and prove n never exceeds total (count matches the executor)
  const d = mockDeps();
  const events = [];
  await provisionEntities(qcInput, { apply: true }, { sdk: d.sdk, provision: d.provision, emit: (e) => events.push(e) });
  assert.ok(d.calls.includes('updateTable'), 'the quick-create updateTable step ran');
  const total = events[0] && events[0].total;
  assert.ok(events.every((e) => e.n <= e.total), `no step emits n > total (total=${total})`);
  assert.ok(events.some((e) => /enable quick create/.test(e.label || '')), 'the quick-create step is narrated');
});

test('no quick-create step is planned/counted without the flag (regression guard)', async () => {
  const dry = await provisionEntities(input, { apply: false }, mockDeps());
  assert.ok(!dry.plan.some((p) => /enable quick create/.test(p)), 'no quick-create step without the opt-in');
});

test('dry-run plan includes non-trivial provision steps and skips non-actions', async () => {
  const rich = {
    solution: { uniqueName: 'Default', publisherPrefix: 'cr' },
    globalChoices: [{ name: 'cr_priority', options: ['Low', 'High'] }],
    entities: [
      {
        schemaName: 'cr_parent',
        displayName: 'Parent',
        primaryAttribute: { schemaName: 'cr_name' },
        columns: [
          { schemaName: 'cr_priority', type: 'Choice', globalChoice: 'cr_priority' },
          { schemaName: 'cr_childid', type: 'Lookup' },
        ],
        statusReasons: [{ label: 'Archived', state: 'Inactive' }],
        alternateKeys: [{ schemaName: 'cr_parent_key', columns: ['cr_name'] }],
      },
      { schemaName: 'cr_child', displayName: 'Child', primaryAttribute: { schemaName: 'cr_name' }, columns: [] },
    ],
    relationships: [
      { type: 'OneToMany', schemaName: 'cr_parent_children', referenced: 'cr_parent', referencing: 'cr_child', lookup: { schemaName: 'cr_parentid' } },
      { type: 'ManyToMany', schemaName: 'cr_parent_child_nn', entity1: 'cr_parent', entity2: 'cr_child' },
    ],
    sampleData: { cr_parent: [{ cr_name: 'A' }, { cr_name: 'B' }], cr_child: [] },
  };

  const dry = await provisionEntities(rich, { apply: false, sampleData: true }, mockDeps());

  assert.deepStrictEqual(dry.plan, [
    'solution Default',
    'global choice cr_priority',
    'table cr_parent',
    'column cr_parent.cr_priority (Choice)',
    'status reason cr_parent: Archived',
    'alt key cr_parent.cr_parent_key',
    'table cr_child',
    'relationship 1:N cr_parent->cr_child',
    'relationship N:N cr_parent<->cr_child',
    '2 record(s) -> cr_parent',
  ]);
});

test('apply surfaces fallback metadata for existing columns and relationships', async () => {
  const existingInput = {
    solution: { uniqueName: 'Default', publisherPrefix: 'cr' },
    entities: [
      { schemaName: 'cr_parent', displayName: 'Parent', primaryAttribute: { schemaName: 'cr_name' }, columns: [{ schemaName: 'cr_code', type: 'Text' }] },
      { schemaName: 'cr_child', displayName: 'Child', primaryAttribute: { schemaName: 'cr_name' }, columns: [] },
    ],
    relationships: [
      { type: 'OneToMany', schemaName: 'cr_parent_children', referenced: 'cr_parent', referencing: 'cr_child', lookup: { schemaName: 'cr_parentid' } },
      { type: 'ManyToMany', schemaName: 'cr_parent_child_nn', entity1: 'cr_parent', entity2: 'cr_child' },
    ],
  };
  const d = mockDeps();
  d.provision.findTables = async (schemaName) => [{ logicalName: schemaName.toLowerCase(), entitySetName: `${schemaName.toLowerCase()}s` }];
  d.provision.findColumns = async () => [{ logicalName: 'cr_code' }];
  d.provision.fetchEntityMetadata = async (logical) => ({
    logicalName: logical,
    entitySetName: `${logical}s`,
    relationships: [
      { schemaName: 'cr_parent_children' },
      { schemaName: 'cr_parent_child_nn' },
    ],
  });

  const r = await provisionEntities(existingInput, { apply: true }, { sdk: d.sdk, provision: d.provision });

  assert.deepStrictEqual(r.columns, [{ table: 'cr_parent', schemaName: 'cr_code', logicalName: 'cr_code' }]);
  assert.deepStrictEqual(r.relationships, [
    { kind: '1n', schemaName: 'cr_parent_children' },
    { kind: 'nn', schemaName: 'cr_parent_child_nn' },
  ]);
  assert.ok(!d.calls.includes('createColumn'), 'existing columns are not recreated');
});

test('apply seeds requested sample data and returns created record ids', async () => {
  const seedInput = {
    solution: { uniqueName: 'Default', publisherPrefix: 'cr' },
    entities: [{
      schemaName: 'cr_parent',
      displayName: 'Parent',
      primaryAttribute: { schemaName: 'cr_name' },
      columns: [],
      alternateKeys: [{ schemaName: 'cr_parent_key', columns: ['cr_name'] }],
    }],
    relationships: [],
    sampleData: { cr_parent: [{ cr_name: 'A' }, { cr_name: 'B' }] },
  };
  const d = mockDeps();
  let seedGroup;
  d.sdk.seedRecordGraph = async (groups) => {
    [seedGroup] = groups;
    return { createdIds: { cr_parent: ['id-a', 'id-b'] } };
  };

  const r = await provisionEntities(seedInput, { apply: true, sampleData: true }, { sdk: d.sdk, provision: d.provision });

  assert.strictEqual(seedGroup.matchOn, 'cr_name', 'a single-column alternate key makes sample seeding idempotent');
  assert.deepStrictEqual(r.records, { cr_parent: ['id-a', 'id-b'] });
});
