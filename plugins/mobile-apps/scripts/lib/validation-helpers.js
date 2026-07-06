#!/usr/bin/env node

// Shared utilities for Power Pages validation hook scripts.
// Provides common boilerplate so each validator only contains its unique logic.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Exit 0 = success (allow). Exit 2 = blocking error (stderr is fed back to Claude).
const approve = () => { process.exit(0); };
const block = (reason) => {
  process.stderr.write(reason);
  process.exit(2);
};

/**
 * Wraps stdin JSON parsing and try/catch boilerplate.
 * Calls `callback(cwd)` with the parsed working directory.
 * Approves automatically if cwd is missing or on any uncaught error.
 */
function runValidation(callback) {
  let inputData = '';
  process.stdin.on('data', chunk => (inputData += chunk));
  process.stdin.on('end', async () => {
    try {
      const input = JSON.parse(inputData);
      const cwd = input.cwd;
      if (!cwd) approve();
      await callback(cwd);
    } catch {
      approve();
    }
  });
}

/**
 * Searches for a file or directory in `dir` and one level of subdirectories.
 * @param {string} dir - Starting directory
 * @param {string} target - Relative path to look for (e.g. 'powerpages.config.json')
 * @returns {string|null} Full path if found, null otherwise
 */
function findPath(dir, target) {
  const direct = path.join(dir, target);
  if (fs.existsSync(direct)) return direct;

  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
        const sub = path.join(dir, entry.name, target);
        if (fs.existsSync(sub)) return sub;
      }
    }
  } catch {}

  return null;
}

/**
 * Finds the project root directory (containing powerpages.config.json).
 * @returns {string|null} Project root path, or null
 */
function findProjectRoot(dir) {
  let current = path.resolve(dir);
  while (true) {
    const configPath = path.join(current, 'powerpages.config.json');
    if (fs.existsSync(configPath)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  const fallbackConfigPath = findPath(dir, 'powerpages.config.json');
  return fallbackConfigPath ? path.dirname(fallbackConfigPath) : null;
}

/**
 * Finds a subdirectory inside .powerpages-site/.
 * @param {string} dir - Starting directory
 * @param {string} subdir - Subdirectory name (e.g. 'site-settings', 'web-roles')
 * @returns {string|null} Full path to the subdirectory, or null
 */
function findPowerPagesSiteDir(dir, subdir) {
  return findPath(dir, path.join('.powerpages-site', subdir));
}

/** UUID v4 validation regex */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Extracts the Dataverse tenant from the environment's WWW-Authenticate challenge.
 * @returns {Promise<string|null>} Tenant GUID/name, or null if unavailable
 */
async function getDataverseTenantFromChallenge(resourceUrl) {
  const normalizedUrl = resourceUrl.replace(/\/+$/, '');
  const res = await makeRequest({
    url: `${normalizedUrl}/api/data/v9.2/WhoAmI`,
    includeHeaders: true,
    timeout: 10000,
  });
  const header = res.headers && res.headers['www-authenticate'];
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

function getAzAccountTenantId() {
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

function getAzAccessToken(resourceUrl, tenantId = null) {
  const args = ['account', 'get-access-token'];
  if (tenantId) args.push('--tenant', tenantId);
  args.push('--resource', resourceUrl, '--query', 'accessToken', '-o', 'tsv');
  try {
    return execFileSync('az', args, {
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Gets an Azure CLI access token for the given resource URL.
 * Targets the env's tenant from Dataverse auth challenge when available.
 * Falls back to the active az tenant and then unqualified az token lookup.
 * @returns {Promise<string|null>} Access token, or null if unavailable
 */
async function getAuthToken(resourceUrl) {
  const tenantCandidates = [
    process.env.POWER_PLATFORM_TENANT_ID,
    process.env.DATAVERSE_TENANT_ID,
    await getDataverseTenantFromChallenge(resourceUrl),
    getAzAccountTenantId(),
  ].filter(Boolean);

  for (const tenantId of [...new Set(tenantCandidates)]) {
    const token = getAzAccessToken(resourceUrl, tenantId);
    if (token) return token;
  }

  return getAzAccessToken(resourceUrl);
}

/**
 * Gets the environment URL from explicit environment variables.
 * @returns {string|null} Environment URL, or null
 */
function getEnvironmentUrl() {
  const value = process.env.POWER_PLATFORM_ENVIRONMENT_URL
    || process.env.DATAVERSE_ENVIRONMENT_URL
    || process.env.ENVIRONMENT_URL;
  return value ? value.replace(/\/+$/, '') : null;
}

function getEnvironmentId() {
  const value = process.env.POWER_PLATFORM_ENVIRONMENT_ID
    || process.env.DATAVERSE_ENVIRONMENT_ID
    || process.env.ENVIRONMENT_ID;
  if (value) return value;
  try {
    const configPath = path.join(process.cwd(), 'power.config.json');
    if (!fs.existsSync(configPath)) return null;
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return config.environmentId || null;
  } catch {
    return null;
  }
}

/**
 * Makes an HTTP/HTTPS request using Node.js built-in modules (cross-platform, no PowerShell).
 * Returns a Promise — callers must use `await`.
 * @param {object} options
 * @param {string} options.url - Full URL to request
 * @param {string} [options.method='GET'] - HTTP method
 * @param {object} [options.headers={}] - Request headers
 * @param {string} [options.body=null] - Request body (string)
 * @param {boolean} [options.includeHeaders=false] - Include response headers in result
 * @param {number} [options.timeout=15000] - Timeout in ms
 * @returns {Promise<{ statusCode: number, body: string, headers?: object } | { error: string }>}
 */
function makeRequest({ url, method = 'GET', headers = {}, body = null, includeHeaders = false, timeout = 15000 }) {
  return new Promise((resolve) => {
    const https = require('https');
    const http = require('http');
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        method,
        headers,
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
        timeout,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          const result = { statusCode: res.statusCode, body: data };
          if (includeHeaders) result.headers = res.headers;
          resolve(result);
        });
      }
    );
    req.on('error', (e) => resolve({ error: e.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ error: 'Request timed out' });
    });
    if (body) req.write(body);
    req.end();
  });
}

// ── Publisher prefix detection ───────────────────────────────────────────────

/**
 * System / first-party publisher prefixes to ignore when scanning custom
 * entities — these belong to Microsoft solutions and are not the org's
/** Cloud → Power Platform API base URL mapping */
const CLOUD_TO_API = {
  'Public': 'https://api.powerplatform.com',
  'UsGov': 'https://api.gov.powerplatform.microsoft.us',
  'UsGovHigh': 'https://api.high.powerplatform.microsoft.us',
  'UsGovDod': 'https://api.appsplatform.us',
  'China': 'https://api.powerplatform.partner.microsoftonline.cn',
};

/** Cloud → Power Pages site URL domain mapping */
const CLOUD_TO_SITE_DOMAIN = {
  'Public': 'powerappsportals.com',
  'UsGov': 'powerappsportals.us',
  'UsGovHigh': 'high.powerappsportals.us',
  'UsGovDod': 'appsplatform.us',
  'China': 'powerappsportals.cn',
};

module.exports = {
  approve,
  block,
  runValidation,
  findPath,
  findProjectRoot,
  findPowerPagesSiteDir,
  UUID_REGEX,
  getAuthToken,
  getAzAccessToken,
  getDataverseTenantFromChallenge,
  makeRequest,
  getEnvironmentUrl,
  getEnvironmentId,
  CLOUD_TO_API,
  CLOUD_TO_SITE_DOMAIN,
};
