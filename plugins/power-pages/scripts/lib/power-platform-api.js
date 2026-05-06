#!/usr/bin/env node

// Shared client for the Power Platform API used by Power Pages operations
// (security scans, firewall, etc.).
//
// Resolves auth/tenant/environment context from the local PAC + Azure CLI
// state and issues HTTP requests with consistent error handling and
// asynchronous-operation polling.

const { execSync } = require('child_process');
const {
  getAuthToken,
  makeRequest,
  getPacAuthInfo,
  CLOUD_TO_API,
} = require('./validation-helpers');

// Default polling cap for asynchronous operations. Surfaced as a flag rather
// than embedded silently because long scans may legitimately exceed it.
const DEFAULT_POLL_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 5000;

function getTenantId() {
  // The Power Platform CLI does not expose tenant id directly; read it from
  // the active Azure CLI account, which shares the same identity in practice.
  try {
    const out = execSync('az account show --query tenantId -o tsv', {
      encoding: 'utf8',
      timeout: 15000,
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

  const mergedQuery = { 'api-version': '2022-03-01-preview', ...query };
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

  const res = await makeRequest({ url, method, headers, body: payload, includeHeaders: true, ...(timeout != null && { timeout }) });
  if (res.error) {
    return { ok: false, statusCode: 0, body: null, headers: {}, error: { code: 'NetworkError', message: res.error } };
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
  if (ct.includes('application/json') || /^[\[{]/.test(raw.trim())) {
    try { return JSON.parse(raw); } catch { /* fall through */ }
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

/**
 * Polls a status endpoint until a predicate returns truthy or timeout elapses.
 *
 * @param {object} options
 * @param {function} options.fetchStatus - async () => { ok, body }
 * @param {function} options.isDone      - (body) => boolean | { value }
 * @param {number} [options.timeoutMs]
 * @param {number} [options.intervalMs]
 * @returns {Promise<{ ok: boolean, body?: any, error?: string, attempts: number }>}
 */
async function pollUntil({ fetchStatus, isDone, timeoutMs = DEFAULT_POLL_TIMEOUT_MS, intervalMs = DEFAULT_POLL_INTERVAL_MS }) {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  // First attempt is immediate; subsequent attempts wait `intervalMs`.
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

module.exports = {
  resolveContext,
  request,
  pollUntil,
  parseCliArgs,
  emitJson,
  fail,
  DEFAULT_POLL_TIMEOUT_MS,
  DEFAULT_POLL_INTERVAL_MS,
};
