'use strict';
// Declared chart reconciliation through the REAL vendored SDK over an in-memory
// savedqueryvisualizations table: the chart type, group-by and measure converge, a maker's palette,
// colours and custom series properties survive the push, and every refusal sends nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRowTableServer } = require('./helpers/row-table-server.js');
const { fakeManaged, fakePublication } = require('./helpers/feature-ports.js');
const { compileChartIntent, planChartReconcile, applyChartReconcile, createdChartBinding } = require('../lib/chart-reconcile.js');

const CID = '44444444-0000-4000-8000-000000000001';
const data = (groupBy = 'cr_priority', measures = '<attribute alias="aggregate_column" name="cr_caseid" aggregate="count" />') => '<datadefinition><fetchcollection><fetch mapping="logical" aggregate="true"><entity name="cr_case">'
  + `<attribute groupby="true" alias="groupby_column" name="${groupBy}" />${measures}</entity></fetch></fetchcollection>`
  + '<categorycollection><category><measurecollection><measure alias="aggregate_column" /></measurecollection></category></categorycollection></datadefinition>';
// A maker-customized presentation: a custom palette, colours and series custom properties.
const PRES = '<Chart Palette="None" PaletteCustomColors="91,151,213; 237,125,49"><Series><Series ChartType="Column" IsValueShownAsLabel="True" Color="91, 151, 213" CustomProperties="PointWidth=0.75, MaxPixelPointWidth=40"><SmartLabelStyle Enabled="True" /></Series></Series>'
  + '<ChartAreas><ChartArea BorderColor="White"><AxisY LineColor="165, 172, 181"><MajorGrid LineColor="239, 242, 246" /></AxisY><AxisX LineColor="165, 172, 181" /></ChartArea></ChartAreas>'
  + '<Titles><Title Alignment="TopLeft" DockingOffset="-3"></Title></Titles><Legends><Legend Alignment="Center" Docking="right" /></Legends></Chart>';

function server(row = {}) {
  const srv = createRowTableServer({ tables: { savedqueryvisualizations: 'savedqueryvisualizationid' } });
  srv.seed('savedqueryvisualizations', { savedqueryvisualizationid: CID, name: 'Cases by priority', description: '', primaryentitytypecode: 'cr_case', isdefault: false, datadescription: data(), presentationdescription: PRES, ...row });
  return srv;
}
const declared = (over = {}) => ({ entity: 'cr_case', name: 'Cases by priority', chartType: 'Bar', groupBy: 'cr_status', reconcile: 'declared', ...over });

async function run(srv, chart, ctx = {}) {
  const sdk = await srv.newSdk();
  const plan = await planChartReconcile({ chart, sdk }, ctx);
  const result = await applyChartReconcile(plan, { sdk }, ctx);
  return { plan, result };
}

test('chart type and group-by converge in one PATCH; the maker palette, colours and custom properties survive; a rerun sends nothing', async () => {
  const srv = server();
  const managed = fakeManaged();
  const publication = fakePublication();
  const { plan, result } = await run(srv, declared(), { authorizedAdoption: true, managed, publication });
  assert.deepEqual(plan.changed, ['chartType', 'category']);
  assert.deepEqual(result.saved.map((s) => s.id), [CID]);
  assert.equal(srv.writes.length, 1);
  const row = srv.rowOf('savedqueryvisualizations', CID);
  assert.match(row.datadescription, /<attribute groupby="true" alias="groupby_column" name="cr_status" \/>/, 'the group-by column changed and kept its alias');
  assert.match(row.datadescription, /<attribute alias="aggregate_column" name="cr_caseid" aggregate="count" \/>/);
  assert.equal(row.presentationdescription, PRES.replace('ChartType="Column"', 'ChartType="Bar"'), 'only the chart type changed in the presentation XML');
  assert.deepEqual(publication.queued, [{ type: 'chart', id: CID, table: 'cr_case' }]);
  assert.equal(result.managedBindings[0].origin, 'adopted');
  managed.persist(result.managedBindings);

  srv.clearLog();
  const again = fakePublication();
  const second = await run(srv, declared(), { managed, publication: again });
  assert.equal(second.plan.action, 'noChange');
  assert.equal(srv.writes.length, 0, 'a converged chart sends no push');
  assert.deepEqual(again.queued, [], 'and queues no publish');
});

test('the measure and an explicit description converge; an omitted description is never blanked', async () => {
  const srv = server({ description: 'Maker text' });
  const first = await run(srv, declared({ chartType: 'Column', groupBy: 'cr_priority', measure: 'countcolumn' }), { authorizedAdoption: true });
  assert.deepEqual(first.plan.changed, ['series']);
  const row = srv.rowOf('savedqueryvisualizations', CID);
  assert.match(row.datadescription, /name="cr_caseid" aggregate="countcolumn"/);
  assert.equal(row.description, 'Maker text', 'no description in the spec leaves the maker\'s text');

  srv.clearLog();
  const second = await run(srv, declared({ chartType: 'Column', groupBy: 'cr_priority', measure: 'countcolumn', description: 'Open cases by priority' }), { authorizedAdoption: true });
  assert.deepEqual(second.plan.changed, ['description']);
  assert.equal(srv.rowOf('savedqueryvisualizations', CID).description, 'Open cases by priority');
});

test('a chart this spec does not manage yet needs adoption approval; nothing is sent until then', async () => {
  const srv = server();
  const { result } = await run(srv, declared());
  assert.deepEqual(result.refused.map((r) => r.code), ['chart-adoption-not-authorized']);
  assert.equal(srv.writes.length, 0);
});

test('drift on an owned field is refused until the overwrite is approved; converged drift writes nothing', async () => {
  const srv = server();
  const managed = fakeManaged();
  const first = await run(srv, declared(), { authorizedAdoption: true, managed });
  managed.persist(first.result.managedBindings);
  // Someone else turns it into a pie chart.
  const row = srv.rowOf('savedqueryvisualizations', CID);
  row.presentationdescription = row.presentationdescription.replace('ChartType="Bar"', 'ChartType="Pie"');
  srv.clearLog();
  const refused = await run(srv, declared(), { managed });
  assert.deepEqual(refused.result.refused.map((r) => r.code), ['chart-drift']);
  assert.equal(srv.writes.length, 0);

  const approved = await run(srv, declared(), { managed, authorizedOverwrite: ['cr_case/Cases by priority'] });
  assert.deepEqual(approved.result.saved.map((s) => s.parts), [['chartType']]);
  assert.match(srv.rowOf('savedqueryvisualizations', CID).presentationdescription, /ChartType="Bar"/);
});

test('a spec that starts declaring a description or title is an edit, not drift', async () => {
  const srv = server({ description: 'Maker text' });
  const managed = fakeManaged();
  const first = await run(srv, declared(), { authorizedAdoption: true, managed });
  managed.persist(first.result.managedBindings);
  srv.clearLog();
  const second = await run(srv, declared({ description: 'Open cases by status', title: 'By status' }), { managed });
  assert.deepEqual(second.result.refused, [], 'the binding was recorded before the spec owned these fields');
  assert.deepEqual(second.plan.changed, ['description', 'title']);
  assert.equal(srv.rowOf('savedqueryvisualizations', CID).description, 'Open cases by status');
  managed.persist(second.result.managedBindings);
  srv.clearLog();
  // And stopping again leaves the text alone without reading as drift.
  const third = await run(srv, declared(), { managed });
  assert.deepEqual(third.result.refused, []);
  assert.equal(third.plan.action, 'noChange');
  assert.equal(srv.writes.length, 0);
});

test('a chart outside the supported shape (two measures) is refused, not reduced', async () => {
  const srv = server({ datadescription: data('cr_priority', '<attribute alias="aggregate_column" name="cr_caseid" aggregate="count" /><attribute alias="aggregate_column2" name="cr_amount" aggregate="sum" />') });
  const { result } = await run(srv, declared(), { authorizedAdoption: true });
  assert.deepEqual(result.refused.map((r) => r.code), ['chart-shape-unsupported']);
  assert.equal(srv.writes.length, 0);
});

test('an aggregate that means nothing on a primary id is refused before any read', async () => {
  assert.match(compileChartIntent(declared({ measure: 'sum' })).errors.join(), /measure must be one of count\|countcolumn/);
  assert.match(compileChartIntent(declared({ chartType: 'Donut' })).errors.join(), /chartType/);
  const srv = server();
  const { result } = await run(srv, declared({ measure: 'avg' }), { authorizedAdoption: true });
  assert.deepEqual(result.refused.map((r) => r.code), ['chart-spec-invalid']);
  assert.equal(srv.reads.length, 0);
});

test('a missing chart plans a create for the build and writes nothing itself; the created binding carries the intent', async () => {
  const srv = createRowTableServer({ tables: { savedqueryvisualizations: 'savedqueryvisualizationid' } });
  const { plan, result } = await run(srv, declared());
  assert.equal(plan.action, 'create');
  assert.equal(srv.writes.length, 0);
  assert.deepEqual(result.saved, []);
  const b = createdChartBinding(plan, CID, {});
  assert.equal(b.origin, 'created');
  assert.equal(b.intentSha256, plan.desiredSha);
});

test('a read failure is unknown, never refused or saved', async () => {
  const sdk = { findArtifact: async () => { throw new Error('socket hang up'); } };
  const plan = await planChartReconcile({ chart: declared(), sdk });
  const result = await applyChartReconcile(plan, { sdk });
  assert.deepEqual(result.unknown.map((u) => u.code), ['chart-lookup-unreadable']);
  assert.deepEqual(result.refused, []);
});
