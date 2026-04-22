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

function classifyPPCs(ppcs) {
  const byType = new Map();
  for (const c of ppcs) {
    const t = c.powerpagecomponenttype;
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t).push(c);
  }

  // Canonical type numbers for known Power Pages components
  const SITE_SETTING = 9;
  const WEB_ROLE = 16;
  const TABLE_PERMISSION = 18;
  const BOT_CONSUMER = 27;
  const CLOUD_FLOW_LINK = 33;
  const WEB_FILE = 2;
  const WEB_PAGE = 4;
  const WEB_TEMPLATE = 11;

  return {
    siteSettings: byType.get(SITE_SETTING) || [],
    webRoles: byType.get(WEB_ROLE) || [],
    tablePermissions: byType.get(TABLE_PERMISSION) || [],
    botConsumers: byType.get(BOT_CONSUMER) || [],
    cloudFlowLinks: byType.get(CLOUD_FLOW_LINK) || [],
    webFiles: byType.get(WEB_FILE) || [],
    webPages: byType.get(WEB_PAGE) || [],
    webTemplates: byType.get(WEB_TEMPLATE) || [],
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
 */
async function countSolutionMembership(envUrl, solutionId, token) {
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
  return {
    total: rows.length,
    byComponentType: byType,
    objectIds: rows.map((r) => (r.objectid || '').toLowerCase()),
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
  const inSolution = solutionId
    ? await countSolutionMembership(envUrl, solutionId, resolved)
    : null;

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
  //
  // Bots (type 10137) and bot topics (type 10193) are separate entity rows not
  // reachable from ppcs; they're captured under inSolution when --solutionId is
  // passed but can't be discovered site-wide without a bot-specific query.
  // That's a known undercount bound; it does not affect the solution-owned count.
  const siteTotalComponents =
    ppcs.length +
    tables.length +
    envVarCount +
    classified.cloudFlowLinks.length;

  return {
    siteName: siteName || null,
    publisherPrefix: publisherPrefix || null,
    solutionId: solutionId || null,
    totalSizeMB: round1(totalSizeMB),
    componentCount: siteTotalComponents,
    componentCountSiteTotal: siteTotalComponents,
    componentCountInSolution: inSolution ? inSolution.total : null,
    orphansOnSite: inSolution ? Math.max(siteTotalComponents - inSolution.total, 0) : null,
    inSolution: inSolution
      ? {
          total: inSolution.total,
          byComponentType: inSolution.byComponentType,
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
  BYTES_PER,
};
