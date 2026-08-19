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

// ── Task 11: v2 shape emission + legacy back-compat ───────────────────────────
test('hydrateSpec emits the v2 shape when pages carry keys (schemaVersion 2, source.kind tsx, design, key subareas)', async () => {
  const read = {
    app: async () => ({ name: 'A', description: '', siteMap: { areas: [{ title: 'M', groups: [{ title: 'G', subAreas: [{ type: 'GenPage', genPageId: 'gp-o', title: 'Overview' }] }] }] } }),
    pages: async () => [{ pageId: 'gp-o', name: 'Overview', key: 'overview', purpose: 'Home', navigatesTo: [{ targetKey: 'detail' }], dataSources: [], codeFile: 'overview.tsx' }],
    entities: async () => [], webResources: async () => [], solution: async () => ({ uniqueName: 'S', publisherPrefix: 'new' }),
    design: async () => ({ theme: 'ocean' }),
  };
  const spec = await hydrateSpec(read);
  assert.strictEqual(spec.schemaVersion, 2);
  assert.deepStrictEqual(spec.design, { theme: 'ocean' });
  assert.strictEqual(spec.pages[0].source.kind, 'tsx');
  assert.strictEqual(spec.pages[0].key, 'overview');
  assert.deepStrictEqual(spec.pages[0].navigatesTo, [{ targetKey: 'detail' }]);
  assert.strictEqual(spec.appShell.areas[0].groups[0].subAreas[0].page, 'overview', 'GenPage subarea resolved by KEY');
});

test('hydrateSpec keeps the legacy name-based shape when pages carry no key (back-compat)', async () => {
  const read = {
    app: async () => ({ name: 'A', description: '', siteMap: { areas: [{ title: 'M', groups: [{ title: 'G', subAreas: [{ type: 'GenPage', genPageId: 'gp-o', title: 'Overview' }] }] }] } }),
    pages: async () => [{ pageId: 'gp-o', name: 'Overview', dataSources: [], codeFile: 'overview.tsx' }],
    entities: async () => [], webResources: async () => [], solution: async () => ({ uniqueName: 'S', publisherPrefix: 'new' }),
  };
  const spec = await hydrateSpec(read);
  assert.strictEqual(spec.schemaVersion, undefined);
  assert.strictEqual(spec.pages[0].codeFile, 'overview.tsx');
  assert.strictEqual(spec.appShell.areas[0].groups[0].subAreas[0].page, 'Overview', 'legacy GenPage subarea resolved by NAME');
});

// ── Task 6: pageId kept in the v2 edit-snapshot (C3) ─────────────────────────
test('hydrateSpec emits pageId on v2 pages (edit-snapshot self-describes its ids, C3)', async () => {
  const GP_O = '13ecbc57-a3a4-4132-b0a2-a6c6b12691e8';
  const read = {
    app: async () => ({ name: 'A', description: '', siteMap: { areas: [{ title: 'M', groups: [{ title: 'G', subAreas: [{ type: 'GenPage', genPageId: GP_O, title: 'Overview' }] }] }] } }),
    pages: async () => [{ pageId: GP_O, key: 'overview', name: 'Overview', codeFile: 'pages/overview.tsx' }],
    entities: async () => [], webResources: async () => [], dashboards: async () => [], solution: async () => ({ uniqueName: 'S', publisherPrefix: 'new' }),
  };
  const spec = await hydrateSpec(read);
  assert.strictEqual(spec.schemaVersion, 2, 'v2 shape (pages have keys)');
  assert.strictEqual(spec.pages[0].key, 'overview');
  assert.strictEqual(spec.pages[0].pageId, GP_O, 'pageId carried through as C3 edit-snapshot marker');
  // A legacy page (no key) must NOT get pageId even if one is present on the page object
  const spec2 = await hydrateSpec({
    app: async () => ({ name: 'A', description: '', siteMap: { areas: [] } }),
    pages: async () => [{ pageId: GP_O, name: 'Overview', dataSources: [], codeFile: 'o.tsx' }],
    entities: async () => [], webResources: async () => [], solution: async () => ({ uniqueName: 'S', publisherPrefix: 'new' }),
  });
  assert.strictEqual(spec2.schemaVersion, undefined, 'no schemaVersion for legacy (no key)');
  assert.strictEqual(spec2.pages[0].pageId, undefined, 'legacy shape has no pageId field');
});

test('hydrateSpec strips the transient solution.prefixResolved flag from the persisted spec (keeps uniqueName + publisherPrefix)', async () => {
  // recoverAppSolution returns { uniqueName, publisherPrefix, prefixResolved } — the last is a download-time
  // signal consumed by iconWebResources, NOT part of the user-facing spec. It must not leak into app-spec.json.
  const read = {
    app: async () => ({ name: 'A', description: '', uniquename: 'crba3_realapp', siteMap: { areas: [] } }),
    pages: async () => [],
    entities: async () => [], webResources: async () => [],
    solution: async () => ({ uniqueName: 'Real', publisherPrefix: 'crba3', prefixResolved: true }),
  };
  const spec = await hydrateSpec(read);
  assert.deepStrictEqual(spec.solution, { uniqueName: 'Real', publisherPrefix: 'crba3' }, 'persisted solution keeps only uniqueName + publisherPrefix');
  assert.ok(!('prefixResolved' in spec.solution), 'the transient prefixResolved flag is stripped from the persisted spec');
  assert.strictEqual(spec.app.uniqueName, 'crba3_realapp', 'the app real uniquename round-trips into spec.app.uniqueName (identity survives a rebuild)');
});


// -- issue #430: a sitemap URL subarea carrying a web-resource token ----------------------------
// The Site Map Designer's "custom page backed by an HTML web resource" writes `$webresource:<name>`
// into a URL subarea. Passing it through made validateAppSpec reject the whole spec, so
// download-model-app.js wrote NO spec at all and the entire download -> edit -> rebuild flow was
// blocked for the app over one unrelated nav entry.

function appWithUrl(url) {
  return {
    app: async () => ({
      name: 'Ops',
      description: '',
      siteMap: {
        areas: [{
          title: 'Main',
          groups: [{
            title: 'G',
            subAreas: [
              { type: 'Entity', entity: 'new_order', title: 'Orders' },
              { type: 'URL', url, title: 'Home' },
            ],
          }],
        }],
      },
    }),
    pages: async () => [],
    entities: async () => [{ schemaName: 'new_order', displayName: 'Order', primaryAttribute: { schemaName: 'new_name', displayName: 'Name' }, columns: [] }],
    webResources: async () => [],
    solution: async () => ({ uniqueName: 'Ops', publisherPrefix: 'new' }),
  };
}

test('hydrateSpec DROPS a $webresource: URL subarea instead of emitting an invalid spec (#430)', async () => {
  const spec = await hydrateSpec(appWithUrl('$webresource:new_homepage.html'));
  const subs = spec.appShell.areas[0].groups[0].subAreas;
  assert.strictEqual(subs.some((s) => s.title === 'Home'), false, 'the token subarea must be dropped');
  assert.ok(subs.some((s) => s.entity === 'new_order'), 'the rest of the nav must survive');
  assert.strictEqual(spec.droppedSubareas, 1, 'the drop must be COUNTED so the maker is told');
});

test('hydrateSpec still emits a real http(s) URL subarea (#430 must not over-drop)', async () => {
  const spec = await hydrateSpec(appWithUrl('https://contoso.example/help'));
  const subs = spec.appShell.areas[0].groups[0].subAreas;
  assert.ok(subs.some((s) => s.url === 'https://contoso.example/help'), 'a real link must round-trip');
  assert.strictEqual(spec.droppedSubareas, 0);
});

test('hydrateSpec drops any scheme the validator would reject, not just $webresource (#430)', async () => {
  // Tested against the shared isSafeHttpUrl rule, so a javascript:/file: nav entry cannot fail the
  // whole download either — and the drop rule cannot drift from the validation rule.
  for (const url of ['$webresource:x.html', '/WebResources/x.html', 'javascript:alert(1)', 'file:///etc/passwd', 'not a url']) {
    const spec = await hydrateSpec(appWithUrl(url));
    const subs = spec.appShell.areas[0].groups[0].subAreas;
    assert.strictEqual(subs.some((s) => s.title === 'Home'), false, url + ' should be dropped');
  }
});

test('a spec hydrated from an app with a web-resource subarea PASSES validation (#430 end to end)', async () => {
  // The actual reported symptom: validateAppSpec rejected the downloaded spec, so no file was written.
  const spec = await hydrateSpec(appWithUrl('$webresource:new_homepage.html'));
  const v = validateAppSpec(spec, { profile: 'plan' });
  assert.strictEqual(v.ok, true, 'validation errors: ' + JSON.stringify(v.errors));
});
