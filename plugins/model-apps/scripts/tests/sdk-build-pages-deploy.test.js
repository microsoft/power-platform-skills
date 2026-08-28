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

// Real GUIDs for the three-authority sitemap mock (Imp9). SELF_* resolve THIS app's appmodule + sitemap so
// fetchSitemap(appUnique) returns opts.liveSitemapXml; a page-less EMPTY sitemap is the default membership.
const APP_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const SELF_UNIQUE_VALUE = 'c0ffee00-0000-4000-8000-00000000dddd';
const SELF_SITEMAP_ID = '5111e0f2-0000-4000-8000-0000000000aa';
const EMPTY_SITEMAP_XML = '<SiteMap><Area><Group></Group></Area></SiteMap>';

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
      const pageId = o.pageId || `gp-${String(o.name).toLowerCase()}`;
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
    assert.ok(overviewUpload.content.includes('gp-detail'), 'uploaded content carries the resolved target id');
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

test('deploy: a declared+referenced DANGLING target HALTS before the sitemap finalize', async () => {
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
    assert.strictEqual(byKey.overview, 'gp-overview');
    assert.strictEqual(byKey.detail, 'gp-detail');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('deploy: a rebuild re-binds ids from the live enumeration and issues only UPDATEs (no duplicate CREATE)', async () => {
  const { appDir, spec } = makeTwoPageApp();
  try {
    const live = [{ pageId: 'gp-overview', name: 'Overview' }, { pageId: 'gp-detail', name: 'Detail' }];
    const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: 'gp-overview' }, { key: 'detail', name: 'Detail', pageId: 'gp-detail' }] }), 'utf8').toString('base64');
    const { sdk } = mockSdk({ pageManifest: manifest, manifestId: 'wr-manifest' });
    const genpageCli = mockGenpageCli(live);
    await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES });
    assert.ok(genpageCli.uploads.length > 0);
    assert.ok(genpageCli.uploads.every((u) => !!u.requestedId), 'every upload targets a known pageId (UPDATE) — no CREATE, no duplicate');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

// Sol review (dup-page-name fix): validateAppSpec TOLERATES a duplicate name when both pages carry a
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

test('deploy: a STALE duplicate-named page (its pageId absent from live) HALTS before creating a dupe (Sol review)', async () => {
  const { appDir, spec, GA, manifest } = makeDupNamePageApp();
  try {
    const { sdk } = mockSdk({ pageManifest: manifest, manifestId: 'wr-manifest' });
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
    const { sdk } = mockSdk({ pageManifest: manifest, manifestId: 'wr-manifest' });
    const genpageCli = mockGenpageCli([{ pageId: GA, name: 'Supplier Scorecard' }, { pageId: GB, name: 'Supplier Scorecard' }]); // BOTH exist
    await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES });
    assert.strictEqual(genpageCli.uploads.length, 2, 'both dupe-named pages uploaded');
    assert.ok(genpageCli.uploads.every((u) => !!u.requestedId), 'both are UPDATEs (bound to live ids) — no CREATE, no duplicate materialized');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

// OVERRIDE 2 (new-Important-1): a DYNAMIC nav pageId (e.g. pageId: someVar — a variable, not a literal)
// must be rejected BEFORE any write, even when navigatesTo:[] so the existing parity check sees no mismatch.
// Only extractNavTargets-based structural detection (kind:'dynamic') catches it. Error code: pages-nav-parity.
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
    const live = [{ pageId: 'gp-overview', name: 'Overview' }, { pageId: 'gp-detail', name: 'Detail' }];
    const genpageCli = mockGenpageCli(live);
    const manifest = { schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: 'gp-overview' }, { key: 'detail', name: 'Detail', pageId: 'gp-detail' }] };
    const manifestB64 = Buffer.from(JSON.stringify(manifest), 'utf8').toString('base64');
    const { sdk } = mockSdk({ pageManifest: manifestB64 });
    const r = await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PAGES_ONLY, changedOnly: { fastApply: true, resolvedAppId: APP_ID, skipSitemapFinalize: true, selectedKeys: ['overview'] } });
    assert.ok(r.ok);
    const uploaded = genpageCli.uploads.map((u) => u.name);
    assert.ok(uploaded.includes('Overview'), 'the selected page was uploaded');
    assert.ok(!uploaded.includes('Detail'), 'the UNCHANGED page was NOT re-uploaded (no clobber)');
    assert.ok(r.created.pageDeployedShas.overview, 'a measured deployed hash is recorded for the uploaded page');
    assert.ok(!r.created.pageDeployedShas.detail, 'no deployed hash for the page we did not touch');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});
