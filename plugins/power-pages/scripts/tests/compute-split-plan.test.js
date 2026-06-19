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
  validateSplits,
  subPartitionIfOverCap,
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
    componentCountSiteTotal: 1500,
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
    componentCountSiteTotal: 2100,
  });
  const { primary } = selectStrategy(est, baseConfig());
  assert.equal(primary, 'strategy-1-layer');
});

test('Scenario C (Prabhat 34x950 schema): schema red → Strategy 3 Schema Segmentation wins even under size cap', () => {
  const est = baseEstimate({
    totalSizeMB: 68,
    tableCount: 34,
    schemaAttrCount: 32300,
    componentCountSiteTotal: 35000,
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
    componentCountSiteTotal: 7200,
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

test('computeSplitPlan produces 2 partition solutions + 1 Future buffer for Layer split', () => {
  const result = computeSplitPlan({
    estimate: baseEstimate({ totalSizeMB: 142, webFilesAggregateMB: 110 }),
    config: baseConfig(),
    meta: { baseName: 'Test', siteName: 'Test Site' },
  });
  assert.equal(result.splitStrategy, 'strategy-1-layer');
  // 2 partition solutions (Core, WebAssets) + 1 Future buffer reserved for new additions
  assert.equal(result.proposedSolutions.length, 3);
  assert.match(result.proposedSolutions[0].uniqueName, /Core$/);
  assert.match(result.proposedSolutions[1].uniqueName, /WebAssets$/);
  assert.equal(result.proposedSolutions[2].uniqueName, 'Test_Future');
  assert.equal(result.proposedSolutions[2].isFutureBuffer, true);
  assert.equal(result.proposedSolutions[0].order, 1);
  assert.equal(result.proposedSolutions[1].order, 2);
  assert.equal(result.proposedSolutions[2].order, 3);
});

test('computeSplitPlan produces 4 partition solutions + 1 Future buffer for Change-Frequency split', () => {
  const result = computeSplitPlan({
    estimate: baseEstimate({ totalSizeMB: 74, componentCountSiteTotal: 7200, cloudFlowCount: 12 }),
    config: baseConfig(),
    meta: { baseName: 'Test', siteName: 'Test Site' },
  });
  assert.equal(result.proposedSolutions.length, 5);
  const names = result.proposedSolutions.map((s) => s.uniqueName);
  assert.deepEqual(names, [
    'Test_Foundation',
    'Test_Integration',
    'Test_Config',
    'Test_Content',
    'Test_Future',
  ]);
  assert.equal(result.proposedSolutions[4].isFutureBuffer, true);
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
  // 2 explicit domains + 1 Site solution + 1 Future buffer
  assert.equal(result.proposedSolutions.length, 4);
  assert.equal(result.proposedSolutions[0].uniqueName, 'Test_Catalog');
  assert.equal(result.proposedSolutions[1].uniqueName, 'Test_Orders');
  assert.equal(result.proposedSolutions[2].uniqueName, 'Test_Site');
  assert.equal(result.proposedSolutions[3].uniqueName, 'Test_Future');
  assert.equal(result.proposedSolutions[3].isFutureBuffer, true);
});

test('computeSplitPlan Strategy 3 packs tables by capacity (no domains configured) — bounded, not per-table', () => {
  const result = computeSplitPlan({
    estimate: baseEstimate({
      tableCount: 22,
      schemaAttrCount: 16000, // > maxSchemaAttrs(15000) -> 2 buckets by attrs
      tables: [
        { logicalName: 'tst_product', attributeCount: 4000 },
        { logicalName: 'tst_productVariant', attributeCount: 4000 },
        { logicalName: 'tst_order', attributeCount: 4000 },
        { logicalName: 'tst_orderLine', attributeCount: 4000 },
      ],
    }),
    config: baseConfig(),
    meta: { baseName: 'Test', siteName: 'Test Site' },
  });
  assert.equal(result.splitStrategy, 'strategy-3-schema-segmentation');
  const tableSolutions = result.proposedSolutions.filter(
    (s) => Array.isArray(s.componentTypes) && s.componentTypes.length === 1 && s.componentTypes[0] === 'Table',
  );
  assert.equal(tableSolutions.length, 2, '16000 attrs / 15000 cap -> 2 Table solutions, not one-per-table');
});

test('computeSplitPlan Strategy 3 never overflows the attr cap when independent clusters fragment', () => {
  // Regression for the FFD under-allocation bug: 4 INDEPENDENT (no-edge) tables of
  // 8000 attrs each = 32000 total. Seeding the packer from the lower bound
  // ceil(32000/15000)=3 gave only 3 bins, so the 4th cluster fell into the
  // least-loaded bucket -> 16000 attrs (> 15000 cap), unwarned. The packer must
  // instead open a 4th bin (clusters.length permits it) so no bucket busts the cap.
  const result = computeSplitPlan({
    estimate: baseEstimate({
      tableCount: 4,
      schemaAttrCount: 32000,
      tables: [
        { logicalName: 'tst_alpha', attributeCount: 8000 },
        { logicalName: 'tst_beta', attributeCount: 8000 },
        { logicalName: 'tst_gamma', attributeCount: 8000 },
        { logicalName: 'tst_delta', attributeCount: 8000 },
      ],
      tableRelationships: [], // no edges -> 4 singleton clusters
    }),
    config: baseConfig(),
    meta: { baseName: 'Test', siteName: 'Test Site' },
  });
  assert.equal(result.splitStrategy, 'strategy-3-schema-segmentation');
  const tableSolutions = result.proposedSolutions.filter(
    (s) => Array.isArray(s.componentTypes) && s.componentTypes.length === 1 && s.componentTypes[0] === 'Table',
  );
  // 4 independent 8000-attr tables -> 4 single-table solutions (each 8000 < 15000),
  // NOT 3 with one 16000-attr overflow bucket.
  assert.equal(tableSolutions.length, 4, '4 independent 8000-attr tables -> 4 Table solutions (no attr-cap overflow)');
  for (const s of tableSolutions) {
    assert.equal(s.tableLogicalNames.length, 1, `${s.uniqueName} must hold exactly one table — no bucket over the attr cap`);
  }
});

test('computeSplitPlan WARNS when >maxSchemaSplitSolutions independent attr-heavy clusters bust the attr cap (ceiling boundary)', () => {
  // 9 INDEPENDENT (no-edge) 14000-attr tables, ceiling=8: the packer can open at
  // most 8 buckets, so FFD's least-loaded fallback co-locates 2 tables in one
  // solution -> 28000 attrs > maxSchemaAttrs(15000). The table-count guard misses
  // it (each solution has <=2 tables, well under maxTableCount). The attr guard
  // must surface it. (Regression for the ceiling-boundary silent overflow.)
  const tables = Array.from({ length: 9 }, (_, i) => ({ logicalName: `tst_t${i}`, attributeCount: 14000 }));
  const result = computeSplitPlan({
    estimate: baseEstimate({ tableCount: 9, schemaAttrCount: 9 * 14000, tables, tableRelationships: [] }),
    config: baseConfig(),
    meta: { baseName: 'Test', siteName: 'Test Site' },
  });
  assert.equal(result.splitStrategy, 'strategy-3-schema-segmentation');
  const attrWarn = (result.recommendations || []).find((r) => /columns — above the .* per-solution cap/i.test(r.message || ''));
  assert.ok(attrWarn, 'expected an oversized-schema (attr-cap) warning when a Table solution exceeds maxSchemaAttrs at the ceiling');
});

test('computeSplitPlan: a Table domain componentCount is a schema-component proxy (sum attrs + 1/table), not the table count', () => {
  // Counting 1-per-table severely undercounts solution components and can let an
  // over-cap solution slip past validateSplits. Proxy = sum(attributeCount) + 1/table.
  const result = computeSplitPlan({
    // tableCount:34 makes the schema "red" so Strategy 3 fires; the proxy reads the
    // per-table attributeCount from tables[] (500 + 300), independent of the global count.
    estimate: baseEstimate({
      tableCount: 34,
      schemaAttrCount: 32000,
      tables: [
        { logicalName: 'tst_product', attributeCount: 500 },
        { logicalName: 'tst_category', attributeCount: 300 },
      ],
    }),
    config: baseConfig({ domains: [{ name: 'Catalog', tableLogicalNames: ['tst_product', 'tst_category'] }] }),
    meta: { baseName: 'Test', siteName: 'Test Site' },
  });
  assert.equal(result.splitStrategy, 'strategy-3-schema-segmentation');
  const catalog = result.proposedSolutions.find((s) => s.uniqueName === 'Test_Catalog');
  assert.ok(catalog, 'Catalog Table domain solution exists');
  assert.equal(catalog.componentCount, 802, 'sum(500+300) + 2 tables = 802 (proxy), not 2 (table count)');
});

test('computeSplitPlan: schema-component proxy + attr-cap guard are CASE-INSENSITIVE on table names', () => {
  // estimate.tables carry Dataverse LogicalName casing (e.g. bp_Inspection), but a
  // user-authored .alm-config.json domain may list them in another case. The proxy
  // (and the attr-cap guard) must match case-insensitively — otherwise the lookups
  // miss, attrs read as 0, and the count collapses to the bare table count.
  const result = computeSplitPlan({
    estimate: baseEstimate({
      tableCount: 34,
      schemaAttrCount: 32000,
      tables: [
        { logicalName: 'bp_Inspection', attributeCount: 500 }, // Dataverse casing
        { logicalName: 'bp_Permit', attributeCount: 300 },
      ],
    }),
    config: baseConfig({ domains: [{ name: 'Core', tableLogicalNames: ['bp_inspection', 'bp_permit'] }] }), // lower-case
    meta: { baseName: 'Test', siteName: 'Test Site' },
  });
  const core = result.proposedSolutions.find((s) => s.uniqueName === 'Test_Core');
  assert.ok(core, 'Core domain solution exists');
  assert.equal(core.componentCount, 802, 'case-insensitive proxy: 500+300+2 = 802, not 2 (missed lookups)');
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
  // Even additive flows still end with the Future buffer.
  const last = result.proposedSolutions[result.proposedSolutions.length - 1];
  assert.equal(last.uniqueName, 'Test_Future');
  assert.equal(last.isFutureBuffer, true);
});

// --- Future buffer behavior -------------------------------------------------

test('single-solution plan does NOT get a Future buffer appended', () => {
  const result = computeSplitPlan({
    estimate: baseEstimate(),
    config: baseConfig(),
    meta: { baseName: 'Test', siteName: 'Test Site' },
  });
  assert.equal(result.splitStrategy, 'single');
  assert.equal(result.proposedSolutions.length, 1, 'single plan should stay one solution');
  assert.ok(
    !result.proposedSolutions.some((s) => s.isFutureBuffer),
    'single plan has no partition to protect — no Future buffer expected'
  );
});

test('Future buffer has zero size, zero count, and isFutureBuffer flag set', () => {
  const result = computeSplitPlan({
    estimate: baseEstimate({ totalSizeMB: 142, webFilesAggregateMB: 110 }),
    config: baseConfig(),
    meta: { baseName: 'Test', siteName: 'Test Site' },
  });
  const future = result.proposedSolutions.find((s) => s.isFutureBuffer);
  assert.ok(future, 'Future buffer should be present in a multi-solution split');
  assert.equal(future.sizeMB, 0);
  assert.equal(future.componentCount, 0);
  assert.deepEqual(future.components, []);
  assert.deepEqual(future.componentTypes, ['Any']);
  assert.match(future.description, /new components added to the site/i);
});

test('Future buffer uses consistent naming and is always the last entry', () => {
  // Run multiple strategies; Future should always come last with the same suffix.
  const cases = [
    { label: 'layer', est: baseEstimate({ totalSizeMB: 142, webFilesAggregateMB: 110 }) },
    { label: 'change-freq', est: baseEstimate({ totalSizeMB: 74, componentCountSiteTotal: 7200, cloudFlowCount: 12 }) },
    { label: 'schema', est: baseEstimate({ tableCount: 34, schemaAttrCount: 32000 }) },
  ];
  for (const c of cases) {
    const result = computeSplitPlan({
      estimate: c.est,
      config: baseConfig(),
      meta: { baseName: 'Test', siteName: 'Test Site' },
    });
    const last = result.proposedSolutions[result.proposedSolutions.length - 1];
    assert.equal(last.uniqueName, 'Test_Future', `${c.label}: last solution should be Test_Future`);
    assert.equal(last.order, result.proposedSolutions.length, `${c.label}: Future should have the highest order`);
  }
});

test('appendFutureBuffer exported and idempotent-safe on single-entry arrays', () => {
  const { appendFutureBuffer } = require('../lib/compute-split-plan');
  const single = [{ uniqueName: 'Alpha', order: 1 }];
  // Single-entry arrays represent a single-solution plan — no buffer.
  assert.deepEqual(appendFutureBuffer(single, { baseName: 'X', siteName: 'X' }), single);
  // Multi-entry arrays get the buffer appended exactly once.
  const multi = [
    { uniqueName: 'Alpha', order: 1 },
    { uniqueName: 'Beta', order: 2 },
  ];
  const out = appendFutureBuffer(multi, { baseName: 'X', siteName: 'X Site' });
  assert.equal(out.length, 3);
  assert.equal(out[2].uniqueName, 'X_Future');
  assert.equal(out[2].order, 3);
  // Empty/invalid input shape: return as-is.
  assert.deepEqual(appendFutureBuffer([], { baseName: 'X', siteName: 'X' }), []);
  assert.deepEqual(appendFutureBuffer(null, { baseName: 'X', siteName: 'X' }), null);
});

// --- Size + count composite enforcement ------------------------------------

test('Scenario F: size red + count red, web-heavy → Layer split sub-partitions Core when Core still over count cap', () => {
  const result = computeSplitPlan({
    estimate: baseEstimate({
      totalSizeMB: 200,
      webFilesAggregateMB: 110,
      componentCountSiteTotal: 8000,
      webFileCount: 400,
    }),
    config: baseConfig(),
    meta: { baseName: 'Test', siteName: 'Test Site' },
  });
  assert.equal(result.splitStrategy, 'strategy-1-layer');
  assert.equal(result.compositeSubPartitioned, true);
  assert.ok(result.appliedStrategies.includes('composite-sub-partition'));
  const names = result.proposedSolutions.map((s) => s.uniqueName);
  // Core was sub-partitioned; WebAssets and Future stayed.
  assert.ok(names.includes('Test_Core_Foundation'), `expected Test_Core_Foundation in ${names.join(',')}`);
  assert.ok(names.includes('Test_Core_Content'), `expected Test_Core_Content in ${names.join(',')}`);
  assert.ok(names.includes('Test_WebAssets'), `expected Test_WebAssets in ${names.join(',')}`);
  assert.ok(names.includes('Test_Future'), `expected Test_Future in ${names.join(',')}`);
  // The original Core entry should NOT survive — it was replaced.
  assert.ok(!names.includes('Test_Core'), `Test_Core should be replaced by sub-children, got ${names.join(',')}`);
});

test('Scenario G: size red + count red, NOT web-heavy → primary is Strategy 2 and already partitions appropriately', () => {
  const result = computeSplitPlan({
    estimate: baseEstimate({
      totalSizeMB: 120,
      webFilesAggregateMB: 10,
      componentCountSiteTotal: 6000,
      cloudFlowCount: 10,
    }),
    config: baseConfig(),
    meta: { baseName: 'Test', siteName: 'Test Site' },
  });
  assert.equal(result.splitStrategy, 'strategy-2-change-frequency');
  // Change-frequency already split counts — no sub-partition pass.
  assert.ok(!result.compositeSubPartitioned, 'expected compositeSubPartitioned to be falsy');
  assert.ok(
    !result.appliedStrategies.includes('composite-sub-partition'),
    'composite-sub-partition should not be in appliedStrategies',
  );
});

test('validateSplits emits a count warning when a split exceeds maxComponentCount', () => {
  const t = { ...DEFAULTS };
  const overCount = validateSplits(
    [{ uniqueName: 'X', sizeMB: 50, componentCount: 5000 }],
    t,
  );
  assert.equal(overCount.length, 1);
  assert.match(overCount[0].message, /components/);

  const futureBuffer = validateSplits(
    [{ uniqueName: 'X_Future', sizeMB: 0, componentCount: 0, isFutureBuffer: true }],
    t,
  );
  assert.equal(futureBuffer.length, 0, 'future buffer must never produce a warning');

  // Defensive: even if a future buffer somehow had high counts, still no warning.
  const futureWithHighCount = validateSplits(
    [{ uniqueName: 'X_Future', sizeMB: 99, componentCount: 9000, isFutureBuffer: true }],
    t,
  );
  assert.equal(futureWithHighCount.length, 0);
});

test('Future buffer is not sub-partitioned even when over cap (defensive — should never happen)', () => {
  const t = { ...DEFAULTS };
  const input = [
    {
      uniqueName: 'X_Future',
      displayName: 'X — Future Growth',
      order: 1,
      componentTypes: ['Any'],
      sizeMB: 99,
      componentCount: 9000,
      components: [],
      isFutureBuffer: true,
    },
  ];
  const { solutions, modified } = subPartitionIfOverCap(input, baseEstimate(), t);
  assert.equal(modified, false, 'future buffer should never trigger a sub-partition');
  assert.equal(solutions.length, 1);
  assert.equal(solutions[0].uniqueName, 'X_Future');
});

test('sub-partition path tags appliedStrategies and compositeSubPartitioned correctly', () => {
  const result = computeSplitPlan({
    estimate: baseEstimate({
      totalSizeMB: 200,
      webFilesAggregateMB: 110,
      componentCountSiteTotal: 8000,
      webFileCount: 400,
    }),
    config: baseConfig(),
    meta: { baseName: 'Test', siteName: 'Test Site' },
  });
  assert.equal(result.compositeSubPartitioned, true);
  assert.ok(result.appliedStrategies.includes('strategy-1-layer'));
  assert.ok(result.appliedStrategies.includes('composite-sub-partition'));
});

test('sub-partition preserves componentTypes coverage: every type the parent claimed has a child claimer', () => {
  // Regression guard: an earlier buildSubChildren dropped Cloud Flow / Bot
  // Component / Environment Variable from the union of sub-child
  // componentTypes when flows < changeFreqMinFlows AND additive Strategy 4
  // wasn't firing. Those types existed on the site but had no owner solution
  // after sub-partition — setup-solution Phase 5 routing fell them to Default.
  //
  // This scenario: web-heavy + count-heavy → Layer + sub-partition. NO additive
  // Strategy 4 (envVarCount under cap). cloudFlowCount=2, botCount=0 — under
  // the changeFreqMinFlows threshold (5). Pre-fix: _Integration not emitted,
  // Cloud Flow / Bot Component / Environment Variable missing from union.
  const result = computeSplitPlan({
    estimate: baseEstimate({
      totalSizeMB: 200,
      webFilesAggregateMB: 110,
      componentCountSiteTotal: 8000,
      webFileCount: 400,
      cloudFlowCount: 2,
      botCount: 0,
      envVarCount: 10,  // under maxEnvVarCount, no additive Strategy 4
    }),
    config: baseConfig(),
    meta: { baseName: 'Test', siteName: 'Test Site' },
  });
  assert.equal(result.compositeSubPartitioned, true, 'sub-partition must have fired');
  assert.ok(!result.appliedStrategies.includes('strategy-4-config-isolation'), 'additive Strategy 4 must NOT fire for this scenario');

  // Build the union of all componentTypes claimed by all non-buffer solutions.
  const claimedTypes = new Set();
  for (const s of result.proposedSolutions) {
    if (s.isFutureBuffer) continue;
    for (const t of (s.componentTypes || [])) claimedTypes.add(t);
  }

  // Parent Strategy 1 Core claimed these — every one needs a claimer post-sub.
  const requiredTypes = [
    'Table', 'Site Setting', 'Web Role', 'Table Permission',
    'Cloud Flow', 'Environment Variable', 'Bot Component',
  ];
  for (const t of requiredTypes) {
    assert.ok(
      claimedTypes.has(t),
      `componentType '${t}' must have an owner solution after sub-partition. Claimed: ${[...claimedTypes].join(', ')}`,
    );
  }

  // _Integration MUST exist when flows + bots > 0, even below changeFreqMinFlows.
  const integrationSol = result.proposedSolutions.find((s) => /_Integration$/.test(s.uniqueName));
  assert.ok(integrationSol, 'Test_Core_Integration must be emitted when flows + bots > 0');
  assert.ok(integrationSol.componentTypes.includes('Cloud Flow'));
});

test('Layer + sub-partition + additive Strategy 4: env vars are NOT double-claimed across solutions', () => {
  // Stress case: web-heavy (triggers Layer), count-heavy (triggers sub-partition
  // of Core), AND env-var-heavy (triggers additive Strategy 4). Without the fix
  // for buildSubChildren's Config componentTypes, both `_EnvVars` (additive)
  // AND `_Core_Config` (sub-partition) would list 'Environment Variable',
  // creating a double-claim that breaks setup-solution's componentType routing.
  const result = computeSplitPlan({
    estimate: baseEstimate({
      totalSizeMB: 200,
      webFilesAggregateMB: 110,
      componentCountSiteTotal: 8000,
      webFileCount: 400,
      envVarCount: 800,
    }),
    config: baseConfig(),
    meta: { baseName: 'Test', siteName: 'Test Site' },
  });

  // All three strategies should be applied.
  assert.ok(result.appliedStrategies.includes('strategy-1-layer'));
  assert.ok(result.appliedStrategies.includes('composite-sub-partition'));
  assert.ok(result.appliedStrategies.includes('strategy-4-config-isolation'));
  assert.equal(result.compositeSubPartitioned, true);

  // Find the env-var-claiming solutions. Exactly one should claim env vars.
  const envVarClaimers = result.proposedSolutions.filter((s) =>
    Array.isArray(s.componentTypes) && s.componentTypes.includes('Environment Variable'),
  );
  assert.equal(
    envVarClaimers.length,
    1,
    `exactly one solution should claim 'Environment Variable' in componentTypes, got ${envVarClaimers.length}: ${envVarClaimers.map((s) => s.uniqueName).join(', ')}`,
  );
  assert.match(envVarClaimers[0].uniqueName, /_EnvVars$/, 'the env-var claimer should be the additive _EnvVars solution');

  // Sub-partition's _Config must exist (proves sub-partition fired) but not own env vars.
  const subConfig = result.proposedSolutions.find((s) => s.uniqueName === 'Test_Core_Config');
  assert.ok(subConfig, 'expected sub-partition _Core_Config solution');
  assert.ok(
    !subConfig.componentTypes.includes('Environment Variable'),
    `_Core_Config must not claim 'Environment Variable', got componentTypes=${JSON.stringify(subConfig.componentTypes)}`,
  );
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
    baseEstimate({ totalSizeMB: 100, componentCountSiteTotal: 7000, schemaAttrCount: 200 }),
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
  const est = baseEstimate({ componentCountSiteTotal: 12000 });
  const { primary } = selectStrategy(est, baseConfig());
  assert.equal(primary, 'strategy-2-change-frequency');
});

test('Hard-flag component count emits an error-type recommendation', () => {
  const result = computeSplitPlan({
    estimate: baseEstimate({ componentCountSiteTotal: 12000 }),
    config: baseConfig(),
    meta: { baseName: 'Test', siteName: 'Test Site' },
  });
  const hit = result.recommendations.find((r) => r.type === 'error' && /hard-flag/i.test(r.message));
  assert.ok(hit, 'expected an error-type recommendation mentioning the hard-flag threshold');
});

// --- Size / count consistency in Change-Frequency partition ----------------

test('partitionByChangeFrequency sums sizeMB back to totalSizeMB (±0.5)', () => {
  const est = baseEstimate({ totalSizeMB: 74, componentCountSiteTotal: 7200, cloudFlowCount: 12 });
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

// --- dependency-aware capacity packing (the "21 solutions" fix) --------------

function makeTables(n, attrsEach, prefix = 'tbl') {
  return Array.from({ length: n }, (_, i) => ({ logicalName: `${prefix}_${i}`, attributeCount: attrsEach }));
}

test('Strategy 3: 34 distinct tables / 32.3k cols -> a HANDFUL of solutions, never ~34', () => {
  const tables = makeTables(34, 950); // 34 * 950 = 32300
  const result = computeSplitPlan({
    estimate: baseEstimate({ totalSizeMB: 68, tableCount: 34, schemaAttrCount: 32300, componentCountSiteTotal: 3000, tables, tableRelationships: [] }),
    config: baseConfig(),
    meta: { baseName: 'Big', siteName: 'Big Site' },
  });
  assert.equal(result.splitStrategy, 'strategy-3-schema-segmentation');
  const tableSolutions = result.proposedSolutions.filter((s) => s.componentTypes && s.componentTypes[0] === 'Table' && s.componentTypes.length === 1);
  assert.ok(tableSolutions.length >= 2 && tableSolutions.length <= 8, `expected a handful of Table solutions, got ${tableSolutions.length}`);
  // Every Table solution stays under the per-solution table cap.
  for (const s of tableSolutions) {
    assert.ok(s.tableLogicalNames.length <= 20, `Table solution ${s.uniqueName} has ${s.tableLogicalNames.length} tables (> cap)`);
  }
  // All 34 tables are placed exactly once across the Table solutions.
  const placed = tableSolutions.flatMap((s) => s.tableLogicalNames);
  assert.equal(placed.length, 34);
  assert.equal(new Set(placed).size, 34);
});

test('Strategy 3: 22 tables with low cols -> 2 Table solutions (count-driven), not 22', () => {
  const tables = makeTables(22, 50);
  const result = computeSplitPlan({
    estimate: baseEstimate({ tableCount: 22, schemaAttrCount: 1100, tables, tableRelationships: [] }),
    config: baseConfig(),
    meta: { baseName: 'M', siteName: 'M' },
  });
  assert.equal(result.splitStrategy, 'strategy-3-schema-segmentation');
  const tableSolutions = result.proposedSolutions.filter((s) => s.componentTypes && s.componentTypes[0] === 'Table' && s.componentTypes.length === 1);
  assert.equal(tableSolutions.length, 2, '22 tables / 20-per-solution -> 2 Table solutions');
});

test('Strategy 3 does NOT trigger for <=20 tables with low cols -> single', () => {
  const tables = makeTables(18, 50);
  const { primary } = selectStrategy(baseEstimate({ tableCount: 18, schemaAttrCount: 900, tables }), baseConfig());
  assert.equal(primary, 'single');
});

test('Strategy 3: dependency clusters are never split across solutions', () => {
  // Cluster A (4 tables) + Cluster B (2 tables) + 20 standalone = 26 tables, low cols.
  const clusterA = ['rel_a0', 'rel_a1', 'rel_a2', 'rel_a3'];
  const clusterB = ['rel_b0', 'rel_b1'];
  const standalone = makeTables(20, 50, 'solo').map((t) => t.logicalName);
  const tables = [...clusterA, ...clusterB, ...standalone].map((n) => ({ logicalName: n, attributeCount: 50 }));
  const edges = [
    ['rel_a0', 'rel_a1'], ['rel_a1', 'rel_a2'], ['rel_a2', 'rel_a3'], // A connected
    ['rel_b0', 'rel_b1'],                                              // B connected
  ];
  const result = computeSplitPlan({
    estimate: baseEstimate({ tableCount: 26, schemaAttrCount: 1300, tables, tableRelationships: edges }),
    config: baseConfig(),
    meta: { baseName: 'Dep', siteName: 'Dep' },
  });
  assert.equal(result.splitStrategy, 'strategy-3-schema-segmentation');
  const tableSolutions = result.proposedSolutions.filter((s) => s.componentTypes && s.componentTypes[0] === 'Table' && s.componentTypes.length === 1);
  const home = (name) => tableSolutions.findIndex((s) => s.tableLogicalNames.includes(name));
  // Every table in cluster A shares one solution; same for B.
  assert.ok(home('rel_a0') !== -1);
  assert.ok(clusterA.every((n) => home(n) === home('rel_a0')), 'cluster A must not be split across solutions');
  assert.ok(clusterB.every((n) => home(n) === home('rel_b0')), 'cluster B must not be split across solutions');
});

test('Strategy 3: an oversized single cluster (>cap) stays whole + raises a warning', () => {
  // 25 tables all chained into ONE connected cluster -> cannot be split.
  const names = makeTables(25, 50, 'big').map((t) => t.logicalName);
  const tables = names.map((n) => ({ logicalName: n, attributeCount: 50 }));
  const edges = names.slice(1).map((n, i) => [names[i], n]); // chain a0-a1-a2-...-a24
  const result = computeSplitPlan({
    estimate: baseEstimate({ tableCount: 25, schemaAttrCount: 1250, tables, tableRelationships: edges }),
    config: baseConfig(),
    meta: { baseName: 'Mega', siteName: 'Mega' },
  });
  const tableSolutions = result.proposedSolutions.filter((s) => s.componentTypes && s.componentTypes[0] === 'Table' && s.componentTypes.length === 1);
  assert.equal(tableSolutions.length, 1, 'one indivisible cluster -> one Table solution');
  assert.equal(tableSolutions[0].tableLogicalNames.length, 25);
  assert.ok(result.recommendations.some((r) => /dependency cluster that cannot be split/.test(r.message)), 'oversized-cluster warning must fire');
});
