#!/usr/bin/env node
// Get detailed pipeline information including stages and solution artifacts.
// Usage: node get-pipeline-info.js --envUrl <url> --pipelineId <guid> --sourceEnvId <guid> --artifactName <string>
// Output: { "status": "success", "pipeline": {...} }

const { getAuthToken, makeRequest, UUID_REGEX } = require('./lib/pipeline-helpers');

const API_VERSION = 'v9.2';

function parseArgs(argv) {
  const args = argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && i + 1 < args.length) parsed.envUrl = args[++i].replace(/\/+$/, '');
    else if (args[i] === '--pipelineId' && i + 1 < args.length) parsed.pipelineId = args[++i];
    else if (args[i] === '--sourceEnvId' && i + 1 < args.length) parsed.sourceEnvId = args[++i];
    else if (args[i] === '--artifactName' && i + 1 < args.length) parsed.artifactName = args[++i];
    else if (args[i] === '--tenant' && i + 1 < args.length) parsed.tenant = args[++i];
  }
  if (!parsed.envUrl || !parsed.pipelineId || !parsed.sourceEnvId || !parsed.artifactName) {
    console.error(JSON.stringify({ error: 'Required: --envUrl, --pipelineId, --sourceEnvId, --artifactName' }));
    process.exit(1);
  }
  if (!UUID_REGEX.test(parsed.pipelineId) || !UUID_REGEX.test(parsed.sourceEnvId)) {
    console.error(JSON.stringify({ error: 'pipelineId and sourceEnvId must be valid GUIDs' }));
    process.exit(1);
  }
  return parsed;
}

async function main() {
  const { envUrl, pipelineId, sourceEnvId, artifactName, tenant } = parseArgs(process.argv);
  const resourceUrl = new URL(envUrl).origin;
  const token = getAuthToken(resourceUrl, tenant);
  if (!token) {
    console.error(JSON.stringify({ error: 'Failed to obtain auth token. Run "az login" first.' }));
    process.exit(1);
  }

  const encodedName = encodeURIComponent(artifactName);
  const apiPath = `RetrieveDeploymentPipelineInfo(DeploymentPipelineId=${pipelineId},SourceEnvironmentId='${sourceEnvId}',ArtifactName='${encodedName}')`;

  const result = await makeRequest({
    url: `${envUrl}/api/data/${API_VERSION}/${apiPath}`,
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0'
    }
  });

  if (result.error) {
    console.error(JSON.stringify({ error: result.error }));
    process.exit(1);
  }

  if (result.statusCode !== 200) {
    let errorData;
    try { errorData = JSON.parse(result.body); } catch { errorData = result.body; }
    console.error(JSON.stringify({ error: `Get pipeline info failed with status ${result.statusCode}`, details: errorData }));
    process.exit(1);
  }

  let data;
  try {
    data = JSON.parse(result.body);
  } catch {
    console.error(JSON.stringify({ error: 'Failed to parse response' }));
    process.exit(1);
  }

  console.log(JSON.stringify({
    status: 'success',
    pipeline: data
  }));
  process.exit(0);
}

main();
