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
async function getDataverseTenantFromChallenge(resourceUrl, options = {}) {
  let normalizedUrl;
  try {
    normalizedUrl = module.exports.validateDataverseEnvironmentUrl(resourceUrl, 'Azure CLI token resolution', options);
  } catch (err) {
    return null;
  }
  const res = await module.exports.makeRequest({
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
 * @param {string} resourceUrl Dataverse resource URL to request a token for
 * @param {string|null} explicitTenantId Resolved environment tenant; skips tenant discovery when valid
 * @returns {Promise<string|null>} Access token, or null if unavailable
 */
async function getAuthToken(resourceUrl, explicitTenantId = null, options = {}) {
  // Validate origin early before any HTTP probe or Azure CLI invocation
  module.exports.validateDataverseEnvironmentUrl(resourceUrl, 'Azure CLI token resolution', options);

  // Candidates are produced LAZILY, in priority order. This used to be an array
  // literal, and an array literal evaluates every element before `.filter()`
  // runs — so each call paid for the WWW-Authenticate probe AND an
  // `az account show` spawn even when an env var already supplied the tenant.
  // `az account show` measured ~4.9s on a warm macOS box (it resolves the whole
  // subscription context, not just the tenant), and a single data-model run
  // issues dozens of Dataverse calls, so that dominated wall-clock time.
  // Short-circuiting preserves the exact preference order and fallback below —
  // it only skips work once a candidate has already minted a token.
  const candidateProducers = [
    () => explicitTenantId,
    () => process.env.POWER_PLATFORM_TENANT_ID,
    () => process.env.DATAVERSE_TENANT_ID,
    () => getDataverseTenantFromChallenge(resourceUrl, options),
    () => getAzAccountTenantId(),
  ];

  // Mirrors the previous `.filter(Boolean)` + `new Set(...)` de-duplication:
  // skip empty candidates, and never re-attempt a tenant an earlier producer
  // already tried (common when the env var and the az account agree).
  const attempted = new Set();
  for (const produce of candidateProducers) {
    // Producers are a mix of sync and async; `await` normalizes both.
    const tenantId = await produce();
    if (!tenantId || attempted.has(tenantId)) continue;
    attempted.add(tenantId);
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

const DATAVERSE_HOST_PATTERNS = [
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:api\.)?crm\d*\.dynamics\.com$/,
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:api\.)?crm\.microsoftdynamics\.us$/,
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:api\.)?crm\.appsplatform\.us$/,
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:api\.)?crm\.dynamics\.cn$/,
];

function isDataverseHost(hostname) {
  return DATAVERSE_HOST_PATTERNS.some((pattern) => pattern.test(hostname));
}

function parseTrustedMicrosoftUrl(value, {
  purpose = 'URL',
  allowPath = true,
  allowedHost = (hostname) => isDataverseHost(hostname),
  allowLoopback = false,
} = {}) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${purpose} must be a non-empty string.`);
  }

  if (/[\u0000-\u001f\u007f\\]/.test(value)) {
    throw new Error(`${purpose} contains control characters or backslashes.`);
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${purpose} is not a valid URL.`);
  }

  const isLoopback = allowLoopback === true && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost');
  if (!isLoopback && parsed.protocol !== 'https:') {
    throw new Error(`${purpose} must use HTTPS.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${purpose} must not contain credentials.`);
  }
  if (parsed.hash) {
    throw new Error(`${purpose} must not contain a fragment.`);
  }

  const authorityMatch = new RegExp('^https?://([^/?#]*)', 'i').exec(value);
  if (!authorityMatch) {
    throw new Error(`${purpose} must use HTTPS.`);
  }
  const authority = authorityMatch[1];
  if (!isLoopback && authority.includes(':')) {
    throw new Error(`${purpose} must not contain a port.`);
  }
  if (!isLoopback && (!/^[A-Za-z0-9.-]+$/.test(authority) || parsed.hostname.includes('xn--'))) {
    throw new Error(`${purpose} contains unsafe host characters.`);
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!allowedHost(hostname)) {
    throw new Error(`${purpose} host "${hostname}" is not an allowed Microsoft Dataverse endpoint.`);
  }
  if (!allowPath && (parsed.pathname !== '/' || parsed.search)) {
    throw new Error(`${purpose} must be an HTTPS origin without a path or query.`);
  }

  return parsed;
}

function validateDataverseEnvironmentUrl(value, purpose = 'Dataverse environment URL', options = {}) {
  const allowLoopback = options.allowLoopback === true;
  return parseTrustedMicrosoftUrl(value, {
    purpose,
    allowPath: false,
    allowedHost: (hostname) => {
      if (allowLoopback && (hostname === '127.0.0.1' || hostname === 'localhost')) return true;
      return isDataverseHost(hostname);
    },
    allowLoopback,
  }).origin;
}


/**
 * Validates a Dataverse OData API path to prevent path traversal and origin changes.
 * Resolves the path against the base API URL and ensures it remains within scope.
 *
 * @param {string} apiPath - The relative API path (e.g., "accounts?$top=1")
 * @param {string} trustedEnvUrl - The validated environment URL
 * @param {Object} [options] - Optional validation options
 * @returns {string} The fully resolved and validated HTTPS URL
 */
function validateDataverseApiPath(apiPath, trustedEnvUrl, options = {}) {
  if (typeof apiPath !== 'string' || apiPath.trim() === '') {
    throw new Error('Invalid apiPath: must be a non-empty string.');
  }
  if (apiPath.length > 8000) {
    throw new Error('Invalid apiPath: exceeds maximum length of 8000 characters.');
  }
  if (/[\u0000-\u001F\u007F]/.test(apiPath)) {
    throw new Error('Invalid apiPath: contains control characters.');
  }
  if (apiPath.includes('#')) {
    throw new Error('Invalid apiPath: fragments (#) are not allowed.');
  }

  // Strip exactly one leading slash for backward compatibility, if present
  let normalizedPath = apiPath;
  if (normalizedPath.startsWith('/')) {
    normalizedPath = normalizedPath.substring(1);
  }

  const API_BASE_PATH = '/api/data/v9.2/';
  const baseUrl = new URL(API_BASE_PATH, trustedEnvUrl);

  let targetUrl;
  try {
    targetUrl = new URL(normalizedPath, baseUrl);
  } catch (err) {
    throw new Error('Invalid apiPath: could not parse URL.');
  }

  if (targetUrl.origin !== baseUrl.origin) {
    throw new Error('Invalid apiPath: resolves to a different origin.');
  }
  const isLoopback = options.allowLoopback === true && (targetUrl.hostname === '127.0.0.1' || targetUrl.hostname === 'localhost');
  if (!isLoopback && targetUrl.protocol !== 'https:') {
    throw new Error('Invalid apiPath: must use HTTPS protocol.');
  }
  if (targetUrl.username || targetUrl.password) {
    throw new Error('Invalid apiPath: credentials in URL are not allowed.');
  }
  if (!targetUrl.pathname.startsWith(baseUrl.pathname)) {
    throw new Error('Invalid apiPath: resolves outside the API base path.');
  }

  // Defense in depth: reject encoded slashes/backslashes in the pathname portion
  if (/%2f|%5c/i.test(targetUrl.pathname)) {
    throw new Error('Invalid apiPath: encoded path separators are not allowed in the path.');
  }

  return targetUrl.href;
}

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
  validateDataverseApiPath,
  validateDataverseEnvironmentUrl,
};
