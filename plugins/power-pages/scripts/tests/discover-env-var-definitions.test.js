'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('../lib/validation-helpers');
const {
  discoverEnvVarDefinitions,
  typeLabel,
  TYPE_LABELS,
} = require('../lib/discover-env-var-definitions');

function withMockedRequests(t, handler) {
  const orig = helpers.makeRequest;
  const calls = [];
  helpers.makeRequest = async (opts) => {
    calls.push(opts);
    return handler(opts, calls.length);
  };
  t.after(() => { helpers.makeRequest = orig; });
  return calls;
}

test('typeLabel maps the canonical Dataverse option-set codes (verified against live tenant)', () => {
  // Regression guard for a real bug: earlier TYPE_LABELS had 100000003→'Secret'
  // and 100000005→'Json' — swapped. A Secret env var created via the Power
  // Platform UI is stored as type 100000005, and this helper was rendering
  // it as "Json" in the ALM plan's Env Variables tab.
  assert.equal(typeLabel(100000000), 'String');
  assert.equal(typeLabel(100000001), 'Number');
  assert.equal(typeLabel(100000002), 'Boolean');
  assert.equal(typeLabel(100000003), 'JSON');
  assert.equal(typeLabel(100000004), 'DataSource');
  assert.equal(typeLabel(100000005), 'Secret');
  assert.equal(typeLabel(undefined), 'String');
  assert.equal(typeLabel(null), 'String');
  assert.equal(typeLabel(99999), 'String'); // unknown code
});

test('discoverEnvVarDefinitions throws when envUrl missing', async () => {
  await assert.rejects(
    () => discoverEnvVarDefinitions({ token: 't', publisherPrefix: 'cr5fe', websiteRecordId: 'site-id' }),
    /--envUrl is required/
  );
});

test('discoverEnvVarDefinitions returns empty when publisherPrefix missing (avoids tenant-wide scan)', async () => {
  const result = await discoverEnvVarDefinitions({
    envUrl: 'https://org.crm.dynamics.com',
    token: 'fake',
    publisherPrefix: null,
    websiteRecordId: 'site-id',
  });
  assert.deepEqual(result, { envVars: [], count: 0, scope: 'none' });
});

test('discoverEnvVarDefinitions filters definitions by publisher prefix and uses v9.2 API', async (t) => {
  const calls = withMockedRequests(t, ({ url }) => {
    if (url.includes('environmentvariabledefinitions')) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          value: [
            {
              environmentvariabledefinitionid: 'def-1',
              schemaname: 'cr5fe_LocalLoginEnabled',
              displayname: 'Local Login Enabled',
              type: 100000002,
              defaultvalue: 'true',
            },
            {
              environmentvariabledefinitionid: 'def-2',
              schemaname: 'cr5fe_ApiBaseUrl',
              displayname: 'API Base URL',
              type: 100000000,
              defaultvalue: 'https://dev.api',
            },
          ],
        }),
      };
    }
    return { statusCode: 200, body: JSON.stringify({ value: [] }) };
  });

  const result = await discoverEnvVarDefinitions({
    envUrl: 'https://org.crm.dynamics.com',
    token: 'fake',
    publisherPrefix: 'cr5fe',
    websiteRecordId: 'site-id',
  });

  assert.equal(result.count, 2);
  assert.equal(result.envVars[0].schemaName, 'cr5fe_LocalLoginEnabled');
  assert.equal(result.envVars[0].displayName, 'Local Login Enabled');
  assert.equal(result.envVars[0].type, 'Boolean');
  assert.equal(result.envVars[0].defaultValue, 'true');
  assert.equal(result.envVars[1].schemaName, 'cr5fe_ApiBaseUrl');
  assert.equal(result.envVars[1].displayName, 'API Base URL');
  assert.equal(result.envVars[1].type, 'String');

  const defCall = calls.find((c) => c.url.includes('environmentvariabledefinitions'));
  assert.ok(defCall, 'should have called environmentvariabledefinitions');
  assert.ok(/v9\.2/.test(defCall.url), 'should use v9.2 API');
  assert.ok(
    /startswith\(schemaname,'cr5fe_'\)/.test(defCall.url),
    'filter should match the publisher prefix with trailing underscore'
  );
  assert.ok(/description/.test(defCall.url), 'should select description column');
});

test('discoverEnvVarDefinitions surfaces description when present and falls back to schemaName for displayName', async (t) => {
  withMockedRequests(t, ({ url }) => {
    if (url.includes('environmentvariabledefinitions')) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          value: [
            {
              environmentvariabledefinitionid: 'def-1',
              schemaname: 'cr5fe_ApiBaseUrl',
              displayname: 'API Base URL',
              description: 'Endpoint used for cross-environment API calls. Varies per stage.',
              type: 100000000,
              defaultvalue: 'https://dev.api',
            },
            {
              // No displayname AND no description on this row
              environmentvariabledefinitionid: 'def-2',
              schemaname: 'cr5fe_NoMeta',
              type: 100000000,
              defaultvalue: '',
            },
          ],
        }),
      };
    }
    return { statusCode: 200, body: JSON.stringify({ value: [] }) };
  });

  const result = await discoverEnvVarDefinitions({
    envUrl: 'https://org.crm.dynamics.com',
    token: 'fake',
    publisherPrefix: 'cr5fe',
    websiteRecordId: 'site-id',
  });

  assert.equal(result.envVars[0].displayName, 'API Base URL');
  assert.equal(result.envVars[0].description, 'Endpoint used for cross-environment API calls. Varies per stage.');
  // Fallback: no displayname → schemaName is used; no description → empty string
  assert.equal(result.envVars[1].displayName, 'cr5fe_NoMeta');
  assert.equal(result.envVars[1].description, '');
});

test('discoverEnvVarDefinitions joins bindings by env var GUID and surfaces site setting names', async (t) => {
  withMockedRequests(t, ({ url }) => {
    if (url.includes('environmentvariabledefinitions')) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          value: [
            { environmentvariabledefinitionid: 'def-bound', schemaname: 'cr_X', type: 100000000, defaultvalue: 'a' },
            { environmentvariabledefinitionid: 'def-unbound', schemaname: 'cr_Y', type: 100000000, defaultvalue: 'b' },
          ],
        }),
      };
    }
    if (url.includes('mspp_sitesettings')) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          value: [
            { mspp_name: 'Feature/EnableX', mspp_source: 1, _mspp_environmentvariable_value: 'def-bound' },
            // a second site setting bound to the same env var — duplicate binding,
            // first one wins
            { mspp_name: 'Feature/AltX', mspp_source: 1, _mspp_environmentvariable_value: 'def-bound' },
          ],
        }),
      };
    }
    return { statusCode: 200, body: '{}' };
  });

  const result = await discoverEnvVarDefinitions({
    envUrl: 'https://org.crm.dynamics.com',
    token: 'fake',
    publisherPrefix: 'cr',
    websiteRecordId: 'site-id-001',
  });

  assert.equal(result.envVars.length, 2);
  const bound = result.envVars.find((v) => v.schemaName === 'cr_X');
  const unbound = result.envVars.find((v) => v.schemaName === 'cr_Y');
  assert.equal(bound.siteSetting, 'Feature/EnableX', 'bound env var should reference its site setting');
  assert.equal(unbound.siteSetting, '', 'unbound env var should have empty siteSetting');
});

test('discoverEnvVarDefinitions site-setting query filters by website + mspp_source eq 1', async (t) => {
  const calls = withMockedRequests(t, ({ url }) => {
    if (url.includes('environmentvariabledefinitions')) {
      return { statusCode: 200, body: JSON.stringify({ value: [] }) };
    }
    return { statusCode: 200, body: JSON.stringify({ value: [] }) };
  });

  await discoverEnvVarDefinitions({
    envUrl: 'https://org.crm.dynamics.com',
    token: 'fake',
    publisherPrefix: 'cr',
    websiteRecordId: 'b9d92a00-0000-0000-0000-000000000001',
  });

  const ssCall = calls.find((c) => c.url.includes('mspp_sitesettings'));
  assert.ok(ssCall, 'should have queried mspp_sitesettings');
  assert.ok(
    ssCall.url.includes('_mspp_websiteid_value eq b9d92a00-0000-0000-0000-000000000001'),
    'should scope to the website record'
  );
  assert.ok(
    ssCall.url.includes('mspp_source eq 1'),
    'should filter for env-var-backed source'
  );
});

test('discoverEnvVarDefinitions returns empty when definitions query errors', async (t) => {
  withMockedRequests(t, ({ url }) => {
    if (url.includes('environmentvariabledefinitions')) {
      return { error: 'connection reset' };
    }
    return { statusCode: 200, body: JSON.stringify({ value: [] }) };
  });

  const result = await discoverEnvVarDefinitions({
    envUrl: 'https://org.crm.dynamics.com',
    token: 'fake',
    publisherPrefix: 'cr',
    websiteRecordId: 'site-id',
  });
  // When the definitions query errors out, helper returns empty and the scope
  // stays at the legacy fallback label ('publisher-prefix') since solutionId
  // wasn't passed. The fall-through is deliberate — caller treats the empty
  // result as "no data" regardless of scope label.
  assert.deepEqual(result, { envVars: [], count: 0, scope: 'publisher-prefix' });
});

test('discoverEnvVarDefinitions handles missing defaultvalue and unknown type gracefully', async (t) => {
  withMockedRequests(t, ({ url }) => {
    if (url.includes('environmentvariabledefinitions')) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          value: [
            // No defaultvalue, unknown type code
            { environmentvariabledefinitionid: 'def-x', schemaname: 'cr_NoDefault', type: 99999 },
            // null defaultvalue
            { environmentvariabledefinitionid: 'def-y', schemaname: 'cr_NullDefault', type: 100000005, defaultvalue: null },
          ],
        }),
      };
    }
    return { statusCode: 200, body: JSON.stringify({ value: [] }) };
  });

  const result = await discoverEnvVarDefinitions({
    envUrl: 'https://org.crm.dynamics.com',
    token: 'fake',
    publisherPrefix: 'cr',
    websiteRecordId: 'site-id',
  });

  assert.equal(result.envVars.length, 2);
  assert.equal(result.envVars[0].defaultValue, '', 'missing defaultvalue → empty string');
  assert.equal(result.envVars[0].type, 'String', 'unknown type code → String fallback');
  assert.equal(result.envVars[1].defaultValue, '', 'null defaultvalue → empty string');
  assert.equal(result.envVars[1].type, 'Secret', 'known type code preserved');
});

// --- Solution-scoped filtering ----------------------------------------------
//
// Regression test for the "env var prediction is off" report: a tenant with 5
// publisher-prefix-matching env var defs, but only 2 of them in the target
// solution. With --solutionId, the helper must return just those 2 (and report
// scope: 'solution'). Without --solutionId, it returns all 5 (the legacy
// wider-than-intended scope, preserved for fresh projects).

test('discoverEnvVarDefinitions intersects with solution membership when --solutionId is passed', async (t) => {
  const fiveDefs = [
    { environmentvariabledefinitionid: 'def-aaaa-1111', schemaname: 'new_FromThisProject', displayname: 'From This Project', type: 100000000, defaultvalue: 'v1', description: '' },
    { environmentvariabledefinitionid: 'def-bbbb-2222', schemaname: 'new_FromOtherProject1', displayname: 'Foreign 1', type: 100000000, defaultvalue: 'x', description: '' },
    { environmentvariabledefinitionid: 'def-cccc-3333', schemaname: 'new_FromOtherProject2', displayname: 'Foreign 2', type: 100000000, defaultvalue: 'y', description: '' },
    { environmentvariabledefinitionid: 'def-dddd-4444', schemaname: 'new_AlsoFromThisProject', displayname: 'Also Ours', type: 100000002, defaultvalue: 'true', description: '' },
    { environmentvariabledefinitionid: 'def-eeee-5555', schemaname: 'new_FromOtherProject3', displayname: 'Foreign 3', type: 100000000, defaultvalue: 'z', description: '' },
  ];
  // Solution owns def-aaaa-1111 + def-dddd-4444 only.
  const inSolutionRows = [
    { objectid: 'def-aaaa-1111' },
    { objectid: 'def-dddd-4444' },
  ];

  withMockedRequests(t, ({ url }) => {
    if (url.includes('environmentvariabledefinitions')) {
      return { statusCode: 200, body: JSON.stringify({ value: fiveDefs }) };
    }
    if (url.includes('solutioncomponents')) {
      return { statusCode: 200, body: JSON.stringify({ value: inSolutionRows }) };
    }
    if (url.includes('mspp_sitesettings')) {
      return { statusCode: 200, body: JSON.stringify({ value: [] }) };
    }
    return { statusCode: 200, body: JSON.stringify({ value: [] }) };
  });

  const result = await discoverEnvVarDefinitions({
    envUrl: 'https://org.crm.dynamics.com',
    token: 'fake',
    publisherPrefix: 'new',
    websiteRecordId: 'site-id',
    solutionId: 'sol-9999',
  });

  assert.equal(result.scope, 'solution', 'scope must reflect solution-membership filtering');
  assert.equal(result.count, 2, 'only the two solution-owned env vars should be returned');
  const names = result.envVars.map((e) => e.schemaName).sort();
  assert.deepEqual(names, ['new_AlsoFromThisProject', 'new_FromThisProject']);
});

test('discoverEnvVarDefinitions falls back to publisher-prefix when --solutionId omitted', async (t) => {
  const threeDefs = [
    { environmentvariabledefinitionid: 'd1', schemaname: 'new_A', displayname: 'A', type: 100000000, defaultvalue: '', description: '' },
    { environmentvariabledefinitionid: 'd2', schemaname: 'new_B', displayname: 'B', type: 100000000, defaultvalue: '', description: '' },
    { environmentvariabledefinitionid: 'd3', schemaname: 'new_C', displayname: 'C', type: 100000000, defaultvalue: '', description: '' },
  ];
  withMockedRequests(t, ({ url }) => {
    if (url.includes('environmentvariabledefinitions')) {
      return { statusCode: 200, body: JSON.stringify({ value: threeDefs }) };
    }
    return { statusCode: 200, body: JSON.stringify({ value: [] }) };
  });

  const result = await discoverEnvVarDefinitions({
    envUrl: 'https://org.crm.dynamics.com',
    token: 'fake',
    publisherPrefix: 'new',
    websiteRecordId: 'site-id',
    // no --solutionId
  });

  assert.equal(result.scope, 'publisher-prefix', 'scope label must reflect the wider fallback');
  assert.equal(result.count, 3, 'all three prefix-matching env vars should be returned');
});

test('discoverEnvVarDefinitions with --solutionId returns empty (with scope=solution) when solution has zero env var defs', async (t) => {
  // Two env vars match the publisher prefix, but the solution contains NONE.
  // Without scoping the result would be 2; with scoping the result is 0, and
  // the scope label must be 'solution' (not 'publisher-prefix') so the
  // renderer doesn't accidentally fall back to the wider count.
  withMockedRequests(t, ({ url }) => {
    if (url.includes('environmentvariabledefinitions')) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          value: [
            { environmentvariabledefinitionid: 'd1', schemaname: 'new_A', displayname: 'A', type: 100000000, defaultvalue: '', description: '' },
            { environmentvariabledefinitionid: 'd2', schemaname: 'new_B', displayname: 'B', type: 100000000, defaultvalue: '', description: '' },
          ],
        }),
      };
    }
    if (url.includes('solutioncomponents')) {
      return { statusCode: 200, body: JSON.stringify({ value: [] }) };
    }
    return { statusCode: 200, body: JSON.stringify({ value: [] }) };
  });

  const result = await discoverEnvVarDefinitions({
    envUrl: 'https://org.crm.dynamics.com',
    token: 'fake',
    publisherPrefix: 'new',
    websiteRecordId: 'site-id',
    solutionId: 'sol-empty',
  });

  assert.equal(result.scope, 'solution', 'solution scope must be honored even when the result is empty');
  assert.equal(result.count, 0);
});

test('discoverEnvVarDefinitions sends Prefer: odata.maxpagesize header (pagination correctness)', async (t) => {
  let preferOnDefsQuery = null;
  let preferOnSiteSettingsQuery = null;
  withMockedRequests(t, ({ url, headers }) => {
    if (url.includes('environmentvariabledefinitions')) {
      preferOnDefsQuery = headers && headers.Prefer;
    } else if (url.includes('mspp_sitesettings')) {
      preferOnSiteSettingsQuery = headers && headers.Prefer;
    }
    return { statusCode: 200, body: JSON.stringify({ value: [] }) };
  });

  await discoverEnvVarDefinitions({
    envUrl: 'https://org.crm.dynamics.com',
    token: 'fake',
    publisherPrefix: 'new',
    websiteRecordId: 'site-id',
  });

  assert.match(preferOnDefsQuery || '', /odata\.maxpagesize=/, 'definitions query must send Prefer header');
  assert.match(preferOnSiteSettingsQuery || '', /odata\.maxpagesize=/, 'site-settings query must send Prefer header');
});

test('discoverEnvVarDefinitions follows @odata.nextLink to aggregate paginated definitions', async (t) => {
  let callCount = 0;
  withMockedRequests(t, ({ url }) => {
    if (url.includes('environmentvariabledefinitions')) {
      callCount += 1;
      if (callCount === 1) {
        // First page: return 3 defs plus a nextLink
        return {
          statusCode: 200,
          body: JSON.stringify({
            value: [
              { environmentvariabledefinitionid: 'd1', schemaname: 'new_A', displayname: 'A', type: 100000000, defaultvalue: '', description: '' },
              { environmentvariabledefinitionid: 'd2', schemaname: 'new_B', displayname: 'B', type: 100000000, defaultvalue: '', description: '' },
              { environmentvariabledefinitionid: 'd3', schemaname: 'new_C', displayname: 'C', type: 100000000, defaultvalue: '', description: '' },
            ],
            '@odata.nextLink': 'https://org.crm.dynamics.com/api/data/v9.2/environmentvariabledefinitions?$skiptoken=page2',
          }),
        };
      }
      // Second page: 2 more defs, no nextLink
      return {
        statusCode: 200,
        body: JSON.stringify({
          value: [
            { environmentvariabledefinitionid: 'd4', schemaname: 'new_D', displayname: 'D', type: 100000000, defaultvalue: '', description: '' },
            { environmentvariabledefinitionid: 'd5', schemaname: 'new_E', displayname: 'E', type: 100000000, defaultvalue: '', description: '' },
          ],
        }),
      };
    }
    return { statusCode: 200, body: JSON.stringify({ value: [] }) };
  });

  const result = await discoverEnvVarDefinitions({
    envUrl: 'https://org.crm.dynamics.com',
    token: 'fake',
    publisherPrefix: 'new',
    websiteRecordId: 'site-id',
  });

  assert.equal(result.count, 5, 'should aggregate across both pages');
  const names = result.envVars.map((e) => e.schemaName);
  assert.deepEqual(names, ['new_A', 'new_B', 'new_C', 'new_D', 'new_E']);
});
