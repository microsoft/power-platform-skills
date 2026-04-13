const test = require('node:test');
const assert = require('node:assert/strict');

// Unit tests for create-stage-run.js
// Network calls are mocked via helpers.makeRequest

const { createStageRun } = require('../lib/create-stage-run');

const VALID_ARGS = {
  hostEnvUrl: 'https://host.crm.dynamics.com',
  token: 'fake-token',
  pipelineId: 'pipeline-guid-1234',
  stageId: 'stage-guid-5678',
  sourceDeploymentEnvironmentId: 'srcenv-guid-9012',
  solutionId: 'solution-guid-3456',
  artifactName: 'MySolutionUniqueName',
};

test('createStageRun returns stageRunId from OData-EntityId on 204', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const origReq = helpers.makeRequest;

  helpers.makeRequest = async () => ({
    statusCode: 204,
    body: '',
    headers: {
      'odata-entityid': 'https://host.crm.dynamics.com/api/data/v9.2/deploymentstageruns(abc-123-def-456)',
    },
  });

  t.after(() => { helpers.makeRequest = origReq; });

  const result = await createStageRun(VALID_ARGS);
  assert.equal(result.stageRunId, 'abc-123-def-456');
});

test('createStageRun returns stageRunId from JSON body on 201', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const origReq = helpers.makeRequest;

  helpers.makeRequest = async () => ({
    statusCode: 201,
    body: JSON.stringify({ deploymentstagerunid: 'body-guid-789' }),
    headers: {},
  });

  t.after(() => { helpers.makeRequest = origReq; });

  const result = await createStageRun(VALID_ARGS);
  assert.equal(result.stageRunId, 'body-guid-789');
});

test('createStageRun throws on 409 with body text', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const origReq = helpers.makeRequest;

  helpers.makeRequest = async () => ({
    statusCode: 409,
    body: 'Conflict: stage run already exists',
    headers: {},
  });

  t.after(() => { helpers.makeRequest = origReq; });

  await assert.rejects(
    () => createStageRun(VALID_ARGS),
    /409.*Conflict: stage run already exists/
  );
});

test('createStageRun throws on 400 with body text', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const origReq = helpers.makeRequest;

  helpers.makeRequest = async () => ({
    statusCode: 400,
    body: 'Bad Request: invalid pipelineId',
    headers: {},
  });

  t.after(() => { helpers.makeRequest = origReq; });

  await assert.rejects(
    () => createStageRun(VALID_ARGS),
    /400.*Bad Request: invalid pipelineId/
  );
});

test('createStageRun throws when required args missing', async () => {
  await assert.rejects(
    () => createStageRun({ hostEnvUrl: 'https://host.crm.dynamics.com', token: 'tok' }),
    /Missing required arguments/
  );
});

test('createStageRun throws when stageRunId cannot be extracted', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const origReq = helpers.makeRequest;

  // 204 with no OData-EntityId header and no body ID
  helpers.makeRequest = async () => ({
    statusCode: 204,
    body: '',
    headers: {},
  });

  t.after(() => { helpers.makeRequest = origReq; });

  await assert.rejects(
    () => createStageRun(VALID_ARGS),
    /Could not extract stageRunId/
  );
});
