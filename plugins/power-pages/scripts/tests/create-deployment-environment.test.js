const test = require('node:test');
const assert = require('node:assert/strict');

// Unit tests for create-deployment-environment.js (unprefixed schema).
// Field shape verified against msdyn_AppDeploymentAnchor v9.1.2026034 in a
// live tenant on 2026-04-28. Earlier msdyn_-prefixed shape is no longer
// supported by the shipped Pipelines schema.

const {
  createDeploymentEnvironment,
  ENV_TYPE_DEV,
  ENV_TYPE_TARGET,
  VALIDATION_STATUS_SUCCEEDED,
  VALIDATION_STATUS_FAILED,
} = require('../lib/create-deployment-environment');

const FAKE_GUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const BAP_ENV_ID = '9f930375-571f-ee07-8b8f-d4a9e317c292';
const ODATA_ENTITY_ID_HEADER = `https://host.crm.dynamics.com/api/data/v9.1/deploymentenvironments(${FAKE_GUID})`;

const VALIDATION_STATUS_PENDING = 200000000;

function setupMock(t, fn) {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  helpers.makeRequest = fn;
  t.after(() => { helpers.makeRequest = orig; });
}

test('exported constants match the shipped schema', () => {
  assert.equal(ENV_TYPE_DEV, 200000000);
  assert.equal(ENV_TYPE_TARGET, 200000001);
  assert.equal(VALIDATION_STATUS_SUCCEEDED, 200000001);
  assert.equal(VALIDATION_STATUS_FAILED, 200000002);
});

test('returns deploymentEnvironmentId when validation succeeds on first poll', async (t) => {
  let postBodySeen = null;
  setupMock(t, async (opts) => {
    if (opts.method === 'GET' && opts.url.includes('$filter=')) {
      // existence check — none
      return { statusCode: 200, body: JSON.stringify({ value: [] }) };
    }
    if (opts.method === 'POST') {
      postBodySeen = JSON.parse(opts.body);
      return { statusCode: 204, body: '', headers: { 'odata-entityid': ODATA_ENTITY_ID_HEADER } };
    }
    // Poll
    return { statusCode: 200, body: JSON.stringify({ validationstatus: VALIDATION_STATUS_SUCCEEDED }) };
  });

  const result = await createDeploymentEnvironment({
    hostEnvUrl: 'https://host.crm.dynamics.com',
    token: 'fake-token',
    name: 'My Dev Env',
    bapEnvId: BAP_ENV_ID,
    environmentUrl: 'https://org.crm.dynamics.com',
    environmentType: ENV_TYPE_DEV,
  });

  assert.equal(result.deploymentEnvironmentId, FAKE_GUID);
  assert.equal(result.name, 'My Dev Env');
  assert.equal(result.bapEnvId, BAP_ENV_ID);
  assert.equal(result.environmentType, ENV_TYPE_DEV);
  assert.equal(result.validationStatus, VALIDATION_STATUS_SUCCEEDED);
  assert.equal(result.reused, false);

  // Body uses unprefixed schema with BAP env GUID
  assert.equal(postBodySeen.name, 'My Dev Env');
  assert.equal(postBodySeen.environmentid, BAP_ENV_ID);
  assert.equal(postBodySeen.environmenttype, ENV_TYPE_DEV);
  assert.equal(postBodySeen.msdyn_name, undefined);
  assert.equal(postBodySeen.msdyn_url, undefined);
});

test('idempotent — reuses existing record when bapEnvId already has one', async (t) => {
  let postCount = 0;
  setupMock(t, async (opts) => {
    if (opts.method === 'GET' && opts.url.includes('$filter=')) {
      return {
        statusCode: 200,
        body: JSON.stringify({ value: [{
          deploymentenvironmentid: FAKE_GUID,
          name: 'Existing Env',
          environmentid: BAP_ENV_ID,
          environmenttype: ENV_TYPE_TARGET,
          validationstatus: VALIDATION_STATUS_SUCCEEDED,
        }] }),
      };
    }
    if (opts.method === 'POST') postCount++;
    return { statusCode: 200, body: JSON.stringify({ validationstatus: VALIDATION_STATUS_SUCCEEDED }) };
  });

  const result = await createDeploymentEnvironment({
    hostEnvUrl: 'https://host.crm.dynamics.com',
    token: 'fake-token',
    name: 'New Name (ignored)',
    bapEnvId: BAP_ENV_ID,
    environmentType: ENV_TYPE_TARGET,
  });

  assert.equal(result.deploymentEnvironmentId, FAKE_GUID);
  assert.equal(result.name, 'Existing Env');
  assert.equal(result.reused, true);
  assert.equal(postCount, 0, 'must not POST when reusing');
});

test('throws when validation fails with error details', async (t) => {
  setupMock(t, async (opts) => {
    if (opts.method === 'GET' && opts.url.includes('$filter=')) {
      return { statusCode: 200, body: JSON.stringify({ value: [] }) };
    }
    if (opts.method === 'POST') {
      return { statusCode: 204, body: '', headers: { 'odata-entityid': ODATA_ENTITY_ID_HEADER } };
    }
    return {
      statusCode: 200,
      body: JSON.stringify({
        validationstatus: VALIDATION_STATUS_FAILED,
        errormessage: 'Environment not accessible from this host',
      }),
    };
  });

  await assert.rejects(
    () => createDeploymentEnvironment({
      hostEnvUrl: 'https://host.crm.dynamics.com',
      token: 'fake-token',
      name: 'Bad Env',
      bapEnvId: BAP_ENV_ID,
      environmentType: ENV_TYPE_TARGET,
    }),
    /Environment not accessible from this host/,
  );
});

test('polls through pending status before succeeding', async (t) => {
  let pollCount = 0;
  setupMock(t, async (opts) => {
    if (opts.method === 'GET' && opts.url.includes('$filter=')) {
      return { statusCode: 200, body: JSON.stringify({ value: [] }) };
    }
    if (opts.method === 'POST') {
      return { statusCode: 204, body: '', headers: { 'odata-entityid': ODATA_ENTITY_ID_HEADER } };
    }
    pollCount++;
    if (pollCount < 3) {
      return { statusCode: 200, body: JSON.stringify({ validationstatus: VALIDATION_STATUS_PENDING }) };
    }
    return { statusCode: 200, body: JSON.stringify({ validationstatus: VALIDATION_STATUS_SUCCEEDED }) };
  });

  const result = await createDeploymentEnvironment({
    hostEnvUrl: 'https://host.crm.dynamics.com',
    token: 'fake-token',
    name: 'Staging',
    bapEnvId: BAP_ENV_ID,
    environmentType: ENV_TYPE_TARGET,
  });

  assert.equal(result.deploymentEnvironmentId, FAKE_GUID);
  assert.equal(pollCount, 3);
});

test('throws when required args are missing', async () => {
  await assert.rejects(
    () => createDeploymentEnvironment({ token: 't', name: 'n', bapEnvId: BAP_ENV_ID, environmentType: ENV_TYPE_DEV }),
    /--hostEnvUrl is required/,
  );
  await assert.rejects(
    () => createDeploymentEnvironment({ hostEnvUrl: 'h', name: 'n', bapEnvId: BAP_ENV_ID, environmentType: ENV_TYPE_DEV }),
    /--token is required/,
  );
  await assert.rejects(
    () => createDeploymentEnvironment({ hostEnvUrl: 'h', token: 't', bapEnvId: BAP_ENV_ID, environmentType: ENV_TYPE_DEV }),
    /--name is required/,
  );
  await assert.rejects(
    () => createDeploymentEnvironment({ hostEnvUrl: 'h', token: 't', name: 'n', environmentType: ENV_TYPE_DEV }),
    /--bapEnvId is required/,
  );
  await assert.rejects(
    () => createDeploymentEnvironment({ hostEnvUrl: 'h', token: 't', name: 'n', bapEnvId: BAP_ENV_ID }),
    /--environmentType must be/,
  );
  await assert.rejects(
    () => createDeploymentEnvironment({ hostEnvUrl: 'h', token: 't', name: 'n', bapEnvId: BAP_ENV_ID, environmentType: 999 }),
    /--environmentType must be/,
  );
});
