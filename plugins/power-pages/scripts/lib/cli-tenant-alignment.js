'use strict';

const { execFileSync } = require('child_process');
const { getAuthToken } = require('./validation-helpers');

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeGuid(value) {
  const text = String(value || '').trim();
  return GUID_RE.test(text) ? text.toLowerCase() : null;
}

function parsePacTenantId(output) {
  // PAC auth banners are label/value text and vary slightly by version, e.g.:
  //   Tenant ID:    72f988bf-86f1-41af-91ab-2d7cd011db47
  //   Tenant:       72f988bf-86f1-41af-91ab-2d7cd011db47
  // Values can have extra spaces, so parse only known tenant labels and require
  // a GUID-shaped value before trusting it.
  const match = String(output || '').match(/^\s*(?:Tenant ID|Tenant)\s*:\s*([0-9a-f-]{36})\s*$/im);
  return match ? normalizeGuid(match[1]) : null;
}

function decodeJwtPayload(token) {
  const parts = String(token || '').split('.');
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function tenantIdFromToken(token) {
  const payload = decodeJwtPayload(token);
  return normalizeGuid(payload && payload.tid);
}

function getPacTenantId(execFile = execFileSync) {
  try {
    return parsePacTenantId(execFile('pac', ['auth', 'who'], { encoding: 'utf8', timeout: 15000 }));
  } catch {
    return null;
  }
}

function getAzAccountTenantId(execFile = execFileSync) {
  try {
    return normalizeGuid(execFile('az', ['account', 'show', '--query', 'tenantId', '-o', 'tsv'], { encoding: 'utf8', timeout: 15000 }));
  } catch {
    return null;
  }
}

function validateCliTenantAlignment({ envUrl, token, pacTenantId, azTenantId, tokenTenantId } = {}, deps = {}) {
  const execFile = deps.execFile || execFileSync;
  const getToken = deps.getAuthToken || getAuthToken;
  const pacTenant = normalizeGuid(pacTenantId) || getPacTenantId(execFile);
  const azTenant = normalizeGuid(azTenantId) || getAzAccountTenantId(execFile);
  const bearerToken = token || (envUrl ? getToken(envUrl) : null);
  const tokenTenant = normalizeGuid(tokenTenantId) || tenantIdFromToken(bearerToken);

  const missing = [];
  if (!pacTenant) missing.push('pacTenantId');
  if (!azTenant) missing.push('azTenantId');
  if (!tokenTenant) missing.push('tokenTenantId');
  if (missing.length) {
    return {
      ok: false,
      error: `Could not determine ${missing.join(', ')}. Run pac auth who and az login, then retry.`,
      pacTenantId: pacTenant,
      azTenantId: azTenant,
      tokenTenantId: tokenTenant,
    };
  }

  const mismatches = [];
  if (pacTenant !== azTenant) mismatches.push('pac-vs-az');
  if (pacTenant !== tokenTenant) mismatches.push('pac-vs-token');
  if (azTenant !== tokenTenant) mismatches.push('az-vs-token');

  return {
    ok: mismatches.length === 0,
    pacTenantId: pacTenant,
    azTenantId: azTenant,
    tokenTenantId: tokenTenant,
    mismatches,
    error: mismatches.length
      ? 'PAC CLI and Azure CLI are authenticated to different tenants. Switch PAC auth or Azure CLI tenant before importing.'
      : null,
  };
}

module.exports = {
  decodeJwtPayload,
  parsePacTenantId,
  tenantIdFromToken,
  validateCliTenantAlignment,
};
