#!/usr/bin/env node

// Tenant cross-check for `git-configure` Phase 2: confirms the ADO org's home
// Entra tenant matches the Dataverse env's tenant before any Git mutation.
//
// SECURITY MODEL:
//   The ADO bearer token is acquired IN-PROCESS via `acquire-ado-token.js`,
//   used only to call ADO's connectionData endpoint, and then discarded. It is
//   NEVER returned to the caller, NEVER written to disk, and NEVER printed to
//   stdout (which is captured in session/event logs). The CLI output carries
//   only the tenant-comparison result — no credential material.
//
//   This replaces the previous `--writeToFile`/`.ado-token` pattern, which
//   persisted the raw token under the project tree (committable to source
//   control). ADO REST helpers now mint their own token in-process via
//   `resolveAdoTokenOrAcquire` (resolve-ado-token.js), so no helper needs a
//   token file or a token on its command line.
//
// Output (JSON to stdout) — NEVER contains the token:
//   {
//     "ok":             true,
//     "tokenType":      "OAuth",
//     "tenantId":       "<guid from az>",          // the az-signed-in tenant
//     "expiresOn":      "<ISO 8601>",
//     "adoOrgTenantId": "<guid|null>",             // populated with --verifyTenant
//     "tenantMismatch": false,
//     "hint":           null | "<message>"
//   }
//   On failure: { "ok": false, "error": "<message>" }
//
// Usage:
//   node get-ado-token.js [--organization <adoOrg>] [--verifyTenant]
//
// Azure DevOps accepts Entra OAuth bearer tokens for its REST APIs. The ADO
// Entra application has a tenant-invariant resource id (owned by
// acquire-ado-token.js):
//   499b84ac-1321-427f-aa17-267ca6975798
// See: https://learn.microsoft.com/azure/devops/integrate/get-started/authentication/entra

'use strict';

const { makeRequest } = require('./validation-helpers');
const { acquireAdoToken, ADO_ENTRA_RESOURCE_GUID } = require('./acquire-ado-token');

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { organization: null, verifyTenant: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--organization' && args[i + 1]) opts.organization = args[++i];
    else if (args[i] === '--verifyTenant') opts.verifyTenant = true;
  }
  return opts;
}

/**
 * Pulls the org's home Entra tenant ID out of an ADO connectionData response.
 * The field's path is not contractually documented; we probe several known
 * locations and return null when none yield a GUID.
 *
 * Probe order:
 *   1. authenticatedUser.properties["Microsoft.IdentityModel.Claims.TenantId"].$value
 *   2. authorizedUser.properties["Microsoft.IdentityModel.Claims.TenantId"].$value
 *   3. authenticatedUser.properties.TenantId.$value
 *   4. authorizedUser.properties.TenantId.$value
 *
 * @param {object} body parsed connectionData response
 * @returns {string|null}
 */
function extractTenantIdFromConnectionData(body) {
  if (!body || typeof body !== 'object') return null;
  const TENANT_KEYS = ['Microsoft.IdentityModel.Claims.TenantId', 'TenantId'];
  const USER_KEYS = ['authenticatedUser', 'authorizedUser'];
  const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

  for (const userKey of USER_KEYS) {
    const user = body[userKey];
    if (!user || typeof user !== 'object') continue;
    const props = user.properties;
    if (!props || typeof props !== 'object') continue;
    for (const tk of TENANT_KEYS) {
      const entry = props[tk];
      if (!entry) continue;
      const candidate = (typeof entry === 'object' && entry.$value) ? entry.$value : entry;
      if (typeof candidate === 'string' && GUID_RE.test(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * @param {object} options
 * @param {string} [options.organization]   ADO org name; required with verifyTenant.
 * @param {boolean} [options.verifyTenant]  If true, also resolve the org's tenant
 *                                          and compare against the az-signed-in tenant.
 * @param {Function} [options._execImpl]    DI hook forwarded to acquireAdoToken (tests).
 * @param {Function} [options._acquireImpl] DI hook for the in-process token acquire (tests).
 * @param {Function} [options._makeRequestImpl] DI hook for HTTP calls (tests).
 * @returns {Promise<object>}  Masked result — NEVER contains the token.
 */
async function getAdoToken({ organization, verifyTenant, _execImpl, _acquireImpl, _makeRequestImpl } = {}) {
  if (verifyTenant && !organization) {
    return { ok: false, error: '--organization is required when --verifyTenant is set' };
  }

  // Acquire the token IN-PROCESS. It lives only in this function's scope, is
  // used solely for the connectionData call below, and is never returned.
  const acq = typeof _acquireImpl === 'function' ? _acquireImpl() : acquireAdoToken({ _execImpl });
  if (!acq || !acq.ok) {
    return { ok: false, error: (acq && acq.error) || 'failed to acquire an ADO token' };
  }

  const out = {
    ok: true,
    tokenType: 'OAuth',
    tenantId: acq.tenantId || null,
    expiresOn: acq.expiresOn || null,
    adoOrgTenantId: null,
    tenantMismatch: false,
    hint: null,
  };

  if (!verifyTenant) return out;

  const request = typeof _makeRequestImpl === 'function' ? _makeRequestImpl : makeRequest;
  const url =
    `https://dev.azure.com/${encodeURIComponent(organization)}/_apis/connectionData?api-version=7.1`;
  const res = await request({
    url,
    method: 'GET',
    headers: { Authorization: `Bearer ${acq.token}`, Accept: 'application/json' },
  });

  if (res && res.error) {
    out.hint =
      `tenant verification skipped — could not reach ${url} (${res.error}). ` +
      'Proceeding without tenant cross-check.';
    return out;
  }
  if (!res || res.statusCode !== 200) {
    out.hint =
      `tenant verification skipped — connectionData returned HTTP ${res && res.statusCode}. ` +
      'Proceeding without tenant cross-check.';
    return out;
  }

  let body;
  try { body = JSON.parse(res.body); }
  catch {
    out.hint = 'tenant verification skipped — could not parse connectionData response.';
    return out;
  }

  const adoOrgTenantId = extractTenantIdFromConnectionData(body);
  out.adoOrgTenantId = adoOrgTenantId;

  if (!adoOrgTenantId) {
    out.hint =
      'tenant verification skipped — could not extract org tenant from connectionData.';
    return out;
  }

  if (out.tenantId && adoOrgTenantId.toLowerCase() !== out.tenantId.toLowerCase()) {
    out.tenantMismatch = true;
    out.hint =
      `The az-signed-in tenant (${out.tenantId}) does not match the ADO org ` +
      `"${organization}" home tenant (${adoOrgTenantId}). Run ` +
      `\`az login --tenant ${adoOrgTenantId}\` and retry.`;
  }

  return out;
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  getAdoToken(args)
    .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); })
    .catch((e) => {
      process.stderr.write('get-ado-token: ' + (e && e.message ? e.message : e) + '\n');
      process.exit(1);
    });
}

module.exports = {
  getAdoToken,
  extractTenantIdFromConnectionData,
  ADO_ENTRA_RESOURCE_GUID,
};
