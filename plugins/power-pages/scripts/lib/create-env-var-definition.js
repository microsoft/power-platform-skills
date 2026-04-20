#!/usr/bin/env node

// Creates an environmentvariabledefinition in Dataverse.
// Handles duplicate creation (409) by returning the existing definition's ID.
//
// Usage: node create-env-var-definition.js
//          --envUrl <url> --token <token>
//          --schemaName <name> --displayName <name>
//          [--type 100000003]      (100000003=Secret, 100000000=String, 100000001=Number, 100000002=Boolean)
//          [--defaultValue ""]
//
// Output (JSON to stdout):
//   { "definitionId": "...", "schemaName": "...", "created": true|false }
//
// Exit 0 on success, exit 1 on failure.

'use strict';

const helpers = require('./validation-helpers');
const { getAuthToken } = helpers;

// Env var type codes
const ENV_VAR_TYPES = {
  String: 100000000,
  Number: 100000001,
  Boolean: 100000002,
  Secret: 100000003,
  DataSource: 100000004,
  Json: 100000005,
};

function parseArgs(argv) {
  const args = argv.slice(2);
  const result = {
    envUrl: null,
    token: null,
    schemaName: null,
    displayName: null,
    type: ENV_VAR_TYPES.Secret,
    defaultValue: '',
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) result.envUrl = args[++i];
    else if (args[i] === '--token' && args[i + 1]) result.token = args[++i];
    else if (args[i] === '--schemaName' && args[i + 1]) result.schemaName = args[++i];
    else if (args[i] === '--displayName' && args[i + 1]) result.displayName = args[++i];
    else if (args[i] === '--type' && args[i + 1]) result.type = parseInt(args[++i], 10);
    else if (args[i] === '--defaultValue' && args[i + 1] !== undefined) result.defaultValue = args[++i];
  }

  return result;
}

function extractGuidFromEntityId(entityIdHeader) {
  const match = entityIdHeader && entityIdHeader.match(
    /\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/i
  );
  return match ? match[1] : null;
}

async function findExistingDefinition(envUrl, token, schemaName) {
  const url = new URL(`${envUrl}/api/data/v9.2/environmentvariabledefinitions`);
  url.searchParams.set('$filter', `schemaname eq '${schemaName}'`);
  url.searchParams.set('$select', 'environmentvariabledefinitionid,schemaname');

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

  if (res.statusCode !== 200) return null;
  const data = JSON.parse(res.body);
  if (!data.value || data.value.length === 0) return null;
  return data.value[0].environmentvariabledefinitionid;
}

async function createEnvVarDefinition({ envUrl, token, schemaName, displayName, type, defaultValue }) {
  if (!envUrl || !schemaName || !displayName) {
    throw new Error('--envUrl, --schemaName, and --displayName are required');
  }

  const resolvedToken = token || getAuthToken(envUrl);
  if (!resolvedToken) throw new Error('Failed to acquire Azure CLI token. Run `az login` first.');

  const resolvedType = type !== undefined ? type : ENV_VAR_TYPES.Secret;

  const body = JSON.stringify({
    schemaname: schemaName,
    displayname: displayName,
    type: resolvedType,
    defaultvalue: defaultValue || '',
  });

  const res = await helpers.makeRequest({
    url: `${envUrl}/api/data/v9.2/environmentvariabledefinitions`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resolvedToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
    },
    body,
    includeHeaders: true,
    timeout: 30000,
  });

  if (res.error) throw new Error(`API request failed: ${res.error}`);

  if (res.statusCode === 204 || res.statusCode === 201) {
    const entityIdHeader = res.headers && (res.headers['odata-entityid'] || res.headers['OData-EntityId']);
    const definitionId = extractGuidFromEntityId(entityIdHeader);
    if (!definitionId) {
      throw new Error(`Created but could not extract definitionId from OData-EntityId: ${entityIdHeader}`);
    }
    return { definitionId, schemaName, created: true };
  }

  // 409: already exists — re-query
  if (res.statusCode === 409) {
    const existingId = await findExistingDefinition(envUrl, resolvedToken, schemaName);
    if (existingId) return { definitionId: existingId, schemaName, created: false };
    throw new Error(`409 on creation but existing definition not found for schemaName: ${schemaName}`);
  }

  throw new Error(`Unexpected response (${res.statusCode}): ${res.body}`);
}

// CLI entry point
if (require.main === module) {
  const args = parseArgs(process.argv);

  createEnvVarDefinition(args)
    .then((result) => {
      console.log(JSON.stringify(result));
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    });
}

module.exports = { createEnvVarDefinition, ENV_VAR_TYPES };
