#!/usr/bin/env node

// Estimates solution size + component counts by querying Dataverse metadata.
// Output feeds compute-split-plan.js.
//
// Usage: node estimate-solution-size.js
//          --envUrl <url>
//          --websiteRecordId <guid>
//          [--token <token>]
//          [--publisherPrefix <prefix>]
//          [--siteName <name>]
//          [--datamodelManifest <path>]
//
// Output (JSON to stdout):
//   {
//     totalSizeMB, componentCount, tableCount, schemaAttrCount,
//     webFilesAggregateMB, webFilesIndividual[],
//     cloudFlowCount, botCount, envVarCount, mediaRatio,
//     siteType, tables[], estimationMethod, estimationAccuracyPct
//   }
//
// Exit 0 on success, exit 1 on any error (including auth failure). Callers that
// redirect stdout to a file should use the tmp-file pattern (write to `.tmp`, move
// on success) so a failed run doesn't clobber a prior good estimate.

'use strict';

const helpers = require('./validation-helpers');
const { getAuthToken } = helpers;
const { queryCustomUnmanagedTables } = require('./query-metadata');
const { fetchTableRelationships } = require('./query-table-relationships');
const { collectReferencedEntityNames, scopeCustomTables } = require('./resolve-site-tables');
// `makeRequest` is accessed via `helpers.makeRequest` (not destructured) so
// tests can inject a mock by mutating `helpers.makeRequest` before calling
// the top-level `estimateSolutionSize`. See estimate-solution-size.test.js for
// the pagination integration test that depends on this.

// Approximate bytes-per-component for metadata-based estimation.
// Calibrated against managed solution exports at typical sizes.
const BYTES_PER = Object.freeze({
  table: 48 * 1024,            // schema + forms + views per table
  attribute: 2 * 1024,         // per column (some are larger, averaged)
  sitesetting: 512,
  webrole: 256,
  tablepermission: 1024,
  cloudflow: 2.2 * 1024 * 1024, // flows carry embedded JSON
  bot: 512 * 1024,
  envvarDef: 256,
  webpage: 6 * 1024,
  webtemplate: 4 * 1024,
  pagetemplate: 2 * 1024,
  contentsnippet: 1024,
  sitemarker: 256,
  other: 512,
});

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    envUrl: null,
    token: null,
    websiteRecordId: null,
    publisherPrefix: null,
    siteName: null,
    datamodelManifest: null,
    solutionId: null,
    projectRoot: null,
    siteType: null,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) out.envUrl = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--websiteRecordId' && args[i + 1]) out.websiteRecordId = args[++i];
    else if (args[i] === '--publisherPrefix' && args[i + 1]) out.publisherPrefix = args[++i];
    else if (args[i] === '--siteName' && args[i + 1]) out.siteName = args[++i];
    else if (args[i] === '--datamodelManifest' && args[i + 1]) out.datamodelManifest = args[++i];
    else if (args[i] === '--solutionId' && args[i + 1]) out.solutionId = args[++i];
    else if (args[i] === '--projectRoot' && args[i + 1]) out.projectRoot = args[++i];
    else if (args[i] === '--siteType' && args[i + 1]) out.siteType = args[++i];
  }
  return out;
}

// Resolve the build-axis site type for the estimator's diagnostic `siteType`
// output field. Prefer the caller-supplied value (plan-alm resolves this in
// Phase 1 via detect-project-context.js, the authoritative source), and fall
// back to a lightweight local probe of the same markers detect-project-context.js
// resolves on (also described in the plugin's AGENTS.md "detect-project-context.js" entry):
//   - `powerpages.config.json`          → code / SPA site
//   - `.powerpages-site/.portalconfig/` → declarative design-studio (EDM/standard) site
// Returns the canonical values ('code' | 'declarative') to match
// detect-project-context.js — NOT the old hardcoded 'code-site', which mislabeled
// every declarative/EDM site as a code site. ('declarative' was formerly labeled
// 'data-model'; a caller still passing the legacy 'data-model' is NORMALIZED to
// 'declarative' so the output is always canonical.) Returns 'unknown' when neither
// marker is present (e.g. running outside a project root).
function resolveSiteType(explicitSiteType, projectRoot) {
  // Normalize the caller-supplied label. 'data-model' is the legacy alias for
  // 'declarative' (back-compat). Only canonical labels are trusted verbatim;
  // anything else — notably an unsubstituted "{SITE_TYPE}" template literal an
  // agent forwarded without resolving it — is IGNORED in favor of the local
  // marker probe, so garbage never lands in the diagnostic output.
  if (explicitSiteType === 'data-model') return 'declarative';
  if (explicitSiteType === 'code' || explicitSiteType === 'declarative' || explicitSiteType === 'unknown') {
    return explicitSiteType;
  }
  if (!projectRoot) return 'unknown';
  const fs = require('fs');
  const path = require('path');
  try {
    if (fs.existsSync(path.join(projectRoot, 'powerpages.config.json'))) return 'code';
    if (fs.existsSync(path.join(projectRoot, '.powerpages-site', '.portalconfig'))) return 'declarative';
  } catch {
    // Filesystem probe is best-effort — a diagnostic label must never be fatal.
  }
  return 'unknown';
}

// Page size for paginated OData queries. Dataverse caps `Prefer: odata.maxpagesize`
// at 5000 — requesting more is silently downgraded. Using the cap minimizes
// roundtrips for large sites.
const ODATA_MAX_PAGE_SIZE = 5000;

// Safety upper bound on pagination iterations. At 5000 rows/page this allows up
// to 500,000 records before we bail — well above any realistic Power Pages site.
// The cap exists only to prevent runaway loops in pathological response loops
// where `@odata.nextLink` cycles. Hitting this is the signal of a server bug,
// not a normal-case truncation.
const PAGINATION_SAFETY_CAP = 100;

// NB: this is the local path-based helper `odataGetPath(envUrl, path, token)` — it
// builds the v9.2 URL from a relative path. Distinct from validation-helpers.js's
// shared `odataGet(url, token, request)` (absolute URL, different arg order); the
// rename avoids a silent breakage if a future edit destructures the shared one here.
async function odataGetPath(envUrl, path, token) {
  const url = path.startsWith('http') ? path : `${envUrl}/api/data/v9.2/${path.replace(/^\//, '')}`;
  const res = await helpers.makeRequest({
    url,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
      // `Prefer: odata.maxpagesize=N` is what makes Dataverse emit
      // `@odata.nextLink` when there are more rows than fit in one page.
      // Without it, a `$top=N` query returns at most N rows AND NO continuation
      // link — even when more rows exist. That was the cause of webFileCount
      // capping at 500 on stress-test sites with 6000+ web files.
      Prefer: `odata.maxpagesize=${ODATA_MAX_PAGE_SIZE}`,
    },
    timeout: 30000,
  });
  if (res.error) throw new Error(`API request failed: ${res.error}`);
  if (res.statusCode === 401) {
    const err = new Error('Authentication failed');
    err.code = 'AUTH';
    throw err;
  }
  if (res.statusCode !== 200) {
    throw new Error(`Unexpected response (${res.statusCode}): ${res.body}`);
  }
  return JSON.parse(res.body);
}

// Follows `@odata.nextLink` until exhausted, aggregating all pages.
// `maxPages` is a safety cap — leave at the default unless you know the
// remote endpoint can return more than ~500K rows.
async function collectPaginated(envUrl, path, token, maxPages = PAGINATION_SAFETY_CAP) {
  let next = path;
  const items = [];
  let pagesFetched = 0;
  for (let p = 0; p < maxPages && next; p++) {
    const page = await odataGetPath(envUrl, next, token);
    if (Array.isArray(page.value)) items.push(...page.value);
    next = page['@odata.nextLink'] || null;
    pagesFetched += 1;
  }
  if (next) {
    // We hit the safety cap with more pages remaining. This is a strong signal
    // of either a bug in the remote endpoint or an unrealistic dataset size.
    // Stamp a warning into stderr so the caller can see it; the canary in the
    // top-level estimator output will also flag the truncation.
    process.stderr.write(
      `estimate-solution-size: WARN — collectPaginated hit the safety cap of ${maxPages} pages (~${maxPages * ODATA_MAX_PAGE_SIZE} rows) with more remaining. Path: ${path.slice(0, 200)}\n`,
    );
  }
  return items;
}

/**
 * Discovers bots + bot components linked to the site.
 *
 * Power Pages bot linkage: each site has `powerpagecomponent` rows of type 27
 * (Bot Consumer). Each consumer carries the bot schemaname in its `content`
 * JSON (the `name` column is literally the string "Bot Consumer"). We scope
 * the bot query by those schemanames so env-wide bots from other projects
 * don't inflate this site's count.
 *
 * Each bot has child `botcomponent` rows (topics, entities, gpt defs). Both
 * bots and bot components become separate `solutioncomponents` rows when
 * added to a solution (the Bot and BotComponent types; integer values are
 * dynamic per tenant — resolve via `discover-component-types.js` before any
 * mutation). Observed values in current tenants are 10192 for Bot and 10193
 * for BotComponent; 10137 is Connection Reference (not a bot type), which
 * earlier comments here had swapped. Counting bots + bot components here
 * closes the siteTotal gap that previously made orphansOnSite look
 * artificially small.
 *
 * Pagination: uses the shared `collectPaginated` helper with the default
 * `PAGINATION_SAFETY_CAP` (100 pages × `ODATA_MAX_PAGE_SIZE` = ~500K rows).
 * Hitting that cap is so unusual in real tenants that we log a WARN via the
 * helper rather than paginating forever.
 */
async function discoverBotsAndComponents(envUrl, botConsumerPpcs, token) {
  if (!botConsumerPpcs || botConsumerPpcs.length === 0) {
    return { bots: [], botComponents: [] };
  }

  // Bot schemaname lives in the ppc `content` JSON (the `name` field is the
  // literal string "Bot Consumer" — not useful). We re-query the consumers
  // with content included, parse, and collect unique schema names.
  const consumerIds = botConsumerPpcs
    .map((c) => c.powerpagecomponentid)
    .filter(Boolean);
  if (consumerIds.length === 0) return { bots: [], botComponents: [] };

  const idFilter = consumerIds.map((id) => `powerpagecomponentid eq ${id}`).join(' or ');
  const withContentPath =
    `powerpagecomponents?$filter=${idFilter}&$select=powerpagecomponentid,content&$top=${ODATA_MAX_PAGE_SIZE}`;
  let enriched;
  try {
    enriched = await collectPaginated(envUrl, withContentPath, token);
  } catch {
    return { bots: [], botComponents: [] };
  }

  const consumerNames = [];
  for (const row of enriched) {
    let schema = null;
    try {
      const parsed = JSON.parse(row.content || '{}');
      schema = parsed.botschemaname || parsed.botSchemaName || null;
    } catch {
      // Malformed content — skip this consumer.
    }
    if (schema) consumerNames.push(schema);
  }

  const unique = [...new Set(consumerNames)];
  if (unique.length === 0) return { bots: [], botComponents: [] };

  // Fetch bots by schema-name match. OR-chaining several equality predicates
  // stays well inside URL-length limits for realistic consumer counts (<50).
  const safeNames = unique.map((n) => n.replace(/'/g, "''"));
  const botFilter = safeNames.map((n) => `schemaname eq '${n}'`).join(' or ');
  const botsPath =
    `bots?$filter=${botFilter}&$select=botid,name,schemaname&$top=${ODATA_MAX_PAGE_SIZE}`;
  let bots = [];
  try {
    bots = await collectPaginated(envUrl, botsPath, token);
  } catch {
    // Bots may be unavailable in some tenants (privilege / feature gating).
    // Don't fail the whole estimate — surface as zero and move on.
    return { bots: [], botComponents: [] };
  }
  if (bots.length === 0) return { bots: [], botComponents: [] };

  const botIds = bots.map((b) => b.botid).filter(Boolean);
  const compFilter = botIds.map((id) => `_parentbotid_value eq ${id}`).join(' or ');
  const compsPath =
    `botcomponents?$filter=${compFilter}&$select=botcomponentid&$top=${ODATA_MAX_PAGE_SIZE}`;
  let botComponents = [];
  try {
    botComponents = await collectPaginated(envUrl, compsPath, token);
  } catch {
    botComponents = [];
  }
  return { bots, botComponents };
}

async function discoverPowerPageComponents(envUrl, websiteRecordId, token) {
  // Verified 2026-04-21 against org1e98cc97 (v9.2 endpoint): both quoted and
  // unquoted GUID forms return identical results. Keeping quoted because it's
  // the historically safer form and tests against this codebase assume it.
  // See memory/project_pr107_deferred_validation.md (Check 1) for evidence.
  const path =
    `powerpagecomponents` +
    `?$filter=_powerpagesiteid_value eq '${websiteRecordId}'` +
    `&$select=powerpagecomponentid,name,powerpagecomponenttype` +
    `&$top=${ODATA_MAX_PAGE_SIZE}`;
  return collectPaginated(envUrl, path, token);
}

// Returns the server's `@odata.count` for an entity + optional filter — cheap
// ground-truth check (one round-trip; payload is a single row plus the count
// annotation). Used by the truncation canary: if the row-fetch returned fewer
// items than `@odata.count` reports, pagination is broken upstream. Returns
// null on query failure so the canary can degrade gracefully.
async function countOData(envUrl, entity, filter, token) {
  try {
    const filterPart = filter ? `&$filter=${filter}` : '';
    const countPath = `${entity}?$count=true&$top=1${filterPart}`;
    const page = await odataGetPath(envUrl, countPath, token);
    const n = page['@odata.count'];
    return typeof n === 'number' ? n : null;
  } catch {
    return null;
  }
}

async function discoverPowerPageSiteLanguages(envUrl, websiteRecordId, token) {
  // Site languages are a sibling unified entity (`powerpagesitelanguage`)
  // with its own solutioncomponent.componenttype (10428). They MUST be added
  // to the user solution alongside powerpagecomponents — without them the
  // target site silently fails to render post-auth. See
  // references/solution-api-patterns.md for the 3-entity model.
  // Older Power Pages installs without the unified entity return 404; we
  // swallow that and return [] so the estimator stays usable.
  const path =
    `powerpagesitelanguages` +
    `?$filter=_powerpagesiteid_value eq '${websiteRecordId}'` +
    `&$select=powerpagesitelanguageid,name,languagecode` +
    `&$top=${ODATA_MAX_PAGE_SIZE}`;
  try {
    return await collectPaginated(envUrl, path, token);
  } catch (e) {
    if (/HTTP\s+404\b/.test(String(e && e.message))) return [];
    throw e;
  }
}

// Discovers the custom tables the SITE actually references — NOT every table
// sharing the publisher prefix. The old prefix-wide enumeration over-counted
// catastrophically with a shared/default publisher (`new_`, env default): a
// 6-table site reported 22 tables, which cascaded into absurd schema splits.
//
// Source of truth = the site's table permissions (+ datamodel manifest), per
// SME: "If a table is used in the site there will be permissions for it."
// We intersect those referenced names with the env's custom-unmanaged tables so
// standard tables (contact/annotation) and managed template tables drop out.
//
// Returns `{ tables, tableCountScope }` where scope ∈
//   "site-referenced" | "manifest-only" | "unavailable".
// On no local signal we return zero tables (NEVER a prefix dump) so a missing
// `.powerpages-site/` degrades safe instead of inflating the plan.
async function discoverTables(envUrl, token, { projectRoot, datamodelManifestPath } = {}) {
  let customUnmanaged = [];
  try {
    customUnmanaged = await queryCustomUnmanagedTables(envUrl, token);
  } catch {
    customUnmanaged = [];
  }

  const { names, available, sources } = collectReferencedEntityNames({ projectRoot, datamodelManifestPath });

  let scope;
  let scoped = [];
  if (!available) {
    scope = 'unavailable';
  } else {
    scoped = scopeCustomTables(names, customUnmanaged);
    scope = sources.tablePermissions > 0 ? 'site-referenced' : 'manifest-only';
  }

  const byName = new Map();
  for (const t of scoped) {
    if (t.logicalName && !byName.has(t.logicalName)) {
      byName.set(t.logicalName, { logicalName: t.logicalName, metadataId: t.metadataId });
    }
  }
  return { tables: Array.from(byName.values()), tableCountScope: scope };
}

// Build the deduped, scoped dependency-edge list among the site's tables.
// Each edge `[a, b]` (lowercased logical names, a<b) means tables a and b are
// connected by a lookup (OneToMany) or N:N (ManyToMany) — so the schema-split
// clustering keeps them in the same solution. Only edges where BOTH ends are in
// the scoped table set are kept. Per-table fetch errors are non-fatal.
async function discoverTableRelationships(envUrl, tables, token) {
  if (!Array.isArray(tables) || tables.length < 2) return [];
  const inSet = new Set(tables.map((t) => (t.logicalName || '').toLowerCase()).filter(Boolean));
  const seen = new Set();
  const edges = [];
  const addEdge = (x, y) => {
    const a = String(x || '').toLowerCase();
    const b = String(y || '').toLowerCase();
    if (!a || !b || a === b || !inSet.has(a) || !inSet.has(b)) return;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(a < b ? [a, b] : [b, a]);
  };
  // Fetch each table's relationships with BOUNDED CONCURRENCY (~2 OData calls per
  // table; a 34-table site is 68 round-trips — serial is slow at plan time). Edge
  // assembly stays sequential, in table order, so dedup is deterministic.
  const CONCURRENCY = 5;
  const results = new Array(tables.length).fill(null);
  let nextIdx = 0;
  async function worker() {
    while (nextIdx < tables.length) {
      const i = nextIdx++;
      try {
        results[i] = await fetchTableRelationships(envUrl, tables[i].logicalName, token);
      } catch {
        results[i] = null; // inaccessible table — skip its edges
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, tables.length) }, () => worker()),
  );
  for (const rel of results) {
    if (!rel) continue;
    for (const e of rel.oneToMany) addEdge(e.referencedEntity, e.referencingEntity);
    for (const e of rel.manyToMany) addEdge(e.entity1, e.entity2);
  }
  return edges;
}

async function countAttributesForTables(envUrl, tables, token) {
  let total = 0;
  for (const t of tables) {
    try {
      const page = await odataGetPath(
        envUrl,
        `EntityDefinitions(LogicalName='${t.logicalName}')/Attributes?$select=LogicalName&$top=1000`,
        token,
      );
      const n = Array.isArray(page.value) ? page.value.length : 0;
      total += n;
      t.attributeCount = n;
    } catch {
      t.attributeCount = 0;
    }
  }
  return total;
}

async function countEnvVarDefinitions(envUrl, publisherPrefix, token) {
  const filter = publisherPrefix
    ? `&$filter=startswith(schemaname,'${publisherPrefix}_')`
    : '';
  const path =
    `environmentvariabledefinitions?$select=schemaname,displayname,type${filter}&$top=${ODATA_MAX_PAGE_SIZE}`;
  const items = await collectPaginated(envUrl, path, token);
  return items.length;
}

// Detects Vite/Rollup/Webpack code-bundle chunks emitted by
// `pac pages upload-code-site`. Each rebuild uploads new hash-suffixed files
// and leaves the prior batch behind — so the total accumulates even though
// only the latest batch is referenced by index.html. For plan-alm purposes,
// these dead entries are noise, not real site inventory.
//
// Patterns matched:
//   Home-BPuZZDcA.js        (Vite dynamic chunks)
//   index-DyzztwOp.js       (main entry)
//   chunk-RxR9EgHz.js       (generic chunk)
//   vendor.a1b2c3d4.js      (older Webpack pattern)
//   style.Z0qHD57j.css
//
// Heuristic: name contains `-` or `.` separator followed by 7–14 chars of
// [A-Za-z0-9_-] followed by a `.js`/`.mjs`/`.cjs`/`.css`/`.map` extension.
// Includes sourcemaps since those also accumulate. Keeps static assets like
// `logo.svg`, `favicon.ico`, `hero.jpg` — no hash suffix.
const BUNDLE_CHUNK_NAME = /[-.][A-Za-z0-9_-]{7,14}\.(?:js|mjs|cjs|css)(?:\.map)?$/;
function isProbablyBundleChunk(name) {
  if (!name) return false;
  return BUNDLE_CHUNK_NAME.test(String(name));
}

function classifyPPCs(ppcs) {
  const byType = new Map();
  for (const c of ppcs) {
    const t = c.powerpagecomponenttype;
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t).push(c);
  }

  // Canonical `powerpagecomponenttype` picklist values (authoritative: MS Learn,
  // cross-checked against the PPC_TYPE_LABELS enum in discover-site-components.js).
  // Earlier versions of this file had swapped constants (WEB_FILE=2, WEB_PAGE=4,
  // WEB_TEMPLATE=11) which actually pointed at Web Page, Web Link Set, and Web
  // Role respectively — making webFileCount / webFilesAggregateMB catastrophically
  // wrong on any site. Fixed 2026-04-22.
  const PUBLISHING_STATE = 1;
  const WEB_PAGE = 2;
  const WEB_FILE = 3;
  const WEB_LINK_SET = 4;
  const WEB_LINK = 5;
  const PAGE_TEMPLATE = 6;
  const CONTENT_SNIPPET = 7;
  const WEB_TEMPLATE = 8;
  const SITE_SETTING = 9;
  const WEB_ROLE = 11;
  const SITE_MARKER = 13;
  const BOT_CONSUMER = 27;
  const CLOUD_FLOW_LINK = 33;
  const TABLE_PERMISSION = 18; // note: 18 is Table Permission per the docs

  const rawWebFiles = byType.get(WEB_FILE) || [];
  const bundleChunks = rawWebFiles.filter((f) => isProbablyBundleChunk(f.name));
  const liveWebFiles = rawWebFiles.filter((f) => !isProbablyBundleChunk(f.name));

  return {
    siteSettings: byType.get(SITE_SETTING) || [],
    webRoles: byType.get(WEB_ROLE) || [],
    tablePermissions: byType.get(TABLE_PERMISSION) || [],
    botConsumers: byType.get(BOT_CONSUMER) || [],
    cloudFlowLinks: byType.get(CLOUD_FLOW_LINK) || [],
    // webFiles now excludes bundle chunks — the real "content" web files only
    // (images, fonts, static assets). Bundle chunks are surfaced separately so
    // they can be reported (and optionally cleaned up) but not counted as
    // meaningful site inventory for planning purposes.
    webFiles: liveWebFiles,
    bundleChunks,
    webPages: byType.get(WEB_PAGE) || [],
    webTemplates: byType.get(WEB_TEMPLATE) || [],
    publishingStates: byType.get(PUBLISHING_STATE) || [],
    webLinks: byType.get(WEB_LINK) || [],
    webLinkSets: byType.get(WEB_LINK_SET) || [],
    pageTemplates: byType.get(PAGE_TEMPLATE) || [],
    contentSnippets: byType.get(CONTENT_SNIPPET) || [],
    siteMarkers: byType.get(SITE_MARKER) || [],
    all: ppcs,
    byType,
  };
}

async function measureWebFiles(envUrl, webFiles, token) {
  // Uses odataGetPath directly (single-row fetch each, no pagination needed).
  const individual = [];
  let aggregateBytes = 0;
  let imgOrFontBytes = 0;

  for (const wf of webFiles) {
    const id = wf.powerpagecomponentid;
    try {
      const rec = await odataGetPath(
        envUrl,
        `powerpagecomponents(${id})?$select=name,powerpagecomponentid,content`,
        token,
      );
      const name = rec.name || wf.name || id;
      const content = rec.content || '';
      // content is base64; decoded size = floor(len * 3/4)
      const bytes = Math.max(0, Math.floor((content.length * 3) / 4));
      aggregateBytes += bytes;
      const sizeMB = bytes / (1024 * 1024);
      if (sizeMB >= 0.05) {
        individual.push({ name, sizeMB: Math.round(sizeMB * 100) / 100, currentPath: `/${name}` });
      }
      if (/\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf)$/i.test(name)) {
        imgOrFontBytes += bytes;
      }
    } catch {
      // Skip unreadable web file — estimate from metadata only
      aggregateBytes += BYTES_PER.other;
    }
  }

  individual.sort((a, b) => b.sizeMB - a.sizeMB);
  return {
    aggregateBytes,
    individual,
    sampleSize: webFiles.length,
    mediaRatio: aggregateBytes > 0 ? imgOrFontBytes / aggregateBytes : 0,
  };
}

// Stratified sample over a list of web files. The goal: cover the full id-range
// so a hot spot of large files in the long tail can't dominate or get missed.
// - <= cap → measure everything
// - > cap  → take first 50 + last 50 + 50 evenly-spaced middles (deterministic)
// `WEB_FILE_SAMPLE_CAP` is the upper bound; bumped from 80 to 150 after field
// reports of underestimated size on sites with large media biased to one end of
// the ppc id range.
const WEB_FILE_SAMPLE_CAP = 150;
function stratifiedWebFileSample(webFiles) {
  const len = webFiles.length;
  if (len <= WEB_FILE_SAMPLE_CAP) return webFiles.slice();
  const first = webFiles.slice(0, 50);
  const last = webFiles.slice(len - 50, len);
  const middle = [];
  for (let i = 0; i < 50; i++) {
    // Map i ∈ [0,50) to an index in the middle region (50, len-50).
    const idx = Math.floor((i * (len - 100)) / 50) + 50;
    middle.push(webFiles[idx]);
  }
  // Dedupe by id in the rare edge case where regions overlap on small bumps.
  const seen = new Set();
  const out = [];
  for (const wf of [...first, ...middle, ...last]) {
    const key = wf && wf.powerpagecomponentid;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(wf);
  }
  return out;
}

// Walks a directory recursively and sums file byte sizes. Skips node_modules,
// .git, and any hidden directory (name starts with `.`). Synchronous on
// purpose — small directories complete instantly; for larger directories we'd
// rather block briefly than juggle async state inside the estimator's main
// flow. Returns null on any error (permission, missing path) so callers can
// degrade gracefully.
//
// Symlink-loop protection: tracks visited inode-device pairs in `seenInodes`.
// A symlink that points back into the walked tree (or into the project root
// itself) would otherwise recurse forever. We use `lstatSync` to NOT follow
// the link, then conditionally `statSync` to read the target's size — so we
// always count the bytes once and never re-walk the same physical directory.
function walkDirectoryBytes(rootPath) {
  const fs = require('fs');
  const path = require('path');
  try {
    const st = fs.statSync(rootPath);
    if (!st.isDirectory()) return null;
  } catch {
    return null;
  }
  let totalBytes = 0;
  let fileCount = 0;
  const seenInodes = new Set();
  const stack = [rootPath];
  while (stack.length) {
    const dir = stack.pop();
    try {
      const dst = fs.statSync(dir);
      const key = `${dst.dev}:${dst.ino}`;
      if (seenInodes.has(key)) continue;  // already walked (cycle or hard link)
      seenInodes.add(key);
    } catch {
      continue;
    }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const name = ent.name;
      if (!name) continue;
      const full = path.join(dir, name);
      // Use lstatSync to NOT follow the link itself — we only follow when the
      // target is a real directory we haven't visited.
      let lst;
      try { lst = fs.lstatSync(full); } catch { continue; }
      if (lst.isSymbolicLink()) {
        try {
          const target = fs.statSync(full);  // resolves the symlink
          if (target.isDirectory()) {
            if (name === 'node_modules' || name.startsWith('.')) continue;
            stack.push(full);
          } else if (target.isFile()) {
            totalBytes += target.size;
            fileCount += 1;
          }
        } catch {
          // broken symlink — skip
        }
        continue;
      }
      if (ent.isDirectory()) {
        if (name === 'node_modules' || name.startsWith('.')) continue;
        stack.push(full);
      } else if (ent.isFile()) {
        try {
          const s = fs.statSync(full);
          totalBytes += s.size;
          fileCount += 1;
        } catch {
          // skip unreadable file
        }
      }
    }
  }
  return { totalBytes, fileCount };
}

// Detects the build-output directory for a Power Pages code site. Order
// matches the conventional outputs across supported frameworks (Vite, Astro,
// Angular CLI, Nuxt-static fallback). Returns null if none of the candidates
// exist as directories.
function detectBuildOutputDir(projectRoot) {
  if (!projectRoot) return null;
  const fs = require('fs');
  const path = require('path');
  const candidates = ['dist', 'public-output', 'build', '.output'];
  for (const name of candidates) {
    const full = path.join(projectRoot, name);
    try {
      const st = fs.statSync(full);
      if (st.isDirectory()) return full;
    } catch {
      // try next
    }
  }
  return null;
}

function estimateTotalSize({ classified, tables, schemaAttrCount, webFilesAggregateBytes, envVarCount }) {
  const tb = BYTES_PER;
  const total =
    tables.length * tb.table +
    schemaAttrCount * tb.attribute +
    (classified.siteSettings.length * tb.sitesetting) +
    (classified.webRoles.length * tb.webrole) +
    (classified.tablePermissions.length * tb.tablepermission) +
    (classified.cloudFlowLinks.length * tb.cloudflow) +
    (classified.botConsumers.length * tb.bot) +
    (classified.webPages.length * tb.webpage) +
    (classified.webTemplates.length * tb.webtemplate) +
    (envVarCount * tb.envvarDef) +
    webFilesAggregateBytes;
  return total / (1024 * 1024);
}

/**
 * Queries solutioncomponents for a specific solution and aggregates counts by
 * componenttype so the caller can distinguish "site-total" from "in-solution"
 * numbers. Used to fix the common confusion where the site has 908 ppcs but
 * only 361 are actually owned by the solution being planned.
 *
 * When `sitePpcIdSet` is provided (the set of powerpagecomponent ids actually
 * linked to the target site), the returned object also includes a
 * `crossSitePpcs` warning — type-10373 rows in the solution that do NOT belong
 * to the expected site. Safety check for solutions that accidentally contain
 * ppcs from multiple sites.
 */
async function countSolutionMembership(envUrl, solutionId, token, sitePpcIdSet = null) {
  const url = `${envUrl}/api/data/v9.2/solutioncomponents?$filter=_solutionid_value eq ${solutionId}&$select=objectid,componenttype&$top=5000`;
  const res = await helpers.makeRequest({
    url,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
      Prefer: 'odata.maxpagesize=5000',
    },
    timeout: 30000,
  });
  if (res.error || res.statusCode < 200 || res.statusCode >= 300) {
    // Don't fail the whole estimate — just omit the inSolution block.
    return null;
  }
  const parsed = JSON.parse(res.body);
  const rows = parsed.value || [];
  const byType = {};
  for (const r of rows) {
    byType[r.componenttype] = (byType[r.componenttype] || 0) + 1;
  }

  // Cross-site safety check: if the caller gave us the set of ppc ids on the
  // target site, flag any type-10373 row in the solution whose objectid isn't
  // in that set. 100% overlap is the healthy case; any miss means this
  // solution contains ppcs from a different site (rare, but possible when a
  // user manually adds components across sites).
  let crossSitePpcs = [];
  if (sitePpcIdSet && sitePpcIdSet.size > 0) {
    const solPpcs = rows
      .filter((r) => r.componenttype === 10373)
      .map((r) => (r.objectid || '').toLowerCase());
    crossSitePpcs = solPpcs.filter((id) => id && !sitePpcIdSet.has(id));
  }

  return {
    total: rows.length,
    byComponentType: byType,
    objectIds: rows.map((r) => (r.objectid || '').toLowerCase()),
    crossSitePpcs,
  };
}

async function estimateSolutionSize({ envUrl, websiteRecordId, token, publisherPrefix, siteName, datamodelManifest, solutionId, projectRoot, siteType }) {
  if (!envUrl || !websiteRecordId) {
    throw new Error('--envUrl and --websiteRecordId are required');
  }
  const resolved = token || getAuthToken(envUrl);
  if (!resolved) {
    throw new Error('Failed to acquire Azure CLI token. Run `az login` first.');
  }

  const ppcs = await discoverPowerPageComponents(envUrl, websiteRecordId, resolved);
  const classified = classifyPPCs(ppcs);

  // Truncation canary — ask Dataverse for the authoritative row count and
  // compare against what discoverPowerPageComponents returned. If they disagree
  // by more than a small margin, pagination is broken (or the data changed
  // mid-scan, which is rare for code-site inventory). Cheap: one extra
  // round-trip with `$count=true&$top=1`.
  const ppcGroundTruthCount = await countOData(
    envUrl,
    'powerpagecomponents',
    `_powerpagesiteid_value eq '${websiteRecordId}'`,
    resolved,
  );

  // Site-language records are a sibling unified entity, NOT powerpagecomponent
  // rows. Enumerate them so the site total reconciles with the solution total
  // (which includes them under componenttype 10428).
  const siteLanguages = await discoverPowerPageSiteLanguages(envUrl, websiteRecordId, resolved);

  const { tables, tableCountScope } = await discoverTables(envUrl, resolved, {
    projectRoot,
    datamodelManifestPath: datamodelManifest,
  });
  const schemaAttrCount = await countAttributesForTables(envUrl, tables, resolved);
  // Dependency edges among the scoped tables — drives the schema-split clustering
  // so related tables ship in the same solution (never split a relationship).
  const tableRelationships = await discoverTableRelationships(envUrl, tables, resolved);

  // Tenant-wide env var defs matching the publisher prefix. This is the
  // fallback used when no solution is set up yet (fresh project); for sites
  // with a solution, we refine to in-solution scope below using
  // `inSolution.byComponentType[380]` (Environment Variable Definition).
  // Without that refinement, sites whose publisher prefix is shared across
  // tenants (e.g. `new_`, `cr5fe_`) over-count by including env vars from
  // unrelated projects. See plan-alm + MEMORY.md for the regression context.
  const envVarCountTenantWide = await countEnvVarDefinitions(envUrl, publisherPrefix, resolved);

  // Bot + bot components — scoped to bots referenced by this site's
  // type-27 bot consumer ppcs so env-wide bots don't inflate the count.
  const botsAndComponents = await discoverBotsAndComponents(
    envUrl,
    classified.botConsumers,
    resolved,
  );

  // Stratified sample over the full web-file list — cap at 150 (bumped from
  // an earlier 80). Field reports showed the old `slice(0, 80)` undercount
  // when large media lived in the long tail of the powerpagecomponentid range.
  // See `stratifiedWebFileSample` for the first-50 + middle-50 + last-50 layout.
  const webFileSample = stratifiedWebFileSample(classified.webFiles);
  const webMeasure = await measureWebFiles(envUrl, webFileSample, resolved);
  const sampleSize = webMeasure.sampleSize;

  // Scale measured bytes to full web file count if we sampled
  const scaleFactor =
    classified.webFiles.length > 0 && webFileSample.length > 0
      ? classified.webFiles.length / webFileSample.length
      : 1;
  const webFilesAggregateBytes = webMeasure.aggregateBytes * scaleFactor;

  // Optional disk-measurement cross-check. When the caller passes
  // `--projectRoot`, walk the build-output directory and sum file bytes. We
  // never replace `webFilesAggregateBytes` with this — the Dataverse-measured
  // bytes are what will actually ship in the solution zip — but the disk
  // total is useful as a sanity check for the undercount canary below.
  let webFilesDiskMeasuredMB = null;
  let webFilesDiskMeasuredPath = null;
  let webFilesDiskFileCount = null;
  if (projectRoot) {
    const buildDir = detectBuildOutputDir(projectRoot);
    if (buildDir) {
      const walk = walkDirectoryBytes(buildDir);
      if (walk) {
        webFilesDiskMeasuredMB = round1(walk.totalBytes / (1024 * 1024));
        webFilesDiskMeasuredPath = buildDir;
        webFilesDiskFileCount = walk.fileCount;
      } else {
        process.stderr.write(
          `estimate-solution-size: WARN — disk-measurement walk of ${buildDir} failed; webFilesDiskMeasuredMB unavailable.\n`,
        );
      }
    }
  }

  // Optional: when caller passes --solutionId, also report what's actually
  // in the solution vs. site-total. Reported raw — every solutioncomponents
  // row counts, including bundle-chunk ppcs that were explicitly added to the
  // solution. Matches the Power Platform Maker UI's solution breakdown
  // (e.g. 311 site components + 11 tables + 1 site record + 1 site language
  // + 4 connection references + 2 cloud flows + 2 agents + 30 agent
  // components = 362). An earlier revision subtracted bundle chunks from
  // inSolution.total on the theory they were "noise", but bundle chunks that
  // made it into the solution ship as managed components — they're real
  // members, not noise. Noise-filtering belongs only to the on-site orphan
  // heuristic below, not the in-solution count.
  //
  // NOTE: this block was moved BEFORE the estimateTotalSize call so the
  // refined `envVarCount` below can use `inSolution.byComponentType[380]`
  // when a solution is set up. estimateTotalSize uses envVarCount in its
  // size calculation, so the input MUST be the solution-scoped figure
  // whenever possible — otherwise the size for sites with shared publisher
  // prefixes is inflated by tenant-wide env var defs.
  const sitePpcIdSet = new Set(
    ppcs.map((p) => (p.powerpagecomponentid || '').toLowerCase()).filter(Boolean),
  );
  const inSolution = solutionId
    ? await countSolutionMembership(envUrl, solutionId, resolved, sitePpcIdSet)
    : null;

  // Refine env var count: prefer solution-scoped membership when available.
  // `inSolution.byComponentType[380]` is the count of `solutioncomponents`
  // rows of type 380 (Environment Variable Definition) for the target solution
  // — exactly what we want for plan-alm's "today's env vars" stat. When no
  // solution is set up, fall back to the publisher-prefix tenant-wide count
  // (the only useful number when there's nothing else to scope by).
  const envVarCountInSolution = inSolution && inSolution.byComponentType
    ? (inSolution.byComponentType[380] || 0)
    : null;
  const envVarCount = envVarCountInSolution != null ? envVarCountInSolution : envVarCountTenantWide;
  const envVarCountScope = envVarCountInSolution != null ? 'solution' : 'publisher-prefix';

  const totalSizeMB = estimateTotalSize({
    classified,
    tables,
    schemaAttrCount,
    webFilesAggregateBytes,
    envVarCount,
  });

  // Tag how many of the solution's ppc rows are bundle-chunk files, purely as
  // metadata — we do NOT subtract this from inSolution.total. Useful for
  // downstream cleanup tooling and for the plan banner that says "your
  // solution contains N superseded bundle chunks — consider a cleanup pass".
  let bundleChunksInSolution = 0;
  if (inSolution && classified.bundleChunks.length > 0) {
    const chunkIdSet = new Set(
      classified.bundleChunks.map((c) => (c.powerpagecomponentid || '').toLowerCase()),
    );
    const inSolIds = new Set(inSolution.objectIds || []);
    for (const id of chunkIdSet) {
      if (inSolIds.has(id)) bundleChunksInSolution += 1;
    }
  }

  // Component count must match what Dataverse `solutioncomponents` counts —
  // each table is ONE component (attributes ride along, not counted separately).
  // Earlier versions added `schemaAttrCount` which inflated the total by 3–5×
  // on schema-heavy sites (e.g. 503 attrs pushed the count from 405 → 908).
  //
  // Each term in the sum below maps to a category of `solutioncomponents` row
  // that would be created if the site's artifacts were added to a solution.
  //
  // On componenttype integers: the Dataverse `solutioncomponent.componenttype`
  // picklist is officially **dynamic per tenant** — AddSolutionComponent
  // expects the caller to resolve values at runtime, which is what
  // `scripts/lib/discover-component-types.js` does. `countSolutionMembership`
  // in this file is deliberately resolver-free: it tallies whatever values
  // Dataverse returns in `byComponentType`, no hardcoded integers. Observed
  // values in current tenants (2026-04-22) are
  //   1=Entity, 29=Workflow, 380=EnvVarDef, 10137=ConnectionReference,
  //   10192=Bot, 10193=BotComponent, 10373=PowerPageComponent, 10374=Website
  // but callers MUST NOT rely on those in mutation paths — use the resolver.
  //
  // Site-inventory terms:
  //   ppcs.length          — rows in powerpagecomponents for this website.
  //                          Already contains type-27 bot consumers and
  //                          type-33 cloud flow bindings (they're all ppcs).
  //                          When exported to a solution they become the
  //                          umbrella PowerPageComponent solutioncomponents
  //                          type — one row each.
  //   tables.length        — custom tables matching publisherPrefix.
  //   envVarCount          — envvar definitions matching publisherPrefix.
  //   cloudFlowLinks       — classified.cloudFlowLinks is type-33 ppcs but
  //                          we're using its length as a 1:1 proxy for the
  //                          Workflow entity count. Not a double-count with
  //                          ppcs.length: that sum covers the ppc binding,
  //                          this term covers the distinct Workflow record.
  //   bots / botComponents — resolved by schema-name match through the
  //                          site's type-27 ppcs; adds the env-level Bot +
  //                          BotComponent entity rows.
  //
  // For the live SIP reference site in dev (org1e98cc97), this sum evaluates
  // to 393 + 11 + 1 + 2 + 2 + 30 = 439. Connection references (4) and the
  // website record itself (1) are NOT included — they're env-/site-level
  // artifacts and not derivable without separate queries.
  //
  // Raw site inventory — every ppc and related artifact, no filtering. Matches
  // the Dataverse view of the site. Bundle-chunk noise is surfaced separately
  // (bundleChunkCount) so consumers can reason about it without us silently
  // subtracting it here. Earlier revisions subtracted chunks to get an
  // "actionable" count, but that made the siteTotal non-comparable to the
  // solution count in Dataverse (which does include chunk members).
  const bundleChunkCount = classified.bundleChunks.length;
  // Power Pages 3-entity site model: ppcs (10426) + 1 site root (10427) +
  // siteLanguages (10428). All three live in the user solution, so the site
  // total must include all three for parity with componentCountInSolution.
  const websiteRootCount = 1;
  const siteLanguageCount = siteLanguages.length;
  const siteTotalComponents =
    ppcs.length +
    websiteRootCount +
    siteLanguageCount +
    tables.length +
    envVarCount +
    classified.cloudFlowLinks.length +
    (botsAndComponents.bots.length || 0) +
    (botsAndComponents.botComponents.length || 0);

  // "Actionable" site inventory — excludes bundle-chunk ppcs that are stale
  // leftovers from prior `pac pages upload-code-site` runs. Useful when the
  // user wants to know "how many real components do I have" vs. "how many
  // rows exist in Dataverse".
  const siteActionableComponents = siteTotalComponents - bundleChunkCount;

  // ── Truncation canary ───────────────────────────────────────────────────
  // Evaluate signals that suggest pagination silently truncated the inventory.
  // Three independent checks; any one being true sets `truncationSuspected`.
  //   (a) The Dataverse `@odata.count` for powerpagecomponents disagrees with
  //       what we actually fetched (>5% gap). Strongest possible signal.
  //   (b) ppcs.length lands on an exact multiple of the page size (5000/10000/
  //       15000/...). Could be coincidence but is very rare for real sites.
  //   (c) ppcs.length is exactly at one of the historical legacy paging
  //       boundaries (500/1000/2000) — guards against future code that
  //       accidentally drops the `Prefer: odata.maxpagesize` header again.
  // Each true signal contributes a string to `truncationWarnings[]` so
  // compute-split-plan + plan-alm can surface the specific reason.
  const truncationWarnings = [];
  if (
    typeof ppcGroundTruthCount === 'number' &&
    ppcGroundTruthCount > 0 &&
    Math.abs(ppcGroundTruthCount - ppcs.length) > Math.max(5, ppcGroundTruthCount * 0.05)
  ) {
    truncationWarnings.push(
      `Dataverse reports ${ppcGroundTruthCount} powerpagecomponent rows for this site, but the discovery query returned ${ppcs.length}. Pagination is truncating — estimator size/component counts WILL be wrong.`,
    );
  }
  const PAGE_SIZE_MULTIPLES = [
    ODATA_MAX_PAGE_SIZE, ODATA_MAX_PAGE_SIZE * 2, ODATA_MAX_PAGE_SIZE * 3,
    ODATA_MAX_PAGE_SIZE * 4, ODATA_MAX_PAGE_SIZE * 5,
  ];
  if (PAGE_SIZE_MULTIPLES.includes(ppcs.length)) {
    truncationWarnings.push(
      `ppcs.length is exactly ${ppcs.length} (= ${ppcs.length / ODATA_MAX_PAGE_SIZE} full page${ppcs.length === ODATA_MAX_PAGE_SIZE ? '' : 's'} of size ${ODATA_MAX_PAGE_SIZE}). Verify the next page wasn't dropped — compare against \`$count=true\` for the same filter.`,
    );
  }
  const LEGACY_BOUNDARIES = [500, 1000, 2000];
  if (LEGACY_BOUNDARIES.includes(ppcs.length)) {
    truncationWarnings.push(
      `ppcs.length is exactly ${ppcs.length} — a historical paging boundary from an older $top value. Suggests the \`Prefer: odata.maxpagesize\` header has regressed; verify odataGetPath still sends it.`,
    );
  }

  // ── Web-file undercount canaries ────────────────────────────────────────
  // Two independent signals that the Dataverse-measured web-file size is
  // likely an undercount. The classic failure mode: `mspp_webfile` payload
  // bytes live in a file-typed column (e.g. `documentbody`) whose contents
  // are NOT returned by `$select=content`. The estimator scales up a
  // metadata-only response and reports a number much smaller than reality.
  const webFilesAggregateMB = webFilesAggregateBytes / (1024 * 1024);
  const webFileCount = classified.webFiles.length;
  if (
    webFilesDiskMeasuredMB != null &&
    webFilesDiskMeasuredMB > 5 &&
    webFilesAggregateMB < 0.5 * webFilesDiskMeasuredMB
  ) {
    // The disk total is the byte sum of EVERY file under the build output dir —
    // including HTML pages, source maps, and other artifacts that Power Pages
    // doesn't ship as `powerpagecomponents` type-3 web files (HTML uploads as
    // type-2 web pages instead). For HTML-dominated code sites, the disk total
    // can legitimately exceed the Dataverse web-files total without indicating
    // an undercount. The strong signal is when disk ≫ Dataverse AND the
    // dominant disk content is media/assets (image/font/binary extensions),
    // which is the file-typed-column case. The warning copy below reflects the
    // dominant-case interpretation but reviewers should sanity-check by
    // inspecting `webFilesDiskMeasuredPath` for HTML-heavy content.
    truncationWarnings.push(
      `Web-file content from Dataverse (${webFilesAggregateMB.toFixed(1)} MB across ${webFileCount} files) is much smaller than the local build output (${webFilesDiskMeasuredMB.toFixed(1)} MB at ${webFilesDiskMeasuredPath}). Most likely cause: the site's web file payloads live in a file-typed column whose bytes are not returned via $select=content — solution size is under-estimated and you should trust the disk-measured number. Alternate explanation if the disk content is HTML-dominated: HTML files are uploaded as type-2 web pages (not type-3 web files), so disk > Dataverse can be legitimate; inspect the directory if the disk total looks higher than expected for your media assets.`,
    );
  }
  if (
    classified.webFiles.length > 20 &&
    sampleSize > 0 &&
    (webMeasure.aggregateBytes / sampleSize) < 1024
  ) {
    truncationWarnings.push(
      `Sampled ${sampleSize} of ${webFileCount} web files, but the average measured size is suspiciously small (<1 KB/file). The site's web file payloads may live in file-typed columns whose bytes are not returned via $select=content. The estimator's webFilesAggregateMB is likely an undercount.`,
    );
  }
  const truncationSuspected = truncationWarnings.length > 0;

  return {
    siteName: siteName || null,
    publisherPrefix: publisherPrefix || null,
    solutionId: solutionId || null,
    totalSizeMB: round1(totalSizeMB),
    // componentCountSiteTotal is the RAW site inventory — one count per
    // Dataverse row. Matches what the Power Platform Maker UI would show
    // if the whole site were added to a solution. Bundle chunks are included
    // here because they're real rows in the site's `powerpagecomponents`.
    componentCountSiteTotal: siteTotalComponents,
    // Sub-count that strips bundle-chunk noise (stale .js/.css from prior
    // `pac pages upload-code-site` runs) for people who want the
    // "actionable content" view.
    componentCountSiteActionable: siteActionableComponents,
    // componentCountInSolution matches the raw solutioncomponents row count
    // for the target solution — i.e. what the Maker UI "Objects" page shows.
    // Bundle chunks that were added to the solution count as members here;
    // they ship with the managed solution when exported.
    componentCountInSolution: inSolution ? inSolution.total : null,
    // Orphans = ppcs on the site that the solution does not own. Bundle
    // chunks are excluded from orphans since they're stale upload artifacts,
    // not content gaps. If you want the strict diff, compare
    // componentCountSiteTotal - componentCountInSolution yourself.
    orphansOnSite: inSolution
      ? Math.max(siteActionableComponents - inSolution.total, 0)
      : null,
    botCountScoped: botsAndComponents.bots.length || 0,
    botComponentCountScoped: botsAndComponents.botComponents.length || 0,
    bundleChunkCount,
    bundleChunkNote: bundleChunkCount > 0
      ? `${bundleChunkCount} hashed bundle chunks (Vite/Rollup) on the site — ${bundleChunksInSolution} are in the solution, ${bundleChunkCount - bundleChunksInSolution} are orphans from prior pac pages upload-code-site runs. Cleanable via dedicated cleanup pass.`
      : null,
    inSolution: inSolution
      ? {
          total: inSolution.total,
          byComponentType: inSolution.byComponentType,
          bundleChunksInSolution,
          crossSitePpcCount: (inSolution.crossSitePpcs || []).length,
          crossSitePpcWarning:
            inSolution.crossSitePpcs && inSolution.crossSitePpcs.length > 0
              ? `⚠ ${inSolution.crossSitePpcs.length} powerpagecomponent row(s) in this solution do not belong to site ${websiteRecordId}. The solution may contain components from a different site. Re-check the site scope before exporting.`
              : null,
          // objectIds intentionally omitted from JSON output to keep it small;
          // callers that need diffing should use discover-site-components.js.
        }
      : null,
    tableCount: tables.length,
    // How the table set was scoped: "site-referenced" (table permissions),
    // "manifest-only" (datamodel manifest, no permissions), or "unavailable"
    // (no local signal — tableCount reflects 0, NOT a publisher-prefix dump).
    tableCountScope,
    schemaAttrCount,
    webFilesAggregateMB: round1(webFilesAggregateBytes / (1024 * 1024)),
    webFilesIndividual: webMeasure.individual,
    webFileCount: classified.webFiles.length,
    // Stratified sample bookkeeping — surfaces how many ppcs the per-file
    // content fetch actually visited. Compared with webFileCount this tells
    // callers how aggressively the aggregate-bytes number was extrapolated.
    webFileSampleSize: sampleSize,
    // Disk-measurement cross-check fields. Null unless `--projectRoot` was
    // passed AND a build-output directory was found. Surfaced for callers to
    // sanity-check `webFilesAggregateMB`; we intentionally do NOT substitute
    // this value into `webFilesAggregateMB` because the Dataverse-measured
    // number is still the authoritative size for what ships in the solution.
    webFilesDiskMeasuredMB,
    webFilesDiskMeasuredPath,
    webFilesDiskFileCount,
    cloudFlowCount: classified.cloudFlowLinks.length,
    botCount: classified.botConsumers.length,
    // envVarCount is the count consumers should drive display + decision logic
    // off of. It reflects the most accurate scope available: solution-scoped
    // when --solutionId was provided, publisher-prefix tenant-wide otherwise.
    envVarCount,
    // envVarCountScope explains where the number came from. 'solution' is the
    // accurate path; 'publisher-prefix' is the fallback for fresh projects
    // where no solution exists yet and is necessarily a wider scope.
    envVarCountScope,
    // envVarCountTenantWide preserves the prefix-wide count for diagnostic
    // purposes — e.g. flagging cases where the tenant has 500x more env vars
    // matching the prefix than the solution actually contains (common when
    // the prefix is shared across projects). Always surfaced regardless of
    // scope so reviewers can spot the divergence.
    envVarCountTenantWide,
    mediaRatio: Math.round(webMeasure.mediaRatio * 100) / 100,
    // Build-axis label: 'code' | 'declarative' | 'unknown' (was hardcoded
    // 'code-site', which mislabeled every declarative/EDM site). Prefers the
    // caller-supplied --siteType (plan-alm Phase 1), falls back to a local marker probe.
    siteType: resolveSiteType(siteType, projectRoot),
    tables: tables.map((t) => ({ logicalName: t.logicalName, attributeCount: t.attributeCount || 0 })),
    // Dependency edges among the scoped tables ([a,b], lowercased, a<b) — consumed
    // by compute-split-plan.js to cluster related tables into the same solution.
    tableRelationships,
    breakdown: {
      tables: round1((tables.length * BYTES_PER.table + schemaAttrCount * BYTES_PER.attribute) / (1024 * 1024)),
      webFiles: round1(webFilesAggregateBytes / (1024 * 1024)),
      siteSettings: round1((classified.siteSettings.length * BYTES_PER.sitesetting) / (1024 * 1024)),
      cloudFlows: round1((classified.cloudFlowLinks.length * BYTES_PER.cloudflow) / (1024 * 1024)),
      webRolesAndPermissions: round1(
        ((classified.webRoles.length * BYTES_PER.webrole) +
          (classified.tablePermissions.length * BYTES_PER.tablepermission)) /
          (1024 * 1024),
      ),
      envVars: round1((envVarCount * BYTES_PER.envvarDef) / (1024 * 1024)),
      otherMetadata: round1(
        (((classified.webPages.length * BYTES_PER.webpage) +
          (classified.webTemplates.length * BYTES_PER.webtemplate) +
          (classified.botConsumers.length * BYTES_PER.bot))) /
          (1024 * 1024),
      ),
    },
    estimationMethod: 'metadata-based',
    estimationAccuracyPct: 15,
    // Truncation canary — see the canary block above. Consumers
    // (compute-split-plan, plan-alm) MUST surface these warnings rather than
    // silently producing recommendations from possibly-truncated inputs.
    truncationSuspected,
    truncationWarnings,
    // Ground-truth row count from Dataverse — null when the count probe
    // failed (auth lapse, server transient error). Compute-split-plan uses
    // this to confirm estimator inputs make sense.
    ppcGroundTruthCount,
  };
}

function round1(n) {
  return Math.round((Number(n) || 0) * 10) / 10;
}

// CLI entry point
if (require.main === module) {
  const args = parseArgs(process.argv);
  estimateSolutionSize(args)
    .then((result) => {
      process.stdout.write(JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    });
}

module.exports = {
  estimateSolutionSize,
  estimateTotalSize,
  classifyPPCs,
  countSolutionMembership,
  isProbablyBundleChunk,
  resolveSiteType,
  parseArgs,
  BYTES_PER,
};
