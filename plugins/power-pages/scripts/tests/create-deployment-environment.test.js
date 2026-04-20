const test = require('node:test');
const assert = require('node:assert/strict');

// Unit tests for create-deployment-environment.js
// Network calls are mocked via module-level replacement on helpers.makeRequest.

const { createDeploymentEnvironment } = require('../lib/create-deployment-environment');

const FAKE_GUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const ODATA_ENTITY_ID_HEADER = `https://host.crm.dynamics.com/api/data/v9.2/deploymentenvironments(${FAKE_GUID})`;

const VALIDATION_STATUS_SUCCEEDED = 192350001;
const VALIDATION_STATUS_FAILED = 192350002;
const VALIDATION_STATUS_PENDING = 192350000;

test('createDeploymentEnvironment returns deploymentEnvironmentId when validation succeeds on first poll', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const origReq = helpers.makeRequest;

  let callCount = 0;
  helpers.makeRequest = async (opts) => {
    callCount++;
    if (opts.method === 'POST') {
      // Create response — 204 with OData-EntityId header
      return {
        statusCode: 204,
        body: '',
        headers: { 'odata-entityid': ODATA_ENTITY_ID_HEADER },
      };
    }
    // Poll response — Succeeded immediately
    return {
      statusCode: 200,
      body: JSON.stringify({ msdyn_validationstatus: VALIDATION_STATUS_SUCCEEDED }),
    };
  };

  t.after(() => { helpers.makeRequest = origReq; });

  const result = await createDeploymentEnvironment({
    hostEnvUrl: 'https://host.crm.dynamics.com',
    token: 'fake-token',
    name: 'My Dev Env',
    environmentUrl: 'https://org.crm.dynamics.com',
  });

  assert.equal(result.deploymentEnvironmentId, FAKE_GUID);
  assert.equal(result.name, 'My Dev Env');
  assert.equal(result.environmentUrl, 'https://org.crm.dynamics.com');
  assert.equal(result.validationStatus, VALIDATION_STATUS_SUCCEEDED);
});

test('createDeploymentEnvironment throws when validation fails with error details', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const origReq = helpers.makeRequest;

  helpers.makeRequest = async (opts) => {
    if (opts.method === 'POST') {
      return {
        statusCode: 204,
        body: '',
        headers: { 'odata-entityid': ODATA_ENTITY_ID_HEADER },
      };
    }
    return {
      statusCode: 200,
      body: JSON.stringify({
        msdyn_validationstatus: VALIDATION_STATUS_FAILED,
        msdyn_errordetails: 'Environment not accessible from this host',
      }),
    };
  };

  t.after(() => { helpers.makeRequest = origReq; });

  await assert.rejects(
    () => createDeploymentEnvironment({
      hostEnvUrl: 'https://host.crm.dynamics.com',
      token: 'fake-token',
      name: 'Bad Env',
      environmentUrl: 'https://bad-org.crm.dynamics.com',
    }),
    /Environment not accessible from this host/
  );
});

test('createDeploymentEnvironment throws when required args are missing', async () => {
  await assert.rejects(
    () => createDeploymentEnvironment({ token: 'fake-token', name: 'x', environmentUrl: 'y' }),
    /--hostEnvUrl is required/
  );

  await assert.rejects(
    () => createDeploymentEnvironment({ hostEnvUrl: 'https://host.crm.dynamics.com', name: 'x', environmentUrl: 'y' }),
    /--token is required/
  );

  await assert.rejects(
    () => createDeploymentEnvironment({ hostEnvUrl: 'https://host.crm.dynamics.com', token: 'tok', environmentUrl: 'y' }),
    /--name is required/
  );

  await assert.rejects(
    () => createDeploymentEnvironment({ hostEnvUrl: 'https://host.crm.dynamics.com', token: 'tok', name: 'x' }),
    /--environmentUrl is required/
  );
});

test('createDeploymentEnvironment polls through pending status before succeeding', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const origReq = helpers.makeRequest;

  let pollCount = 0;
  helpers.makeRequest = async (opts) => {
    if (opts.method === 'POST') {
      return {
        statusCode: 204,
        body: '',
        headers: { 'odata-entityid': ODATA_ENTITY_ID_HEADER },
      };
    }
    pollCount++;
    if (pollCount < 3) {
      // Return pending status for first 2 polls
      return {
        statusCode: 200,
        body: JSON.stringify({ msdyn_validationstatus: VALIDATION_STATUS_PENDING }),
      };
    }
    return {
      statusCode: 200,
      body: JSON.stringify({ msdyn_validationstatus: VALIDATION_STATUS_SUCCEEDED }),
    };
  };

  t.after(() => { helpers.makeRequest = origReq; });

  const result = await createDeploymentEnvironment({
    hostEnvUrl: 'https://host.crm.dynamics.com',
    token: 'fake-token',
    name: 'Staging',
    environmentUrl: 'https://staging.crm.dynamics.com',
  });

  assert.equal(result.deploymentEnvironmentId, FAKE_GUID);
  assert.equal(pollCount, 3);
});
