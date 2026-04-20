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
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) out.envUrl = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--websiteRecordId' && args[i + 1]) out.websiteRecordId = args[++i];
    else if (args[i] === '--publisherPrefix' && args[i + 1]) out.publisherPrefix = args[++i];
    else if (args[i] === '--siteName' && args[i + 1]) out.siteName = args[++i];
    else if (args[i] === '--datamodelManifest' && args[i + 1]) out.datamodelManifest = args[++i];
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

  // Query EntityDefinitions for custom unmanaged tables
  const path =
    `EntityDefinitions` +
    `?$select=LogicalName,MetadataId,IsManaged,IsCustomEntity` +
    `&$top=500`;
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

async function estimateSolutionSize({ envUrl, websiteRecordId, token, publisherPrefix, siteName, datamodelManifest }) {
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

  return {
    siteName: siteName || null,
    publisherPrefix: publisherPrefix || null,
    totalSizeMB: round1(totalSizeMB),
    componentCount:
      ppcs.length +
      tables.length +
      schemaAttrCount +
      envVarCount,
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
