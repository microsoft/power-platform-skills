'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { schemaFacts, isBuildableColumn } = require('../lib/schema-facts.js');
const { assertGolden } = require('./helpers/golden.js');

const sample = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'samples', `app-spec.${n}.json`), 'utf8'));

test('isBuildableColumn: every type except Lookup is buildable; Customer is buildable', () => {
  for (const type of ['Text', 'Memo', 'Choice', 'MultiChoice', 'Boolean', 'Money', 'DateTime', 'Integer', 'BigInt', 'Decimal', 'Double', 'File', 'Image', 'AutoNumber', 'Customer']) {
    assert.strictEqual(isBuildableColumn({ type }), true, `${type} should be buildable`);
  }
  assert.strictEqual(isBuildableColumn({ type: 'Lookup' }), false);
  assert.strictEqual(isBuildableColumn({}), true); // undefined type defaults to Text (buildable)
});

test('schemaFacts normalizes tables: lowercased logical, buildable columns only, choice values pinned', () => {
  const spec = {
    solution: { publisherPrefix: 'new' },
    globalChoices: [{ name: 'new_Region', options: ['East', 'West'] }],
    entities: [{
      schemaName: 'new_Order', displayName: 'Order', hasNotes: true,
      primaryAttribute: { schemaName: 'new_Name', displayName: 'Order #', autoNumberFormat: 'ORD-{SEQNUM:4}' },
      columns: [
        { schemaName: 'new_Status', displayName: 'Status', type: 'Choice', options: ['Open', 'Closed'] },
        { schemaName: 'new_Owner', displayName: 'Owner', type: 'Lookup' }, // not buildable — dropped
      ],
      statusReasons: [{ label: 'On Hold', state: 'Active' }],
    }],
  };
  const f = schemaFacts(spec);
  const t = f.tables[0];
  assert.strictEqual(t.logicalName, 'new_order');
  assert.strictEqual(t.hasNotes, true);
  assert.deepStrictEqual(t.primary, { logicalName: 'new_name', displayName: 'Order #', autoNumber: true });
  // Lookup column dropped; only the Choice column survives.
  assert.deepStrictEqual(t.columns.map((c) => c.logicalName), ['new_status']);
  assert.deepStrictEqual(t.columns[0].choices, [{ value: 100000000, label: 'Open' }, { value: 100000001, label: 'Closed' }]);
  assert.deepStrictEqual(f.globalChoices[0], { name: 'new_region', options: [{ value: 100000000, label: 'East' }, { value: 100000001, label: 'West' }] });
  assert.deepStrictEqual(t.statusReasons, [{ label: 'On Hold', state: 'Active' }]);
});

test('schemaFacts normalizes relationships with prefixed schema names, sorted', () => {
  const spec = {
    solution: { publisherPrefix: 'new' },
    entities: [{ schemaName: 'new_customer', primaryAttribute: { schemaName: 'new_name' }, columns: [] }],
    relationships: [
      { type: 'ManyToMany', entity1: 'new_ticket', entity2: 'new_tag', intersectEntityName: 'new_ticket_tag' },
      { type: 'OneToMany', referenced: 'new_customer', referencing: 'new_ticket', lookup: { schemaName: 'new_CustomerId', displayName: 'Customer' } },
    ],
  };
  const f = schemaFacts(spec);
  assert.strictEqual(f.relationships.length, 2);
  // Sorted by schemaName; 1:n schema name is `<referenced>_<referencing>` (already prefixed).
  assert.deepStrictEqual(f.relationships[0], { kind: '1:n', schemaName: 'new_customer_new_ticket', referenced: 'new_customer', referencing: 'new_ticket', lookup: { logicalName: 'new_customerid', displayName: 'Customer' } });
  assert.strictEqual(f.relationships[1].kind, 'n:n');
  // #3: the N:N schema name sorts its two entities alphabetically (new_tag < new_ticket) so it is
  // STABLE regardless of entity1/entity2 declaration order — swapping them yields the same name.
  assert.strictEqual(f.relationships[1].schemaName, 'new_tag_new_ticket');
  const swapped = JSON.parse(JSON.stringify(spec));
  swapped.relationships[0] = { type: 'ManyToMany', entity1: 'new_tag', entity2: 'new_ticket', intersectEntityName: 'new_ticket_tag' };
  assert.strictEqual(schemaFacts(swapped).relationships.find((r) => r.kind === 'n:n').schemaName, 'new_tag_new_ticket');
});

test('schemaFacts is deterministic regardless of input entity/column order', () => {
  const base = { solution: { publisherPrefix: 'new' }, entities: [
    { schemaName: 'new_b', primaryAttribute: { schemaName: 'new_name' }, columns: [{ schemaName: 'new_z', type: 'Text' }, { schemaName: 'new_a', type: 'Text' }] },
    { schemaName: 'new_a', primaryAttribute: { schemaName: 'new_name' }, columns: [] },
  ] };
  const reordered = { solution: { publisherPrefix: 'new' }, entities: [base.entities[1], base.entities[0]] };
  assert.deepStrictEqual(schemaFacts(base), schemaFacts(reordered));
});

test('schemaFacts golden: support-desk data model is stable', () => {
  assertGolden('schema-facts.support-desk.json', JSON.stringify(schemaFacts(sample('support-desk')), null, 2) + '\n');
});
