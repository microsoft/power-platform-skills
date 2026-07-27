'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { stageFacts } = require('../lib/facts.js');

// A minimal but valid schemaVersion:2 spec covering all stage primitives: one entity with a
// Choice column, a view, a chart, a form, an intent page (no .tsx), and a sitemap subarea for each.
// The page key and name are the same string to avoid the linter's name-vs-key ambiguity in subarea
// references (spec-lint.js validates sa.page against p.name, not p.key).
const spec = {
  schemaVersion: 2,
  solution: { uniqueName: 'S', publisherPrefix: 'new' },
  app: { name: 'T', description: '' },
  entities: [{
    schemaName: 'new_order', displayName: 'Order',
    primaryAttribute: { schemaName: 'new_name', displayName: 'Name' },
    columns: [{ schemaName: 'new_status', displayName: 'Status', type: 'Choice', options: ['New', 'Done'] }],
  }],
  views: [{ entity: 'new_order', name: 'Active Orders', columns: ['new_name', 'new_status'], activeOnly: true }],
  charts: [{ entity: 'new_order', name: 'Orders by Status', groupBy: 'new_status', measure: 'count', chartType: 'Pie' }],
  forms: [{ entity: 'new_order', type: 'main', name: 'Order', layout: 'auto' }],
  // The page's name matches the key (both "overview"); validateAppSpec(v2) checks sa.page against
  // page keys, while lintAppSpec checks against page names — making key === name satisfies both.
  pages: [{ key: 'overview', name: 'overview', source: { kind: 'intent' }, navigatesTo: [{ targetKey: 'overview' }] }],
  appShell: { areas: [{ label: 'M', groups: [{ label: 'G', subAreas: [
    { entity: 'new_order', title: 'Orders' },
    { page: 'overview', title: 'Overview' },
  ] }] }] },
};

test('stageFacts.author validates under the plan profile and lints clean', async () => {
  const f = await stageFacts(spec);
  assert.strictEqual(f.author.validate.ok, true, JSON.stringify(f.author.validate.errors));
  assert.strictEqual(f.author.lint.errors.length, 0, JSON.stringify(f.author.lint.errors));
});

test('stageFacts.data/ui expose normalized structural facts', async () => {
  const f = await stageFacts(spec);
  assert.deepStrictEqual(f.data.tables.map((t) => t.logicalName), ['new_order']);
  assert.deepStrictEqual(f.ui.views.map((v) => v.name), ['Active Orders']);
  assert.deepStrictEqual(f.ui.charts.map((c) => c.name), ['Orders by Status']);
  assert.ok(f.ui.forms[0].fields.includes('new_name'), 'primary field placed in form');
});

test('stageFacts.app resolves every sitemap subarea and reports no dangling nav', async () => {
  const f = await stageFacts(spec);
  const refs = f.app.areas.flatMap((a) => a.groups.flatMap((g) => g.subAreas.map((s) => s.ref)));
  assert.ok(refs.every((r) => r), `all subareas should have a resolved ref; got ${JSON.stringify(refs)}`);
  // overview→overview: targetKey "overview" matches p.key "overview" → not dangling.
  assert.deepStrictEqual(f.app.danglingNav, []);
});

test('stageFacts.plan groups items by known engine phase; verify runs offline', async () => {
  const f = await stageFacts(spec);
  assert.ok(f.plan.phases.every((p) => f.PHASES.includes(p)), `unknown phase in plan: ${f.plan.phases.filter((p) => !f.PHASES.includes(p))}`);
  // verifySpec either succeeds (ok:true) or degrades gracefully (skipped string) — never throws.
  assert.ok(f.verify.ok === true || typeof f.verify.skipped === 'string', `unexpected verify result: ${JSON.stringify(f.verify)}`);
});

test('stageFacts.teardown plans a reverse-of-build delete ending at the solution, web resources after tables', async () => {
  const f = await stageFacts(spec);
  const kinds = f.teardown.kinds;
  assert.strictEqual(kinds[kinds.length - 1], 'solution', 'the solution container is deleted last');
  assert.ok(kinds.includes('table'), 'a table delete step is planned');
  // Web resources (incl. the build's generated icon + the page manifest) are torn down AFTER tables —
  // a table's icon web resource is referenced by the table, so it cannot be removed until the table is.
  const lastTable = kinds.lastIndexOf('table');
  const firstWr = kinds.indexOf('webResource');
  assert.ok(firstWr > lastTable, `web-resource step (${firstWr}) must follow the last table (${lastTable})`);
});

test('stageFacts.roundTrip hydrates the spec back losslessly (solution, tables, pages, sitemap)', async () => {
  const f = await stageFacts(spec);
  assert.strictEqual(f.roundTrip.error, undefined, f.roundTrip.error);
  assert.strictEqual(f.roundTrip.solution, 'S', 'the solution round-trips');
  assert.deepStrictEqual(f.roundTrip.tables, ['new_order'], 'tables round-trip');
  assert.deepStrictEqual(f.roundTrip.pageKeys, ['overview'], 'page keys round-trip');
  assert.deepStrictEqual(f.roundTrip.origSubareaTargets, f.roundTrip.hydratedSubareaTargets, 'the sitemap subareas round-trip unchanged');
  assert.deepStrictEqual(f.roundTrip.hydratedSubareaTargets, ['entity:new_order', 'page:overview']);
});

// A spec with a classic dashboard pinned to the nav — exercises the download→rebuild dashboard
// reconstruction (readDashboards + DashBoard-subarea hydrate) and the teardown dashboard step.
const dashSpec = {
  schemaVersion: 2,
  solution: { uniqueName: 'D', publisherPrefix: 'new' },
  app: { name: 'A', description: '' },
  entities: [{ schemaName: 'new_asset', displayName: 'Asset', primaryAttribute: { schemaName: 'new_name', displayName: 'Name' },
    columns: [{ schemaName: 'new_status', displayName: 'Status', type: 'Choice', options: ['A', 'B'] }] }],
  views: [{ entity: 'new_asset', name: 'Active Assets', columns: ['new_name', 'new_status'], activeOnly: true }],
  charts: [{ entity: 'new_asset', name: 'Assets by Status', groupBy: 'new_status', measure: 'count', chartType: 'Column' }],
  dashboards: [{ name: 'Ops', tiles: [{ type: 'chart', chart: 'Assets by Status', view: 'Active Assets' }, { type: 'list', view: 'Active Assets', name: 'Recent' }] }],
  appShell: { areas: [{ label: 'M', groups: [{ label: 'G', subAreas: [{ entity: 'new_asset', title: 'Assets' }, { dashboard: 'Ops', title: 'Dash' }] }] }] },
};

test('stageFacts round-trips a classic DashBoard subarea and plans its teardown', async () => {
  const f = await stageFacts(dashSpec);
  assert.strictEqual(f.author.validate.ok, true, JSON.stringify(f.author.validate.errors));
  assert.ok(f.teardown.kinds.includes('dashboard'), 'a dashboard delete step is planned');
  assert.strictEqual(f.roundTrip.error, undefined, f.roundTrip.error);
  // The DashBoard subarea is reconstructed by name (readDashboards id-passthrough) and survives the round-trip.
  assert.deepStrictEqual(f.roundTrip.hydratedSubareaTargets, ['entity:new_asset', 'dashboard:Ops']);
});

// A lookup-heavy child (8 scalars + a 1:N parent lookup) with a no-label sub-grid — exercises the
// 2026-07-15 fixes at the fact level: #2 (default view keeps the lookup), #7 (no createdon), #5
// (sub-grid own 1-column section titled by the child pluralName).
const hardeningSpec = {
  schemaVersion: 2,
  solution: { uniqueName: 'H', publisherPrefix: 'new' },
  app: { name: 'H', description: '' },
  entities: [
    { schemaName: 'new_customer', displayName: 'Customer', pluralName: 'Customers', primaryAttribute: { schemaName: 'new_name', displayName: 'Name' }, columns: [] },
    { schemaName: 'new_ticket', displayName: 'Ticket', pluralName: 'Tickets', primaryAttribute: { schemaName: 'new_subject', displayName: 'Subject' },
      columns: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((s) => ({ schemaName: `new_${s}`, displayName: s.toUpperCase(), type: 'Text' })) },
  ],
  relationships: [{ type: 'OneToMany', referenced: 'new_customer', referencing: 'new_ticket', lookup: { schemaName: 'new_CustomerId', displayName: 'Customer' } }],
  forms: [{ entity: 'new_customer', type: 'main', name: 'Customer', layout: 'auto', subgrids: [{ childEntity: 'new_ticket', view: 'Open Tickets' }] }],
  views: [{ entity: 'new_ticket', name: 'Open Tickets', columns: ['new_subject'], activeOnly: true }],
  appShell: { areas: [{ label: 'M', groups: [{ label: 'G', subAreas: [{ entity: 'new_customer', title: 'Customers' }] }] }] },
  sampleData: { new_customer: [{ new_name: 'Acme' }], new_ticket: [{ new_subject: 'Down', new_a: 'x', $parent: { entity: 'new_customer', match: { new_name: 'Acme' } } }] },
};

test('stageFacts.ui.defaultViews keep the parent lookup despite 8 scalars (#2) and drop createdon (#7)', async () => {
  const f = await stageFacts(hardeningSpec);
  assert.strictEqual(f.author.validate.ok, true, JSON.stringify(f.author.validate.errors));
  const tk = f.ui.defaultViews['new_ticket'];
  assert.ok(tk, 'new_ticket is enrichable');
  assert.ok(tk.columns.includes('new_customerid'), `#2: parent lookup kept; got [${tk.columns}]`);
  assert.strictEqual(tk.lookupsPresent, true, '#2: every parent lookup present');
  assert.strictEqual(tk.hasCreatedon, false, '#7: no createdon in the enriched default view');
});

test('stageFacts.ui.subgrids give each sub-grid a 1-column section titled by the child pluralName (#5)', async () => {
  const f = await stageFacts(hardeningSpec);
  const sg = f.ui.subgrids.find((s) => s.childEntity === 'new_ticket');
  assert.ok(sg, 'sub-grid fact present');
  assert.strictEqual(sg.sectionColumns, 1, '#5: full-width 1-column section');
  assert.strictEqual(sg.label, 'Tickets', '#5: title from child pluralName, not the logical name');
});
