#!/usr/bin/env node
'use strict';
// download-model-app: pull a DEPLOYED app back into a complete app-spec + page codeFiles (the edit
// flow's "pull everything" step). Reconstructs the app (sitemap -> appShell), ALL its generative
// pages (via pac list+download, incl. Maker-authored), its entities (minimal — the build reuses
// existing tables idempotently), the icon web resources, and its solution, via hydrate-spec.
//
// Usage: node download-model-app.js --env <orgUrl> --app <appId|uniqueName> --out <dir>

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs, emitResult } = require('./lib/dataverse-auth.js');
const { createAzHttpClient } = require('./lib/sdk-http-client.js');
const { hydrateSpec } = require('./lib/hydrate-spec.js');
const { makeGenpageCli } = require('./lib/genpage-cli.js');
const { parseManifestBase64, manifestResourceName, reconcilePageIds } = require('./lib/page-manifest.js');
const { reverseResolveNavIds } = require('./lib/pageref-resolver.js');

// webresourcetype (int) -> app-spec web-resource type.
const WR_TYPE = { 1: 'html', 2: 'css', 3: 'js', 4: 'xml', 5: 'png', 6: 'jpg', 7: 'gif', 8: 'xap', 9: 'xsl', 10: 'ico', 11: 'svg', 12: 'resx' };

// Reconstruct the app's dashboards (declared as DashBoard sitemap subareas) into app-spec
// dashboards[] entries. Each tile is reconstructed with ID PASSTHROUGH — it carries the deployed
// view/chart ids (+ target entity) directly, so a rebuild recreates the dashboard against the
// EXISTING views/charts without needing views[]/charts[] declared (which would else duplicate them).
async function readDashboards(sdk, app) {
  const strip = (g) => String(g || '').replace(/[{}]/g, '') || undefined;
  const ids = new Map(); // dashboardId -> subarea title (fallback name)
  for (const a of (app.siteMap && app.siteMap.areas) || []) {
    for (const g of a.groups || []) {
      for (const sa of g.subAreas || []) {
        if (sa.type === 'DashBoard' && sa.dashboardId) ids.set(String(sa.dashboardId).toLowerCase(), sa.title);
      }
    }
  }
  const out = [];
  for (const [id, title] of ids) {
    let art;
    try { art = await sdk.fetchArtifact('dashboard', id); } catch { continue; }
    let name = title || id;
    try { const rows = await sdk.queryRecords('systemform', { select: ['name'], filter: `formid eq ${id}`, top: 1 }); if (rows && rows[0] && rows[0].name) name = rows[0].name; } catch { /* keep fallback */ }
    const tiles = [];
    for (const c of art.components || []) {
      const p = c.parameters || {};
      const entity = p.TargetEntityType;
      const viewId = strip(p.ViewId);
      if (c.type === 'chart' && viewId) tiles.push({ type: 'chart', name: c.name, entity, viewId, visualizationId: strip(p.VisualizationId) });
      else if (c.type === 'list' && viewId) tiles.push({ type: 'list', name: c.name, entity, viewId });
      else if (c.type === 'iframe' && p.Url) tiles.push({ type: 'iframe', name: c.name, url: p.Url });
      else if (c.type === 'webresource' && p.WebResourceName) tiles.push({ type: 'webresource', name: c.name, webResource: p.WebResourceName });
    }
    if (tiles.length) out.push({ id, name, tiles });
  }
  return out;
}

function makeProvision(env, workspaceDir) {
  const { createMakerSdk } = require('./vendor/cds-maker-sdk.cjs');
  const httpClient = createAzHttpClient(env);
  fs.mkdirSync(workspaceDir, { recursive: true });
  const sdk = createMakerSdk({ workspacePath: workspaceDir, instanceUrl: env, httpClient });
  sdk.initWorkspace();
  return sdk;
}

async function resolveAppId(sdk, appArg) {
  if (/^[0-9a-fA-F-]{36}$/.test(appArg)) return appArg;
  const rows = await sdk.queryRecords('appmodule', { select: ['appmoduleid'], filter: `uniquename eq '${String(appArg).replace(/'/g, "''")}'`, top: 1 });
  return rows && rows[0] && rows[0].appmoduleid;
}

// The distinct entity logical names + icon web-resource names referenced by the app's sitemap.
function collectSitemap(app) {
  const entities = new Set();
  const icons = new Set();
  for (const a of (app.siteMap && app.siteMap.areas) || []) {
    if (a.icon) icons.add(a.icon);
    for (const g of a.groups || []) {
      for (const sa of g.subAreas || []) {
        if (sa.type === 'Entity' && sa.entity) entities.add(String(sa.entity).toLowerCase());
        if (sa.icon) icons.add(sa.icon);
      }
    }
  }
  return { entities: [...entities], icons: [...icons] };
}

// Read pac's downloaded page tree (<pagesRoot>/<pageId>/{page.tsx,config.json,prompt.txt}) into
// pages[] entries with codeFile paths relative to `outDir`.
function parseDownloadedPages(pagesRoot, outDir, nameById) {
  const pages = [];
  if (!fs.existsSync(pagesRoot)) return pages;
  for (const entry of fs.readdirSync(pagesRoot)) {
    const dir = path.join(pagesRoot, entry);
    if (!fs.statSync(dir).isDirectory()) continue;
    const tsx = path.join(dir, 'page.tsx');
    if (!fs.existsSync(tsx)) continue;
    let config = {};
    try { config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')); } catch { /* optional */ }
    let prompt = '';
    try { prompt = fs.readFileSync(path.join(dir, 'prompt.txt'), 'utf8').trim(); } catch { /* optional */ }
    pages.push({
      pageId: entry,
      name: (nameById && nameById.get(String(entry).toLowerCase())) || entry,
      dataSources: config.dataSources || [],
      prompt,
      codeFile: path.relative(outDir, tsx).replace(/\\/g, '/'),
    });
  }
  return pages;
}

// Assign a STABLE key to every downloaded page + carry the manifest's v2 semantics. `keyToId` (from
// reconcilePageIds — the authority: manifest-confirmed-live id → unique live-name, ambiguous already
// HALTed upstream) binds manifest keys to live ids; a page bound there reuses that key + purpose/
// navigatesTo/pageInput/dataSources. A page with NO binding (legacy app / Maker-authored) gets a FRESH
// unique slug key (design §7.3 — NOT the old name shape, which drifted on rename). Returns idToKey for
// reverse-normalizing nav literals. Mutates pages. This uses reconcilePageIds, NOT a name-collapsing Map.
function assignPageKeys(pages, manifest, keyToId) {
  const idToKey = new Map();
  const used = new Set();
  const manifestByKey = new Map(((manifest && manifest.pages) || []).map((m) => [m.key, m]));
  // Build idToKey (lowercase-id → key) from the reconciled binding so reverseResolveNavIds can
  // rewrite nav pageId literals back to their symbolic keys (structural, nav literals only).
  for (const [key, id] of (keyToId || new Map())) { idToKey.set(String(id).toLowerCase(), key); used.add(key); }
  // Slug-minter: converts a display name to a stable lowercase slug. De-dupes with a -N suffix when
  // the same slug has already been assigned to another page (collision on rename or duplicate names).
  const mint = (name) => {
    const base = String(name || 'page').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'page';
    let k = base;
    let i = 2;
    while (used.has(k)) k = `${base}-${i++}`;
    used.add(k);
    return k;
  };
  // First pass: assign keys to pages that are bound (manifest-confirmed-live id) + carry v2 semantics.
  for (const p of pages) {
    const bound = idToKey.get(String(p.pageId).toLowerCase());
    if (!bound) continue;
    p.key = bound;
    const m = manifestByKey.get(bound);
    if (m) {
      if (m.purpose !== undefined) p.purpose = m.purpose;
      if (m.navigatesTo) p.navigatesTo = m.navigatesTo;
      if (m.pageInput !== undefined) p.pageInput = m.pageInput;
      // Only copy manifest dataSources when the download gave us nothing (pac may include them).
      if (m.dataSources && !(p.dataSources || []).length) p.dataSources = m.dataSources;
    }
  }
  // Second pass: pages that had no binding get a fresh unique slug key.
  for (const p of pages) {
    if (!p.key) {
      p.key = mint(p.name);
      idToKey.set(String(p.pageId).toLowerCase(), p.key);
    }
  }
  return idToKey;
}

// Entries of `a` whose pageId is absent from `b`. Used BOTH directions to require exact enumerated<->
// downloaded id equality (I3). A gap either way means pac downloaded a different set than exists —
// rebuilding from this spec would silently drop/add pages, so download FAILS instead.
function missingDownloads(a, b) {
  const have = new Set((b || []).map((p) => String(p.pageId).toLowerCase()));
  return (a || []).filter((p) => !have.has(String(p.pageId).toLowerCase()));
}

// Minimal entity spec (schemaName + primary name column). The build reuses existing tables/columns
// idempotently, so column fidelity isn't required to re-apply an edit.
function entityFromMetadata(meta, logical) {
  const primary = (meta && (meta.primaryNameAttribute || meta.primaryNameLogicalName)) || `${logical.split('_')[0]}_name`;
  return {
    schemaName: (meta && (meta.schemaName || meta.logicalName)) || logical,
    displayName: (meta && meta.displayName) || logical,
    primaryAttribute: { schemaName: primary, displayName: 'Name' },
    columns: [],
  };
}

// Fetch the icon web resources referenced by the sitemap, looked up by NAME (the sitemap stores the
// web-resource name, not its id — sdk.getWebResource keys by id and 400s on a name). Returns
// app-spec webResources[] entries with the content as base64.
async function iconWebResources(sdk, icons) {
  const out = [];
  for (const name of icons || []) {
    try {
      const rows = await sdk.queryRecords('webresource', { select: ['name', 'webresourcetype', 'content'], filter: `name eq '${String(name).replace(/'/g, "''")}'`, top: 1 });
      const wr = rows && rows[0];
      if (wr && wr.content) out.push({ name, type: WR_TYPE[wr.webresourcetype] || 'png', contentBase64: wr.content });
    } catch { /* skip a web resource we can't read */ }
  }
  return out;
}

// Count sitemap subareas hydrateSpec could not round-trip (present in the deployed sitemap but not in
// the reconstructed spec — e.g. classic DashBoard subareas). A rebuild from the spec drops these.
function droppedSubareaCount(app, spec) {
  const countSub = (areas) => (areas || []).reduce((n, a) => n + (a.groups || []).reduce((m, g) => m + (g.subAreas || []).length, 0), 0);
  return countSub(app && app.siteMap && app.siteMap.areas) - countSub(spec && spec.appShell && spec.appShell.areas);
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const env = flags.env;
  const appArg = flags.app || positional[0];
  const outDir = path.resolve(flags.out || flags.output || '.');
  if (!env || !appArg) {
    process.stderr.write('Usage: node download-model-app.js --env <url> --app <appId|uniqueName> --out <dir>\n');
    process.exit(1);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const sdk = makeProvision(env, path.join(outDir, '.maker-workspace'));
  const appId = await resolveAppId(sdk, appArg);
  if (!appId) { emitResult(false, { ok: false, error: `app '${appArg}' not found` }); return; }

  const app = await sdk.fetchArtifact('app', appId);
  const { entities: entityLogicals, icons } = collectSitemap(app);

  // Pages (all — incl. Maker-authored). AUTHORITATIVE via a fail-closed enumeration (lists every page,
  // even ones not in the sitemap), NOT the sitemap titles alone. Everything below is fail-closed: an
  // enumeration failure, a download failure, a missing-page gap, or a read/write error ABORTS with a
  // structured error rather than silently writing a page-dropping spec (Critical 2 / I3).
  const genpageCli = makeGenpageCli(env);
  const enumd = await genpageCli.enumerate({ appId });
  if (!enumd.ok) { emitResult(false, { ok: false, error: `page enumeration failed during download: ${enumd.error}` }); return; }
  let pages = [];
  let manifest = null;
  if (!enumd.empty) {
    // Durable manifest (keys + v2 semantics), looked up by the app's unique name. Best-effort:
    // a missing/corrupt manifest means we fall back to fresh-key minting (no v2 semantics).
    const appRows = await sdk.queryRecords('appmodule', { select: ['uniquename'], filter: `appmoduleid eq ${appId}`, top: 1 });
    const appUnique = appRows && appRows[0] && appRows[0].uniquename;
    if (appUnique) {
      const rows = await sdk.queryRecords('webresource', { select: ['content'], filter: `name eq '${manifestResourceName(appUnique).replace(/'/g, "''")}'`, top: 1 });
      if (rows && rows[0] && rows[0].content) manifest = parseManifestBase64(rows[0].content);
    }
    // Clean the download dir, then download — FAIL on error (genpageCli.download throws → main().catch).
    const pagesRoot = path.join(outDir, 'pages');
    fs.rmSync(pagesRoot, { recursive: true, force: true });
    fs.mkdirSync(pagesRoot, { recursive: true });
    await genpageCli.download({ appId, outputDir: pagesRoot });
    // Build the name-by-id map from the AUTHORITATIVE enumeration (not the sitemap), so even
    // Maker-authored pages (absent from the sitemap) get their correct display name.
    const nameById = new Map(enumd.pages.filter((p) => p.name).map((p) => [String(p.pageId).toLowerCase(), p.name]));
    pages = parseDownloadedPages(pagesRoot, outDir, nameById);
    // EXACT enumerated<->downloaded id equality, BOTH directions (I3). A gap either way means pac
    // downloaded a different set than enumerated — rebuilding from this spec would drop/add pages.
    const missing = missingDownloads(enumd.pages, pages);
    if (missing.length) { emitResult(false, { ok: false, error: `enumerated page(s) not downloaded: ${missing.map((p) => p.name || p.pageId).join(', ')} — refusing to write a spec that would drop them` }); return; }
    const extra = missingDownloads(pages, enumd.pages);
    if (extra.length) { emitResult(false, { ok: false, error: `downloaded page(s) not enumerated: ${extra.map((p) => p.pageId).join(', ')} — inconsistent page set` }); return; }
    // Reconcile ids via the reconcilePageIds authority (ambiguous names HALT), assign stable keys,
    // reverse-normalize each page.tsx (structural — nav pageId literals only).
    const { keyToId, ambiguous } = reconcilePageIds((manifest && manifest.pages) || [], manifest, pages);
    if (ambiguous.length) { emitResult(false, { ok: false, error: `ambiguous page name(s) during download: ${ambiguous.map((a) => a.name).join(', ')} — cannot safely reconstruct keys` }); return; }
    const idToKey = assignPageKeys(pages, manifest, keyToId);
    for (const p of pages) {
      const abs = path.join(outDir, p.codeFile);
      const src = fs.readFileSync(abs, 'utf8');           // FAIL on a read error (no swallow)
      const rev = reverseResolveNavIds(src, idToKey);     // structural — nav pageId literals only
      if (rev !== src) fs.writeFileSync(abs, rev, 'utf8'); // FAIL on a write error (no swallow)
    }
  }

  // Entities (minimal).
  const entities = [];
  for (const logical of entityLogicals) {
    try { entities.push(entityFromMetadata(await sdk.fetchEntityMetadata(logical), logical)); } catch { /* skip */ }
  }

  // Icon web resources — looked up by NAME (see iconWebResources).
  const webResources = await iconWebResources(sdk, icons);

  // Dashboards (declared as DashBoard sitemap subareas) — reconstructed with id-passthrough tiles.
  let dashboards = [];
  try { dashboards = await readDashboards(sdk, app); } catch (e) { process.stderr.write(`(dashboards reconstruction skipped: ${e.message})\n`); }

  // Solution (best-effort): the unmanaged solution the appmodule belongs to.
  let solution = { uniqueName: 'Default', publisherPrefix: 'new' };
  try {
    const comps = await sdk.queryRecords('solutioncomponent', { select: ['_solutionid_value'], filter: `objectid eq ${appId}`, top: 1 });
    const solId = comps && comps[0] && comps[0]._solutionid_value;
    if (solId) {
      const sols = await sdk.queryRecords('solution', { select: ['uniquename', 'friendlyname'], filter: `solutionid eq ${solId} and ismanaged eq false`, top: 1 });
      if (sols && sols[0]) solution = { uniqueName: sols[0].uniquename, publisherPrefix: 'new' };
    }
  } catch { /* default */ }

  const read = {
    app: async () => app,
    pages: async () => pages,
    entities: async () => entities,
    webResources: async () => webResources,
    dashboards: async () => dashboards,
    solution: async () => solution,
    design: async () => (manifest ? manifest.design : undefined),
  };
  const spec = await hydrateSpec(read);
  // Warn about any sitemap subareas the edit flow can't yet round-trip (CustomPage subareas and
  // unmapped/legacy types are not hydrated) — a rebuild from this spec would drop them, so the caller
  // must re-add them. Entity/GenPage/URL/DashBoard subareas round-trip losslessly.
  const droppedSubareas = droppedSubareaCount(app, spec);
  if (droppedSubareas > 0) {
    process.stderr.write(`WARNING: ${droppedSubareas} sitemap subarea(s) could not be round-tripped (e.g. custom pages / legacy types) — a rebuild from this spec will DROP them from the app nav. Re-add them after editing.\n`);
  }
  const specPath = path.join(outDir, 'app-spec.json');
  fs.writeFileSync(specPath, JSON.stringify(spec, null, 2));
  emitResult(true, { ok: true, spec: specPath, pages: pages.length, entities: entities.length, webResources: webResources.length, droppedSubareas });
}

if (require.main === module) {
  main().catch((err) => emitResult(false, err));
}

module.exports = { resolveAppId, collectSitemap, parseDownloadedPages, assignPageKeys, missingDownloads, entityFromMetadata, iconWebResources, readDashboards, droppedSubareaCount };
