const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { validateAppSpec, columnTypeMap, relationshipFor, resolveSampleRecords } = require(path.join(__dirname, '..', 'lib', 'app-spec.js'));

const sample = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'samples', 'app-spec.project-tracker.json'), 'utf8')
);
const desk = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'samples', 'app-spec.support-desk.json'), 'utf8')
);
const cloneDesk = () => JSON.parse(JSON.stringify(desk));

test('validateAppSpec accepts the sample', () => {
  const r = validateAppSpec(sample);
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});

test('validateAppSpec rejects a form referencing an unknown entity', () => {
  const bad = JSON.parse(JSON.stringify(sample));
  bad.forms[0].entity = 'new_missing';
  const r = validateAppSpec(bad);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('new_missing')));
});

test('validateAppSpec rejects a Choice column with no options', () => {
  const bad = JSON.parse(JSON.stringify(sample));
  delete bad.entities[0].columns[1].options;
  const r = validateAppSpec(bad);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('Choice needs options')));
});

test('columnTypeMap maps Choice to the Dataverse picklist type', () => {
  assert.strictEqual(columnTypeMap('Choice').dv, 'picklist');
});

test('resolveSampleRecords resolves inline AND global Choice labels (and multi-select tokens) to option ints', () => {
  const spec = { globalChoices: [{ name: 'new_tierset', options: ['Platinum', 'Gold', 'Silver', 'Bronze'] }] };
  const entity = {
    columns: [
      { schemaName: 'new_tier', type: 'Choice', globalChoice: 'new_tierset' }, // global
      { schemaName: 'new_pri', type: 'Choice', options: ['Low', 'High'] },      // inline
      { schemaName: 'new_tags', type: 'MultiChoice', options: ['A', 'B', 'C'] },// multi-select
    ],
  };
  const [r] = resolveSampleRecords(entity, [{ new_tier: 'Silver', new_pri: 'High', new_tags: 'A,C', new_name: 'Acme' }], spec);
  assert.strictEqual(r.new_tier, 100000002, 'global-choice label -> option int');
  assert.strictEqual(r.new_pri, 100000001, 'inline-choice label -> option int');
  assert.strictEqual(r.new_tags, '100000000,100000002', 'multi-select tokens resolved');
  assert.strictEqual(r.new_name, 'Acme', 'non-choice value passes through');
});

test('resolveSampleRecords renders a single MultiChoice label as a comma-string, not a bare Int32', () => {
  // regression: a multi-select picklist needs Edm.String even for one value
  // ("Cannot convert '100000002' (Int32) to Edm.String").
  const entity = { columns: [{ schemaName: 'new_certs', type: 'MultiChoice', options: ['Plumbing', 'HVAC', 'Electrical'] }] };
  const [one] = resolveSampleRecords(entity, [{ new_certs: 'HVAC' }], {});
  assert.strictEqual(one.new_certs, '100000001', 'single multi-select value is a STRING');
  assert.strictEqual(typeof one.new_certs, 'string', 'never a bare number');
  const [many] = resolveSampleRecords(entity, [{ new_certs: 'Plumbing,Electrical' }], {});
  assert.strictEqual(many.new_certs, '100000000,100000002', 'multiple values comma-joined as a string');
});

test('resolveSampleRecords leaves raw ints and unknown tokens untouched', () => {
  const entity = { columns: [{ schemaName: 'new_pri', type: 'Choice', options: ['Low', 'High'] }] };
  const [r] = resolveSampleRecords(entity, [{ new_pri: 100000001 }], {});
  assert.strictEqual(r.new_pri, 100000001, 'raw option int unchanged');
  const [r2] = resolveSampleRecords(entity, [{ new_pri: 'Nope' }], {});
  assert.strictEqual(r2.new_pri, 'Nope', 'unknown label passes through (lint flags it)');
});

// --- Rich-spec validation (charts / sub-grids / relational sample data) ----

test('validateAppSpec accepts the relational support-desk sample', () => {
  const r = validateAppSpec(desk);
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});

test('relationshipFor matches the OneToMany by referenced/referencing (case-insensitive)', () => {
  const rel = relationshipFor(desk, 'NEW_Customer', 'new_ticket');
  assert.ok(rel, 'found the customer->ticket relationship');
  assert.strictEqual(rel.lookup.schemaName, 'new_CustomerId');
  assert.strictEqual(relationshipFor(desk, 'new_ticket', 'new_customer'), null, 'direction matters');
  assert.strictEqual(relationshipFor(desk, 'new_customer', 'new_comment'), null, 'no transitive match');
});

test('validateAppSpec rejects a chart whose groupBy is not a Choice column', () => {
  const bad = cloneDesk();
  bad.charts[0].groupBy = 'new_duedate'; // a DateTime, not a Choice
  const r = validateAppSpec(bad);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /groupBy/.test(e) && /Choice/.test(e)));
});

test('validateAppSpec rejects an unknown chartType', () => {
  const bad = cloneDesk();
  bad.charts[0].chartType = 'Donut';
  const r = validateAppSpec(bad);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /chartType/.test(e)));
});

test('validateAppSpec rejects a chart missing a name', () => {
  const bad = cloneDesk();
  delete bad.charts[0].name;
  const r = validateAppSpec(bad);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /name is required/.test(e)));
});

test('validateAppSpec rejects a sub-grid childEntity with no OneToMany relationship', () => {
  const bad = cloneDesk();
  // comment is not a direct child of customer (only ticket is) -> invalid sub-grid.
  bad.forms[0].subgrids[0].childEntity = 'new_comment';
  const r = validateAppSpec(bad);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /no OneToMany or ManyToMany relationship/.test(e)));
});

test('validateAppSpec rejects a sub-grid referencing an unknown childEntity', () => {
  const bad = cloneDesk();
  bad.forms[0].subgrids[0].childEntity = 'new_missing';
  const r = validateAppSpec(bad);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /unknown childEntity/.test(e)));
});

test('validateAppSpec rejects an invalid formType', () => {
  const bad = cloneDesk();
  bad.forms[0].formType = 'Card2';
  const r = validateAppSpec(bad);
  assert.ok(!r.ok && r.errors.some((e) => /formType must be one of/.test(e)));
});

test('validateAppSpec rejects sub-grids on a non-Main form', () => {
  const bad = cloneDesk(); // desk forms[0] (Customer) has a Tickets sub-grid
  bad.forms[0].formType = 'QuickCreate';
  const r = validateAppSpec(bad);
  assert.ok(!r.ok && r.errors.some((e) => /can't host sub-grids/.test(e)));
});

test('validateAppSpec accepts a command referencing a declared web resource', () => {
  const ok = cloneDesk();
  ok.webResources = [{ name: 'new_ticket.js', type: 'js', content: 'x' }];
  ok.commands = [{ entity: 'new_ticket', label: 'Escalate', library: 'new_ticket.js', function: 'T.escalate' }];
  const r = validateAppSpec(ok);
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});

test('validateAppSpec rejects a command referencing an undeclared web resource', () => {
  const bad = cloneDesk();
  bad.commands = [{ entity: 'new_ticket', label: 'Escalate', library: 'missing.js', function: 'T.escalate' }];
  const r = validateAppSpec(bad);
  assert.ok(!r.ok && r.errors.some((e) => /is not a declared webResources/.test(e)));
});

test('validateAppSpec rejects a command with no function', () => {
  const bad = cloneDesk();
  bad.webResources = [{ name: 'new_ticket.js', type: 'js', content: 'x' }];
  bad.commands = [{ entity: 'new_ticket', label: 'Escalate', library: 'new_ticket.js' }];
  const r = validateAppSpec(bad);
  assert.ok(!r.ok && r.errors.some((e) => /function .* is required/.test(e)));
});

test('validateAppSpec accepts a dashboard with chart + list tiles on declared view/chart', () => {
  const ok = cloneDesk();
  ok.dashboards = [{ name: 'Ops', tiles: [
    { type: 'chart', chart: ok.charts[0].name, view: ok.views[0].name },
    { type: 'list', view: ok.views[0].name, name: 'List' },
  ] }];
  const r = validateAppSpec(ok);
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});

test('validateAppSpec rejects a dashboard chart tile referencing an unknown chart', () => {
  const bad = cloneDesk();
  bad.dashboards = [{ name: 'Ops', tiles: [{ type: 'chart', chart: 'Nope', view: bad.views[0].name }] }];
  const r = validateAppSpec(bad);
  assert.ok(!r.ok && r.errors.some((e) => /unknown chart/.test(e)));
});

test('validateAppSpec rejects an invalid form.layout value', () => {
  const bad = cloneDesk();
  bad.forms[0].layout = 'fancy';
  const r = validateAppSpec(bad);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /layout must be/.test(e)));
});

test('validateAppSpec rejects $parent pointing at an entity with no relationship to the child', () => {
  const bad = cloneDesk();
  // bind a comment directly to a customer -> no customer->comment relationship.
  bad.sampleData.new_comment[0].$parent = { entity: 'new_customer', match: { new_name: 'Northwind Traders' } };
  const r = validateAppSpec(bad);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /no OneToMany relationship from \$parent/.test(e)));
});

test('validateAppSpec rejects $parent with an empty match', () => {
  const bad = cloneDesk();
  bad.sampleData.new_ticket[0].$parent = { entity: 'new_customer', match: {} };
  const r = validateAppSpec(bad);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /match must be a non-empty object/.test(e)));
});
