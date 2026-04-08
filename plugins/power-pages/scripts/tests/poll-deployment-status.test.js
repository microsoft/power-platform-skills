const test = require('node:test');
const assert = require('node:assert/strict');

// Unit tests for poll-deployment-status.js
// Network calls are mocked via helpers.makeRequest

const { pollDeploymentStatus } = require('../lib/poll-deployment-status');

const VALID_ARGS = {
  hostEnvUrl: 'https://host.crm.dynamics.com',
  token: 'fake-token',
  stageRunId: 'stage-run-guid-5678',
  intervalMs: 0,   // zero interval so tests run fast
  maxAttempts: 5,
};

test('pollDeploymentStatus returns { status: Succeeded } on first poll', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const origReq = helpers.makeRequest;

  helpers.makeRequest = async () => ({
    statusCode: 200,
    body: JSON.stringify({
      msdyn_stagerunstatus: 200000002,  // Succeeded
      msdyn_deploymentresults: '{"result":"ok"}',
      msdyn_errordetails: null,
    }),
  });

  t.after(() => { helpers.makeRequest = origReq; });

  const result = await pollDeploymentStatus(VALID_ARGS);
  assert.equal(result.status, 'Succeeded');
  assert.equal(result.stageRunId, VALID_ARGS.stageRunId);
  assert.equal(result.deploymentResults, '{"result":"ok"}');
  assert.equal(result.errorDetails, null);
});

test('pollDeploymentStatus returns { status: Awaiting } for approval gate and does NOT throw', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const origReq = helpers.makeRequest;

  helpers.makeRequest = async () => ({
    statusCode: 200,
    body: JSON.stringify({
      msdyn_stagerunstatus: 200000005,  // Awaiting approval
      msdyn_deploymentresults: null,
      msdyn_errordetails: null,
    }),
  });

  t.after(() => { helpers.makeRequest = origReq; });

  // Must NOT throw — approval gate is non-blocking
  const result = await pollDeploymentStatus(VALID_ARGS);
  assert.equal(result.status, 'Awaiting');
  assert.equal(result.stageRunId, VALID_ARGS.stageRunId);
  assert.equal(result.deploymentResults, null);
  assert.equal(result.errorDetails, null);
});

test('pollDeploymentStatus throws on Failed status with errorDetails', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const origReq = helpers.makeRequest;

  helpers.makeRequest = async () => ({
    statusCode: 200,
    body: JSON.stringify({
      msdyn_stagerunstatus: 200000003,  // Failed
      msdyn_deploymentresults: null,
      msdyn_errordetails: 'Import failed: missing dependency',
    }),
  });

  t.after(() => { helpers.makeRequest = origReq; });

  await assert.rejects(
    () => pollDeploymentStatus(VALID_ARGS),
    /Failed.*Import failed: missing dependency/
  );
});

test('pollDeploymentStatus throws on Canceled status', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const origReq = helpers.makeRequest;

  helpers.makeRequest = async () => ({
    statusCode: 200,
    body: JSON.stringify({
      msdyn_stagerunstatus: 200000004,  // Canceled
      msdyn_deploymentresults: null,
      msdyn_errordetails: null,
    }),
  });

  t.after(() => { helpers.makeRequest = origReq; });

  await assert.rejects(
    () => pollDeploymentStatus(VALID_ARGS),
    /Canceled/
  );
});

test('pollDeploymentStatus throws when maxAttempts exceeded (always in-progress)', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const origReq = helpers.makeRequest;

  // Always return an in-progress status (not a terminal state)
  helpers.makeRequest = async () => ({
    statusCode: 200,
    body: JSON.stringify({
      msdyn_stagerunstatus: 200000010,  // Deploying (in-progress)
      msdyn_deploymentresults: null,
      msdyn_errordetails: null,
    }),
  });

  t.after(() => { helpers.makeRequest = origReq; });

  await assert.rejects(
    () => pollDeploymentStatus({ ...VALID_ARGS, maxAttempts: 3 }),
    /timed out/i
  );
});

test('pollDeploymentStatus throws when required args missing', async () => {
  await assert.rejects(
    () => pollDeploymentStatus({ hostEnvUrl: 'https://host.crm.dynamics.com' }),
    /Missing required arguments/
  );
});
