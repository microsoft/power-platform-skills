'use strict';
// REAL BUNDLE: a dashboard tile that hosts a custom control (the Power Apps grid, say) is named and left out of the
// downloaded spec, never emitted as a plain tile.
//
// The SDK types a dashboard tile by its control's class. The custom-control class used to be read as the Assistant
// whatever it hosted, so such a tile was never a list or a chart; the SDK now types a grid or a chart that a custom
// control hosts by the grid parameters it carries, so the tile reads exactly like a native one — the same
// `TargetEntityType`, `ViewId` and `ChartGridMode` — and differs only by its class. `readDashboards` emits a list or chart
// tile from those parameters, so it would hand back a plain tile for the maker's control: a rebuild into another
// environment would then create the plain grid where the control was, and nothing would have said so.
//
// The App Spec cannot express a custom control, so the tile is left out and the download says which one, as it does for
// every other tile it cannot rebuild. A rebuild into the same environment is not touched by this either way: the spec
// pins the dashboard by its id, and the build reuses a dashboard that exists without applying tile edits.
const test = require('node:test');
const assert = require('node:assert');
const { readDashboards } = require('../download-model-app.js');
const { hydrateSpec } = require('../lib/hydrate-spec.js');
// An apply that names no app folder and no workspace gets an app folder of its own: it holds its build lease in its workspace (helpers/own-app-folder.js).
const { inOwnFolder } = require('./helpers/own-app-folder.js');
const { runSdkBuild: runSdkBuildInPlace } = require('../lib/sdk-build.js');
const runSdkBuild = inOwnFolder(runSdkBuildInPlace);
const { createHarness } = require('./helpers/form-store-harness.js');

const DASHBOARD_ID = '33333333-3333-4333-8333-333333333333';
const OPEN_VIEW = '11111111-0000-4000-8000-0000000000a1';
const MINE_VIEW = '11111111-0000-4000-8000-0000000000a2';
const CHART_VIEW = '11111111-0000-4000-8000-0000000000a3';
const CHART = '22222222-0000-4000-8000-0000000000b1';
const CUSTOM_CHART = '22222222-0000-4000-8000-0000000000b2';

const {
  NATIVE_CLASS, CUSTOM_CLASS, nativeGrid, nativeChart, customGrid, customChart, iframeTile, webResourceTile, customDescription, dashboardXml,
} = require('./helpers/dashboard-formxml.js');

const GRID_UNIQUE = 'cccccccc-0000-4000-8000-000000000001';
const CHART_UNIQUE = 'cccccccc-0000-4000-8000-000000000002';

const harnesses = [];
test.after(() => { for (const h of harnesses) h.cleanup(); });

// A harness whose one row is a dashboard (systemform type 0) holding `formxml`, and an SDK over it.
async function dashboardOver(formxml) {
  const h = createHarness({ formId: DASHBOARD_ID, entity: 'incident', formName: 'Support board' });
  harnesses.push(h);
  h.store.row = { formid: DASHBOARD_ID, name: 'Support board', description: 'The support lead\u2019s view.', objecttypecode: 'none', type: 0, formxml };
  const { sdk } = await h.freshSdk();
  const app = { siteMap: { areas: [{ groups: [{ subAreas: [{ type: 'DashBoard', dashboardId: DASHBOARD_ID, title: 'Support board' }] }] }] } };
  return { h, sdk, app };
}

const ordinaryTiles = [
  { type: 'list', name: 'Open cases', entity: 'incident', viewId: OPEN_VIEW, colspan: 2, rowspan: 8 },
  { type: 'chart', name: 'Cases by status', entity: 'incident', viewId: CHART_VIEW, visualizationId: CHART, colspan: 2, rowspan: 8 },
];

test('a dashboard of native tiles downloads as it always did: a list, a chart, an iframe and a web resource, with nothing said', async () => {
  const { sdk, app } = await dashboardOver(dashboardXml([
    [nativeGrid('Component1', 'Open cases', OPEN_VIEW), nativeChart('Component2', 'Cases by status', CHART_VIEW, CHART)],
    [iframeTile('Component3', 'Knowledge', 'https://contoso.example/help'), webResourceTile('Component4', 'Welcome', 'new_welcome.htm')],
  ]));
  const warnings = [];
  const dashboards = await readDashboards(sdk, app, (m) => warnings.push(m));
  assert.deepStrictEqual(dashboards.map((d) => [d.id, d.name]), [[DASHBOARD_ID, 'Support board']]);
  assert.deepStrictEqual(dashboards[0].tiles, [
    ...ordinaryTiles,
    { type: 'iframe', name: 'Knowledge', url: 'https://contoso.example/help', colspan: 4, rowspan: 6 },
    { type: 'webresource', name: 'Welcome', webResource: 'new_welcome.htm', colspan: 4, rowspan: 6 },
  ]);
  assert.deepStrictEqual(warnings, []);
});

test('the SDK reads a tile a custom control hosts like a native one — the same type and parameters — and tells it apart only by its class', async () => {
  // The premise of everything below. If a later bundle stops exposing the class, or types such a tile differently, this
  // fails first and the download has to be looked at again.
  const { sdk } = await dashboardOver(dashboardXml([
    [nativeGrid('Component1', 'Open cases', OPEN_VIEW), customGrid('Component2', 'My cases', MINE_VIEW, GRID_UNIQUE)],
  ], [customDescription(GRID_UNIQUE, MINE_VIEW)]));
  await sdk.fetchArtifact('dashboard', DASHBOARD_ID);
  const [native, hosted] = (await sdk.getArtifact('dashboard', DASHBOARD_ID)).components;
  assert.deepStrictEqual([native.type, hosted.type], ['list', 'list']);
  assert.deepStrictEqual(hosted.parameters.TargetEntityType, native.parameters.TargetEntityType);
  assert.strictEqual(hosted.parameters.ViewId, `{${MINE_VIEW}}`);
  assert.strictEqual(native.classId.replace(/[{}]/g, '').toUpperCase(), NATIVE_CLASS.replace(/[{}]/g, '').toUpperCase());
  assert.strictEqual(hosted.classId.replace(/[{}]/g, '').toUpperCase(), CUSTOM_CLASS.replace(/[{}]/g, '').toUpperCase());
});

test('a tile a custom control hosts is named and left out, not emitted as a plain tile; the dashboard\u2019s other tiles download as before', async () => {
  const { sdk, app } = await dashboardOver(dashboardXml([
    [nativeGrid('Component1', 'Open cases', OPEN_VIEW), customGrid('Component2', 'My cases (grid control)', MINE_VIEW, GRID_UNIQUE)],
    [nativeChart('Component3', 'Cases by status', CHART_VIEW, CHART), customChart('Component4', 'Escalations (chart control)', CHART_VIEW, CUSTOM_CHART, CHART_UNIQUE)],
  ], [customDescription(GRID_UNIQUE, MINE_VIEW), customDescription(CHART_UNIQUE, CHART_VIEW)]));
  const warnings = [];
  const dashboards = await readDashboards(sdk, app, (m) => warnings.push(m));

  assert.deepStrictEqual(dashboards[0].tiles, ordinaryTiles, 'only the native tiles are emitted');
  assert.strictEqual(warnings.length, 2, JSON.stringify(warnings));
  assert.match(warnings[0], /^dashboard 'Support board' tile 'My cases \(grid control\)' hosts a custom control, which the App Spec cannot express, so it is omitted from dashboards\[\]\./);
  assert.match(warnings[1], /^dashboard 'Support board' tile 'Escalations \(chart control\)' hosts a custom control/);
  // What a rebuild does to it, so the maker knows where the control stays and where it has to be put back.
  assert.match(warnings[0], /into this environment keeps the dashboard as it is[^.]*\./);
  assert.match(warnings[0], /into another environment creates it without this tile/);
});

test('a dashboard whose only tile hosts a custom control is dropped, and its navigation entry counts as dropped — what the lossy-download gate refuses on', async () => {
  const { sdk, app } = await dashboardOver(dashboardXml([
    [customGrid('Component1', 'My cases (grid control)', MINE_VIEW, GRID_UNIQUE)],
  ], [customDescription(GRID_UNIQUE, MINE_VIEW)]));
  const warnings = [];
  const dashboards = await readDashboards(sdk, app, (m) => warnings.push(m));
  assert.deepStrictEqual(dashboards, []);
  assert.ok(warnings.some((w) => /tile 'My cases \(grid control\)' hosts a custom control/.test(w)), JSON.stringify(warnings));
  assert.ok(warnings.some((w) => /read OK but produced no recognizable tiles .*its sitemap subarea will be dropped/.test(w)), JSON.stringify(warnings));

  // The subarea is then counted as dropped, which is what the download's lossy-download gate refuses on.
  const spec = await hydrateSpec({
    app: async () => ({ name: 'Support', description: '', uniquename: 'new_support', siteMap: app.siteMap }),
    pages: async () => [], entities: async () => [], webResources: async () => [],
    solution: async () => ({ uniqueName: 'Support', publisherPrefix: 'new' }),
    dashboards: async () => dashboards,
  });
  assert.strictEqual(spec.droppedSubareas, 1);
});

test('a rebuild into the same environment leaves the dashboard, and so the control, as it is', async () => {
  const hosted = dashboardXml([
    [nativeGrid('Component1', 'Open cases', OPEN_VIEW), customGrid('Component2', 'My cases (grid control)', MINE_VIEW, GRID_UNIQUE)],
  ], [customDescription(GRID_UNIQUE, MINE_VIEW)]);
  const { h, sdk, app } = await dashboardOver(hosted);
  const dashboards = await readDashboards(sdk, app);
  const spec = await hydrateSpec({
    app: async () => ({ name: 'Support', description: '', uniquename: 'new_support', siteMap: app.siteMap }),
    pages: async () => [], entities: async () => [], webResources: async () => [],
    solution: async () => ({ uniqueName: 'Support', publisherPrefix: 'new' }),
    dashboards: async () => dashboards,
  });
  assert.deepStrictEqual(spec.dashboards.map((d) => [d.name, d.dashboardId, d.tiles.length]), [['Support board', DASHBOARD_ID, 1]], 'the spec pins the dashboard it was read from');

  const before = h.writes.length;
  const { sdk: rebuilding } = await h.freshSdk();
  const events = [];
  const built = await runSdkBuild(spec, { sdk: rebuilding, apply: true, phases: ['dashboards'], emit: (e) => events.push(e), warn: () => {} });
  assert.strictEqual(built.ok, true);
  assert.deepStrictEqual(h.writes.slice(before).filter((w) => w.method === 'patch' || (w.method === 'post' && /\/systemforms(?:\?|$)/.test(w.url))), [], 'no write reaches the dashboard');
  assert.strictEqual(h.store.row.formxml, hosted, 'its FormXML is unchanged, the hosted control included');
  assert.ok(events.some((e) => e.status === 'skip' && /dashboard "Support board" \(exists — reuse by its dashboardId/.test(e.label)), JSON.stringify(events.map((e) => [e.status, e.label])));
});
