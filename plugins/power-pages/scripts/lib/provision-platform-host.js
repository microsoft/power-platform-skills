#!/usr/bin/env node

// Provisions a Power Platform Pipelines Platform Host (PE) via the BAP
// `getOrCreate` endpoint. The endpoint is idempotent: a tenant that already
// has a PE gets the existing one back (200 + provisioningState=Succeeded);
// a tenant without a PE gets one provisioned (202 + lifecycle op). Same call
// `make.powerapps.com → Pipelines` makes when a user clicks "Get started".
// Used by ensure-pipelines-host Phase 4.0.
//
//   POST {bapBase}/providers/Microsoft.BusinessAppPlatform/environments/getOrCreate?api-version=2021-04-01
//   Headers:
//     Authorization: Bearer {bapToken}
//     Content-Type: application/json
//     x-ms-correlation-id: {uuid v4}
//   Body:
//     {
//       "properties": {
//         "environmentSku": "Platform",
//         "linkedEnvironmentMetadata": { "templates": ["D365_1stPartyAdminApps"] }
//       }
//     }
//
// Response handling:
//   - 200 + provisioningState=Succeeded — tenant already had a PE; return it
//     with alreadyExisted=true. This is the idempotent path, not an error.
//   - 202 — Location header points to a lifecycle op; Retry-After is the poll
//     interval (seconds). Body usually includes the env record with
//     provisioningState: 'Creating'. Return alreadyExisted=false on success.
//   - 401 — BAP token invalid; refresh and retry.
//   - 403 — tenant policy or token-audience mismatch (PE provisioning does NOT
//     require admin role). Surface body verbatim and recommend re-auth.
//   - 4xx other — throw with body.
//
// Polling: identical to provision-custom-host.js. We GET the Location URL,
// read provisioningState, honor Retry-After, terminate on Succeeded/Failed/
// Canceled or after --timeoutSec.
//
// Usage: node provision-platform-host.js --bapToken <token>
//          [--correlationId <uuid>] [--timeoutSec 600]
//          [--apiVersion 2021-04-01] [--bapBase <url>]
//
// Output (JSON to stdout):
//   {
//     status: 'Succeeded',
//     alreadyExisted: true | false,    // 200 idempotent vs. 202 newly provisioned
//     envId: '<guid>',
//     instanceUrl: 'https://...',
//     instanceApiUrl: 'https://...',
//     displayName: '...',
//     environmentSku: 'Platform',
//     provisioningState: 'Succeeded',
//     durationSec: <number>,
//     correlationId: '<uuid>',
//     pollAttempts: <number>,
//     locationHeader: '<url>' | null
//   }
//
// Exit 0 on success, exit 1 on error (stderr includes status + body).

'use strict';

const crypto = require('crypto');
const helpers = require('./validation-helpers');

const DEFAULT_API_VERSION = '2021-04-01';
const DEFAULT_BAP_BASE = 'https://api.bap.microsoft.com';
const DEFAULT_TIMEOUT_SEC = 600;
const DEFAULT_RETRY_AFTER_SEC = 10;
const POST_TIMEOUT_MS = 60000;
const POLL_TIMEOUT_MS = 30000;

const TEMPLATE_NAME = 'D365_1stPartyAdminApps';
const ENVIRONMENT_SKU = 'Platform';

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    bapToken: null,
    correlationId: null,
    timeoutSec: DEFAULT_TIMEOUT_SEC,
    apiVersion: DEFAULT_API_VERSION,
    bapBase: DEFAULT_BAP_BASE,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = args[i + 1];
    if (a === '--bapToken' && next) opts.bapToken = args[++i];
    else if (a === '--correlationId' && next) opts.correlationId = args[++i];
    else if (a === '--timeoutSec' && next) opts.timeoutSec = Number(args[++i]) || DEFAULT_TIMEOUT_SEC;
    else if (a === '--apiVersion' && next) opts.apiVersion = args[++i];
    else if (a === '--bapBase' && next) opts.bapBase = args[++i];
  }

  return opts;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function provisionPlatformHost(opts = {}) {
  const {
    bapToken,
    correlationId,
    timeoutSec = DEFAULT_TIMEOUT_SEC,
    apiVersion = DEFAULT_API_VERSION,
    bapBase = DEFAULT_BAP_BASE,
    sleepImpl = null,
    nowImpl = null,
  } = opts;

  if (!bapToken) throw new Error('--bapToken is required');

  const sleep = sleepImpl || defaultSleep;
  const now = nowImpl || (() => Date.now());

  const cleanBase = bapBase.replace(/\/+$/, '');
  const cid = correlationId || crypto.randomUUID();
  const startedAt = now();

  const requestBody = JSON.stringify({
    properties: {
      environmentSku: ENVIRONMENT_SKU,
      linkedEnvironmentMetadata: { templates: [TEMPLATE_NAME] },
    },
  });

  // Endpoint is `/environments/getOrCreate`, NOT `/getOrCreate`. The latter
  // returns 404 from BAP. Confirmed against a live tenant where the existing
  // Platform Host (envId 8916a7c4-8c4c-e041-ad42-aa9980ff6810,
  // `PlatformEnv-unitedstates`) was only reachable via the `/environments/`
  // prefix. Same shape as the rest of the BAP environments RP.
  const postUrl = `${cleanBase}/providers/Microsoft.BusinessAppPlatform/environments/getOrCreate?api-version=${encodeURIComponent(apiVersion)}`;
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
    throw new Error(`BAP getOrCreate POST failed: ${postRes.error}`);
  }

  if (postRes.statusCode === 401) {
    throw new Error('BAP getOrCreate returned 401 — caller not authenticated; refresh BAP token and retry.');
  }
  if (postRes.statusCode === 403) {
    throw new Error(`BAP getOrCreate returned 403 — tenant policy may have disabled Platform Host provisioning, or the BAP token audience is mismatched. Try re-authenticating ('az logout && az login') and retry. Body: ${(postRes.body || '').slice(0, 500)}`);
  }
  if (postRes.statusCode !== 200 && postRes.statusCode !== 202) {
    throw new Error(`BAP getOrCreate returned unexpected status ${postRes.statusCode}: ${(postRes.body || '').slice(0, 500)}`);
  }

  let envBody = null;
  if (postRes.body) {
    try { envBody = JSON.parse(postRes.body); } catch { envBody = null; }
  }

  let envId = envBody?.name || null;
  let instanceUrl = envBody?.properties?.linkedEnvironmentMetadata?.instanceUrl || null;
  let instanceApiUrl = envBody?.properties?.linkedEnvironmentMetadata?.instanceApiUrl || null;
  let displayName = envBody?.properties?.displayName || null;
  let resolvedSku = envBody?.properties?.environmentSku || ENVIRONMENT_SKU;
  let provisioningState = extractProvisioningState(envBody) || 'Creating';
  const locationHeader = postRes.headers?.location || postRes.headers?.Location || null;
  let retryAfterSec = readRetryAfterSec(postRes.headers) || DEFAULT_RETRY_AFTER_SEC;

  // Idempotent existing-PE path: 200 + Succeeded means the tenant already had
  // a PE; getOrCreate is returning it. Distinguish with alreadyExisted=true so
  // the caller can write the right telemetry.
  if (postRes.statusCode === 200 && isTerminalSucceeded(provisioningState)) {
    return {
      status: 'Succeeded',
      alreadyExisted: true,
      envId,
      instanceUrl,
      instanceApiUrl,
      displayName,
      environmentSku: resolvedSku,
      provisioningState,
      durationSec: (now() - startedAt) / 1000,
      correlationId: cid,
      pollAttempts: 0,
      locationHeader,
    };
  }

  // 202 path — we just kicked off a new provision. Poll until terminal.
  if (!locationHeader && !envId) {
    throw new Error('BAP getOrCreate returned 202 but neither Location header nor env id is available; cannot poll for completion.');
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
      continue;
    }

    if (pollRes.statusCode === 401) {
      throw new Error('Polling returned 401 mid-provision — token expired. The PE may still finish; re-run detect after a few minutes.');
    }

    if (pollRes.statusCode >= 500) {
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
    if (pollData?.properties?.displayName) displayName = pollData.properties.displayName;
    if (pollData?.name && !envId) envId = pollData.name;

    const newRetryAfter = readRetryAfterSec(pollRes.headers);
    if (newRetryAfter) retryAfterSec = newRetryAfter;
  }

  if (isTerminalSucceeded(provisioningState)) {
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
          displayName = final?.properties?.displayName || displayName;
          resolvedSku = final?.properties?.environmentSku || resolvedSku;
        } catch {}
      }
    }
    return {
      status: 'Succeeded',
      alreadyExisted: false,
      envId,
      instanceUrl,
      instanceApiUrl,
      displayName,
      environmentSku: resolvedSku,
      provisioningState,
      durationSec: (now() - startedAt) / 1000,
      correlationId: cid,
      pollAttempts,
      locationHeader,
    };
  }

  if (isTerminalFailed(provisioningState)) {
    throw new Error(`Platform Host provisioning ended with state "${provisioningState}" after ${pollAttempts} poll(s). Inspect lifecycle op ${locationHeader || envGetUrl} for details.`);
  }

  throw new Error(`Platform Host provisioning timed out after ${timeoutSec}s (${pollAttempts} polls); last state: ${provisioningState}.`);
}

if (require.main === module) {
  const opts = parseArgs(process.argv);
  provisionPlatformHost(opts)
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
  provisionPlatformHost,
  extractProvisioningState,
  isTerminalSucceeded,
  isTerminalFailed,
  readRetryAfterSec,
  TEMPLATE_NAME,
  ENVIRONMENT_SKU,
};
