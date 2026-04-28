#!/usr/bin/env node

// Provisions a new Power Platform Pipelines Custom Host via the BAP env-create
// API with the `D365_ProjectHost` organization template. The template
// pre-installs the Pipelines app, so the resulting env is immediately usable as
// a host. Used by ensure-pipelines-host Phase 4.A (the fast-path Custom Host
// provisioning step). Same template PPAC's `New custom host` button uses.
//
//   POST {bapBase}/providers/Microsoft.BusinessAppPlatform/environments?api-version=2021-04-01
//   Headers:
//     Authorization: Bearer {bapToken}
//     Content-Type: application/json
//     x-ms-correlation-id: {uuid v4}
//   Body:
//     {
//       "location": "{region}",
//       "properties": {
//         "displayName": "{displayName}",
//         "environmentSku": "Production",
//         "databaseType": "CommonDataService",
//         "linkedEnvironmentMetadata": { "templates": ["D365_ProjectHost"] }
//       }
//     }
//
// Response handling:
//   - 200 sync — env already provisioned (rare). Return success immediately.
//   - 202 async — Location header points to a lifecycle operation; Retry-After
//     is the poll interval (seconds). Body usually includes the env record with
//     provisioningState: 'Creating'.
//   - 401 — BAP token invalid; refresh and retry.
//   - 403 — caller is not Power Platform / Dynamics admin; throw.
//   - 4xx other — throw with body.
//
// Polling:
//   - GET the Location URL (or the env URL if Location absent).
//   - Read `properties.provisioningState` (preferred), fallback to `state` /
//     `status.code` / `status` (lifecycle ops vary by API version).
//   - Honor `Retry-After` per response; default 10s.
//   - Stop on Succeeded/Failed/Canceled or after --timeoutSec.
//
// Usage: node provision-custom-host.js
//          --bapToken <token> --displayName <"name">
//          --region <unitedstates|europe|asia|...>
//          [--correlationId <uuid>] [--timeoutSec 900]
//          [--apiVersion 2021-04-01] [--bapBase <url>]
//
// Output (JSON to stdout):
//   {
//     status: 'Succeeded',
//     envId: '<guid>',
//     instanceUrl: 'https://...',
//     instanceApiUrl: 'https://...',
//     displayName: '...',
//     environmentSku: 'Production',
//     provisioningState: 'Succeeded',
//     durationSec: <number>,
//     correlationId: '<uuid>',
//     pollAttempts: <number>,
//     locationHeader: '<url>'
//   }
//
// Exit 0 on success, exit 1 on error (stderr includes status + body).

'use strict';

const crypto = require('crypto');
const helpers = require('./validation-helpers');

const DEFAULT_API_VERSION = '2021-04-01';
const DEFAULT_BAP_BASE = 'https://api.bap.microsoft.com';
const DEFAULT_TIMEOUT_SEC = 900;
const DEFAULT_RETRY_AFTER_SEC = 10;
const POST_TIMEOUT_MS = 60000;
const POLL_TIMEOUT_MS = 30000;

const TEMPLATE_NAME = 'D365_ProjectHost';

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    bapToken: null,
    displayName: null,
    region: null,
    correlationId: null,
    timeoutSec: DEFAULT_TIMEOUT_SEC,
    apiVersion: DEFAULT_API_VERSION,
    bapBase: DEFAULT_BAP_BASE,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = args[i + 1];
    if (a === '--bapToken' && next) opts.bapToken = args[++i];
    else if (a === '--displayName' && next) opts.displayName = args[++i];
    else if (a === '--region' && next) opts.region = args[++i];
    else if (a === '--correlationId' && next) opts.correlationId = args[++i];
    else if (a === '--timeoutSec' && next) opts.timeoutSec = Number(args[++i]) || DEFAULT_TIMEOUT_SEC;
    else if (a === '--apiVersion' && next) opts.apiVersion = args[++i];
    else if (a === '--bapBase' && next) opts.bapBase = args[++i];
  }

  return opts;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Reads provisioning state from a polling response across multiple shapes.
// BAP env GET → properties.provisioningState
// Lifecycle op GET → state | status.code | status (string)
function extractProvisioningState(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.properties && typeof data.properties.provisioningState === 'string') {
    return data.properties.provisioningState;
  }
  if (typeof data.state === 'string') return data.state;
  if (data.status && typeof data.status === 'object' && typeof data.status.code === 'string') {
    return data.status.code;
  }
  if (typeof data.status === 'string') return data.status;
  return null;
}

function isTerminalSucceeded(state) {
  if (!state) return false;
  const s = String(state).toLowerCase();
  return s === 'succeeded' || s === 'succeeded.';
}

function isTerminalFailed(state) {
  if (!state) return false;
  const s = String(state).toLowerCase();
  return s === 'failed' || s === 'canceled' || s === 'cancelled';
}

function readRetryAfterSec(headers) {
  if (!headers) return null;
  const v = headers['retry-after'] || headers['Retry-After'];
  if (!v) return null;
  const n = Number(v);
  return isFinite(n) && n > 0 ? n : null;
}

async function provisionCustomHost(opts = {}) {
  const {
    bapToken,
    displayName,
    region,
    correlationId,
    timeoutSec = DEFAULT_TIMEOUT_SEC,
    apiVersion = DEFAULT_API_VERSION,
    bapBase = DEFAULT_BAP_BASE,
    // Test injection points:
    sleepImpl = null,
    nowImpl = null,
  } = opts;

  if (!bapToken) throw new Error('--bapToken is required');
  if (!displayName) throw new Error('--displayName is required');
  if (!region) throw new Error('--region is required');

  const sleep = sleepImpl || defaultSleep;
  const now = nowImpl || (() => Date.now());

  const cleanBase = bapBase.replace(/\/+$/, '');
  const cid = correlationId || crypto.randomUUID();
  const startedAt = now();

  const requestBody = JSON.stringify({
    location: region,
    properties: {
      displayName,
      environmentSku: 'Production',
      databaseType: 'CommonDataService',
      linkedEnvironmentMetadata: { templates: [TEMPLATE_NAME] },
    },
  });

  const postUrl = `${cleanBase}/providers/Microsoft.BusinessAppPlatform/environments?api-version=${encodeURIComponent(apiVersion)}`;
  const postHeaders = {
    Authorization: `Bearer ${bapToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'x-ms-correlation-id': cid,
  };

  const postRes = await helpers.makeRequest({
    url: postUrl,
    method: 'POST',
    headers: postHeaders,
    body: requestBody,
    timeout: POST_TIMEOUT_MS,
    includeHeaders: true,
  });

  if (postRes.error) {
    throw new Error(`BAP env-create POST failed: ${postRes.error}`);
  }

  if (postRes.statusCode === 401) {
    throw new Error('BAP env-create returned 401 — caller not authenticated; refresh BAP token and retry.');
  }
  if (postRes.statusCode === 403) {
    throw new Error('BAP env-create returned 403 — Custom Host fast-path requires Global / Power Platform / Dynamics admin. Suggest using the PPAC UI path or installing the Pipelines app on an existing env you administer.');
  }
  if (postRes.statusCode !== 200 && postRes.statusCode !== 202) {
    throw new Error(`BAP env-create returned unexpected status ${postRes.statusCode}: ${(postRes.body || '').slice(0, 500)}`);
  }

  let envBody = null;
  if (postRes.body) {
    try { envBody = JSON.parse(postRes.body); } catch { envBody = null; }
  }

  let envId = envBody?.name || null;
  let instanceUrl = envBody?.properties?.linkedEnvironmentMetadata?.instanceUrl || null;
  let instanceApiUrl = envBody?.properties?.linkedEnvironmentMetadata?.instanceApiUrl || null;
  let environmentSku = envBody?.properties?.environmentSku || 'Production';
  let provisioningState = extractProvisioningState(envBody) || 'Creating';
  const locationHeader = postRes.headers?.location || postRes.headers?.Location || null;
  let retryAfterSec = readRetryAfterSec(postRes.headers) || DEFAULT_RETRY_AFTER_SEC;

  // Already done synchronously
  if (postRes.statusCode === 200 && isTerminalSucceeded(provisioningState)) {
    return {
      status: 'Succeeded',
      envId,
      instanceUrl,
      instanceApiUrl,
      displayName,
      environmentSku,
      provisioningState,
      durationSec: (now() - startedAt) / 1000,
      correlationId: cid,
      pollAttempts: 0,
      locationHeader,
    };
  }

  // Polling — choose URL: prefer Location header, else build env GET URL.
  if (!locationHeader && !envId) {
    throw new Error('BAP env-create returned 202 but neither Location header nor env id is available; cannot poll for completion.');
  }

  const envGetUrl = envId
    ? `${cleanBase}/providers/Microsoft.BusinessAppPlatform/environments/${encodeURIComponent(envId)}?api-version=${encodeURIComponent(apiVersion)}&$expand=${encodeURIComponent('properties.linkedEnvironmentMetadata')}`
    : null;

  let pollAttempts = 0;
  const deadline = startedAt + timeoutSec * 1000;

  while (now() < deadline) {
    if (isTerminalSucceeded(provisioningState) || isTerminalFailed(provisioningState)) break;

    await sleep(retryAfterSec * 1000);

    pollAttempts++;
    const pollUrl = locationHeader || envGetUrl;
    const pollRes = await helpers.makeRequest({
      url: pollUrl,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${bapToken}`,
        Accept: 'application/json',
        'x-ms-correlation-id': cid,
      },
      timeout: POLL_TIMEOUT_MS,
      includeHeaders: true,
    });

    if (pollRes.error) {
      // transient — keep polling
      continue;
    }

    if (pollRes.statusCode === 401) {
      throw new Error('Polling returned 401 mid-provision — token expired. The env may still finish; re-run detect after a few minutes.');
    }

    if (pollRes.statusCode >= 500) {
      // transient server error — keep polling
      continue;
    }

    if (pollRes.statusCode !== 200 && pollRes.statusCode !== 202) {
      throw new Error(`Polling returned unexpected status ${pollRes.statusCode}: ${(pollRes.body || '').slice(0, 500)}`);
    }

    let pollData = null;
    try { pollData = JSON.parse(pollRes.body || '{}'); } catch { pollData = null; }

    const newState = extractProvisioningState(pollData);
    if (newState) provisioningState = newState;

    const linked = pollData?.properties?.linkedEnvironmentMetadata;
    if (linked?.instanceUrl) instanceUrl = linked.instanceUrl;
    if (linked?.instanceApiUrl) instanceApiUrl = linked.instanceApiUrl;
    if (pollData?.name && !envId) envId = pollData.name;

    const newRetryAfter = readRetryAfterSec(pollRes.headers);
    if (newRetryAfter) retryAfterSec = newRetryAfter;
  }

  // After loop — decide what state we're in
  if (isTerminalSucceeded(provisioningState)) {
    // If lifecycle op didn't include linkedEnvironmentMetadata, do a direct env GET to fetch URLs.
    if ((!instanceApiUrl || !instanceUrl) && envId && envGetUrl) {
      const envFinalRes = await helpers.makeRequest({
        url: envGetUrl,
        method: 'GET',
        headers: { Authorization: `Bearer ${bapToken}`, Accept: 'application/json', 'x-ms-correlation-id': cid },
        timeout: POLL_TIMEOUT_MS,
      });
      if (envFinalRes.statusCode === 200) {
        try {
          const final = JSON.parse(envFinalRes.body);
          instanceApiUrl = final?.properties?.linkedEnvironmentMetadata?.instanceApiUrl || instanceApiUrl;
          instanceUrl = final?.properties?.linkedEnvironmentMetadata?.instanceUrl || instanceUrl;
          environmentSku = final?.properties?.environmentSku || environmentSku;
        } catch {}
      }
    }
    return {
      status: 'Succeeded',
      envId,
      instanceUrl,
      instanceApiUrl,
      displayName,
      environmentSku,
      provisioningState,
      durationSec: (now() - startedAt) / 1000,
      correlationId: cid,
      pollAttempts,
      locationHeader,
    };
  }

  if (isTerminalFailed(provisioningState)) {
    throw new Error(`Provisioning ended with state "${provisioningState}" after ${pollAttempts} poll(s). Inspect lifecycle op ${locationHeader || envGetUrl} for details.`);
  }

  throw new Error(`Provisioning timed out after ${timeoutSec}s (${pollAttempts} polls); last state: ${provisioningState}.`);
}

if (require.main === module) {
  const opts = parseArgs(process.argv);
  provisionCustomHost(opts)
    .then((result) => {
      console.log(JSON.stringify(result));
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    });
}

module.exports = {
  provisionCustomHost,
  extractProvisioningState,
  isTerminalSucceeded,
  isTerminalFailed,
  readRetryAfterSec,
  TEMPLATE_NAME,
};
