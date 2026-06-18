#!/usr/bin/env node

// Shared client utilities for Azure DevOps REST API calls used by the
// inner-loop ADO helpers (create-pr, get-pr, list-commits, revert-branch).
//
// Responsibilities:
//   - Auth header construction (delegates to verify-ado-permissions.buildAuthHeader
//     for PAT-vs-OAuth detection so we have one canonical implementation)
//   - URL construction (dev.azure.com/<org>/<project>/_apis/git/...)
//   - Retry with exponential backoff on transient failures (429, 5xx, network)
//   - Throttling: honor ADO's `Retry-After` header on 429
//   - Test seam: callers can pass `baseUrl` to override the dev.azure.com host
//
// API surface (library only — no CLI):
//   const c = createAdoClient({ organization, project, repository, pat?, token?, baseUrl?, ... });
//   await c.request({ method, path, body?, query?, apiVersion?, headers? });
//   await c.get('/refs', { query: { filter: 'heads/main' } });
//   await c.post('/pullrequests', { body: { ... } });
//
// References:
//   git-integration-api-patterns.md §11 (ADO REST envelope)
//   inner-loop-error-catalog.md IL-009..IL-012 (ADO error patterns)
//
// TODO: HAR-verify — exact Retry-After header semantics on ADO 429 (seconds vs HTTP date)

'use strict';

const { makeRequest } = require('./validation-helpers');
const { buildAuthHeader } = require('./verify-ado-permissions');

const DEFAULT_API_VERSION = '7.0';
const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_MS = 500;
const RETRY_ON_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function parseRetryAfter(headers) {
  if (!headers) return null;
  const raw = headers['retry-after'] || headers['Retry-After'];
  if (!raw) return null;
  const seconds = parseInt(raw, 10);
  if (!isNaN(seconds) && seconds >= 0) return seconds * 1000;
  // HTTP-date format — fallback to default backoff
  return null;
}

function buildQueryString(query, apiVersion) {
  const params = new URLSearchParams();
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) params.append(k, String(v));
    }
  }
  if (apiVersion && !params.has('api-version')) params.append('api-version', apiVersion);
  const str = params.toString();
  return str ? `?${str}` : '';
}

/**
 * Create a stateful ADO REST client bound to a single organization/project/repository.
 *
 * @param {object} options
 * @param {string}  options.organization
 * @param {string}  [options.project]      Required for repo-scoped paths
 * @param {string}  [options.repository]   Required for repo-scoped paths
 * @param {string}  [options.pat]          ADO PAT, OR
 * @param {string}  [options.token]        AAD bearer
 * @param {string}  [options.baseUrl]      Override dev.azure.com (for tests)
 * @param {string}  [options.apiVersion]   Default '7.0'
 * @param {number}  [options.retryAttempts]   Default 3
 * @param {number}  [options.retryBaseMs]     Default 500 (exponential: base * 2^attempt)
 * @returns {{ request, get, post, patch, put, delete }}
 */
function createAdoClient({
  organization, project = null, repository = null,
  pat = null, token = null,
  baseUrl = null,
  apiVersion = DEFAULT_API_VERSION,
  retryAttempts = DEFAULT_RETRY_ATTEMPTS,
  retryBaseMs = DEFAULT_RETRY_BASE_MS,
} = {}) {
  if (!organization) throw new Error('createAdoClient: organization is required');
  if (!pat && !token) throw new Error('createAdoClient: pat or token is required');

  const { header: authHeader } = buildAuthHeader(pat || token);
  const base = baseUrl || `https://dev.azure.com/${encodeURIComponent(organization)}`;

  function buildUrl(path, query, ver) {
    // path may be either:
    //   absolute starting with /     → joined to base + project + _apis/git/repositories/<repo>
    //   starting with /_apis/        → joined to base + project only
    //   starting with /<project>/_apis  → joined to base only
    //   full http(s)://              → used as-is
    let url;
    if (/^https?:\/\//.test(path)) {
      url = path;
    } else if (path.startsWith('/_apis/')) {
      // org-level API (no project), e.g. /_apis/projects
      url = `${base}${path}`;
    } else if (path.startsWith('/')) {
      if (!project) throw new Error('ADO client: project required for repo-scoped paths');
      if (!repository) throw new Error('ADO client: repository required for repo-scoped paths');
      url = `${base}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repository)}${path}`;
    } else {
      throw new Error('ADO client: path must start with "/" or be a full URL');
    }
    return url + buildQueryString(query, ver || apiVersion);
  }

  async function requestOnce({ method, url, body, headers }) {
    const finalHeaders = {
      Authorization: authHeader,
      Accept: 'application/json',
      ...(headers || {}),
    };
    if (body && !finalHeaders['Content-Type']) finalHeaders['Content-Type'] = 'application/json';
    return await makeRequest({
      url, method,
      headers: finalHeaders,
      body: typeof body === 'string' || body == null ? body : JSON.stringify(body),
      includeHeaders: true,
    });
  }

  async function request({ method = 'GET', path, body = null, query = null, apiVersion: ver = null, headers = null } = {}) {
    if (!path) throw new Error('ADO client: path is required');
    const url = buildUrl(path, query, ver);
    let lastRes = null;
    for (let attempt = 0; attempt <= retryAttempts; attempt++) {
      const res = await requestOnce({ method, url, body, headers });
      lastRes = res;
      const transient = res.error || (res.statusCode && RETRY_ON_STATUSES.has(res.statusCode));
      if (!transient || attempt === retryAttempts) {
        return res;
      }
      const retryAfterMs = parseRetryAfter(res.headers);
      const backoff = retryAfterMs || (retryBaseMs * Math.pow(2, attempt));
      await sleep(backoff);
    }
    return lastRes;
  }

  const shortcuts = (method) => (path, opts = {}) => request({ ...opts, method, path });

  return {
    request,
    get:    shortcuts('GET'),
    post:   shortcuts('POST'),
    patch:  shortcuts('PATCH'),
    put:    shortcuts('PUT'),
    delete: shortcuts('DELETE'),
    _buildUrl: buildUrl, // exposed for tests
  };
}

module.exports = {
  createAdoClient,
  parseRetryAfter,
  buildQueryString,
  RETRY_ON_STATUSES,
  DEFAULT_API_VERSION,
};
