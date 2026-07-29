'use strict';
// HttpClient adapter that satisfies @maker-studio/cds-maker-sdk's HttpClient interface
// (get/post/patch/delete/put -> { status, headers, body }) using the same Azure CLI token
// the rest of the plugin uses. Auth is caller-injected into the SDK; this is that injection.
//
// The SDK's DataverseClient passes a FULL request URL (instanceUrl + /api/data/v9.x/...) and
// supplies per-call headers (MSCRM.SolutionUniqueName, If-Match etag, Prefer, …) via options.
// We must NOT throw on non-2xx — the SDK inspects { status, body } and raises its own typed
// errors (ensureSuccess / VersionConflictError on 412). We throw only when we cannot obtain a token
// (ensureToken) or when the underlying transport itself fails — a network/timeout error (res.error)
// after exhausting retries. We never throw purely on a non-2xx HTTP status.
const { getAuthToken, makeRequest } = require('./dataverse-auth.js');

/**
 * Build an HttpClient bound to one Dataverse org.
 * @param {string} orgUrl - e.g. https://contoso.crm.dynamics.com
 * @param {object} [deps] - test seam: { getToken(orgUrl)->string|null, request(opts)->Promise }
 * @returns {{get,post,patch,delete,put}}
 */
function createAzHttpClient(orgUrl, deps = {}) {
  const clean = String(orgUrl).replace(/\/+$/, '');
  // Same-origin guard (security): this client obtains and attaches an Azure bearer token scoped to
  // `clean` (the user-supplied --env org URL). The SDK always calls back with a FULL URL under that
  // same origin (instanceUrl + /api/data/v9.x/...). If a request URL ever targets a DIFFERENT origin —
  // a malformed/hostile --env, or an SDK bug — we must NOT attach the Dataverse token to it, or we would
  // leak a credential to an unintended host. Compute the expected origin once; refuse any call whose
  // absolute URL resolves to a different origin. (If `clean` itself is not a parseable absolute URL, the
  // az token fetch for it would already fail, so we leave the guard disabled in that degenerate case.)
  let expectedOrigin;
  try { expectedOrigin = new URL(clean).origin; } catch { expectedOrigin = null; }
  function assertSameOrigin(url) {
    let target;
    try { target = new URL(url); } catch { throw new Error(`Refusing to send the Dataverse token to a non-absolute URL: ${url}`); }
    if (expectedOrigin !== null && target.origin !== expectedOrigin) {
      throw new Error(`Refusing to send the Dataverse token for ${expectedOrigin} to a different origin (${target.origin}); the request URL must be under the --env org URL.`);
    }
  }
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
    // The BASE is capped at 8000ms (1s,2s,4s,8s,8s); the returned delay then adds up to +25% jitter
    // on top, so the actual sleep can exceed 8000ms (e.g. ~9000ms). The cap is on the base, not the
    // final sleep — jitter is intentionally allowed to push past it to de-sync lockstep collisions.
    const base = Math.min(1000 * 2 ** attempt, 8000);
    return base + Math.floor(random() * base * 0.25);
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
    assertSameOrigin(url); // never attach the org's bearer token to a foreign origin
    const hasBody = body !== undefined && body !== null;
    const bodyStr = hasBody ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    // DELETE retry policy splits by endpoint, because the two kinds fail oppositely:
    //  - METADATA deletes (EntityDefinitions / RelationshipDefinitions / GlobalOptionSetDefinitions)
    //    are async-idempotent: a slow one client-times-out while completing server-side, and a retry
    //    just gets the cosmetic 404 (tolerated as deleted). These KEEP retry — otherwise a slow
    //    table/relationship delete surfaces a false "timed out" failure.
    //  - RECORD deletes (webresourceset, appmodule, savedquery, appaction, solutions, …) must NOT
    //    retry: Dataverse's "More than one concurrent Delete requests detected" guard PERMANENTLY
    //    wedges the record when a retry races the still-in-flight first delete (web-resource deletes
    //    SQL-time-out under load and trip exactly this). One delete keeps the failure re-runnable.
    const method_ = String(method).toUpperCase();
    const isMetadataDelete = /\/(EntityDefinitions|RelationshipDefinitions|GlobalOptionSetDefinitions)\b/i.test(url);
    const noRetry = method_ === 'DELETE' && !isMetadataDelete;

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
        if (last || noRetry) throw new Error(`Request failed: ${res.error}`);
        await sleep(backoffMs(attempt));
        continue;
      }
      if (res.statusCode === 401 && !last) {
        token = null; // force a token refresh and retry immediately
        continue;
      }
      if (TRANSIENT.has(res.statusCode) && !last && !noRetry) {
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
