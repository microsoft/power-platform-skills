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
      value: estimate.componentCount,
      tier: classifyTier(
        estimate.componentCount,
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
    estimate.componentCount > t.maxComponentCount ||
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
      componentCount: estimate.componentCount,
      components: [],
    },
  ];
}

function partitionByLayer(estimate, meta) {
  const coreSize = Math.max(estimate.totalSizeMB - estimate.webFilesAggregateMB, 0);
  const coreCount = Math.max(estimate.componentCount - (estimate.webFileCount || 0), 0);
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
  const foundationCount = Math.ceil(estimate.componentCount * 0.15);
  const integrationCount = estimate.cloudFlowCount + estimate.botCount;
  const configCount = Math.ceil(estimate.componentCount * 0.1);
  const contentCount = Math.max(
    estimate.componentCount - foundationCount - integrationCount - configCount,
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
    : deriveDomainsFromPrefix(estimate);

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

  const domainSolutions = explicitDomains.map((dom, i) => ({
    uniqueName: `${meta.baseName}_${sanitizeDomainName(dom.name)}`,
    displayName: `${meta.siteName} — ${dom.name}`,
    order: i + 1,
    componentTypes: ['Table'],
    description: `Schema domain: ${dom.name}. Tables: ${(dom.tableLogicalNames || []).join(', ') || '(derived)'}${domainDescSuffix}`,
    sizeMB: round(sizePerDomain),
    componentCount: Math.ceil(
      (estimate.schemaAttrCount || 0) / domainCount,
    ),
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
      estimate.componentCount - domainSolutions.reduce((s, d) => s + d.componentCount, 0),
      0,
    ),
    components: [],
  };

  return [...domainSolutions, siteSolution];
}

function deriveDomainsFromPrefix(estimate) {
  const tables = estimate.tables || [];
  if (tables.length === 0) return [{ name: 'All', tableLogicalNames: [] }];

  const groups = new Map();
  for (const t of tables) {
    const name = (t.logicalName || t).toString();
    const afterPrefix = name.includes('_') ? name.split('_').slice(1).join('_') : name;
    const stem = afterPrefix.split(/[_]/)[0] || 'misc';
    const key = stem.charAt(0).toUpperCase() + stem.slice(1);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(name);
  }

  return Array.from(groups.entries()).map(([name, tableLogicalNames]) => ({
    name,
    tableLogicalNames,
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

function round(n) {
  return Math.round((Number(n) || 0) * 10) / 10;
}

// --- Per-split validation ---------------------------------------------------

function validateSplits(solutions, thresholds) {
  const warnings = [];
  for (const sol of solutions) {
    if (sol.sizeMB > thresholds.maxSolutionSizeMB) {
      warnings.push({
        type: 'warning',
        message: `Solution ${sol.uniqueName} is still estimated at ${sol.sizeMB.toFixed(
          1,
        )} MB — consider tree-shaking, WebP conversion, or removing sourcemaps.`,
      });
    }
  }
  return warnings;
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
  if (estimate.componentCount > t.hardFlagComponentCount) {
    recs.push({
      type: 'error',
      message:
        `Component count (${estimate.componentCount.toLocaleString()}) exceeds the hard-flag threshold of ${t.hardFlagComponentCount.toLocaleString()}. Splitting alone is unlikely to be sufficient — archive historical data, remove unused components, or consolidate before proceeding.`,
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

  if (strategy.additive) {
    proposedSolutions = applyConfigIsolation(proposedSolutions, estimate, meta);
  }

  const splitWarnings = validateSplits(proposedSolutions, config.thresholds);
  const recommendations = buildRecommendations(estimate, strategy, config).concat(splitWarnings);

  const appliedStrategies = [strategy.primary];
  if (strategy.additive) appliedStrategies.push('strategy-4-config-isolation');

  return {
    sizeAnalysis,
    assetAdvisory,
    splitStrategy: strategy.primary,
    appliedStrategies,
    proposedSolutions,
    recommendations,
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
  validateSplits,
  buildRecommendations,
};
