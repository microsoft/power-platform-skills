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

test('typeLabel maps known option-set codes and falls back to String', () => {
  assert.equal(typeLabel(TYPE_LABELS && 100000000), 'String');
  assert.equal(typeLabel(100000002), 'Boolean');
  assert.equal(typeLabel(100000003), 'Secret');
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
  assert.deepEqual(result, { envVars: [], count: 0 });
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
  assert.deepEqual(result, { envVars: [], count: 0 });
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
            { environmentvariabledefinitionid: 'def-y', schemaname: 'cr_NullDefault', type: 100000003, defaultvalue: null },
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
