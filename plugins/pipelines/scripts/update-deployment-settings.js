#!/usr/bin/env node
// Update deployment settings (environment variables and connection references) on a stage run.
// Called between ValidatePackageAsync and DeployPackageAsync.
//
// Usage: node update-deployment-settings.js --envUrl <url> --stageRunId <guid> --settings <json> [--tenant <id>]
// Usage: node update-deployment-settings.js --envUrl <url> --stageRunId <guid> --settingsFile <path> [--tenant <id>]
//
// Settings JSON format:
// {
//   "EnvironmentVariables": [
//     {"SchemaName": "var_name", "Value": "target_value"}
//   ],
//   "ConnectionReferences": [
//     {"LogicalName": "conn_ref_name", "ConnectionId": "<guid>", "ConnectorId": "/providers/..."}
//   ]
// }

const { getAuthToken, makeRequest, UUID_REGEX, API_PATHS } = require('./lib/pipeline-helpers');
const fs = require('fs');

function parseArgs(argv) {
  const args = argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && i + 1 < args.length) parsed.envUrl = args[++i].replace(/\/+$/, '');
    else if (args[i] === '--stageRunId' && i + 1 < args.length) parsed.stageRunId = args[++i];
    else if (args[i] === '--settings' && i + 1 < args.length) parsed.settings = args[++i];
    else if (args[i] === '--settingsFile' && i + 1 < args.length) parsed.settingsFile = args[++i];
    else if (args[i] === '--tenant' && i + 1 < args.length) parsed.tenant = args[++i];
  }
  if (!parsed.envUrl || !parsed.stageRunId || (!parsed.settings && !parsed.settingsFile)) {
    console.error(JSON.stringify({ error: 'Required: --envUrl, --stageRunId, and --settings <json> or --settingsFile <path>' }));
    process.exit(1);
  }
  if (!UUID_REGEX.test(parsed.stageRunId)) {
    console.error(JSON.stringify({ error: 'stageRunId must be a valid GUID' }));
    process.exit(1);
  }
  return parsed;
}

async function main() {
  const { envUrl, stageRunId, settings, settingsFile, tenant } = parseArgs(process.argv);
  const resourceUrl = new URL(envUrl).origin;
  const token = getAuthToken(resourceUrl, tenant);
  if (!token) {
    console.error(JSON.stringify({ error: 'Failed to obtain auth token. Run "az login" first.' }));
    process.exit(1);
  }

  // Load settings from arg or file
  let settingsJson;
  if (settingsFile) {
    try {
      settingsJson = fs.readFileSync(settingsFile, 'utf8');
    } catch (e) {
      console.error(JSON.stringify({ error: `Failed to read settings file: ${e.message}` }));
      process.exit(1);
    }
  } else {
    settingsJson = settings;
  }

  // Validate it's valid JSON
  try {
    JSON.parse(settingsJson);
  } catch {
    console.error(JSON.stringify({ error: 'Settings must be valid JSON' }));
    process.exit(1);
  }

  // PATCH the stage run with deployment settings
  const result = await makeRequest({
    url: `${envUrl}/api/data/v9.0/${API_PATHS.STAGE_RUNS}(${stageRunId})`,
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0'
    },
    body: JSON.stringify({ deploymentsettingsjson: settingsJson })
  });

  if (result.error) {
    console.error(JSON.stringify({ error: result.error }));
    process.exit(1);
  }

  if (result.statusCode >= 300) {
    let errorData;
    try { errorData = JSON.parse(result.body); } catch { errorData = result.body; }
    console.error(JSON.stringify({ error: `Failed to update deployment settings: status ${result.statusCode}`, details: errorData }));
    process.exit(1);
  }

  console.log(JSON.stringify({
    status: 'success',
    stageRunId,
    message: 'Deployment settings updated'
  }));
  process.exit(0);
}

main();
