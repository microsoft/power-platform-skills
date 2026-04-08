#!/usr/bin/env node

// Triggers async Dataverse solution export and polls until complete.
//
// Usage:
//   node export-solution-async.js --envUrl <url> --solutionName <name> --managed <true|false> [--token <token>]
//
// Options:
//   --envUrl <url>          Dataverse environment URL
//   --solutionName <name>   Unique name of the solution to export
//   --managed <true|false>  Export as managed (true) or unmanaged (false)
//   --token <token>         Azure CLI Bearer token (optional; acquired via helpers.getAuthToken if omitted)
//
// Output (JSON to stdout):
//   { "asyncOperationId": "...", "solutionName": "...", "managed": true/false }
//
// Exit 0 on success, exit 1 on failure (error on stderr).

'use strict';

const helpers = require('./validation-helpers');

const POLL_INTERVAL_MS = 5000;
const MAX_ATTEMPTS = 60;

// statecode 3 = Succeeded, statecode 4 = Failed/Canceled
const TERMINAL_SUCCEEDED = 3;
const TERMINAL_FAILED = 4;

function parseArgs(argv) {
  const args = argv.slice(2);
  let envUrl = null;
  let solutionName = null;
  let managed = null;
  let token = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) envUrl = args[++i];
    else if (args[i] === '--solutionName' && args[i + 1]) solutionName = args[++i];
    else if (args[i] === '--managed' && args[i + 1]) managed = args[++i];
    else if (args[i] === '--token' && args[i + 1]) token = args[++i];
  }

  return { envUrl, solutionName, managed, token };
}

async function exportSolutionAsync({ envUrl, solutionName, managed, token } = {}) {
  if (!envUrl) throw new Error('--envUrl is required');
  if (!solutionName) throw new Error('--solutionName is required');
  if (managed === null || managed === undefined) throw new Error('--managed is required');

  const cleanEnvUrl = envUrl.replace(/\/+$/, '');
  const managedBool = String(managed).toLowerCase() === 'true';

  // Acquire token if not provided
  const authToken = token || helpers.getAuthToken(cleanEnvUrl);
  if (!authToken) {
    throw new Error(
      'Azure CLI token acquisition failed. Run `az login` and retry, or pass --token explicitly.'
    );
  }

  const authHeaders = {
    Authorization: `Bearer ${authToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'OData-MaxVersion': '4.0',
    'OData-Version': '4.0',
  };

  // Step 1: POST ExportSolutionAsync
  const exportBody = JSON.stringify({
    SolutionName: solutionName,
    Managed: managedBool,
  });

  const exportRes = await helpers.makeRequest({
    url: `${cleanEnvUrl}/api/data/v9.2/ExportSolutionAsync`,
    method: 'POST',
    headers: authHeaders,
    body: exportBody,
    timeout: 30000,
  });

  if (exportRes.error) {
    throw new Error(`ExportSolutionAsync request failed: ${exportRes.error}`);
  }
  if (exportRes.statusCode < 200 || exportRes.statusCode >= 300) {
    throw new Error(
      `ExportSolutionAsync returned HTTP ${exportRes.statusCode}: ${exportRes.body}`
    );
  }

  let exportData;
  try {
    exportData = JSON.parse(exportRes.body);
  } catch {
    throw new Error(`ExportSolutionAsync returned non-JSON body: ${exportRes.body}`);
  }

  const asyncOperationId = exportData.AsyncOperationId;
  if (!asyncOperationId) {
    throw new Error(
      `ExportSolutionAsync response did not contain AsyncOperationId. Body: ${exportRes.body}`
    );
  }

  // Step 2: Poll asyncoperations until terminal state
  const pollUrl =
    `${cleanEnvUrl}/api/data/v9.2/asyncoperations(${asyncOperationId})` +
    `?$select=statecode,statuscode,message`;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Refresh token on long-running polls (every ~20 attempts = ~100s)
    const currentToken = attempt % 20 === 0
      ? (helpers.getAuthToken(cleanEnvUrl) || authToken)
      : authToken;

    const pollRes = await helpers.makeRequest({
      url: pollUrl,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${currentToken}`,
        Accept: 'application/json',
        'OData-MaxVersion': '4.0',
        'OData-Version': '4.0',
      },
      timeout: 15000,
    });

    if (pollRes.error) {
      throw new Error(`Polling asyncoperations failed: ${pollRes.error}`);
    }
    if (pollRes.statusCode !== 200) {
      throw new Error(
        `Polling asyncoperations returned HTTP ${pollRes.statusCode}: ${pollRes.body}`
      );
    }

    let pollData;
    try {
      pollData = JSON.parse(pollRes.body);
    } catch {
      throw new Error(`Polling response was non-JSON: ${pollRes.body}`);
    }

    const { statecode, message } = pollData;

    if (statecode === TERMINAL_SUCCEEDED) {
      return { asyncOperationId, solutionName, managed: managedBool };
    }

    if (statecode === TERMINAL_FAILED) {
      throw new Error(
        `Export job failed (asyncOperationId: ${asyncOperationId}): ${message || '(no message)'}`
      );
    }

    // Not yet terminal — wait and retry
    if (attempt < MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  throw new Error(
    `Export job timed out after ${MAX_ATTEMPTS} poll attempts (asyncOperationId: ${asyncOperationId}). ` +
    'The export may still be running — check the Power Platform admin center.'
  );
}

// CLI entry point
if (require.main === module) {
  const { envUrl, solutionName, managed, token } = parseArgs(process.argv);

  exportSolutionAsync({ envUrl, solutionName, managed, token })
    .then((result) => {
      console.log(JSON.stringify(result));
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    });
}

module.exports = { exportSolutionAsync };
