#!/usr/bin/env node

// Runs the solution split decision tree against a size-estimate blob.
//
// Usage:
//   node compute-split-plan.js --estimate <path-to-estimate.json> [--projectRoot <path>]
//
// Inputs:
//   estimate.json — output of estimate-solution-size.js
//   .alm-config.json — optional, loaded from projectRoot if present
//
// Outputs JSON to stdout:
//   {
//     sizeAnalysis: { ...computed tier classifications },
//     assetAdvisory: { candidates: [...], recommendation, enabled },
//     splitStrategy: "single" | "strategy-1-layer" | "strategy-2-change-frequency"
//                    | "strategy-3-schema-segmentation" | "strategy-4-config-isolation",
//     appliedStrategies: [...]  // includes strategy-4 additive if applicable
//     proposedSolutions: [ { uniqueName, displayName, order, components, sizeMB, componentCount, ... } ],
//     recommendations: [ { type, message } ]
//   }

'use strict';

const fs = require('fs');
const path = require('path');
const { loadConfig, classifyTier } = require('./alm-thresholds');

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { estimate: null, projectRoot: null, publisherPrefix: null, siteName: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--estimate' && args[i + 1]) out.estimate = args[++i];
    else if (args[i] === '--projectRoot' && args[i + 1]) out.projectRoot = args[++i];
    else if (args[i] === '--publisherPrefix' && args[i + 1]) out.publisherPrefix = args[++i];
    else if (args[i] === '--siteName' && args[i + 1]) out.siteName = args[++i];
  }
  return out;
}

// --- Tier classification ----------------------------------------------------

function buildSizeAnalysis(estimate, thresholds) {
  return {
    totalSizeMB: {
      value: estimate.totalSizeMB,
      tier: classifyTier(estimate.totalSizeMB, 60, thresholds.maxSolutionSizeMB),
    },
    componentCount: {
      value: estimate.componentCountSiteTotal,
      tier: classifyTier(
        estimate.componentCountSiteTotal,
        thresholds.warnComponentCount,
        thresholds.maxComponentCount,
      ),
    },
    schemaAttrCount: {
      value: estimate.schemaAttrCount,
      tier: classifyTier(estimate.schemaAttrCount, 5000, thresholds.maxSchemaAttrs),
    },
    tableCount: {
      value: estimate.tableCount,
      tier: classifyTier(estimate.tableCount, 10, thresholds.maxTableCount),
    },
    webFilesAggregateMB: {
      value: estimate.webFilesAggregateMB,
      tier: classifyTier(estimate.webFilesAggregateMB, 20, thresholds.maxAggregateWebFilesMB),
    },
    envVarCount: {
      value: estimate.envVarCount,
      tier: classifyTier(estimate.envVarCount, 50, thresholds.maxEnvVarCount),
    },
  };
}

// --- Gate A: Asset Advisory -------------------------------------------------

function computeAssetAdvisory(estimate, config) {
  if (!config.assetAdvisory.enabled || config.assetAdvisory.preferredStorage === 'none') {
    return { enabled: false, candidates: [], recommendation: null };
  }

  const excludePatterns = config.assetAdvisory.excludePatterns || [];
  const matchesExclude = (name) =>
    excludePatterns.some((pat) => {
      const re = globToRegex(pat);
      return re.test(name);
    });

  const threshold = config.thresholds.maxSingleFileMB;
  const storagePriority = config.assetAdvisory.preferredStorage === 'cdn'
    ? ['cdn', 'azure-blob']
    : ['azure-blob', 'cdn'];

  const candidates = (estimate.webFilesIndividual || [])
    .filter((f) => f.sizeMB >= threshold && !matchesExclude(f.name))
    .map((f) => ({
      name: f.name,
      sizeMB: f.sizeMB,
      currentPath: f.currentPath || f.name,
      classification: classifyFile(f.name),
      recommendation: storagePriority[0],
      suggestedUrlFormat: storagePriority[0] === 'azure-blob'
        ? `https://{account}.blob.core.windows.net/{container}/${basename(f.name)}`
        : `https://{cdn-host}/${basename(f.name)}`,
      rationale: buildRationale(f, storagePriority[0]),
    }));

  let recommendation = null;
  if (
    estimate.webFilesAggregateMB > config.thresholds.maxAggregateWebFilesMB &&
    estimate.mediaRatio > config.thresholds.mediaRatioTrigger
  ) {
    recommendation = 'externalize-media';
  }

  return { enabled: true, candidates, recommendation };
}

function globToRegex(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '__DOUBLESTAR__')
    .replace(/\*/g, '[^/]*')
    .replace(/__DOUBLESTAR__/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

function basename(p) {
  return String(p).split(/[\\/]/).pop();
}

function classifyFile(name) {
  const lower = String(name).toLowerCase();
  if (/\.(png|jpe?g|gif|webp|svg|bmp|ico)$/.test(lower)) return 'image-media';
  if (/\.(woff2?|ttf|otf|eot)$/.test(lower)) return 'font';
  if (/\.(mp4|webm|mov|avi)$/.test(lower)) return 'video';
  if (/\.(pdf|docx?|xlsx?|pptx?)$/.test(lower)) return 'document';
  if (/\.js$/.test(lower)) return 'script';
  if (/\.css$/.test(lower)) return 'stylesheet';
  return 'other';
}

function buildRationale(file, storage) {
  const cls = classifyFile(file.name);
  const parts = [`${cls === 'image-media' ? 'Large image' : 'Large file'} (${file.sizeMB.toFixed(1)} MB).`];
  if (storage === 'azure-blob') {
    parts.push('Private access via SAS preserves any auth requirements.');
  } else {
    parts.push('Public CDN URL improves edge latency.');
  }
  if (cls === 'image-media' && /\.(png|jpe?g)$/i.test(file.name)) {
    parts.push('Consider WebP conversion before upload (est. 30–70% reduction).');
  }
  return parts.join(' ');
}

// --- Gate B: Strategy selection --------------------------------------------

function selectStrategy(estimate, config) {
  const t = config.thresholds;

  if (config.strategyOverride) {
    return { primary: config.strategyOverride, additive: false };
  }

  const hasSchemaHeavy =
    estimate.schemaAttrCount > t.maxSchemaAttrs || estimate.tableCount > t.maxTableCount;
  const isWebHeavy =
    estimate.totalSizeMB > t.maxSolutionSizeMB &&
    estimate.totalSizeMB <= t.sizeExceedsCapUpperBound &&
    estimate.webFilesAggregateMB > t.webFileDominanceRatio * estimate.totalSizeMB;
  // Hard-flag counts still route to Strategy 2 — a split is the best option we have. The
  // hard-flag warning is added separately in buildRecommendations.
  const isComponentHeavy =
    estimate.componentCountSiteTotal > t.maxComponentCount ||
    (estimate.cloudFlowCount > t.changeFreqMinFlows && estimate.totalSizeMB > t.changeFreqMinSizeMB);
  const hasManyEnvVars = estimate.envVarCount > t.maxEnvVarCount;

  let primary = 'single';
  if (hasSchemaHeavy) primary = 'strategy-3-schema-segmentation';
  else if (isWebHeavy) primary = 'strategy-1-layer';
  else if (isComponentHeavy) primary = 'strategy-2-change-frequency';
  else if (hasManyEnvVars) primary = 'strategy-4-config-isolation';

  const additive = hasManyEnvVars && primary !== 'single' && primary !== 'strategy-4-config-isolation';

  return { primary, additive };
}

// --- Partitioning -----------------------------------------------------------

function partitionBySingle(estimate, meta) {
  return [
    {
      uniqueName: meta.baseName,
      displayName: meta.siteName,
      order: 1,
      componentTypes: ['All'],
      description:
        'All components packaged in a single managed solution. Estimated size is within recommended thresholds.',
      sizeMB: estimate.totalSizeMB,
      componentCount: estimate.componentCountSiteTotal,
      components: [],
    },
  ];
}

function partitionByLayer(estimate, meta) {
  const coreSize = Math.max(estimate.totalSizeMB - estimate.webFilesAggregateMB, 0);
  const coreCount = Math.max(estimate.componentCountSiteTotal - (estimate.webFileCount || 0), 0);
  return [
    {
      uniqueName: `${meta.baseName}_Core`,
      displayName: `${meta.siteName} — Core`,
      order: 1,
      componentTypes: ['Table', 'Site Setting', 'Web Role', 'Table Permission', 'Cloud Flow', 'Environment Variable', 'Bot Component'],
      description:
        'Tables, security, integrations, site settings, environment variables. Low change frequency.',
      sizeMB: round(coreSize),
      componentCount: coreCount,
      components: [],
    },
    {
      uniqueName: `${meta.baseName}_WebAssets`,
      displayName: `${meta.siteName} — Web Assets`,
      order: 2,
      componentTypes: ['Web File'],
      description:
        'Web files (media, content uploads tracked in powerpagecomponent). High change frequency — deploy independently.',
      sizeMB: round(estimate.webFilesAggregateMB),
      componentCount: estimate.webFileCount || 0,
      components: [],
    },
  ];
}

function partitionByChangeFrequency(estimate, meta) {
  const foundationCount = Math.ceil(estimate.componentCountSiteTotal * 0.15);
  const integrationCount = estimate.cloudFlowCount + estimate.botCount;
  const configCount = Math.ceil(estimate.componentCountSiteTotal * 0.1);
  const contentCount = Math.max(
    estimate.componentCountSiteTotal - foundationCount - integrationCount - configCount,
    0,
  );

  // Derive size from count shares so size and componentCount stay self-consistent.
  // Avoids the earlier bug where fixed 25/20/10/45% size fractions didn't track the
  // count allocation and confused users reading the HTML.
  const totalCounts = foundationCount + integrationCount + configCount + contentCount;
  const sizePerCount = totalCounts > 0 ? estimate.totalSizeMB / totalCounts : 0;
  const sizeFor = (n) => round(n * sizePerCount);

  return [
    {
      uniqueName: `${meta.baseName}_Foundation`,
      displayName: `${meta.siteName} — Foundation`,
      order: 1,
      componentTypes: ['Table', 'Environment Variable', 'Web Role', 'Table Permission'],
      description: 'Schema and security — rarely changes.',
      sizeMB: sizeFor(foundationCount),
      componentCount: foundationCount,
      components: [],
    },
    {
      uniqueName: `${meta.baseName}_Integration`,
      displayName: `${meta.siteName} — Integration`,
      order: 2,
      componentTypes: ['Cloud Flow', 'Bot Component', 'Connection Reference'],
      description: 'Cloud flows, bots, connection references.',
      sizeMB: sizeFor(integrationCount),
      componentCount: integrationCount,
      components: [],
    },
    {
      uniqueName: `${meta.baseName}_Config`,
      displayName: `${meta.siteName} — Config`,
      order: 3,
      componentTypes: ['Site Setting', 'Site Marker', 'Publishing State'],
      description: 'Site settings, markers, publishing states.',
      sizeMB: sizeFor(configCount),
      componentCount: configCount,
      components: [],
    },
    {
      uniqueName: `${meta.baseName}_Content`,
      displayName: `${meta.siteName} — Content`,
      order: 4,
      componentTypes: ['Web Page', 'Web Template', 'Page Template', 'Content Snippet', 'Web File'],
      description: 'Pages, templates, content snippets, web files. Highest change frequency.',
      sizeMB: sizeFor(contentCount),
      componentCount: contentCount,
      components: [],
    },
  ];
}

function partitionBySchema(estimate, meta, config) {
  const explicitDomains = Array.isArray(config.domains) && config.domains.length > 0
    ? config.domains
    : deriveDomainsByCapacity(estimate, config.thresholds);

  // Derive domain vs site size shares from the estimator's breakdown when available,
  // falling back to a 50/50 heuristic only if breakdown is absent.
  const tablesSizeMB = estimate.breakdown && Number.isFinite(Number(estimate.breakdown.tables))
    ? Number(estimate.breakdown.tables)
    : estimate.totalSizeMB * 0.5;
  const siteSizeMB = Math.max(estimate.totalSizeMB - tablesSizeMB, 0);
  const domainCount = Math.max(explicitDomains.length, 1);
  const sizePerDomain = tablesSizeMB / domainCount;
  const breakdownAvailable = estimate.breakdown && Number.isFinite(Number(estimate.breakdown.tables));
  const domainDescSuffix = breakdownAvailable ? '' : ' (rough estimate — breakdown unavailable)';

  // Per-table attribute counts → a schema-component PROXY. A table contributes far
  // more than one solution component (the entity + every column/relationship), so
  // counting 1-per-table severely undercounts and lets an over-cap Table solution
  // slip past validateSplits' maxComponentCount check (and distorts the Site
  // solution's count, which subtracts the domain counts). Proxy = sum(attributeCount)
  // + 1 per table (the entity component). attributeCount comes from estimate.tables[].
  // Keys/lookups are LOWERCASED — table logical names are case-insensitive and are
  // lowercased everywhere else (table permissions, relationship edges); user-authored
  // .alm-config.json domain names may not match Dataverse casing exactly.
  const attrByTable = new Map(
    (Array.isArray(estimate.tables) ? estimate.tables : [])
      .map((t) => [t && t.logicalName && t.logicalName.toLowerCase(), (t && t.attributeCount) || 0]),
  );
  const schemaComponentProxy = (names) =>
    (names || []).reduce((sum, n) => sum + (attrByTable.get(String(n).toLowerCase()) || 0), 0) + (names ? names.length : 0);

  const domainSolutions = explicitDomains.map((dom, i) => ({
    uniqueName: `${meta.baseName}_${sanitizeDomainName(dom.name)}`,
    displayName: `${meta.siteName} — ${dom.name}`,
    order: i + 1,
    componentTypes: ['Table'],
    description: `Schema domain: ${dom.name}. Tables: ${(dom.tableLogicalNames || []).join(', ') || '(derived)'}${domainDescSuffix}`,
    sizeMB: round(sizePerDomain),
    // Schema-component proxy when the domain's tables are known (sum of columns +
    // 1/table); falls back to an even attr-share split only for explicit domains
    // that didn't list their tables.
    componentCount: (dom.tableLogicalNames && dom.tableLogicalNames.length > 0)
      ? schemaComponentProxy(dom.tableLogicalNames)
      : Math.ceil((estimate.schemaAttrCount || 0) / domainCount),
    components: [],
    tableLogicalNames: dom.tableLogicalNames || [],
  }));

  const siteOrder = domainSolutions.length + 1;
  const siteSolution = {
    uniqueName: `${meta.baseName}_Site`,
    displayName: `${meta.siteName} — Site`,
    order: siteOrder,
    componentTypes: ['Web Role', 'Table Permission', 'Site Setting', 'Cloud Flow', 'Web File', 'Web Page', 'Web Template'],
    description:
      'Site artifacts — web roles, permissions, settings, flows, pages. Imports after all domain solutions.',
    sizeMB: round(siteSizeMB),
    componentCount: Math.max(
      estimate.componentCountSiteTotal - domainSolutions.reduce((s, d) => s + d.componentCount, 0),
      0,
    ),
    components: [],
  };

  return [...domainSolutions, siteSolution];
}

// --- Dependency-aware schema packing ---------------------------------------
//
// Replaces the old "one solution per table-name stem" heuristic (which produced
// ~one solution per table for any distinctly-named schema). Tables connected by
// a relationship MUST ship together, so we:
//   1. Group tables into connected components (union-find over the estimator's
//      `tableRelationships` edges). Because components have no edges between
//      them, packing whole components into separate solutions never cuts a
//      relationship — so there are no cross-/circular-solution table deps and
//      import order among the table solutions is irrelevant.
//   2. Bin-pack the components into the FEWEST solutions that keep each under the
//      per-solution caps (maxTableCount tables AND maxSchemaAttrs columns),
//      capped at maxSchemaSplitSolutions.

function normalizeTables(estimate) {
  return (estimate.tables || [])
    .map((t) => ({
      logicalName: (t && (t.logicalName || t)).toString(),
      attributeCount: (t && t.attributeCount) || 0,
    }))
    .filter((t) => t.logicalName);
}

// Union-find over tables + relationship edges -> array of clusters (each a list
// of table objects). A table with no edges is its own singleton cluster.
function buildTableClusters(tables, edges) {
  const idx = new Map();
  tables.forEach((t, i) => idx.set(t.logicalName.toLowerCase(), i));
  const parent = tables.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  for (const e of edges || []) {
    if (!Array.isArray(e) || e.length < 2) continue;
    const ia = idx.get(String(e[0]).toLowerCase());
    const ib = idx.get(String(e[1]).toLowerCase());
    if (ia != null && ib != null) union(ia, ib);
  }
  const groups = new Map();
  tables.forEach((t, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(t);
  });
  return [...groups.values()];
}

function clusterAttrs(cluster) {
  return cluster.reduce((s, t) => s + (t.attributeCount || 0), 0);
}

// First-fit-decreasing pack of whole clusters into `n` buckets, respecting the
// per-solution table + attribute caps. A cluster that fits nowhere under the
// caps (oversized, or n too small) goes to the least-loaded bucket — that bucket
// then exceeds a cap and is surfaced by the oversized-cluster recommendation.
function packClusters(clusters, n, thresholds) {
  const sorted = [...clusters].sort((a, b) => (clusterAttrs(b) - clusterAttrs(a)) || (b.length - a.length));
  const buckets = Array.from({ length: Math.max(n, 1) }, () => ({ tables: [], attrs: 0 }));
  for (const cluster of sorted) {
    const cAttrs = clusterAttrs(cluster);
    let target = buckets.findIndex(
      (b) => b.tables.length + cluster.length <= thresholds.maxTableCount &&
             b.attrs + cAttrs <= thresholds.maxSchemaAttrs,
    );
    if (target === -1) {
      target = buckets.reduce((best, b, i) => (b.attrs < buckets[best].attrs ? i : best), 0);
    }
    buckets[target].tables.push(...cluster);
    buckets[target].attrs += cAttrs;
  }
  return buckets.filter((b) => b.tables.length > 0);
}

// Returns capacity-bounded "domains" (one per packed bucket) in the same shape
// the schema partitioner consumes: { name, tableLogicalNames }.
function deriveDomainsByCapacity(estimate, thresholds) {
  const tables = normalizeTables(estimate);
  if (tables.length === 0) return [{ name: 'Tables', tableLogicalNames: [] }];

  const clusters = buildTableClusters(tables, estimate.tableRelationships || []);
  const ceiling = (thresholds && thresholds.maxSchemaSplitSolutions) || 8;
  // Seed the packer with the maximum permitted bins (one per cluster, capped at
  // maxSchemaSplitSolutions). First-fit-decreasing still consolidates — clusters
  // that fit together share a bin and the empty bins are dropped, so the final
  // count stays minimal — but a cluster that fits nowhere lands in a NEW bin
  // instead of overflowing an existing one. Seeding from a lower bound
  // (ceil(tables/maxTable), ceil(attrs/maxAttr)) under-allocated bins and let
  // independent attr-heavy clusters bust maxSchemaAttrs in the least-loaded
  // bucket, unwarned (the oversized guard only catches per-cluster table count).
  const n = Math.min(clusters.length, ceiling);

  const buckets = packClusters(clusters, n, thresholds);
  const multi = buckets.length > 1;
  return buckets.map((b, i) => ({
    name: multi ? `Tables ${i + 1}` : 'Tables',
    tableLogicalNames: b.tables.map((t) => t.logicalName),
  }));
}

function applyConfigIsolation(solutions, estimate, meta) {
  return [
    {
      uniqueName: `${meta.baseName}_EnvVars`,
      displayName: `${meta.siteName} — Environment Variables`,
      order: 1,
      componentTypes: ['Environment Variable'],
      description:
        'Environment variable definitions isolated so value updates do not force a full solution re-import.',
      sizeMB: round(Math.max(estimate.envVarCount * 0.001, 0.3)),
      componentCount: estimate.envVarCount,
      components: [],
    },
    ...solutions.map((s) => ({ ...s, order: s.order + 1 })),
  ];
}

function sanitizeDomainName(name) {
  return String(name).replace(/[^A-Za-z0-9]/g, '');
}

/**
 * Appends an empty "Future Growth" solution to a multi-solution split so there
 * is an obvious default target for any new components the team adds later. Without
 * this buffer, every new server-logic / flow / env var tends to end up crammed
 * into the wrong layer solution and forces a re-plan.
 *
 * Rules:
 *   - Only appended when the split already has ≥ 2 solutions (splits, not `single`).
 *   - Sized at 0 MB / 0 components — it's a reserved slot, not a prediction.
 *   - Marked with `isFutureBuffer: true` so renderers and setup-solution can
 *     style/describe it distinctly from partition-owned solutions.
 *   - Tagged with `componentTypes: ['Any']` to signal "open to any type."
 */
function appendFutureBuffer(solutions, meta) {
  if (!Array.isArray(solutions) || solutions.length < 2) return solutions;
  const nextOrder = (solutions[solutions.length - 1].order || solutions.length) + 1;
  return [
    ...solutions,
    {
      uniqueName: `${meta.baseName}_Future`,
      displayName: `${meta.siteName} — Future Growth`,
      order: nextOrder,
      componentTypes: ['Any'],
      description:
        'Reserved empty solution. New components added to the site after this plan (server logic, cloud flows, env vars, pages, etc.) should be added here by default so the partition-owned solutions above stay stable. Rename it or fold it into an existing solution if site growth plateaus.',
      sizeMB: 0,
      componentCount: 0,
      components: [],
      isFutureBuffer: true,
    },
  ];
}

function round(n) {
  return Math.round((Number(n) || 0) * 10) / 10;
}

// --- Per-split validation ---------------------------------------------------

function validateSplits(solutions, thresholds) {
  const warnings = [];
  for (const sol of solutions) {
    // Future buffer is a reserved 0/0 slot — never warn on it.
    if (sol.isFutureBuffer === true) continue;
    if (sol.sizeMB > thresholds.maxSolutionSizeMB) {
      warnings.push({
        type: 'warning',
        message: `Solution ${sol.uniqueName} is still estimated at ${sol.sizeMB.toFixed(
          1,
        )} MB — consider tree-shaking, WebP conversion, or removing sourcemaps.`,
      });
    }
    if (sol.componentCount > thresholds.maxComponentCount) {
      warnings.push({
        type: 'warning',
        message: `Solution ${sol.uniqueName} is still estimated at ${sol.componentCount.toLocaleString()} components — exceeds the recommended ${thresholds.maxComponentCount.toLocaleString()}-component cap. Consider sub-partitioning or archiving unused components.`,
      });
    }
  }
  return warnings;
}

// --- Sub-partition oversized children of the primary partition --------------
//
// Runs ONCE after the primary partition is built. For each child that still
// busts either the size or component-count cap, replace it with 3 (or 4)
// change-frequency-shaped sub-solutions. Single-component-type slices
// (WebAssets, EnvVars, future buffer) are left alone — sub-partitioning them
// makes no sense; validateSplits will flag them instead. The intent is to
// catch the Strategy-1 (Layer) case where Core inherits flows/bots/tables and
// stays over cap even after Web Assets are peeled off.

function subPartitionIfOverCap(solutions, estimate, thresholds, opts = {}) {
  if (!Array.isArray(solutions)) return { solutions, modified: false };
  let modified = false;
  const out = [];
  let nextOrder = 1;

  for (const sol of solutions) {
    const overSize = sol.sizeMB > thresholds.maxSolutionSizeMB;
    const overCount = sol.componentCount > thresholds.maxComponentCount;

    // Single-type slices and the future buffer are never sub-partitioned.
    // We pattern-match on componentTypes rather than uniqueName so renamed
    // splits (`Test_WebAssets` vs `MySite_WebAssets`) still hit the guard.
    const types = Array.isArray(sol.componentTypes) ? sol.componentTypes : [];
    const isSingleTypeSlice =
      sol.isFutureBuffer === true ||
      (types.length === 1 &&
        (types[0] === 'Web File' ||
          types[0] === 'Environment Variable' ||
          types[0] === 'Any'));

    if ((overSize || overCount) && !isSingleTypeSlice) {
      modified = true;
      const children = buildSubChildren(sol, estimate, thresholds, nextOrder, opts);
      for (const c of children) {
        out.push(c);
        nextOrder++;
      }
    } else {
      out.push({ ...sol, order: nextOrder });
      nextOrder++;
    }
  }

  return { solutions: out, modified };
}

function buildSubChildren(parent, estimate, thresholds, startOrder, opts = {}) {
  const parentCount = parent.componentCount || 0;
  const parentSize = parent.sizeMB || 0;
  const flows = (estimate.cloudFlowCount || 0) + (estimate.botCount || 0);
  // Always emit `_Integration` when the parent carries flows or bots — even
  // below `changeFreqMinFlows`. Without it, downstream setup-solution Phase 5
  // routing can't place Cloud Flow / Bot Component records (they fall to the
  // Default solution). The `changeFreqMinFlows` threshold governs whether
  // change-frequency is the right TOP-LEVEL split strategy; once we've
  // committed to sub-partitioning, coverage takes priority over heuristic.
  const parentTypes = Array.isArray(parent.componentTypes) ? parent.componentTypes : [];
  const parentHasIntegrationTypes =
    parentTypes.includes('Cloud Flow') ||
    parentTypes.includes('Bot Component') ||
    parentTypes.includes('Connection Reference');
  const includeIntegration = flows > 0 || parentHasIntegrationTypes;

  // additiveStrategy4 flips the _Config componentTypes: when the top-level
  // _EnvVars solution will own env vars, we drop 'Environment Variable' from
  // _Config to prevent double-claiming. When it WON'T (envVarCount under cap
  // OR additive not firing), _Config absorbs env vars so they have an owner.
  const additiveStrategy4 = opts.additiveStrategy4 === true;

  // Proportional shares — foundation 20%, config 15%, content 65% when no
  // integration slice; otherwise foundation 20%, integration = actual flow+bot
  // count, config 15%, content = remainder. Sizes derive from the count share
  // so size and count stay self-consistent (same pattern as
  // partitionByChangeFrequency).
  const foundation = Math.max(1, Math.round(parentCount * 0.20));
  const config = Math.max(1, Math.round(parentCount * 0.15));
  const integration = includeIntegration ? Math.max(flows, 1) : 0;
  const content = Math.max(parentCount - foundation - config - integration, 0);

  const totalAlloc = foundation + config + integration + content;
  const sizePerCount = totalAlloc > 0 ? parentSize / totalAlloc : 0;
  const sizeFor = (n) => round(n * sizePerCount);

  const children = [
    {
      uniqueName: `${parent.uniqueName}_Foundation`,
      displayName: `${parent.displayName} — Foundation`,
      order: startOrder,
      componentTypes: ['Table', 'Web Role', 'Table Permission'],
      description: `Sub-partition of ${parent.uniqueName}: schema and security. Created automatically because the parent exceeded the recommended caps.`,
      sizeMB: sizeFor(foundation),
      componentCount: foundation,
      components: [],
    },
  ];

  let order = startOrder + 1;
  if (includeIntegration) {
    children.push({
      uniqueName: `${parent.uniqueName}_Integration`,
      displayName: `${parent.displayName} — Integration`,
      order: order++,
      componentTypes: ['Cloud Flow', 'Bot Component', 'Connection Reference'],
      description: `Sub-partition of ${parent.uniqueName}: cloud flows, bots, connection references.`,
      sizeMB: sizeFor(integration),
      componentCount: integration,
      components: [],
    });
  }

  // Env vars: included in _Config UNLESS the top-level additive _EnvVars
  // solution will own them. Double-claim would break setup-solution Phase 5
  // routing (one component type owned by two solutions). The original
  // partitionByChangeFrequency Config block doesn't list env vars because
  // change-frequency mode never combines with additive Strategy 4 (selectStrategy
  // sets additive=true only for strategies 1/3); here additive can fire so we
  // condition on it explicitly.
  const configTypes = ['Site Setting', 'Site Marker', 'Publishing State'];
  if (!additiveStrategy4) configTypes.push('Environment Variable');
  children.push({
    uniqueName: `${parent.uniqueName}_Config`,
    displayName: `${parent.displayName} — Config`,
    order: order++,
    componentTypes: configTypes,
    description: additiveStrategy4
      ? `Sub-partition of ${parent.uniqueName}: site settings, markers, publishing states.`
      : `Sub-partition of ${parent.uniqueName}: site settings, markers, publishing states, env vars.`,
    sizeMB: sizeFor(config),
    componentCount: config,
    components: [],
  });

  children.push({
    uniqueName: `${parent.uniqueName}_Content`,
    displayName: `${parent.displayName} — Content`,
    order: order++,
    componentTypes: ['Web Page', 'Web Template', 'Page Template', 'Content Snippet'],
    description: `Sub-partition of ${parent.uniqueName}: pages, templates, content snippets.`,
    sizeMB: sizeFor(content),
    componentCount: content,
    components: [],
  });

  return children;
}

// --- Recommendations --------------------------------------------------------

function buildRecommendations(estimate, strategy, config) {
  const recs = [];
  const t = config.thresholds;

  if (strategy.primary === 'strategy-3-schema-segmentation') {
    recs.push({
      type: 'warning',
      message:
        'Schema-heavy solution detected. Expected import time per stage: 2–10+ hours. Test in staging first and do not schedule production deploys during peak hours.',
    });
  }
  if (estimate.componentCountSiteTotal > t.hardFlagComponentCount) {
    recs.push({
      type: 'error',
      message:
        `Component count (${estimate.componentCountSiteTotal.toLocaleString()}) exceeds the hard-flag threshold of ${t.hardFlagComponentCount.toLocaleString()}. Splitting alone is unlikely to be sufficient — archive historical data, remove unused components, or consolidate before proceeding.`,
    });
  }
  if (estimate.totalSizeMB > t.maxSolutionSizeMB) {
    recs.push({
      type: 'info',
      message: `Estimated total size (${estimate.totalSizeMB.toFixed(
        1,
      )} MB) exceeds the recommended ${t.maxSolutionSizeMB} MB cap.`,
    });
  }
  if (estimate.webFilesAggregateMB > t.maxAggregateWebFilesMB) {
    recs.push({
      type: 'info',
      message: `Web files total ${estimate.webFilesAggregateMB.toFixed(
        1,
      )} MB. Externalize large media to Azure Blob before import for reliability.`,
    });
  }
  if (estimate.envVarCount > t.maxEnvVarCount) {
    recs.push({
      type: 'info',
      message: `${estimate.envVarCount} environment variables — isolate into a dedicated EnvVars solution so value updates don't require a full re-import.`,
    });
  }
  return recs;
}

// --- Main -------------------------------------------------------------------

function computeSplitPlan({ estimate, config, meta }) {
  const sizeAnalysis = buildSizeAnalysis(estimate, config.thresholds);
  const assetAdvisory = computeAssetAdvisory(estimate, config);
  const strategy = selectStrategy(estimate, config);

  let proposedSolutions;
  switch (strategy.primary) {
    case 'strategy-3-schema-segmentation':
      proposedSolutions = partitionBySchema(estimate, meta, config);
      break;
    case 'strategy-1-layer':
      proposedSolutions = partitionByLayer(estimate, meta);
      break;
    case 'strategy-2-change-frequency':
      proposedSolutions = partitionByChangeFrequency(estimate, meta);
      break;
    case 'strategy-4-config-isolation':
      proposedSolutions = applyConfigIsolation(partitionBySingle(estimate, meta), estimate, meta);
      break;
    case 'single':
    default:
      proposedSolutions = partitionBySingle(estimate, meta);
      break;
  }

  // Sub-partition any oversized children of the primary partition. Only runs
  // for strategy-1-layer (Core often inherits flows/bots/tables and stays
  // over cap after Web Assets are peeled off). Skip for:
  //   - single (no partition to sub-divide)
  //   - strategy-2-change-frequency (children are already a change-frequency
  //     slice — re-splitting by change-frequency would produce the same shape)
  //   - strategy-3-schema-segmentation (children are domain-scoped Table
  //     slices; change-frequency re-splitting doesn't fit the domain model)
  //   - strategy-4-config-isolation (primary): the all-in-one child is by
  //     definition not partitioned; sub-partitioning it would silently
  //     promote it to a multi-solution split the user didn't opt into.
  // Runs ONCE; if children still bust caps validateSplits will surface a
  // manual-archival warning.
  let compositeSubPartitioned = false;
  if (strategy.primary === 'strategy-1-layer') {
    // Pass `additiveStrategy4` so `_Config` knows whether the top-level
    // `_EnvVars` solution will claim env vars (in which case _Config drops
    // 'Environment Variable' from its componentTypes to avoid double-claim).
    const sub = subPartitionIfOverCap(proposedSolutions, estimate, config.thresholds, {
      additiveStrategy4: strategy.additive === true,
    });
    if (sub.modified) {
      proposedSolutions = sub.solutions;
      compositeSubPartitioned = true;
    }
  }

  if (strategy.additive) {
    proposedSolutions = applyConfigIsolation(proposedSolutions, estimate, meta);
  }

  // Add a reserved `{Prefix}_Future` solution when the site is actually being
  // split so new components have a defined home. Single-solution plans skip
  // this — there's no split to protect.
  proposedSolutions = appendFutureBuffer(proposedSolutions, meta);

  const splitWarnings = validateSplits(proposedSolutions, config.thresholds);
  // Oversized-cluster guard: a Table solution holding more tables than the
  // per-solution cap means a single connected dependency cluster couldn't be
  // split without cutting a relationship. Name it so the user can decide whether
  // to denormalize the schema or raise the cap — we never silently split a cluster.
  const oversizedClusterWarnings = proposedSolutions
    .filter((s) => Array.isArray(s.tableLogicalNames) &&
      s.tableLogicalNames.length > config.thresholds.maxTableCount)
    .map((s) => ({
      type: 'warning',
      message: `Solution ${s.uniqueName} holds ${s.tableLogicalNames.length} related tables — above the ${config.thresholds.maxTableCount}-per-solution cap — because they form one dependency cluster that cannot be split without breaking a relationship. Consider denormalizing the schema or raising maxTableCount in .alm-config.json.`,
    }));
  // Oversized-SCHEMA guard (companion to the table-count guard above): a Table
  // solution whose summed column count exceeds maxSchemaAttrs. This fires at the
  // `maxSchemaSplitSolutions` ceiling — when MORE than that many independent
  // attr-heavy table clusters must share the capped number of split solutions, the
  // FFD packer's least-loaded fallback co-locates clusters and a bucket busts the
  // column cap. Without this, the overflow is silent (the table-count guard alone
  // misses it). attributeCount comes from estimate.tables[]; keys/lookups lowercased
  // (case-insensitive table names — see partitionBySchema).
  const attrByTable = new Map(
    (Array.isArray(estimate.tables) ? estimate.tables : [])
      .map((t) => [t && t.logicalName && t.logicalName.toLowerCase(), (t && t.attributeCount) || 0]),
  );
  const solutionSchemaAttrs = (s) =>
    (s.tableLogicalNames || []).reduce((sum, n) => sum + (attrByTable.get(String(n).toLowerCase()) || 0), 0);
  const oversizedAttrWarnings = proposedSolutions
    .filter((s) => Array.isArray(s.tableLogicalNames) && s.tableLogicalNames.length > 0 &&
      solutionSchemaAttrs(s) > config.thresholds.maxSchemaAttrs)
    .map((s) => ({
      type: 'warning',
      message: `Solution ${s.uniqueName} holds tables totaling ${solutionSchemaAttrs(s)} columns — above the ${config.thresholds.maxSchemaAttrs}-column per-solution cap. This happens when more than ${config.thresholds.maxSchemaSplitSolutions} independent attr-heavy table clusters must share the capped number of schema-split solutions. Consider raising maxSchemaSplitSolutions (or maxSchemaAttrs) in .alm-config.json, or denormalizing the widest tables.`,
    }));
  // Surface estimator-side truncation warnings as `recommendations[]` entries
  // so the rendered plan shows them inline. These get the `error` type because
  // a truncated input is more dangerous than a normal split-decision warning
  // (the user can't tell anything's wrong from the recommendation alone).
  const truncationRecs = (Array.isArray(estimate.truncationWarnings) ? estimate.truncationWarnings : [])
    .map((message) => ({
      type: 'error',
      message: `Estimator may be truncated: ${message} The split recommendation below could be wrong — investigate before approving.`,
    }));
  const recommendations = truncationRecs
    .concat(buildRecommendations(estimate, strategy, config))
    .concat(splitWarnings)
    .concat(oversizedClusterWarnings)
    .concat(oversizedAttrWarnings);

  const appliedStrategies = [strategy.primary];
  if (strategy.additive) appliedStrategies.push('strategy-4-config-isolation');
  if (compositeSubPartitioned) appliedStrategies.push('composite-sub-partition');

  return {
    sizeAnalysis,
    assetAdvisory,
    splitStrategy: strategy.primary,
    appliedStrategies,
    compositeSubPartitioned,
    proposedSolutions,
    recommendations,
    // Pass the canary fields through so plan-alm can surface them to the user
    // and gate the "keep as single anyway" override on whether they're set.
    truncationSuspected: !!estimate.truncationSuspected,
    truncationWarnings: Array.isArray(estimate.truncationWarnings) ? estimate.truncationWarnings : [],
  };
}

// CLI entry point
if (require.main === module) {
  const args = parseArgs(process.argv);
  if (!args.estimate) {
    process.stderr.write('Usage: compute-split-plan.js --estimate <file.json> [--projectRoot <path>] [--publisherPrefix <p>] [--siteName <name>]\n');
    process.exit(1);
  }
  try {
    const estimate = JSON.parse(fs.readFileSync(args.estimate, 'utf8'));
    const config = loadConfig(args.projectRoot);
    const baseName = args.siteName
      ? args.siteName.replace(/[^A-Za-z0-9]/g, '')
      : estimate.siteName
        ? estimate.siteName.replace(/[^A-Za-z0-9]/g, '')
        : 'Site';
    const meta = {
      baseName,
      siteName: args.siteName || estimate.siteName || 'Site',
      publisherPrefix: args.publisherPrefix || estimate.publisherPrefix || '',
    };
    const result = computeSplitPlan({ estimate, config, meta });
    process.stdout.write(JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (err) {
    process.stderr.write(`compute-split-plan failed: ${err.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  computeSplitPlan,
  buildSizeAnalysis,
  computeAssetAdvisory,
  selectStrategy,
  partitionBySingle,
  partitionByLayer,
  partitionByChangeFrequency,
  partitionBySchema,
  applyConfigIsolation,
  appendFutureBuffer,
  validateSplits,
  buildRecommendations,
  subPartitionIfOverCap,
};
