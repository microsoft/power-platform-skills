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

function harness() {
  const { createMakerSdk } = require(BUNDLE);
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
  const sdk = createMakerSdk({ workspacePath: dir, instanceUrl: 'https://contoso.crm.dynamics.com', httpClient });
  sdk.initWorkspace();
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
    const { sdk, store } = harness();
    const art = sdk.createArtifact('dashboard', { name: 'Field Ops' });
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
