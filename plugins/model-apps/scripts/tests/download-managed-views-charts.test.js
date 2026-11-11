'use strict';
// The explicit managed download (download-model-app.js main, --include-managed --managed-manifest <store>) over the build that made
// the store: a stable view and chart (createIdentity "stable-v1") built into a fake Dataverse by the real build and the real SDK, then
// downloaded through main with only its connections replaced. runDownload answers what the plain download of this app hydrates: no
// views[] or charts[], and the view and chart in the not-round-tripped inventory, by id.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../vendor/cds-maker-sdk.cjs');
const { runSdkBuild } = require('../lib/sdk-build.js');
const { createPublicationBarrier } = require('../lib/publication-barrier.js');
const { PREFIX } = require('../lib/managed-bindings.js');
const { main: downloadMain, notRoundTrippedSummary, notRoundTrippedWarning } = require('../download-model-app.js');
const { createFakeBuildOrg } = require('./helpers/fake-app-build-org.js');
const { gatedClient } = require('./helpers/gated-fake-client.js');

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
function newDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-managed-vc-'));
  dirs.push(dir);
  return dir;
}

const ENTITIES = {
  contoso_item: { attributes: { contoso_name: 'String', contoso_code: 'String', contoso_kind: 'Picklist', contoso_ownerid: 'Lookup' } },
  contoso_owner: { attributes: { contoso_name: 'String', contoso_rank: 'Integer' } },
};
const SOLUTION = 'ContosoStable';
const APP = 'contoso_stableids';
const APP_ID = '00000000-0000-4000-8000-00000000a111';

function makeSpec(extra = {}) {
  return {
    solution: { uniqueName: SOLUTION, displayName: 'Contoso Stable', publisherPrefix: 'contoso' },
    app: { name: 'Stable Ids', uniqueName: APP },
    entities: [{
      schemaName: 'contoso_item', displayName: 'Item', existing: true, primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' },
      columns: [{ schemaName: 'contoso_code', displayName: 'Code', type: 'Text' }, { schemaName: 'contoso_kind', displayName: 'Kind', type: 'Choice', options: [{ label: 'A', value: 100000000 }, { label: 'B', value: 100000001 }] }],
    }],
    views: [{ entity: 'contoso_item', name: 'Declared Items', reconcile: 'declared', columns: ['contoso_name', 'contoso_code'] }],
    charts: [{ entity: 'contoso_item', name: 'By Kind', chartType: 'Pie', groupBy: 'contoso_kind', reconcile: 'declared' }],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Records', subAreas: [{ entity: 'contoso_item', title: 'Items' }] }] }] },
    ...extra,
  };
}
const stableSpec = (extra) => makeSpec({ createIdentity: 'stable-v1', minimumPluginVersion: '2.21.0', ...extra });

// The build that keeps the store: views and charts only, published, as the CLI's build leaves them (its publish phase settles the
// chart's table publish; the views phase publishes its own).
async function build(org, dir, spec, phases = ['views', 'charts', 'publish']) {
  const barrier = createPublicationBarrier();
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: org.origin, httpClient: gatedClient(org, barrier, null) });
  await sdk.initWorkspace();
  const out = await runSdkBuild(spec, { sdk, apply: true, publish: true, workspaceDir: dir, appDir: dir, env: org.origin, warn: () => {}, phases, publicationBarrier: barrier });
  return { out, sdk };
}
const storeFileOf = (dir) => path.join(dir, fs.readdirSync(dir).find((f) => f.startsWith(PREFIX)));

// What a plain download of this app hydrates: the spec with no views[] or charts[] (a downloaded spec carries none), and the
// not-round-tripped inventory naming the view and chart the app holds.
function plainDownload(built) {
  const { createIdentity, minimumPluginVersion, ...spec } = makeSpec({ views: [], charts: [] });
  void createIdentity; void minimumPluginVersion;
  const inventory = {
    ...(built.view ? { views: [{ id: built.view, name: 'Declared Items', entity: 'contoso_item' }] } : {}),
    ...(built.chart ? { charts: [{ id: built.chart, name: 'By Kind', entity: 'contoso_item' }] } : {}),
  };
  return { spec, inventory };
}

// download-model-app.js main with its connections replaced; runDownload keeps runDownload's contract for the report: printed by it
// unless main asks it to defer (`deferReport`), then handed back as its parts.
async function download(org, out, argv, { downloaded, ...extra } = {}) {
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(newDir()), instanceUrl: org.origin, httpClient: org.httpClient });
  await sdk.initWorkspace();
  const dl = Object.create(sdk);
  dl.queryRecords = async (table, o) => (table === 'appmodule' ? [{ uniquename: APP }] : sdk.queryRecords(table, o));
  const asked = [];
  const emitted = [];
  const said = [];
  const printed = [];
  const mark = org.calls.length;
  await downloadMain({
    argv: ['--env', org.origin, '--app', APP_ID, '--out', out, ...argv],
    stderr: { write: (text) => { said.push(String(text)); return true; } },
    exit: () => {},
    emitResult: (ok, payload) => emitted.push({ ok, payload }),
    preflightAuth: async () => ({ ok: true }),
    makeDownloadSdk: async () => ({ sdk: dl, cleanup() {} }),
    makeGenpageSdk: () => ({}),
    runDownload: async (args) => {
      asked.push(args);
      const spec = JSON.parse(JSON.stringify(downloaded.spec));
      const notRoundTripped = notRoundTrippedSummary(downloaded.inventory);
      if (!args.deferReport && notRoundTripped) printed.push(notRoundTrippedWarning(notRoundTripped));
      return {
        ok: true, spec, pages: [], entities: [], webResources: [], droppedSubareas: 0, droppedSubareaDetails: [], notRoundTripped,
        ...(args.deferReport ? { deferredReport: { inventory: downloaded.inventory, membershipNotes: [] } } : {}),
      };
    },
    ...extra,
  });
  const specFile = path.join(out, 'app-spec.json');
  const calls = org.calls.slice(mark);
  return { asked, emitted, said: said.join(''), printed: printed.join(''), calls, writes: calls.filter((c) => c.method !== 'GET'), written: fs.existsSync(specFile) ? JSON.parse(fs.readFileSync(specFile, 'utf8')) : null };
}

async function builtApp(extra) {
  const org = createFakeBuildOrg({ entities: ENTITIES, solution: { uniqueName: SOLUTION } });
  const dir = newDir();
  const spec = stableSpec(extra);
  const { out } = await build(org, dir, spec);
  const built = { view: out.created.views['contoso_item|Declared Items'], chart: out.created.charts['contoso_item|By Kind'] };
  assert.ok((!spec.views.length || built.view) && (!spec.charts.length || built.chart), JSON.stringify(out.created));
  return { org, dir, built, flags: ['--include-managed', '--managed-manifest', storeFileOf(dir)] };
}

// --- the report seam ---------------------------------------------------------------------------------------------------------------

test('the managed download asks runDownload to defer the not-round-tripped report and prints it once, after the restore, less what it restored; the plain one does not ask', async () => {
  const { org, built, flags } = await builtApp();
  const downloaded = plainDownload(built);
  // A stock view no store proves: it stays in the report.
  const stock = { id: '00000000-0000-4000-8000-0000000000aa', name: 'Active Items', entity: 'contoso_item' };
  downloaded.inventory.views.push(stock);
  const managed = await download(org, newDir(), flags, { downloaded });
  assert.equal(managed.emitted.length, 1);
  assert.equal(managed.emitted[0].ok, true, JSON.stringify(managed.emitted) + managed.said);
  assert.equal(managed.asked[0].deferReport, true);
  // The declared view and chart are restored into views[] and charts[], so only the stock view is still reported as left out.
  const left = notRoundTrippedSummary({ views: [stock] });
  const warning = notRoundTrippedWarning(notRoundTrippedSummary(downloaded.inventory));
  assert.equal(managed.printed, '', 'runDownload printed nothing itself');
  assert.equal(managed.said.split(notRoundTrippedWarning(left)).length - 1, 1, `main printed the report once: ${managed.said}`);
  assert.equal(managed.said.includes(warning), false, 'and never the report that still names what was restored');
  assert.deepEqual(managed.emitted[0].payload.notRoundTripped, left);

  const plain = await download(org, newDir(), [], { downloaded });
  assert.equal(plain.emitted[0].ok, true, JSON.stringify(plain.emitted));
  assert.equal('deferReport' in plain.asked[0], false, 'the plain download asks runDownload exactly what it did');
  assert.equal(plain.printed, warning, 'runDownload printed the report, as it always did');
  assert.equal(plain.said.includes(warning), false, 'and main did not print it again');
  assert.deepEqual(plain.emitted[0].payload.notRoundTripped, notRoundTrippedSummary(downloaded.inventory));
});

test('a store rewritten while the managed download reads it stops the download before anything is written', async () => {
  const { org, dir, built, flags } = await builtApp();
  const { validateAppSpec } = require('../lib/app-spec.js');
  const file = storeFileOf(dir);
  let touched = false;
  const out = newDir();
  const res = await download(org, out, flags, {
    downloaded: plainDownload(built),
    // A build rewriting the store between the restore's first read and the publication of the download (JSON-equal, other bytes).
    validateAppSpec: (s, o) => {
      if (!touched) { fs.appendFileSync(file, '\n'); touched = true; }
      return validateAppSpec(s, o);
    },
  });
  assert.ok(touched);
  assert.equal(res.emitted.length, 1);
  assert.equal(res.emitted[0].ok, false, JSON.stringify(res.emitted));
  assert.equal(res.emitted[0].payload.code, 'managed-manifest-changed');
  assert.match(res.emitted[0].payload.error, /changed while this download read it.*Nothing was written\.$/s);
  assert.deepEqual(fs.readdirSync(out), [], 'no spec, baseline or fragments file');
  assert.deepEqual(res.writes, [], 'the download writes nothing to the service');
});

// --- managed views -----------------------------------------------------------------------------------------------------------------

const { viewDeclarationFromLive } = require('../lib/declared-view-io.js');
const VIEW_KEY = 'contoso_item/Declared Items';
// A declared view using every part a declaration can say: widths, a joined-table column, sort on the join and the base table, the
// default active filter, an `in` list written partly as a label, a condition with no value, one on the join, and the join's own filter.
const RICH_VIEW = {
  entity: 'contoso_item', name: 'Declared Items', reconcile: 'declared', description: 'Items by kind',
  columns: ['contoso_name', { name: 'contoso_code', width: 150 }, { name: 'own.contoso_name', relatedEntity: 'own', width: 120 }],
  sort: [{ attr: 'contoso_name', relatedEntity: 'own' }, { attr: 'contoso_code', dir: 'desc' }],
  filters: [{ attr: 'contoso_kind', op: 'in', values: ['A', 100000001] }, { attr: 'contoso_code', op: 'not-null' }, { attr: 'contoso_rank', op: 'gt', value: 3, relatedEntity: 'own' }],
  linkEntities: [{ name: 'contoso_owner', from: 'contoso_ownerid', to: 'contoso_ownerid', alias: 'own', linkType: 'outer', filters: [{ attr: 'contoso_rank', op: 'ge', value: 1 }] }],
};
const nonGet = (calls) => calls.filter((c) => c.method !== 'GET');
const savedQueryWrites = (calls) => nonGet(calls).filter((c) => /savedquer/i.test(c.path));
// Rewrite the view group of the store file in place (a test of what the restore makes of a group it cannot trust).
function editViewGroup(dir, edit) {
  const file = storeFileOf(dir);
  const store = JSON.parse(fs.readFileSync(file, 'utf8'));
  edit(store.groups.find((g) => g.family === 'view'));
  fs.writeFileSync(file, JSON.stringify(store, null, 2));
}

test('a view a stable build created is downloaded as the declaration that rebuilds it, pinned to its id, and is no longer reported as left out', async () => {
  const { org, dir, built, flags } = await builtApp({ views: [RICH_VIEW] });
  const downloaded = plainDownload(built);
  const stock = { id: '00000000-0000-4000-8000-0000000000aa', name: 'Active Items', entity: 'contoso_item' };
  downloaded.inventory.views.push(stock);
  const res = await download(org, newDir(), flags, { downloaded });
  assert.equal(res.emitted[0].ok, true, JSON.stringify(res.emitted) + res.said);
  assert.deepEqual(res.written.views, [{
    entity: 'contoso_item', name: 'Declared Items', reconcile: 'declared', description: 'Items by kind',
    columns: [{ name: 'contoso_name', width: 100 }, { name: 'contoso_code', width: 150 }, { name: 'own.contoso_name', relatedEntity: 'own', width: 120 }],
    sort: [{ attr: 'contoso_name', relatedEntity: 'own' }, { attr: 'contoso_code', dir: 'desc' }],
    // The active filter the build added is written out as a condition, with activeOnly false: never the default, re-guessed.
    activeOnly: false,
    filters: [
      { attr: 'statecode', op: 'eq', value: 0 },
      { attr: 'contoso_code', op: 'not-null' },
      { attr: 'contoso_rank', op: 'gt', value: 3, relatedEntity: 'own' },
      { attr: 'contoso_kind', op: 'in', values: [100000000, 100000001] },
    ],
    linkEntities: [{ name: 'contoso_owner', from: 'contoso_ownerid', to: 'contoso_ownerid', alias: 'own', linkType: 'outer', filters: [{ attr: 'contoso_rank', op: 'ge', value: 1 }] }],
    viewId: built.view,
  }]);
  assert.equal(res.written.createIdentity, 'stable-v1');
  assert.equal(res.written.minimumPluginVersion, '2.21.0');
  assert.deepEqual(res.emitted[0].payload.managedViews, { restored: [VIEW_KEY], omitted: [] });
  // The restored view (and the restored chart) leave the report; the stock view stays in it.
  const left = { views: [stock] };
  assert.deepEqual(res.emitted[0].payload.notRoundTripped, notRoundTrippedSummary(left));
  assert.equal(res.said.split(notRoundTrippedWarning(notRoundTrippedSummary(left))).length - 1, 1, res.said);
  assert.deepEqual(res.writes, [], 'the download writes nothing to the service');

  // A rebuild from the downloaded spec, through the build's own workspace and store, finds nothing to change: no view write, no publish.
  // The rebuild runs without the publish phase, which republishes every table a spec declares a view on whatever changed
  // (sdk-build.js phase 8): what is proved here is that the reconcile itself writes nothing and owes no publish.
  const reconcileOnly = ['views', 'charts'];
  const mark = org.calls.length;
  await build(org, dir, res.written, reconcileOnly);
  assert.deepEqual(savedQueryWrites(org.calls.slice(mark)), []);
  assert.deepEqual(org.publishLog(mark), []);
  // And from a new folder with no store, the pin alone names the row, which already holds the declaration.
  const fresh = org.calls.length;
  await build(org, newDir(), res.written, reconcileOnly);
  assert.deepEqual(savedQueryWrites(org.calls.slice(fresh)), []);
  assert.deepEqual(org.publishLog(fresh), []);
});

test('a managed view the restore cannot prove is left out of views[] with a fixed reason and stays in the report', async (t) => {
  const cases = [
    ['edited since its build proved it', 'changed', async ({ org, built }) => {
      await org.httpClient.patch(`${org.origin}/api/data/v9.2/savedqueries(${built.view})`, { description: 'Edited in the maker portal' });
    }],
    ['renamed and the rename not published', 'unpublished-changes', async ({ org, built }) => {
      await org.httpClient.patch(`${org.origin}/api/data/v9.2/savedqueries(${built.view})`, { name: 'Renamed Items' });
    }],
    ['adopted, not created, by its build', 'not-created', async ({ dir }) => editViewGroup(dir, (g) => { g.records[0].origin = 'adopted'; })],
    // The store says the table's publish is still owed (the shape a build leaves after a saved, unpublished write).
    ['whose publish is still owed', 'publication-unsettled', async ({ dir }) => editViewGroup(dir, (g) => { g.publication.state = 'owed'; g.publication.dispatchToken = null; })],
    ['deleted since', 'missing', async ({ org, built }) => {
      org.intercept((c) => c.method === 'GET' && c.path.includes(`savedqueries(${built.view})`), () => ({ status: 404, headers: {}, body: { error: { code: '0x80040217', message: 'Does Not Exist' } } }));
    }],
  ];
  for (const [what, code, provoke] of cases) {
    await t.test(what, async () => {
      // No chart, so a restored chart cannot opt the spec into stable ids either.
      const app = await builtApp({ charts: [] });
      await provoke(app);
      const downloaded = plainDownload(app.built);
      const res = await download(app.org, newDir(), app.flags, { downloaded });
      assert.equal(res.emitted[0].ok, true, JSON.stringify(res.emitted) + res.said);
      const omitted = res.emitted[0].payload.managedViews.omitted;
      assert.equal(omitted.length, 1, JSON.stringify(omitted));
      assert.equal(omitted[0].code, code);
      assert.equal(omitted[0].key, VIEW_KEY);
      assert.equal(omitted[0].id, app.built.view);
      assert.doesNotMatch(JSON.stringify(omitted), /Edited in the maker portal|Does Not Exist/, 'a reason never carries what the service said');
      assert.match(res.said, new RegExp(`WARNING: managed view ${VIEW_KEY} was not restored: `));
      assert.deepEqual(res.written.views, []);
      assert.equal(res.written.createIdentity, undefined, 'nothing restored, so the spec is not opted into stable ids');
      assert.deepEqual(res.emitted[0].payload.notRoundTripped, notRoundTrippedSummary(downloaded.inventory));
    });
  }
});

test('viewDeclarationFromLive refuses a view whose query a declaration cannot say, and never flattens a filter tree', () => {
  const view = (over = {}) => ({
    id: '00000000-0000-4000-8000-0000000000bb', name: 'V', entityLogicalName: 'contoso_item', queryType: 0,
    columns: [{ name: 'contoso_name', width: 100, order: 0 }],
    filters: { type: 'and', conditions: [{ attribute: 'contoso_code', operator: 'not-null' }], groups: [] },
    sort: [],
    fetchBag: { a: [['version', '1.0']], c: [{ i: 0, node: { n: 'entity', a: [['name', 'contoso_item']], c: [
      { n: 'attribute', a: [['name', 'contoso_name']], c: [] },
      { n: 'filter', a: [['type', 'and']], c: [{ n: 'condition', a: [['attribute', 'contoso_code'], ['operator', 'not-null']], c: [] }] },
    ] } }] },
    ...over,
  });
  assert.deepEqual(viewDeclarationFromLive(view(), { key: 'contoso_item/V' }).declaration, {
    entity: 'contoso_item', name: 'V', reconcile: 'declared', columns: [{ name: 'contoso_name', width: 100 }], activeOnly: false, filters: [{ attr: 'contoso_code', op: 'not-null' }],
  });
  assert.equal(viewDeclarationFromLive(view(), { key: 'custom-key' }).declaration.key, 'custom-key', 'a key that is not the default is kept');
  const tree = (groups) => ({ type: 'and', conditions: [], groups });
  const refused = {
    'an OR of two columns': { filters: tree([{ type: 'or', conditions: [{ attribute: 'a', operator: 'eq', value: '1' }, { attribute: 'b', operator: 'eq', value: '1' }], groups: [] }]) },
    'an OR of mixed operators': { filters: tree([{ type: 'or', conditions: [{ attribute: 'a', operator: 'eq', value: '1' }, { attribute: 'a', operator: 'ne', value: '2' }], groups: [] }]) },
    'a nested group': { filters: tree([{ type: 'or', conditions: [{ attribute: 'a', operator: 'eq', value: '1' }], groups: [{ type: 'and', conditions: [], groups: [] }] }]) },
    'an OR at the top': { filters: { type: 'or', conditions: [], groups: [] } },
    'a quick-find filter': { fetchBag: { a: [], c: [{ i: 0, node: { n: 'entity', a: [], c: [
      { n: 'filter', a: [['type', 'and']], c: [{ n: 'condition', a: [['attribute', 'contoso_code'], ['operator', 'not-null']], c: [] }] },
      { n: 'filter', a: [['type', 'or'], ['isquickfindfields', '1']], c: [{ n: 'condition', a: [['attribute', 'contoso_name'], ['operator', 'like'], ['value', '{0}']], c: [] }] },
    ] } }] } },
    'an aggregate query': { fetchBag: { a: [['aggregate', 'true']], c: [{ i: 0, node: { n: 'entity', a: [], c: [{ n: 'filter', a: [], c: [{ n: 'condition', a: [], c: [] }] }] } }] } },
    'a join the typed tree does not show': { fetchBag: { a: [], c: [{ i: 0, node: { n: 'entity', a: [], c: [
      { n: 'filter', a: [], c: [{ n: 'condition', a: [], c: [] }] }, { n: 'link-entity', a: [['name', 'x']], c: [] },
    ] } }] } },
    'a column read back without its join': { columns: [{ name: 'own.contoso_name', width: 100, order: 0 }] },
    'a column with no width': { columns: [{ name: 'contoso_name', order: 0 }] },
    'a quick find view': { queryType: 4 },
  };
  for (const [what, over] of Object.entries(refused)) {
    const out = viewDeclarationFromLive(view(over), { key: 'contoso_item/V' });
    assert.equal(out.declaration, undefined, what);
    assert.equal(typeof out.unsupported, 'string', what);
  }
});
// --- managed charts ----------------------------------------------------------------------------------------------------------------

const { chartDeclarationFromLive } = require('../lib/declared-chart-io.js');
const { readSavedQueryLayerRows } = require('../lib/savedquery-published.js');
const CHART_KEY = 'contoso_item/By Kind';
const chartWrites = (calls) => nonGet(calls).filter((c) => /savedqueryvisualization/i.test(c.path));
const API = (org) => `${org.origin}/api/data/v9.2`;
const chartRow = async (org, id) => (await org.httpClient.get(`${API(org)}/savedqueryvisualizations(${id})?$select=name,description,datadescription,presentationdescription`)).body;
const publishTable = (org) => org.httpClient.post(`${API(org)}/PublishXml`, { ParameterXml: '<importexportxml><entities><entity>contoso_item</entity></entities></importexportxml>' });
function editChartGroup(dir, edit) {
  const file = storeFileOf(dir);
  const store = JSON.parse(fs.readFileSync(file, 'utf8'));
  edit(store.groups.find((g) => g.family === 'chart'));
  fs.writeFileSync(file, JSON.stringify(store, null, 2));
}
// A maker edit the build then proved again: the store's confirmed publish names the saved layer as it is now, so only the restore's
// own checks (not the publish proof) can refuse the chart.
async function reproveChart({ org, dir }) {
  const client = { get: (p) => org.httpClient.get(`${API(org)}${p}`) };
  const store = JSON.parse(fs.readFileSync(storeFileOf(dir), 'utf8'));
  const { savedSha256 } = await readSavedQueryLayerRows('chart', client, store.groups.find((g) => g.family === 'chart'));
  editChartGroup(dir, (g) => { g.publication.desiredSha256 = savedSha256; });
}

test('a chart a stable build created is downloaded as the declaration that rebuilds it, and a rebuild through the store writes nothing, not even to a namesake', async () => {
  const { org, dir, built, flags } = await builtApp({ views: [] });
  const downloaded = plainDownload(built);
  const res = await download(org, newDir(), flags, { downloaded });
  assert.equal(res.emitted[0].ok, true, JSON.stringify(res.emitted) + res.said);
  assert.deepEqual(res.written.charts, [{ entity: 'contoso_item', name: 'By Kind', reconcile: 'declared', chartType: 'Pie', groupBy: 'contoso_kind', measure: 'count' }]);
  assert.equal(res.written.createIdentity, 'stable-v1');
  assert.equal(res.written.minimumPluginVersion, '2.21.0');
  assert.deepEqual(res.emitted[0].payload.managedCharts, { restored: [CHART_KEY], omitted: [] });
  assert.equal(notRoundTrippedSummary({}), null);
  assert.equal(res.emitted[0].payload.notRoundTripped, undefined, 'nothing is left to report');
  assert.doesNotMatch(res.said, /managed chart|does not reconstruct/);
  assert.deepEqual(res.writes, [], 'the download writes nothing to the service');

  // A chart with the same name on the same table, made after the build: the store names the exact row, so it is never the one bound.
  const before = await chartRow(org, built.chart);
  const namesakeRes = await org.httpClient.post(`${API(org)}/savedqueryvisualizations`, {
    name: 'By Kind', primaryentitytypecode: 'contoso_item', datadescription: before.datadescription, presentationdescription: before.presentationdescription,
  });
  assert.ok(namesakeRes.status < 300, JSON.stringify(namesakeRes));
  const again = await download(org, newDir(), flags, { downloaded });
  assert.deepEqual(again.written.charts, res.written.charts);
  assert.deepEqual(again.emitted[0].payload.managedCharts, { restored: [CHART_KEY], omitted: [] });

  const mark = org.calls.length;
  await build(org, dir, res.written);
  assert.deepEqual(chartWrites(org.calls.slice(mark)), [], 'no write to the chart or its namesake');
  assert.deepEqual(org.publishLog(mark), []);
  assert.deepEqual(await chartRow(org, built.chart), before, 'palette, colours and every other byte of the chart are as they were');
});

test('a managed chart the restore cannot prove is left out of charts[] with a fixed reason and stays in the report', async (t) => {
  const patch = (org, id, body) => org.httpClient.patch(`${API(org)}/savedqueryvisualizations(${id})`, body);
  const cases = [
    ['edited since its build proved it', 'changed', async ({ org, built }) => { await patch(org, built.chart, { description: 'Edited in the maker portal' }); }],
    ['renamed and the rename not published', 'unpublished-changes', async ({ org, built }) => { await patch(org, built.chart, { name: 'Renamed Kind' }); }],
    ['renamed, published and proved again', 'key-mismatch', async (app) => {
      await patch(app.org, app.built.chart, { name: 'Renamed Kind' });
      await publishTable(app.org);
      await reproveChart(app);
    }],
    ['given a filter the declaration cannot say, published and proved again', 'unsupported', async (app) => {
      const { datadescription } = await chartRow(app.org, app.built.chart);
      const filtered = datadescription.replace(/<\/entity>/, '<filter type="and"><condition attribute="contoso_code" operator="not-null" /></filter></entity>');
      assert.notEqual(filtered, datadescription);
      await patch(app.org, app.built.chart, { datadescription: filtered });
      await publishTable(app.org);
      await reproveChart(app);
    }],
    ['adopted, not created, by its build', 'not-created', async ({ dir }) => editChartGroup(dir, (g) => { g.records[0].origin = 'adopted'; })],
    ['whose publish is still owed', 'publication-unsettled', async ({ dir }) => editChartGroup(dir, (g) => { g.publication.state = 'owed'; g.publication.dispatchToken = null; })],
    ['deleted since', 'missing', async ({ org, built }) => {
      org.intercept((c) => c.method === 'GET' && c.path.includes(`savedqueryvisualizations(${built.chart})`), () => ({ status: 404, headers: {}, body: { error: { code: '0x80040217', message: 'Does Not Exist' } } }));
    }],
  ];
  for (const [what, code, provoke] of cases) {
    await t.test(what, async () => {
      const app = await builtApp({ views: [] });
      await provoke(app);
      const downloaded = plainDownload(app.built);
      const res = await download(app.org, newDir(), app.flags, { downloaded });
      assert.equal(res.emitted[0].ok, true, JSON.stringify(res.emitted) + res.said);
      const omitted = res.emitted[0].payload.managedCharts.omitted;
      assert.equal(omitted.length, 1, JSON.stringify(omitted));
      assert.equal(omitted[0].code, code);
      assert.equal(omitted[0].key, CHART_KEY);
      assert.equal(omitted[0].id, app.built.chart);
      assert.doesNotMatch(JSON.stringify(omitted), /Edited in the maker portal|Does Not Exist/, 'a reason never carries what the service said');
      assert.match(res.said, new RegExp(`WARNING: managed chart ${CHART_KEY} was not restored: `));
      assert.deepEqual(res.written.charts, []);
      assert.equal(res.written.createIdentity, undefined, 'nothing restored, so the spec is not opted into stable ids');
      assert.deepEqual(res.emitted[0].payload.notRoundTripped, notRoundTrippedSummary(downloaded.inventory));
      assert.deepEqual(res.writes, [], 'the download writes nothing to the service');
    });
  }
});

test('chartDeclarationFromLive says only one count of the id by one column of the table, and refuses the rest', () => {
  const chart = (over = {}) => ({
    id: '00000000-0000-4000-8000-0000000000cc', name: 'By Kind', description: '', entityLogicalName: 'contoso_item', chartType: 'Column', isDefault: false,
    series: [{ attribute: 'contoso_itemid', aggregate: 'count', alias: 'a' }], categories: [{ attribute: 'contoso_kind', alias: 'b' }],
    presentation: { showLegend: true }, ...over,
  });
  assert.deepEqual(chartDeclarationFromLive(chart()).declaration, { entity: 'contoso_item', name: 'By Kind', reconcile: 'declared', chartType: 'Column', groupBy: 'contoso_kind', measure: 'count' });
  assert.deepEqual(chartDeclarationFromLive(chart({ description: 'Items', presentation: { title: 'Kinds' } })).declaration,
    { entity: 'contoso_item', name: 'By Kind', reconcile: 'declared', chartType: 'Column', groupBy: 'contoso_kind', measure: 'count', description: 'Items', title: 'Kinds' });
  const refused = {
    'two series': { series: [{ attribute: 'contoso_itemid', aggregate: 'count' }, { attribute: 'contoso_itemid', aggregate: 'countcolumn' }] },
    'two categories': { categories: [{ attribute: 'contoso_kind' }, { attribute: 'contoso_code' }] },
    'a category grouped by date': { categories: [{ attribute: 'createdon', dateGrouping: 'month' }] },
    'a category on a joined table': { categories: [{ attribute: 'contoso_rank', relatedEntity: 'own' }] },
    'a measure on a joined table': { series: [{ attribute: 'contoso_ownerid', aggregate: 'count', relatedEntity: 'own' }] },
    'a measure of another column': { series: [{ attribute: 'contoso_code', aggregate: 'count' }] },
    'a sum': { series: [{ attribute: 'contoso_itemid', aggregate: 'sum' }] },
    'a chart type a declaration cannot say': { chartType: 'Radar' },
    'no name': { name: '  ' },
  };
  for (const [what, over] of Object.entries(refused)) {
    const out = chartDeclarationFromLive(chart(over));
    assert.equal(out.declaration, undefined, what);
    assert.equal(typeof out.unsupported, 'string', what);
  }
});

// --- field security profiles: reported by both downloads, restored by neither ---------------------------------------------------

test('the field security profiles runDownload reports reach the result of a plain and a managed download alike, and neither declares one', async () => {
  const { org, built, flags } = await builtApp();
  const downloaded = plainDownload(built);
  const omitted = [{ kind: 'fieldSecurityProfile', id: '00000000-0000-4000-8000-0000000000f1', name: 'HR', code: 'ownership-unproven', reason: 'no binding store record proves this app authored it, so it is not declared' }];
  const runDownload = async (args) => {
    const notRoundTripped = notRoundTrippedSummary(downloaded.inventory);
    return {
      ok: true, spec: JSON.parse(JSON.stringify(downloaded.spec)), pages: [], entities: [], webResources: [], droppedSubareas: 0, droppedSubareaDetails: [], notRoundTripped,
      fieldSecurityProfiles: { omitted },
      ...(args.deferReport ? { deferredReport: { inventory: downloaded.inventory, membershipNotes: [] } } : {}),
    };
  };
  for (const argv of [[], flags]) {
    const run = await download(org, newDir(), argv, { downloaded, runDownload });
    assert.equal(run.emitted[0].ok, true, JSON.stringify(run.emitted) + run.said);
    assert.deepEqual(run.emitted[0].payload.fieldSecurityProfiles, { omitted });
    assert.equal('fieldSecurityProfiles' in run.written, false);
    assert.equal(run.writes.some((c) => /fieldsecurityprofile|fieldpermission/i.test(c.path)), false);
  }
});
