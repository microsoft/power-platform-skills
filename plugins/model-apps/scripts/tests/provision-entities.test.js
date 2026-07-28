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
