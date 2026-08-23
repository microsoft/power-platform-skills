'use strict';
// Failure-ordering + restart-convergence for the §9 pages protocol (I6/C5): the sitemap is committed ONLY
// after every resolved upload; a halt directly after the FIRST create converges on re-run without
// duplicate creates; and the descoped advisory lease refuses a fresh concurrent build (I4).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runSdkBuild, appUniqueName, acquireAppPagesLease } = require('../lib/sdk-build.js');

// Real GUIDs for the three-authority sitemap mock (Imp9). fetchSitemap(self) resolves via SELF_* to a
// page-less EMPTY sitemap — these ordering/restart tests converge on EXISTENCE (env list), not membership.
const APP_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const SELF_UNIQUE_VALUE = 'c0ffee00-0000-4000-8000-00000000dddd';
const SELF_SITEMAP_ID = '5111e0f2-0000-4000-8000-0000000000aa';
const EMPTY_SITEMAP_XML = '<SiteMap><Area><Group></Group></Area></SiteMap>';

// Stateful harness: enumerate() reflects pages a create appended; the manifest webresource persists in
// `store`/`manifestB64`; uploads are recorded in the shared `calls` sequence log.
function harness() {
  const live = [];
  const calls = [];
  const store = {};
  let manifestB64 = null;
  const sdk = {
    queryRecords: async (e, o) => {
      const filter = (o && o.filter) || '';
      if (e === 'appmodule') {
        const m = filter.match(/uniquename eq '([^']+)'/);
        if (m) return [{ appmoduleid: APP_ID, appmoduleidunique: SELF_UNIQUE_VALUE, uniquename: m[1] }];
        return [{ appmoduleid: APP_ID, appmoduleidunique: SELF_UNIQUE_VALUE, uniquename: undefined }];
      }
      if (e === 'appmodulecomponent') return [{ objectid: SELF_SITEMAP_ID, componenttype: 62 }];
      if (e === 'sitemap') {
        if (/sitemapnameunique eq/.test(filter)) return [{ sitemapid: 'sm-1' }];
        return [{ sitemapxml: EMPTY_SITEMAP_XML }];
      }
      if (e === 'solution') return [];
      if (e === 'webresource') { if (/_pagemanifest'/.test(filter)) return manifestB64 ? [{ webresourceid: 'wr-m', content: manifestB64 }] : []; return []; }
      if (e === 'systemform') return [];
      if (e === 'savedquery') return [{ savedqueryid: 'defview-x', isdefault: true }];
      return [{ publisherid: 'pub-1' }];
    },
    findArtifact: async () => null,
    fetchArtifact: async (t, id) => { if (!store[`${t}:${id}`]) store[`${t}:${id}`] = { id, siteMap: { areas: [] } }; return store[`${t}:${id}`]; },
    createPublisher: async () => ({ id: 'pub-new' }), createSolution: async () => ({ id: 'sol-1' }),
    findTables: async () => [], findColumns: async () => [],
    fetchEntityMetadata: async (l) => ({ logicalName: l, entitySetName: `${l}s`, attributes: [], relationships: [] }),
    createTable: async (o) => ({ logicalName: o.schemaName.toLowerCase(), entitySetName: `${o.schemaName.toLowerCase()}s`, metadataId: 't' }),
    createColumn: async (e, o) => ({ logicalName: o.schemaName.toLowerCase(), metadataId: 'c' }),
    createRelationship: async (o) => ({ schemaName: o.schemaName }),
    createWebResource: async (o) => { calls.push({ name: 'createWebResource', args: [o] }); if (/_pagemanifest$/.test(o.name)) manifestB64 = Buffer.from(o.content, 'utf8').toString('base64'); return { id: 'wr-m', name: o.name }; },
    updateWebResource: async (id, o) => { calls.push({ name: 'updateWebResource', args: [id, o] }); manifestB64 = Buffer.from(o.content, 'utf8').toString('base64'); return {}; },
    enrichDefaultViews: async () => ({ updated: [] }),
    createArtifact: (t, def) => { const id = `${t}-1`; store[`${t}:${id}`] = Object.assign({ id }, def); return JSON.parse(JSON.stringify(store[`${t}:${id}`])); },
    getArtifact: (t, id) => store[`${t}:${id}`] || { id },
    addElement: () => ({}), updateElement: (t, id, ptr, patch) => { calls.push({ name: 'updateElement', args: [t, id, ptr, patch] }); },
    removeElement: () => ({}),
    pushArtifact: async (t, id) => ({ type: t, id, success: true }),
    addSolutionComponent: async () => {}, publishArtifact: async () => {},
  };
  const genpageCli = {
    uploads: [],
    // EXISTENCE reflects pages a create appended to `live` (env-wide, Task 2).
    enumerateEnv: async () => ({ ok: true, ids: live.map((p) => String(p.pageId).toLowerCase()), pages: live.slice() }),
    upload: async (o) => {
      const pageId = o.pageId || `gp-${String(o.name).toLowerCase()}`;
      genpageCli.uploads.push({ name: o.name, requestedId: o.pageId, resolvedId: pageId });
      calls.push({ name: 'upload', args: [o.name] });
      if (!o.pageId && !live.some((p) => p.name === o.name)) live.push({ pageId, name: o.name });
      return { pageId };
    },
  };
  return { sdk, genpageCli, calls, live };
}

const NAV = (key) => `Xrm.Navigation.navigateTo({ pageType: "generative", pageId: "PAGEREF_${key}", data: {} });`;

// Overview → Detail. Detail (the nav target) is created FIRST in create-absent-first, so the "first create"
// is Detail; Overview is created (or updated) in upload-once.
function twoPageApp() {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-order-'));
  fs.writeFileSync(path.join(appDir, 'overview.tsx'), `export default function O(){ ${NAV('detail')} return null; }`, 'utf8');
  fs.writeFileSync(path.join(appDir, 'detail.tsx'), 'export default function D(){ return null; }', 'utf8');
  const spec = {
    schemaVersion: 2, solution: { uniqueName: 'PgOrd', displayName: 'Pg', publisherPrefix: 'contoso' }, app: { name: 'Order App' },
    entities: [{ schemaName: 'contoso_item', displayName: 'Item', primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' }, columns: [] }],
    pages: [
      { key: 'overview', name: 'Overview', navigatesTo: [{ targetKey: 'detail' }], source: { kind: 'tsx', codeFile: 'overview.tsx' } },
      { key: 'detail', name: 'Detail', source: { kind: 'tsx', codeFile: 'detail.tsx' } },
    ],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Pages', subAreas: [{ page: 'overview', title: 'Overview' }, { page: 'detail', title: 'Detail' }] }] }] },
  };
  return { appDir, spec };
}
const PHASES = ['solution', 'data-model', 'app-shell', 'pages'];

test('SEQUENCE: uploads → per-create manifest persist → sitemap finalize; no manifest write after finalize (I6)', async () => {
  const { appDir, spec } = twoPageApp();
  try {
    const h = harness();
    await runSdkBuild(spec, { sdk: h.sdk, apply: true, env: 'https://x', appDir, genpageCli: h.genpageCli, phases: PHASES });
    const idxs = (pred) => h.calls.map((c, i) => (pred(c) ? i : -1)).filter((i) => i >= 0);
    const uploadIdxs = idxs((c) => c.name === 'upload');
    const manifestIdxs = idxs((c) => (c.name === 'createWebResource' && /_pagemanifest$/.test(c.args[0].name)) || c.name === 'updateWebResource');
    const finalizeIdx = h.calls.findIndex((c) => c.name === 'updateElement' && c.args[2] === '/siteMap');
    assert.ok(uploadIdxs.length >= 2 && manifestIdxs.length >= 1 && finalizeIdx >= 0);
    assert.ok(Math.min(...manifestIdxs) > Math.min(...uploadIdxs), 'the first manifest persist follows the first upload (persist-after-each-create)');
    assert.ok(manifestIdxs.every((i) => i < finalizeIdx), 'every manifest write precedes the sitemap finalize (the commit point)');
    assert.ok(uploadIdxs.every((i) => i < finalizeIdx), 'every upload precedes the finalize');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('RESTART-CONVERGENCE: a halt directly after the FIRST page CREATE re-runs with NO duplicate create (C5)', async () => {
  const { appDir, spec } = twoPageApp();
  try {
    const h = harness();
    let n = 0;
    const realUpload = h.genpageCli.upload;
    h.genpageCli.upload = async (o) => { n += 1; if (n === 2) throw new Error('crash directly after the first page create'); return realUpload(o); };
    await assert.rejects(runSdkBuild(spec, { sdk: h.sdk, apply: true, env: 'https://x', appDir, genpageCli: h.genpageCli, phases: PHASES }));
    const created1 = h.genpageCli.uploads.filter((u) => !u.requestedId);
    assert.strictEqual(created1.length, 1, 'exactly ONE create landed before the crash; the manifest was persisted right after it');
    const firstName = created1[0].name; // 'Detail' (the absent nav target minted first)
    // Re-run the FULL build. Enumeration + the persisted manifest bind the created page → it is only
    // UPDATEd this run, and the un-created page is created once. No duplicate of the first page.
    h.genpageCli.upload = realUpload;
    const before = h.genpageCli.uploads.length;
    await runSdkBuild(spec, { sdk: h.sdk, apply: true, env: 'https://x', appDir, genpageCli: h.genpageCli, phases: PHASES });
    const run2 = h.genpageCli.uploads.slice(before);
    assert.ok(run2.filter((u) => u.name === firstName).every((u) => !!u.requestedId), 'the already-created page is only UPDATEd in run 2 (seeded from the persisted manifest + enumeration)');
    assert.strictEqual(h.live.filter((p) => p.name === firstName).length, 1, 'the first page exists exactly once — no duplicate');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('FAILURE-ORDER: an upload failure before the finalize leaves the sitemap unwritten', async () => {
  const { appDir, spec } = twoPageApp();
  try {
    const h = harness();
    const realUpload = h.genpageCli.upload;
    h.genpageCli.upload = async (o) => { if (o.name === 'Overview' && o.codeFile && /pageref-deploy/.test(o.codeFile)) throw new Error('pac upload failed'); return realUpload(o); };
    await assert.rejects(runSdkBuild(spec, { sdk: h.sdk, apply: true, env: 'https://x', appDir, genpageCli: h.genpageCli, phases: PHASES }));
    assert.ok(!h.calls.some((c) => c.name === 'updateElement' && c.args[2] === '/siteMap'), 'the sitemap is NOT finalized when an upload fails before the commit point');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('CONCURRENCY: a second build HALTs (pages-locked) while a FRESH app-scoped lock is held (I4)', async () => {
  const { appDir, spec } = twoPageApp();
  try {
    const wsDir = path.join(appDir, '.maker-workspace');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, `pages-${appUniqueName(spec).replace(/[^A-Za-z0-9_-]/g, '_')}.lock`), JSON.stringify({ pid: 999999, at: Date.now() }));
    const h = harness();
    await assert.rejects(
      runSdkBuild(spec, { sdk: h.sdk, apply: true, env: 'https://x', appDir, genpageCli: h.genpageCli, phases: PHASES }),
      (e) => e && e.phase === 'pages' && e.code === 'pages-locked'
    );
    assert.strictEqual(h.genpageCli.uploads.length, 0, 'no page uploaded while the lease is held by another build');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

// Direct unit tests of the DESCOPED advisory lease (review R2 Critical 3): the DESCOPED advisory lease
// NEVER steals and NEVER age-reclaims — a held lock HALTs a second acquire (manual delete required);
// release is owner-checked. Correctness rests on the convergence spine, not the lock.
test('LEASE: a FRESH lock HALTs a second acquire (never steals); release then allows re-acquire', () => {
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-'));
  try {
    const now = () => 1000;
    const a = acquireAppPagesLease(wsDir, 'app', { now });
    assert.throws(() => acquireAppPagesLease(wsDir, 'app', { now }), (e) => e && e.code === 'pages-locked');
    a.release();
    const b = acquireAppPagesLease(wsDir, 'app', { now });
    b.release();
  } finally { fs.rmSync(wsDir, { recursive: true, force: true }); }
});

test('LEASE: a held lock is NEVER auto-reclaimed by age — a much-later acquire still HALTs (manual delete required)', () => {
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-'));
  try {
    acquireAppPagesLease(wsDir, 'app', { now: () => 0 }); // held at t=0, never released
    assert.throws(() => acquireAppPagesLease(wsDir, 'app', { now: () => 100000000 }), (e) => e && e.code === 'pages-locked', 'no age-reclaim: an old lock still HALTs; correctness rests on the convergence spine, not the lock');
  } finally { fs.rmSync(wsDir, { recursive: true, force: true }); }
});

test('LEASE: release is owner-checked — it does NOT remove a lock a different pid now holds', () => {
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-'));
  try {
    const lease = acquireAppPagesLease(wsDir, 'app', { now: () => 0 });
    const lockPath = path.join(wsDir, 'pages-app.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid + 1, at: Date.now() })); // another build took over
    lease.release();
    assert.ok(fs.existsSync(lockPath), 'release did not delete a lock now owned by a different pid');
  } finally { fs.rmSync(wsDir, { recursive: true, force: true }); }
});
