#!/usr/bin/env node

// Creates an environment variable definition and value in Dataverse.
// Uses Dataverse OData API with Azure CLI authentication.
//
// Usage:
//   node create-environment-variable.js <envUrl> --schemaName <name> --displayName <name> --value <value> [--type <string|secret>]
//
// Arguments:
//   envUrl         Dataverse environment URL (e.g., https://org123.crm.dynamics.com)
//   --schemaName   Schema name for the env var (e.g., cr5b4_ApiSecret)
//   --displayName  Human-readable display name
//   --value        The value (plain text for string type, Key Vault secret URI for secret type)
//   --type         "string" (default) or "secret" (Key Vault-backed)
//
// Output (JSON to stdout):
//   { "definitionId": "<guid>", "valueId": "<guid>", "schemaName": "<name>" }
//
// Exit codes:
//   0 - Success
//   1 - Validation or API error

const { getAuthToken, makeRequest } = require('./lib/validation-helpers');
const generateUuid = require('./generate-uuid');

const cliArgs = process.argv.slice(2);

// First positional arg is the environment URL — validate as HTTPS URL to prevent shell injection
// (envUrl flows into getAuthToken which may use execSync)
const rawEnvUrl = cliArgs[0] && !cliArgs[0].startsWith('--') ? cliArgs[0].replace(/\/+$/, '') : null;
const envUrl = rawEnvUrl && /^https:\/\/[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]*)*$/.test(rawEnvUrl) ? rawEnvUrl : null;
if (rawEnvUrl && !envUrl) {
  process.stderr.write('Error: envUrl must be a valid HTTPS URL (e.g., https://org123.crm.dynamics.com).\n');
  process.exit(1);
}

function getArg(name) {
  const idx = cliArgs.indexOf(`--${name}`);
  return idx !== -1 && idx + 1 < cliArgs.length ? cliArgs[idx + 1] : null;
}

const schemaName = getArg('schemaName');
const displayName = getArg('displayName');
const value = getArg('value');
const type = getArg('type') || 'string';

if (!envUrl || !schemaName || !displayName || value === null) {
  process.stderr.write(
    'Usage: node create-environment-variable.js <envUrl> --schemaName <name> --displayName <name> --value <value> [--type <string|secret>]\n'
  );
  process.exit(1);
}

if (type !== 'string' && type !== 'secret') {
  process.stderr.write('Error: --type must be "string" or "secret".\n');
  process.exit(1);
}

// Schema name validation: must follow Dataverse publisher prefix pattern (letters, digits, underscores)
if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(schemaName)) {
  process.stderr.write(
    'Error: --schemaName must start with a letter and contain only letters, digits, and underscores.\n'
  );
  process.exit(1);
}

// Dataverse environment variable type codes
const ENV_VAR_TYPES = {
  string: 100000000,
  secret: 100000005,
};

async function apiPost(envUrl, token, entitySet, body) {
  const res = await makeRequest({
    url: `${envUrl}/api/data/v9.2/${entitySet}`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
    timeout: 30000,
  });

  if (res.error) {
    return { ok: false, message: res.error };
  }
  if (res.statusCode >= 400) {
    let msg = `HTTP ${res.statusCode}`;
    try { msg += ': ' + JSON.parse(res.body).error.message; } catch {}
    return { ok: false, message: msg };
  }
  return { ok: true };
}

async function main() {
  const token = getAuthToken(envUrl);
  if (!token) {
    process.stderr.write('Failed to get Azure CLI token. Run `az login` first.\n');
    process.exit(1);
  }

  const definitionId = generateUuid();
  const valueId = generateUuid();

  // Deep insert: create definition + value in a single atomic API call.
  // If it fails, neither record is created — no orphaned definitions.
  const result = await apiPost(envUrl, token, 'environmentvariabledefinitions', {
    schemaname: schemaName,
    displayname: displayName,
    type: ENV_VAR_TYPES[type],
    environmentvariabledefinitionid: definitionId,
    environmentvariabledefinition_environmentvariablevalue: [
      {
        value: value,
        environmentvariablevalueid: valueId,
      },
    ],
  });

  if (!result.ok) {
    process.stderr.write(`Failed to create environment variable: ${result.message}\n`);
    process.exit(1);
  }

  process.stdout.write(JSON.stringify({ definitionId, valueId, schemaName }));
}

main();
