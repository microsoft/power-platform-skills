#!/usr/bin/env node
// Start a deployment stage run.
// Usage: node start-deployment.js --envUrl <url> --artifactName <string> --devEnvId <guid> --stageId <guid> --solutionId <guid>
// Output: { "status": "success", "stageRunId": "<created-id>" }

const { getAuthToken, makeRequest, extractEntityId, UUID_REGEX, API_PATHS } = require('./lib/pipeline-helpers');

const API_VERSION = 'v9.2';

function parseArgs(argv) {
  const args = argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && i + 1 < args.length) parsed.envUrl = args[++i].replace(/\/+$/, '');
    else if (args[i] === '--artifactName' && i + 1 < args.length) parsed.artifactName = args[++i];
    else if (args[i] === '--devEnvId' && i + 1 < args.length) parsed.devEnvId = args[++i];
    else if (args[i] === '--stageId' && i + 1 < args.length) parsed.stageId = args[++i];
    else if (args[i] === '--solutionId' && i + 1 < args.length) parsed.solutionId = args[++i];
    else if (args[i] === '--tenant' && i + 1 < args.length) parsed.tenant = args[++i];
  }
  if (!parsed.envUrl || !parsed.artifactName || !parsed.devEnvId || !parsed.stageId || !parsed.solutionId) {
    console.error(JSON.stringify({ error: 'Required: --envUrl, --artifactName, --devEnvId, --stageId, --solutionId' }));
    process.exit(1);
  }
  for (const [key, val] of [['devEnvId', parsed.devEnvId], ['stageId', parsed.stageId], ['solutionId', parsed.solutionId]]) {
    if (!UUID_REGEX.test(val)) {
      console.error(JSON.stringify({ error: `${key} must be a valid GUID` }));
      process.exit(1);
    }
  }
  return parsed;
}

async function main() {
  const { envUrl, artifactName, devEnvId, stageId, solutionId, tenant } = parseArgs(process.argv);
  const resourceUrl = new URL(envUrl).origin;
  const token = getAuthToken(resourceUrl, tenant);
  if (!token) {
    console.error(JSON.stringify({ error: 'Failed to obtain auth token. Run "az login" first.' }));
    process.exit(1);
  }

  const bodyObj = {
    artifactname: artifactName,
    'devdeploymentenvironment@odata.bind': `/${API_PATHS.ENVIRONMENTS}(${devEnvId})`,
    'deploymentstageid@odata.bind': `/${API_PATHS.STAGES}(${stageId})`,
    'solutionid': solutionId
  };

  const result = await makeRequest({
    url: `${envUrl}/api/data/${API_VERSION}/${API_PATHS.STAGE_RUNS}`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
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
    console.error(JSON.stringify({ error: `Deployment start failed with status ${result.statusCode}`, details: errorData }));
    process.exit(1);
  }

  const odataEntityId = result.headers && (result.headers['odata-entityid'] || result.headers['OData-EntityId']);
  const stageRunId = extractEntityId(odataEntityId);
  if (!stageRunId) {
    console.error(JSON.stringify({ error: 'Could not extract stage run ID from response headers' }));
    process.exit(1);
  }

  console.log(JSON.stringify({
    status: 'success',
    stageRunId
  }));
  process.exit(0);
}

main();
