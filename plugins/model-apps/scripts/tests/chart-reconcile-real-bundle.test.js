'use strict';
// Declared chart reconciliation through the REAL vendored SDK over an in-memory
// savedqueryvisualizations table: the chart type, group-by and measure converge, a maker's palette,
// colours and custom series properties survive the push, and every refusal sends nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRowTableServer } = require('./helpers/row-table-server.js');
const { fakeManaged, fakePublication, fakeCreates } = require('./helpers/feature-ports.js');
const { compileChartIntent, planChartReconcile, applyChartReconcile } = require('../lib/chart-reconcile.js');

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

async function run(srv, chart, ctx = {}, createArtifact) {
  const sdk = await srv.newSdk();
  const plan = await planChartReconcile({ chart, sdk, chartArtifact: createArtifact }, ctx);
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

test('an unmanaged chart that already matches is not bound without approval, so a later edit still asks', async () => {
  const srv = server();
  const managed = fakeManaged();
  const same = await run(srv, declared({ chartType: 'Column', groupBy: 'cr_priority' }), { managed });
  assert.equal(same.plan.action, 'noChange');
  assert.deepEqual(same.result.managedBindings, [], 'matching the spec is not an approval to manage it');
  managed.persist(same.result.managedBindings);
  const edit = await run(srv, declared(), { managed });
  assert.deepEqual(edit.result.refused.map((r) => r.code), ['chart-adoption-not-authorized']);
  assert.equal(srv.writes.length, 0);
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

test('two charts with the declared name: nothing is chosen and nothing is written', async () => {
  const srv = server();
  srv.seed('savedqueryvisualizations', { ...srv.rowOf('savedqueryvisualizations', CID), savedqueryvisualizationid: '44444444-0000-4000-8000-000000000002' });
  const { plan, result } = await run(srv, declared(), { authorizedAdoption: true, creates: fakeCreates() }, chartArtifact());
  assert.equal(srv.writes.length, 0);
  assert.equal(plan.chartId, null);
  assert.deepEqual(result.saved, []);
  assert.deepEqual(result.refused.map((r) => r.code), ['chart-name-ambiguous']);
  assert.deepEqual(result.unknown, []);
});

// The ChartArtifact the build compiles for a declared chart (sdk-build chartDef), without an id.
const chartArtifact = (over = {}) => ({ name: 'Cases by priority', description: '', entityLogicalName: 'cr_case', chartType: 'Bar', isDefault: false,
  series: [{ attribute: 'cr_caseid', aggregate: 'count' }], categories: [{ attribute: 'cr_status' }], presentation: { showLegend: true, title: 'Cases by priority' }, ...over });

test('a missing chart is created through the creation port under the reserved id, with a full baseline; a rerun sends nothing', async () => {
  const srv = createRowTableServer({ tables: { savedqueryvisualizations: 'savedqueryvisualizationid' } });
  const managed = fakeManaged();
  const creates = fakeCreates();
  const publication = fakePublication();
  const { plan, result } = await run(srv, declared(), { managed, creates, publication }, chartArtifact());
  assert.equal(plan.action, 'create');
  assert.equal(creates.calls.length, 1);
  assert.equal(creates.calls[0].executed, true);
  const id = creates.calls[0].ids.id;
  assert.deepEqual(result.saved.map((s) => [s.id, s.created]), [[id, true]]);
  assert.ok(srv.rowOf('savedqueryvisualizations', id), 'the chart row carries the id the port reserved');
  assert.deepEqual(publication.queued, [{ type: 'chart', id, table: 'cr_case' }]);
  const b = result.managedBindings[0];
  assert.equal(b.origin, 'created');
  assert.equal(b.id, id);
  assert.ok(b.partsSha256 && b.partsSha256.title && b.partsSha256.description, 'the baseline covers the full projection');
  managed.persist(result.managedBindings);

  srv.clearLog();
  const again = await run(srv, declared(), { managed, creates });
  assert.equal(again.plan.action, 'noChange');
  assert.equal(srv.writes.length, 0);
  assert.equal(creates.calls.length, 1);
});

test('a missing chart is never created without the creation port, without the compiled artifact, or while an earlier create is unresolved', async () => {
  const empty = () => createRowTableServer({ tables: { savedqueryvisualizations: 'savedqueryvisualizationid' } });
  let srv = empty();
  let out = await run(srv, declared(), {}, chartArtifact());
  assert.deepEqual(out.result.refused.map((r) => r.code), ['creation-port-unavailable']);
  assert.equal(srv.writes.length, 0);

  srv = empty();
  const creates = fakeCreates();
  out = await run(srv, declared(), { creates });
  assert.deepEqual(out.result.refused.map((r) => r.code), ['chart-create-artifact-missing']);
  assert.equal(creates.calls.length, 0);
  assert.equal(srv.writes.length, 0);

  srv = empty();
  out = await run(srv, declared(), { creates: fakeCreates({ pendingUnknown: ['cr_case/Cases by priority'] }) }, chartArtifact());
  assert.deepEqual(out.result.refused.map((r) => r.code), ['creation-pending-unknown']);
  assert.equal(srv.writes.length, 0);
});

test('a bound chart is edited by its bound id only: a same-name replacement is refused, not adopted', async () => {
  const srv = server();
  const managed = fakeManaged();
  const first = await run(srv, declared({ chartType: 'Column', groupBy: 'cr_priority' }), { managed, authorizedAdoption: true });
  managed.persist(first.result.managedBindings);
  assert.equal(managed.lookup('chart', 'cr_case/Cases by priority').id, CID);
  const other = '44444444-0000-4000-8000-000000000002';
  const row = srv.rowOf('savedqueryvisualizations', CID);
  srv.store.get('savedqueryvisualizations').delete(CID);
  srv.seed('savedqueryvisualizations', { ...row, savedqueryvisualizationid: other });
  srv.clearLog();
  const second = await run(srv, declared(), { managed, authorizedAdoption: true });
  assert.equal(srv.writes.length, 0, 'the same-name chart was never managed by this spec');
  assert.deepEqual(second.result.refused.map((r) => r.code), ['chart-bound-row-missing']);
  assert.deepEqual(second.result.managedBindings, []);
});

test('a bound chart with an unrelated maker description change can still take an owned edit; the description is kept', async () => {
  const srv = server();
  const managed = fakeManaged();
  const first = await run(srv, declared({ chartType: 'Column', groupBy: 'cr_priority' }), { managed, authorizedAdoption: true });
  managed.persist(first.result.managedBindings);
  const row = srv.rowOf('savedqueryvisualizations', CID);
  row.description = 'Maker note';
  srv.clearLog();
  const second = await run(srv, declared({ chartType: 'Pie', groupBy: 'cr_priority' }), { managed });
  assert.deepEqual(second.result.refused, [], 'a part this run leaves alone is not a conflict');
  assert.deepEqual(second.plan.changed, ['chartType']);
  assert.equal(srv.rowOf('savedqueryvisualizations', CID).description, 'Maker note');
  managed.persist(second.result.managedBindings);
  // But declaring the description now, over the maker's edit, is drift.
  srv.clearLog();
  const third = await run(srv, declared({ chartType: 'Pie', groupBy: 'cr_priority', description: 'Spec text' }), { managed });
  assert.deepEqual(third.result.refused.map((r) => r.code), [], 'the maker text is the recorded baseline after the last apply');
  assert.equal(srv.rowOf('savedqueryvisualizations', CID).description, 'Spec text');
});
test('a read failure is unknown, never refused or saved', async () => {
  const sdk = { findArtifact: async () => { throw new Error('socket hang up'); } };
  const plan = await planChartReconcile({ chart: declared(), sdk });
  const result = await applyChartReconcile(plan, { sdk });
  assert.deepEqual(result.unknown.map((u) => u.code), ['chart-lookup-unreadable']);
  assert.deepEqual(result.refused, []);
});

// A presentation with no <Title> element: the SDK writes a title only into an existing one, so a
// declared title cannot be stored on it (the scratch presentation of a new chart has none either).
const PRES_NO_TITLE = PRES.replace(/<Titles>.*<\/Titles>/, '');

test('a declared title the stored chart cannot hold is never claimed saved, and a rerun is neither a write nor drift', async () => {
  const srv = server({ presentationdescription: PRES_NO_TITLE });
  const managed = fakeManaged();
  const first = await run(srv, declared(), { authorizedAdoption: true, managed });
  assert.deepEqual(first.result.refused, []);
  managed.persist(first.result.managedBindings);
  srv.clearLog();
  for (let i = 0; i < 2; i += 1) {
    srv.clearLog();
    const again = await run(srv, declared({ description: 'Open cases by status', title: 'By status' }), { managed });
    assert.deepEqual(again.result.refused.map((r) => [r.key, r.code]), [['cr_case/Cases by priority', 'chart-title-not-stored']], 'the same refusal each run, never chart-drift');
    assert.deepEqual(again.result.saved, [], 'nothing is claimed saved');
    assert.equal(srv.writes.length, 0, 'nothing is written');
    managed.persist(again.result.managedBindings);
  }
  assert.equal(srv.rowOf('savedqueryvisualizations', CID).description, '');
  // Without the title the rest of the spec applies.
  srv.clearLog();
  const without = await run(srv, declared({ description: 'Open cases by status' }), { managed });
  assert.deepEqual(without.result.refused, []);
  assert.deepEqual(without.result.saved.map((s) => s.parts), [['description']]);
});

test('a new chart with a declared title reports the title not stored instead of saved; the rerun is not drift', async () => {
  const srv = createRowTableServer({ tables: { savedqueryvisualizations: 'savedqueryvisualizationid' } });
  const managed = fakeManaged();
  const creates = fakeCreates();
  const spec = declared({ title: 'By status' });
  const { result } = await run(srv, spec, { managed, creates }, chartArtifact());
  assert.equal(creates.calls.length, 1);
  const id = creates.calls[0].ids.id;
  assert.ok(srv.rowOf('savedqueryvisualizations', id), 'the chart itself was created');
  assert.ok(!/By status/.test(srv.rowOf('savedqueryvisualizations', id).presentationdescription));
  assert.equal(result.saved.length, 1);
  assert.ok(!result.saved[0].parts.includes('title'), 'the title is not claimed saved');
  assert.deepEqual(result.refused.map((r) => r.code), ['chart-title-not-stored']);
  assert.equal(result.managedBindings.length, 1, 'the created chart is bound from what was read back');
  managed.persist(result.managedBindings);
  srv.clearLog();
  const again = await run(srv, spec, { managed, creates });
  assert.deepEqual(again.result.refused.map((r) => r.code), ['chart-title-not-stored']);
  assert.equal(srv.writes.length, 0);
  assert.equal(creates.calls.length, 1);
});
