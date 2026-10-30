'use strict';
// Declared dashboard reconciliation through the REAL vendored SDK over an in-memory systemforms
// table, with the build's own tile mapping (dashboardTileOpts + dashboardComponent): an authored tile
// edit lands on its own cell only, a new keyed tile is appended under the creation port's id, a
// foreign custom-control tile and the platform's per-tile defaults survive, and refusals send nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRowTableServer } = require('./helpers/row-table-server.js');
const { fakeCreates, fakeManaged, fakePublication } = require('./helpers/feature-ports.js');
const X = require('./helpers/dashboard-formxml.js');
const { dashboardTileOpts, dashboardComponent } = require('../lib/sdk-build.js');
const {
  validateDeclaredDashboard,
  planDashboardReconcile,
  applyDashboardReconcile,
  expectedDashboardProjection,
  createdDashboardBindings,
} = require('../lib/dashboard-reconcile.js');

const DID = '55555555-0000-4000-8000-000000000001';
const V_OPEN = '66666666-0000-4000-8000-000000000001';
const V_MINE = '66666666-0000-4000-8000-000000000002';
const LIST_CTRL = '{c1c1c1c1-0000-4000-8000-000000000001}';
const FOREIGN_CTRL = '{c2c2c2c2-0000-4000-8000-000000000002}';
const FOREIGN_CELL_RE = /<cell colspan="2" rowspan="8" showlabel="false" id="\{aaaaaaaa-0000-4000-8000-000000000002\}" auto="false"><labels><label description="Foreign" languagecode="1033" \/><\/labels><control id="\{c2c2c2c2-0000-4000-8000-000000000002\}" classid="\{F9A8A302-114E-466A-B582-6771B2AE0D92\}" uniqueid="\{77777777-0000-4000-8000-000000000001\}"><parameters><Mode>compact<\/Mode><\/parameters><\/control><\/cell>/;

const spec = { views: [{ entity: 'incident', name: 'Open cases' }, { entity: 'incident', name: 'My cases' }] };
const built = { created: { views: { 'incident|Open cases': V_OPEN, 'incident|My cases': V_MINE }, charts: {} } };
const resolveTile = (t) => dashboardTileOpts(spec, t, built);

function server() {
  const srv = createRowTableServer({ tables: { systemforms: 'formid' } });
  const xml = X.dashboardXml([[X.nativeGrid(LIST_CTRL, 'Open cases', V_OPEN), X.otherCustomControl(FOREIGN_CTRL, 'Foreign', '77777777-0000-4000-8000-000000000001')]]);
  srv.seed('systemforms', { formid: DID, name: 'Ops', description: '', type: 0, objecttypecode: 'none', formxml: xml, istabletenabled: false });
  return srv;
}
const declared = (tiles, over = {}) => ({ name: 'Ops', reconcile: 'declared', tiles, ...over });
const listTile = (over = {}) => ({ key: 'open', type: 'list', view: 'Open cases', componentId: LIST_CTRL, ...over });

async function run(srv, dashboard, ctx = {}) {
  const sdk = await srv.newSdk();
  const plan = await planDashboardReconcile({ dashboard, dashboardId: DID, sdk, resolveTile, toComponent: dashboardComponent }, ctx);
  const result = await applyDashboardReconcile(plan, { sdk }, ctx);
  return { plan, result, sdk };
}
const formXml = (srv) => srv.rowOf('systemforms', DID).formxml;

test('an authored tile edit lands on its own cell; a new keyed tile is appended under the creation id; the foreign tile and unauthored defaults survive; a rerun sends nothing', async () => {
  const srv = server();
  const creates = fakeCreates();
  const managed = fakeManaged();
  const publication = fakePublication();
  const witnessed = [];
  const tiles = [listTile({ view: 'My cases', name: 'My cases', rowspan: 12 }), { key: 'mine2', type: 'list', view: 'Open cases', name: 'Second' }];
  // 'mine2' shows the same view the adopted 'open' tile showed: the twin guard must not fire for it,
  // because the dashboard is adopted explicitly and the live tile is claimed by 'open'.
  const { plan, result } = await run(srv, declared(tiles), { authorizedAdoption: true, creates, managed, publication, witness: (w) => witnessed.push(w) });
  assert.deepEqual(plan.tiles.map((e) => e.action), ['update', 'create']);
  assert.deepEqual(plan.tiles[0].changed, ['name', 'rowspan', 'parameters/ViewId']);
  assert.equal(srv.writes.length, 1, 'one PATCH for the whole dashboard');
  const xml = formXml(srv);
  assert.match(xml, /<cell colspan="2" rowspan="12" showlabel="false" id="\{aaaaaaaa-0000-4000-8000-000000000001\}" auto="false"><labels><label description="My cases"/, 'the edited cell keeps its id, colspan and bag');
  assert.match(xml, /<RecordsPerPage>8<\/RecordsPerPage><HeaderColorCode>#F3F3F3<\/HeaderColorCode><ViewId>66666666-0000-4000-8000-000000000002<\/ViewId>/, 'only the authored ViewId changed; the per-tile defaults are kept');
  assert.match(xml, FOREIGN_CELL_RE, 'the foreign custom-control tile is byte-identical');
  const minted = creates.calls[0].ids.childIds['ops/mine2'];
  assert.ok(xml.includes(`<control id="{${minted}}"`) || xml.includes(`<control id="${minted}"`), 'the new tile carries the creation port\'s id');
  assert.deepEqual(publication.queued, [{ type: 'dashboard', id: DID }]);
  assert.equal(witnessed.length, 1);
  assert.equal(witnessed[0].expected.components.length, 3, 'the witness gets the artifact as pushed');
  assert.deepEqual(result.managedBindings.map((b) => [b.kind, b.key, b.origin]), [['dashboard-tile', 'ops/open', 'adopted'], ['dashboard-tile', 'ops/mine2', 'created'], ['dashboard', 'ops', 'adopted']]);
  managed.persist(result.managedBindings);

  srv.clearLog();
  const again = fakePublication();
  // Bound now: the componentId pin is no longer needed.
  const second = await run(srv, declared([listTile({ view: 'My cases', name: 'My cases', rowspan: 12, componentId: undefined }), tiles[1]]), { creates, managed, publication: again });
  assert.equal(second.plan.action, 'noChange');
  assert.equal(srv.writes.length, 0);
  assert.deepEqual(again.queued, []);
  assert.equal(creates.calls.length, 1, 'no second tile is created');
});

test('an unmanaged dashboard needs adoption approval before any write', async () => {
  const srv = server();
  const { result } = await run(srv, declared([listTile({ name: 'Renamed' })]));
  assert.deepEqual(result.refused.map((r) => r.code), ['dashboard-adoption-not-authorized']);
  assert.equal(srv.writes.length, 0);
});

test('a keyed tile with no pin that matches a live tile is refused rather than added twice', async () => {
  const srv = server();
  const { result } = await run(srv, declared([{ key: 'open', type: 'list', view: 'Open cases' }]), { authorizedAdoption: true, creates: fakeCreates() });
  assert.deepEqual(result.refused.map((r) => r.code), ['dashboard-tile-match-unpinned']);
  assert.equal(srv.writes.length, 0);
});

test('a type change is refused and nothing is written, even for the other tiles', async () => {
  const srv = server();
  const { result } = await run(srv, declared([{ key: 'open', type: 'iframe', name: 'Web', url: 'https://contoso.example', componentId: LIST_CTRL }, listTile({ key: 'x', componentId: undefined, view: 'My cases' })]), { authorizedAdoption: true, creates: fakeCreates() });
  assert.deepEqual(result.refused.map((r) => r.code), ['dashboard-tile-type-change']);
  assert.equal(srv.writes.length, 0);
});

test('drift on an authored tile part is refused until the overwrite is approved', async () => {
  const srv = server();
  const managed = fakeManaged();
  const first = await run(srv, declared([listTile({ name: 'Open' })]), { authorizedAdoption: true, managed });
  managed.persist(first.result.managedBindings);
  const row = srv.rowOf('systemforms', DID);
  row.formxml = row.formxml.replace('<label description="Open" ', '<label description="Someone else" ');
  srv.clearLog();
  const refused = await run(srv, declared([listTile({ name: 'Open' })]), { managed });
  assert.deepEqual(refused.result.refused.map((r) => r.code), ['dashboard-tile-drift']);
  assert.equal(srv.writes.length, 0);
  const approved = await run(srv, declared([listTile({ name: 'Open' })]), { managed, authorizedOverwrite: ['ops/open'] });
  assert.equal(approved.result.saved.length, 1);
  assert.match(formXml(srv), /<label description="Open" /);
});

test('a spec that starts declaring a tile name or size is an edit, not drift; stopping again is not drift either', async () => {
  const srv = server();
  const managed = fakeManaged();
  const first = await run(srv, declared([listTile()]), { authorizedAdoption: true, managed });
  managed.persist(first.result.managedBindings);
  srv.clearLog();
  const second = await run(srv, declared([listTile({ name: 'Renamed', rowspan: 10 })]), { managed });
  assert.deepEqual(second.result.refused, [], 'the binding was recorded before the spec owned the name and size');
  assert.deepEqual(second.plan.tiles[0].changed, ['name', 'rowspan']);
  assert.match(formXml(srv), /rowspan="10"[^>]*><labels><label description="Renamed" /);
  managed.persist(second.result.managedBindings);
  srv.clearLog();
  // Recorded with the name and rowspan owned; now the colspan joins them.
  const wider = await run(srv, declared([listTile({ name: 'Renamed', rowspan: 10, colspan: 4 })]), { managed });
  assert.deepEqual(wider.result.refused, [], 'a binding recorded under a partial ownership still matches');
  assert.deepEqual(wider.plan.tiles[0].changed, ['colspan']);
  assert.match(formXml(srv), /<cell colspan="4" rowspan="10"/);
  managed.persist(wider.result.managedBindings);
  srv.clearLog();
  const third = await run(srv, declared([listTile()]), { managed });
  assert.deepEqual(third.result.refused, []);
  assert.equal(third.plan.action, 'noChange');
  assert.equal(srv.writes.length, 0);
});

test('a tile omitted from the spec is never removed', async () => {
  const srv = server();
  await run(srv, declared([listTile({ name: 'Only this' })]), { authorizedAdoption: true });
  assert.match(formXml(srv), FOREIGN_CELL_RE);
});

test('a new tile without the creation port is refused before any write; a pending unknown creation blocks a second one', async () => {
  const srv = server();
  const managed = fakeManaged([{ kind: 'dashboard', key: 'ops', id: DID, origin: 'created', intentSha256: 'x' }]);
  const noPort = await run(srv, declared([{ key: 'new', type: 'list', view: 'My cases' }]), { managed });
  assert.deepEqual(noPort.result.refused.map((r) => r.code), ['creation-port-unavailable']);
  const pending = await run(srv, declared([{ key: 'new', type: 'list', view: 'My cases' }]), { managed, creates: fakeCreates({ pendingUnknown: ['ops'] }) });
  assert.deepEqual(pending.result.refused.map((r) => r.code), ['creation-pending-unknown']);
  assert.equal(srv.writes.length, 0);
});

test('declared tiles must be keyed and unique', () => {
  const errors = validateDeclaredDashboard(declared([{ type: 'list', view: 'a' }, { key: 'k', type: 'list' }, { key: 'k', type: 'list' }, { key: 'z', type: 'list', componentId: 'nope' }]));
  assert.equal(errors.length, 3);
  assert.match(errors[0], /tiles\[0\]: key is required/);
  assert.match(errors[1], /tiles\[2\]: key 'k' is used twice/);
  assert.match(errors[2], /tiles\[3\]: componentId must be a GUID/);
});

test('the bindings of a dashboard the build creates pair tile i with component i of the expected projection', async () => {
  const srv = createRowTableServer({ tables: { systemforms: 'formid' } });
  const sdk = await srv.newSdk();
  const dash = declared([{ key: 'a', type: 'list', view: 'Open cases' }, { key: 'b', type: 'list', view: 'My cases' }]);
  const art = await sdk.createArtifact('dashboard', { name: 'Ops' });
  for (let i = 0; i < dash.tiles.length; i++) await sdk.addElement('dashboard', art.id, '/components', dashboardComponent(resolveTile(dash.tiles[i]), i));
  const expected = await expectedDashboardProjection(sdk, art.id);
  const bindings = createdDashboardBindings({ dashboard: dash, artifact: expected, resolveTile, toComponent: dashboardComponent });
  assert.deepEqual(bindings.map((b) => [b.key, b.id]), [['ops/a', expected.components[0].id.replace(/[{}]/g, '').toLowerCase()], ['ops/b', expected.components[1].id.replace(/[{}]/g, '').toLowerCase()], ['ops', art.id.toLowerCase()]]);
  assert.equal(srv.writes.length, 0);
});
