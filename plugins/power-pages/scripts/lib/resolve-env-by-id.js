#!/usr/bin/env node

// Resolves a BAP environment GUID to instance URL + sku + linked metadata + permissions.
// Mirrors `useGetEnvironmentByName` from ProjectHostProvider.tsx — same BAP endpoint.
//
//   GET https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/environments/{envId}
//     ?api-version=2020-06-01
//     &$expand=properties.linkedEnvironmentMetadata,properties.permissions
//
// 404 disambiguation: per PowerPipelines_PE_Knowledge.md §6.A, BAP returns 404 for
// deleted/disabled/no-PE/no-access without distinguishing. Callers must corroborate
// with list-tenant-envs.js before treating as "doesn't exist".
//
// Usage: node resolve-env-by-id.js --bapToken <token> --envId <guid>
//        [--apiVersion 2020-06-01]
//
// Output (JSON to stdout):
//   200 → { found: true, envId, instanceUrl, instanceApiUrl, displayName, environmentSku, isManaged, permissions, raw }
//   404 → { found: false, reason: "404-ambiguous", envId }
//   403 → throws (caller decides handling)
//
// Exit 0 on success (including found: false), exit 1 on error.

'use strict';

const helpers = require('./validation-helpers');

const DEFAULT_API_VERSION = '2020-06-01';
const DEFAULT_BAP_BASE = 'https://api.bap.microsoft.com';

function parseArgs(argv) {
  const args = argv.slice(2);
  let bapToken = null;
  let envId = null;
  let apiVersion = DEFAULT_API_VERSION;
  let bapBase = DEFAULT_BAP_BASE;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--bapToken' && args[i + 1]) bapToken = args[++i];
    else if (args[i] === '--envId' && args[i + 1]) envId = args[++i];
    else if (args[i] === '--apiVersion' && args[i + 1]) apiVersion = args[++i];
    else if (args[i] === '--bapBase' && args[i + 1]) bapBase = args[++i];
  }

  return { bapToken, envId, apiVersion, bapBase };
}

async function resolveEnvById({ bapToken, envId, apiVersion = DEFAULT_API_VERSION, bapBase = DEFAULT_BAP_BASE } = {}) {
  if (!bapToken) throw new Error('--bapToken is required');
  if (!envId) throw new Error('--envId is required');

  const cleanBase = bapBase.replace(/\/+$/, '');
  const expand = encodeURIComponent('properties.linkedEnvironmentMetadata,properties.permissions');
  const url = `${cleanBase}/providers/Microsoft.BusinessAppPlatform/environments/${encodeURIComponent(envId)}?api-version=${encodeURIComponent(apiVersion)}&$expand=${expand}`;

  const res = await helpers.makeRequest({
    url,
    method: 'GET',
    headers: {
      Authorization: `Bearer ${bapToken}`,
      Accept: 'application/json',
    },
    timeout: 15000,
  });

  if (res.error) {
    throw new Error(`BAP env GET failed: ${res.error}`);
  }

  if (res.statusCode === 404) {
    return { found: false, reason: '404-ambiguous', envId };
  }

  if (res.statusCode === 403) {
    throw new Error(`BAP env GET returned 403 for env ${envId} — caller lacks permission`);
  }

  if (res.statusCode !== 200) {
    throw new Error(`BAP env GET returned unexpected status ${res.statusCode}: ${res.body}`);
  }

  let data;
  try {
    data = JSON.parse(res.body);
  } catch (e) {
    throw new Error(`Failed to parse BAP env response: ${e.message}`);
  }

  const props = data.properties || {};
  const linked = props.linkedEnvironmentMetadata || {};

  return {
    found: true,
    envId: data.name || envId,
    instanceUrl: linked.instanceUrl || null,
    instanceApiUrl: linked.instanceApiUrl || null,
    displayName: props.displayName || null,
    environmentSku: props.environmentSku || null,
    isManaged: !!linked.isManaged,
    permissions: props.permissions || {},
    location: data.location || null,
    tenantId: props.tenantId || null,
    azureRegionHint: props.azureRegionHint || null,
    domainName: linked.domainName || null,
  };
}

if (require.main === module) {
  const { bapToken, envId, apiVersion, bapBase } = parseArgs(process.argv);

  resolveEnvById({ bapToken, envId, apiVersion, bapBase })
    .then((result) => {
      console.log(JSON.stringify(result));
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    });
}

module.exports = { resolveEnvById };
