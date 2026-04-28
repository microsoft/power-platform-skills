const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveEnvById } = require('../lib/resolve-env-by-id');

const FAKE_RESPONSE = {
  id: '/providers/Microsoft.BusinessAppPlatform/environments/0817fd3d-a664-e99a-a758-dd9dc03ceb01',
  type: 'Microsoft.BusinessAppPlatform/environments',
  location: 'unitedstates',
  name: '0817fd3d-a664-e99a-a758-dd9dc03ceb01',
  properties: {
    tenantId: '72f988bf-86f1-41af-91ab-2d7cd011db47',
    azureRegionHint: 'westus',
    displayName: 'PA Staff Pipelines Host',
    environmentSku: 'Production',
    permissions: {
      ListDatabaseEntities: { displayName: 'List Database Entities' },
      ReadEnvironment: { displayName: 'Read Environment' },
    },
    linkedEnvironmentMetadata: {
      instanceUrl: 'https://pascalepipelineshost.crm.dynamics.com/',
      instanceApiUrl: 'https://pascalepipelineshost.api.crm.dynamics.com',
      domainName: 'pascalepipelineshost',
      friendlyName: 'PA Staff Pipelines Host',
    },
  },
};

test('returns full metadata on 200', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  helpers.makeRequest = async () => ({ statusCode: 200, body: JSON.stringify(FAKE_RESPONSE) });
  t.after(() => { helpers.makeRequest = orig; });

  const result = await resolveEnvById({ bapToken: 'fake', envId: '0817fd3d-a664-e99a-a758-dd9dc03ceb01' });
  assert.equal(result.found, true);
  assert.equal(result.envId, '0817fd3d-a664-e99a-a758-dd9dc03ceb01');
  assert.equal(result.instanceUrl, 'https://pascalepipelineshost.crm.dynamics.com/');
  assert.equal(result.instanceApiUrl, 'https://pascalepipelineshost.api.crm.dynamics.com');
  assert.equal(result.displayName, 'PA Staff Pipelines Host');
  assert.equal(result.environmentSku, 'Production');
  assert.equal(result.tenantId, '72f988bf-86f1-41af-91ab-2d7cd011db47');
  assert.equal(result.domainName, 'pascalepipelineshost');
  assert.deepEqual(Object.keys(result.permissions), ['ListDatabaseEntities', 'ReadEnvironment']);
});

test('returns { found: false, reason: 404-ambiguous } on 404', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  helpers.makeRequest = async () => ({ statusCode: 404, body: 'Not Found' });
  t.after(() => { helpers.makeRequest = orig; });

  const result = await resolveEnvById({ bapToken: 'fake', envId: 'abc-123' });
  assert.equal(result.found, false);
  assert.equal(result.reason, '404-ambiguous');
  assert.equal(result.envId, 'abc-123');
});

test('throws specific error on 403', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  helpers.makeRequest = async () => ({ statusCode: 403, body: 'Forbidden' });
  t.after(() => { helpers.makeRequest = orig; });

  await assert.rejects(
    () => resolveEnvById({ bapToken: 'fake', envId: 'abc-123' }),
    /403.*caller lacks permission/,
  );
});

test('throws on unexpected non-2xx', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  helpers.makeRequest = async () => ({ statusCode: 502, body: 'Bad Gateway' });
  t.after(() => { helpers.makeRequest = orig; });

  await assert.rejects(
    () => resolveEnvById({ bapToken: 'fake', envId: 'abc-123' }),
    /unexpected status 502/,
  );
});

test('throws on transport error', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  helpers.makeRequest = async () => ({ error: 'getaddrinfo ENOTFOUND' });
  t.after(() => { helpers.makeRequest = orig; });

  await assert.rejects(
    () => resolveEnvById({ bapToken: 'fake', envId: 'abc-123' }),
    /BAP env GET failed/,
  );
});

test('throws when --bapToken is missing', async () => {
  await assert.rejects(() => resolveEnvById({ envId: 'abc-123' }), /--bapToken is required/);
});

test('throws when --envId is missing', async () => {
  await assert.rejects(() => resolveEnvById({ bapToken: 'fake' }), /--envId is required/);
});

test('handles env with empty linkedEnvironmentMetadata', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  helpers.makeRequest = async () => ({
    statusCode: 200,
    body: JSON.stringify({ name: 'abc', properties: { displayName: 'X', environmentSku: 'Sandbox' } }),
  });
  t.after(() => { helpers.makeRequest = orig; });

  const result = await resolveEnvById({ bapToken: 'fake', envId: 'abc' });
  assert.equal(result.found, true);
  assert.equal(result.instanceUrl, null);
  assert.equal(result.instanceApiUrl, null);
  assert.equal(result.displayName, 'X');
  assert.equal(result.environmentSku, 'Sandbox');
});

test('URL-encodes envId and apiVersion in the request URL', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  let captured = null;
  helpers.makeRequest = async (args) => {
    captured = args.url;
    return { statusCode: 200, body: JSON.stringify({ name: 'abc', properties: {} }) };
  };
  t.after(() => { helpers.makeRequest = orig; });

  await resolveEnvById({ bapToken: 'fake', envId: 'abc 123', apiVersion: '2020-06-01' });
  assert.ok(captured.includes('environments/abc%20123'));
  assert.ok(captured.includes('api-version=2020-06-01'));
});

test('strips trailing slashes from --bapBase', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  let captured = null;
  helpers.makeRequest = async (args) => {
    captured = args.url;
    return { statusCode: 200, body: JSON.stringify({ name: 'abc', properties: {} }) };
  };
  t.after(() => { helpers.makeRequest = orig; });

  await resolveEnvById({ bapToken: 'fake', envId: 'abc', bapBase: 'https://api.bap.microsoft.com////' });
  assert.ok(captured.startsWith('https://api.bap.microsoft.com/providers/'));
});
