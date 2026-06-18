const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { validateAppSpec, columnTypeMap, relationshipFor } = require(path.join(__dirname, '..', 'lib', 'app-spec.js'));

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

test('columnTypeMap maps Choice to picklist', () => {
  assert.strictEqual(columnTypeMap('Choice').dv, 'picklist');
  assert.strictEqual(columnTypeMap('Choice').kernel, 'picklist');
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
  assert.ok(r.errors.some((e) => /no OneToMany relationship/.test(e)));
});

test('validateAppSpec rejects a sub-grid referencing an unknown childEntity', () => {
  const bad = cloneDesk();
  bad.forms[0].subgrids[0].childEntity = 'new_missing';
  const r = validateAppSpec(bad);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /unknown childEntity/.test(e)));
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
