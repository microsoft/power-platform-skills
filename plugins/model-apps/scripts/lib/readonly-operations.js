'use strict';
// Shared pieces of the plugin's read-only diagnostics — the push preview (lib/push-preview.js), component inspection
// (lib/feature-verify.js), solution inventory (lib/solution-inventory.js), promotion coverage planning
// (lib/promotion-plan.js) — and of the data-repair runner's planning step (lib/data-fix-runner.js).
//
// Each of them promises the maker that it READS ONLY. The bundled SDK makes the same promise for the calls these
// helpers use (previewPush, inspectArtifact, planDataFix, planPromotion), and it enforces it with its own guard. A
// second guard sits on the transport here because a promise made to a maker about a production environment should not
// rest on one layer: a defect in either the SDK or the plugin that tried to write would otherwise be found only by the
// write landing. The wrapper refuses before anything is sent and counts the refusal, so a test (and the result) can
// show that zero writes were attempted, not merely that none succeeded.
//
// Results carry codes, HTTP statuses and fixed or plugin-written messages only — never a response body, a header, a
// token, a URL, a service's error text or a record value (findingOf; a structured SDK finding is projected to its code).

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The code a refused write carries. It is the plugin's own: the SDK has `PREVIEW_WRITE_REFUSED` for the same defect
// inside its preview, and keeping the two distinct says which layer caught it.
const READ_ONLY_WRITE_REFUSED = 'READ_ONLY_TRANSPORT_WRITE_REFUSED';

const WRITE_METHODS = ['post', 'patch', 'delete', 'put', 'postRaw', 'patchRaw'];

/**
 * An HttpClient (the SDK's interface: get/post/patch/delete and optional put/postRaw/patchRaw) that forwards GETs and
 * refuses every other method before sending it.
 *
 * `stats.gets` counts forwarded GET calls and `stats.refusedWrites` the refused attempts, with `stats.refused` naming the
 * method and the path (no query string — a filter can hold a record value) of each. A GET counts once however many
 * times the wrapped client's transport retries it (a 429 or 5xx retry happens below this wrapper, out of its sight), so
 * `gets` is the number of reads asked for, a lower bound on the HTTP requests sent.
 *
 * A `$batch` POST is refused too, even one whose parts are all GETs: the SDK's read paths used here do not batch, and
 * telling a read batch from a write batch would mean parsing a multipart body to decide whether to let it through.
 * @param {object} client
 */
function readOnlyHttpClient(client) {
  if (!client || typeof client.get !== 'function') throw new TypeError('readOnlyHttpClient: an HttpClient with get() is required');
  const stats = { gets: 0, refusedWrites: 0, refused: [] };
  const refuse = (method) => async (url) => {
    stats.refusedWrites += 1;
    stats.refused.push({ method: method === 'postRaw' ? 'POST' : method === 'patchRaw' ? 'PATCH' : method.toUpperCase(), path: pathOnly(url) });
    const err = new Error(`a read-only operation attempted a ${method.toUpperCase()} request; nothing was sent`);
    err.code = READ_ONLY_WRITE_REFUSED;
    throw err;
  };
  const wrapped = {
    async get(url, options) {
      stats.gets += 1;
      return client.get(url, options);
    },
  };
  // Optional methods are offered only when the wrapped client has them: the SDK decides what it may do from whether a
  // method exists (no `postRaw` → no atomic change sets), and a reader must not look more capable than its client.
  for (const method of WRITE_METHODS) {
    if (method === 'post' || method === 'patch' || method === 'delete' || typeof client[method] === 'function') wrapped[method] = refuse(method);
  }
  return { client: wrapped, stats };
}

// `https://contoso.crm.dynamics.com/api/data/v9.2/savedqueries(<id>)?$select=...` -> `/api/data/v9.2/savedqueries(<id>)`.
// A relative URL (the SDK sends some relative to its base) keeps its path. The query is dropped because a filter can
// carry a record's value.
function pathOnly(url) {
  const text = String(url == null ? '' : url);
  const noQuery = text.split('?')[0];
  return noQuery.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '');
}

// A code worth passing on: an identifier (`VERSION_CONFLICT`, `CONNECTION_ERROR`, `build-locked`) or a Dataverse error
// code (`0x80040220`). Anything else in `err.code` is free text and could quote a value, so the caller's fallback
// replaces it. Dataverse error codes: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/web-service-error-codes
const CODE_RE = /^(?:[A-Za-z][A-Za-z0-9_-]{1,79}|0x[0-9A-Fa-f]{8})$/;

// The HTTP status of a caught error: on the error or on a cause it wraps (the SDK wraps the transport's error, which
// carries `statusCode`; some layers say `status` or `httpStatus`). Only an integer HTTP status is taken.
function statusOf(err) {
  let e = err;
  for (let depth = 0; e && typeof e === 'object' && depth < 6; depth += 1, e = e.cause) {
    for (const key of ['statusCode', 'status', 'httpStatus']) {
      const v = e[key];
      if (Number.isInteger(v) && v >= 100 && v <= 599) return v;
    }
  }
  return undefined;
}

function wordsForStatus(status) {
  const withheld = 'its own error text is not shown, because it can quote a record value.';
  if (status === undefined) return `The operation failed; ${withheld}`;
  const head = `The service answered HTTP ${status}`;
  if (status === 401) return `${head} (not signed in, or the sign-in expired); ${withheld}`;
  if (status === 403) return `${head} (the signed-in user lacks a privilege for this request); ${withheld}`;
  if (status === 404) return `${head} (not found: it does not exist, or this user cannot see it); ${withheld}`;
  if (status === 409 || status === 412) return `${head} (the row changed since it was read); ${withheld}`;
  if (status === 429) return `${head} (throttled: too many requests); ${withheld}`;
  if (status >= 500) return `${head} (a service error); ${withheld}`;
  if (status >= 400) return `${head} (the request was refused); ${withheld}`;
  return `${head}; ${withheld}`;
}

/**
 * An error whose message is the plugin's own words — written here from the maker's input or the code's own state, never
 * from a service's answer — and so may be printed as it is: findingOf passes `publicMessage` through.
 * @param {string} code
 * @param {string} message
 */
function publicError(code, message) {
  return Object.assign(new Error(message), { code, publicMessage: message });
}

/**
 * The public projection of a caught error: `{ code, statusCode?, message }`. `code` is the error's own code when it is
 * a code (CODE_RE), else `fallback`; `statusCode` is the HTTP status found on it or its causes; `message` is the
 * error's `publicMessage` when the plugin wrote one, else fixed words chosen by the status. An error's own `message` is
 * never used: a service's error text — and so the SDK's, which wraps it — can quote a record value, a filter or a row
 * name, and no scrubbing of free text can be trusted to take every value out.
 * @param {unknown} err
 * @param {string} [fallback]
 */
function findingOf(err, fallback = 'UNEXPECTED_ERROR') {
  const code = err && typeof err.code === 'string' && CODE_RE.test(err.code) ? err.code : fallback;
  const statusCode = statusOf(err);
  const message = err && typeof err.publicMessage === 'string' ? err.publicMessage : wordsForStatus(statusCode);
  return { code, ...(statusCode !== undefined ? { statusCode } : {}), message };
}

/**
 * Closed-key check: every own key of `obj` must be in `allowed`. Pushes one error per unknown key into `errors`, with
 * `where` naming the object. Returns `false` (and pushes an error) when `obj` is not a plain object.
 */
function checkClosedObject(obj, allowed, where, errors) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    errors.push(`${where} must be an object`);
    return false;
  }
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) errors.push(`${where}.${key} is not a recognised field (allowed: ${allowed.join(', ')})`);
  }
  return true;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

module.exports = { GUID_RE, READ_ONLY_WRITE_REFUSED, readOnlyHttpClient, pathOnly, publicError, findingOf, checkClosedObject, isNonEmptyString };
