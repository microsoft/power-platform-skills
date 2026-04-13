#!/usr/bin/env node

// Polls the operation field on a deploymentstageruns record until it leaves the "validating" state.
//
// Usage: node poll-validation-status.js --hostEnvUrl <url> --token <token> --stageRunId <id>
//                                        [--intervalMs <ms>] [--maxAttempts <n>]
//
// Output (JSON to stdout):
//   { "stageRunId": "...", "validationResults": "<string|null>", "stageRunStatus": <number> }
//
// Exit 0 on success, exit 1 on failure (error on stderr).

'use strict';

const helpers = require('./validation-helpers');

const STAGE_RUN_STATUS_VALIDATION_SUCCEEDED = 200000007;
const STAGE_RUN_STATUS_FAILED = 200000003;

function parseArgs(argv) {
  const args = argv.slice(2);
  const result = {
    hostEnvUrl: null,
    token: null,
    stageRunId: null,
    intervalMs: 5000,
    maxAttempts: 36,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--hostEnvUrl' && args[i + 1]) result.hostEnvUrl = args[++i];
    else if (args[i] === '--token' && args[i + 1]) result.token = args[++i];
    else if (args[i] === '--stageRunId' && args[i + 1]) result.stageRunId = args[++i];
    else if (args[i] === '--intervalMs' && args[i + 1]) result.intervalMs = parseInt(args[++i], 10);
    else if (args[i] === '--maxAttempts' && args[i + 1]) result.maxAttempts = parseInt(args[++i], 10);
  }

  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollValidationStatus({ hostEnvUrl, token, stageRunId, intervalMs = 5000, maxAttempts = 36 }) {
  if (!hostEnvUrl || !token || !stageRunId) {
    throw new Error('Missing required arguments: --hostEnvUrl, --token, --stageRunId');
  }

  const baseUrl = hostEnvUrl.replace(/\/+$/, '');
  const url = `${baseUrl}/api/data/v9.0/deploymentstageruns(${stageRunId})?$select=operation,validationresults,stagerunstatus`;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await helpers.makeRequest({
      url,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'OData-MaxVersion': '4.0',
        'OData-Version': '4.0',
      },
      timeout: 30000,
    });

    if (res.error) {
      throw new Error(`Request failed: ${res.error}`);
    }

    if (res.statusCode !== 200) {
      throw new Error(`Unexpected status ${res.statusCode}: ${res.body}`);
    }

    let data;
    try {
      data = JSON.parse(res.body);
    } catch {
      throw new Error(`Invalid JSON response: ${res.body}`);
    }

    const stageRunStatus = data.stagerunstatus;
    const validationResults = data.validationresults || null;

    // Validation succeeded — done
    if (stageRunStatus === STAGE_RUN_STATUS_VALIDATION_SUCCEEDED) {
      return { stageRunId, validationResults, stageRunStatus };
    }

    // Validation failed
    if (stageRunStatus === STAGE_RUN_STATUS_FAILED) {
      throw new Error(
        `Validation failed (stageRunStatus=${stageRunStatus}). Validation results: ${validationResults || '(none)'}`
      );
    }

    // Still validating — wait and retry
    if (attempt < maxAttempts) {
      await sleep(intervalMs);
      continue;
    }
  }

  throw new Error(
    `Validation polling timed out after ${maxAttempts} attempts. Check status in Power Platform.`
  );
}

// CLI entry point
if (require.main === module) {
  const args = parseArgs(process.argv);

  pollValidationStatus(args)
    .then((result) => {
      console.log(JSON.stringify(result));
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    });
}

module.exports = { pollValidationStatus };
