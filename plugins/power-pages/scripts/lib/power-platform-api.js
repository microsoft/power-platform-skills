#!/usr/bin/env node

// Shared client for Power Pages operations against the Power Platform API.
// Resolves auth/tenant/environment context from local PAC + Azure CLI state
// and issues HTTP requests with consistent error handling and async polling.

const { execSync } = require('child_process');
const {
  getAuthToken,
  makeRequest,
  getPacAuthInfo,
  CLOUD_TO_API,
} = require('./validation-helpers');

const DEFAULT_POLL_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 5000;
const AZ_TIMEOUT_MS = 15_000;
const API_VERSION = '2022-03-01-preview';

function getTenantId() {
  // PAC CLI does not expose tenant id; pull it from Azure CLI which shares
  // the same identity. stdio settings suppress az's stderr noise on logout.
  try {
    const out = execSync('az account show --query tenantId -o tsv', {
      encoding: 'utf8',
      timeout: AZ_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Resolves the full Power Platform API context from local CLI state. Callers build
 * site-specific URL paths themselves using a portalId — the Power Platform API URL
 * segment is portalId, never websiteRecordId. See `lib/website.js` for the
 * resolution from a Dataverse websiteRecordId to a portalId.
 *
 * @returns {{ tenantId, environmentId, baseUrl, token, apiHost } | { error: string }}
 */
function resolveContext() {
  const pac = getPacAuthInfo();
  if (!pac) {
    return { error: 'Power Platform CLI is not signed in. Run: pac auth create' };
  }
  const tenantId = getTenantId();
  if (!tenantId) {
    return { error: 'Azure CLI is not signed in. Run: az login' };
  }
  const apiHost = CLOUD_TO_API[pac.cloud] || CLOUD_TO_API.Public;
  const token = getAuthToken(apiHost);
  if (!token) {
    return { error: `Failed to acquire access token for ${apiHost}.` };
  }
  const baseUrl = `${apiHost}/powerpages/environments/${pac.environmentId}`;
  return { tenantId, environmentId: pac.environmentId, baseUrl, token, apiHost };
}

function buildQuery(params) {
  if (!params) return '';
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null);
  if (entries.length === 0) return '';
  return '?' + entries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

/**
 * Issues a request against the Power Platform API. Returns a normalized envelope.
 *
 * @param {object} options
 * @param {object} options.context  - Result of resolveContext()
 * @param {string} options.method   - HTTP method
 * @param {string} options.path     - Path relative to context.baseUrl (must start with '/')
 * @param {object} [options.query]  - Query parameters (encoded)
 * @param {object|string} [options.body] - JSON body (object) or raw string
 * @param {object} [options.extraHeaders]
 * @param {number} [options.timeout] - Request timeout in ms (default: 15000)
 * @returns {Promise<{ ok: boolean, statusCode: number, body: any, headers: object, error?: { code, message } }>}
 */
async function request({ context, method, path, query, body, extraHeaders, timeout }) {
  if (!context || !context.baseUrl) throw new Error('context is required');
  if (!path.startsWith('/')) throw new Error('path must start with /');

  const mergedQuery = { 'api-version': API_VERSION, ...query };
  const url = `${context.baseUrl}${path}${buildQuery(mergedQuery)}`;
  const headers = {
    Authorization: `Bearer ${context.token}`,
    Accept: 'application/json',
    ...(extraHeaders || {}),
  };
  let payload = null;
  if (body !== undefined && body !== null) {
    if (typeof body === 'string') {
      payload = body;
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    } else {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    }
  }

  const res = await makeRequest({
    url,
    method,
    headers,
    body: payload,
    includeHeaders: true,
    ...(timeout != null && { timeout }),
  });
  if (res.error) {
    return {
      ok: false,
      statusCode: 0,
      body: null,
      headers: {},
      error: { code: 'NetworkError', message: res.error },
    };
  }

  const parsedBody = parseBody(res.body, res.headers || {});
  const ok = res.statusCode >= 200 && res.statusCode < 300;
  const out = { ok, statusCode: res.statusCode, body: parsedBody, headers: res.headers || {} };
  if (!ok) out.error = extractError(parsedBody, res.statusCode);
  return out;
}

function parseBody(raw, headers) {
  if (!raw) return null;
  const ct = (headers['content-type'] || headers['Content-Type'] || '').toLowerCase();
  const first = typeof raw === 'string' ? raw.trimStart()[0] : '';
  if (ct.includes('application/json') || first === '{' || first === '[') {
    try {
      return JSON.parse(raw);
    } catch {
      // Fall through and return the raw string.
    }
  }
  return raw;
}

function extractError(body, statusCode) {
  if (body && typeof body === 'object' && body.error) {
    return { code: body.error.code || `HTTP_${statusCode}`, message: body.error.message || '' };
  }
  if (typeof body === 'string') {
    return { code: `HTTP_${statusCode}`, message: body };
  }
  return { code: `HTTP_${statusCode}`, message: '' };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls a status endpoint until a predicate returns truthy or timeout elapses.
 *
 * @param {object} options
 * @param {function} options.fetchStatus - async () => { ok, body }
 * @param {function} options.isDone      - (body) => boolean
 * @param {number} [options.timeoutMs]
 * @param {number} [options.intervalMs]
 * @returns {Promise<{ ok: boolean, body?: any, error?: string, attempts: number }>}
 */
async function pollUntil({
  fetchStatus,
  isDone,
  timeoutMs = DEFAULT_POLL_TIMEOUT_MS,
  intervalMs = DEFAULT_POLL_INTERVAL_MS,
}) {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts += 1;
    const status = await fetchStatus();
    if (!status.ok) {
      return { ok: false, error: status.error || 'status fetch failed', attempts };
    }
    if (isDone(status.body)) {
      return { ok: true, body: status.body, attempts };
    }
    await sleep(intervalMs);
  }
  return { ok: false, error: 'timeout', attempts };
}

function parseCliArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function emitJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function fail(message, code = 1) {
  process.stderr.write(message.endsWith('\n') ? message : message + '\n');
  process.exit(code);
}

/**
 * Returns true when the response carries one of the given error codes. Power
 * Platform error codes are unique per scenario (B022/B023 = 400, B003 = 409,
 * etc.), so the helper does not constrain status.
 */
function hasErrorCode(res, ...codes) {
  return codes.includes(res.error?.code);
}

/**
 * Returns true when the response indicates the feature is not supported for
 * this site (region restriction, trial site, etc.). Recognizes the documented
 * error codes plus a "not supported" fallback in the message.
 */
function isFeatureUnsupported(res, ...codes) {
  if (hasErrorCode(res, ...codes)) return true;
  return res.statusCode === 400 && /not supported/i.test(res.error?.message || '');
}

/**
 * Parses --timeoutMinutes (or any positive-integer-minute flag) into milliseconds.
 * Calls `fail()` on non-finite or non-positive values.
 */
function parseTimeoutMs(value, defaultMinutes) {
  const minutes = value === undefined ? defaultMinutes : Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    fail(`Invalid --timeoutMinutes value "${value}". Must be a positive number.`, 1);
  }
  return minutes * 60 * 1000;
}

/**
 * Wraps an async `main` for CLI scripts. Caller passes its own `module` so the
 * gate fires only when the script is executed directly, not when required.
 */
function runCli(callerModule, mainFn) {
  if (require.main !== callerModule) return;
  Promise.resolve()
    .then(mainFn)
    .catch((err) => fail(err?.message || String(err), 1));
}

module.exports = {
  resolveContext,
  request,
  pollUntil,
  parseCliArgs,
  parseTimeoutMs,
  emitJson,
  fail,
  hasErrorCode,
  isFeatureUnsupported,
  runCli,
  DEFAULT_POLL_TIMEOUT_MS,
  DEFAULT_POLL_INTERVAL_MS,
};
