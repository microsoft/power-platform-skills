'use strict';

// Integration test for discover-site-components.js — runs against a real HTTP
// mock server (not injected makeRequest) so we validate the actual network
// code paths, URL construction, authorization header handling, and pagination.

const test = require('node:test');
const assert = require('node:assert/strict');
const { startMock } = require('./mock-dataverse');
const {
  discoverSiteComponents,
} = require('../../lib/discover-site-components');

test('integration: discover follows @odata.nextLink pagination against a real HTTP server', async () => {
  let mockBase = null;

  const routes = [
    // Page 2 — serves rows when nextPage=1 is in the query
    {
      method: 'GET',
      matcher: (req) =>
        req.url.includes('/powerpagecomponents') && req.url.includes('nextPage=1'),
      body: {
        value: [
          { powerpagecomponentid: 'p3', name: 'Page3', powerpagecomponenttype: 2 },
          { powerpagecomponentid: 'p4', name: 'index-abc.js', powerpagecomponenttype: 3 },
        ],
      },
    },
    // Page 1 — serves rows + nextLink
    {
      method: 'GET',
      matcher: (req) =>
        req.url.includes('/powerpagecomponents') && !req.url.includes('nextPage='),
      body: () => ({
        value: [
          { powerpagecomponentid: 'p1', name: 'Home', powerpagecomponenttype: 2 },
          { powerpagecomponentid: 'p2', name: 'About', powerpagecomponenttype: 2 },
        ],
        '@odata.nextLink': `${mockBase}/api/data/v9.2/powerpagecomponents?nextPage=1`,
      }),
    },
    { method: 'GET', matcher: '/workflows?', body: { value: [] } },
    {
      method: 'GET',
      matcher: '/solutioncomponents?',
      body: {
        value: [
          { objectid: 'p1', componenttype: 10373 },
          { objectid: 'p2', componenttype: 10373 },
          // p3, p4 missing
        ],
      },
    },
  ];

  const mock = await startMock(routes);
  mockBase = mock.baseUrl;

  try {
    const result = await discoverSiteComponents({
      envUrl: mock.baseUrl,
      token: 'fake-integration-token',
      siteId: 'site-42',
      solutionId: 'sol-integration',
    });

    assert.equal(result.powerpagecomponents.total, 4, 'should aggregate both pages');
    assert.equal(result.missing.powerpagecomponents.length, 2);
    assert.deepEqual(
      result.missing.powerpagecomponents.map((c) => c.name).sort(),
      ['Page3', 'index-abc.js']
    );
    assert.equal(result.inSolution.total, 2);

    // Every call must have carried the Authorization header
    for (const call of mock.calls) {
      assert.equal(
        call.authorization,
        'Bearer fake-integration-token',
        `Auth header missing on ${call.method} ${call.url}`
      );
    }

    // Two ppc calls confirm pagination was exercised
    const ppcCalls = mock.calls.filter((c) => c.url.includes('/powerpagecomponents'));
    assert.equal(ppcCalls.length, 2, 'expected two ppc requests (page 1 + page 2)');
  } finally {
    await mock.close();
  }
});

test('integration: discover surfaces HTTP 500 with a clear error', async () => {
  const mock = await startMock([
    {
      method: 'GET',
      matcher: '/powerpagecomponents',
      status: 500,
      body: { error: { message: 'Synthetic failure' } },
    },
  ]);
  try {
    await assert.rejects(
      discoverSiteComponents({ envUrl: mock.baseUrl, token: 'x', siteId: 'site-42' }),
      /HTTP 500/
    );
  } finally {
    await mock.close();
  }
});

test('integration: discover survives an empty site (no components, no solutionId)', async () => {
  const mock = await startMock([
    { method: 'GET', matcher: '/powerpagecomponents', body: { value: [] } },
    { method: 'GET', matcher: '/workflows?', body: { value: [] } },
  ]);
  try {
    const result = await discoverSiteComponents({
      envUrl: mock.baseUrl,
      token: 'x',
      siteId: 'site-empty',
    });
    assert.equal(result.powerpagecomponents.total, 0);
    assert.deepEqual(Object.keys(result.powerpagecomponents.byType), []);
    assert.equal(result.cloudFlows.length, 0);
    assert.strictEqual(result.missing, undefined, 'missing block only populates when solutionId passed');
  } finally {
    await mock.close();
  }
});

test('integration: countSolutionMembership cross-site safety check flags ppcs not on target site', async () => {
  const { countSolutionMembership } = require('../../lib/estimate-solution-size');
  const mock = await startMock([
    {
      method: 'GET',
      matcher: '/solutioncomponents?',
      body: {
        value: [
          { objectid: 'ppc-on-site-1', componenttype: 10373 },
          { objectid: 'ppc-on-site-2', componenttype: 10373 },
          { objectid: 'ppc-from-OTHER-site', componenttype: 10373 }, // ← cross-site
          { objectid: 'table-1', componenttype: 1 }, // not a ppc — not checked
          { objectid: 'website-1', componenttype: 10374 },
        ],
      },
    },
  ]);
  try {
    const sitePpcIdSet = new Set(['ppc-on-site-1', 'ppc-on-site-2']);
    const result = await countSolutionMembership(
      mock.baseUrl,
      'sol-xyz',
      'fake-token',
      sitePpcIdSet,
    );
    assert.equal(result.total, 5);
    assert.equal(result.byComponentType[10373], 3);
    assert.deepEqual(result.crossSitePpcs, ['ppc-from-other-site'],
      'the ppc not in the site set should be flagged, and the check is case-insensitive');
  } finally {
    await mock.close();
  }
});

test('integration: countSolutionMembership returns empty crossSitePpcs when sitePpcIdSet is null', async () => {
  const { countSolutionMembership } = require('../../lib/estimate-solution-size');
  const mock = await startMock([
    {
      method: 'GET',
      matcher: '/solutioncomponents?',
      body: {
        value: [{ objectid: 'x', componenttype: 10373 }],
      },
    },
  ]);
  try {
    const result = await countSolutionMembership(
      mock.baseUrl,
      'sol-xyz',
      'fake-token',
      null,
    );
    assert.deepEqual(result.crossSitePpcs, [],
      'no cross-site check when caller did not supply the site set');
  } finally {
    await mock.close();
  }
});

test('integration: discover with publisherPrefix queries env vars + tables endpoints', async () => {
  const mock = await startMock([
    { method: 'GET', matcher: '/powerpagecomponents', body: { value: [] } },
    { method: 'GET', matcher: '/workflows?', body: { value: [] } },
    {
      method: 'GET',
      matcher: '/environmentvariabledefinitions',
      body: {
        value: [
          {
            environmentvariabledefinitionid: 'ev1',
            schemaname: 'contoso_FeatureFlag',
            displayname: 'Feature Flag',
            type: 100000000,
            defaultvalue: 'false',
          },
        ],
      },
    },
    {
      method: 'GET',
      matcher: '/EntityDefinitions',
      body: {
        value: [
          {
            MetadataId: 'meta-1',
            LogicalName: 'contoso_account',
            SchemaName: 'contoso_Account',
            DisplayName: { UserLocalizedLabel: { Label: 'Account' } },
          },
          {
            MetadataId: 'meta-2',
            LogicalName: 'other_widget',
            SchemaName: 'other_Widget',
            DisplayName: { UserLocalizedLabel: { Label: 'Widget' } },
          },
        ],
      },
    },
  ]);
  try {
    const result = await discoverSiteComponents({
      envUrl: mock.baseUrl,
      token: 'x',
      siteId: 'site-42',
      publisherPrefix: 'contoso',
    });
    assert.equal(result.envVars.length, 1);
    assert.equal(result.envVars[0].schemaName, 'contoso_FeatureFlag');
    assert.equal(result.customTables.length, 1);
    assert.equal(result.customTables[0].logicalName, 'contoso_account');

    const evCalls = mock.calls.filter((c) => c.url.includes('/environmentvariabledefinitions'));
    assert.equal(evCalls.length, 1);
    const edCalls = mock.calls.filter((c) => c.url.includes('/EntityDefinitions'));
    assert.equal(edCalls.length, 1);
  } finally {
    await mock.close();
  }
});
