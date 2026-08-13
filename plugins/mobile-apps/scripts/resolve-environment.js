#!/usr/bin/env node

// Resolves a Power Platform environment URL or ID through Azure CLI and Dataverse APIs.
// Usage: node scripts/resolve-environment.js <environment-url-or-id>
// Output: JSON with environmentUrl, environmentId, tenantId, and displayName when available.

const { execFileSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const path = require('path');

const BAP_RESOURCE = 'https://api.bap.microsoft.com';
const BAP_TOKEN_FALLBACK_RESOURCE = 'https://service.powerapps.com/';
const BAP_API_VERSION = '2020-10-01';
const BAP_HOST = 'https://api.bap.microsoft.com';
const CACHE_FILE = '.resolved-environment.json';
const AUTH_CONFIG_FILE = 'auth.config.json';
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeUrl(value) {
  return value.replace(/\/+$/, '');
}

function isUrl(value) {
  return /^https:\/\//i.test(value);
}

function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function cacheMatchesTarget(cache, target) {
  if (!cache || !cache.environmentUrl) return false;
  if (!target) return true;
  if (GUID_RE.test(target)) {
    return Boolean(cache.environmentId && cache.environmentId.toLowerCase() === target.toLowerCase());
  }
  if (isUrl(target)) {
    return normalizeUrl(cache.environmentUrl).toLowerCase() === normalizeUrl(target).toLowerCase();
  }
  return false;
}

function readCachedResolution(target) {
  const sidecarCache = readJsonFile(path.join(process.cwd(), CACHE_FILE));
  const authConfig = readJsonFile(path.join(process.cwd(), AUTH_CONFIG_FILE));
  const authCache = authConfig && authConfig.environment ? authConfig.environment : null;
  for (const cache of [sidecarCache, authCache]) {
    if (cacheMatchesTarget(cache, target)) return cache;
  }
  return null;
}

function hasCachedEnvironmentDetails(value) {
  return Boolean(value && value.environmentUrl && value.tenantId);
}

function toEnvironmentResult(value, source) {
  return {
    environmentUrl: value.environmentUrl,
    environmentId: value.environmentId || null,
    displayName: value.displayName || null,
    tenantId: value.tenantId || null,
    source,
  };
}

function shouldWriteCache(result) {
  return Boolean(result && result.environmentId && result.environmentUrl
    && fs.existsSync(path.join(process.cwd(), AUTH_CONFIG_FILE)));
}

function writeCacheIfProject(result) {
  if (!shouldWriteCache(result)) return;
  const cachePath = path.join(process.cwd(), CACHE_FILE);
  const cache = { ...result, cachedAt: new Date().toISOString() };
  fs.writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`);

  const authPath = path.join(process.cwd(), AUTH_CONFIG_FILE);
  const authConfig = readJsonFile(authPath);
  if (authConfig && typeof authConfig === 'object') {
    authConfig.environment = cache;
    fs.writeFileSync(authPath, `${JSON.stringify(authConfig, null, 2)}\n`);
  }
}

function printResult(result) {
  console.log(JSON.stringify(result, null, 2));
}

function getAzTenantId() {
  try {
    return execFileSync('az', ['account', 'show', '--query', 'tenantId', '-o', 'tsv'], {
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
}

function getAzToken(resource, tenantId = null) {
  const args = ['account', 'get-access-token'];
  if (tenantId) args.push('--tenant', tenantId);
  args.push('--resource', resource, '--query', 'accessToken', '-o', 'tsv');
  try {
    return execFileSync('az', args, {
      encoding: 'utf8',
      timeout: 20000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
}

function requestJson(url, token = null, timeout = 20000) {
  return new Promise((resolve) => {
    const req = https.request(url, {
      method: 'GET',
      headers: token ? { Authorization: `Bearer ${token}`, Accept: 'application/json' } : { Accept: 'application/json' },
      timeout,
    }, (res) => {
      let body = '';
      res.on('data', chunk => (body += chunk));
      res.on('end', () => {
        let data = null;
        try { data = body ? JSON.parse(body) : null; } catch { data = body; }
        resolve({ statusCode: res.statusCode, headers: res.headers, data });
      });
    });
    req.on('error', error => resolve({ error: error.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ error: 'request timed out' });
    });
    req.end();
  });
}

function extractTenantFromAuthenticate(header) {
  if (!header) return null;
  const value = Array.isArray(header) ? header.join(',') : String(header);
  const patterns = [
    /authorization_uri="https:\/\/login\.microsoftonline\.com\/([^/"\s]+)\//i,
    /authorization="https:\/\/login\.microsoftonline\.com\/([^/"\s]+)\//i,
    /https:\/\/login\.microsoftonline\.com\/([^/"\s]+)\//i,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match && !['common', 'organizations', 'consumers'].includes(match[1])) return match[1];
  }
  return null;
}

async function getTenantFromDataverseChallenge(environmentUrl) {
  const res = await requestJson(`${normalizeUrl(environmentUrl)}/api/data/v9.2/`, null, 10000);
  return extractTenantFromAuthenticate(res.headers && res.headers['www-authenticate']);
}

function buildEnvironmentApiUrl(environmentId) {
  return `${BAP_HOST}/providers/Microsoft.BusinessAppPlatform/scopes/admin/environments/${encodeURIComponent(environmentId.toLowerCase())}?api-version=${BAP_API_VERSION}`;
}

function normalizeDataverseUrl(value) {
  if (!value || typeof value !== 'string' || !/^https:\/\//i.test(value)) return null;
  const apiIndex = value.toLowerCase().indexOf('/api/data/');
  const baseUrl = apiIndex >= 0 ? value.slice(0, apiIndex) : value;
  return normalizeUrl(baseUrl);
}

function findDataverseUrl(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    return /\.crm\d*\.dynamics\.com\b/i.test(value) ? normalizeDataverseUrl(value) : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDataverseUrl(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) {
      const found = findDataverseUrl(item);
      if (found) return found;
    }
  }
  return null;
}

function pickEnvironmentRecord(data, environmentId) {
  const candidates = Array.isArray(data && data.value) ? data.value : [data];
  return candidates.find((item) => {
    if (!item || typeof item !== 'object') return false;
    return [item.name, item.id, item.environmentId, item.properties && item.properties.environmentId]
      .filter(Boolean)
      .some(candidate => String(candidate).toLowerCase().includes(environmentId.toLowerCase()));
  }) || candidates.find(item => item && typeof item === 'object') || null;
}

function environmentFromPowerPlatformPayload(payload, environmentId) {
  const props = payload.properties || {};
  const linked = props.linkedEnvironmentMetadata || {};
  const environmentUrl = normalizeDataverseUrl(linked.instanceUrl)
    || normalizeDataverseUrl(props.instanceUrl)
    || normalizeDataverseUrl(payload.instanceUrl)
    || findDataverseUrl(payload);
  return {
    environmentId: payload.name || props.environmentId || payload.environmentId || environmentId || null,
    displayName: props.displayName || linked.friendlyName || null,
    environmentUrl,
    tenantId: (props.createdBy && props.createdBy.tenantId) || props.tenantId || linked.tenantId || null,
  };
}

async function resolveEnvironmentId(environmentId, tenantId) {
  const token = getAzToken(BAP_RESOURCE, tenantId)
    || getAzToken(BAP_TOKEN_FALLBACK_RESOURCE, tenantId)
    || getAzToken(BAP_RESOURCE)
    || getAzToken(BAP_TOKEN_FALLBACK_RESOURCE);
  if (!token) throw new Error('Could not get Azure CLI token for the BAP admin API. Run az login and retry.');

  const endpointUrl = buildEnvironmentApiUrl(environmentId);
  const res = await requestJson(endpointUrl, token);
  if (res.statusCode === 200 && res.data) {
    const record = pickEnvironmentRecord(res.data, environmentId);
    if (record) return environmentFromPowerPlatformPayload(record, environmentId);
  }

  const apiMessage = res.data && typeof res.data === 'object'
    ? [res.data.code, res.data.message, res.data.innererror && res.data.innererror.message].filter(Boolean).join(': ')
    : res.error || `HTTP ${res.statusCode}`;
  const recovery = /Forbidden|Unauthorized|Authorization|permission|privilege|Insufficient/i.test(apiMessage || '')
    ? ' The Azure CLI account may not have permission to read this environment through the BAP admin API. Use an account with environment read access, or provide the Dataverse environment URL directly.'
    : '';
  throw new Error(`Could not resolve environment ID ${environmentId} through ${endpointUrl}: ${apiMessage || 'unknown error'}.${recovery}`);
}

async function main() {
  const target = process.argv[2];
  if (!target) {
    process.stderr.write('Usage: node scripts/resolve-environment.js <environment-url-or-id>\nPass the environment ID from power.config.json, or pass the Dataverse environment URL directly.\n');
    process.exit(1);
  }

  const cached = readCachedResolution(target);
  if (hasCachedEnvironmentDetails(cached)) {
    const result = toEnvironmentResult(cached, 'cache');
    writeCacheIfProject(result);
    printResult(result);
    return;
  }

  const loginTenantId = getAzTenantId();
  let resolved;
  if (isUrl(target)) {
    const normalizedUrl = normalizeUrl(target);
    const challengeTenant = await getTenantFromDataverseChallenge(normalizedUrl);
    resolved = {
      environmentUrl: normalizedUrl,
      environmentId: cached && cached.environmentId ? cached.environmentId : null,
      displayName: cached && cached.displayName ? cached.displayName : null,
      tenantId: challengeTenant || (cached && cached.tenantId) || null,
    };
  } else if (GUID_RE.test(target)) {
    try {
      resolved = await resolveEnvironmentId(target, loginTenantId);
    } catch (error) {
      if (cached && cached.environmentUrl) {
        resolved = {
          environmentUrl: cached.environmentUrl,
          environmentId: cached.environmentId || target,
          displayName: cached.displayName || null,
          tenantId: cached.tenantId || null,
          source: 'cache-refresh',
        };
      } else {
        throw error;
      }
    }
  } else {
    throw new Error(`Expected an HTTPS environment URL or environment GUID, got: ${target}`);
  }

  if (!resolved.environmentUrl) {
    throw new Error('Environment URL was not present in the Power Platform environment metadata. Provide the Dataverse URL directly.');
  }

  if (!resolved.tenantId) {
    resolved.tenantId = await getTenantFromDataverseChallenge(resolved.environmentUrl);
  }

  const result = toEnvironmentResult(resolved, resolved.source || (isUrl(target) ? 'environment-url' : 'environment-id'));
  writeCacheIfProject(result);
  printResult(result);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});