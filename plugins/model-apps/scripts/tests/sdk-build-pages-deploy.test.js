'use strict';
// Integration tests for the §9 PAGEREF_ deployment protocol: STRUCTURAL scan/parity → create-absent-first
// → resolve-to-run-scoped-staging (never mutate canonical) → upload-once (no duplicates) → sitemap finalize.
// Uses a REAL temp appDir so the fs read (canonical .tsx) and write (staging) run. Staging is cleaned in a
// finally, so the mock upload captures the uploaded bytes at call time.
//
// Tests also cover OVERRIDE 2 (new-Important-1): a nav pageId that is a `dynamic` expression or a `literal`
// GUID (hardcoded) must be rejected fail-closed BEFORE any write, even when navigatesTo: [] (so the existing
// parity check does not catch it). Only `extractNavTargets`-based structural detection catches these.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runSdkBuild, appUniqueName } = require('../lib/sdk-build.js');
const { writeBaseline, readBaseline } = require('../lib/deployed-baseline.js');
const { sha256 } = require('../lib/hash.js');
const { currentReadSdk } = require('./helpers/app-membership-sdk.js');
const { OBJECT_DIVISION_PAGE, MISREAD_PAGES, HIDDEN_CALL_PAGE, PREFIX_INCREMENT_PAGE, TEMPLATE_LINE_PAGE, JSX_TEXT_PAGE, ELEMENT_AFTER_OPERATOR_PAGES, ELEMENT_LOOKALIKE_PAGES, ELEMENT_PAGE_TOKEN_LINE, FUNCTION_TYPE_PAGES } = require('./helpers/misread-page.js');

// Real GUIDs for the three-authority sitemap mock (Imp9). SELF_* resolve THIS app's appmodule + sitemap so
// fetchSitemap(appUnique) returns opts.liveSitemapXml; a page-less EMPTY sitemap is the default membership.
const APP_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const SELF_UNIQUE_VALUE = 'c0ffee00-0000-4000-8000-00000000dddd';
const SELF_SITEMAP_ID = '5111e0f2-0000-4000-8000-0000000000aa';
const EMPTY_SITEMAP_XML = '<SiteMap><Area><Group></Group></Area></SiteMap>';
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

// genpageCli mock: mints deterministic ids from the page name; captures the uploaded bytes (staging is
// cleaned in a finally). `live` seeds enumerate() for a rebuild.
function mockGenpageCli(live = []) {
  const uploads = [];
  return {
    uploads,
    // EXISTENCE is env-wide (Task 2). `live` seeds the id set a rebuild reuses.
    enumerateEnv: async () => ({ ok: true, ids: live.map((p) => String(p.pageId).toLowerCase()), pages: live }),
    upload: async (o) => {
      let content = '';
      try { content = fs.readFileSync(o.codeFile, 'utf8'); } catch { /* nothing */ }
      const pageId = o.pageId || (o.name === 'Detail' ? DETAIL_ID : OVERVIEW_ID);
      uploads.push({ name: o.name, requestedId: o.pageId, resolvedId: pageId, codeFile: o.codeFile, content });
      return { pageId };
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
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Pages', subAreas: [{ page: 'overview', title: 'Overview' }, { page: 'detail', title: 'Detail' }] }] }] },
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
    assert.ok(!/PAGEREF_/.test(overviewUpload.content), 'no PAGEREF_ token remains in the uploaded (staged) bytes');
    assert.ok(fs.readFileSync(path.join(appDir, 'overview.tsx'), 'utf8').includes('"PAGEREF_detail"'), 'canonical .tsx untouched');
    const stagingRoot = path.join(appDir, '.maker-workspace', '.pageref-deploy');
    assert.ok(!fs.existsSync(stagingRoot) || fs.readdirSync(stagingRoot).length === 0, 'run-scoped staging cleaned in finally');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('deploy: a MALFORMED (single-quoted) nav PAGEREF_ HALTS before any upload (C4 grammar, structural)', async () => {
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

test('deploy: a real nav ref with NO declaration HALTS on parity before any upload (C4 parity, structural)', async () => {
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

test('deploy: a DECOY "PAGEREF_" string (not a nav call site) does NOT satisfy a declared edge — parity HALTs (C1)', async () => {
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
      appShell: { areas: [{ label: 'M', groups: [{ label: 'P', subAreas: [{ page: 'overview' }, { page: 'detail' }] }] }] },
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
        build(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES }),
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
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Pages', subAreas: [{ page: 'sc-a', title: 'Supplier Scorecard' }, { page: 'sc-b', title: 'Supplier Scorecard' }] }] }] },
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

// OVERRIDE 2 (new-Important-1): a DYNAMIC nav pageId (e.g. pageId: someVar — a variable, not a literal)
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

test('deploy: DYNAMIC nav pageId (variable expression) HALTS before any write — new-Important-1 override-2', async () => {
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
      // only extractNavTargets's 'dynamic' kind detection (OVERRIDE 2) rejects this before any write.
      pages: [
        { key: 'overview', name: 'Overview', navigatesTo: [], source: { kind: 'tsx', codeFile: 'overview.tsx' } },
        { key: 'detail', name: 'Detail', source: { kind: 'tsx', codeFile: 'detail.tsx' } },
      ],
      appShell: { areas: [{ label: 'Main', groups: [{ label: 'P', subAreas: [{ page: 'overview' }, { page: 'detail' }] }] }] },
    };
    const { sdk } = mockSdk();
    const genpageCli = mockGenpageCli();
    await assert.rejects(
      runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES }),
      (e) => e && e.phase === 'pages' && e.code === 'pages-nav-parity'
    );
    assert.strictEqual(genpageCli.uploads.length, 0, 'dynamic nav pageId rejected before any write (new-Important-1)');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

// OVERRIDE 2 (new-Important-1): a LITERAL GUID nav pageId (hardcoded env-specific id — breaks cross-env
// recreate, design §9 T5) must be rejected BEFORE any write. Even with navigatesTo:[] (parity passes),
// extractNavTargets (kind:'literal') catches it. Error code: pages-nav-parity.
test('deploy: LITERAL GUID nav pageId (hardcoded) HALTS before any write — new-Important-1 override-2', async () => {
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
      // navigatesTo:[] so parity passes; only extractNavTargets 'literal' detection (OVERRIDE 2) rejects this.
      pages: [
        { key: 'overview', name: 'Overview', navigatesTo: [], source: { kind: 'tsx', codeFile: 'overview.tsx' } },
        { key: 'detail', name: 'Detail', source: { kind: 'tsx', codeFile: 'detail.tsx' } },
      ],
      appShell: { areas: [{ label: 'Main', groups: [{ label: 'P', subAreas: [{ page: 'overview' }, { page: 'detail' }] }] }] },
    };
    const { sdk } = mockSdk();
    const genpageCli = mockGenpageCli();
    await assert.rejects(
      runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES }),
      (e) => e && e.phase === 'pages' && e.code === 'pages-nav-parity'
    );
    assert.strictEqual(genpageCli.uploads.length, 0, 'literal GUID nav pageId rejected before any write (new-Important-1)');
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
        sdk, provisionSdk: sdk, genpageCli, sleep: async () => {}, log: (m) => lines.push(m),
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

// The build wraps a pac upload that timed out with the caller's own advice: it keeps no base marker, and a navigation page's code file is a staging copy it deletes at the end, so the standalone
// script's `genpage-base.js check --file <staging copy>` would fail on a missing file. The update is reported as one that may have landed, it is NOT sent again, and the next build
// converges with one page per name.
test('deploy: a pac timeout during an UPDATE stops the build with the build\'s advice, sends nothing again, and the next build converges with one page per name', async () => {
  const { makeGenpageCli } = require('../lib/genpage-cli.js');
  const { isTransientHalt } = require('../build-model-app.js');
  const { appDir, spec } = makeTwoPageApp(); // overview links to detail: its upload goes through a staging copy
  try {
    const live = [{ pageId: OVERVIEW_ID, name: 'Overview' }, { pageId: DETAIL_ID, name: 'Detail' }];
    const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: OVERVIEW_ID }, { key: 'detail', name: 'Detail', pageId: DETAIL_ID }] }), 'utf8').toString('base64');
    const listing = `Connected as tester@contoso.com\nRetrieving generated pages...\nFound ${live.length} generated page(s):\n\n${'Page ID'.padEnd(37)}${'Name'.padEnd(9)}Published\n${live.map((p) => `${p.pageId} ${p.name.padEnd(8)} -`).join('\n')}\n`;
    const pacCalls = [];
    let stall = true;
    const run = async (args) => {
      pacCalls.push(args);
      if (args[2] === 'list') return { status: 0, stdout: listing, stderr: '' };
      if (stall) return { status: null, timedOut: true, timeoutMs: 600000, command: 'pac model genpage upload', stdout: '', stderr: '' };
      return { status: 0, stdout: `Page ID: ${args[args.indexOf('--page-id') + 1]}`, stderr: '' };
    };
    const genpageCli = makeGenpageCli('https://x', { run, sleep: async () => {} });
    const make = () => mockSdk({ pageManifest: manifest, liveSitemapXml: pageSitemap([OVERVIEW_ID, DETAIL_ID]), pageRows: live.map((p) => ({ uxagentprojectid: p.pageId, name: p.name })) }).sdk;
    await assert.rejects(runSdkBuild(spec, { sdk: make(), apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES }), (e) => {
      assert.strictEqual(e.phase, 'pages');
      assert.match(e.message, /timed out after 600 s and was stopped — the UPDATE of page 11111111-0000-4000-8000-000000000001 MAY HAVE LANDED/);
      assert.match(e.message, /First see what is deployed: pac model genpage download --environment https:\/\/x --app-id [^ ]+ --page-id 11111111-0000-4000-8000-000000000001 --output-directory <folder>/);
      assert.match(e.message, /Then run the build again: it sends this page once more, to the same page id/);
      assert.doesNotMatch(e.message, /genpage-base\.js|\.pageref-deploy|re-run the upload/, 'no advice the build cannot follow: no check on a staging copy it deletes');
      assert.strictEqual(isTransientHalt(e), false, 'the build does not retry it by itself');
      return true;
    });
    const uploads = pacCalls.filter((a) => a[2] === 'upload');
    assert.strictEqual(uploads.length, 1, 'one send: the update that stalled is not sent again, and the next page was never started');
    assert.ok(!fs.existsSync(path.join(appDir, '.maker-workspace', '.pageref-deploy')) || fs.readdirSync(path.join(appDir, '.maker-workspace', '.pageref-deploy')).length === 0, 'the staging copy is gone, as the message says it would be');
    // The next normal build: the same pages, the same ids — one page per name, nothing created.
    stall = false;
    pacCalls.length = 0;
    await runSdkBuild(spec, { sdk: make(), apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES });
    const sent = pacCalls.filter((a) => a[2] === 'upload');
    assert.strictEqual(sent.length, 2, 'both pages are sent');
    assert.deepStrictEqual(sent.map((a) => a[a.indexOf('--page-id') + 1]).sort(), [OVERVIEW_ID, DETAIL_ID].sort(), 'each to the id it already has: updates, and no create');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

// The same for an UPDATE that FAILS rather than stalls: pac can fail in the publish after it wrote the page and recorded its prompt, so the build sends it once — not again in the
// upload's own loop, and not by its re-run of a halt it takes for transient (the pac words here, "try again later", would read as one without the marker) — and gives its own advice.
test('deploy: a pac failure during an UPDATE stops the build with the build\'s advice, sends nothing again, and the next build converges with one page per name', async () => {
  const { makeGenpageCli } = require('../lib/genpage-cli.js');
  const { isTransientHalt } = require('../build-model-app.js');
  const { appDir, spec } = makeTwoPageApp();
  try {
    const live = [{ pageId: OVERVIEW_ID, name: 'Overview' }, { pageId: DETAIL_ID, name: 'Detail' }];
    const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: OVERVIEW_ID }, { key: 'detail', name: 'Detail', pageId: DETAIL_ID }] }), 'utf8').toString('base64');
    const listing = `Connected as tester@contoso.com\nRetrieving generated pages...\nFound ${live.length} generated page(s):\n\n${'Page ID'.padEnd(37)}${'Name'.padEnd(9)}Published\n${live.map((p) => `${p.pageId} ${p.name.padEnd(8)} -`).join('\n')}\n`;
    const pacCalls = [];
    let fail = true;
    const run = async (args) => {
      pacCalls.push(args);
      if (args[2] === 'list') return { status: 0, stdout: listing, stderr: '' };
      const id = args[args.indexOf('--page-id') + 1];
      if (fail) return { status: 1, stdout: `Page ID: ${id}\r\nPublishing...\r\n`, stderr: 'Error: The service is busy, try again later.' };
      return { status: 0, stdout: `Page ID: ${id}`, stderr: '' };
    };
    const genpageCli = makeGenpageCli('https://x', { run, sleep: async () => {} });
    const make = () => mockSdk({ pageManifest: manifest, liveSitemapXml: pageSitemap([OVERVIEW_ID, DETAIL_ID]), pageRows: live.map((p) => ({ uxagentprojectid: p.pageId, name: p.name })) }).sdk;
    await assert.rejects(runSdkBuild(spec, { sdk: make(), apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES }), (e) => {
      assert.strictEqual(e.phase, 'pages');
      assert.match(e.message, /failed \(Error: The service is busy, try again later\.\) — the UPDATE of page 11111111-0000-4000-8000-000000000001 MAY HAVE LANDED: pac had printed the Page ID/);
      assert.match(e.message, /First see what is deployed: pac model genpage download --environment https:\/\/x --app-id [^ ]+ --page-id 11111111-0000-4000-8000-000000000001 --output-directory <folder>/);
      assert.match(e.message, /Then run the build again: it sends this page once more, to the same page id, so nothing new is created — but if the failed send did land/);
      assert.doesNotMatch(e.message, /genpage-base\.js|\.pageref-deploy|re-run the upload/, 'no advice the build cannot follow: no check on a staging copy it deletes');
      assert.strictEqual(isTransientHalt(e), false, 'the build does not retry it by itself');
      return true;
    });
    const uploads = pacCalls.filter((a) => a[2] === 'upload');
    assert.strictEqual(uploads.length, 1, 'one send: the update that failed is not sent again, and the next page was never started');
    // The next normal build: the same pages, the same ids — one page per name, nothing created.
    fail = false;
    pacCalls.length = 0;
    await runSdkBuild(spec, { sdk: make(), apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES });
    const sent = pacCalls.filter((a) => a[2] === 'upload');
    assert.strictEqual(sent.length, 2, 'both pages are sent');
    assert.deepStrictEqual(sent.map((a) => a[a.indexOf('--page-id') + 1]).sort(), [OVERVIEW_ID, DETAIL_ID].sort(), 'each to the id it already has: updates, and no create');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
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
    assert.deepStrictEqual(r.created.pageSourceShas, { overview: source('overview.tsx'), detail: source('detail.tsx') });
    assert.notStrictEqual(r.created.pageDeployedShas.overview, r.created.pageSourceShas.overview, 'the copy that is uploaded has the target\'s id where the source has PAGEREF_: it is another hash');
    // Only a page that is sent is recorded: a changed-only run that selects one page records that page.
    const selected = await runSdkBuild(spec, { sdk: mockSdk({ pageManifest: Buffer.from(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: OVERVIEW_ID }, { key: 'detail', name: 'Detail', pageId: DETAIL_ID }] }), 'utf8').toString('base64'), liveSitemapXml: pageSitemap([OVERVIEW_ID, DETAIL_ID]), pageRows: [{ uxagentprojectid: OVERVIEW_ID, name: 'Overview' }, { uxagentprojectid: DETAIL_ID, name: 'Detail' }] }).sdk,
      apply: true, env: 'https://x', appDir, genpageCli: mockGenpageCli([{ pageId: OVERVIEW_ID, name: 'Overview' }, { pageId: DETAIL_ID, name: 'Detail' }]), phases: PAGES_ONLY,
      changedOnly: { fastApply: true, resolvedAppId: APP_ID, skipSitemapFinalize: true, selectedKeys: ['detail'] } });
    assert.deepStrictEqual(selected.created.pageSourceShas, { detail: source('detail.tsx') });
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
    const upload = first.genpageCli.upload;
    first.genpageCli.upload = async (o) => { const up = await upload(o); if (o.name === 'Detail') app.edit(GRIFFEL_BAD); return up; };
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
    const upload = cli.upload;
    cli.upload = async (o) => { const up = await upload(o); app.edit(GRIFFEL_BAD); return up; };
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
    genpageCli.download = async ({ outputDir, pageIds }) => {
      assert.deepStrictEqual([...pageIds].sort(), [overviewId, detailId].sort());
      for (const id of pageIds) {
        const dir = path.join(outputDir, id);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'page.tsx'), genpageCli.uploads.find((u) => u.requestedId === id).content, 'utf8');
        fs.writeFileSync(path.join(dir, 'config.json'), '\uFEFF{"dataSources":[]}', 'utf8');
      }
      return true;
    };
    const downloaded = await runDownload({
      sdk: currentReadSdk(downloadSdk, { appId: APP_ID, layerId: SELF_UNIQUE_VALUE, sitemapXml: xml }),
      genpageCli, outDir: downloadDir, appId: APP_ID, appUnique: 'contoso_deployapp',
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
      const staging = path.join(dir, '.maker-workspace', '.pageref-deploy');
      assert.ok(!fs.existsSync(staging) || fs.readdirSync(staging).length === 0, 'run-scoped staging cleaned');
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

// ── An upload whose outcome is not known is never sent again — not by the build's own retry either ─────────────────────────────────────────────
// buildModelApp re-runs the whole build when a halt reads as transient (isTransientHalt), and it decides that from the halt's TEXT. The text of an uncertain create quotes the page's name — user
// text, so "SQL Timeouts" or "Concurrent Deletes" read as a SQL timeout or a concurrent delete — and pac's own words ("… try again later"). A re-run is a second create: the page the first one made,
// if it landed, is left beside the new one, outside the app's navigation, and the run reports success. These tests drive the REAL retry loop, the real wrapper and a pac that ends the create each
// way, and count the creates that reach pac.
function onePageApp(pageName) {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-uncertain-'));
  fs.writeFileSync(path.join(appDir, 'p.tsx'), 'export default function P(){ return null; }', 'utf8');
  const spec = {
    schemaVersion: 2,
    solution: { uniqueName: 'UncertainSol', displayName: 'Uncertain', publisherPrefix: 'contoso' },
    app: { name: 'Uncertain App' },
    entities: [{ schemaName: 'contoso_item', displayName: 'Item', primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' }, columns: [] }],
    pages: [{ key: 'p', name: pageName, source: { kind: 'tsx', codeFile: 'p.tsx' } }],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Pages', subAreas: [{ page: 'p', title: pageName }] }] }] },
  };
  return { appDir, spec };
}
const PAC_LISTING_EMPTY = 'Connected as tester@contoso.com\nRetrieving generated pages...\nFound 0 generated page(s):\n';
function pacListing(rows) {
  const width = Math.max(4, ...rows.map((r) => r.name.length));
  return `Connected as tester@contoso.com\nRetrieving generated pages...\nFound ${rows.length} generated page(s):\n\n${'Page ID'.padEnd(37)}${'Name'.padEnd(width + 1)}Published\n${rows.map((r) => `${r.pageId} ${r.name.padEnd(width)} -`).join('\n')}\n`;
}
const PAC_STALLED = { status: null, timedOut: true, timeoutMs: 600000, command: 'pac model genpage upload', stdout: '', stderr: '' };
// A pac whose create ends as `create` says, and whose listings, once a create was sent, answer as `afterListing` says. Every call is recorded.
function sendingPac({ create, afterListing = () => ({ status: 0, stdout: PAC_LISTING_EMPTY, stderr: '' }) }) {
  const calls = [];
  let sent = 0;
  let listedSinceSend = 0;
  const run = async (args) => {
    calls.push(args);
    if (args[2] === 'list') {
      if (sent === 0) return { status: 0, stdout: PAC_LISTING_EMPTY, stderr: '' };
      listedSinceSend += 1;
      return afterListing(listedSinceSend);
    }
    if (args[2] === 'upload') { sent += 1; return create(sent, args); }
    return { status: 1, stdout: '', stderr: 'unexpected pac call' };
  };
  return { run, calls, creates: () => calls.filter((a) => a[2] === 'upload' && !a.includes('--page-id')).length };
}
const TRY_AGAIN_LATER = 'Error: The service is unavailable. Please try again later.';
const UNCERTAIN_PAGE_ID = '3a1f9c52-0000-4000-8000-00000000a0a0';
// `says` is what the halt says; each scenario ends the create a different way.
const UNCERTAIN_CREATES = [
  { what: 'a create that stalls with nothing visible yet, for a page named "SQL Timeouts"', name: 'SQL Timeouts', create: () => PAC_STALLED, says: /an UNCERTAIN create: no new page is visible/ },
  { what: 'a create that stalls with nothing visible yet, for a page named "Concurrent Deletes"', name: 'Concurrent Deletes', create: () => PAC_STALLED, says: /an UNCERTAIN create: no new page is visible/ },
  { what: 'a create that stalls and whose environment listing then fails with "try again later"', name: 'Overview', create: () => PAC_STALLED, afterListing: () => ({ status: 1, stdout: '', stderr: TRY_AGAIN_LATER }), says: /env enumeration failed — refusing to retry/ },
  { what: 'a create that fails and whose environment listing then fails with "try again later"', name: 'Overview', create: () => ({ status: 1, stdout: '', stderr: 'Error: the upload failed' }), afterListing: () => ({ status: 1, stdout: '', stderr: TRY_AGAIN_LATER }), says: /env enumeration failed — refusing to retry/ },
  { what: 'a create that stalls and whose page then shows up in the environment, for a page named "SQL Timeout Report"', name: 'SQL Timeout Report', create: () => PAC_STALLED, afterListing: () => ({ status: 0, stdout: pacListing([{ pageId: UNCERTAIN_PAGE_ID, name: 'SQL Timeout Report' }]), stderr: '' }), says: /ambiguous ownership/ },
  { what: 'a create that fails and leaves a page in the environment, for a page named "SQL Timeout Report"', name: 'SQL Timeout Report', create: () => ({ status: 1, stdout: '', stderr: 'Error: could not publish' }), afterListing: () => ({ status: 0, stdout: pacListing([{ pageId: UNCERTAIN_PAGE_ID, name: 'SQL Timeout Report' }]), stderr: '' }), says: /ambiguous ownership/ },
  { what: 'a create that stalls after pac printed the Page ID, for a page named "SQL Timeouts"', name: 'SQL Timeouts', create: () => ({ ...PAC_STALLED, stdout: `Page ID: ${UNCERTAIN_PAGE_ID}\n` }), says: /after it had CREATED the page as/ },
  { what: 'a create that fails after pac printed the Page ID, with "try again later"', name: 'Overview', create: () => ({ status: 1, stdout: `Page ID: ${UNCERTAIN_PAGE_ID}\n`, stderr: TRY_AGAIN_LATER }), says: /failed after it had CREATED the page as/ },
];
async function runUncertainBuild(scenario) {
  const { buildModelApp } = require('../build-model-app.js');
  const { makeGenpageCli } = require('../lib/genpage-cli.js');
  const { appDir, spec } = onePageApp(scenario.name);
  try {
    const pac = sendingPac(scenario);
    const genpageCli = makeGenpageCli('https://contoso.crm.dynamics.com', { run: pac.run, sleep: async () => {}, request: async () => ({ status: 200, data: { name: scenario.name, createdon: '2026-01-01T00:00:00Z' } }) });
    const { sdk } = mockSdk();
    const lines = [];
    let halt = null;
    try {
      await buildModelApp(spec, { apply: true, env: 'https://contoso.crm.dynamics.com', appDir, retryDelayMs: 0 }, {
        sdk, provisionSdk: sdk, genpageCli, sleep: async () => {}, log: (m) => lines.push(m),
        discoverOpDiffState: async () => ({ collision: { appExists: false, solutionExists: false }, forms: [], sitemap: null }),
      });
    } catch (e) { halt = e; }
    return { halt, lines, pac, spec };
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
}
for (const scenario of UNCERTAIN_CREATES) {
  test(`deploy: ${scenario.what} halts the build — its create reaches pac once, and the build's own retry does not send it again`, async () => {
    const { isTransientHalt } = require('../build-model-app.js');
    const { halt, lines, pac, spec } = await runUncertainBuild(scenario);
    assert.ok(halt, 'the build halts');
    assert.strictEqual(halt.phase, 'pages');
    assert.match(halt.message, scenario.says);
    assert.strictEqual(pac.creates(), 1, 'one create: a second would make a duplicate page');
    assert.deepStrictEqual(lines.filter((l) => /transient error|retrying/.test(l)), [], 'and the build never says it is retrying');
    assert.strictEqual(isTransientHalt(halt, { spec }), false, 'the halt reads as final');
    assert.strictEqual(halt.cause && halt.cause.transient, false, 'because the error it wraps says so, whatever its text quotes');
  });
}

// The marker is not a blanket: what the build rides out is still ridden out. A listing that fails BEFORE any create was sent — the snapshot the create is checked against — leaves nothing
// to duplicate, so a transient failure there is retried, and the create is sent once, when it can be.
test('deploy: a transient failure BEFORE the create was sent is still retried by the build, and the create is sent once', async () => {
  const scenario = { name: 'Overview', create: () => ({ status: 0, stdout: `Page ID: ${UNCERTAIN_PAGE_ID}\n`, stderr: '' }) };
  const { buildModelApp } = require('../build-model-app.js');
  const { makeGenpageCli } = require('../lib/genpage-cli.js');
  const { appDir, spec } = onePageApp(scenario.name);
  try {
    const pac = sendingPac(scenario);
    let snapshots = 0;
    const run = async (args) => {
      if (args[2] === 'list' && pac.creates() === 0 && (snapshots += 1) <= 3) return { status: 1, stdout: '', stderr: TRY_AGAIN_LATER };
      return pac.run(args);
    };
    const genpageCli = makeGenpageCli('https://contoso.crm.dynamics.com', { run, sleep: async () => {} });
    const { sdk } = mockSdk();
    const lines = [];
    const result = await buildModelApp(spec, { apply: true, env: 'https://contoso.crm.dynamics.com', appDir, retryDelayMs: 0 }, {
      sdk, provisionSdk: sdk, genpageCli, sleep: async () => {}, log: (m) => lines.push(m),
      discoverOpDiffState: async () => ({ collision: { appExists: false, solutionExists: false }, forms: [], sitemap: null }),
    });
    assert.strictEqual(result.ok, true);
    assert.ok(lines.some((l) => /transient error in pages — retrying/.test(l)), 'the build retried');
    assert.strictEqual(pac.creates(), 1, 'and the create went out once');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

// The one other place a create is left unrecorded: pac made the page, and the receipt that lets a later build find it could not be written. The halt quotes the page's name too.
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
        sdk, provisionSdk: sdk, genpageCli, sleep: async () => {}, log: (m) => lines.push(m),
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

// The pages scan reads each page ONCE, and checks and hashes those bytes; every upload then sends a staging copy of them, never the canonical file.
// A page saved again while the build runs — after the scan, before its own upload — must not ship unchecked, nor be recorded as what was sent.
// Overview links to Detail and Notes, so both are minted first (the create-absent-first step); Help links nowhere and goes up last. While the
// first page goes up, Notes and Help are saved with a key Griffel drops.
test('deploy: every page is uploaded from a staging copy of the bytes the scan read — a save to a page during the build does not ship', async () => {
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
      appShell: { areas: [{ label: 'Main', groups: [{ label: 'Pages', subAreas: ['overview', 'detail', 'notes', 'help'].map((page) => ({ page, title: page })) }] }] },
    };
    const saved = "import { makeStyles } from '@fluentui/react-components';\nconst useStyles = makeStyles({ root: { borderWidth: '1px' } });\nexport default function Saved(){ return null; }";
    const ids = { Overview: OVERVIEW_ID, Detail: DETAIL_ID, Notes: '33333333-0000-4000-8000-000000000003', Help: '44444444-0000-4000-8000-000000000004' };
    const uploads = [];
    const genpageCli = {
      enumerateEnv: async () => ({ ok: true, ids: [], pages: [] }),
      upload: async (o) => {
        uploads.push({ name: o.name, codeFile: o.codeFile, content: fs.readFileSync(o.codeFile, 'utf8') });
        if (uploads.length === 1) {
          fs.writeFileSync(path.join(appDir, 'notes.tsx'), saved, 'utf8');
          fs.writeFileSync(path.join(appDir, 'help.tsx'), saved, 'utf8');
        }
        return { pageId: o.pageId || ids[o.name] };
      },
    };
    const { sdk } = mockSdk();
    const r = await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES });
    assert.deepStrictEqual(uploads.map((u) => u.name), ['Detail', 'Notes', 'Overview', 'Help'], 'the link targets are minted first, then the rest go up, each once');
    const by = Object.fromEntries(uploads.map((u) => [u.name, u]));
    assert.strictEqual(by.Notes.content, original.notes, 'a minted target sends what the scan read, not the later save');
    assert.strictEqual(by.Help.content, original.help, 'a page that links nowhere sends what the scan read, not the later save');
    const stagingRoot = path.join(appDir, '.maker-workspace', '.pageref-deploy');
    for (const u of uploads) assert.ok(u.codeFile.startsWith(stagingRoot), `${u.name}: a staging copy, not the canonical file (${u.codeFile})`);
    assert.ok(!fs.existsSync(stagingRoot) || fs.readdirSync(stagingRoot).length === 0, 'and the copies are removed when the build ends');
    // What the build records as sent is what it sent: the source hash the next build compares with, and (for a page sent in the upload step) the deployed hash.
    for (const key of ['notes', 'help']) assert.strictEqual(r.created.pageSourceShas[key], sha256(original[key]), `${key}: source hash`);
    assert.strictEqual(r.created.pageDeployedShas.help, sha256(original.help), 'help: deployed hash');
    assert.strictEqual(fs.readFileSync(path.join(appDir, 'help.tsx'), 'utf8'), saved, 'the canonical file keeps the save, for the next build to check');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

// Windows reserves the device names, with or without an extension (`NUL.txt` is NUL —
// https://learn.microsoft.com/windows/win32/fileio/naming-a-file), and a page key is a slug that can be one. The
// staging copy pac uploads must never be named like one: where a release reads `con.tsx` as the console, the build
// would hand pac a device instead of the page. Checked on the name rather than by writing one, because Windows 11
// writes `con.tsx` as an ordinary file, so a write would pass here and fail elsewhere.
test('deploy: a page keyed like a Windows device name is staged under a name that is not one', async () => {
  const DEVICE = /^(?:con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(?:\..*)?$/i;
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
      appShell: { areas: [{ label: 'Main', groups: [{ label: 'Pages', subAreas: keys.map((page) => ({ page, title: page })) }] }] },
    };
    const uploads = [];
    let minted = 0;
    const genpageCli = {
      enumerateEnv: async () => ({ ok: true, ids: [], pages: [] }),
      upload: async (o) => {
        uploads.push({ name: o.name, codeFile: o.codeFile, content: fs.readFileSync(o.codeFile, 'utf8') });
        return { pageId: o.pageId || `5${String(++minted).padStart(7, '0')}-0000-4000-8000-000000000000` };
      },
    };
    const { sdk } = mockSdk();
    await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES });
    assert.deepStrictEqual(uploads.map((u) => u.name).sort(), keys.map((k) => `Page ${k}`).sort(), 'every page goes up once');
    for (const u of uploads) {
      const base = path.basename(u.codeFile);
      assert.doesNotMatch(base, DEVICE, `${u.name}: staged as "${base}", which Windows reserves for a device`);
      assert.match(base, /\.tsx$/, `${u.name}: still a .tsx file, for pac to transpile`);
    }
    assert.strictEqual(new Set(uploads.map((u) => path.basename(u.codeFile))).size, uploads.length, 'one staging file per page');
    for (const key of keys.filter((k) => k !== 'con')) assert.strictEqual(uploads.find((u) => u.name === `Page ${key}`).content, source[key], `${key}: the bytes the scan read`);
    assert.doesNotMatch(uploads.find((u) => u.name === 'Page con').content, /PAGEREF_/, 'and the navigation page goes up with its tokens resolved');
    const stagingRoot = path.join(appDir, '.maker-workspace', '.pageref-deploy');
    assert.ok(!fs.existsSync(stagingRoot) || fs.readdirSync(stagingRoot).length === 0, 'the copies are removed when the build ends');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});
