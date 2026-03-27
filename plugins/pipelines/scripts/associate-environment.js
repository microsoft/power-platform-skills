#!/usr/bin/env node
// Associate a source environment with a deployment pipeline.
// Usage: node associate-environment.js --envUrl <url> --pipelineId <guid> --environmentId <guid>
// Output: { "status": "success", "pipelineId": "<guid>", "environmentId": "<guid>" }

const { getAuthToken, makeRequest, UUID_REGEX, API_PATHS } = require('./lib/pipeline-helpers');

const API_VERSION = 'v9.2';

function parseArgs(argv) {
  const args = argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && i + 1 < args.length) parsed.envUrl = args[++i].replace(/\/+$/, '');
    else if (args[i] === '--pipelineId' && i + 1 < args.length) parsed.pipelineId = args[++i];
    else if (args[i] === '--environmentId' && i + 1 < args.length) parsed.environmentId = args[++i];
    else if (args[i] === '--tenant' && i + 1 < args.length) parsed.tenant = args[++i];
  }
  if (!parsed.envUrl || !parsed.pipelineId || !parsed.environmentId) {
    console.error(JSON.stringify({ error: 'Required: --envUrl, --pipelineId, --environmentId' }));
    process.exit(1);
  }
  if (!UUID_REGEX.test(parsed.pipelineId) || !UUID_REGEX.test(parsed.environmentId)) {
    console.error(JSON.stringify({ error: 'pipelineId and environmentId must be valid GUIDs' }));
    process.exit(1);
  }
  return parsed;
}

async function main() {
  const { envUrl, pipelineId, environmentId, tenant } = parseArgs(process.argv);
  const resourceUrl = new URL(envUrl).origin;
  const token = getAuthToken(resourceUrl, tenant);
  if (!token) {
    console.error(JSON.stringify({ error: 'Failed to obtain auth token. Run "az login" first.' }));
    process.exit(1);
  }

  const apiPath = `${API_PATHS.PIPELINES}(${pipelineId})/deploymentpipeline_deploymentenvironment/$ref`;
  const body = JSON.stringify({
    '@odata.context': `${envUrl}/api/data/${API_VERSION}/$metadata#$ref`,
    '@odata.id': `${API_PATHS.ENVIRONMENTS}(${environmentId})`
  });

  const result = await makeRequest({
    url: `${envUrl}/api/data/${API_VERSION}/${apiPath}`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0'
    },
    body
  });

  if (result.error) {
    console.error(JSON.stringify({ error: result.error }));
    process.exit(1);
  }

  if (result.statusCode < 200 || result.statusCode >= 300) {
    let errorData;
    try { errorData = JSON.parse(result.body); } catch { errorData = result.body; }
    console.error(JSON.stringify({ error: `Association failed with status ${result.statusCode}`, details: errorData }));
    process.exit(1);
  }

  console.log(JSON.stringify({
    status: 'success',
    pipelineId,
    environmentId
  }));
  process.exit(0);
}

main();
