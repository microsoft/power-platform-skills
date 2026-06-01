#!/usr/bin/env node

// Creates a deploymentstageruns record to initiate a Power Platform Pipeline deployment stage.
//
// Usage: node create-stage-run.js --hostEnvUrl <url> --token <token>
//                                  --stageId <id> --sourceDeploymentEnvironmentId <id>
//                                  --solutionId <guid> --artifactName <uniqueName>
//                                  [--pipelineId <id>]  (optional — not used in body, kept for logging)
//
// Output (JSON to stdout):
//   { "stageRunId": "..." }
//
// Exit 0 on success, exit 1 on failure (error on stderr).

'use strict';

const helpers = require('./validation-helpers');

function parseArgs(argv) {
  const args = argv.slice(2);
  const result = {
    hostEnvUrl: null,
    token: null,
    pipelineId: null,
    stageId: null,
    sourceDeploymentEnvironmentId: null,
    solutionId: null,
    artifactName: null,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--hostEnvUrl' && args[i + 1]) result.hostEnvUrl = args[++i];
    else if (args[i] === '--token' && args[i + 1]) result.token = args[++i];
    else if (args[i] === '--pipelineId' && args[i + 1]) result.pipelineId = args[++i];
    else if (args[i] === '--stageId' && args[i + 1]) result.stageId = args[++i];
    else if (args[i] === '--sourceDeploymentEnvironmentId' && args[i + 1]) result.sourceDeploymentEnvironmentId = args[++i];
    else if (args[i] === '--solutionId' && args[i + 1]) result.solutionId = args[++i];
    else if (args[i] === '--artifactName' && args[i + 1]) result.artifactName = args[++i];
  }

  return result;
}

async function createStageRun({ hostEnvUrl, token, pipelineId, stageId, sourceDeploymentEnvironmentId, solutionId, artifactName }) {
  if (!hostEnvUrl || !token || !stageId || !sourceDeploymentEnvironmentId || !solutionId || !artifactName) {
    throw new Error(
      'Missing required arguments: --hostEnvUrl, --token, --stageId, --sourceDeploymentEnvironmentId, --solutionId, --artifactName'
    );
  }

  // Uses v9.0 API with HAR-confirmed field names (no msdyn_ prefix).
  // $select=deploymentstagerunid ensures the created ID is returned in the response body (201)
  // or can be read from OData-EntityId header (204).
  const url = `${hostEnvUrl.replace(/\/+$/, '')}/api/data/v9.0/deploymentstageruns?$select=deploymentstagerunid`;
  const body = JSON.stringify({
    'deploymentstageid@odata.bind': `/deploymentstages(${stageId})`,
    'devdeploymentenvironment@odata.bind': `/deploymentenvironments(${sourceDeploymentEnvironmentId})`,
    'artifactname': artifactName,           // solution unique name for artifact lookup
    'solutionid': solutionId,              // solution GUID for pipeline artifact resolution
    'makerainoteslanguagecode': 'en-US',
  });

  const res = await helpers.makeRequest({
    url,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
    },
    body,
    includeHeaders: true,
    timeout: 30000,
  });

  if (res.error) {
    throw new Error(`Request failed: ${res.error}`);
  }

  if (res.statusCode === 400 || res.statusCode === 409) {
    throw new Error(`Stage run creation failed (${res.statusCode}): ${res.body}`);
  }

  if (res.statusCode !== 201 && res.statusCode !== 204) {
    throw new Error(`Unexpected status ${res.statusCode}: ${res.body}`);
  }

  let stageRunId = null;

  // 201: JSON body contains the record ID
  if (res.statusCode === 201 && res.body) {
    try {
      const data = JSON.parse(res.body);
      stageRunId = data.deploymentstagerunid || data.msdyn_deploymentstagerunid || null;
    } catch {
      // fall through to OData-EntityId header
    }
  }

  // 204 (or 201 without body ID): extract from OData-EntityId header
  if (!stageRunId) {
    const entityId = (res.headers && (res.headers['odata-entityid'] || res.headers['OData-EntityId'])) || '';
    const m = entityId.match(/deploymentstageruns\(([^)]+)\)/);
    stageRunId = m ? m[1] : null;
  }

  if (!stageRunId) {
    throw new Error('Could not extract stageRunId from response body or OData-EntityId header');
  }

  return { stageRunId };
}

// CLI entry point
if (require.main === module) {
  const args = parseArgs(process.argv);

  createStageRun(args)
    .then((result) => {
      console.log(JSON.stringify(result));
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    });
}

module.exports = { createStageRun };
