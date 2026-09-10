#!/usr/bin/env node

// Shared utilities for Power Pages validation hook scripts.
// Provides common boilerplate so each validator only contains its unique logic.

const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');

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
 * Reads the .alm-deferred marker file if present in the project root.
 * Users drop this marker when they explicitly defer ALM for a project /
 * environment so skill-completion validators stop reporting "missing
 * artifacts" — the artifacts aren't supposed to exist for this project.
 *
 * Recognized formats (any will do):
 *   - Empty file (just the touch marker)
 *   - Plain text — a one-line reason
 *   - JSON — { deferredAt, deferredBy, reason, scope: "project"|"env:<name>" }
 *
 * Returns null when not found, or an object describing the deferral when
 * present. Validators should call this before checking artifacts and
 * silent-approve when it returns non-null.
 *
 * @param {string} projectRoot
 * @returns {{ path: string, raw: string, info: object|null }|null}
 */
function readDeferralMarker(projectRoot) {
  if (!projectRoot) return null;
  const markerPath = path.join(projectRoot, '.alm-deferred');
  if (!fs.existsSync(markerPath)) return null;
  let raw = '';
  try { raw = fs.readFileSync(markerPath, 'utf8'); } catch { /* keep raw='' */ }
  let info = null;
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try { info = JSON.parse(trimmed); } catch { /* invalid JSON — treat as plain text */ }
  }
  return { path: markerPath, raw, info };
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
 * Finds the project root directory of a Power Pages site.
 *
 * A project root is marked by EITHER:
 *   - `powerpages.config.json` — code/SPA sites (`pac pages download-code-site`), OR
 *   - a `.powerpages-site/` directory — declarative design-studio sites
 *     (`pac pages download`; standard or enhanced data model). These have NO
 *     `powerpages.config.json`.
 *
 * Code sites have both markers; declarative sites have only
 * `.powerpages-site/`. Checking for either makes root discovery work for both site types.
 *
 * @returns {string|null} Project root path, or null
 */
function findProjectRoot(dir) {
  let current = path.resolve(dir);
  while (true) {
    if (fs.existsSync(path.join(current, 'powerpages.config.json')) ||
        fs.existsSync(path.join(current, '.powerpages-site'))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  // Fallback: search subdirectories for either marker (config first, then .powerpages-site/).
  const fallbackConfigPath = findPath(dir, 'powerpages.config.json');
  if (fallbackConfigPath) return path.dirname(fallbackConfigPath);
  const fallbackSiteDir = findPath(dir, '.powerpages-site');
  return fallbackSiteDir ? path.dirname(fallbackSiteDir) : null;
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

// Dataverse publishes one environment-host family per supported cloud:
//   Commercial/GCC: <org>[.api].crm{region?}.dynamics.com
//   GCC High:       <org>[.api].crm.microsoftdynamics.us
//   DoD:            <org>[.api].crm.appsplatform.us
//   China:          <org>[.api].crm.dynamics.cn
// See: https://learn.microsoft.com/power-apps/developer/data-platform/discovery-service#global-discovery-service
const DATAVERSE_HOST_PATTERNS = [
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:api\.)?crm\d*\.dynamics\.com$/,
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:api\.)?crm\.microsoftdynamics\.us$/,
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:api\.)?crm\.appsplatform\.us$/,
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:api\.)?crm\.dynamics\.cn$/,
];

// These are the first-party service hosts used by this plugin's cloud maps and
// the repository's Power Platform cloud map. Keep this exact-host list narrow:
// an Authorization header must never follow a caller-controlled URL to an
// arbitrary host just because it happens to use HTTPS.
const POWER_PLATFORM_SERVICE_HOSTS = new Set([
  'api.powerplatform.com',
  'api.gov.powerplatform.microsoft.us',
  'api.high.powerplatform.microsoft.us',
  'high.api.powerplatform.microsoft.us',
  'api.appsplatform.us',
  'dod.api.powerplatform.microsoft.us',
  'api.powerplatform.partner.microsoftonline.cn',
  'api.bap.microsoft.com',
  'gov.api.bap.microsoft.us',
  'high.api.bap.microsoft.us',
  'dod.api.bap.microsoft.us',
  'api.flow.microsoft.com',
  'gov.api.flow.microsoft.us',
  'high.gov.api.flow.microsoft.us',
  'high.api.flow.microsoft.us',
  'dod.api.flow.microsoft.us',
  'api.flow.microsoft.cn',
  'service.flow.microsoft.com',
  'gov.service.flow.microsoft.us',
  'high.gov.service.flow.microsoft.us',
  'high.service.flow.microsoft.us',
  'dod.service.flow.microsoft.us',
  'service.flow.microsoft.cn',
]);

const BAP_HOSTS = new Set([
  'api.bap.microsoft.com',
  'gov.api.bap.microsoft.us',
  'high.api.bap.microsoft.us',
  'dod.api.bap.microsoft.us',
]);

function isDataverseHost(hostname) {
  return DATAVERSE_HOST_PATTERNS.some((pattern) => pattern.test(hostname));
}

function parseTrustedMicrosoftUrl(value, {
  purpose = 'URL',
  allowPath = true,
  allowedHost = (hostname) => isDataverseHost(hostname) || POWER_PLATFORM_SERVICE_HOSTS.has(hostname),
} = {}) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${purpose} must be a non-empty string.`);
  }

  // WHATWG URL parsing removes tabs and newlines before validation and treats
  // backslashes as path separators for special schemes. Reject those before
  // parsing; ordinary spaces remain allowed in OData query expressions and are
  // percent-encoded by URL.href below.
  if (/[\u0000-\u001f\u007f\\]/.test(value)) {
    throw new Error(`${purpose} contains control characters or backslashes.`);
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${purpose} is not a valid URL.`);
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(`${purpose} must use HTTPS.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${purpose} must not contain credentials.`);
  }
  if (parsed.hash) {
    throw new Error(`${purpose} must not contain a fragment.`);
  }

  // URL.port is empty for an explicit default :443, so inspect the original
  // authority as well. Microsoft service endpoints used here never require a
  // caller-selected port. URL schemes are case-insensitive, so capture the raw
  // authority without requiring callers to use lowercase `https://`.
  const authorityMatch = /^https:\/\/([^/?#]*)/i.exec(value);
  if (!authorityMatch) {
    throw new Error(`${purpose} must use HTTPS.`);
  }
  const authority = authorityMatch[1];
  if (authority.includes(':')) {
    throw new Error(`${purpose} must not contain a port.`);
  }
  if (!/^[A-Za-z0-9.-]+$/.test(authority) || parsed.hostname.includes('xn--')) {
    throw new Error(`${purpose} contains unsafe host characters.`);
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!allowedHost(hostname)) {
    throw new Error(`${purpose} host "${hostname}" is not an allowed Microsoft Dataverse or Power Platform endpoint.`);
  }
  if (!allowPath && (parsed.pathname !== '/' || parsed.search)) {
    throw new Error(`${purpose} must be an HTTPS origin without a path or query.`);
  }

  return parsed;
}

function validateDataverseEnvironmentUrl(value, purpose = 'Dataverse environment URL') {
  return parseTrustedMicrosoftUrl(value, {
    purpose,
    allowPath: false,
    allowedHost: isDataverseHost,
  }).origin;
}

function validateTokenResourceUrl(value) {
  const parsed = parseTrustedMicrosoftUrl(value, {
    purpose: 'Token resource URL',
    allowPath: false,
  });
  return parsed.origin + (value.endsWith('/') ? '/' : '');
}

function validateAuthenticatedRequestUrl(value) {
  return parseTrustedMicrosoftUrl(value, {
    purpose: 'Authenticated request URL',
    allowPath: true,
  }).href;
}

function validateBapUrl(value, { allowPath = true } = {}) {
  return parseTrustedMicrosoftUrl(value, {
    purpose: 'BAP URL',
    allowPath,
    allowedHost: (hostname) => BAP_HOSTS.has(hostname),
  }).href;
}

function validateBapPollingUrl(location, initiatingUrl, purpose = 'BAP Location header') {
  const trustedInitiatingUrl = validateBapUrl(initiatingUrl);
  let resolvedLocation;
  try {
    resolvedLocation = new URL(location, trustedInitiatingUrl).href;
  } catch {
    throw new Error(`${purpose} is not a valid URL.`);
  }

  const trustedPollingUrl = validateBapUrl(resolvedLocation);
  if (new URL(trustedPollingUrl).origin !== new URL(trustedInitiatingUrl).origin) {
    throw new Error(`${purpose} points to a different host than the initiating BAP request.`);
  }
  return trustedPollingUrl;
}

/**
 * Gets an Azure CLI access token for the given resource URL.
 * The `--allow-no-subscriptions` flag is only valid on `az login` (other `az`
 * subcommands reject it as an unrecognized argument), so it must not be passed
 * here. Accounts without a subscription can still mint AAD-scoped tokens after
 * signing in via `az login --allow-no-subscriptions`.
 * @returns {string|null} Access token, or null if unavailable
 */
function getAuthToken(resourceUrl) {
  try {
    const trustedResourceUrl = validateTokenResourceUrl(resourceUrl);
    return execFileSync(
      'az',
      ['account', 'get-access-token', '--resource', trustedResourceUrl, '--query', 'accessToken', '-o', 'tsv'],
      { encoding: 'utf8', timeout: 15000, shell: false }
    ).trim();
  } catch {
    return null;
  }
}

/**
 * Gets the environment URL from `pac env who`.
 * @returns {string|null} Environment URL, or null
 */
// Pure parser (exported for unit testing — getEnvironmentUrl() shells out, so the
// regex itself is tested here against raw banner text rather than through execSync).
// PAC CLI labels the environment URL differently across versions / commands:
// `pac env who` on 2.8.x prints it under "Org URL:" (inside "Organization
// Information"); older/other builds emit "Environment URL:". Match EITHER — with
// only the "Environment URL:" form this returned null on 2.8.x and every caller
// relying on the pac-env-who fallback (verify-alm-prerequisites when --envUrl is
// omitted, the datamodel / solution / permissions validators) silently failed.
// Example 2.8.1 line: `  Org URL:    https://org4a2942d9.crm17.dynamics.com/`
function parseEnvironmentUrl(whoOutput) {
  if (!whoOutput) return null;
  const match = whoOutput.match(/(?:Org URL|Environment URL):\s*(https:\/\/[^\s]+)/i);
  if (!match) return null;
  try {
    return validateDataverseEnvironmentUrl(match[1]);
  } catch {
    return null;
  }
}

function parseActiveAuthListEnvironmentUrl(authListOutput) {
  for (const line of String(authListOutput || '').split(/\r?\n/)) {
    if (!/^\s*\[\d+\]\s+\*/.test(line)) continue;
    const urls = line.match(/https:\/\/[^\s]+/gi) || [];
    const environmentUrl = urls[urls.length - 1];
    if (!environmentUrl) continue;
    try {
      return validateDataverseEnvironmentUrl(environmentUrl);
    } catch {
      return null;
    }
  }
  return null;
}

function getEnvironmentUrl() {
  try {
    const output = execSync('pac env who', { encoding: 'utf8', timeout: 15000 });
    const envUrl = parseEnvironmentUrl(output);
    if (envUrl) return envUrl;
  } catch {}

  try {
    return parseActiveAuthListEnvironmentUrl(execSync('pac auth list', { encoding: 'utf8', timeout: 15000 }));
  } catch {
    return null;
  }
}

/**
 * Gets PAC CLI auth info (environment ID and cloud).
 * @returns {{ environmentId: string, cloud: string }|null}
 */
function getPacAuthInfo() {
  try {
    const output = execSync('pac auth who', { encoding: 'utf8', timeout: 15000 });
    const envMatch = output.match(/Environment ID:\s*([0-9a-fA-F-]+)/i);
    const cloudMatch = output.match(/Cloud:\s*(\S+)/i);
    if (!envMatch) return null;
    return {
      environmentId: envMatch[1],
      cloud: cloudMatch ? cloudMatch[1] : 'Public',
    };
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
  const authorizationHeader = Object.entries(headers)
    .find(([name, value]) => name.toLowerCase() === 'authorization' && value);
  const requestUrl = authorizationHeader ? validateAuthenticatedRequestUrl(url) : url;

  return new Promise((resolve) => {
    const https = require('https');
    const http = require('http');
    const u = new URL(requestUrl);
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

/**
 * Single Dataverse OData GET (v9.2 headers, `Prefer: odata.maxpagesize=5000`),
 * throws on non-2xx. `url` is absolute — pass an `@odata.nextLink` straight back in.
 * @param {string} url - absolute URL
 * @param {string} token - bearer token
 * @param {Function} [request=makeRequest] - injectable for tests
 * @returns {Promise<object>} parsed JSON body
 */
async function odataGet(url, token, request = makeRequest) {
  const res = await request({
    url,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
      Prefer: 'odata.maxpagesize=5000',
    },
    timeout: 30000,
  });
  if (res.error) throw new Error(`OData request failed: ${res.error}`);
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`HTTP ${res.statusCode} from ${url}: ${(res.body || '').slice(0, 400)}`);
  }
  return JSON.parse(res.body);
}

/**
 * Follows `@odata.nextLink`, aggregating every page's `value[]` into one array.
 * `maxPages` is a runaway-loop safety cap (100 × 5000 ≈ 500K rows). FAILS CLOSED:
 * if the cap is reached while `@odata.nextLink` is still present, throws rather than
 * silently returning a truncated set — a partial result would produce wrong
 * table/env-var counts for ALM sizing/splitting with no signal. Callers that want
 * partial results must catch and downgrade accuracy intentionally.
 * @param {string} url - absolute starting URL
 * @param {string} token - bearer token
 * @param {Function} [request=makeRequest] - injectable for tests
 * @param {number} [maxPages=100]
 * @returns {Promise<object[]>}
 */
async function odataGetAll(url, token, request = makeRequest, maxPages = 100) {
  const out = [];
  let next = url;
  let p = 0;
  for (; p < maxPages && next; p++) {
    const page = await odataGet(next, token, request);
    if (Array.isArray(page.value)) out.push(...page.value);
    next = page['@odata.nextLink'] || null;
  }
  if (next) {
    throw new Error(
      `odataGetAll hit the ${maxPages}-page cap with @odata.nextLink still present ` +
      `(${out.length} rows so far) — result would be truncated. Raise maxPages or narrow the query.`,
    );
  }
  return out;
}

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
  readDeferralMarker,
  findPath,
  findProjectRoot,
  findPowerPagesSiteDir,
  UUID_REGEX,
  validateDataverseEnvironmentUrl,
  validateTokenResourceUrl,
  validateAuthenticatedRequestUrl,
  validateBapUrl,
  validateBapPollingUrl,
  getAuthToken,
  makeRequest,
  odataGet,
  odataGetAll,
  getEnvironmentUrl,
  parseEnvironmentUrl,
  parseActiveAuthListEnvironmentUrl,
  getPacAuthInfo,
  CLOUD_TO_API,
  CLOUD_TO_SITE_DOMAIN,
};
