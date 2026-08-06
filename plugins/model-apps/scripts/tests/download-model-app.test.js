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

test('collectSitemap separates BARE-NAME icons from platform-path customRefs (both icon + vectorIcon, areas + subareas)', () => {
  const app = { siteMap: { areas: [{ icon: '/WebResources/crba3_area.svg', groups: [{ subAreas: [
    { type: 'Entity', entity: 'zava_javavendor', icon: '/WebResources/msdyn_OmnichannelBase/_imgs/SitemapIcon/CDSEntity', vectorIcon: '/WebResources/crba3_/icons/approval.svg' },
    { type: 'Entity', entity: 'new_thing', icon: 'new_declared.png' }, // a bare name → icons (fetched + re-declared)
  ] }] }] } };
  const { icons, customRefs } = collectSitemap(app);
  assert.deepStrictEqual([...icons], ['new_declared.png'], 'only the bare-name icon goes to icons');
  // Platform paths → customRefs, with the WR NAME extracted (leading /WebResources/ stripped); OOB + custom alike.
  assert.deepStrictEqual([...customRefs].sort(), [
    'crba3_/icons/approval.svg', 'crba3_area.svg', 'msdyn_OmnichannelBase/_imgs/SitemapIcon/CDSEntity',
  ].sort(), 'icon + vectorIcon platform paths are gathered as customRefs (name-extracted)');
});

test('iconWebResources re-declares an OWN-PREFIX CUSTOM (unmanaged) image WR as external:true; SKIPS managed/OOB + foreign-prefix; tracks unresolved own-prefix refs', async () => {
  const sdk = { queryRecords: async (e, o) => {
    const name = (o.filter.match(/name eq '([^']*)'/) || [])[1];
    if (name === 'crba3_navicon.svg') return [{ name, webresourcetype: 11, content: 'PHN2Zz4=', ismanaged: false }]; // own custom unmanaged SVG
    if (name === 'msdyn_x/CDSEntity') return [{ name, webresourcetype: 11, content: 'x', ismanaged: true }];          // managed OOB
    if (name === 'isv_foreign.svg') return [{ name, webresourcetype: 11, content: 'y', ismanaged: false }];           // foreign unmanaged (another publisher)
    if (name === 'crba3_bare.png') return [{ name, webresourcetype: 5, content: 'aW1n', ismanaged: false }];          // bare-name author icon
    if (name === 'crba3_gone.svg') return [];                                                                         // own-prefix but absent on source → unresolved
    return [];
  } };
  const { webResources, unresolved } = await iconWebResources(
    sdk, ['crba3_bare.png'], ['crba3_navicon.svg', 'msdyn_x/CDSEntity', 'isv_foreign.svg', 'crba3_gone.svg'], 'crba3', true);
  const byName = Object.fromEntries(webResources.map((w) => [w.name, w]));
  assert.ok(byName['crba3_navicon.svg'], 'an OWN-prefix custom unmanaged path-referenced WR is re-declared');
  assert.strictEqual(byName['crba3_navicon.svg'].external, true, 'a re-declared path-referenced icon is flagged external (teardown skips it)');
  assert.ok(byName['crba3_bare.png'], 'a bare-name author icon is re-declared as before');
  assert.notStrictEqual(byName['crba3_bare.png'].external, true, 'a bare-name author icon is NOT external (teardown owns it, as before)');
  assert.ok(!byName['msdyn_x/CDSEntity'], 'a managed/OOB path-referenced WR is NOT re-declared');
  assert.ok(!byName['isv_foreign.svg'], 'a FOREIGN-prefix WR is NOT re-declared (would BuildHalt under an unregistered prefix on a fresh env)');
  assert.deepStrictEqual(unresolved, ['crba3_gone.svg'], 'an own-prefix ref absent on the source env is reported unresolved (surface, do not silently drop)');
});

test('iconWebResources reports an own-prefix icon read FAILURE as unresolved (not a silent skip)', async () => {
  const sdk = { queryRecords: async (e, o) => {
    const name = (o.filter.match(/name eq '([^']*)'/) || [])[1];
    if (name === 'crba3_flaky.svg') throw new Error('429 throttled');
    return [];
  } };
  const { webResources, unresolved } = await iconWebResources(sdk, [], ['crba3_flaky.svg'], 'crba3', true);
  assert.strictEqual(webResources.length, 0);
  assert.deepStrictEqual(unresolved, ['crba3_flaky.svg'], 'a transient read failure on an own-prefix icon is surfaced');
});

test('iconWebResources with an UNVERIFIED prefix (publisher read failed) surfaces a genuine own custom icon as unresolved instead of silently dropping it; a managed/OOB ref stays silent', async () => {
  // prefixResolved=false + a fallback prefix ('new') that does NOT match the app's real 'crba3' icons.
  // Without the guard, crba3_nav.svg fails startsWith('new_') and is silently skipped with no warning
  // (Opus/Sol finding). It must instead be surfaced as unresolved; the OOB CDSEntity ref must stay silent.
  const sdk = { queryRecords: async (e, o) => {
    const name = (o.filter.match(/name eq '([^']*)'/) || [])[1];
    if (name === 'crba3_nav.svg') return [{ name, webresourcetype: 11, content: 'PHN2Zz4=', ismanaged: false }]; // genuine own custom svg
    if (name === 'msdyn_x/CDSEntity') return [{ name, webresourcetype: 11, content: 'x', ismanaged: true }];      // managed OOB (exists everywhere)
    return [];
  } };
  const { webResources, unresolved } = await iconWebResources(
    sdk, [], ['crba3_nav.svg', 'msdyn_x/CDSEntity'], 'new', false);
  assert.strictEqual(webResources.length, 0, 'never re-declares under an unverified prefix (would BuildHalt on a fresh env)');
  assert.deepStrictEqual(unresolved, ['crba3_nav.svg'], 'the genuine custom icon is surfaced; the managed OOB ref stays silent (no false alarm)');
});

test('iconWebResources: a WR referenced BOTH by a bare name AND a platform path inherits external:true (overlap keeps teardown protection)', async () => {
  // Sol finding: if the bare pass emitted the WR without external and `seen` then suppressed the path
  // classification, teardown would delete a shared nav icon. The path pass runs first / the bare entry
  // inherits external when it is also a customRef.
  const sdk = { queryRecords: async (e, o) => {
    const name = (o.filter.match(/name eq '([^']*)'/) || [])[1];
    if (name === 'crba3_shared.svg') return [{ name, webresourcetype: 11, content: 'PHN2Zz4=', ismanaged: false }];
    return [];
  } };
  const { webResources } = await iconWebResources(
    sdk, ['crba3_shared.svg'], ['crba3_shared.svg'], 'crba3', true);
  assert.strictEqual(webResources.length, 1, 'the overlapping WR is re-declared exactly once (deduped)');
  assert.strictEqual(webResources[0].external, true, 'an overlapping bare+path WR is external (teardown must not delete a shared nav icon)');
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
  const { webResources: out } = await iconWebResources(sdk, ['new_rgicon.svg', 'missing.png']);
  assert.strictEqual(calls[0].logical, 'webresource', 'queries the webresource logical name');
  assert.match(calls[0].filter, /name eq 'new_rgicon\.svg'/, 'filters by name, not id');
  assert.deepStrictEqual(out, [{ name: 'new_rgicon.svg', type: 'svg', contentBase64: 'BASE64SVG' }]);
});

test('iconWebResources skips a web resource it cannot read (no throw)', async () => {
  const sdk = { queryRecords: async () => { throw new Error('boom'); } };
  const { webResources } = await iconWebResources(sdk, ['x.png']);
  assert.deepStrictEqual(webResources, []);
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
const { appUniqueName } = require('../lib/sdk-build.js');
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
        // The app belongs to a real unmanaged solution — recoverAppSolution returns its uniquename, but the
        // publisher PREFIX must still come from the app uniquename ('test'), NOT this solution (Sol F2).
        if (logical === 'solutioncomponent') return [{ _solutionid_value: 'sol-x' }];
        if (logical === 'solution') return [{ solutionid: 'sol-x', uniquename: 'ContosoSln', ismanaged: false }];
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
    // App identity round-trips: the REAL immutable uniquename is captured (so a rebuild resolves the
    // existing app even after a display-name rename) and the publisher prefix is derived FROM it.
    assert.strictEqual(spec.app.uniqueName, APP_UNIQUE, 'the app real uniquename round-trips into spec.app.uniqueName');
    assert.strictEqual(spec.solution.uniqueName, 'ContosoSln', 'the real unmanaged solution uniquename is recovered for teardown');
    assert.strictEqual(spec.solution.publisherPrefix, 'test', 'the publisher prefix is derived from the app uniquename (test_roundtrip → test), NOT the recovered solution (Sol F2)');
    assert.strictEqual(appUniqueName(spec), APP_UNIQUE, 'appUniqueName resolves the REAL uniquename (identity lookup finds the existing app, no duplicate) even though the display name is "Test App"');
    assert.ok(!('prefixResolved' in spec.solution), 'the transient prefixResolved flag is stripped from the persisted spec');
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
test('recoverAppSolution enumerates ALL memberships and returns the real unmanaged solution uniquename (does NOT recover a prefix — that comes from the app uniquename)', async () => {
  const APP = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  let publisherQueried = false;
  const sdk = {
    queryRecords: async (logical, opts) => {
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
      if (logical === 'publisher') { publisherQueried = true; return [{ customizationprefix: 'crba3' }]; }
      return [];
    },
  };
  const sol = await recoverAppSolution(sdk, APP);
  assert.deepStrictEqual(sol, { uniqueName: 'NucleoLive2' }, 'returns ONLY the real solution uniquename');
  assert.strictEqual(publisherQueried, false, 'no publisher lookup — the prefix is NOT sourced from an arbitrary solution membership (Sol review)');
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
