#!/usr/bin/env node

// Installs the Power Platform Pipelines application package on an existing
// Dataverse environment. Replaces the manual PPAC click-through that
// ensure-pipelines-host Phase 4.B used to render. Same shape as the existing
// provision-* helpers (env-scoped POST + Location poll), with a PAC CLI
// fallback when the BAP path fails (e.g. token-audience mismatch in tenants
// where Az → BAP is rejected — the same scenario `pac-bap-shim.js` handles
// for env enumeration).
//
// Resolution order:
//   1. BAP applicationPackages list — discover the Pipelines package by
//      uniqueName matching /msdyn_AppDeploymentAnchor|msdyn.*pipeline/i.
//      If found and `properties.state === 'Installed'` → already installed,
//      return alreadyInstalled=true (idempotent).
//   2. BAP applicationPackages install POST — submit the install. 200 sync,
//      202 + Location poll. Same polling pattern as provision-custom-host.js.
//   3. On 401/403/5xx (or transport error after retry), fall through to PAC:
//      `pac application install --environment-id {envId} --application-list
//      msdyn_AppDeploymentAnchor`. Same package, different client; PAC's
//      first-party client ID has different BAP-RP grants than Az CLI.
//   4. Final verification: GET {instanceApiUrl}/api/data/v9.0/solutions
//      ?$filter=uniquename eq 'msdyn_AppDeploymentAnchor'&$top=1 — confirms
//      the solution actually landed in Dataverse, not just that the BAP op
//      succeeded.
//
//   POST {bapBase}/providers/Microsoft.BusinessAppPlatform/scopes/admin/environments/{envId}/applicationPackages/{uniqueName}/install?api-version={apiVersion}
//   Headers:
//     Authorization: Bearer {bapToken}
//     Content-Type: application/json
//     x-ms-correlation-id: {uuid v4}
//
// Usage:
//   node install-pipelines-app.js
//     --bapToken <token> --envId <guid> --instanceApiUrl <url>
//     [--hostToken <token>]                     // for verification step (Dataverse)
//     [--allowPacFallback]                      // try PAC CLI on BAP failure (default: true)
//     [--correlationId <uuid>]
//     [--timeoutSec 600]
//     [--apiVersion 2022-03-01-preview]
//     [--bapBase <url>]
//
// Output (JSON to stdout):
//   {
//     status: 'Succeeded',
//     alreadyInstalled: true | false,           // 200 (idempotent) vs 202 (newly installed) vs PAC path
//     installPath: 'bap' | 'pac' | 'cached',    // which route succeeded
//     packageUniqueName: 'msdyn_AppDeploymentAnchor',
//     pipelinesSolutionVersion: '9.x.y.z' | null,
//     durationSec: <number>,
//     correlationId: '<uuid>',
//     pollAttempts: <number>,
//     locationHeader: '<url>' | null,
//     pacFallbackReason: '<string>' | null,     // populated when installPath === 'pac'
//   }
//
// Exit 0 on success, exit 1 on error (stderr includes status + body).

'use strict';

const crypto = require('crypto');
const { execSync } = require('child_process');
const helpers = require('./validation-helpers');

const DEFAULT_API_VERSION = '2022-03-01-preview';
const DEFAULT_BAP_BASE = 'https://api.bap.microsoft.com';
const DEFAULT_TIMEOUT_SEC = 600;
const DEFAULT_RETRY_AFTER_SEC = 10;
const POST_TIMEOUT_MS = 60000;
const POLL_TIMEOUT_MS = 30000;

// The Power Platform Pipelines application package's solution uniqueName.
// PPAC's "Install app" picker filters on this value; the BAP /applicationPackages
// list uses the same uniqueName. Listed in priority order — discovery uses the
// first match.
const PIPELINES_PACKAGE_UNIQUE_NAMES = ['msdyn_AppDeploymentAnchor'];
// Defensive secondary filter — if the catalog only exposes a package by
// displayName (some tenants), match these substrings (case-insensitive).
const PIPELINES_PACKAGE_DISPLAY_PATTERNS = [/power platform pipelines/i, /pipelines deployment/i];

const PIPELINES_SOLUTION_UNIQUE_NAME = 'msdyn_AppDeploymentAnchor';

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    bapToken: null,
    envId: null,
    instanceApiUrl: null,
    hostToken: null,
    allowPacFallback: true,
    correlationId: null,
    timeoutSec: DEFAULT_TIMEOUT_SEC,
    apiVersion: DEFAULT_API_VERSION,
    bapBase: DEFAULT_BAP_BASE,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = args[i + 1];
    if (a === '--bapToken' && next) opts.bapToken = args[++i];
    else if (a === '--envId' && next) opts.envId = args[++i];
    else if (a === '--instanceApiUrl' && next) opts.instanceApiUrl = args[++i];
    else if (a === '--hostToken' && next) opts.hostToken = args[++i];
    else if (a === '--no-pac-fallback') opts.allowPacFallback = false;
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
  return s === 'succeeded' || s === 'succeeded.' || s === 'installed';
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

// Discover the Pipelines application package on this env. Returns the
// canonical package object (name + state) or null if no Pipelines package
// is exposed for this env (rare — tenant policy can hide packages).
async function discoverPackage({ bapToken, envId, apiVersion, bapBase, correlationId }) {
  const cleanBase = bapBase.replace(/\/+$/, '');
  const url = `${cleanBase}/providers/Microsoft.BusinessAppPlatform/scopes/admin/environments/${encodeURIComponent(envId)}/applicationPackages?api-version=${encodeURIComponent(apiVersion)}`;

  const res = await helpers.makeRequest({
    url,
    method: 'GET',
    headers: {
      Authorization: `Bearer ${bapToken}`,
      Accept: 'application/json',
      'x-ms-correlation-id': correlationId,
    },
    timeout: POST_TIMEOUT_MS,
    includeHeaders: true,
  });

  if (res.error) throw new Error(`BAP applicationPackages list failed: ${res.error}`);
  if (res.statusCode === 401) throw new Error('BAP applicationPackages list returned 401 — refresh BAP token.');
  if (res.statusCode === 403) {
    const e = new Error(`BAP applicationPackages list returned 403 — caller lacks Power Platform admin or tenant policy denies discovery. Body: ${(res.body || '').slice(0, 300)}`);
    e.statusCode = 403;
    throw e;
  }
  if (res.statusCode !== 200) {
    throw new Error(`BAP applicationPackages list returned unexpected status ${res.statusCode}: ${(res.body || '').slice(0, 500)}`);
  }

  let data = null;
  try { data = JSON.parse(res.body); } catch { data = null; }
  const items = Array.isArray(data?.value) ? data.value : [];

  // Try uniqueName match first (deterministic).
  for (const target of PIPELINES_PACKAGE_UNIQUE_NAMES) {
    const hit = items.find((p) => (p?.properties?.uniqueName || p?.name) === target);
    if (hit) return normalizePackage(hit);
  }
  // Fall back to displayName / localizedDescription substring match.
  for (const pat of PIPELINES_PACKAGE_DISPLAY_PATTERNS) {
    const hit = items.find((p) => {
      const dn = p?.properties?.localizedDescription || p?.properties?.applicationName || p?.properties?.displayName || '';
      return pat.test(dn);
    });
    if (hit) return normalizePackage(hit);
  }
  return null;
}

function normalizePackage(pkg) {
  const props = pkg?.properties || {};
  return {
    uniqueName: props.uniqueName || pkg?.name || null,
    displayName: props.localizedDescription || props.applicationName || props.displayName || null,
    state: props.state || null,
    raw: pkg,
  };
}

// PAC fallback path: shells out to `pac application install`. Used when the
// BAP install POST returns 401/403/5xx.
function tryPacFallback({ envId, packageUniqueName }) {
  // Best-effort. PAC's argument names have varied across versions, so we try
  // the modern form first and fall through to legacy on stderr signals.
  const candidates = [
    ['application', 'install', '--environment-id', envId, '--application-list', packageUniqueName],
    ['application', 'install', '--environment', envId, '--application-list', packageUniqueName],
    ['admin', 'application', 'install', '--environment-id', envId, '--application-name-list', packageUniqueName],
  ];
  let lastErr = null;
  for (const argv of candidates) {
    const cmd = ['pac', ...argv].map((a) => (/[\s"']/.test(a) ? `"${a}"` : a)).join(' ');
    try {
      const out = execSync(cmd, { encoding: 'utf8', timeout: 600000, stdio: ['ignore', 'pipe', 'pipe'] });
      return { ok: true, command: cmd, stdout: out };
    } catch (err) {
      lastErr = err;
      // Try next candidate if PAC reports an unrecognized arg / subcommand.
      const stderr = (err.stderr || err.message || '').toLowerCase();
      if (!/unrecognized|unknown|invalid argument/i.test(stderr)) break;
    }
  }
  return { ok: false, error: (lastErr && (lastErr.stderr || lastErr.message)) || 'pac fallback failed' };
}

// Verify the Pipelines solution actually landed in Dataverse after install.
// BAP can report success while the solution is still propagating. This is the
// single round-trip that confirms the install is real.
async function verifySolutionInstalled({ instanceApiUrl, hostToken }) {
  if (!instanceApiUrl || !hostToken) {
    return { ok: false, reason: 'instanceApiUrl or hostToken not provided — caller should verify separately' };
  }
  const url = `${instanceApiUrl.replace(/\/+$/, '')}/api/data/v9.0/solutions?$filter=uniquename eq '${PIPELINES_SOLUTION_UNIQUE_NAME}'&$select=uniquename,version&$top=1`;
  const res = await helpers.makeRequest({
    url,
    method: 'GET',
    headers: {
      Authorization: `Bearer ${hostToken}`,
      Accept: 'application/json',
      'OData-Version': '4.0',
      'OData-MaxVersion': '4.0',
    },
    timeout: POLL_TIMEOUT_MS,
  });
  if (res.error) return { ok: false, reason: `solutions probe failed: ${res.error}` };
  if (res.statusCode !== 200) return { ok: false, reason: `solutions probe returned ${res.statusCode}` };
  let data = null;
  try { data = JSON.parse(res.body); } catch { data = null; }
  const row = Array.isArray(data?.value) && data.value.length > 0 ? data.value[0] : null;
  if (!row) return { ok: false, reason: 'solution not found post-install — propagation may still be in progress' };
  return { ok: true, version: row.version || null };
}

async function installPipelinesApp(opts = {}) {
  const {
    bapToken,
    envId,
    instanceApiUrl,
    hostToken = null,
    allowPacFallback = true,
    correlationId,
    timeoutSec = DEFAULT_TIMEOUT_SEC,
    apiVersion = DEFAULT_API_VERSION,
    bapBase = DEFAULT_BAP_BASE,
    sleepImpl = null,
    nowImpl = null,
    pacFallbackImpl = null,
  } = opts;

  if (!bapToken) throw new Error('--bapToken is required');
  if (!envId) throw new Error('--envId is required');

  const sleep = sleepImpl || defaultSleep;
  const now = nowImpl || (() => Date.now());
  const pacFallback = pacFallbackImpl || tryPacFallback;

  const cleanBase = bapBase.replace(/\/+$/, '');
  const cid = correlationId || crypto.randomUUID();
  const startedAt = now();

  // Discovery — also catches the idempotent "already installed" path.
  let pkg;
  try {
    pkg = await discoverPackage({ bapToken, envId, apiVersion, bapBase, correlationId: cid });
  } catch (err) {
    // 403 on the LIST endpoint usually means the BAP audience isn't the right
    // one for this tenant. Skip straight to PAC fallback when permitted.
    if (err.statusCode === 403 && allowPacFallback) {
      pkg = null;
    } else {
      throw err;
    }
  }

  if (pkg && isTerminalSucceeded(pkg.state)) {
    // Already installed — idempotent path.
    let verifyResult = null;
    if (instanceApiUrl && hostToken) {
      verifyResult = await verifySolutionInstalled({ instanceApiUrl, hostToken });
    }
    return {
      status: 'Succeeded',
      alreadyInstalled: true,
      installPath: 'cached',
      packageUniqueName: pkg.uniqueName || PIPELINES_PACKAGE_UNIQUE_NAMES[0],
      pipelinesSolutionVersion: verifyResult?.version || null,
      durationSec: (now() - startedAt) / 1000,
      correlationId: cid,
      pollAttempts: 0,
      locationHeader: null,
      pacFallbackReason: null,
    };
  }

  // BAP install POST
  const packageUniqueName = pkg?.uniqueName || PIPELINES_PACKAGE_UNIQUE_NAMES[0];
  const postUrl = `${cleanBase}/providers/Microsoft.BusinessAppPlatform/scopes/admin/environments/${encodeURIComponent(envId)}/applicationPackages/${encodeURIComponent(packageUniqueName)}/install?api-version=${encodeURIComponent(apiVersion)}`;
  const postRes = await helpers.makeRequest({
    url: postUrl,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bapToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-ms-correlation-id': cid,
    },
    body: '{}',
    timeout: POST_TIMEOUT_MS,
    includeHeaders: true,
  });

  // PAC fallback on transport error / 401 / 403 / 5xx
  if (
    postRes.error
    || postRes.statusCode === 401
    || postRes.statusCode === 403
    || (postRes.statusCode >= 500 && postRes.statusCode < 600)
  ) {
    if (!allowPacFallback) {
      throw new Error(`BAP applicationPackages install failed (status ${postRes.statusCode || 'transport-error'}): ${(postRes.body || postRes.error || '').toString().slice(0, 500)}`);
    }
    const pacRes = pacFallback({ envId, packageUniqueName });
    if (!pacRes.ok) {
      throw new Error(`BAP install failed and PAC fallback failed: BAP=${postRes.statusCode || postRes.error}; PAC=${pacRes.error}`);
    }
    let verifyResult = null;
    if (instanceApiUrl && hostToken) {
      // PAC returns once the install is committed; still verify in Dataverse.
      verifyResult = await verifySolutionInstalled({ instanceApiUrl, hostToken });
    }
    return {
      status: 'Succeeded',
      alreadyInstalled: false,
      installPath: 'pac',
      packageUniqueName,
      pipelinesSolutionVersion: verifyResult?.version || null,
      durationSec: (now() - startedAt) / 1000,
      correlationId: cid,
      pollAttempts: 0,
      locationHeader: null,
      pacFallbackReason: `BAP returned ${postRes.statusCode || postRes.error}`,
    };
  }

  if (postRes.statusCode === 409) {
    // Idempotent — install already in progress or already installed.
    let verifyResult = null;
    if (instanceApiUrl && hostToken) {
      verifyResult = await verifySolutionInstalled({ instanceApiUrl, hostToken });
    }
    return {
      status: 'Succeeded',
      alreadyInstalled: true,
      installPath: 'cached',
      packageUniqueName,
      pipelinesSolutionVersion: verifyResult?.version || null,
      durationSec: (now() - startedAt) / 1000,
      correlationId: cid,
      pollAttempts: 0,
      locationHeader: null,
      pacFallbackReason: null,
    };
  }

  if (postRes.statusCode !== 200 && postRes.statusCode !== 202) {
    throw new Error(`BAP applicationPackages install returned unexpected status ${postRes.statusCode}: ${(postRes.body || '').slice(0, 500)}`);
  }

  let respBody = null;
  if (postRes.body) {
    try { respBody = JSON.parse(postRes.body); } catch { respBody = null; }
  }
  let provisioningState = extractProvisioningState(respBody) || 'Installing';
  const locationHeader = postRes.headers?.location || postRes.headers?.Location || null;
  let retryAfterSec = readRetryAfterSec(postRes.headers) || DEFAULT_RETRY_AFTER_SEC;

  if (postRes.statusCode === 200 && isTerminalSucceeded(provisioningState)) {
    let verifyResult = null;
    if (instanceApiUrl && hostToken) {
      verifyResult = await verifySolutionInstalled({ instanceApiUrl, hostToken });
    }
    return {
      status: 'Succeeded',
      alreadyInstalled: false,
      installPath: 'bap',
      packageUniqueName,
      pipelinesSolutionVersion: verifyResult?.version || null,
      durationSec: (now() - startedAt) / 1000,
      correlationId: cid,
      pollAttempts: 0,
      locationHeader,
      pacFallbackReason: null,
    };
  }

  if (!locationHeader) {
    throw new Error('BAP applicationPackages install returned 202 but no Location header — cannot poll for completion.');
  }

  let pollAttempts = 0;
  const deadline = startedAt + timeoutSec * 1000;

  while (now() < deadline) {
    if (isTerminalSucceeded(provisioningState) || isTerminalFailed(provisioningState)) break;
    await sleep(retryAfterSec * 1000);
    pollAttempts++;
    const pollRes = await helpers.makeRequest({
      url: locationHeader,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${bapToken}`,
        Accept: 'application/json',
        'x-ms-correlation-id': cid,
      },
      timeout: POLL_TIMEOUT_MS,
      includeHeaders: true,
    });

    if (pollRes.error) continue;
    if (pollRes.statusCode === 401) {
      throw new Error('Polling returned 401 mid-install — token expired. Re-run after re-authenticating; the install may still be in progress.');
    }
    if (pollRes.statusCode >= 500) continue;
    if (pollRes.statusCode !== 200 && pollRes.statusCode !== 202) {
      throw new Error(`Polling returned unexpected status ${pollRes.statusCode}: ${(pollRes.body || '').slice(0, 500)}`);
    }

    let pollData = null;
    try { pollData = JSON.parse(pollRes.body || '{}'); } catch { pollData = null; }
    const newState = extractProvisioningState(pollData);
    if (newState) provisioningState = newState;
    const newRetryAfter = readRetryAfterSec(pollRes.headers);
    if (newRetryAfter) retryAfterSec = newRetryAfter;
  }

  if (isTerminalSucceeded(provisioningState)) {
    let verifyResult = null;
    if (instanceApiUrl && hostToken) {
      verifyResult = await verifySolutionInstalled({ instanceApiUrl, hostToken });
    }
    return {
      status: 'Succeeded',
      alreadyInstalled: false,
      installPath: 'bap',
      packageUniqueName,
      pipelinesSolutionVersion: verifyResult?.version || null,
      durationSec: (now() - startedAt) / 1000,
      correlationId: cid,
      pollAttempts,
      locationHeader,
      pacFallbackReason: null,
    };
  }

  if (isTerminalFailed(provisioningState)) {
    throw new Error(`Pipelines app install ended with state "${provisioningState}" after ${pollAttempts} poll(s). Inspect lifecycle op ${locationHeader} for details.`);
  }

  throw new Error(`Pipelines app install timed out after ${timeoutSec}s (${pollAttempts} polls); last state: ${provisioningState}.`);
}

if (require.main === module) {
  const opts = parseArgs(process.argv);
  installPipelinesApp(opts)
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
  installPipelinesApp,
  discoverPackage,
  verifySolutionInstalled,
  extractProvisioningState,
  isTerminalSucceeded,
  isTerminalFailed,
  readRetryAfterSec,
  PIPELINES_PACKAGE_UNIQUE_NAMES,
  PIPELINES_PACKAGE_DISPLAY_PATTERNS,
  PIPELINES_SOLUTION_UNIQUE_NAME,
};
