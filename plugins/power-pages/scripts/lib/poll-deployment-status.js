#!/usr/bin/env node

// Polls stagerunstatus on a deploymentstageruns record until a terminal state.
//
// Usage: node poll-deployment-status.js --hostEnvUrl <url> --token <token> --stageRunId <id>
//                                        [--intervalMs <ms>] [--maxAttempts <n>]
//
// Terminal states:
//   200000002 = Succeeded
//   200000003 = Failed
//   200000004 = Canceled
//   200000005 = PendingApproval (post-validation approval gate — returns without error)
//   200000008 = AwaitingPreDeployApproval (pre-deploy approval gate — returns without error)
//
// Output (JSON to stdout):
//   { "stageRunId": "...", "status": "Succeeded|Awaiting", "errorDetails": "<string|null>" }
//
// Exit 0 on success or awaiting approval, exit 1 on failure (error on stderr).

'use strict';

const helpers = require('./validation-helpers');

const STATUS_SUCCEEDED = 200000002;
const STATUS_FAILED = 200000003;
const STATUS_CANCELED = 200000004;
const STATUS_PENDING_APPROVAL = 200000005;
const STATUS_AWAITING_PRE_DEPLOY = 200000008;

function parseArgs(argv) {
  const args = argv.slice(2);
  const result = {
    hostEnvUrl: null,
    token: null,
    stageRunId: null,
    intervalMs: 8000,
    maxAttempts: 75,
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

async function pollDeploymentStatus({ hostEnvUrl, token, stageRunId, intervalMs = 8000, maxAttempts = 75 }) {
  if (!hostEnvUrl || !token || !stageRunId) {
    throw new Error('Missing required arguments: --hostEnvUrl, --token, --stageRunId');
  }

  const baseUrl = hostEnvUrl.replace(/\/+$/, '');
  const url = `${baseUrl}/api/data/v9.0/deploymentstageruns(${stageRunId})?$select=stagerunstatus,errormessage`;

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
    const errorMessage = data.errormessage || null;

    if (stageRunStatus === STATUS_SUCCEEDED) {
      return { stageRunId, status: 'Succeeded', errorDetails: null };
    }

    if (stageRunStatus === STATUS_PENDING_APPROVAL || stageRunStatus === STATUS_AWAITING_PRE_DEPLOY) {
      // Approval gate — non-blocking, return for caller to handle
      return { stageRunId, status: 'Awaiting', errorDetails: null };
    }

    if (stageRunStatus === STATUS_FAILED || stageRunStatus === STATUS_CANCELED) {
      const label = stageRunStatus === STATUS_FAILED ? 'Failed' : 'Canceled';
      throw new Error(
        `Deployment ${label} (stageRunStatus=${stageRunStatus}). Error: ${errorMessage || '(none)'}`
      );
    }

    // Still in progress — wait and retry
    if (attempt < maxAttempts) {
      await sleep(intervalMs);
    }
  }

  throw new Error(
    `Deployment polling timed out after ${maxAttempts} attempts (${Math.round((maxAttempts * intervalMs) / 1000)}s). ` +
    'Check status in Power Platform.'
  );
}

// CLI entry point
if (require.main === module) {
  const args = parseArgs(process.argv);

  pollDeploymentStatus(args)
    .then((result) => {
      console.log(JSON.stringify(result));
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    });
}

module.exports = { pollDeploymentStatus };
