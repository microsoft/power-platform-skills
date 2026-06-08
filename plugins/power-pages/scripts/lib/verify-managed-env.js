#!/usr/bin/env node

// Verifies that Managed Environments is enabled for the current Power Platform
// environment. Managed Environments is a prerequisite for Connect-to-Git.
//
// Checks via the Power Platform BAP API (same source the admin center uses).
// Falls back to inspecting the Dataverse org settings if the BAP call fails
// (happens in some tenants where the caller's token doesn't have BAP scope).
//
// Output (JSON to stdout):
//   {
//     enabled:        true | false,
//     environmentId:  "<guid>",
//     displayName:    "<env display name>" | null,
//     protectionLevel: "Standard" | "Basic" | null,   // Standard = Managed
//     checkMethod:    "bap" | "dataverse-org" | "unknown",
//   }
//   On error: { error: "<message>" }
//
// Usage:
//   node verify-managed-env.js [--envUrl <url>] [--token <token>]
//                              [--bapToken <token>]
//
// NOTE: The BAP API requires a token scoped to `https://service.powerapps.com/`
// NOT the Dataverse resource URL. Pass --bapToken when the calling skill has
// already acquired one. When omitted, the helper attempts `az account
// get-access-token --resource https://service.powerapps.com/`.

'use strict';

const { getAuthToken, getEnvironmentUrl, getPacAuthInfo, makeRequest } = require('./validation-helpers');

const BAP_RESOURCE = 'https://service.powerapps.com/';
// HAR-confirmed 2026-06: api.bap.microsoft.com (not api.powerplatform.com).
// The latter returns 404 RouteNotFound. See references/inner-loop-empirical-findings.md §6.
const BAP_BASE = 'https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/scopes/admin';
const BAP_API_VERSION = '2023-06-01';

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { envUrl: null, token: null, bapToken: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) out.envUrl = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--bapToken' && args[i + 1]) out.bapToken = args[++i];
  }
  return out;
}

/**
 * Resolve the BAP environment ID from PAC CLI.
 * PAC CLI's `pac auth who` returns the environment ID in its output.
 */
function getBapEnvId() {
  const info = getPacAuthInfo();
  return info ? info.environmentId : null;
}

/**
 * Try checking Managed Env via the BAP /environments/{id} endpoint.
 * Returns { enabled, displayName, protectionLevel } on success, null on failure.
 */
async function checkViaBap(bapToken, environmentId) {
  const apiUrl = `${BAP_BASE}/environments/${environmentId}?api-version=${BAP_API_VERSION}`;
  const res = await makeRequest({
    url: apiUrl,
    method: 'GET',
    headers: {
      Authorization: `Bearer ${bapToken}`,
      Accept: 'application/json',
    },
  });
  if (res.statusCode !== 200) return null;
  let body;
  try { body = JSON.parse(res.body); } catch { return null; }

  // BAP API response shape: body.properties.governanceConfiguration.protectionLevel
  // "Standard" = Managed Environments enabled.
  // "Basic" = default, Managed Env not enabled.
  // TODO: HAR-verify — confirm the exact field path and values on a real tenant.
  const protection = body?.properties?.governanceConfiguration?.protectionLevel || null;
  return {
    enabled: protection === 'Standard',
    displayName: body?.properties?.displayName || null,
    protectionLevel: protection,
  };
}

/**
 * Fallback: check Dataverse org settings for managedEnvironmentsEnabled.
 * Some tenants block BAP API access even with correct scope.
 *
 * TODO: HAR-verify — the org settings entity `organizations` and the field
 * `isgoverned` (or equivalent) need confirmation.
 */
async function checkViaDataverse(tok, envUrl) {
  const base = envUrl.replace(/\/+$/, '');
  const apiUrl =
    `${base}/api/data/v9.2/organizations?$select=organizationid,isgoverned,name`;
  const res = await makeRequest({
    url: apiUrl,
    method: 'GET',
    headers: {
      Authorization: `Bearer ${tok}`,
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
      Accept: 'application/json',
    },
  });
  if (res.statusCode !== 200) return null;
  let rows;
  try { rows = JSON.parse(res.body).value; } catch { return null; }
  if (!rows || rows.length === 0) return null;
  const org = rows[0];
  // `isgoverned` is the presumed column; TODO HAR-verify exact name.
  return {
    enabled: org.isgoverned === true,
    displayName: org.name || null,
    protectionLevel: org.isgoverned === true ? 'Standard' : 'Basic',
  };
}

/**
 * @param {object} options
 * @param {string} [options.envUrl]
 * @param {string} [options.token]     Dataverse scoped token
 * @param {string} [options.bapToken]  BAP-scoped token
 * @returns {Promise<object>}
 */
async function verifyManagedEnv({ envUrl, token, bapToken } = {}) {
  const url = envUrl || getEnvironmentUrl();
  if (!url) return { error: 'Could not determine environment URL.' };

  const environmentId = getBapEnvId();
  const tok = token || getAuthToken(url);

  // Preferred path: BAP API
  const bap = bapToken || getAuthToken(BAP_RESOURCE);
  if (bap && environmentId) {
    const result = await checkViaBap(bap, environmentId);
    if (result) return { ...result, environmentId, checkMethod: 'bap' };
  }

  // Fallback: Dataverse org entity
  if (tok) {
    const result = await checkViaDataverse(tok, url);
    if (result) return { ...result, environmentId: environmentId || null, checkMethod: 'dataverse-org' };
  }

  return {
    enabled: false,
    environmentId: environmentId || null,
    displayName: null,
    protectionLevel: null,
    checkMethod: 'unknown',
    error: 'Could not verify Managed Environment status — ensure you are logged in to both Azure CLI and PAC CLI.',
  };
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  verifyManagedEnv(args)
    .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); })
    .catch((e) => {
      process.stderr.write('verify-managed-env: ' + e.message + '\n');
      process.exit(1);
    });
}

module.exports = { verifyManagedEnv, BAP_RESOURCE };
