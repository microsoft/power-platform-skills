const test = require('node:test');
const assert = require('node:assert/strict');

// Unit tests for poll-validation-status.js
// Network calls are mocked via helpers.makeRequest

const { pollValidationStatus } = require('../lib/poll-validation-status');

const VALID_ARGS = {
  hostEnvUrl: 'https://host.crm.dynamics.com',
  token: 'fake-token',
  stageRunId: 'stage-run-guid-1234',
  intervalMs: 0,   // zero interval so tests run fast
  maxAttempts: 5,
};

test('pollValidationStatus returns immediately when stageRunStatus is Validation Succeeded (200000007)', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const origReq = helpers.makeRequest;

  helpers.makeRequest = async () => ({
    statusCode: 200,
    body: JSON.stringify({
      stagerunstatus: 200000007,     // Validation Succeeded
      validationresults: null,
    }),
  });

  t.after(() => { helpers.makeRequest = origReq; });

  const result = await pollValidationStatus(VALID_ARGS);
  assert.equal(result.stageRunId, VALID_ARGS.stageRunId);
  assert.equal(result.stageRunStatus, 200000007);
  assert.equal(result.validationResults, null);
});

test('pollValidationStatus returns validationResults when validation succeeds with results', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const origReq = helpers.makeRequest;

  helpers.makeRequest = async () => ({
    statusCode: 200,
    body: JSON.stringify({
      stagerunstatus: 200000007,
      validationresults: '{"ValidationStatus":"Succeeded"}',
    }),
  });

  t.after(() => { helpers.makeRequest = origReq; });

  const result = await pollValidationStatus(VALID_ARGS);
  assert.equal(result.validationResults, '{"ValidationStatus":"Succeeded"}');
});

test('pollValidationStatus throws when stageRunStatus is Failed with validationResults', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const origReq = helpers.makeRequest;

  helpers.makeRequest = async () => ({
    statusCode: 200,
    body: JSON.stringify({
      stagerunstatus: 200000003,     // Failed
      validationresults: 'Missing dependency: SomeComponent',
    }),
  });

  t.after(() => { helpers.makeRequest = origReq; });

  await assert.rejects(
    () => pollValidationStatus(VALID_ARGS),
    /Validation failed.*Missing dependency/
  );
});

test('pollValidationStatus throws when maxAttempts exceeded (always in validating state)', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const origReq = helpers.makeRequest;

  // Always return an in-progress validation state (not Succeeded or Failed)
  helpers.makeRequest = async () => ({
    statusCode: 200,
    body: JSON.stringify({
      stagerunstatus: 200000006,   // Validating (in-progress)
      validationresults: null,
    }),
  });

  t.after(() => { helpers.makeRequest = origReq; });

  await assert.rejects(
    () => pollValidationStatus({ ...VALID_ARGS, maxAttempts: 3 }),
    /timed out/i
  );
});

test('pollValidationStatus throws when required args missing', async () => {
  await assert.rejects(
    () => pollValidationStatus({ hostEnvUrl: 'https://host.crm.dynamics.com' }),
    /Missing required arguments/
  );
});

test('pollValidationStatus throws on non-200 HTTP status', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const origReq = helpers.makeRequest;

  helpers.makeRequest = async () => ({
    statusCode: 404,
    body: 'Not found',
  });

  t.after(() => { helpers.makeRequest = origReq; });

  await assert.rejects(
    () => pollValidationStatus(VALID_ARGS),
    /Unexpected status 404/
  );
});
