#!/usr/bin/env node

// Polls a Dataverse asyncoperations record until it reaches a terminal state.
// Reusable across export-solution and import-solution skills.
//
// Usage:
//   node poll-async-operation.js --asyncJobId "<guid>" --envUrl "https://contoso.crm.dynamics.com" --token "<bearer-token>"
//
// Optional:
//   --intervalMs <ms>      Poll interval in milliseconds (default: 5000)
//   --maxAttempts <n>      Maximum poll attempts (default: 60 = ~5 minutes at 5s)
//   --tokenResource <url>  Resource URL for token refresh (default: envUrl)
//
// Output (JSON to stdout):
//   { "status": "Succeeded", "asyncJobId": "...", "attempts": 12 }
//   { "status": "Failed", "asyncJobId": "...", "message": "...", "friendlyMessage": "..." }
//   { "status": "Canceled", "asyncJobId": "...", "message": "..." }
//   { "status": "Timeout", "asyncJobId": "...", "message": "Still running after N attempts" }
//   { "error": "..." }   — when arguments are missing or network errors prevent polling

const { getAuthToken, makeRequest } = require('./lib/validation-helpers');

function output(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const args = {};
  const keys = ['--asyncJobId', '--envUrl', '--token', '--intervalMs', '--maxAttempts', '--tokenResource'];
  for (const key of keys) {
    const idx = argv.indexOf(key);
    if (idx !== -1 && idx + 1 < argv.length) {
      args[key.replace('--', '')] = argv[idx + 1];
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (!args.asyncJobId) output({ error: 'Missing required argument: --asyncJobId' });
if (!args.envUrl) output({ error: 'Missing required argument: --envUrl' });

const envUrl = args.envUrl.replace(/\/+$/, '');
const intervalMs = parseInt(args.intervalMs || '5000', 10);
const maxAttempts = parseInt(args.maxAttempts || '60', 10);
const tokenResource = args.tokenResource || envUrl;

// Token may be passed in directly (to avoid redundant az CLI calls) or refreshed each cycle
let token = args.token || null;
const tokenRefreshEvery = Math.max(1, Math.floor(60000 / intervalMs)); // refresh every ~60s

// Dataverse asyncoperations statecode/statuscode reference:
//   statecode 0: Open (0=Ready, 20=InProgress, 30=Pausing, 40=Canceling)
//   statecode 1: Suspended (10=WaitingForResources)
//   statecode 2: Locked (10=InProgress, 20=Pausing, 21=Canceling)
//   statecode 3: Completed (30=Succeeded, 31=Failed, 32=Canceled)

const TERMINAL_STATECODES = new Set([3]);
const SUCCESS_STATUSCODES = new Set([30]);
const FAILURE_STATUSCODES = new Set([31]);
const CANCELED_STATUSCODES = new Set([32]);

const pollUrl = `${envUrl}/api/data/v9.2/asyncoperations(${args.asyncJobId})?$select=statecode,statuscode,message,friendlymessage,errorcode`;

(async () => {
  // Acquire initial token if not provided
  if (!token) {
    token = getAuthToken(tokenResource);
    if (!token) {
      output({ error: `Azure CLI token not available for ${tokenResource}. Run "az login" first.` });
    }
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Refresh token periodically
    if (attempt > 1 && attempt % tokenRefreshEvery === 0) {
      const refreshed = getAuthToken(tokenResource);
      if (refreshed) token = refreshed;
    }

    let pollBody;
    try {
      const result = await makeRequest({
        url: pollUrl,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'OData-Version': '4.0',
        },
        timeout: 15000,
      });

      if (result.error) {
        // Network error — wait and retry (don't fail on transient issues)
        await sleep(intervalMs);
        continue;
      }

      if (result.statusCode === 401) {
        // Auth expired mid-poll — refresh and retry immediately
        const refreshed = getAuthToken(tokenResource);
        if (refreshed) token = refreshed;
        continue;
      }

      if (result.statusCode !== 200 || !result.body) {
        await sleep(intervalMs);
        continue;
      }

      pollBody = JSON.parse(result.body);
    } catch {
      await sleep(intervalMs);
      continue;
    }

    const statecode = pollBody.statecode;
    const statuscode = pollBody.statuscode;
    const message = pollBody.message || pollBody.Message || '';
    const friendlyMessage = pollBody.friendlymessage || pollBody.FriendlyMessage || '';

    if (!TERMINAL_STATECODES.has(statecode)) {
      // Still running — wait and poll again
      await sleep(intervalMs);
      continue;
    }

    // Terminal state reached
    if (SUCCESS_STATUSCODES.has(statuscode)) {
      output({ status: 'Succeeded', asyncJobId: args.asyncJobId, attempts: attempt });
    }

    if (CANCELED_STATUSCODES.has(statuscode)) {
      output({ status: 'Canceled', asyncJobId: args.asyncJobId, message, attempts: attempt });
    }

    // Failed (statuscode 31 or unknown terminal)
    output({
      status: 'Failed',
      asyncJobId: args.asyncJobId,
      message,
      friendlyMessage,
      statuscode,
      attempts: attempt,
    });
  }

  // Timed out
  output({
    status: 'Timeout',
    asyncJobId: args.asyncJobId,
    message: `Async operation still running after ${maxAttempts} attempts (~${Math.round(maxAttempts * intervalMs / 60000)} minutes). Check operation status manually.`,
  });
})();
