'use strict';

const { execFileSync } = require('child_process');
const {
  getAuthToken,
  parseActiveAuthListEnvironmentUrl,
  parseEnvironmentUrl,
  runAzureCli,
  validateDataverseEnvironmentUrl,
} = require('./validation-helpers');

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

function runPacAuthWho({ execFile = execFileSync, platform = process.platform } = {}) {
  if (platform === 'win32') {
    // PAC installs as pac.exe on Windows. Route through cmd.exe so PATH lookup
    // matches the user's terminal while keeping the executable literal fixed for
    // the secure-process validator.
    return execFile('cmd.exe', ['/d', '/s', '/c', 'pac.exe', 'auth', 'who'], { encoding: 'utf8', timeout: 15000 });
  }
  return execFile('pac', ['auth', 'who'], { encoding: 'utf8', timeout: 15000 });
}

function runPacEnvWho({ execFile = execFileSync, platform = process.platform } = {}) {
  if (platform === 'win32') {
    return execFile('cmd.exe', ['/d', '/s', '/c', 'pac.exe', 'env', 'who'], { encoding: 'utf8', timeout: 15000 });
  }
  return execFile('pac', ['env', 'who'], { encoding: 'utf8', timeout: 15000 });
}

function runPacAuthList({ execFile = execFileSync, platform = process.platform } = {}) {
  if (platform === 'win32') {
    return execFile('cmd.exe', ['/d', '/s', '/c', 'pac.exe', 'auth', 'list'], { encoding: 'utf8', timeout: 15000 });
  }
  return execFile('pac', ['auth', 'list'], { encoding: 'utf8', timeout: 15000 });
}

function runAzAccountShowTenant({ execFile = execFileSync, platform = process.platform } = {}) {
  return runAzureCli(
    ['account', 'show', '--query', 'tenantId', '-o', 'tsv'],
    { execFile, platform }
  );
}

function getPacTenantId(execFile = execFileSync, platform = process.platform) {
  try {
    return parsePacTenantId(runPacAuthWho({ execFile, platform }));
  } catch {
    return null;
  }
}

function getAzAccountTenantId(execFile = execFileSync, platform = process.platform) {
  try {
    return normalizeGuid(runAzAccountShowTenant({ execFile, platform }));
  } catch {
    return null;
  }
}

function getPacEnvironmentUrl(execFile = execFileSync, platform = process.platform) {
  try {
    const environmentUrl = parseEnvironmentUrl(runPacEnvWho({ execFile, platform }));
    if (environmentUrl) return environmentUrl;
  } catch {}
  try {
    return parseActiveAuthListEnvironmentUrl(runPacAuthList({ execFile, platform }));
  } catch {
    return null;
  }
}

function validateCliTenantAlignment({
  envUrl,
  token,
  pacTenantId,
  azTenantId,
  tokenTenantId,
  pacEnvironmentUrl,
} = {}, deps = {}) {
  const execFile = deps.execFile || execFileSync;
  const platform = deps.platform || process.platform;
  let expectedEnvironmentUrl = null;
  if (envUrl) {
    try {
      expectedEnvironmentUrl = validateDataverseEnvironmentUrl(envUrl);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
  const activeEnvironmentUrl = expectedEnvironmentUrl
    ? (pacEnvironmentUrl
        ? (() => {
            try { return validateDataverseEnvironmentUrl(pacEnvironmentUrl); } catch { return null; }
          })()
        : getPacEnvironmentUrl(execFile, platform))
    : null;
  const pacTenant = normalizeGuid(pacTenantId) || getPacTenantId(execFile, platform);
  const azTenant = normalizeGuid(azTenantId) || getAzAccountTenantId(execFile, platform);
  const bearerToken = token || (expectedEnvironmentUrl
    ? (deps.getAuthToken
        ? deps.getAuthToken(expectedEnvironmentUrl)
        : getAuthToken(expectedEnvironmentUrl, { execFile, platform }))
    : null);
  const tokenTenant = normalizeGuid(tokenTenantId) || tenantIdFromToken(bearerToken);

  const missing = [];
  if (expectedEnvironmentUrl && !activeEnvironmentUrl) missing.push('pacEnvironmentUrl');
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
      expectedEnvironmentUrl,
      pacEnvironmentUrl: activeEnvironmentUrl,
    };
  }

  const mismatches = [];
  if (expectedEnvironmentUrl && expectedEnvironmentUrl !== activeEnvironmentUrl) {
    mismatches.push('pac-vs-environment');
  }
  if (pacTenant !== azTenant) mismatches.push('pac-vs-az');
  if (pacTenant !== tokenTenant) mismatches.push('pac-vs-token');
  if (azTenant !== tokenTenant) mismatches.push('az-vs-token');

  return {
    ok: mismatches.length === 0,
    pacTenantId: pacTenant,
    azTenantId: azTenant,
    tokenTenantId: tokenTenant,
    expectedEnvironmentUrl,
    pacEnvironmentUrl: activeEnvironmentUrl,
    mismatches,
    error: mismatches.length
      ? 'PAC CLI and Azure CLI are authenticated to different tenants or environments. Switch PAC auth or Azure CLI tenant before continuing.'
      : null,
  };
}

module.exports = {
  decodeJwtPayload,
  parsePacTenantId,
  runAzAccountShowTenant,
  runPacAuthList,
  runPacAuthWho,
  runPacEnvWho,
  tenantIdFromToken,
  validateCliTenantAlignment,
};
