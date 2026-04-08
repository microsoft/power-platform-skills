#!/usr/bin/env node

// Creates a deployment pipeline record, associates the source environment via $ref,
// and creates stage records for each target environment.
//
// Usage:
//   node create-deployment-pipeline.js \
//     --hostEnvUrl <url> \
//     --token <token> \
//     --pipelineName <name> \
//     --description <desc> \
//     --sourceDeploymentEnvironmentId <guid> \
//     --stagesJson '[{"name":"Deploy to Staging","targetDeploymentEnvironmentId":"...","order":1}]'
//
// Output (JSON to stdout):
//   {
//     "pipelineId": "...",
//     "pipelineName": "...",
//     "stages": [{ "stageId": "...", "name": "...", "targetDeploymentEnvironmentId": "..." }]
//   }
//
// Exit 0 on success, exit 1 on error (stderr).

'use strict';

const helpers = require('./validation-helpers');

function parseArgs(argv) {
  const args = argv.slice(2);
  let hostEnvUrl = null;
  let token = null;
  let pipelineName = null;
  let description = '';
  let sourceDeploymentEnvironmentId = null;
  let stagesJson = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--hostEnvUrl' && args[i + 1]) hostEnvUrl = args[++i];
    else if (args[i] === '--token' && args[i + 1]) token = args[++i];
    else if (args[i] === '--pipelineName' && args[i + 1]) pipelineName = args[++i];
    else if (args[i] === '--description' && args[i + 1]) description = args[++i];
    else if (args[i] === '--sourceDeploymentEnvironmentId' && args[i + 1]) sourceDeploymentEnvironmentId = args[++i];
    else if (args[i] === '--stagesJson' && args[i + 1]) stagesJson = args[++i];
  }

  return { hostEnvUrl, token, pipelineName, description, sourceDeploymentEnvironmentId, stagesJson };
}

function extractGuidFromODataEntityId(header) {
  if (!header) return null;
  const match = header.match(/\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/i);
  return match ? match[1] : null;
}

async function createDeploymentPipeline({
  hostEnvUrl,
  token,
  pipelineName,
  description = '',
  sourceDeploymentEnvironmentId,
  stagesJson,
} = {}) {
  if (!hostEnvUrl) throw new Error('--hostEnvUrl is required');
  if (!token) throw new Error('--token is required');
  if (!pipelineName) throw new Error('--pipelineName is required');
  if (!sourceDeploymentEnvironmentId) throw new Error('--sourceDeploymentEnvironmentId is required');
  if (!stagesJson) throw new Error('--stagesJson is required');

  const cleanHostEnvUrl = hostEnvUrl.replace(/\/+$/, '');

  let stages;
  try {
    stages = typeof stagesJson === 'string' ? JSON.parse(stagesJson) : stagesJson;
  } catch (e) {
    throw new Error(`Failed to parse --stagesJson: ${e.message}`);
  }

  if (!Array.isArray(stages)) {
    throw new Error('--stagesJson must be a JSON array');
  }

  // Step 1: Create the pipeline record
  const pipelineBody = JSON.stringify({
    msdyn_name: pipelineName,
    msdyn_description: description,
  });

  const pipelineRes = await helpers.makeRequest({
    url: `${cleanHostEnvUrl}/api/data/v9.2/deploymentpipelines`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: pipelineBody,
    includeHeaders: true,
    timeout: 30000,
  });

  if (pipelineRes.error) {
    throw new Error(`Create deploymentpipelines failed: ${pipelineRes.error}`);
  }

  if (pipelineRes.statusCode < 200 || pipelineRes.statusCode >= 300) {
    throw new Error(
      `Create deploymentpipelines returned status ${pipelineRes.statusCode}: ${pipelineRes.body}`
    );
  }

  const pipelineEntityId = pipelineRes.headers && pipelineRes.headers['odata-entityid'];
  const pipelineId = extractGuidFromODataEntityId(pipelineEntityId);

  if (!pipelineId) {
    throw new Error(
      `Could not extract pipelineId from OData-EntityId header: ${pipelineEntityId}`
    );
  }

  // Step 2: Associate source environment via $ref
  const refBody = JSON.stringify({
    '@odata.context': `${cleanHostEnvUrl}/api/data/v9.2/$metadata#$ref`,
    '@odata.id': `deploymentenvironments(${sourceDeploymentEnvironmentId})`,
  });

  const refRes = await helpers.makeRequest({
    url: `${cleanHostEnvUrl}/api/data/v9.2/deploymentpipelines(${pipelineId})/msdyn_sourceenvironment/$ref`,
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: refBody,
    timeout: 15000,
  });

  if (refRes.error) {
    throw new Error(`Associate source environment via $ref failed: ${refRes.error}`);
  }

  if (refRes.statusCode < 200 || refRes.statusCode >= 300) {
    throw new Error(
      `Associate source environment via $ref returned status ${refRes.statusCode}: ${refRes.body}`
    );
  }

  // Step 3: Create stage records for each target
  const createdStages = [];

  for (const stage of stages) {
    const { name: stageName, targetDeploymentEnvironmentId, order } = stage;

    if (!stageName) throw new Error('Each stage must have a "name" field');
    if (!targetDeploymentEnvironmentId) {
      throw new Error('Each stage must have a "targetDeploymentEnvironmentId" field');
    }

    const stageBody = JSON.stringify({
      msdyn_name: stageName,
      msdyn_order: order || 1,
      'msdyn_pipelineid@odata.bind': `/deploymentpipelines(${pipelineId})`,
      'msdyn_targetenvironmentid@odata.bind': `/deploymentenvironments(${targetDeploymentEnvironmentId})`,
    });

    const stageRes = await helpers.makeRequest({
      url: `${cleanHostEnvUrl}/api/data/v9.2/deploymentstages`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: stageBody,
      includeHeaders: true,
      timeout: 30000,
    });

    if (stageRes.error) {
      throw new Error(`Create deploymentstage "${stageName}" failed: ${stageRes.error}`);
    }

    if (stageRes.statusCode < 200 || stageRes.statusCode >= 300) {
      throw new Error(
        `Create deploymentstage "${stageName}" returned status ${stageRes.statusCode}: ${stageRes.body}`
      );
    }

    const stageEntityId = stageRes.headers && stageRes.headers['odata-entityid'];
    const stageId = extractGuidFromODataEntityId(stageEntityId);

    if (!stageId) {
      throw new Error(
        `Could not extract stageId from OData-EntityId header for stage "${stageName}": ${stageEntityId}`
      );
    }

    createdStages.push({
      stageId,
      name: stageName,
      targetDeploymentEnvironmentId,
    });
  }

  return {
    pipelineId,
    pipelineName,
    stages: createdStages,
  };
}

// CLI entry point
if (require.main === module) {
  const { hostEnvUrl, token, pipelineName, description, sourceDeploymentEnvironmentId, stagesJson } =
    parseArgs(process.argv);

  createDeploymentPipeline({
    hostEnvUrl,
    token,
    pipelineName,
    description,
    sourceDeploymentEnvironmentId,
    stagesJson,
  })
    .then((result) => {
      console.log(JSON.stringify(result));
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    });
}

module.exports = { createDeploymentPipeline };
