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

test('warns that a QuickView form needs manual placement (created, not auto-wired)', () => {
  const s = base();
  s.forms = [{ entity: 'new_ticket', formType: 'QuickView' }];
  const r = lintAppSpec(s);
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.ok(r.warnings.some((m) => /QuickView form/i.test(m) && /placing it/i.test(m)));
});

test('errors on sub-grids declared on a non-Main form', () => {
  const s = base();
  s.forms = [{ entity: 'new_customer', formType: 'QuickCreate', subgrids: [{ childEntity: 'new_ticket' }] }];
  const r = lintAppSpec(s);
  assert.ok(!r.ok && r.errors.some((m) => /Main-form only/i.test(m)));
});

test('errors on a relationship referencing an unknown entity', () => {
  const s = base();
  s.relationships[0].referencing = 'new_nope';
  const r = lintAppSpec(s);
  assert.ok(r.errors.some((m) => /unknown entity/i.test(m)));
});

test('errors on a command with no function and an undeclared library', () => {
  const s = base();
  s.commands = [{ entity: 'new_ticket', label: 'Escalate', library: 'missing.js' }];
  const r = lintAppSpec(s);
  assert.ok(!r.ok && r.errors.some((m) => /needs a function/i.test(m)));
  assert.ok(r.errors.some((m) => /undeclared web resource/i.test(m)));
});

test('accepts a command bound to a declared web resource + function', () => {
  const s = base();
  s.webResources = [{ name: 'new_ticket.js', type: 'js', content: 'x' }];
  s.commands = [{ entity: 'new_ticket', label: 'Escalate', library: 'new_ticket.js', function: 'T.escalate' }];
  const r = lintAppSpec(s);
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});

test('warns on prefix drift', () => {
  const s = base();
  s.entities[1].schemaName = 'cr123_ticket';
  const r = lintAppSpec(s);
  assert.ok(r.warnings.some((m) => /prefix/i.test(m)));
});

// --- Sample-data Choice value resolvability (the global-choice live gap) -----------------

test('errors on a sampleData Choice value that is neither a declared label nor an int', () => {
  const s = base();
  s.sampleData = { new_ticket: [{ new_name: 'T1', new_priority: 'Platnium' }] }; // typo, not Low/High
  const r = lintAppSpec(s);
  assert.ok(!r.ok && r.errors.some((m) => /isn't a valid option/i.test(m)));
});

test('catches an unresolvable label on a GLOBAL-choice column (the gap that slipped past)', () => {
  const s = base();
  s.globalChoices = [{ name: 'new_tierset', options: ['Platinum', 'Gold', 'Silver', 'Bronze'] }];
  s.entities[0].columns.push({ schemaName: 'new_tier', displayName: 'Tier', type: 'Choice', globalChoice: 'new_tierset' });
  s.sampleData = { new_customer: [{ new_name: 'C1', new_tier: 'Platnium' }] }; // typo for Platinum
  const r = lintAppSpec(s);
  assert.ok(!r.ok && r.errors.some((m) => /new_tier='Platnium'/.test(m)));
});

test('accepts sampleData Choice values that match a declared label (inline or global) or a raw int', () => {
  const s = base();
  s.globalChoices = [{ name: 'new_tierset', options: ['Platinum', 'Gold'] }];
  s.entities[0].columns.push({ schemaName: 'new_tier', displayName: 'Tier', type: 'Choice', globalChoice: 'new_tierset' });
  s.sampleData = {
    new_ticket: [{ new_name: 'T1', new_priority: 'High' }, { new_name: 'T2', new_priority: 100000000 }],
    new_customer: [{ new_name: 'C1', new_tier: 'Gold' }],
  };
  const r = lintAppSpec(s);
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});
