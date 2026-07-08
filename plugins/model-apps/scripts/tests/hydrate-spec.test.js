'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { hydrateSpec } = require('../lib/hydrate-spec.js');
const { validateAppSpec } = require('../lib/app-spec.js');

// A deployed app with an entity subarea (+ icon) and a GenPage subarea, one entity, one genpage
// (as if authored in Maker), and a solution.
function deployedRead() {
  return {
    app: async () => ({
      name: 'Ops App',
      description: 'ops',
      siteMap: {
        areas: [
          {
            title: 'Main',
            icon: 'new_areaicon.png',
            groups: [
              {
                title: 'Records',
                subAreas: [
                  { type: 'Entity', entity: 'new_order', title: 'Orders', icon: 'new_ordericon.png' },
                  { type: 'GenPage', genPageId: 'GP-1', title: 'Overview', vectorIcon: '/_imgs/x.svg' },
                  { type: 'URL', url: 'https://help', title: 'Help' },
                  { type: 'DashBoard', dashboardId: 'D-1', title: 'Legacy' },
                ],
              },
            ],
          },
        ],
      },
    }),
    pages: async () => [{ pageId: 'gp-1', name: 'Overview', dataSources: ['new_order'], prompt: 'kpis', codeFile: 'pages/Overview.tsx' }],
    entities: async () => [{ schemaName: 'new_order', displayName: 'Order', primaryAttribute: { schemaName: 'new_name', displayName: 'Name' }, columns: [{ schemaName: 'new_status', displayName: 'Status', type: 'Choice', options: ['Open', 'Closed'] }] }],
    webResources: async () => [
      { name: 'new_areaicon.png', type: 'png', contentBase64: 'AAAA' },
      { name: 'new_ordericon.png', type: 'png', contentBase64: 'AAAA' },
    ],
    solution: async () => ({ uniqueName: 'OpsSln', publisherPrefix: 'new' }),
  };
}

test('hydrateSpec reconstructs a valid, complete spec (entities + appShell + pages)', async () => {
  const spec = await hydrateSpec(deployedRead());
  const r = validateAppSpec(spec);
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});

test('hydrateSpec maps a GenPage subarea back to a page target by name (case-insensitive id match)', async () => {
  const spec = await hydrateSpec(deployedRead());
  const subs = spec.appShell.areas[0].groups[0].subAreas;
  const page = subs.find((s) => s.page);
  assert.strictEqual(page.page, 'Overview', 'GP-1 resolved to the page name Overview');
  assert.strictEqual(page.title, 'Overview');
});

test('hydrateSpec preserves entity + URL subareas and icons; omits a DashBoard when no dashboards reader', async () => {
  const spec = await hydrateSpec(deployedRead());
  const subs = spec.appShell.areas[0].groups[0].subAreas;
  assert.ok(subs.some((s) => s.entity === 'new_order' && s.icon === 'new_ordericon.png'), 'entity subarea + icon preserved');
  assert.ok(subs.some((s) => s.url === 'https://help'), 'url subarea preserved');
  assert.ok(!subs.some((s) => s.title === 'Legacy'), 'DashBoard subarea omitted when it cannot be reconstructed');
  assert.strictEqual(spec.appShell.areas[0].icon, 'new_areaicon.png', 'area icon preserved');
});

test('hydrateSpec round-trips a DashBoard subarea + dashboards[] (id-passthrough tiles) when a dashboards reader is present', async () => {
  const read = deployedRead();
  read.dashboards = async () => [{ id: 'D-1', name: 'Ops Overview', tiles: [
    { type: 'chart', name: 'Orders by Status', entity: 'new_order', viewId: 'v1', visualizationId: 'c1' },
    { type: 'list', name: 'Active Orders', entity: 'new_order', viewId: 'v1' },
  ] }];
  const spec = await hydrateSpec(read);
  // subarea now resolves to the dashboard by its real name
  const subs = spec.appShell.areas[0].groups[0].subAreas;
  assert.ok(subs.some((s) => s.dashboard === 'Ops Overview' && s.title === 'Legacy'), 'DashBoard subarea -> { dashboard: name }');
  // dashboards[] reconstructed with the id-passthrough tiles
  assert.strictEqual(spec.dashboards.length, 1);
  assert.strictEqual(spec.dashboards[0].name, 'Ops Overview');
  assert.deepStrictEqual(spec.dashboards[0].tiles[0], { type: 'chart', name: 'Orders by Status', entity: 'new_order', viewId: 'v1', visualizationId: 'c1' });
  // and the whole spec still validates (id-based tiles need no declared views[]/charts[])
  const r = validateAppSpec(spec);
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});

test('hydrateSpec carries every deployed page into pages[] (incl. Maker-authored)', async () => {
  const spec = await hydrateSpec(deployedRead());
  assert.strictEqual(spec.pages.length, 1);
  assert.deepStrictEqual(spec.pages[0], { name: 'Overview', dataSources: ['new_order'], prompt: 'kpis', codeFile: 'pages/Overview.tsx' });
});
