// plugins/model-apps/scripts/tests/spec-lint.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { lintAppSpec } = require('../lib/spec-lint.js');

const base = () => ({
  solution: { uniqueName: 'X', publisherPrefix: 'new' },
  entities: [
    { schemaName: 'new_customer', displayName: 'Customer', primaryAttribute: { schemaName: 'new_name', displayName: 'Name' }, columns: [] },
    { schemaName: 'new_ticket', displayName: 'Ticket', primaryAttribute: { schemaName: 'new_name', displayName: 'Title' },
      columns: [{ schemaName: 'new_priority', displayName: 'Priority', type: 'Choice', options: ['Low', 'High'] }] },
  ],
  relationships: [{ type: 'OneToMany', referenced: 'new_customer', referencing: 'new_ticket', lookup: { schemaName: 'new_CustomerId', displayName: 'Customer' } }],
  forms: [], views: [], charts: [],
});

test('a clean spec passes with no errors', () => {
  const r = lintAppSpec(base());
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.errors.length, 0);
});

test('flags the relationship-name vs lookup-name collision (the live bug)', () => {
  const s = base();
  s.relationships[0].lookup.schemaName = 'new_customer_new_ticket';
  const r = lintAppSpec(s);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((m) => /collides with its lookup/i.test(m)));
});

test('errors on a missing primaryAttribute', () => {
  const s = base();
  delete s.entities[1].primaryAttribute;
  const r = lintAppSpec(s);
  assert.ok(!r.ok && r.errors.some((m) => /primaryAttribute/i.test(m)));
});

test('errors on a Choice column with no options', () => {
  const s = base();
  s.entities[1].columns[0].options = [];
  const r = lintAppSpec(s);
  assert.ok(r.errors.some((m) => /needs options/i.test(m)));
});

test('warns when a Choice has too many options', () => {
  const s = base();
  s.entities[1].columns[0].options = Array.from({ length: 14 }, (_, i) => 'O' + i);
  const r = lintAppSpec(s);
  assert.ok(r.warnings.some((m) => /consider a lookup table/i.test(m)));
});

test('errors on a sub-grid with no matching OneToMany', () => {
  const s = base();
  s.forms = [{ entity: 'new_customer', subgrids: [{ childEntity: 'new_comment' }] }];
  const r = lintAppSpec(s);
  assert.ok(r.errors.some((m) => /no matching OneToMany/i.test(m)));
});

test('errors on a relationship referencing an unknown entity', () => {
  const s = base();
  s.relationships[0].referencing = 'new_nope';
  const r = lintAppSpec(s);
  assert.ok(r.errors.some((m) => /unknown entity/i.test(m)));
});

test('warns on prefix drift', () => {
  const s = base();
  s.entities[1].schemaName = 'cr123_ticket';
  const r = lintAppSpec(s);
  assert.ok(r.warnings.some((m) => /prefix/i.test(m)));
});
