#!/usr/bin/env node
// Create a deployment stage in a pipeline.
// Usage: node create-stage.js --envUrl <url> --pipelineId <guid> --name <string> --targetEnvId <guid> [--description <string>]
// Output: { "status": "success", "stageId": "<created-id>", "name": "<name>" }

const { getAuthToken, makeRequest, extractEntityId, UUID_REGEX, API_PATHS } = require('./lib/pipeline-helpers');

const API_VERSION = 'v9.2';

function parseArgs(argv) {
  const args = argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && i + 1 < args.length) parsed.envUrl = args[++i].replace(/\/+$/, '');
    else if (args[i] === '--pipelineId' && i + 1 < args.length) parsed.pipelineId = args[++i];
    else if (args[i] === '--name' && i + 1 < args.length) parsed.name = args[++i];
    else if (args[i] === '--targetEnvId' && i + 1 < args.length) parsed.targetEnvId = args[++i];
    else if (args[i] === '--description' && i + 1 < args.length) parsed.description = args[++i];
    else if (args[i] === '--tenant' && i + 1 < args.length) parsed.tenant = args[++i];
  }
  if (!parsed.envUrl || !parsed.pipelineId || !parsed.name || !parsed.targetEnvId) {
    console.error(JSON.stringify({ error: 'Required: --envUrl, --pipelineId, --name, --targetEnvId' }));
    process.exit(1);
  }
  if (!UUID_REGEX.test(parsed.pipelineId) || !UUID_REGEX.test(parsed.targetEnvId)) {
    console.error(JSON.stringify({ error: 'pipelineId and targetEnvId must be valid GUIDs' }));
    process.exit(1);
  }
  return parsed;
}

async function main() {
  const { envUrl, pipelineId, name, targetEnvId, description, tenant } = parseArgs(process.argv);
  const resourceUrl = new URL(envUrl).origin;
  const token = getAuthToken(resourceUrl, tenant);
  if (!token) {
    console.error(JSON.stringify({ error: 'Failed to obtain auth token. Run "az login" first.' }));
    process.exit(1);
  }

  const bodyObj = {
    name,
    'deploymentpipelineid@odata.bind': `/${API_PATHS.PIPELINES}(${pipelineId})`,
    'targetdeploymentenvironmentid@odata.bind': `/${API_PATHS.ENVIRONMENTS}(${targetEnvId})`
  };
  if (description) bodyObj.description = description;

  const result = await makeRequest({
    url: `${envUrl}/api/data/${API_VERSION}/${API_PATHS.STAGES}`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Prefer: 'return=representation',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0'
    },
    body: JSON.stringify(bodyObj),
    includeHeaders: true
  });

  if (result.error) {
    console.error(JSON.stringify({ error: result.error }));
    process.exit(1);
  }

  if (result.statusCode < 200 || result.statusCode >= 300) {
    let errorData;
    try { errorData = JSON.parse(result.body); } catch { errorData = result.body; }
    console.error(JSON.stringify({ error: `Stage creation failed with status ${result.statusCode}`, details: errorData }));
    process.exit(1);
  }

  let responseData = null;
  try { responseData = JSON.parse(result.body); } catch { /* fallback to header */ }

  const stageId = (responseData && responseData.deploymentstageid) ||
    extractEntityId(result.headers && (result.headers['odata-entityid'] || result.headers['OData-EntityId']));

  if (!stageId) {
    console.error(JSON.stringify({ error: 'Could not extract stage ID from response' }));
    process.exit(1);
  }

  console.log(JSON.stringify({
    status: 'success',
    stageId,
    name
  }));
  process.exit(0);
}

main();
