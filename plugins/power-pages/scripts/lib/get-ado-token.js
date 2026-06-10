#!/usr/bin/env node

// Acquires a Microsoft Entra-issued bearer token scoped to Azure DevOps via
// `az account get-access-token`. Used by `setup-git-integration` Phase 1
// step 0 and Phase 2 step 1 to replace the PAT prompt.
//
// Azure DevOps accepts both PATs (Basic auth) and Entra OAuth bearer tokens
// for its REST APIs. The ADO Entra application has a tenant-invariant ID:
//   499b84ac-1321-427f-aa17-267ca6975798
// This GUID is the same in every tenant and is the documented resource
// identifier for ADO API access. See:
//   https://learn.microsoft.com/azure/devops/integrate/get-started/authentication/entra
//
// Output (JSON to stdout):
//   {
//     "ok":             true,
//     "token":          "<jwt>",
//     "tokenType":      "OAuth",
//     "tenantId":       "<guid from az>",
//     "expiresOn":      "<ISO 8601>",
//     "adoOrgTenantId": "<guid|null>",   // populated only with --verifyTenant
//     "tenantMismatch": false,
//     "hint":           null | "<message>"
//   }
//
//   On failure: { "ok": false, "error": "<message>" }
//
// Usage:
//   node get-ado-token.js [--organization <adoOrg>] [--verifyTenant]
//
// Security:
//   - Never log the token to stderr or anywhere other than stdout-as-JSON.
//   - Callers must not echo the `token` field; pass it directly to
//     downstream helpers as `--token "<token>"`.

'use strict';

const { execSync } = require('child_process');

const { makeRequest } = require('./validation-helpers');

const ADO_ENTRA_RESOURCE_GUID = '499b84ac-1321-427f-aa17-267ca6975798';

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
 * Default implementation that shells out to `az account get-access-token`.
 * The DI hook (`_execImpl`) lets tests provide a fake without touching the
 * shell.
 *
 * @returns {{ token: string, tenantId: string, expiresOn: string }}
 * @throws  Error when `az` is missing, signed-out, or returns non-JSON.
 */
function defaultAzGetTokenImpl(execImpl) {
  const exec = execImpl || execSync;
  const cmd =
    `az account get-access-token --resource ${ADO_ENTRA_RESOURCE_GUID} ` +
    `--query "{token:accessToken, expiresOn:expiresOn, tenantId:tenant}" -o json`;
  let raw;
  try {
    raw = exec(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
  } catch (e) {
    const stderr = (e && e.stderr && e.stderr.toString()) || '';
    const detail = stderr.trim() || (e && e.message) || 'unknown';
    throw new Error(
      "az CLI not authenticated or not installed. Run 'az login' first. " +
      `Detail: ${detail}`
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(typeof raw === 'string' ? raw : (raw || '').toString());
  } catch (e) {
    throw new Error('az returned non-JSON output: ' + (e && e.message));
  }
  if (!parsed || !parsed.token) {
    throw new Error('az returned no accessToken field. Run "az login" and retry.');
  }
  return {
    token: String(parsed.token),
    tenantId: parsed.tenantId ? String(parsed.tenantId) : null,
    expiresOn: parsed.expiresOn ? String(parsed.expiresOn) : null,
  };
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
 * @param {boolean} [options.verifyTenant]  If true, also resolve org tenant.
 * @param {Function} [options._execImpl]    DI hook for child_process.execSync (tests).
 * @param {Function} [options._makeRequestImpl] DI hook for HTTP calls (tests).
 * @returns {Promise<object>}
 */
async function getAdoToken({ organization, verifyTenant, _execImpl, _makeRequestImpl } = {}) {
  if (verifyTenant && !organization) {
    return { ok: false, error: '--organization is required when --verifyTenant is set' };
  }

  let tokenInfo;
  try {
    tokenInfo = defaultAzGetTokenImpl(_execImpl);
  } catch (e) {
    return { ok: false, error: e.message };
  }

  const out = {
    ok: true,
    token: tokenInfo.token,
    tokenType: 'OAuth',
    tenantId: tokenInfo.tenantId,
    expiresOn: tokenInfo.expiresOn,
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
    headers: { Authorization: `Bearer ${tokenInfo.token}`, Accept: 'application/json' },
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

  if (tokenInfo.tenantId && adoOrgTenantId.toLowerCase() !== tokenInfo.tenantId.toLowerCase()) {
    out.tenantMismatch = true;
    out.hint =
      `The az-signed-in tenant (${tokenInfo.tenantId}) does not match the ADO org ` +
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
