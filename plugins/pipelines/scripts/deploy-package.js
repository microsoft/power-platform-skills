#!/usr/bin/env node
// Deploy a validated package (trigger the actual import into target environment).
// This is Step 2 of deployment — called AFTER ValidatePackageAsync succeeds.
//
// Usage: node deploy-package.js --envUrl <url> --stageRunId <guid> [--version <string>] [--devVersion <string>] [--notes <string>] [--tenant <id>]
// Output: { "status": "success", "stageRunId": "<guid>" }
//
// Flow: CreateStageRun → ValidatePackageAsync → (configure settings) → DeployPackageAsync
//       ^^^^^^^^^^^^     ^^^^^^^^^^^^^^^^^^^^                          ^^^^^^^^^^^^^^^^^^^
//       start-deployment  validate-deployment                          THIS SCRIPT

const { getAuthToken, makeRequest, UUID_REGEX, API_PATHS } = require('./lib/pipeline-helpers');

function parseArgs(argv) {
  const args = argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && i + 1 < args.length) parsed.envUrl = args[++i].replace(/\/+$/, '');
    else if (args[i] === '--stageRunId' && i + 1 < args.length) parsed.stageRunId = args[++i];
    else if (args[i] === '--version' && i + 1 < args.length) parsed.version = args[++i];
    else if (args[i] === '--devVersion' && i + 1 < args.length) parsed.devVersion = args[++i];
    else if (args[i] === '--notes' && i + 1 < args.length) parsed.notes = args[++i];
    else if (args[i] === '--tenant' && i + 1 < args.length) parsed.tenant = args[++i];
  }
  if (!parsed.envUrl || !parsed.stageRunId) {
    console.error(JSON.stringify({ error: 'Required: --envUrl, --stageRunId [--version <ver>] [--devVersion <ver>] [--notes <text>]' }));
    process.exit(1);
  }
  if (!UUID_REGEX.test(parsed.stageRunId)) {
    console.error(JSON.stringify({ error: 'stageRunId must be a valid GUID' }));
    process.exit(1);
  }
  return parsed;
}

async function main() {
  const { envUrl, stageRunId, version, devVersion, notes, tenant } = parseArgs(process.argv);
  const resourceUrl = new URL(envUrl).origin;
  const token = getAuthToken(resourceUrl, tenant);
  if (!token) {
    console.error(JSON.stringify({ error: 'Failed to obtain auth token. Run "az login" first.' }));
    process.exit(1);
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'OData-MaxVersion': '4.0',
    'OData-Version': '4.0'
  };

  // Step 1: Update version info and deployment notes on the stage run (if provided)
  if (version || devVersion || notes) {
    const patchBody = {};
    if (version) patchBody.artifactversion = version;
    if (devVersion) patchBody.artifactdevcurrentversion = devVersion;
    if (notes) patchBody.deploymentnotes = notes;

    const patchResult = await makeRequest({
      url: `${envUrl}/api/data/v9.0/${API_PATHS.STAGE_RUNS}(${stageRunId})`,
      method: 'PATCH',
      headers,
      body: JSON.stringify(patchBody)
    });

    if (patchResult.error || (patchResult.statusCode && (patchResult.statusCode < 200 || patchResult.statusCode >= 300))) {
      const errDetail = patchResult.error || `PATCH failed with status ${patchResult.statusCode}`;
      console.error(JSON.stringify({ error: `Failed to update version info: ${errDetail}` }));
      process.exit(1);
    }
  }

  // Step 2: Trigger the actual deployment via DeployPackageAsync
  const deployResult = await makeRequest({
    url: `${envUrl}/api/data/v9.1/DeployPackageAsync`,
    method: 'POST',
    headers,
    body: JSON.stringify({ StageRunId: stageRunId })
  });

  if (deployResult.error) {
    console.error(JSON.stringify({ error: deployResult.error }));
    process.exit(1);
  }

  if (deployResult.statusCode < 200 || deployResult.statusCode >= 300) {
    let errorData;
    try { errorData = JSON.parse(deployResult.body); } catch { errorData = deployResult.body; }
    console.error(JSON.stringify({ error: `DeployPackageAsync failed with status ${deployResult.statusCode}`, details: errorData }));
    process.exit(1);
  }

  console.log(JSON.stringify({
    status: 'success',
    stageRunId,
    message: 'Deployment initiated. Poll check-deployment-status.js for progress.'
  }));
  process.exit(0);
}

main();
