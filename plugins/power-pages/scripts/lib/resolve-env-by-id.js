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
const { resolveEnvByIdViaPac } = require('./pac-bap-shim');

const DEFAULT_API_VERSION = '2020-06-01';
const DEFAULT_BAP_BASE = 'https://api.bap.microsoft.com';

function parseArgs(argv) {
  const args = argv.slice(2);
  let bapToken = null;
  let envId = null;
  let apiVersion = DEFAULT_API_VERSION;
  let bapBase = DEFAULT_BAP_BASE;
  let source = 'auto'; // auto | bap | pac

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--bapToken' && args[i + 1]) bapToken = args[++i];
    else if (args[i] === '--envId' && args[i + 1]) envId = args[++i];
    else if (args[i] === '--apiVersion' && args[i + 1]) apiVersion = args[++i];
    else if (args[i] === '--bapBase' && args[i + 1]) bapBase = args[++i];
    else if (args[i] === '--source' && args[i + 1]) source = args[++i];
  }

  return { bapToken, envId, apiVersion, bapBase, source };
}

// Maps a BAP-shaped env (or PAC-shim-shaped one) to our consistent output.
function bapEnvToResult(data, fallbackEnvId) {
  const props = data.properties || {};
  const linked = props.linkedEnvironmentMetadata || {};
  return {
    found: true,
    envId: data.name || fallbackEnvId,
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

async function resolveViaBap({ bapToken, envId, apiVersion, bapBase }) {
  if (!bapToken) {
    const err = new Error('BAP token required for source=bap');
    err.statusCode = null;
    throw err;
  }
  const cleanBase = bapBase.replace(/\/+$/, '');
  const expand = encodeURIComponent('properties.linkedEnvironmentMetadata,properties.permissions');
  const url = `${cleanBase}/providers/Microsoft.BusinessAppPlatform/environments/${encodeURIComponent(envId)}?api-version=${encodeURIComponent(apiVersion)}&$expand=${expand}`;

  const res = await helpers.makeRequest({
    url,
    method: 'GET',
    headers: { Authorization: `Bearer ${bapToken}`, Accept: 'application/json' },
    timeout: 15000,
  });

  if (res.error) {
    const err = new Error(`BAP env GET failed: ${res.error}`);
    err.statusCode = null;
    throw err;
  }
  if (res.statusCode === 404) return { found: false, reason: '404-ambiguous', envId };
  if (res.statusCode === 403) {
    const err = new Error(`BAP env GET returned 403 for env ${envId} — caller lacks permission`);
    err.statusCode = 403;
    throw err;
  }
  if (res.statusCode === 401) {
    const err = new Error(`BAP env GET returned 401 for env ${envId} — token rejected by BAP`);
    err.statusCode = 401;
    throw err;
  }
  if (res.statusCode !== 200) {
    const err = new Error(`BAP env GET returned unexpected status ${res.statusCode}: ${res.body}`);
    err.statusCode = res.statusCode;
    throw err;
  }

  let data;
  try { data = JSON.parse(res.body); } catch (e) {
    throw new Error(`Failed to parse BAP env response: ${e.message}`);
  }
  return { ...bapEnvToResult(data, envId), sourceUsed: 'bap' };
}

async function resolveViaPac({ envId, pacExecImpl }) {
  const env = await resolveEnvByIdViaPac({ envId, execImpl: pacExecImpl });
  if (!env) return { found: false, reason: 'not-in-pac-list', envId, sourceUsed: 'pac' };
  return { ...bapEnvToResult(env, envId), sourceUsed: 'pac' };
}

async function resolveEnvById({
  bapToken,
  envId,
  apiVersion = DEFAULT_API_VERSION,
  bapBase = DEFAULT_BAP_BASE,
  source = 'auto',
  pacExecImpl = null,
} = {}) {
  if (!envId) throw new Error('--envId is required');
  if (source === 'bap' && !bapToken) throw new Error('--bapToken is required when --source bap');

  if (source === 'pac') {
    return resolveViaPac({ envId, pacExecImpl });
  }
  if (source === 'bap') {
    return resolveViaBap({ bapToken, envId, apiVersion, bapBase });
  }
  // auto: try BAP first if a token is available, else PAC; on 401/403 fall back to PAC
  if (!bapToken) {
    const r = await resolveViaPac({ envId, pacExecImpl });
    return { ...r, fallbackReason: 'no-bap-token-provided' };
  }
  try {
    return await resolveViaBap({ bapToken, envId, apiVersion, bapBase });
  } catch (e) {
    const sc = e.statusCode;
    if (sc === 401 || sc === 403) {
      try {
        const r = await resolveViaPac({ envId, pacExecImpl });
        return { ...r, fallbackReason: `bap-rejected-${sc}` };
      } catch (pacErr) {
        throw e; // surface original BAP error
      }
    }
    throw e;
  }
}

if (require.main === module) {
  const opts = parseArgs(process.argv);
  resolveEnvById(opts)
    .then((result) => {
      console.log(JSON.stringify(result));
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    });
}

module.exports = { resolveEnvById, resolveViaBap, resolveViaPac, bapEnvToResult };
