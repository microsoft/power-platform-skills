#!/usr/bin/env node

// Creates a deploymentenvironments record in the Pipelines host environment
// and polls until validationstatus reports Succeeded (or Failed).
//
// Uses the **unprefixed** field schema (canonical per power-pipeline-skill-
// reference.md and verified against msdyn_AppDeploymentAnchor v9.1.2026034
// on 2026-04-28). The earlier msdyn_-prefixed shape we used was from an
// early-preview HAR; it is rejected ("Invalid property 'msdyn_name'") by the
// shipped Pipelines schema.
//
// Required body fields:
//   name             — display name of the deploymentenvironment record
//   environmentid    — BAP env GUID (NOT the env URL)
//   environmenttype  — 200000000 (Development) or 200000001 (Target)
//
// Usage:
//   node create-deployment-environment.js \
//     --hostEnvUrl <url> \
//     --token <hostToken> \
//     --name <"Display Name"> \
//     --bapEnvId <bap-env-guid> \
//     --environmentType <200000000|200000001> \
//     [--environmentUrl <url>]   (optional — only used in the output marker)
//
// Output (JSON to stdout):
//   { "deploymentEnvironmentId": "...",
//     "name": "...",
//     "bapEnvId": "...",
//     "environmentUrl": "...",
//     "environmentType": 200000000,
//     "validationStatus": 200000001 }
//
// Exit 0 on success, exit 1 on error (stderr).

'use strict';

const helpers = require('./validation-helpers');

const ENV_TYPE_DEV = 200000000;
const ENV_TYPE_TARGET = 200000001;

const VALIDATION_STATUS_PENDING = 200000000;
const VALIDATION_STATUS_SUCCEEDED = 200000001;
const VALIDATION_STATUS_FAILED = 200000002;

const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 20;

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    hostEnvUrl: null,
    token: null,
    name: null,
    bapEnvId: null,
    environmentUrl: null,
    environmentType: null,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--hostEnvUrl' && args[i + 1]) out.hostEnvUrl = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--name' && args[i + 1]) out.name = args[++i];
    else if (args[i] === '--bapEnvId' && args[i + 1]) out.bapEnvId = args[++i];
    else if (args[i] === '--environmentUrl' && args[i + 1]) out.environmentUrl = args[++i];
    else if (args[i] === '--environmentType' && args[i + 1]) out.environmentType = Number(args[++i]);
  }

  return out;
}

function extractGuidFromODataEntityId(header) {
  if (!header) return null;
  const match = header.match(/\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/i);
  return match ? match[1] : null;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function findExistingByBapId({ cleanHostEnvUrl, token, bapEnvId }) {
  const filter = encodeURIComponent(`environmentid eq '${bapEnvId}'`);
  const url = `${cleanHostEnvUrl}/api/data/v9.1/deploymentenvironments?$filter=${filter}&$select=deploymentenvironmentid,name,environmentid,environmenttype,validationstatus`;
  const res = await helpers.makeRequest({
    url,
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    timeout: 15000,
  });
  if (res.statusCode === 200 && res.body) {
    try {
      const data = JSON.parse(res.body);
      if (Array.isArray(data.value) && data.value.length > 0) return data.value[0];
    } catch {}
  }
  return null;
}

async function createDeploymentEnvironment({
  hostEnvUrl,
  token,
  name,
  bapEnvId,
  environmentUrl = null,
  environmentType,
} = {}) {
  if (!hostEnvUrl) throw new Error('--hostEnvUrl is required');
  if (!token) throw new Error('--token is required');
  if (!name) throw new Error('--name is required');
  if (!bapEnvId) throw new Error('--bapEnvId is required (the BAP environment GUID, e.g., 9f930375-571f-ee07-8b8f-d4a9e317c292)');
  if (environmentType !== ENV_TYPE_DEV && environmentType !== ENV_TYPE_TARGET) {
    throw new Error(`--environmentType must be ${ENV_TYPE_DEV} (Development) or ${ENV_TYPE_TARGET} (Target)`);
  }

  const cleanHostEnvUrl = hostEnvUrl.replace(/\/+$/, '');

  // Idempotency: if a deploymentenvironment record already exists for this
  // BAP env, return it instead of creating a duplicate.
  const existing = await findExistingByBapId({ cleanHostEnvUrl, token, bapEnvId });
  if (existing) {
    return {
      deploymentEnvironmentId: existing.deploymentenvironmentid,
      name: existing.name,
      bapEnvId: existing.environmentid,
      environmentUrl,
      environmentType: existing.environmenttype,
      validationStatus: existing.validationstatus,
      reused: true,
    };
  }

  const body = JSON.stringify({
    name,
    environmentid: bapEnvId,
    environmenttype: environmentType,
  });

  const createRes = await helpers.makeRequest({
    url: `${cleanHostEnvUrl}/api/data/v9.1/deploymentenvironments`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
      Prefer: 'return=representation',
    },
    body,
    includeHeaders: true,
    timeout: 30000,
  });

  if (createRes.error) {
    throw new Error(`Create deploymentenvironments failed: ${createRes.error}`);
  }

  if (createRes.statusCode < 200 || createRes.statusCode >= 300) {
    throw new Error(
      `Create deploymentenvironments returned status ${createRes.statusCode}: ${createRes.body.slice(0, 500)}`,
    );
  }

  const entityIdHeader = createRes.headers && (createRes.headers['odata-entityid'] || createRes.headers['OData-EntityId']);
  let deploymentEnvironmentId = extractGuidFromODataEntityId(entityIdHeader);
  if (!deploymentEnvironmentId && createRes.body) {
    try { deploymentEnvironmentId = JSON.parse(createRes.body).deploymentenvironmentid || null; } catch {}
  }
  if (!deploymentEnvironmentId) {
    throw new Error(`Could not extract deploymentEnvironmentId. headers=${JSON.stringify(createRes.headers || {}).slice(0, 200)}, body=${(createRes.body || '').slice(0, 200)}`);
  }

  // Poll validationstatus until terminal
  let attempts = 0;
  let validationStatus = null;
  while (attempts < MAX_POLL_ATTEMPTS) {
    await sleep(POLL_INTERVAL_MS);
    attempts++;

    const pollRes = await helpers.makeRequest({
      url: `${cleanHostEnvUrl}/api/data/v9.1/deploymentenvironments(${deploymentEnvironmentId})?$select=validationstatus,errormessage,name`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      timeout: 15000,
    });

    if (pollRes.error) throw new Error(`Poll deploymentenvironment failed: ${pollRes.error}`);
    if (pollRes.statusCode !== 200) {
      throw new Error(`Poll deploymentenvironment returned ${pollRes.statusCode}: ${pollRes.body}`);
    }
    let pollData;
    try { pollData = JSON.parse(pollRes.body); } catch (e) {
      throw new Error(`Failed to parse poll response: ${e.message}`);
    }

    validationStatus = pollData.validationstatus;
    if (validationStatus === VALIDATION_STATUS_SUCCEEDED) {
      return {
        deploymentEnvironmentId,
        name,
        bapEnvId,
        environmentUrl,
        environmentType,
        validationStatus,
        reused: false,
      };
    }
    if (validationStatus === VALIDATION_STATUS_FAILED) {
      const err = pollData.errormessage || 'No error details available';
      throw new Error(`Deployment environment validation failed: ${err}`);
    }
    // Pending — keep polling
  }

  throw new Error(
    `Deployment environment validation did not complete after ${MAX_POLL_ATTEMPTS} attempts. Last status: ${validationStatus}`,
  );
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  createDeploymentEnvironment(args)
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
  createDeploymentEnvironment,
  ENV_TYPE_DEV,
  ENV_TYPE_TARGET,
  VALIDATION_STATUS_SUCCEEDED,
  VALIDATION_STATUS_FAILED,
};
