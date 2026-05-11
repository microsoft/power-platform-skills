'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Unit tests for force-link-environment.js (calls ManageEnvironmentStamp).
// API shape verified against the supplierportalpipelineshostch.crm17
// Deployment Pipeline Configuration HAR, 2026-05-11.

const {
  forceLinkEnvironment,
  formatGuidForStamp,
  VALIDATION_STATUS_SUCCEEDED,
  VALIDATION_STATUS_FAILED,
  VALIDATION_STATUS_PENDING,
} = require('../lib/force-link-environment');

const HOST_URL = 'https://host.crm.dynamics.com';
const DEPLOYMENT_ENV_ID = 'c44399fe-bf4a-f111-bec6-7ced8d42befa';

function setupMock(t, fn) {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  helpers.makeRequest = fn;
  t.after(() => { helpers.makeRequest = orig; });
}

test('exported status constants match the Dataverse schema', () => {
  assert.equal(VALIDATION_STATUS_PENDING, 200000000);
  assert.equal(VALIDATION_STATUS_SUCCEEDED, 200000001);
  assert.equal(VALIDATION_STATUS_FAILED, 200000002);
});

test('formatGuidForStamp wraps GUID in {UPPERCASE} braces to match the HAR shape', () => {
  assert.equal(
    formatGuidForStamp('c44399fe-bf4a-f111-bec6-7ced8d42befa'),
    '{C44399FE-BF4A-F111-BEC6-7CED8D42BEFA}',
  );
  // Already-uppercase input is left alone (case-insensitive).
  assert.equal(
    formatGuidForStamp('C44399FE-BF4A-F111-BEC6-7CED8D42BEFA'),
    '{C44399FE-BF4A-F111-BEC6-7CED8D42BEFA}',
  );
});

test('POSTs the correct body, headers, and endpoint and returns Succeeded', async (t) => {
  let postSeen = null;
  let pollSeen = null;
  setupMock(t, async (opts) => {
    if (opts.method === 'POST') {
      postSeen = opts;
      return { statusCode: 204, body: '', headers: {} };
    }
    pollSeen = opts;
    return {
      statusCode: 200,
      body: JSON.stringify({ validationstatus: VALIDATION_STATUS_SUCCEEDED, errormessage: null, name: 'Dev' }),
    };
  });

  const result = await forceLinkEnvironment({
    hostEnvUrl: HOST_URL,
    token: 'fake-token',
    deploymentEnvironmentId: DEPLOYMENT_ENV_ID,
    intervalMs: 1,
  });

  // Endpoint
  assert.equal(postSeen.url, `${HOST_URL}/api/data/v9.0/ManageEnvironmentStamp`);

  // Body shape (HAR-verified): {"DeploymentEnvironmentId":"{UPPER-GUID}"}
  const body = JSON.parse(postSeen.body);
  assert.deepEqual(Object.keys(body), ['DeploymentEnvironmentId']);
  assert.equal(body.DeploymentEnvironmentId, '{C44399FE-BF4A-F111-BEC6-7CED8D42BEFA}');

  // Required headers
  assert.equal(postSeen.headers.Authorization, 'Bearer fake-token');
  assert.equal(postSeen.headers['Content-Type'], 'application/json');
  assert.equal(postSeen.headers.clienthost, 'Browser');
  assert.equal(postSeen.headers['x-ms-app-name'], 'AppDeploymentConfiguration');
  assert.equal(postSeen.headers.prefer, 'odata.include-annotations="*"');

  // Poll URL targets the same record
  assert.match(pollSeen.url, /deploymentenvironments\(c44399fe-bf4a-f111-bec6-7ced8d42befa\)/);
  assert.match(pollSeen.url, /\$select=validationstatus,errormessage,name/);

  // Return contract
  assert.equal(result.deploymentEnvironmentId, DEPLOYMENT_ENV_ID);
  assert.equal(result.hostEnvUrl, HOST_URL);
  assert.equal(result.validationStatus, VALIDATION_STATUS_SUCCEEDED);
  assert.ok(typeof result.forcedAt === 'string' && result.forcedAt.length > 0);
});

test('trims trailing slashes from hostEnvUrl', async (t) => {
  let postSeen = null;
  setupMock(t, async (opts) => {
    if (opts.method === 'POST') {
      postSeen = opts;
      return { statusCode: 204, body: '', headers: {} };
    }
    return {
      statusCode: 200,
      body: JSON.stringify({ validationstatus: VALIDATION_STATUS_SUCCEEDED }),
    };
  });

  await forceLinkEnvironment({
    hostEnvUrl: `${HOST_URL}///`,
    token: 't',
    deploymentEnvironmentId: DEPLOYMENT_ENV_ID,
    intervalMs: 1,
  });

  assert.equal(postSeen.url, `${HOST_URL}/api/data/v9.0/ManageEnvironmentStamp`);
});

test('polls through Pending before resolving Succeeded', async (t) => {
  let pollCount = 0;
  setupMock(t, async (opts) => {
    if (opts.method === 'POST') return { statusCode: 204, body: '', headers: {} };
    pollCount++;
    if (pollCount < 3) {
      return { statusCode: 200, body: JSON.stringify({ validationstatus: VALIDATION_STATUS_PENDING }) };
    }
    return { statusCode: 200, body: JSON.stringify({ validationstatus: VALIDATION_STATUS_SUCCEEDED }) };
  });

  const result = await forceLinkEnvironment({
    hostEnvUrl: HOST_URL,
    token: 't',
    deploymentEnvironmentId: DEPLOYMENT_ENV_ID,
    intervalMs: 1,
  });

  assert.equal(pollCount, 3);
  assert.equal(result.validationStatus, VALIDATION_STATUS_SUCCEEDED);
});

test('throws when post-link validation reports Failed with the errormessage', async (t) => {
  setupMock(t, async (opts) => {
    if (opts.method === 'POST') return { statusCode: 204, body: '', headers: {} };
    return {
      statusCode: 200,
      body: JSON.stringify({
        validationstatus: VALIDATION_STATUS_FAILED,
        errormessage: 'Environment still claimed by previous host',
      }),
    };
  });

  await assert.rejects(
    () => forceLinkEnvironment({
      hostEnvUrl: HOST_URL,
      token: 't',
      deploymentEnvironmentId: DEPLOYMENT_ENV_ID,
      intervalMs: 1,
    }),
    /Environment still claimed by previous host/,
  );
});

test('throws when ManageEnvironmentStamp returns non-204 (e.g., 403 missing role)', async (t) => {
  setupMock(t, async (opts) => {
    if (opts.method === 'POST') {
      return { statusCode: 403, body: 'Caller lacks Deployment Pipeline Administrator role', headers: {} };
    }
    return { statusCode: 200, body: JSON.stringify({ validationstatus: VALIDATION_STATUS_SUCCEEDED }) };
  });

  await assert.rejects(
    () => forceLinkEnvironment({
      hostEnvUrl: HOST_URL,
      token: 't',
      deploymentEnvironmentId: DEPLOYMENT_ENV_ID,
      intervalMs: 1,
    }),
    /returned status 403/,
  );
});

test('throws when ManageEnvironmentStamp returns 404 (record missing on host)', async (t) => {
  setupMock(t, async (opts) => {
    if (opts.method === 'POST') {
      return { statusCode: 404, body: 'deploymentenvironment not found', headers: {} };
    }
    return { statusCode: 200, body: '{}' };
  });

  await assert.rejects(
    () => forceLinkEnvironment({
      hostEnvUrl: HOST_URL,
      token: 't',
      deploymentEnvironmentId: DEPLOYMENT_ENV_ID,
      intervalMs: 1,
    }),
    /returned status 404/,
  );
});

test('throws when polling times out without reaching terminal status', async (t) => {
  setupMock(t, async (opts) => {
    if (opts.method === 'POST') return { statusCode: 204, body: '', headers: {} };
    return { statusCode: 200, body: JSON.stringify({ validationstatus: VALIDATION_STATUS_PENDING }) };
  });

  await assert.rejects(
    () => forceLinkEnvironment({
      hostEnvUrl: HOST_URL,
      token: 't',
      deploymentEnvironmentId: DEPLOYMENT_ENV_ID,
      intervalMs: 1,
      maxAttempts: 2,
    }),
    /did not complete after 2 attempts/,
  );
});

test('throws when required args are missing', async () => {
  await assert.rejects(
    () => forceLinkEnvironment({ token: 't', deploymentEnvironmentId: DEPLOYMENT_ENV_ID }),
    /--hostEnvUrl is required/,
  );
  await assert.rejects(
    () => forceLinkEnvironment({ hostEnvUrl: HOST_URL, deploymentEnvironmentId: DEPLOYMENT_ENV_ID }),
    /--token is required/,
  );
  await assert.rejects(
    () => forceLinkEnvironment({ hostEnvUrl: HOST_URL, token: 't' }),
    /--deploymentEnvironmentId is required/,
  );
});

test('throws on malformed GUID before making any HTTP call', async (t) => {
  let calls = 0;
  setupMock(t, async () => { calls++; return { statusCode: 204, body: '' }; });

  await assert.rejects(
    () => forceLinkEnvironment({
      hostEnvUrl: HOST_URL,
      token: 't',
      deploymentEnvironmentId: 'not-a-guid',
    }),
    /is not a valid GUID/,
  );
  assert.equal(calls, 0, 'must validate GUID before any network call');
});
