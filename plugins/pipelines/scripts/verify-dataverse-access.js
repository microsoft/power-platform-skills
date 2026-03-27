#!/usr/bin/env node
// Verify Dataverse access by calling the WhoAmI endpoint.
// Usage: node verify-dataverse-access.js [--envUrl <url>]
// Output: { "envUrl": "...", "userId": "...", "organizationId": "...", "businessUnitId": "..." }

const { getAuthToken, makeRequest, getEnvironmentUrl } = require('./lib/pipeline-helpers');

const API_VERSION = 'v9.2';

function parseArgs(argv) {
  const args = argv.slice(2);
  let envUrl = null;
  let tenant = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && i + 1 < args.length) {
      envUrl = args[++i].replace(/\/+$/, '');
    } else if (args[i] === '--tenant' && i + 1 < args.length) {
      tenant = args[++i];
    }
  }
  return { envUrl, tenant };
}

async function main() {
  let { envUrl, tenant } = parseArgs(process.argv);

  if (!envUrl) {
    envUrl = getEnvironmentUrl();
    if (!envUrl) {
      console.error(JSON.stringify({ error: 'Could not determine environment URL. Use --envUrl or run pac auth create first.' }));
      process.exit(1);
    }
  }

  const resourceUrl = new URL(envUrl).origin;
  const token = getAuthToken(resourceUrl, tenant);
  if (!token) {
    console.error(JSON.stringify({ error: `Failed to obtain auth token for ${resourceUrl}. Run "az login" first.` }));
    process.exit(1);
  }

  const result = await makeRequest({
    url: `${envUrl}/api/data/${API_VERSION}/WhoAmI`,
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0'
    }
  });

  if (result.error) {
    console.error(JSON.stringify({ error: result.error }));
    process.exit(1);
  }

  if (result.statusCode !== 200) {
    console.error(JSON.stringify({ error: `WhoAmI returned status ${result.statusCode}`, body: result.body }));
    process.exit(1);
  }

  let data;
  try {
    data = JSON.parse(result.body);
  } catch {
    console.error(JSON.stringify({ error: 'Failed to parse WhoAmI response' }));
    process.exit(1);
  }

  console.log(JSON.stringify({
    envUrl,
    userId: data.UserId,
    organizationId: data.OrganizationId,
    businessUnitId: data.BusinessUnitId
  }));
  process.exit(0);
}

main();
