#!/usr/bin/env node

// Creates a deploymentenvironments record in the Pipelines host environment
// and polls until validationstatus is Succeeded.
//
// Usage:
//   node create-deployment-environment.js \
//     --hostEnvUrl <url> \
//     --token <token> \
//     --name <name> \
//     --environmentUrl <url>
//
// Output (JSON to stdout):
//   { "deploymentEnvironmentId": "...", "name": "...", "environmentUrl": "...", "validationStatus": 192350001 }
//
// Exit 0 on success, exit 1 on error (stderr).

'use strict';

const helpers = require('./validation-helpers');

const VALIDATION_STATUS_SUCCEEDED = 192350001;
const VALIDATION_STATUS_FAILED = 192350002;
const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 20;

function parseArgs(argv) {
  const args = argv.slice(2);
  let hostEnvUrl = null;
  let token = null;
  let name = null;
  let environmentUrl = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--hostEnvUrl' && args[i + 1]) hostEnvUrl = args[++i];
    else if (args[i] === '--token' && args[i + 1]) token = args[++i];
    else if (args[i] === '--name' && args[i + 1]) name = args[++i];
    else if (args[i] === '--environmentUrl' && args[i + 1]) environmentUrl = args[++i];
  }

  return { hostEnvUrl, token, name, environmentUrl };
}

function extractGuidFromODataEntityId(header) {
  if (!header) return null;
  const match = header.match(/\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/i);
  return match ? match[1] : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createDeploymentEnvironment({ hostEnvUrl, token, name, environmentUrl } = {}) {
  if (!hostEnvUrl) throw new Error('--hostEnvUrl is required');
  if (!token) throw new Error('--token is required');
  if (!name) throw new Error('--name is required');
  if (!environmentUrl) throw new Error('--environmentUrl is required');

  const cleanHostEnvUrl = hostEnvUrl.replace(/\/+$/, '');

  const body = JSON.stringify({
    msdyn_name: name,
    msdyn_url: environmentUrl,
    msdyn_type: 1,
  });

  const createRes = await helpers.makeRequest({
    url: `${cleanHostEnvUrl}/api/data/v9.2/deploymentenvironments`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
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
      `Create deploymentenvironments returned status ${createRes.statusCode}: ${createRes.body}`
    );
  }

  const entityIdHeader = createRes.headers && createRes.headers['odata-entityid'];
  const deploymentEnvironmentId = extractGuidFromODataEntityId(entityIdHeader);

  if (!deploymentEnvironmentId) {
    throw new Error(
      `Could not extract deploymentEnvironmentId from OData-EntityId header: ${entityIdHeader}`
    );
  }

  // Poll validationstatus until Succeeded or Failed
  let attempts = 0;
  let validationStatus = null;

  while (attempts < MAX_POLL_ATTEMPTS) {
    await sleep(POLL_INTERVAL_MS);
    attempts++;

    const pollRes = await helpers.makeRequest({
      url: `${cleanHostEnvUrl}/api/data/v9.2/deploymentenvironments(${deploymentEnvironmentId})?$select=msdyn_validationstatus,msdyn_errordetails`,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      timeout: 15000,
    });

    if (pollRes.error) {
      throw new Error(`Poll deploymentenvironment failed: ${pollRes.error}`);
    }

    if (pollRes.statusCode !== 200) {
      throw new Error(
        `Poll deploymentenvironment returned status ${pollRes.statusCode}: ${pollRes.body}`
      );
    }

    let pollData;
    try {
      pollData = JSON.parse(pollRes.body);
    } catch (e) {
      throw new Error(`Failed to parse poll response: ${e.message}`);
    }

    validationStatus = pollData.msdyn_validationstatus;

    if (validationStatus === VALIDATION_STATUS_SUCCEEDED) {
      return {
        deploymentEnvironmentId,
        name,
        environmentUrl,
        validationStatus,
      };
    }

    if (validationStatus === VALIDATION_STATUS_FAILED) {
      const errorDetails = pollData.msdyn_errordetails || 'No error details available';
      throw new Error(
        `Deployment environment validation failed: ${errorDetails}`
      );
    }

    // Any other status — keep polling
  }

  throw new Error(
    `Deployment environment validation did not complete after ${MAX_POLL_ATTEMPTS} attempts. Last status: ${validationStatus}`
  );
}

// CLI entry point
if (require.main === module) {
  const { hostEnvUrl, token, name, environmentUrl } = parseArgs(process.argv);

  createDeploymentEnvironment({ hostEnvUrl, token, name, environmentUrl })
    .then((result) => {
      console.log(JSON.stringify(result));
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    });
}

module.exports = { createDeploymentEnvironment };
