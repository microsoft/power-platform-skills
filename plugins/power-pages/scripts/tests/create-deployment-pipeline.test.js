const test = require('node:test');
const assert = require('node:assert/strict');

// Unit tests for create-deployment-pipeline.js (unprefixed schema).
// Field shape verified against msdyn_AppDeploymentAnchor v9.1.2026034 in a
// live tenant on 2026-04-28.

const { createDeploymentPipeline } = require('../lib/create-deployment-pipeline');

const PIPELINE_GUID = '11111111-2222-3333-4444-555555555555';
const STAGE1_GUID = 'aaaaaaaa-bbbb-cccc-dddd-111111111111';
const STAGE2_GUID = 'aaaaaaaa-bbbb-cccc-dddd-222222222222';
const SOURCE_ENV_ID = 'src-env-0000-0000-0000-000000000000';
const TARGET_ENV_ID_1 = 'tgt-env-1111-1111-1111-111111111111';
const TARGET_ENV_ID_2 = 'tgt-env-2222-2222-2222-222222222222';
const HOST = 'https://host.crm.dynamics.com';

function setupMock(t, fn) {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  helpers.makeRequest = fn;
  t.after(() => { helpers.makeRequest = orig; });
}

function makeEntityIdUrl(entity, guid) {
  return `${HOST}/api/data/v9.1/${entity}(${guid})`;
}

// Helper that returns a default-success mock router for a single-stage pipeline create.
function defaultSuccessMock(stageGuids = [STAGE1_GUID]) {
  let stageIdx = 0;
  return async (opts) => {
    // Pipeline existence check (filter on name)
    if (opts.method === 'GET' && opts.url.includes('/deploymentpipelines') && opts.url.includes('$filter=')) {
      return { statusCode: 200, body: JSON.stringify({ value: [] }) };
    }
    // Stage existence check (filter on _deploymentpipelineid_value)
    if (opts.method === 'GET' && opts.url.includes('/deploymentstages') && opts.url.includes('$filter=')) {
      return { statusCode: 200, body: JSON.stringify({ value: [] }) };
    }
    // Source association check (M2M nav)
    if (opts.method === 'GET' && opts.url.includes('/deploymentpipeline_deploymentenvironment')) {
      return { statusCode: 200, body: JSON.stringify({ value: [] }) };
    }
    // Pipeline create
    if (opts.method === 'POST' && opts.url.endsWith('/deploymentpipelines')) {
      return { statusCode: 204, body: '', headers: { 'odata-entityid': makeEntityIdUrl('deploymentpipelines', PIPELINE_GUID) } };
    }
    // Source $ref association (POST + deploymentpipeline_deploymentenvironment)
    if (opts.method === 'POST' && opts.url.includes('/deploymentpipeline_deploymentenvironment/$ref')) {
      return { statusCode: 204, body: '' };
    }
    // Stage create
    if (opts.method === 'POST' && opts.url.endsWith('/deploymentstages')) {
      const guid = stageGuids[stageIdx++] || STAGE1_GUID;
      return { statusCode: 204, body: '', headers: { 'odata-entityid': makeEntityIdUrl('deploymentstages', guid) } };
    }
    return { statusCode: 200, body: '{}' };
  };
}

test('returns pipelineId and stages[] on success — uses unprefixed schema', async (t) => {
  let pipelineBodySeen = null;
  let refBodySeen = null;
  let refMethod = null;
  let refUrl = null;
  let stageBodySeen = null;

  setupMock(t, async (opts) => {
    if (opts.method === 'GET' && opts.url.includes('$filter=')) {
      return { statusCode: 200, body: JSON.stringify({ value: [] }) };
    }
    if (opts.method === 'GET' && opts.url.includes('/deploymentpipeline_deploymentenvironment')) {
      return { statusCode: 200, body: JSON.stringify({ value: [] }) };
    }
    if (opts.method === 'POST' && opts.url.endsWith('/deploymentpipelines')) {
      pipelineBodySeen = JSON.parse(opts.body);
      return { statusCode: 204, body: '', headers: { 'odata-entityid': makeEntityIdUrl('deploymentpipelines', PIPELINE_GUID) } };
    }
    if (opts.url.includes('/deploymentpipeline_deploymentenvironment/$ref')) {
      refMethod = opts.method;
      refUrl = opts.url;
      refBodySeen = JSON.parse(opts.body);
      return { statusCode: 204, body: '' };
    }
    if (opts.method === 'POST' && opts.url.endsWith('/deploymentstages')) {
      stageBodySeen = JSON.parse(opts.body);
      return { statusCode: 204, body: '', headers: { 'odata-entityid': makeEntityIdUrl('deploymentstages', STAGE1_GUID) } };
    }
    return { statusCode: 200, body: '{}' };
  });

  const result = await createDeploymentPipeline({
    hostEnvUrl: HOST,
    token: 'fake-token',
    pipelineName: 'BYOC Demo Pipeline',
    description: 'Test pipeline',
    sourceDeploymentEnvironmentId: SOURCE_ENV_ID,
    stagesJson: JSON.stringify([
      { name: 'Deploy to Staging', targetDeploymentEnvironmentId: TARGET_ENV_ID_1 },
    ]),
  });

  assert.equal(result.pipelineId, PIPELINE_GUID);
  assert.equal(result.pipelineName, 'BYOC Demo Pipeline');
  assert.equal(result.stages.length, 1);
  assert.equal(result.stages[0].stageId, STAGE1_GUID);

  // Pipeline body uses unprefixed schema
  assert.equal(pipelineBodySeen.name, 'BYOC Demo Pipeline');
  assert.equal(pipelineBodySeen.description, 'Test pipeline');
  assert.equal(pipelineBodySeen.statuscode, 1);
  assert.equal(pipelineBodySeen.statecode, 0);
  assert.equal(pipelineBodySeen.msdyn_name, undefined);
  assert.equal(pipelineBodySeen.msdyn_description, undefined);

  // Source ref uses POST (not PUT) on deploymentpipeline_deploymentenvironment
  assert.equal(refMethod, 'POST');
  assert.match(refUrl, /\/deploymentpipeline_deploymentenvironment\/\$ref$/);
  assert.equal(refBodySeen['@odata.id'], `deploymentenvironments(${SOURCE_ENV_ID})`);

  // Stage body uses unprefixed @odata.bind property names
  assert.equal(stageBodySeen.name, 'Deploy to Staging');
  assert.equal(stageBodySeen['deploymentpipelineid@odata.bind'], `/deploymentpipelines(${PIPELINE_GUID})`);
  assert.equal(stageBodySeen['targetdeploymentenvironmentid@odata.bind'], `/deploymentenvironments(${TARGET_ENV_ID_1})`);
  assert.equal(stageBodySeen['msdyn_pipelineid@odata.bind'], undefined);
});

test('multi-stage — assigns each stage a distinct stageId', async (t) => {
  setupMock(t, defaultSuccessMock([STAGE1_GUID, STAGE2_GUID]));

  const result = await createDeploymentPipeline({
    hostEnvUrl: HOST,
    token: 'fake-token',
    pipelineName: 'Two-Stage Pipeline',
    description: '',
    sourceDeploymentEnvironmentId: SOURCE_ENV_ID,
    stagesJson: JSON.stringify([
      { name: 'Deploy to Staging', targetDeploymentEnvironmentId: TARGET_ENV_ID_1 },
      { name: 'Deploy to Production', targetDeploymentEnvironmentId: TARGET_ENV_ID_2 },
    ]),
  });

  assert.equal(result.stages.length, 2);
  assert.equal(result.stages[0].stageId, STAGE1_GUID);
  assert.equal(result.stages[1].stageId, STAGE2_GUID);
});

test('idempotent — reuses existing pipeline by name', async (t) => {
  let pipelinePostCount = 0;
  setupMock(t, async (opts) => {
    if (opts.method === 'GET' && opts.url.includes('/deploymentpipelines') && opts.url.includes('$filter=')) {
      return {
        statusCode: 200,
        body: JSON.stringify({ value: [{ deploymentpipelineid: PIPELINE_GUID, name: 'Existing Pipeline' }] }),
      };
    }
    if (opts.method === 'GET' && opts.url.includes('/deploymentstages') && opts.url.includes('$filter=')) {
      return { statusCode: 200, body: JSON.stringify({ value: [] }) };
    }
    if (opts.method === 'GET' && opts.url.includes('/deploymentpipeline_deploymentenvironment')) {
      return { statusCode: 200, body: JSON.stringify({ value: [{ deploymentenvironmentid: SOURCE_ENV_ID }] }) };
    }
    if (opts.method === 'POST' && opts.url.endsWith('/deploymentpipelines')) {
      pipelinePostCount++;
      return { statusCode: 204, body: '' };
    }
    if (opts.method === 'POST' && opts.url.endsWith('/deploymentstages')) {
      return { statusCode: 204, body: '', headers: { 'odata-entityid': makeEntityIdUrl('deploymentstages', STAGE1_GUID) } };
    }
    return { statusCode: 200, body: '{}' };
  });

  const result = await createDeploymentPipeline({
    hostEnvUrl: HOST,
    token: 'fake-token',
    pipelineName: 'Existing Pipeline',
    sourceDeploymentEnvironmentId: SOURCE_ENV_ID,
    stagesJson: JSON.stringify([{ name: 'Deploy to Staging', targetDeploymentEnvironmentId: TARGET_ENV_ID_1 }]),
  });

  assert.equal(result.pipelineId, PIPELINE_GUID);
  assert.equal(pipelinePostCount, 0, 'must not POST when reusing');
});

test('idempotent — reuses existing stage by name+pipelineId', async (t) => {
  let stagePostCount = 0;
  setupMock(t, async (opts) => {
    if (opts.method === 'GET' && opts.url.includes('/deploymentpipelines') && opts.url.includes('$filter=')) {
      return { statusCode: 200, body: JSON.stringify({ value: [] }) };
    }
    if (opts.method === 'GET' && opts.url.includes('/deploymentstages') && opts.url.includes('$filter=')) {
      return { statusCode: 200, body: JSON.stringify({ value: [{ deploymentstageid: STAGE2_GUID, name: 'Deploy to Staging' }] }) };
    }
    if (opts.method === 'GET' && opts.url.includes('/deploymentpipeline_deploymentenvironment')) {
      return { statusCode: 200, body: JSON.stringify({ value: [] }) };
    }
    if (opts.method === 'POST' && opts.url.endsWith('/deploymentpipelines')) {
      return { statusCode: 204, body: '', headers: { 'odata-entityid': makeEntityIdUrl('deploymentpipelines', PIPELINE_GUID) } };
    }
    if (opts.method === 'POST' && opts.url.includes('/deploymentpipeline_deploymentenvironment/$ref')) {
      return { statusCode: 204, body: '' };
    }
    if (opts.method === 'POST' && opts.url.endsWith('/deploymentstages')) {
      stagePostCount++;
      return { statusCode: 204, body: '' };
    }
    return { statusCode: 200, body: '{}' };
  });

  const result = await createDeploymentPipeline({
    hostEnvUrl: HOST,
    token: 'fake-token',
    pipelineName: 'New Pipeline With Reused Stage Name',
    sourceDeploymentEnvironmentId: SOURCE_ENV_ID,
    stagesJson: JSON.stringify([{ name: 'Deploy to Staging', targetDeploymentEnvironmentId: TARGET_ENV_ID_1 }]),
  });

  assert.equal(result.stages.length, 1);
  assert.equal(result.stages[0].stageId, STAGE2_GUID);
  assert.equal(stagePostCount, 0, 'must not POST when stage exists');
});

test('reuses existing pipeline by source+target wiring even with different name', async (t) => {
  // Existing pipeline "Old Pipeline Name" wired to source SOURCE_ENV_ID and target TARGET_ENV_ID_1
  // User requests "New Pipeline Name" with same source + same target → should reuse Old Pipeline
  const EXISTING_PIPELINE_ID = '99999999-aaaa-bbbb-cccc-dddddddddddd';
  const EXISTING_STAGE_ID = '11111111-2222-3333-4444-eeeeeeeeeeee';

  let pipelinePostCount = 0;
  let stagePostCount = 0;

  setupMock(t, async (opts) => {
    // Name-match lookup returns nothing for "New Pipeline Name"
    if (opts.method === 'GET' && opts.url.includes('/deploymentpipelines') && opts.url.includes('$filter=name')) {
      return { statusCode: 200, body: JSON.stringify({ value: [] }) };
    }
    // Wiring lookup: list all pipelines
    if (opts.method === 'GET' && opts.url.includes('/deploymentpipelines') && !opts.url.includes('/deploymentpipeline_deploymentenvironment') && !opts.url.includes('$filter=')) {
      return { statusCode: 200, body: JSON.stringify({ value: [{ deploymentpipelineid: EXISTING_PIPELINE_ID, name: 'Old Pipeline Name' }] }) };
    }
    // Source binding for the existing pipeline
    if (opts.method === 'GET' && opts.url.includes(`/deploymentpipelines(${EXISTING_PIPELINE_ID})/deploymentpipeline_deploymentenvironment`)) {
      return { statusCode: 200, body: JSON.stringify({ value: [{ deploymentenvironmentid: SOURCE_ENV_ID }] }) };
    }
    // Stages on the existing pipeline (with original stage name "Old Stage")
    if (opts.method === 'GET' && opts.url.includes('/deploymentstages') && opts.url.includes('$filter=')) {
      return { statusCode: 200, body: JSON.stringify({ value: [{
        deploymentstageid: EXISTING_STAGE_ID,
        name: 'Old Stage Name',
        _targetdeploymentenvironmentid_value: TARGET_ENV_ID_1,
      }] }) };
    }
    // No POSTs should happen
    if (opts.method === 'POST' && opts.url.endsWith('/deploymentpipelines')) {
      pipelinePostCount++;
      return { statusCode: 204, body: '' };
    }
    if (opts.method === 'POST' && opts.url.endsWith('/deploymentstages')) {
      stagePostCount++;
      return { statusCode: 204, body: '' };
    }
    if (opts.method === 'POST' && opts.url.includes('/$ref')) {
      return { statusCode: 204, body: '' };
    }
    return { statusCode: 200, body: '{}' };
  });

  const result = await createDeploymentPipeline({
    hostEnvUrl: HOST,
    token: 'fake-token',
    pipelineName: 'New Pipeline Name',
    sourceDeploymentEnvironmentId: SOURCE_ENV_ID,
    stagesJson: JSON.stringify([{ name: 'New Stage Name', targetDeploymentEnvironmentId: TARGET_ENV_ID_1 }]),
  });

  assert.equal(result.pipelineId, EXISTING_PIPELINE_ID, 'should reuse the existing pipeline');
  assert.equal(result.pipelineName, 'Old Pipeline Name', 'should report the original name');
  assert.equal(result.reused, true);
  assert.equal(result.reusedByWiring.requestedName, 'New Pipeline Name');
  assert.equal(result.reusedByWiring.originalName, 'Old Pipeline Name');
  assert.equal(result.stages.length, 1);
  assert.equal(result.stages[0].stageId, EXISTING_STAGE_ID);
  assert.equal(result.stages[0].reusedFromWiringMatch, true);
  assert.equal(pipelinePostCount, 0, 'must not POST a new pipeline');
  assert.equal(stagePostCount, 0, 'must not POST a new stage');
});

test('does NOT reuse pipeline by wiring when target envs differ', async (t) => {
  const EXISTING_PIPELINE_ID = '99999999-aaaa-bbbb-cccc-dddddddddddd';
  let pipelinePostCount = 0;

  setupMock(t, async (opts) => {
    if (opts.method === 'GET' && opts.url.includes('$filter=name')) {
      return { statusCode: 200, body: JSON.stringify({ value: [] }) };
    }
    if (opts.method === 'GET' && opts.url.includes('/deploymentpipelines') && !opts.url.includes('$filter=') && !opts.url.includes('deploymentpipeline_deploymentenvironment')) {
      return { statusCode: 200, body: JSON.stringify({ value: [{ deploymentpipelineid: EXISTING_PIPELINE_ID, name: 'Old' }] }) };
    }
    if (opts.url.includes('/deploymentpipeline_deploymentenvironment')) {
      return { statusCode: 200, body: JSON.stringify({ value: [{ deploymentenvironmentid: SOURCE_ENV_ID }] }) };
    }
    if (opts.method === 'GET' && opts.url.includes('/deploymentstages')) {
      // Existing pipeline targets TARGET_ENV_ID_1, but we'll request TARGET_ENV_ID_2
      return { statusCode: 200, body: JSON.stringify({ value: [{
        deploymentstageid: 'old-stage',
        _targetdeploymentenvironmentid_value: TARGET_ENV_ID_1,
      }] }) };
    }
    if (opts.method === 'POST' && opts.url.endsWith('/deploymentpipelines')) {
      pipelinePostCount++;
      return { statusCode: 204, body: '', headers: { 'odata-entityid': makeEntityIdUrl('deploymentpipelines', PIPELINE_GUID) } };
    }
    if (opts.method === 'POST' && opts.url.includes('/$ref')) return { statusCode: 204, body: '' };
    if (opts.method === 'POST' && opts.url.endsWith('/deploymentstages')) {
      return { statusCode: 204, body: '', headers: { 'odata-entityid': makeEntityIdUrl('deploymentstages', STAGE2_GUID) } };
    }
    return { statusCode: 200, body: '{}' };
  });

  const result = await createDeploymentPipeline({
    hostEnvUrl: HOST,
    token: 'fake-token',
    pipelineName: 'Different Targets Pipeline',
    sourceDeploymentEnvironmentId: SOURCE_ENV_ID,
    stagesJson: JSON.stringify([{ name: 'Stage', targetDeploymentEnvironmentId: TARGET_ENV_ID_2 }]),
  });

  assert.equal(result.reused, false, 'should not reuse — targets differ');
  assert.equal(pipelinePostCount, 1, 'should POST a new pipeline');
});

test('throws when required args are missing', async () => {
  await assert.rejects(
    () => createDeploymentPipeline({ token: 't', pipelineName: 'p', sourceDeploymentEnvironmentId: SOURCE_ENV_ID, stagesJson: '[]' }),
    /--hostEnvUrl is required/,
  );
  await assert.rejects(
    () => createDeploymentPipeline({ hostEnvUrl: HOST, token: 't', sourceDeploymentEnvironmentId: SOURCE_ENV_ID, stagesJson: '[]' }),
    /--pipelineName is required/,
  );
  await assert.rejects(
    () => createDeploymentPipeline({ hostEnvUrl: HOST, token: 't', pipelineName: 'p', stagesJson: '[]' }),
    /--sourceDeploymentEnvironmentId is required/,
  );
  await assert.rejects(
    () => createDeploymentPipeline({ hostEnvUrl: HOST, token: 't', pipelineName: 'p', sourceDeploymentEnvironmentId: SOURCE_ENV_ID }),
    /--stagesJson is required/,
  );
});
