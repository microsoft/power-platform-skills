'use strict';
// HttpClient adapter that satisfies @maker-studio/cds-maker-sdk's HttpClient interface
// (get/post/patch/delete/put -> { status, headers, body }) using the same Azure CLI token
// the rest of the plugin uses. Auth is caller-injected into the SDK; this is that injection.
//
// The SDK's DataverseClient passes a FULL request URL (instanceUrl + /api/data/v9.x/...) and
// supplies per-call headers (MSCRM.SolutionUniqueName, If-Match etag, Prefer, …) via options.
// We must NOT throw on non-2xx — the SDK inspects { status, body } and raises its own typed
// errors (ensureSuccess / VersionConflictError on 412). We only throw when we cannot get a token.
const { getAuthToken, makeRequest } = require('./dataverse-auth.js');

/**
 * Build an HttpClient bound to one Dataverse org.
 * @param {string} orgUrl - e.g. https://contoso.crm.dynamics.com
 * @param {object} [deps] - test seam: { getToken(orgUrl)->string|null, request(opts)->Promise }
 * @returns {{get,post,patch,delete,put}}
 */
function createAzHttpClient(orgUrl, deps = {}) {
  const clean = String(orgUrl).replace(/\/+$/, '');
  const getToken = deps.getToken || ((u) => getAuthToken(u));
  const request = deps.request || makeRequest;

  let token = null;
  function ensureToken() {
    if (!token) {
      token = getToken(clean);
      if (!token) {
        throw new Error(`Failed to get Azure CLI token for ${clean}. Run 'az login' first.`);
      }
    }
    return token;
  }

  function parseBody(raw) {
    if (raw === undefined || raw === null || raw === '') return undefined;
    if (typeof raw !== 'string') return raw;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  async function call(method, url, body, options) {
    const hasBody = body !== undefined && body !== null;
    const bodyStr = hasBody ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;

    // One token refresh on 401, mirroring dataverse-auth's retry policy.
    for (let attempt = 0; attempt <= 1; attempt++) {
      const headers = {
        Authorization: `Bearer ${ensureToken()}`,
        Accept: 'application/json',
        'OData-MaxVersion': '4.0',
        'OData-Version': '4.0',
        ...((options && options.headers) || {}),
      };
      if (bodyStr && !headers['Content-Type']) {
        headers['Content-Type'] = 'application/json; charset=utf-8';
      }

      const res = await request({ url, method, headers, body: bodyStr, includeHeaders: true });
      if (res.error) {
        if (attempt < 1) continue;
        throw new Error(`Request failed: ${res.error}`);
      }
      if (res.statusCode === 401 && attempt < 1) {
        token = null; // force refresh and retry once
        continue;
      }
      return { status: res.statusCode, headers: res.headers || {}, body: parseBody(res.body) };
    }
    /* istanbul ignore next */
    throw new Error('Unreachable retry loop');
  }

  return {
    get: (url, options) => call('GET', url, undefined, options),
    post: (url, body, options) => call('POST', url, body, options),
    patch: (url, body, options) => call('PATCH', url, body, options),
    delete: (url, options) => call('DELETE', url, undefined, options),
    put: (url, body, options) => call('PUT', url, body, options),
  };
}

module.exports = { createAzHttpClient };
