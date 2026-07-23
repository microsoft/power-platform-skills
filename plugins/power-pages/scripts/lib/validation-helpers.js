#!/usr/bin/env node

// Shared utilities for Power Pages validation hook scripts.
// Provides common boilerplate so each validator only contains its unique logic.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Bearer tokens acquired by this plugin are scoped to Microsoft cloud services.
// Restrict token acquisition and authenticated requests to the service domains
// the plugin supports so a hostile manifest cannot redirect a token elsewhere.
const TRUSTED_POWER_PLATFORM_HOST_SUFFIXES = [
  'dynamics.com',
  'dynamics.cn',
  'microsoftdynamics.us',
  'appsplatform.us',
  'powerplatform.com',
  'powerplatform.microsoft.us',
  'powerplatform.partner.microsoftonline.cn',
  'bap.microsoft.com',
  'bap.microsoft.us',
  'powerapps.com',
  'powerapps.us',
  'powerapps.cn',
  'powerappsportals.com',
  'powerappsportals.us',
  'powerappsportals.cn',
  'flow.microsoft.com',
  'flow.microsoft.us',
  'flow.microsoft.cn',
  'logic.azure.com',
  'vault.azure.net',
  'vault.azure.com',
  'vault.usgovcloudapi.net',
  'vault.azure.cn',
  'management.azure.com',
  'management.usgovcloudapi.net',
  'management.chinacloudapi.cn',
];

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
  const start = path.resolve(dir);
  const tempRoot = path.resolve(os.tmpdir());
  let current = start;
  while (true) {
    // Test runners and other applications share the system temporary root.
    // Do not let a stale `.powerpages-site` under that shared ancestor claim
    // unrelated temporary workspaces as children of one Power Pages project.
    if (current === tempRoot && start !== tempRoot) break;

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

/**
 * Gets an Azure CLI access token for the given resource URL.
 * The `--allow-no-subscriptions` flag is only valid on `az login` (other `az`
 * subcommands reject it as an unrecognized argument), so it must not be passed
 * here. Accounts without a subscription can still mint AAD-scoped tokens after
 * signing in via `az login --allow-no-subscriptions`.
 * @returns {string|null} Access token, or null if unavailable
 */
function isTrustedPowerPlatformHost(hostname) {
  const normalized = String(hostname || '').toLowerCase();
  return TRUSTED_POWER_PLATFORM_HOST_SUFFIXES.some(
    (suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`),
  );
}

function validatePowerPlatformUrl(value, { requireOrigin = false } = {}) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid Power Platform URL: ${value}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`Power Platform URL must use HTTPS: ${value}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`Power Platform URL must not contain credentials: ${value}`);
  }
  if (parsed.port && parsed.port !== '443') {
    throw new Error(`Power Platform URL must use the default HTTPS port: ${value}`);
  }
  if (!isTrustedPowerPlatformHost(parsed.hostname)) {
    throw new Error(`Power Platform URL is not a trusted Microsoft Power Platform host: ${value}`);
  }
  if (requireOrigin && (parsed.pathname !== '/' || parsed.search || parsed.hash)) {
    throw new Error(`Power Platform token resource must be an origin URL without a path, query, or fragment: ${value}`);
  }
  return parsed;
}

function getAuthToken(resourceUrl, execFileImpl = execFileSync) {
  const resource = validatePowerPlatformUrl(resourceUrl, { requireOrigin: true }).origin;
  try {
    return execFileImpl(
      'az',
      [
        'account',
        'get-access-token',
        '--resource',
        resource,
        '--query',
        'accessToken',
        '-o',
        'tsv',
      ],
      {
        encoding: 'utf8',
        timeout: 15000,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      },
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
  return match ? match[1].replace(/\/+$/, '') : null;
}

function getEnvironmentUrl() {
  try {
    const output = execFileSync('pac', ['env', 'who'], {
      encoding: 'utf8',
      timeout: 15000,
      shell: false,
    });
    return parseEnvironmentUrl(output);
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
    const output = execFileSync('pac', ['auth', 'who'], {
      encoding: 'utf8',
      timeout: 15000,
      shell: false,
    });
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
function makeRequest({ url, method = 'GET', bearerToken, headers = {}, body = null, includeHeaders = false, timeout = 15000 }) {
  return new Promise((resolve) => {
    const https = require('https');
    const http = require('http');
    const authorization = bearerToken
      ? `Bearer ${bearerToken}`
      : (headers.Authorization || headers.authorization || '');
    if (authorization) {
      validatePowerPlatformUrl(url);
    }
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const requestHeaders = bearerToken
      ? { ...headers, Authorization: authorization }
      : headers;
    const req = mod.request(
      {
        method,
        headers: requestHeaders,
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
  validatePowerPlatformUrl,
  getAuthToken,
  makeRequest,
  odataGet,
  odataGetAll,
  getEnvironmentUrl,
  parseEnvironmentUrl,
  getPacAuthInfo,
  CLOUD_TO_API,
  CLOUD_TO_SITE_DOMAIN,
};
