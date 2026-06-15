#!/usr/bin/env node

// Acquires a Microsoft Entra-issued bearer token scoped to Azure DevOps via
// `az account get-access-token`. Used by `git-configure` Phase 1 (auth
// preflight) and Phase 2 (ADO permission / repo-init preflights) to replace
// the PAT prompt.
//
// Azure DevOps accepts both PATs (Basic auth) and Entra OAuth bearer tokens
// for its REST APIs. The ADO Entra application has a tenant-invariant ID:
//   499b84ac-1321-427f-aa17-267ca6975798
// This GUID is the same in every tenant and is the documented resource
// identifier for ADO API access. See:
//   https://learn.microsoft.com/azure/devops/integrate/get-started/authentication/entra
//
// Output (JSON to stdout):
//   Default (NO --writeToFile, NO --mask) — back-compat:
//   {
//     "ok":             true,
//     "token":          "<jwt>",                // raw token; legacy callers consume this
//     "tokenType":      "OAuth",
//     "tenantId":       "<guid from az>",
//     "expiresOn":      "<ISO 8601>",
//     "adoOrgTenantId": "<guid|null>",   // populated only with --verifyTenant
//     "tenantMismatch": false,
//     "hint":           null | "<message>"
//   }
//
//   With --writeToFile <path>:
//     • File at <path> receives the FULL JSON payload (incl. "token") and is
//       chmod'd to 0o600 (best-effort on Windows — NTFS ACL inheritance applies).
//     • Stdout receives the same shape MINUS "token", PLUS:
//         "tokenFile":   "<absolute path>",
//         "tokenSha256": "<hex digest of the raw token>"
//
//   With --mask (no file write):
//     • Stdout receives the same shape MINUS "token", PLUS "tokenSha256".
//
//   --writeToFile and --mask may be combined — both effects apply.
//
//   On failure: { "ok": false, "error": "<message>" }
//
// Usage:
//   node get-ado-token.js [--organization <adoOrg>] [--verifyTenant]
//                         [--writeToFile <path>] [--mask]
//
// Security:
//   - When invoked from interactive AI-agent contexts, ALWAYS pass
//     --writeToFile so the raw token never enters stdout (which is captured
//     in session event logs). The agent then reads the token from <path>
//     and passes it to downstream helpers via --token, never echoing the
//     file's contents to user-visible output.
//   - The file mode 0o600 is set via fs.chmodSync. On POSIX this fully
//     restricts to the owner. On Windows fs.chmod is a partial no-op (chmod
//     does not map cleanly to NTFS ACLs) — keep the file under a path that
//     is .gitignored and not synced to OneDrive / cloud backup.
//   - tokenSha256 lets callers verify the file's contents match an
//     expected token without ever reading the raw token themselves.
//   - Default behavior (no --writeToFile, no --mask) is preserved for
//     back-compat with scripts that already consume `.token` from stdout
//     (e.g. pre-2026-06-11 callers). New skill code MUST use --writeToFile.

'use strict';

const { execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { makeRequest } = require('./validation-helpers');

const ADO_ENTRA_RESOURCE_GUID = '499b84ac-1321-427f-aa17-267ca6975798';

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { organization: null, verifyTenant: false, writeToFile: null, mask: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--organization' && args[i + 1]) opts.organization = args[++i];
    else if (args[i] === '--verifyTenant') opts.verifyTenant = true;
    else if (args[i] === '--writeToFile' && args[i + 1]) opts.writeToFile = args[++i];
    else if (args[i] === '--mask') opts.mask = true;
  }
  return opts;
}

/**
 * SHA-256 hex digest of the token string. Exposed so callers can verify a
 * token file's contents without ever reading the raw token themselves.
 *
 * @param {string} token
 * @returns {string} 64-char lowercase hex
 */
function sha256Hex(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Writes the token payload to disk with restrictive permissions.
 *
 * POSIX: mode 0o600 (owner read/write only).
 * Windows: NTFS ignores the POSIX mode and the file inherits the parent
 *   directory's ACL — which in a shared host may grant other principals
 *   (BUILTIN\Users, Authenticated Users). We therefore actively lock the ACL
 *   down with `icacls`: disable inheritance and grant Full control only to the
 *   current user (plus SYSTEM, which the OS needs). This guarantees the token
 *   file is owner-only regardless of where it is written.
 *
 * @param {string} filePath
 * @param {object} payload Full payload incl. "token"
 * @param {object} [deps]
 * @param {(cmd: string) => void} [deps._execImpl]  DI for the icacls call (tests).
 * @param {string} [deps._platform]                 DI for process.platform (tests).
 * @returns {string} Absolute path actually written
 */
function writeTokenFile(filePath, payload, { _execImpl, _platform } = {}) {
  const abs = path.resolve(filePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  // Write with explicit 0o600 mode so the file is owner-only from the moment
  // it's created (POSIX). On Windows the mode argument is largely ignored.
  fs.writeFileSync(abs, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
  // Defence-in-depth: chmod after write in case writeFileSync mode was ignored.
  try { fs.chmodSync(abs, 0o600); } catch (_) { /* best-effort */ }

  const platform = _platform || process.platform;
  if (platform === 'win32') {
    // Strip inherited ACEs and grant only the current user + SYSTEM. Without
    // this, a token file written under a shared path inherits Users/Authenticated
    // Users read access — a credential-leak footgun on multi-user hosts.
    const exec = _execImpl || ((cmd) => execSync(cmd, { stdio: 'ignore' }));
    const user = process.env.USERNAME
      ? `${process.env.USERDOMAIN || process.env.COMPUTERNAME || '.'}\\${process.env.USERNAME}`
      : null;
    try {
      const grants = user ? `/grant:r "${user}:F" ` : '';
      exec(`icacls "${abs}" /inheritance:r ${grants}/grant:r "SYSTEM:F"`);
    } catch (_) { /* best-effort: chmod above is the POSIX fallback */ }
  }
  return abs;
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
 * Strips the raw token from a result object and (optionally) adds a sha256
 * digest + token-file path. Used to compose the safe stdout payload when
 * --writeToFile or --mask is set.
 *
 * @param {object} result   Full result object from getAdoToken (incl. `token`)
 * @param {object} options
 * @param {string} [options.tokenFile]  Absolute path the token was written to
 * @param {boolean} [options.includeSha256]  Whether to compute + include the digest
 * @returns {object} A new object without `token`
 */
function redactResult(result, { tokenFile = null, includeSha256 = false } = {}) {
  const { token, ...rest } = result;
  const safe = { ...rest };
  if (tokenFile) safe.tokenFile = tokenFile;
  if (includeSha256 && typeof token === 'string') safe.tokenSha256 = sha256Hex(token);
  return safe;
}

/**
 * @param {object} options
 * @param {string} [options.organization]   ADO org name; required with verifyTenant.
 * @param {boolean} [options.verifyTenant]  If true, also resolve org tenant.
 * @param {string} [options.writeToFile]    If set, write the full payload here (0o600)
 *                                          and return a redacted result without `token`
 *                                          but with `tokenFile` + `tokenSha256`.
 * @param {boolean} [options.mask]          If true, return a redacted result with
 *                                          `tokenSha256` (no `token`). Combinable with
 *                                          writeToFile (both effects apply).
 * @param {Function} [options._execImpl]    DI hook for child_process.execSync (tests).
 * @param {Function} [options._makeRequestImpl] DI hook for HTTP calls (tests).
 * @param {Function} [options._writeToFileImpl] DI hook for the file-write step (tests).
 * @returns {Promise<object>}
 */
async function getAdoToken({ organization, verifyTenant, writeToFile, mask, _execImpl, _makeRequestImpl, _writeToFileImpl } = {}) {
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

  // Helper: apply --writeToFile + --mask effects on the full result `r`.
  // Always called at every successful return path so the contract is uniform.
  const applyRedaction = (r) => {
    if (!writeToFile && !mask) return r;
    let tokenFile = null;
    if (writeToFile) {
      const writer = typeof _writeToFileImpl === 'function' ? _writeToFileImpl : writeTokenFile;
      // The file payload mirrors the full result (incl. token) but excludes
      // transient stdout-only fields like `hint`. Callers reading the file
      // get the canonical token bundle.
      const filePayload = {
        token: r.token,
        tokenType: r.tokenType,
        tenantId: r.tenantId,
        expiresOn: r.expiresOn,
        adoOrgTenantId: r.adoOrgTenantId,
        tenantMismatch: r.tenantMismatch,
      };
      tokenFile = writer(writeToFile, filePayload);
    }
    return redactResult(r, { tokenFile, includeSha256: true });
  };

  if (!verifyTenant) return applyRedaction(out);

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
    return applyRedaction(out);
  }
  if (!res || res.statusCode !== 200) {
    out.hint =
      `tenant verification skipped — connectionData returned HTTP ${res && res.statusCode}. ` +
      'Proceeding without tenant cross-check.';
    return applyRedaction(out);
  }

  let body;
  try { body = JSON.parse(res.body); }
  catch {
    out.hint = 'tenant verification skipped — could not parse connectionData response.';
    return applyRedaction(out);
  }

  const adoOrgTenantId = extractTenantIdFromConnectionData(body);
  out.adoOrgTenantId = adoOrgTenantId;

  if (!adoOrgTenantId) {
    out.hint =
      'tenant verification skipped — could not extract org tenant from connectionData.';
    return applyRedaction(out);
  }

  if (tokenInfo.tenantId && adoOrgTenantId.toLowerCase() !== tokenInfo.tenantId.toLowerCase()) {
    out.tenantMismatch = true;
    out.hint =
      `The az-signed-in tenant (${tokenInfo.tenantId}) does not match the ADO org ` +
      `"${organization}" home tenant (${adoOrgTenantId}). Run ` +
      `\`az login --tenant ${adoOrgTenantId}\` and retry.`;
  }

  return applyRedaction(out);
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
  sha256Hex,
  writeTokenFile,
  redactResult,
};
