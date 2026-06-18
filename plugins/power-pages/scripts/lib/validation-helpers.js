#!/usr/bin/env node

// Shared utilities for Power Pages validation hook scripts.
// Provides common boilerplate so each validator only contains its unique logic.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

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
 * Gets an Azure CLI access token for the given resource URL.
 * The `--allow-no-subscriptions` flag is only valid on `az login` (other `az`
 * subcommands reject it as an unrecognized argument), so it must not be passed
 * here. Accounts without a subscription can still mint AAD-scoped tokens after
 * signing in via `az login --allow-no-subscriptions`.
 * @returns {string|null} Access token, or null if unavailable
 */
function getAuthToken(resourceUrl) {
  try {
    return execSync(
      `az account get-access-token --resource "${resourceUrl}" --query accessToken -o tsv`,
      { encoding: 'utf8', timeout: 15000 }
    ).trim();
  } catch {
    return null;
  }
}

/**
 * Gets the environment URL from `pac env who`.
 * @returns {string|null} Environment URL, or null
 */
function getEnvironmentUrl() {
  try {
    const output = execSync('pac env who', { encoding: 'utf8', timeout: 15000 });
    const match = output.match(/Environment URL:\s*(https:\/\/[^\s]+)/i);
    return match ? match[1].replace(/\/+$/, '') : null;
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

// Default socket-inactivity timeout for makeRequest. 15 s is plenty for any
// normal Dataverse OData call (read/write of a single record returns in ms).
//
// Long-running OData actions — CommitToGit, ConnectToGit, RefreshChangesFromGit,
// PullChangesFromGit, DisconnectFromGit, big imports — hold the request open
// server-side for tens of seconds to many minutes. Those callers MUST pass
// `socketTimeoutMs: LONG_RUNNING_GIT_ACTION_TIMEOUT_MS` (15 min) so a slow
// but ultimately successful server reply is not misread as a timeout failure.
//
// Empirical first-commit ranges for CommitToGit (HAR-confirmed 2026-06; see
// references/inner-loop-empirical-findings.md §3 / §10):
//   - small first-commit (~40 components):  ~25–60 s
//   - medium solution (~200 components):    2–5 min
//   - big solution (1000+ components):      5–15 min
const DEFAULT_SOCKET_TIMEOUT_MS = 15000;
const LONG_RUNNING_GIT_ACTION_TIMEOUT_MS = 900000;

/**
 * Makes an HTTP/HTTPS request using Node.js built-in modules (cross-platform, no PowerShell).
 * Returns a Promise — callers must use `await`.
 * @param {object} options
 * @param {string} options.url - Full URL to request
 * @param {string} [options.method='GET'] - HTTP method
 * @param {object} [options.headers={}] - Request headers
 * @param {string} [options.body=null] - Request body (string)
 * @param {boolean} [options.includeHeaders=false] - Include response headers in result
 * @param {number} [options.socketTimeoutMs=15000] - Socket-inactivity timeout in ms.
 *     The default suits normal Dataverse calls (record read/write returns in ms).
 *     Pass `LONG_RUNNING_GIT_ACTION_TIMEOUT_MS` (15 min) for blocking OData
 *     actions like CommitToGit that hold the request open server-side until
 *     they finish writing every component to ADO.
 * @param {number} [options.timeout] - DEPRECATED alias for `socketTimeoutMs`,
 *     retained only for back-compat with any external caller. Prefer
 *     `socketTimeoutMs`. If both are supplied, `socketTimeoutMs` wins.
 * @returns {Promise<{ statusCode: number, body: string, headers?: object } | { error: string }>}
 */
function makeRequest({ url, method = 'GET', headers = {}, body = null, includeHeaders = false, socketTimeoutMs, timeout }) {
  const effectiveTimeoutMs = socketTimeoutMs !== undefined
    ? socketTimeoutMs
    : (timeout !== undefined ? timeout : DEFAULT_SOCKET_TIMEOUT_MS);
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
        timeout: effectiveTimeoutMs,
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
  getAuthToken,
  makeRequest,
  DEFAULT_SOCKET_TIMEOUT_MS,
  LONG_RUNNING_GIT_ACTION_TIMEOUT_MS,
  getEnvironmentUrl,
  getPacAuthInfo,
  CLOUD_TO_API,
  CLOUD_TO_SITE_DOMAIN,
};
