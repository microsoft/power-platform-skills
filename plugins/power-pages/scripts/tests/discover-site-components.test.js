'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  discoverSiteComponents,
  PPC_TYPE_LABELS,
  PPC_DEFAULT_INCLUDE,
} = require('../lib/discover-site-components');

/**
 * Creates a fake `makeRequest` that matches URL fragments to response bodies.
 * Each entry is `[urlFragment, responseObject]`; the first matching entry wins.
 * Any unmatched URL returns 404.
 */
function fakeRequest(entries) {
  return async ({ url }) => {
    for (const [fragment, response] of entries) {
      if (url.includes(fragment)) {
        return {
          statusCode: 200,
          body: JSON.stringify(response),
        };
      }
    }
    return { statusCode: 404, body: '{}' };
  };
}

test('exports authoritative picklist labels covering every documented value', () => {
  // Spot-check the ones we care about for ALM workflows.
  assert.equal(PPC_TYPE_LABELS[2], 'Web Page');
  assert.equal(PPC_TYPE_LABELS[3], 'Web File');
  assert.equal(PPC_TYPE_LABELS[27], 'Bot Consumer');
  assert.equal(PPC_TYPE_LABELS[33], 'Cloud Flow');
  assert.equal(PPC_TYPE_LABELS[35], 'Server Logic');
  // 14, 22, 23, 25 are gaps in the documented picklist — ensure we don't invent them.
  assert.equal(PPC_TYPE_LABELS[14], undefined);
  assert.equal(PPC_TYPE_LABELS[22], undefined);
});

test('default inclusion policy includes every known type', () => {
  for (const typeValue of Object.keys(PPC_TYPE_LABELS)) {
    assert.equal(
      PPC_DEFAULT_INCLUDE[typeValue],
      true,
      `Expected type ${typeValue} (${PPC_TYPE_LABELS[typeValue]}) to be included by default`
    );
  }
});

test('groups site components by powerpagecomponenttype', async () => {
  const makeRequest = fakeRequest([
    [
      '/powerpagecomponents?',
      {
        value: [
          { powerpagecomponentid: 'a1', name: 'Home', powerpagecomponenttype: 2 },
          { powerpagecomponentid: 'a2', name: 'About', powerpagecomponenttype: 2 },
          { powerpagecomponentid: 'a3', name: 'layout.html', powerpagecomponenttype: 3 },
          { powerpagecomponentid: 'a4', name: 'invoice-checker', powerpagecomponenttype: 35 },
        ],
      },
    ],
    [
      '/workflows?',
      { value: [] },
    ],
  ]);

  const result = await discoverSiteComponents({
    envUrl: 'https://example.crm.dynamics.com',
    token: 'tok',
    siteId: 'site-guid',
    makeRequest,
  });

  assert.equal(result.powerpagecomponents.total, 4);
  assert.deepEqual(
    result.powerpagecomponents.byType['2'].map((r) => r.name).sort(),
    ['About', 'Home']
  );
  assert.equal(result.powerpagecomponents.byType['35'][0].typeLabel, 'Server Logic');
});

test('returns cloudFlows with linkedViaPpc flag when a type-33 binding is present', async () => {
  const makeRequest = fakeRequest([
    [
      '/powerpagecomponents?',
      {
        value: [
          { powerpagecomponentid: 'FLOW1', name: 'flow-binding', powerpagecomponenttype: 33 },
        ],
      },
    ],
    [
      '/workflows?',
      {
        value: [
          { workflowid: 'flow1', name: 'Invoice Processing', statecode: 1, category: 5 },
          { workflowid: 'flow2', name: 'Orphan Flow', statecode: 0, category: 5 },
        ],
      },
    ],
  ]);

  const result = await discoverSiteComponents({
    envUrl: 'https://example.crm.dynamics.com',
    token: 'tok',
    siteId: 'site-guid',
    makeRequest,
  });

  assert.equal(result.cloudFlows.length, 2);
  const invoice = result.cloudFlows.find((f) => f.id === 'flow1');
  const orphan = result.cloudFlows.find((f) => f.id === 'flow2');
  assert.equal(invoice.linkedViaPpc, true);
  assert.equal(orphan.linkedViaPpc, false);
});

test('computes missing[] diff against an existing solution', async () => {
  const makeRequest = fakeRequest([
    [
      '/powerpagecomponents?',
      {
        value: [
          { powerpagecomponentid: 'PAGE1', name: 'Home', powerpagecomponenttype: 2 },
          { powerpagecomponentid: 'LOGIC1', name: 'invoice-checker', powerpagecomponenttype: 35 },
        ],
      },
    ],
    [
      '/workflows?',
      {
        value: [
          { workflowid: 'FLOW1', name: 'Already in solution', statecode: 1, category: 5 },
          { workflowid: 'FLOW2', name: 'Missing from solution', statecode: 1, category: 5 },
        ],
      },
    ],
    [
      '/solutioncomponents?',
      {
        value: [
          { objectid: 'PAGE1', componenttype: 10373 },
          { objectid: 'FLOW1', componenttype: 29 },
        ],
      },
    ],
  ]);

  const result = await discoverSiteComponents({
    envUrl: 'https://example.crm.dynamics.com',
    token: 'tok',
    siteId: 'site-guid',
    solutionId: 'sol-guid',
    makeRequest,
  });

  assert.equal(result.inSolution.total, 2);
  assert.deepEqual(
    result.missing.powerpagecomponents.map((c) => c.name),
    ['invoice-checker']
  );
  assert.deepEqual(
    result.missing.cloudFlows.map((f) => f.name),
    ['Missing from solution']
  );
});

test('diffs custom tables by MetadataId against solutioncomponents.objectid', async () => {
  const makeRequest = fakeRequest([
    ['/powerpagecomponents?', { value: [] }],
    ['/workflows?', { value: [] }],
    ['/environmentvariabledefinitions?', { value: [] }],
    [
      '/EntityDefinitions?',
      {
        value: [
          {
            MetadataId: 'meta-in-solution',
            LogicalName: 'crd50_already',
            SchemaName: 'crd50_Already',
            DisplayName: { UserLocalizedLabel: { Label: 'Already' } },
          },
          {
            MetadataId: 'meta-missing',
            LogicalName: 'crd50_missing',
            SchemaName: 'crd50_Missing',
            DisplayName: { UserLocalizedLabel: { Label: 'Missing' } },
          },
        ],
      },
    ],
    [
      '/solutioncomponents?',
      { value: [{ objectid: 'meta-in-solution', componenttype: 1 }] },
    ],
  ]);

  const result = await discoverSiteComponents({
    envUrl: 'https://example.crm.dynamics.com',
    token: 'tok',
    siteId: 'site-guid',
    publisherPrefix: 'crd50',
    solutionId: 'sol-guid',
    makeRequest,
  });

  assert.deepEqual(
    result.missing.customTables.map((t) => t.logicalName),
    ['crd50_missing']
  );
});

test('excludes managed + system flows — only returns unmanaged category-5 workflows', async () => {
  let capturedFilter = null;
  const makeRequest = async ({ url }) => {
    if (url.includes('/workflows?')) {
      capturedFilter = decodeURIComponent(url);
      return { statusCode: 200, body: '{"value":[]}' };
    }
    if (url.includes('/powerpagecomponents?')) return { statusCode: 200, body: '{"value":[]}' };
    return { statusCode: 404, body: '{}' };
  };

  await discoverSiteComponents({
    envUrl: 'https://example.crm.dynamics.com',
    token: 'tok',
    siteId: 'site-guid',
    makeRequest,
  });

  assert.ok(/ismanaged\s+eq\s+false/i.test(capturedFilter), `expected ismanaged eq false; got ${capturedFilter}`);
  assert.ok(/category\s+eq\s+5/i.test(capturedFilter), `expected category eq 5; got ${capturedFilter}`);
});

test('matching is case-insensitive on solution object IDs', async () => {
  const makeRequest = fakeRequest([
    [
      '/powerpagecomponents?',
      { value: [{ powerpagecomponentid: 'ABC-123', name: 'Home', powerpagecomponenttype: 2 }] },
    ],
    ['/workflows?', { value: [] }],
    // Solutioncomponents sometimes returns lowercase GUIDs; the diff must still find it.
    ['/solutioncomponents?', { value: [{ objectid: 'abc-123', componenttype: 10373 }] }],
  ]);

  const result = await discoverSiteComponents({
    envUrl: 'https://example.crm.dynamics.com',
    token: 'tok',
    siteId: 'site-guid',
    solutionId: 'sol-guid',
    makeRequest,
  });

  assert.equal(result.missing.powerpagecomponents.length, 0);
});

test('discovers env vars and custom tables when publisherPrefix is passed', async () => {
  const makeRequest = fakeRequest([
    ['/powerpagecomponents?', { value: [] }],
    ['/workflows?', { value: [] }],
    [
      '/environmentvariabledefinitions?',
      {
        value: [
          {
            environmentvariabledefinitionid: 'env1',
            schemaname: 'crd50_FeatureFlag',
            displayname: 'Feature Flag',
            type: 100000000,
            defaultvalue: 'false',
          },
        ],
      },
    ],
    [
      '/EntityDefinitions?',
      {
        // Server-side we only get IsCustomEntity=true rows back; our filter is $filter=IsCustomEntity eq true.
        // Client-side we also filter by the publisher prefix. MetadataId is returned so callers
        // can diff against solutioncomponents.objectid (componenttype 1).
        value: [
          {
            MetadataId: 'meta-crd50-invoice',
            LogicalName: 'crd50_invoice',
            SchemaName: 'crd50_Invoice',
            DisplayName: { UserLocalizedLabel: { Label: 'Invoice' } },
          },
          {
            MetadataId: 'meta-other-widget',
            // A custom table from a different publisher — must be filtered out client-side.
            LogicalName: 'other_widget',
            SchemaName: 'other_Widget',
            DisplayName: { UserLocalizedLabel: { Label: 'Widget' } },
          },
        ],
      },
    ],
  ]);

  const result = await discoverSiteComponents({
    envUrl: 'https://example.crm.dynamics.com',
    token: 'tok',
    siteId: 'site-guid',
    publisherPrefix: 'crd50',
    makeRequest,
  });

  assert.equal(result.envVars.length, 1);
  assert.equal(result.envVars[0].schemaName, 'crd50_FeatureFlag');
  assert.equal(result.customTables.length, 1);
  assert.equal(result.customTables[0].logicalName, 'crd50_invoice');
  assert.equal(result.customTables[0].displayName, 'Invoice');
});

test('skips env var + table discovery when publisherPrefix is not provided', async () => {
  let envVarCalled = false;
  let tableCalled = false;
  const makeRequest = async ({ url }) => {
    if (url.includes('/environmentvariabledefinitions?')) envVarCalled = true;
    if (url.includes('/EntityDefinitions?')) tableCalled = true;
    if (url.includes('/powerpagecomponents?')) return { statusCode: 200, body: '{"value":[]}' };
    if (url.includes('/workflows?')) return { statusCode: 200, body: '{"value":[]}' };
    return { statusCode: 200, body: '{"value":[]}' };
  };

  const result = await discoverSiteComponents({
    envUrl: 'https://example.crm.dynamics.com',
    token: 'tok',
    siteId: 'site-guid',
    makeRequest,
  });

  assert.equal(envVarCalled, false, 'env var endpoint should not be queried');
  assert.equal(tableCalled, false, 'EntityDefinitions endpoint should not be queried');
  assert.deepEqual(result.envVars, []);
  assert.deepEqual(result.customTables, []);
});

test('rejects publisherPrefix with OData-injection characters up front', async () => {
  // A publisherPrefix with invalid characters must error before any HTTP is
  // issued — silently stripping would both mask the typo and leak the call.
  let anyCall = false;
  const makeRequest = async () => {
    anyCall = true;
    return { statusCode: 200, body: '{"value":[]}' };
  };

  await assert.rejects(
    discoverSiteComponents({
      envUrl: 'https://example.crm.dynamics.com',
      token: 'tok',
      siteId: 'site-guid',
      publisherPrefix: "crd50' or '1'='1",
      makeRequest,
    }),
    /Invalid publisherPrefix/
  );
  assert.strictEqual(anyCall, false, 'no HTTP request should have been made');
});

test('follows @odata.nextLink pagination for large result sets', async () => {
  let call = 0;
  const makeRequest = async ({ url }) => {
    if (url.includes('/powerpagecomponents?')) {
      call++;
      if (call === 1) {
        return {
          statusCode: 200,
          body: JSON.stringify({
            value: [
              { powerpagecomponentid: 'p1', name: 'a', powerpagecomponenttype: 2 },
            ],
            '@odata.nextLink': 'https://example.crm.dynamics.com/api/data/v9.2/powerpagecomponents?page2',
          }),
        };
      }
      return {
        statusCode: 200,
        body: JSON.stringify({
          value: [{ powerpagecomponentid: 'p2', name: 'b', powerpagecomponenttype: 2 }],
        }),
      };
    }
    if (url.includes('/workflows?')) return { statusCode: 200, body: '{"value":[]}' };
    return { statusCode: 404, body: '{}' };
  };

  const result = await discoverSiteComponents({
    envUrl: 'https://example.crm.dynamics.com',
    token: 'tok',
    siteId: 'site-guid',
    makeRequest,
  });

  assert.equal(result.powerpagecomponents.total, 2);
});

test('surfaces HTTP errors with a clear message', async () => {
  const makeRequest = async () => ({ statusCode: 403, body: '{"error":{"message":"denied"}}' });

  await assert.rejects(
    discoverSiteComponents({
      envUrl: 'https://example.crm.dynamics.com',
      token: 'tok',
      siteId: 'site-guid',
      makeRequest,
    }),
    /HTTP 403/
  );
});

test('throws on missing required args', async () => {
  await assert.rejects(
    discoverSiteComponents({ envUrl: 'https://e', token: 't' }),
    /siteId is required/
  );
  await assert.rejects(
    discoverSiteComponents({ envUrl: 'https://e', siteId: 's' }),
    /token is required/
  );
  await assert.rejects(
    discoverSiteComponents({ siteId: 's', token: 't' }),
    /envUrl is required/
  );
});
