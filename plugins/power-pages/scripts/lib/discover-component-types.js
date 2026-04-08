#!/usr/bin/env node

// Discovers Dataverse solution component type integers at runtime by querying
// solutioncomponents for known object IDs. Never hardcodes component types.
//
// Usage: node discover-component-types.js
//          --envUrl <url> --token <token>
//          --websiteRecordId <id>
//          [--powerpageComponentId <id>]
//          [--siteLanguageId <id>]
//          [--objectIds <id1,id2,...>]   (generic: returns array of { objectId, componentType })
//
// Output (JSON to stdout):
//   {
//     "websiteComponentType": 10374,
//     "subComponentType": 10373,          // only if --powerpageComponentId provided
//     "siteLanguageComponentType": 10375, // only if --siteLanguageId provided
//     "resolved": [{ "objectId": "...", "componentType": 9999 }]  // for --objectIds
//   }
//
// Exit 0 on success, exit 1 on failure.

'use strict';

const helpers = require('./validation-helpers');
const { getAuthToken } = helpers;

function parseArgs(argv) {
  const args = argv.slice(2);
  const result = {
    envUrl: null,
    token: null,
    websiteRecordId: null,
    powerpageComponentId: null,
    siteLanguageId: null,
    objectIds: [],
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) result.envUrl = args[++i];
    else if (args[i] === '--token' && args[i + 1]) result.token = args[++i];
    else if (args[i] === '--websiteRecordId' && args[i + 1]) result.websiteRecordId = args[++i];
    else if (args[i] === '--powerpageComponentId' && args[i + 1]) result.powerpageComponentId = args[++i];
    else if (args[i] === '--siteLanguageId' && args[i + 1]) result.siteLanguageId = args[++i];
    else if (args[i] === '--objectIds' && args[i + 1]) result.objectIds = args[++i].split(',').filter(Boolean);
  }

  return result;
}

async function resolveComponentType(envUrl, token, objectId) {
  const url = new URL(`${envUrl}/api/data/v9.2/solutioncomponents`);
  url.searchParams.set('$filter', `objectid eq '${objectId}'`);
  url.searchParams.set('$select', 'componenttype');
  url.searchParams.set('$top', '1');

  const res = await helpers.makeRequest({
    url: url.toString(),
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
    },
    timeout: 15000,
  });

  if (res.error) throw new Error(`solutioncomponents query failed for ${objectId}: ${res.error}`);
  if (res.statusCode !== 200) {
    throw new Error(`solutioncomponents query returned ${res.statusCode} for ${objectId}`);
  }

  const data = JSON.parse(res.body);
  if (!data.value || data.value.length === 0) return null;
  return data.value[0].componenttype;
}

async function discoverComponentTypes({ envUrl, token, websiteRecordId, powerpageComponentId, siteLanguageId, objectIds }) {
  if (!envUrl) throw new Error('--envUrl is required');
  if (!websiteRecordId) throw new Error('--websiteRecordId is required');

  const resolvedToken = token || getAuthToken(envUrl);
  if (!resolvedToken) throw new Error('Failed to acquire Azure CLI token. Run `az login` first.');

  const result = {};

  // Always resolve website component type
  const websiteType = await resolveComponentType(envUrl, resolvedToken, websiteRecordId);
  if (websiteType === null) {
    throw new Error(
      `Website record (${websiteRecordId}) not found in solutioncomponents. ` +
      'The site must be deployed before it can be solutionized.'
    );
  }
  result.websiteComponentType = websiteType;

  // Optional: powerpagecomponent sub-type
  if (powerpageComponentId) {
    const subType = await resolveComponentType(envUrl, resolvedToken, powerpageComponentId);
    result.subComponentType = subType;
  }

  // Optional: site language type
  if (siteLanguageId) {
    const langType = await resolveComponentType(envUrl, resolvedToken, siteLanguageId);
    result.siteLanguageComponentType = langType;
  }

  // Optional: generic batch resolution
  if (objectIds && objectIds.length > 0) {
    const resolved = [];
    for (const id of objectIds) {
      const ct = await resolveComponentType(envUrl, resolvedToken, id);
      resolved.push({ objectId: id, componentType: ct });
    }
    result.resolved = resolved;
  }

  return result;
}

// CLI entry point
if (require.main === module) {
  const args = parseArgs(process.argv);

  discoverComponentTypes(args)
    .then((result) => {
      console.log(JSON.stringify(result));
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    });
}

module.exports = { discoverComponentTypes, resolveComponentType };
