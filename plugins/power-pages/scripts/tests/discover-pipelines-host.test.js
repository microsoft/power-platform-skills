const test = require('node:test');
const assert = require('node:assert/strict');

// Unit tests for discover-pipelines-host.js
// Network calls are mocked via module-level replacement on helpers.makeRequest.

const { discoverPipelinesHost } = require('../lib/discover-pipelines-host');

test('discoverPipelinesHost returns { found: false } when SettingValue is empty', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const origReq = helpers.makeRequest;

  helpers.makeRequest = async () => ({
    statusCode: 200,
    body: JSON.stringify({ SettingValue: '' }),
  });

  t.after(() => { helpers.makeRequest = origReq; });

  const result = await discoverPipelinesHost({
    envUrl: 'https://org.crm.dynamics.com',
    token: 'fake-token',
    userId: 'user-id-1',
  });

  assert.equal(result.found, false);
  assert.equal(result.hostEnvUrl, null);
});

test('discoverPipelinesHost returns { found: true, hostEnvUrl } when SettingValue is a URL', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const origReq = helpers.makeRequest;

  helpers.makeRequest = async () => ({
    statusCode: 200,
    body: JSON.stringify({ SettingValue: 'https://pipelineshost.crm.dynamics.com' }),
  });

  t.after(() => { helpers.makeRequest = origReq; });

  const result = await discoverPipelinesHost({
    envUrl: 'https://org.crm.dynamics.com',
    token: 'fake-token',
    userId: 'user-id-1',
  });

  assert.equal(result.found, true);
  assert.equal(result.hostEnvUrl, 'https://pipelineshost.crm.dynamics.com');
});

test('discoverPipelinesHost throws when --envUrl is missing', async () => {
  await assert.rejects(
    () => discoverPipelinesHost({ token: 'fake-token', userId: 'user-id-1' }),
    /--envUrl is required/
  );
});

test('discoverPipelinesHost returns { found: false } when response is 404', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const origReq = helpers.makeRequest;

  helpers.makeRequest = async () => ({
    statusCode: 404,
    body: 'Not Found',
  });

  t.after(() => { helpers.makeRequest = origReq; });

  const result = await discoverPipelinesHost({
    envUrl: 'https://org.crm.dynamics.com',
    token: 'fake-token',
    userId: 'user-id-1',
  });

  assert.equal(result.found, false);
  assert.equal(result.hostEnvUrl, null);
});

test('discoverPipelinesHost throws when --token is missing', async () => {
  await assert.rejects(
    () => discoverPipelinesHost({ envUrl: 'https://org.crm.dynamics.com', userId: 'user-id-1' }),
    /--token is required/
  );
});

test('discoverPipelinesHost throws on unexpected non-2xx status', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const origReq = helpers.makeRequest;

  helpers.makeRequest = async () => ({
    statusCode: 500,
    body: 'Internal Server Error',
  });

  t.after(() => { helpers.makeRequest = origReq; });

  await assert.rejects(
    () => discoverPipelinesHost({
      envUrl: 'https://org.crm.dynamics.com',
      token: 'fake-token',
      userId: 'user-id-1',
    }),
    /unexpected status 500/
  );
});
