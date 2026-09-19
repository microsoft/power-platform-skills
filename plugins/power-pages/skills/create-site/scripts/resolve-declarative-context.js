#!/usr/bin/env node

// Resolves the non-secret environment context required by declarative site creation.
// Tokens remain inside this process and are never included in stdout.

const {
  getEnvironmentUrl,
  getPacAuthInfo,
  getAuthToken,
  makeRequest,
  validateDataverseEnvironmentUrl,
} = require('../../../scripts/lib/validation-helpers');

async function resolveDeclarativeContext(dependencies = {}) {
  const readEnvironmentUrl = dependencies.getEnvironmentUrl || getEnvironmentUrl;
  const readPacAuthInfo = dependencies.getPacAuthInfo || getPacAuthInfo;
  const acquireToken = dependencies.getAuthToken || getAuthToken;
  const request = dependencies.makeRequest || makeRequest;

  const rawEnvironmentUrl = readEnvironmentUrl();
  const pac = readPacAuthInfo();
  if (!rawEnvironmentUrl || !pac || !pac.environmentId) {
    throw new Error(
      'Power Platform CLI is not signed in to a Dataverse environment. Run "pac auth create" and retry.',
    );
  }

  const environmentUrl = validateDataverseEnvironmentUrl(rawEnvironmentUrl);
  const token = acquireToken(environmentUrl);
  if (!token) {
    throw new Error('Azure CLI token is unavailable. Run "az login" and retry.');
  }

  const result = await request({
    url: `${environmentUrl}/api/data/v9.2/WhoAmI`,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
    timeout: 15_000,
  });

  if (result.error) {
    throw new Error(`Dataverse WhoAmI request failed: ${result.error}`);
  }
  if (result.statusCode !== 200) {
    throw new Error(`Dataverse WhoAmI returned HTTP ${result.statusCode}.`);
  }

  let body;
  try {
    body = JSON.parse(result.body);
  } catch {
    throw new Error('Dataverse WhoAmI returned invalid JSON.');
  }
  if (!body.OrganizationId) {
    throw new Error('Dataverse WhoAmI did not return OrganizationId.');
  }

  return {
    environmentUrl,
    environmentId: pac.environmentId,
    organizationId: body.OrganizationId,
    cloud: pac.cloud || 'Public',
  };
}

async function main() {
  try {
    const context = await resolveDeclarativeContext();
    process.stdout.write(`${JSON.stringify(context, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = { resolveDeclarativeContext };
