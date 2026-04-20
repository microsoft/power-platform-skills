#!/usr/bin/env node

// Central threshold defaults for ALM split-decision logic.
// Loaded by estimate-solution-size.js and compute-split-plan.js.
// Override in project root via `.alm-config.json`.

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULTS = Object.freeze({
  maxSolutionSizeMB: 95,
  warnComponentCount: 3000,
  maxComponentCount: 6000,
  hardFlagComponentCount: 10000,
  maxSchemaAttrs: 15000,
  maxTableCount: 20,
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
