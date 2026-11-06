#!/usr/bin/env node

// Creates a Dataverse solution (and optionally a publisher) via OData API.
// Handles "already exists" (409) by returning the existing record's ID.
//
// Usage: node create-solution.js --envUrl <url> --token <token>
//          --uniqueName <name> --friendlyName <name> --version <version>
//          --publisherId <id> [--description <text>]
//
// Output (JSON to stdout):
//   { "solutionId": "...", "uniqueName": "...", "created": true|false }
//   created=false means a solution with this uniqueName already existed.
//
// Exit 0 on success, exit 1 on failure.

'use strict';

const helpers = require('./validation-helpers');
const { getAuthToken } = helpers;

function parseArgs(argv) {
  const args = argv.slice(2);
  const result = { envUrl: null, token: null, uniqueName: null, friendlyName: null, version: null, publisherId: null, description: '' };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) result.envUrl = args[++i];
    else if (args[i] === '--token' && args[i + 1]) result.token = args[++i];
    else if (args[i] === '--uniqueName' && args[i + 1]) result.uniqueName = args[++i];
    else if (args[i] === '--friendlyName' && args[i + 1]) result.friendlyName = args[++i];
    else if (args[i] === '--version' && args[i + 1]) result.version = args[++i];
    else if (args[i] === '--publisherId' && args[i + 1]) result.publisherId = args[++i];
    else if (args[i] === '--description' && args[i + 1]) result.description = args[++i];
  }

  return result;
}

function extractGuidFromEntityId(entityIdHeader) {
  // OData-EntityId: https://org.crm.dynamics.com/api/data/v9.2/solutions(guid)
  const match = entityIdHeader && entityIdHeader.match(
    /\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/i
  );
  return match ? match[1] : null;
}

function extractSolutionIdFromBody(body) {
  if (!body) return null;
  try {
    const parsed = typeof body === 'string' ? JSON.parse(body) : body;
    const id = parsed && parsed.solutionid;
    return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : null;
  } catch {
    return null;
  }
}

async function createSolution({ envUrl, token, uniqueName, friendlyName, version, publisherId, description }) {
  if (!envUrl || !uniqueName || !friendlyName || !version || !publisherId) {
    throw new Error('--envUrl, --uniqueName, --friendlyName, --version, --publisherId are all required');
  }

  const resolvedToken = token || getAuthToken(envUrl);
  if (!resolvedToken) {
    throw new Error('Failed to acquire Azure CLI token. Run `az login` first.');
  }

  const commonHeaders = {
    Authorization: `Bearer ${resolvedToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'OData-MaxVersion': '4.0',
    'OData-Version': '4.0',
  };

  const body = JSON.stringify({
    uniquename: uniqueName,
    friendlyname: friendlyName,
    version: version,
    description: description || `Power Pages site components for ${friendlyName}`,
    'publisherid@odata.bind': `/publishers(${publisherId})`,
  });

  const res = await helpers.makeRequest({
    url: `${envUrl}/api/data/v9.2/solutions`,
    method: 'POST',
    headers: { ...commonHeaders, Prefer: 'return=representation' },
    body,
    includeHeaders: true,
    timeout: 30000,
  });

  if (res.error) throw new Error(`API request failed: ${res.error}`);

  // `Prefer: return=representation` makes Dataverse answer 201 with the created row
  // in the body (and, in practice, no OData-EntityId header); without the preference
  // it answers 204 with only the header. Accept either source of the id:
  //   201 body:   { "solutionid": "aabbccdd-…", "uniquename": "MyPortal", … }
  //   204 header: OData-EntityId: https://org.crm.dynamics.com/api/data/v9.2/solutions(aabbccdd-…)
  // https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/create-entity-web-api#create-with-data-returned
  if (res.statusCode === 204 || res.statusCode === 201) {
    const entityIdHeader = res.headers && (res.headers['odata-entityid'] || res.headers['OData-EntityId']);
    const solutionId = extractGuidFromEntityId(entityIdHeader) || extractSolutionIdFromBody(res.body);
    if (!solutionId) {
      throw new Error(
        `Solution created (HTTP ${res.statusCode}) but no solutionId was found in the OData-EntityId header ` +
        `(${entityIdHeader}) or the response body.`
      );
    }
    return { solutionId, uniqueName, created: true };
  }

  // 409: duplicate — re-query to get existing ID
  if (res.statusCode === 409) {
    const { verifySolutionExists } = require('./verify-solution-exists');
    const existing = await verifySolutionExists({ envUrl, uniqueName, token: resolvedToken });
    if (existing.found) {
      return { solutionId: existing.solutionId, uniqueName, created: false };
    }
    throw new Error(`Solution creation returned 409 but existing solution not found on re-query.`);
  }

  throw new Error(`Unexpected response (${res.statusCode}): ${res.body}`);
}

// CLI entry point
if (require.main === module) {
  const args = parseArgs(process.argv);

  createSolution(args)
    .then((result) => {
      console.log(JSON.stringify(result));
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    });
}

module.exports = { createSolution };
