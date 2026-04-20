const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeSplitPlan,
  selectStrategy,
  buildSizeAnalysis,
  computeAssetAdvisory,
  partitionByLayer,
  partitionByChangeFrequency,
  partitionBySchema,
} = require('../lib/compute-split-plan');
const { DEFAULT_CONFIG, DEFAULTS } = require('../lib/alm-thresholds');

function baseConfig(overrides = {}) {
  return {
    ...DEFAULT_CONFIG,
    thresholds: { ...DEFAULTS, ...(overrides.thresholds || {}) },
    assetAdvisory: { ...DEFAULT_CONFIG.assetAdvisory, ...(overrides.assetAdvisory || {}) },
    domains: overrides.domains || [],
    strategyOverride: overrides.strategyOverride || null,
  };
}

function baseEstimate(overrides = {}) {
  return {
    siteName: 'Test',
    publisherPrefix: 'tst',
    totalSizeMB: 40,
    componentCount: 1500,
    tableCount: 3,
    schemaAttrCount: 60,
    webFilesAggregateMB: 4,
    webFilesIndividual: [],
    webFileCount: 10,
    cloudFlowCount: 1,
    botCount: 0,
    envVarCount: 5,
    mediaRatio: 0.3,
    siteType: 'code-site',
    tables: [],
    ...overrides,
  };
}

// --- selectStrategy branches ------------------------------------------------

test('Scenario A (typical customer): Green everywhere → single solution', () => {
  const est = baseEstimate();
  const { primary, additive } = selectStrategy(est, baseConfig());
  assert.equal(primary, 'single');
  assert.equal(additive, false);
});

test('Scenario B (Feedback Portal): Size red + web-heavy → Strategy 1 Layer', () => {
  const est = baseEstimate({
    totalSizeMB: 142,
    webFilesAggregateMB: 110,
    componentCount: 2100,
  });
  const { primary } = selectStrategy(est, baseConfig());
  assert.equal(primary, 'strategy-1-layer');
});

test('Scenario C (Prabhat 34x950 schema): schema red → Strategy 3 Schema Segmentation wins even under size cap', () => {
  const est = baseEstimate({
    totalSizeMB: 68,
    tableCount: 34,
    schemaAttrCount: 32300,
    componentCount: 35000,
  });
  const { primary } = selectStrategy(est, baseConfig());
  assert.equal(primary, 'strategy-3-schema-segmentation');
});

test('Scenario D (Brad 1400 env vars): only envVarCount red → Strategy 4 alone', () => {
  const est = baseEstimate({
    envVarCount: 1400,
  });
  const { primary, additive } = selectStrategy(est, baseConfig());
  assert.equal(primary, 'strategy-4-config-isolation');
  assert.equal(additive, false);
});

test('Scenario E (component-heavy with many flows): Strategy 2 Change-Frequency', () => {
  const est = baseEstimate({
    totalSizeMB: 74,
    componentCount: 7200,
    cloudFlowCount: 12,
  });
  const { primary } = selectStrategy(est, baseConfig());
  assert.equal(primary, 'strategy-2-change-frequency');
});

test('Additive: Strategy 1 + Strategy 4 when web-heavy AND env-var heavy', () => {
  const est = baseEstimate({
    totalSizeMB: 142,
    webFilesAggregateMB: 110,
    envVarCount: 800,
  });
  const { primary, additive } = selectStrategy(est, baseConfig());
  assert.equal(primary, 'strategy-1-layer');
  assert.equal(additive, true);
});

test('strategyOverride bypasses the tree', () => {
  const est = baseEstimate();
  const cfg = baseConfig({ strategyOverride: 'strategy-2-change-frequency' });
  const { primary } = selectStrategy(est, cfg);
  assert.equal(primary, 'strategy-2-change-frequency');
});

// --- computeSplitPlan end-to-end --------------------------------------------

test('computeSplitPlan produces 1 proposed solution for single', () => {
  const result = computeSplitPlan({
    estimate: baseEstimate(),
    config: baseConfig(),
    meta: { baseName: 'Test', siteName: 'Test Site' },
  });
  assert.equal(result.splitStrategy, 'single');
  assert.equal(result.proposedSolutions.length, 1);
  assert.equal(result.proposedSolutions[0].uniqueName, 'Test');
});

test('computeSplitPlan produces 2 solutions for Layer split', () => {
  const result = computeSplitPlan({
    estimate: baseEstimate({ totalSizeMB: 142, webFilesAggregateMB: 110 }),
    config: baseConfig(),
    meta: { baseName: 'Test', siteName: 'Test Site' },
  });
  assert.equal(result.splitStrategy, 'strategy-1-layer');
  assert.equal(result.proposedSolutions.length, 2);
  assert.match(result.proposedSolutions[0].uniqueName, /Core$/);
  assert.match(result.proposedSolutions[1].uniqueName, /WebAssets$/);
  assert.equal(result.proposedSolutions[0].order, 1);
  assert.equal(result.proposedSolutions[1].order, 2);
});

test('computeSplitPlan produces 4 solutions for Change-Frequency split', () => {
  const result = computeSplitPlan({
    estimate: baseEstimate({ totalSizeMB: 74, componentCount: 7200, cloudFlowCount: 12 }),
    config: baseConfig(),
    meta: { baseName: 'Test', siteName: 'Test Site' },
  });
  assert.equal(result.proposedSolutions.length, 4);
  const names = result.proposedSolutions.map((s) => s.uniqueName);
  assert.deepEqual(names, ['Test_Foundation', 'Test_Integration', 'Test_Config', 'Test_Content']);
});

test('computeSplitPlan Strategy 3 uses explicit config.domains when present', () => {
  const config = baseConfig({
    domains: [
      { name: 'Catalog', tableLogicalNames: ['tst_product', 'tst_category'] },
      { name: 'Orders', tableLogicalNames: ['tst_order'] },
    ],
  });
  const result = computeSplitPlan({
    estimate: baseEstimate({ tableCount: 34, schemaAttrCount: 32000 }),
    config,
    meta: { baseName: 'Test', siteName: 'Test Site' },
  });
  assert.equal(result.splitStrategy, 'strategy-3-schema-segmentation');
  // 2 explicit domains + 1 Site solution
  assert.equal(result.proposedSolutions.length, 3);
  assert.equal(result.proposedSolutions[0].uniqueName, 'Test_Catalog');
  assert.equal(result.proposedSolutions[1].uniqueName, 'Test_Orders');
  assert.equal(result.proposedSolutions[2].uniqueName, 'Test_Site');
});

test('computeSplitPlan Strategy 3 falls back to prefix heuristic when no domains configured', () => {
  const result = computeSplitPlan({
    estimate: baseEstimate({
      tableCount: 22,
      schemaAttrCount: 16000,
      tables: [
        { logicalName: 'tst_product' },
        { logicalName: 'tst_productVariant' },
        { logicalName: 'tst_order' },
        { logicalName: 'tst_orderLine' },
      ],
    }),
    config: baseConfig(),
    meta: { baseName: 'Test', siteName: 'Test Site' },
  });
  assert.equal(result.splitStrategy, 'strategy-3-schema-segmentation');
  assert.ok(result.proposedSolutions.length >= 2);
});

test('computeSplitPlan additive Strategy 4 prepends EnvVars solution', () => {
  const result = computeSplitPlan({
    estimate: baseEstimate({ totalSizeMB: 142, webFilesAggregateMB: 110, envVarCount: 800 }),
    config: baseConfig(),
    meta: { baseName: 'Test', siteName: 'Test Site' },
  });
  assert.ok(result.appliedStrategies.includes('strategy-1-layer'));
  assert.ok(result.appliedStrategies.includes('strategy-4-config-isolation'));
  assert.equal(result.proposedSolutions[0].uniqueName, 'Test_EnvVars');
  assert.equal(result.proposedSolutions[0].order, 1);
});

// --- Asset advisory ---------------------------------------------------------

test('computeAssetAdvisory collects files above threshold and excludes favicons', () => {
  const est = baseEstimate({
    webFilesIndividual: [
      { name: 'hero.png', sizeMB: 4.8 },
      { name: 'small.png', sizeMB: 0.3 },
      { name: 'favicon.ico', sizeMB: 2.5 },
    ],
  });
  const cfg = baseConfig({ assetAdvisory: { excludePatterns: ['favicon.*'] } });
  const adv = computeAssetAdvisory(est, cfg);
  assert.equal(adv.enabled, true);
  assert.equal(adv.candidates.length, 1);
  assert.equal(adv.candidates[0].name, 'hero.png');
  assert.equal(adv.candidates[0].recommendation, 'azure-blob');
});

test('computeAssetAdvisory recommends externalize-media for heavy media aggregates', () => {
  const est = baseEstimate({
    webFilesAggregateMB: 68,
    mediaRatio: 0.8,
    webFilesIndividual: [{ name: 'x.png', sizeMB: 3 }],
  });
  const adv = computeAssetAdvisory(est, baseConfig());
  assert.equal(adv.recommendation, 'externalize-media');
});

test('computeAssetAdvisory disabled when preferredStorage is "none"', () => {
  const cfg = baseConfig({ assetAdvisory: { preferredStorage: 'none' } });
  const adv = computeAssetAdvisory(baseEstimate(), cfg);
  assert.equal(adv.enabled, false);
  assert.equal(adv.candidates.length, 0);
});

// --- Recommendations --------------------------------------------------------

test('Strategy 3 surfaces the 10+ hour warning in recommendations', () => {
  const result = computeSplitPlan({
    estimate: baseEstimate({ tableCount: 34, schemaAttrCount: 32000 }),
    config: baseConfig(),
    meta: { baseName: 'Test', siteName: 'Test Site' },
  });
  const hit = result.recommendations.find((r) => /10\+ hours/.test(r.message));
  assert.ok(hit, 'expected a recommendation mentioning import time');
});

// --- sizeAnalysis tier classification --------------------------------------

test('buildSizeAnalysis tags signals as green/yellow/red', () => {
  const analysis = buildSizeAnalysis(
    baseEstimate({ totalSizeMB: 100, componentCount: 7000, schemaAttrCount: 200 }),
    DEFAULTS,
  );
  assert.equal(analysis.totalSizeMB.tier, 'red');
  assert.equal(analysis.componentCount.tier, 'red');
  assert.equal(analysis.schemaAttrCount.tier, 'green');
});

// --- Hard-flag component count ---------------------------------------------

test('Hard-flag component count still routes to Strategy 2 (not silent single)', () => {
  // 12,000 components is above hardFlagComponentCount (10,000) — earlier code
  // fell through to `single`. Now it should still recommend a split.
  const est = baseEstimate({ componentCount: 12000 });
  const { primary } = selectStrategy(est, baseConfig());
  assert.equal(primary, 'strategy-2-change-frequency');
});

test('Hard-flag component count emits an error-type recommendation', () => {
  const result = computeSplitPlan({
    estimate: baseEstimate({ componentCount: 12000 }),
    config: baseConfig(),
    meta: { baseName: 'Test', siteName: 'Test Site' },
  });
  const hit = result.recommendations.find((r) => r.type === 'error' && /hard-flag/i.test(r.message));
  assert.ok(hit, 'expected an error-type recommendation mentioning the hard-flag threshold');
});

// --- Size / count consistency in Change-Frequency partition ----------------

test('partitionByChangeFrequency sums sizeMB back to totalSizeMB (±0.5)', () => {
  const est = baseEstimate({ totalSizeMB: 74, componentCount: 7200, cloudFlowCount: 12 });
  const solutions = partitionByChangeFrequency(est, { baseName: 'T', siteName: 'T' });
  const sum = solutions.reduce((s, sol) => s + sol.sizeMB, 0);
  assert.ok(
    Math.abs(sum - est.totalSizeMB) < 0.5,
    `expected sizes to sum to ~${est.totalSizeMB} MB, got ${sum}`,
  );
});

// --- partitionBySchema uses breakdown when available -----------------------

test('partitionBySchema uses breakdown.tables to size domain solutions', () => {
  const est = baseEstimate({
    totalSizeMB: 100,
    tableCount: 34,
    schemaAttrCount: 32000,
    breakdown: { tables: 40 }, // 40 MB in tables, 60 MB for site
  });
  const cfg = baseConfig({
    domains: [
      { name: 'Catalog', tableLogicalNames: ['tst_product'] },
      { name: 'Orders', tableLogicalNames: ['tst_order'] },
    ],
  });
  const solutions = partitionBySchema(est, { baseName: 'T', siteName: 'T' }, cfg);
  // 40 MB split across 2 domains = 20 MB each
  assert.equal(solutions[0].sizeMB, 20);
  assert.equal(solutions[1].sizeMB, 20);
  // Site solution absorbs the remainder
  assert.equal(solutions[2].sizeMB, 60);
});
