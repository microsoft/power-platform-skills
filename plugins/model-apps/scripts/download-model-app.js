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

  // Pages (all — incl. Maker-authored). Page names come from the sitemap's GenPage subarea titles
  // (authoritative — they equal the page --name), keyed by genPageId.
  const genpageCli = makeGenpageCli(env);
  const nameById = new Map();
  for (const a of (app.siteMap && app.siteMap.areas) || []) {
    for (const g of a.groups || []) {
      for (const sa of g.subAreas || []) if (sa.type === 'GenPage' && sa.genPageId) nameById.set(String(sa.genPageId).toLowerCase(), sa.title);
    }
  }
  let pages = [];
  if (nameById.size) {
    try {
      const pagesRoot = path.join(outDir, 'pages');
      fs.mkdirSync(pagesRoot, { recursive: true });
      await genpageCli.download({ appId, outputDir: pagesRoot });
      pages = parseDownloadedPages(pagesRoot, outDir, nameById);
    } catch (e) { process.stderr.write(`(pages download skipped: ${e.message})\n`); }
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
  main();
}

module.exports = { resolveAppId, collectSitemap, parseDownloadedPages, entityFromMetadata, iconWebResources, readDashboards, droppedSubareaCount };
