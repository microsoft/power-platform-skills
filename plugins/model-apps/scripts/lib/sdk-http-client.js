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
const { dataverseOrigin, getAuthToken, makeRequest, tokenFailureMessage } = require('./dataverse-auth.js');

// How Dataverse reports that SQL Server chose a request's transaction as a deadlock VICTIM and rolled
// it back. Two live captures, both HTTP 500 (a process-flow delete during a teardown, and PublishXml):
//   HTTP 500 from …/api/data/v9.0/workflows(<id>):  Sql error: Generic SQL error. CRM ErrorCode: -2147204784 Sql ErrorCode: -2146232060 Sql Number: 1205
//   {"error":{"code":"0x80044150","message":" Sql error: Generic SQL error. CRM ErrorCode: -2147204784 Sql ErrorCode: -2146232060 Sql Number: 1205"}}
// Only the SQL number identifies it; the code and message text are shared with every other SQL error.
// The vendored SDK recognizes the same marker for its own re-send of reads, app creates and PublishXml.
const SQL_DEADLOCK_VICTIM = /\bSql Number:\s*1205\b/i;
// At most this many re-sends of a deadlock victim, 1 s / 2 s / 4 s apart — the SDK's own schedule.
const DEADLOCK_RESENDS = 3;
// The longest `Retry-After` honoured in full. Dataverse's service protection limits answer 429 with
// `Retry-After` in seconds and ask the caller to wait that long; a request sent sooner is refused again
// and spends one of the few attempts. The cap keeps a large value from stalling a build or a teardown
// for minutes per attempt.
// See: https://learn.microsoft.com/power-apps/developer/data-platform/api-limits#retry-operations
const RETRY_AFTER_CAP_MS = 60000;

/**
 * The wait a response asks for in `Retry-After`, in milliseconds, capped at RETRY_AFTER_CAP_MS; 0 when
 * the header is absent or unreadable. RFC 9110 allows two forms, delay-seconds and an HTTP date:
 *   Retry-After: 20
 *   Retry-After: Wed, 30 Sep 2026 10:00:20 GMT
 * Node lowercases response header names; a test double may not, so the name is matched case-insensitively.
 * See: https://www.rfc-editor.org/rfc/rfc9110#field.retry-after
 */
function retryAfterMs(headers, now = Date.now()) {
  if (!headers || typeof headers !== 'object') return 0;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === 'retry-after');
  if (key === undefined) return 0;
  const raw = String(Array.isArray(headers[key]) ? headers[key][0] : headers[key]).trim();
  let ms = 0;
  if (/^\d+$/.test(raw)) ms = Number(raw) * 1000;
  else if (raw) {
    const at = Date.parse(raw);
    if (Number.isFinite(at)) ms = at - now;
  }
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, RETRY_AFTER_CAP_MS) : 0;
}

/** True when a raw transport response says SQL rolled this request back as a deadlock victim. */
function isSqlDeadlockVictim(res) {
  if (!res || res.statusCode !== 500 || res.body === undefined || res.body === null) return false;
  return SQL_DEADLOCK_VICTIM.test(typeof res.body === 'string' ? res.body : JSON.stringify(res.body));
}

/**
 * True when a `$batch` REQUEST may be sent again after a proven rollback: every operation in it is a
 * DELETE conditioned on the exact row version its caller read. That is the vendored SDK's atomic app
 * delete, the app and its sitemap in one change set (abridged):
 *   --batch_<id>
 *   Content-Type: multipart/mixed;boundary=changeset_<id>
 *
 *   --changeset_<id>
 *   Content-Type: application/http
 *   Content-ID: 1
 *
 *   DELETE https://contoso.crm.dynamics.com/api/data/v9.0/appmodules(<id>) HTTP/1.1
 *   If-Match: W/"1001"
 *
 *   --changeset_<id>--
 *   --batch_<id>--
 * A second send of such a batch meets the rows exactly as the first did, or is refused with 412: it cannot
 * remove anything its caller did not read. No other batch qualifies. Notably the SDK updates a generative
 * page's files in a batch of `If-Match: *` writes after checking their versions itself; sent again after
 * a backoff, that batch would skip the check and overwrite another maker's edit. An unconditional DELETE
 * does not qualify either (the SDK's create rollback sends those; it is sent once, as before).
 */
function isConditionalDeleteBatch(body) {
  if (typeof body !== 'string') return false;
  const lines = body.split(/\r?\n/);
  const ops = [];
  for (let i = 0; i < lines.length; i += 1) {
    const request = /^([A-Z]+) \S+ HTTP\/1\.1$/.exec(lines[i]);
    if (!request) continue;
    let ifMatch;
    for (let j = i + 1; j < lines.length && lines[j] !== ''; j += 1) {
      const m = /^If-Match:\s*(\S.*?)\s*$/i.exec(lines[j]);
      if (m) ifMatch = m[1];
    }
    ops.push({ method: request[1], ifMatch });
  }
  return ops.length > 0 && ops.every((op) => op.method === 'DELETE' && op.ifMatch && op.ifMatch !== '*');
}

/**
 * True when a `$batch` ANSWER proves nothing in it committed, because SQL rolled every operation back as a
 * deadlock victim. A change set is atomic: when an operation in it fails, the whole set is rolled back and
 * only the failing operation is answered. Captured live on a teardown's app delete (HTTP 500 for the
 * batch, abridged):
 *   --batchresponse_<id>
 *   Content-Type: multipart/mixed; boundary=changesetresponse_<id>
 *
 *   --changesetresponse_<id>
 *   Content-Type: application/http
 *   Content-ID: 1
 *
 *   HTTP/1.1 500 Internal Server Error
 *   {"error":{"code":"0x80044150","message":" Sql error: Generic SQL error. ... Sql Number: 1205"}}
 *   --changesetresponse_<id>--
 *   --batchresponse_<id>--
 * The answer is read part by part (the text between delimiter lines, `--<boundary>`), and it proves the
 * rollback only when it is complete (it closes the boundary it opened with: first line `--<boundary>`,
 * last line `--<boundary>--`), it answers at least one operation, and EVERY operation's own part is a 500
 * carrying the deadlock marker. Anything
 * else (one success, another failure, an operation whose part does not name the deadlock itself, a
 * truncated answer) is returned as it came.
 */
function isBatchDeadlockVictim(res) {
  const results = batchResults(res);
  return !!results && results.length > 0 && results.every((r) => r.status === '500' && SQL_DEADLOCK_VICTIM.test(r.text));
}

/**
 * The operations a complete multipart `$batch` answer reports, as `{ status, text }` per part (the text
 * between delimiter lines, `--<boundary>`), or null when the answer is not a complete multipart envelope
 * (its first line `--<boundary>`, its last `--<boundary>--`). Parts without an `HTTP/1.1 <status>` line
 * (the change-set headers) are not operations and are left out.
 */
function batchResults(res) {
  if (!res || typeof res.body !== 'string') return null;
  const lines = res.body.split(/\r?\n/);
  const nonEmpty = lines.map((l) => l.trim()).filter(Boolean);
  const outer = /^--(\S+)$/.exec(nonEmpty[0] || '');
  if (!outer || nonEmpty[nonEmpty.length - 1] !== `--${outer[1]}--`) return null;
  const parts = [];
  let part = null;
  for (const line of lines) {
    if (/^--\S/.test(line)) {
      if (part) parts.push(part);
      part = [];
    } else if (part) {
      part.push(line);
    }
  }
  return parts
    .map((p) => ({ status: (p.map((l) => /^HTTP\/1\.1 (\d{3})\b/.exec(l)).find(Boolean) || [])[1], text: p.join('\n') }))
    .filter((r) => r.status);
}

/**
 * True when a `$batch` ANSWER proves the server refused to START it (HTTP 429), so nothing in it ran.
 * Two shapes qualify:
 *   - the whole request refused before any operation was read: a plain error answer with status 429, not
 *     a multipart one — service protection limits answer this way, e.g.
 *       HTTP 429  {"error":{"code":"0x80072322","message":"Number of requests exceeded the limit of 6000 over time window of 300 seconds."}}
 *   - a complete multipart answer in which EVERY operation it answers is a 429 (read part by part, as
 *     isBatchDeadlockVictim reads a deadlock).
 * An answer that starts as a multipart envelope but is cut short proves nothing and is returned as it came.
 * See: https://learn.microsoft.com/power-apps/developer/data-platform/api-limits
 */
function isBatchThrottled(res) {
  if (!res) return false;
  const body = typeof res.body === 'string' ? res.body : '';
  const first = body.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
  if (!/^--\S/.test(first)) return res.statusCode === 429;
  const results = batchResults(res);
  return !!results && results.length > 0 && results.every((r) => r.status === '429');
}

/**
 * The longest `Retry-After` the throttled operations of a multipart `$batch` answer carry in their OWN
 * headers, in milliseconds (capped as retryAfterMs caps it); 0 when none does. An operation refused
 * inside a batch is answered with its own status line and headers, which the outer response need not
 * repeat:
 *   HTTP/1.1 429 Too Many Requests
 *   Retry-After: 30
 *   Content-Type: application/json; odata.metadata=minimal
 */
function batchRetryAfterMs(res, now = Date.now()) {
  const results = batchResults(res);
  if (!results) return 0;
  let longest = 0;
  for (const r of results) {
    if (r.status !== '429') continue;
    const m = /^Retry-After:[ \t]*(\S.*?)[ \t]*$/im.exec(r.text);
    if (m) longest = Math.max(longest, retryAfterMs({ 'retry-after': m[1] }, now));
  }
  return longest;
}
/**
 * Build an HttpClient bound to one Dataverse org.
 * @param {string} orgUrl - e.g. https://contoso.crm.dynamics.com
 * @param {object} [deps] - test seam: { getToken(orgUrl)->string|null, request(opts)->Promise }
 * @returns {{get,post,patch,delete,put,postRaw}}
 */
function createAzHttpClient(orgUrl, deps = {}) {
  // Same-origin guard: this client attaches an Azure bearer token for the org, and the SDK always
  // calls back with a FULL URL under that org (instanceUrl + /api/data/v9.x/...). To keep the
  // credential boundary fail-closed, construction requires a Dataverse environment ORIGIN (the same
  // check every token request makes, see `dataverseOrigin`), the token is requested for that
  // validated origin rather than the caller's text, and any request to a different origin is refused.
  const expectedOrigin = dataverseOrigin(String(orgUrl));
  if (!expectedOrigin) {
    throw new Error(`Invalid Dataverse org URL "${orgUrl}": expected the environment's https:// origin only (e.g. https://contoso.crm.dynamics.com).`);
  }
  const clean = expectedOrigin;
  function assertSameOrigin(url) {
    let target;
    try { target = new URL(url); } catch { throw new Error(`Refusing to send the Dataverse token to a non-absolute URL: ${url}`); }
    if (target.origin !== expectedOrigin) {
      throw new Error(`Refusing to send the Dataverse token for ${expectedOrigin} to a different origin (${target.origin}); the request URL must be under the --env org URL.`);
    }
  }
  const getToken = deps.getToken || ((u, options) => getAuthToken(u, options));
  const request = deps.request || makeRequest;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const random = deps.random || Math.random;
  const now = deps.now || Date.now;
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
  // The wait before re-sending an answered request: the backoff above, or longer when the answer asks
  // for longer in `Retry-After` (retryAfterMs, capped).
  const retryWaitMs = (res, attempt) => Math.max(backoffMs(attempt), retryAfterMs(res.headers, now()));

  let token = null;
  function ensureToken(options = {}) {
    if (!token) {
      token = getToken(clean, options);
      if (!token) {
        throw new Error(tokenFailureMessage(clean, `Failed to get Azure CLI token for ${clean}. Run 'az login' first.`));
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
    //    SQL-time-out under load and trip exactly this). One delete keeps the failure re-runnable —
    //    unless the server ANSWERS that it did not run it (see the re-sends below).
    //  - A `$batch` change set is a POST, but it CARRIES record deletes (the SDK deletes an app and
    //    its sitemap in one atomic change set), so it inherits the record-delete hazard above. It is
    //    also ambiguous on failure: the server may have committed while the response was lost, so a
    //    blind re-issue is exactly the racing retry that wedges the row. Issue it once and let the
    //    SDK surface the unknown outcome to the caller — unless it is a batch of conditional deletes and
    //    its answer proves no operation in it ran (see the re-sends below).
    const method_ = String(method).toUpperCase();
    const isMetadataDelete = /\/(EntityDefinitions|RelationshipDefinitions|GlobalOptionSetDefinitions)\b/i.test(url);
    const isBatch = method_ === 'POST' && /\/\$batch(\?|$)/i.test(url);
    const recordDelete = method_ === 'DELETE' && !isMetadataDelete;
    const noRetry = recordDelete || isBatch;
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
        // The server ANSWERED (status and headers arrived) and the body was then cut off. A POST may
        // already have been applied — re-sending a create here made a second row — so it is reported
        // as an uncertain outcome rather than replayed. The idempotent rebuild adopts whatever landed.
        // Reads, PATCH/PUT and metadata deletes keep the retry below.
        if (res.incompleteResponse && method_ === 'POST') {
          throw new Error(`Request failed: ${res.error} — the server had already answered ${res.statusCode}, so this POST may have been applied; it was not re-sent. Re-run to reconcile.`);
        }
        if (last || noRetry) throw new Error(`Request failed: ${res.error}`);
        await sleep(backoffMs(attempt));
        continue;
      }
      if (res.statusCode === 401 && !last) {
        // The process-wide token memo is safe for ordinary repeats, but a 401 is the server telling
        // us this token was rejected. The retry must bypass that memo or it can only resend the same
        // rejected bearer value and convert a refresh path into a guaranteed second 401.
        token = getToken(clean, { fresh: true });
        if (!token) {
          throw new Error(tokenFailureMessage(clean, `Failed to refresh Azure CLI token for ${clean}. Run 'az login' first.`));
        }
        continue;
      }
      if (TRANSIENT.has(res.statusCode) && !last && !noRetry) {
        await sleep(retryWaitMs(res, attempt));
        continue;
      }
      // A record DELETE or a `$batch` is otherwise never re-sent (see noRetry). Two ANSWERS are the
      // exceptions, because in each the server says it did not run the request: nothing is still in
      // flight to race the concurrent-delete guard, and nothing was deleted.
      //  - HTTP 429: the server refused to START the request. Measured live, in two teardowns: the
      //    solution delete that ends a teardown, sent right after the teardown's own table delete, was
      //    refused with
      //      HTTP 429 … solutions(<id>): Cannot start the requested operation [Uninstall] because there is
      //      another [EntityCustomization] running at this moment. … Please try again later.
      //    and both teardowns finished with the solution left behind. It is re-sent on the schedule of any
      //    other throttled request, honouring `Retry-After`.
      //  - A SQL deadlock VICTIM: SQL rolled the request's transaction back. Measured live: a teardown's
      //    process-flow delete failed exactly this way, and so did a teardown's app delete — a change set —
      //    which stopped the whole teardown with nothing removed; both were clean on a re-run.
      // A batch is re-sent only when it is made of conditional deletes (isConditionalDeleteBatch) and its
      // answer shows that no operation in it ran (isBatchThrottled, isBatchDeadlockVictim).
      const conditionalDeleteBatch = isBatch && isConditionalDeleteBatch(bodyStr);
      const throttled = (recordDelete && res.statusCode === 429) || (conditionalDeleteBatch && isBatchThrottled(res));
      if (throttled && !last) {
        // A batch refused operation by operation may carry the wait in that operation's own headers.
        await sleep(Math.max(retryWaitMs(res, attempt), isBatch ? batchRetryAfterMs(res, now()) : 0));
        continue;
      }
      const deadlocked = (recordDelete && isSqlDeadlockVictim(res))
        || (conditionalDeleteBatch && isBatchDeadlockVictim(res));
      if (deadlocked && attempt < DEADLOCK_RESENDS) {
        await sleep(1000 * 2 ** attempt);
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

module.exports = { createAzHttpClient, SQL_DEADLOCK_VICTIM, isBatchDeadlockVictim, isBatchThrottled, batchRetryAfterMs, isConditionalDeleteBatch, retryAfterMs, RETRY_AFTER_CAP_MS };
