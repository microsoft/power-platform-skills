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
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const random = deps.random || Math.random;
  // Transient HTTP statuses worth retrying with backoff — throttling, gateway hiccups, and
  // SQL deadlocks (Dataverse surfaces deadlock 1205 as a 500 from PublishXml under load).
  const TRANSIENT = new Set([429, 500, 502, 503, 504]);
  // Jittered, capped exponential backoff. Metadata customizations serialize on a per-entity
  // lock; when several artifacts (forms/views/charts) for the same table retry concurrently,
  // a fixed schedule wakes them in lockstep so they re-collide forever. Jitter de-syncs them.
  const backoffMs = (attempt) => {
    const base = Math.min(1000 * 2 ** attempt, 8000); // 1s,2s,4s,8s,8s (capped)
    return base + Math.floor(random() * base * 0.25); // + up to 25% jitter
  };

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

    // Retry: refresh the token once on 401 (no backoff); back off on transient 5xx/429.
    // 6 attempts with capped jittered backoff rides out a per-entity customization lock that
    // can stay held for ~20s while a prior metadata op or publish settles.
    const maxAttempts = 6;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const last = attempt === maxAttempts - 1;
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
        if (last) throw new Error(`Request failed: ${res.error}`);
        await sleep(backoffMs(attempt));
        continue;
      }
      if (res.statusCode === 401 && !last) {
        token = null; // force a token refresh and retry immediately
        continue;
      }
      if (TRANSIENT.has(res.statusCode) && !last) {
        await sleep(backoffMs(attempt));
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
