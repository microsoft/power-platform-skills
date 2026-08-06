'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { readerFor } = require('../verify-model-app.js');

const GP_OVERVIEW = '13ecbc57-a3a4-4132-b0a2-a6c6b12691e8';
const GP_DETAIL   = '5c0a4889-45fd-46ea-91a8-ff876914d644';

// SDK stub that provides enough surface for readerFor (appId resolution, sitemap, webresource).
// `sitemap` when provided causes stubSdk to route appmodulecomponent + sitemap queries appropriately
// so fetchSitemap returns { ok:true, xml, ids }.
function stubSdk({ webresource = [], sitemap = null } = {}) {
  return {
    queryRecords: async (set) => {
      if (set === 'appmodule') return [{ appmoduleid: 'app-uuid-1', appmoduleidunique: 'uid-1' }];
      if (set === 'appmodulecomponent') return sitemap ? [{ objectid: 'sm-1', componenttype: 62 }] : [];
      if (set === 'sitemap') return sitemap ? [{ sitemapxml: sitemap }] : [];
      if (set === 'webresource') return webresource;
      return [];
    },
    findTables: async () => [],
    findColumns: async () => [],
  };
}

// SDK where appmodule returns empty → fetchSitemap gets { ok:false, reason:'app-not-found' }.
function noAppSdk() {
  return { queryRecords: async () => [], findTables: async () => [], findColumns: async () => [] };
}

test('readerFor.existenceIds() calls enumerateEnv(), memoized to one call, throws on failure', async () => {
  let calls = 0;
  const genpageCli = { enumerateEnv: async () => { calls++; return { ok: true, ids: [GP_OVERVIEW, GP_DETAIL] }; } };
  const reader = readerFor(stubSdk(), 'contoso_app', { genpageCli, workspaceDir: os.tmpdir() });

  const ids = await reader.existenceIds();
  assert.deepStrictEqual(ids, [GP_OVERVIEW, GP_DETAIL]);
  await reader.existenceIds(); // second call — must NOT re-invoke enumerateEnv (memoized)
  assert.strictEqual(calls, 1, 'enumerateEnv called exactly once (memoized per verify run)');

  // Failure path: enumerateEnv !ok → existenceIds must throw (fail-closed — unknown env means cannot verify).
  const failing = readerFor(stubSdk(), 'contoso_app', {
    genpageCli: { enumerateEnv: async () => ({ ok: false, error: 'auth expired' }) },
    workspaceDir: os.tmpdir(),
  });
  await assert.rejects(failing.existenceIds(), /auth expired/i);
});

test('readerFor.sitemapPageIds() returns page ids from fetchSitemap; throws when sitemap unreadable', async () => {
  const xml = `<SiteMap><Area><Group><SubArea GenPageId="${GP_OVERVIEW}"/><SubArea GenPageId="${GP_DETAIL}"/></Group></Area></SiteMap>`;
  const reader = readerFor(stubSdk({ sitemap: xml }), 'contoso_app', {
    genpageCli: { enumerateEnv: async () => ({ ok: true, ids: [] }) },
    workspaceDir: os.tmpdir(),
  });
  const ids = await reader.sitemapPageIds();
  assert.ok(ids.includes(GP_OVERVIEW.toLowerCase()), 'GP_OVERVIEW in sitemapPageIds');
  assert.ok(ids.includes(GP_DETAIL.toLowerCase()), 'GP_DETAIL in sitemapPageIds');

  // Failure: fetchSitemap returns !ok (app-not-found) → sitemapPageIds must throw (fail-closed).
  const failing = readerFor(noAppSdk(), 'contoso_app', {
    genpageCli: { enumerateEnv: async () => ({ ok: true, ids: [] }) },
    workspaceDir: os.tmpdir(),
  });
  await assert.rejects(failing.sitemapPageIds(), /could not read the app sitemap/i);
});

test('readerFor.manifest() returns null when webresource absent; parsed manifest when valid; null when corrupt', async () => {
  // Absent: no webresource row → manifest() returns null (verifySpec will set unableToRun on a page-bearing spec).
  const readAbsent = readerFor(stubSdk(), 'contoso_app', {
    genpageCli: { enumerateEnv: async () => ({ ok: true, ids: [] }) },
    workspaceDir: os.tmpdir(),
  });
  assert.strictEqual(await readAbsent.manifest(), null, 'manifest null when webresource absent');

  // Valid: webresource.content = base64 of valid manifest JSON → manifest() returns parsed object.
  const manifest = { schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: GP_OVERVIEW }] };
  const b64 = Buffer.from(JSON.stringify(manifest)).toString('base64');
  const readPresent = readerFor(stubSdk({ webresource: [{ content: b64 }] }), 'contoso_app', {
    genpageCli: { enumerateEnv: async () => ({ ok: true, ids: [] }) },
    workspaceDir: os.tmpdir(),
  });
  const m = await readPresent.manifest();
  assert.ok(m && m.pages[0].pageId === GP_OVERVIEW, 'manifest parsed when webresource is valid');

  // Corrupt: base64 of non-JSON → parseManifestBase64 returns null → manifest() returns null.
  const corruptB64 = Buffer.from('this is not valid json!').toString('base64');
  const readCorrupt = readerFor(stubSdk({ webresource: [{ content: corruptB64 }] }), 'contoso_app', {
    genpageCli: { enumerateEnv: async () => ({ ok: true, ids: [] }) },
    workspaceDir: os.tmpdir(),
  });
  assert.strictEqual(await readCorrupt.manifest(), null, 'manifest null when webresource is corrupt JSON');
});

test('readerFor.pageCode(id) downloads by id (pageIds:[id]), caches per id, throws on download failure', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-'));
  let downloads = 0;
  const genpageCli = {
    enumerateEnv: async () => ({ ok: true, ids: [] }),
    // Simulate pac writing <outDir>/<pageId>/page.tsx (the per-id output layout).
    download: async ({ outputDir, pageIds }) => {
      downloads += 1;
      const id = pageIds[0];
      fs.mkdirSync(path.join(outputDir, id), { recursive: true });
      fs.writeFileSync(path.join(outputDir, id, 'page.tsx'), `// code for ${id}`, 'utf8');
      return true;
    },
  };
  const reader = readerFor(stubSdk(), 'contoso_app', { genpageCli, workspaceDir: ws });

  const code = await reader.pageCode(GP_OVERVIEW);
  assert.ok(code.includes(GP_OVERVIEW), 'returned the page code for the requested id');

  await reader.pageCode(GP_OVERVIEW); // second call — same id — must NOT re-download
  assert.strictEqual(downloads, 1, 'download runs once per id (cached)');

  await reader.pageCode(GP_DETAIL); // different id → exactly one more download (per-id, not all-pages)
  assert.strictEqual(downloads, 2, 'each distinct id downloaded separately');

  // Download failure → throws so the build gate gets an error (fail-closed).
  const failing = readerFor(stubSdk(), 'contoso_app', {
    genpageCli: {
      enumerateEnv: async () => ({ ok: true, ids: [] }),
      download: async () => { throw new Error('pac download failed'); },
    },
    workspaceDir: fs.mkdtempSync(path.join(os.tmpdir(), 'vf-')),
  });
  await assert.rejects(failing.pageCode(GP_OVERVIEW), /pac download failed/i);
});

test('readerFor WITHOUT a genpageCli has no sitemapPageIds/existenceIds/manifest/pageCode — verifySpec fails closed (Imp7/C6)', () => {
  const reader = readerFor(stubSdk(), 'contoso_app', {});
  // No genpageCli → page-authority methods absent → verifySpec detects reader-incapacity → unableToRun.
  assert.strictEqual(typeof reader.sitemapPageIds, 'undefined', 'no sitemapPageIds when no genpageCli');
  assert.strictEqual(typeof reader.existenceIds, 'undefined', 'no existenceIds when no genpageCli');
  assert.strictEqual(typeof reader.manifest, 'undefined', 'no manifest when no genpageCli');
  assert.strictEqual(typeof reader.pageCode, 'undefined', 'no pageCode when no genpageCli');
});
