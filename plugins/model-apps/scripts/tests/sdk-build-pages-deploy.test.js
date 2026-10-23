'use strict';
// Integration tests for the §9 PAGEREF_ deployment protocol: STRUCTURAL scan/parity → create-absent-first
// → resolve in memory (never mutate canonical) → upload-once (no duplicates) → sitemap finalize.
// Uses a REAL temp appDir so the fs read of the canonical .tsx runs; the page backend double records the text
// each write was sent — the SDK takes the text of a page, so there is no file to stage or to read back.
//
// Tests also cover a nav pageId that is a `dynamic` expression or a `literal`
// GUID (hardcoded): it must be rejected fail-closed BEFORE any write, even when navigatesTo: [] (so the existing
// parity check does not catch it). Only `extractNavTargets`-based structural detection catches these.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runSdkBuild: runBuild, appUniqueName } = require('../lib/sdk-build.js');
const { makeGenpageSdk } = require('../lib/genpage-sdk.js');
const { FakeSdk, connectionError, sdkError } = require('./helpers/fake-genpage-sdk.js');
// The page backend double these tests hand the build is named `genpageCli` throughout — what it stood in for until pages went through the SDK
// (lib/genpage-sdk.js) — and the build takes it as `genpage`.
const runSdkBuild = (spec, opts) => runBuild(spec, { ...opts, ...(opts.genpageCli ? { genpage: opts.genpageCli } : {}) });
const { writeBaseline, readBaseline } = require('../lib/deployed-baseline.js');
const { sha256 } = require('../lib/hash.js');
const { readPageOwnership, readPendingCreations, recordPagePending, recordPageCreation } = require('../lib/page-ownership-records.js');
const { currentReadSdk } = require('./helpers/app-membership-sdk.js');
const { OBJECT_DIVISION_PAGE, MISREAD_PAGES, HIDDEN_CALL_PAGE, PREFIX_INCREMENT_PAGE, TEMPLATE_LINE_PAGE, JSX_TEXT_PAGE, ELEMENT_AFTER_OPERATOR_PAGES, ELEMENT_LOOKALIKE_PAGES, ELEMENT_PAGE_TOKEN_LINE, FUNCTION_TYPE_PAGES } = require('./helpers/misread-page.js');

// Real GUIDs for the three-authority sitemap mock. SELF_* resolve THIS app's appmodule + sitemap so
// fetchSitemap(appUnique) returns opts.liveSitemapXml; a page-less EMPTY sitemap is the default membership.
const APP_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const SELF_UNIQUE_VALUE = 'c0ffee00-0000-4000-8000-00000000dddd';
const SELF_SITEMAP_ID = '5111e0f2-0000-4000-8000-0000000000aa';
const EMPTY_SITEMAP_XML = '<SiteMap><Area><Group></Group></Area></SiteMap>';
// A new app is created with its navigation minus the pages, and Dataverse refuses a navigation with nothing left
// (lib/app-navigation.js), so an app these tests build from nothing has an entry that is not a page beside its pages.
const TABLE_ENTRY = { entity: 'contoso_item', title: 'Items' };
const OVERVIEW_ID = '11111111-0000-4000-8000-000000000001';
const DETAIL_ID = '22222222-0000-4000-8000-000000000002';
const pageSitemap = (ids) => `<SiteMap><Area><Group>${ids.map((id) => `<SubArea GenPageId="${id}"/>`).join('')}</Group></Area></SiteMap>`;

function mockSdk(opts = {}) {
  const calls = [];
  let idc = 0;
  const store = {};
  const sdk = {
    queryRecords: async (e, o) => {
      calls.push({ name: 'queryRecords', args: [e, o] });
      const filter = (o && o.filter) || '';
      if (e === 'appmodule') {
        const m = filter.match(/uniquename eq '([^']+)'/);
        if (m) {
          const oi = (opts.otherApps || []).findIndex((a) => a.uniquename === m[1]);
          if (oi >= 0) return [{ appmoduleid: `app-${oi + 2}`, appmoduleidunique: `uv-${oi + 2}`, uniquename: m[1] }];
          return [{ appmoduleid: APP_ID, appmoduleidunique: SELF_UNIQUE_VALUE, uniquename: m[1] }];
        }
        if (opts.failAppList) throw new Error('appmodule list failed');
        const rows = [{ appmoduleid: APP_ID, appmoduleidunique: SELF_UNIQUE_VALUE, uniquename: opts.selfAppUnique }];
        (opts.otherApps || []).forEach((a, i) => rows.push({ appmoduleid: `app-${i + 2}`, appmoduleidunique: `uv-${i + 2}`, uniquename: a.uniquename }));
        return rows;
      }
      if (e === 'appmodulecomponent') {
        const uv = (filter.match(/_appmoduleidunique_value eq (\S+)/) || [])[1];
        if (uv === SELF_UNIQUE_VALUE) return [{ objectid: SELF_SITEMAP_ID, componenttype: 62 }];
        const idx = (opts.otherApps || []).findIndex((_, i) => `uv-${i + 2}` === uv);
        return [{ objectid: `sm-${idx + 2}`, componenttype: 62 }];
      }
      if (e === 'sitemap') {
        if (/sitemapnameunique eq/.test(filter)) return [{ sitemapid: 'sm-1' }];
        const smId = (filter.match(/sitemapid eq (\S+)/) || [])[1];
        if (smId === SELF_SITEMAP_ID) return [{ sitemapxml: opts.liveSitemapXml || EMPTY_SITEMAP_XML }];
        const idx = Number(String(smId).replace('sm-', '')) - 2;
        return [{ sitemapxml: (opts.otherApps && opts.otherApps[idx] && opts.otherApps[idx].sitemapxml) || '<SiteMap/>' }];
      }
      if (e === 'solution') return [];
      if (e === 'webresource') { if (/_pagemanifest'/.test(filter)) return opts.pageManifest ? [{ webresourceid: opts.manifestId || 'wr-manifest', content: opts.pageManifest }] : []; return []; }
      if (e === 'uxagentproject') return (opts.pageRows || []).filter((r) => filter.includes(r.uxagentprojectid.toLowerCase()));
      if (e === 'systemform') return [];
      if (e === 'savedquery') return [{ savedqueryid: 'defview-x', isdefault: true }];
      return [{ publisherid: 'pub-1' }];
    },
    findArtifact: async () => null,
    fetchArtifact: async (t, id) => { if (!store[`${t}:${id}`]) store[`${t}:${id}`] = { id, siteMap: { areas: [] } }; return store[`${t}:${id}`]; },
    createPublisher: async () => ({ id: 'pub-new' }),
    createSolution: async () => ({ id: 'sol-1' }),
    findTables: async () => [],
    findColumns: async () => [],
    fetchEntityMetadata: async (logical) => ({ logicalName: logical, entitySetName: `${logical}s`, attributes: [], relationships: [] }),
    createTable: async (o) => ({ logicalName: o.schemaName.toLowerCase(), entitySetName: `${o.schemaName.toLowerCase()}s`, metadataId: `tbl-${o.schemaName}` }),
    createColumn: async (e, o) => ({ logicalName: o.schemaName.toLowerCase(), metadataId: `col-${o.schemaName}` }),
    createRelationship: async (o) => ({ schemaName: o.schemaName }),
    createWebResource: async (o) => { calls.push({ name: 'createWebResource', args: [o] }); return { id: `wr-${++idc}`, name: o.name }; },
    updateWebResource: async (id, o) => { calls.push({ name: 'updateWebResource', args: [id, o] }); return {}; },
    enrichDefaultViews: async () => ({ updated: [] }),
    createArtifact: (t, def) => { calls.push({ name: 'createArtifact', args: [t, def] }); const id = `${t}-${++idc}`; store[`${t}:${id}`] = Object.assign({ id }, def); return JSON.parse(JSON.stringify(store[`${t}:${id}`])); },
    getArtifact: async (t, id) => { await Promise.resolve(); return store[`${t}:${id}`] || { id }; },
    addElement: async () => { await Promise.resolve(); return {}; },
    updateElement: async (t, id, ptr, patch) => { await Promise.resolve(); calls.push({ name: 'updateElement', args: [t, id, ptr, patch] }); return {}; },
    removeElement: async () => { await Promise.resolve(); return {}; },
    pushArtifact: async (t, id) => ({ type: t, id, saved: true, shipped: false, publish: { kind: 'notRequested' } }),
    addSolutionComponent: async (o) => { calls.push({ name: 'addSolutionComponent', args: [o] }); },
    publishArtifact: async (type, id) => ({ type, id, shipped: true, publish: { kind: 'verified' } }),
    // The shared-page scan's reads through the client: the list of apps (the published ones are all there are here, none was never published) and the other apps'
    // saved layer, which is each app's published sitemap while nothing is pending.
    dataverse: {
      get: async (url) => {
        if (url.startsWith('/appmodules/')) {
          const value = [{ appmoduleid: APP_ID, appmoduleidunique: SELF_UNIQUE_VALUE, uniquename: opts.selfAppUnique, componentstate: 0 }];
          (opts.otherApps || []).forEach((a, i) => value.push({ appmoduleid: `app-${i + 2}`, appmoduleidunique: `uv-${i + 2}`, uniquename: a.uniquename, componentstate: 0 }));
          return { status: 200, body: { value } };
        }
        if (url.startsWith('/sitemaps/')) return { status: 200, body: { value: (opts.otherApps || []).map((a, i) => ({ sitemapid: `sm-${i + 2}`, sitemapxml: a.sitemapxml || '<SiteMap/>', componentstate: 0 })) } };
        return { status: 404, body: null };
      },
    },
  };
  return { sdk, calls };
}

// The page backend double: mints deterministic ids from the page name, and records every write as the text it was sent (`content`) — what
// the SDK takes — never a file. `live` seeds the environment's pages a rebuild reuses (EXISTENCE is env-wide). A rebuild's writes are
// updates; `update` and `create` can be wrapped to do something as a page goes up, as a maker saving a file would.
function mockGenpageCli(live = []) {
  const uploads = [];
  // The app operations the build asked for: one entry per `placeInApp`, { appId, pages, dataSources }.
  const placements = [];
  // The request the build hands each placement to send before it writes the app (`beforeAppWrite`): a function, so it is kept apart from the data above.
  const hooks = [];
  const answer = (o, pageId) => ({ pageId, name: o.name, publish: { kind: 'verified', detail: '' }, warnings: [] });
  return {
    uploads,
    placements,
    hooks,
    enumerateEnv: async () => ({ ok: true, ids: live.map((p) => String(p.pageId).toLowerCase()), pages: live }),
    create: async (o) => {
      const pageId = o.name === 'Detail' ? DETAIL_ID : OVERVIEW_ID;
      uploads.push({ name: o.name, requestedId: undefined, resolvedId: pageId, content: o.source });
      return answer(o, pageId);
    },
    update: async (id, o) => {
      uploads.push({ name: o.name, requestedId: id, resolvedId: id, content: o.source });
      return answer(o, id);
    },
    placeInApp: async (appId, o) => {
      const { beforeAppWrite, ...asked } = o;
      placements.push({ appId, ...asked });
      hooks.push(beforeAppWrite);
      return { added: [], alreadyPlaced: [], pinnedViews: [], warnings: [], appEdited: false };
    },
  };
}

const NAV = (key) => `Xrm.Navigation.navigateTo({ pageType: "generative", pageId: "PAGEREF_${key}", data: {} });`;

// Overview → Detail on disk under a real temp appDir. Options toggle malformed / undeclared / dangling refs.
function makeTwoPageApp(opts = {}) {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-deploy-'));
  const parts = [NAV('detail')];
  if (opts.malformed) parts.push("Xrm.Navigation.navigateTo({ pageType: 'generative', pageId: 'PAGEREF_detail' });"); // single-quoted → malformed
  if (opts.undeclaredRef) parts.push(NAV('ghost'));   // referenced at a real nav site, not declared
  if (opts.danglingTarget) parts.push(NAV('ghost'));  // declared + referenced, but 'ghost' is not a page
  fs.writeFileSync(path.join(appDir, 'overview.tsx'), `export default function Overview(){ ${parts.join(' ')} return null; }`, 'utf8');
  fs.writeFileSync(path.join(appDir, 'detail.tsx'), 'export default function Detail(){ return null; }', 'utf8');
  const navigatesTo = [{ targetKey: 'detail' }];
  if (opts.danglingTarget) navigatesTo.push({ targetKey: 'ghost' });
  const spec = {
    schemaVersion: 2,
    solution: { uniqueName: 'PgDeploy', displayName: 'Pg', publisherPrefix: 'contoso' },
    app: { name: 'Deploy App' },
    entities: [{ schemaName: 'contoso_item', displayName: 'Item', primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' }, columns: [] }],
    pages: [
      { key: 'overview', name: 'Overview', navigatesTo, source: { kind: 'tsx', codeFile: 'overview.tsx' } },
      { key: 'detail', name: 'Detail', source: { kind: 'tsx', codeFile: 'detail.tsx' } },
    ],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Pages', subAreas: [{ page: 'overview', title: 'Overview' }, { page: 'detail', title: 'Detail' }, TABLE_ENTRY] }] }] },
  };
  return { appDir, spec };
}

const PHASES = ['solution', 'data-model', 'app-shell', 'pages'];

test('deploy: nav page uploads RESOLVED content (target id, no PAGEREF_); canonical .tsx is NEVER GUID-mutated', async () => {
  const { appDir, spec } = makeTwoPageApp();
  try {
    const { sdk } = mockSdk();
    const genpageCli = mockGenpageCli();
    await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES });
    const overviewUpload = genpageCli.uploads.find((u) => u.name === 'Overview');
    assert.ok(overviewUpload.content.includes(DETAIL_ID), 'uploaded content carries the resolved target id');
    assert.ok(!/PAGEREF_/.test(overviewUpload.content), 'no PAGEREF_ token remains in the uploaded bytes');
    assert.ok(fs.readFileSync(path.join(appDir, 'overview.tsx'), 'utf8').includes('"PAGEREF_detail"'), 'canonical .tsx untouched');
    assert.ok(!fs.existsSync(path.join(appDir, '.maker-workspace', '.pageref-deploy')), 'the resolved copy is held in memory: no staging folder is made');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('deploy: a MALFORMED (single-quoted) nav PAGEREF_ HALTS before any upload (grammar, structural)', async () => {
  const { appDir, spec } = makeTwoPageApp({ malformed: true });
  try {
    const { sdk } = mockSdk();
    const genpageCli = mockGenpageCli();
    await assert.rejects(
      runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES }),
      (e) => e && e.phase === 'pages' && e.code === 'pages-malformed-navref'
    );
    assert.strictEqual(genpageCli.uploads.length, 0, 'scan rejects before any page write');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('deploy: a real nav ref with NO declaration HALTS on parity before any upload (parity, structural)', async () => {
  const { appDir, spec } = makeTwoPageApp({ undeclaredRef: true });
  try {
    const { sdk } = mockSdk();
    const genpageCli = mockGenpageCli();
    await assert.rejects(
      runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES }),
      (e) => e && e.phase === 'pages' && e.code === 'pages-nav-parity'
    );
    assert.strictEqual(genpageCli.uploads.length, 0);
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('deploy: a DECOY "PAGEREF_" string (not a nav call site) does NOT satisfy a declared edge — parity HALTs', async () => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-decoy-'));
  try {
    // Overview DECLARES nav to detail, but the only "PAGEREF_detail" is a decoy string; the REAL nav
    // points at "PAGEREF_other". Structural parity: referenced=[other], declared=[detail] → mismatch.
    fs.writeFileSync(path.join(appDir, 'overview.tsx'), `export default function O(){ const decoy = "PAGEREF_detail"; ${NAV('other')} return null; }`, 'utf8');
    fs.writeFileSync(path.join(appDir, 'detail.tsx'), 'export default function D(){ return null; }', 'utf8');
    const spec = {
      schemaVersion: 2, solution: { uniqueName: 'PgDecoy', displayName: 'Pg', publisherPrefix: 'contoso' }, app: { name: 'Decoy App' },
      entities: [{ schemaName: 'contoso_item', displayName: 'Item', primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' }, columns: [] }],
      pages: [{ key: 'overview', name: 'Overview', navigatesTo: [{ targetKey: 'detail' }], source: { kind: 'tsx', codeFile: 'overview.tsx' } }, { key: 'detail', name: 'Detail', source: { kind: 'tsx', codeFile: 'detail.tsx' } }],
      appShell: { areas: [{ label: 'M', groups: [{ label: 'P', subAreas: [{ page: 'overview' }, { page: 'detail' }, TABLE_ENTRY] }] }] },
    };
    const { sdk } = mockSdk();
    const genpageCli = mockGenpageCli();
    await assert.rejects(
      runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES }),
      (e) => e && e.phase === 'pages' && e.code === 'pages-nav-parity'
    );
    assert.strictEqual(genpageCli.uploads.length, 0, 'a decoy string cannot pass structural parity');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

// A PAGEREF_ token that is not the canonical pageId of a recognised call is not rewritten, and ships as the literal string
// "PAGEREF_x" — a dead link when the page hands it to the host as a page id. It is refused before ANY upload, naming the page
// and the line and column of each token, so the author finds it without searching.
const OVERVIEW_WITH = (...lines) => `export default function Overview(){\n${lines.map((l) => `  ${l}`).join('\n')}\n  return null;\n}`;
// What every report of a PAGEREF_ token states: where one may be, so the author knows what to change.
const PAGEREF_RULE_TEXT = /allowed only as the double-quoted pageId literal of a pageType:"generative" navigateTo call[\s\S]*and nowhere else — not in a comment/;

test('deploy: a PAGEREF_ token no navigation rewrite resolves HALTs before any upload, naming the page and the place', async () => {
  const cases = {
    'a string a call could read': [OVERVIEW_WITH('const route = "PAGEREF_detail";', NAV('detail')), /Overview[\s\S]*PAGEREF_detail \(line 2, column 18\)/],
    'template text': [OVERVIEW_WITH('const help = `open PAGEREF_detail next`;', NAV('detail')), /PAGEREF_detail \(line 2, column \d+\)/],
    'a lookup table': [OVERVIEW_WITH('const routes = { a: "PAGEREF_a", b: "PAGEREF_b" };', NAV('detail')), /PAGEREF_a \(line 2, column \d+\), PAGEREF_b \(line 2, column \d+\)/],
    'a call with a type assertion on its callee': [OVERVIEW_WITH('(navigateTo as Navigate)({ pageType: "generative", pageId: "PAGEREF_viaCast" });', NAV('detail')), /PAGEREF_viaCast \(line 2, column /],
    'a pageType that is not a literal': [OVERVIEW_WITH('navigateTo({ pageType: kind, pageId: "PAGEREF_detail" });', NAV('detail')), /PAGEREF_detail \(line 2, column /],
    'a nested data value': [OVERVIEW_WITH('Xrm.Navigation.navigateTo({ pageType: "generative", pageId: "PAGEREF_detail", data: { next: "PAGEREF_other" } });'), /PAGEREF_other \(line 2, column /],
    'a token in a type position, which the compiler erases but the build reads': [OVERVIEW_WITH('const key = "detail" as "PAGEREF_viaType";', NAV('detail')), /PAGEREF_viaType \(line 2, column \d+\)/],
    'a callee that is the argument of another call': [OVERVIEW_WITH('factory(navigateTo)({ pageType: "generative", pageId: "PAGEREF_viaFactory" });', NAV('detail')), /PAGEREF_viaFactory \(line 2, column /],
    'a callee after a non-null assertion': [OVERVIEW_WITH('factory!(navigateTo)({ pageType: "generative", pageId: "PAGEREF_viaBang" });', NAV('detail')), /PAGEREF_viaBang \(line 2, column /],
    'a callee after a generic instantiation': [OVERVIEW_WITH('factory<unknown>(navigateTo)({ pageType: "generative", pageId: "PAGEREF_viaGeneric" });', NAV('detail')), /PAGEREF_viaGeneric \(line 2, column /],
    'a callee after a tagged template': [OVERVIEW_WITH('tag`x`(navigateTo)({ pageType: "generative", pageId: "PAGEREF_viaTag" });', NAV('detail')), /PAGEREF_viaTag \(line 2, column /],
    'a callee after a function expression': [OVERVIEW_WITH('const g = function () { return f; }(navigateTo)({ pageType: "generative", pageId: "PAGEREF_viaFunction" });', NAV('detail')), /PAGEREF_viaFunction \(line 2, column /],
    'a token in a trailing comment, beside the real call': [OVERVIEW_WITH(`${NAV('detail')} // PAGEREF_detail`), /PAGEREF_detail \(line 2, column \d+\)/],
    'a token in a block comment after code': [OVERVIEW_WITH('const label = 1; /* PAGEREF_detail */', NAV('detail')), /PAGEREF_detail \(line 2, column \d+\)/],
    'a token in a // comment on a line of its own': [OVERVIEW_WITH('// PAGEREF_detail is replaced at deploy', NAV('detail')), /PAGEREF_detail \(line 2, column 6\)/],
    'a token in a block comment on a line of its own': [OVERVIEW_WITH('/* PAGEREF_detail is replaced at deploy */', NAV('detail')), /PAGEREF_detail \(line 2, column 6\)/],
    'a call written out in a comment': [OVERVIEW_WITH('// navigateTo({ pageType: "generative", pageId: "PAGEREF_viaComment" });', NAV('detail')), /PAGEREF_viaComment \(line 2, column /],
    'a template line that starts with // and holds no call': [OVERVIEW_WITH('const help = `\n// PAGEREF_viaTemplate\n`;', NAV('detail')), /PAGEREF_viaTemplate \(line 3, column 4\)/],
    'an object read in a condition, not handed to navigateTo': [OVERVIEW_WITH('navigateTo(({ pageType: "generative", pageId: "PAGEREF_inCondition" }).pageId.length === 14 ? a : b);', NAV('detail')), /PAGEREF_inCondition \(line 2, column /],
    'an options object built in a variable': [OVERVIEW_WITH('const options = { pageType: "generative", pageId: "PAGEREF_viaVariable" };', 'navigateTo(options);', NAV('detail')), /PAGEREF_viaVariable \(line 2, column /],
  };
  for (const [what, [source, expected]] of Object.entries(cases)) {
    const { appDir, spec } = makeTwoPageApp();
    try {
      fs.writeFileSync(path.join(appDir, 'overview.tsx'), source, 'utf8');
      const { sdk } = mockSdk();
      const genpageCli = mockGenpageCli();
      await assert.rejects(
        runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES }),
        (e) => e && e.phase === 'pages' && e.code === 'pages-stray-pageref' && expected.test(e.message) && PAGEREF_RULE_TEXT.test(e.message) && !e.recoverable,
        what
      );
      assert.strictEqual(genpageCli.uploads.length, 0, `${what}: refused before any page is created or updated`);
    } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
  }
});

// A page whose `/` after an object literal hides a call: JavaScript makes both navigations, but the lexer reads the `/` after the object literal on line 4 as a regex and
// the `/*` in `/\/*$/` as a comment over the second call, so the build resolved the first and shipped "PAGEREF_detail" in the second —
// with promotion, parity and the residue check all passing. It halts before any write, naming the call and the `/`.
test('deploy: a page whose "/" after an object literal hides a navigation call HALTs before any upload, naming the call and the "/"', async () => {
  const { appDir, spec } = makeTwoPageApp();
  try {
    fs.writeFileSync(path.join(appDir, 'overview.tsx'), OBJECT_DIVISION_PAGE, 'utf8');
    const { sdk } = mockSdk();
    const genpageCli = mockGenpageCli();
    await assert.rejects(
      runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES }),
      (e) => e && e.phase === 'pages' && e.code === 'pages-stray-pageref' && !e.recoverable
        && /Overview[\s\S]*PAGEREF_detail \(line 5, column \d+, after the "brace" ambiguity at line 4, column \d+\)/.test(e.message)
        && /may be a division or comparison after an object literal, or a regex or JSX element after a block[\s\S]*parentheses/.test(e.message)
    );
    assert.strictEqual(genpageCli.uploads.length, 0, 'refused before any page is created or updated');
    assert.strictEqual(fs.readFileSync(path.join(appDir, 'overview.tsx'), 'utf8'), OBJECT_DIVISION_PAGE, 'the canonical source is untouched');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
  // The control: with the object literal in parentheses the `/` is read right, and both calls deploy resolved.
  const fixed = OBJECT_DIVISION_PAGE.replace('{valueOf(){return 12;}, ...extras}/2', '({valueOf(){return 12;}, ...extras})/2');
  assert.notStrictEqual(fixed, OBJECT_DIVISION_PAGE);
  const control = makeTwoPageApp();
  try {
    fs.writeFileSync(path.join(control.appDir, 'overview.tsx'), fixed, 'utf8');
    const { sdk } = mockSdk();
    const genpageCli = mockGenpageCli();
    await runSdkBuild(control.spec, { sdk, apply: true, env: 'https://x', appDir: control.appDir, genpageCli, phases: PHASES });
    const overview = genpageCli.uploads.find((u) => u.name === 'Overview');
    assert.strictEqual(overview.content.split(`"${DETAIL_ID}"`).length - 1, 2, 'both calls are resolved');
    assert.ok(!/PAGEREF_/.test(overview.content));
  } finally { fs.rmSync(control.appDir, { recursive: true, force: true }); }
});

// Every way of making the lexer hide a navigation call, or read text as one, is a page the build refuses before any write
// (tests/helpers/misread-page.js). From the first spot the lexer reads by guess, every PAGEREF_ token is stray and none is rewritten, so
// the page is not half resolved. The message names the page, each token's line and column, and the kind and position of the guess.
test('deploy: each misread page HALTs before any upload, naming the token and the guess', async () => {
  for (const [name, { kind, frontier, code, reaching }] of Object.entries(MISREAD_PAGES)) {
    const { appDir, spec } = makeTwoPageApp();
    try {
      fs.writeFileSync(path.join(appDir, 'overview.tsx'), code, 'utf8');
      const at = frontier(code);
      const where = (offset) => {
        const lines = code.slice(0, offset).split('\n');
        return `line ${lines.length}, column ${lines[lines.length - 1].length + 1}`;
      };
      const { sdk } = mockSdk();
      const genpageCli = mockGenpageCli();
      await assert.rejects(
        runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES }),
        (e) => e && e.phase === 'pages' && e.code === 'pages-stray-pageref' && !e.recoverable
          && e.message.includes('page "Overview"')
          // A call that reaches the guess is untrusted whole, so its token is named though it lies before the guess.
          && e.message.includes(`PAGEREF_detail (${where(code.indexOf('PAGEREF_detail', reaching ? 0 : at))}, ${reaching ? 'in a call that reaches' : 'after'} the "${kind}" ambiguity at ${where(at)})`)
          && /this check cannot tell for certain how the code after it is read/.test(e.message),
        name
      );
      assert.strictEqual(genpageCli.uploads.length, 0, `${name}: refused before any page is created or updated`);
      assert.strictEqual(fs.readFileSync(path.join(appDir, 'overview.tsx'), 'utf8'), code, `${name}: the canonical source is untouched`);
    } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
  }
});

// A declared call the lexer cannot see is "declared-but-absent", and that alone sends the author looking for a call that is plainly there.
// The page of a live run: `of/2` is read as the start of a regex whose `/*` opens a comment over the call. The halt names the guess that
// hides it — which it is, where, what it could be, and what to change — and nothing is written. A page with no guess, and no call, is
// told only what is missing.
test('deploy: a declared call the lexer cannot see HALTs on parity, naming the guess that hides it', async () => {
  const { code, frontier } = HIDDEN_CALL_PAGE;
  const before = code.slice(0, frontier(code)).split('\n');
  const { appDir, spec } = makeTwoPageApp();
  try {
    fs.writeFileSync(path.join(appDir, 'overview.tsx'), code, 'utf8');
    const { sdk } = mockSdk();
    const genpageCli = mockGenpageCli();
    await assert.rejects(
      runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES }),
      (e) => e && e.phase === 'pages' && e.code === 'pages-nav-parity' && !e.recoverable
        && /page "Overview" navigation parity mismatch — declared-but-absent: \[detail\], referenced-but-undeclared: \[\]/.test(e.message)
        && e.message.includes(`the page has a "keyword" ambiguity at line ${before.length}, column ${before[before.length - 1].length + 1}, so a navigation call written after it may not be seen`)
        && /a "\/" or "<" right after a word that is a keyword in some places and a name in others/.test(e.message)
        && /this check cannot tell for certain how the code after it is read[\s\S]*parentheses/.test(e.message)
    );
    assert.strictEqual(genpageCli.uploads.length, 0, 'refused before any page is created or updated');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
  const bare = makeTwoPageApp();
  try {
    fs.writeFileSync(path.join(bare.appDir, 'overview.tsx'), 'export default function Overview(){ return null; }', 'utf8');
    const { sdk } = mockSdk();
    await assert.rejects(
      runSdkBuild(bare.spec, { sdk, apply: true, env: 'https://x', appDir: bare.appDir, genpageCli: mockGenpageCli(), phases: PHASES }),
      (e) => e && e.code === 'pages-nav-parity' && /declared-but-absent: \[detail\]/.test(e.message) && !/ambiguity/.test(e.message)
    );
  } finally { fs.rmSync(bare.appDir, { recursive: true, force: true }); }
});

// Pages the lexer reads right after a line break (ASI: a `!` or `++` there is a prefix operator, so the `/` after it is a regex). The page whose
// `++` is a prefix increment holds the text of a call in a regex: a token no rewrite resolves, so it HALTs before any upload and nothing is
// rewritten — no guess is involved, so the halt says only where a token may be. The page whose template line starts with `//` holds a real call
// in a `${}`, which runs, so it deploys resolved.
test('deploy: a regex after a prefix "++" holds a token no rewrite resolves, so the page HALTs before any upload', async () => {
  const { appDir, spec } = makeTwoPageApp();
  try {
    fs.writeFileSync(path.join(appDir, 'overview.tsx'), PREFIX_INCREMENT_PAGE, 'utf8');
    const { sdk } = mockSdk();
    const genpageCli = mockGenpageCli();
    await assert.rejects(
      runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES }),
      (e) => e && e.phase === 'pages' && e.code === 'pages-stray-pageref' && !e.recoverable
        && /page "Overview"[\s\S]*PAGEREF_detail \(line 6, column \d+\)/.test(e.message)
        && PAGEREF_RULE_TEXT.test(e.message) && !/ambiguity/.test(e.message)
    );
    assert.strictEqual(genpageCli.uploads.length, 0, 'refused before any page is created or updated');
    assert.strictEqual(fs.readFileSync(path.join(appDir, 'overview.tsx'), 'utf8'), PREFIX_INCREMENT_PAGE, 'the canonical source is untouched');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

// JSX text that looks like a parameter list: `<div data-active={enabled}>(a): Title</div>` is an element (TypeScript's rule), so the regex after
// the next arrow is data. The token in it is a token no rewrite resolves, so the page HALTs before any upload — and the regex is never rewritten
// into a call. No guess is involved, so the halt says only where a token may be.
test('deploy: JSX text that looks like parameters leaves a regex holding a token no rewrite resolves, so the page HALTs before any upload', async () => {
  const { appDir, spec } = makeTwoPageApp();
  try {
    fs.writeFileSync(path.join(appDir, 'overview.tsx'), JSX_TEXT_PAGE, 'utf8');
    const { sdk } = mockSdk();
    const genpageCli = mockGenpageCli();
    await assert.rejects(
      runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES }),
      (e) => e && e.phase === 'pages' && e.code === 'pages-stray-pageref' && !e.recoverable
        && /page "Overview"[\s\S]*PAGEREF_detail \(line 5, column \d+\)/.test(e.message)
        && PAGEREF_RULE_TEXT.test(e.message) && !/ambiguity/.test(e.message)
    );
    assert.strictEqual(genpageCli.uploads.length, 0, 'refused before any page is created or updated');
    assert.strictEqual(fs.readFileSync(path.join(appDir, 'overview.tsx'), 'utf8'), JSX_TEXT_PAGE, 'the canonical source is untouched');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

// After a unary or binary operator a `<` opens an element whatever follows its name (`a === <T extends X>text</T>`), so the regex after it is data and the token in it
// is a token no rewrite resolves: the page HALTs before any upload, with no guess named, and the regex is never rewritten into a call.
test('deploy: a regex after an element that follows a unary or binary operator holds a token no rewrite resolves, so the page HALTs before any upload', async () => {
  for (const { name, code } of ELEMENT_AFTER_OPERATOR_PAGES) {
    const { appDir, spec } = makeTwoPageApp();
    try {
      fs.writeFileSync(path.join(appDir, 'overview.tsx'), code, 'utf8');
      const { sdk } = mockSdk();
      const genpageCli = mockGenpageCli();
      await assert.rejects(
        runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES }),
        (e) => e && e.phase === 'pages' && e.code === 'pages-stray-pageref' && !e.recoverable
          && new RegExp(`page "Overview"[\\s\\S]*PAGEREF_detail \\(line ${ELEMENT_PAGE_TOKEN_LINE}, column \\d+\\)`).test(e.message)
          && PAGEREF_RULE_TEXT.test(e.message) && !/ambiguity/.test(e.message),
        name
      );
      assert.strictEqual(genpageCli.uploads.length, 0, `${name}: refused before any page is created or updated`);
      assert.strictEqual(fs.readFileSync(path.join(appDir, 'overview.tsx'), 'utf8'), code, `${name}: the canonical source is untouched`);
    } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
  }
});

// JSX that holds what looks like a function type's parameter list compiles as an element, so the regex after it is data: the token in it is a token no rewrite resolves,
// and the page HALTs before any upload, with no guess named. The regex is never rewritten into a call.
test('deploy: a regex after an element whose text looks like a parameter list holds a token no rewrite resolves, so the page HALTs before any upload', async () => {
  for (const { name, code } of ELEMENT_LOOKALIKE_PAGES) {
    const { appDir, spec } = makeTwoPageApp();
    try {
      fs.writeFileSync(path.join(appDir, 'overview.tsx'), code, 'utf8');
      const { sdk } = mockSdk();
      const genpageCli = mockGenpageCli();
      await assert.rejects(
        runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES }),
        (e) => e && e.phase === 'pages' && e.code === 'pages-stray-pageref' && !e.recoverable
          && new RegExp(`page "Overview"[\\s\\S]*PAGEREF_detail \\(line ${ELEMENT_PAGE_TOKEN_LINE}, column \\d+\\)`).test(e.message)
          && PAGEREF_RULE_TEXT.test(e.message) && !/ambiguity/.test(e.message),
        name
      );
      assert.strictEqual(genpageCli.uploads.length, 0, `${name}: refused before any page is created or updated`);
      assert.strictEqual(fs.readFileSync(path.join(appDir, 'overview.tsx'), 'utf8'), code, `${name}: the canonical source is untouched`);
    } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
  }
});

// A generic function type whose parameter list holds a type argument or an object type compiles, and no element does: it is a type, for certain, so the page is read as
// it is and the call after it deploys resolved. (A rule that took each for a guess at the `<` refused the page: the call after it was not trusted.)
test('deploy: a page that holds a generic function type with a type argument or an object type in its parameter list deploys resolved', async () => {
  for (const { name, code } of FUNCTION_TYPE_PAGES) {
    const { appDir, spec } = makeTwoPageApp();
    try {
      fs.writeFileSync(path.join(appDir, 'overview.tsx'), code, 'utf8');
      const { sdk } = mockSdk();
      const genpageCli = mockGenpageCli();
      await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES });
      const overview = genpageCli.uploads.find((u) => u.name === 'Overview');
      assert.strictEqual(overview.content, code.replace('"PAGEREF_detail"', `"${DETAIL_ID}"`), `${name}: exactly the call is rewritten`);
      assert.ok(!/PAGEREF_/.test(overview.content), name);
    } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
  }
});

test('deploy: a call in a template line that starts with // deploys resolved, as the page runs it', async () => {
  const { appDir, spec } = makeTwoPageApp();
  try {
    fs.writeFileSync(path.join(appDir, 'overview.tsx'), TEMPLATE_LINE_PAGE, 'utf8');
    const { sdk } = mockSdk();
    const genpageCli = mockGenpageCli();
    await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES });
    const overview = genpageCli.uploads.find((u) => u.name === 'Overview');
    assert.strictEqual(overview.content, TEMPLATE_LINE_PAGE.replace('"PAGEREF_detail"', `"${DETAIL_ID}"`), 'exactly the call is rewritten');
    assert.ok(!/PAGEREF_/.test(overview.content));
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

// The residual net on the RESOLVED copy: after resolution the page holds no raw PAGEREF_ token at all, and the copy is read as plain text,
// with no lexer and no exemption, before any page is updated with it. Every token the source check accepts is in a call the rewrite
// reaches, and every page id is a GUID (the sitemap, the manifest and the receipts are read as such), so no real page leaves one: the net is
// a tripwire for a defect in the checks before it. The resolver is made to leave one here — the token is put back into the resolved copy —
// and the build must halt, naming the page and the place, before any page is created or updated.
test('deploy: a resolved copy that still holds a PAGEREF_ token HALTs before any update, naming the page and the place', async () => {
  const resolverPath = require.resolve('../lib/pageref-resolver.js');
  const buildPath = require.resolve('../lib/sdk-build.js');
  const resolver = require(resolverPath);
  const real = resolver.resolvePageRefs;
  const live = [{ pageId: OVERVIEW_ID, name: 'Overview' }, { pageId: DETAIL_ID, name: 'Detail' }];
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: OVERVIEW_ID }, { key: 'detail', name: 'Detail', pageId: DETAIL_ID }] }), 'utf8').toString('base64');
  const proven = () => mockSdk({ pageManifest: manifest, manifestId: 'wr-manifest', liveSitemapXml: pageSitemap([OVERVIEW_ID, DETAIL_ID]), pageRows: live.map((p) => ({ uxagentprojectid: p.pageId, name: p.name })) });
  resolver.resolvePageRefs = (sources, keyToId) => {
    const resolved = real(sources, keyToId);
    const deployment = new Map(resolved.deployment);
    deployment.set('overview', deployment.get('overview').replace(`"${DETAIL_ID}"`, '"PAGEREF_detail"'));
    const { residual } = real(new Map([['overview', { code: deployment.get('overview') }]]), new Map());
    return { ...resolved, deployment, residual };
  };
  delete require.cache[buildPath];
  try {
    const { runSdkBuild: build } = require(buildPath);
    const { appDir, spec } = makeTwoPageApp();
    try {
      const { sdk } = proven();
      const genpageCli = mockGenpageCli(live);
      await assert.rejects(
        build(spec, { sdk, apply: true, env: 'https://x', appDir, genpage: genpageCli, phases: PHASES }),
        (e) => e && e.phase === 'pages' && e.code === 'pages-stray-pageref' && !e.recoverable
          && /page "Overview" has PAGEREF_ token\(s\) left once its navigation links were resolved/.test(e.message)
          && /PAGEREF_detail \(line \d+, column \d+\)/.test(e.message)
          && PAGEREF_RULE_TEXT.test(e.message)
      );
      assert.strictEqual(genpageCli.uploads.length, 0, 'no page is created or updated with the copy');
      assert.ok(fs.readFileSync(path.join(appDir, 'overview.tsx'), 'utf8').includes('"PAGEREF_detail"'), 'the canonical source is untouched');
    } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
  } finally {
    resolver.resolvePageRefs = real;
    delete require.cache[buildPath];
  }
  // The control: with the resolver as it is, the copy holds nothing and the same page deploys over the same proven ids.
  const control = makeTwoPageApp();
  try {
    const { sdk } = proven();
    const genpageCli = mockGenpageCli(live);
    await runSdkBuild(control.spec, { sdk, apply: true, env: 'https://x', appDir: control.appDir, genpageCli, phases: PHASES });
    const overview = genpageCli.uploads.find((u) => u.name === 'Overview');
    assert.ok(overview.content.includes(`"${DETAIL_ID}"`) && !/PAGEREF_/.test(overview.content));
  } finally { fs.rmSync(control.appDir, { recursive: true, force: true }); }
});
test('deploy: static spellings of a navigation call deploy resolved, and a comment that says what a call looks like is left as it was', async () => {
  const obj = '{ pageType: "generative", pageId: "PAGEREF_detail" }';
  for (const call of [`(navigateTo)(${obj});`, `navigateTo((${obj}));`, `Xrm.Navigation?.["navigateTo"]?.(${obj});`, `(Xrm.Navigation.navigateTo)?.((${obj}));`]) {
    const { appDir, spec } = makeTwoPageApp();
    try {
      fs.writeFileSync(path.join(appDir, 'overview.tsx'), OVERVIEW_WITH('// The link below is replaced at deploy /* by the build */', '// navigateTo({ pageType: "generative", pageId: "help-text" });', call), 'utf8');
      const { sdk } = mockSdk();
      const genpageCli = mockGenpageCli();
      await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES });
      const overview = genpageCli.uploads.find((u) => u.name === 'Overview');
      assert.ok(overview.content.includes(call.replace('"PAGEREF_detail"', `"${DETAIL_ID}"`)), `${call}: the token in the call is resolved`);
      assert.ok(overview.content.includes('// The link below is replaced at deploy /* by the build */'), `${call}: the line comment is left as it was`);
      assert.ok(overview.content.includes('// navigateTo({ pageType: "generative", pageId: "help-text" });'), `${call}: the comment that looks like a call is left as it was`);
      assert.ok(!/PAGEREF_/.test(overview.content), call);
    } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
  }
});

test('deploy: a type-only cast on a navigation literal deploys resolved with the cast kept, and a cast that hides an expression HALTs', async () => {
  const resolved = [
    'Xrm.Navigation.navigateTo({ pageType: "generative" as const, pageId: "PAGEREF_detail" as const });',
    'Xrm.Navigation.navigateTo({ pageType: "generative", pageId: "PAGEREF_detail" satisfies string, data: { next: 1 } } as const);',
    'navigateTo({ pageId: "PAGEREF_detail" as string, pageType: "generative" });',
  ];
  for (const call of resolved) {
    const { appDir, spec } = makeTwoPageApp();
    try {
      fs.writeFileSync(path.join(appDir, 'overview.tsx'), OVERVIEW_WITH(call), 'utf8');
      const { sdk } = mockSdk();
      const genpageCli = mockGenpageCli();
      await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES });
      const overview = genpageCli.uploads.find((u) => u.name === 'Overview');
      assert.ok(overview.content.includes(call.replace('"PAGEREF_detail"', `"${DETAIL_ID}"`)), `${call}: the literal is replaced and the cast stays`);
      assert.ok(!/PAGEREF_/.test(overview.content), call);
    } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
  }
  for (const [value, tokens] of [
    ['("PAGEREF_detail" as const).slice(1)', 'PAGEREF_detail'],
    ['"PAGEREF_detail" as const + "x"', 'PAGEREF_detail'],
    ['"PAGEREF_detail" as unknown as true < limit > [false][0]', 'PAGEREF_detail'],
    ['"PAGEREF_detail" as "PAGEREF_other"', 'PAGEREF_detail, PAGEREF_other'],
    ['"PAGEREF_detail" as Readonly<string>', 'PAGEREF_detail'],
  ]) {
    const { appDir, spec } = makeTwoPageApp();
    try {
      fs.writeFileSync(path.join(appDir, 'overview.tsx'), OVERVIEW_WITH(NAV('detail'), `Xrm.Navigation.navigateTo({ pageType: "generative", pageId: ${value} });`), 'utf8');
      const { sdk } = mockSdk();
      const genpageCli = mockGenpageCli();
      await assert.rejects(
        runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES }),
        (e) => e && e.phase === 'pages' && e.code === 'pages-malformed-navref' && e.message.includes(`: ${tokens} —`) && PAGEREF_RULE_TEXT.test(e.message),
        value
      );
      assert.strictEqual(genpageCli.uploads.length, 0, `${value}: refused before any page is created or updated`);
    } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
  }
});

test('deploy: a declared+referenced DANGLING target HALTs before the sitemap finalize', async () => {
  const { appDir, spec } = makeTwoPageApp({ danglingTarget: true });
  try {
    const { sdk, calls } = mockSdk();
    const genpageCli = mockGenpageCli();
    await assert.rejects(
      runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES }),
      (e) => e && e.phase === 'pages' && e.code === 'pages-dangling-navref'
    );
    assert.ok(!calls.some((c) => c.name === 'updateElement' && c.args[2] === '/siteMap'), 'sitemap NOT finalized on a dangling target');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('deploy: create-absent-first mints target ids, uploads each page ONCE, records both ids in the manifest', async () => {
  const { appDir, spec } = makeTwoPageApp();
  try {
    const { sdk, calls } = mockSdk();
    const genpageCli = mockGenpageCli();
    await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES });
    assert.strictEqual(genpageCli.uploads.filter((u) => u.name === 'Detail').length, 1);
    assert.strictEqual(genpageCli.uploads.filter((u) => u.name === 'Overview').length, 1);
    const writes = calls.filter((c) => (c.name === 'createWebResource' && /_pagemanifest$/.test(c.args[0].name)) || c.name === 'updateWebResource');
    const last = writes[writes.length - 1];
    const content = last.name === 'updateWebResource' ? last.args[1].content : last.args[0].content;
    const byKey = Object.fromEntries(JSON.parse(content).pages.map((p) => [p.key, p.pageId]));
    assert.strictEqual(byKey.overview, OVERVIEW_ID);
    assert.strictEqual(byKey.detail, DETAIL_ID);
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('deploy: a rebuild re-binds ids from the live enumeration and issues only UPDATEs (no duplicate CREATE)', async () => {
  const { appDir, spec } = makeTwoPageApp();
  try {
    const live = [{ pageId: OVERVIEW_ID, name: 'Overview' }, { pageId: DETAIL_ID, name: 'Detail' }];
    const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: OVERVIEW_ID }, { key: 'detail', name: 'Detail', pageId: DETAIL_ID }] }), 'utf8').toString('base64');
    const { sdk } = mockSdk({ pageManifest: manifest, manifestId: 'wr-manifest', liveSitemapXml: pageSitemap([OVERVIEW_ID, DETAIL_ID]), pageRows: live.map((p) => ({ uxagentprojectid: p.pageId, name: p.name })) });
    const genpageCli = mockGenpageCli(live);
    await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES });
    assert.ok(genpageCli.uploads.length > 0);
    assert.ok(genpageCli.uploads.every((u) => !!u.requestedId), 'every upload targets a known pageId (UPDATE) — no CREATE, no duplicate');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

// Duplicate page names: validateAppSpec TOLERATES a duplicate name when both pages carry a
// pageId, but a pageId is only a CLAIM. A STALE snapshot (a page deleted in Maker since download) reconciles
// its id as ABSENT, so the upload loop would CREATE it fresh and re-materialize the duplicate. The
// post-reconcile gate must HALT before any write; a fresh download (both ids live) must still build.
function makeDupNamePageApp() {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-dupname-'));
  fs.writeFileSync(path.join(appDir, 'a.tsx'), 'export default function A(){ return null; }', 'utf8');
  fs.writeFileSync(path.join(appDir, 'b.tsx'), 'export default function B(){ return null; }', 'utf8');
  const GA = 'aaaaaaaa-0000-4000-8000-00000000aaaa';
  const GB = 'bbbbbbbb-0000-4000-8000-00000000bbbb';
  const spec = {
    schemaVersion: 2,
    solution: { uniqueName: 'PgDup', displayName: 'Pg', publisherPrefix: 'contoso' },
    app: { name: 'Dup App' },
    entities: [{ schemaName: 'contoso_item', displayName: 'Item', primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' }, columns: [] }],
    pages: [
      { key: 'sc-a', name: 'Supplier Scorecard', pageId: GA, source: { kind: 'tsx', codeFile: 'a.tsx' } },
      { key: 'sc-b', name: 'Supplier Scorecard', pageId: GB, source: { kind: 'tsx', codeFile: 'b.tsx' } },
    ],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Pages', subAreas: [{ page: 'sc-a', title: 'Supplier Scorecard' }, { page: 'sc-b', title: 'Supplier Scorecard' }, TABLE_ENTRY] }] }] },
  };
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'sc-a', name: 'Supplier Scorecard', pageId: GA }, { key: 'sc-b', name: 'Supplier Scorecard', pageId: GB }] }), 'utf8').toString('base64');
  return { appDir, spec, GA, GB, manifest };
}

test('deploy: a STALE duplicate-named page (its pageId absent from live) HALTS before creating a dupe', async () => {
  const { appDir, spec, GA, manifest } = makeDupNamePageApp();
  try {
    const { sdk } = mockSdk({ pageManifest: manifest, manifestId: 'wr-manifest', liveSitemapXml: pageSitemap([GA]), pageRows: [{ uxagentprojectid: GA, name: 'Supplier Scorecard' }] });
    const genpageCli = mockGenpageCli([{ pageId: GA, name: 'Supplier Scorecard' }]); // only GA exists; GB is stale
    await assert.rejects(
      runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES }),
      (e) => e.code === 'pages-duplicate-name-create' || /duplicate-named generative page/.test(String(e && e.message)),
    );
    assert.strictEqual(genpageCli.uploads.length, 0, 'HALT before any page write (never materialize the duplicate)');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('deploy: two duplicate-named pages BOTH live (fresh download) build as UPDATEs — no false halt (the repro is safe)', async () => {
  const { appDir, spec, GA, GB, manifest } = makeDupNamePageApp();
  try {
    const { sdk } = mockSdk({ pageManifest: manifest, manifestId: 'wr-manifest', liveSitemapXml: pageSitemap([GA, GB]), pageRows: [GA, GB].map((id) => ({ uxagentprojectid: id, name: 'Supplier Scorecard' })) });
    const genpageCli = mockGenpageCli([{ pageId: GA, name: 'Supplier Scorecard' }, { pageId: GB, name: 'Supplier Scorecard' }]); // BOTH exist
    await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES });
    assert.strictEqual(genpageCli.uploads.length, 2, 'both dupe-named pages uploaded');
    assert.ok(genpageCli.uploads.every((u) => !!u.requestedId), 'both are UPDATEs (bound to live ids) — no CREATE, no duplicate materialized');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

// A DYNAMIC nav pageId (e.g. pageId: someVar — a variable, not a literal)
// must be rejected BEFORE any write, even when navigatesTo:[] so the existing parity check sees no mismatch.
// Only extractNavTargets-based structural detection (kind:'dynamic') catches it. Error code: pages-nav-parity.
test('deploy: trailing spread after nav pageId HALTS before any write', async () => {
  const { appDir, spec } = makeTwoPageApp();
  try {
    fs.writeFileSync(path.join(appDir, 'overview.tsx'),
      `export default function O(){ const options = JSON.parse('{"pageId":"PAGEREF_other"}'); Xrm.Navigation.navigateTo({ pageType: "generative", pageId: "PAGEREF_detail", ...options }); return null; }`,
      'utf8');
    const { sdk } = mockSdk();
    const genpageCli = mockGenpageCli();
    await assert.rejects(
      runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES }),
      (e) => e && e.phase === 'pages' && e.code === 'pages-nav-parity'
    );
    assert.strictEqual(genpageCli.uploads.length, 0, 'trailing spread can override pageId at runtime, so the page is rejected before upload');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('deploy: DYNAMIC nav pageId (variable expression) HALTS before any write', async () => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-dynav-'));
  try {
    // overview: navigatesTo:[] but source calls navigateTo with a variable pageId (dynamic, unverifiable target)
    fs.writeFileSync(path.join(appDir, 'overview.tsx'),
      `export default function O(){ Xrm.Navigation.navigateTo({ pageType: "generative", pageId: someVar, data: {} }); return null; }`,
      'utf8');
    fs.writeFileSync(path.join(appDir, 'detail.tsx'), 'export default function D(){ return null; }', 'utf8');
    const spec = {
      schemaVersion: 2,
      solution: { uniqueName: 'PgDynNav', displayName: 'Pg', publisherPrefix: 'contoso' },
      app: { name: 'DynNav App' },
      entities: [{ schemaName: 'contoso_item', displayName: 'Item', primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' }, columns: [] }],
      // navigatesTo:[] so the existing parity check (declared vs referenced canonical PAGEREF) sees no mismatch;
      // only extractNavTargets's 'dynamic' kind detection rejects this before any write.
      pages: [
        { key: 'overview', name: 'Overview', navigatesTo: [], source: { kind: 'tsx', codeFile: 'overview.tsx' } },
        { key: 'detail', name: 'Detail', source: { kind: 'tsx', codeFile: 'detail.tsx' } },
      ],
      appShell: { areas: [{ label: 'Main', groups: [{ label: 'P', subAreas: [{ page: 'overview' }, { page: 'detail' }, TABLE_ENTRY] }] }] },
    };
    const { sdk } = mockSdk();
    const genpageCli = mockGenpageCli();
    await assert.rejects(
      runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES }),
      (e) => e && e.phase === 'pages' && e.code === 'pages-nav-parity'
    );
    assert.strictEqual(genpageCli.uploads.length, 0, 'dynamic nav pageId rejected before any write');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

// A LITERAL GUID nav pageId (hardcoded env-specific id — breaks cross-env
// recreate, design §9) must be rejected BEFORE any write. Even with navigatesTo:[] (parity passes),
// extractNavTargets (kind:'literal') catches it. Error code: pages-nav-parity.
test('deploy: LITERAL GUID nav pageId (hardcoded) HALTS before any write', async () => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-litguid-'));
  try {
    // overview: navigatesTo:[] but source has a hardcoded GUID as pageId — env-specific, not symbolic
    fs.writeFileSync(path.join(appDir, 'overview.tsx'),
      `export default function O(){ Xrm.Navigation.navigateTo({ pageType: "generative", pageId: "00000000-0000-0000-0000-000000000000", data: {} }); return null; }`,
      'utf8');
    fs.writeFileSync(path.join(appDir, 'detail.tsx'), 'export default function D(){ return null; }', 'utf8');
    const spec = {
      schemaVersion: 2,
      solution: { uniqueName: 'PgLitGuid', displayName: 'Pg', publisherPrefix: 'contoso' },
      app: { name: 'LitGuid App' },
      entities: [{ schemaName: 'contoso_item', displayName: 'Item', primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' }, columns: [] }],
      // navigatesTo:[] so parity passes; only extractNavTargets 'literal' detection rejects this.
      pages: [
        { key: 'overview', name: 'Overview', navigatesTo: [], source: { kind: 'tsx', codeFile: 'overview.tsx' } },
        { key: 'detail', name: 'Detail', source: { kind: 'tsx', codeFile: 'detail.tsx' } },
      ],
      appShell: { areas: [{ label: 'Main', groups: [{ label: 'P', subAreas: [{ page: 'overview' }, { page: 'detail' }, TABLE_ENTRY] }] }] },
    };
    const { sdk } = mockSdk();
    const genpageCli = mockGenpageCli();
    await assert.rejects(
      runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES }),
      (e) => e && e.phase === 'pages' && e.code === 'pages-nav-parity'
    );
    assert.strictEqual(genpageCli.uploads.length, 0, 'literal GUID nav pageId rejected before any write');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

// ---- #changed-only pages-only fast-apply seams (opts.changedOnly) --------------------------------------
// Two flag-gated seams in runSdkBuild: (a) seed result.created.app from opts.changedOnly.resolvedAppId so a
// pages-only apply passes `pages-requires-app` without running app-shell; (b) skip the sitemap finalize so
// appDef(spec, result.created) does not rebuild the WHOLE sitemap from an incomplete result.created (which
// would THROW on a dashboard subarea and STRIP form/view/chart component registrations).
const PAGES_ONLY = ['pages'];

// A single implemented page whose app sitemap ALSO has a dashboard subarea — the dashboard subarea is what
// makes a pages-only finalize (appDef with result.dashboards empty) throw, so it proves both landmine + fix.
function makeOnePageDashboardApp() {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chg-only-'));
  fs.writeFileSync(path.join(appDir, 'overview.tsx'), 'export default function Overview(){ return null; }', 'utf8');
  const spec = {
    schemaVersion: 2,
    solution: { uniqueName: 'ChgOnly', displayName: 'C', publisherPrefix: 'contoso' },
    app: { name: 'Changed Only App' },
    entities: [{ schemaName: 'contoso_item', displayName: 'Item', primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' }, columns: [] }],
    pages: [{ key: 'overview', name: 'Overview', source: { kind: 'tsx', codeFile: 'overview.tsx' } }],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'G', subAreas: [{ page: 'overview', title: 'Overview' }, { dashboard: 'Ops', title: 'Ops' }] }] }] },
  };
  return { appDir, spec };
}

const finalizeRan = (calls) => calls.some((c) => c.name === 'updateElement' && c.args[0] === 'app' && c.args[2] === '/siteMap');

test('changed-only: a pages-only apply WITHOUT a seeded app id still HALTS on pages-requires-app', async () => {
  const { appDir, spec } = makeOnePageDashboardApp();
  try {
    const { sdk } = mockSdk();
    const genpageCli = mockGenpageCli();
    await assert.rejects(
      runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PAGES_ONLY }),
      (e) => e && e.phase === 'pages' && e.code === 'pages-requires-app'
    );
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('changed-only: a pages-only apply with a seeded app id but WITHOUT skipping the finalize THROWS on the dashboard subarea (the landmine)', async () => {
  const { appDir, spec } = makeOnePageDashboardApp();
  try {
    const { sdk } = mockSdk();
    const genpageCli = mockGenpageCli();
    // resolvedAppId lets pages run, but the finalize rebuilds the sitemap from an empty result.dashboards.
    await assert.rejects(
      runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PAGES_ONLY, changedOnly: { resolvedAppId: APP_ID } }),
      (e) => /dashboard 'Ops' which wasn't built/.test(String(e && e.message))
    );
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('changed-only: pages-only with resolvedAppId + skipSitemapFinalize UPLOADS the page and SKIPS the finalize (the fix)', async () => {
  const { appDir, spec } = makeOnePageDashboardApp();
  try {
    const { sdk, calls } = mockSdk();
    const genpageCli = mockGenpageCli();
    const r = await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PAGES_ONLY, changedOnly: { resolvedAppId: APP_ID, skipSitemapFinalize: true } });
    assert.ok(r.ok);
    assert.ok(genpageCli.uploads.some((u) => u.name === 'Overview'), 'the changed page was re-uploaded');
    assert.ok(!finalizeRan(calls), 'the sitemap finalize (appDef rebuild) must be skipped for a content-only re-upload');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('changed-only: a NORMAL full build (no opts.changedOnly) still runs the sitemap finalize (seam is byte-identical off-path)', async () => {
  const { appDir, spec } = makeTwoPageApp();
  try {
    const { sdk, calls } = mockSdk();
    const genpageCli = mockGenpageCli();
    await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES });
    assert.ok(finalizeRan(calls), 'the full-build path is unchanged — the finalize still runs');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('changed-only selectedKeysOnly: uploads ONLY the selected page(s), never clobbers an unchanged one', async () => {
  // Two independent (no-nav) pages already deployed; a changed-only fast apply selects only "overview".
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-keys-'));
  try {
    fs.writeFileSync(path.join(appDir, 'overview.tsx'), 'export default function O(){ return null; }', 'utf8');
    fs.writeFileSync(path.join(appDir, 'detail.tsx'), 'export default function D(){ return null; }', 'utf8');
    const spec = {
      schemaVersion: 2,
      solution: { uniqueName: 'SelKeys', displayName: 'S', publisherPrefix: 'contoso' },
      app: { name: 'Sel Keys App' },
      entities: [{ schemaName: 'contoso_item', displayName: 'Item', primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' }, columns: [] }],
      pages: [
        { key: 'overview', name: 'Overview', source: { kind: 'tsx', codeFile: 'overview.tsx' } },
        { key: 'detail', name: 'Detail', source: { kind: 'tsx', codeFile: 'detail.tsx' } },
      ],
      appShell: { areas: [{ label: 'Main', groups: [{ label: 'G', subAreas: [{ page: 'overview', title: 'Overview' }, { page: 'detail', title: 'Detail' }] }] }] },
    };
    // Both pages already exist (seed enumerate + a base64 manifest so reconcile resolves both to live ids).
    const live = [{ pageId: OVERVIEW_ID, name: 'Overview' }, { pageId: DETAIL_ID, name: 'Detail' }];
    const genpageCli = mockGenpageCli(live);
    const manifest = { schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: OVERVIEW_ID }, { key: 'detail', name: 'Detail', pageId: DETAIL_ID }] };
    const manifestB64 = Buffer.from(JSON.stringify(manifest), 'utf8').toString('base64');
    const { sdk } = mockSdk({ pageManifest: manifestB64, liveSitemapXml: pageSitemap([OVERVIEW_ID, DETAIL_ID]), pageRows: live.map((p) => ({ uxagentprojectid: p.pageId, name: p.name })) });
    const r = await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PAGES_ONLY, changedOnly: { fastApply: true, resolvedAppId: APP_ID, skipSitemapFinalize: true, selectedKeys: ['overview'] } });
    assert.ok(r.ok);
    const uploaded = genpageCli.uploads.map((u) => u.name);
    assert.ok(uploaded.includes('Overview'), 'the selected page was uploaded');
    assert.ok(!uploaded.includes('Detail'), 'the UNCHANGED page was NOT re-uploaded (no clobber)');
    assert.ok(r.created.pageDeployedShas.overview, 'a measured deployed hash is recorded for the uploaded page');
    assert.ok(!r.created.pageDeployedShas.detail, 'no deployed hash for the page we did not touch');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

// A page that SUPPLIES a blank prompt or agent message would otherwise have generated text deployed
// in its place — the fabricated-provenance defect, reached through /app-builder rather than the
// standalone CLI. The standalone path refuses it; this asserts app-builder refuses it too, and does
// so BEFORE any upload so a bad spec cannot leave half the pages deployed.
test('deploy: a page with a present-but-blank agent message HALTS before any upload', async () => {
  const { appDir, spec } = makeTwoPageApp();
  try {
    spec.pages[0].agentMessage = '   \n'; // whitespace-only: a blank file is how this really arrives
    const { sdk } = mockSdk();
    const genpageCli = mockGenpageCli();
    await assert.rejects(
      runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES }),
      (e) => e && e.phase === 'pages' && e.code === 'pages-blank-provenance'
    );
    assert.strictEqual(genpageCli.uploads.length, 0, 'nothing may deploy when provenance is blank');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

// ── The Griffel check in the build's pre-write scan (AB#6691124) ────────────────────────────────────────────────────────────────────
// Griffel drops ten CSS shorthands from a `makeStyles` object at runtime and nothing between the author and the browser notices, so a page that writes one deploys without its
// border, colour or reset. /app-builder pages come from workers that have no shell, from hand edits after a download, and from specs written by hand: every one of them reaches this
// scan before a page is created or updated, so this is where the defect is stopped whatever instructions were or were not followed.
const GRIFFEL_IMPORT = "import { makeStyles, tokens } from '@fluentui/react-components';\n";
const GRIFFEL_BAD = `${GRIFFEL_IMPORT}const useStyles = makeStyles({\n  root: {\n    borderWidth: '1px',\n    padding: '4px',\n  },\n  hover: { ':hover': { borderColor: 'red' } },\n});\nexport default function Detail() { return null; }\n`;
const GRIFFEL_CLEAN = `${GRIFFEL_IMPORT}// borderWidth: 1\nconst useStyles = makeStyles({ root: { borderTopWidth: '1px', padding: '4px' } });\nexport default function Detail() { return <div style={{ borderColor: 'red' }}>{'borderStyle'}</div>; }\n`;
// Valid TSX that the lexer cannot read for certain: after `if (s) { }` a `/` could start a regex or divide, so the makeStyles call below it is not one the checker can vouch for.
const GRIFFEL_UNREADABLE = `${GRIFFEL_IMPORT}export function skip(s: string) { if (s) { } /x/.test(s); }\nconst useStyles = makeStyles({ root: { padding: '4px' } });\nexport default function Detail() { return null; }\n`;
// A style object written elsewhere: its keys — here one Griffel drops — are not in the call, so the checker cannot see them.
const GRIFFEL_INDIRECT = `${GRIFFEL_IMPORT}const styles = { root: { borderWidth: '1px' } };\nconst useStyles = makeStyles(styles);\nexport default function Detail() { return null; }\n`;
const BOTH_WAYS_OUT = 'Deleting a key changes nothing on screen, because Griffel never applied it; writing the longhands (for `all`, the properties you want) makes the style start to render, which changes how the page looks.';

// What an earlier APPLY left in last-applied.json, read back as build-model-app.js reads it for the next build (`opts.baselineSpec`): the real writer and the real reader, so each page's
// `__contentSha` is the hash the changed-only flow records, of the source as it is on disk NOW — call it before editing a page to record "the source as last applied". The reader returns
// the snapshot only for the app and environment it describes, as it does for a build.
const BASELINE_ENV = 'https://contoso.crm.dynamics.com';
function recordApply(spec, appDir) {
  const workspace = path.join(appDir, '.maker-workspace');
  const identity = { environment: BASELINE_ENV, appUniqueName: appUniqueName(spec) };
  writeBaseline(workspace, spec, { appDir, ...identity, created: { pages: { overview: OVERVIEW_ID, detail: DETAIL_ID } } });
  return readBaseline(workspace, identity);
}
// A rebuild of the two-page app with `detail` as given: both pages are live and bound by the manifest, and neither links to the other (so no source is rewritten on its way out).
// `rebuild({ baselineSpec })` runs the pages phase; its `warnings` are what the build said through `warn` about Griffel (it also warns about other things — an organization language it could not read, say).
function deployedApp(detail) {
  const { appDir, spec } = makeTwoPageApp();
  fs.writeFileSync(path.join(appDir, 'overview.tsx'), 'export default function Overview(){ return null; }', 'utf8');
  fs.writeFileSync(path.join(appDir, 'detail.tsx'), detail, 'utf8');
  spec.pages[0].navigatesTo = undefined;
  const live = [{ pageId: OVERVIEW_ID, name: 'Overview' }, { pageId: DETAIL_ID, name: 'Detail' }];
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: OVERVIEW_ID }, { key: 'detail', name: 'Detail', pageId: DETAIL_ID }] }), 'utf8').toString('base64');
  const rebuild = (extra = {}) => {
    const { sdk } = mockSdk({ pageManifest: manifest, liveSitemapXml: pageSitemap([OVERVIEW_ID, DETAIL_ID]), pageRows: live.map((p) => ({ uxagentprojectid: p.pageId, name: p.name })) });
    const genpageCli = mockGenpageCli(live);
    const warnings = [];
    return { genpageCli, warnings, run: () => runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES, warn: (m) => { if (/Griffel/.test(m)) warnings.push(m); }, ...extra }) };
  };
  return { appDir, spec, rebuild, edit: (text) => fs.writeFileSync(path.join(appDir, 'detail.tsx'), text, 'utf8'), cleanup: () => fs.rmSync(appDir, { recursive: true, force: true }) };
}

test('deploy: a NEW page whose makeStyles drops a Griffel shorthand HALTS before any upload, naming the page, each key\'s line and column, the longhands and both ways out', async () => {
  const { appDir, spec } = makeTwoPageApp();
  try {
    fs.writeFileSync(path.join(appDir, 'detail.tsx'), GRIFFEL_BAD, 'utf8');
    const { sdk } = mockSdk();
    const genpageCli = mockGenpageCli();
    await assert.rejects(
      runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES }),
      (e) => {
        assert.strictEqual(e.phase, 'pages');
        assert.strictEqual(e.code, 'pages-griffel-shorthand');
        assert.strictEqual(e.recoverable, false);
        assert.ok(e.message.startsWith('page "Detail" writes CSS that Griffel drops at runtime, so the page would deploy without it — '), e.message);
        assert.ok(e.message.includes('detail.tsx:4:5: `borderWidth` is not supported by Griffel'), 'where the first key is');
        assert.ok(e.message.includes('detail.tsx:7:24: `borderColor` is not supported by Griffel'), 'and the second');
        assert.ok(e.message.includes('Write the longhands instead: borderTopWidth, borderRightWidth, borderBottomWidth, borderLeftWidth.'));
        assert.ok(e.message.includes(BOTH_WAYS_OUT), 'and what each way out does: deleting the key keeps the look, the longhands start to render');
        assert.match(e.message, /Fix them in the page's source \(`node scripts\/check-griffel-styles\.js --file <page\.tsx>` lists every one\), then re-run\.$/);
        assert.doesNotMatch(e.message, /Its source changed since/, 'a page that does not exist yet has no earlier source to have changed from');
        return true;
      }
    );
    assert.strictEqual(genpageCli.uploads.length, 0, 'the scan rejects before any page is created — not even the page that is clean');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

// The halt's text opens with the page's name, and buildModelApp decides from the text whether a halt is a transient error to run the build again for (isTransientHalt). A page called
// "SQL Timeout Report" must not make this refusal read as one: it is raised before anything in the pages phase is written, so a run again can only repeat it — three more times, after every
// earlier phase, with a log that blames the service. The words alone DO read as transient (the control), so it is the marker that is tested; the receipt halt carries the same one.
test('deploy: the Griffel halt of a page whose name reads as a transient error is not retried by the build', async () => {
  const { buildModelApp, isTransientHalt } = require('../build-model-app.js');
  const { appDir, spec } = onePageApp('SQL Timeout Report');
  try {
    fs.writeFileSync(path.join(appDir, 'p.tsx'), GRIFFEL_BAD, 'utf8');
    const genpageCli = mockGenpageCli();
    const { sdk } = mockSdk();
    const lines = [];
    let halt = null;
    try {
      await buildModelApp(spec, { apply: true, env: 'https://contoso.crm.dynamics.com', appDir, retryDelayMs: 0 }, {
        sdk, provisionSdk: sdk, genpage: genpageCli, sleep: async () => {}, log: (m) => lines.push(m),
        discoverOpDiffState: async () => ({ collision: { appExists: false, solutionExists: false }, forms: [], sitemap: null }),
      });
    } catch (e) { halt = e; }
    assert.ok(halt, 'the build halts');
    assert.strictEqual(halt.code, 'pages-griffel-shorthand');
    assert.match(halt.message, /^page "SQL Timeout Report" writes CSS that Griffel drops at runtime/);
    assert.strictEqual(genpageCli.uploads.length, 0, 'before any page is created');
    assert.deepStrictEqual(lines.filter((l) => /transient error|retrying/.test(l)), [], 'and no retry');
    assert.strictEqual(isTransientHalt(halt, { spec }), false, 'the halt reads as final');
    assert.strictEqual(halt.transient, false, 'because it says so');
    assert.strictEqual(isTransientHalt(new Error(halt.message), { spec }), true, 'its words alone would have read as a transient error');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('deploy: the Griffel check holds for a NEW navigation page, whose canonical source is checked ahead of the resolved copy', async () => {
  const nav = makeTwoPageApp();
  try {
    fs.writeFileSync(path.join(nav.appDir, 'overview.tsx'), `${GRIFFEL_IMPORT}const s = makeStyles({ root: { borderStyle: 'solid' } });\nexport default function Overview(){ ${NAV('detail')} return null; }\n`, 'utf8');
    const genpageCli = mockGenpageCli();
    await assert.rejects(
      runSdkBuild(nav.spec, { sdk: mockSdk().sdk, apply: true, env: 'https://x', appDir: nav.appDir, genpageCli, phases: PHASES }),
      (e) => e && e.code === 'pages-griffel-shorthand' && /page "Overview" writes CSS[\s\S]*overview\.tsx:2:[0-9]+: `borderStyle`/.test(e.message)
    );
    assert.strictEqual(genpageCli.uploads.length, 0, 'no target was minted for the navigation either');
  } finally { fs.rmSync(nav.appDir, { recursive: true, force: true }); }
});

// A page deployed by an earlier release can carry a key Griffel drops (its only guard was a grep for `borderWidth`): `borderColor` under `:hover` passed. Sending the same bytes again ships
// nothing new, and stopping a rebuild over a page nobody touched — after the earlier phases have written — leaves one way through, editing it, whose longhands CHANGE how the page renders.
test('deploy: a page already deployed with a dropped key and sent again UNCHANGED is warned about, not refused — each key named, with both ways out', async () => {
  const app = deployedApp(GRIFFEL_BAD);
  try {
    // The last apply sent this very source: last-applied.json records its hash.
    const baselineSpec = recordApply(app.spec, app.appDir);
    const r = app.rebuild({ baselineSpec });
    await r.run();
    assert.deepStrictEqual(r.genpageCli.uploads.map((u) => u.name).sort(), ['Detail', 'Overview'], 'both pages are updated, as any rebuild does');
    assert.strictEqual(r.genpageCli.uploads.find((u) => u.name === 'Detail').content, GRIFFEL_BAD, 'and what is sent is the source, untouched');
    assert.strictEqual(r.warnings.length, 1, 'one warning, for the page that has the keys — the clean page says nothing');
    const [warning] = r.warnings;
    assert.ok(warning.startsWith('page "Detail" is already deployed, and its source is the one the last build recorded for it, so this build sends it again as it is and goes on. '), warning);
    assert.ok(warning.includes('detail.tsx:4:5: `borderWidth` is not supported by Griffel'), 'the first key, where it is');
    assert.ok(warning.includes('detail.tsx:7:24: `borderColor` is not supported by Griffel'), 'and the second');
    assert.ok(warning.includes(BOTH_WAYS_OUT), 'both ways out');
    assert.match(warning, /lists every one\); once the page's source changes, the build holds it to the check and stops on anything the check still reports\.$/);
    // A caller that does not listen (no `warn`) goes on all the same: the warning is advice, never a condition.
    await app.rebuild({ baselineSpec, warn: undefined }).run();
  } finally { app.cleanup(); }
});

// A page that links to another is uploaded as a RESOLVED copy (the target's id where its source has a PAGEREF_ name), and what an apply records is the hash of the SOURCE in the app folder.
// The comparison is with that source, so such a page is told "unchanged" like any other — and an edit to the source is what changes it.
test('deploy: a deployed NAVIGATION page with a dropped key, sent again unchanged, is warned about — its source is compared, not the resolved copy that is uploaded', async () => {
  const { appDir, spec } = makeTwoPageApp(); // overview links to detail
  try {
    const overview = (padding) => `${GRIFFEL_IMPORT}const s = makeStyles({ root: { borderColor: 'red', padding: '${padding}' } });\nexport default function Overview(){ ${NAV('detail')} return null; }\n`;
    fs.writeFileSync(path.join(appDir, 'overview.tsx'), overview('4px'), 'utf8');
    const baselineSpec = recordApply(spec, appDir);
    const live = [{ pageId: OVERVIEW_ID, name: 'Overview' }, { pageId: DETAIL_ID, name: 'Detail' }];
    const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: OVERVIEW_ID }, { key: 'detail', name: 'Detail', pageId: DETAIL_ID }] }), 'utf8').toString('base64');
    const rebuild = (extra) => {
      const { sdk } = mockSdk({ pageManifest: manifest, liveSitemapXml: pageSitemap([OVERVIEW_ID, DETAIL_ID]), pageRows: live.map((p) => ({ uxagentprojectid: p.pageId, name: p.name })) });
      const genpageCli = mockGenpageCli(live);
      const warnings = [];
      return { genpageCli, warnings, run: () => runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES, baselineSpec, warn: (m) => { if (/Griffel/.test(m)) warnings.push(m); }, ...extra }) };
    };
    const same = rebuild();
    await same.run();
    const sent = same.genpageCli.uploads.find((u) => u.name === 'Overview');
    assert.ok(sent.content.includes(DETAIL_ID) && !sent.content.includes('PAGEREF_'), 'what is uploaded is the resolved copy, which is not the source whose hash was recorded');
    assert.strictEqual(same.warnings.length, 1);
    assert.match(same.warnings[0], /^page "Overview" is already deployed, and its source is the one the last build recorded for it/);
    assert.ok(same.warnings[0].includes('overview.tsx:2:'), 'the key is named where it is in the source');
    // An edit to the source is a change, resolved copy or not.
    fs.writeFileSync(path.join(appDir, 'overview.tsx'), overview('8px'), 'utf8');
    const edited = rebuild();
    await assert.rejects(edited.run(), (e) => e.code === 'pages-griffel-shorthand' && /^page "Overview" writes CSS/.test(e.message) && /Its source changed since the last build recorded for it/.test(e.message));
    assert.deepStrictEqual(edited.genpageCli.uploads, [], 'nothing was written');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('deploy: a page that is UPDATED with a changed source is held to the check even when the key was already there — nothing is written', async () => {
  const app = deployedApp(GRIFFEL_BAD);
  try {
    const baselineSpec = recordApply(app.spec, app.appDir);
    // The maker edits the page's text and keeps the shorthand: its hash no longer matches the last apply's, so this build would ship a CHANGED page that still drops the key.
    app.edit(GRIFFEL_BAD.replace("padding: '4px'", "padding: '8px'"));
    const r = app.rebuild({ baselineSpec });
    await assert.rejects(r.run(), (e) => {
      assert.strictEqual(e.phase, 'pages');
      assert.strictEqual(e.code, 'pages-griffel-shorthand');
      assert.strictEqual(e.recoverable, false);
      assert.ok(e.message.startsWith('page "Detail" writes CSS that Griffel drops at runtime, so the page would deploy without it — '), e.message);
      assert.ok(e.message.includes('detail.tsx:4:5: `borderWidth`') && e.message.includes('detail.tsx:7:24: `borderColor`'), 'each key, where it is');
      assert.ok(e.message.includes(BOTH_WAYS_OUT), 'both ways out');
      assert.ok(e.message.includes('Its source changed since the last build recorded for it, so it is held to the check as a new page is; left as it was, it would only be warned about. Fix them in the page\'s source'), 'and why this page is held to it');
      return true;
    });
    assert.deepStrictEqual(r.genpageCli.uploads, [], 'neither page was written');
    assert.deepStrictEqual(r.warnings, [], 'a halt says why it halted, not what it would have let through');
    // Adding a key to a page that was clean is the same: it changed, and now drops one.
    const clean = deployedApp(GRIFFEL_CLEAN);
    try {
      const recorded = recordApply(clean.spec, clean.appDir);
      clean.edit(GRIFFEL_BAD);
      const again = clean.rebuild({ baselineSpec: recorded });
      await assert.rejects(again.run(), (e) => e.code === 'pages-griffel-shorthand' && /Its source changed since the last build recorded for it/.test(e.message));
      assert.deepStrictEqual(again.genpageCli.uploads, []);
    } finally { clean.cleanup(); }
    // Control: the maker deletes the keys (no change on screen): the page is changed and clean, and goes up with no warning.
    app.edit(GRIFFEL_CLEAN);
    const fixed = app.rebuild({ baselineSpec });
    await fixed.run();
    assert.deepStrictEqual(fixed.genpageCli.uploads.map((u) => u.name).sort(), ['Detail', 'Overview']);
    assert.deepStrictEqual(fixed.warnings, []);
  } finally { app.cleanup(); }
});

// "No record" is the case the build cannot tell: a workspace that is new, moved or cleared, or an apply that predates the record. The page exists in the environment, so an earlier release
// deployed it as it is — the key silently dropped — and refusing it now would stop a rebuild that release completed. It fails open, with a warning that says so. A page that does NOT exist
// is created, and no record can change that: what would be deployed is new.
test('deploy: a page that exists but has no record in this workspace is warned about, not refused — and a page that does not exist yet is still held to the check', async () => {
  const app = deployedApp(GRIFFEL_BAD);
  try {
    const recorded = recordApply(app.spec, app.appDir);
    const unreadableThen = { ...recorded, pages: recorded.pages.map((p) => (p.key === 'detail' ? { ...p, __contentSha: null } : p)) };
    for (const [what, baselineSpec] of [
      ['no baseline at all (a new or cleared workspace, or another app or environment)', undefined],
      ['a baseline with no record of this page', { ...recorded, pages: recorded.pages.filter((p) => p.key !== 'detail') }],
      ['a record with no hash — the source could not be read then', unreadableThen],
    ]) {
      const r = app.rebuild({ baselineSpec });
      await r.run();
      assert.deepStrictEqual(r.genpageCli.uploads.map((u) => u.name).sort(), ['Detail', 'Overview'], `${what}: the rebuild completes`);
      assert.strictEqual(r.warnings.length, 1, what);
      assert.ok(r.warnings[0].startsWith('page "Detail" is already deployed, and this workspace holds no record of what the last build sent for it, so the build cannot tell whether this send changes it; it goes on, as builds did before this check. '), `${what}: ${r.warnings[0]}`);
      assert.ok(r.warnings[0].includes('detail.tsx:4:5: `borderWidth`') && r.warnings[0].includes(BOTH_WAYS_OUT), what);
      assert.ok(r.warnings[0].endsWith('once a build has recorded this page, a change to its source is held to the check, and the build stops on anything the check still reports.'), `${what}: what happens from then on`);
    }
  } finally { app.cleanup(); }
  // Not deployed: the page is created, and the record of an apply that once sent the same bytes does not matter — the earlier page was deleted.
  const fresh = makeTwoPageApp();
  try {
    fs.writeFileSync(path.join(fresh.appDir, 'detail.tsx'), GRIFFEL_BAD, 'utf8');
    const baselineSpec = recordApply(fresh.spec, fresh.appDir);
    const genpageCli = mockGenpageCli();
    await assert.rejects(
      runSdkBuild(fresh.spec, { sdk: mockSdk().sdk, apply: true, env: 'https://x', appDir: fresh.appDir, genpageCli, phases: PHASES, baselineSpec }),
      (e) => e.code === 'pages-griffel-shorthand' && /page "Detail" writes CSS/.test(e.message) && !/Its source changed/.test(e.message)
    );
    assert.deepStrictEqual(genpageCli.uploads, []);
  } finally { fs.rmSync(fresh.appDir, { recursive: true, force: true }); }
});

// A style object written elsewhere hides its keys from the check, so the page is held as one the check could not read — as an unreadable call is — and an unchanged page
// that is already deployed only warns.
test('deploy: a page whose style object is written elsewhere is held as one the check could not read; sent unchanged it only warns', async () => {
  const app = deployedApp(GRIFFEL_INDIRECT);
  try {
    const baselineSpec = recordApply(app.spec, app.appDir);
    const ok = app.rebuild({ baselineSpec });
    await ok.run();
    assert.strictEqual(ok.warnings.length, 1);
    assert.match(ok.warnings[0], /^page "Detail" is already deployed, and its source is the one the last build recorded for it, so this build sends it again as it is and goes on\. It has makeStyles calls the Griffel check could not read/);
    app.edit(`${GRIFFEL_INDIRECT}// edited\n`);
    const held = app.rebuild({ baselineSpec });
    await assert.rejects(held.run(), (e) => {
      assert.strictEqual(e.code, 'pages-griffel-shorthand');
      assert.match(e.message, /^page "Detail" has makeStyles calls the Griffel check could not read, so it cannot tell whether the page writes CSS that Griffel drops at runtime — detail\.tsx:3:\d+: this makeStyles call is given a style object written elsewhere/);
      return true;
    });
    assert.deepStrictEqual(held.genpageCli.uploads, []);
  } finally { app.cleanup(); }
});

// A call the checker cannot read is not a key Griffel drops, and a refusal that says so sends the author looking for CSS that is not there: nothing gets past it but rewriting the code, which
// the message has to say. A page that is already deployed and sent as it is only warns, as for a key.
test('deploy: a makeStyles call the checker cannot read is reported as that — not as CSS Griffel drops — with what to change; an unchanged page with one only warns', async () => {
  const app = deployedApp(GRIFFEL_UNREADABLE);
  try {
    const baselineSpec = recordApply(app.spec, app.appDir);
    const ok = app.rebuild({ baselineSpec });
    await ok.run();
    assert.strictEqual(ok.warnings.length, 1);
    assert.ok(ok.warnings[0].startsWith('page "Detail" is already deployed, and its source is the one the last build recorded for it, so this build sends it again as it is and goes on. It has makeStyles calls the Griffel check could not read, so it cannot tell whether the page writes CSS that Griffel drops at runtime: detail.tsx:3:19: the makeStyles call here cannot be checked for certain'), ok.warnings[0]);
    assert.doesNotMatch(ok.warnings[0], /Deleting a key/, 'there is no key to delete or rewrite');
    // Changed, or new: held, and told what to change.
    app.edit(`${GRIFFEL_UNREADABLE}// edited\n`);
    const held = app.rebuild({ baselineSpec });
    await assert.rejects(held.run(), (e) => {
      assert.strictEqual(e.code, 'pages-griffel-shorthand');
      assert.ok(e.message.startsWith('page "Detail" has makeStyles calls the Griffel check could not read, so it cannot tell whether the page writes CSS that Griffel drops at runtime — detail.tsx:3:19: the makeStyles call here cannot be checked for certain'), e.message);
      assert.doesNotMatch(e.message, /writes CSS that Griffel drops at runtime, so the page would deploy without it/, 'it is not said to write any');
      assert.match(e.message, /put an operand in parentheses, \(\{ … \}\) \/ 2 or \(\/re\/\)\.test\(text\), or end the statement with a ";" — or move the makeStyles call above it\./);
      assert.match(e.message, /Its source changed since the last build recorded for it, so it is held to the check as a new page is; left as it was, it would only be warned about\. Change the page's source as that says \(`node scripts\/check-griffel-styles\.js --file <page\.tsx>` shows what it cannot read\), then re-run\.$/);
      return true;
    });
    assert.deepStrictEqual(held.genpageCli.uploads, []);
  } finally { app.cleanup(); }
  const fresh = makeTwoPageApp();
  try {
    fs.writeFileSync(path.join(fresh.appDir, 'detail.tsx'), GRIFFEL_UNREADABLE, 'utf8');
    await assert.rejects(
      runSdkBuild(fresh.spec, { sdk: mockSdk().sdk, apply: true, env: 'https://x', appDir: fresh.appDir, genpageCli: mockGenpageCli(), phases: PHASES }),
      (e) => e.code === 'pages-griffel-shorthand' && /^page "Detail" has makeStyles calls the Griffel check could not read/.test(e.message) && /then re-run\.$/.test(e.message)
    );
  } finally { fs.rmSync(fresh.appDir, { recursive: true, force: true }); }
});

// The page write that cannot say what it did is the one the build must never send again. An UPDATE whose answer is lost, and whose read then shows the page changed by someone else, MAY HAVE
// LANDED: the backend refuses it with the build's advice — the build keeps no base marker, so it points at its own re-run, which reads every page first — and the error says it must not be
// retried, so the build's own retry of a halt it takes for transient does not send it again. The next build converges with one page per name. Driven through the REAL backend over the SDK stand-in.
function liveTwoPages(sdk) {
  sdk.seedPage({ id: OVERVIEW_ID, name: 'Overview', source: 'export default function Overview(){ return null; }', conversation: [{ sender: 'user', message: 'first' }, { sender: 'agent', message: 'ok' }] });
  sdk.seedPage({ id: DETAIL_ID, name: 'Detail', source: 'export default function Detail(){ return null; }', conversation: [{ sender: 'user', message: 'first' }, { sender: 'agent', message: 'ok' }] });
  return sdk;
}
const reset = () => connectionError(0, 'Request failed: read ECONNRESET');

test('deploy: an UPDATE whose outcome is not known stops the build with the build\'s advice, sends nothing again, and the next build converges with one page per name', async () => {
  const { isTransientHalt } = require('../build-model-app.js');
  const { appDir, spec } = makeTwoPageApp(); // overview links to detail
  try {
    const live = [{ pageId: OVERVIEW_ID, name: 'Overview' }, { pageId: DETAIL_ID, name: 'Detail' }];
    const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: OVERVIEW_ID }, { key: 'detail', name: 'Detail', pageId: DETAIL_ID }] }), 'utf8').toString('base64');
    // The answer to the first page's write is lost, and by the time it is read the page holds neither what was sent nor what it held.
    const fake = liveTwoPages(new FakeSdk())
      .script('push', { lose: reset() })
      .script('fetch', undefined, (s, type, id) => { s.pages.get(id).source = 'saved by someone else in the meantime'; });
    const genpage = makeGenpageSdk('https://x', { sdk: fake });
    const make = () => mockSdk({ pageManifest: manifest, liveSitemapXml: pageSitemap([OVERVIEW_ID, DETAIL_ID]), pageRows: live.map((p) => ({ uxagentprojectid: p.pageId, name: p.name })) }).sdk;
    await assert.rejects(runSdkBuild(spec, { sdk: make(), apply: true, env: 'https://x', appDir, genpage, phases: PHASES }), (e) => {
      assert.strictEqual(e.phase, 'pages');
      assert.match(e.message, new RegExp(`the update of generative page "Overview" \\(${OVERVIEW_ID}\\) MAY HAVE LANDED or been overtaken`));
      assert.match(e.message, /a second send would overwrite whatever was saved since/);
      assert.match(e.message, /Run the build again: it reads the page first, so an update that did land is not sent again and records nothing twice/);
      assert.doesNotMatch(e.message, /genpage-base\.js|re-run the upload/, 'no advice the build cannot follow: it keeps no base marker');
      assert.strictEqual(isTransientHalt(e), false, 'the build does not retry it by itself');
      return true;
    });
    assert.strictEqual(fake.count('pushArtifact'), 1, 'one send: the update whose answer was lost is not sent again, and the next page was never started');
    assert.strictEqual(fake.count('createArtifact'), 0);
    // The next normal build: the same pages, the same ids — one page per name, nothing created.
    fake.pages.get(OVERVIEW_ID).source = 'export default function Overview(){ return null; }';
    await runSdkBuild(spec, { sdk: make(), apply: true, env: 'https://x', appDir, genpage, phases: PHASES });
    assert.strictEqual(fake.count('createArtifact'), 0, 'updates, and no create');
    assert.deepStrictEqual([...fake.pages.keys()].sort(), [OVERVIEW_ID, DETAIL_ID].sort(), 'one page per name');
    assert.ok(fake.pages.get(OVERVIEW_ID).source.includes(DETAIL_ID), 'the navigation page now holds its resolved copy');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

// A page that was WRITTEN but whose publish failed is on the server, so the next build reuses it and publishes the copy it already holds — it does not write it again, nor create another.
test('deploy: an UPDATE whose publish fails stops the build naming the page, and the next build publishes what the page holds without writing it again', async () => {
  const { appDir, spec } = makeTwoPageApp();
  try {
    const live = [{ pageId: OVERVIEW_ID, name: 'Overview' }, { pageId: DETAIL_ID, name: 'Detail' }];
    const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: OVERVIEW_ID }, { key: 'detail', name: 'Detail', pageId: DETAIL_ID }] }), 'utf8').toString('base64');
    const fake = liveTwoPages(new FakeSdk()).script('publish', new Error('PublishXml answered 500: the service is busy'));
    const genpage = makeGenpageSdk('https://x', { sdk: fake });
    const make = () => mockSdk({ pageManifest: manifest, liveSitemapXml: pageSitemap([OVERVIEW_ID, DETAIL_ID]), pageRows: live.map((p) => ({ uxagentprojectid: p.pageId, name: p.name })) }).sdk;
    await assert.rejects(runSdkBuild(spec, { sdk: make(), apply: true, env: 'https://x', appDir, genpage, phases: PHASES }), (e) => {
      assert.strictEqual(e.phase, 'pages');
      assert.strictEqual(e.code, 'pages-publish-failed');
      assert.match(e.message, new RegExp(`page "Overview" was updated as ${OVERVIEW_ID} and saved, but publishing it failed \\(PublishXml answered 500: the service is busy\\)`));
      assert.match(e.message, /the runtime still serves the previously published copy\. Re-run the build once the cause is cleared: the page is reused, not created again/);
      return true;
    });
    assert.strictEqual(fake.count('pushArtifact'), 1, 'the write landed once; the next page was never started');
    const written = fake.pages.get(OVERVIEW_ID).source;
    assert.ok(written.includes(DETAIL_ID), 'the page was written, with its resolved navigation');
    // The next normal build: the page holds its content, so it is published — not written again — and the other page goes up. One page per name, nothing created.
    await runSdkBuild(spec, { sdk: make(), apply: true, env: 'https://x', appDir, genpage, phases: PHASES });
    assert.strictEqual(fake.count('pushArtifact'), 1, 'nothing is written again: the page that was written is only published, and the other already holds its source');
    assert.strictEqual(fake.count('createArtifact'), 0, 'no create');
    assert.strictEqual(fake.pages.get(OVERVIEW_ID).source, written, 'the page that was already written is as it was');
    assert.ok(fake.of('publishArtifact').filter((c) => c.args[1] === OVERVIEW_ID).length >= 2, 'and is published again');
    assert.ok(fake.of('publishArtifact').some((c) => c.args[1] === DETAIL_ID), 'and the page the first build never reached is published too');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

// An UPDATE answers with the id it was asked to write. A different one would leave the navigation that links to the page pointing at a page that is not the one written, so the build stops
// there instead of finalizing on an inconsistent target.
test('deploy: an UPDATE that answers with a different page id halts the build — nothing is finalized on an inconsistent target', async () => {
  const { appDir, spec } = makeTwoPageApp();
  try {
    const live = [{ pageId: OVERVIEW_ID, name: 'Overview' }, { pageId: DETAIL_ID, name: 'Detail' }];
    const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: OVERVIEW_ID }, { key: 'detail', name: 'Detail', pageId: DETAIL_ID }] }), 'utf8').toString('base64');
    const OTHER_ID = '99999999-9999-4999-8999-999999999999';
    const genpageCli = mockGenpageCli(live);
    const update = genpageCli.update;
    genpageCli.update = async (id, o) => { const up = await update(id, o); return o.name === 'Detail' ? { ...up, pageId: OTHER_ID } : up; };
    const { sdk } = mockSdk({ pageManifest: manifest, liveSitemapXml: pageSitemap([OVERVIEW_ID, DETAIL_ID]), pageRows: live.map((p) => ({ uxagentprojectid: p.pageId, name: p.name })) });
    await assert.rejects(
      runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES }),
      (e) => {
        assert.strictEqual(e.phase, 'pages');
        assert.strictEqual(e.code, 'pages-update-identity-mismatch');
        assert.match(e.message, new RegExp(`page "Detail" UPDATE returned a different id \\(${OTHER_ID} != ${DETAIL_ID}\\)`));
        return true;
      }
    );
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

// The backend the pages phase makes for itself holds a throwaway workspace with every page's source in it, so it is removed when the phase ends — by finishing or by halting. A backend the
// caller lends is the caller's to dispose, and the build makes no other.
test('deploy: the backend the pages phase makes for itself is disposed when the phase ends, finishing or halting — and a lent one is left to its owner', async () => {
  const { loadCli } = require('./helpers/cli-harness.js');
  const made = [];
  const genpageModule = {
    ...require('../lib/genpage-sdk.js'),
    makeGenpageSdk: (url) => {
      assert.strictEqual(url, 'https://x');
      const backend = { ...mockGenpageCli(), disposed: 0, dispose() { this.disposed += 1; } };
      made.push(backend);
      return backend;
    },
  };
  const engine = loadCli(path.join(__dirname, '..', 'lib', 'sdk-build.js'), { requires: { './genpage-sdk.js': genpageModule } }).exports;
  for (const [what, options] of [['finishes', {}], ['halts', { malformed: true }]]) {
    const { appDir, spec } = makeTwoPageApp(options);
    try {
      const run = engine.runSdkBuild(spec, { sdk: mockSdk().sdk, apply: true, env: 'https://x', appDir, phases: PHASES });
      if (what === 'halts') await assert.rejects(run, (e) => e.code === 'pages-malformed-navref'); else await run;
    } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
    assert.strictEqual(made.length, what === 'finishes' ? 1 : 2, `${what}: one backend is made for the run`);
    assert.strictEqual(made[made.length - 1].disposed, 1, `${what}: and disposed exactly once`);
  }
  const lent = { ...mockGenpageCli(), disposed: 0, dispose() { this.disposed += 1; } };
  const { appDir, spec } = makeTwoPageApp();
  try {
    await engine.runSdkBuild(spec, { sdk: mockSdk().sdk, apply: true, env: 'https://x', appDir, genpage: lent, phases: PHASES });
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
  assert.strictEqual(made.length, 2, 'no backend of its own was made for a run that was lent one');
  assert.strictEqual(lent.disposed, 0, 'and the lent one is not disposed by the build');
});

// dispose() answers `{ left }`: the folders it could not remove, each still holding the page sources. The build dropped the answer and ended as a success with them in the temp directory.
test('deploy: a workspace the build\'s own page backend could not remove is a warning of the build — finishing or halting — and nothing is said when none is left', async () => {
  const { loadCli } = require('./helpers/cli-harness.js');
  const left = ['C:\\temp\\genpage-x1y2z3'];
  const words = `the page workspace could not be removed, so page source may be left on disk: ${left[0]} — delete the folder by hand`;
  let leftOver = left;
  const genpageModule = {
    ...require('../lib/genpage-sdk.js'),
    makeGenpageSdk: () => ({ ...mockGenpageCli(), dispose: async () => ({ left: leftOver }) }),
  };
  const engine = loadCli(path.join(__dirname, '..', 'lib', 'sdk-build.js'), { requires: { './genpage-sdk.js': genpageModule } }).exports;
  for (const [what, options] of [['finishes', {}], ['halts', { malformed: true }]]) {
    const { appDir, spec } = makeTwoPageApp(options);
    const warnings = [];
    try {
      const run = engine.runSdkBuild(spec, { sdk: mockSdk().sdk, apply: true, env: 'https://x', appDir, phases: PHASES, warn: (m) => warnings.push(m) });
      if (what === 'halts') await assert.rejects(run, (e) => e.code === 'pages-malformed-navref'); else await run;
    } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
    assert.ok(warnings.includes(words), `${what}: the build says which folder is left — ${JSON.stringify(warnings)}`);
  }
  leftOver = [];
  const { appDir, spec } = makeTwoPageApp();
  const warnings = [];
  try {
    await engine.runSdkBuild(spec, { sdk: mockSdk().sdk, apply: true, env: 'https://x', appDir, phases: PHASES, warn: (m) => warnings.push(m) });
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
  assert.ok(!warnings.some((m) => /page workspace could not be removed/.test(m)), 'nothing left, nothing said');
});

test('deploy: a page with the same names only in a comment, a string or an inline style is not refused, and a spec of clean pages builds as it did', async () => {
  const { appDir, spec } = makeTwoPageApp();
  try {
    fs.writeFileSync(path.join(appDir, 'detail.tsx'), GRIFFEL_CLEAN, 'utf8');
    const genpageCli = mockGenpageCli();
    await runSdkBuild(spec, { sdk: mockSdk().sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES });
    assert.deepStrictEqual(genpageCli.uploads.map((u) => u.name).sort(), ['Detail', 'Overview']);
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('changed-only: the Griffel check is held against the pages the run uploads, not against a page it leaves alone — and a selected page is judged like any other', async () => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-griffel-'));
  try {
    fs.writeFileSync(path.join(appDir, 'overview.tsx'), 'export default function O(){ return null; }', 'utf8');
    fs.writeFileSync(path.join(appDir, 'detail.tsx'), GRIFFEL_CLEAN, 'utf8');
    const spec = {
      schemaVersion: 2,
      solution: { uniqueName: 'SelGriffel', displayName: 'S', publisherPrefix: 'contoso' },
      app: { name: 'Sel Griffel App' },
      entities: [{ schemaName: 'contoso_item', displayName: 'Item', primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' }, columns: [] }],
      pages: [
        { key: 'overview', name: 'Overview', source: { kind: 'tsx', codeFile: 'overview.tsx' } },
        { key: 'detail', name: 'Detail', source: { kind: 'tsx', codeFile: 'detail.tsx' } },
      ],
      appShell: { areas: [{ label: 'Main', groups: [{ label: 'G', subAreas: [{ page: 'overview', title: 'Overview' }, { page: 'detail', title: 'Detail' }] }] }] },
    };
    // The last apply sent `detail` clean; since then its source was edited, and now drops keys. (The record is made before the edit.)
    const cleanBaseline = recordApply(spec, appDir);
    fs.writeFileSync(path.join(appDir, 'detail.tsx'), GRIFFEL_BAD, 'utf8');
    const live = [{ pageId: OVERVIEW_ID, name: 'Overview' }, { pageId: DETAIL_ID, name: 'Detail' }];
    const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: OVERVIEW_ID }, { key: 'detail', name: 'Detail', pageId: DETAIL_ID }] }), 'utf8').toString('base64');
    const make = () => mockSdk({ pageManifest: manifest, liveSitemapXml: pageSitemap([OVERVIEW_ID, DETAIL_ID]), pageRows: live.map((p) => ({ uxagentprojectid: p.pageId, name: p.name })) }).sdk;
    const changedOnly = (selectedKeys) => ({ fastApply: true, resolvedAppId: APP_ID, skipSitemapFinalize: true, selectedKeys });
    // The selected page is clean: the run goes ahead, and the page it did not select — which would be refused if it were uploaded — is left alone.
    const genpageCli = mockGenpageCli(live);
    const r = await runSdkBuild(spec, { sdk: make(), apply: true, env: 'https://x', appDir, genpageCli, phases: PAGES_ONLY, changedOnly: changedOnly(['overview']), baselineSpec: cleanBaseline });
    assert.ok(r.ok);
    assert.deepStrictEqual(genpageCli.uploads.map((u) => u.name), ['Overview']);
    // Selecting the page that changed to drop a key is refused, before anything is uploaded.
    const refused = mockGenpageCli(live);
    await assert.rejects(
      runSdkBuild(spec, { sdk: make(), apply: true, env: 'https://x', appDir, genpageCli: refused, phases: PAGES_ONLY, changedOnly: changedOnly(['overview', 'detail']), baselineSpec: cleanBaseline }),
      (e) => e && e.code === 'pages-griffel-shorthand' && /page "Detail"/.test(e.message)
    );
    assert.deepStrictEqual(refused.uploads, []);
    // No selection at all is a full build: every page is uploaded, so every page is checked.
    const full = mockGenpageCli(live);
    await assert.rejects(
      runSdkBuild(spec, { sdk: make(), apply: true, env: 'https://x', appDir, genpageCli: full, phases: PAGES_ONLY, changedOnly: { resolvedAppId: APP_ID, skipSitemapFinalize: true }, baselineSpec: cleanBaseline }),
      (e) => e && e.code === 'pages-griffel-shorthand'
    );
    // A selected page whose source is the one recorded — the record was made with the keys in it — is sent as it is and warned about: the decision is the build's, whoever selected the page.
    const badBaseline = recordApply(spec, appDir);
    const sameAsRecorded = mockGenpageCli(live);
    const warnings = [];
    await runSdkBuild(spec, { sdk: make(), apply: true, env: 'https://x', appDir, genpageCli: sameAsRecorded, phases: PAGES_ONLY, changedOnly: changedOnly(['detail']), baselineSpec: badBaseline, warn: (m) => warnings.push(m) });
    assert.deepStrictEqual(sameAsRecorded.uploads.map((u) => u.name), ['Detail']);
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /^page "Detail" is already deployed, and its source is the one the last build recorded for it/);
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

// ── What the build records as the source it sent ────────────────────────────────────────────────────────────────────────────────────────────
// The baseline is written when the build ENDS, and it is what the next build's Griffel check judges a page against: "the source the last apply sent". The pages phase measures the source it
// read and checked for each page it sends (`created.pageSourceShas`), and that is what is recorded — not the file as it is when the baseline is written, which a maker can have saved over
// while the build ran. Such a page then reads as changed next time, and is held to the check, instead of as "unchanged", with a key nothing ever checked let through on a warning.
test('deploy: the pages phase records the hash of the source it read for each page it sends — a navigation page by its own source, not by the resolved copy it uploads', async () => {
  const { appDir, spec } = makeTwoPageApp(); // overview links to detail
  try {
    const genpageCli = mockGenpageCli();
    const r = await runSdkBuild(spec, { sdk: mockSdk().sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES });
    const source = (file) => sha256(fs.readFileSync(path.join(appDir, file)));
    // The result's page maps are null-prototype objects (lib/own-keys.js: a page's key can be `constructor`), so their entries are compared.
    assert.deepStrictEqual({ ...r.created.pageSourceShas }, { overview: source('overview.tsx'), detail: source('detail.tsx') });
    assert.notStrictEqual(r.created.pageDeployedShas.overview, r.created.pageSourceShas.overview, 'the copy that is uploaded has the target\'s id where the source has PAGEREF_: it is another hash');
    // Only a page that is sent is recorded: a changed-only run that selects one page records that page.
    const selected = await runSdkBuild(spec, { sdk: mockSdk({ pageManifest: Buffer.from(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: OVERVIEW_ID }, { key: 'detail', name: 'Detail', pageId: DETAIL_ID }] }), 'utf8').toString('base64'), liveSitemapXml: pageSitemap([OVERVIEW_ID, DETAIL_ID]), pageRows: [{ uxagentprojectid: OVERVIEW_ID, name: 'Overview' }, { uxagentprojectid: DETAIL_ID, name: 'Detail' }] }).sdk,
      apply: true, env: 'https://x', appDir, genpageCli: mockGenpageCli([{ pageId: OVERVIEW_ID, name: 'Overview' }, { pageId: DETAIL_ID, name: 'Detail' }]), phases: PAGES_ONLY,
      changedOnly: { fastApply: true, resolvedAppId: APP_ID, skipSitemapFinalize: true, selectedKeys: ['detail'] } });
    assert.deepStrictEqual({ ...selected.created.pageSourceShas }, { detail: source('detail.tsx') });
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('deploy: a page saved while a build runs is not recorded as applied — the next build holds it to the check, instead of finding it "unchanged" and letting its new key through on a warning', async () => {
  const { persistAppliedBaseline } = require('../build-model-app.js');
  const app = deployedApp(GRIFFEL_CLEAN);
  try {
    const workspace = path.join(app.appDir, '.maker-workspace');
    const identity = { environment: BASELINE_ENV, appUniqueName: appUniqueName(app.spec) };
    const earlier = recordApply(app.spec, app.appDir); // an earlier apply sent the clean page
    // Build 1: the pre-write scan has read both pages when, during the upload, the maker saves a `borderColor` into detail.tsx.
    const first = app.rebuild({ baselineSpec: earlier });
    const update = first.genpageCli.update;
    first.genpageCli.update = async (id, o) => { const up = await update(id, o); if (o.name === 'Detail') app.edit(GRIFFEL_BAD); return up; };
    const result = await first.run();
    assert.strictEqual(first.genpageCli.uploads.find((u) => u.name === 'Detail').content, GRIFFEL_CLEAN, 'build 1 sent the clean page, and succeeded');
    assert.ok(persistAppliedBaseline(result, { spec: app.spec, opts: { apply: true, baselineSpec: earlier }, workspaceDir: workspace, appDirAbs: app.appDir, baselineIdentity: identity }), 'its baseline is written, as main() does');
    // Build 2 meets the saved page. It is not what build 1 sent, so it is changed, and its key is refused.
    const recorded = readBaseline(workspace, identity);
    const second = app.rebuild({ baselineSpec: recorded });
    await assert.rejects(second.run(), (e) => e.code === 'pages-griffel-shorthand' && /^page "Detail" writes CSS/.test(e.message) && /Its source changed since the last build recorded for it/.test(e.message));
    assert.deepStrictEqual(second.genpageCli.uploads, [], 'nothing was written');
    assert.deepStrictEqual(second.warnings, []);
  } finally { app.cleanup(); }
});

test('deploy: a page that no edit touched is recorded as sent, so the build after it still only warns about the key it already has', async () => {
  const { persistAppliedBaseline } = require('../build-model-app.js');
  const app = deployedApp(GRIFFEL_BAD);
  try {
    const workspace = path.join(app.appDir, '.maker-workspace');
    const identity = { environment: BASELINE_ENV, appUniqueName: appUniqueName(app.spec) };
    const earlier = recordApply(app.spec, app.appDir);
    const first = app.rebuild({ baselineSpec: earlier });
    const result = await first.run();
    assert.ok(persistAppliedBaseline(result, { spec: app.spec, opts: { apply: true, baselineSpec: earlier }, workspaceDir: workspace, appDirAbs: app.appDir, baselineIdentity: identity }));
    const second = app.rebuild({ baselineSpec: readBaseline(workspace, identity) });
    await second.run();
    assert.strictEqual(second.genpageCli.uploads.length, 2, 'both pages are sent again');
    assert.strictEqual(second.warnings.length, 1);
    assert.match(second.warnings[0], /^page "Detail" is already deployed, and its source is the one the last build recorded for it/);
  } finally { app.cleanup(); }
});

test('changed-only: a page the run did not select keeps the record it had, whatever its file says by the time the baseline is written', async () => {
  const { persistAppliedBaseline } = require('../build-model-app.js');
  const app = deployedApp(GRIFFEL_CLEAN);
  try {
    const workspace = path.join(app.appDir, '.maker-workspace');
    const identity = { environment: BASELINE_ENV, appUniqueName: appUniqueName(app.spec) };
    const earlier = recordApply(app.spec, app.appDir); // detail was sent clean
    // A fast apply that selects only overview; detail is saved with a key while it runs, and is never sent.
    const live = [{ pageId: OVERVIEW_ID, name: 'Overview' }, { pageId: DETAIL_ID, name: 'Detail' }];
    const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: OVERVIEW_ID }, { key: 'detail', name: 'Detail', pageId: DETAIL_ID }] }), 'utf8').toString('base64');
    const sdk = mockSdk({ pageManifest: manifest, liveSitemapXml: pageSitemap([OVERVIEW_ID, DETAIL_ID]), pageRows: live.map((p) => ({ uxagentprojectid: p.pageId, name: p.name })) }).sdk;
    const cli = mockGenpageCli(live);
    const update = cli.update;
    cli.update = async (id, o) => { const up = await update(id, o); app.edit(GRIFFEL_BAD); return up; };
    const result = await runSdkBuild(app.spec, { sdk, apply: true, env: 'https://x', appDir: app.appDir, genpageCli: cli, phases: PAGES_ONLY, baselineSpec: earlier,
      changedOnly: { fastApply: true, resolvedAppId: APP_ID, skipSitemapFinalize: true, selectedKeys: ['overview'] } });
    assert.deepStrictEqual(cli.uploads.map((u) => u.name), ['Overview']);
    assert.ok(persistAppliedBaseline({ ...result, changedOnly: { decision: 'fast' } }, { spec: app.spec, opts: { apply: true, phases: PAGES_ONLY, baselineSpec: earlier }, workspaceDir: workspace, appDirAbs: app.appDir, baselineIdentity: identity }));
    const recorded = readBaseline(workspace, identity);
    assert.strictEqual(recorded.pages.find((p) => p.key === 'detail').__contentSha, earlier.pages.find((p) => p.key === 'detail').__contentSha, 'detail: the record it had, not the hash of a file nothing sent');
    // So the next build — a full one — finds detail changed, and holds it.
    await assert.rejects(app.rebuild({ baselineSpec: recorded }).run(), (e) => e.code === 'pages-griffel-shorthand' && /^page "Detail" writes CSS/.test(e.message));
  } finally { app.cleanup(); }
});

// A halting build says only why it halted: the pages it would have let through are warned about once the whole scan has passed. The warning for a page that comes first must not be said
// when a later page stops the build — a message about a page the build then never sent would read as if it had.
test('deploy: a build that halts on a later page says nothing about an earlier page it would have let through', async () => {
  const app = deployedApp(GRIFFEL_CLEAN);
  try {
    const earlier = recordApply(app.spec, app.appDir);
    // overview carries a key with no record of what was last sent for it (a warning); detail changed and carries one (a halt) — detail comes second in the scan.
    fs.writeFileSync(path.join(app.appDir, 'overview.tsx'), `${GRIFFEL_IMPORT}const s = makeStyles({ root: { borderColor: 'red' } });\nexport default function Overview(){ return null; }\n`, 'utf8');
    const baselineSpec = { ...earlier, pages: earlier.pages.map((p) => (p.key === 'overview' ? { ...p, __contentSha: null } : p)) };
    app.edit(GRIFFEL_BAD);
    const held = app.rebuild({ baselineSpec });
    await assert.rejects(held.run(), (e) => e.code === 'pages-griffel-shorthand' && /^page "Detail" writes CSS/.test(e.message));
    assert.deepStrictEqual(held.warnings, [], 'the page that would have been warned about is not mentioned');
    assert.deepStrictEqual(held.genpageCli.uploads, []);
    // Control: with detail clean, the same overview is warned about, once, and the build goes on — so the silence above is about the halt.
    app.edit(GRIFFEL_CLEAN);
    const goes = app.rebuild({ baselineSpec });
    await goes.run();
    assert.strictEqual(goes.warnings.length, 1);
    assert.match(goes.warnings[0], /^page "Overview" is already deployed, and this workspace holds no record/);
  } finally { app.cleanup(); }
});

test('deploy: a page with a present-but-blank prompt HALTS before any upload', async () => {
  const { appDir, spec } = makeTwoPageApp();
  try {
    spec.pages[0].prompt = '';
    const { sdk } = mockSdk();
    const genpageCli = mockGenpageCli();
    await assert.rejects(
      runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES }),
      (e) => e && e.phase === 'pages' && e.code === 'pages-blank-provenance'
    );
    assert.strictEqual(genpageCli.uploads.length, 0);
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

// The control: an ABSENT key is not a claim, so the wrapper's default still applies and the build
// proceeds. Without this, the guard above could be satisfied by refusing every page.
test('deploy: pages that omit prompt/agentMessage entirely still deploy', async () => {
  const { appDir, spec } = makeTwoPageApp();
  try {
    for (const p of spec.pages) { delete p.prompt; delete p.agentMessage; }
    const { sdk } = mockSdk();
    const genpageCli = mockGenpageCli();
    await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES });
    assert.ok(genpageCli.uploads.length > 0, 'an omitted key is not an authoring mistake');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('lexical navigation variants survive deploy-download-rebuild', async () => {
  const { runDownload } = require('../download-model-app.js');
  const { appDir, spec } = makeTwoPageApp();
  const overviewId = 'aaaaaaaa-0000-4000-8000-000000000001';
  const detailId = 'bbbbbbbb-0000-4000-8000-000000000002';
  const live = [{ pageId: overviewId, name: 'Overview' }, { pageId: detailId, name: 'Detail' }];
  // Build the expected bytes independently; decoy IDs and PAGEREFs outside navigation must stay put. An identifier written with a Unicode
  // escape in CODE is a trust frontier (a call spelled `navigate\u0054o` is refused, see pageref-resolver), so the callees are spelled plainly;
  // escapes inside a quoted KEY are inside a string, and stay certain.
  const source = (target) => [
    'export default function Overview() {',
    `  const decoy = "${detailId}";`,
    '  // const token = "a link placeholder";',
    '  const separators = "left\u2028middle\u2029right";',
    `  // navigateTo({pageType:"generative",pageId:"${detailId}"})\u2028  Xrm.Navigation.navigateTo?.({pageType:"generative",/* keep pageId */pageId:"${target}",data:{}});`,
    `  // another inert pageId\u2029  Xrm.Navigation.navigateTo?.({pageType:"generative",pageId:"${target}"});`,
    String.raw`  Xrm?.Navigation?.navigateTo({"page\u0054ype":"generative","page\u{49}d":"` + target + '"});',
    `  Xrm.Navigation.navigateTo({pageType:"generative",pageId:"${target}",// pageId stays\u2029data:{}});`,
    String.raw`  Xrm.Navigation.navigateTo?.({"pageType":"generative",'page\x49d':"` + target + '"});',
    `  Xrm.Navigation.navigateTo?.({pageType(){return "entityrecord";},pageType:"generative",get pageId(){return "runtime";},pageId:"${target}"});`,
    '  return null;',
    '}',
    '',
  ].join('\r\n');
  const canonical = source('PAGEREF_detail');
  const resolved = source(detailId);
  try {
    fs.writeFileSync(path.join(appDir, 'overview.tsx'), canonical, 'utf8');
    spec.pages[0].pageId = overviewId;
    spec.pages[1].pageId = detailId;
    const xml = `<SiteMap><Area><Group><SubArea GenPageId="${overviewId}" Title="Overview"/><SubArea GenPageId="${detailId}" Title="Detail"/><SubArea Entity="contoso_item"/></Group></Area></SiteMap>`;
    const { sdk, calls } = mockSdk({ liveSitemapXml: xml });
    const genpageCli = mockGenpageCli(live);
    await runSdkBuild(spec, { sdk, apply: true, env: 'https://contoso.crm.dynamics.com', appDir, genpageCli, phases: PHASES });
    assert.strictEqual(genpageCli.uploads.length, 2);
    assert.strictEqual(genpageCli.uploads.find((u) => u.requestedId === overviewId).content, resolved);
    assert.strictEqual(fs.readFileSync(path.join(appDir, 'overview.tsx'), 'utf8'), canonical);
    const writes = calls.filter((c) => (c.name === 'createWebResource' && /_pagemanifest$/.test(c.args[0].name)) || c.name === 'updateWebResource');
    const last = writes[writes.length - 1];
    const manifest = last.name === 'updateWebResource' ? last.args[1].content : last.args[0].content;
    const manifestB64 = Buffer.from(manifest, 'utf8').toString('base64');
    const downloadDir = path.join(appDir, 'download');
    fs.mkdirSync(downloadDir);
    const downloadSdk = {
      fetchArtifact: async () => ({
        name: spec.app.name, description: '',
        siteMap: { areas: [{ title: 'Main', groups: [{ title: 'Pages', subAreas: [
          ...live.map((p) => ({ type: 'GenPage', genPageId: p.pageId, title: p.name })),
          { type: 'Entity', entity: 'contoso_item' },
        ] }] }] },
      }),
      queryRecords: async (logical) => {
        if (logical === 'appmodule') return [{ appmoduleid: APP_ID, appmoduleidunique: SELF_UNIQUE_VALUE, uniquename: 'contoso_deployapp' }];
        if (logical === 'appmodulecomponent') return [{ objectid: SELF_SITEMAP_ID, componenttype: 62 }];
        if (logical === 'sitemap') return [{ sitemapxml: xml }];
        if (logical === 'webresource') return [{ content: manifestB64 }];
        return [];
      },
      fetchEntityMetadata: async (logical) => ({ schemaName: logical, displayName: 'Item', primaryNameAttribute: 'contoso_name', attributes: [], relationships: [] }),
      dataverse: { get: async () => ({ status: 200, body: { value: [] } }) },
    };
    // What the environment now holds is what the build last wrote: a download reads each page back from it.
    genpageCli.read = async (id) => ({ id, name: live.find((p) => p.pageId === id).name, source: genpageCli.uploads.find((u) => u.requestedId === id).content, dataSources: [], conversation: [] });
    const downloaded = await runDownload({
      sdk: currentReadSdk(downloadSdk, { appId: APP_ID, layerId: SELF_UNIQUE_VALUE, sitemapXml: xml }),
      genpage: genpageCli, outDir: downloadDir, appId: APP_ID, appUnique: 'contoso_deployapp',
    });
    assert.ok(downloaded.ok, JSON.stringify(downloaded));
    const overview = downloaded.spec.pages.find((p) => p.key === 'overview');
    assert.deepStrictEqual(overview.navigatesTo, [{ targetKey: 'detail' }]);
    assert.strictEqual(fs.readFileSync(path.join(downloadDir, overview.source.codeFile), 'utf8'), canonical, 'download reverses only effective navigation target spans');
    const rebuiltCli = mockGenpageCli(live);
    const { sdk: rebuiltSdk } = mockSdk({ liveSitemapXml: xml, pageManifest: manifestB64 });
    await runSdkBuild(downloaded.spec, { sdk: rebuiltSdk, apply: true, env: 'https://contoso.crm.dynamics.com', appDir: downloadDir, genpageCli: rebuiltCli, phases: ['app-shell', 'pages'] });
    assert.strictEqual(rebuiltCli.uploads.length, 2);
    assert.ok(rebuiltCli.uploads.every((u) => u.requestedId), 'the rebuild performs only updates');
    assert.strictEqual(rebuiltCli.uploads.find((u) => u.requestedId === overviewId).content, resolved);
    assert.strictEqual(fs.readFileSync(path.join(downloadDir, overview.source.codeFile), 'utf8'), canonical);
    for (const dir of [appDir, downloadDir]) {
      assert.ok(!fs.existsSync(path.join(dir, '.maker-workspace', '.pageref-deploy')), 'the resolved copy is held in memory: no staging folder is made');
    }
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('lexical navigation overrides halt before any upload', async () => {
  for (const override of [
    'pageId(){return "runtime";}',
    'get pageId(){return "runtime";}',
    'set pageId(value){}',
    'pageId',
    '["page" + "Id"]:"runtime"',
    '...{pageId:"runtime"}',
  ]) {
    const { appDir, spec } = makeTwoPageApp();
    try {
      spec.pages[0].navigatesTo = [];
      fs.writeFileSync(path.join(appDir, 'overview.tsx'),
        `export default function Overview(){ const pageId = "runtime"; Xrm.Navigation.navigateTo?.({pageType:"generative",/* pageId */pageId:"PAGEREF_detail",${override}}); return null; }`, 'utf8');
      const { sdk } = mockSdk();
      const genpageCli = mockGenpageCli();
      await assert.rejects(
        runSdkBuild(spec, { sdk, apply: true, env: 'https://contoso.crm.dynamics.com', appDir, genpageCli, phases: PHASES }),
        (e) => e && e.phase === 'pages' && e.code === 'pages-nav-parity' && /non-symbolic navigation target/.test(e.message),
        override
      );
      assert.strictEqual(genpageCli.uploads.length, 0, `${override}: rejected before target pre-minting or source upload`);
    } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
  }
});

// ── A write whose outcome is not known is never sent again — not by the build's own retry either ──────────────────────────────────────────────
// buildModelApp re-runs the whole build when a halt reads as transient (isTransientHalt), and it decides that from the halt's TEXT. The text of an uncertain create quotes the page's name — user
// text, so "SQL Timeouts" or "Concurrent Deletes" read as a SQL timeout or a concurrent delete — and the service's own words ("… try again later"). A re-run would send the create again: the page the
// first send made, if it landed, is left beside the new one, outside the app's navigation, and the run reports success. These tests drive the REAL retry loop and the real backend over the SDK
// stand-in, with a create that ends each way, and count the sends that reach the service: under one minted id, never a second page.
function onePageApp(pageName) {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-uncertain-'));
  fs.writeFileSync(path.join(appDir, 'p.tsx'), 'export default function P(){ return null; }', 'utf8');
  const spec = {
    schemaVersion: 2,
    solution: { uniqueName: 'UncertainSol', displayName: 'Uncertain', publisherPrefix: 'contoso' },
    app: { name: 'Uncertain App' },
    entities: [{ schemaName: 'contoso_item', displayName: 'Item', primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' }, columns: [] }],
    pages: [{ key: 'p', name: pageName, source: { kind: 'tsx', codeFile: 'p.tsx' } }],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Pages', subAreas: [{ page: 'p', title: pageName }, TABLE_ENTRY] }] }] },
  };
  return { appDir, spec };
}
const TRY_AGAIN_LATER = 'The service is unavailable. Please try again later.';
const UNCERTAIN_PAGE_ID = '3a1f9c52-0000-4000-8000-00000000a0a0';
// A backend over the SDK stand-in whose create ends as `fake` is scripted to: the page's id is minted up front, so every send is under the same id.
function uncertainBackend(script) {
  const fake = new FakeSdk();
  script(fake);
  return { fake, genpage: makeGenpageSdk('https://contoso.crm.dynamics.com', { sdk: fake, newId: () => UNCERTAIN_PAGE_ID }) };
}
// `says` is what the halt says; each scenario ends the create a different way, and `sends` is how many sends reach the service.
const UNCERTAIN_CREATES = [
  { what: 'a create that never arrives, twice, for a page named "SQL Timeouts"', name: 'SQL Timeouts', script: (f) => f.script('push', { drop: connectionError(0, 'Request failed: read ECONNRESET') }, { drop: connectionError(0, 'Request failed: read ECONNRESET') }), sends: 2, says: /creating it was sent twice and neither answer could be used/ },
  { what: 'a create that never arrives, twice, for a page named "Concurrent Deletes"', name: 'Concurrent Deletes', script: (f) => f.script('push', { drop: connectionError(0, 'Request failed: read ECONNRESET') }, { drop: connectionError(0, 'Request failed: read ECONNRESET') }), sends: 2, says: /creating it was sent twice and neither answer could be used/ },
  { what: 'a create whose answer is lost and whose page then cannot be read, the service saying "try again later"', name: 'Overview', script: (f) => f.script('push', { lose: connectionError(0, 'Request failed: read ECONNRESET') }).script('fetch', new Error(TRY_AGAIN_LATER)), sends: 1, says: /the outcome of creating it is unknown[\s\S]*reading the page it would have[\s\S]*failed too \(The service is unavailable\. Please try again later\.\)/ },
  { what: 'a create whose answer is lost and whose page then reads as changed, for a page named "SQL Timeout Report"', name: 'SQL Timeout Report', script: (f) => f.script('push', { lose: connectionError(0, 'Request failed: read ECONNRESET') }).script('fetch', (s, type, id) => { s.pages.get(id).source = 'saved by someone else'; }), sends: 1, says: /exists, but it is not a page any create under this id sent: its source is not the one that was sent[\s\S]*not adopted, not sent again and not published/ },
  { what: 'a create the service says already exists, with no page to be read', name: 'Overview', script: (f) => f.script('push', { report: { saved: false, error: Object.assign(new Error('the artifact already exists'), { code: 'ARTIFACT_ALREADY_EXISTS' }) } }), sends: 1, says: /the service answered that page \S+ already exists, but no page \S+ can be read[\s\S]*a request that is still in flight can land/ },
  { what: 'a create that arrives only after its answer was given up on, for a page named "SQL Timeouts"', name: 'SQL Timeouts', script: (f) => f.script('push', { lose: connectionError(0, 'Request failed: read ECONNRESET') }).script('fetch', new Error(TRY_AGAIN_LATER)), sends: 1, says: /the outcome of creating it is unknown/ },
];
async function runUncertainBuild(scenario) {
  const { buildModelApp } = require('../build-model-app.js');
  const { appDir, spec } = onePageApp(scenario.name);
  try {
    const backend = uncertainBackend(scenario.script);
    const { sdk } = mockSdk();
    const lines = [];
    let halt = null;
    try {
      await buildModelApp(spec, { apply: true, env: 'https://contoso.crm.dynamics.com', appDir, retryDelayMs: 0 }, {
        sdk, provisionSdk: sdk, genpage: backend.genpage, sleep: async () => {}, log: (m) => lines.push(m),
        discoverOpDiffState: async () => ({ collision: { appExists: false, solutionExists: false }, forms: [], sitemap: null }),
      });
    } catch (e) { halt = e; }
    return { halt, lines, fake: backend.fake, spec };
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
}
for (const scenario of UNCERTAIN_CREATES) {
  test(`deploy: ${scenario.what} halts the build — it reaches the service under one id, and the build's own retry does not send it again`, async () => {
    const { isTransientHalt } = require('../build-model-app.js');
    const { halt, lines, fake, spec } = await runUncertainBuild(scenario);
    assert.ok(halt, 'the build halts');
    assert.strictEqual(halt.phase, 'pages');
    assert.match(halt.message, scenario.says);
    assert.strictEqual(fake.count('pushArtifact'), scenario.sends, `${scenario.sends} send(s): the one id is never sent a third time, and no second page is created`);
    assert.strictEqual(new Set(fake.of('createArtifact').map((c) => c.args[1].id)).size, 1, 'every send is under the same minted id');
    assert.deepStrictEqual(lines.filter((l) => /transient error|retrying/.test(l)), [], 'and the build never says it is retrying');
    assert.strictEqual(isTransientHalt(halt, { spec }), false, 'the halt reads as final');
    assert.strictEqual(halt.cause && halt.cause.transient, false, 'because the error it wraps says so, whatever its text quotes');
  });
}

// The marker is not a blanket: what the build rides out is still ridden out. A listing that fails BEFORE any create was sent — the snapshot the create is checked against — leaves nothing
// to duplicate, so a transient failure there is retried, and the create is sent once, when it can be.
test('deploy: a transient failure BEFORE the create was sent is still retried by the build, and the create is sent once', async () => {
  const { buildModelApp } = require('../build-model-app.js');
  const { appDir, spec } = onePageApp('Overview');
  try {
    // The environment's page list — read before anything is created — fails once with "try again later": nothing has been sent, so there is nothing to duplicate.
    const fake = new FakeSdk().script('list', new Error(TRY_AGAIN_LATER));
    const genpage = makeGenpageSdk('https://contoso.crm.dynamics.com', { sdk: fake, newId: () => UNCERTAIN_PAGE_ID });
    const { sdk } = mockSdk();
    const lines = [];
    const result = await buildModelApp(spec, { apply: true, env: 'https://contoso.crm.dynamics.com', appDir, retryDelayMs: 0 }, {
      sdk, provisionSdk: sdk, genpage, sleep: async () => {}, log: (m) => lines.push(m),
      discoverOpDiffState: async () => ({ collision: { appExists: false, solutionExists: false }, forms: [], sitemap: null }),
    });
    assert.strictEqual(result.ok, true);
    assert.ok(lines.some((l) => /transient error in pages — retrying/.test(l)), 'the build retried');
    assert.strictEqual(fake.count('pushArtifact'), 1, 'and the create went out once');
    assert.deepStrictEqual([...fake.pages.keys()], [UNCERTAIN_PAGE_ID], 'one page');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

// The one other place a create is left unrecorded: the page was made, and the receipt that lets a later build find it could not be written. The halt quotes the page's name too.
test('deploy: a page that was created but whose local receipt cannot be saved halts, and the build does not retry it into a second page — whatever the page is called', async () => {
  const { buildModelApp, isTransientHalt } = require('../build-model-app.js');
  const { recordPageCreation } = require('../lib/page-ownership-records.js');
  const { appDir, spec } = onePageApp('SQL Timeouts');
  try {
    const workspaceDir = path.join(appDir, '.maker-workspace');
    // A receipt for this very page id under another name: saving this one is refused, as a receipt that disagrees about the page is.
    recordPageCreation(workspaceDir, appUniqueName(spec), 'p', OVERVIEW_ID, 'Another name', 'https://contoso.crm.dynamics.com');
    const genpageCli = mockGenpageCli();
    const { sdk } = mockSdk();
    const lines = [];
    let halt = null;
    try {
      await buildModelApp(spec, { apply: true, env: 'https://contoso.crm.dynamics.com', appDir, workspaceDir, retryDelayMs: 0 }, {
        sdk, provisionSdk: sdk, genpage: genpageCli, sleep: async () => {}, log: (m) => lines.push(m),
        discoverOpDiffState: async () => ({ collision: { appExists: false, solutionExists: false }, forms: [], sitemap: null }),
      });
    } catch (e) { halt = e; }
    assert.ok(halt, 'the build halts');
    assert.match(halt.message, /page "SQL Timeouts" was created as 11111111-0000-4000-8000-000000000001, but its local receipt could not be saved/);
    assert.strictEqual(genpageCli.uploads.length, 1, 'one create');
    assert.deepStrictEqual(lines.filter((l) => /transient error|retrying/.test(l)), [], 'and no retry');
    assert.strictEqual(isTransientHalt(halt, { spec }), false);
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

// The pages scan reads each page ONCE, and checks and hashes those bytes; every write then sends the text of those bytes — the SDK takes a page's text, so no file is read again — never the canonical file.
// A page saved again while the build runs — after the scan, before its own write — must not ship unchecked, nor be recorded as what was sent.
// Overview links to Detail and Notes, so both are minted first (the create-absent-first step); Help links nowhere and goes up last. While the
// first page goes up, Notes and Help are saved with a key Griffel drops.
test('deploy: every page is written from the bytes the scan read — a save to a page during the build does not ship', async () => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-deploy-'));
  try {
    const original = {
      notes: 'export default function Notes(){ return null; }',
      help: 'export default function Help(){ return null; }',
    };
    fs.writeFileSync(path.join(appDir, 'overview.tsx'), `export default function Overview(){ ${NAV('detail')} ${NAV('notes')} return null; }`, 'utf8');
    fs.writeFileSync(path.join(appDir, 'detail.tsx'), 'export default function Detail(){ return null; }', 'utf8');
    fs.writeFileSync(path.join(appDir, 'notes.tsx'), original.notes, 'utf8');
    fs.writeFileSync(path.join(appDir, 'help.tsx'), original.help, 'utf8');
    const spec = {
      schemaVersion: 2,
      solution: { uniqueName: 'PgDeploy', displayName: 'Pg', publisherPrefix: 'contoso' },
      app: { name: 'Deploy App' },
      entities: [{ schemaName: 'contoso_item', displayName: 'Item', primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' }, columns: [] }],
      pages: [
        { key: 'overview', name: 'Overview', navigatesTo: [{ targetKey: 'detail' }, { targetKey: 'notes' }], source: { kind: 'tsx', codeFile: 'overview.tsx' } },
        { key: 'detail', name: 'Detail', source: { kind: 'tsx', codeFile: 'detail.tsx' } },
        { key: 'notes', name: 'Notes', source: { kind: 'tsx', codeFile: 'notes.tsx' } },
        { key: 'help', name: 'Help', source: { kind: 'tsx', codeFile: 'help.tsx' } },
      ],
      appShell: { areas: [{ label: 'Main', groups: [{ label: 'Pages', subAreas: [...['overview', 'detail', 'notes', 'help'].map((page) => ({ page, title: page })), TABLE_ENTRY] }] }] },
    };
    const saved = "import { makeStyles } from '@fluentui/react-components';\nconst useStyles = makeStyles({ root: { borderWidth: '1px' } });\nexport default function Saved(){ return null; }";
    const ids = { Overview: OVERVIEW_ID, Detail: DETAIL_ID, Notes: '33333333-0000-4000-8000-000000000003', Help: '44444444-0000-4000-8000-000000000004' };
    const uploads = [];
    const genpageCli = {
      enumerateEnv: async () => ({ ok: true, ids: [], pages: [] }),
      create: async (o) => {
        uploads.push({ name: o.name, content: o.source });
        if (uploads.length === 1) {
          fs.writeFileSync(path.join(appDir, 'notes.tsx'), saved, 'utf8');
          fs.writeFileSync(path.join(appDir, 'help.tsx'), saved, 'utf8');
        }
        return { pageId: ids[o.name], name: o.name, publish: { kind: 'verified', detail: '' }, warnings: [] };
      },
    };
    const { sdk } = mockSdk();
    const r = await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES });
    assert.deepStrictEqual(uploads.map((u) => u.name), ['Detail', 'Notes', 'Overview', 'Help'], 'the link targets are minted first, then the rest go up, each once');
    const by = Object.fromEntries(uploads.map((u) => [u.name, u]));
    assert.strictEqual(by.Notes.content, original.notes, 'a minted target sends what the scan read, not the later save');
    assert.strictEqual(by.Help.content, original.help, 'a page that links nowhere sends what the scan read, not the later save');
    for (const u of uploads) assert.strictEqual(typeof u.content, 'string', `${u.name}: the page is written as text — there is no file for a later save to reach`);
    assert.ok(!fs.existsSync(path.join(appDir, '.maker-workspace', '.pageref-deploy')), 'and no staging folder is made');
    // What the build records as sent is what it sent: the source hash the next build compares with, and (for a page sent in the upload step) the deployed hash.
    for (const key of ['notes', 'help']) assert.strictEqual(r.created.pageSourceShas[key], sha256(original[key]), `${key}: source hash`);
    assert.strictEqual(r.created.pageDeployedShas.help, sha256(original.help), 'help: deployed hash');
    assert.strictEqual(fs.readFileSync(path.join(appDir, 'help.tsx'), 'utf8'), saved, 'the canonical file keeps the save, for the next build to check');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

// A page key is a slug, and some slugs are Windows device names: CON, PRN, AUX, NUL, COM1-9 and LPT1-9 are reserved as a file name with or
// without an extension (https://learn.microsoft.com/windows/win32/fileio/naming-a-file). Through 2.14.0 the build handed pac each page as a
// staging file named after its key (`page-<key>.tsx`, so that no key could become a device name). The SDK takes a page's text, so no file is
// named after a key at all: such pages build like any other, and nothing is written to disk on their behalf.
test('deploy: pages keyed like Windows device names are written as text, with no file named after them', async () => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-deploy-'));
  try {
    const keys = ['con', 'nul', 'aux', 'prn', 'com1', 'lpt1'];
    const source = {};
    // `con` links to `nul` and `aux`, so both are minted first and `con` goes up with its tokens resolved; the rest link nowhere.
    for (const key of keys) {
      source[key] = key === 'con'
        ? `export default function Con(){ ${NAV('nul')} ${NAV('aux')} return null; }`
        : `export default function Page_${key}(){ return null; }`;
      fs.writeFileSync(path.join(appDir, `src-${key}.tsx`), source[key], 'utf8');
    }
    const spec = {
      schemaVersion: 2,
      solution: { uniqueName: 'PgDeploy', displayName: 'Pg', publisherPrefix: 'contoso' },
      app: { name: 'Deploy App' },
      entities: [{ schemaName: 'contoso_item', displayName: 'Item', primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' }, columns: [] }],
      pages: keys.map((key) => ({ key, name: `Page ${key}`, ...(key === 'con' ? { navigatesTo: [{ targetKey: 'nul' }, { targetKey: 'aux' }] } : {}), source: { kind: 'tsx', codeFile: `src-${key}.tsx` } })),
      appShell: { areas: [{ label: 'Main', groups: [{ label: 'Pages', subAreas: [...keys.map((page) => ({ page, title: page })), TABLE_ENTRY] }] }] },
    };
    const writes = [];
    let minted = 0;
    const genpageCli = {
      enumerateEnv: async () => ({ ok: true, ids: [], pages: [] }),
      create: async (o) => {
        writes.push({ name: o.name, content: o.source });
        return { pageId: `5${String(++minted).padStart(7, '0')}-0000-4000-8000-000000000000`, name: o.name, publish: { kind: 'verified', detail: '' }, warnings: [] };
      },
    };
    const { sdk } = mockSdk();
    await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES });
    assert.deepStrictEqual(writes.map((w) => w.name).sort(), keys.map((k) => `Page ${k}`).sort(), 'every page is written once');
    for (const w of writes) assert.strictEqual(typeof w.content, 'string', `${w.name}: written as text`);
    for (const key of keys.filter((k) => k !== 'con')) assert.strictEqual(writes.find((w) => w.name === `Page ${key}`).content, source[key], `${key}: the text the scan read`);
    assert.doesNotMatch(writes.find((w) => w.name === 'Page con').content, /PAGEREF_/, 'and the navigation page goes up with its tokens resolved');
    assert.ok(!fs.existsSync(path.join(appDir, '.maker-workspace', '.pageref-deploy')), 'no staging folder is made');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

// ── A create the build could not account for is not forgotten: its identity is written down BEFORE it is sent ───────────────────────────────────
// The build used to learn the identity of a page it created only when the create RETURNED. A create that committed, whose answer was lost and whose page could not be read back either, threw an
// error that carried the minted id — and nothing local kept it: the next build found the page in the environment's list with no link to its spec entry, and created ANOTHER page for it. The id is
// now recorded as a PENDING creation (lib/page-ownership-records.js) before the first request, and the next build settles the record: the page is there under the name the create sent — it is
// adopted, a creation receipt is written and the record consumed; it is not there — the create is sent again under the SAME id. These tests run the real pages phase twice over one workspace,
// through the real backend over the stateful fake of the page tables, and count the pages the service holds.
const { FakeGenPageServer, INSTANCE: PAGE_SERVICE } = require('./helpers/fake-genpage-server.js');
const BUILD_ENV = 'https://x';
const PAGE_SOURCE = "import * as React from 'react';\nexport default function Page() { return <div>Page</div>; }\n";
const lostAnswer = () => { throw new Error('Request failed: read ECONNRESET'); };
// The reads that would settle a create are the page's own row; the listing of the environment's pages, which the build reads before it creates anything, is not one of them.
const rowReadsFail = (method, requestPath, batched) => (method === 'GET' && !batched && /^\/uxagentprojects\(/.test(requestPath) ? 503 : undefined);
const realPageBackend = (server) => makeGenpageSdk(PAGE_SERVICE, { httpClient: server.http() });
async function buildPages(spec, appDir, genpage, extra = {}) {
  try {
    return await runSdkBuild(spec, { sdk: mockSdk().sdk, apply: true, env: BUILD_ENV, appDir, workspaceDir: path.join(appDir, '.maker-workspace'), genpage, phases: PHASES, ...extra });
  } finally { await genpage.dispose(); }
}
const pendingOf = (spec, appDir) => readPendingCreations(path.join(appDir, '.maker-workspace'), appUniqueName(spec), BUILD_ENV);
const receiptsOf = (spec, appDir) => readPageOwnership(path.join(appDir, '.maker-workspace'), appUniqueName(spec), BUILD_ENV).created;

test('deploy: a create whose answer is lost and whose page cannot be read is not forgotten — the next build adopts the page it left, where it used to create another', async () => {
  const { appDir, spec } = onePageApp('Overview');
  fs.writeFileSync(path.join(appDir, 'p.tsx'), PAGE_SOURCE, 'utf8');
  const server = new FakeGenPageServer();
  try {
    // Build 1: the create commits, its answer is lost, and the read that would settle it fails too.
    server.afterCommit = lostAnswer;
    server.failOn = rowReadsFail;
    await assert.rejects(buildPages(spec, appDir, realPageBackend(server)), (e) => e.phase === 'pages' && /the outcome of creating it is unknown/.test(e.message));
    const [id, ...others] = [...server.state.projects.keys()];
    assert.ok(id && !others.length, 'the page IS on the service — one page');
    assert.deepStrictEqual([...pendingOf(spec, appDir)], [['p', [{ pageId: id, sent: [{ name: 'Overview', sourceSha256: sha256(PAGE_SOURCE) }] }]]], 'and the build wrote down the id it minted for the spec entry before it sent anything — with the name and the source it sent');
    assert.deepStrictEqual(receiptsOf(spec, appDir), [], 'a pending creation is intent, not ownership: nothing was acknowledged, so there is no creation receipt');

    // Build 2: a new process on the same workspace, the service healthy.
    server.afterCommit = undefined;
    server.failOn = undefined;
    const batches = server.batches.length;
    const result = await buildPages(spec, appDir, realPageBackend(server));
    assert.deepStrictEqual([...server.state.projects.keys()], [id], 'one page per spec entry: the page build 1 left is the page, not the first of two');
    assert.strictEqual(result.created.pages.p, id);
    assert.deepStrictEqual(receiptsOf(spec, appDir).map((r) => [r.key, r.pageId, r.name]), [['p', id, 'Overview']], 'it is adopted: a creation receipt now says it was created for this key');
    assert.strictEqual(pendingOf(spec, appDir).size, 0, 'and the record that stood for it is consumed');
    assert.strictEqual(server.batches.length, batches, 'the page held what the build sends, so nothing was written to it — it was only published');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('deploy: the page a lost create left is adopted and then written like any page the build created — a file edited since goes up as an update, not as a second create that collides', async () => {
  const { appDir, spec } = onePageApp('Overview');
  fs.writeFileSync(path.join(appDir, 'p.tsx'), PAGE_SOURCE, 'utf8');
  const server = new FakeGenPageServer();
  try {
    server.afterCommit = lostAnswer;
    server.failOn = rowReadsFail;
    await assert.rejects(buildPages(spec, appDir, realPageBackend(server)), (e) => e.phase === 'pages');
    const [id] = [...server.state.projects.keys()];
    server.afterCommit = undefined;
    server.failOn = undefined;
    // The author edits the page before the next build.
    const edited = PAGE_SOURCE.replace('Page</div>', 'Edited</div>');
    fs.writeFileSync(path.join(appDir, 'p.tsx'), edited, 'utf8');
    const result = await buildPages(spec, appDir, realPageBackend(server));
    assert.deepStrictEqual([...server.state.projects.keys()], [id], 'still one page');
    assert.strictEqual(server.rowText(id, 'src/pages/page.tsx'), edited, 'it holds the edit: the build updated the page it adopted');
    assert.strictEqual(result.created.pages.p, id);
    assert.strictEqual(pendingOf(spec, appDir).size, 0);
    assert.deepStrictEqual(receiptsOf(spec, appDir).map((r) => r.pageId), [id]);
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('deploy: a create that never arrived is sent again by the next build under the SAME id — one page — and a late send of the first collides on the id instead of making another', async () => {
  const { appDir, spec } = onePageApp('Overview');
  fs.writeFileSync(path.join(appDir, 'p.tsx'), PAGE_SOURCE, 'utf8');
  const server = new FakeGenPageServer();
  try {
    // Build 1: both sends of the create time out in flight; the service has seen neither yet.
    server.strandBatch = (n) => n <= 2;
    await assert.rejects(buildPages(spec, appDir, realPageBackend(server)), (e) => e.phase === 'pages' && /was sent twice and neither answer could be used/.test(e.message));
    assert.strictEqual(server.state.projects.size, 0, 'nothing has landed');
    const [[key, [pending]]] = [...pendingOf(spec, appDir)];
    assert.strictEqual(key, 'p');

    // Build 2 finds no such page, so it sends the create again — under the id build 1 minted, not a new one.
    server.strandBatch = undefined;
    const result = await buildPages(spec, appDir, realPageBackend(server));
    assert.deepStrictEqual([...server.state.projects.keys()], [pending.pageId], 'one page, under the recorded id');
    assert.strictEqual(result.created.pages.p, pending.pageId);
    assert.strictEqual(pendingOf(spec, appDir).size, 0, 'acknowledged: the record is consumed');
    assert.deepStrictEqual(receiptsOf(spec, appDir).map((r) => r.pageId), [pending.pageId]);

    // The two requests build 1 gave up on reach the service now: each collides on the project id and is rolled back whole.
    await server.landStranded();
    assert.deepStrictEqual([...server.state.projects.keys()], [pending.pageId], 'no second page');
    assert.strictEqual(server.messagesOf(pending.pageId).length, 2, 'and the conversation holds the turn once');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('deploy: a create known to have written nothing leaves no pending record behind — a resumed one keeps the record and is UNKNOWN, because a request an earlier build sent may still land', async () => {
  const { appDir, spec } = onePageApp('Overview');
  const workspaceDir = path.join(appDir, '.maker-workspace');
  const server = new FakeGenPageServer();
  const EARLIER = '9d3a77c1-0000-4000-8000-0000000000e1';
  try {
    // A page that does not compile is refused by the SDK before it sends anything: nothing can land, so there is nothing for a later build to find.
    fs.writeFileSync(path.join(appDir, 'p.tsx'), 'export default function Page( {', 'utf8');
    await assert.rejects(buildPages(spec, appDir, realPageBackend(server)), (e) => e.phase === 'pages' && /nothing was written/.test(e.message));
    assert.strictEqual(server.batches.length, 0, 'nothing was sent');
    assert.strictEqual(pendingOf(spec, appDir).size, 0, 'and the record the create wrote before it started is consumed: it is known to have written nothing');

    // A create that resumes an earlier build's is another matter: that build's request may still be in flight, and a refusal of THIS call says nothing about it.
    recordPagePending(workspaceDir, appUniqueName(spec), 'p', EARLIER, 'Overview', BUILD_ENV, sha256(PAGE_SOURCE));
    await assert.rejects(buildPages(spec, appDir, realPageBackend(server)), (e) => {
      assert.strictEqual(e.phase, 'pages');
      assert.doesNotMatch(e.message, /nothing was written/, 'it is not said: the earlier request can still land');
      assert.match(e.message, new RegExp(`a create an earlier build sent under id ${EARLIER}, whose outcome was never learned\\) and the send after it was refused[\\s\\S]*it can still reach the service`));
      assert.strictEqual(e.cause.outcome, 'unknown');
      assert.strictEqual(e.cause.pageId, EARLIER, 'and the id to look for is kept');
      return true;
    });
    // Both creates stay recorded: the earlier build's, and the one this build recorded before it sent (its page does not compile, so it was refused — but the page may still hold what either sent).
    const BROKEN = 'export default function Page( {';
    const kept = pendingOf(spec, appDir);
    assert.deepStrictEqual([...kept.keys()], ['p']);
    assert.deepStrictEqual(kept.get('p').map((r) => r.pageId), [EARLIER], 'its record stays');
    assert.deepStrictEqual(kept.get('p')[0].sent.map((s) => s.sourceSha256).sort(), [sha256(PAGE_SOURCE), sha256(BROKEN)].sort());
    assert.strictEqual(server.state.projects.size, 0);
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('deploy: a pre-created navigation target is resumed like any create — the next build adopts it, and the page that links to it holds its id', async () => {
  const { appDir, spec } = makeTwoPageApp(); // overview links to detail, so detail is minted first
  const server = new FakeGenPageServer();
  try {
    let lost = true;
    server.afterCommit = () => { if (lost) lostAnswer(); };
    server.failOn = (method, requestPath, batched) => (lost ? rowReadsFail(method, requestPath, batched) : undefined);
    await assert.rejects(buildPages(spec, appDir, realPageBackend(server)), (e) => e.phase === 'pages' && /the outcome of creating it is unknown/.test(e.message));
    const [detailId, ...others] = [...server.state.projects.keys()];
    assert.ok(detailId && !others.length, 'the target is on the service, and nothing else');
    assert.deepStrictEqual([...pendingOf(spec, appDir).keys()], ['detail'], 'recorded under its own key, before its create was sent');

    lost = false;
    const result = await buildPages(spec, appDir, realPageBackend(server));
    assert.strictEqual(server.state.projects.size, 2, 'two pages for two spec entries — not three');
    assert.strictEqual(result.created.pages.detail, detailId, 'the target is the page build 1 left');
    const overviewId = result.created.pages.overview;
    assert.ok(overviewId && overviewId !== detailId);
    const linked = server.rowText(overviewId, 'src/pages/page.tsx');
    assert.ok(linked.includes(detailId) && !/PAGEREF_/.test(linked), 'and the page that links to it holds its id, resolved');
    assert.strictEqual(pendingOf(spec, appDir).size, 0);
    assert.deepStrictEqual(receiptsOf(spec, appDir).map((r) => r.key).sort(), ['detail', 'overview']);
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('deploy: a pending creation is not ownership — a page under its id that is not named what the create sent is a conflict: not adopted, not updated; a key the spec does not declare is left as it is', async () => {
  const { appDir, spec } = onePageApp('Overview');
  fs.writeFileSync(path.join(appDir, 'p.tsx'), PAGE_SOURCE, 'utf8');
  const workspaceDir = path.join(appDir, '.maker-workspace');
  const server = new FakeGenPageServer();
  const THEIRS = '9d3a77c1-0000-4000-8000-0000000000d1';
  const RETIRED = '9d3a77c1-0000-4000-8000-0000000000d2';
  const theirs = 'export default function Theirs() { return null; }\n';
  server.seedPage(THEIRS, { name: 'Somebody else\'s page', source: theirs });
  recordPagePending(workspaceDir, appUniqueName(spec), 'p', THEIRS, 'Overview', BUILD_ENV, sha256(PAGE_SOURCE));
  recordPagePending(workspaceDir, appUniqueName(spec), 'retired', RETIRED, 'Retired page', BUILD_ENV, sha256(PAGE_SOURCE));
  try {
    await assert.rejects(buildPages(spec, appDir, realPageBackend(server)), (e) => {
      assert.strictEqual(e.phase, 'pages');
      assert.strictEqual(e.code, 'pages-identity-conflict');
      assert.match(e.message, new RegExp(`page ${THEIRS} exists under the id an earlier build minted for "p", but it is not a page that build sent: it is named "Somebody else's page", and the create sent "Overview", and its source is not the one that was sent — so it is neither adopted nor updated`));
      return true;
    });
    assert.deepStrictEqual(server.writes(), [], 'nothing was written to any page: not an update, not a create, not a delete');
    assert.strictEqual(server.rowText(THEIRS, 'src/pages/page.tsx'), theirs, 'the other page is as it was');
    assert.deepStrictEqual(receiptsOf(spec, appDir), [], 'and no receipt was made out of the record');
    assert.deepStrictEqual([...pendingOf(spec, appDir).keys()].sort(), ['p', 'retired'], 'both records are kept: one is for the build to settle, the other for a key this spec does not declare');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('deploy: two creations left pending for one key cannot be told apart — the build stops before it writes anything, naming both ids', async () => {
  const { appDir, spec } = onePageApp('Overview');
  fs.writeFileSync(path.join(appDir, 'p.tsx'), PAGE_SOURCE, 'utf8');
  const workspaceDir = path.join(appDir, '.maker-workspace');
  const server = new FakeGenPageServer();
  const FIRST = '9d3a77c1-0000-4000-8000-0000000000f1';
  const SECOND = '9d3a77c1-0000-4000-8000-0000000000f2';
  recordPagePending(workspaceDir, appUniqueName(spec), 'p', FIRST, 'Overview', BUILD_ENV, sha256(PAGE_SOURCE));
  recordPagePending(workspaceDir, appUniqueName(spec), 'p', SECOND, 'Overview', BUILD_ENV, sha256(PAGE_SOURCE));
  try {
    await assert.rejects(buildPages(spec, appDir, realPageBackend(server)), (e) => {
      assert.strictEqual(e.phase, 'pages');
      assert.strictEqual(e.code, 'pages-identity-conflict');
      assert.match(e.message, /page "p" has 2 unfinished creations/);
      assert.ok(e.message.includes(FIRST) && e.message.includes(SECOND), 'it names both ids');
      return true;
    });
    assert.strictEqual(server.batches.length, 0, 'nothing was sent: neither id is resumed on a guess');
    assert.deepStrictEqual(pendingOf(spec, appDir).get('p').map((r) => r.pageId).sort(), [FIRST, SECOND], 'and both records are kept');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

// ── A pending record whose create was acknowledged is consumed through its receipt ─────────────────────────────────────────────────────────────────────
// An acknowledged create writes its receipt first and consumes its pending record after; a record that cannot be removed (a scanner or an indexer holding the file) is a warning, on the footing that the next build
// finds the receipt and removes it. The next build used to prove the record again by the page's name and source instead, a proof a page edited since its create — a maker's save, or a navigation target created
// with its tokens and rewritten with them resolved — can no longer pass: the build halted with an identity conflict over a page it had made and recorded.
test('deploy: a pending record that could not be removed after its create was acknowledged is consumed by the next build through the receipt — a page edited since is no conflict, and a record that still cannot be removed is a warning', async () => {
  const { appDir, spec } = onePageApp('Overview');
  fs.writeFileSync(path.join(appDir, 'p.tsx'), PAGE_SOURCE, 'utf8');
  const server = new FakeGenPageServer();
  const realUnlink = fs.unlinkSync;
  // Node's own recursive remove (behind fs.rmSync) keeps the `unlinkSync` it finds the first time it runs, so it is run once before `unlinkSync` is replaced: the clean-up at the end is not held by the replacement.
  const warmUp = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-rimraf-'));
  fs.writeFileSync(path.join(warmUp, 'x'), 'x');
  fs.rmSync(warmUp, { recursive: true, force: true });
  // The record cannot be removed (EBUSY, as when a scanner or an indexer holds the file).
  const holdsRecord = () => {
    fs.unlinkSync = (target, ...rest) => {
      if (String(target).includes('page-ownership.pending.')) throw Object.assign(new Error(`EBUSY: resource busy or locked, unlink '${target}'`), { code: 'EBUSY' });
      return realUnlink(target, ...rest);
    };
  };
  const notRemoved = /the record of its create \(\S+\) could not be removed/;
  try {
    const firstWarnings = [];
    holdsRecord();
    let first;
    try { first = await buildPages(spec, appDir, realPageBackend(server), { warn: (m) => firstWarnings.push(m) }); } finally { fs.unlinkSync = realUnlink; }
    const id = first.created.pages.p;
    assert.deepStrictEqual(receiptsOf(spec, appDir).map((r) => r.pageId), [id], 'the create was acknowledged: its receipt is written');
    assert.deepStrictEqual(pendingOf(spec, appDir).get('p').map((r) => r.pageId), [id], 'and its record could not be removed');
    assert.ok(firstWarnings.some((m) => notRemoved.test(m)), `the build says so: ${JSON.stringify(firstWarnings)}`);

    // A maker saves the page: it no longer holds what the create sent, which is what the record would be proved by.
    makerSaves(server, id, `${PAGE_SOURCE}// edited in Maker\n`);
    // The next build still cannot remove the record: it goes on, and says so.
    const secondWarnings = [];
    holdsRecord();
    let second;
    try { second = await rebuildPages(spec, appDir, server, { p: id }, { warn: (m) => secondWarnings.push(m) }); } finally { fs.unlinkSync = realUnlink; }
    assert.strictEqual(second.created.pages.p, id);
    assert.deepStrictEqual([...server.state.projects.keys()], [id], 'one page');
    assert.strictEqual(server.rowText(id, 'src/pages/page.tsx'), PAGE_SOURCE, 'the build brought the page the edit changed back to the file, as it does any page it made');
    assert.deepStrictEqual(pendingOf(spec, appDir).get('p').map((r) => r.pageId), [id], 'the record that cannot be removed is still there');
    assert.ok(secondWarnings.some((m) => notRemoved.test(m)), `and that is a warning, not an identity conflict: ${JSON.stringify(secondWarnings)}`);

    // Once it can be removed, the next build removes it, and the receipt stays: it is what teardown finds the page by.
    await rebuildPages(spec, appDir, server, { p: id });
    assert.strictEqual(pendingOf(spec, appDir).size, 0);
    assert.deepStrictEqual(receiptsOf(spec, appDir).map((r) => r.pageId), [id]);
  } finally { fs.unlinkSync = realUnlink; fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('deploy: a receipt for another key does not settle a pending record — the create is resumed under the id the record names', async () => {
  const { appDir, spec } = onePageApp('Overview');
  fs.writeFileSync(path.join(appDir, 'p.tsx'), PAGE_SOURCE, 'utf8');
  const workspaceDir = path.join(appDir, '.maker-workspace');
  const server = new FakeGenPageServer();
  const EARLIER = '9d3a77c1-0000-4000-8000-0000000000e2';
  recordPagePending(workspaceDir, appUniqueName(spec), 'p', EARLIER, 'Overview', BUILD_ENV, sha256(PAGE_SOURCE));
  recordPageCreation(workspaceDir, appUniqueName(spec), 'other', EARLIER, 'Overview', BUILD_ENV);
  try {
    const result = await buildPages(spec, appDir, realPageBackend(server));
    assert.strictEqual(result.created.pages.p, EARLIER, 'the record was not consumed as acknowledged: no page is there, so the create is sent again under its id');
    assert.deepStrictEqual([...server.state.projects.keys()], [EARLIER]);
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

// ── A key bound to another page keeps the record of a create that can still land ──────────────────────────────────────────────────────────────────────
// An absence in one listing is a snapshot, not proof that the request which would make the page cannot still arrive. A build that binds the spec key to another live page does not resume the create — but it must not
// consume the record either: the page that lands later would have no key, no receipt and no record, and nothing — teardown included — would find it. The record stays until evidence settles it (the page appears, or
// the page is deleted), and the build that finds the page reports it as an unused page it made.
test('deploy: a key bound to another page does not consume the record of a create that can still land — the record is kept and said so, and when the page lands the next build reports it as an unused page this build made', async () => {
  const { appDir, spec } = onePageApp('Overview');
  fs.writeFileSync(path.join(appDir, 'p.tsx'), PAGE_SOURCE, 'utf8');
  const server = new FakeGenPageServer();
  const BOUND = '9d3a77c1-0000-4000-8000-0000000000b1';
  try {
    // Build 1: both sends are in flight when the build gives up on them.
    server.strandBatch = () => true;
    await assert.rejects(buildPages(spec, appDir, realPageBackend(server)), (e) => e.phase === 'pages');
    const [[, [pending]]] = [...pendingOf(spec, appDir)];

    // The spec now binds the key to a page that is in this app's navigation.
    server.strandBatch = undefined;
    server.seedPage(BOUND, { name: 'Overview', source: PAGE_SOURCE, config: { dataSources: [] } });
    spec.pages[0].pageId = BOUND;
    const withNavigation = () => ({ sdk: mockSdk({ liveSitemapXml: pageSitemap([BOUND]) }).sdk });
    const warnings = [];
    const second = await buildPages(spec, appDir, realPageBackend(server), { ...withNavigation(), warn: (m) => warnings.push(m) });
    assert.strictEqual(second.created.pages.p, BOUND, 'the key stays bound to its page');
    assert.deepStrictEqual([...server.state.projects.keys()], [BOUND], 'nothing was created for it');
    assert.deepStrictEqual([...pendingOf(spec, appDir)], [['p', [{ pageId: pending.pageId, sent: [{ name: 'Overview', sourceSha256: sha256(PAGE_SOURCE) }] }]]], 'the record of the create that can still land is KEPT');
    const kept = warnings.filter((m) => m.includes(pending.pageId));
    assert.strictEqual(kept.length, 1);
    assert.match(kept[0], /is not resumed\. No such page is in the environment now, but a request still in flight can create it later, so its record is kept/);
    assert.doesNotMatch(kept[0], /record was removed/);
    assert.match(kept[0], /--clear-workspace waits for it/);

    // The request build 1 gave up on arrives after that build: the page it makes is the one the record is for.
    await server.landStranded();
    assert.strictEqual(server.state.projects.size, 2, 'the page exists now, with no key, no receipt and — until the next build — only the record to find it by');
    assert.strictEqual(server.state.projects.get(pending.pageId).name, 'Overview');

    const orphanWarnings = [];
    const third = await buildPages(spec, appDir, realPageBackend(server), { ...withNavigation(), warn: (m) => orphanWarnings.push(m) });
    assert.strictEqual(third.created.pages.p, BOUND, 'the key is still the other page\'s');
    assert.strictEqual(server.state.projects.size, 2, 'the page that landed is not deleted — nothing here deletes a page');
    assert.deepStrictEqual(receiptsOf(spec, appDir).map((r) => [r.key, r.pageId, r.name]), [['p', pending.pageId, 'Overview']], 'it is recorded as a page this app created, so teardown finds it by that id');
    assert.strictEqual(pendingOf(spec, appDir).size, 0, 'and the record is consumed: the page was found');
    const orphan = orphanWarnings.filter((m) => m.includes(pending.pageId));
    assert.strictEqual(orphan.length, 1);
    assert.match(orphan[0], new RegExp(`page "Overview" \\(${pending.pageId}\\) was created by an earlier build for "p" — its answer was lost — and is not used: "p" is bound to ${BOUND}\\. It is recorded as a page this app created, so teardown deletes it`));
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('deploy: a resumed create whose send is refused while the earlier build\'s request lands is read, found and adopted — one page, one receipt, never "nothing was written"', async () => {
  const { appDir, spec } = onePageApp('Overview');
  fs.writeFileSync(path.join(appDir, 'p.tsx'), PAGE_SOURCE, 'utf8');
  const server = new FakeGenPageServer();
  try {
    server.strandBatch = () => true;
    await assert.rejects(buildPages(spec, appDir, realPageBackend(server)), (e) => e.phase === 'pages');
    const [[, [pending]]] = [...pendingOf(spec, appDir)];
    assert.strictEqual(server.state.projects.size, 0, 'nothing has landed yet');

    // Build 2 finds no page and resumes under the same id. Its send is refused — a throttle — and while it is, the request build 1 gave up on lands.
    server.strandBatch = undefined;
    server.failBatch = () => { server.landStranded(); return 429; };
    const result = await buildPages(spec, appDir, realPageBackend(server));
    server.failBatch = undefined;
    assert.strictEqual(result.created.pages.p, pending.pageId);
    assert.deepStrictEqual([...server.state.projects.keys()], [pending.pageId], 'one page: the one the refusal was read for');
    assert.deepStrictEqual(receiptsOf(spec, appDir).map((r) => r.pageId), [pending.pageId]);
    assert.strictEqual(pendingOf(spec, appDir).size, 0, 'acknowledged: the record is consumed');
    assert.deepStrictEqual(server.published, [pending.pageId], 'and it is published, once');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('deploy: a resumed create whose send is refused while nothing has landed is UNKNOWN — it names the id to look for and keeps the record — and the next build adopts the page once the request lands', async () => {
  const { appDir, spec } = onePageApp('Overview');
  fs.writeFileSync(path.join(appDir, 'p.tsx'), PAGE_SOURCE, 'utf8');
  const server = new FakeGenPageServer();
  try {
    server.strandBatch = () => true;
    await assert.rejects(buildPages(spec, appDir, realPageBackend(server)), (e) => e.phase === 'pages');
    const [[, [pending]]] = [...pendingOf(spec, appDir)];

    // Build 2: refused, and nothing lands. The refusal proves nothing about the request build 1 gave up on.
    server.strandBatch = undefined;
    server.failBatch = () => 429;
    const failure = await buildPages(spec, appDir, realPageBackend(server)).then(() => null, (e) => e);
    server.failBatch = undefined;
    assert.ok(failure, 'the build stops');
    assert.strictEqual(failure.phase, 'pages');
    assert.doesNotMatch(failure.message, /nothing was written|wrote nothing/);
    assert.match(failure.message, /it can still reach the service/);
    assert.strictEqual(failure.cause.outcome, 'unknown');
    assert.strictEqual(failure.cause.pageId, pending.pageId, 'with the id to look for');
    assert.strictEqual(pendingOf(spec, appDir).size, 1, 'and the record stays');
    assert.strictEqual(server.state.projects.size, 0);

    // The request lands afterwards, as it can; the next build finds the page and adopts it.
    await server.landStranded();
    assert.deepStrictEqual([...server.state.projects.keys()], [pending.pageId]);
    const third = await buildPages(spec, appDir, realPageBackend(server));
    assert.strictEqual(third.created.pages.p, pending.pageId);
    assert.deepStrictEqual([...server.state.projects.keys()], [pending.pageId], 'one page for one spec entry');
    assert.deepStrictEqual(receiptsOf(spec, appDir).map((r) => r.pageId), [pending.pageId]);
    assert.strictEqual(pendingOf(spec, appDir).size, 0);
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

// ── A page found under a pending id is recognised by what was sent, and brought to what this build asks for ──────────────────────────────────────────────
// The page under the id is the one the pending record is for only if it holds what a create under that id sent — its name and its source. One that does is ours; it may still hold what an EARLIER build sent (another model
// or name), and is then updated to what this build asks for — through the ordinary update, never published and acknowledged as if the new content had been stored. One that does not is somebody else's.
test('deploy: an earlier build\'s request that lands just before the resumed send leaves a page with the OLD model — the page is adopted and updated to the new one before it is published, not acknowledged as it is', async () => {
  const { appDir, spec } = onePageApp('Overview');
  fs.writeFileSync(path.join(appDir, 'p.tsx'), PAGE_SOURCE, 'utf8');
  const server = new FakeGenPageServer();
  spec.pages[0].model = 'model-before';
  spec.pages[0].prompt = 'First request';
  try {
    server.strandBatch = () => true;
    await assert.rejects(buildPages(spec, appDir, realPageBackend(server)), (e) => e.phase === 'pages');
    const [[, [pending]]] = [...pendingOf(spec, appDir)];

    // The spec changes — another model, another prompt, the same source — and the request build 1 gave up on lands right before the resumed send, which then collides on the id.
    server.strandBatch = undefined;
    spec.pages[0].model = 'model-after';
    spec.pages[0].prompt = 'Revised request';
    server.beforeBatch = () => { server.beforeBatch = undefined; server.landStranded(); };
    const warnings = [];
    const result = await buildPages(spec, appDir, realPageBackend(server), { warn: (m) => warnings.push(m) });
    assert.strictEqual(result.created.pages.p, pending.pageId);
    assert.deepStrictEqual([...server.state.projects.keys()], [pending.pageId], 'one page');
    assert.strictEqual(JSON.parse(server.rowText(pending.pageId, 'config.json')).model, 'model-after', 'it holds the model this build asks for, not the one the earlier build sent');
    assert.deepStrictEqual(server.messagesOf(pending.pageId).map((m) => m.message), ['First request', 'Authored by app-builder', 'Revised request', 'Authored by app-builder'], 'its conversation shows both requests: the update recorded this build\'s turn');
    assert.deepStrictEqual(server.published, [pending.pageId], 'it was published once — after it was brought to what this build asks for, never before');
    assert.deepStrictEqual(receiptsOf(spec, appDir).map((r) => [r.key, r.pageId, r.name]), [['p', pending.pageId, 'Overview']]);
    assert.strictEqual(pendingOf(spec, appDir).size, 0);
    assert.ok(warnings.some((m) => /an earlier create under this id had written, differing from this create in model[\s\S]*was updated to what this create asks for instead of being published as it was/.test(m)), `the build says what it did: ${JSON.stringify(warnings)}`);
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('deploy: the spec renamed the page since the build that left it pending — the page it left, under the OLD name, is still ours: adopted and renamed, in the resumed create and when found in the listing', async () => {
  // (a) the earlier request lands while the resumed create is being sent.
  const a = onePageApp('Overview');
  fs.writeFileSync(path.join(a.appDir, 'p.tsx'), PAGE_SOURCE, 'utf8');
  const server = new FakeGenPageServer();
  try {
    server.strandBatch = () => true;
    await assert.rejects(buildPages(a.spec, a.appDir, realPageBackend(server)), (e) => e.phase === 'pages');
    const [[, [pending]]] = [...pendingOf(a.spec, a.appDir)];
    server.strandBatch = undefined;
    a.spec.pages[0].name = 'Overview, renamed';
    server.beforeBatch = () => { server.beforeBatch = undefined; server.landStranded(); };
    const result = await buildPages(a.spec, a.appDir, realPageBackend(server));
    assert.strictEqual(result.created.pages.p, pending.pageId);
    assert.deepStrictEqual([...server.state.projects.keys()], [pending.pageId], 'one page');
    assert.strictEqual(server.state.projects.get(pending.pageId).name, 'Overview, renamed', 'renamed by the update');
    assert.strictEqual(pendingOf(a.spec, a.appDir).size, 0, 'both records — the old name\'s and the new one\'s — are consumed with the page');
  } finally { fs.rmSync(a.appDir, { recursive: true, force: true }); }

  // (b) the page is already in the listing when the next build starts: a create whose answer was lost, and whose page could not be read.
  const b = onePageApp('Overview');
  fs.writeFileSync(path.join(b.appDir, 'p.tsx'), PAGE_SOURCE, 'utf8');
  const lost = new FakeGenPageServer();
  try {
    lost.afterCommit = lostAnswer;
    lost.failOn = rowReadsFail;
    await assert.rejects(buildPages(b.spec, b.appDir, realPageBackend(lost)), (e) => e.phase === 'pages');
    const [id] = [...lost.state.projects.keys()];
    lost.afterCommit = undefined;
    lost.failOn = undefined;
    b.spec.pages[0].name = 'Overview, renamed';
    const result = await buildPages(b.spec, b.appDir, realPageBackend(lost));
    assert.strictEqual(result.created.pages.p, id, 'adopted: its stored name is an older one than the spec\'s, which does not make it somebody else\'s');
    assert.deepStrictEqual([...lost.state.projects.keys()], [id]);
    assert.strictEqual(lost.state.projects.get(id).name, 'Overview, renamed', 'and the update renamed it');
    assert.strictEqual(pendingOf(b.spec, b.appDir).size, 0);
  } finally { fs.rmSync(b.appDir, { recursive: true, force: true }); }
});

test('deploy: a page found in the listing under a pending id holds what the build sent and an OLD model — it is adopted, and the ordinary update brings it to the new one', async () => {
  const { appDir, spec } = onePageApp('Overview');
  fs.writeFileSync(path.join(appDir, 'p.tsx'), PAGE_SOURCE, 'utf8');
  spec.pages[0].model = 'model-before';
  const server = new FakeGenPageServer();
  try {
    server.afterCommit = lostAnswer;
    server.failOn = rowReadsFail;
    await assert.rejects(buildPages(spec, appDir, realPageBackend(server)), (e) => e.phase === 'pages');
    const [id] = [...server.state.projects.keys()];
    server.afterCommit = undefined;
    server.failOn = undefined;
    spec.pages[0].model = 'model-after';
    const result = await buildPages(spec, appDir, realPageBackend(server));
    assert.strictEqual(result.created.pages.p, id);
    assert.deepStrictEqual([...server.state.projects.keys()], [id], 'one page');
    assert.strictEqual(JSON.parse(server.rowText(id, 'config.json')).model, 'model-after');
    assert.deepStrictEqual(receiptsOf(spec, appDir).map((r) => r.pageId), [id]);
    assert.strictEqual(pendingOf(spec, appDir).size, 0);
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('deploy: a page that comes to hold a pending id after the listing — named otherwise than the create sent it — is not ours: not adopted, not published, no receipt, and the build says which id', async () => {
  const { appDir, spec } = onePageApp('Overview');
  fs.writeFileSync(path.join(appDir, 'p.tsx'), PAGE_SOURCE, 'utf8');
  const server = new FakeGenPageServer();
  try {
    server.strandBatch = () => true;
    await assert.rejects(buildPages(spec, appDir, realPageBackend(server)), (e) => e.phase === 'pages');
    const [[, [pending]]] = [...pendingOf(spec, appDir)];

    // After the listing this build read, a page with the same source but another name appears under the id: the resumed send then collides on it.
    server.strandBatch = undefined;
    server.beforeBatch = () => { server.beforeBatch = undefined; server.seedPage(pending.pageId, { name: 'Another app page', source: PAGE_SOURCE }); };
    const failure = await buildPages(spec, appDir, realPageBackend(server)).then(() => null, (e) => e);
    assert.ok(failure, 'the build stops');
    assert.strictEqual(failure.phase, 'pages');
    assert.strictEqual(failure.code, 'pages-identity-conflict');
    assert.match(failure.message, new RegExp(`generative page "Overview" \\(${pending.pageId}\\) exists, but it is not a page any create under this id sent: it is named "Another app page", and the create sent "Overview"`));
    assert.match(failure.message, /not adopted, not sent again and not published/);
    assert.deepStrictEqual(server.published, [], 'it was not published');
    assert.deepStrictEqual(receiptsOf(spec, appDir), [], 'no receipt was written — least of all with the spec\'s name');
    assert.strictEqual(server.state.projects.get(pending.pageId).name, 'Another app page', 'and the page is as it was');
    assert.strictEqual(pendingOf(spec, appDir).size, 1, 'the record stays for the build — or the person — that settles it');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('deploy: a page in the listing under a pending id with the right NAME and another SOURCE, or the right source and another name, is not one the build sent — neither is adopted, and each says what differs', async () => {
  for (const [what, held, says] of [
    ['another source', { name: 'Overview', source: 'export default function Theirs() { return null; }\n' }, /it is not a page that build sent: its source is not the one that was sent — so it is neither adopted nor updated/],
    ['another name', { name: 'Overview 2', source: PAGE_SOURCE }, /it is not a page that build sent: it is named "Overview 2", and the create sent "Overview" — so it is neither adopted nor updated/],
  ]) {
    const { appDir, spec } = onePageApp('Overview');
    fs.writeFileSync(path.join(appDir, 'p.tsx'), PAGE_SOURCE, 'utf8');
    const workspaceDir = path.join(appDir, '.maker-workspace');
    const server = new FakeGenPageServer();
    const ID = '9d3a77c1-0000-4000-8000-0000000000c1';
    server.seedPage(ID, held);
    recordPagePending(workspaceDir, appUniqueName(spec), 'p', ID, 'Overview', BUILD_ENV, sha256(PAGE_SOURCE));
    try {
      await assert.rejects(buildPages(spec, appDir, realPageBackend(server)), (e) => e.code === 'pages-identity-conflict' && says.test(e.message), what);
      assert.deepStrictEqual(server.writes(), [], `${what}: nothing was written`);
      assert.deepStrictEqual(receiptsOf(spec, appDir), [], `${what}: no receipt`);
    } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
  }
});

// A page the listing showed under a pending id can be gone by the time the build reads it to prove it (a maker deleted it): that is an absence like any other, so the create is resumed under the same id.
// A page that is there and cannot be READ proves nothing either way — it is not adopted, and not resumed over (a create under an id that exists collides): the build stops and says so.
const vanish = (server, pageId) => {
  for (const [fileId, file] of [...server.state.files]) if (file.projectId === pageId) server.state.files.delete(fileId);
  for (const [messageId, message] of [...server.state.messages]) if (message.regarding === pageId) server.state.messages.delete(messageId);
  server.state.projects.delete(pageId);
};

test('deploy: a page that was in the listing under a pending id and is gone when the build reads it is resumed like a page that was not listed — created again under the SAME id', async () => {
  const { appDir, spec } = onePageApp('Overview');
  fs.writeFileSync(path.join(appDir, 'p.tsx'), PAGE_SOURCE, 'utf8');
  const workspaceDir = path.join(appDir, '.maker-workspace');
  const server = new FakeGenPageServer();
  const ID = '9d3a77c1-0000-4000-8000-0000000000c2';
  server.seedPage(ID, { name: 'Overview', source: PAGE_SOURCE });
  recordPagePending(workspaceDir, appUniqueName(spec), 'p', ID, 'Overview', BUILD_ENV, sha256(PAGE_SOURCE));
  try {
    const genpage = realPageBackend(server);
    const read = genpage.read;
    genpage.read = async (pageId) => { vanish(server, pageId); return read(pageId); };
    const result = await buildPages(spec, appDir, genpage);
    assert.strictEqual(result.created.pages.p, ID, 'the page is created again under the recorded id');
    assert.deepStrictEqual([...server.state.projects.keys()], [ID], 'one page');
    assert.deepStrictEqual(receiptsOf(spec, appDir).map((r) => r.pageId), [ID], 'acknowledged, so it has a receipt');
    assert.strictEqual(pendingOf(spec, appDir).size, 0, 'and the record is consumed on that evidence');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('deploy: a page in the listing under a pending id that cannot be READ is neither adopted nor resumed over — the build stops, says it could not read it, and writes nothing', async () => {
  const { appDir, spec } = onePageApp('Overview');
  fs.writeFileSync(path.join(appDir, 'p.tsx'), PAGE_SOURCE, 'utf8');
  const workspaceDir = path.join(appDir, '.maker-workspace');
  const server = new FakeGenPageServer();
  const ID = '9d3a77c1-0000-4000-8000-0000000000c3';
  server.seedPage(ID, { name: 'Overview', source: PAGE_SOURCE });
  recordPagePending(workspaceDir, appUniqueName(spec), 'p', ID, 'Overview', BUILD_ENV, sha256(PAGE_SOURCE));
  server.failOn = rowReadsFail;
  try {
    await assert.rejects(buildPages(spec, appDir, realPageBackend(server)), (e) => {
      assert.strictEqual(e.code, 'pages-identity-conflict');
      assert.match(e.message, new RegExp(`page ${ID} exists under the id an earlier build minted for "p", but it could not be read to tell whether it is a page that build sent \\(.*\\), so it is neither adopted nor updated`));
      return true;
    });
    assert.deepStrictEqual(server.writes(), [], 'nothing was written');
    assert.deepStrictEqual(receiptsOf(spec, appDir), [], 'no receipt was made out of the record');
    assert.strictEqual(pendingOf(spec, appDir).size, 1, 'and the record stays');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('deploy: a resumed create with another name or source adds a record — the earlier one stays, because the page may hold either — and the acknowledgement consumes them all', async () => {
  const { appDir, spec } = onePageApp('Overview');
  fs.writeFileSync(path.join(appDir, 'p.tsx'), PAGE_SOURCE, 'utf8');
  const server = new FakeGenPageServer();
  try {
    server.strandBatch = () => true;
    await assert.rejects(buildPages(spec, appDir, realPageBackend(server)), (e) => e.phase === 'pages');
    // Build 2 changes both, and is stranded as well.
    const edited = PAGE_SOURCE.replace('Page</div>', 'Edited</div>');
    fs.writeFileSync(path.join(appDir, 'p.tsx'), edited, 'utf8');
    spec.pages[0].name = 'Overview 2';
    await assert.rejects(buildPages(spec, appDir, realPageBackend(server)), (e) => e.phase === 'pages');
    const [[, [pending]]] = [...pendingOf(spec, appDir)];
    assert.deepStrictEqual(pending.sent, [
      { name: 'Overview', sourceSha256: sha256(PAGE_SOURCE) },
      { name: 'Overview 2', sourceSha256: sha256(edited) },
    ].sort((a, b) => (`${a.name}\n${a.sourceSha256}` < `${b.name}\n${b.sourceSha256}` ? -1 : 1)), 'what each build sent under the one id');
    // Build 3 is healthy: the page lands (only the first-sent request lands; the rest collide), and it is the OLD one — adopted, and brought to what build 3 asks for.
    server.strandBatch = undefined;
    server.beforeBatch = () => { server.beforeBatch = undefined; server.landStranded(); };
    const result = await buildPages(spec, appDir, realPageBackend(server));
    assert.strictEqual(result.created.pages.p, pending.pageId);
    assert.strictEqual(server.state.projects.get(pending.pageId).name, 'Overview 2');
    assert.strictEqual(server.rowText(pending.pageId, 'src/pages/page.tsx'), edited, 'it holds what the last build asks for');
    assert.strictEqual(pendingOf(spec, appDir).size, 0, 'every record of the id is consumed');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

// ── An unchanged rebuild publishes nothing ────────────────────────────────────────────────────────────────────────────────────────────────────
// A page that already holds what the spec asks for is not written, but the backend published it all the same — the server cannot say whether an earlier run's publish of it finished, and a page whose
// publish did not finish has to be published by the next run. So an unchanged rebuild of an app with ten pages made ten PublishXml calls of several seconds each (the release before pages went through the SDK
// re-uploaded and re-published every page of a full rebuild, so it paid them too). The build now keeps what it published in its workspace (lib/page-publish-records.js): the hash of each page's CONTENT and the
// version of each of its file rows, written once a publish was SEEN to take effect, and handed back to the next update — for a page whose file rows still have those versions — which publishes a page it finds
// already holding that content only if the hash is not that content's. These tests count what a rebuild asks of the page service, through the real backend over the stateful fake of the page tables.
const { readPublishedPages, publishedRecordPath } = require('../lib/page-publish-records.js');
const publishedOf = (spec, appDir) => readPublishedPages(path.join(appDir, '.maker-workspace'), appUniqueName(spec), BUILD_ENV);
// The requests the page service received from `from` on, by kind: change sets (one `$batch` is one atomic write), PublishXml, any other write, and reads.
function requestsOf(server, from = 0) {
  const received = server.requests.slice(from).filter((r) => !r.batched);
  const isPublish = (r) => r.method === 'POST' && /PublishXml/.test(r.path);
  const isChangeSet = (r) => r.method === 'POST' && r.path === '/$batch';
  return {
    changeSets: received.filter(isChangeSet).length,
    publishes: received.filter(isPublish).length,
    otherWrites: received.filter((r) => r.method !== 'GET' && !isPublish(r) && !isChangeSet(r)).length,
    reads: received.filter((r) => r.method === 'GET').length,
  };
}
// Two independent pages in a real temp folder: nothing navigates, so no source is rewritten on its way out and what a page holds is exactly its file.
function twoPageApp() {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-republish-'));
  const pages = [['alpha', 'Alpha'], ['beta', 'Beta']];
  for (const [key, name] of pages) fs.writeFileSync(path.join(appDir, `${key}.tsx`), PAGE_SOURCE.replace('Page()', `${name}()`).replace('>Page<', `>${name}<`), 'utf8');
  const spec = {
    schemaVersion: 2,
    solution: { uniqueName: 'RepublishSol', displayName: 'Republish', publisherPrefix: 'contoso' },
    app: { name: 'Republish App' },
    entities: [{ schemaName: 'contoso_item', displayName: 'Item', primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' }, columns: [] }],
    pages: pages.map(([key, name]) => ({ key, name, source: { kind: 'tsx', codeFile: `${key}.tsx` } })),
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Pages', subAreas: [{ page: 'alpha', title: 'Alpha' }, { page: 'beta', title: 'Beta' }, TABLE_ENTRY] }] }] },
  };
  return { appDir, spec };
}
// A rebuild of pages an earlier build left: the app's navigation holds them and the manifest names them, as the maker's app would, and the workspace folder is the one the earlier build wrote in.
// The page backend is a new one over the same service, as a new process has.
function rebuildPages(spec, appDir, server, ids, extra = {}) {
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, pages: spec.pages.map((p) => ({ key: p.key, name: p.name, pageId: ids[p.key] })) }), 'utf8').toString('base64');
  const { sdk } = mockSdk({ pageManifest: manifest, liveSitemapXml: pageSitemap(Object.values(ids)), pageRows: spec.pages.map((p) => ({ uxagentprojectid: ids[p.key], name: p.name })) });
  return buildPages(spec, appDir, realPageBackend(server), { sdk, ...extra });
}
// What a maker's save in the designer does: the page's draft no longer holds the file's source.
function makerSaves(server, pageId, text) {
  server.filesOf(pageId).find((f) => f.filename === 'src/pages/page.tsx').content = Buffer.from(text, 'utf8');
}

test('deploy: an UNCHANGED rebuild of an app with two pages sends no change set and no PublishXml — it only reads — and a rebuild that changes one page writes and publishes that page alone', async () => {
  const { appDir, spec } = twoPageApp();
  const server = new FakeGenPageServer();
  try {
    const first = await buildPages(spec, appDir, realPageBackend(server));
    const ids = { ...first.created.pages };
    assert.deepStrictEqual(Object.keys(ids).sort(), ['alpha', 'beta']);
    const created = requestsOf(server);
    assert.deepStrictEqual([created.changeSets, created.publishes], [2, 2], 'the first build creates both pages and publishes both');
    assert.deepStrictEqual([...publishedOf(spec, appDir).keys()].sort(), Object.values(ids).sort(), 'and records that it published them');

    // Nothing changed.
    let from = server.requests.length;
    const again = await rebuildPages(spec, appDir, server, ids);
    // `created.pages` is a null-prototype map (lib/own-keys.js), so its entries are compared with the plain copy `ids`.
    assert.deepStrictEqual({ ...again.created.pages }, ids, 'the same two pages');
    const unchanged = requestsOf(server, from);
    assert.deepStrictEqual([unchanged.changeSets, unchanged.publishes, unchanged.otherWrites], [0, 0, 0], 'an unchanged page costs no change set, no publish and no other write');
    assert.ok(unchanged.reads > 0, 'only reads: each page is read to see that it holds what the spec asks for');

    // One page's file changes.
    const edited = fs.readFileSync(path.join(appDir, 'beta.tsx'), 'utf8').replace('>Beta<', '>Beta, edited<');
    fs.writeFileSync(path.join(appDir, 'beta.tsx'), edited, 'utf8');
    const publishedBefore = server.published.length;
    from = server.requests.length;
    await rebuildPages(spec, appDir, server, ids);
    const changed = requestsOf(server, from);
    assert.deepStrictEqual([changed.changeSets, changed.publishes], [1, 1], 'one change set, for the page that changed, and one publish — the page next to it is neither written nor published');
    assert.deepStrictEqual(server.published.slice(publishedBefore), [ids.beta], 'and the page that was published is the one that changed');
    assert.strictEqual(server.rowText(ids.beta, 'src/pages/page.tsx'), edited);

    // The rebuild after that is unchanged again: what was published was recorded.
    from = server.requests.length;
    await rebuildPages(spec, appDir, server, ids);
    const settled = requestsOf(server, from);
    assert.deepStrictEqual([settled.changeSets, settled.publishes, settled.otherWrites], [0, 0, 0]);
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

// The kitchen-sink shape: one page links to the other. The target is created first, the linking page goes up with the target's id resolved into its text, and what is recorded for it is that text.
test('deploy: pages that link to each other are published once and then left alone — the linking page\'s resolved text is the content its record is of', async () => {
  const { appDir, spec } = makeTwoPageApp(); // overview links to detail
  const server = new FakeGenPageServer();
  try {
    const first = await buildPages(spec, appDir, realPageBackend(server));
    const ids = { ...first.created.pages };
    assert.deepStrictEqual(Object.keys(ids).sort(), ['detail', 'overview']);
    assert.ok(server.rowText(ids.overview, 'src/pages/page.tsx').includes(ids.detail), 'the linking page holds its target\'s id, resolved');
    assert.deepStrictEqual([...publishedOf(spec, appDir).keys()].sort(), Object.values(ids).sort(), 'both pages are recorded as published');

    const from = server.requests.length;
    const again = await rebuildPages(spec, appDir, server, ids);
    assert.deepStrictEqual({ ...again.created.pages }, ids);
    const unchanged = requestsOf(server, from);
    assert.deepStrictEqual([unchanged.changeSets, unchanged.publishes, unchanged.otherWrites], [0, 0, 0], 'an unchanged rebuild of linked pages writes and publishes nothing either');
    assert.ok(unchanged.reads > 0);
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('deploy: a rebuild after a publish that FAILED publishes that page — the convergence is kept — and still not the page that was published', async () => {
  const { appDir, spec } = twoPageApp();
  const server = new FakeGenPageServer();
  try {
    // Build 1 creates both pages; the first publish goes through and every later one is refused (HTTP 500). The second page is written and its id recorded, so the halt says it will be reused.
    let publishes = 0;
    server.failOn = (method, requestPath) => (/PublishXml/.test(requestPath) && (publishes += 1) > 1 ? 500 : undefined);
    await assert.rejects(buildPages(spec, appDir, realPageBackend(server)), (e) => e.phase === 'pages' && e.code === 'pages-publish-failed' && /page "Beta" was created as \S+ and saved, but publishing it failed/.test(e.message));
    const ids = Object.fromEntries(receiptsOf(spec, appDir).map((r) => [r.key, r.pageId]));
    assert.deepStrictEqual(Object.keys(ids).sort(), ['alpha', 'beta'], 'both pages are on the service, and both have a receipt');
    assert.deepStrictEqual([...publishedOf(spec, appDir).keys()], [ids.alpha], 'only the page whose publish took effect is recorded as published');

    // Build 2, the service healthy: Beta holds what the spec asks for — it was written — but was never published, so it is published now. Alpha was published, and is left alone.
    server.failOn = undefined;
    const publishedBefore = server.published.length;
    const from = server.requests.length;
    await rebuildPages(spec, appDir, server, ids);
    const rebuilt = requestsOf(server, from);
    assert.deepStrictEqual([rebuilt.changeSets, rebuilt.publishes], [0, 1], 'nothing is written again, and the one page whose publish failed is published');
    assert.deepStrictEqual(server.published.slice(publishedBefore), [ids.beta]);
    assert.deepStrictEqual([...publishedOf(spec, appDir).keys()].sort(), Object.values(ids).sort(), 'and both pages are recorded as published now');

    const next = server.requests.length;
    await rebuildPages(spec, appDir, server, ids);
    assert.strictEqual(requestsOf(server, next).publishes, 0, 'after which a rebuild publishes nothing');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

// What is recorded is the whole content, not the source: a page that was RENAMED and whose publish failed holds the new name, and the source that was recorded is still its source.
test('deploy: a page renamed by a rebuild whose publish failed is published by the next one, although its source is the recorded one — what is recorded is the whole content', async () => {
  const { appDir, spec } = twoPageApp();
  const server = new FakeGenPageServer();
  try {
    const first = await buildPages(spec, appDir, realPageBackend(server));
    const ids = { ...first.created.pages };
    spec.pages[1].name = 'Beta renamed';
    server.failOn = (method, requestPath) => (/PublishXml/.test(requestPath) ? 500 : undefined);
    await assert.rejects(rebuildPages(spec, appDir, server, ids), (e) => e.code === 'pages-publish-failed');
    assert.strictEqual(server.state.projects.get(ids.beta).name, 'Beta renamed', 'the rename was written');
    assert.strictEqual(server.rowText(ids.beta, 'src/pages/page.tsx'), fs.readFileSync(path.join(appDir, 'beta.tsx'), 'utf8'), 'and the source is the one that was published');

    server.failOn = undefined;
    const publishedBefore = server.published.length;
    const from = server.requests.length;
    await rebuildPages(spec, appDir, server, ids);
    const rebuilt = requestsOf(server, from);
    assert.deepStrictEqual([rebuilt.changeSets, rebuilt.publishes], [0, 1], 'the page holds the new name, and the name was never published');
    assert.deepStrictEqual(server.published.slice(publishedBefore), [ids.beta]);
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('deploy: a publish that was accepted but not SEEN to take effect is not recorded — the next rebuild publishes the page again, and once it is seen the page is left alone', async () => {
  const { appDir, spec } = twoPageApp();
  const server = new FakeGenPageServer();
  try {
    // The published projection has not caught up (PublishXml is asynchronous): the SDK can say the publish was submitted, not that it took effect.
    server.holdPublishedProjection = true;
    const warnings = [];
    const first = await buildPages(spec, appDir, realPageBackend(server), { warn: (m) => warnings.push(m) });
    const ids = { ...first.created.pages };
    assert.ok(warnings.some((m) => /could not be read back to confirm it/.test(m)), 'the build said so');
    assert.strictEqual(publishedOf(spec, appDir).size, 0, 'so nothing is recorded as published');

    server.holdPublishedProjection = false;
    let from = server.requests.length;
    await rebuildPages(spec, appDir, server, ids);
    assert.deepStrictEqual([requestsOf(server, from).changeSets, requestsOf(server, from).publishes], [0, 2], 'both pages are published again — they are not known to be published — and this time it is seen');
    assert.strictEqual(publishedOf(spec, appDir).size, 2);

    from = server.requests.length;
    await rebuildPages(spec, appDir, server, ids);
    assert.strictEqual(requestsOf(server, from).publishes, 0);
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('deploy: a record of a publish never stands in for a write — a page a maker changed since is written back and published, and the page next to it is left alone', async () => {
  const { appDir, spec } = twoPageApp();
  const server = new FakeGenPageServer();
  try {
    const first = await buildPages(spec, appDir, realPageBackend(server));
    const ids = { ...first.created.pages };
    makerSaves(server, ids.alpha, 'export default function Alpha() { return null; }\n');
    const publishedBefore = server.published.length;
    const from = server.requests.length;
    await rebuildPages(spec, appDir, server, ids);
    const rebuilt = requestsOf(server, from);
    assert.deepStrictEqual([rebuilt.changeSets, rebuilt.publishes], [1, 1], 'the file wins, as on any rebuild: one write and one publish');
    assert.deepStrictEqual(server.published.slice(publishedBefore), [ids.alpha]);
    assert.strictEqual(server.rowText(ids.alpha, 'src/pages/page.tsx'), fs.readFileSync(path.join(appDir, 'alpha.tsx'), 'utf8'));
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('deploy: a record that is missing, damaged or for another environment costs a publish and nothing else — the build goes on, and records again', async () => {
  const { appDir, spec } = twoPageApp();
  const server = new FakeGenPageServer();
  try {
    const first = await buildPages(spec, appDir, realPageBackend(server));
    const ids = { ...first.created.pages };
    const workspaceDir = path.join(appDir, '.maker-workspace');
    const file = publishedRecordPath(workspaceDir, appUniqueName(spec), BUILD_ENV);
    // Each damage is done to the record the step before it left valid.
    const damages = [
      ['missing', () => fs.rmSync(file)],
      ['torn', () => fs.writeFileSync(file, '{"schemaVersion":1,"pages":{', 'utf8')],
      ['written for another environment', () => fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/"environmentFingerprint":"[0-9a-f]{64}"/, `"environmentFingerprint":"${'0'.repeat(64)}"`), 'utf8')],
    ];
    for (const [what, damage] of damages) {
      damage();
      const from = server.requests.length;
      await rebuildPages(spec, appDir, server, ids);
      const rebuilt = requestsOf(server, from);
      assert.deepStrictEqual([rebuilt.changeSets, rebuilt.publishes], [0, 2], `${what}: both pages are published, and nothing is written`);
      assert.strictEqual(publishedOf(spec, appDir).size, 2, `${what}: and the record is made again`);
    }
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('deploy: a record that cannot be saved is ONE warning — the pages are still published and the build still finishes', async () => {
  const { appDir, spec } = twoPageApp();
  const server = new FakeGenPageServer();
  try {
    // The record's name is taken by a folder, so the atomic rename onto it fails.
    const workspaceDir = path.join(appDir, '.maker-workspace');
    fs.mkdirSync(publishedRecordPath(workspaceDir, appUniqueName(spec), BUILD_ENV), { recursive: true });
    const warnings = [];
    const first = await buildPages(spec, appDir, realPageBackend(server), { warn: (m) => warnings.push(m) });
    assert.deepStrictEqual(Object.keys(first.created.pages).sort(), ['alpha', 'beta']);
    assert.strictEqual(requestsOf(server).publishes, 2, 'both pages were published');
    const said = warnings.filter((m) => /could not save which pages this build published/.test(m));
    assert.strictEqual(said.length, 1, `said once, not once per page: ${warnings.join(' | ')}`);
    assert.match(said[0], /so the next build publishes them again/);
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

// ── A page that holds bindings, rebuilt by the spec a download wrote ─────────────────────────────────────────────────────────────────────────
// A page's connector and Custom API bindings are in the spec a download writes (pages[].connectorBindings, pages[].actionBindings), and the build sends them with the page's content. The record of a publish is the
// hash of that content, and the record an earlier build made of a page it published was made when the build stated no lists: it is the hash of the content WITHOUT them. The page has not changed, and the first
// rebuild after a download used to meet a hash it did not know and publish every such page again — one PublishXml of several seconds each. It must not: the page is neither written nor published, and its record is
// renewed, so the build after it asks nothing more of the published copy. What stays as it was: a page the spec CHANGES is written and published, and so is one whose published copy does not hold the lists.
const { contentFingerprint } = require('../lib/genpage-sdk.js');
const HELD_WEATHER = { logicalName: 'contoso_msnweather', connectorId: '/providers/Microsoft.PowerApps/apis/shared_msnweather', dataset: '', operations: ['CurrentWeather'] };
const HELD_APPROVE = { name: 'contoso_ApproveOrder', isFunction: false, boundEntityLogicalName: 'contoso_item', displayName: 'Approve order', parameterKinds: { Comment: 'String' } };
const STATED_LISTS = { connectorBindings: [HELD_WEATHER], actionBindings: [HELD_APPROVE] };
const CONNECTION_PLACEHOLDER = 'env-local-connection-placeholder';

// The environment of an app whose pages the maker laid out: the first holds bindings (and, with `extras`, a connection id a spec does not state), the second none. Each page's file is what the spec points at, so the
// pages hold what the spec asks for and a rebuild has nothing to write.
function seededBindingApp({ extras = true } = {}) {
  const { appDir, spec } = twoPageApp();
  const server = new FakeGenPageServer();
  const ids = { alpha: 'a1000000-0000-4000-8000-000000000001', beta: 'a2000000-0000-4000-8000-000000000002' };
  for (const [key, id] of Object.entries(ids)) {
    const page = spec.pages.find((p) => p.key === key);
    const lists = key === 'alpha' ? { connectorBindings: [extras ? { ...HELD_WEATHER, connectionId: CONNECTION_PLACEHOLDER } : HELD_WEATHER], actionBindings: [HELD_APPROVE] } : {};
    server.seedPage(id, { name: page.name, source: fs.readFileSync(path.join(appDir, `${key}.tsx`), 'utf8'), config: { dataSources: [], model: '', ...lists } });
  }
  return { appDir, spec, server, ids };
}
const quiet = (requests) => [requests.changeSets, requests.publishes, requests.otherWrites];

test('deploy: a page that holds bindings, built by a spec that stated none and then by the spec a download wrote, is neither written nor published by the second build — the record of its publish stands, and is renewed', async () => {
  for (const extras of [false, true]) {
    const { appDir, spec, server, ids } = seededBindingApp({ extras });
    try {
      // Build 1, as every build was before a spec could state the lists: the pages hold what the spec asks for, so they are only published, and the publish is recorded — with no lists in its hash.
      await rebuildPages(spec, appDir, server, ids);
      assert.deepStrictEqual([...publishedOf(spec, appDir).keys()].sort(), Object.values(ids).sort());
      const legacy = publishedOf(spec, appDir).get(ids.alpha).fingerprint;
      const betaRecord = publishedOf(spec, appDir).get(ids.beta);

      // The download states the bindings, without what a spec does not state.
      Object.assign(spec.pages[0], STATED_LISTS);
      const alphaSource = fs.readFileSync(path.join(appDir, 'alpha.tsx'), 'utf8');
      const stated = contentFingerprint({ source: alphaSource, name: 'Alpha', dataSources: [], ...STATED_LISTS });
      assert.notStrictEqual(stated, legacy, 'the lists are part of the hash');
      const publishedBefore = server.published.length;
      let from = server.requests.length;
      await rebuildPages(spec, appDir, server, ids);
      assert.deepStrictEqual(quiet(requestsOf(server, from)), [0, 0, 0], `extras ${extras}: neither a change set, nor a publish, nor any other write — only reads`);
      assert.strictEqual(server.published.length, publishedBefore);
      const renewed = publishedOf(spec, appDir).get(ids.alpha);
      assert.strictEqual(renewed.fingerprint, stated, 'the record is now the hash of what the spec states');
      assert.deepStrictEqual(renewed.files, versionsNow(server, ids.alpha), 'with the versions the page has: nothing moved it');
      assert.deepStrictEqual(publishedOf(spec, appDir).get(ids.beta), betaRecord, 'a page that states none keeps its record as it was');
      const held = JSON.parse(server.rowText(ids.alpha, 'config.json'));
      assert.strictEqual(held.connectorBindings[0].connectionId, extras ? CONNECTION_PLACEHOLDER : undefined, 'the page keeps what the spec could not state');

      // And the build after it asks nothing: the record is the hash as it is, and the published copy is not read again to see that it holds the lists.
      from = server.requests.length;
      await rebuildPages(spec, appDir, server, ids);
      assert.deepStrictEqual(quiet(requestsOf(server, from)), [0, 0, 0]);
      assert.strictEqual(server.requests.slice(from).filter((r) => r.method === 'GET' && /^\/uxagentproject/.test(r.path) && !('MSCRM.IncludeUnpublished' in r.headers) && !/versionnumber/.test(r.path)).length, 0, 'no read of the published copy: the versions the record is held to are the only plain reads');
    } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
  }
});

test('deploy: the renewed record is no licence — a page a maker saved since is published again, and a page the spec changes is written and published whatever was recorded', async () => {
  const { appDir, spec, server, ids } = seededBindingApp();
  try {
    await rebuildPages(spec, appDir, server, ids);
    Object.assign(spec.pages[0], STATED_LISTS);
    await rebuildPages(spec, appDir, server, ids);
    const config = JSON.parse(server.rowText(ids.alpha, 'config.json'));

    // A maker saves the page's settings as a draft, adding a setting and nothing else: the page's files moved, so the record no longer stands and the page is published once — with nothing to write.
    server.otherWorkspaceDraft(ids.alpha, 'config.json', JSON.stringify({ ...config, futureSetting: { kept: true } }));
    let from = server.requests.length;
    await rebuildPages(spec, appDir, server, ids);
    assert.deepStrictEqual(quiet(requestsOf(server, from)), [0, 1, 0], 'a publish, and no write');
    from = server.requests.length;
    await rebuildPages(spec, appDir, server, ids);
    assert.deepStrictEqual(quiet(requestsOf(server, from)), [0, 0, 0], 'after which it is left alone again');

    // The spec edits a binding: the page is written — one change set — and published, and keeps what the spec could not state of the entry it changes.
    spec.pages[0].connectorBindings = [{ ...HELD_WEATHER, operations: ['Forecast'] }];
    from = server.requests.length;
    await rebuildPages(spec, appDir, server, ids);
    assert.deepStrictEqual(quiet(requestsOf(server, from)), [1, 1, 0]);
    const edited = JSON.parse(server.rowText(ids.alpha, 'config.json'));
    assert.deepStrictEqual(edited.connectorBindings, [{ ...HELD_WEATHER, connectionId: CONNECTION_PLACEHOLDER, operations: ['Forecast'] }]);
    assert.deepStrictEqual(edited.futureSetting, { kept: true });
    // The write was published and recorded, with the lists in the hash: the next build leaves the page alone.
    from = server.requests.length;
    await rebuildPages(spec, appDir, server, ids);
    assert.deepStrictEqual(quiet(requestsOf(server, from)), [0, 0, 0]);
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('deploy: a page whose record names ONE of its lists, built by a spec that states both, is neither written nor published — a list stated for the first time is no change to the page', async () => {
  const { appDir, spec, server, ids } = seededBindingApp({ extras: false });
  try {
    // The first build states the page's connector bindings and not its Custom API bindings: the page is published, and the record is the hash of its content with that one list.
    spec.pages[0].connectorBindings = STATED_LISTS.connectorBindings;
    await rebuildPages(spec, appDir, server, ids);
    const alphaSource = fs.readFileSync(path.join(appDir, 'alpha.tsx'), 'utf8');
    assert.strictEqual(publishedOf(spec, appDir).get(ids.alpha).fingerprint, contentFingerprint({ source: alphaSource, name: 'Alpha', dataSources: [], connectorBindings: STATED_LISTS.connectorBindings }));
    // The next states the Custom API bindings too, which the page holds: nothing is written, nothing is published, and the record is renewed to name both lists.
    spec.pages[0].actionBindings = STATED_LISTS.actionBindings;
    const from = server.requests.length;
    await rebuildPages(spec, appDir, server, ids);
    assert.deepStrictEqual(quiet(requestsOf(server, from)), [0, 0, 0], 'neither a change set, nor a publish, nor any other write — only reads');
    assert.strictEqual(publishedOf(spec, appDir).get(ids.alpha).fingerprint, contentFingerprint({ source: alphaSource, name: 'Alpha', dataSources: [], ...STATED_LISTS }));
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

// ── a changed-only run checks the bindings of the pages it writes, and only those ────────────────────────────────────────────────────────────
test('changed-only: a binding whose reference is another connector\'s stops a run that writes its page before anything is uploaded — and does not stop one that leaves the page alone', async () => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-bindings-'));
  try {
    fs.writeFileSync(path.join(appDir, 'overview.tsx'), 'export default function O(){ return null; }', 'utf8');
    fs.writeFileSync(path.join(appDir, 'detail.tsx'), 'export default function D(){ return null; }', 'utf8');
    const spec = {
      schemaVersion: 2,
      solution: { uniqueName: 'SelBindings', displayName: 'S', publisherPrefix: 'contoso' },
      app: { name: 'Sel Bindings App' },
      entities: [{ schemaName: 'contoso_item', displayName: 'Item', primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' }, columns: [] }],
      pages: [
        { key: 'overview', name: 'Overview', source: { kind: 'tsx', codeFile: 'overview.tsx' } },
        { key: 'detail', name: 'Detail', source: { kind: 'tsx', codeFile: 'detail.tsx' }, connectorBindings: [HELD_WEATHER] },
      ],
      appShell: { areas: [{ label: 'Main', groups: [{ label: 'G', subAreas: [{ page: 'overview', title: 'Overview' }, { page: 'detail', title: 'Detail' }] }] }] },
    };
    const live = [{ pageId: OVERVIEW_ID, name: 'Overview' }, { pageId: DETAIL_ID, name: 'Detail' }];
    const manifest = { schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: OVERVIEW_ID }, { key: 'detail', name: 'Detail', pageId: DETAIL_ID }] };
    const environment = () => {
      const { sdk } = mockSdk({ pageManifest: Buffer.from(JSON.stringify(manifest), 'utf8').toString('base64'), liveSitemapXml: pageSitemap([OVERVIEW_ID, DETAIL_ID]), pageRows: live.map((p) => ({ uxagentprojectid: p.pageId, name: p.name })) });
      const answer = sdk.queryRecords;
      sdk.queryRecords = async (entity, options) => (entity === 'connectionreference'
        ? [{ connectionreferencelogicalname: 'contoso_msnweather', connectorid: '/providers/Microsoft.PowerApps/apis/shared_office365users' }]
        : answer(entity, options));
      return sdk;
    };
    const run = (selectedKeys, genpageCli) => runSdkBuild(spec, { sdk: environment(), apply: true, env: 'https://x', appDir, genpageCli, phases: PAGES_ONLY, changedOnly: { fastApply: true, resolvedAppId: APP_ID, skipSitemapFinalize: true, selectedKeys } });

    const left = mockGenpageCli(live);
    const fine = await run(['overview'], left);
    assert.ok(fine.ok);
    assert.deepStrictEqual(left.uploads.map((u) => u.name), ['Overview'], 'the page that is not written is not held to its bindings');

    const stopped = mockGenpageCli(live);
    await assert.rejects(run(['detail'], stopped), (e) => e.code === 'pages-binding-reference-conflict' && e.phase === 'preflight' && /page "Detail": connector binding "contoso_msnweather" is for connector shared_msnweather/.test(e.message));
    assert.deepStrictEqual(stopped.uploads, [], 'and nothing was uploaded');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

// ── a changed-only run leaves alone the bindings of a navigation target that exists ─────────────────────────────────────────────────────────
// Three pages: Alpha, Bravo — which navigates to Charlie — and Charlie, whose connector binding goes through `contoso_msnweather`, a connection reference this environment holds for ANOTHER connector. A
// changed-only run writes the pages it selected, and makes a navigation target only when the target is ABSENT (from its spec entry, bindings and all); one that exists it leaves as it is. Which targets exist
// is settled by the pages phase, after the check before writing, so the changed-only flow tells the build the pages its last verified apply deployed (`deployedKeys`): such a target is not checked, and one
// the pages phase then finds absent after all is checked there, before it is made. A run told nothing, a run that writes before its pages phase, and a full build check every target, as they always did.
const ABC_IDS = { alpha: 'a1a1a1a1-0000-4000-8000-00000000000a', bravo: 'b2b2b2b2-0000-4000-8000-00000000000b', charlie: 'c3c3c3c3-0000-4000-8000-00000000000c' };
const ABC_NAMES = { alpha: 'Alpha', bravo: 'Bravo', charlie: 'Charlie' };
const ABC_KEYS = Object.keys(ABC_IDS);
const reference = (logicalName, connector) => ({ connectionreferencelogicalname: logicalName, connectorid: `/providers/Microsoft.PowerApps/apis/${connector}`, connectionid: `${connector}-0001`, _customconnectorid_value: null });
// Charlie's reference, as the environment holds it: for another connector than Charlie's binding says.
const CHARLIE_REFERENCE = reference('contoso_msnweather', 'shared_office365users');
const SHAREPOINT_BINDING = { logicalName: 'contoso_sharepoint', connectorId: '/providers/Microsoft.PowerApps/apis/shared_sharepointonline', dataset: 'https://contoso.sharepoint.com/sites/x', tables: ['11111111-2222-3333-4444-555555555555'] };

// `present`: the pages the environment holds — the rest are absent, as a page deleted in Maker since the last apply is. `recorded`: the pages the app's manifest and navigation still name (by default
// the present ones; a page deleted in Maker stays in both). `alpha`: what Alpha states besides its source.
function abcApp({ present = ABC_KEYS, recorded = present, alpha = {} } = {}) {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abc-bindings-'));
  fs.writeFileSync(path.join(appDir, 'alpha.tsx'), 'export default function A(){ return null; }', 'utf8');
  fs.writeFileSync(path.join(appDir, 'bravo.tsx'), `export default function B(){ ${NAV('charlie')} return null; }`, 'utf8');
  fs.writeFileSync(path.join(appDir, 'charlie.tsx'), 'export default function C(){ return null; }', 'utf8');
  const spec = {
    schemaVersion: 2,
    solution: { uniqueName: 'AbcBindings', displayName: 'Abc', publisherPrefix: 'contoso' },
    app: { name: 'Abc Bindings App' },
    entities: [{ schemaName: 'contoso_item', displayName: 'Item', primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' }, columns: [] }],
    pages: [
      { key: 'alpha', name: 'Alpha', source: { kind: 'tsx', codeFile: 'alpha.tsx' }, ...alpha },
      { key: 'bravo', name: 'Bravo', navigatesTo: [{ targetKey: 'charlie' }], source: { kind: 'tsx', codeFile: 'bravo.tsx' } },
      { key: 'charlie', name: 'Charlie', source: { kind: 'tsx', codeFile: 'charlie.tsx' }, connectorBindings: [HELD_WEATHER] },
    ],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'G', subAreas: [...ABC_KEYS.map((key) => ({ page: key, title: ABC_NAMES[key] })), TABLE_ENTRY] }] }] },
  };
  const live = present.map((key) => ({ pageId: ABC_IDS[key], name: ABC_NAMES[key] }));
  const manifest = { schemaVersion: 1, pages: recorded.map((key) => ({ key, name: ABC_NAMES[key], pageId: ABC_IDS[key] })) };
  // Every read of what the bindings name, every read of the generative pages in the saved layer, and every write to the SDK, whatever the run.
  const reads = [];
  const pageReads = [];
  const writes = [];
  // `references`: the rows the environment answers for connection references — or a function of the read's number (1, 2, …) that answers them, or throws as a refused read does.
  // `failPageRows`: the read of the generative pages in the saved layer is refused.
  const run = (options, references = [CHARLIE_REFERENCE], { failPageRows = false } = {}) => {
    const { sdk } = mockSdk({ pageManifest: Buffer.from(JSON.stringify(manifest), 'utf8').toString('base64'), liveSitemapXml: pageSitemap(recorded.map((key) => ABC_IDS[key])), pageRows: live.map((p) => ({ uxagentprojectid: p.pageId, name: p.name })) });
    const answer = sdk.queryRecords;
    sdk.queryRecords = async (entity, query) => {
      if (!['connectionreference', 'customapi', 'connector'].includes(entity)) return answer(entity, query);
      reads.push({ entity, filter: query && query.filter });
      if (typeof references === 'function') return references(entity, reads.length);
      return entity === 'connectionreference' ? references : [];
    };
    // The generative pages in the SAVED layer, by id (lib/app-components.js savedPageRows), as the environment holds them:
    //   GET /uxagentprojects/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=uxagentprojectid,name,componentstate&$filter=uxagentprojectid eq <id> or uxagentprojectid eq <id>
    const get = sdk.dataverse.get;
    sdk.dataverse.get = async (url) => {
      if (!url.startsWith('/uxagentprojects/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()')) return get(url);
      pageReads.push(url);
      if (failPageRows) return { status: 503, body: { error: { message: 'Service Unavailable' } } };
      const asked = [...url.matchAll(/uxagentprojectid eq ([0-9a-f-]{36})/gi)].map((m) => m[1].toLowerCase());
      return { status: 200, body: { value: live.filter((p) => asked.includes(p.pageId.toLowerCase())).map((p) => ({ uxagentprojectid: p.pageId, name: p.name, componentstate: 0 })) } };
    };
    for (const method of Object.keys(sdk).filter((name) => /^(create|update|push|publish|add|remove|set|enrich|seed)/.test(name))) {
      const original = sdk[method];
      sdk[method] = (...args) => { writes.push(method); return original(...args); };
    }
    const genpage = abcGenpage(live);
    return { genpage, built: runSdkBuild(spec, { sdk, env: 'https://x', appDir, genpageCli: genpage, apply: true, phases: PAGES_ONLY, ...options }) };
  };
  return { appDir, spec, reads, pageReads, writes, run };
}

// The page backend of the three pages: the environment's pages are `live`, and a create makes the page under its own id.
function abcGenpage(live) {
  const uploads = [];
  const answer = (o, pageId) => ({ pageId, name: o.name, publish: { kind: 'verified', detail: '' }, warnings: [] });
  return {
    uploads,
    enumerateEnv: async () => ({ ok: true, ids: live.map((p) => p.pageId.toLowerCase()), pages: live }),
    create: async (o) => {
      const key = ABC_KEYS.find((k) => ABC_NAMES[k] === o.name);
      uploads.push(`create ${o.name}`);
      return answer(o, ABC_IDS[key]);
    },
    update: async (id, o) => { uploads.push(`update ${o.name}`); return answer(o, id); },
    placeInApp: async () => ({ added: [], alreadyPlaced: [], pinnedViews: [], warnings: [], appEdited: false }),
  };
}
const fastApply = (selectedKeys, extra = {}) => ({ changedOnly: { fastApply: true, resolvedAppId: APP_ID, skipSitemapFinalize: true, selectedKeys, ...extra } });
const conflictOn = (page) => (e) => e.code === 'pages-binding-reference-conflict' && e.phase === 'preflight' && e.recoverable === false && e.transient === false
  && new RegExp(`page "${page}": connector binding "[a-z_]+" is for connector shared_[a-z0-9]+, but the connection reference of that name in this environment is for connector shared_[a-z0-9]+`).test(e.message)
  && /The build stopped before writing anything\./.test(e.message);

test('changed-only: an edit of one page leaves alone the bindings of a navigation target that exists — not read, not refused, not said — though its reference is another connector\'s', async () => {
  const app = abcApp();
  try {
    const warnings = [];
    const { genpage, built } = app.run({ ...fastApply(['alpha'], { deployedKeys: ABC_KEYS }), warn: (m) => warnings.push(String(m)) });
    const result = await built;
    assert.ok(result.ok, JSON.stringify(result));
    assert.deepStrictEqual(genpage.uploads, ['update Alpha'], 'Alpha alone is written: Charlie exists, so it is not made, and Bravo is not selected');
    assert.deepStrictEqual(app.reads, [], 'no page the run writes states a binding, so nothing is read of what bindings name');
    assert.deepStrictEqual(warnings.filter((w) => /contoso_msnweather|"Charlie"/.test(w)), [], 'and nothing is said of Charlie\'s binding');
  } finally { fs.rmSync(app.appDir, { recursive: true, force: true }); }
});

test('changed-only: the read is for the bindings of the pages the run writes — a target that exists adds no name to it', async () => {
  const app = abcApp({ alpha: { connectorBindings: [SHAREPOINT_BINDING] } });
  try {
    const { genpage, built } = app.run(fastApply(['alpha'], { deployedKeys: ABC_KEYS }), [CHARLIE_REFERENCE, reference('contoso_sharepoint', 'shared_sharepointonline')]);
    assert.ok((await built).ok);
    assert.deepStrictEqual(genpage.uploads, ['update Alpha']);
    assert.deepStrictEqual(app.reads.map((r) => r.entity), ['connectionreference'], 'one read of the references, as for any page that states a connector binding');
    assert.strictEqual(app.reads[0].filter, "connectionreferencelogicalname eq 'contoso_sharepoint'", 'for Alpha\'s reference alone');
  } finally { fs.rmSync(app.appDir, { recursive: true, force: true }); }
});

test('changed-only: a page the run writes is still refused for a reference that is another connector\'s — before anything is written', async () => {
  const app = abcApp({ alpha: { connectorBindings: [SHAREPOINT_BINDING] } });
  try {
    const { genpage, built } = app.run(fastApply(['alpha'], { deployedKeys: ABC_KEYS }), [CHARLIE_REFERENCE, reference('contoso_sharepoint', 'shared_office365users')]);
    await assert.rejects(built, conflictOn('Alpha'));
    assert.deepStrictEqual(genpage.uploads, [], 'nothing was uploaded');
    assert.deepStrictEqual(app.writes, [], 'and nothing else was written');
  } finally { fs.rmSync(app.appDir, { recursive: true, force: true }); }
});

test('changed-only: an ABSENT navigation target is made by the run, bindings and all, so it is refused before anything is written — told of the pages that exist, or told nothing', async () => {
  for (const extra of [{ deployedKeys: ['alpha', 'bravo'] }, {}]) {
    const app = abcApp({ present: ['alpha', 'bravo'] });
    try {
      const { genpage, built } = app.run(fastApply(['alpha'], extra));
      await assert.rejects(built, conflictOn('Charlie'), JSON.stringify(extra));
      assert.deepStrictEqual(genpage.uploads, [], 'Charlie was not made, and Alpha not written');
      assert.deepStrictEqual(app.writes, []);
    } finally { fs.rmSync(app.appDir, { recursive: true, force: true }); }
  }
});

// The flow's record is of its last verified apply, and a maker can delete a page in Maker after it. The run is then told Charlie exists, and the pages phase finds it absent and makes it from its spec entry:
// its bindings are checked there, before the first page is written, with the same halt — never left unchecked because the record said the page was there.
test('changed-only: a target the run was told exists, and finds absent, is checked before it is made — the same halt, and nothing written', async () => {
  const app = abcApp({ present: ['alpha', 'bravo'] });
  try {
    const { genpage, built } = app.run(fastApply(['alpha'], { deployedKeys: ABC_KEYS }));
    await assert.rejects(built, (e) => conflictOn('Charlie')(e) && /^1 connector binding\(s\) name a connection reference this environment already has for ANOTHER connector: /.test(e.message));
    assert.deepStrictEqual(genpage.uploads, [], 'Charlie was not made, and Alpha not written');
    assert.deepStrictEqual(app.writes, [], 'and nothing else was written');
    assert.deepStrictEqual(app.reads, [{ entity: 'connectionreference', filter: "connectionreferencelogicalname eq 'contoso_msnweather'" }], 'Charlie\'s reference was read once, when the run found it was to make the page');
  } finally { fs.rmSync(app.appDir, { recursive: true, force: true }); }
});

test('changed-only: a run that is told nothing of which pages exist checks every navigation target before it writes anything, as before', async () => {
  const app = abcApp();
  try {
    const { genpage, built } = app.run(fastApply(['alpha']));
    await assert.rejects(built, conflictOn('Charlie'));
    assert.deepStrictEqual(genpage.uploads, []);
    assert.deepStrictEqual(app.writes, []);
  } finally { fs.rmSync(app.appDir, { recursive: true, force: true }); }
});

test('a full build writes every page, so a target\'s binding is refused before anything is written — and so is it in a changed-only run that writes before its pages phase, whatever it is told', async () => {
  for (const extra of [{}, { changedOnly: { selectedKeys: ['alpha'], deployedKeys: ABC_KEYS } }]) {
    const app = abcApp();
    try {
      const { genpage, built } = app.run({ phases: PHASES, ...extra });
      await assert.rejects(built, conflictOn('Charlie'), JSON.stringify(extra));
      assert.deepStrictEqual(genpage.uploads, []);
      assert.deepStrictEqual(app.writes, [], 'no solution, table, app or page');
    } finally { fs.rmSync(app.appDir, { recursive: true, force: true }); }
  }
});

test('changed-only: a dry run marks the pages an apply would stop at, and no other — by the same rule', async () => {
  const marked = async (options, present) => {
    const app = abcApp(present ? { present, alpha: options.alpha } : { alpha: options.alpha });
    try {
      const { built } = app.run({ ...fastApply(['alpha'], options.extra), apply: false }, options.references);
      const planned = await built;
      assert.strictEqual(planned.dryRun, true);
      return { halts: planned.planItems.filter((item) => item.wouldHalt).map((item) => item.label), reads: app.reads.length };
    } finally { fs.rmSync(app.appDir, { recursive: true, force: true }); }
  };
  assert.deepStrictEqual(await marked({ extra: { deployedKeys: ABC_KEYS } }), { halts: [], reads: 0 }, 'Charlie exists: an apply writes Alpha alone');
  assert.deepStrictEqual(await marked({ extra: { deployedKeys: ['alpha', 'bravo'] } }, ['alpha', 'bravo']), { halts: ['page "Charlie"'], reads: 1 }, 'Charlie is absent: an apply makes it, and stops');
  assert.deepStrictEqual(await marked({ extra: {} }), { halts: ['page "Charlie"'], reads: 1 }, 'told nothing, the plan checks every target, as the apply does');
  const alphaConflict = { alpha: { connectorBindings: [SHAREPOINT_BINDING] }, references: [CHARLIE_REFERENCE, reference('contoso_sharepoint', 'shared_office365users')] };
  assert.deepStrictEqual(await marked({ ...alphaConflict, extra: { deployedKeys: ABC_KEYS } }), { halts: ['page "Alpha"'], reads: 1 }, 'the page an apply writes is marked');
});

// Alpha and Charlie name the same connection reference. Alpha's binding states the connector the environment's reference is for, so Alpha is fine; Charlie's states another, so Charlie's
// conflicts. Charlie was deleted in Maker since the last apply, while the run is told it is deployed: the check before writing reads the reference for Alpha, and the pages phase, about to
// make Charlie, judges Charlie by what that read answered. A name is read once per attempt — so a second read cannot be refused and turn the proven conflict into "not checked".
const SHARED_NAME_ALPHA = { connectorBindings: [{ ...HELD_WEATHER, connectorId: CHARLIE_REFERENCE.connectorid, operations: [] }] };

test('changed-only: a target found absent is judged by what the attempt already read of a name it shares — a later read that would fail cannot let it be made unchecked', async () => {
  const app = abcApp({ present: ['alpha', 'bravo'], recorded: ABC_KEYS, alpha: SHARED_NAME_ALPHA });
  try {
    const { genpage, built } = app.run(fastApply(['alpha'], { deployedKeys: ABC_KEYS }), (entity, number) => {
      if (number === 1) return [CHARLIE_REFERENCE];
      throw new Error('connectionreference: HTTP 403');
    });
    await assert.rejects(built, conflictOn('Charlie'));
    assert.deepStrictEqual(genpage.uploads, [], 'Charlie was not made, and Alpha not written');
    assert.deepStrictEqual(app.writes, [], 'and nothing else was written');
    assert.deepStrictEqual(app.reads, [{ entity: 'connectionreference', filter: "connectionreferencelogicalname eq 'contoso_msnweather'" }], 'the shared name was read once, before anything was written');
  } finally { fs.rmSync(app.appDir, { recursive: true, force: true }); }
});

test('changed-only: a name the check before writing read is not read again for a target found absent — one read of it in the attempt, as before the fix', async () => {
  const app = abcApp({ present: ['alpha', 'bravo'], recorded: ABC_KEYS, alpha: SHARED_NAME_ALPHA });
  try {
    const { genpage, built } = app.run(fastApply(['alpha'], { deployedKeys: ABC_KEYS }));
    await assert.rejects(built, conflictOn('Charlie'));
    assert.deepStrictEqual(genpage.uploads, []);
    assert.strictEqual(app.reads.length, 1, 'the reference is read once in the attempt');
  } finally { fs.rmSync(app.appDir, { recursive: true, force: true }); }
});

// A dry run has no pages phase to find a target absent, so for each target it was told is deployed it asks the environment, read only, whether the page is still there — and checks the one that is
// not, as the apply will. Plan and apply are run here with the SAME options against the SAME environment.
test('changed-only: a dry run finds a target it was told is deployed absent, and marks it — as the apply with the same options and environment stops on it', async () => {
  const app = abcApp({ present: ['alpha', 'bravo'], recorded: ABC_KEYS });
  try {
    const options = fastApply(['alpha'], { deployedKeys: ABC_KEYS });
    const planned = await app.run({ ...options, apply: false }).built;
    assert.strictEqual(planned.dryRun, true);
    assert.deepStrictEqual(planned.planItems.filter((item) => item.wouldHalt).map((item) => item.label), ['page "Charlie"']);
    assert.strictEqual(app.pageReads.length, 1, 'one read of the pages, for the target it was told is deployed');
    assert.strictEqual(app.reads.length, 1, 'and Charlie\'s reference, which the apply reads too');
    const { genpage, built } = app.run(options);
    await assert.rejects(built, conflictOn('Charlie'));
    assert.deepStrictEqual(genpage.uploads, []);
  } finally { fs.rmSync(app.appDir, { recursive: true, force: true }); }
});

test('changed-only: a dry run that finds the target it was told is deployed still there leaves its binding unread — one read of the pages, none of references', async () => {
  const app = abcApp();
  try {
    const planned = await app.run({ ...fastApply(['alpha'], { deployedKeys: ABC_KEYS }), apply: false }).built;
    assert.deepStrictEqual(planned.planItems.filter((item) => item.wouldHalt), []);
    assert.strictEqual(app.pageReads.length, 1);
    assert.deepStrictEqual(app.reads, []);
  } finally { fs.rmSync(app.appDir, { recursive: true, force: true }); }
});

test('changed-only: a dry run told a target is deployed that neither the spec nor the manifest gives an id checks it — there is no page to ask the environment about', async () => {
  const app = abcApp({ present: ['alpha', 'bravo'] });
  try {
    const planned = await app.run({ ...fastApply(['alpha'], { deployedKeys: ABC_KEYS }), apply: false }).built;
    assert.deepStrictEqual(planned.planItems.filter((item) => item.wouldHalt).map((item) => item.label), ['page "Charlie"']);
    assert.strictEqual(app.pageReads.length, 0);
    assert.strictEqual(app.reads.length, 1);
  } finally { fs.rmSync(app.appDir, { recursive: true, force: true }); }
});

// A dry run that cannot tell whether such a target is still there checks it, as if the apply will make it — never the record of an earlier apply taken as proof. It says so: the mark may be one
// the apply does not make (Charlie IS there, so the apply below writes Alpha alone).
test('changed-only: a dry run that cannot read whether a target it was told is deployed is there checks it, and says why — fail closed', async () => {
  const app = abcApp();
  try {
    const options = fastApply(['alpha'], { deployedKeys: ABC_KEYS });
    const warnings = [];
    const planned = await app.run({ ...options, apply: false, warn: (m) => warnings.push(String(m)) }, undefined, { failPageRows: true }).built;
    assert.deepStrictEqual(planned.planItems.filter((item) => item.wouldHalt).map((item) => item.label), ['page "Charlie"']);
    const said = warnings.filter((w) => /recorded as deployed/.test(w));
    assert.strictEqual(said.length, 1, warnings.join('\n'));
    assert.match(said[0], /^could not tell whether page "Charlie", recorded as deployed, is still in this environment \(the pages recorded as deployed: HTTP 503 .*\), so its bindings are checked as if the build will make it$/);
    const { genpage, built } = app.run(options);
    assert.ok((await built).ok);
    assert.deepStrictEqual(genpage.uploads, ['update Alpha']);
  } finally { fs.rmSync(app.appDir, { recursive: true, force: true }); }
});

test('deploy: the record keeps only the pages the spec still binds — a page it no longer names is dropped when the next is written', async () => {
  const { appDir, spec } = twoPageApp();
  const server = new FakeGenPageServer();
  try {
    const first = await buildPages(spec, appDir, realPageBackend(server));
    const ids = { ...first.created.pages };
    // An entry for a page that no key is bound to — a page that was deleted, or replaced — is in the record.
    const workspaceDir = path.join(appDir, '.maker-workspace');
    const stale = 'ffffffff-0000-4000-8000-00000000ffff';
    const { writePublishedPages } = require('../lib/page-publish-records.js');
    writePublishedPages(workspaceDir, appUniqueName(spec), BUILD_ENV, new Map([...publishedOf(spec, appDir), [stale, { fingerprint: sha256('gone') }]]));
    assert.ok(publishedOf(spec, appDir).has(stale));
    // Beta changes, so its publish writes the record again.
    fs.writeFileSync(path.join(appDir, 'beta.tsx'), fs.readFileSync(path.join(appDir, 'beta.tsx'), 'utf8').replace('>Beta<', '>Beta 2<'), 'utf8');
    await rebuildPages(spec, appDir, server, ids);
    assert.deepStrictEqual([...publishedOf(spec, appDir).keys()].sort(), Object.values(ids).sort(), 'the two pages of the app, and not the one nothing is bound to');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

// ── A page published from somewhere else is published again ────────────────────────────────────────────────────────────────────────────────────
// The record of a publish is the hash of the content AND the versionnumber of every file row of the page, read (with a plain GET) right after the publish was seen to take effect. The hash says what this
// workspace sent; the versions say that nothing has moved the page's files since — MEASURED: publishing new content, or saving a file as a draft, moves the version of each file row it changes, and a row
// that did not change keeps its own. So an unchanged page skips its publish only while its files read as they did, and a page published from another workspace, another machine or Maker — then put back to the
// file's content as a draft, which the hash alone cannot tell from a page that is live — is published again. The fake page service models those versions (helpers/fake-genpage-server.js).
const isVersionRead = (requestPath) => /^\/uxagentprojectfiles\?.*versionnumber/.test(requestPath);
const versionReads = (server, from = 0) => server.requests.slice(from).filter((r) => r.method === 'GET' && isVersionRead(r.path));
// The versions of a page's file rows as the server holds them right now: what the record is expected to hold after a publish.
const versionsNow = (server, pageId) => new Map([[pageId, String(server.state.projects.get(pageId).version)], ...server.filesOf(pageId).map((f) => [f.id, String(f.version)])]);
const PAGE_FILE = 'src/pages/page.tsx';

test('deploy: the record keeps the version of every file row of each page as it was right after its publish — and an unchanged rebuild reads them all in ONE request and publishes nothing', async () => {
  const { appDir, spec } = twoPageApp();
  const server = new FakeGenPageServer();
  try {
    const first = await buildPages(spec, appDir, realPageBackend(server));
    const ids = { ...first.created.pages };
    for (const id of Object.values(ids)) {
      const recorded = publishedOf(spec, appDir).get(id);
      assert.deepStrictEqual(recorded.files, versionsNow(server, id), `${id}: every file row, with the version it had once the publish had taken effect`);
      assert.ok(recorded.files.size >= 4, 'the four rows a page is made of, at least');
    }
    // A page's versions are read twice after its publish, one read on each side of the read-back of its published copy: they are recorded only when the two agree and the copy holds the content that was sent.
    assert.strictEqual(versionReads(server).length, 4, 'two reads of a page\'s versions for each of the two pages');

    const from = server.requests.length;
    await rebuildPages(spec, appDir, server, ids);
    const rebuilt = requestsOf(server, from);
    assert.deepStrictEqual([rebuilt.changeSets, rebuilt.publishes, rebuilt.otherWrites], [0, 0, 0]);
    assert.strictEqual(versionReads(server, from).length, 1, 'both pages\' versions come in one read, however many pages there are');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('deploy: a page published from ANOTHER workspace and then put back to the file\'s content as a draft is published again — its draft equals the file, and the hash of what was sent still matches', async () => {
  const { appDir, spec } = twoPageApp();
  const server = new FakeGenPageServer();
  try {
    const first = await buildPages(spec, appDir, realPageBackend(server));
    const ids = { ...first.created.pages };
    const alphaText = fs.readFileSync(path.join(appDir, 'alpha.tsx'), 'utf8');
    // Another workspace publishes other content, writes the file's content back as a draft and does not publish it (its publish fails, say).
    server.otherWorkspaceDraft(ids.alpha, PAGE_FILE, 'export default function Alpha() { return <b>somebody else</b>; }\n');
    server.otherWorkspacePublishes(ids.alpha);
    server.otherWorkspaceDraft(ids.alpha, PAGE_FILE, alphaText);
    const served = () => Buffer.from(server.publishedPages.get(ids.alpha).files.find((f) => f.filename === PAGE_FILE).content).toString('utf8');
    assert.strictEqual(server.rowText(ids.alpha, PAGE_FILE), alphaText, 'the draft is the file');
    assert.match(served(), /somebody else/, 'and what runs is the other content');

    const publishedBefore = server.published.length;
    const from = server.requests.length;
    await rebuildPages(spec, appDir, server, ids);
    const rebuilt = requestsOf(server, from);
    assert.deepStrictEqual([rebuilt.changeSets, rebuilt.publishes], [0, 1], 'nothing to write — the draft is the file — and the page is published');
    assert.deepStrictEqual(server.published.slice(publishedBefore), [ids.alpha], 'that page alone: the page next to it was not touched');
    assert.strictEqual(served(), alphaText, 'what runs is the file again');
    assert.deepStrictEqual(publishedOf(spec, appDir).get(ids.alpha).files, versionsNow(server, ids.alpha), 'and the record holds the versions after THIS publish');

    const next = server.requests.length;
    await rebuildPages(spec, appDir, server, ids);
    assert.strictEqual(requestsOf(server, next).publishes, 0, 'after which the page is left alone again');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('deploy: a page saved as a draft from elsewhere is published again even when the save wrote the very bytes the file has — the version moved', async () => {
  const { appDir, spec } = twoPageApp();
  const server = new FakeGenPageServer();
  try {
    const first = await buildPages(spec, appDir, realPageBackend(server));
    const ids = { ...first.created.pages };
    server.otherWorkspaceDraft(ids.beta, PAGE_FILE, server.rowText(ids.beta, PAGE_FILE));
    const publishedBefore = server.published.length;
    const from = server.requests.length;
    await rebuildPages(spec, appDir, server, ids);
    const rebuilt = requestsOf(server, from);
    assert.deepStrictEqual([rebuilt.changeSets, rebuilt.publishes], [0, 1]);
    assert.deepStrictEqual(server.published.slice(publishedBefore), [ids.beta]);
    const next = server.requests.length;
    await rebuildPages(spec, appDir, server, ids);
    assert.strictEqual(requestsOf(server, next).publishes, 0);
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('deploy: a file row added to a page, or taken away from it, makes the next rebuild publish the page — the set of rows is part of what was recorded', async () => {
  const { appDir, spec } = twoPageApp();
  const server = new FakeGenPageServer();
  try {
    const first = await buildPages(spec, appDir, realPageBackend(server));
    const ids = { ...first.created.pages };
    const extra = 'f0000000-0000-4000-8000-0000000000e1';
    const step = async (what) => {
      const publishedBefore = server.published.length;
      const from = server.requests.length;
      await rebuildPages(spec, appDir, server, ids);
      assert.deepStrictEqual([requestsOf(server, from).changeSets, requestsOf(server, from).publishes], [0, 1], `${what}: nothing to write, one publish`);
      assert.deepStrictEqual(server.published.slice(publishedBefore), [ids.alpha], `${what}: the page that changed, and no other`);
      assert.deepStrictEqual(publishedOf(spec, appDir).get(ids.alpha).files, versionsNow(server, ids.alpha), `${what}: and the record is made again`);
    };
    server.seedFile(ids.alpha, extra, 'src/styles.css', 200000000, 'body { margin: 0 }');
    server.otherWorkspacePublishes(ids.alpha);
    await step('a row added');
    assert.ok(publishedOf(spec, appDir).get(ids.alpha).files.has(extra), 'the row that was added is in the record now');

    server.state.files.delete(extra);
    server.otherWorkspacePublishes(ids.alpha);
    await step('a row removed');
    assert.ok(!publishedOf(spec, appDir).get(ids.alpha).files.has(extra));
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('deploy: a record with no versions — one of the earlier format, or one made when the versions could not be read — publishes every page it names once, and records them', async () => {
  const { appDir, spec } = twoPageApp();
  const server = new FakeGenPageServer();
  try {
    const first = await buildPages(spec, appDir, realPageBackend(server));
    const ids = { ...first.created.pages };
    const workspaceDir = path.join(appDir, '.maker-workspace');
    const file = publishedRecordPath(workspaceDir, appUniqueName(spec), BUILD_ENV);
    // The record as the release before the versions wrote it: schema version 1, a hash per page.
    const current = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...current, schemaVersion: 1, pages: Object.fromEntries(Object.entries(current.pages).map(([id, entry]) => [id, entry.fingerprint])) }), 'utf8');
    assert.ok([...publishedOf(spec, appDir).values()].every((entry) => entry.files === null), 'it holds hashes and no versions');

    let from = server.requests.length;
    await rebuildPages(spec, appDir, server, ids);
    assert.deepStrictEqual([requestsOf(server, from).changeSets, requestsOf(server, from).publishes], [0, 2], 'both pages are published: nothing says their files are as they were');
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).schemaVersion, 3, 'and the record is of the current format now');
    for (const id of Object.values(ids)) assert.deepStrictEqual(publishedOf(spec, appDir).get(id).files, versionsNow(server, id));

    from = server.requests.length;
    await rebuildPages(spec, appDir, server, ids);
    assert.strictEqual(requestsOf(server, from).publishes, 0, 'after which an unchanged rebuild publishes nothing');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('deploy: a read of the versions that FAILS costs the pages a publish and a warning — never the build — and the record made without them publishes once more', async () => {
  const { appDir, spec } = twoPageApp();
  const server = new FakeGenPageServer();
  try {
    const first = await buildPages(spec, appDir, realPageBackend(server));
    const ids = { ...first.created.pages };

    // The versions cannot be read, before the pages are looked at and after they are published.
    server.failOn = (method, requestPath) => (method === 'GET' && isVersionRead(requestPath) ? 503 : undefined);
    const warnings = [];
    let from = server.requests.length;
    await rebuildPages(spec, appDir, server, ids, { warn: (m) => warnings.push(m) });
    assert.deepStrictEqual([requestsOf(server, from).changeSets, requestsOf(server, from).publishes], [0, 2], 'both pages are published');
    assert.strictEqual(warnings.filter((m) => /could not read the versions of the pages' files/.test(m)).length, 1, `said once: ${warnings.join(' | ')}`);
    assert.ok([...publishedOf(spec, appDir).values()].every((entry) => entry.files === null), 'and what was recorded has no versions, since none could be read');

    server.failOn = undefined;
    from = server.requests.length;
    await rebuildPages(spec, appDir, server, ids);
    assert.strictEqual(requestsOf(server, from).publishes, 2, 'a record with no versions publishes once more, and this time the versions are read');
    from = server.requests.length;
    await rebuildPages(spec, appDir, server, ids);
    assert.strictEqual(requestsOf(server, from).publishes, 0);
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

// ── The record certifies the publish it is of ────────────────────────────────────────────────────────────────────────────────────────────────────
// The record pairs the hash of what the build published with the versions of the page's files, and a rebuild skips the page's publish while its files still read as recorded and it still holds that content. So the
// versions are worth something only when they are those of the publication the hash is of. They used to be read AFTER the SDK had seen the publish take effect (and after the manifest was written), and nothing tied
// them to it: a writer that published other content and put the build's content back as a draft in between left a page whose draft equalled the file and whose versions equalled the record — and whose published copy was
// the other writer's, skipped by every rebuild after that, each of them reporting success. The build now records versions only from a published copy it read back, between two reads of the versions that agree, and found
// to hold the content it sent; anything else leaves the page unrecorded, and the next build publishes it. The second writer is the stateful fake of the page tables (helpers/fake-genpage-server.js), acting between the
// build's own requests through a second backend of its own.
const COMPILED_FILE = 'src/pages/page.compiled';
// What another writer does to a page: it publishes `otherText` — the page's source and its compiled output both change — and puts the draft back to what it held, so the draft still equals the file.
async function publishOver(server, writer, pageId, otherText) {
  const sourceBefore = server.rowText(pageId, PAGE_FILE);
  const compiledBefore = server.rowText(pageId, COMPILED_FILE);
  const wrote = await writer.update(pageId, { source: otherText });
  assert.strictEqual(wrote.publish.kind, 'verified', 'the other writer\'s publish took effect');
  server.otherWorkspaceDraft(pageId, PAGE_FILE, sourceBefore);
  server.otherWorkspaceDraft(pageId, COMPILED_FILE, compiledBefore);
}
const publishedSource = (server, pageId) => Buffer.from(server.publishedPages.get(pageId).files.find((f) => f.filename === PAGE_FILE).content).toString('utf8');

test('deploy: a page another writer published over before the build read its versions is not recorded as published — the next build publishes it, where the record used to skip it for good', async () => {
  const { appDir, spec } = twoPageApp();
  const server = new FakeGenPageServer();
  const writer = realPageBackend(server);
  try {
    const alphaText = fs.readFileSync(path.join(appDir, 'alpha.tsx'), 'utf8');
    const genpage = realPageBackend(server);
    const readVersions = genpage.fileVersions;
    let overwritten = null;
    genpage.fileVersions = async (ids) => {
      // The build's first read of a page's versions comes after its publish was seen to take effect; the other writer gets in before it.
      if (overwritten === null) {
        overwritten = ids[0];
        await publishOver(server, writer, ids[0], alphaText.replace('>Alpha<', '>Somebody else<'));
      }
      return readVersions(ids);
    };
    const warnings = [];
    const first = await buildPages(spec, appDir, genpage, { warn: (m) => warnings.push(m) });
    const ids = { ...first.created.pages };
    assert.strictEqual(overwritten, ids.alpha, 'the first page built is the one the other writer got to');
    assert.match(publishedSource(server, ids.alpha), /Somebody else/, 'what runs is the other writer\'s page, and the draft is the file');
    assert.strictEqual(server.rowText(ids.alpha, PAGE_FILE), alphaText);
    const entry = publishedOf(spec, appDir).get(ids.alpha);
    assert.ok(!entry || entry.files === null, 'so the page is not recorded with versions: they would be those of a publication that is not the build\'s');
    assert.ok(publishedOf(spec, appDir).get(ids.beta).files, 'the page next to it, which nobody touched, is recorded as before');
    assert.ok(warnings.some((m) => /page "Alpha"/.test(m) && /differs from what this build sent in its source/.test(m) && /published again from elsewhere/.test(m)), `the build said why: ${warnings.join(' | ')}`);

    // The next build finds the draft equal to the file and nothing recorded for the page, so it publishes that page — and no other.
    const publishedBefore = server.published.length;
    let from = server.requests.length;
    await rebuildPages(spec, appDir, server, ids);
    const rebuilt = requestsOf(server, from);
    assert.deepStrictEqual([rebuilt.changeSets, rebuilt.publishes], [0, 1], 'nothing to write, and the one page that is not known to be published is published');
    assert.deepStrictEqual(server.published.slice(publishedBefore), [ids.alpha]);
    assert.strictEqual(publishedSource(server, ids.alpha), alphaText, 'what runs is the file again');
    assert.deepStrictEqual(publishedOf(spec, appDir).get(ids.alpha).files, versionsNow(server, ids.alpha), 'and the record holds the versions of THAT publication');

    from = server.requests.length;
    await rebuildPages(spec, appDir, server, ids);
    assert.strictEqual(requestsOf(server, from).publishes, 0, 'after which the page is left alone');
  } finally {
    await writer.dispose();
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});

// The same writer at each point of the build's proof: before its first read of the page's versions, while the published copy is read back, and after that read. A copy that already differs is said so; a page whose files
// moved after the copy was read back is not — the copy held the content when it was read, and what refuses the record is the movement. Neither is ever recorded.
test('deploy: a page another writer publishes over at any point while the build reads its published copy back is left unrecorded, and the next build publishes it', async () => {
  const placements = [
    { when: 'before', what: 'before the first read of the versions', says: true },
    { when: 'while', what: 'while the published copy is read back', says: true },
    { when: 'after', what: 'after the published copy was read back, before the second read of the versions', says: false },
  ];
  for (const { when, what, says } of placements) {
    const { appDir, spec } = twoPageApp();
    const server = new FakeGenPageServer();
    const writer = realPageBackend(server);
    try {
      const alphaText = fs.readFileSync(path.join(appDir, 'alpha.tsx'), 'utf8');
      const genpage = realPageBackend(server);
      assert.strictEqual(typeof genpage.publishedDiffers, 'function', 'the backend can read a page\'s published copy back');
      let target = null;
      let reads = 0;
      let done = false;
      const act = async (pageId) => { done = true; await publishOver(server, writer, pageId, alphaText.replace('>Alpha<', '>Somebody else<')); };
      const readVersions = genpage.fileVersions;
      genpage.fileVersions = async (ids) => {
        if (target === null) target = ids[0];
        if (ids[0] === target) {
          reads += 1;
          if (!done && ((when === 'before' && reads === 1) || (when === 'after' && reads === 2))) await act(ids[0]);
        }
        return readVersions(ids);
      };
      const readCopy = genpage.publishedDiffers;
      genpage.publishedDiffers = async (id, args, expected) => {
        if (!done && when === 'while') await act(id);
        return readCopy(id, args, expected);
      };
      const warnings = [];
      const first = await buildPages(spec, appDir, genpage, { warn: (m) => warnings.push(m) });
      const ids = { ...first.created.pages };
      assert.ok(done, `${what}: the other writer got in`);
      assert.strictEqual(target, ids.alpha);
      assert.match(publishedSource(server, ids.alpha), /Somebody else/, `${what}: what runs is the other writer's page`);
      const entry = publishedOf(spec, appDir).get(ids.alpha);
      assert.ok(!entry || entry.files === null, `${what}: so the page is not recorded with versions`);
      assert.ok(publishedOf(spec, appDir).get(ids.beta).files, `${what}: and the page next to it is`);
      assert.strictEqual(warnings.filter((m) => /published again from elsewhere/.test(m)).length, says ? 1 : 0, `${what}: ${warnings.join(' | ')}`);

      const publishedBefore = server.published.length;
      await rebuildPages(spec, appDir, server, ids);
      assert.deepStrictEqual(server.published.slice(publishedBefore), [ids.alpha], `${what}: the next build publishes that page, and only that page`);
      assert.strictEqual(publishedSource(server, ids.alpha), alphaText, `${what}: what runs is the file again`);
      assert.deepStrictEqual(publishedOf(spec, appDir).get(ids.alpha).files, versionsNow(server, ids.alpha), `${what}: and it is recorded now`);
    } finally {
      await writer.dispose();
      fs.rmSync(appDir, { recursive: true, force: true });
    }
  }
});

test('deploy: a published copy that cannot be read back is not recorded — the build finishes and says nothing of it, and the next build publishes the page and records it', async () => {
  const { appDir, spec } = twoPageApp();
  const server = new FakeGenPageServer();
  try {
    const genpage = realPageBackend(server);
    assert.strictEqual(typeof genpage.publishedDiffers, 'function', 'the backend can read a page\'s published copy back');
    const readCopy = genpage.publishedDiffers;
    let reads = 0;
    genpage.publishedDiffers = async (id, args, expected) => {
      // The service refuses the reads of the first page's files while its copy is read back — and only then: the SDK's own check of the publish is over, and the next page's is not under way.
      reads += 1;
      if (reads > 1) return readCopy(id, args, expected);
      server.failOn = (method, requestPath) => (method === 'GET' && /\/filecontent\/\$value/.test(requestPath) ? 503 : undefined);
      try { return await readCopy(id, args, expected); } finally { server.failOn = undefined; }
    };
    const warnings = [];
    const first = await buildPages(spec, appDir, genpage, { warn: (m) => warnings.push(m) });
    const ids = { ...first.created.pages };
    const entry = publishedOf(spec, appDir).get(ids.alpha);
    assert.ok(entry && entry.files === null, 'the page is recorded as published, with no versions: nothing proves them');
    assert.ok(publishedOf(spec, appDir).get(ids.beta).files, 'the page next to it is recorded with its versions');
    assert.deepStrictEqual(warnings.filter((m) => /Alpha/.test(m)), [], 'and nothing is said: it is a cache, and a failed read of it costs a publish');

    const publishedBefore = server.published.length;
    let from = server.requests.length;
    await rebuildPages(spec, appDir, server, ids);
    assert.deepStrictEqual([requestsOf(server, from).changeSets, requestsOf(server, from).publishes], [0, 1]);
    assert.deepStrictEqual(server.published.slice(publishedBefore), [ids.alpha]);
    assert.deepStrictEqual(publishedOf(spec, appDir).get(ids.alpha).files, versionsNow(server, ids.alpha), 'this time the copy is read back, and the versions are recorded');
    from = server.requests.length;
    await rebuildPages(spec, appDir, server, ids);
    assert.strictEqual(requestsOf(server, from).publishes, 0);
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

// What the record certifies is the CONTENT the published copy holds, not who published it: another writer's publish that left the page holding the very content the build sent — it published something else and then
// the build's content again — is a published copy that holds the content, and is recorded.
test('deploy: a page another writer published and then published the build\'s content back to is recorded — the record is of the content the published copy holds, whoever published it', async () => {
  const { appDir, spec } = twoPageApp();
  const server = new FakeGenPageServer();
  const writer = realPageBackend(server);
  try {
    const alphaText = fs.readFileSync(path.join(appDir, 'alpha.tsx'), 'utf8');
    const genpage = realPageBackend(server);
    const readVersions = genpage.fileVersions;
    let overwritten = null;
    genpage.fileVersions = async (ids) => {
      if (overwritten === null) {
        overwritten = ids[0];
        await writer.update(ids[0], { source: alphaText.replace('>Alpha<', '>Somebody else<') });
        await writer.update(ids[0], { source: alphaText });
      }
      return readVersions(ids);
    };
    const warnings = [];
    const first = await buildPages(spec, appDir, genpage, { warn: (m) => warnings.push(m) });
    const ids = { ...first.created.pages };
    assert.strictEqual(overwritten, ids.alpha);
    assert.strictEqual(publishedSource(server, ids.alpha), alphaText, 'what runs is the file');
    assert.deepStrictEqual(publishedOf(spec, appDir).get(ids.alpha).files, versionsNow(server, ids.alpha), 'and the page is recorded with the versions of the copy that runs');
    assert.deepStrictEqual(warnings.filter((m) => /Alpha/.test(m)), []);
    const from = server.requests.length;
    await rebuildPages(spec, appDir, server, ids);
    assert.strictEqual(requestsOf(server, from).publishes, 0, 'so the next build leaves it alone');
  } finally {
    await writer.dispose();
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});

// The read-back belongs to a publish the build has just seen take effect. A page that is left alone — nothing to write, and recorded as published — is not published, so nothing of its published copy is read: an unchanged
// rebuild asks the page service for the draft of each page and the versions of its files, in one request, and for no published content.
test('deploy: an unchanged rebuild reads no page\'s published copy — the read-back is for a publish the build has just made', async () => {
  const { appDir, spec } = twoPageApp();
  const server = new FakeGenPageServer();
  try {
    const first = await buildPages(spec, appDir, realPageBackend(server));
    const ids = { ...first.created.pages };
    // A read of a file's content that does not ask for the unpublished layer is a read of the published one.
    const publishedContentReads = (from) => server.requests.slice(from).filter((r) => r.method === 'GET' && /\/filecontent\/\$value$/.test(r.path) && r.headers['MSCRM.IncludeUnpublished'] !== 'true').length;
    assert.ok(publishedContentReads(0) > 0, 'a publish is read back: the SDK\'s check of it, and the build\'s');
    let from = server.requests.length;
    await rebuildPages(spec, appDir, server, ids);
    assert.strictEqual(publishedContentReads(from), 0, 'an unchanged rebuild publishes nothing, so it reads no published copy');

    // A page that changes is published, and read back.
    fs.writeFileSync(path.join(appDir, 'beta.tsx'), fs.readFileSync(path.join(appDir, 'beta.tsx'), 'utf8').replace('>Beta<', '>Beta, edited<'), 'utf8');
    from = server.requests.length;
    await rebuildPages(spec, appDir, server, ids);
    assert.ok(publishedContentReads(from) > 0, 'a rebuild that publishes a page reads it back');
    from = server.requests.length;
    await rebuildPages(spec, appDir, server, ids);
    assert.strictEqual(publishedContentReads(from), 0, 'and the rebuild after it reads no published copy again');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

// ── The text of a page file is normalized ONCE ────────────────────────────────────────────────────────────────────────────────────────────────────
// The build reads each page file once and turns its bytes into text (sourceText: one leading byte order mark is the encoding, and goes). The Griffel gate, the PAGEREF resolution, the hash recorded as
// deployed and the page's write all use that text as it is. The backend used to normalize the text again, so a file that started with two marks was sent with neither, and what the build recorded as
// deployed was not what the SDK stored.
test('deploy: a page file that starts with two byte order marks is checked, resolved, hashed and stored as the same text — one mark is the encoding, the other is content', async () => {
  const { appDir, spec } = makeTwoPageApp(); // overview links to detail
  const MARK = '\uFEFF';
  const server = new FakeGenPageServer();
  try {
    const bodies = {
      overview: `export default function Overview(){ ${NAV('detail')} return null; }`,
      detail: 'export default function Detail(){ return null; }',
    };
    for (const [key, body] of Object.entries(bodies)) fs.writeFileSync(path.join(appDir, `${key}.tsx`), `${MARK}${MARK}${body}`, 'utf8');
    const result = await buildPages(spec, appDir, realPageBackend(server));
    const stored = (key) => server.rowText(result.created.pages[key], 'src/pages/page.tsx');
    assert.strictEqual(stored('detail'), `${MARK}${bodies.detail}`, 'the file\'s first mark was the encoding marker and is gone; the second is content and is stored');
    assert.strictEqual(stored('overview'), `${MARK}${bodies.overview.replace('PAGEREF_detail', result.created.pages.detail)}`, 'a navigation page is resolved on that same text');
    // The link target is created in the step that resolves navigation and is not sent again, so only the page sent in the upload step has a deployed hash.
    assert.strictEqual(result.created.pageDeployedShas.overview, sha256(stored('overview')), 'the hash recorded as deployed is the hash of what the service stores');
    for (const key of ['overview', 'detail']) {
      assert.strictEqual(result.created.pageSourceShas[key], sha256(fs.readFileSync(path.join(appDir, `${key}.tsx`))), `${key}: the source hash is that of the file`);
    }
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }

  // A page that links nowhere is sent in the upload step as it is.
  const alone = onePageApp('Overview');
  try {
    const body = 'export default function P(){ return null; }';
    fs.writeFileSync(path.join(alone.appDir, 'p.tsx'), `${MARK}${MARK}${body}`, 'utf8');
    const result = await buildPages(alone.spec, alone.appDir, realPageBackend(server));
    const stored = server.rowText(result.created.pages.p, 'src/pages/page.tsx');
    assert.strictEqual(stored, `${MARK}${body}`);
    assert.strictEqual(result.created.pageDeployedShas.p, sha256(stored), 'the hash recorded as deployed is the hash of what the service stores');
  } finally { fs.rmSync(alone.appDir, { recursive: true, force: true }); }
});

// ── The build pins the default views of the tables the pages it wrote read ────────────────────────────────────────────────────────────────────
// pac pinned each table's default public view into the app on EVERY upload — the build's included — so that the maker's "/" picker lists the table. The SDK's page write does not. After its pages are
// written and recorded, the build makes ONE app operation for all of them: the backend's placeInApp with no page to place and only the tables (the call genpage-upload.js makes with --app-id). It writes
// nothing when every view is already pinned, and a failure to pin is a warning, not a halt.
const withTables = (spec, tables) => { for (const p of spec.pages) if (tables[p.key]) p.dataSources = tables[p.key]; return spec; };

test('deploy: once its pages are written the build pins the default views of the tables they read — ONE app operation for all of them, after the pages are written', async () => {
  const { appDir, spec } = makeTwoPageApp();
  try {
    withTables(spec, { overview: ['contoso_item', 'contoso_note'], detail: ['contoso_item'] });
    const genpageCli = mockGenpageCli();
    const seen = [];
    const placeInApp = genpageCli.placeInApp;
    genpageCli.placeInApp = (appId, o) => { seen.push(genpageCli.uploads.map((u) => u.name)); return placeInApp(appId, o); };
    const { sdk, calls } = mockSdk();
    const r = await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES });
    assert.strictEqual(genpageCli.placements.length, 1, 'one app operation, not one per page');
    assert.deepStrictEqual(genpageCli.placements[0], { appId: r.created.app, pages: [], dataSources: ['contoso_item', 'contoso_note'] }, 'no page is placed, the app is the one built, and each table is named once');
    assert.deepStrictEqual(seen, [['Detail', 'Overview']], 'it came after both pages were written');
    assert.ok(finalizeRan(calls), 'and the sitemap was finalized by then');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('deploy: the build\'s pin names the authoring language it built in, and says nothing of a language when it built in none', async () => {
  const { appDir, spec } = makeTwoPageApp();
  try {
    withTables(spec, { detail: ['contoso_item'] });
    const plain = mockGenpageCli();
    await runSdkBuild(spec, { sdk: mockSdk().sdk, apply: true, env: 'https://x', appDir, genpageCli: plain, phases: PHASES });
    assert.deepStrictEqual(Object.keys(plain.placements[0]).sort(), ['appId', 'dataSources', 'pages']);
    const german = mockGenpageCli();
    await runSdkBuild(spec, { sdk: mockSdk().sdk, apply: true, env: 'https://x', appDir, genpageCli: german, phases: PHASES, preResolvedLanguageCode: 1031 });
    assert.strictEqual(german.placements[0].languageCode, 1031);
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('deploy: a build whose pages read no table makes no app operation; a changed-only run pins only the tables of the pages it wrote', async () => {
  const none = makeTwoPageApp();
  try {
    const genpageCli = mockGenpageCli();
    await runSdkBuild(none.spec, { sdk: mockSdk().sdk, apply: true, env: 'https://x', appDir: none.appDir, genpageCli, phases: PHASES });
    assert.deepStrictEqual(genpageCli.placements, [], 'no table, no app operation — placing reads the app, and a read that was not needed could only fail');
  } finally { fs.rmSync(none.appDir, { recursive: true, force: true }); }

  const app = deployedApp(GRIFFEL_CLEAN); // two independent pages, both live and bound
  try {
    withTables(app.spec, { overview: ['contoso_item'], detail: ['contoso_note'] });
    const run = app.rebuild({ phases: PAGES_ONLY, changedOnly: { fastApply: true, resolvedAppId: APP_ID, skipSitemapFinalize: true, selectedKeys: ['overview'] } });
    await run.run();
    assert.deepStrictEqual(run.genpageCli.uploads.map((u) => u.name), ['Overview'], 'only the selected page was written');
    assert.deepStrictEqual(run.genpageCli.placements, [{ appId: APP_ID, pages: [], dataSources: ['contoso_item'] }], 'so only its table is pinned: the page left alone writes nothing the app needs');
  } finally { app.cleanup(); }
});

// A page key is a lowercase slug, so a page can be keyed `constructor` — a member of Object.prototype. The pages this run wrote are the ones
// `created.pages` holds, and a page it left alone must read as not written whatever its key is.
test('deploy: a changed-only run pins only the tables of the pages it wrote when the page it left alone is keyed constructor', async () => {
  const { appDir, spec } = makeTwoPageApp();
  try {
    fs.writeFileSync(path.join(appDir, 'overview.tsx'), 'export default function Overview(){ return null; }', 'utf8');
    spec.pages[0].navigatesTo = undefined;
    spec.pages[1].key = 'constructor';
    spec.appShell.areas[0].groups[0].subAreas[1].page = 'constructor';
    spec.pages[0].dataSources = ['contoso_item'];
    spec.pages[1].dataSources = ['contoso_note'];
    const live = [{ pageId: OVERVIEW_ID, name: 'Overview' }, { pageId: DETAIL_ID, name: 'Detail' }];
    const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: OVERVIEW_ID }, { key: 'constructor', name: 'Detail', pageId: DETAIL_ID }] }), 'utf8').toString('base64');
    const { sdk } = mockSdk({ pageManifest: manifest, liveSitemapXml: pageSitemap([OVERVIEW_ID, DETAIL_ID]), pageRows: live.map((p) => ({ uxagentprojectid: p.pageId, name: p.name })) });
    const genpageCli = mockGenpageCli(live);
    const r = await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PAGES_ONLY, changedOnly: { fastApply: true, resolvedAppId: APP_ID, skipSitemapFinalize: true, selectedKeys: ['overview'] } });
    assert.deepStrictEqual(genpageCli.uploads.map((u) => u.name), ['Overview'], 'only the selected page was written');
    assert.deepStrictEqual(Object.keys(r.created.pages), ['overview'], 'and only it is in the result');
    assert.deepStrictEqual(genpageCli.placements, [{ appId: APP_ID, pages: [], dataSources: ['contoso_item'] }], 'so only its table is pinned, not the table of the page keyed constructor');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('deploy: the pin carries the request to send before the app is written — a function the placement awaits, which sends nothing without --publish — and what it is asked to pin is still only data', async () => {
  const { appDir, spec } = makeTwoPageApp();
  try {
    withTables(spec, { detail: ['contoso_item'] });
    const genpageCli = mockGenpageCli();
    const { sdk, calls } = mockSdk();
    sdk.dataverse.post = async (url, body) => { calls.push({ name: 'dataverse.post', args: [url, body] }); return { status: 204, body: null }; };
    const r = await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES });
    assert.deepStrictEqual(genpageCli.placements, [{ appId: r.created.app, pages: [], dataSources: ['contoso_item'] }], 'the data it is given is what it always was');
    assert.strictEqual(genpageCli.hooks.length, 1);
    assert.strictEqual(typeof genpageCli.hooks[0], 'function');
    const before = calls.length;
    // The backend tells the hook what the push it is about to make sends (lib/genpage-sdk.js placeInApp); without --publish none of it is looked at, and a backend that tells nothing is no reason to fail.
    await genpageCli.hooks[0]({ pushes: true, entityTables: ['contoso_item', 'contoso_other'], mainFormsByTable: undefined });
    await genpageCli.hooks[0]();
    assert.deepStrictEqual(calls.slice(before), [], 'without --publish the placement is not preceded by a read or a publish of anything');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('deploy: with --publish the request the placement is handed names the tables of the navigation the placement says it pushes — not the spec\'s — and none when it says it only publishes', async () => {
  const { appDir, spec } = makeTwoPageApp();
  try {
    withTables(spec, { detail: ['contoso_item'] });
    const genpageCli = mockGenpageCli();
    const { sdk, calls } = mockSdk();
    sdk.dataverse.post = async (url, body) => { calls.push({ name: 'dataverse.post', args: [url, body] }); return { status: 204, body: null }; };
    await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES, publish: true });
    const requested = () => calls.filter((c) => c.name === 'dataverse.post' && c.args[0] === '/PublishXml').map((c) => [...c.args[1].ParameterXml.matchAll(/<entity>([^<]+)<\/entity>/g)].map((m) => m[1]));
    const before = requested().length;
    assert.deepStrictEqual(requested(), [['contoso_item']], 'the build\'s own request, made when it created the app: the spec\'s navigation, which that write sends');
    await genpageCli.hooks[0]({ pushes: false, entityTables: ['contoso_other'], mainFormsByTable: undefined });
    assert.deepStrictEqual(requested().slice(before), [], 'a placement that only publishes the app adds no Main form: nothing to name');
    await genpageCli.hooks[0]({ pushes: true, entityTables: ['contoso_item', 'contoso_live'], mainFormsByTable: { contoso_other: [] } });
    assert.deepStrictEqual(requested().slice(before), [['contoso_live']], 'what its push adds forms of, less what an earlier request named: the spec\'s own table was published already');
    await genpageCli.hooks[0]({ pushes: true, entityTables: ['contoso_live', 'contoso_empty'], mainFormsByTable: { contoso_empty: [] } });
    assert.deepStrictEqual(requested().slice(before), [['contoso_live']], 'and a table the push adds no form of, or one already named, is not named again');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('deploy: a table whose view could not be pinned is a warning — the pages were written, so the build does not halt', async () => {
  const { appDir, spec } = makeTwoPageApp();
  try {
    withTables(spec, { detail: ['contoso_item'] });
    const genpageCli = mockGenpageCli();
    genpageCli.placeInApp = async () => { throw new Error('the app could not be saved'); };
    const warnings = [];
    const r = await runSdkBuild(spec, { sdk: mockSdk().sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES, warn: (m) => warnings.push(m) });
    assert.ok(r.ok, 'the build finished');
    assert.strictEqual(genpageCli.uploads.length, 2, 'with both pages written');
    assert.ok(warnings.some((m) => /the pages were written, but their tables' default views could not be added to the app's components.*the app could not be saved/.test(m)), warnings.join('\n'));

    const refused = mockGenpageCli();
    refused.placeInApp = async () => ({ added: [], alreadyPlaced: [], pinnedViews: [], warnings: ['table contoso_item has no default public view to pin into the app'], appEdited: false });
    const heard = [];
    await runSdkBuild(spec, { sdk: mockSdk().sdk, apply: true, env: 'https://x', appDir, genpageCli: refused, phases: PHASES, warn: (m) => heard.push(m) });
    assert.ok(heard.some((m) => /^default views of the pages' tables: table contoso_item has no default public view/.test(m)), 'what the backend warns about is passed on');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('deploy: through the real backend the pin is ONE app edit, and a rebuild writes nothing to the app when every view is already pinned', async () => {
  const VIEW = 'aaaaaaaa-0000-4000-8000-0000000000a1';
  const LAYER = '33333333-0000-4000-8000-0000000000cc';
  const held = [];
  const fake = new FakeSdk({
    records: {
      savedquery: () => [{ savedqueryid: VIEW.toUpperCase() }],
      appmodulecomponent: () => held.map((objectid) => ({ objectid: `{${objectid}}`, componenttype: 26 })),
    },
    onGet: async (url) => (/RetrieveUnpublishedMultiple/.test(url) ? { status: 200, body: { value: [{ appmoduleid: APP_ID, appmoduleidunique: LAYER, componentstate: 0 }] } } : { status: 404, body: null }),
  }).seedApp({ id: APP_ID, name: 'App', siteMap: { areas: [{ id: 'area_1', title: 'Main', groups: [{ id: 'group_1', title: 'Pages', subAreas: [] }] }] } });
  liveTwoPages(fake);
  const { appDir, spec } = makeTwoPageApp();
  try {
    spec.pages[0].navigatesTo = undefined;
    fs.writeFileSync(path.join(appDir, 'overview.tsx'), 'export default function Overview(){ return 1; }', 'utf8');
    for (const p of spec.pages) p.dataSources = ['contoso_item'];
    const live = [{ pageId: OVERVIEW_ID, name: 'Overview' }, { pageId: DETAIL_ID, name: 'Detail' }];
    const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: OVERVIEW_ID }, { key: 'detail', name: 'Detail', pageId: DETAIL_ID }] }), 'utf8').toString('base64');
    const genpage = makeGenpageSdk('https://x', { sdk: fake });
    const run = () => runSdkBuild(spec, {
      sdk: mockSdk({ pageManifest: manifest, liveSitemapXml: pageSitemap([OVERVIEW_ID, DETAIL_ID]), pageRows: live.map((p) => ({ uxagentprojectid: p.pageId, name: p.name })) }).sdk,
      apply: true, env: 'https://x', appDir, genpage, phases: PAGES_ONLY, changedOnly: { fastApply: true, resolvedAppId: APP_ID, skipSitemapFinalize: true },
    });
    const appCalls = (name) => fake.of(name).filter((c) => c.args[0] === 'app');
    await run();
    assert.deepStrictEqual(fake.apps.get(APP_ID).components, { views: [VIEW] }, 'the default view of the pages\' table is pinned into the app');
    assert.strictEqual(appCalls('pushArtifact').length, 1, 'by one push');
    assert.strictEqual(appCalls('publishArtifact').length, 1, 'and one publish — for both pages and their one table');
    held.push(VIEW); // the app's layer holds it now
    await run();
    assert.strictEqual(appCalls('pushArtifact').length, 1, 'a rebuild writes nothing to the app: every view is already pinned');
    assert.strictEqual(appCalls('publishArtifact').length, 1);
    await genpage.dispose();
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

// ── A halt that quotes a page's name is final for the build's retry — whatever the page is called ──────────────────────────────────────────────────
// buildModelApp runs the whole build again — up to three times, after every earlier phase — when a halt reads as a transient error (isTransientHalt, build-model-app.js), and unless the halt says
// `transient: false` it reads that from the halt's TEXT. Most halts of the pages phase open with the page's name, which is the maker's own: a page called "SQL Timeout Report" whose source makes a
// navigation call the build refuses, or holds a token it cannot resolve, read as a SQL timeout — the page that could never deploy was run three more times before the build reported it, and the log
// blamed the service. Each halt below is raised by something a run again cannot change, so each carries the marker, as the style-shorthand and receipt halts do. In every test the control is that the
// halt's words alone DO read as transient, so it is the marker that holds the build back; the tests after the table pin that what the build rides out is still ridden out.
const HALT_NAME = 'SQL Timeout Report';
const manifestOf = (pages) => Buffer.from(JSON.stringify({ schemaVersion: 1, pages }), 'utf8').toString('base64');
const OTHER_PAGE_ID = '99999999-9999-4999-8999-999999999999';
// `setup(name)` makes the folder and the spec whose first page is called `name`, with the doubles the build runs against when it needs more than the defaults.
const NAME_HALTS = [
  { code: 'pages-malformed-navref', what: 'a navigation reference that is not a double-quoted PAGEREF_ literal', setup: (name) => {
    const a = makeTwoPageApp({ malformed: true });
    a.spec.pages[0].name = name;
    return a;
  } },
  { code: 'pages-nav-parity', what: 'a navigation call nothing declares', setup: (name) => {
    const a = makeTwoPageApp({ undeclaredRef: true });
    a.spec.pages[0].name = name;
    return a;
  } },
  { code: 'pages-nav-parity', what: 'a declared navigation the page never makes', setup: (name) => {
    const a = makeTwoPageApp();
    a.spec.pages[0].name = name;
    fs.writeFileSync(path.join(a.appDir, 'overview.tsx'), 'export default function Overview(){ return null; }', 'utf8');
    return a;
  } },
  { code: 'pages-nav-parity', what: 'a navigation target that is not a declared PAGEREF_ symbol', setup: (name) => {
    const a = makeTwoPageApp();
    a.spec.pages[0].name = name;
    a.spec.pages[0].navigatesTo = [];
    fs.writeFileSync(path.join(a.appDir, 'overview.tsx'), 'export default function O(){ Xrm.Navigation.navigateTo({ pageType: "generative", pageId: someVar, data: {} }); return null; }', 'utf8');
    return a;
  } },
  { code: 'pages-stray-pageref', what: 'a PAGEREF_ token no navigation rewrite resolves', setup: (name) => {
    const a = makeTwoPageApp();
    a.spec.pages[0].name = name;
    fs.writeFileSync(path.join(a.appDir, 'overview.tsx'), OVERVIEW_WITH('const route = "PAGEREF_detail";', NAV('detail')), 'utf8');
    return a;
  } },
  { code: 'pages-source-not-utf8', what: 'a source that is not UTF-8', setup: (name) => {
    const a = makeTwoPageApp();
    a.spec.pages[0].name = name;
    fs.writeFileSync(path.join(a.appDir, 'overview.tsx'), Buffer.from([0x65, 0xff, 0xfe, 0x66]));
    return a;
  } },
  { code: 'pages-blank-provenance', what: 'a prompt that is present and blank', setup: (name) => {
    const a = makeTwoPageApp();
    a.spec.pages[0].name = name;
    a.spec.pages[0].prompt = '   ';
    return a;
  } },
  { code: 'pages-dangling-navref', quotesName: false, what: 'a navigation target that is not a built page', setup: (name) => {
    const a = makeTwoPageApp({ danglingTarget: true });
    a.spec.pages[0].name = name;
    return a;
  } },
  { code: 'pages-duplicate-name-create', what: 'two pages of one name, one of them no longer deployed', setup: (name) => {
    const a = makeDupNamePageApp();
    for (const p of a.spec.pages) p.name = name;
    const manifest = manifestOf([{ key: 'sc-a', name, pageId: a.GA }, { key: 'sc-b', name, pageId: a.GB }]);
    return { ...a, sdk: mockSdk({ pageManifest: manifest, manifestId: 'wr-manifest', liveSitemapXml: pageSitemap([a.GA]), pageRows: [{ uxagentprojectid: a.GA, name }] }).sdk, genpage: mockGenpageCli([{ pageId: a.GA, name }]) };
  } },
  { code: 'pages-identity-conflict', what: 'a manifest id nothing proves is this app\'s', setup: (name) => {
    const a = onePageApp(name);
    fs.writeFileSync(path.join(a.appDir, 'p.tsx'), PAGE_SOURCE, 'utf8');
    const manifest = manifestOf([{ key: 'p', name, pageId: UNCERTAIN_PAGE_ID }]);
    return { ...a, sdk: mockSdk({ pageManifest: manifest, manifestId: 'wr-manifest', liveSitemapXml: EMPTY_SITEMAP_XML, pageRows: [{ uxagentprojectid: UNCERTAIN_PAGE_ID, name }] }).sdk, genpage: mockGenpageCli([{ pageId: UNCERTAIN_PAGE_ID, name }]) };
  } },
  { code: 'pages-identity-conflict', what: 'a page under an id an earlier build minted that no create sent', setup: (name) => {
    const a = onePageApp(name);
    fs.writeFileSync(path.join(a.appDir, 'p.tsx'), PAGE_SOURCE, 'utf8');
    const workspaceDir = path.join(a.appDir, '.maker-workspace');
    const server = new FakeGenPageServer();
    server.seedPage(UNCERTAIN_PAGE_ID, { name: 'Somebody else\'s page', source: 'export default function Theirs() { return null; }\n' });
    recordPagePending(workspaceDir, appUniqueName(a.spec), 'p', UNCERTAIN_PAGE_ID, name, BUILD_ENV, sha256(PAGE_SOURCE));
    return { ...a, genpage: realPageBackend(server), opts: { workspaceDir } };
  } },
  { code: 'pages-update-identity-mismatch', what: 'a page whose update answers with another page\'s id', setup: (name) => {
    const a = makeTwoPageApp();
    a.spec.pages[1].name = name;
    const live = [{ pageId: OVERVIEW_ID, name: 'Overview' }, { pageId: DETAIL_ID, name }];
    const genpage = mockGenpageCli(live);
    const update = genpage.update;
    genpage.update = async (id, o) => { const up = await update(id, o); return o.name === name ? { ...up, pageId: OTHER_PAGE_ID } : up; };
    const manifest = manifestOf([{ key: 'overview', name: 'Overview', pageId: OVERVIEW_ID }, { key: 'detail', name, pageId: DETAIL_ID }]);
    return { ...a, genpage, sdk: mockSdk({ pageManifest: manifest, liveSitemapXml: pageSitemap([OVERVIEW_ID, DETAIL_ID]), pageRows: live.map((p) => ({ uxagentprojectid: p.pageId, name: p.name })) }).sdk };
  } },
  { code: 'pages-shared-across-apps', quotesName: false, what: 'a page another app\'s navigation also holds', setup: () => {
    const a = makeTwoPageApp();
    const live = [{ pageId: OVERVIEW_ID, name: 'Overview' }, { pageId: DETAIL_ID, name: 'Detail' }];
    const manifest = manifestOf([{ key: 'overview', name: 'Overview', pageId: OVERVIEW_ID }, { key: 'detail', name: 'Detail', pageId: DETAIL_ID }]);
    const sdk = mockSdk({ pageManifest: manifest, selfAppUnique: appUniqueName(a.spec), liveSitemapXml: pageSitemap([OVERVIEW_ID, DETAIL_ID]), pageRows: live.map((p) => ({ uxagentprojectid: p.pageId, name: p.name })),
      otherApps: [{ uniquename: 'contoso_secondapp', sitemapxml: pageSitemap([OVERVIEW_ID]) }] }).sdk;
    return { ...a, sdk, genpage: mockGenpageCli(live) };
  } },
  { code: 'pages-publish-failed', what: 'a publish the service refused for no reason a run again would change', setup: (name) => {
    const a = makeTwoPageApp();
    a.spec.pages[0].name = name;
    const genpage = mockGenpageCli();
    const create = genpage.create;
    genpage.create = async (o) => { const up = await create(o); return o.name === name ? { ...up, publish: { kind: 'failed', detail: 'PublishXml answered 500: the service is busy' } } : up; };
    return { ...a, genpage };
  } },
];
// The halt `scenario` ends the build with, for a page called `name`; the page doubles are disposed and the folder removed.
async function nameHaltOf(scenario, name) {
  const a = scenario.setup(name);
  const genpage = a.genpage || mockGenpageCli();
  try {
    let halt = null;
    try {
      await runSdkBuild(a.spec, { sdk: a.sdk || mockSdk().sdk, apply: true, env: BUILD_ENV, appDir: a.appDir, genpageCli: genpage, phases: PHASES, ...(a.opts || {}) });
    } catch (e) { halt = e; }
    return { halt, spec: a.spec };
  } finally {
    if (typeof genpage.dispose === 'function') await genpage.dispose();
    fs.rmSync(a.appDir, { recursive: true, force: true });
  }
}
for (const scenario of NAME_HALTS) {
  test(`deploy: the ${scenario.code} halt for ${scenario.what} is final for the build's retry, even for a page called "${HALT_NAME}"`, async () => {
    const { isTransientHalt } = require('../build-model-app.js');
    const { halt, spec } = await nameHaltOf(scenario, HALT_NAME);
    assert.ok(halt, 'the build halts');
    assert.strictEqual(halt.phase, 'pages');
    assert.strictEqual(halt.code, scenario.code);
    assert.strictEqual(isTransientHalt(halt, { spec }), false, 'the build does not run again for it');
    if (scenario.quotesName !== false) {
      assert.ok(halt.message.includes(HALT_NAME), 'the halt quotes the page\'s name');
      assert.strictEqual(isTransientHalt(new Error(halt.message), { spec }), true, 'its words alone would have read as a transient error');
    } else {
      assert.ok(halt.transient === false || (halt.cause && halt.cause.transient === false), 'the halt carries the marker itself: what it quotes is the maker\'s text too');
    }
  });
}

// The navigation links are resolved into a copy of each page, and that copy is checked once more — a tripwire for a defect in the checks before it. The resolver is made to leave a token here,
// as the test of that check does, and the halt it ends the build with is final for the retry too.
test('deploy: the halt for a token left in the resolved copy of a page called "SQL Timeout Report" is final for the build\'s retry', async () => {
  const { isTransientHalt } = require('../build-model-app.js');
  const resolverPath = require.resolve('../lib/pageref-resolver.js');
  const buildPath = require.resolve('../lib/sdk-build.js');
  const resolver = require(resolverPath);
  const real = resolver.resolvePageRefs;
  const live = [{ pageId: OVERVIEW_ID, name: HALT_NAME }, { pageId: DETAIL_ID, name: 'Detail' }];
  resolver.resolvePageRefs = (sources, keyToId) => {
    const resolved = real(sources, keyToId);
    const deployment = new Map(resolved.deployment);
    deployment.set('overview', deployment.get('overview').replace(`"${DETAIL_ID}"`, '"PAGEREF_detail"'));
    const { residual } = real(new Map([['overview', { code: deployment.get('overview') }]]), new Map());
    return { ...resolved, deployment, residual };
  };
  delete require.cache[buildPath];
  const { appDir, spec } = makeTwoPageApp();
  try {
    const { runSdkBuild: build } = require(buildPath);
    spec.pages[0].name = HALT_NAME;
    const manifest = manifestOf([{ key: 'overview', name: HALT_NAME, pageId: OVERVIEW_ID }, { key: 'detail', name: 'Detail', pageId: DETAIL_ID }]);
    const { sdk } = mockSdk({ pageManifest: manifest, manifestId: 'wr-manifest', liveSitemapXml: pageSitemap([OVERVIEW_ID, DETAIL_ID]), pageRows: live.map((p) => ({ uxagentprojectid: p.pageId, name: p.name })) });
    let halt = null;
    try { await build(spec, { sdk, apply: true, env: 'https://x', appDir, genpage: mockGenpageCli(live), phases: PHASES }); } catch (e) { halt = e; }
    assert.ok(halt, 'the build halts');
    assert.strictEqual(halt.code, 'pages-stray-pageref');
    assert.match(halt.message, /page "SQL Timeout Report" has PAGEREF_ token\(s\) left once its navigation links were resolved/);
    assert.strictEqual(isTransientHalt(halt, { spec }), false, 'the build does not run again for it');
    assert.strictEqual(isTransientHalt(new Error(halt.message), { spec }), true, 'its words alone would have read as a transient error');
  } finally {
    resolver.resolvePageRefs = real;
    delete require.cache[buildPath];
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});

// Through the real retry loop: one run of the pages phase, never four, and a log that does not blame the service — for each way a page can be called that reads as a transient error (the control
// is that the words alone do) and for a name that merely contains a status.
test('deploy: the build runs once — not four times — for a halt that quotes a page called like a transient error', async () => {
  const { buildModelApp, isTransientHalt } = require('../build-model-app.js');
  for (const name of [HALT_NAME, 'Please try again later', 'Concurrent Delete log', '503 Orders']) {
    const a = makeTwoPageApp({ malformed: true });
    a.spec.pages[0].name = name;
    try {
      const genpage = mockGenpageCli();
      let listings = 0;
      const enumerateEnv = genpage.enumerateEnv;
      genpage.enumerateEnv = async () => { listings += 1; return enumerateEnv(); };
      const { sdk } = mockSdk();
      const lines = [];
      let halt = null;
      try {
        await buildModelApp(a.spec, { apply: true, env: 'https://contoso.crm.dynamics.com', appDir: a.appDir, retryDelayMs: 0 }, {
          sdk, provisionSdk: sdk, genpage, sleep: async () => {}, log: (m) => lines.push(m),
          discoverOpDiffState: async () => ({ collision: { appExists: false, solutionExists: false }, forms: [], sitemap: null }),
        });
      } catch (e) { halt = e; }
      assert.ok(halt, `${name}: the build halts`);
      assert.strictEqual(halt.code, 'pages-malformed-navref', name);
      assert.strictEqual(listings, 1, `${name}: the pages phase ran once`);
      assert.deepStrictEqual(lines.filter((l) => /transient error|retrying/.test(l)), [], `${name}: and the build never says it is retrying`);
      if (name !== '503 Orders') assert.strictEqual(isTransientHalt(new Error(halt.message), { spec: a.spec }), true, `${name}: its words alone would have read as a transient error`);
    } finally { fs.rmSync(a.appDir, { recursive: true, force: true }); }
  }
});

// The marker is on the halts, not on the names: a failure that IS transient is run again for a page called "SQL Timeout Report" as for any other.
test('deploy: a transient failure is still run again for a page called like one — and the create is sent once', async () => {
  const { buildModelApp } = require('../build-model-app.js');
  const { appDir, spec } = onePageApp(HALT_NAME);
  try {
    const fake = new FakeSdk().script('list', new Error(TRY_AGAIN_LATER));
    const genpage = makeGenpageSdk('https://contoso.crm.dynamics.com', { sdk: fake, newId: () => UNCERTAIN_PAGE_ID });
    const { sdk } = mockSdk();
    const lines = [];
    const result = await buildModelApp(spec, { apply: true, env: 'https://contoso.crm.dynamics.com', appDir, retryDelayMs: 0 }, {
      sdk, provisionSdk: sdk, genpage, sleep: async () => {}, log: (m) => lines.push(m),
      discoverOpDiffState: async () => ({ collision: { appExists: false, solutionExists: false }, forms: [], sitemap: null }),
    });
    assert.strictEqual(result.ok, true);
    assert.ok(lines.some((l) => /transient error in pages — retrying/.test(l)), 'the build retried');
    assert.strictEqual(fake.count('pushArtifact'), 1, 'and the create went out once');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

// A refused publish is the one halt that quotes the page's name AND the service's own words, and the words are what say whether a run again can help ("… try again later"). So it is judged by the
// service's words alone: the same words that always made it a transient error still do, and the page's name no longer can.
test('deploy: a refused publish is run again when the service says to try later — and not when only the page\'s name says so', async () => {
  const { buildModelApp } = require('../build-model-app.js');
  const run = async (name, detail) => {
    const { appDir, spec } = makeTwoPageApp();
    spec.pages[0].name = name;
    try {
      const genpage = mockGenpageCli();
      let creates = 0;
      const create = genpage.create;
      genpage.create = async (o) => {
        const up = await create(o);
        if (o.name !== name) return up;
        creates += 1;
        return creates === 1 ? { ...up, publish: { kind: 'failed', detail } } : up;
      };
      const { sdk } = mockSdk();
      const lines = [];
      let halt = null;
      let result = null;
      try {
        result = await buildModelApp(spec, { apply: true, env: 'https://contoso.crm.dynamics.com', appDir, retryDelayMs: 0 }, {
          sdk, provisionSdk: sdk, genpage, sleep: async () => {}, log: (m) => lines.push(m),
          discoverOpDiffState: async () => ({ collision: { appExists: false, solutionExists: false }, forms: [], sitemap: null }),
        });
      } catch (e) { halt = e; }
      return { halt, result, creates, retried: lines.some((l) => /transient error in pages — retrying/.test(l)) };
    } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
  };
  const later = await run(HALT_NAME, TRY_AGAIN_LATER);
  assert.strictEqual(later.halt, null, 'the second run publishes it');
  assert.strictEqual(later.retried, true, 'the service said to try again later, so the build did');
  assert.strictEqual(later.creates, 2);
  for (const name of [HALT_NAME, 'Overview']) {
    const final = await run(name, 'PublishXml answered 500: the service is busy');
    assert.strictEqual(final.halt && final.halt.code, 'pages-publish-failed', name);
    assert.strictEqual(final.retried, false, `${name}: the service gave no reason to run again, and a page's name is not one`);
    assert.strictEqual(final.creates, 1, name);
  }
});

// ── What a rebuild records in a page's history ───────────────────────────────────────────────────────────────────────────────────────────────
// A page's conversation holds the prompt of each change made to it. The release before pages went through the SDK sent every page again on every run, so the history grew by one prompt per page per build — and
// by one more for each automatic re-run after a transient failure later in the same run. A page is written now only when what the spec asks for differs from what the page holds (`update`, lib/genpage-sdk.js:
// the source, and the name, data sources, model and bindings the spec gives), so the history grows by one turn per CHANGE, and a page nothing changed is neither written nor given a turn. These tests count the
// messages the page service holds and the writes it receives across rebuilds, through the real backend over the stateful fake of the page tables; the publish is covered by the tests above them.
test('deploy: an unchanged rebuild records no prompt however often it runs — and a change records one turn, on the page that changed, whatever kind of change it is', async () => {
  const { appDir, spec } = twoPageApp();
  const server = new FakeGenPageServer();
  try {
    const first = await buildPages(spec, appDir, realPageBackend(server));
    const ids = { ...first.created.pages };
    const history = () => Object.fromEntries(Object.entries(ids).map(([key, id]) => [key, server.messagesOf(id).length]));
    assert.deepStrictEqual(history(), { alpha: 2, beta: 2 }, 'a create records the prompt and the reply');
    const rebuild = async () => {
      const from = server.requests.length;
      await rebuildPages(spec, appDir, server, ids);
      const { changeSets, publishes, otherWrites } = requestsOf(server, from);
      return [changeSets, publishes, otherWrites];
    };
    // Three rebuilds, nothing changed: the new count of writes for a no-op rebuild of this app is zero — no change set, no publish, no other write — and no turn.
    for (let run = 1; run <= 3; run += 1) assert.deepStrictEqual(await rebuild(), [0, 0, 0], `rebuild ${run}: not one write`);
    assert.deepStrictEqual(history(), { alpha: 2, beta: 2 }, 'and not one prompt');

    // A page's source changes: one change set and one publish, for the page that changed, and the new turn on that page alone.
    fs.writeFileSync(path.join(appDir, 'beta.tsx'), fs.readFileSync(path.join(appDir, 'beta.tsx'), 'utf8').replace('>Beta<', '>Beta, edited<'), 'utf8');
    assert.deepStrictEqual(await rebuild(), [1, 1, 0], 'a changed source is written and published once');
    assert.deepStrictEqual(history(), { alpha: 2, beta: 4 }, 'with its turn, on the page that changed');
    assert.deepStrictEqual(await rebuild(), [0, 0, 0], 'and the rebuild after it is a no-op again');
    assert.deepStrictEqual(history(), { alpha: 2, beta: 4 });

    // What is not the source — the model the spec names — is part of the page too: a change to it is written, as a change to the source is, and once.
    spec.pages[1].model = 'gpt-4.1';
    assert.deepStrictEqual(await rebuild(), [1, 1, 0], 'a changed model is written and published once');
    assert.deepStrictEqual(history(), { alpha: 2, beta: 6 });
    assert.deepStrictEqual(await rebuild(), [0, 0, 0]);
    assert.deepStrictEqual(history(), { alpha: 2, beta: 6 }, 'and then it is held');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

// The build runs itself again, from its first phase, when a failure it takes for transient comes after the pages were written: a 503 on a later write, say. That run reads every page again and finds it
// holding what the spec asks for, so it writes none of them and gives none a second turn; the record of what was published (lib/page-publish-records.js) spares them a second publish too.
// The build here is the real one, through its own retry loop, with the first publish of the app — after both pages are written, in the sitemap finalize — refused once with a 503. It answers what the
// build returned, what it logged, and how many change sets the page service had received when the app's publish was refused.
async function buildThroughTransientFailure(spec, appDir, server, genpage) {
  const { buildModelApp } = require('../build-model-app.js');
  const { sdk } = mockSdk();
  const publishArtifact = sdk.publishArtifact;
  let refusedAt = null;
  sdk.publishArtifact = async (type, id, options) => {
    if (type === 'app' && refusedAt === null) {
      refusedAt = { changeSets: requestsOf(server).changeSets };
      throw Object.assign(new Error('Service Unavailable'), { statusCode: 503 });
    }
    return publishArtifact(type, id, options);
  };
  const lines = [];
  let result;
  try {
    result = await buildModelApp(spec, { apply: true, env: 'https://contoso.crm.dynamics.com', appDir, workspaceDir: path.join(appDir, '.maker-workspace'), retryDelayMs: 0 }, {
      sdk, provisionSdk: sdk, genpage, sleep: async () => {}, log: (m) => lines.push(m),
      discoverOpDiffState: async () => ({ collision: { appExists: false, solutionExists: false }, forms: [], sitemap: null }),
    });
  } finally { await genpage.dispose(); }
  return { result, lines, refusedAt };
}
test('deploy: the build\'s automatic re-run after a transient failure later in the same run sends no page again — each is written once, published once, and has its turn once', async () => {
  const { appDir, spec } = twoPageApp();
  const server = new FakeGenPageServer();
  try {
    const { result, lines, refusedAt } = await buildThroughTransientFailure(spec, appDir, server, realPageBackend(server));
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(refusedAt, { changeSets: 2 }, 'the failure came after both pages were written');
    assert.ok(lines.some((l) => /transient error in pages — retrying/.test(l)), 'the build ran again');
    const all = requestsOf(server);
    assert.deepStrictEqual([all.changeSets, all.publishes, all.otherWrites], [2, 2, 0], 'one write and one publish per page across both runs, and nothing else');
    assert.deepStrictEqual([...server.state.projects.keys()].sort(), Object.values(result.created.pages).sort(), 'one page per spec entry');
    for (const id of Object.values(result.created.pages)) assert.strictEqual(server.messagesOf(id).length, 2, `${id}: the prompt and the reply, once`);
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

// The record spares a page its second publish only when it provably describes what is published. Another writer that published over a page while the first run was recording it left that page unrecorded, so
// the re-run publishes it — and only it — and still writes nothing: the draft is the file, and what is wrong is the published copy.
test('deploy: the automatic re-run publishes the page another writer published over in the first run — that page alone, and without writing it', async () => {
  const { appDir, spec } = twoPageApp();
  const server = new FakeGenPageServer();
  const writer = realPageBackend(server);
  try {
    const alphaText = fs.readFileSync(path.join(appDir, 'alpha.tsx'), 'utf8');
    const genpage = realPageBackend(server);
    const readVersions = genpage.fileVersions;
    let overwritten = null;
    genpage.fileVersions = async (ids) => {
      if (overwritten === null) {
        overwritten = ids[0];
        await publishOver(server, writer, ids[0], alphaText.replace('>Alpha<', '>Somebody else<'));
      }
      return readVersions(ids);
    };
    const { result, lines, refusedAt } = await buildThroughTransientFailure(spec, appDir, server, genpage);
    const ids = result.created.pages;
    assert.strictEqual(result.ok, true);
    assert.strictEqual(overwritten, ids.alpha);
    assert.deepStrictEqual(refusedAt, { changeSets: 3 }, 'both pages were created and the other writer\'s update was written by then');
    assert.ok(lines.some((l) => /transient error in pages — retrying/.test(l)), 'the build ran again');
    assert.deepStrictEqual(server.published, [ids.alpha, ids.alpha, ids.beta, ids.alpha], 'Alpha: its create, the other writer, and the re-run that found it unrecorded; Beta: its create alone');
    const all = requestsOf(server);
    assert.deepStrictEqual([all.changeSets, all.otherWrites], [3, 0], 'two creates and the other writer\'s update: the re-run writes nothing');
    assert.strictEqual(publishedSource(server, ids.alpha), alphaText, 'and what runs is the file');
    assert.deepStrictEqual([ids.alpha, ids.beta].map((id) => server.messagesOf(id).length), [4, 2], 'the re-run records no turn: Alpha\'s second pair is the other writer\'s');
  } finally {
    await writer.dispose();
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});

// ── The build's retry reads the failure, not the words a maker chose ─────────────────────────────────────────────────────────────────────────────
// A halt's message quotes what the maker named — a page, a workspace folder, a source file — and the build used to read it as if the service had said it: a page, folder or file whose name holds "SQL Timeout"
// made a refusal no run could change run again, three more times, from the first phase. Each halt now declares what a run again may do (lib/retry-policy.js), and a failure it wraps is judged by its structure: the
// status, the transport, the SDK's own types. These tests drive the REAL retry loop over the real pages phase, with the name in a path, in a file error's cause, and in a page's name, and count the runs.
// halt-retry-policy.test.js holds every halt the build can raise against a table; the halts of the pages phase are held here, beside the page doubles.
const LABEL_503 = 'SQL Timeout 503 try again later';
async function driveBuild(spec, appDir, { genpage, engine = runBuild, runOpts = {}, sdk: given, opts = {}, deps = {} } = {}) {
  const { buildModelApp } = require('../build-model-app.js');
  const sdk = given || mockSdk().sdk;
  let attempts = 0;
  const lines = [];
  let halt = null;
  let result = null;
  try {
    // A workspace the engine is given is the build's too, as the CLI passes one to both: the build's lease is taken in it, and each attempt borrows it there.
    result = await buildModelApp(spec, { apply: true, env: 'https://contoso.crm.dynamics.com', appDir, retryDelayMs: 0, ...(runOpts.workspaceDir ? { workspaceDir: runOpts.workspaceDir } : {}), ...opts }, {
      sdk, provisionSdk: sdk, genpage, sleep: async () => {}, log: (m) => lines.push(m), warn: () => {}, verify: async () => ({ ok: true }),
      discoverOpDiffState: async () => ({ collision: { appExists: false, solutionExists: false }, forms: [], sitemap: null }),
      runBuild: async (s, o) => { attempts += 1; return engine(s, { ...o, phases: PHASES, ...runOpts }); },
      ...deps,
    });
  } catch (e) { halt = e; }
  return { halt, result, attempts, lines, retried: lines.filter((l) => /retrying/.test(l)).length };
}

test('deploy: the pages lease held by another build stops the build once — in a workspace folder called "SQL Timeout Workspace" as in any other', async () => {
  const { acquireAppPagesLease } = require('../lib/sdk-build.js');
  const { appDir, spec } = onePageApp('Overview');
  const workspaceDir = path.join(appDir, 'SQL Timeout Workspace');
  const lease = acquireAppPagesLease(workspaceDir, appUniqueName(spec));
  try {
    const out = await driveBuild(spec, appDir, { genpage: mockGenpageCli(), runOpts: { workspaceDir } });
    assert.strictEqual(out.halt && out.halt.code, 'pages-locked');
    assert.match(out.halt.message, /SQL Timeout Workspace/, 'the halt names the lease file, which lies in the maker\'s folder');
    assert.deepStrictEqual([out.attempts, out.retried], [1, 0], 'the lease belongs to a build still running: running the earlier phases again would not release it');
  } finally {
    lease.release();
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});

test('deploy: a page source that goes missing after the spec was checked stops the build once — a missing "SQL Timeout Report.tsx" is a file error, not a SQL timeout', async () => {
  const { appDir, spec } = onePageApp('Overview');
  spec.pages[0].source.codeFile = 'SQL Timeout Report.tsx';
  const file = path.join(appDir, 'SQL Timeout Report.tsx');
  fs.writeFileSync(file, 'export default function P(){ return null; }', 'utf8');
  try {
    const engine = async (s, o) => { fs.rmSync(file, { force: true }); return runBuild(s, o); };
    const out = await driveBuild(spec, appDir, { genpage: mockGenpageCli(), engine });
    assert.strictEqual(out.halt && out.halt.code, 'APP_SOURCE_PATH');
    assert.match(String(out.halt.cause && out.halt.cause.message), /ENOENT[\s\S]*SQL Timeout Report\.tsx/, 'the cause is the file error, which quotes the path');
    assert.deepStrictEqual([out.attempts, out.retried], [1, 0]);
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('deploy: a local page record that cannot be read stops the build once, in a folder called "SQL Timeout Workspace" — the receipts and the pending records both', async () => {
  const { appDir, spec } = onePageApp('Overview');
  const workspaceDir = path.join(appDir, 'SQL Timeout Workspace');
  fs.mkdirSync(workspaceDir);
  try {
    // A creation receipt that is not one: the first read of the workspace's records refuses it.
    fs.writeFileSync(path.join(workspaceDir, `page-ownership.created.${'0'.repeat(64)}.json`), '{}', 'utf8');
    const receipt = await driveBuild(spec, appDir, { genpage: mockGenpageCli(), runOpts: { workspaceDir } });
    assert.strictEqual(receipt.halt && receipt.halt.code, 'pages-identity-conflict');
    assert.match(receipt.halt.message, /could not read local page creation receipts[\s\S]*SQL Timeout Workspace/);
    assert.deepStrictEqual([receipt.attempts, receipt.retried], [1, 0], 'the receipt read');
    fs.rmSync(path.join(workspaceDir, `page-ownership.created.${'0'.repeat(64)}.json`));

    // The second read of the folder — the pending records — fails while the first did not: a permission that changed mid-run.
    const engine = async (s, o) => {
      const readdir = fs.readdirSync;
      let reads = 0;
      fs.readdirSync = function patched(p, ...args) {
        if (path.resolve(String(p)) === workspaceDir && (reads += 1) === 2) throw Object.assign(new Error(`EACCES: permission denied, scandir '${p}'`), { code: 'EACCES' });
        return readdir.call(this, p, ...args);
      };
      try { return await runBuild(s, o); } finally { fs.readdirSync = readdir; }
    };
    const pending = await driveBuild(spec, appDir, { genpage: mockGenpageCli(), engine, runOpts: { workspaceDir } });
    assert.strictEqual(pending.halt && pending.halt.code, 'pages-identity-conflict');
    assert.match(pending.halt.message, /could not read local records of page creations that were started[\s\S]*SQL Timeout Workspace/);
    assert.deepStrictEqual([pending.attempts, pending.retried], [1, 0], 'the pending read');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('deploy: a creation receipt that cannot be saved stops the build once, in a folder called "SQL Timeout Workspace" — the page exists, and running the earlier phases again would not save the receipt', async () => {
  const { appDir, spec } = onePageApp('Overview');
  const workspaceDir = path.join(appDir, 'SQL Timeout Workspace');
  try {
    const engine = async (s, o) => {
      const rename = fs.renameSync;
      // The receipt is written through a temp file and renamed into place (apply-snapshot-store.js writeFileAtomic): the rename of this record's file fails, as a disk that is full or read-only does.
      fs.renameSync = function patched(from, to, ...args) {
        if (/page-ownership\.created\.[0-9a-f]{64}\.json$/.test(String(to))) throw Object.assign(new Error(`EACCES: permission denied, rename '${from}' -> '${to}'`), { code: 'EACCES' });
        return rename.call(this, from, to, ...args);
      };
      try { return await runBuild(s, o); } finally { fs.renameSync = rename; }
    };
    const out = await driveBuild(spec, appDir, { genpage: mockGenpageCli(), engine, runOpts: { workspaceDir } });
    assert.strictEqual(out.halt && out.halt.code, 'pages-creation-receipt-failed');
    assert.match(out.halt.message, /was created as [\s\S]*its local receipt could not be saved[\s\S]*SQL Timeout Workspace/);
    assert.deepStrictEqual([out.attempts, out.retried], [1, 0]);
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

// The page backend reports a publish the service refused, or one that threw, BY VALUE, and the build used to take the words of what it caught as the service's: a file error on the maker's machine, with a path
// in it, read as a transient service error, and an error marked never-retry lost its mark on the way. The backend now passes the error it caught on, and the halt follows its structure.
test('deploy: a publish that fails on the maker\'s own machine is final and one the service refuses with a 503 is run again — the page is sent once either way, whatever it is called', async () => {
  const cases = [
    { what: 'a file error whose path holds "SQL Timeout"', failure: () => Object.assign(new Error("EACCES: permission denied, open 'C:\\Work\\SQL Timeout\\genPages\\page.json'"), { code: 'EACCES' }), runs: 1 },
    { what: 'an error that says it must never be retried', failure: () => Object.assign(new Error('The service is unavailable. Please try again later.'), { transient: false }), runs: 1 },
    { what: 'a 400 from the service', failure: () => connectionError(400, 'Bad request'), runs: 1 },
    { what: 'a 503', failure: () => connectionError(503, 'The service is unavailable.'), runs: 2 },
    { what: 'a 429', failure: () => connectionError(429, 'Too many requests.'), runs: 2 },
    { what: 'a reset of the connection', failure: () => connectionError(0, 'Request failed: read ECONNRESET'), runs: 2 },
  ];
  for (const { what, failure, runs } of cases) {
    const { appDir, spec } = onePageApp('SQL Timeout Report');
    const fake = new FakeSdk().script('publish', failure());
    const genpage = makeGenpageSdk('https://contoso.crm.dynamics.com', { sdk: fake, newId: () => UNCERTAIN_PAGE_ID });
    try {
      const out = await driveBuild(spec, appDir, { genpage, runOpts: { workspaceDir: path.join(appDir, '.maker-workspace') } });
      assert.strictEqual(out.attempts, runs, `${what}: the build ran ${runs} time(s)`);
      if (runs === 1) assert.strictEqual(out.halt && out.halt.code, 'pages-publish-failed', what);
      else assert.strictEqual(out.result && out.result.ok, true, `${what}: and the run again finished it`);
      assert.strictEqual(fake.count('pushArtifact'), 1, `${what}: the create was sent once`);
    } finally {
      await genpage.dispose();
      fs.rmSync(appDir, { recursive: true, force: true });
    }
  }
});

test('deploy: a listing of the environment\'s pages that is refused stops the build once; one whose answer says to try again later is run again', async () => {
  for (const [what, words, runs] of [['a refusal', 'permanent refusal', 1], ['the service saying to try later', 'The service is unavailable. Please try again later.', 2]]) {
    const { appDir, spec } = onePageApp('SQL Timeout Report');
    const genpage = mockGenpageCli();
    let listings = 0;
    genpage.enumerateEnv = async () => {
      listings += 1;
      return listings === 1 ? { ok: false, ids: [], error: `could not list the environment's generative pages: ${words}` } : { ok: true, ids: [], pages: [] };
    };
    try {
      const out = await driveBuild(spec, appDir, { genpage });
      assert.strictEqual(out.attempts, runs, what);
      if (runs === 1) assert.strictEqual(out.halt && out.halt.code, 'pages-existence-failed', what);
      else assert.strictEqual(out.result && out.result.ok, true, what);
    } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
  }
});

// The reads the pages phase makes of the app's navigation fail BY VALUE (lib/sitemap-pages.js), and used to be read for the words of the failure. The error itself now rides along, and the halt follows its structure: a 503
// or a 429 is run again — as the service's answer to a request, whatever anything is called — and a refusal, a typed error and an error that says it must not be run again are not.
const retriedFailures = () => [
  { what: 'a 503', failure: () => connectionError(503, 'The service is unavailable.'), runs: 2 },
  { what: 'a 429', failure: () => connectionError(429, 'Too many requests.'), runs: 2 },
  { what: 'a 504', failure: () => connectionError(504, 'The gateway timed out.'), runs: 2 },
  { what: 'a reset of the connection', failure: () => connectionError(0, 'Request failed: read ECONNRESET'), runs: 2 },
  { what: 'a 403', failure: () => connectionError(403, 'permission denied'), runs: 1 },
  { what: 'a typed refusal whose words say to try again later', failure: () => Object.assign(new Error(TRY_AGAIN_LATER), { code: 'VALIDATION_ERROR' }), runs: 1 },
  { what: 'an error that says it must not be run again', failure: () => Object.assign(new Error(TRY_AGAIN_LATER), { transient: false }), runs: 1 },
];

test('deploy: the sitemap read of the pages phase that fails is run again for a 503, a 429, a 504 and a reset — and not for a 403, a typed refusal or an error that says never, whatever they say', async () => {
  for (const { what, failure, runs } of retriedFailures()) {
    const { appDir, spec } = onePageApp('SQL Timeout Report');
    const { sdk } = mockSdk();
    const query = sdk.queryRecords;
    let thrown = 0;
    // The sitemap read of an app begins with its appmodule row by unique name (fetchSitemap); the first such read the pages phase makes fails.
    sdk.queryRecords = async (entity, o) => {
      if (entity === 'appmodule' && o && Array.isArray(o.select) && o.select.includes('appmoduleidunique') && thrown === 0) { thrown += 1; throw failure(); }
      return query(entity, o);
    };
    try {
      const out = await driveBuild(spec, appDir, { genpage: mockGenpageCli(), sdk, runOpts: { workspaceDir: path.join(appDir, '.maker-workspace') } });
      assert.strictEqual(out.attempts, runs, `${what}: the build ran ${runs} time(s)`);
      if (runs === 1) assert.strictEqual(out.halt && out.halt.code, 'pages-sitemap-read-failed', what);
      else assert.strictEqual(out.result && out.result.ok, true, `${what}: and the run again finished it`);
    } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
  }
});

test('deploy: the scan for pages shared across apps that fails is run again for a 503, a 429, a 504 and a reset — and not for a 403, a typed refusal or an error that says never, whatever they say', async () => {
  for (const { what, failure, runs } of retriedFailures()) {
    const a = makeTwoPageApp();
    const live = [{ pageId: OVERVIEW_ID, name: 'Overview' }, { pageId: DETAIL_ID, name: 'Detail' }];
    const manifest = manifestOf([{ key: 'overview', name: 'Overview', pageId: OVERVIEW_ID }, { key: 'detail', name: 'Detail', pageId: DETAIL_ID }]);
    const { sdk } = mockSdk({ pageManifest: manifest, selfAppUnique: appUniqueName(a.spec), liveSitemapXml: pageSitemap([OVERVIEW_ID, DETAIL_ID]), pageRows: live.map((p) => ({ uxagentprojectid: p.pageId, name: p.name })) });
    const query = sdk.queryRecords;
    let thrown = 0;
    // The scan lists every app, with no filter by unique name: the first such list fails.
    sdk.queryRecords = async (entity, o) => {
      if (entity === 'appmodule' && !((o && o.filter) || '').includes('uniquename eq') && thrown === 0) { thrown += 1; throw failure(); }
      return query(entity, o);
    };
    try {
      const out = await driveBuild(a.spec, a.appDir, { genpage: mockGenpageCli(live), sdk, runOpts: { workspaceDir: path.join(a.appDir, '.maker-workspace') } });
      assert.strictEqual(out.attempts, runs, `${what}: the build ran ${runs} time(s)`);
      if (runs === 1) assert.strictEqual(out.halt && out.halt.code, 'pages-shared-check-failed', what);
      else assert.strictEqual(out.result && out.result.ok, true, `${what}: and the run again finished it`);
    } finally { fs.rmSync(a.appDir, { recursive: true, force: true }); }
  }
});

test('deploy: a listing of the environment\'s pages that fails is judged by the error the backend caught, not by the words it printed — a 503 behind innocent words is run again, a typed refusal behind "try again later" is not', async () => {
  const { withCause } = require('../lib/retry-policy.js');
  for (const { what, failure, runs } of retriedFailures()) {
    const { appDir, spec } = onePageApp('SQL Timeout Report');
    const genpage = mockGenpageCli();
    let listings = 0;
    genpage.enumerateEnv = async () => {
      listings += 1;
      const error = failure();
      // The words the backend prints are its own and the error's, and say nothing here: what is judged is the error beside them.
      return listings === 1 ? withCause({ ids: [], ok: false, error: `could not list the environment's generative pages: ${what}` }, error) : { ok: true, ids: [], pages: [] };
    };
    try {
      const out = await driveBuild(spec, appDir, { genpage });
      assert.strictEqual(out.attempts, runs, `${what}: the build ran ${runs} time(s)`);
      if (runs === 1) assert.strictEqual(out.halt && out.halt.code, 'pages-existence-failed', what);
      else assert.strictEqual(out.result && out.result.ok, true, `${what}: and the run again finished it`);
    } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
  }
});

// ── The record certifies the runtime that was published, and the row that names the page ────────────────────────────────────────────────────────────
// What the record says is: this content was published, and the page's rows have not moved since. Two things the proof of it used to miss. (1) The compiled output — what actually runs — was not compared: another
// writer that published other compiled bytes under the SAME source, and put the original back as a draft, left a page whose draft equalled the file, whose source matched and whose versions agreed twice, so every
// rebuild skipped it while it ran the other writer's bytes. The build now asks the backend for the hash of the compiled output the draft held when it published (`runtimeEvidence`), and the published copy read
// back must hold it. (2) The page's own row — its name — is not one of its files: a rename inside the two reads of the file versions moved none of them. The row's version is read beside the files', in the proof
// and in every later check. And a record the earlier proof wrote (schema 2) can no longer vouch for anything: it is read as a record with no versions, and the page is proved again.
const publishedText = (server, pageId, file) => Buffer.from(server.publishedPages.get(pageId).files.find((f) => f.filename === file).content).toString('utf8');

test('deploy: a page whose COMPILED OUTPUT alone was published over by another writer is not recorded as published — the record certifies the runtime that runs, not only the source', async () => {
  const { appDir, spec } = twoPageApp();
  const server = new FakeGenPageServer();
  const gp = realPageBackend(server);
  const other = realPageBackend(server);
  try {
    let target = null;
    let original = null;
    const readVersions = gp.fileVersions;
    gp.fileVersions = async (ids) => {
      if (target === null) {
        target = ids[0];
        original = server.rowText(target, COMPILED_FILE);
        const different = original.replace('"Alpha"', '"Other published runtime"');
        assert.notStrictEqual(different, original, 'the compiled output of the fixture names the page');
        // Another writer saves other compiled bytes under the SAME source and publishes them, then puts the original bytes back as a draft: the source and the settings never change.
        server.otherWorkspaceDraft(target, COMPILED_FILE, different);
        assert.strictEqual((await other.update(target, { source: server.rowText(target, PAGE_FILE) })).publish.kind, 'verified');
        server.otherWorkspaceDraft(target, COMPILED_FILE, original);
      }
      return readVersions(ids);
    };
    const warnings = [];
    const first = await buildPages(spec, appDir, gp, { warn: (m) => warnings.push(m) });
    const ids = { ...first.created.pages };
    assert.strictEqual(target, ids.alpha);
    assert.match(publishedText(server, target, COMPILED_FILE), /Other published runtime/, 'what runs is the other writer\'s compiled output, and the draft holds the original');
    assert.strictEqual(server.rowText(target, COMPILED_FILE), original);
    const entry = publishedOf(spec, appDir).get(target);
    assert.ok(!entry || entry.files === null, 'so the page is not recorded with versions');
    assert.ok(publishedOf(spec, appDir).get(ids.beta).files, 'the page next to it, which nobody touched, is recorded');
    assert.ok(warnings.some((m) => /page "Alpha"/.test(m) && /compiled output/.test(m) && /published again from elsewhere/.test(m)), `the build said why: ${warnings.join(' | ')}`);

    const before = server.published.length;
    await rebuildPages(spec, appDir, server, ids);
    assert.deepStrictEqual(server.published.slice(before), [target], 'the next build publishes that page, and only that page');
    assert.strictEqual(publishedText(server, target, COMPILED_FILE), original, 'and what runs is the original compiled output again');
    const after = server.published.length;
    await rebuildPages(spec, appDir, server, ids);
    assert.strictEqual(server.published.length, after, 'after which the page is left alone');
  } finally {
    await other.dispose();
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});

test('deploy: a page another writer RENAMED inside the proof — published, and the draft put back — is not recorded as published, though no file row moved', async () => {
  const { appDir, spec } = twoPageApp();
  const server = new FakeGenPageServer();
  const gp = realPageBackend(server);
  const other = realPageBackend(server);
  try {
    const readCopy = gp.publishedDiffers;
    let target = null;
    gp.publishedDiffers = async (id, args, expected) => {
      const answer = await readCopy(id, args, expected);
      if (target === null) {
        target = id;
        const files = server.filesOf(id).map((f) => [f.id, f.version]);
        // After the published copy was read, another writer renames the page and publishes it, and puts the name back as a draft. Its publish moves no file row: the content did not change.
        assert.strictEqual((await other.update(id, { source: server.rowText(id, PAGE_FILE), name: 'Other published name' })).publish.kind, 'verified');
        const draft = server.state.projects.get(id);
        draft.name = args.name;
        draft.etag = server.nextEtag();
        assert.deepStrictEqual(server.filesOf(id).map((f) => [f.id, f.version]), files, 'a rename moves no file row\'s version, so the two reads of the files agree');
      }
      return answer;
    };
    const first = await buildPages(spec, appDir, gp);
    const ids = { ...first.created.pages };
    assert.strictEqual(target, ids.alpha);
    assert.strictEqual(server.publishedPages.get(target).project.name, 'Other published name', 'what runs is under the other writer\'s name, and the draft is named as the spec says');
    const entry = publishedOf(spec, appDir).get(target);
    assert.ok(!entry || entry.files === null, 'so the page is not recorded with versions');
    const before = server.published.length;
    await rebuildPages(spec, appDir, server, ids);
    assert.deepStrictEqual(server.published.slice(before), [target], 'the next build publishes that page, and only that page');
    assert.strictEqual(server.publishedPages.get(target).project.name, 'Alpha', 'under the name the spec gives it');
  } finally {
    await other.dispose();
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});

test('deploy: a page renamed from elsewhere AFTER it was recorded is published again — the record\'s check reads the page\'s own row, as the proof does', async () => {
  const { appDir, spec } = twoPageApp();
  const server = new FakeGenPageServer();
  const other = realPageBackend(server);
  try {
    const first = await buildPages(spec, appDir, realPageBackend(server));
    const ids = { ...first.created.pages };
    assert.ok(publishedOf(spec, appDir).get(ids.alpha).files.has(ids.alpha), 'the record holds the version of the page\'s own row, keyed by the page\'s id');
    assert.strictEqual((await other.update(ids.alpha, { source: server.rowText(ids.alpha, PAGE_FILE), name: 'Renamed elsewhere' })).publish.kind, 'verified');
    const draft = server.state.projects.get(ids.alpha);
    draft.name = 'Alpha';
    draft.etag = server.nextEtag();
    const before = server.published.length;
    await rebuildPages(spec, appDir, server, ids);
    assert.deepStrictEqual(server.published.slice(before), [ids.alpha], 'the page that was renamed is published again, and the one beside it is not');
    assert.strictEqual(server.publishedPages.get(ids.alpha).project.name, 'Alpha');
    const after = server.published.length;
    await rebuildPages(spec, appDir, server, ids);
    assert.strictEqual(server.published.length, after, 'and then it is left alone');
  } finally {
    await other.dispose();
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});

// What the proof cannot read, it does not certify. Each of these leaves a page unrecorded and costs the next build one publish of it — never a wrong skip.
test('deploy: a page whose own row\'s version cannot be read, or whose publish gave no evidence of the compiled output, is not recorded — the next build publishes it and records it', async () => {
  const ways = {
    'the row\'s version cannot be read': (gp) => { gp.projectVersions = async () => ({ ok: false, error: 'unavailable' }); },
    'the backend cannot read the row\'s version': (gp) => { gp.projectVersions = undefined; },
    'the publish gave no evidence of the compiled output': (gp) => {
      for (const verb of ['create', 'update']) {
        const original = gp[verb];
        gp[verb] = async (...args) => { const done = await original(...args); delete done.runtimeSha256; return done; };
      }
    },
    'the backend answers without the compiled output it read — it did not compare the runtime': (gp) => {
      const original = gp.publishedDiffers;
      gp.publishedDiffers = async (id, args) => original(id, args);
    },
  };
  for (const [what, impair] of Object.entries(ways)) {
    const { appDir, spec } = twoPageApp();
    const server = new FakeGenPageServer();
    try {
      const gp = realPageBackend(server);
      impair(gp);
      const first = await buildPages(spec, appDir, gp);
      const ids = { ...first.created.pages };
      for (const id of Object.values(ids)) {
        const entry = publishedOf(spec, appDir).get(id);
        assert.ok(!entry || entry.files === null, `${what}: ${id} is not recorded with versions`);
      }
      const before = server.published.length;
      await rebuildPages(spec, appDir, server, ids);
      assert.deepStrictEqual(server.published.slice(before).sort(), Object.values(ids).sort(), `${what}: the next build publishes both pages`);
      const after = server.published.length;
      await rebuildPages(spec, appDir, server, ids);
      assert.strictEqual(server.published.length, after, `${what}: and records them, so the build after that publishes nothing`);
      for (const id of Object.values(ids)) assert.ok(publishedOf(spec, appDir).get(id).files.size >= 5, `${what}: with the rows' versions`);
    } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
  }
});

test('deploy: a record the earlier proof wrote (schema 2) does not skip a publish — it is read as a record with no versions, so the page is proved again', async () => {
  const { appDir, spec } = twoPageApp();
  const server = new FakeGenPageServer();
  const other = realPageBackend(server);
  try {
    const first = await buildPages(spec, appDir, realPageBackend(server));
    const ids = { ...first.created.pages };
    const alphaText = fs.readFileSync(path.join(appDir, 'alpha.tsx'), 'utf8');
    // Another writer publishes other content and puts the build's content back as a draft: the draft is the file, and the page that runs is not.
    await publishOver(server, other, ids.alpha, alphaText.replace('>Alpha<', '>Somebody else<'));
    // What the earlier proof recorded for such a page: this build's hash, with the versions of the FILE rows as they were by then (it read them once, after the publish, and nothing else).
    const pages = {};
    for (const id of Object.values(ids)) {
      pages[id] = { fingerprint: publishedOf(spec, appDir).get(id).fingerprint, files: Object.fromEntries(server.filesOf(id).map((f) => [f.id, String(f.version)])) };
    }
    const { environmentFingerprint } = require('../lib/page-ownership-records.js');
    const workspace = path.join(appDir, '.maker-workspace');
    fs.writeFileSync(publishedRecordPath(workspace, appUniqueName(spec), BUILD_ENV), `${JSON.stringify({ schemaVersion: 2, environmentFingerprint: environmentFingerprint(BUILD_ENV), appUniqueName: appUniqueName(spec).toLowerCase(), pages })}\n`);
    assert.ok([...publishedOf(spec, appDir).values()].every((entry) => entry.files === null), 'a schema 2 record is read as one with no versions');

    const before = server.published.length;
    await rebuildPages(spec, appDir, server, ids);
    assert.deepStrictEqual(server.published.slice(before).sort(), Object.values(ids).sort(), 'every page is proved again, which costs one publish each, once');
    assert.strictEqual(publishedSource(server, ids.alpha), alphaText, 'and the page the other writer published over runs the file again');
    const after = server.published.length;
    await rebuildPages(spec, appDir, server, ids);
    assert.strictEqual(server.published.length, after, 'after which a rebuild publishes nothing');
  } finally {
    await other.dispose();
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});

// ── A page write the service throttles ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// A throttle (HTTP 429) refuses a request before it starts, so the page's change set committed nothing, and the page backend waits it out and sends it again inside the pages phase — under the id it minted (a create) or
// the turn identity it recorded (an update) — without the build running again. One that outlasts the backend's waits wrote nothing either and reads as the service's to say: the build runs again, as for any transient
// failure, and the page is written once, by the run that gets through. These tests drive the REAL build, its retry loop, the real backend and the real SDK over the stateful fake of the page tables, with the waits recorded
// and not taken.
const throttleBackend = (server, slept) => makeGenpageSdk(PAGE_SERVICE, { httpClient: server.http(), sleep: async (ms) => { slept.push(ms); }, random: () => 0 });
const pagesWorkspace = (appDir) => ({ workspaceDir: path.join(appDir, '.maker-workspace') });

test('deploy: a page write the service throttles once (429) is waited out inside the pages phase — the build runs once, and the page, its turn and its publish are each there once', async () => {
  const { appDir, spec } = onePageApp('Overview');
  fs.writeFileSync(path.join(appDir, 'p.tsx'), PAGE_SOURCE, 'utf8');
  const server = new FakeGenPageServer();
  server.failBatch = (n) => (n === 1 ? { status: 429, headers: { 'retry-after': '2' } } : undefined);
  const slept = [];
  const genpage = throttleBackend(server, slept);
  try {
    const out = await driveBuild(spec, appDir, { genpage, runOpts: pagesWorkspace(appDir) });
    assert.strictEqual(out.halt, null);
    assert.strictEqual(out.result.ok, true);
    assert.deepStrictEqual([out.attempts, out.retried], [1, 0], 'the backend rode it out: the build did not have to run again');
    assert.deepStrictEqual(slept, [2000], 'the wait the answer asked for');
    const id = out.result.created.pages.p;
    assert.deepStrictEqual([...server.state.projects.keys()], [id], 'one page');
    assert.strictEqual(server.messagesOf(id).length, 2, 'the prompt and the reply, once');
    assert.deepStrictEqual(server.published, [id], 'published once');
    assert.strictEqual(server.batches.length, 2, 'the change set that was refused, and the one that was taken');
    assert.strictEqual(pendingOf(spec, appDir).size, 0, 'and the record of the creation under way is consumed');
  } finally {
    await genpage.dispose();
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});

test('deploy: a throttle that outlasts the backend\'s waits writes nothing and is run again by the build — the page, a "SQL Timeouts" one, is there once, from the run that got through', async () => {
  const { appDir, spec } = onePageApp('SQL Timeouts');
  fs.writeFileSync(path.join(appDir, 'p.tsx'), PAGE_SOURCE, 'utf8');
  const server = new FakeGenPageServer();
  // The six sends of the first run are refused, and the first of the second run is taken.
  server.failBatch = (n) => (n <= 6 ? 429 : undefined);
  const slept = [];
  const genpage = throttleBackend(server, slept);
  try {
    const out = await driveBuild(spec, appDir, { genpage, runOpts: pagesWorkspace(appDir) });
    assert.strictEqual(out.halt, null);
    assert.strictEqual(out.result.ok, true);
    assert.deepStrictEqual([out.attempts, out.retried], [2, 1], 'the build ran again: the throttle is the service\'s to say, whatever the page is called');
    assert.deepStrictEqual(slept, [1000, 2000, 4000, 8000, 8000], 'the waits between the first run\'s sends');
    const id = out.result.created.pages.p;
    assert.deepStrictEqual([...server.state.projects.keys()], [id], 'one page');
    assert.strictEqual(server.messagesOf(id).length, 2);
    assert.strictEqual(server.batches.length, 7, 'six refused change sets, then the one that was taken');
    assert.strictEqual(pendingOf(spec, appDir).size, 0);
  } finally {
    await genpage.dispose();
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});

test('deploy: a throttle that never lifts ends the build with nothing written and nothing left behind — a healthy build afterwards creates the page once', async () => {
  const { appDir, spec } = onePageApp('Overview');
  fs.writeFileSync(path.join(appDir, 'p.tsx'), PAGE_SOURCE, 'utf8');
  const server = new FakeGenPageServer();
  server.failBatch = () => 429;
  const genpage = throttleBackend(server, []);
  try {
    const out = await driveBuild(spec, appDir, { genpage, runOpts: pagesWorkspace(appDir) });
    assert.ok(out.halt, 'the build stops');
    assert.strictEqual(out.halt.phase, 'pages');
    assert.match(out.halt.message, /was not created \(nothing was written\)[\s\S]*throttled/);
    assert.ok(out.attempts > 1, `the failure reads as the service's, so the build ran again: ${out.attempts} run(s)`);
    assert.strictEqual(out.retried, out.attempts - 1);
    assert.strictEqual(server.batches.length, out.attempts * 6, 'six sends in each run, and no seventh');
    assert.strictEqual(server.state.projects.size, 0, 'nothing was written');
    assert.strictEqual(pendingOf(spec, appDir).size, 0, 'a creation that was refused every time leaves no record of one under way');
    assert.deepStrictEqual(receiptsOf(spec, appDir), []);
  } finally { await genpage.dispose(); }

  // The service lets requests through again: the next build creates the page, once.
  server.failBatch = undefined;
  const healthy = throttleBackend(server, []);
  try {
    const out = await driveBuild(spec, appDir, { genpage: healthy, runOpts: pagesWorkspace(appDir) });
    assert.strictEqual(out.halt, null);
    assert.strictEqual(out.result.ok, true);
    const id = out.result.created.pages.p;
    assert.deepStrictEqual([...server.state.projects.keys()], [id]);
    assert.strictEqual(server.messagesOf(id).length, 2);
  } finally {
    await healthy.dispose();
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});

test('deploy: an edited page whose update the service throttles is waited out and written once — its turn is recorded once, and the build runs once; one that is throttled for good is not half-written', async () => {
  const { appDir, spec } = onePageApp('Overview');
  fs.writeFileSync(path.join(appDir, 'p.tsx'), PAGE_SOURCE, 'utf8');
  const server = new FakeGenPageServer();
  const first = throttleBackend(server, []);
  let id;
  try {
    id = (await driveBuild(spec, appDir, { genpage: first, runOpts: pagesWorkspace(appDir) })).result.created.pages.p;
  } finally { await first.dispose(); }
  assert.strictEqual(server.messagesOf(id).length, 2);

  // The author edits the page; the update's change set is refused once.
  const edited = PAGE_SOURCE.replace('Page</div>', 'Edited</div>');
  fs.writeFileSync(path.join(appDir, 'p.tsx'), edited, 'utf8');
  const sentBefore = server.batches.length;
  server.failBatch = (n) => (n === sentBefore + 1 ? { status: 429, headers: { 'retry-after': '4' } } : undefined);
  const slept = [];
  const second = throttleBackend(server, slept);
  try {
    const out = await driveBuild(spec, appDir, { genpage: second, runOpts: pagesWorkspace(appDir) });
    assert.strictEqual(out.halt, null);
    assert.deepStrictEqual([out.attempts, out.retried], [1, 0]);
    assert.deepStrictEqual(slept, [4000]);
    assert.strictEqual(server.rowText(id, 'src/pages/page.tsx'), edited, 'the page holds the edit');
    assert.strictEqual(server.messagesOf(id).length, 4, 'the turn is recorded once, after the create\'s own');
    assert.strictEqual(server.batches.length, sentBefore + 2);
  } finally { await second.dispose(); }

  // Another edit that the service throttles every time: the page is as it was, no turn is recorded, and the next healthy build writes it once.
  const again = edited.replace('Edited</div>', 'Edited again</div>');
  fs.writeFileSync(path.join(appDir, 'p.tsx'), again, 'utf8');
  server.failBatch = () => 429;
  const stuck = throttleBackend(server, []);
  const writesBefore = server.batches.length;
  try {
    const out = await driveBuild(spec, appDir, { genpage: stuck, runOpts: pagesWorkspace(appDir) });
    assert.ok(out.halt, 'the build stops');
    assert.match(out.halt.message, /failed and wrote nothing[\s\S]*throttled/);
    assert.ok(out.attempts > 1, 'after running again');
    assert.strictEqual(server.batches.length, writesBefore + out.attempts * 6);
    assert.strictEqual(server.rowText(id, 'src/pages/page.tsx'), edited, 'the page is as it was');
    assert.strictEqual(server.messagesOf(id).length, 4, 'and no turn was recorded');
  } finally { await stuck.dispose(); }

  server.failBatch = undefined;
  const healthy = throttleBackend(server, []);
  try {
    const out = await driveBuild(spec, appDir, { genpage: healthy, runOpts: pagesWorkspace(appDir) });
    assert.strictEqual(out.halt, null);
    assert.strictEqual(server.rowText(id, 'src/pages/page.tsx'), again);
    assert.strictEqual(server.messagesOf(id).length, 6, 'one more turn, once');
  } finally {
    await healthy.dispose();
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});

// ── What the service asked crosses to the build, and the waits of the run's layers are one budget ─────────────────────────────────────────────────────
// The backend waits out a throttled page write between its sends; when its six sends are not enough it hands the build what the last answer asked, as a moment before which nothing may be sent, and the build waits for THAT before
// it runs the pages phase again — not for its own shorter backoff. The waiting those two layers do, and the HTTP client's own waits for a throttled read or publish (pinned at the end of this file), are one budget of five minutes
// (lib/throttle-budget.js). A wait that does not fit stops the run with a halt that says what the service asked and that a later run continues. These tests drive the real build, its retry loop,
// the real backend and the real SDK, with each layer's waits recorded in one list.
const waitsOf = (events) => events.filter((e) => e.ms !== undefined);
const totalWait = (events) => waitsOf(events).reduce((sum, e) => sum + e.ms, 0);
function throttledSetup(name, refuse) {
  const { appDir, spec } = onePageApp(name);
  fs.writeFileSync(path.join(appDir, 'p.tsx'), PAGE_SOURCE, 'utf8');
  const server = new FakeGenPageServer();
  const events = [];
  const warnings = [];
  server.failBatch = (n) => { events.push({ send: n }); return refuse(n); };
  const genpage = makeGenpageSdk(PAGE_SERVICE, { httpClient: server.http(), sleep: async (ms) => { events.push({ who: 'backend', ms }); }, random: () => 0 });
  const drive = () => driveBuild(spec, appDir, {
    genpage, runOpts: pagesWorkspace(appDir), opts: { retryDelayMs: undefined },
    deps: { sleep: async (ms) => { events.push({ who: 'build', ms }); }, warn: (m) => warnings.push(m) },
  });
  return { appDir, spec, server, events, warnings, genpage, drive };
}

test('deploy: the wait a throttled page write was asked to take crosses to the build — six refusals asking for 7 s, and the build waits 7 s, not its own 3 s, before the seventh send', async () => {
  const run = throttledSetup('SQL Timeout Reader', (n) => (n <= 6 ? { status: 429, headers: { 'retry-after': '7' } } : undefined));
  try {
    const out = await run.drive();
    assert.strictEqual(out.halt, null);
    assert.strictEqual(out.result.ok, true);
    assert.strictEqual(out.attempts, 2, 'the sixth refusal outlasted the backend\'s sends, and the build ran again');
    assert.strictEqual(run.server.state.projects.size, 1, 'one page');
    assert.strictEqual(run.server.batches.length, 7);
    const sixth = run.events.findIndex((e) => e.send === 6);
    const seventh = run.events.findIndex((e) => e.send === 7);
    const between = waitsOf(run.events.slice(sixth + 1, seventh));
    assert.deepStrictEqual(between.map((e) => [e.who, e.ms]), [['build', 7000]], 'between the sixth send and the seventh the build waited what the service asked, whole');
    assert.deepStrictEqual(waitsOf(run.events.slice(0, sixth)).map((e) => e.ms), [7000, 7000, 7000, 8000, 8000], 'and before the sixth, the backend: the longer of its schedule and the ask');
    assert.match(out.lines.join('\n'), /retrying \(attempt 1\/3\) after 7000ms.*the service asked to wait 7 s/);
  } finally {
    await run.genpage.dispose();
    fs.rmSync(run.appDir, { recursive: true, force: true });
  }
});

test('deploy: a service that keeps asking for a minute is waited for five minutes by the backend and the build together — then the build stops with a halt that says what it asked', async () => {
  const { isTransientHalt } = require('../build-model-app.js');
  const run = throttledSetup('Overview', () => ({ status: 429, headers: { 'retry-after': '60' } }));
  try {
    const out = await run.drive();
    assert.ok(out.halt, 'the build stops');
    assert.strictEqual(out.halt.code, 'throttle-budget-exhausted');
    assert.strictEqual(out.halt.phase, 'pages');
    assert.strictEqual(isTransientHalt(out.halt), true, 'a transient halt: nothing is wrong with the build, and a later run can go on');
    assert.match(out.halt.message, /the service asked to wait 60 s before the next send, which does not fit in what is left of the 5 minutes a run allows itself for waiting out a throttled service \(300 s are spent\)/);
    assert.match(out.halt.message, /run the same command again later, and it continues from here/);
    assert.strictEqual(out.attempts, 1, 'the run that spent the budget is the only one: a second would only wait again');
    assert.strictEqual(totalWait(run.events), 300000, 'five waits of a minute, and no more — twenty minutes of silent waiting are not scheduled any more');
    assert.strictEqual(run.server.batches.length, 6, 'six sends, all refused');
    assert.strictEqual(run.server.state.projects.size, 0, 'nothing was written');
    assert.strictEqual(pendingOf(run.spec, run.appDir).size, 0, 'and no creation is left under way');
    const announced = run.warnings.filter((w) => /^generative page "Overview": the service throttled the write/.test(w));
    assert.strictEqual(announced.length, 5, 'and each of the waits, which are all longer than a few seconds, was announced on the warn seam (stderr)');
    assert.ok(announced.every((w) => /^generative page "Overview": the service throttled the write \(HTTP 429\); waiting 60 s before sending it again \(\d+ s of the 5 minutes/.test(w)), announced.join('\n'));
  } finally {
    await run.genpage.dispose();
    fs.rmSync(run.appDir, { recursive: true, force: true });
  }
});

test('deploy: an ask longer than the whole budget stops the run at once — one change set sent, nothing waited for — and a build that finds the service healthy afterwards writes the page once', async () => {
  const run = throttledSetup('Overview', (n) => (n === 1 ? { status: 429, headers: { 'retry-after': '600' } } : undefined));
  try {
    const out = await run.drive();
    assert.ok(out.halt);
    assert.strictEqual(out.halt.code, 'throttle-budget-exhausted');
    assert.match(out.halt.message, /the service asked to wait 600 s before the next send, which does not fit in what is left of the 5 minutes a run allows itself for waiting out a throttled service \(0 s are spent\)/);
    assert.strictEqual(out.attempts, 1);
    assert.deepStrictEqual(waitsOf(run.events), [], 'nothing was waited for');
    assert.strictEqual(run.server.batches.length, 1);
    assert.strictEqual(run.server.state.projects.size, 0);
    // The service lets requests through: the next build, which starts its own budget, creates the page once.
    const again = await run.drive();
    assert.strictEqual(again.halt, null);
    assert.strictEqual(run.server.state.projects.size, 1);
    assert.strictEqual(run.server.batches.length, 2);
  } finally {
    await run.genpage.dispose();
    fs.rmSync(run.appDir, { recursive: true, force: true });
  }
});

test('deploy: the budget is the run\'s for an update as it is for a create — an edited page whose update is throttled for a minute, in a run that has spent 250 s of its 300, is stopped at once and left as it was', async () => {
  const { makeThrottleBudget } = require('../lib/throttle-budget.js');
  const run = throttledSetup('Overview', () => undefined);
  try {
    const created = await run.drive();
    assert.strictEqual(created.halt, null);
    const id = created.result.created.pages.p;
    // The author edits the page; the update's change set is refused, asking for a minute — a wait that fits a budget of its own, and not what is left of the run's.
    fs.writeFileSync(path.join(run.appDir, 'p.tsx'), PAGE_SOURCE.replace('Page</div>', 'Edited</div>'), 'utf8');
    const sent = run.server.batches.length;
    run.server.failBatch = (n) => { run.events.push({ send: n }); return n === sent + 1 ? { status: 429, headers: { 'retry-after': '60' } } : undefined; };
    const budget = makeThrottleBudget();
    budget.spend(250000);
    const waits = [];
    const out = await driveBuild(run.spec, run.appDir, {
      genpage: run.genpage, runOpts: pagesWorkspace(run.appDir), opts: { retryDelayMs: undefined },
      deps: { throttle: budget, sleep: async (ms) => { waits.push(ms); }, warn: () => {} },
    });
    assert.ok(out.halt, 'the build stops');
    assert.strictEqual(out.halt.code, 'throttle-budget-exhausted');
    assert.match(out.halt.message, /the service asked to wait 60 s before the next send, which does not fit in what is left of the 5 minutes a run allows itself for waiting out a throttled service \(250 s are spent\)/);
    assert.strictEqual(out.attempts, 1);
    assert.strictEqual(run.server.batches.length, sent + 1, 'the update was sent once, and not again');
    assert.deepStrictEqual([...waitsOf(run.events), ...waits], [], 'and nothing was waited for');
    assert.strictEqual(run.server.rowText(id, 'src/pages/page.tsx'), PAGE_SOURCE, 'the page is as it was');
    assert.strictEqual(run.server.messagesOf(id).length, 2, 'and no turn was recorded');
  } finally {
    await run.genpage.dispose();
    fs.rmSync(run.appDir, { recursive: true, force: true });
  }
});

test('deploy: a throttle that never says how long keeps the waits it always had — 1, 2, 4, 8 and 8 s a run, the build\'s 3 s, 6 s and 12 s between — inside the budget, with nothing for the build to stop on', async () => {
  const run = throttledSetup('Overview', () => 429);
  try {
    const out = await run.drive();
    assert.ok(out.halt);
    assert.notStrictEqual(out.halt.code, 'throttle-budget-exhausted', 'the retries ran out, not the budget');
    assert.strictEqual(out.attempts, 4);
    assert.strictEqual(run.server.batches.length, 24, 'six sends in each of four runs, as ever');
    const waits = waitsOf(run.events);
    assert.deepStrictEqual(waits.filter((e) => e.who === 'backend').map((e) => e.ms), [1000, 2000, 4000, 8000, 8000].concat([1000, 2000, 4000, 8000, 8000], [1000, 2000, 4000, 8000, 8000], [1000, 2000, 4000, 8000, 8000]));
    assert.deepStrictEqual(waits.filter((e) => e.who === 'build').map((e) => Math.floor(e.ms / 1000)), [3, 6, 12]);
    assert.ok(totalWait(run.events) < 300000);
    assert.deepStrictEqual(run.warnings.filter((w) => /waiting \d+ s/.test(w)).length, 8, 'the two waits of 8 s in each run are longer than a few seconds, and are announced; the shorter ones are not');
  } finally {
    await run.genpage.dispose();
    fs.rmSync(run.appDir, { recursive: true, force: true });
  }
});

// The HTTP client draws its waits for a throttled answer from the run's budget when it is given one (lib/sdk-http-client.js); a client that is given none — the pcf plugin's, which has no budget — waits as it always did: at most five re-sends of
// a throttled read or publish, each honouring a `Retry-After` of up to a minute. This pins that, with the same ten minutes of throttling the budgeted tests below cannot wait out.
test('deploy: a client that is given no budget waits as it always did — five reads throttled for a minute are waited out by the client, five page writes by the backend, and the build succeeds', async () => {
  const { createAzHttpClient } = require('../lib/sdk-http-client.js');
  const { makeThrottleBudget } = require('../lib/throttle-budget.js');
  const { appDir, spec } = onePageApp('Overview');
  fs.writeFileSync(path.join(appDir, 'p.tsx'), PAGE_SOURCE, 'utf8');
  const server = new FakeGenPageServer();
  const raw = server.http();
  const events = [];
  let refusedReads = 0;
  // The production client over the page service: the answers of the fake, as the transport hands them over, with the first five reads throttled for a minute.
  const httpClient = createAzHttpClient(PAGE_SERVICE, {
    getToken: () => 'TOK', random: () => 0, sleep: async (ms) => { events.push({ who: 'client', ms }); },
    request: async ({ url, method, headers, body }) => {
      if (method === 'GET' && refusedReads < 5) {
        refusedReads += 1;
        return { statusCode: 429, headers: { 'retry-after': '60' }, body: '{"error":{"message":"throttled"}}' };
      }
      const answer = method === 'POST' && url.endsWith('/$batch') ? await raw.postRaw(url, body, { headers })
        : method === 'GET' ? await raw.get(url, { headers })
          : method === 'DELETE' ? await raw.delete(url, { headers })
            : method === 'PATCH' && Buffer.isBuffer(body) ? await raw.patchRaw(url, body, { headers })
              : await raw[method.toLowerCase()](url, typeof body === 'string' ? JSON.parse(body) : body, { headers });
      const text = typeof answer.body === 'string' || Buffer.isBuffer(answer.body) ? answer.body : JSON.stringify(answer.body === undefined ? null : answer.body);
      return { statusCode: answer.status, headers: answer.headers || {}, body: text };
    },
  });
  server.failBatch = (n) => (n <= 5 ? { status: 429, headers: { 'retry-after': '60' } } : undefined);
  const genpage = makeGenpageSdk(PAGE_SERVICE, { httpClient, random: () => 0, sleep: async (ms) => { events.push({ who: 'backend', ms }); } });
  const budget = makeThrottleBudget();
  try {
    const out = await driveBuild(spec, appDir, {
      genpage, runOpts: pagesWorkspace(appDir), opts: { retryDelayMs: undefined },
      deps: { throttle: budget, sleep: async (ms) => { events.push({ who: 'build', ms }); } },
    });
    assert.strictEqual(out.halt, null, 'a build throttled for a while still succeeds, as it did before the budget existed');
    assert.strictEqual(out.result.ok, true);
    assert.strictEqual(out.attempts, 1);
    assert.strictEqual(server.state.projects.size, 1, 'one page');
    assert.deepStrictEqual(events.filter((e) => e.who === 'client').map((e) => e.ms), [60000, 60000, 60000, 60000, 60000], 'the client waited out the five throttled reads on its own, a minute each');
    assert.deepStrictEqual(events.filter((e) => e.who === 'backend').map((e) => e.ms), [60000, 60000, 60000, 60000, 60000], 'the backend waited out the five throttled page writes');
    assert.deepStrictEqual(events.filter((e) => e.who === 'build'), [], 'and the build had nothing to wait for');
    assert.strictEqual(budget.spentMs(), 300000, 'the client was given no budget, so the budget holds the backend\'s waits alone: ten minutes were waited in all, five of them inside it');
  } finally {
    await genpage.dispose();
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});

// The transport under the production client: the answers of the fake page service as a transport hands them over, with the nth read throttled when `refuseRead(n)` answers.
function pageTransport(server, refuseRead = () => undefined) {
  const raw = server.http();
  let reads = 0;
  return async ({ url, method, headers, body }) => {
    if (method === 'GET') {
      reads += 1;
      const refused = refuseRead(reads);
      if (refused) return refused;
    }
    const answer = method === 'POST' && url.endsWith('/$batch') ? await raw.postRaw(url, body, { headers })
      : method === 'GET' ? await raw.get(url, { headers })
        : method === 'DELETE' ? await raw.delete(url, { headers })
          : method === 'PATCH' && Buffer.isBuffer(body) ? await raw.patchRaw(url, body, { headers })
            : await raw[method.toLowerCase()](url, typeof body === 'string' ? JSON.parse(body) : body, { headers });
    const text = typeof answer.body === 'string' || Buffer.isBuffer(answer.body) ? answer.body : JSON.stringify(answer.body === undefined ? null : answer.body);
    return { statusCode: answer.status, headers: answer.headers || {}, body: text };
  };
}
const throttledRead = (seconds) => ({ statusCode: 429, headers: { 'retry-after': String(seconds) }, body: '{"error":{"message":"throttled"}}' });
// A clock that every wait of the run moves, as a real wait does: the HTTP client places its waits on it.
function movingClock() {
  let at = Date.parse('2026-09-30T10:00:00Z');
  return { now: () => at, advance: (ms) => { at += ms; } };
}
// `driveBuild` builds for the page service's own environment, and a build keeps its local page records per environment: `pendingOf` and `receiptsOf` read those of BUILD_ENV, which a driven build never writes.
const pendingOfDriven = (spec, appDir) => readPendingCreations(path.join(appDir, '.maker-workspace'), appUniqueName(spec), PAGE_SERVICE);
const receiptsOfDriven = (spec, appDir) => readPageOwnership(path.join(appDir, '.maker-workspace'), appUniqueName(spec), PAGE_SERVICE).created;
// The production stack under the pages phase: the HTTP client, drawing its waits from the run's budget, over the fake page service on a clock its waits move, and the page backend on it. The requests `refuse` names are answered
// 429 with a `Retry-After` of `askSeconds`, as a transport answers them. `budget: false` is a run with none: a client and a backend that wait as they always did.
function budgetedPages(server, { refuse = () => false, askSeconds = 600, budget = true } = {}) {
  const { createAzHttpClient } = require('../lib/sdk-http-client.js');
  const { makeThrottleBudget } = require('../lib/throttle-budget.js');
  const clock = movingClock();
  const waits = [];
  const warnings = [];
  const throttle = makeThrottleBudget({ warn: (line) => warnings.push(line) });
  const transport = pageTransport(server);
  const sleep = async (ms) => { waits.push(ms); clock.advance(ms); };
  const httpClient = createAzHttpClient(PAGE_SERVICE, {
    getToken: () => 'TOK', random: () => 0, now: clock.now, sleep, ...(budget ? { throttle } : {}),
    request: async (request) => (refuse(request) ? throttledRead(askSeconds) : transport(request)),
  });
  const genpage = makeGenpageSdk(PAGE_SERVICE, { httpClient, ...(budget ? { throttle } : {}), random: () => 0, now: clock.now, sleep });
  return { genpage, throttle, clock, waits, warnings };
}

// With a budget the production client draws its waits for a throttled read or publish from it — with the backend's waits between the sends of a page write, and the build's own: one five minutes for the run.
test('deploy: the HTTP client\'s waits for a throttled read are drawn from the run\'s budget with the backend\'s — two reads and two page writes throttled for a minute are waited out inside it, and the build succeeds', async () => {
  const { createAzHttpClient } = require('../lib/sdk-http-client.js');
  const { makeThrottleBudget } = require('../lib/throttle-budget.js');
  const { appDir, spec } = onePageApp('Overview');
  fs.writeFileSync(path.join(appDir, 'p.tsx'), PAGE_SOURCE, 'utf8');
  const server = new FakeGenPageServer();
  const events = [];
  const clock = movingClock();
  const budget = makeThrottleBudget();
  const httpClient = createAzHttpClient(PAGE_SERVICE, {
    getToken: () => 'TOK', random: () => 0, throttle: budget, now: clock.now,
    sleep: async (ms) => { events.push({ who: 'client', ms }); clock.advance(ms); },
    request: pageTransport(server, (n) => (n <= 2 ? throttledRead(60) : undefined)),
  });
  server.failBatch = (n) => (n <= 2 ? { status: 429, headers: { 'retry-after': '60' } } : undefined);
  const genpage = makeGenpageSdk(PAGE_SERVICE, { httpClient, random: () => 0, sleep: async (ms) => { events.push({ who: 'backend', ms }); clock.advance(ms); } });
  try {
    const out = await driveBuild(spec, appDir, {
      genpage, runOpts: pagesWorkspace(appDir), opts: { retryDelayMs: undefined },
      deps: { throttle: budget, sleep: async (ms) => { events.push({ who: 'build', ms }); } },
    });
    assert.strictEqual(out.halt, null);
    assert.strictEqual(out.result.ok, true);
    assert.strictEqual(out.attempts, 1);
    assert.strictEqual(server.state.projects.size, 1, 'one page');
    assert.deepStrictEqual(events.filter((e) => e.who === 'client').map((e) => e.ms), [60000, 60000], 'the client waited out the two throttled reads');
    assert.deepStrictEqual(events.filter((e) => e.who === 'backend').map((e) => e.ms), [60000, 60000], 'the backend the two throttled page writes');
    assert.deepStrictEqual(events.filter((e) => e.who === 'build'), []);
    assert.strictEqual(budget.spentMs(), 240000, 'and all four are the budget\'s: four of the five minutes');
  } finally {
    await genpage.dispose();
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});

test('deploy: ten minutes of throttling in all are no longer waited out — five reads throttled for a minute take the whole budget, and the page write that is throttled after them stops the build with the budget\'s halt', async () => {
  const { createAzHttpClient } = require('../lib/sdk-http-client.js');
  const { makeThrottleBudget } = require('../lib/throttle-budget.js');
  const { isTransientHalt } = require('../build-model-app.js');
  const { appDir, spec } = onePageApp('Overview');
  fs.writeFileSync(path.join(appDir, 'p.tsx'), PAGE_SOURCE, 'utf8');
  const server = new FakeGenPageServer();
  const events = [];
  const clock = movingClock();
  const budget = makeThrottleBudget();
  const httpClient = createAzHttpClient(PAGE_SERVICE, {
    getToken: () => 'TOK', random: () => 0, throttle: budget, now: clock.now,
    sleep: async (ms) => { events.push({ who: 'client', ms }); clock.advance(ms); },
    request: pageTransport(server, (n) => (n <= 5 ? throttledRead(60) : undefined)),
  });
  server.failBatch = (n) => (n <= 5 ? { status: 429, headers: { 'retry-after': '60' } } : undefined);
  const genpage = makeGenpageSdk(PAGE_SERVICE, { httpClient, random: () => 0, sleep: async (ms) => { events.push({ who: 'backend', ms }); clock.advance(ms); } });
  try {
    const out = await driveBuild(spec, appDir, {
      genpage, runOpts: pagesWorkspace(appDir), opts: { retryDelayMs: undefined },
      deps: { throttle: budget, sleep: async (ms) => { events.push({ who: 'build', ms }); } },
    });
    assert.ok(out.halt, 'the build stops: the service throttled for ten minutes, and a run waits five at most');
    assert.strictEqual(out.halt.code, 'throttle-budget-exhausted');
    assert.strictEqual(isTransientHalt(out.halt), true, 'a transient halt: a later run goes on from here');
    assert.match(out.halt.message, /the service asked to wait 60 s before the next send, which does not fit in what is left of the 5 minutes a run allows itself for waiting out a throttled service \(300 s are spent\)\. Nothing more is sent now: run the same command again later, and it continues from here\./);
    assert.strictEqual(out.attempts, 1, 'and the run is not run again to be refused again');
    assert.deepStrictEqual(events.filter((e) => e.who === 'client').map((e) => e.ms), [60000, 60000, 60000, 60000, 60000], 'the client waited out the five throttled reads — five minutes');
    assert.deepStrictEqual(events.filter((e) => e.who !== 'client'), [], 'and nothing else was waited for');
    assert.strictEqual(budget.spentMs(), 300000);
    assert.strictEqual(server.batches.length, 1, 'the page write was sent once, and refused');
    assert.strictEqual(server.state.projects.size, 0, 'nothing was written');
    assert.strictEqual(pendingOfDriven(spec, appDir).size, 0, 'and no creation is left under way');
  } finally {
    await genpage.dispose();
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});

// The pages phase makes its page backend itself, and the backend its own HTTP client: this is the production path, with the budget the build was given reaching the client through the engine and the backend, and nothing injected
// but the transport under the client (the module's `createAzHttpClient` is the one thing replaced, so that the client it makes talks to the fake page service on a clock the test holds).
test('deploy: the budget reaches the HTTP client the pages phase makes for itself — a read the service throttles for ten minutes is not waited for, nothing is written, and the build stops with the budget\'s halt, naming what the service asked', async (t) => {
  const clientModule = require('../lib/sdk-http-client.js');
  const { makeThrottleBudget } = require('../lib/throttle-budget.js');
  const { isTransientHalt } = require('../build-model-app.js');
  const { appDir, spec } = onePageApp('Overview');
  fs.writeFileSync(path.join(appDir, 'p.tsx'), PAGE_SOURCE, 'utf8');
  const server = new FakeGenPageServer();
  const events = [];
  const made = [];
  const create = clientModule.createAzHttpClient;
  t.mock.method(clientModule, 'createAzHttpClient', (env, deps) => {
    made.push(deps);
    return create(env, { ...deps, getToken: () => 'TOK', random: () => 0, sleep: async (ms) => { events.push({ who: 'client', ms }); }, request: pageTransport(server, () => throttledRead(600)) });
  });
  const budget = makeThrottleBudget();
  try {
    const out = await driveBuild(spec, appDir, {
      runOpts: pagesWorkspace(appDir), opts: { retryDelayMs: undefined },
      deps: { throttle: budget, sleep: async (ms) => { events.push({ who: 'build', ms }); } },
    });
    assert.strictEqual(made.length, 1, 'the pages phase made one backend, and the backend one client');
    assert.strictEqual(made[0].throttle, budget, 'with the very budget the build was given');
    assert.ok(out.halt, 'the build stops');
    assert.strictEqual(out.halt.code, 'throttle-budget-exhausted');
    assert.strictEqual(out.halt.phase, 'pages');
    assert.strictEqual(isTransientHalt(out.halt), true);
    assert.match(out.halt.message, /^pages stopped: the service asked to wait 600 s before the next send, which does not fit in what is left of the 5 minutes a run allows itself for waiting out a throttled service \(0 s are spent\)\. Nothing more is sent now: run the same command again later, and it continues from here\.$/);
    assert.strictEqual(out.attempts, 1, 'the run is not run again to meet the same answer');
    assert.deepStrictEqual(events, [], 'nothing was waited for, by the client or by the build');
    assert.strictEqual(budget.spentMs(), 0);
    assert.strictEqual(budget.declined().count, 1, 'the client told the budget once');
    assert.strictEqual(server.batches.length, 0, 'and nothing was sent');
    assert.strictEqual(server.state.projects.size, 0);
    assert.strictEqual(pendingOfDriven(spec, appDir).size, 0);
  } finally {
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});

// ── A read before a write that the run's budget refused ──────────────────────────────────────────────────────────────────────────────────────────
// The reads that come before a page write — an update's read of the page it is about to change, the read that proves a page a pending create left behind — are requests like any other: when the run's budget has no room for the wait a throttled
// read asks for, the HTTP client hands the 429 back as it came and tells the budget (lib/throttle-budget.js, `decline`). The SDK reports that 429 as a page that cannot be read, which the backend used to make final (`transient: false`), so the build
// stopped with `GENPAGE_UNREADABLE` — and, for a pending create, with a conflict that tells the maker to delete a record — instead of the budget's halt that says what the service asked. Nothing was written either way: the refusal is the throttle's.
const contentRead = ({ method, url }) => method === 'GET' && /\/filecontent\/\$value$/.test(new URL(url).pathname);

test('deploy: the read before an update that the budget has no room to wait for is the throttle\'s refusal and not an unreadable page — the build stops with the budget\'s halt, nothing is written, and the next run updates the page once', async () => {
  const { isTransientHalt } = require('../build-model-app.js');
  const { appDir, spec } = onePageApp('Overview');
  fs.writeFileSync(path.join(appDir, 'p.tsx'), PAGE_SOURCE, 'utf8');
  const server = new FakeGenPageServer();
  const seed = budgetedPages(server);
  let id;
  try {
    const seeded = await driveBuild(spec, appDir, { genpage: seed.genpage, runOpts: pagesWorkspace(appDir), deps: { throttle: seed.throttle } });
    assert.strictEqual(seeded.halt, null, 'the page is made');
    id = seeded.result.created.pages.p;
  } finally { await seed.genpage.dispose(); }
  fs.writeFileSync(path.join(appDir, 'p.tsx'), PAGE_SOURCE.replace('Page</div>', 'Edited</div>'), 'utf8');
  const state = () => ({ pages: server.state.projects.size, messages: server.messagesOf(id).length, batches: server.batches.length });
  const before = state();
  const refusing = budgetedPages(server, { refuse: contentRead });
  try {
    const out = await driveBuild(spec, appDir, { genpage: refusing.genpage, runOpts: pagesWorkspace(appDir), deps: { throttle: refusing.throttle } });
    assert.ok(out.halt, 'the build stops');
    assert.strictEqual(out.halt.code, 'throttle-budget-exhausted', 'with the budget\'s halt, and not "the page cannot be read"');
    assert.strictEqual(isTransientHalt(out.halt), true, 'a transient halt: a later run goes on from here');
    assert.match(out.halt.message, /^pages stopped: the service asked to wait 600 s before the next send, which does not fit in what is left of the 5 minutes a run allows itself for waiting out a throttled service \(0 s are spent\)/);
    assert.strictEqual(out.attempts, 1, 'and the run is not run again to meet the same answer');
    assert.deepStrictEqual(refusing.waits, [], 'nothing was waited for');
    assert.ok(refusing.throttle.declined().count >= 1, 'the client told the budget');
    assert.deepStrictEqual(state(), before, 'nothing was written: no page, no turn, no change set');
    assert.strictEqual(pendingOfDriven(spec, appDir).size, 0);
  } finally { await refusing.genpage.dispose(); }
  const healthy = budgetedPages(server);
  try {
    const out = await driveBuild(spec, appDir, { genpage: healthy.genpage, runOpts: pagesWorkspace(appDir), deps: { throttle: healthy.throttle } });
    assert.strictEqual(out.halt, null);
    assert.deepStrictEqual(state(), { pages: before.pages, messages: before.messages + 2, batches: before.batches + 1 }, 'the next run updates the page once: one more turn, one more change set');
    assert.ok(server.rowText(id, 'src/pages/page.tsx').includes('Edited'));
  } finally {
    await healthy.genpage.dispose();
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});

test('the backend: a read of a page that the budget refused to wait for says it is the throttle — HTTP 429, nothing changed, what the service asked — and the same read refused until the sends ran out is as final as it ever was', async () => {
  const { isTransientHalt } = require('../build-model-app.js');
  const ID = '9d3a77c1-0000-4000-8000-0000000000d1';
  const edit = { source: PAGE_SOURCE.replace('Page</div>', 'Edited</div>'), prompt: 'edit', agentMessage: 'done' };
  const attempt = async (options, call) => {
    const server = new FakeGenPageServer();
    server.seedPage(ID, { name: 'Overview', source: PAGE_SOURCE });
    const stack = budgetedPages(server, { refuse: contentRead, ...options });
    try { return { ...stack, server, error: await call(stack.genpage).then(() => null, (e) => e) }; } finally { await stack.genpage.dispose(); }
  };
  const update = (genpage) => genpage.update(ID, edit);
  const read = (genpage) => genpage.read(ID);
  // The budget has no room for the ten minutes the service asked.
  for (const [what, call, message] of [['update', update, /^could not read page \S+ before updating it \(HTTP 429 .*\) — nothing was changed$/], ['read', read, /^could not read page \S+: HTTP 429 /]]) {
    const refused = await attempt({}, call);
    const { error } = refused;
    assert.ok(error, what);
    assert.strictEqual(error.code, 'GENPAGE_UNREADABLE', what);
    assert.notStrictEqual(error.transient, false, `${what}: the service's load is not final`);
    assert.strictEqual(isTransientHalt(error), true, what);
    assert.strictEqual(error.statusCode, 429, what);
    assert.strictEqual(error.cause.code, 'CONNECTION_ERROR', `${what}: the SDK's own error is the cause`);
    assert.strictEqual(error.cause.statusCode, 429, what);
    assert.strictEqual(error.retryAfterMs, 600000, `${what}: what the service asked, whole`);
    assert.strictEqual(error.retryNotBefore, refused.clock.now() + 600000, `${what}: and the moment before which nothing may be sent`);
    assert.match(error.message, message, what);
    assert.deepStrictEqual(refused.waits, [], `${what}: nothing was waited for`);
    assert.strictEqual(refused.server.batches.length, 0, `${what}: nothing was written`);
    if (what === 'update') assert.deepStrictEqual([error.outcome, error.pageId], ['nothing', ID], 'an update says it changed nothing');
  }
  // The same refusal where the budget had room: every wait fit, the sends ran out, and the read failed as it always did — final, and no word of the budget.
  for (const [what, call] of [['update', update], ['read', read]]) {
    for (const [how, options] of [['with a budget that had room', { askSeconds: 1 }], ['with no budget', { askSeconds: 1, budget: false }]]) {
      const ran = await attempt(options, call);
      assert.ok(ran.error, `${what} ${how}`);
      assert.strictEqual(ran.error.code, 'GENPAGE_UNREADABLE', `${what} ${how}`);
      assert.strictEqual(ran.error.transient, false, `${what} ${how}: the sends ran out, which this has always been final`);
      assert.strictEqual(isTransientHalt(ran.error), false, `${what} ${how}`);
      assert.strictEqual(ran.error.retryAfterMs, undefined, `${what} ${how}`);
      assert.ok(ran.waits.length > 0, `${what} ${how}: the client waited, as the schedule has it`);
      assert.strictEqual(ran.throttle.declined().count, 0, `${what} ${how}: no wait was refused`);
    }
  }
});

test('deploy: a page under a pending id whose read the budget refused to wait for is not a conflict — the engine stops with a transient halt, the record stays and nothing is written', async () => {
  const { isTransientHalt } = require('../build-model-app.js');
  const { appDir, spec } = onePageApp('Overview');
  fs.writeFileSync(path.join(appDir, 'p.tsx'), PAGE_SOURCE, 'utf8');
  const workspaceDir = path.join(appDir, '.maker-workspace');
  const server = new FakeGenPageServer();
  const ID = '9d3a77c1-0000-4000-8000-0000000000d2';
  server.seedPage(ID, { name: 'Overview', source: PAGE_SOURCE });
  recordPagePending(workspaceDir, appUniqueName(spec), 'p', ID, 'Overview', BUILD_ENV, sha256(PAGE_SOURCE));
  try {
    await assert.rejects(buildPages(spec, appDir, budgetedPages(server, { refuse: contentRead }).genpage), (e) => {
      assert.strictEqual(e.code, 'pages-read-throttled', 'not "pages-identity-conflict", which tells the maker to delete a record');
      assert.strictEqual(e.phase, 'pages');
      assert.strictEqual(e.recoverable, true);
      assert.strictEqual(isTransientHalt(e), true, 'a run again may find the service ready');
      assert.match(e.message, new RegExp(`^could not read page ${ID}, which an earlier build started creating for "p", because the service throttled the read \\(.*HTTP 429.*\\) — nothing was changed`));
      return true;
    });
    assert.deepStrictEqual(server.writes(), [], 'nothing was written');
    assert.deepStrictEqual(receiptsOf(spec, appDir), [], 'no receipt was made out of the record');
    assert.strictEqual(pendingOf(spec, appDir).size, 1, 'and the record stays, for the run that can read the page');
    // A page that cannot be read for another reason stays the conflict it was: the reading of the 503 is the service's own words and no word of the budget.
    const unread = new FakeGenPageServer();
    unread.seedPage(ID, { name: 'Overview', source: PAGE_SOURCE });
    unread.failOn = rowReadsFail;
    await assert.rejects(buildPages(spec, appDir, realPageBackend(unread)), (e) => e.code === 'pages-identity-conflict');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('deploy: through the build, a page under a pending id whose read the budget refused to wait for stops the build with the budget\'s halt — and the next run reads the page, proves it holds what was sent and adopts it', async () => {
  const { isTransientHalt } = require('../build-model-app.js');
  const { appDir, spec } = onePageApp('Overview');
  fs.writeFileSync(path.join(appDir, 'p.tsx'), PAGE_SOURCE, 'utf8');
  const server = new FakeGenPageServer();
  const ID = '9d3a77c1-0000-4000-8000-0000000000d3';
  server.seedPage(ID, { name: 'Overview', source: PAGE_SOURCE });
  recordPagePending(path.join(appDir, '.maker-workspace'), appUniqueName(spec), 'p', ID, 'Overview', PAGE_SERVICE, sha256(PAGE_SOURCE));
  const refusing = budgetedPages(server, { refuse: contentRead });
  try {
    const out = await driveBuild(spec, appDir, { genpage: refusing.genpage, runOpts: pagesWorkspace(appDir), deps: { throttle: refusing.throttle } });
    assert.ok(out.halt, 'the build stops');
    assert.strictEqual(out.halt.code, 'throttle-budget-exhausted');
    assert.strictEqual(isTransientHalt(out.halt), true);
    assert.match(out.halt.message, /^pages stopped: the service asked to wait 600 s before the next send, which does not fit/);
    assert.strictEqual(out.attempts, 1);
    assert.deepStrictEqual(refusing.waits, []);
    assert.deepStrictEqual(server.writes(), [], 'nothing was written');
    assert.strictEqual(pendingOfDriven(spec, appDir).size, 1, 'the record of the create stays');
  } finally { await refusing.genpage.dispose(); }
  const healthy = budgetedPages(server);
  try {
    const out = await driveBuild(spec, appDir, { genpage: healthy.genpage, runOpts: pagesWorkspace(appDir), deps: { throttle: healthy.throttle } });
    assert.strictEqual(out.halt, null);
    assert.strictEqual(out.result.created.pages.p, ID, 'the page the earlier build started is adopted');
    assert.deepStrictEqual([...server.state.projects.keys()], [ID], 'one page');
    assert.deepStrictEqual(receiptsOfDriven(spec, appDir).map((r) => r.pageId), [ID]);
    assert.strictEqual(pendingOfDriven(spec, appDir).size, 0, 'and the record is consumed on that evidence');
  } finally {
    await healthy.genpage.dispose();
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});
