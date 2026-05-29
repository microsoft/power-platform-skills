#!/usr/bin/env node

// Force-links an existing deploymentenvironments record (in a Pipelines host
// env) to take over the source environment's host association. This is the
// API behind the "Force Link" button in the Deployment Pipeline Configuration
// app and is the documented remediation when creating an environment record
// fails with "this environment is already associated with another pipelines
// host".
//
// Endpoint:  POST {hostEnvUrl}/api/data/v9.0/ManageEnvironmentStamp
// Body:      { "DeploymentEnvironmentId": "{UPPER-CASE-GUID-IN-BRACES}" }
// Success:   204 No Content
//
// Required headers (HAR-verified against AppDeploymentConfiguration UI on the
// supplierportalpipelineshostch.crm17 host, 2026-05-11):
//   Authorization: Bearer <hostToken>
//   Content-Type: application/json
//   Accept: application/json
//   clienthost: Browser
//   prefer: odata.include-annotations="*"
//   x-ms-app-name: AppDeploymentConfiguration
//
// Side effects (per Microsoft Learn `custom-host-pipelines#using-force-link…`):
//   - The previous host's deploymentenvironments row for this BAP env is
//     delinked (its validationstatus is left stale until refreshed).
//   - Makers lose access to any pipelines in the previous host that ran
//     against this environment.
//   - Reversible by performing Force Link again from the previous host.
//
// After the action returns 204, this script re-polls validationstatus on the
// new host's record until it reaches a terminal state. Force Link is success-
// ful when validationstatus flips to Succeeded (200000001).
//
// Usage:
//   node force-link-environment.js \
//     --hostEnvUrl <url> \
//     --token <hostToken> \
//     --deploymentEnvironmentId <guid> \
//     [--intervalMs 3000] [--maxAttempts 20]
//
// Output (JSON to stdout):
//   { "deploymentEnvironmentId": "...",
//     "hostEnvUrl": "...",
//     "validationStatus": 200000001,
//     "forcedAt": "<ISO timestamp>" }
//
// Exit 0 on success, exit 1 on error (stderr).

'use strict';

const helpers = require('./validation-helpers');

const VALIDATION_STATUS_PENDING = 200000000;
const VALIDATION_STATUS_SUCCEEDED = 200000001;
const VALIDATION_STATUS_FAILED = 200000002;

const DEFAULT_POLL_INTERVAL_MS = 3000;
const DEFAULT_MAX_POLL_ATTEMPTS = 20;

const GUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    hostEnvUrl: null,
    token: null,
    deploymentEnvironmentId: null,
    intervalMs: DEFAULT_POLL_INTERVAL_MS,
    maxAttempts: DEFAULT_MAX_POLL_ATTEMPTS,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--hostEnvUrl' && args[i + 1]) out.hostEnvUrl = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--deploymentEnvironmentId' && args[i + 1]) out.deploymentEnvironmentId = args[++i];
    else if (args[i] === '--intervalMs' && args[i + 1]) out.intervalMs = parseInt(args[++i], 10);
    else if (args[i] === '--maxAttempts' && args[i + 1]) out.maxAttempts = parseInt(args[++i], 10);
  }

  return out;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// The Deployment Pipeline Configuration app posts the GUID as
// `{UPPERCASE-GUID}`. Match that shape exactly — Dataverse parses both forms
// today but the bracketed form is the only one observed in production.
function formatGuidForStamp(guid) {
  return `{${guid.toUpperCase()}}`;
}

async function forceLinkEnvironment({
  hostEnvUrl,
  token,
  deploymentEnvironmentId,
  intervalMs = DEFAULT_POLL_INTERVAL_MS,
  maxAttempts = DEFAULT_MAX_POLL_ATTEMPTS,
} = {}) {
  if (!hostEnvUrl) throw new Error('--hostEnvUrl is required');
  if (!token) throw new Error('--token is required');
  if (!deploymentEnvironmentId) throw new Error('--deploymentEnvironmentId is required');
  if (!GUID_REGEX.test(deploymentEnvironmentId)) {
    throw new Error(`--deploymentEnvironmentId is not a valid GUID: ${deploymentEnvironmentId}`);
  }

  const cleanHostEnvUrl = hostEnvUrl.replace(/\/+$/, '');
  const body = JSON.stringify({
    DeploymentEnvironmentId: formatGuidForStamp(deploymentEnvironmentId),
  });

  const res = await helpers.makeRequest({
    url: `${cleanHostEnvUrl}/api/data/v9.0/ManageEnvironmentStamp`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
      clienthost: 'Browser',
      prefer: 'odata.include-annotations="*"',
      'x-ms-app-name': 'AppDeploymentConfiguration',
    },
    body,
    includeHeaders: true,
    timeout: 30000,
  });

  if (res.error) {
    throw new Error(`ManageEnvironmentStamp request failed: ${res.error}`);
  }
  if (res.statusCode !== 204) {
    // 403 typically means the caller lacks Deployment Pipeline Administrator
    // role on the host. 404 = the deployment env record doesn't exist on this
    // host (caller must create it first). Pass through the full body so the
    // skill can surface remediation.
    throw new Error(
      `ManageEnvironmentStamp returned status ${res.statusCode}: ${(res.body || '').slice(0, 500)}`,
    );
  }

  // Re-poll validationstatus until Succeeded or Failed. The action itself is
  // synchronous (204 = stamp move accepted) but the record's validation flag
  // re-runs asynchronously after the stamp moves.
  //
  // API version note: we use v9.0 here (not v9.1) because the entire Force
  // Link flow — ManageEnvironmentStamp action + its post-action validation
  // probe — was HAR-captured against v9.0 in the AppDeploymentConfiguration
  // UI. Dataverse's OData surface is backwards-compatible across versions so
  // mixing is functionally fine; we just keep this script aligned with what
  // production actually ships.
  let validationStatus = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await sleep(intervalMs);

    const pollRes = await helpers.makeRequest({
      url: `${cleanHostEnvUrl}/api/data/v9.0/deploymentenvironments(${deploymentEnvironmentId})?$select=validationstatus,errormessage,name`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      timeout: 15000,
    });

    if (pollRes.error) {
      throw new Error(`Poll deploymentenvironment failed: ${pollRes.error}`);
    }
    if (pollRes.statusCode !== 200) {
      throw new Error(
        `Poll deploymentenvironment returned ${pollRes.statusCode}: ${(pollRes.body || '').slice(0, 500)}`,
      );
    }

    let pollData;
    try { pollData = JSON.parse(pollRes.body); } catch (e) {
      throw new Error(`Failed to parse poll response: ${e.message}`);
    }

    validationStatus = pollData.validationstatus;

    if (validationStatus === VALIDATION_STATUS_SUCCEEDED) {
      return {
        deploymentEnvironmentId,
        hostEnvUrl: cleanHostEnvUrl,
        validationStatus,
        forcedAt: new Date().toISOString(),
      };
    }
    if (validationStatus === VALIDATION_STATUS_FAILED) {
      const errMsg = pollData.errormessage || '(no error details)';
      throw new Error(
        `Force Link succeeded (stamp moved) but post-link validation failed: ${errMsg}`,
      );
    }
  }

  throw new Error(
    `Force Link post-validation did not complete after ${maxAttempts} attempts. Last validationstatus: ${validationStatus}`,
  );
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  forceLinkEnvironment(args)
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
  forceLinkEnvironment,
  formatGuidForStamp,
  VALIDATION_STATUS_PENDING,
  VALIDATION_STATUS_SUCCEEDED,
  VALIDATION_STATUS_FAILED,
};
