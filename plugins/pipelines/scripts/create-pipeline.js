#!/usr/bin/env node
// Create a deployment pipeline.
// Usage: node create-pipeline.js --envUrl <url> --name <string> [--enableAI]
// Output: { "status": "success", "pipelineId": "<created-id>", "name": "<name>" }

const { getAuthToken, makeRequest, extractEntityId, PIPELINE_STATE, PIPELINE_STATUS, DEPLOYMENT_TYPE, API_PATHS } = require('./lib/pipeline-helpers');

const API_VERSION = 'v9.2';

function parseArgs(argv) {
  const args = argv.slice(2);
  const parsed = { enableAI: true }; // AI deployment notes always enabled (matches maker portal)
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && i + 1 < args.length) parsed.envUrl = args[++i].replace(/\/+$/, '');
    else if (args[i] === '--name' && i + 1 < args.length) parsed.name = args[++i];
    else if (args[i] === '--description' && i + 1 < args.length) parsed.description = args[++i];
    else if (args[i] === '--noAI') parsed.enableAI = false;
    else if (args[i] === '--tenant' && i + 1 < args.length) parsed.tenant = args[++i];
  }
  if (!parsed.envUrl || !parsed.name) {
    console.error(JSON.stringify({ error: 'Required: --envUrl, --name [--description <text>] [--noAI]' }));
    process.exit(1);
  }
  return parsed;
}

async function main() {
  const { envUrl, name, description, enableAI, tenant } = parseArgs(process.argv);
  const resourceUrl = new URL(envUrl).origin;
  const token = getAuthToken(resourceUrl, tenant);
  if (!token) {
    console.error(JSON.stringify({ error: 'Failed to obtain auth token. Run "az login" first.' }));
    process.exit(1);
  }

  const pipelineBody = {
    name,
    enableaideploymentnotes: enableAI,
    statuscode: PIPELINE_STATUS.ACTIVE,
    statecode: PIPELINE_STATE.ACTIVE,
    deploymenttype: DEPLOYMENT_TYPE.STANDARD
  };
  if (description) pipelineBody.description = description;

  const body = JSON.stringify(pipelineBody);

  const result = await makeRequest({
    url: `${envUrl}/api/data/${API_VERSION}/${API_PATHS.PIPELINES}`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Prefer: 'return=representation',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0'
    },
    body,
    includeHeaders: true
  });

  if (result.error) {
    console.error(JSON.stringify({ error: result.error }));
    process.exit(1);
  }

  if (result.statusCode < 200 || result.statusCode >= 300) {
    let errorData;
    try { errorData = JSON.parse(result.body); } catch { errorData = result.body; }
    console.error(JSON.stringify({ error: `Pipeline creation failed with status ${result.statusCode}`, details: errorData }));
    process.exit(1);
  }

  // With Prefer: return=representation, the response body contains the created entity
  let responseData = null;
  try { responseData = JSON.parse(result.body); } catch { /* fallback to header */ }

  const pipelineId = (responseData && responseData.deploymentpipelineid) ||
    extractEntityId(result.headers && (result.headers['odata-entityid'] || result.headers['OData-EntityId']));

  if (!pipelineId) {
    console.error(JSON.stringify({ error: 'Could not extract pipeline ID from response' }));
    process.exit(1);
  }

  console.log(JSON.stringify({
    status: 'success',
    pipelineId,
    name
  }));
  process.exit(0);
}

main();
