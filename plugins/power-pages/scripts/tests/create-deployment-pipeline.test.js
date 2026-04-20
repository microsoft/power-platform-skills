const test = require('node:test');
const assert = require('node:assert/strict');

// Unit tests for create-deployment-pipeline.js
// Network calls are mocked via module-level replacement on helpers.makeRequest.

const { createDeploymentPipeline } = require('../lib/create-deployment-pipeline');

const PIPELINE_GUID = '11111111-2222-3333-4444-555555555555';
const STAGE1_GUID = 'aaaaaaaa-bbbb-cccc-dddd-111111111111';
const STAGE2_GUID = 'aaaaaaaa-bbbb-cccc-dddd-222222222222';
const SOURCE_ENV_ID = 'src-env-0000-0000-0000-000000000000';
const TARGET_ENV_ID_1 = 'tgt-env-1111-1111-1111-111111111111';
const TARGET_ENV_ID_2 = 'tgt-env-2222-2222-2222-222222222222';

function makeEntityIdUrl(base, entity, guid) {
  return `${base}/api/data/v9.2/${entity}(${guid})`;
}

function buildMockMakeRequest(hostEnvUrl) {
  // Track call sequence to return correct entity IDs
  let callIndex = 0;
  return async (opts) => {
    callIndex++;
    if (opts.method === 'POST' && opts.url.includes('/deploymentpipelines') && !opts.url.includes('/msdyn_sourceenvironment')) {
      // Pipeline create
      return {
        statusCode: 204,
        body: '',
        headers: { 'odata-entityid': makeEntityIdUrl(hostEnvUrl, 'deploymentpipelines', PIPELINE_GUID) },
      };
    }
    if (opts.method === 'PUT' && opts.url.includes('/$ref')) {
      // $ref association
      return { statusCode: 204, body: '' };
    }
    if (opts.method === 'POST' && opts.url.includes('/deploymentstages')) {
      // Stage creates — return different GUIDs per call
      const stageGuid = callIndex % 2 === 0 ? STAGE1_GUID : STAGE2_GUID;
      return {
        statusCode: 204,
        body: '',
        headers: { 'odata-entityid': makeEntityIdUrl(hostEnvUrl, 'deploymentstages', stageGuid) },
      };
    }
    return { statusCode: 200, body: '{}' };
  };
}

test('createDeploymentPipeline returns pipelineId and stages[] on success', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const origReq = helpers.makeRequest;

  const HOST = 'https://host.crm.dynamics.com';
  helpers.makeRequest = buildMockMakeRequest(HOST);

  t.after(() => { helpers.makeRequest = origReq; });

  const result = await createDeploymentPipeline({
    hostEnvUrl: HOST,
    token: 'fake-token',
    pipelineName: 'IdeaSphere Pipeline',
    description: 'Test pipeline',
    sourceDeploymentEnvironmentId: SOURCE_ENV_ID,
    stagesJson: JSON.stringify([
      { name: 'Deploy to Staging', targetDeploymentEnvironmentId: TARGET_ENV_ID_1, order: 1 },
    ]),
  });

  assert.equal(result.pipelineId, PIPELINE_GUID);
  assert.equal(result.pipelineName, 'IdeaSphere Pipeline');
  assert.ok(Array.isArray(result.stages));
  assert.equal(result.stages.length, 1);
  assert.equal(result.stages[0].name, 'Deploy to Staging');
  assert.equal(result.stages[0].targetDeploymentEnvironmentId, TARGET_ENV_ID_1);
  assert.ok(result.stages[0].stageId, 'stageId should be set');
});

test('createDeploymentPipeline gives each stage a stageId from OData-EntityId', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const origReq = helpers.makeRequest;

  const HOST = 'https://host.crm.dynamics.com';

  // Return distinct GUIDs for the two stages
  const stageGuids = [STAGE1_GUID, STAGE2_GUID];
  let stageCallIndex = 0;

  helpers.makeRequest = async (opts) => {
    if (opts.method === 'POST' && opts.url.includes('/deploymentpipelines') && !opts.url.includes('/$ref')) {
      return {
        statusCode: 204,
        body: '',
        headers: { 'odata-entityid': `${HOST}/api/data/v9.2/deploymentpipelines(${PIPELINE_GUID})` },
      };
    }
    if (opts.method === 'PUT' && opts.url.includes('/$ref')) {
      return { statusCode: 204, body: '' };
    }
    if (opts.method === 'POST' && opts.url.includes('/deploymentstages')) {
      const guid = stageGuids[stageCallIndex++];
      return {
        statusCode: 204,
        body: '',
        headers: { 'odata-entityid': `${HOST}/api/data/v9.2/deploymentstages(${guid})` },
      };
    }
    return { statusCode: 200, body: '{}' };
  };

  t.after(() => { helpers.makeRequest = origReq; });

  const result = await createDeploymentPipeline({
    hostEnvUrl: HOST,
    token: 'fake-token',
    pipelineName: 'Two-Stage Pipeline',
    description: '',
    sourceDeploymentEnvironmentId: SOURCE_ENV_ID,
    stagesJson: JSON.stringify([
      { name: 'Deploy to Staging', targetDeploymentEnvironmentId: TARGET_ENV_ID_1, order: 1 },
      { name: 'Deploy to Production', targetDeploymentEnvironmentId: TARGET_ENV_ID_2, order: 2 },
    ]),
  });

  assert.equal(result.stages.length, 2);
  assert.equal(result.stages[0].stageId, STAGE1_GUID);
  assert.equal(result.stages[1].stageId, STAGE2_GUID);
  assert.equal(result.stages[0].name, 'Deploy to Staging');
  assert.equal(result.stages[1].name, 'Deploy to Production');
});

test('createDeploymentPipeline throws when --pipelineName is missing', async () => {
  await assert.rejects(
    () => createDeploymentPipeline({
      hostEnvUrl: 'https://host.crm.dynamics.com',
      token: 'tok',
      sourceDeploymentEnvironmentId: SOURCE_ENV_ID,
      stagesJson: '[]',
    }),
    /--pipelineName is required/
  );
});

test('createDeploymentPipeline throws when --hostEnvUrl is missing', async () => {
  await assert.rejects(
    () => createDeploymentPipeline({
      token: 'tok',
      pipelineName: 'Pipeline',
      sourceDeploymentEnvironmentId: SOURCE_ENV_ID,
      stagesJson: '[]',
    }),
    /--hostEnvUrl is required/
  );
});

test('createDeploymentPipeline throws when --sourceDeploymentEnvironmentId is missing', async () => {
  await assert.rejects(
    () => createDeploymentPipeline({
      hostEnvUrl: 'https://host.crm.dynamics.com',
      token: 'tok',
      pipelineName: 'Pipeline',
      stagesJson: '[]',
    }),
    /--sourceDeploymentEnvironmentId is required/
  );
});
