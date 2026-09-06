#!/usr/bin/env node
'use strict';
// download-model-app: pull a DEPLOYED app back into an editable app-spec + page codeFiles (the edit
// flow's "pull everything" step). Reconstructs the app (sitemap -> appShell), ALL its generative
// pages (via pac list+download, incl. Maker-authored), its entities (minimal — the build reuses
// existing tables idempotently), the icon web resources, and its solution, via hydrate-spec.
//
// Usage: node download-model-app.js --env <orgUrl> --app <appId|uniqueName|displayName> --out <dir> [--allow-lossy-download]

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs, emitResult } = require('./lib/dataverse-auth.js');
const { createAzHttpClient } = require('./lib/sdk-http-client.js');
const { hydrateSpec, descriptionFromDataverse, withDescription } = require('./lib/hydrate-spec.js');
const { makeGenpageCli } = require('./lib/genpage-cli.js');
const { parseManifestBase64, manifestResourceName, reconcilePageIds } = require('./lib/page-manifest.js');
const { reverseResolveNavIds } = require('./lib/pageref-resolver.js');
const { fetchSitemap, sitemapGenPages } = require('./lib/sitemap-pages.js');
const { isRestrictedSolution } = require('./lib/system-solutions.js');
const { isPlatformIconRef, webResourceNameFromRef, validateAppSpec, normalizeLanguageCode } = require('./lib/app-spec.js');

// webresourcetype (int) -> app-spec web-resource type.
const WR_TYPE = { 1: 'html', 2: 'css', 3: 'js', 4: 'xml', 5: 'png', 6: 'jpg', 7: 'gif', 8: 'xap', 9: 'xsl', 10: 'ico', 11: 'svg', 12: 'resx' };

// Reconstruct the app's dashboards (declared as DashBoard sitemap subareas) into app-spec
// dashboards[] entries. Each tile is reconstructed with ID PASSTHROUGH — it carries the deployed
// view/chart ids (+ target entity) directly, so a rebuild recreates the dashboard against the
// EXISTING views/charts without needing views[]/charts[] declared (which would else duplicate them).
// `warn` is optional and injected so the CLI can report WHY a dashboard could not be reconstructed.
// Without it this function swallowed every per-dashboard failure (`catch { continue }`) and returned
// a short list, so the subarea silently dropped and download failed downstream with "could not be
// round-tripped" and no cause. That is a diagnosis dead-end: live, the real reason was an SDK
// deserialization bug several layers down, and nothing surfaced it.
async function readDashboards(sdk, app, warn) {
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
    // Keep going on a single unreadable dashboard — one bad artifact must not sink the whole
    // download — but SAY SO. A dropped subarea with no stated cause is what made this untraceable.
    try { art = await sdk.fetchArtifact('dashboard', id); } catch (e) {
      if (typeof warn === 'function') warn(`dashboard '${title || id}' (${id}) could not be read: ${e && e.message}`);
      continue;
    }
    let name = title || id;
    let description;
    try {
      const rows = await sdk.queryRecords('systemform', { select: ['name', 'description'], filter: `formid eq ${id}`, top: 1 });
      if (rows && rows[0] && rows[0].name) name = rows[0].name;
      description = rows && rows[0] && rows[0].description;
    } catch { /* keep fallback */ }
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
    // A dashboard that read cleanly but yielded no usable tile is ALSO a silent drop — the subarea
    // disappears with nothing said. Distinguish it from the unreadable case above.
    if (tiles.length) out.push(withDescription({ id, name, tiles }, description));
    else if (typeof warn === 'function') {
      warn(`dashboard '${name}' (${id}) read OK but produced no recognizable tiles `
        + `(${(art.components || []).length} component(s)); its sitemap subarea will be dropped.`);
    }
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

// Resolve `--app` to an app GUID. Accepts the app's id, its immutable `uniquename`, or — as a
// convenience — its DISPLAY name. Identity order matters: an id and a uniquename are unique and
// authoritative, so they are tried first and a display-name query is never issued for them.
//
// A display NAME is resolved only as a LAST RESORT and FAILS CLOSED on ambiguity. Unlike a
// uniquename it is mutable and NOT unique — Dataverse happily holds two appmodules both named
// "Sales" — so silently taking the first match could download a different app than the operator
// meant. On multiple matches we return the candidate unique names instead of guessing.
// Display names were previously rejected outright with a bare "not found", which is a dead end for
// an operator holding the name the maker portal shows them (the unique name is not surfaced there).
//
// Returns { appId, matchedBy?, uniqueName? } on success, or { error } describing how to retry.
async function resolveAppId(sdk, appArg) {
  if (/^[0-9a-fA-F-]{36}$/.test(appArg)) return { appId: appArg };
  // OData string literals escape a single quote by DOUBLING it: O'Brien -> 'O''Brien'.
  const esc = String(appArg).replace(/'/g, "''");
  const byUnique = await sdk.queryRecords('appmodule', { select: ['appmoduleid'], filter: `uniquename eq '${esc}'`, top: 1 });
  if (byUnique && byUnique[0] && byUnique[0].appmoduleid) return { appId: byUnique[0].appmoduleid, matchedBy: 'uniqueName' };

  const byName = await sdk.queryRecords('appmodule', { select: ['appmoduleid', 'uniquename', 'name'], filter: `name eq '${esc}'`, top: 50 });
  const matches = (byName || []).filter((r) => r && r.appmoduleid);
  if (matches.length === 1) return { appId: matches[0].appmoduleid, matchedBy: 'displayName', uniqueName: matches[0].uniquename };
  if (matches.length > 1) {
    const names = matches.map((m) => m.uniquename).filter(Boolean).join(', ');
    return { error: `'${appArg}' is a DISPLAY name shared by ${matches.length} apps — display names are not unique, so re-run --app with one of these unique names: ${names}` };
  }
  return { error: `app '${appArg}' not found — --app takes the app's id (GUID), its unique name (e.g. new_myapp), or an unambiguous display name` };
}

// The distinct entity logical names + icon web-resource NAMES referenced by the app's sitemap. Returns
// TWO name sets:
//   `icons`     — BARE-NAME icon references (a locally-declared image web resource); fetched and
//                 re-emitted as webResources[] so the build recreates them (existing behavior).
//   `customRefs`— web-resource NAMES extracted from a PLATFORM icon/vectorIcon PATH reference
//                 (`/WebResources/<name>` or `$webresource:<name>`) on ANY area/subarea icon OR
//                 vectorIcon. These are fetched too — but re-declared ONLY when the WR is CUSTOM
//                 (unmanaged) — so a modern custom nav icon referenced by PATH survives a cross-env
//                 rebuild (previously the path was a dangling reference: the WR was never recreated on
//                 a target env that lacked it). An OOB/system path (a managed WR, or a virtual
//                 `/_imgs/...` image that isn't a real web resource) resolves to nothing / a managed WR
//                 and is left as a bare reference (it exists on every env / travels with its managed
//                 solution).
function collectSitemap(app) {
  const entities = new Set();
  const icons = new Set();
  const customRefs = new Set();
  const navRefs = new Set();   // web resources a URL SUBAREA targets (non-image types allowed)
  const addIcon = (v) => { if (!v) return; if (isPlatformIconRef(v)) { const n = webResourceNameFromRef(v); if (n) customRefs.add(n); } else icons.add(v); };
  for (const a of (app.siteMap && app.siteMap.areas) || []) {
    addIcon(a.icon); addIcon(a.vectorIcon);
    for (const g of a.groups || []) {
      for (const sa of g.subAreas || []) {
        if (sa.type === 'Entity' && sa.entity) entities.add(String(sa.entity).toLowerCase());
        addIcon(sa.icon); addIcon(sa.vectorIcon);
        // A URL subarea can TARGET a web resource rather than link out — the Site Map Designer's
        // "custom page backed by an HTML web resource" writes `$webresource:<name>`. Collected
        // SEPARATELY from icon refs because the type policy differs: such a page is `html`, which the
        // icon path's image-only gate excludes by design. Capturing it means the page travels with
        // the app instead of the rebuild emitting a nav entry the spec cannot recreate.
        // `webResourceNameFromRef` returns null for a real http(s) link, so those are untouched.
        if (sa.type === 'URL' && sa.url) {
          const wr = webResourceNameFromRef(sa.url);
          if (wr) navRefs.add(wr);
        }
      }
    }
  }
  return { entities: [...entities], icons: [...icons], customRefs: [...customRefs], navRefs: [...navRefs] };
}

// The entity logical names that are COMPONENTS of the app module, regardless of whether they appear
// in the sitemap. `collectSitemap` can only see tables the maker placed in navigation, but a
// model-driven app routinely includes tables reachable only through a lookup, sub-grid, or related
// view — an app built on account/contact typically also carries task, email, appointment, phonecall,
// systemuser, team and annotation with no sitemap entry of their own. Reconstructing entities from
// the sitemap alone silently dropped those (ADO 6603388), so the download→edit→rebuild round trip
// lost hidden app dependencies.
//
// The entity is derived from the app's VIEW / CHART / FORM components, NOT from its
// `componenttype eq 1` (Entities) rows. That looks like the obvious source but is unusable:
// LIVE-verified that every componenttype-1 row carries the SAME `objectid` — the MetadataId of the
// `entity` metadata table itself — so it identifies the component *kind*, not which table. (On a
// 2-table app both rows read `9d0f025b-…`, which resolves to the logical name `entity`.)
// `RetrieveAppComponents` returned 0 rows on the same app, so it is not an alternative here.
//
// View/chart/form components DO carry usable ids: each `objectid` is a real row id whose record
// names its owning table. An app includes its tables' views and forms, so unioning their owners
// recovers the hidden membership.
//   componenttype 26 → savedquery.returnedtypecode
//   componenttype 59 → savedqueryvisualization.primaryentitytypecode
//   componenttype 60 → systemform.objecttypecode
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/appmodulecomponent
//
// `appId` is the appmoduleid; the parent lookup targets `appmoduleidunique`, so that is resolved
// first. Best-effort by design: any failure returns an empty list so the caller keeps today's
// sitemap-derived behavior rather than losing the download entirely.
const APP_COMPONENT_ENTITY_SOURCES = [
  { componentType: 26, set: 'savedquery', idField: 'savedqueryid', entityField: 'returnedtypecode' },
  { componentType: 59, set: 'savedqueryvisualization', idField: 'savedqueryvisualizationid', entityField: 'primaryentitytypecode' },
  { componentType: 60, set: 'systemform', idField: 'formid', entityField: 'objecttypecode' },
];
// Dataverse honors `$top` as a HARD cap and omits `@odata.nextLink`, so this is the point past which
// components of one type stop being inspected. Generous for a real app (a 70-table app has ~1000
// views), and exceeded only with a warning.
const COMPONENT_PAGE_CAP = 1000;

async function appComponentEntities(sdk, appId) {
  if (!appId) return [];
  try {
    const appRows = await sdk.queryRecords('appmodule', { select: ['appmoduleidunique'], filter: `appmoduleid eq ${appId}`, top: 1 });
    const appUniqueId = appRows && appRows[0] && appRows[0].appmoduleidunique;
    if (!appUniqueId) return [];
    const parent = String(appUniqueId).replace(/[{}]/g, '');
    const found = new Set();
    for (const src of APP_COMPONENT_ENTITY_SOURCES) {
      const rows = await sdk.queryRecords('appmodulecomponent', {
        select: ['objectid', 'componenttype'],
        filter: `_appmoduleidunique_value eq ${parent} and componenttype eq ${src.componentType}`,
        top: COMPONENT_PAGE_CAP,
      });
      // `$top` is a HARD cap in Dataverse (the SDK refuses to combine `top` with `paginate` for
      // exactly this reason: `@odata.nextLink` is omitted, so the tail is lost with no signal). An
      // app with more than this many components of one type would silently lose the remainder —
      // the same silent-drop class as ADO 6603388, just at a higher threshold — so say so rather
      // than quietly returning a partial set.
      if ((rows || []).length >= COMPONENT_PAGE_CAP) {
        process.stderr.write(`WARNING: this app has at least ${COMPONENT_PAGE_CAP} ${src.set} components; only the first ${COMPONENT_PAGE_CAP} were inspected, so a table referenced only beyond that point may be missing from the spec.\n`);
      }
      const ids = [...new Set((rows || []).map((r) => r && r.objectid).filter(Boolean).map((id) => String(id).replace(/[{}]/g, '')))];
      // Chunk the OR-batched id lookups so a many-component app cannot build an over-long URL.
      for (let i = 0; i < ids.length; i += 20) {
        const filter = ids.slice(i, i + 20).map((id) => `${src.idField} eq ${id}`).join(' or ');
        const recs = await sdk.queryRecords(src.set, { select: [src.idField, src.entityField], filter, top: 1000 });
        // A dashboard is a `systemform` row too, and its `objecttypecode` is NOT an entity logical
        // name ('none' / ''). Filtering it here keeps a bogus name out of the metadata fetch loop
        // instead of relying on that fetch 404-ing into a bare catch.
        for (const r of recs || []) {
          const logical = r && r[src.entityField] ? String(r[src.entityField]).toLowerCase() : '';
          if (logical && logical !== 'none') found.add(logical);
        }
      }
    }
    return [...found];
  } catch {
    return []; // best-effort — never break the download over the component read
  }
}

async function rowsByIds(sdk, set, idField, ids, select, mapRow) {
  const out = [];
  const clean = [...new Set((ids || []).map((id) => String(id || '').replace(/[{}]/g, '')).filter(Boolean))];
  for (let i = 0; i < clean.length; i += 20) {
    const filter = clean.slice(i, i + 20).map((id) => `${idField} eq ${id}`).join(' or ');
    const rows = await sdk.queryRecords(set, { select, filter, top: 1000 });
    for (const r of rows || []) out.push(mapRow(r));
  }
  return out;
}

async function readDescriptionInventory(sdk, appId, solutionUniqueName) {
  const inventory = { views: [], charts: [], forms: [], businessRules: [], globalChoices: [], roleRestrictedForms: [] };
  try {
    const appRows = await sdk.queryRecords('appmodule', { select: ['appmoduleidunique'], filter: `appmoduleid eq ${appId}`, top: 1 });
    const appUniqueId = appRows && appRows[0] && appRows[0].appmoduleidunique;
    const parent = appUniqueId ? String(appUniqueId).replace(/[{}]/g, '') : null;
    if (parent) {
      for (const src of APP_COMPONENT_ENTITY_SOURCES) {
        const rows = await sdk.queryRecords('appmodulecomponent', {
          select: ['objectid', 'componenttype'],
          filter: `_appmoduleidunique_value eq ${parent} and componenttype eq ${src.componentType}`,
          top: COMPONENT_PAGE_CAP,
        });
        const ids = (rows || []).map((r) => r && r.objectid).filter(Boolean);
        if (src.set === 'savedquery') {
          inventory.views.push(...await rowsByIds(sdk, 'savedquery', 'savedqueryid', ids, ['savedqueryid', 'name', 'returnedtypecode', 'description'], (r) =>
            withDescription({ id: r.savedqueryid, name: r.name, entity: r.returnedtypecode }, r.description)));
        } else if (src.set === 'savedqueryvisualization') {
          inventory.charts.push(...await rowsByIds(sdk, 'savedqueryvisualization', 'savedqueryvisualizationid', ids, ['savedqueryvisualizationid', 'name', 'primaryentitytypecode', 'description'], (r) =>
            withDescription({ id: r.savedqueryvisualizationid, name: r.name, entity: r.primaryentitytypecode }, r.description)));
        } else if (src.set === 'systemform') {
          // `formxml` is pulled ONLY to detect a role restriction — it is never stored. A form's
          // security roles live inside formxml as `<DisplayConditions>` (there is no
          // systemform↔role relationship), and `forms[]` is not reconstructed by this download at
          // all, so a restricted form would come back as one every role can see. That is a silent
          // WIDENING of access on a cross-environment rebuild, which is why it is worth one extra
          // column on a query this download already makes.
          //
          // The flag is kept OFF the form entries and on a sibling key, because
          // `sanitizeDescriptionInventory` whitelists exactly five keys — so this reaches the
          // download CLI for its warning without leaking a new field into `app-spec.json`.
          const rawForms = await rowsByIds(sdk, 'systemform', 'formid', ids, ['formid', 'name', 'objecttypecode', 'description', 'formxml'], (r) => r);
          for (const r of rawForms) {
            if (!r || !r.objecttypecode || r.objecttypecode === 'none') continue;
            inventory.forms.push(withDescription({ id: r.formid, name: r.name, entity: r.objecttypecode }, r.description));
            if (isRoleRestrictedFormXml(r.formxml)) {
              inventory.roleRestrictedForms.push({ name: r.name, entity: r.objecttypecode });
            }
          }
        }
      }
    }
  } catch { /* inventory is best-effort; structural download still carries the rebuildable app spec */ }

  try {
    if (solutionUniqueName && !isRestrictedSolution(solutionUniqueName)) {
      const esc = String(solutionUniqueName).replace(/'/g, "''");
      const sols = await sdk.queryRecords('solution', { select: ['solutionid'], filter: `uniquename eq '${esc}'`, top: 1 });
      const solId = sols && sols[0] && sols[0].solutionid;
      if (solId) {
        // Solution component type 29 is Workflow — which is EVERY process kind, not just business
        // rules: classic workflows, actions, business process flows and modern flows all land here.
        // See component type values: https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/solutioncomponent
        //
        // So the rows must be narrowed after the fetch. A business rule is `category 2`, and `type 1`
        // is the DEFINITION — activating one makes Dataverse create a second `type 2` copy of it, so
        // without the type filter every active rule would appear twice in the inventory.
        //
        // Filtered client-side rather than in the query because `rowsByIds` batches on the id column;
        // both fields are requested in the select so the decision is made on real values, and a row
        // that reports NEITHER field is dropped rather than assumed to be a rule — fail closed, since
        // mislabelling somebody's classic workflow as a business rule is the failure mode here.
        const comps = await sdk.queryRecords('solutioncomponent', { select: ['objectid', 'componenttype'], filter: `_solutionid_value eq ${solId} and componenttype eq 29`, top: 1000 });
        const ids = (comps || []).map((r) => r && r.objectid).filter(Boolean);
        const processes = await rowsByIds(sdk, 'workflow', 'workflowid', ids, ['workflowid', 'name', 'primaryentity', 'description', 'category', 'type'], (r) => r);
        for (const r of processes) {
          if (Number(r && r.category) !== 2 || Number(r && r.type) !== 1) continue;
          inventory.businessRules.push(withDescription({ id: r.workflowid, name: r.name, entity: r.primaryentity }, r.description));
        }
      }
    }
  } catch { /* business-rule descriptions are an inspection aid, not a rebuild prerequisite */ }

  try {
    // Global option sets are not app components, but their Description is another Dataverse Label. This
    // is intentionally an inventory, not `globalChoices[]`: without options we cannot safely claim a
    // rebuildable choice definition.
    //
    // Read through the RAW client, NOT `sdk.queryRecords`. `queryRecords` resolves its first argument
    // to an entity SET name via `EntityDefinitions(LogicalName='<arg>')?$select=EntitySetName`, and
    // `GlobalOptionSetDefinitions` is a metadata collection rather than a table, so that lookup 404s
    // and the catch below would swallow it — leaving this inventory permanently empty while the
    // download still reported success. Same trap, and same fix, as readEntityWithDescriptions.
    //
    // `dataverse.get` RESOLVES on a non-2xx instead of throwing, so the status is checked explicitly.
    const res = await sdk.dataverse.get('/GlobalOptionSetDefinitions?$select=Name,Description');
    const rows = (res && res.status >= 200 && res.status < 300 && res.body && res.body.value) || [];
    inventory.globalChoices.push(...rows.map((r) => withDescription({ name: r.Name }, r.Description)));
  } catch { /* optional inventory */ }

  return Object.fromEntries(Object.entries(inventory).filter(([, value]) => value.length));
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
//
// The primary-name attribute MUST come from real Dataverse metadata. It used to fall back to a
// `<first-segment-of-logical>_name` guess, which is wrong for most out-of-the-box tables — `account`
// became `account_name` (really `name`) and `contact` became `contact_name` (really `fullname`). The
// guess was invisible on custom tables (`co_ticket` → `co_name`, which happens to be right), so the
// bug only surfaced on an app built from standard tables (ADO 6603392). The SDK's
// fetchEntityMetadata now $selects and returns PrimaryNameAttribute/SchemaName, so consume those.
//
// `primaryAttribute` is REQUIRED by App Spec validation, so this cannot simply omit it when metadata
// is missing — that would emit a spec the user cannot rebuild from at all. Instead the caller treats a
// missing primary name as a hard download failure, which is actionable at the point it happens rather
// than as a confusing validation error later. Returns `null` for `primaryAttribute` so the caller can
// detect and report it.
// Dataverse `AttributeType` -> App Spec column type. Only types the App Spec can actually declare
// are mapped; anything else (Lookup, Owner, State, Status, Uniqueidentifier, Virtual, ...) is a
// column the author never wrote — a Lookup comes from `relationships[]`, and the rest are platform
// plumbing — so it is left out of the hydrated spec entirely.
// See: https://learn.microsoft.com/en-us/dotnet/api/microsoft.xrm.sdk.metadata.attributetypecode
const SPEC_TYPE_FROM_ATTRIBUTE_TYPE = {
  String: 'Text', Memo: 'Memo', Picklist: 'Choice', MultiSelectPicklist: 'MultiChoice',
  Boolean: 'Boolean', Money: 'Money', DateTime: 'DateTime', Integer: 'Integer',
  BigInt: 'BigInt', Decimal: 'Decimal', Double: 'Double', File: 'File', Image: 'Image',
};

// Types whose App Spec declaration REQUIRES a companion field this hydrator cannot supply: a
// `Choice`/`MultiChoice` column must carry `options[]` or a `globalChoice` reference, and reading
// those needs a per-column typed-metadata expand the download does not perform. (Verified to be the
// ONLY such dependency: every other companion rule in `validateAppSpec` / `spec-lint` — AutoNumber's
// format, Calculated/Rollup's formula, Customer's description — is a warning, not an error.)
//
// So the column is emitted WITHOUT a type rather than with one that makes the whole spec fail
// validation ("column X: Choice needs options[] or a globalChoice reference") — which is what
// happened the moment types started being carried, live.
//
// This is NOT free, and the cost is surfaced rather than described as harmless. On a rebuild into an
// org that does NOT already have the table, `provisionDataModel` decides create-vs-reuse from org
// DISCOVERY (not from `existing`) and computes buildable columns as `SDK_COLUMN_TYPE[c.type ||
// 'Text']` — so a type-less Choice column is created as TEXT. The now-asymmetric result (Memo, Money
// and DateTime round-trip while Choice quietly degrades) is harder to notice than the old
// everything-is-Text, so the affected columns are warned about by name.
const TYPES_NEEDING_COMPANION_DATA = new Set(['Choice', 'MultiChoice']);

// Does this form's `formxml` restrict it to particular security roles?
//
// The roles live INSIDE formxml, as a `<DisplayConditions>` child of `<form>` — `systemform` has no
// role relationship at all — e.g.:
//
//   <DisplayConditions Order="2" FallbackForm="false"><Role Id="{GUID}" /></DisplayConditions>
//
// The unrestricted default is the sibling shape `<DisplayConditions ...><Everyone /></...>`, or no
// element at all. Only the `<Role>` form is a restriction, so match on that specifically rather than
// on the presence of `<DisplayConditions>`, which every form has.
//
// Attribute order and casing vary between platform-authored and SDK-authored xml, so this matches
// the element name case-insensitively and does not assume `Id` is the first attribute.
function isRoleRestrictedFormXml(formxml) {
  const xml = String(formxml || '');
  const block = xml.match(/<DisplayConditions[\s\S]*?<\/DisplayConditions>/i);
  if (!block) return false;
  return /<Role\b/i.test(block[0]);
}

// Columns whose type could not be substantiated, so a `download -> rebuild into a fresh org` round
// trip does not silently create them as Text. `type` is absent for a Choice/MultiChoice (above), or
// for an attribute whose metadata carried no `attributeType` at all — an attribute with a type that
// simply has no App Spec equivalent is filtered out of `columns[]` entirely, so it never gets here.
function untypedColumnNames(entities) {
  const out = [];
  for (const e of entities || []) {
    for (const c of (e.columns || [])) {
      if (c && c.schemaName && c.type === undefined) out.push(`${e.schemaName}.${c.schemaName}`);
    }
  }
  return out;
}

function entityFromMetadata(meta, logical) {
  const primary = meta && (meta.primaryNameAttribute || meta.primaryNameLogicalName);
  const attrs = Array.isArray(meta && meta.attributes) ? meta.attributes : (Array.isArray(meta && meta.Attributes) ? meta.Attributes : []);
  const primaryLower = String(primary || '').toLowerCase();
  const columns = attrs.filter((a) => {
    if (!a) return false;
    const name = String(a.schemaName || a.SchemaName || a.logicalName || a.LogicalName || '').toLowerCase();
    // The primary name column is declared separately as `primaryAttribute`, so it must not ALSO
    // appear in `columns[]`.
    if (!name || name === primaryLower) return false;
    // CUSTOM attributes only. `fetchEntityMetadata` returns the FULL attribute list — `createdon`,
    // `versionnumber`, `importsequencenumber`, `owningbusinessunit` and the rest — and emitting
    // those as spec columns is not merely noisy, it is destructive: `columns[]` feeds
    // `defaultViewColumns`, which `enrichDefaultViews` uses to REPLACE the Active/Inactive views'
    // column set. A downloaded spec that listed system attributes would rewrite a customer's
    // default views to `Created On` / `Import Sequence Number` on the next rebuild, undoing fix #7
    // ("drop Created On from enriched default views") whose invariant is stated at
    // sdk-build.js `defaultViewColumns`: the set only ever contains DECLARED spec columns.
    const isCustom = a.isCustomAttribute !== undefined ? a.isCustomAttribute : a.IsCustomAttribute;
    if (isCustom === false) return false;
    // Keep only attribute types the App Spec can declare (see the map above).
    const at = a.attributeType || a.AttributeType;
    return at === undefined || SPEC_TYPE_FROM_ATTRIBUTE_TYPE[at] !== undefined;
  }).map((a) => {
    const schemaName = (a && (a.schemaName || a.SchemaName || a.logicalName || a.LogicalName)) || '';
    // The SDK projects `attributeType`, NOT `type`. Reading `a.type` yielded `undefined` on every
    // column, which silently disabled every type-based filter downstream (`DEFAULT_VIEW_SKIP_TYPES`
    // skips Memo/File/Image; `SDK_COLUMN_TYPE` decides what an auto form layout places).
    const at = a && (a.attributeType || a.AttributeType);
    const mapped = a && a.type ? a.type : SPEC_TYPE_FROM_ATTRIBUTE_TYPE[at];
    const specType = TYPES_NEEDING_COMPANION_DATA.has(mapped) ? undefined : mapped;
    return withDescription({
      schemaName,
      ...(a && (a.displayName || a.DisplayName) ? { displayName: descriptionFromDataverse(a.displayName || a.DisplayName) || a.displayName || a.DisplayName } : {}),
      ...(specType ? { type: specType } : {}),
    }, a && (a.description !== undefined ? a.description : a.Description));
  }).filter((c) => c.schemaName);
  return {
    schemaName: (meta && (meta.schemaName || meta.logicalName)) || logical,
    displayName: (meta && meta.displayName) || logical,
    ...(descriptionFromDataverse(meta && (meta.description !== undefined ? meta.description : meta.Description)) ? { description: descriptionFromDataverse(meta && (meta.description !== undefined ? meta.description : meta.Description)) } : {}),
    // Never synthesized: a fabricated attribute name yields a spec that references a column Dataverse
    // does not have, which is exactly the bug this fixes.
    primaryAttribute: primary ? { schemaName: primary, displayName: 'Name' } : null,
    columns,
    // Flag every recovered table as pre-existing so a teardown of THIS downloaded spec never deletes the
    // table (+ its data). Download cannot prove which tables the app CREATED vs merely REFERENCED, and
    // deleting a customer's table/data is unrecoverable while an orphaned table is not — so fail safe.
    // (The build re-applies a downloaded spec by discovery regardless of this flag; and hydrate emits no
    // forms, so the build's `existing`-gated default-form promotion path is not reached here anyway.)
    existing: true,
  };
}

function metadataEntityPath(logical) {
  return `EntityDefinitions(LogicalName='${String(logical).replace(/'/g, "''")}')`;
}

async function readEntityWithDescriptions(sdk, logical) {
  const meta = { ...(await sdk.fetchEntityMetadata(logical)) };
  // The SDK's fetchEntityMetadata projection is enough for identity but carries NO descriptions —
  // measured against a live org, its entity keys are logicalName/schemaName/displayName/
  // entitySetName/primaryNameAttribute/primaryIdAttribute/isCustomEntity/attributes/relationships,
  // and each attribute is {logicalName, displayName, attributeType, isCustomAttribute, targets}.
  // So descriptions require a second read against the metadata endpoints.
  //
  // This deliberately does NOT go through `sdk.queryRecords`. That helper first resolves its
  // argument to an entity SET name via `EntityDefinitions(LogicalName='<arg>')?$select=EntitySetName`,
  // so handing it a metadata path produces a nested nonsense URL and a 404:
  //   .../EntityDefinitions(LogicalName='EntityDefinitions(LogicalName=''contoso_workitem'')')?$select=EntitySetName
  // Combined with the best-effort catch below, that failed silently for EVERY table — the download
  // reported success and dropped every table and column description. `sdk.dataverse` is the raw
  // client and takes an API-relative path verbatim.
  //
  // NOTE `dataverse.get` RESOLVES with `{ status, headers, body }` on a non-2xx rather than throwing
  // (a 404 returns status 404), so the status MUST be checked explicitly. A try/catch alone would
  // reintroduce exactly the silence this replaces.
  const entityPath = `/${metadataEntityPath(logical)}`;
  try {
    const res = await sdk.dataverse.get(`${entityPath}?$select=LogicalName,Description`);
    if (res && res.status >= 200 && res.status < 300 && res.body) meta.Description = res.body.Description;
  } catch { /* description best-effort — never sink an otherwise usable download */ }
  try {
    // Merge onto the SDK's attribute list rather than replacing it: `fetchEntityMetadata` supplies
    // `targets` (lookup target tables) and `attributeType`, which this projection does not, and
    // entityFromMetadata/other callers rely on them.
    const res = await sdk.dataverse.get(`${entityPath}/Attributes?$select=LogicalName,Description`);
    const rows = (res && res.status >= 200 && res.status < 300 && res.body && res.body.value) || null;
    if (Array.isArray(rows)) {
      const byLogical = new Map(rows.filter((r) => r && r.LogicalName).map((r) => [String(r.LogicalName).toLowerCase(), r.Description]));
      meta.attributes = (meta.attributes || []).map((a) => {
        const key = String((a && (a.logicalName || a.LogicalName)) || '').toLowerCase();
        return byLogical.has(key) ? { ...a, Description: byLogical.get(key) } : a;
      });
    }
  } catch { /* column descriptions are best-effort */ }
  return meta;
}

// Image webresourcetypes (png/jpg/gif/ico/svg) — an icon reference must resolve to one of these to be
// re-declared. See WR_TYPE. Guards against re-declaring a non-image WR that a path happens to name.
const IMAGE_WR_TYPES = new Set([5, 6, 7, 10, 11]);

// Fetch the icon web resources referenced by the sitemap, looked up by NAME (the sitemap stores the
// web-resource name, not its id — sdk.getWebResource keys by id and 400s on a name). Returns
// `{ webResources, unresolved }`:
//   webResources — app-spec webResources[] entries (content as base64).
//     `icons`      (BARE names the author declared) → re-declared (any found WR). Deletable on teardown
//                  UNLESS the same name is ALSO a `customRefs` path reference, in which case it inherits
//                  `external:true` (a shared nav icon referenced both ways must keep teardown protection).
//     `customRefs` (names extracted from a PLATFORM path/`$webresource:` ref on an icon OR vectorIcon)
//                  → re-declared ONLY when the WR is (a) OWNED by this app (name starts with
//                  `ownPrefix + '_'`), (b) CUSTOM (unmanaged), and (c) an IMAGE type — so a modern custom
//                  nav icon survives a cross-env rebuild. Such an entry is flagged `external:true` so the
//                  build creates-if-missing / reuses-if-present, but TEARDOWN does NOT delete it: prefix +
//                  unmanaged does NOT prove the WR is exclusively this app's (a publisher's WRs are shared
//                  across all its solutions), and deleting a WR another app shares would break it (fail-safe
//                  — an orphan is recoverable, a deleted shared resource is not; mirrors the `existing:true`
//                  protection on downloaded tables). A FOREIGN-prefix / managed / OOB / non-existent ref is
//                  SKIPPED → left as a bare reference (re-creating a foreign prefix on a fresh env would
//                  hard-fail the build). Path refs are processed BEFORE bare names so this stricter
//                  classification wins on an overlap.
//   unresolved   — customRefs we could NOT safely round-trip (a custom nav icon that will dangle on a
//                  cross-env rebuild), so the caller surfaces a warning (the build-time portability warning
//                  is the backstop). Deduped by name.
//
// `prefixResolved` — whether `ownPrefix` is the app's REAL publisher customizationprefix (recovered from
//   Dataverse) or the unverified `'new'` fallback (recoverAppSolution's publisher read failed / found no
//   solution). This gates own-vs-foreign classification and MUST NOT be conflated with an app whose prefix
//   genuinely IS 'new': when the prefix is UNVERIFIED we cannot trust `startsWith(ownPrefix)`, so a genuine
//   own custom icon (e.g. `crba3_nav.svg` while the fallback prefix is `new`) would fail the own-prefix test
//   and — without this guard — be silently skipped with NO warning, re-introducing the exact broken-icon bug
//   this fix exists to prevent (Opus review, Medium). So when `prefixResolved` is false we do NOT re-declare
//   any path-derived WR (an unknown non-'new' prefix would BuildHalt on a fresh env) but we PROBE every
//   customRef and surface each genuine CUSTOM (unmanaged image) one as `unresolved` — a managed/OOB/absent
//   ref is a system icon present in every env, so it stays silent (no false alarm).
async function iconWebResources(sdk, icons, customRefs, ownPrefix, prefixResolved, navRefs) {
  const out = [];
  const seen = new Set();                 // lowercased names actually re-declared into `out`
  const prefixLc = ownPrefix ? String(ownPrefix).toLowerCase() + '_' : null;
  const customRefSet = new Set((customRefs || []).map((n) => String(n).toLowerCase()));
  // `navRefs` are web resources a URL SUBAREA targets (the Site Map Designer's "custom page backed by
  // an HTML web resource"), as opposed to an icon. They take the SAME safety gates as a path-derived
  // icon — own prefix, unmanaged, has content, `external: true` so teardown never deletes it — but
  // NOT the image-type gate: such a page is `html` (type 1), which `IMAGE_WR_TYPES` excludes by
  // design. Without this distinction the page is never re-declared and a rebuild's nav entry points
  // at a resource the spec cannot recreate.
  const navRefSet = new Set((navRefs || []).map((n) => String(n).toLowerCase()));
  const allowedTypeFor = (key) => (navRefSet.has(key) ? null : IMAGE_WR_TYPES); // null = any type
  const candidateUnresolved = new Map();  // key -> original name; a path ref we could NOT re-declare in PASS 1
  const queryWr = async (name) =>
    (await sdk.queryRecords('webresource', { select: ['name', 'webresourcetype', 'content', 'ismanaged'], filter: `name eq '${String(name).replace(/'/g, "''")}'`, top: 1 }))?.[0];
  const isCustomImage = (wr) => !!(wr && wr.content && wr.ismanaged === false && IMAGE_WR_TYPES.has(wr.webresourcetype));

  // PASS 1 — path-derived custom icons (safety-gated). Done FIRST so a name referenced BOTH by a platform
  // path AND by a bare name is classified by the STRICTER path rules (and flagged `external`) before the
  // lenient bare pass can re-declare it as deletable — otherwise the overlap silently loses teardown
  // protection and a shared nav icon gets deleted (Sol review, High).
  for (const name of [...(customRefs || []), ...(navRefs || [])]) {
    const key = String(name).toLowerCase();
    if (seen.has(key)) continue;
    const ownScoped = !!prefixLc && key.startsWith(prefixLc);
    // TRUSTED prefix: only an OWN-prefix ref is a candidate; a foreign/OOB ref is left as a bare reference
    // (never queried). UNTRUSTED prefix: fall through and probe EVERY ref to classify it (see below).
    if (prefixResolved && !ownScoped) continue;
    try {
      const wr = await queryWr(name);
      if (!prefixResolved) {
        // Unverified prefix — classify only, NEVER re-declare (an unknown non-'new' prefix would BuildHalt).
        // Flag a genuine custom icon as a candidate so a transient recovery failure degrades to a warning,
        // not a silent drop; a managed/OOB/absent ref exists in every env, so stay silent (no false alarm).
        if (isCustomImage(wr)) candidateUnresolved.set(key, name);
        continue;
      }
      if (!wr || !wr.content) { candidateUnresolved.set(key, name); continue; }         // own-prefix but absent on source → will dangle
      const allowed = allowedTypeFor(key);
      if (wr.ismanaged === true || (allowed && !allowed.has(wr.webresourcetype))) continue;   // managed / wrong type → leave as a bare reference
      seen.add(key);
      out.push({ name, type: WR_TYPE[wr.webresourcetype] || 'png', contentBase64: wr.content, external: true });
    } catch { candidateUnresolved.set(key, name); /* read failure → candidate (surface unless a bare pass resolves it) */ }
  }

  // PASS 2 — author-declared BARE names. A bare name MUST be re-declared (validation requires a bare icon
  // to be a declared image WR). Flag it `external` iff it is ALSO path-referenced (the shared-resource
  // signal), so the overlap keeps teardown protection. A read failure on a bare-only icon is a silent skip
  // (a hand-authored bare icon name that can't be read isn't a cross-env regression signal).
  for (const name of icons || []) {
    const key = String(name).toLowerCase();
    if (seen.has(key)) continue;
    try {
      const wr = await queryWr(name);
      if (!wr || !wr.content) continue;
      seen.add(key);
      const entry = { name, type: WR_TYPE[wr.webresourcetype] || 'png', contentBase64: wr.content };
      if (customRefSet.has(key)) entry.external = true; // also path-referenced → protect from teardown
      out.push(entry);
    } catch { /* a bare author icon that fails to read is skipped (unchanged) */ }
  }

  // A path ref is unresolved ONLY if it was never re-declared (a bare pass may have re-declared an
  // overlapping name — that resolves it, so it must not also warn). Dedup preserved by the Map key.
  const unresolved = [...candidateUnresolved].filter(([key]) => !seen.has(key)).map(([, name]) => name);
  return { webResources: out, unresolved };
}

// Count sitemap subareas hydrateSpec could not round-trip (present in the deployed sitemap but not in
// the reconstructed spec — e.g. classic DashBoard subareas). A rebuild from the spec drops these.
function droppedSubareaCount(app, spec) {
  const countSub = (areas) => (areas || []).reduce((n, a) => n + (a.groups || []).reduce((m, g) => m + (g.subAreas || []).length, 0), 0);
  return countSub(app && app.siteMap && app.siteMap.areas) - countSub(spec && spec.appShell && spec.appShell.areas);
}

// Recover the REAL unmanaged solution an app module belongs to. An app is a `solutioncomponent` of
// EVERY solution it lives in — always the built-in system solutions (Active/Default/Basic) AND the
// real unmanaged solution it was created in. The naive `top:1` query returns an arbitrary row (often
// 'Default', which is itself ismanaged=false, so an ismanaged filter does not exclude it), so the
// real solution was never recovered and a downloaded spec defaulted its solution to the restricted
// 'Default' — which teardown then 400s on, orphaning the real solution. So enumerate ALL memberships
// and pick the single unmanaged, non-system solution. Best-effort: returns null (caller keeps its own
// default) on no match or any query error — never throws.
//
// Returns `{ uniqueName, publisherPrefix? }`. The publisher prefix is read from the recovered
// solution's OWNING PUBLISHER via the SDK's `getSolution`, because it is the only authoritative
// source: the prefix was previously guessed from the app's uniquename, which breaks whenever the app
// name doesn't encode the solution's publisher — an app named `new_customermanagement` inside
// publisher `contoso`, an app with no prefix at all, or a publisher prefix longer than the guess's
// length bound all collapsed to the literal `'new'` (ADO 6603390). `getSolution` is best-effort on top
// of best-effort: if it fails or the publisher defines no prefix, we return the uniqueName alone and
// the caller falls back to the app-derived guess.
async function recoverAppSolution(sdk, appId) {
  try {
    // objectid == the appmoduleid. `top:500` is a safe over-provision (an app is realistically a
    // component of only a handful of solutions) that keeps us on the same proven query path as every
    // other queryRecords call in the skill (all pass an explicit top) — it just must not be the old
    // `top:1`, which returned an arbitrary single membership (often 'Default').
    const comps = await sdk.queryRecords('solutioncomponent', { select: ['_solutionid_value'], filter: `objectid eq ${appId}`, top: 500 });
    const solIds = [...new Set((comps || []).map((c) => c && c._solutionid_value).filter(Boolean))];
    if (!solIds.length) return null;
    // One OR-batched lookup for all candidate solutions (solutionid is a Guid, so it is unquoted in
    // the OData filter — mirrors the existing `solutionid eq ${id}` usage elsewhere in this file).
    const filter = solIds.map((id) => `solutionid eq ${id}`).join(' or ');
    const sols = await sdk.queryRecords('solution', { select: ['solutionid', 'uniquename', 'ismanaged', 'description'], filter, top: 500 });
    const real = (sols || []).find((s) => s && s.ismanaged === false && !isRestrictedSolution(s.uniquename));
    if (!real) return null;
    const out = withDescription({ uniqueName: real.uniquename }, real.description);
    // Authoritative publisher prefix for anything authored into THIS solution. Guarded on the method
    // existing so an older vendored bundle (pre-getSolution) degrades to the caller's fallback instead
    // of throwing away the solution we just recovered.
    if (typeof sdk.getSolution === 'function') {
      try {
        const info = await sdk.getSolution(real.uniquename);
        // An empty-string prefix is legitimate for some first-party publishers, but it is not usable as
        // a customization prefix, so treat it as "not recovered" and let the caller fall back.
        if (info && info.publisherPrefix) out.publisherPrefix = String(info.publisherPrefix).toLowerCase();
      } catch { /* best-effort — keep the recovered uniqueName */ }
    }
    return out;
  } catch {
    return null; // best-effort — a recovery failure must not break the download
  }
}

// Injectable download helper: all live-Dataverse work happens here so tests can inject mock deps.
// `sdk`        — the MakerSDK (fetchArtifact, queryRecords, fetchEntityMetadata)
// `genpageCli` — the genpage CLI wrapper (enumerateEnv, download)
// `outDir`     — output directory root
// `appId`      — the app's GUID (used for download + solution lookup)
// `appUnique`  — the app's unique name (for fetchSitemap + manifest lookup); may be undefined for
//                apps not found by unique name, in which case the sitemap read fails gracefully.
// Returns { ok:true, spec, pages, entities, webResources, droppedSubareas, droppedSubareaDetails,
// dashboardReconstructionError } or { ok:false, error }.
// Logical failures (no sitemap, enumeration down, missing download) return { ok:false } without
// throwing. Unexpected I/O errors propagate as thrown exceptions (caught by main().catch).
async function runDownload({ sdk, genpageCli, outDir, appId, appUnique, allowLossy = false }) {
  // `fetchArtifact('app')` FAILS CLOSED when the app's sitemap cannot be resolved, read, or proven to
  // still belong to this app (SDK code `APP_SITEMAP_UNRESOLVED`) — rather than returning an app whose
  // navigation is untrustworthy. That is a LOGICAL failure of exactly the class this function's
  // contract says it returns rather than throws (the sitemap IS the download's membership oracle), so
  // translate it instead of letting a raw SDK error escape. A newly created app is the common cause:
  // an unpublished appmodule is not readable, so the caller's fix is to publish it and retry.
  let app;
  try {
    app = await sdk.fetchArtifact('app', appId);
  } catch (e) {
    const code = e && e.code;
    if (code === 'APP_SITEMAP_UNRESOLVED' || code === 'APP_UPDATE_NO_ETAG') {
      return { ok: false, error: `cannot read app ${appId}: ${(e && e.message) || code}` };
    }
    throw e;
  }
  const { entities: entityLogicals, icons, customRefs, navRefs } = collectSitemap(app);

  // MEMBERSHIP: the authoritative set of pages owned by this app, from its SITEMAP XML (fail-closed,
  // discriminated). The app-scoped `pac genpage list --app-id` is sitemap-scoped anyway but returns
  // SITEMAP TITLES (not page names), misses headless nav-target pages, and cannot be trusted as the
  // "real names" source. The raw sitemap XML is the single authoritative membership record.
  const smResult = appUnique
    ? await fetchSitemap(sdk, appUnique)
    : { ok: false, reason: 'app-unique-unresolved' };
  if (!smResult.ok) {
    return { ok: false, error: `could not read the app sitemap during download (${smResult.reason}) — refusing to write a spec without the authoritative page set` };
  }
  // [{ pageId, title? }] — deduped by id; membership-only (title is the XML-decoded subarea label,
  // NOT the page's real name — the real name comes from the env-wide list below).
  const smPages = sitemapGenPages(smResult.xml);
  let pages = [];
  let manifest = null;

  if (smPages.length) {
    // Durable manifest (stable key→id bindings + v2 semantics). Best-effort: a missing or corrupt
    // manifest falls back to fresh key minting (no v2 semantics for a first-ever download).
    if (appUnique) {
      const rows = await sdk.queryRecords('webresource', { select: ['content'], filter: `name eq '${manifestResourceName(appUnique).replace(/'/g, "''")}'`, top: 1 });
      if (rows && rows[0] && rows[0].content) manifest = parseManifestBase64(rows[0].content);
    }

    // Real names from the ENV-WIDE list (addenda new-1: env names ≠ sitemap titles). The env-wide
    // `pac genpage list` returns each page's actual configured name; the sitemap title is what the
    // Maker chose for the subarea label, which can differ. Using the sitemap title as the page name
    // was the root of the name-vs-title mismatch (live-confirmed; see Plan-5 §Background).
    const envResult = await genpageCli.enumerateEnv();
    if (!envResult.ok) {
      return { ok: false, error: `page enumeration failed during download: ${envResult.error}` };
    }
    const envNameById = new Map(
      (envResult.pages || []).filter((p) => p.pageId && p.name)
        .map((p) => [String(p.pageId).toLowerCase(), p.name])
    );

    // Download EXACTLY the sitemap's pages (by id — headless-free, no env-wide over-pull). The
    // sitemap is the MEMBERSHIP authority: we pull precisely this app's pages, no more, no less.
    const pagesRoot = path.join(outDir, 'pages');
    fs.rmSync(pagesRoot, { recursive: true, force: true });
    fs.mkdirSync(pagesRoot, { recursive: true });
    const sitemapIds = smPages.map((p) => p.pageId);
    try {
      await genpageCli.download({ appId, outputDir: pagesRoot, pageIds: sitemapIds });
    } catch (e) {
      return { ok: false, error: `pac genpage download failed: ${e.message}` };
    }

    // Name resolver: env-wide name (real, stable) primary; sitemap title (XML-entity-decoded) as
    // fallback when the env-wide list doesn't cover an id (shouldn't happen in practice — env-wide
    // lists all pages — but guards against an eventual stale or truncated listing).
    const nameById = new Map(smPages.map((p) => {
      const id = String(p.pageId).toLowerCase();
      return [id, envNameById.get(id) || p.title || p.pageId];
    }));
    pages = parseDownloadedPages(pagesRoot, outDir, nameById);

    // Bidirectional exact equality: sitemap ids ↔ downloaded ids (I3). A gap either way means pac
    // fetched a different set than the sitemap declares — rebuilding from this spec would silently
    // drop or add pages, so download FAILS instead.
    const missing = missingDownloads(smPages, pages);
    if (missing.length) {
      return { ok: false, error: `sitemap page(s) not downloaded: ${missing.map((p) => p.title || p.pageId).join(', ')} — refusing to write a spec that would drop them` };
    }
    const extra = missingDownloads(pages, smPages);
    if (extra.length) {
      return { ok: false, error: `downloaded page(s) not in the sitemap: ${extra.map((p) => p.pageId).join(', ')} — inconsistent page set` };
    }

    // Reconcile by MEMBERSHIP. For download, existence AND membership are both the sitemap ids
    // (the pages we just pulled — if they were downloaded they exist; if not we already aborted
    // above). This differs from the build path, which uses the env-wide EXISTENCE set (because a
    // build must find crash-orphaned pages that are not yet in the sitemap).
    const { keyToId, conflicts } = reconcilePageIds(
      (manifest && manifest.pages) || [],
      manifest,
      sitemapIds, // existenceIds: confirmed present (we just downloaded them)
      sitemapIds  // sitemapIds: membership = same set as existence for the download path
    );
    if (conflicts.length) {
      return { ok: false, error: `page identity conflict during download: ${conflicts.map((c) => c.pageId || c.key).join(', ')} — cannot safely reconstruct` };
    }

    // Assign stable keys + carry v2 semantics (navigatesTo/purpose/pageInput) from the manifest.
    // Pages bound to manifest keys reuse their key and semantics; Maker-added pages (not in the
    // manifest) get a fresh slug key minted from their env-wide name.
    const idToKey = assignPageKeys(pages, manifest, keyToId);

    // Reverse-resolve nav pageId literals → symbolic PAGEREF_<key> tokens (structural, oracle-safe).
    for (const p of pages) {
      const abs = path.join(outDir, p.codeFile);
      const src = fs.readFileSync(abs, 'utf8');           // FAIL on a read error (no swallow)
      const rev = reverseResolveNavIds(src, idToKey);     // structural — nav pageId literals only
      if (rev !== src) fs.writeFileSync(abs, rev, 'utf8'); // FAIL on a write error (no swallow)
    }

    // Warn about manifest pages no longer in the sitemap (Maker-deleted in the live app). The
    // rebuilt spec drops these pages; the warning mirrors the droppedSubareaCount WARNING below.
    const liveSet = new Set(sitemapIds.map((id) => String(id).toLowerCase()));
    const goneManifestPages = ((manifest && manifest.pages) || []).filter(
      (mp) => mp.pageId && !liveSet.has(String(mp.pageId).toLowerCase())
    );
    if (goneManifestPages.length) {
      process.stderr.write(`WARNING: ${goneManifestPages.length} manifest page(s) are no longer in the app sitemap (deleted in Maker): ${goneManifestPages.map((p) => p.name || p.pageId).join(', ')} — the rebuilt spec drops them.\n`);
    }
  }

  // Entities: the sitemap's navigable tables UNIONED with the app's real entity components. The
  // sitemap alone misses tables reachable only via lookup/sub-grid/related view (ADO 6603388); the
  // component read is best-effort, so a failure degrades to exactly today's sitemap-derived set.
  const componentLogicals = await appComponentEntities(sdk, appId);
  const sitemapSet = new Set(entityLogicals);
  const allLogicals = [...new Set([...entityLogicals, ...componentLogicals])];
  const entities = [];
  const noPrimaryName = [];   // sitemap tables — a hard failure (the user asked for these)
  const droppedComponents = []; // component-only tables — dropped with a warning (best-effort input)
  const metadataErrors = new Map(); // logical -> error message (the read itself failed)
  for (const logical of allLogicals) {
    let e;
    // A metadata READ failure is not the same as metadata that reports no primary name, and it must
    // not be swallowed: a 429/503 on a sitemap table used to drop it silently, leaving its subarea
    // behind so validation later complained about a "sitemap subArea references unknown entity" —
    // the confusing downstream error the explicit branch below exists to avoid. Bucket it by origin
    // exactly like the no-primary-name case, so the user is told the table AND the reason.
    try {
      e = entityFromMetadata(await readEntityWithDescriptions(sdk, logical), logical);
    } catch (err) {
      metadataErrors.set(logical, (err && err.message) || String(err));
      (sitemapSet.has(logical) ? noPrimaryName : droppedComponents).push(logical);
      continue;
    }
    // `primaryAttribute` is REQUIRED by App Spec validation, so an entity without one cannot be
    // emitted — the spec would fail to validate and the user could not rebuild at all. Guessing the
    // name is what caused ADO 6603392, so the only honest options are fail or drop.
    //
    // Which one depends on WHERE the table came from. A sitemap table is one the user explicitly
    // navigated to: failing loudly names it and is actionable. A component-only table is a hidden
    // dependency this download newly discovered on a best-effort basis — aborting the whole download
    // over one (which previously downloaded fine, because it was never included) would be a
    // regression with no override flag, so drop it and say so. NOTE the SDK returns '' (not
    // undefined) for a missing PrimaryNameAttribute, which `entityFromMetadata` maps to null.
    if (!e.primaryAttribute) {
      (sitemapSet.has(logical) ? noPrimaryName : droppedComponents).push(logical);
      continue;
    }
    entities.push(e);
  }
  const withReason = (list) => list.map((l) => (metadataErrors.has(l) ? `${l} (metadata read failed: ${metadataErrors.get(l)})` : l)).join(', ');
  if (noPrimaryName.length) {
    // Overridable, like the dropped-subarea path: without an escape hatch a download that used to
    // succeed produces nothing at all, which is an availability regression on a READ-ONLY command.
    if (!allowLossy) {
      return { ok: false, error: `could not read the primary-name column for table(s): ${withReason(noPrimaryName)} — refusing to write a spec with a guessed or missing primary attribute (re-run with --allow-lossy-download to drop them instead)` };
    }
    process.stderr.write(`WARNING: ${noPrimaryName.length} sitemap table(s) were DROPPED because their primary-name column could not be read (${withReason(noPrimaryName)}) — --allow-lossy-download was set. Their navigation entries are dropped too; the spec will not rebuild them.\n`);
    for (const l of noPrimaryName) sitemapSet.delete(l);
  }
  if (droppedComponents.length) {
    process.stderr.write(`WARNING: ${droppedComponents.length} app component table(s) were omitted from the spec because Dataverse reported no primary-name column (${withReason(droppedComponents)}) — they are NOT in the app's navigation, and the deployed app still references them; declare them by hand if a rebuild needs them.\n`);
  }
  // A column whose App Spec type could not be substantiated — a Choice/MultiChoice (whose options
  // this download does not read) or an attribute type the spec cannot declare. Rebuilding into an
  // org that ALREADY has the table reuses the column and this is inert; rebuilding into a FRESH org
  // creates it as Text, because the data-model phase falls back to `c.type || 'Text'`. That silent
  // downgrade is the reason this is announced by name rather than left to be discovered later.
  const untyped = untypedColumnNames(entities);
  if (untyped.length) {
    process.stderr.write(`WARNING: ${untyped.length} column(s) were captured WITHOUT a type (${untyped.join(', ')}) — most likely Choice/MultiChoice columns, whose options this download does not read. Rebuilding this spec into an environment that already has the table is unaffected, but rebuilding into a FRESH environment would create them as single-line Text. Add the type and options[] (or a globalChoice reference) by hand before a cross-environment rebuild.\n`);
  }

  // App identity comes from the app's REAL, immutable uniquename (`appUnique`, captured from Dataverse as
  // `appmodule.uniquename`; guaranteed present here because runDownload bails at the sitemap gate above).
  // It is exactly what the build (appUniqueName → findArtifact) + teardown must match — NOT the mutable
  // display name (a rename would miss the existing app). Its leading segment is ALSO parsed as a
  // publisher-prefix FALLBACK, with a full `<prefix>_<name>` shape check (a bare token is not a valid app
  // uniquename — its leading segment must be followed by `_<name>`).
  //
  // This app-derived value is only a fallback: the app's name does not reliably encode the publisher of
  // the solution that owns it (ADO 6603390). The authoritative prefix is the recovered solution's owning
  // publisher, read below.
  const appPrefixMatch = /^([a-z][a-z0-9]{1,7})_.+$/.exec(String(appUnique || '').toLowerCase());
  const appDerivedPrefix = appPrefixMatch ? appPrefixMatch[1] : null;

  // Solution container (best-effort): the real unmanaged solution the appmodule belongs to, for a clean
  // teardown, plus its owning publisher's customization prefix. Falls back to the restricted 'Default'
  // when recovery finds nothing — that fallback cannot be torn down, but teardown skips it safely (see
  // system-solutions.js) rather than erroring.
  const recovered = await recoverAppSolution(sdk, appId);

  // Prefix precedence: the SOLUTION's publisher (authoritative) → the app-uniquename guess (fallback).
  // `prefixResolved` means "this prefix is trustworthy", which gates the icon own-vs-foreign
  // classification below; it must be true for BOTH trusted sources, or a genuine own-publisher custom
  // nav icon stops round-tripping. It stays false only for the unverified 'new' default.
  const solutionPrefix = (recovered && recovered.publisherPrefix) || null;
  const trustedPrefix = solutionPrefix || appDerivedPrefix;
  const solution = { uniqueName: 'Default', publisherPrefix: trustedPrefix || 'new', prefixResolved: !!trustedPrefix };
  if (recovered && recovered.uniqueName) solution.uniqueName = recovered.uniqueName;
  // `recoverAppSolution` already unwraps the solution's description; carry it across. This object is
  // built fresh (rather than spread from `recovered`) so an unrecovered solution still gets its
  // required defaults, which is why each field has to be copied deliberately — a field added to
  // `recoverAppSolution` and not copied here is silently dropped, as this one was.
  if (recovered && recovered.description) solution.description = recovered.description;

  // Icon web resources — looked up by NAME (the sitemap stores the web-resource name, not its id).
  // Bare-name icons are re-declared as-is; a CUSTOM (unmanaged) web resource referenced by a PLATFORM
  // path (e.g. a modern nav vectorIcon `/WebResources/<pub>/icons/x.svg`) is ALSO re-declared so the icon
  // survives a rebuild into a fresh env that lacks it — but ONLY when it belongs to THIS app's own
  // publisher (`solution.publisherPrefix`). A FOREIGN-prefix / OOB reference is left as a bare reference:
  // re-declaring it would make the build try to createWebResource under an unregistered prefix on a fresh
  // env → a hard BuildHalt, turning a cosmetic broken icon into a failed build (Opus review).
  const { webResources, unresolved: unresolvedIcons } = await iconWebResources(sdk, icons, customRefs, solution.publisherPrefix, solution.prefixResolved, navRefs);
  if (unresolvedIcons && unresolvedIcons.length) {
    // A custom nav icon we couldn't safely round-trip: either an own-prefix WR that's absent on the source
    // env / failed to read, OR (when the publisher prefix couldn't be verified) any custom image icon we
    // can't classify as own-vs-foreign. Its sitemap reference round-trips but the WR isn't re-declared, so
    // the icon will dangle on a rebuild into a fresh env. Surface it now (the build-time portability
    // warning is the backstop). Without this, an unverified-prefix download would silently drop the icon.
    process.stderr.write(`WARNING: ${unresolvedIcons.length} custom nav-icon web resource(s) could not be captured (${unresolvedIcons.join(', ')}) — their sitemap reference is kept, but declare the web resource(s) in webResources[] if you rebuild into a fresh environment, or the icon will be missing there.\n`);
  }

  // Dashboards (declared as DashBoard sitemap subareas) — reconstructed with id-passthrough tiles.
  let dashboards = [];
  let dashboardReconstructionError = null;
  // Per-dashboard failures are collected rather than swallowed. They are the usual cause of a
  // "subarea could not be round-tripped" error further down, and without them that error names the
  // subarea but not the reason, which makes it undiagnosable without a debugger.
  const dashboardWarnings = [];
  try {
    dashboards = await readDashboards(sdk, app, (m) => {
      dashboardWarnings.push(m);
      process.stderr.write(`WARNING: ${m}\n`);
    });
  } catch (e) {
    dashboardReconstructionError = e.message;
    process.stderr.write(`(dashboards reconstruction skipped: ${e.message})\n`);
  }

  // Captured by the descriptionInventory accessor below so the role-restriction warning can read it
  // without making a second query.
  let capturedInventory;
  const read = {
    // Ensure the app's REAL uniquename reaches hydrateSpec (→ spec.app.uniqueName) even if the artifact
    // read didn't surface it: `appUnique` is the authoritative value (from the appmodule query) and is
    // guaranteed present here (the sitemap gate above bails when it's falsy). This is what lets a rebuild
    // resolve the EXISTING app by identity after a display-name rename instead of creating a duplicate.
    app: async () => ({ ...app, uniquename: (app && app.uniquename) || appUnique }),
    pages: async () => pages,
    entities: async () => entities,
    webResources: async () => webResources,
    dashboards: async () => dashboards,
    solution: async () => solution,
    design: async () => (manifest ? manifest.design : undefined),
    // Captured on the way past so the role-restriction warning below can read it. The accessor stays
    // a function (hydrateSpec's contract) and is still called exactly once, so this adds no query.
    descriptionInventory: async () => {
      capturedInventory = await readDescriptionInventory(sdk, appId, solution.uniqueName);
      return capturedInventory;
    },
  };
  const spec = await hydrateSpec(read);

  // A form restricted to particular security roles. `forms[]` is not reconstructed by this download,
  // so nothing carries the restriction forward: rebuilding into a FRESH environment regenerates the
  // form with no `<DisplayConditions>`, and a form with none is offered to EVERY role. Every other
  // download gap loses a customization; this one silently WIDENS access, so it is named explicitly.
  const restricted = (capturedInventory && capturedInventory.roleRestrictedForms) || [];
  if (restricted.length) {
    process.stderr.write(`WARNING: ${restricted.length} form(s) are restricted to specific security roles (${restricted.map((f) => `${f.entity}.${f.name}`).join(', ')}). This download does not reconstruct forms[], so that restriction is NOT carried into the spec — rebuilding into a fresh environment would recreate them visible to EVERY role. Re-declare it with forms[].securityRoles before a cross-environment rebuild.\n`);
  }
  const droppedSubareas = typeof spec.droppedSubareas === 'number' ? spec.droppedSubareas : droppedSubareaCount(app, spec);
  const droppedSubareaDetails = Array.isArray(spec.droppedSubareaDetails) ? spec.droppedSubareaDetails : [];
  return { ok: true, spec, pages, entities, webResources, droppedSubareas, droppedSubareaDetails, dashboardReconstructionError, dashboardWarnings };
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  // parseArgs returns boolean true for a value-less flag. For value-bearing flags, treat that as
  // missing so `--env --app x` or `--out` reaches the usage guard instead of passing true into URL,
  // app-id, or path handling. `--allow-lossy-download` is a real boolean switch and stays true.
  const env = typeof flags.env === 'string' ? flags.env : undefined;
  const appArg = (typeof flags.app === 'string' ? flags.app : undefined) || (typeof positional[0] === 'string' ? positional[0] : undefined);
  const outArg = typeof flags.out === 'string' ? flags.out : (typeof flags.output === 'string' ? flags.output : undefined);
  const allowLossyDownload = flags['allow-lossy-download'] === true;
  if (!env || !appArg || flags.app === true || flags.out === true || flags.output === true) {
    process.stderr.write('Usage: node download-model-app.js --env <url> --app <appId|uniqueName|displayName> --out <dir> [--allow-lossy-download]\n');
    process.exit(1);
  }
  const outDir = path.resolve(outArg || '.');
  fs.mkdirSync(outDir, { recursive: true });
  const sdk = makeProvision(env, path.join(outDir, '.maker-workspace'));
  const resolved = await resolveAppId(sdk, appArg);
  if (resolved.error) { emitResult(false, { ok: false, error: resolved.error }); return; }
  const appId = resolved.appId;
  // Narrate a display-name match so the operator learns the app's stable identity: the unique name
  // is what every later build/teardown must be given, and it survives a rename of the display name.
  if (resolved.matchedBy === 'displayName') {
    process.stderr.write(`(resolved display name '${appArg}' to app unique name '${resolved.uniqueName}' — prefer the unique name, it is immutable)\n`);
  }

  // Resolve the app's unique name early — needed for fetchSitemap (MEMBERSHIP) + manifest lookup.
  const appRows = await sdk.queryRecords('appmodule', { select: ['uniquename'], filter: `appmoduleid eq ${appId}`, top: 1 });
  const appUnique = appRows && appRows[0] && appRows[0].uniquename;
  const genpageCli = makeGenpageCli(env);

  const result = await runDownload({ sdk, genpageCli, outDir, appId, appUnique, allowLossy: allowLossyDownload });
  if (!result.ok) { emitResult(false, result); return; }

  const { spec, pages, entities, webResources, droppedSubareas, droppedSubareaDetails, dashboardReconstructionError, dashboardWarnings } = result;
  if (droppedSubareas > 0 || dashboardReconstructionError) {
    const droppedList = (droppedSubareaDetails || [])
      .map((d) => `${d.type}${d.id ? `:${d.id}` : ''}${d.title ? ` (${d.title})` : ''}`)
      .join(', ');
    const dashboardMessage = dashboardReconstructionError ? ` Dashboard reconstruction failed: ${dashboardReconstructionError}.` : '';
    // Per-dashboard reasons, when there are any. Naming the subarea without saying WHY it dropped
    // sends the reader looking at their sitemap when the cause is an unreadable artifact.
    const causeMessage = (dashboardWarnings && dashboardWarnings.length)
      ? ` Cause: ${dashboardWarnings.join('; ')}.`
      : '';
    const message = `${droppedSubareas} sitemap subarea(s) could not be round-tripped${droppedList ? `: ${droppedList}` : ''}.${dashboardMessage}${causeMessage} A rebuild from this spec will DROP them from the app nav.`;
    if (!allowLossyDownload) {
      process.stderr.write(`ERROR: ${message}\nPass --allow-lossy-download to write the partial spec anyway.\n`);
      emitResult(false, { ok: false, error: message, droppedSubareas, droppedSubareaDetails, dashboardReconstructionError, ...(dashboardWarnings && dashboardWarnings.length ? { dashboardWarnings } : {}) });
      return;
    }
    process.stderr.write(`WARNING: ${message}\n`);
  }
  // `reconstructed: true` — this spec was rebuilt from a DEPLOYED app, not authored. Authoring-only
  // rules become warnings, because refusing to write a description of an app that already exists
  // leaves the author with no artifact at all (see the pageInput producer rule).
  const validation = validateAppSpec(spec, { profile: 'plan', reconstructed: true });
  if (!validation.ok) {
    emitResult(false, { ok: false, error: 'downloaded App Spec failed validation', errors: validation.errors });
    return;
  }
  for (const w of validation.warnings || []) process.stderr.write(`WARNING: ${w}\n`);
  // A defaulted `directEntry` must not be silent. hydrateSpec injects a conservative `emptyState` for
  // pages that predate the field (otherwise this download would have hard-failed above and written no
  // spec at all), but the author has to know a behaviour was chosen for them so they can change it.
  const defaulted = spec.directEntryDefaulted || [];
  if (defaulted.length) {
    process.stderr.write(
      `WARNING: ${defaulted.length} page(s) declare pageInput but predate directEntry — defaulted to `
      + `{ "behavior": "emptyState" }: ${defaulted.join(', ')}.\n`
      + '  Review each: change to "selector" if opening the page from the navigation should show a record picker.\n'
    );
  }
  const specPath = path.join(outDir, 'app-spec.json');
  preserveAuthoredLanguageCode(spec, specPath);
  fs.writeFileSync(specPath, JSON.stringify(spec, null, 2));
  emitResult(true, { ok: true, spec: specPath, pages: pages.length, entities: entities.length, webResources: webResources.length, droppedSubareas, ...(defaulted.length ? { directEntryDefaulted: defaulted } : {}) });
}

// Carry an AUTHOR-PINNED `languageCode` across a download, and only from the spec already on disk.
//
// Download deliberately does not read `languageCode` from Dataverse. An LCID copied out of the source
// org would be re-applied verbatim when the spec is rebuilt somewhere else, which is exactly how a
// spec starts failing in an org that has not provisioned that language (#447) — leaving it absent lets
// every target org resolve its own base language, which is the right default.
//
// But silently dropping a value the author WROTE is its own bug, and a quiet one: the next build
// resolves the org default, so newly created columns get one language while the ones from the pinned
// build keep another. A mixed-language app, no error anywhere. So the value is restored from the
// previous spec at this path — the author's own file — and never synthesized from the environment.
//
// Best-effort by design: a missing, unreadable or malformed previous spec just means there is nothing
// to preserve. Failing the download over it would be worse than the wart this fixes. Only a value that
// would itself pass validation is restored — carrying a broken one forward would fail the next build
// for a reason the operator did not cause on this run.
// Exported for tests.
function preserveAuthoredLanguageCode(spec, specPath, deps = {}) {
  const readFileSync = deps.readFileSync || fs.readFileSync;
  const existsSync = deps.existsSync || fs.existsSync;
  if (!spec || spec.languageCode !== undefined) return spec;
  try {
    if (!existsSync(specPath)) return spec;
    const prior = JSON.parse(readFileSync(specPath, 'utf8'));
    // Assign the NORMALIZED value, not the raw one. `"1031"` and `" 1031 "` both validate, but a
    // downloaded spec is a generated artifact and should be canonical — writing the author's
    // whitespace or string form back out makes the file's diff noisy and its type inconsistent with
    // every other numeric field the download emits.
    const lcid = prior ? normalizeLanguageCode(prior.languageCode) : null;
    if (lcid !== null) spec.languageCode = lcid;
  } catch { /* no previous spec, or not parseable — nothing to preserve */ }
  return spec;
}

if (require.main === module) {
  main().catch((err) => emitResult(false, err));
}

module.exports = { untypedColumnNames, isRoleRestrictedFormXml, resolveAppId, collectSitemap, appComponentEntities, parseDownloadedPages, assignPageKeys, missingDownloads, entityFromMetadata, readEntityWithDescriptions, readDescriptionInventory, iconWebResources, readDashboards, droppedSubareaCount, recoverAppSolution, runDownload, preserveAuthoredLanguageCode };
