#!/usr/bin/env node
// List deployment pipelines for a source environment.
// Usage: node list-pipelines.js --envUrl <url> --sourceEnvId <guid>
// Output: { "status": "success", "pipelines": [...] }

const { getAuthToken, makeRequest, UUID_REGEX } = require('./lib/pipeline-helpers');

const API_VERSION = 'v9.2';

function parseArgs(argv) {
  const args = argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && i + 1 < args.length) parsed.envUrl = args[++i].replace(/\/+$/, '');
    else if (args[i] === '--sourceEnvId' && i + 1 < args.length) parsed.sourceEnvId = args[++i];
    else if (args[i] === '--tenant' && i + 1 < args.length) parsed.tenant = args[++i];
  }
  if (!parsed.envUrl || !parsed.sourceEnvId) {
    console.error(JSON.stringify({ error: 'Required: --envUrl, --sourceEnvId' }));
    process.exit(1);
  }
  if (!UUID_REGEX.test(parsed.sourceEnvId)) {
    console.error(JSON.stringify({ error: 'sourceEnvId must be a valid GUID' }));
    process.exit(1);
  }
  return parsed;
}

async function main() {
  const { envUrl, sourceEnvId, tenant } = parseArgs(process.argv);
  const resourceUrl = new URL(envUrl).origin;
  const token = getAuthToken(resourceUrl, tenant);
  if (!token) {
    console.error(JSON.stringify({ error: 'Failed to obtain auth token. Run "az login" first.' }));
    process.exit(1);
  }

  const apiPath = `RetrieveDeploymentPipelines(SourceEnvironmentId='${sourceEnvId}')`;

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
    console.error(JSON.stringify({ error: `List pipelines failed with status ${result.statusCode}`, details: errorData }));
    process.exit(1);
  }

  let data;
  try {
    data = JSON.parse(result.body);
  } catch {
    console.error(JSON.stringify({ error: 'Failed to parse response' }));
    process.exit(1);
  }

  // RetrieveDeploymentPipelines returns a custom response shape, not standard OData collection
  // Shape: { CanCreate, AvailablePipelines: [...], DeploymentEnvironment: {...} }
  const availablePipelines = (data.AvailablePipelines || []).map(p => ({
    pipelineId: p.PipelineId,
    name: p.Name,
    description: p.Description || '',
    isAssociatedToSourceEnvironment: p.IsAssociatedToSourceEnvironment,
    canDelete: p.CanDelete
  }));

  const deploymentEnvironment = data.DeploymentEnvironment ? {
    deploymentEnvironmentId: data.DeploymentEnvironment.DeploymentEnvironmentId,
    environmentId: data.DeploymentEnvironment.EnvironmentId,
    environmentType: data.DeploymentEnvironment.EnvironmentType
  } : null;

  console.log(JSON.stringify({
    status: 'success',
    canCreate: data.CanCreate,
    pipelines: availablePipelines,
    sourceDeploymentEnvironment: deploymentEnvironment
  }));
  process.exit(0);
}

main();
