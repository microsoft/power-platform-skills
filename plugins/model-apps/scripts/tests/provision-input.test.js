'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { validateProvisionInput } = require(path.join(__dirname, '..', 'lib', 'provision-input.js'));

test('accepts a minimal valid input', () => {
  const r = validateProvisionInput({ solution: { uniqueName: 'Default', publisherPrefix: 'cr' },
    entities: [{ schemaName: 'cr_candidate', displayName: 'Candidate', primaryAttribute: { schemaName: 'cr_name' }, columns: [] }], relationships: [] });
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});

test('rejects a missing solution.publisherPrefix', () => {
  const r = validateProvisionInput({ solution: { uniqueName: 'Default' }, entities: [], relationships: [] });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /publisherPrefix/i.test(e)));
});

test('rejects an entity whose schemaName lacks a prefix', () => {
  const r = validateProvisionInput({ solution: { uniqueName: 'Default', publisherPrefix: 'cr' },
    entities: [{ schemaName: 'candidate', displayName: 'C', primaryAttribute: { schemaName: 'cr_name' }, columns: [] }], relationships: [] });
  assert.strictEqual(r.ok, false);
});

test('rejects a relationship referencing an unknown entity', () => {
  const r = validateProvisionInput({ 
    solution: { uniqueName: 'Default', publisherPrefix: 'cr' },
    entities: [{ schemaName: 'cr_candidate', displayName: 'Candidate', primaryAttribute: { schemaName: 'cr_name' }, columns: [] }],
    relationships: [{ type: 'OneToMany', referenced: 'cr_jobrequisition', referencing: 'cr_candidate', lookup: { schemaName: 'cr_jobrequisition' } }]
  });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /not found in entities/i.test(e)));
});

test('rejects a relationship with an unknown type', () => {
  const r = validateProvisionInput({
    solution: { uniqueName: 'Default', publisherPrefix: 'cr' },
    entities: [
      { schemaName: 'cr_candidate', displayName: 'Candidate', primaryAttribute: { schemaName: 'cr_name' }, columns: [] },
      { schemaName: 'cr_job', displayName: 'Job', primaryAttribute: { schemaName: 'cr_name' }, columns: [] },
    ],
    relationships: [{ type: 'OneToOne', referenced: 'cr_job', referencing: 'cr_candidate', lookup: { schemaName: 'cr_jobid' } }],
  });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /type must be 'OneToMany' or 'ManyToMany'/.test(e)));
});

test('rejects a column with an unknown type', () => {
  const r = validateProvisionInput({ 
    solution: { uniqueName: 'Default', publisherPrefix: 'cr' },
    entities: [{ 
      schemaName: 'cr_candidate', 
      displayName: 'Candidate', 
      primaryAttribute: { schemaName: 'cr_name' }, 
      columns: [{ schemaName: 'cr_status', type: 'InvalidType' }]
    }],
    relationships: []
  });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /unknown type/i.test(e)));
});

test('accepts a valid OneToMany relationship', () => {
  const r = validateProvisionInput({ 
    solution: { uniqueName: 'Default', publisherPrefix: 'cr' },
    entities: [
      { schemaName: 'cr_jobrequisition', displayName: 'Job', primaryAttribute: { schemaName: 'cr_name' }, columns: [] },
      { schemaName: 'cr_candidate', displayName: 'Candidate', primaryAttribute: { schemaName: 'cr_name' }, columns: [] }
    ],
    relationships: [{ type: 'OneToMany', referenced: 'cr_jobrequisition', referencing: 'cr_candidate', lookup: { schemaName: 'cr_jobrequisition' } }]
  });
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});
