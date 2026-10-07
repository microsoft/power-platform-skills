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
const { runSdkBuild } = require('../lib/sdk-build.js');
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
