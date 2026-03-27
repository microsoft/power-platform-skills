#!/usr/bin/env node
// Register a deployment environment in the pipeline host.
// Usage: node register-environment.js --envUrl <url> --environmentId <guid> --name <string> --type <development|target>
// Output: { "status": "success", "deploymentEnvironmentId": "<created-id>", "environmentId": "<input-id>", "name": "<name>", "type": "<type>" }

const { getAuthToken, makeRequest, extractEntityId, ENV_TYPE, API_PATHS, UUID_REGEX } = require('./lib/pipeline-helpers');

const API_VERSION = 'v9.2';

function parseArgs(argv) {
  const args = argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && i + 1 < args.length) parsed.envUrl = args[++i].replace(/\/+$/, '');
    else if (args[i] === '--environmentId' && i + 1 < args.length) parsed.environmentId = args[++i];
    else if (args[i] === '--name' && i + 1 < args.length) parsed.name = args[++i];
    else if (args[i] === '--type' && i + 1 < args.length) parsed.type = args[++i].toLowerCase();
    else if (args[i] === '--tenant' && i + 1 < args.length) parsed.tenant = args[++i];
  }
  if (!parsed.envUrl || !parsed.environmentId || !parsed.name || !parsed.type) {
    console.error(JSON.stringify({ error: 'Required: --envUrl, --environmentId, --name, --type (development|target)' }));
    process.exit(1);
  }
  if (!['development', 'target'].includes(parsed.type)) {
    console.error(JSON.stringify({ error: '--type must be "development" or "target"' }));
    process.exit(1);
  }
  if (!UUID_REGEX.test(parsed.environmentId)) {
    console.error(JSON.stringify({ error: 'environmentId must be a valid GUID' }));
    process.exit(1);
  }
  return parsed;
}

async function main() {
  const { envUrl, environmentId, name, type, tenant } = parseArgs(process.argv);
  const resourceUrl = new URL(envUrl).origin;
  const token = getAuthToken(resourceUrl, tenant);
  if (!token) {
    console.error(JSON.stringify({ error: 'Failed to obtain auth token. Run "az login" first.' }));
    process.exit(1);
  }

  const envType = type === 'development' ? ENV_TYPE.DEVELOPMENT : ENV_TYPE.TARGET;
  const body = JSON.stringify({
    environmentid: environmentId,
    environmenttype: envType,
    name: name
  });

  const result = await makeRequest({
    url: `${envUrl}/api/data/${API_VERSION}/${API_PATHS.ENVIRONMENTS}`,
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
    console.error(JSON.stringify({ error: `Registration failed with status ${result.statusCode}`, details: errorData }));
    process.exit(1);
  }

  // With Prefer: return=representation, the created entity is returned in the response body
  let responseData = null;
  try { responseData = JSON.parse(result.body); } catch { /* fallback to header */ }

  const createdId = (responseData && responseData.deploymentenvironmentid) ||
    extractEntityId(result.headers && (result.headers['odata-entityid'] || result.headers['OData-EntityId']));

  if (!createdId) {
    console.error(JSON.stringify({ error: 'Failed to determine deploymentEnvironmentId from registration response.' }));
    process.exit(1);
  }

  console.log(JSON.stringify({
    status: 'success',
    deploymentEnvironmentId: createdId,
    environmentId,
    name,
    type
  }));
  process.exit(0);
}

main();
