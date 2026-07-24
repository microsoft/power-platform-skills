const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { validateAppSpec, columnTypeMap, relationshipFor, lookupColumnsFor, childRelationshipsFor, relationshipSchemaName, manyToManySchemaName, resolveSampleRecords } = require(path.join(__dirname, '..', 'lib', 'app-spec.js'));

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

test('relationshipSchemaName: all-custom default is unchanged (backward compatible)', () => {
  const rel = { type: 'OneToMany', referenced: 'new_customer', referencing: 'new_ticket' };
  assert.strictEqual(relationshipSchemaName(rel, 'new'), 'new_customer_new_ticket');
  // With no prefix supplied, the legacy composed name is returned unchanged.
  assert.strictEqual(relationshipSchemaName(rel), 'new_customer_new_ticket');
});

test('relationshipSchemaName: a relationship to a SYSTEM table is auto-prefixed (the build-halt fix)', () => {
  const rel = { type: 'OneToMany', referenced: 'systemuser', referencing: 'contoso_teammember' };
  // systemuser has no publisher prefix, so the naive `systemuser_contoso_teammember` would be
  // rejected by Dataverse. The prefix is prepended and the redundant one on the child is stripped.
  assert.strictEqual(relationshipSchemaName(rel, 'contoso'), 'contoso_systemuser_teammember');
});

test('relationshipSchemaName: account-referenced default is also prefixed', () => {
  const rel = { type: 'OneToMany', referenced: 'account', referencing: 'contoso_project' };
  assert.strictEqual(relationshipSchemaName(rel, 'contoso'), 'contoso_account_project');
});

test('relationshipSchemaName: an explicit schemaName is honored verbatim', () => {
  const rel = { type: 'OneToMany', referenced: 'systemuser', referencing: 'contoso_teammember', schemaName: 'contoso_myrel' };
  assert.strictEqual(relationshipSchemaName(rel, 'contoso'), 'contoso_myrel');
});

test('manyToManySchemaName: system-table N:N is auto-prefixed', () => {
  const rel = { type: 'ManyToMany', entity1: 'systemuser', entity2: 'contoso_project' };
  assert.strictEqual(manyToManySchemaName(rel, 'contoso'), 'contoso_systemuser_project');
  // all-custom is unchanged
  assert.strictEqual(manyToManySchemaName({ entity1: 'new_a', entity2: 'new_b' }, 'new'), 'new_a_new_b');
});

test('validateAppSpec accepts a sitemap icon referencing a declared image web resource', () => {
  const s = JSON.parse(JSON.stringify(sample));
  s.webResources = (s.webResources || []).concat([{ name: 'new_ic.png', type: 'png', contentBase64: 'AAAA' }]);
  s.appShell.areas[0].groups[0].subAreas[0].icon = 'new_ic.png';
  s.appShell.areas[0].groups[0].subAreas[0].vectorIcon = 'Home';
  s.appShell.areas[0].icon = 'new_ic.png';
  const r = validateAppSpec(s);
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});

test('validateAppSpec rejects a sitemap icon referencing an undeclared web resource', () => {
  const s = JSON.parse(JSON.stringify(sample));
  s.appShell.areas[0].groups[0].subAreas[0].icon = 'new_missing.png';
  const r = validateAppSpec(s);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /icon 'new_missing\.png' is not a declared web resource/.test(e)), JSON.stringify(r.errors));
});

test('validateAppSpec rejects a sitemap icon referencing a non-image web resource', () => {
  const s = JSON.parse(JSON.stringify(sample));
  s.webResources = (s.webResources || []).concat([{ name: 'new_logic.js', type: 'js', content: 'x' }]);
  s.appShell.areas[0].groups[0].subAreas[0].icon = 'new_logic.js';
  const r = validateAppSpec(s);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /must be an image web resource/.test(e)), JSON.stringify(r.errors));
});

test('validateAppSpec accepts a table vectorIcon referencing a declared SVG web resource', () => {
  const s = JSON.parse(JSON.stringify(sample));
  s.webResources = (s.webResources || []).concat([{ name: 'new_tableicon', type: 'svg', content: '<svg/>' }]);
  s.entities[0].vectorIcon = 'new_tableicon';
  const r = validateAppSpec(s);
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});

test('validateAppSpec rejects a table vectorIcon that is not a declared web resource (the glimmer cause)', () => {
  const s = JSON.parse(JSON.stringify(sample));
  s.entities[0].vectorIcon = 'AccessTimeFilled'; // a Fluent token, NOT a web resource
  const r = validateAppSpec(s);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /vectorIcon 'AccessTimeFilled' is not a declared web resource/.test(e)), JSON.stringify(r.errors));
});

test('validateAppSpec rejects a table vectorIcon that is a non-SVG web resource', () => {
  const s = JSON.parse(JSON.stringify(sample));
  s.webResources = (s.webResources || []).concat([{ name: 'new_tableicon_png', type: 'png', contentBase64: 'AAAA' }]);
  s.entities[0].vectorIcon = 'new_tableicon_png';
  const r = validateAppSpec(s);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /vectorIcon 'new_tableicon_png' must be an SVG web resource/.test(e)), JSON.stringify(r.errors));
});

test('validateAppSpec rejects a table (raster) icon that is an SVG web resource (use vectorIcon)', () => {
  const s = JSON.parse(JSON.stringify(sample));
  s.webResources = (s.webResources || []).concat([{ name: 'new_svgicon', type: 'svg', content: '<svg/>' }]);
  s.entities[0].icon = 'new_svgicon';
  const r = validateAppSpec(s);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /must be a raster image web resource/.test(e)), JSON.stringify(r.errors));
});

test('validateAppSpec accepts an app.icon referencing a declared image web resource', () => {
  const s = JSON.parse(JSON.stringify(sample));
  s.webResources = (s.webResources || []).concat([{ name: 'new_appicon', type: 'png', contentBase64: 'AAAA' }]);
  s.app.icon = 'new_appicon';
  const r = validateAppSpec(s);
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});

test('validateAppSpec rejects an app.icon that is not a declared web resource', () => {
  const s = JSON.parse(JSON.stringify(sample));
  s.app.icon = 'new_missingappicon';
  const r = validateAppSpec(s);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /app\.icon 'new_missingappicon' is not a declared web resource/.test(e)), JSON.stringify(r.errors));
});

test('validateAppSpec accepts pages[] + a page sitemap subarea', () => {
  const s = JSON.parse(JSON.stringify(sample));
  s.pages = [{ name: 'Overview', dataSources: ['new_project'], prompt: 'kpis', codeFile: 'overview.tsx' }];
  s.appShell.areas[0].groups[0].subAreas.push({ page: 'Overview', title: 'Overview' });
  const r = validateAppSpec(s);
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});

test('validateAppSpec rejects a page with no source/codeFile and a subarea referencing an unknown page', () => {
  const s = cloneDesk();
  s.pages = [{ name: 'Overview' }]; // no source, no codeFile
  s.appShell.areas[0].groups[0].subAreas.push({ title: 'Overview', page: 'Nope' });
  const r = validateAppSpec(s); // default deploy profile
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /page 'Overview': must be implemented/.test(e)), JSON.stringify(r.errors));
  assert.ok(r.errors.some((e) => /unknown page 'Nope'/.test(e)), JSON.stringify(r.errors));
});

test('validateAppSpec rejects a subarea that sets both an entity and a page', () => {
  const s = JSON.parse(JSON.stringify(sample));
  s.pages = [{ name: 'Overview', codeFile: 'o.tsx' }];
  s.appShell.areas[0].groups[0].subAreas.push({ entity: 'new_project', page: 'Overview', title: 'Both' });
  const r = validateAppSpec(s);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /sets multiple targets/.test(e)), JSON.stringify(r.errors));
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

test('validateAppSpec accepts id-passthrough dashboard tiles (viewId/visualizationId + entity, no declared view/chart)', () => {
  const ok = cloneDesk();
  ok.views = []; ok.charts = []; // round-tripped spec declares no views/charts
  ok.dashboards = [{ name: 'Ops', tiles: [
    { type: 'chart', name: 'By Status', entity: ok.entities[0].schemaName, viewId: 'v1', visualizationId: 'c1' },
    { type: 'list', name: 'Active', entity: ok.entities[0].schemaName, viewId: 'v1' },
  ] }];
  const r = validateAppSpec(ok);
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});

test('validateAppSpec rejects an id-based dashboard tile missing entity or viewId', () => {
  const noEntity = cloneDesk();
  noEntity.dashboards = [{ name: 'Ops', tiles: [{ type: 'chart', name: 'X', viewId: 'v1', visualizationId: 'c1' }] }];
  assert.ok(validateAppSpec(noEntity).errors.some((e) => /id-based chart tile needs entity/.test(e)));
  const noView = cloneDesk();
  noView.dashboards = [{ name: 'Ops', tiles: [{ type: 'chart', name: 'X', entity: noView.entities[0].schemaName, visualizationId: 'c1' }] }];
  assert.ok(validateAppSpec(noView).errors.some((e) => /also needs viewId/.test(e)));
});

test('validateAppSpec rejects a dashboard chart tile referencing an unknown chart', () => {
  const bad = cloneDesk();
  bad.dashboards = [{ name: 'Ops', tiles: [{ type: 'chart', chart: 'Nope', view: bad.views[0].name }] }];
  const r = validateAppSpec(bad);
  assert.ok(!r.ok && r.errors.some((e) => /unknown chart/.test(e)));
});

test('validateAppSpec accepts a quick-view placement referencing a QuickView form', () => {
  const ok = cloneDesk();
  ok.forms = [
    { entity: 'new_ticket', name: 'Ticket', formType: 'Main', quickViews: [{ lookup: 'new_customerid', targetEntity: 'new_customer', form: 'Customer QV' }] },
    { entity: 'new_customer', name: 'Customer QV', formType: 'QuickView' },
  ];
  const r = validateAppSpec(ok);
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});

test('validateAppSpec rejects a quick-view whose form is not a QuickView', () => {
  const bad = cloneDesk();
  bad.forms = [
    { entity: 'new_ticket', name: 'Ticket', formType: 'Main', quickViews: [{ lookup: 'new_customerid', targetEntity: 'new_customer', form: 'Customer' }] },
    { entity: 'new_customer', name: 'Customer', formType: 'Main' },
  ];
  const r = validateAppSpec(bad);
  assert.ok(!r.ok && r.errors.some((e) => /must have formType: "QuickView"/.test(e)));
});

test('validateAppSpec accepts a flyout command (children carry the actions); rejects a child with no function', () => {
  const ok = cloneDesk();
  ok.webResources = [{ name: 'new_ticket.js', type: 'js', content: 'x' }];
  ok.commands = [{ entity: 'new_ticket', label: 'More', type: 'FlyoutAnchor', children: [
    { label: 'Escalate', library: 'new_ticket.js', function: 'T.escalate' },
  ] }];
  assert.strictEqual(validateAppSpec(ok).ok, true, JSON.stringify(validateAppSpec(ok).errors));
  const bad = cloneDesk();
  bad.webResources = [{ name: 'new_ticket.js', type: 'js', content: 'x' }];
  bad.commands = [{ entity: 'new_ticket', label: 'More', type: 'FlyoutAnchor', children: [{ label: 'Escalate', library: 'new_ticket.js' }] }];
  const r = validateAppSpec(bad);
  assert.ok(!r.ok && r.errors.some((e) => /child 'Escalate'.*function .* is required/.test(e)));
});

test('validateAppSpec accepts a DashBoard sitemap subarea, rejects an unknown dashboard + a double-target subarea', () => {
  const ok = cloneDesk();
  ok.dashboards = [{ name: 'Ops', tiles: [{ type: 'list', view: ok.views[0].name, name: 'L' }] }];
  ok.appShell.areas[0].groups[0].subAreas.push({ dashboard: 'Ops', title: 'Overview' });
  assert.strictEqual(validateAppSpec(ok).ok, true, JSON.stringify(validateAppSpec(ok).errors));

  const unknown = cloneDesk();
  unknown.appShell.areas[0].groups[0].subAreas.push({ dashboard: 'Nope', title: 'X' });
  assert.ok(validateAppSpec(unknown).errors.some((e) => /unknown dashboard 'Nope'/.test(e)));

  const dbl = cloneDesk();
  dbl.appShell.areas[0].groups[0].subAreas.push({ entity: 'new_ticket', url: 'https://x', title: 'Both' });
  assert.ok(validateAppSpec(dbl).errors.some((e) => /sets multiple targets/.test(e)));
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

// --- Gap 3: lookupColumnsFor -----------------------------------------------------------------
test('lookupColumnsFor returns the 1:N lookups on the child (referencing) side, excludes N:N, dedupes', () => {
  const spec = {
    relationships: [
      { type: 'OneToMany', referenced: 'new_project', referencing: 'new_task', lookup: { schemaName: 'new_ProjectId', displayName: 'Project' } },
      { type: 'OneToMany', referenced: 'systemuser', referencing: 'new_task', lookup: { schemaName: 'new_AssignedTo', displayName: 'Assigned To' } },
      { type: 'ManyToMany', entity1: 'new_task', entity2: 'new_tag', intersectEntityName: 'new_task_tag' },
      { type: 'OneToMany', referenced: 'new_project', referencing: 'new_other', lookup: { schemaName: 'new_ProjectId', displayName: 'Project' } },
    ],
  };
  const forTask = lookupColumnsFor(spec, 'new_task');
  assert.deepStrictEqual(forTask.map((l) => l.logical), ['new_projectid', 'new_assignedto'], 'both 1:N lookups on new_task, N:N excluded, lowercased');
  assert.strictEqual(forTask[0].displayName, 'Project');
  // the parent side (new_project is referenced, not referencing) has no lookup column
  assert.deepStrictEqual(lookupColumnsFor(spec, 'new_project'), []);
});

// --- Gap 7: childRelationshipsFor (auto sub-grids) -------------------------------------------
test('childRelationshipsFor returns the child (many) side of each 1:N where the entity is the parent, plus N:N partners', () => {
  const spec = {
    relationships: [
      { type: 'OneToMany', referenced: 'new_project', referencing: 'new_task', lookup: { schemaName: 'new_ProjectId' } },
      { type: 'OneToMany', referenced: 'new_project', referencing: 'new_risk', lookup: { schemaName: 'new_ProjectId2' } },
      { type: 'ManyToMany', entity1: 'new_project', entity2: 'new_tag', intersectEntityName: 'new_project_tag' },
      { type: 'OneToMany', referenced: 'systemuser', referencing: 'new_project', lookup: { schemaName: 'new_OwnerId' } },
    ],
  };
  // new_project is the PARENT of task + risk, and an N:N partner of tag — its form should list all three.
  assert.deepStrictEqual(childRelationshipsFor(spec, 'new_project').map((c) => c.childEntity), ['new_task', 'new_risk', 'new_tag']);
  // new_task is only a child (referencing) — it has no child grids of its own here.
  assert.deepStrictEqual(childRelationshipsFor(spec, 'new_task'), []);
});

// === Task 3 (Plan 3): page-spec validation BEFORE any write (Critical 4) ===
// These checks run on every validateAppSpec call — author plan, run-1/run-2, teardown, verify —
// so a malformed page spec is rejected before the pages phase writes anything. Design §7.2.

// A minimal v2 spec that passes everything EXCEPT the page rule under test. schemaVersion 2 so the
// stable-key rules apply; one entity so the base validation is satisfied.
function pageSpec(pages) {
  return {
    schemaVersion: 2,
    solution: { uniqueName: 'S', publisherPrefix: 'new' },
    app: { name: 'A' },
    entities: [{ schemaName: 'new_widget', primaryAttribute: { schemaName: 'new_name' }, columns: [] }],
    pages,
    appShell: { areas: [] },
  };
}

test('validateAppSpec rejects case-insensitive duplicate page names (Critical 4)', () => {
  const r = validateAppSpec(pageSpec([
    { key: 'a', name: 'Overview', source: { kind: 'tsx', codeFile: 'a.tsx' } },
    { key: 'b', name: 'overview', source: { kind: 'tsx', codeFile: 'b.tsx' } },
  ]), { profile: 'plan' });
  assert.ok(!r.ok && r.errors.some((e) => /duplicate page name/i.test(e)), r.errors.join('; '));
});

test('validateAppSpec rejects duplicate implemented codeFile paths (Critical 4)', () => {
  const r = validateAppSpec(pageSpec([
    { key: 'a', name: 'A', source: { kind: 'tsx', codeFile: 'pages/x.tsx' } },
    { key: 'b', name: 'B', source: { kind: 'tsx', codeFile: 'pages/x.tsx' } },
  ]), { profile: 'plan' });
  assert.ok(!r.ok && r.errors.some((e) => /duplicate .*codeFile|codeFile .*already/i.test(e)), r.errors.join('; '));
});

// Addendum Crit 4: path aliases that resolve to the same file must be detected as duplicates.
// path.normalize('pages/./x.tsx') and path.normalize('pages/x.tsx') resolve identically; without
// normalization these would evade the duplicate check as different strings.
test('validateAppSpec rejects normalized path duplicates: pages/x.tsx vs pages/./x.tsx (addendum Crit 4)', () => {
  const r = validateAppSpec(pageSpec([
    { key: 'a', name: 'A', source: { kind: 'tsx', codeFile: 'pages/x.tsx' } },
    { key: 'b', name: 'B', source: { kind: 'tsx', codeFile: 'pages/./x.tsx' } },
  ]), { profile: 'plan' });
  assert.ok(!r.ok && r.errors.some((e) => /duplicate .*codeFile|codeFile .*already/i.test(e)), `pages/./x.tsx alias should be detected as duplicate: ${r.errors.join('; ')}`);
});

test('validateAppSpec rejects a codeFile that escapes the workspace (.. or absolute) (Critical 4)', () => {
  for (const bad of ['../evil.tsx', '/etc/evil.tsx', 'C:/evil.tsx', 'a/../../evil.tsx']) {
    const r = validateAppSpec(pageSpec([{ key: 'a', name: 'A', source: { kind: 'tsx', codeFile: bad } }]), { profile: 'plan' });
    assert.ok(!r.ok && r.errors.some((e) => /codeFile.*(outside|escape|confin|absolute|\.\.)/i.test(e)), `${bad}: ${r.errors.join('; ')}`);
  }
});

test('validateAppSpec rejects an invalid stable key grammar (Critical 4)', () => {
  for (const bad of ['Overview', 'wo_detail', '-lead', 'lead-', 'a b']) {
    const r = validateAppSpec(pageSpec([{ key: bad, name: 'A', source: { kind: 'tsx', codeFile: 'a.tsx' } }]), { profile: 'plan' });
    assert.ok(!r.ok && r.errors.some((e) => /key.*grammar|invalid.*key|key '/i.test(e)), `${bad}: ${r.errors.join('; ')}`);
  }
});

test('validateAppSpec accepts a unique-name, confined-path, well-keyed page set', () => {
  const r = validateAppSpec(pageSpec([
    { key: 'overview', name: 'Overview', source: { kind: 'tsx', codeFile: 'overview.tsx' } },
    { key: 'wo-detail', name: 'WO Detail', navigatesTo: [{ targetKey: 'overview' }], source: { kind: 'tsx', codeFile: 'pages/wo-detail.tsx' } },
  ]), { profile: 'deploy' });
  assert.ok(r.ok, r.errors.join('; '));
});

test('validateAppSpec rejects $parent with an empty match', () => {
  const bad = cloneDesk();
  bad.sampleData.new_ticket[0].$parent = { entity: 'new_customer', match: {} };
  const r = validateAppSpec(bad);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /match must be a non-empty object/.test(e)));
});

// --- ai block validation -----------------------------------------------------------------

test('validateAppSpec accepts a well-formed ai block', () => {
  const s = cloneDesk();
  s.ai = {
    appFeatures: { formFill: true, nlSearch: true },
    summaries: { default: 'auto', tables: { new_ticket: { enabled: true, columns: ['new_status'] } } },
  };
  const r = validateAppSpec(s);
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});

test('validateAppSpec rejects an ai summaries table not in entities', () => {
  const s = cloneDesk();
  s.ai = { summaries: { tables: { not_a_table: { enabled: true } } } };
  const r = validateAppSpec(s);
  assert.ok(!r.ok && r.errors.some((e) => /unknown table 'not_a_table'/i.test(e)));
});

test('validateAppSpec rejects an unknown ai.appFeatures key', () => {
  const s = cloneDesk();
  s.ai = { appFeatures: { formFill: true, copilot: true } };
  const r = validateAppSpec(s);
  assert.ok(!r.ok && r.errors.some((e) => /unknown key 'copilot'/i.test(e)));
});

test('validateAppSpec rejects a non-boolean ai.appFeatures value', () => {
  const s = cloneDesk();
  s.ai = { appFeatures: { nlSearch: 'yes' } };
  const r = validateAppSpec(s);
  assert.ok(!r.ok && r.errors.some((e) => /must be a boolean/i.test(e)));
});

test('validateAppSpec rejects ai.summaries.default with an invalid value', () => {
  const s = cloneDesk();
  s.ai = { summaries: { default: 'on' } };
  const r = validateAppSpec(s);
  assert.ok(!r.ok && r.errors.some((e) => /auto.*off|off.*auto/i.test(e)));
});

test('validateAppSpec rejects an unknown column in ai.summaries.tables columns[]', () => {
  const s = cloneDesk();
  s.ai = { summaries: { tables: { new_ticket: { columns: ['new_missing_col'] } } } };
  const r = validateAppSpec(s);
  assert.ok(!r.ok && r.errors.some((e) => /unknown column 'new_missing_col'/i.test(e)));
});

test('validateAppSpec passes when ai is absent (no regression)', () => {
  const r = validateAppSpec(cloneDesk());
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});
