const test = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('../lib/validation-helpers');
const {
  classifyPPCs,
  estimateTotalSize,
  estimateSolutionSize,
  BYTES_PER,
} = require('../lib/estimate-solution-size');

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

// --- estimateSolutionSize pagination integration test -----------------------
//
// Regression test for the field-reported bug where webFileCount capped at ~500
// on stress-test sites with 6000+ web files. Root cause: the OData queries in
// this file lacked `Prefer: odata.maxpagesize=N`, so Dataverse honored `$top=500`
// but never emitted `@odata.nextLink` — paging silently truncated at one page.
//
// This test simulates a 6500-row `powerpagecomponents` response via a mocked
// `helpers.makeRequest`. The pagination plumbing is asserted end-to-end:
//   (a) odataGet sends `Prefer: odata.maxpagesize=...` on every page
//   (b) collectPaginated follows `@odata.nextLink` until exhausted
//   (c) the resulting `ppcs.length` matches the simulated server total
//   (d) the truncation canary does NOT fire on correct pagination
//   (e) `componentCountSiteTotal` reflects the full set
//
// And a second case asserts the canary DOES fire when the mock fakes a
// truncation (returns only the first page despite a higher `@odata.count`).

function withMockedMakeRequest(t, handler) {
  const original = helpers.makeRequest;
  helpers.makeRequest = handler;
  t.after(() => { helpers.makeRequest = original; });
}

// Build a fake makeRequest that returns paginated OData responses for the
// powerpagecomponents query and minimal/empty responses for everything else.
// `totalPpcs` is how many web-file rows the fake server claims to have.
// `truncate` makes the server return only the first page (no nextLink) even
// though `@odata.count` reports the full total — simulates the bug.
function buildFakeServer({
  totalPpcs,
  pageSize = 5000,
  truncate = false,
  contentBytesPerFile = 0,
  onSingleFetch = null,
} = {}) {
  const ppcRows = [];
  for (let i = 0; i < totalPpcs; i++) {
    ppcRows.push({
      powerpagecomponentid: `ppc-${i.toString().padStart(6, '0')}`,
      name: `webfile-${i}.png`,
      powerpagecomponenttype: 3, // Web File
    });
  }
  // Build a base64 content payload of approximately `contentBytesPerFile`
  // when decoded — base64 expands ~4/3, so encoded length ≈ ceil(bytes*4/3).
  const fakeContent =
    contentBytesPerFile > 0
      ? 'A'.repeat(Math.ceil((contentBytesPerFile * 4) / 3))
      : '';
  return async function fakeMakeRequest({ url }) {
    const u = new URL(url);
    const segments = u.pathname.split('/').filter(Boolean);
    const lastSeg = segments[segments.length - 1] || '';
    // Single-row fetch path: `powerpagecomponents(<id>)`. Detect via paren.
    const singleFetchMatch = lastSeg.match(/^powerpagecomponents\(([^)]+)\)$/);
    if (singleFetchMatch) {
      const id = singleFetchMatch[1];
      if (onSingleFetch) onSingleFetch(id);
      return {
        statusCode: 200,
        body: JSON.stringify({
          powerpagecomponentid: id,
          name: `webfile-${id}.png`,
          content: fakeContent,
        }),
      };
    }

    const entity = lastSeg.split('?')[0];

    // Handle $count=true ground-truth probes (used by truncation canary).
    if (u.searchParams.get('$count') === 'true') {
      return {
        statusCode: 200,
        body: JSON.stringify({
          '@odata.count': entity === 'powerpagecomponents' ? totalPpcs : 0,
          value: [],
        }),
      };
    }

    if (entity === 'powerpagecomponents') {
      const skipParam = u.searchParams.get('$skiptoken') || u.searchParams.get('skiptoken');
      const start = skipParam ? Number(skipParam) : 0;
      const end = Math.min(start + pageSize, totalPpcs);
      const value = ppcRows.slice(start, end);
      // Build a nextLink only when there are more rows AND we're not faking truncation
      const hasMore = end < totalPpcs && !truncate;
      const body = {
        value,
        ...(hasMore ? { '@odata.nextLink': `${u.origin}${u.pathname}?$skiptoken=${end}` } : {}),
      };
      return { statusCode: 200, body: JSON.stringify(body) };
    }

    // powerpagesitelanguages, EntityDefinitions, environmentvariabledefinitions,
    // bots, botcomponents, etc. — return empty
    return { statusCode: 200, body: JSON.stringify({ value: [] }) };
  };
}

test('estimateSolutionSize paginates beyond a single page and reports the full ppc count', async (t) => {
  // Six pages worth (with page size 5000, this would be impossibly large in
  // practice — but we want to test that the page loop terminates correctly).
  const TOTAL = 6500;
  // Give each sampled file enough decoded content (>1 KB) so the
  // suspiciously-small-bytes canary doesn't fire — we want this test to
  // exercise pagination, not the undercount canary.
  withMockedMakeRequest(t, buildFakeServer({ totalPpcs: TOTAL, pageSize: 5000, contentBytesPerFile: 4096 }));

  const result = await estimateSolutionSize({
    envUrl: 'https://test.crm.dynamics.com',
    websiteRecordId: '00000000-0000-0000-0000-000000000001',
    token: 'fake-token',
  });

  assert.equal(result.webFileCount, TOTAL, 'webFileCount should reflect all paginated rows');
  // componentCountSiteTotal = ppcs.length + 1 (root) + 0 (langs) + 0 (tables) + 0 (envvars) + 0 (flows) + 0 (bots) + 0 (botcomps)
  assert.equal(result.componentCountSiteTotal, TOTAL + 1, 'siteTotal should match ppcs + website root');
  assert.equal(result.ppcGroundTruthCount, TOTAL, 'ground-truth count should match');
  assert.equal(result.truncationSuspected, false, 'canary should NOT fire on correct pagination');
  assert.deepEqual(result.truncationWarnings, [], 'no warnings on correct pagination');
});

test('estimateSolutionSize canary fires when server reports more rows than the fetch returned', async (t) => {
  const TOTAL = 6050;
  // truncate=true makes the fake server return page 1 only despite @odata.count=6050.
  withMockedMakeRequest(t, buildFakeServer({ totalPpcs: TOTAL, pageSize: 5000, truncate: true }));

  const result = await estimateSolutionSize({
    envUrl: 'https://test.crm.dynamics.com',
    websiteRecordId: '00000000-0000-0000-0000-000000000001',
    token: 'fake-token',
  });

  // Fetched 5000 (first page), ground-truth says 6050 → canary fires.
  assert.equal(result.webFileCount, 5000, 'truncated fetch should return only first page');
  assert.equal(result.ppcGroundTruthCount, TOTAL);
  assert.equal(result.truncationSuspected, true, 'canary MUST fire when fetch count diverges from ground truth');
  assert.ok(
    result.truncationWarnings.some((w) => /pagination is truncating/i.test(w)),
    'a truncation warning should call out the pagination issue',
  );
});

test('estimateSolutionSize canary flags ppcs.length landing exactly on a page-size multiple', async (t) => {
  // Server claims exactly 5000 rows and returns all of them (no truncation).
  // The page-size-multiple canary should fire even though there is no
  // ground-truth divergence — this is the defensive signal that catches future
  // regressions where the Prefer header is dropped and the row count happens
  // to coincide with a paging boundary.
  withMockedMakeRequest(t, buildFakeServer({ totalPpcs: 5000, pageSize: 5000 }));

  const result = await estimateSolutionSize({
    envUrl: 'https://test.crm.dynamics.com',
    websiteRecordId: '00000000-0000-0000-0000-000000000001',
    token: 'fake-token',
  });

  assert.equal(result.webFileCount, 5000);
  assert.equal(result.truncationSuspected, true, 'page-size-multiple canary should fire');
  assert.ok(
    result.truncationWarnings.some((w) => /full page/.test(w)),
    'page-size-multiple canary message should mention the page boundary',
  );
});

test('estimateSolutionSize canary flags legacy paging boundaries (500/1000/2000)', async (t) => {
  // Simulate the historical regression: response claims 500 rows total AND
  // ground-truth count also says 500, so the divergence check passes — but
  // the legacy-boundary canary should still flag this as suspicious because
  // 500 is the historical $top value that exposed the original bug.
  withMockedMakeRequest(t, buildFakeServer({ totalPpcs: 500, pageSize: 5000 }));

  const result = await estimateSolutionSize({
    envUrl: 'https://test.crm.dynamics.com',
    websiteRecordId: '00000000-0000-0000-0000-000000000001',
    token: 'fake-token',
  });

  assert.equal(result.webFileCount, 500);
  assert.equal(result.truncationSuspected, true, 'legacy-boundary canary should fire on 500');
  assert.ok(
    result.truncationWarnings.some((w) => /historical paging boundary/.test(w)),
    'legacy-boundary canary message should mention the historical boundary',
  );
});

test('estimateSolutionSize odataGet sends the Prefer: odata.maxpagesize header', async (t) => {
  // Regression guard: the moment somebody removes the Prefer header, this
  // test fails — because without it the pagination integration test above
  // would also fail, but this one is a more direct assertion that gives a
  // clearer failure message.
  let observedPreferHeader = null;
  withMockedMakeRequest(t, async ({ url, headers }) => {
    if (url.includes('powerpagecomponents')) {
      observedPreferHeader = headers && headers.Prefer;
    }
    return { statusCode: 200, body: JSON.stringify({ value: [] }) };
  });

  await estimateSolutionSize({
    envUrl: 'https://test.crm.dynamics.com',
    websiteRecordId: '00000000-0000-0000-0000-000000000001',
    token: 'fake-token',
  });

  assert.match(
    observedPreferHeader || '',
    /odata\.maxpagesize=\d+/,
    'odataGet MUST send `Prefer: odata.maxpagesize=N` — without it Dataverse silently truncates at $top',
  );
});

// --- envVarCount solution-scoping regression test ---------------------------
//
// Regression test for "env variable prediction is off" — when the publisher
// prefix is shared across multiple projects in a tenant, the tenant-wide
// `startswith(schemaname, '<prefix>_')` filter returns env vars from unrelated
// projects, inflating envVarCount. After the fix, passing `--solutionId`
// scopes the count via `inSolution.byComponentType[380]`.
//
// Simulates a tenant with 5000 publisher-prefix-matching env var defs (e.g.
// the `new_` or `cr5fe_` cases), of which only 12 belong to the target
// solution. Expectation: envVarCount === 12 (solution scope), and
// envVarCountTenantWide === 5000 (preserved for diagnosability).

test('estimateSolutionSize envVarCount is solution-scoped when --solutionId is passed', async (t) => {
  const TENANT_PREFIX_ENV_VARS = 5000;
  const IN_SOLUTION_ENV_VARS = 12;

  // Mock returns 5000 env var defs matching the prefix, and a solution with
  // 12 componenttype-380 rows (env var defs). All other queries empty.
  withMockedMakeRequest(t, async ({ url }) => {
    const u = new URL(url);
    const entity = u.pathname.split('/').slice(-1)[0].split('?')[0];

    if (entity === 'environmentvariabledefinitions') {
      // Return all 5000 in one page — no pagination needed for this test
      const value = [];
      for (let i = 0; i < TENANT_PREFIX_ENV_VARS; i++) {
        value.push({
          environmentvariabledefinitionid: `def-${i.toString().padStart(5, '0')}`,
          schemaname: `new_Var${i}`,
          displayname: `Var ${i}`,
          type: 100000000,
          defaultvalue: '',
        });
      }
      return { statusCode: 200, body: JSON.stringify({ value }) };
    }

    if (entity === 'solutioncomponents') {
      // Return componenttype distribution for the target solution: 12 env var
      // defs (380), 5 site components, 1 site, etc. Only byComponentType[380]
      // matters for this test.
      const rows = [];
      for (let i = 0; i < IN_SOLUTION_ENV_VARS; i++) {
        rows.push({ objectid: `def-${i.toString().padStart(5, '0')}`, componenttype: 380 });
      }
      // A few other component types so the inSolution block is realistic
      rows.push({ objectid: 'pp-1', componenttype: 10373 });
      rows.push({ objectid: 'site-1', componenttype: 10374 });
      return { statusCode: 200, body: JSON.stringify({ value: rows }) };
    }

    if (entity === 'powerpagecomponents' && u.searchParams.get('$count') === 'true') {
      return { statusCode: 200, body: JSON.stringify({ '@odata.count': 0, value: [] }) };
    }

    // powerpagecomponents (regular fetch), EntityDefinitions, languages, bots, etc.
    return { statusCode: 200, body: JSON.stringify({ value: [] }) };
  });

  const result = await estimateSolutionSize({
    envUrl: 'https://test.crm.dynamics.com',
    websiteRecordId: '00000000-0000-0000-0000-000000000001',
    publisherPrefix: 'new',
    solutionId: '00000000-0000-0000-0000-000000000099',
    token: 'fake-token',
  });

  assert.equal(result.envVarCount, IN_SOLUTION_ENV_VARS, 'envVarCount MUST reflect the solution-scoped count, not the tenant-wide prefix match');
  assert.equal(result.envVarCountScope, 'solution', 'scope field must indicate the solution scoping');
  assert.equal(result.envVarCountTenantWide, TENANT_PREFIX_ENV_VARS, 'tenant-wide count preserved for diagnosability');
});

test('estimateSolutionSize envVarCount falls back to publisher-prefix when --solutionId omitted', async (t) => {
  const TENANT_PREFIX_ENV_VARS = 42;
  withMockedMakeRequest(t, async ({ url }) => {
    const u = new URL(url);
    const entity = u.pathname.split('/').slice(-1)[0].split('?')[0];
    if (entity === 'environmentvariabledefinitions') {
      const value = [];
      for (let i = 0; i < TENANT_PREFIX_ENV_VARS; i++) {
        value.push({
          environmentvariabledefinitionid: `def-${i}`,
          schemaname: `new_Var${i}`,
          type: 100000000,
        });
      }
      return { statusCode: 200, body: JSON.stringify({ value }) };
    }
    if (entity === 'powerpagecomponents' && u.searchParams.get('$count') === 'true') {
      return { statusCode: 200, body: JSON.stringify({ '@odata.count': 0, value: [] }) };
    }
    return { statusCode: 200, body: JSON.stringify({ value: [] }) };
  });

  const result = await estimateSolutionSize({
    envUrl: 'https://test.crm.dynamics.com',
    websiteRecordId: '00000000-0000-0000-0000-000000000001',
    publisherPrefix: 'new',
    // no solutionId
    token: 'fake-token',
  });

  assert.equal(result.envVarCount, TENANT_PREFIX_ENV_VARS, 'without --solutionId, falls back to publisher-prefix tenant-wide count');
  assert.equal(result.envVarCountScope, 'publisher-prefix', 'scope label reflects the wider fallback');
  assert.equal(result.envVarCountTenantWide, TENANT_PREFIX_ENV_VARS);
});

test('estimateSolutionSize envVarCount returns 0 (with scope=solution) when target solution has no env var defs', async (t) => {
  // Tenant has 100 prefix-matching env vars, but the solution has zero
  // componenttype-380 rows. envVarCount must reflect the solution truth (0),
  // not silently fall back to the tenant-wide number.
  withMockedMakeRequest(t, async ({ url }) => {
    const u = new URL(url);
    const entity = u.pathname.split('/').slice(-1)[0].split('?')[0];
    if (entity === 'environmentvariabledefinitions') {
      const value = [];
      for (let i = 0; i < 100; i++) value.push({ environmentvariabledefinitionid: `d${i}`, schemaname: `new_X${i}`, type: 100000000 });
      return { statusCode: 200, body: JSON.stringify({ value }) };
    }
    if (entity === 'solutioncomponents') {
      // Solution exists but has no env var defs — only a site component or two.
      return {
        statusCode: 200,
        body: JSON.stringify({ value: [{ objectid: 'pp-1', componenttype: 10373 }] }),
      };
    }
    if (entity === 'powerpagecomponents' && u.searchParams.get('$count') === 'true') {
      return { statusCode: 200, body: JSON.stringify({ '@odata.count': 0, value: [] }) };
    }
    return { statusCode: 200, body: JSON.stringify({ value: [] }) };
  });

  const result = await estimateSolutionSize({
    envUrl: 'https://test.crm.dynamics.com',
    websiteRecordId: '00000000-0000-0000-0000-000000000001',
    publisherPrefix: 'new',
    solutionId: '00000000-0000-0000-0000-000000000099',
    token: 'fake-token',
  });

  assert.equal(result.envVarCount, 0, 'envVarCount must reflect solution truth (zero env var defs)');
  assert.equal(result.envVarCountScope, 'solution');
  assert.equal(result.envVarCountTenantWide, 100, 'tenant-wide count preserved');
});

// --- Web-file size sampling & disk cross-check ------------------------------

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function mkTmpProjectWithDist(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'est-size-'));
  const dist = path.join(root, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  for (const [name, bytes] of files) {
    fs.writeFileSync(path.join(dist, name), Buffer.alloc(bytes, 'a'));
  }
  return { root, dist };
}

test('measureWebFiles uses stratified sampling for >150 files', async (t) => {
  const TOTAL = 500;
  const fetchedIds = [];
  withMockedMakeRequest(t, buildFakeServer({
    totalPpcs: TOTAL,
    pageSize: 5000,
    contentBytesPerFile: 1024 * 1024, // 1 MB decoded per file
    onSingleFetch: (id) => fetchedIds.push(id),
  }));

  await estimateSolutionSize({
    envUrl: 'https://test.crm.dynamics.com',
    websiteRecordId: '00000000-0000-0000-0000-000000000001',
    token: 'fake-token',
  });

  const unique = new Set(fetchedIds);
  assert.equal(unique.size, 150, 'stratified sample should fetch exactly 150 unique ids');
  // Map ppc-XXXXXX ids back to integer indices; the rows were generated with
  // i.toString().padStart(6, '0') so this is unambiguous.
  const indices = [...unique].map((id) => Number(id.replace(/^ppc-/, '')));
  const min = Math.min(...indices);
  const max = Math.max(...indices);
  assert.equal(min, 0, 'sample should include the very first row (first-50 region)');
  assert.equal(max, TOTAL - 1, 'sample should include the very last row (last-50 region)');
  // Spread check: the middle 50 must land in (50, len-50). We assert at least
  // 5 sampled indices fall strictly between 100 and TOTAL-100 to confirm
  // we're not just hitting both ends.
  const middleHits = indices.filter((i) => i > 100 && i < TOTAL - 100);
  assert.ok(middleHits.length >= 5, `expected meaningful middle coverage, got ${middleHits.length}`);
});

test('measureWebFiles measures all files when count <= 150', async (t) => {
  const TOTAL = 100;
  const fetchedIds = [];
  withMockedMakeRequest(t, buildFakeServer({
    totalPpcs: TOTAL,
    pageSize: 5000,
    contentBytesPerFile: 1024,
    onSingleFetch: (id) => fetchedIds.push(id),
  }));

  await estimateSolutionSize({
    envUrl: 'https://test.crm.dynamics.com',
    websiteRecordId: '00000000-0000-0000-0000-000000000001',
    token: 'fake-token',
  });

  const unique = new Set(fetchedIds);
  assert.equal(unique.size, TOTAL, 'every file should be fetched when total <= 150');
});

test('disk-measurement fallback walks projectRoot/dist and sums bytes', async (t) => {
  const { root, dist } = mkTmpProjectWithDist([
    ['a.png', 100],
    ['b.png', 200],
    ['c.png', 5000],
  ]);
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

  withMockedMakeRequest(t, buildFakeServer({ totalPpcs: 0, pageSize: 5000 }));

  const result = await estimateSolutionSize({
    envUrl: 'https://test.crm.dynamics.com',
    websiteRecordId: '00000000-0000-0000-0000-000000000001',
    token: 'fake-token',
    projectRoot: root,
  });

  const expectedMB = Math.round((5300 / (1024 * 1024)) * 10) / 10;
  assert.equal(result.webFilesDiskMeasuredMB, expectedMB);
  assert.equal(result.webFilesDiskFileCount, 3);
  assert.ok(result.webFilesDiskMeasuredPath && result.webFilesDiskMeasuredPath.endsWith('dist'),
    `expected disk path to end with 'dist', got ${result.webFilesDiskMeasuredPath}`);
});

test('undercount canary fires when disk is much larger than Dataverse-measured', async (t) => {
  // Fake disk: ~50 MB. Dataverse: 30 files × 1 KB content = 30 KB total
  // (well under 50% of the disk number). Disk threshold (>5 MB) satisfied.
  const { root } = mkTmpProjectWithDist([
    ['big.bin', 50 * 1024 * 1024],
  ]);
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

  withMockedMakeRequest(t, buildFakeServer({
    totalPpcs: 30,
    pageSize: 5000,
    contentBytesPerFile: 1024, // 1 KB decoded per file
  }));

  const result = await estimateSolutionSize({
    envUrl: 'https://test.crm.dynamics.com',
    websiteRecordId: '00000000-0000-0000-0000-000000000001',
    token: 'fake-token',
    projectRoot: root,
  });

  assert.equal(result.truncationSuspected, true, 'undercount canary must fire');
  assert.ok(
    result.truncationWarnings.some((w) => /file-typed column/.test(w)),
    `expected a file-typed-column warning, got: ${JSON.stringify(result.truncationWarnings)}`,
  );
});

test('undercount canary fires when average sampled bytes per file < 1 KB and webFileCount > 20', async (t) => {
  // 30 web files, each fetch returns content of ~100 chars (decoded ~75 bytes).
  // Average is well under 1 KB/file, and count > 20 → canary fires.
  withMockedMakeRequest(t, buildFakeServer({
    totalPpcs: 30,
    pageSize: 5000,
    contentBytesPerFile: 75,
  }));

  const result = await estimateSolutionSize({
    envUrl: 'https://test.crm.dynamics.com',
    websiteRecordId: '00000000-0000-0000-0000-000000000001',
    token: 'fake-token',
  });

  assert.equal(result.truncationSuspected, true, 'suspiciously-small canary must fire');
  assert.ok(
    result.truncationWarnings.some((w) => /suspiciously small/.test(w)),
    `expected suspiciously-small warning, got: ${JSON.stringify(result.truncationWarnings)}`,
  );
});

test('disk-measurement gracefully no-ops when projectRoot is absent', async (t) => {
  withMockedMakeRequest(t, buildFakeServer({ totalPpcs: 10, pageSize: 5000, contentBytesPerFile: 1024 * 1024 }));

  const result = await estimateSolutionSize({
    envUrl: 'https://test.crm.dynamics.com',
    websiteRecordId: '00000000-0000-0000-0000-000000000001',
    token: 'fake-token',
  });

  assert.equal(result.webFilesDiskMeasuredMB, null);
  assert.equal(result.webFilesDiskMeasuredPath, null);
  assert.equal(result.webFilesDiskFileCount, null);
  assert.equal(result.webFileCount, 10);
});

test('disk-measurement gracefully no-ops when projectRoot has no build-output directory', async (t) => {
  // Create a tmp dir with content unrelated to build output — `src/`, `node_modules/`.
  // The detector walks `dist`, `public-output`, `build`, `.output` in that order;
  // none exist here, so the disk-measurement path must skip and return null fields
  // without throwing.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'est-size-no-build-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export {};');
  fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'placeholder.txt'), 'x');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

  withMockedMakeRequest(t, buildFakeServer({ totalPpcs: 5, pageSize: 5000, contentBytesPerFile: 1024 * 1024 }));

  const result = await estimateSolutionSize({
    envUrl: 'https://test.crm.dynamics.com',
    websiteRecordId: '00000000-0000-0000-0000-000000000001',
    token: 'fake-token',
    projectRoot: root,
  });

  assert.equal(result.webFilesDiskMeasuredMB, null, 'disk MB should be null when no build dir found');
  assert.equal(result.webFilesDiskMeasuredPath, null, 'disk path should be null when no build dir found');
  assert.equal(result.webFilesDiskFileCount, null, 'disk file count should be null when no build dir found');
  // Estimator should still complete with the usual webFileCount.
  assert.equal(result.webFileCount, 5);
  // And the disk-vs-Dataverse canary must NOT fire when no disk number is available.
  assert.ok(
    !result.truncationWarnings.some((w) => /local build output/.test(w)),
    'disk-vs-dataverse canary must not fire when no build dir found',
  );
});

// --- site-referenced table scoping + dependency edges (the prefix-overcount fix) ---

test('estimateSolutionSize scopes tables to site references (not publisher prefix) + emits relationships', async (t) => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  // Temp site root with table permissions referencing only bp_permit + bp_permitstep.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'est-scope-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tpDir = path.join(root, '.powerpages-site', 'table-permissions');
  fs.mkdirSync(tpDir, { recursive: true });
  for (const [base, entity] of [['Permit', 'bp_permit'], ['Step', 'bp_permitstep'], ['Notes', 'annotation']]) {
    fs.writeFileSync(path.join(tpDir, `${base}.tablepermission.yml`),
      `adx_entitypermission_webrole:\n- ad89f5ee-8665-f111-a826-6045bd00fdda\nentitylogicalname: ${entity}\nentityname: ${base}\nid: f03fefed-8665-f111-a826-000d3a597e6a\nscope: 756150000\n`);
  }

  withMockedMakeRequest(t, async ({ url }) => {
    if (url.includes('OneToManyRelationships')) {
      // bp_permit has a lookup to bp_permitstep (both in scope) + one to contact (out of scope).
      if (url.includes("LogicalName='bp_permit'")) {
        return { statusCode: 200, body: JSON.stringify({ value: [
          { SchemaName: 'bp_permit_step', ReferencedEntity: 'bp_permit', ReferencingEntity: 'bp_permitstep', ReferencingAttribute: 'bp_permitid' },
          { SchemaName: 'contact_permit', ReferencedEntity: 'contact', ReferencingEntity: 'bp_permit', ReferencingAttribute: 'bp_contactid' },
        ] }) };
      }
      return { statusCode: 200, body: JSON.stringify({ value: [] }) };
    }
    if (url.includes('ManyToManyRelationships')) return { statusCode: 200, body: JSON.stringify({ value: [] }) };
    if (url.includes('/Attributes')) return { statusCode: 200, body: JSON.stringify({ value: [{ LogicalName: 'c1' }, { LogicalName: 'c2' }] }) };
    if (url.includes('EntityDefinitions') && url.includes('IsCustomEntity')) {
      // Env has 4 custom tables; only bp_* are referenced. new_* are the prefix-noise.
      return { statusCode: 200, body: JSON.stringify({ value: [
        { LogicalName: 'bp_permit', MetadataId: 'm1', IsCustomEntity: true, IsManaged: false },
        { LogicalName: 'bp_permitstep', MetadataId: 'm2', IsCustomEntity: true, IsManaged: false },
        { LogicalName: 'new_unrelated1', MetadataId: 'm3', IsCustomEntity: true, IsManaged: false },
        { LogicalName: 'new_unrelated2', MetadataId: 'm4', IsCustomEntity: true, IsManaged: false },
      ] }) };
    }
    if (url.includes('powerpagecomponents') && url.includes('$count')) {
      return { statusCode: 200, body: JSON.stringify({ '@odata.count': 0, value: [] }) };
    }
    return { statusCode: 200, body: JSON.stringify({ value: [] }) };
  });

  const result = await estimateSolutionSize({
    envUrl: 'https://test.crm.dynamics.com',
    websiteRecordId: '00000000-0000-0000-0000-000000000001',
    publisherPrefix: 'new',           // the (now-irrelevant for tables) shared prefix
    projectRoot: root,
    token: 'fake-token',
  });

  assert.equal(result.tableCount, 2, 'only the 2 site-referenced bp_* tables — NOT the 2 new_* prefix matches');
  assert.equal(result.tableCountScope, 'site-referenced');
  assert.deepEqual(result.tables.map((x) => x.logicalName).sort(), ['bp_permit', 'bp_permitstep']);
  // Edge between the two scoped tables; the contact edge is dropped (out of scope).
  assert.deepEqual(result.tableRelationships, [['bp_permit', 'bp_permitstep']]);
});

test('estimateSolutionSize tableCountScope is "unavailable" with no local signal (never a prefix dump)', async (t) => {
  withMockedMakeRequest(t, async ({ url }) => {
    if (url.includes('EntityDefinitions') && url.includes('IsCustomEntity')) {
      return { statusCode: 200, body: JSON.stringify({ value: [
        { LogicalName: 'new_a', MetadataId: 'm1', IsCustomEntity: true, IsManaged: false },
        { LogicalName: 'new_b', MetadataId: 'm2', IsCustomEntity: true, IsManaged: false },
      ] }) };
    }
    if (url.includes('powerpagecomponents') && url.includes('$count')) {
      return { statusCode: 200, body: JSON.stringify({ '@odata.count': 0, value: [] }) };
    }
    return { statusCode: 200, body: JSON.stringify({ value: [] }) };
  });
  const result = await estimateSolutionSize({
    envUrl: 'https://test.crm.dynamics.com',
    websiteRecordId: '00000000-0000-0000-0000-000000000001',
    publisherPrefix: 'new',
    token: 'fake-token',          // no projectRoot
  });
  assert.equal(result.tableCount, 0, 'no .powerpages-site signal -> zero tables, NOT the env-wide prefix dump');
  assert.equal(result.tableCountScope, 'unavailable');
  assert.deepEqual(result.tableRelationships, []);
});
