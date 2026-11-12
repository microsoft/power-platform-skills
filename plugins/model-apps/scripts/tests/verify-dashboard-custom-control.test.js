'use strict';
// REAL BUNDLE: what `--verify` says of a dashboard that holds a chart tile a custom control hosts.
//
// Verify holds every chart tile of a deployed dashboard to the table it shows: its chart and its view must belong to the tile's
// `TargetEntityType`, because the platform publishes a tile whose chart is another table's and nothing else would say so. That
// is a check of the tiles the BUILD makes from the spec. The SDK types a chart that a custom control hosts `chart`, as it does a
// native one (it used to type every custom-control tile as the Assistant, which verify skipped), so the check read such a tile as
// a native chart. A host that carries no native visualization made the dashboard fail — "its chart or view could not be
// resolved" — and with it `build --verify` of a build that had written nothing to the dashboard.
//
// The App Spec cannot express a custom control, so a download leaves the tile out and a rebuild never touches it; verify leaves
// it alone too, as it did before. A native chart tile is still held to its table, and the Assistant and any other custom control
// are skipped as they always were. The classification is the download's: lib/dashboard-tiles.js.
const test = require('node:test');
const assert = require('node:assert');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../vendor/cds-maker-sdk.cjs');
const { verifySpec } = require('../lib/verify-spec.js');
const { readerFor } = require('../verify-model-app.js');
const { createFakeDataverse } = require('./helpers/fake-dataverse.js');
const {
  nativeGrid, nativeChart, customGrid, customChart, assistantTile, otherCustomControl, customDescription, dashboardXml,
} = require('./helpers/dashboard-formxml.js');

const API = 'https://contoso.crm.dynamics.com/api/data/v9.0';
const DASHBOARD_ID = '33333333-3333-4333-8333-333333333333';
const OPEN_VIEW = '11111111-0000-4000-8000-0000000000a1';
const CHART_VIEW = '11111111-0000-4000-8000-0000000000a3';
const CHART = '22222222-0000-4000-8000-0000000000b1';
const OTHER_TABLE_CHART = '22222222-0000-4000-8000-0000000000b9';
const GRID_UNIQUE = 'cccccccc-0000-4000-8000-000000000001';
const CHART_UNIQUE = 'cccccccc-0000-4000-8000-000000000002';
const OTHER_UNIQUE = 'cccccccc-0000-4000-8000-000000000003';

// The charts and views the environment holds, each by the table it belongs to, whatever the dashboard says about them.
const ENVIRONMENT = {
  charts: { [CHART]: 'incident', [OTHER_TABLE_CHART]: 'account' },
  views: { [OPEN_VIEW]: 'incident', [CHART_VIEW]: 'incident' },
};

// `verifySpec` over the REAL SDK and the real reader seam (`readerFor`), against a fake environment that holds one dashboard
// (the spec pins it by its id, as a download writes it) and the charts and views above. The spec declares the native tile only.
async function verifying(formxml) {
  const fake = createFakeDataverse({ entities: { incident: {} } });
  const post = (set, body) => fake.httpClient.post(`${API}/${set}`, body);
  await post('systemforms', { formid: DASHBOARD_ID, name: 'Support board', description: '', type: 0, objecttypecode: 'none', formxml });
  for (const [id, table] of Object.entries(ENVIRONMENT.charts)) await post('savedqueryvisualizations', { savedqueryvisualizationid: id, name: `chart ${id}`, primaryentitytypecode: table });
  for (const [id, table] of Object.entries(ENVIRONMENT.views)) await post('savedqueries', { savedqueryid: id, name: `view ${id}`, returnedtypecode: table, querytype: 0 });
  const sdk = createMakerSdk({
    workspaceStorage: createNodeWorkspaceStorage(makeTempDir('verify-dashboard-')),
    instanceUrl: 'https://contoso.crm.dynamics.com',
    httpClient: fake.httpClient,
  });
  await sdk.initWorkspace();
  const spec = {
    solution: { uniqueName: 'Support', displayName: 'Support', publisherPrefix: 'new' },
    app: { name: 'Support', uniqueName: 'new_support' },
    entities: [],
    appShell: { areas: [] },
    dashboards: [{ name: 'Support board', dashboardId: DASHBOARD_ID, tiles: [{ type: 'list', name: 'Open cases', entity: 'incident', viewId: OPEN_VIEW }] }],
  };
  const result = await verifySpec(spec, readerFor(sdk, 'new_support', {}), { concurrency: 1 });
  return { result, check: result.checks.find((c) => c.kind === 'dashboard') };
}

const OPEN_CASES = () => nativeGrid('Component1', 'Open cases', OPEN_VIEW);
const BY_STATUS = () => nativeChart('Component2', 'Cases by status', CHART_VIEW, CHART);

test('a native chart tile whose chart and view belong to its table verifies', async () => {
  const { result, check } = await verifying(dashboardXml([[OPEN_CASES(), BY_STATUS()]]));
  assert.strictEqual(check.present, true, check.detail);
  assert.strictEqual(result.ok, true, JSON.stringify(result.missing));
});

test('a chart a custom control hosts, with no native visualization, does not fail the dashboard it sits on', async () => {
  const { result, check } = await verifying(dashboardXml(
    [[OPEN_CASES(), customChart('Component2', 'Custom-rendered chart', CHART_VIEW, '', CHART_UNIQUE)]],
    [customDescription(CHART_UNIQUE, CHART_VIEW)]
  ));
  assert.strictEqual(check.present, true, check.detail);
  assert.deepStrictEqual(result.missing, []);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.unverified, undefined, 'and nothing is reported about it: verify did not look at a tile the spec cannot describe');
});

test('a chart a custom control hosts is not held to its table at all: the ids it carries are not the spec\u2019s to judge', async () => {
  const { check } = await verifying(dashboardXml([[
    OPEN_CASES(),
    customChart('Component2', 'Escalations (chart control)', CHART_VIEW, OTHER_TABLE_CHART, CHART_UNIQUE),
    customGrid('Component3', 'My cases (grid control)', OPEN_VIEW, GRID_UNIQUE),
  ]], [customDescription(CHART_UNIQUE, CHART_VIEW), customDescription(GRID_UNIQUE, OPEN_VIEW)]));
  assert.strictEqual(check.present, true, check.detail);
});

test('a native chart tile is still held to its table: a chart of another table fails the dashboard, and says which tile', async () => {
  const { result, check } = await verifying(dashboardXml([[
    OPEN_CASES(),
    nativeChart('Component2', 'Cases by status', CHART_VIEW, OTHER_TABLE_CHART),
  ]]));
  assert.strictEqual(check.present, false);
  assert.match(check.detail, /^chart tile 'Cases by status' shows incident, but its chart belongs to account$/);
  assert.strictEqual(result.ok, false);
});

test('a native chart tile with no visualization to look up is still unverified, which fails the dashboard', async () => {
  const { check } = await verifying(dashboardXml([[OPEN_CASES(), nativeChart('Component2', 'Cases by status', CHART_VIEW, '')]]));
  assert.strictEqual(check.present, false);
  assert.match(check.detail, /^chart tile 'Cases by status': its chart or view could not be resolved — unverified, not proven correct$/);
});

test('a native chart beside a hosted one is still checked, and it alone fails the dashboard', async () => {
  const { check } = await verifying(dashboardXml(
    [[OPEN_CASES(), customChart('Component2', 'Custom-rendered chart', CHART_VIEW, '', CHART_UNIQUE), nativeChart('Component3', 'Cases by status', CHART_VIEW, OTHER_TABLE_CHART)]],
    [customDescription(CHART_UNIQUE, CHART_VIEW)]
  ));
  assert.strictEqual(check.present, false);
  assert.match(check.detail, /^chart tile 'Cases by status' shows incident, but its chart belongs to account$/, 'only the native tile is named');
});

test('the Assistant, and a custom control that is no grid or chart, are skipped as they always were', async () => {
  const { result, check } = await verifying(dashboardXml([
    [OPEN_CASES(), BY_STATUS()],
    [assistantTile('Component3', 'Assistant'), otherCustomControl('Component4', 'Compact card', OTHER_UNIQUE)],
  ]));
  assert.strictEqual(check.present, true, check.detail);
  assert.strictEqual(result.ok, true, JSON.stringify(result.missing));
});
