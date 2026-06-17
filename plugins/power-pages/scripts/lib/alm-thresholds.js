#!/usr/bin/env node

// Central threshold defaults for ALM split-decision logic.
// Loaded by estimate-solution-size.js and compute-split-plan.js.
// Override in project root via `.alm-config.json`.

'use strict';

const fs = require('fs');
const path = require('path');

// NOTE: split-decision thresholds are intentionally tighter than the platform
// hard caps (95 MB / 6000 components) to leave growth headroom in each
// solution. Recommending a split at ~75 MB / 4000 components means each split
// child has ~20 MB / ~2000 components of room before the platform refuses an
// import. Bumped down on 2026-05-08 (IronItOut release-readiness pass).
const DEFAULTS = Object.freeze({
  maxSolutionSizeMB: 75,
  warnComponentCount: 2500,
  maxComponentCount: 4000,
  hardFlagComponentCount: 10000,
  maxSchemaAttrs: 15000,
  maxTableCount: 20,
  // Safety ceiling on the number of auto-derived schema-split solutions. The
  // schema-segmentation packing keeps each solution under maxTableCount /
  // maxSchemaAttrs, but caps the COUNT here so a pathological schema can't
  // explode into dozens of solutions — beyond this, the hardFlagComponentCount
  // recommendation tells the user to archive/consolidate instead.
  maxSchemaSplitSolutions: 8,
  maxAggregateWebFilesMB: 40,
  maxSingleFileMB: 2,
  maxEnvVarCount: 500,
  webFileDominanceRatio: 0.4,
  mediaRatioTrigger: 0.6,
  sizeExceedsCapUpperBound: 200,
  changeFreqMinFlows: 5,
  changeFreqMinSizeMB: 60,
});

const DEFAULT_CONFIG = Object.freeze({
  thresholds: DEFAULTS,
  strategyPreference: 'auto',
  strategyOverride: null,
  assetAdvisory: Object.freeze({
    enabled: true,
    preferredStorage: 'azure-blob',
    excludePatterns: [],
  }),
  domains: [],
  sizeEstimation: Object.freeze({
    method: 'metadata',
    dryRunEnabled: false,
  }),
});

function deepMerge(target, source) {
  if (!source || typeof source !== 'object') return target;
  const out = { ...target };
  for (const key of Object.keys(source)) {
    const val = source[key];
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      out[key] = deepMerge(target[key] || {}, val);
    } else if (val !== undefined) {
      out[key] = val;
    }
  }
  return out;
}

function loadConfig(projectRoot) {
  if (!projectRoot) return { ...DEFAULT_CONFIG, thresholds: { ...DEFAULTS } };
  const configPath = path.join(projectRoot, '.alm-config.json');
  if (!fs.existsSync(configPath)) {
    return { ...DEFAULT_CONFIG, thresholds: { ...DEFAULTS } };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return deepMerge({ ...DEFAULT_CONFIG, thresholds: { ...DEFAULTS } }, raw);
  } catch (err) {
    process.stderr.write(`Warning: failed to parse .alm-config.json: ${err.message}\n`);
    return { ...DEFAULT_CONFIG, thresholds: { ...DEFAULTS } };
  }
}

// Bounds are strict upper bounds for each tier:
//   value <  greenUpperExclusive  -> green
//   value <  yellowUpperExclusive -> yellow
//   otherwise                     -> red
// Callers that want inclusive bounds should pass `bound + epsilon`.
function classifyTier(value, greenUpperExclusive, yellowUpperExclusive) {
  if (value == null) return 'unknown';
  if (value < greenUpperExclusive) return 'green';
  if (value < yellowUpperExclusive) return 'yellow';
  return 'red';
}

module.exports = {
  DEFAULTS,
  DEFAULT_CONFIG,
  loadConfig,
  deepMerge,
  classifyTier,
};
