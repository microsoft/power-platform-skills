#!/usr/bin/env node
'use strict';
// download-model-app: pull a DEPLOYED app back into an editable app-spec + page codeFiles (the edit
// flow's "pull everything" step). Reconstructs the app (sitemap -> appShell), ALL its generative
// pages (via pac list+download, incl. Maker-authored), its entities (minimal — the build reuses
// existing tables idempotently), the icon web resources, and its solution, via hydrate-spec.
//
// Usage: node download-model-app.js --env <orgUrl> --app <appId|uniqueName> --out <dir> [--allow-lossy-download]

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs, emitResult } = require('./lib/dataverse-auth.js');
const { createAzHttpClient } = require('./lib/sdk-http-client.js');
const { hydrateSpec } = require('./lib/hydrate-spec.js');
const { makeGenpageCli } = require('./lib/genpage-cli.js');
const { parseManifestBase64, manifestResourceName, reconcilePageIds } = require('./lib/page-manifest.js');
const { reverseResolveNavIds } = require('./lib/pageref-resolver.js');
const { fetchSitemap, sitemapGenPages } = require('./lib/sitemap-pages.js');
const { isRestrictedSolution } = require('./lib/system-solutions.js');
const { isPlatformIconRef, webResourceNameFromRef, validateAppSpec } = require('./lib/app-spec.js');

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
  const addIcon = (v) => { if (!v) return; if (isPlatformIconRef(v)) { const n = webResourceNameFromRef(v); if (n) customRefs.add(n); } else icons.add(v); };
  for (const a of (app.siteMap && app.siteMap.areas) || []) {
    addIcon(a.icon); addIcon(a.vectorIcon);
    for (const g of a.groups || []) {
      for (const sa of g.subAreas || []) {
        if (sa.type === 'Entity' && sa.entity) entities.add(String(sa.entity).toLowerCase());
        addIcon(sa.icon); addIcon(sa.vectorIcon);
      }
    }
  }
  return { entities: [...entities], icons: [...icons], customRefs: [...customRefs] };
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
    // Flag every recovered table as pre-existing so a teardown of THIS downloaded spec never deletes the
    // table (+ its data). Download cannot prove which tables the app CREATED vs merely REFERENCED, and
    // deleting a customer's table/data is unrecoverable while an orphaned table is not — so fail safe.
    // (The build re-applies a downloaded spec by discovery regardless of this flag; and hydrate emits no
    // forms, so the build's `existing`-gated default-form promotion path is not reached here anyway.)
    existing: true,
  };
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
async function iconWebResources(sdk, icons, customRefs, ownPrefix, prefixResolved) {
  const out = [];
  const seen = new Set();                 // lowercased names actually re-declared into `out`
  const prefixLc = ownPrefix ? String(ownPrefix).toLowerCase() + '_' : null;
  const customRefSet = new Set((customRefs || []).map((n) => String(n).toLowerCase()));
  const candidateUnresolved = new Map();  // key -> original name; a path ref we could NOT re-declare in PASS 1
  const queryWr = async (name) =>
    (await sdk.queryRecords('webresource', { select: ['name', 'webresourcetype', 'content', 'ismanaged'], filter: `name eq '${String(name).replace(/'/g, "''")}'`, top: 1 }))?.[0];
  const isCustomImage = (wr) => !!(wr && wr.content && wr.ismanaged === false && IMAGE_WR_TYPES.has(wr.webresourcetype));

  // PASS 1 — path-derived custom icons (safety-gated). Done FIRST so a name referenced BOTH by a platform
  // path AND by a bare name is classified by the STRICTER path rules (and flagged `external`) before the
  // lenient bare pass can re-declare it as deletable — otherwise the overlap silently loses teardown
  // protection and a shared nav icon gets deleted (Sol review, High).
  for (const name of customRefs || []) {
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
      if (wr.ismanaged === true || !IMAGE_WR_TYPES.has(wr.webresourcetype)) continue;   // managed/non-image → leave as a bare reference
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
// Returns ONLY the solution `{ uniqueName }` (the teardown container). The publisher PREFIX is
// deliberately NOT recovered here: an app can belong to SEVERAL unmanaged solutions under DIFFERENT
// publishers, so this arbitrary `find()` pick is not an authoritative source for the app's own prefix
// (Sol review). The caller derives the trusted prefix from the app's REAL uniquename instead.
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
    const sols = await sdk.queryRecords('solution', { select: ['solutionid', 'uniquename', 'ismanaged'], filter, top: 500 });
    const real = (sols || []).find((s) => s && s.ismanaged === false && !isRestrictedSolution(s.uniquename));
    if (!real) return null;
    return { uniqueName: real.uniquename };
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
async function runDownload({ sdk, genpageCli, outDir, appId, appUnique }) {
  const app = await sdk.fetchArtifact('app', appId);
  const { entities: entityLogicals, icons, customRefs } = collectSitemap(app);

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

  // Entities (minimal — the build reuses existing tables/columns idempotently, so column fidelity
  // isn't required to re-apply an edit).
  const entities = [];
  for (const logical of entityLogicals) {
    try { entities.push(entityFromMetadata(await sdk.fetchEntityMetadata(logical), logical)); } catch { /* skip */ }
  }

  // App identity + publisher prefix come from the app's REAL, immutable uniquename (`appUnique`, captured
  // from Dataverse as `appmodule.uniquename`; guaranteed present here because runDownload bails at the
  // sitemap gate above when it is falsy). It IS the app's own publisher prefix and exactly what the build
  // (appUniqueName → findArtifact) + teardown must match — NOT the mutable display name (a rename would
  // miss the existing app) and NOT an arbitrary unmanaged solution membership (an app can belong to several,
  // under different publishers — Sol review). Parsed BEFORE the solution-recovery I/O so a recovery failure
  // can't lose it, with a full `<prefix>_<name>` shape check (a bare token is not a valid app uniquename —
  // its leading segment must be followed by `_<name>`). This is the ONLY TRUSTED source for the icon
  // own-vs-foreign classification; when it can't be parsed, prefixResolved=false makes the classifier
  // surface (rather than silently drop) a custom nav icon it can't attribute to this app.
  const appPrefixMatch = /^([a-z][a-z0-9]{1,7})_.+$/.exec(String(appUnique || '').toLowerCase());
  const trustedPrefix = appPrefixMatch ? appPrefixMatch[1] : null;

  // Solution container (best-effort): the real unmanaged solution the appmodule belongs to, for a clean
  // teardown. Falls back to the restricted 'Default' when recovery finds nothing — that fallback cannot be
  // torn down, but teardown skips it safely (see system-solutions.js) rather than erroring. Only its
  // uniqueName is used; the publisher prefix is the appUnique-derived `trustedPrefix` above, NOT this
  // solution's publisher (which may belong to a different publisher).
  const solution = { uniqueName: 'Default', publisherPrefix: trustedPrefix || 'new', prefixResolved: !!trustedPrefix };
  const recovered = await recoverAppSolution(sdk, appId);
  if (recovered && recovered.uniqueName) solution.uniqueName = recovered.uniqueName;

  // Icon web resources — looked up by NAME (the sitemap stores the web-resource name, not its id).
  // Bare-name icons are re-declared as-is; a CUSTOM (unmanaged) web resource referenced by a PLATFORM
  // path (e.g. a modern nav vectorIcon `/WebResources/<pub>/icons/x.svg`) is ALSO re-declared so the icon
  // survives a rebuild into a fresh env that lacks it — but ONLY when it belongs to THIS app's own
  // publisher (`solution.publisherPrefix`). A FOREIGN-prefix / OOB reference is left as a bare reference:
  // re-declaring it would make the build try to createWebResource under an unregistered prefix on a fresh
  // env → a hard BuildHalt, turning a cosmetic broken icon into a failed build (Opus review).
  const { webResources, unresolved: unresolvedIcons } = await iconWebResources(sdk, icons, customRefs, solution.publisherPrefix, solution.prefixResolved);
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
  try {
    dashboards = await readDashboards(sdk, app);
  } catch (e) {
    dashboardReconstructionError = e.message;
    process.stderr.write(`(dashboards reconstruction skipped: ${e.message})\n`);
  }

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
  };
  const spec = await hydrateSpec(read);
  const droppedSubareas = typeof spec.droppedSubareas === 'number' ? spec.droppedSubareas : droppedSubareaCount(app, spec);
  const droppedSubareaDetails = Array.isArray(spec.droppedSubareaDetails) ? spec.droppedSubareaDetails : [];
  return { ok: true, spec, pages, entities, webResources, droppedSubareas, droppedSubareaDetails, dashboardReconstructionError };
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
    process.stderr.write('Usage: node download-model-app.js --env <url> --app <appId|uniqueName> --out <dir> [--allow-lossy-download]\n');
    process.exit(1);
  }
  const outDir = path.resolve(outArg || '.');
  fs.mkdirSync(outDir, { recursive: true });
  const sdk = makeProvision(env, path.join(outDir, '.maker-workspace'));
  const appId = await resolveAppId(sdk, appArg);
  if (!appId) { emitResult(false, { ok: false, error: `app '${appArg}' not found` }); return; }

  // Resolve the app's unique name early — needed for fetchSitemap (MEMBERSHIP) + manifest lookup.
  const appRows = await sdk.queryRecords('appmodule', { select: ['uniquename'], filter: `appmoduleid eq ${appId}`, top: 1 });
  const appUnique = appRows && appRows[0] && appRows[0].uniquename;
  const genpageCli = makeGenpageCli(env);

  const result = await runDownload({ sdk, genpageCli, outDir, appId, appUnique });
  if (!result.ok) { emitResult(false, result); return; }

  const { spec, pages, entities, webResources, droppedSubareas, droppedSubareaDetails, dashboardReconstructionError } = result;
  if (droppedSubareas > 0 || dashboardReconstructionError) {
    const droppedList = (droppedSubareaDetails || [])
      .map((d) => `${d.type}${d.id ? `:${d.id}` : ''}${d.title ? ` (${d.title})` : ''}`)
      .join(', ');
    const dashboardMessage = dashboardReconstructionError ? ` Dashboard reconstruction failed: ${dashboardReconstructionError}.` : '';
    const message = `${droppedSubareas} sitemap subarea(s) could not be round-tripped${droppedList ? `: ${droppedList}` : ''}.${dashboardMessage} A rebuild from this spec will DROP them from the app nav.`;
    if (!allowLossyDownload) {
      process.stderr.write(`ERROR: ${message}\nPass --allow-lossy-download to write the partial spec anyway.\n`);
      emitResult(false, { ok: false, error: message, droppedSubareas, droppedSubareaDetails, dashboardReconstructionError });
      return;
    }
    process.stderr.write(`WARNING: ${message}\n`);
  }
  const validation = validateAppSpec(spec, { profile: 'plan' });
  if (!validation.ok) {
    emitResult(false, { ok: false, error: 'downloaded App Spec failed validation', errors: validation.errors });
    return;
  }
  const specPath = path.join(outDir, 'app-spec.json');
  fs.writeFileSync(specPath, JSON.stringify(spec, null, 2));
  emitResult(true, { ok: true, spec: specPath, pages: pages.length, entities: entities.length, webResources: webResources.length, droppedSubareas });
}

if (require.main === module) {
  main().catch((err) => emitResult(false, err));
}

module.exports = { resolveAppId, collectSitemap, parseDownloadedPages, assignPageKeys, missingDownloads, entityFromMetadata, iconWebResources, readDashboards, droppedSubareaCount, recoverAppSolution, runDownload };
