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
const { getAuthToken, makeRequest } = helpers;

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
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) out.envUrl = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--websiteRecordId' && args[i + 1]) out.websiteRecordId = args[++i];
    else if (args[i] === '--publisherPrefix' && args[i + 1]) out.publisherPrefix = args[++i];
    else if (args[i] === '--siteName' && args[i + 1]) out.siteName = args[++i];
    else if (args[i] === '--datamodelManifest' && args[i + 1]) out.datamodelManifest = args[++i];
    else if (args[i] === '--solutionId' && args[i + 1]) out.solutionId = args[++i];
  }
  return out;
}

async function odataGet(envUrl, path, token) {
  const url = path.startsWith('http') ? path : `${envUrl}/api/data/v9.2/${path.replace(/^\//, '')}`;
  const res = await makeRequest({
    url,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
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

async function collectPaginated(envUrl, path, token, maxPages = 20) {
  let next = path;
  const items = [];
  for (let p = 0; p < maxPages && next; p++) {
    const page = await odataGet(envUrl, next, token);
    if (Array.isArray(page.value)) items.push(...page.value);
    next = page['@odata.nextLink'] || null;
  }
  return items;
}

/**
 * Discovers bots + bot components linked to the site.
 *
 * Power Pages bot linkage: each site has `powerpagecomponent` rows of type 27
 * (Bot Consumer). Each consumer references a bot by its schemaname stored in
 * the ppc `name` field. We use those names to scope the bot query so we only
 * count bots actually attached to this site, not every bot in the env.
 *
 * Each bot has child `botcomponent` rows (topics, entities, gpt defs). Both
 * bots and bot components become separate `solutioncomponents` rows when added
 * to a solution (types 10137 and 10193). Counting them here closes the
 * siteTotal gap that previously made orphansOnSite look artificially small.
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
    `powerpagecomponents?$filter=${idFilter}&$select=powerpagecomponentid,content&$top=500`;
  let enriched;
  try {
    enriched = await collectPaginated(envUrl, withContentPath, token, 2);
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
    `bots?$filter=${botFilter}&$select=botid,name,schemaname&$top=500`;
  let bots = [];
  try {
    bots = await collectPaginated(envUrl, botsPath, token, 3);
  } catch {
    // Bots may be unavailable in some tenants (privilege / feature gating).
    // Don't fail the whole estimate — surface as zero and move on.
    return { bots: [], botComponents: [] };
  }
  if (bots.length === 0) return { bots: [], botComponents: [] };

  const botIds = bots.map((b) => b.botid).filter(Boolean);
  const compFilter = botIds.map((id) => `_parentbotid_value eq ${id}`).join(' or ');
  const compsPath =
    `botcomponents?$filter=${compFilter}&$select=botcomponentid&$top=5000`;
  let botComponents = [];
  try {
    botComponents = await collectPaginated(envUrl, compsPath, token, 5);
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
    `&$top=500`;
  return collectPaginated(envUrl, path, token, 40);
}

async function discoverTables(envUrl, publisherPrefix, token, manifestPath) {
  // Try manifest first
  const fs = require('fs');
  let manifestTables = [];
  if (manifestPath && fs.existsSync(manifestPath)) {
    try {
      const man = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const entries = man.entities || man.tables || [];
      manifestTables = entries.map((e) => ({
        logicalName: e.logicalName || e.LogicalName || e.name,
        metadataId: e.metadataId || e.MetadataId,
      }));
    } catch {}
  }

  // Query EntityDefinitions for custom unmanaged tables.
  // Verified 2026-04-22 against org1e98cc97 (v9.2): EntityDefinitions does NOT
  // support `$top` (returns 400 "The query parameter $top is not supported").
  // We filter server-side to IsCustomEntity=true to keep the payload bounded —
  // there's still no client-side pagination needed for typical tenants.
  const path =
    `EntityDefinitions` +
    `?$filter=IsCustomEntity eq true` +
    `&$select=LogicalName,MetadataId,IsManaged,IsCustomEntity`;
  const all = await collectPaginated(envUrl, path, token, 10);
  const custom = all.filter((e) => e.IsCustomEntity === true && e.IsManaged === false);
  const matchingPrefix = publisherPrefix
    ? custom.filter((e) => (e.LogicalName || '').toLowerCase().startsWith(`${publisherPrefix.toLowerCase()}_`))
    : custom;

  const byName = new Map();
  for (const t of [...manifestTables, ...matchingPrefix.map((e) => ({
    logicalName: e.LogicalName,
    metadataId: e.MetadataId,
  }))]) {
    if (t.logicalName && !byName.has(t.logicalName)) byName.set(t.logicalName, t);
  }
  return Array.from(byName.values());
}

async function countAttributesForTables(envUrl, tables, token) {
  let total = 0;
  for (const t of tables) {
    try {
      const page = await odataGet(
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
    `environmentvariabledefinitions?$select=schemaname,displayname,type${filter}&$top=2000`;
  const items = await collectPaginated(envUrl, path, token, 20);
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
  const individual = [];
  let aggregateBytes = 0;
  let imgOrFontBytes = 0;

  for (const wf of webFiles) {
    const id = wf.powerpagecomponentid;
    try {
      const rec = await odataGet(
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
    mediaRatio: aggregateBytes > 0 ? imgOrFontBytes / aggregateBytes : 0,
  };
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
  const res = await makeRequest({
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

async function estimateSolutionSize({ envUrl, websiteRecordId, token, publisherPrefix, siteName, datamodelManifest, solutionId }) {
  if (!envUrl || !websiteRecordId) {
    throw new Error('--envUrl and --websiteRecordId are required');
  }
  const resolved = token || getAuthToken(envUrl);
  if (!resolved) {
    throw new Error('Failed to acquire Azure CLI token. Run `az login` first.');
  }

  const ppcs = await discoverPowerPageComponents(envUrl, websiteRecordId, resolved);
  const classified = classifyPPCs(ppcs);

  const tables = await discoverTables(envUrl, publisherPrefix, resolved, datamodelManifest);
  const schemaAttrCount = await countAttributesForTables(envUrl, tables, resolved);

  const envVarCount = await countEnvVarDefinitions(envUrl, publisherPrefix, resolved);

  // Bot + bot components — scoped to bots referenced by this site's
  // type-27 bot consumer ppcs so env-wide bots don't inflate the count.
  const botsAndComponents = await discoverBotsAndComponents(
    envUrl,
    classified.botConsumers,
    resolved,
  );

  const webFileSample = classified.webFiles.slice(0, 80); // sample up to 80 web files for sizing
  const webMeasure = await measureWebFiles(envUrl, webFileSample, resolved);

  // Scale measured bytes to full web file count if we sampled
  const scaleFactor =
    classified.webFiles.length > 0 && webFileSample.length > 0
      ? classified.webFiles.length / webFileSample.length
      : 1;
  const webFilesAggregateBytes = webMeasure.aggregateBytes * scaleFactor;

  const totalSizeMB = estimateTotalSize({
    classified,
    tables,
    schemaAttrCount,
    webFilesAggregateBytes,
    envVarCount,
  });

  // Optional: when caller passes --solutionId, also report what's actually
  // in the solution vs. site-total. Fixes the 908-on-site / 361-in-solution
  // ambiguity that previously caused plan docs to overstate solution size.
  //
  // Also provides the site's ppc id set as a cross-site safety check — if any
  // type-10373 rows in the solution aren't on this site, we surface that as
  // a warning in the output rather than silently miscounting.
  const sitePpcIdSet = new Set(
    ppcs.map((p) => (p.powerpagecomponentid || '').toLowerCase()).filter(Boolean),
  );
  const inSolutionRaw = solutionId
    ? await countSolutionMembership(envUrl, solutionId, resolved, sitePpcIdSet)
    : null;

  // Exclude bundle chunks from inSolution too so the comparison stays
  // apples-to-apples with siteTotal. Without this, solutions that shipped
  // last week's bundle chunks (still living in Dataverse even though
  // superseded on-site) make inSolution look artificially larger.
  let inSolution = inSolutionRaw;
  let bundleChunksInSolution = 0;
  if (inSolutionRaw && classified.bundleChunks.length > 0) {
    const chunkIdSet = new Set(
      classified.bundleChunks.map((c) => (c.powerpagecomponentid || '').toLowerCase()),
    );
    const inSolIds = new Set(inSolutionRaw.objectIds || []);
    for (const id of chunkIdSet) {
      if (inSolIds.has(id)) bundleChunksInSolution += 1;
    }
    inSolution = {
      ...inSolutionRaw,
      total: Math.max(inSolutionRaw.total - bundleChunksInSolution, 0),
      totalRawIncludingBundleChunks: inSolutionRaw.total,
      bundleChunksInSolution,
    };
  }

  // Component count must match what Dataverse `solutioncomponents` counts —
  // each table is ONE component (attributes ride along, not counted separately).
  // Earlier versions added `schemaAttrCount` which inflated the total by 3–5×
  // on schema-heavy sites (e.g. 503 attrs pushed the count from 405 → 908).
  //
  // Each constant here maps directly to a `componenttype`:
  //   ppcs.length          → componenttype 10373 (site sub-components)
  //   tables.length        → componenttype 1 (Entity) — attributes NOT added
  //   envVarCount          → componenttype 380 (env var definition)
  //   classified.cloudFlowLinks.length → componenttype 29 via the workflow
  //                            (the type-33 ppc binding is already in ppcs.length)
  //   classified.botConsumers.length → counted once (as ppc type 27 in ppcs.length)
  //   botsAndComponents.bots.length → componenttype 10137 (Bot)
  //   botsAndComponents.botComponents.length → componenttype 10193 (Bot Component)
  //
  // Before adding bot queries on 2026-04-22, bots + bot components were a known
  // undercount. Live SIP site had 4 bots + 30 components missing from siteTotal,
  // making orphansOnSite (46) misleadingly small. With bot queries enabled,
  // siteTotal now includes them and orphansOnSite reflects reality.
  //
  // Subtract bundle chunks (Vite/Rollup hashed .js/.css). Those accumulate as
  // dead orphans with every `pac pages upload-code-site` rebuild and don't
  // represent real site inventory — they're noise, not content.
  const bundleChunkCount = classified.bundleChunks.length;
  const siteTotalComponents =
    ppcs.length -
    bundleChunkCount +
    tables.length +
    envVarCount +
    classified.cloudFlowLinks.length +
    (botsAndComponents.bots.length || 0) +
    (botsAndComponents.botComponents.length || 0);

  return {
    siteName: siteName || null,
    publisherPrefix: publisherPrefix || null,
    solutionId: solutionId || null,
    totalSizeMB: round1(totalSizeMB),
    componentCount: siteTotalComponents,
    componentCountSiteTotal: siteTotalComponents,
    componentCountInSolution: inSolution ? inSolution.total : null,
    orphansOnSite: inSolution ? Math.max(siteTotalComponents - inSolution.total, 0) : null,
    botCountScoped: botsAndComponents.bots.length || 0,
    botComponentCountScoped: botsAndComponents.botComponents.length || 0,
    bundleChunkCount,
    bundleChunkNote: bundleChunkCount > 0
      ? `${bundleChunkCount} hashed bundle chunks (Vite/Rollup) excluded from siteTotal — they're stale orphans from prior pac pages upload-code-site runs. Cleanable via dedicated cleanup pass (not yet implemented).`
      : null,
    inSolution: inSolution
      ? {
          total: inSolution.total,
          byComponentType: inSolution.byComponentType,
          totalRawIncludingBundleChunks: inSolution.totalRawIncludingBundleChunks,
          bundleChunksInSolution: inSolution.bundleChunksInSolution,
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
    schemaAttrCount,
    webFilesAggregateMB: round1(webFilesAggregateBytes / (1024 * 1024)),
    webFilesIndividual: webMeasure.individual,
    webFileCount: classified.webFiles.length,
    cloudFlowCount: classified.cloudFlowLinks.length,
    botCount: classified.botConsumers.length,
    envVarCount,
    mediaRatio: Math.round(webMeasure.mediaRatio * 100) / 100,
    siteType: 'code-site',
    tables: tables.map((t) => ({ logicalName: t.logicalName, attributeCount: t.attributeCount || 0 })),
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
  BYTES_PER,
};
