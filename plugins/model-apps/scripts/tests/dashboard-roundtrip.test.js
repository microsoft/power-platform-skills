'use strict';
// #478 — the vendored SDK could not deserialize a dashboard it had just serialized.
//
// `fetchArtifact('dashboard', id)` threw `Cannot read properties of null (reading 'length')` while
// parsing the `<parameters>` block the SAME bundle emitted, so `download-model-app.js` recovered no
// tiles, dropped the dashboard's sitemap subarea, and failed the whole download unless
// `--allow-lossy-download` was passed. Root cause upstream: the grammar walk descended into TEXT
// nodes, and the bundled @xmldom/xmldom returns `null` for a text node's `.childNodes`.
//
// MEASURED across the re-vendor, with this exact harness:
//   bundle at HEAD before the uptake ... 0/4 round-tripped
//   bundle after the uptake ............ 4/4 round-tripped
//
// There was NO regression test for this — the bug was found by live-verifying a PR, and it survived
// two separate SDK uptakes because nothing in the suite ever fed a serialized dashboard back in.
// That is exactly the gap this file closes: the transport REMEMBERS what was pushed and serves it
// back on read, so the assertion is "deserialize what you serialized" rather than "parse a fixture
// someone hand-wrote to match the parser".
//
// https://github.com/microsoft/power-platform-skills/issues/478
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const BUNDLE = path.resolve(__dirname, '..', 'vendor', 'cds-maker-sdk.cjs');
const DASH_ID = '33333333-3333-3333-3333-333333333333';

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

async function harness() {
  const { createMakerSdk, createNodeWorkspaceStorage } = require(BUNDLE);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-478-'));
  dirs.push(dir);
  const store = {};
  const httpClient = {
    // Serve back the row that was written, not a fixture. A recorder that never consults its own
    // store cannot model a round trip, and a mock that cannot model the failure will certify it.
    get: async (url) => {
      if (/systemforms\(/i.test(url)) {
        return { status: 200, headers: { etag: 'W/"1"' }, body: Object.assign({ formid: DASH_ID, name: 'Field Ops', type: 0 }, store.row || {}) };
      }
      return { status: 200, headers: {}, body: { value: [] } };
    },
    post: async (url, body) => {
      if (/systemforms/i.test(url)) { store.row = Object.assign({}, body); return { status: 204, headers: { 'odata-entityid': `https://x/systemforms(${DASH_ID})` }, body: {} }; }
      return { status: 204, headers: {}, body: {} };
    },
    patch: async (url, body) => {
      if (/systemforms\(/i.test(url)) store.row = Object.assign({}, store.row, body);
      return { status: 204, headers: { etag: 'W/"2"' }, body: {} };
    },
    put: async () => ({ status: 204, headers: {}, body: {} }),
    delete: async () => ({ status: 204, headers: {}, body: {} }),
  };
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: 'https://contoso.crm.dynamics.com', httpClient });
  await sdk.initWorkspace();
  return { sdk, store };
}

// Every tile shape the plugin can emit. The bug was independent of tile type and of the
// `VisualizationId` vs `ChartId` spelling — both threw — so all of them are pinned.
const TILES = {
  'list tile': { type: 'list', id: 'l1', name: 'Open', colspan: 1, rowspan: 1, parameters: { ViewId: '44444444-4444-4444-4444-444444444444', TargetEntityType: 'cfo_workorder' } },
  'chart tile (VisualizationId)': { type: 'chart', id: 'c1', name: 'ByStatus', colspan: 1, rowspan: 1, parameters: { VisualizationId: '55555555-5555-5555-5555-555555555555', TargetEntityType: 'cfo_workorder' } },
  'chart tile (ChartId spelling)': { type: 'chart', id: 'c2', name: 'ByOwner', colspan: 1, rowspan: 1, parameters: { ChartId: '66666666-6666-6666-6666-666666666666', TargetEntityType: 'cfo_workorder' } },
  // An EMPTY parameter value produces a childless text node, which is the shape that made the walk
  // read `.childNodes` off a text node in the first place.
  'tile with an EMPTY parameter value': { type: 'list', id: 'l2', name: 'Empty', colspan: 1, rowspan: 1, parameters: { ViewId: '', TargetEntityType: 'cfo_workorder' } },
};

for (const [label, tile] of Object.entries(TILES)) {
  test(`REAL BUNDLE: a dashboard with a ${label} survives serialize -> deserialize`, async () => {
    const { sdk, store } = await harness();
    const art = await sdk.createArtifact('dashboard', { name: 'Field Ops' });
    await sdk.addElement('dashboard', art.id, '/components', tile);
    await sdk.pushArtifact('dashboard', art.id);

    // Guard the guard: if the push stopped emitting <parameters> the round trip would pass for the
    // wrong reason, since <parameters> is the block that used to throw.
    assert.match(String(store.row && store.row.formxml), /<parameters>/i,
      'the pushed dashboard must actually contain a <parameters> block, or this test proves nothing');

    const back = await sdk.fetchArtifact('dashboard', DASH_ID);
    const comps = (back && (back.components || (back.artifact && back.artifact.components))) || [];
    assert.strictEqual(comps.length, 1, `the tile must come back; got ${JSON.stringify(comps)}`);
  });
}

// A tile's height is its rowspan, counted in rows of the dashboard grid, and the app draws a one-row tile as its
// title bar alone: no chart, no list. The build used to send `rowspan: 1` for every tile the spec did not size, so a
// generated dashboard showed a column of title bars. The platform's own dashboards give chart and list tiles 9 to 24
// rows, most often 12, which is the default now. These tests push the payload PRODUCTION builds for a spec's tiles —
// `dashboardTileOpts` (the tile with its authored size) and then `dashboardComponent` (the default size) — through the
// real bundle, and read the cells it wrote:
//   <cell id="{…}" colspan="1" rowspan="12" showlabel="true"><labels>…</labels><control …>…</control></cell>
const VIEW = '{44444444-4444-4444-4444-444444444444}';
const CHART = '{55555555-5555-5555-5555-555555555555}';

// Pushes a dashboard of the given spec tiles the way the build's dashboards phase does. Returns the stored FormXML's
// rows, each a list of [rowspan, colspan] per tile cell, and the same pair for each tile the SDK reads back.
async function pushTiles(specTiles) {
  const { dashboardTileOpts, dashboardComponent } = require(path.resolve(__dirname, '..', 'lib', 'sdk-build.js'));
  const spec = { views: [{ name: 'Open', entity: 'cfo_workorder' }], charts: [{ name: 'By Status', entity: 'cfo_workorder' }] };
  const created = { views: { 'cfo_workorder|Open': VIEW }, charts: { 'cfo_workorder|By Status': CHART } };
  const { sdk, store } = await harness();
  const art = await sdk.createArtifact('dashboard', { name: 'Field Ops' });
  for (let i = 0; i < specTiles.length; i++) {
    await sdk.addElement('dashboard', art.id, '/components', dashboardComponent(dashboardTileOpts(spec, specTiles[i], { created }), i));
  }
  await sdk.pushArtifact('dashboard', art.id);
  const formxml = String(store.row && store.row.formxml);
  // Only a cell holding a control is a tile; a cell without one is a spacer.
  const rows = [...formxml.matchAll(/<row>([\s\S]*?)<\/row>/g)].map((row) => [...row[1].matchAll(/<cell\b([^>]*)>([\s\S]*?)<\/cell>/g)]
    .filter((cell) => /<control\b/.test(cell[2]))
    .map((cell) => ['rowspan', 'colspan'].map((attr) => Number(new RegExp(`\\b${attr}="(\\d+)"`).exec(cell[1])[1]))));
  const back = await sdk.fetchArtifact('dashboard', DASH_ID);
  const components = (back && (back.components || (back.artifact && back.artifact.components))) || [];
  return { formxml, rows, read: components.map((c) => [c.rowspan, c.colspan]) };
}

test('REAL BUNDLE: a tile the spec does not size is built 12 rows tall, and an authored size is kept', async () => {
  const { rows, read } = await pushTiles([
    { type: 'chart', chart: 'By Status', view: 'Open' },
    { type: 'list', view: 'Open', name: 'Open' },
    { type: 'list', view: 'Open', name: 'Recent', rowspan: 6, colspan: 2 },
    { type: 'iframe', name: 'Map', url: 'https://contoso.com/map' },
    { type: 'webresource', name: 'Widget', webResource: 'new_widget.html' },
    { type: 'list', view: 'Open', name: 'Strip', rowspan: 1 },
  ]);
  const sizes = [[12, 1], [12, 1], [6, 2], [12, 1], [12, 1], [1, 1]];
  assert.deepStrictEqual(rows.flat(), sizes, `each tile's cell must carry its size, in tile order; got ${JSON.stringify(rows)}`);
  assert.deepStrictEqual(read, sizes, 'the SDK must read the same sizes back');
});

// How tiles lay out is the adapter's, not the plugin's: a grid two columns wide, filled in tile order from left to
// right. The App Spec reference tells authors so (two `colspan: 1` tiles share a row; `colspan: 2` is a full-width
// one), and a wider default height changes none of it, so it is pinned here against the bundle that does it.
test('REAL BUNDLE: tiles fill a two-column grid left to right, and a tile too wide for the rest of a row starts the next', async () => {
  const { rows, formxml } = await pushTiles([
    { type: 'list', view: 'Open', name: 'A' },
    { type: 'list', view: 'Open', name: 'B' },
    { type: 'list', view: 'Open', name: 'C', colspan: 2 },
    { type: 'list', view: 'Open', name: 'D' },
    { type: 'list', view: 'Open', name: 'E', colspan: 2 },
    { type: 'list', view: 'Open', name: 'F', colspan: 3 },
  ]);
  assert.match(formxml, /<section\b[^>]*\bcolumns="2"/, 'the section is two columns wide');
  assert.deepStrictEqual(rows.map((row) => row.map(([, colspan]) => colspan)), [[1, 1], [2], [1], [2], [2]],
    `A and B share a row, C takes one, D waits alone because E does not fit beside it, and F's colspan 3 is narrowed to the grid; got ${JSON.stringify(rows)}`);
});

test('dashboardComponent: every tile kind defaults to 12 rows by 1 column, and an authored size wins', () => {
  const { dashboardComponent } = require(path.resolve(__dirname, '..', 'lib', 'sdk-build.js'));
  for (const tile of [{ type: 'chart' }, { type: 'list' }, { type: 'iframe', url: 'https://contoso.com/map' }, { type: 'webresource', webResourceName: 'new_widget.html' }]) {
    const c = dashboardComponent(tile, 0);
    assert.deepStrictEqual([c.rowspan, c.colspan], [12, 1], `${tile.type} tile default size`);
  }
  const sized = dashboardComponent({ type: 'list', rowspan: 1, colspan: 2 }, 0);
  assert.deepStrictEqual([sized.rowspan, sized.colspan], [1, 2], 'an authored size is kept, even a rowspan of 1');
  // The two sizes are independent: authoring one leaves the other at its default.
  const tall = dashboardComponent({ type: 'list', rowspan: 4 }, 0);
  assert.deepStrictEqual([tall.rowspan, tall.colspan], [4, 1], 'an authored rowspan leaves the width at 1');
  const wide = dashboardComponent({ type: 'list', colspan: 2 }, 0);
  assert.deepStrictEqual([wide.rowspan, wide.colspan], [12, 2], 'an authored colspan leaves the height at 12');
});

test('dashboardComponent: a list tile\'s payload carries its class, its place in the grid, its size and its parameters', () => {
  const { dashboardComponent } = require(path.resolve(__dirname, '..', 'lib', 'sdk-build.js'));
  assert.deepStrictEqual(dashboardComponent({ type: 'list', name: 'Open', targetEntity: 'cfo_workorder', viewId: VIEW }, 2), {
    type: 'list', name: 'Open', classId: 'E7A81278-8635-4D9E-8D4D-59480B391C5B',
    position: { tabIndex: 0, columnIndex: 0, sectionIndex: 0, rowIndex: 2, cellIndex: 0 },
    colspan: 1, rowspan: 12,
    parameters: { TargetEntityType: 'cfo_workorder', ViewId: VIEW, IsUserView: 'false', ChartGridMode: 'Grid', RecordsPerPage: '10' },
  });
});
