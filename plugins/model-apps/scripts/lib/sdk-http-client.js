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
// after exhausting retries, or at once for a write that must not be re-sent (see `call`). We never
// throw purely on a non-2xx HTTP status.
const { getAuthToken, makeRequest } = require('./dataverse-auth.js');

/**
 * Build an HttpClient bound to one Dataverse org.
 * @param {string} orgUrl - e.g. https://contoso.crm.dynamics.com
 * @param {object} [deps] - test seam: { getToken(orgUrl)->string|null, request(opts)->Promise }
 * @returns {{get,post,patch,delete,put,postRaw}}
 */
function createAzHttpClient(orgUrl, deps = {}) {
  const clean = String(orgUrl).replace(/\/+$/, '');
  // Same-origin guard (security): this client obtains and attaches an Azure bearer token scoped to
  // `clean` (the user-supplied --env org URL), and the SDK always calls back with a FULL URL under that
  // same origin (instanceUrl + /api/data/v9.x/...). To keep the credential boundary FAIL-CLOSED we (1)
  // require the org URL itself to be a valid absolute https:// URL — rejecting construction otherwise, so
  // a malformed/hostile --env can never silently disable the guard — and (2) refuse any request whose
  // absolute URL resolves to a different origin, so the Dataverse token can never leak to another host.
  let orgUrlParsed;
  try { orgUrlParsed = new URL(clean); } catch { orgUrlParsed = null; }
  if (!orgUrlParsed || orgUrlParsed.protocol !== 'https:') {
    throw new Error(`Invalid Dataverse org URL "${orgUrl}": expected an absolute https:// URL (e.g. https://contoso.crm.dynamics.com).`);
  }
  const expectedOrigin = orgUrlParsed.origin;
  function assertSameOrigin(url) {
    let target;
    try { target = new URL(url); } catch { throw new Error(`Refusing to send the Dataverse token to a non-absolute URL: ${url}`); }
    if (target.origin !== expectedOrigin) {
      throw new Error(`Refusing to send the Dataverse token for ${expectedOrigin} to a different origin (${target.origin}); the request URL must be under the --env org URL.`);
    }
  }
  const getToken = deps.getToken || ((u) => getAuthToken(u));
  const request = deps.request || makeRequest;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const random = deps.random || Math.random;
  // Transient HTTP statuses worth retrying with backoff — throttling, gateway hiccups, and
  // SQL deadlocks (Dataverse surfaces deadlock 1205 as a 500 from PublishXml under load).
  //
  // ⚠ 502/503/504 come from an INTERMEDIARY, so the write behind them may have COMMITTED — and this
  // retry then re-sends it. For a CONDITIONAL write (every SDK form, view, chart, dashboard and app
  // update carries `If-Match`) or a KEYED create (a client-minted id, such as a business process
  // flow), the re-send meets the row the first attempt already created or bumped, so the outcome
  // comes back as a definitive-looking 412 — a version conflict, or "already exists" — for a write
  // that succeeded. That is a spurious FAILURE, never a lost write, and it halts the build with the
  // remedy for that code (`requireSuccessfulPush`, lib/entity-provision.js). Note "already exists" is
  // NOT cleared by simply re-running: the workspace keeps the copy it never recorded as pushed, which
  // is why that halt names a workspace reset. Without the retry the same commit would still fail (as
  // a bare 502), while an attempt that genuinely did not commit would no longer recover. So the
  // policy stays.
  // It is NOT safe for a write whose failure path must know whether the first attempt landed: the
  // SDK's business-process-flow `update`/`delete` settle an ambiguous deactivate by re-reading the
  // row, and this retry pre-empts that. Nothing in this plugin issues those today; exempt such
  // writes from the retry before anything does.
  const TRANSIENT = new Set([429, 500, 502, 503, 504]);
  // How long to wait for an answer before giving up. A WRITE gets far longer than a read, because a
  // write we stop waiting for is not a failed write — the server may still be executing it, so its
  // outcome becomes UNKNOWN, and every recovery from an unknown outcome is worse than waiting. A
  // read is safe to abandon and re-issue.
  // MEASURED live: activating a business process flow on a table created seconds earlier ran past
  // 60 s (the platform creates the flow's backing table inside that request). At the old 60 s limit
  // the activation committed after the client gave up; the re-send was refused with a 412 against
  // the version the first attempt had produced, and the flow's create rolled itself back on that
  // false "concurrent edit" — a build that failed over a write that had succeeded.
  const READ_TIMEOUT_MS = 60000;
  const WRITE_TIMEOUT_MS = 300000;
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

  /**
   * @param {object} [ctl] - transport controls, independent of the OData semantics:
   *   `rawBody` returns the response body as the decoded string it arrived as, skipping parseBody.
   */
  async function call(method, url, body, options, ctl = {}) {
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
    //  - A `$batch` change set is a POST, but it CARRIES record deletes (the SDK deletes an app and
    //    its sitemap in one atomic change set), so it inherits the record-delete hazard above. It is
    //    also ambiguous on failure: the server may have committed while the response was lost, so a
    //    blind re-issue is exactly the racing retry that wedges the row. Issue it once and let the
    //    SDK surface the unknown outcome to the caller.
    const method_ = String(method).toUpperCase();
    const isMetadataDelete = /\/(EntityDefinitions|RelationshipDefinitions|GlobalOptionSetDefinitions)\b/i.test(url);
    const isBatch = method_ === 'POST' && /\/\$batch(\?|$)/i.test(url);
    const noRetry = (method_ === 'DELETE' && !isMetadataDelete) || isBatch;
    const isWrite = method_ !== 'GET';
    // A CONDITIONAL write that got NO answer (a timeout or a dropped connection) is never re-sent.
    // It may still commit — and if it does, the re-send carries a token the first attempt already
    // superseded, so it can only be refused with a 412 that reads exactly like somebody else's edit.
    // The SDK acts on that: a business process flow create rolls itself back on a version conflict
    // in its activation step, which is how one committed-but-slow activation failed a whole build.
    // Surfacing the unknown outcome instead lets the caller report what really happened, and the
    // idempotent rebuild then adopts whatever did land. A conditional write that got an ANSWER
    // (429, 5xx) keeps the status retry above; that trade-off is unchanged.
    const conditional = isWrite && Object.keys((options && options.headers) || {}).some((h) => h.toLowerCase() === 'if-match');

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

      const res = await request({ url, method, headers, body: bodyStr, includeHeaders: true, timeout: isWrite ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS });
      if (res.error) {
        if (conditional) {
          throw new Error(`Request failed: ${res.error} — this conditional ${method_} was not re-sent, because it may still commit and a re-send could only be refused as a false version conflict`);
        }
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
      return {
        status: res.statusCode,
        headers: res.headers || {},
        body: ctl.rawBody ? res.body : parseBody(res.body),
      };
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
    // The SDK's atomic multi-row writes (OData `$batch` change sets) need a transport that does NOT
    // touch the payload in either direction: the request body is a multipart/mixed envelope whose
    // CRLF boundaries are significant, and the response is a multipart envelope the SDK scans for
    // each operation's `HTTP/1.1 <status>` line. JSON-serializing the request or JSON-parsing the
    // response breaks that — the SDK rejects a non-string response body with a ConnectionError.
    // The boundary-bearing Content-Type comes from `options.headers` (call() only defaults a JSON
    // Content-Type when the caller supplied none), so it passes through untouched.
    // Contract: cds-maker-sdk src/types/httpClient.ts (postRaw). Without this method the SDK refuses
    // to delete an app that owns a sitemap (APP_DELETE_NOT_ATOMIC) rather than strand a row.
    postRaw: (url, body, options) => call('POST', url, body, options, { rawBody: true }),
  };
}

module.exports = { createAzHttpClient };
