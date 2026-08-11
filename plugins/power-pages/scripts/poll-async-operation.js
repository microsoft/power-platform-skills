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

function normalizeEnvUrl(value) {
  return String(value || '').replace(/\/+$/, '').replace(/\/api\/data\/v[0-9.]+$/i, '');
}

function normalizeAsyncJobId(value) {
  const match = String(value || '').match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
  return match ? match[0].toLowerCase() : '';
}

// Dataverse asyncoperations statecode/statuscode reference:
//   statecode 0: Open (0=Ready, 20=InProgress, 30=Pausing, 40=Canceling)
//   statecode 1: Suspended (10=WaitingForResources)
//   statecode 2: Locked (10=InProgress, 20=Pausing, 21=Canceling)
//   statecode 3: Completed (30=Succeeded, 31=Failed, 32=Canceled)

const TERMINAL_STATECODES = new Set([3]);
const SUCCESS_STATUSCODES = new Set([30]);
const FAILURE_STATUSCODES = new Set([31]);
const CANCELED_STATUSCODES = new Set([32]);

function writeStatus(statusFile, status) {
  if (!statusFile) return;
  try {
    fs.writeFileSync(statusFile, JSON.stringify({ updatedAt: new Date().toISOString(), ...status }, null, 2), 'utf8');
  } catch {
    // The status page is best-effort; polling must never fail because the user
    // closed a temp folder or the status file could not be updated.
  }
}

async function pollAsyncOperation(rawArgs, deps = {}) {
  if (!rawArgs.asyncJobId) return { error: 'Missing required argument: --asyncJobId' };
  if (!rawArgs.envUrl) return { error: 'Missing required argument: --envUrl' };

  const envUrl = normalizeEnvUrl(rawArgs.envUrl);
  const asyncJobId = normalizeAsyncJobId(rawArgs.asyncJobId);
  if (!asyncJobId) return { error: `Invalid async operation id: ${rawArgs.asyncJobId}` };
  const intervalMs = parseInt(rawArgs.intervalMs || '5000', 10);
  const maxAttempts = parseInt(rawArgs.maxAttempts || '60', 10);
  const tokenResource = rawArgs.tokenResource || envUrl;
  const pollUrl = `${envUrl}/api/data/v9.2/asyncoperations(${asyncJobId})?$select=statecode,statuscode,message,friendlymessage,errorcode`;
  const getToken = deps.getAuthToken || getAuthToken;
  const request = deps.makeRequest || makeRequest;
  const wait = deps.sleep || sleep;

  // Token may be passed in directly (to avoid redundant az CLI calls) or refreshed each cycle.
  let token = rawArgs.token || null;
  const tokenRefreshEvery = Math.max(1, Math.floor(60000 / intervalMs)); // refresh every ~60s

  // Acquire initial token if not provided
  if (!token) {
    token = getToken(tokenResource);
    if (!token) {
      return { error: `Azure CLI token not available for ${tokenResource}. Run "az login" first.` };
    }
  }

  let lastHttpStatus = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Refresh token periodically
    if (attempt > 1 && attempt % tokenRefreshEvery === 0) {
      const refreshed = getToken(tokenResource);
      if (refreshed) token = refreshed;
    }

    let pollBody;
    try {
      const result = await request({
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
        writeStatus(rawArgs.statusFile, { state: 'running', message: 'Waiting for Dataverse import status', attempt });
        await wait(intervalMs);
        continue;
      }

      if (result.statusCode === 401) {
        // Auth expired mid-poll — refresh and retry immediately
        const refreshed = getToken(tokenResource);
        if (refreshed) token = refreshed;
        continue;
      }

      if (result.statusCode !== 200 || !result.body) {
        lastHttpStatus = result.statusCode;
        writeStatus(rawArgs.statusFile, {
          state: 'running',
          message: 'Waiting for Dataverse import status',
          detail: `Dataverse async operation lookup returned HTTP ${result.statusCode}`,
          attempt,
        });
        await wait(intervalMs);
        continue;
      }

      pollBody = JSON.parse(result.body);
    } catch {
      await wait(intervalMs);
      continue;
    }

    const statecode = pollBody.statecode;
    const statuscode = pollBody.statuscode;
    const message = pollBody.message || pollBody.Message || '';
    const friendlyMessage = pollBody.friendlymessage || pollBody.FriendlyMessage || '';

    if (!TERMINAL_STATECODES.has(statecode)) {
      // Still running — wait and poll again
      writeStatus(rawArgs.statusFile, { state: 'running', message: friendlyMessage || message || 'Import is still running', attempt });
      await wait(intervalMs);
      continue;
    }

    // Terminal state reached
    if (SUCCESS_STATUSCODES.has(statuscode)) {
      writeStatus(rawArgs.statusFile, { state: 'succeeded', message: 'Template import completed. Check the agent terminal for the next step.', attempt });
      return { status: 'Succeeded', asyncJobId, attempts: attempt };
    }

    if (CANCELED_STATUSCODES.has(statuscode)) {
      writeStatus(rawArgs.statusFile, { state: 'canceled', message: message || 'Template import was canceled. Check the agent terminal.', attempt });
      return { status: 'Canceled', asyncJobId, message, attempts: attempt };
    }

    // Failed (statuscode 31 or unknown terminal)
    writeStatus(rawArgs.statusFile, { state: 'failed', message: friendlyMessage || message || 'Template import failed. Check the agent terminal.', attempt });
    return {
      status: 'Failed',
      asyncJobId,
      message,
      friendlyMessage,
      statuscode,
      attempts: attempt,
    };
  }

  // Timed out
  writeStatus(rawArgs.statusFile, { state: 'timeout', message: 'Template import is still running. Check the agent terminal.', attempt: maxAttempts });
  return {
    status: 'Timeout',
    asyncJobId,
    lastHttpStatus,
    message: `Async operation still running after ${maxAttempts} attempts (~${Math.round(maxAttempts * intervalMs / 60000)} minutes). Check operation status manually.`,
  };
}

if (require.main === module) {
  pollAsyncOperation(args).then(output);
}

module.exports = { normalizeAsyncJobId, normalizeEnvUrl, parseArgs, pollAsyncOperation };
