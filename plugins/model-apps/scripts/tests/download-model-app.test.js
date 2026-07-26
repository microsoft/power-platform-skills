'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveAppId, collectSitemap, parseDownloadedPages, entityFromMetadata, iconWebResources, droppedSubareaCount } = require('../download-model-app.js');

test('resolveAppId returns a guid as-is, else resolves by uniquename', async () => {
  const guid = '11111111-2222-3333-4444-555555555555';
  assert.strictEqual(await resolveAppId({}, guid), guid);
  const sdk = { queryRecords: async (l, o) => { assert.match(o.filter, /uniquename eq 'new_app'/); return [{ appmoduleid: 'app-1' }]; } };
  assert.strictEqual(await resolveAppId(sdk, 'new_app'), 'app-1');
});

test('collectSitemap gathers distinct entities + icons from the sitemap', () => {
  const app = { siteMap: { areas: [{ icon: 'a.png', groups: [{ subAreas: [
    { type: 'Entity', entity: 'New_Order', icon: 'i.png' },
    { type: 'GenPage', genPageId: 'gp' },
    { type: 'Entity', entity: 'new_order' },
  ] }] }] } };
  const { entities, icons } = collectSitemap(app);
  assert.deepStrictEqual(entities, ['new_order']);
  assert.deepStrictEqual([...icons].sort(), ['a.png', 'i.png']);
});

test('parseDownloadedPages reads pac page tree (<pageId>/page.tsx + config + prompt) into pages[]', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-'));
  const pagesRoot = path.join(out, 'pages');
  const pid = '6e0c28a2-cdbf-41ec-9186-d10fd5de6e35';
  fs.mkdirSync(path.join(pagesRoot, pid), { recursive: true });
  fs.writeFileSync(path.join(pagesRoot, pid, 'page.tsx'), 'x');
  fs.writeFileSync(path.join(pagesRoot, pid, 'config.json'), JSON.stringify({ dataSources: ['new_order'], model: '' }));
  fs.writeFileSync(path.join(pagesRoot, pid, 'prompt.txt'), 'kpis');
  const pages = parseDownloadedPages(pagesRoot, out, new Map([[pid, 'Overview']]));
  assert.strictEqual(pages.length, 1);
  assert.strictEqual(pages[0].name, 'Overview');
  assert.deepStrictEqual(pages[0].dataSources, ['new_order']);
  assert.strictEqual(pages[0].prompt, 'kpis');
  assert.strictEqual(pages[0].codeFile, `pages/${pid}/page.tsx`);
  fs.rmSync(out, { recursive: true, force: true });
});

test('entityFromMetadata builds a minimal (reuse-friendly) entity spec', () => {
  const e = entityFromMetadata({ schemaName: 'new_order', displayName: 'Order', primaryNameAttribute: 'new_name' }, 'new_order');
  assert.strictEqual(e.schemaName, 'new_order');
  assert.strictEqual(e.primaryAttribute.schemaName, 'new_name');
  assert.deepStrictEqual(e.columns, []);
  // A downloaded table is flagged existing:true so a teardown of THIS downloaded spec never deletes a
  // table (+ its data) we cannot prove this build created — download can't distinguish app-created from
  // merely-referenced tables, and deleting customer data is unrecoverable.
  assert.strictEqual(e.existing, true, 'downloaded tables must be flagged existing:true (teardown data-loss guard)');
});

test('iconWebResources looks up web resources by NAME (not id) and maps type from webresourcetype', async () => {
  const calls = [];
  const sdk = {
    queryRecords: async (logical, opts) => {
      calls.push({ logical, filter: opts.filter });
      // svg web resource (webresourcetype 11) with base64 content
      if (/new_rgicon\.svg/.test(opts.filter)) return [{ name: 'new_rgicon.svg', webresourcetype: 11, content: 'BASE64SVG' }];
      return []; // an icon with no matching web resource
    },
  };
  const out = await iconWebResources(sdk, ['new_rgicon.svg', 'missing.png']);
  assert.strictEqual(calls[0].logical, 'webresource', 'queries the webresource logical name');
  assert.match(calls[0].filter, /name eq 'new_rgicon\.svg'/, 'filters by name, not id');
  assert.deepStrictEqual(out, [{ name: 'new_rgicon.svg', type: 'svg', contentBase64: 'BASE64SVG' }]);
});

test('iconWebResources skips a web resource it cannot read (no throw)', async () => {
  const sdk = { queryRecords: async () => { throw new Error('boom'); } };
  assert.deepStrictEqual(await iconWebResources(sdk, ['x.png']), []);
});

test('droppedSubareaCount counts subareas the spec could not round-trip (e.g. dashboards)', () => {
  const app = { siteMap: { areas: [{ groups: [{ subAreas: [{}, {}, {}, {}] }] }] } }; // 4 deployed
  const spec = { appShell: { areas: [{ groups: [{ subAreas: [{}, {}, {}] }] }] } };    // 3 hydrated
  assert.strictEqual(droppedSubareaCount(app, spec), 1);
  const same = { appShell: { areas: [{ groups: [{ subAreas: [{}, {}, {}, {}] }] }] } };
  assert.strictEqual(droppedSubareaCount(app, same), 0);
});

// ── Task 11: assignPageKeys + missingDownloads + full round-trip ──────────────
const { assignPageKeys, missingDownloads, runDownload, recoverAppSolution } = require('../download-model-app.js');
const { reconcilePageIds, buildManifest } = require('../lib/page-manifest.js');
const { hydrateSpec } = require('../lib/hydrate-spec.js');
const { validateAppSpec } = require('../lib/app-spec.js');
const { resolvePageRefs, reverseResolveNavIds } = require('../lib/pageref-resolver.js');

test('assignPageKeys: reuses the manifest key + v2 semantics for a reconcile-bound page, mints fresh keys otherwise (I3/§7.3)', () => {
  const GP_O = '13ecbc57-a3a4-4132-b0a2-a6c6b12691e8';
  const GP_X = '9f2b1a3c-77de-4a10-8b6e-2c4d5e6f7a8b';
  const manifest = { schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: GP_O, purpose: 'Home', navigatesTo: [{ targetKey: 'detail' }], pageInput: { data: {} } }] };
  const downloaded = [
    { pageId: GP_O, name: 'Overview', dataSources: [], codeFile: `p/${GP_O}/page.tsx` },
    { pageId: GP_X, name: 'Some Legacy Page', dataSources: [], codeFile: `p/${GP_X}/page.tsx` },
  ];
  // 4-arg reconcilePageIds: both existence and sitemap are the downloaded page ids (download path)
  const { keyToId } = reconcilePageIds(manifest.pages, manifest, [GP_O, GP_X], [GP_O, GP_X]);
  const idToKey = assignPageKeys(downloaded, manifest, keyToId);
  assert.strictEqual(downloaded[0].key, 'overview');
  assert.deepStrictEqual(downloaded[0].navigatesTo, [{ targetKey: 'detail' }]);
  assert.strictEqual(downloaded[0].purpose, 'Home');
  assert.strictEqual(downloaded[1].key, 'some-legacy-page', 'a page with no manifest binding gets a fresh slug key, not the old name');
  assert.strictEqual(idToKey.get(GP_O), 'overview');
  assert.strictEqual(idToKey.get(GP_X), 'some-legacy-page');
});

test('assignPageKeys: mints unique keys (no manifest) with -N de-dup on slug collision', () => {
  const downloaded = [{ pageId: 'a', name: 'Work Order', dataSources: [], codeFile: 'a' }, { pageId: 'b', name: 'Work Order', dataSources: [], codeFile: 'b' }];
  assignPageKeys(downloaded, null, new Map());
  assert.deepStrictEqual(downloaded.map((p) => p.key), ['work-order', 'work-order-2']);
});

test('missingDownloads flags a gap in EITHER direction (I3 exact enumerated<->downloaded equality)', () => {
  const enumPages = [{ pageId: 'gp-o', name: 'Overview' }, { pageId: 'gp-d', name: 'Detail' }];
  const downloaded = [{ pageId: 'gp-o', name: 'Overview' }];
  assert.deepStrictEqual(missingDownloads(enumPages, downloaded).map((p) => p.pageId), ['gp-d'], 'enumerated-but-not-downloaded');
  assert.deepStrictEqual(missingDownloads(downloaded, enumPages), [], 'downloaded-and-enumerated → no extra');
  assert.deepStrictEqual(missingDownloads(enumPages, enumPages), []);
});

test('ROUND-TRIP: manifest → download → reverse → hydrate → validate → resolve reproduces the deployed ids (Critical 2/I3)', async () => {
  const GP_O = '13ecbc57-a3a4-4132-b0a2-a6c6b12691e8';
  const GP_D = '5c0a4889-45fd-46ea-91a8-ff876914d644';
  const manifest = buildManifest({ pages: [{ key: 'overview', name: 'Overview', navigatesTo: [{ targetKey: 'detail' }] }, { key: 'detail', name: 'Detail' }] }, new Map([['overview', GP_O], ['detail', GP_D]]));
  const deployedOverview = `Xrm.Navigation.navigateTo({ pageType: "generative", pageId: "${GP_D}", data: {} });`;
  const downloaded = [
    { pageId: GP_O, name: 'Overview', dataSources: [], codeFile: 'overview.tsx', _code: deployedOverview },
    { pageId: GP_D, name: 'Detail', dataSources: [], codeFile: 'detail.tsx', _code: 'export default function D(){ return null; }' },
  ];
  // 4-arg reconcilePageIds: sitemap ids are both existence and membership for the download path
  const { keyToId, conflicts } = reconcilePageIds(manifest.pages, manifest, [GP_O, GP_D], [GP_O, GP_D]);
  assert.deepStrictEqual(conflicts, []);
  const idToKey = assignPageKeys(downloaded, manifest, keyToId);
  for (const p of downloaded) p._reversed = reverseResolveNavIds(p._code, idToKey);
  assert.ok(downloaded[0]._reversed.includes('"PAGEREF_detail"'), 'overview nav reversed back to the symbolic key');
  const spec = await hydrateSpec({
    app: async () => ({ name: 'A', description: '', siteMap: { areas: [{ title: 'M', groups: [{ title: 'G', subAreas: [{ type: 'GenPage', genPageId: GP_O, title: 'Overview' }, { type: 'GenPage', genPageId: GP_D, title: 'Detail' }] }] }] } }),
    pages: async () => downloaded,
    entities: async () => [{ schemaName: 'contoso_item', primaryAttribute: { schemaName: 'contoso_name' }, columns: [] }],
    webResources: async () => [], solution: async () => ({ uniqueName: 'S', publisherPrefix: 'new' }),
    design: async () => manifest.design,
  });
  const v = validateAppSpec(spec, { profile: 'plan' });
  assert.ok(v.ok, v.errors.join('; '));
  assert.strictEqual(spec.pages.find((p) => p.key === 'overview').navigatesTo[0].targetKey, 'detail');
  assert.strictEqual(spec.appShell.areas[0].groups[0].subAreas[0].page, 'overview', 'GenPage subarea resolved by KEY');
  const resolved = resolvePageRefs(new Map([['overview', { code: downloaded[0]._reversed }]]), keyToId).deployment.get('overview');
  assert.ok(resolved.includes(`pageId: "${GP_D}"`) && !/PAGEREF_/.test(resolved), 'reverse∘resolve returns the deployed id — the loop is closed');
});

// ── Task 6: sitemap-membership + download-by-id + keep pageId + env-wide names + injectable seam ─

test('Task-6: Maker-added page (sitemap, not in manifest) gets a minted key, keeps pageId (C3)', () => {
  const GP_O = '13ecbc57-a3a4-4132-b0a2-a6c6b12691e8';
  const GP_MAKER = '9f2b1a3c-77de-4a10-8b6e-2c4d5e6f7a8b';
  // manifest knows only GP_O; GP_MAKER was added in Maker and is only in the sitemap
  const manifest = { schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: GP_O }] };
  const pages = [
    { pageId: GP_O,    name: 'Overview',   dataSources: [], codeFile: `pages/${GP_O}/page.tsx` },
    { pageId: GP_MAKER, name: 'Maker Page', dataSources: [], codeFile: `pages/${GP_MAKER}/page.tsx` },
  ];
  const sitemapIds = [GP_O, GP_MAKER];
  const { keyToId, conflicts } = reconcilePageIds(manifest.pages, manifest, sitemapIds, sitemapIds);
  assert.deepStrictEqual(conflicts, []);
  const idToKey = assignPageKeys(pages, manifest, keyToId);
  // Manifest-bound page reuses its key
  assert.strictEqual(pages[0].key, 'overview', 'manifest-bound page reuses its key');
  assert.strictEqual(pages[0].pageId, GP_O, 'pageId preserved (C3)');
  // Maker-added page gets a fresh key and keeps its pageId
  assert.ok(pages[1].key, 'Maker-added page has a minted key');
  assert.strictEqual(pages[1].pageId, GP_MAKER, 'Maker-added page pageId preserved for edit-snapshot adoption (C3)');
  // Both ids are in idToKey so nav reverse-resolve covers all pages
  assert.strictEqual(idToKey.get(GP_O), 'overview');
  assert.ok(idToKey.has(GP_MAKER), 'Maker-added page id is in idToKey (nav reverse-resolve works)');
});

test('Task-6: sitemap id not downloaded → missingDownloads catches it → download aborts (I3)', () => {
  const GP_A = '13ecbc57-a3a4-4132-b0a2-a6c6b12691e8';
  const GP_B = '5c0a4889-45fd-46ea-91a8-ff876914d644';
  // Both GP_A and GP_B are in the sitemap, but only GP_A was downloaded
  const smPages = [{ pageId: GP_A, title: 'Overview' }, { pageId: GP_B, title: 'Detail' }];
  const downloaded = [{ pageId: GP_A, name: 'Overview' }];
  const missing = missingDownloads(smPages, downloaded);
  assert.strictEqual(missing.length, 1, 'one page flagged as missing (sitemap id not downloaded)');
  assert.strictEqual(missing[0].pageId, GP_B, 'GP_B is the missing page');
  // Reverse: no extra (downloaded is a strict subset of sitemap)
  assert.deepStrictEqual(missingDownloads(downloaded, smPages), []);
});

test('Task-6: env-wide id→name used as the page name; sitemap title is fallback only', () => {
  const GP = '13ecbc57-a3a4-4132-b0a2-a6c6b12691e8';
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-nm-'));
  try {
    fs.mkdirSync(path.join(out, 'pages', GP), { recursive: true });
    fs.writeFileSync(path.join(out, 'pages', GP, 'page.tsx'), '');
    // sitemap title is 'Sitemap Overview'; env-wide name is 'Order Overview' (different)
    // Simulate the nameById built in runDownload: env-wide primary, sitemap title fallback
    const envNameById = new Map([[GP.toLowerCase(), 'Order Overview']]);
    const sitemapTitle = 'Sitemap Overview';
    const nameById = new Map([[GP.toLowerCase(), envNameById.get(GP.toLowerCase()) || sitemapTitle]]);
    const pages = parseDownloadedPages(path.join(out, 'pages'), out, nameById);
    assert.strictEqual(pages[0].name, 'Order Overview', 'env-wide name takes precedence over sitemap title');
    assert.strictEqual(pages[0].pageId, GP, 'pageId preserved');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('Task-6: full round-trip via runDownload → hydrateSpec → validateAppSpec ok, pages carry pageId (injectable seam)', async () => {
  const GP_A = '13ecbc57-a3a4-4132-b0a2-a6c6b12691e8';
  const GP_B = '5c0a4889-45fd-46ea-91a8-ff876914d644';
  const APP_ID   = 'a1b2c3d4-0000-4000-8000-000000000001';
  const APP_UNIQ_VALUE = 'c0ffee00-0000-4000-8000-00000000dddd'; // appmoduleidunique lookup GUID
  const SM_ID    = '5111e0f2-0000-4000-8000-0000000000aa';
  const APP_UNIQUE = 'test_roundtrip';
  const SM_XML = `<SiteMap><Area><Group><SubArea GenPageId="${GP_A}" Title="Sitemap A"/><SubArea GenPageId="${GP_B}" Title="Sitemap B"/></Group></Area></SiteMap>`;

  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-rt-'));
  try {
    const mockSdk = {
      fetchArtifact: async () => ({
        name: 'Test App', description: '',
        siteMap: { areas: [{ title: 'M', groups: [{ title: 'G', subAreas: [
          { type: 'GenPage', genPageId: GP_A, title: 'Sitemap A' },
          { type: 'GenPage', genPageId: GP_B, title: 'Sitemap B' },
          { type: 'Entity', entity: 'contoso_item' },  // at least one entity required by plan profile
        ] }] }] },
      }),
      queryRecords: async (logical, opts) => {
        const filter = (opts && opts.filter) || '';
        if (logical === 'appmodule') {
          // fetchSitemap calls this with uniquename filter; un-filtered call returns all apps
          const m = filter.match(/uniquename eq '([^']+)'/);
          if (m) return m[1] === APP_UNIQUE ? [{ appmoduleid: APP_ID, appmoduleidunique: APP_UNIQ_VALUE }] : [];
          return [{ appmoduleid: APP_ID, appmoduleidunique: APP_UNIQ_VALUE, uniquename: APP_UNIQUE }];
        }
        if (logical === 'appmodulecomponent') return [{ objectid: SM_ID, componenttype: 62 }];
        if (logical === 'sitemap') return [{ sitemapxml: SM_XML }];
        if (logical === 'webresource') return []; // no manifest → fresh keys
        if (logical === 'solutioncomponent') return [];
        return [];
      },
      fetchEntityMetadata: async (logical) => ({
        schemaName: logical, displayName: 'Item', primaryNameAttribute: `${String(logical).split('_')[0]}_name`,
      }),
    };
    const mockGenpageCli = {
      // Env-wide names differ from sitemap titles (the core addenda new-1 distinction)
      enumerateEnv: async () => ({
        ok: true,
        ids: [GP_A.toLowerCase(), GP_B.toLowerCase()],
        pages: [{ pageId: GP_A, name: 'Env Name A' }, { pageId: GP_B, name: 'Env Name B' }],
      }),
      download: async ({ outputDir, pageIds }) => {
        // Write minimal page files so parseDownloadedPages can read them
        for (const pid of (pageIds || [])) {
          fs.mkdirSync(path.join(outputDir, pid), { recursive: true });
          fs.writeFileSync(path.join(outputDir, pid, 'page.tsx'), 'export default function P() { return null; }');
        }
        return true;
      },
    };

    const result = await runDownload({ sdk: mockSdk, genpageCli: mockGenpageCli, outDir: out, appId: APP_ID, appUnique: APP_UNIQUE });
    assert.ok(result.ok, JSON.stringify(result));
    const { spec } = result;
    // Full spec validates (profile:'plan' enforces every page is a sitemap subarea)
    const v = validateAppSpec(spec, { profile: 'plan' });
    assert.ok(v.ok, v.errors.join('; '));
    // Every page carries its pageId (C3 edit-snapshot self-description)
    assert.ok(spec.pages.every((p) => p.pageId !== undefined), 'every page in the spec carries its pageId');
    assert.strictEqual(spec.pages.length, 2, 'recovered spec has every sitemap page (no drop)');
    // Env-wide names used (not sitemap titles) — the core addenda new-1 assertion
    const pageA = spec.pages.find((p) => p.pageId === GP_A);
    assert.strictEqual(pageA.name, 'Env Name A', 'env-wide name used as page name (not sitemap title "Sitemap A")');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

// ── recoverAppSolution: recover an app's REAL unmanaged solution (fixes the download→teardown
// round-trip). An app module is a solutioncomponent of EVERY solution it belongs to — the built-in
// system solutions (Active/Default/Basic) AND the real one it was created in. The old code took
// top:1 with no ordering and often got 'Default' (also ismanaged=false), so hydrate defaulted the
// spec's solution to the restricted Default and a downloaded spec could never tear down its own
// solution (teardown 400s on Default, orphaning the real one). ──────────────────────────────
test('recoverAppSolution enumerates ALL memberships and returns the one real unmanaged solution', async () => {
  const APP = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const calls = [];
  const sdk = {
    queryRecords: async (logical, opts) => {
      calls.push({ logical, opts });
      if (logical === 'solutioncomponent') {
        assert.match(opts.filter, new RegExp(`objectid eq ${APP}`), 'filters components by the app id');
        assert.notStrictEqual(opts.top, 1, 'must NOT cap at top:1 — an app belongs to multiple solutions');
        return [
          { _solutionid_value: 'sol-default' },
          { _solutionid_value: 'sol-active' },
          { _solutionid_value: 'sol-real' },
        ];
      }
      if (logical === 'solution') {
        return [
          { solutionid: 'sol-default', uniquename: 'Default', ismanaged: false },
          { solutionid: 'sol-active', uniquename: 'Active', ismanaged: false },
          { solutionid: 'sol-real', uniquename: 'NucleoLive2', ismanaged: false },
        ];
      }
      return [];
    },
  };
  const sol = await recoverAppSolution(sdk, APP);
  assert.deepStrictEqual(sol, { uniqueName: 'NucleoLive2', publisherPrefix: 'new' });
});

test('recoverAppSolution ignores managed solutions and returns null when only system/managed remain', async () => {
  const sdk = {
    queryRecords: async (logical) => {
      if (logical === 'solutioncomponent') return [{ _solutionid_value: 'sol-default' }, { _solutionid_value: 'sol-mgd' }];
      if (logical === 'solution') {
        return [
          { solutionid: 'sol-default', uniquename: 'Default', ismanaged: false },
          { solutionid: 'sol-mgd', uniquename: 'SomeManagedPack', ismanaged: true },
        ];
      }
      return [];
    },
  };
  assert.strictEqual(await recoverAppSolution(sdk, 'app'), null);
});

test('recoverAppSolution returns null when the app has no solution components (caller keeps its default)', async () => {
  const sdk = { queryRecords: async () => [] };
  assert.strictEqual(await recoverAppSolution(sdk, 'app'), null);
});

test('recoverAppSolution never throws — a query error resolves to null (best-effort)', async () => {
  const sdk = { queryRecords: async () => { throw new Error('boom'); } };
  assert.strictEqual(await recoverAppSolution(sdk, 'app'), null);
});
