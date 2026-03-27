#!/usr/bin/env node
// Trigger validation of a deployment stage run package.
// Called after creating a stage run, before deploying.
//
// Usage: node validate-deployment.js --envUrl <url> --stageRunId <guid> [--tenant <id>]
// Output: { "status": "success", "stageRunId": "<guid>" }

const { getAuthToken, makeRequest, UUID_REGEX } = require('./lib/pipeline-helpers');

function parseArgs(argv) {
  const args = argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && i + 1 < args.length) parsed.envUrl = args[++i].replace(/\/+$/, '');
    else if (args[i] === '--stageRunId' && i + 1 < args.length) parsed.stageRunId = args[++i];
    else if (args[i] === '--tenant' && i + 1 < args.length) parsed.tenant = args[++i];
  }
  if (!parsed.envUrl || !parsed.stageRunId) {
    console.error(JSON.stringify({ error: 'Required: --envUrl, --stageRunId' }));
    process.exit(1);
  }
  if (!UUID_REGEX.test(parsed.stageRunId)) {
    console.error(JSON.stringify({ error: 'stageRunId must be a valid GUID' }));
    process.exit(1);
  }
  return parsed;
}

async function main() {
  const { envUrl, stageRunId, tenant } = parseArgs(process.argv);
  const resourceUrl = new URL(envUrl).origin;
  const token = getAuthToken(resourceUrl, tenant);
  if (!token) {
    console.error(JSON.stringify({ error: 'Failed to obtain auth token. Run "az login" first.' }));
    process.exit(1);
  }

  // ValidatePackageAsync uses v9.1 (per UX codebase)
  const result = await makeRequest({
    url: `${envUrl}/api/data/v9.1/ValidatePackageAsync`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0'
    },
    body: JSON.stringify({ StageRunId: stageRunId })
  });

  if (result.error) {
    console.error(JSON.stringify({ error: result.error }));
    process.exit(1);
  }

  if (result.statusCode < 200 || result.statusCode >= 300) {
    let errorData;
    try { errorData = JSON.parse(result.body); } catch { errorData = result.body; }
    console.error(JSON.stringify({ error: `ValidatePackageAsync failed with status ${result.statusCode}`, details: errorData }));
    process.exit(1);
  }

  console.log(JSON.stringify({
    status: 'success',
    stageRunId,
    message: 'Validation initiated. Poll check-deployment-status.js for progress.'
  }));
  process.exit(0);
}

main();
