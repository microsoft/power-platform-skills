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
// after exhausting retries, or at once for a write that must not be re-sent (see `call`) and for a failure
// a resend cannot cure, such as a certificate that does not verify (isTransientTransportFailure). We never
// throw purely on a non-2xx HTTP status. An answer that is not a success comes back with the access
// token taken out of it, and so does a transport failure's text (see "The access token, taken out of what a
// service says"): the SDK quotes such a body in the message a script prints. A success is returned untouched.
const { dataverseOrigin, getAuthToken, makeRequest, tokenFailureMessage } = require('./dataverse-auth.js');

// How Dataverse reports that SQL Server chose a request's transaction as a deadlock VICTIM and rolled
// it back. Two live captures, both HTTP 500 (a process-flow delete during a teardown, and PublishXml):
//   HTTP 500 from …/api/data/v9.0/workflows(<id>):  Sql error: Generic SQL error. CRM ErrorCode: -2147204784 Sql ErrorCode: -2146232060 Sql Number: 1205
//   {"error":{"code":"0x80044150","message":" Sql error: Generic SQL error. CRM ErrorCode: -2147204784 Sql ErrorCode: -2146232060 Sql Number: 1205"}}
// Only the SQL number identifies it; the code and message text are shared with every other SQL error. (The build's own retry, lib/retry-policy.js, reads this same marker — and only in an answer that also carries that code.)
// The number that counts is the LAST one the answer gives. The platform writes its diagnostic (`CRM ErrorCode: … Sql ErrorCode: … Sql Number: <n>`) at the END of a SQL error's message, after the SQL text, and the SQL text can quote what a
// maker named: a duplicate-key error quotes the value that collided, so a name spelled `Sql Number: 1205` is in the answer to a unique-key violation, which no re-send changes:
//   Sql error: Violation of UNIQUE KEY constraint 'ndx_name'. Cannot insert duplicate key. The duplicate key value is (Sql Number: 1205). CRM ErrorCode: -2147204784 Sql ErrorCode: -2146232060 Sql Number: 2627
// So the signature is `Sql Number: 1205` with no other `Sql Number: <digits>` after it: the number at the end decides, and a name in front of it decides nothing, whether it quotes the deadlock's number or another one. It is one pattern
// for everything that reads the marker (the build's retry and the text fallback of its words included). `(?:(?!…)[\s\S])*$` reads on to the end of the text for as long as no further number starts — each candidate is read only as far
// as the next number, so a message that repeats the marker tens of thousands of times is read in linear time, not quadratic.
// The vendored SDK matches the marker anywhere in a 500's body for its own re-send (1 s / 2 s / 4 s) of reads, an app create,
// PublishXml, a form create, a view create and a publisher create — requests this client has already re-sent by
// then, because it re-sends every 5xx that is not a record delete or a $batch (TRANSIENT, below). So a deadlock the
// client clears costs one re-send in all and the SDK's never fires; one that never clears is attempted up to the
// client's six times per SDK attempt (24 in all, measured on a form create and on a view create), a ceiling on a
// pathological case. A record DELETE and a conditional-delete $batch are the exception: this client re-sends their
// deadlocks itself (below), and the SDK re-sends an app delete only for a different answer — the platform's
// search-index race (HTTP 400, SQL 547) — so the two never act on the same one. The deletes of a row-summary
// removal are the one record delete whose deadlock the SDK re-sends as well (a 500 carrying SQL 1205, or a 400
// quoting SQL's "chosen as the deadlock victim"): a 500 is re-sent by this client first, so one that clears costs
// one re-send in all and one that never clears at most 16 attempts (this client's four per SDK attempt). All of it
// is pinned against the real bundle in sdk-resend-layers.test.js.
//
// The one other `$batch` this client sends again is a change set that only CREATES columns (a new table's ordinary columns, see
// isColumnCreateBatch), and only after a 429: the platform refused to start it, so nothing in it committed (a change set is
// atomic) and it goes out again on the throttle schedule. After any other answer, a deadlock included, it is sent once, because a
// change set can commit behind a lost or failed answer; the SDK has no re-send of its own for it, so the layers never multiply
// here either. Pinned through the real client and bundle in table-columns-in-create.test.js and in sdk-http-client.test.js.
const SQL_DEADLOCK_VICTIM = /\bSql Number:\s*1205\b(?:(?!\bSql Number:\s*\d)[\s\S])*$/i;
// At most this many re-sends of a deadlock victim, 1 s / 2 s / 4 s apart — the SDK's own schedule.
const DEADLOCK_RESENDS = 3;
// The longest `Retry-After` honoured in full. Dataverse's service protection limits answer 429 with
// `Retry-After` in seconds and ask the caller to wait that long; a request sent sooner is refused again
// and spends one of the few attempts. The cap keeps a large value from stalling a build or a teardown
// for minutes per attempt. A client given a run's throttle budget (`deps.throttle`) does not use it for a throttled answer: the budget
// bounds all of its waits together, and what the service asked is waited whole when it fits and not at all when it does not.
// See: https://learn.microsoft.com/power-apps/developer/data-platform/api-limits#retry-operations
const RETRY_AFTER_CAP_MS = 60000;

// An OData raw-value read — `…/uxagentprojectfiles(<id>)/filecontent/$value`, or any other `$value` — answers the stored bytes
// themselves, so the client hands them back untouched (createAzHttpClient's `get`).
const RAW_VALUE = /\/\$value(?:\?|$)/;

/**
 * The wait a response asks for in `Retry-After`, in milliseconds, capped at `cap` (RETRY_AFTER_CAP_MS unless a caller says otherwise); 0 when
 * the header is absent or unreadable. RFC 9110 allows two forms, delay-seconds and an HTTP date:
 *   Retry-After: 20
 *   Retry-After: Wed, 30 Sep 2026 10:00:20 GMT
 * Node lowercases response header names; a test double may not, so the name is matched case-insensitively.
 * The cap is for this client's own retries, which must not stall a build for minutes per attempt. A caller that has a bound of its own on the whole of what it waits passes `Infinity` and gets the
 * service's request as it is, to decide for itself whether it fits: solution-settings.js, when it sends a refused import again, inside one budget for the whole retry; the page backend, which spends a
 * run's throttle budget (lib/throttle-budget.js); and this client itself when it was given that budget, for the throttled answers it waits out (waitOutThrottle).
 * See: https://www.rfc-editor.org/rfc/rfc9110#field.retry-after
 */
function retryAfterMs(headers, now = Date.now(), cap = RETRY_AFTER_CAP_MS) {
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
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, cap) : 0;
}

/**
 * The wait before send number `attempt` + 1 of a throttled request, in milliseconds: capped exponential backoff with jitter. Metadata customizations serialize on a per-entity lock; when several
 * artifacts (forms/views/charts) for the same table retry concurrently, a fixed schedule wakes them in lockstep so they re-collide forever. Jitter de-syncs them.
 * The BASE is capped at 8000 ms (1 s, 2 s, 4 s, 8 s, 8 s); the returned delay then adds up to +25% jitter on top, so the actual sleep can exceed 8000 ms (e.g. ~9000 ms). The cap is on the base, not the final sleep —
 * jitter is intentionally allowed to push past it to de-sync lockstep collisions.
 * It is exported because the page backend waits out a throttled page write on this same schedule (lib/genpage-sdk.js): a page's change set is not re-sent by this client (see `call`), so the wait is the backend's,
 * and it is the one every other throttled request gets.
 */
function throttleBackoffMs(attempt, random = Math.random) {
  const base = Math.min(1000 * 2 ** attempt, 8000);
  return base + Math.floor(random() * base * 0.25);
}

/** True when a raw transport response says SQL rolled this request back as a deadlock victim. */
function isSqlDeadlockVictim(res) {
  if (!res || res.statusCode !== 500 || res.body === undefined || res.body === null) return false;
  return SQL_DEADLOCK_VICTIM.test(typeof res.body === 'string' ? res.body : JSON.stringify(res.body));
}

/**
 * The operations a `$batch` REQUEST carries, as `{ method, url, ifMatch }` in the order sent, read from the request lines
 * (`<METHOD> <url> HTTP/1.1`) the SDK renders — see isConditionalDeleteBatch and isColumnCreateBatch for the shapes. `ifMatch` is the
 * operation's own `If-Match` header when it has one. A body that is not text carries none.
 */
function batchOperations(body) {
  if (typeof body !== 'string') return [];
  const lines = body.split(/\r?\n/);
  const ops = [];
  for (let i = 0; i < lines.length; i += 1) {
    const request = /^([A-Z]+) (\S+) HTTP\/1\.1$/.exec(lines[i]);
    if (!request) continue;
    let ifMatch;
    for (let j = i + 1; j < lines.length && lines[j] !== ''; j += 1) {
      const m = /^If-Match:\s*(\S.*?)\s*$/i.exec(lines[j]);
      if (m) ifMatch = m[1];
    }
    ops.push({ method: request[1], url: request[2], ifMatch });
  }
  return ops;
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
 * remove anything its caller did not read. No other batch qualifies, bar the column creates of
 * isColumnCreateBatch (after a 429 only). Notably the SDK updates a generative
 * page's files in a batch of `If-Match: *` writes after checking their versions itself; sent again after
 * a backoff, that batch would skip the check and overwrite another maker's edit. An unconditional DELETE
 * does not qualify either (the SDK's create rollback sends those; it is sent once, as before).
 */
function isConditionalDeleteBatch(body) {
  const ops = batchOperations(body);
  return ops.length > 0 && ops.every((op) => op.method === 'DELETE' && op.ifMatch && op.ifMatch !== '*');
}

// The collection a column is created in: `…/EntityDefinitions(LogicalName='new_ticket')/Attributes`.
const COLUMN_COLLECTION_URL = /\/EntityDefinitions\([^)]*\)\/Attributes$/;

/**
 * True when a `$batch` REQUEST only CREATES columns: every operation is a POST to a table's `Attributes` collection. That is the
 * vendored SDK's createColumns, the ordinary columns of a new table in one change set (abridged):
 *   --batch_<id>
 *   Content-Type: multipart/mixed;boundary=changeset_<id>
 *
 *   --changeset_<id>
 *   Content-Type: application/http
 *   Content-ID: 1
 *
 *   POST https://contoso.crm.dynamics.com/api/data/v9.0/EntityDefinitions(LogicalName='new_ticket')/Attributes HTTP/1.1
 *   Content-Type: application/json;type=entry
 *   MSCRM.SolutionUniqueName: <solution>
 *
 *   {"@odata.type":"Microsoft.Dynamics.CRM.StringAttributeMetadata",...}
 *   --changeset_<id>--
 *   --batch_<id>--
 * It carries no delete and no write conditioned on a row version, so — unlike every other batch — a second send after an answer that
 * proves nothing in it committed (HTTP 429, see isBatchThrottled; a change set is atomic) cannot remove or overwrite anything. The worst a second send can meet is
 * a column that is already there, which the platform refuses whole ("already exists", 0x80060304); the caller falls back to one
 * request per column, where an existing column is skipped. Sent once after any other answer, as before: a change set can commit
 * behind a lost answer.
 */
function isColumnCreateBatch(body) {
  const ops = batchOperations(body);
  return ops.length > 0 && ops.every((op) => op.method === 'POST' && COLUMN_COLLECTION_URL.test(op.url));
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
 * The answer is read part by part (batchResults), and it proves the rollback only when it is a complete, well-formed envelope (its outer boundary closed, every change set in it declared, opened and closed, every part a complete response with a
 * status line and no transfer coding, and no part with no response in it), it answers at least one operation, and EVERY operation's own part is a 500 whose answer ends in the deadlock marker (SQL_DEADLOCK_VICTIM: the LAST SQL number it gives is
 * 1205). Anything else (one success, another failure, an operation whose part does not name the deadlock itself, a
 * truncated answer, an answer that closes its outer boundary and is incomplete inside) is returned as it came.
 */
function isBatchDeadlockVictim(res) {
  const results = batchResults(res);
  return !!results && results.length > 0 && results.every((r) => r.status === '500' && SQL_DEADLOCK_VICTIM.test(r.text));
}

// The characters RFC 2046 allows in a multipart boundary: a line that opens with two dashes and goes on with anything else (an HTML comment's `-->`, `--- end of trace ---`) is TEXT, never a delimiter. This says only that a line LOOKS
// like the delimiter of some boundary; whose delimiter it is, is decided by the part that declares the boundary (headersOf, partsOf).
// See: https://www.rfc-editor.org/rfc/rfc2046#section-5.1.1
const DELIMITER_LIKE_LINE = /^--[0-9A-Za-z'()+_,./:=?-]+$/;
// A line of a part's own MIME header block (`Content-Type: application/http`, `Content-ID: 1`), and a header folded onto the line before it (a line that starts with white space). A header name is an RFC 9110 token; a status
// line (`HTTP/1.1 204 No Content`) is not one — it has a slash before any colon — so it starts the response and ends the headers even when no blank line separates them.
const MIME_HEADER_LINE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+:/;
const FOLDED_HEADER_LINE = /^[ \t]+\S/;
const STATUS_LINE = /^HTTP\/1\.1 (\d{3})\b/;
// A status line of ANY HTTP version: a second one inside a response is the next response, swallowed into this one's body (readResponse).
const ANY_STATUS_LINE = /^HTTP\/\d(?:\.\d)? \d{3}\b/;
const isBlank = (line) => line.trim() === '';

/**
 * An answer as `{ lines, breaks }`: its lines, and the line break that ENDS each (`\r\n`, `\n`, or nothing after the last line). A `Content-Length` counts the bytes of a body, the line breaks inside it included, so a body is
 * measured from the breaks the answer really has (textOf) and not from a guess that they are all CRLF. A byte order mark in front of the first line is not part of it.
 */
function linesOf(text) {
  // 'a\r\nb\n' splits into ['a', '\r\n', 'b', '\n', '']: a line, the break that ends it, a line, its break, and the empty line after the last break.
  const pieces = text.replace(/^\uFEFF/, '').split(/(\r?\n)/);
  const lines = [];
  const breaks = [];
  for (let i = 0; i < pieces.length; i += 2) {
    lines.push(pieces[i]);
    breaks.push(pieces[i + 1] || '');
  }
  return { lines, breaks };
}

// The text of the lines `from` up to `to`, with the breaks the answer has between them. The break after the last of them is not part of it: in front of a delimiter, that break belongs to the delimiter's line (RFC 2046, 5.1.1).
function textOf(doc, from, to) {
  let text = '';
  for (let i = from; i < to; i += 1) text += i < to - 1 ? doc.lines[i] + doc.breaks[i] : doc.lines[i];
  return text;
}

/**
 * The parts of a multipart body — the lines `from` up to `to` — as `[start, end)` ranges of lines, or null when the body is not what its `boundary` says. A part is what lies between two delimiters:
 *   <blank lines>
 *   --<boundary>            opens the first part; nothing but blank lines may come before it
 *   <part>
 *   --<boundary>            ends that part and opens the next
 *   <part>
 *   --<boundary>--          ends the last part and the body; nothing but blank lines may come after it
 * A body that is never opened, never closed, closed before it is opened, or has text outside its delimiters is null: a part with a delimiter missing on either side was not delivered whole. A delimiter is its whole line, but for the
 * white space that may pad it (RFC 2046, 5.1.1). A body whose opening delimiter is followed at once by its closing one holds one part with no line in it — what an operation that nobody answered looks like.
 */
function partsOf(doc, from, to, boundary) {
  const open = `--${boundary}`;
  const close = `${open}--`;
  const parts = [];
  let start = -1;
  for (let i = from; i < to; i += 1) {
    const text = doc.lines[i].trimEnd();
    if (text !== open && text !== close) {
      if (start < 0 && text !== '') return null;
      continue;
    }
    if (start >= 0) parts.push([start, i]);
    else if (text === close) return null;
    if (text === close) return doc.lines.slice(i + 1, to).every(isBlank) ? parts : null;
    start = i + 1;
  }
  return null;
}

/**
 * The MIME headers a part starts with, and where the rest of it begins (`bodyFrom`, the line after the last header): the media type of its first `Content-Type`, lowercased, and that header's `boundary` parameter — each null when
 * the part does not say. A header can be folded onto the lines after it:
 *   Content-Type: multipart/mixed;
 *    boundary="changesetresponse_<id>"
 * A part that has no header starts with a blank line or, directly, with the status line of its response.
 */
function headersOf(doc, from, to) {
  let at = from;
  let type = null;
  let boundary = null;
  while (at < to && MIME_HEADER_LINE.test(doc.lines[at])) {
    let header = doc.lines[at];
    at += 1;
    while (at < to && FOLDED_HEADER_LINE.test(doc.lines[at])) {
      header += ` ${doc.lines[at].trim()}`;
      at += 1;
    }
    const declared = /^content-type:\s*([^;\s]+)(.*)$/i.exec(header);
    if (declared && type === null) {
      type = declared[1].toLowerCase();
      // `boundary=changesetresponse_1`, or quoted: `boundary="changesetresponse_1"`. The parameter's name is not case-sensitive, its value is.
      const parameter = /;\s*boundary\s*=\s*(?:"([^"]*)"|([^\s;"]+))/i.exec(declared[2]);
      boundary = (parameter && (parameter[1] || parameter[2])) || null;
    }
  }
  return { type, boundary, bodyFrom: at };
}

/**
 * Reads the response an operation's part holds — the lines `bodyFrom` (after the part's own MIME headers) up to `to` — and adds it to `results`, with `text` the part's lines from `from`. False unless the part holds exactly one
 * COMPLETE response (abridged, with the part's MIME headers above the blank line):
 *   Content-Type: application/http
 *   Content-ID: 1
 *
 *   HTTP/1.1 403 Forbidden
 *   Content-Type: application/json; odata.metadata=minimal
 *   Content-Length: 27
 *
 *   {"error":{"message":"No."}}
 * A response is complete when:
 *   - It has a status line, `HTTP/1.1 <3 digits>`, as its first line after the blank ones. A part with none — blank, only headers, or cut off in the status line (`HTTP/1.1 20`) — is an operation that nobody answered; the
 *     refusal in the part beside it says nothing about that one.
 *   - It is ONE response. A line that looks like a delimiter (`--changesetresponse_<id>`, or half of one) or a second status line, after the first, is the next part swallowed into this one's body by a delimiter that was damaged: no
 *     ordinary body has one (it is JSON). Without this a damaged delimiter between two operations left the first part to speak for both.
 *   - Its body is as long as it says. `Content-Length: <n>` (more than one, only when they agree) counts the bytes after the blank line that ends the headers: fewer bytes are a body cut off, and more than blank ones are
 *     not the body that was counted. A response with no such blank line (its headers are its last lines) has no body, and a response that does not count its body is not held to a length.
 *   - Its body has no transfer coding. `Transfer-Encoding: chunked` (or any other) frames a body in a way the delimiters around the part say nothing about — whether the chunk stream is whole (a terminal `0` chunk, each chunk the size it
 *     announces, a trailer that ends) is not something this reader checks, and a stream cut off inside a part whose boundaries all close would be taken for a complete response (abridged; no terminal chunk follows the `{}`):
 *       HTTP/1.1 429 Too Many Requests
 *       Retry-After: 7
 *       Transfer-Encoding: chunked
 *
 *       2
 *       {}
 *     So a part that declares one is not read at all, whole stream or not: it never certifies a refusal or a deadlock victim. The service's own batch answers carry neither this header nor a `Content-Length` on a part, as far as its
 *     documented samples show (https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/execute-batch-operations-using-web-api#batch-responses), so no answer it is known to give is lost. The `Content-Transfer-Encoding:
 *     binary` every part names in its MIME headers is not a transfer coding of the response, and a line of the BODY spelled like one is a body.
 * What the response's headers say is otherwise not read: it is the status line that makes a response, and the real service's shape after it (one blank line or two) is not something to turn an answer away for.
 */
function readResponse(doc, from, bodyFrom, to, results) {
  let at = bodyFrom;
  while (at < to && isBlank(doc.lines[at])) at += 1;
  const status = at < to ? STATUS_LINE.exec(doc.lines[at]) : null;
  if (!status) return false;
  let headersEnd = -1;
  const lengths = [];
  for (let i = at + 1; i < to; i += 1) {
    const text = doc.lines[i].trimEnd();
    if (DELIMITER_LIKE_LINE.test(text) || ANY_STATUS_LINE.test(text)) return false;
    if (headersEnd >= 0) continue;
    if (text === '') {
      headersEnd = i;
      continue;
    }
    // Matched with or without white space before the colon, as the length is: a server that is loose about the syntax is still declaring one, and a declaration is all that is looked for.
    if (/^transfer-encoding[ \t]*:/i.test(text)) return false;
    const length = /^content-length[ \t]*:[ \t]*(.*)$/i.exec(text);
    if (length) lengths.push(length[1]);
  }
  if (lengths.length > 0) {
    if (!/^\d+$/.test(lengths[0]) || lengths.some((value) => value !== lengths[0])) return false;
    const body = Buffer.from(headersEnd < 0 ? '' : textOf(doc, headersEnd + 1, to));
    const counted = Number(lengths[0]);
    if (body.length < counted || body.subarray(counted).toString().trim() !== '') return false;
  }
  results.push({ status: status[1], text: doc.lines.slice(from, to).join('\n') });
  return true;
}

/**
 * Reads one part of an answer — the lines `from` up to `to` — and adds the operation it holds to `results`. True when the part is a change set whose every part reads, or one COMPLETE operation; false for anything else.
 *   - A change set is a part that declares a multipart body (`Content-Type: multipart/mixed; boundary=<change set>`) and then HAS one: it opens with `--<change set>` and closes with `--<change set>--`, and nothing but blank lines
 *     lies outside those two delimiters (partsOf). It must say its boundary, or the delimiters inside it cannot be told from text; one that is declared and never opened, opened and never closed, delimited by another boundary, or found
 *     inside another change set (`depth`) is not one the answer contains.
 *   - An operation is a part of `Content-Type: application/http` — or of no type — that holds one complete response (readResponse).
 *   - Nothing else is a part: another type, or no line at all, is not an operation that was answered.
 */
function readPart(doc, from, to, depth, results) {
  const head = headersOf(doc, from, to);
  if (head.type !== null && head.type.startsWith('multipart/')) {
    if (depth > 0 || head.boundary === null) return false;
    const parts = partsOf(doc, head.bodyFrom, to, head.boundary);
    return parts !== null && parts.every(([start, end]) => readPart(doc, start, end, depth + 1, results));
  }
  if (head.type !== null && head.type !== 'application/http') return false;
  return readResponse(doc, from, head.bodyFrom, to, results);
}

/**
 * The operations a complete, well-formed multipart `$batch` answer reports, as `{ status, text }` per operation (`text` is every line of its part, headers included), or null when the answer is anything else. Every
 * operation is a part of a change set, which is itself a part of the answer — the shape the service answers with (abridged; the live capture quoted at isBatchDeadlockVictim is of the same shape):
 *   --batchresponse_<id>
 *   Content-Type: multipart/mixed; boundary=changesetresponse_<id>
 *
 *   --changesetresponse_<id>
 *   Content-Type: application/http
 *   Content-Transfer-Encoding: binary
 *   Content-ID: 1
 *
 *   HTTP/1.1 204 No Content
 *   OData-Version: 4.0
 *
 *   --changesetresponse_<id>--
 *   --batchresponse_<id>--
 * The callers prove something about EVERY operation from this — that a change set was refused, or rolled back as a deadlock victim, as a whole (isBatchThrottled, isBatchDeadlockVictim, completeBatchStatus) — so the answer
 * is read only when ALL of it holds, what its parts hold as well as how they are delimited:
 *   - it is the multipart body of the boundary on its first line (partsOf): that outer delimiter `--<boundary>` opens it, the closing `--<boundary>--` ends it, and nothing but blank lines lies outside them;
 *   - a part that declares a multipart body is a change set (readPart): it names its boundary, and opens and closes exactly that boundary before the outer boundary goes on or closes. A change set the answer declares and never
 *     contains, one it opens and never closes, one whose delimiters are another boundary's, and one inside another change set are all out;
 *   - every other part is ONE COMPLETE operation (readResponse): a response that starts with a status line, whose body is as long as its `Content-Length` says and has no transfer coding (a part that declares a `Transfer-Encoding`, whole
 *     stream or not, is not read: whether a chunk stream is finished is not what the delimiters around it say). A part with no response in it is an operation nobody answered.
 * Anything missing or malformed — a change set left open or declared and absent, a part with no response at all, one with no status line or one cut off (`HTTP/1.1 20`), a body shorter than its `Content-Length`, a part that declares a
 * transfer coding, a part of another kind, text after a closing delimiter — makes the WHOLE answer null: a part that cannot be read is not one that can be left out, it may be the operation that succeeded. (Parts without a status line
 * used to be dropped, so an answer that closed its OUTER boundary proved the one part in it that happened to read; and a part with no response in it, or a change set declared and never opened, was let through the same way.)
 * See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/execute-batch-operations-using-web-api (the format is the OData batch's, 11.7 of
 * http://docs.oasis-open.org/odata/odata/v4.0/errata03/os/complete/part1-protocol/odata-v4.0-errata03-os-part1-protocol-complete.html)
 */
function batchResults(res) {
  if (!res || typeof res.body !== 'string') return null;
  const doc = linesOf(res.body);
  const first = doc.lines.findIndex((line) => !isBlank(line));
  const outer = first < 0 ? null : /^--(\S+)$/.exec(doc.lines[first].trim());
  if (!outer) return null;
  const parts = partsOf(doc, 0, doc.lines.length, outer[1]);
  const results = [];
  return parts !== null && parts.every(([start, end]) => readPart(doc, start, end, 0, results)) ? results : null;
}

/**
 * True when a `$batch` ANSWER proves the server refused it (HTTP 429), so nothing in it committed. A plain 429 means no operation
 * was even read; in a change set, which is atomic, an operation refused with a 429 takes the operations before it with it.
 * Two shapes qualify:
 *   - the whole request refused before any operation was read: a plain error answer with status 429, not
 *     a multipart one — service protection limits answer this way, e.g.
 *       HTTP 429  {"error":{"code":"0x80072322","message":"Number of requests exceeded the limit of 6000 over time window of 300 seconds."}}
 *   - a complete, well-formed multipart answer (batchResults) in which EVERY operation it answers is a 429 (read part by part, as
 *     isBatchDeadlockVictim reads a deadlock).
 * An answer that starts as a multipart envelope but is cut short, or is incomplete inside (a change set never closed, or declared and never opened; a part with no response in it, or with no status line; a body shorter than its response says;
 * a part that declares a transfer coding), proves nothing and is returned as it came.
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
 * headers, in milliseconds (capped as retryAfterMs caps it, at `cap`); 0 when none does. An operation refused
 * inside a batch is answered with its own status line and headers, which the outer response need not
 * repeat:
 *   HTTP/1.1 429 Too Many Requests
 *   Retry-After: 30
 *   Content-Type: application/json; odata.metadata=minimal
 */
function batchRetryAfterMs(res, now = Date.now(), cap = RETRY_AFTER_CAP_MS) {
  const results = batchResults(res);
  if (!results) return 0;
  let longest = 0;
  for (const r of results) {
    if (r.status !== '429') continue;
    const m = /^Retry-After:[ \t]*(\S.*?)[ \t]*$/im.exec(r.text);
    if (m) longest = Math.max(longest, retryAfterMs({ 'retry-after': m[1] }, now, cap));
  }
  return longest;
}

/**
 * The one HTTP status a COMPLETE multipart `$batch` answer reports for every operation it answers — 0 when the answer is not a complete, well-formed envelope (read as isBatchThrottled reads one, by batchResults: closed at its outer
 * boundary, every change set in it declared, opened and closed, every part a complete response with a status line and no transfer coding), has no operation, or its operations do not all say the same. A change set the service refuses AS A WHOLE is answered HTTP 200 with
 * the single part that failed (abridged):
 *   --batchresponse_<id>
 *   Content-Type: multipart/mixed; boundary=changesetresponse_<id>
 *
 *   --changesetresponse_<id>
 *   Content-Type: application/http
 *   Content-ID: 1
 *
 *   HTTP/1.1 403 Forbidden
 *   Content-Type: application/json; odata.metadata=minimal
 *   --changesetresponse_<id>--
 *   --batchresponse_<id>--
 * so what the SDK sees — one result for twelve operations — is an answer it cannot account for, and the status the part carries is what says why. Which statuses a caller is looking for is its own business:
 * a change set that succeeded is uniform too (every part 204).
 */
function completeBatchStatus(res) {
  const results = batchResults(res);
  if (!results || results.length === 0) return 0;
  return results.every((r) => r.status === results[0].status) ? Number(results[0].status) : 0;
}

// ---- Which failures of the transport are worth sending a request again for ----------------------------------------------------------------
// `res` is what makeRequest (lib/dataverse-auth.js) reports when the request itself failed: Node's own message for the error and — when Node gave one — its CODE, which the message spells only by chance:
//   { error: 'read ECONNRESET', code: 'ECONNRESET' }       { error: 'write EPIPE', code: 'EPIPE' }       { error: 'connect ETIMEDOUT 10.0.0.1:443', code: 'ETIMEDOUT' }       { error: 'getaddrinfo EAI_AGAIN contoso.crm.dynamics.com', code: 'EAI_AGAIN' }
//   { error: 'socket hang up', code: 'ECONNRESET' }       { error: 'Client network socket disconnected before secure TLS connection was established', code: 'ECONNRESET' }        (a reset in the middle of the TLS handshake)
//   { error: 'Request timed out' }       { error: 'Response aborted before it completed' }       { error: 'Response failed before it completed: aborted' }       { error: 'Connection closed before the response completed' }       (this module's own words: no code)
// A reset, a timeout, an answer cut off and a TEMPORARY failure of name resolution (EAI_AGAIN) can be gone on the next send, and are what this client sends again, on the throttle schedule. Nothing else is:
// a failure to VERIFY the server's certificate is a fact about this machine's trust store and the server, the same on every send, and sending the request six times only waited 23 s for the same refusal —
//   unable to verify the first certificate  (UNABLE_TO_VERIFY_LEAF_SIGNATURE)     certificate has expired  (CERT_HAS_EXPIRED)     self-signed certificate  (DEPTH_ZERO_SELF_SIGNED_CERT)
//   self-signed certificate in certificate chain  (SELF_SIGNED_CERT_IN_CHAIN)     Hostname/IP does not match certificate's altnames: …  (ERR_TLS_CERT_ALTNAME_INVALID)     …certificate verify failed
// — and neither is a host that does not exist (ENOTFOUND), a refused connection (ECONNREFUSED) or a message nobody recognises. So it is a list of what IS worth another send, and the rest returns at once.
// WHAT DECIDES is Node's code, when the failure came with one: a code in TRANSIENT_TRANSPORT_CODES is sent again and any other code is final, whatever the words beside it say. A certificate that does not verify quotes the host and the
// names the certificate carries, a name can spell anything (`DNS:ECONNRESET.example.com` is a valid alternative name), and a transient word found ANYWHERE in such a message sent the request six times. Only a failure with NO code — one this
// module words itself, or a transport that reports none — is read by its words, and there the phrases of a certificate that does not verify (CERTIFICATE_FAILURE) are read first, so a name quoted in them is not a reset either.
// Both are the same list lib/retry-policy.js uses to tell the build a failure is a blip (TRANSPORT_CODES, TRANSPORT_WORDS, CERTIFICATE_WORDS), kept equal by a test: this file is copied into the pcf plugin, which has no policy.
// See https://nodejs.org/api/errors.html#common-system-errors, https://nodejs.org/api/tls.html#x509-certificate-error-codes and https://docs.openssl.org/3.0/man1/openssl-verification-flags/
const TRANSIENT_TRANSPORT_CODES = Object.freeze(new Set(['ECONNRESET', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNABORTED', 'EPIPE', 'EAI_AGAIN']));
const TRANSIENT_TRANSPORT_FAILURE = /\b(?:ECONNRESET|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNABORTED|EPIPE|EAI_AGAIN)\b|socket hang up|timed out|Connection closed before the response completed|Response (?:aborted|failed) before it completed|Client network socket disconnected before secure TLS connection was established/i;
// What Node and OpenSSL say when a certificate does not verify. Each phrase has a space or a slash in it, which no host name has, so a name that a transient message quotes cannot spell one; and each is the text of a code of Node's own list.
const CERTIFICATE_FAILURE = new RegExp([
  'unable to verify the (?:first|leaf) certificate', // UNABLE_TO_VERIFY_LEAF_SIGNATURE
  'unable to get (?:local )?issuer certificate', // UNABLE_TO_GET_ISSUER_CERT, UNABLE_TO_GET_ISSUER_CERT_LOCALLY
  'self[- ]signed certificate', // DEPTH_ZERO_SELF_SIGNED_CERT, SELF_SIGNED_CERT_IN_CHAIN
  'certificate (?:has expired|is not yet valid|revoked|not trusted|rejected|signature failure|chain too long|verify failed)', // CERT_HAS_EXPIRED, CERT_NOT_YET_VALID, CERT_REVOKED, CERT_UNTRUSTED, CERT_REJECTED, … and OpenSSL 3's own
  'invalid CA certificate', // INVALID_CA
  "does not match certificate's altnames", // ERR_TLS_CERT_ALTNAME_INVALID: "Hostname/IP does not match certificate's altnames: Host: <host>. is not in the cert's altnames: DNS:<name>, …"
].join('|'), 'i');
function isTransientTransportFailure(error, code) {
  if (typeof code === 'string' && code) return TRANSIENT_TRANSPORT_CODES.has(code);
  const words = String(error);
  return !CERTIFICATE_FAILURE.test(words) && TRANSIENT_TRANSPORT_FAILURE.test(words);
}
// The error thrown for a request that failed: the same message as ever — the caller has taken the access token out of it (scrubText, below) — with Node's code on it when Node gave one, which is Node's
// own name for the failure (`ECONNRESET`), never the request's or the service's words, so there is nothing in it to take out. The SDK wraps whatever this client throws in a ConnectionError of status 0 and keeps it as that error's `cause`, and the
// build's retry decision (lib/retry-policy.js) reads the code there — so a certificate that does not verify is not run again because a name in its message spells a reset.
function transportError(res, message) {
  return Object.assign(new Error(message), typeof res.code === 'string' && res.code ? { code: res.code } : {});
}

// ---- The access token, taken out of what a service says -----------------------------------------------------------------------------
// An answer that is not a success is what an SDK makes an error message of — `ConnectionError` QUOTES the body, and the scripts print that message — and an authorization layer, or a gateway,
// that rejects a token may repeat it: whole, or one part of it. So the client takes the token out of such an answer, and out of a transport failure's text, before the SDK can see it. A SUCCESS is
// never touched: its bytes are the caller's data. The same rule keeps the Power Apps client's answers clean (lib/power-apps-service-client.js takes `scrub` and `scrubAnswer` from here, which is
// why they are exported: there is one scrubber).
//
// Not the token alone: what an error or a gateway repeats of a bearer token is often one part of it. A token is `header.payload.signature` (three base64url parts joined by dots;
// https://www.rfc-editor.org/rfc/rfc7519#section-3), so each part long enough to be distinctive is taken out too.
const MIN_TOKEN_PART_LENGTH = 24;
// What takes the place of a token, or of a part of one, in a text.
const TOKEN_MARKER = '<token>';
// The texts of one token that are taken out of a message: the token itself and each of its parts that is long enough to be distinctive, the longest first, once each. The one list the Dataverse client's scrubber
// and the SDK factory's guard (lib/sdk-failure-scrub.js) both read, so what one takes out the other takes out.
function needlesOf(token) {
  const needles = new Set([token]);
  for (const part of token.split('.')) if (part.length >= MIN_TOKEN_PART_LENGTH) needles.add(part);
  return [...needles].sort((a, b) => b.length - a.length);
}
function scrub(text, token) {
  const message = String(text);
  if (!token) return message;
  return needlesOf(token).reduce((out, needle) => out.split(needle).join(TOKEN_MARKER), message);
}

// The same for a whole ANSWER: every string of it is scrubbed, keys included, whatever the status: the rest of the answer is left as it is, so the status and the typed `error.code` the SDK reads survive.
// A structure nested deeper than a real answer is, is replaced rather than walked (recursion on a body nested thousands of levels deep must not be what fails the read).
const MAX_SCRUB_DEPTH = 100;
function scrubAnswer(value, token, depth = 0) {
  if (typeof value === 'string') return scrub(value, token);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_SCRUB_DEPTH) return '<too deeply nested to scrub>';
  if (Array.isArray(value)) return value.map((item) => scrubAnswer(item, token, depth + 1));
  const scrubbed = {};
  for (const [key, item] of Object.entries(value)) scrubbed[scrub(key, token)] = scrubAnswer(item, token, depth + 1);
  return scrubbed;
}

// A value shorter than this is no access token (the Azure CLI's are JWTs of hundreds of characters), and taking it out of a message would blank every place the message has the same few letters.
// The Power Apps client has no such floor: it is given a token by one function, and a short one there is a test's.
const MIN_SCRUBBED_TOKEN_LENGTH = 16;

// Every access token a client of this PROCESS has sent, kept for the one place that cannot be handed the client: what an SDK raises is cleaned where it leaves the SDK (lib/sdk-failure-scrub.js, applied by the factory every
// script makes its SDK with), because a failure the service quotes from inside a SUCCESSFUL answer — a change set it refuses as a whole is answered HTTP 200 with the part that failed — is quoted into the SDK's error after
// this client has returned the answer, and an answer that is a success is returned exactly as it came (the strict readers of a `$batch` count its bytes). A token joins the list when a request that carries it is about to
// be sent, never before, and only if it is long enough to be one: the same floor the client's own scrubbing has. The list is not per client on purpose — a service may repeat a token it was sent by any of them, and a wrapper
// over a client or a copy of it (a spread, a Proxy) must not hide the list from the factory.
const tokensSentByProcess = new Set();
/** Every access token a client of this process has sent, once each, the first sent first. */
function sentTokens() {
  return [...tokensSentByProcess];
}

/** `text` with the access token that `headers` carry (`Authorization: Bearer <token>`) taken out of it, for a caller that has the words of a transport failure and the request it was sending. */
function scrubBearer(text, headers) {
  const entry = headers && typeof headers === 'object' ? Object.entries(headers).find(([name]) => name.toLowerCase() === 'authorization') : undefined;
  const bearer = entry && /^Bearer\s+(\S+)$/i.exec(String(entry[1]));
  return bearer && bearer[1].length >= MIN_SCRUBBED_TOKEN_LENGTH ? scrub(text, bearer[1]) : String(text);
}
/**
 * Build an HttpClient bound to one Dataverse org.
 * @param {string} orgUrl - e.g. https://contoso.crm.dynamics.com
 * @param {object} [deps] - test seam: { getToken(orgUrl)->string|null, request(opts)->Promise }, and two things a caller may set:
 *   `sendOnce(method, url)` -> true for a request that must be sent exactly once, whatever answers it (see `once` in `call`); and
 *   `throttle`, the budget a run allows itself for waiting out a throttled service (lib/throttle-budget.js: `fits`, `spend`, `announce`, `decline`, `note`), which every wait this client takes for a throttled answer (HTTP 429) is
 *   then drawn from — see `waitOutThrottle`. A client given none waits exactly as it always did, and the pcf plugin, which has none, never passes one.
 * @returns {{get,post,patch,delete,put,postRaw,patchRaw}}
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
  const sendOnce = typeof deps.sendOnce === 'function' ? deps.sendOnce : () => false;
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
  // Jittered, capped exponential backoff (throttleBackoffMs, which says why).
  const backoffMs = (attempt) => throttleBackoffMs(attempt, random);
  // The wait before re-sending an answered request: the backoff above, or longer when the answer asks
  // for longer in `Retry-After` (retryAfterMs, capped).
  const retryWaitMs = (res, attempt) => Math.max(backoffMs(attempt), retryAfterMs(res.headers, now()));

  // The run's budget for waiting out a throttle (lib/throttle-budget.js), when the caller gave one — and it must have everything this client calls on it, or it is no budget. This file is copied into the pcf plugin, which has no
  // budget and no such module, so the budget is something a caller hands in and never something this file loads: a client made without one waits exactly as it always did.
  const throttle = ['fits', 'spend', 'announce', 'decline', 'note'].every((name) => deps.throttle && typeof deps.throttle[name] === 'function') ? deps.throttle : null;
  // What THROTTLING is here: the service refusing a request because of its limits — HTTP 429, alone or as every operation of a `$batch`. A 5xx is not: a customization lock or a SQL deadlock victim is a 500, and a gateway's hiccup a 502, 503
  // or 504, each is re-sent on its own schedule (with the Retry-After it carries, capped at a minute), and neither is a reset connection. None of those waits is the budget's.
  //
  // The wait before a throttled request is sent again, for a client that has a budget: the schedule's wait or what the service asked in `Retry-After`, whichever is longer — and the ask WHOLE, not capped at a minute. The cap keeps a large value
  // from stalling a run for minutes on every attempt, which the budget now does for all the attempts together, and a request sent before the service is ready is refused again and spends one of its six attempts. The wait is drawn from the budget,
  // placed on the clock (`at`: the requests this client sends at once are throttled alike and wake together, and what the run waited is the time it spent waiting, not the sum of their waits), and announced when it is long.
  // Resolves true when the wait was taken. It resolves false when the wait does not fit: nothing is waited for, and the caller hands the throttled answer back as it came — as it does when the sends run out — so what the SDK reports is the 429 it is, a
  // refusal that started nothing. That answer says nothing of what the service asked (the SDK's error holds no headers) or of why no more was sent, so the budget is told (`decline`), and the build, which owns the halt, says it.
  // See https://learn.microsoft.com/power-apps/developer/data-platform/api-limits#retry-operations for what a service protection limit asks of the caller.
  async function waitOutThrottle({ res, attempt, method, url, batch }) {
    const at = now();
    // `batch`: an operation refused inside a `$batch` answer carries its own Retry-After, which the outer response need not repeat.
    const asked = Math.max(retryAfterMs(res.headers, at, Infinity), batch ? batchRetryAfterMs(res, at, Infinity) : 0);
    const wait = Math.max(backoffMs(attempt), asked);
    if (!throttle.fits(wait, at)) {
      throttle.decline({ askedMs: asked, waitMs: wait });
      return false;
    }
    const added = throttle.spend(wait, at);
    throttle.announce(`the service throttled ${method} ${new URL(url).pathname} (HTTP 429); waiting ${Math.ceil(wait / 1000)} s before sending it again (${throttle.note()})`, added);
    await sleep(wait);
    return true;
  }

  // Every access token this client has sent — the one a 401 refresh replaced as well as the one that replaced it, because a service may repeat either — for taking it out of an answer that is not a success
  // and out of a transport failure's text (the scrubber above). A success is never given to these.
  const tokensSent = new Set();
  const scrubText = (text) => [...tokensSent].reduce((out, sent) => scrub(out, sent), String(text));
  const scrubValue = (value) => [...tokensSent].reduce((out, sent) => scrubAnswer(out, sent), value);
  // A Buffer is returned as it is unless it holds the token as text: bytes that are not text, or hold no token, are never decoded into something else.
  const scrubBytes = (bytes) => {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || tokensSent.size === 0) return bytes;
    const text = bytes.toString('utf8');
    const clean = scrubText(text);
    return clean === text ? bytes : Buffer.from(clean, 'utf8');
  };

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
   *   `rawBody` returns the response body as the decoded string it arrived as, skipping parseBody;
   *   `bytes` returns the response body as the Buffer it arrived as — never decoded — and sends a Uint8Array request body
   *   verbatim, with its Content-Length and the caller's Content-Type (a file's content, which is bytes, not JSON or text).
   */
  async function call(method, url, body, options, ctl = {}) {
    assertSameOrigin(url); // never attach the org's bearer token to a foreign origin
    const hasBody = body !== undefined && body !== null;
    const bodyOut = !hasBody ? null
      : ctl.bytes ? Buffer.from(body.buffer, body.byteOffset, body.byteLength)
        : (typeof body === 'string' ? body : JSON.stringify(body));
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
    //    SDK surface the unknown outcome to the caller — unless its answer proves no operation in it ran,
    //    and it is a batch of conditional deletes or, for a 429 only, one of column creates (see the
    //    re-sends below).
    const method_ = String(method).toUpperCase();
    const isMetadataDelete = /\/(EntityDefinitions|RelationshipDefinitions|GlobalOptionSetDefinitions)\b/i.test(url);
    const isBatch = method_ === 'POST' && /\/\$batch(\?|$)/i.test(url);
    const recordDelete = method_ === 'DELETE' && !isMetadataDelete;
    // A request the CALLER says is sent once, whatever answers it (`deps.sendOnce`): one whose repeat would do the work twice, or fail in a way that
    // hides what the first send did — a solution import, which the platform runs to its end and which a gateway can answer 504 after it started.
    // Every way the loop below sends a request again is closed for it: a transport failure, a transient status (429, 5xx), the 401 token refresh, and the two
    // answers on which a record DELETE or a `$batch` is re-sent in spite of its own rule (a 429 and a SQL deadlock victim, below), each of which the server may
    // answer AFTER it accepted the request. The first answer is handed to the SDK as it came, so its status and its code survive, and what happened to the work is
    // the caller's to look up. The exceptions of a record DELETE and a `$batch` stay what they were for every request the caller does not name.
    const once = sendOnce(method_, url) === true;
    const noRetry = recordDelete || isBatch || once;
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

    // What the caller is given for an answer that is not sent again — the last the loop got, or a throttled one a budgeted client did not wait for. An answer that is not a success is what an SDK makes an error message of (it quotes the body, and the
    // scripts print that message), so the token is taken out of it first — the body in whatever mode it is read in, and the headers. A success is the caller's data and is returned exactly as it came.
    const deliver = (res) => {
      if (!(res.statusCode >= 200 && res.statusCode < 300)) {
        const text = (value) => (typeof value === 'string' ? scrubText(value) : value);
        return {
          status: res.statusCode,
          headers: scrubValue(res.headers || {}),
          body: ctl.bytes ? scrubBytes(res.body) : ctl.rawBody ? text(res.body) : scrubValue(parseBody(text(res.body))),
        };
      }
      return {
        status: res.statusCode,
        headers: res.headers || {},
        body: ctl.rawBody || ctl.bytes ? res.body : parseBody(res.body),
      };
    };

    // Retry: refresh the token once on 401 (no backoff); back off on transient 5xx/429.
    // 6 attempts with capped jittered backoff rides out a per-entity customization lock that
    // can stay held for ~20s while a prior metadata op or publish settles.
    const maxAttempts = 6;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const last = attempt === maxAttempts - 1;
      const bearer = ensureToken();
      if (bearer.length >= MIN_SCRUBBED_TOKEN_LENGTH) {
        tokensSent.add(bearer);
        tokensSentByProcess.add(bearer);
      }
      const headers = {
        Authorization: `Bearer ${bearer}`,
        Accept: 'application/json',
        'OData-MaxVersion': '4.0',
        'OData-Version': '4.0',
        ...((options && options.headers) || {}),
      };
      if (ctl.bytes) {
        // A file's content: the bytes as they are. `$value` answers the content, not JSON, so it is asked for as any type.
        if (!(options && options.headers && Object.keys(options.headers).some((h) => h.toLowerCase() === 'accept'))) headers.Accept = '*/*';
        if (bodyOut) {
          if (!headers['Content-Type']) headers['Content-Type'] = 'application/octet-stream';
          headers['Content-Length'] = String(bodyOut.length);
        }
      } else if (bodyOut && !headers['Content-Type']) {
        headers['Content-Type'] = 'application/json; charset=utf-8';
      }

      const res = await request({ url, method, headers, body: bodyOut, includeHeaders: true, timeout: isWrite ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS, ...(ctl.bytes ? { binary: true } : {}) });
      if (res.error) {
        if (conditional) {
          throw transportError(res, `Request failed: ${scrubText(res.error)} — this conditional ${method_} was not re-sent, because it may still commit and a re-send could only be refused as a false version conflict`);
        }
        // The server ANSWERED (status and headers arrived) and the body was then cut off. A POST may
        // already have been applied — re-sending a create here made a second row — so it is reported
        // as an uncertain outcome rather than replayed. The idempotent rebuild adopts whatever landed.
        // Reads, PATCH/PUT and metadata deletes keep the retry below.
        if (res.incompleteResponse && method_ === 'POST') {
          throw transportError(res, `Request failed: ${scrubText(res.error)} — the server had already answered ${res.statusCode}, so this POST may have been applied; it was not re-sent. Re-run to reconcile.`);
        }
        if (last || noRetry || !isTransientTransportFailure(res.error, res.code)) throw transportError(res, `Request failed: ${scrubText(res.error)}`);
        await sleep(backoffMs(attempt));
        continue;
      }
      if (res.statusCode === 401 && !last && !once) {
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
        // A throttle (HTTP 429) is waited out inside the run's budget when the client has one, and handed back as it came when the wait does not fit (waitOutThrottle). What else is re-sent here — a customization lock or a deadlock
        // victim (500), a gateway (502, 503, 504) — is not throttling, and keeps its own schedule.
        if (throttle && res.statusCode === 429) {
          if (await waitOutThrottle({ res, attempt, method: method_, url })) continue;
          return deliver(res);
        }
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
      // answer shows that no operation in it ran (isBatchThrottled, isBatchDeadlockVictim) — or when it only
      // creates columns (isColumnCreateBatch) and the answer is a 429 (isBatchThrottled). That change set
      // follows the create of its table, and a table's customization lock can stay held for ~20 s behind
      // that (see maxAttempts): one column's own POST rides it out on this schedule, so the change set that
      // replaces a column's POST gets the same treatment instead of a refusal the caller has to work around.
      const conditionalDeleteBatch = isBatch && isConditionalDeleteBatch(bodyOut);
      const columnCreateBatch = isBatch && isColumnCreateBatch(bodyOut);
      // `once` dominates both: a request the caller sent once is not sent again for a 429 or a deadlock either — the exceptions above are for the requests a caller
      // has not said that of.
      const throttled = !once && ((recordDelete && res.statusCode === 429) || ((conditionalDeleteBatch || columnCreateBatch) && isBatchThrottled(res)));
      if (throttled && !last) {
        if (throttle) {
          if (await waitOutThrottle({ res, attempt, method: method_, url, batch: isBatch })) continue;
          return deliver(res);
        }
        // A batch refused operation by operation may carry the wait in that operation's own headers.
        await sleep(Math.max(retryWaitMs(res, attempt), isBatch ? batchRetryAfterMs(res, now()) : 0));
        continue;
      }
      const deadlocked = !once && ((recordDelete && isSqlDeadlockVictim(res))
        || (conditionalDeleteBatch && isBatchDeadlockVictim(res)));
      if (deadlocked && attempt < DEADLOCK_RESENDS) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      return deliver(res);
    }
    /* istanbul ignore next */
    throw new Error('Unreachable retry loop');
  }

  return {
    // A read of a file's CONTENT (`…/filecontent/$value`, any `$value`) answers the content itself, not JSON: a generative
    // page's rows, an image. It comes back as the Buffer it arrived as. Parsed, a JSON row such as a page's `config.json`
    // became an object, and the SDK refused every page read (GENPAGE_CONTENT_UNREADABLE, measured live); decoded as text,
    // bytes that are not UTF-8 would be corrupted. The SDK takes bytes for content (cds-maker-sdk GenPageApi downloadContent).
    get: (url, options) => call('GET', url, undefined, options, RAW_VALUE.test(url) ? { bytes: true } : {}),
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
    // A PATCH whose body is a file's bytes, verbatim (cds-maker-sdk src/types/httpClient.ts patchRaw): a File column's
    // content is not JSON and never rides in a JSON body. The SDK writes a page's rows in one `$batch` when every body is
    // exactly UTF-8, and through this otherwise (a page that carries an image); without it the SDK refuses such a write
    // rather than save a page whose content never uploaded. The caller's Content-Type passes through; Content-Length is
    // the byte count. The SDK sends `If-Match: *` only when it replaces the content of an EXISTING row, and such a PATCH that
    // got no answer is not re-sent (see `conditional` above). A new row's content PATCH has no If-Match: it writes the same
    // bytes to the same row, so it is idempotent and keeps the ordinary transport retry.
    patchRaw: (url, bytes, options) => call('PATCH', url, bytes, options, { bytes: true }),
  };
}

module.exports = { createAzHttpClient, SQL_DEADLOCK_VICTIM, isBatchDeadlockVictim, isBatchThrottled, completeBatchStatus, batchRetryAfterMs, isConditionalDeleteBatch, isColumnCreateBatch, isTransientTransportFailure, TRANSIENT_TRANSPORT_CODES, retryAfterMs, throttleBackoffMs, RETRY_AFTER_CAP_MS, scrub, scrubAnswer, scrubBearer, needlesOf, sentTokens, TOKEN_MARKER, MIN_SCRUBBED_TOKEN_LENGTH };
