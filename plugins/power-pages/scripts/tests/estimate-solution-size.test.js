const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyPPCs, estimateTotalSize, BYTES_PER } = require('../lib/estimate-solution-size');

// --- classifyPPCs -----------------------------------------------------------

test('classifyPPCs buckets components by authoritative powerpagecomponenttype picklist values', () => {
  // Picklist values sourced from MS Learn / PPC_TYPE_LABELS. Earlier iterations
  // of this test asserted against swapped constants (WEB_FILE=2, WEB_PAGE=4,
  // WEB_TEMPLATE=11) which happened to hide a real bug where web file sizing
  // was silently querying web pages. Fixed 2026-04-22.
  const ppcs = [
    { powerpagecomponentid: 'a', name: 'FeatureFlag', powerpagecomponenttype: 9 },   // Site Setting
    { powerpagecomponentid: 'b', name: 'SearchEnabled', powerpagecomponenttype: 9 },
    { powerpagecomponentid: 'c', name: 'Admin', powerpagecomponenttype: 11 },        // Web Role
    { powerpagecomponentid: 'd', name: 'Contact permission', powerpagecomponenttype: 18 }, // Table Permission
    { powerpagecomponentid: 'e', name: 'Bot Consumer', powerpagecomponenttype: 27 }, // Bot Consumer
    { powerpagecomponentid: 'f', name: 'FlowBinding', powerpagecomponenttype: 33 },  // Cloud Flow
    { powerpagecomponentid: 'g', name: 'hero.jpg', powerpagecomponenttype: 3 },      // Web File (static asset)
    { powerpagecomponentid: 'g2', name: 'Home-BPuZZDcA.js', powerpagecomponenttype: 3 }, // Web File (bundle chunk)
    { powerpagecomponentid: 'h', name: 'Home', powerpagecomponenttype: 2 },          // Web Page
    { powerpagecomponentid: 'i', name: 'layout', powerpagecomponenttype: 8 },        // Web Template
    { powerpagecomponentid: 'j', name: '?', powerpagecomponenttype: 999 },           // unknown
  ];
  const c = classifyPPCs(ppcs);
  assert.equal(c.siteSettings.length, 2);
  assert.equal(c.webRoles.length, 1);
  assert.equal(c.tablePermissions.length, 1);
  assert.equal(c.botConsumers.length, 1);
  assert.equal(c.cloudFlowLinks.length, 1);
  // webFiles is now the "real content" bucket — bundle chunks are split out.
  assert.equal(c.webFiles.length, 1, 'hero.jpg is a real web file');
  assert.equal(c.bundleChunks.length, 1, 'Home-BPuZZDcA.js is a hash-suffixed chunk');
  assert.equal(c.webPages.length, 1);
  assert.equal(c.webTemplates.length, 1);
  assert.equal(c.all.length, 11);
  // Unknown types stay in byType but don't appear in any named bucket.
  assert.ok(c.byType.has(999));
});

test('classifyPPCs isProbablyBundleChunk heuristic identifies Vite/Rollup chunks without false positives on real assets', () => {
  const samples = [
    // Should be flagged as chunks
    { name: 'Home-BPuZZDcA.js', powerpagecomponenttype: 3 },
    { name: 'index-DyzztwOp.js', powerpagecomponenttype: 3 },
    { name: 'purchaseOrderService-CEILvOTp.js', powerpagecomponenttype: 3 },
    { name: 'chunk-RxR9EgHz.mjs', powerpagecomponenttype: 3 },
    { name: 'vendor.a1b2c3d4.js', powerpagecomponenttype: 3 },
    { name: 'style.Z0qHD57j.css', powerpagecomponenttype: 3 },
    { name: 'index-DyzztwOp.js.map', powerpagecomponenttype: 3 },
    // Should NOT be flagged
    { name: 'hero.jpg', powerpagecomponenttype: 3 },
    { name: 'logo.svg', powerpagecomponenttype: 3 },
    { name: 'favicon.ico', powerpagecomponenttype: 3 },
    { name: 'app.js', powerpagecomponenttype: 3 },
    { name: 'style.css', powerpagecomponenttype: 3 },
    { name: 'robots.txt', powerpagecomponenttype: 3 },
    { name: 'fonts/Inter-Regular.woff2', powerpagecomponenttype: 3 },
  ];
  const c = classifyPPCs(samples);
  assert.equal(c.bundleChunks.length, 7, 'should flag all 7 hash-suffixed chunks');
  assert.equal(c.webFiles.length, 7, 'should keep all 7 real assets as web files');
});

test('classifyPPCs returns empty arrays when a type is missing', () => {
  const c = classifyPPCs([{ powerpagecomponentid: 'x', powerpagecomponenttype: 999 }]);
  assert.deepEqual(c.siteSettings, []);
  assert.deepEqual(c.webFiles, []);
  assert.deepEqual(c.webPages, []);
});

test('classifyPPCs handles empty input', () => {
  const c = classifyPPCs([]);
  assert.equal(c.all.length, 0);
  assert.equal(c.byType.size, 0);
  assert.deepEqual(c.siteSettings, []);
});

// --- estimateTotalSize ------------------------------------------------------

function emptyClassified() {
  return {
    siteSettings: [], webRoles: [], tablePermissions: [],
    botConsumers: [], cloudFlowLinks: [],
    webFiles: [], webPages: [], webTemplates: [],
  };
}

test('estimateTotalSize returns 0 MB for an empty site', () => {
  const mb = estimateTotalSize({
    classified: emptyClassified(),
    tables: [],
    schemaAttrCount: 0,
    webFilesAggregateBytes: 0,
    envVarCount: 0,
  });
  assert.equal(mb, 0);
});

test('estimateTotalSize is stable and proportional to inputs', () => {
  const mb = estimateTotalSize({
    classified: {
      ...emptyClassified(),
      siteSettings: new Array(10).fill({}),
      cloudFlowLinks: new Array(2).fill({}),
    },
    tables: [{ logicalName: 'tst_a' }, { logicalName: 'tst_b' }],
    schemaAttrCount: 100,
    webFilesAggregateBytes: 5 * 1024 * 1024, // 5 MB
    envVarCount: 5,
  });
  // 2 tables + 100 attrs + 10 site settings + 2 flows + web files + 5 env vars
  const expectedBytes =
    2 * BYTES_PER.table +
    100 * BYTES_PER.attribute +
    10 * BYTES_PER.sitesetting +
    2 * BYTES_PER.cloudflow +
    5 * 1024 * 1024 +
    5 * BYTES_PER.envvarDef;
  const expectedMB = expectedBytes / (1024 * 1024);
  assert.ok(Math.abs(mb - expectedMB) < 0.01, `expected ~${expectedMB} MB, got ${mb}`);
});

test('estimateTotalSize adds web file aggregate bytes unchanged', () => {
  const mbWithout = estimateTotalSize({
    classified: emptyClassified(),
    tables: [],
    schemaAttrCount: 0,
    webFilesAggregateBytes: 0,
    envVarCount: 0,
  });
  const mbWith = estimateTotalSize({
    classified: emptyClassified(),
    tables: [],
    schemaAttrCount: 0,
    webFilesAggregateBytes: 10 * 1024 * 1024, // +10 MB
    envVarCount: 0,
  });
  assert.ok(Math.abs((mbWith - mbWithout) - 10) < 0.01, 'adding 10 MB of web files should add 10 MB to the estimate');
});

// --- BYTES_PER sanity -------------------------------------------------------

test('BYTES_PER is frozen and cloud flows are the largest per-component cost', () => {
  assert.ok(Object.isFrozen(BYTES_PER));
  // Cloud flows carry embedded JSON — sanity-check that the calibration reflects that.
  assert.ok(BYTES_PER.cloudflow > BYTES_PER.bot);
  assert.ok(BYTES_PER.cloudflow > BYTES_PER.table);
});
