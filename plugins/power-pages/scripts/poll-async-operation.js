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

const fs = require('fs');
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
  const keys = ['--asyncJobId', '--envUrl', '--token', '--intervalMs', '--maxAttempts', '--tokenResource', '--statusFile'];
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

function normalizeEnvUrl(value) {
  return String(value || '').replace(/\/+$/, '').replace(/\/api\/data\/v[0-9.]+$/i, '');
}

function normalizeAsyncJobId(value) {
  const match = String(value || '').match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
  return match ? match[0].toLowerCase() : '';
}

const envUrl = normalizeEnvUrl(args.envUrl);
const asyncJobId = normalizeAsyncJobId(args.asyncJobId);
if (!asyncJobId) output({ error: `Invalid async operation id: ${args.asyncJobId}` });
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

const pollUrl = `${envUrl}/api/data/v9.2/asyncoperations(${asyncJobId})?$select=statecode,statuscode,message,friendlymessage,errorcode`;

function writeStatus(status) {
  if (!args.statusFile) return;
  try {
    fs.writeFileSync(args.statusFile, JSON.stringify({ updatedAt: new Date().toISOString(), ...status }, null, 2), 'utf8');
  } catch {
    // The status page is best-effort; polling must never fail because the user
    // closed a temp folder or the status file could not be updated.
  }
}

function progressFromAsyncOperation(pollBody) {
  const progress = Number(pollBody.progress);
  return Number.isFinite(progress) ? Math.max(0, Math.min(100, Math.floor(progress))) : null;
}

function estimatedProgress(attempt) {
  return Math.max(1, Math.min(95, Math.floor((attempt / maxAttempts) * 95)));
}

(async () => {
  // Acquire initial token if not provided
  if (!token) {
    token = getAuthToken(tokenResource);
    if (!token) {
      output({ error: `Azure CLI token not available for ${tokenResource}. Run "az login" first.` });
    }
  }

  let lastHttpStatus = null;
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
        writeStatus({ state: 'running', message: 'Waiting for Dataverse import status', progressPercent: estimatedProgress(attempt), attempt });
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
        lastHttpStatus = result.statusCode;
        writeStatus({
          state: 'running',
          message: 'Waiting for Dataverse import status',
          detail: `Dataverse async operation lookup returned HTTP ${result.statusCode}`,
          progressPercent: estimatedProgress(attempt),
          attempt,
        });
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
    const progressPercent = progressFromAsyncOperation(pollBody) ?? estimatedProgress(attempt);

    if (!TERMINAL_STATECODES.has(statecode)) {
      // Still running — wait and poll again
      writeStatus({ state: 'running', message: friendlyMessage || message || 'Import is still running', progressPercent, attempt });
      await sleep(intervalMs);
      continue;
    }

    // Terminal state reached
    if (SUCCESS_STATUSCODES.has(statuscode)) {
      writeStatus({ state: 'succeeded', message: 'Template import completed. Check the agent terminal for the next step.', progressPercent: 100, attempt });
      output({ status: 'Succeeded', asyncJobId, attempts: attempt });
    }

    if (CANCELED_STATUSCODES.has(statuscode)) {
      writeStatus({ state: 'canceled', message: message || 'Template import was canceled. Check the agent terminal.', progressPercent, attempt });
      output({ status: 'Canceled', asyncJobId, message, attempts: attempt });
    }

    // Failed (statuscode 31 or unknown terminal)
    writeStatus({ state: 'failed', message: friendlyMessage || message || 'Template import failed. Check the agent terminal.', progressPercent, attempt });
    output({
      status: 'Failed',
      asyncJobId,
      message,
      friendlyMessage,
      statuscode,
      attempts: attempt,
    });
  }

  // Timed out
  writeStatus({ state: 'timeout', message: 'Template import is still running. Check the agent terminal.', progressPercent: estimatedProgress(maxAttempts), attempt: maxAttempts });
  output({
    status: 'Timeout',
    asyncJobId,
    lastHttpStatus,
    message: `Async operation still running after ${maxAttempts} attempts (~${Math.round(maxAttempts * intervalMs / 60000)} minutes). Check operation status manually.`,
  });
})();
