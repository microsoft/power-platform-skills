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
// Results carry codes and short, scrubbed messages only — never a response body, a header, a token, a URL or a
// record value (DESIGN rule: structured errors name the operation, type, key and code).

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The code a refused write carries. It is the plugin's own: the SDK has `PREVIEW_WRITE_REFUSED` for the same defect
// inside its preview, and keeping the two distinct says which layer caught it.
const READ_ONLY_WRITE_REFUSED = 'READ_ONLY_TRANSPORT_WRITE_REFUSED';

const WRITE_METHODS = ['post', 'patch', 'delete', 'put', 'postRaw', 'patchRaw'];

/**
 * An HttpClient (the SDK's interface: get/post/patch/delete and optional put/postRaw/patchRaw) that forwards GETs and
 * refuses every other method before sending it.
 *
 * `stats.gets` counts forwarded GETs and `stats.refusedWrites` the refused attempts, with `stats.refused` naming the
 * method and the path (no query string — a filter can hold a record value) of each.
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

/**
 * A short message for a result: URLs replaced, bearer-like material removed, bounded in length. The SDK's own findings
 * are plain data already; this is for errors the helpers catch themselves.
 * @param {unknown} err
 */
function safeMessage(err) {
  const raw = String((err && err.message) || err || '');
  return raw
    .replace(/https?:\/\/[^\s'"`<>)]+/gi, '<url>')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '<redacted>')
    .slice(0, 400);
}

/** `{ code, message }` for a caught error; `code` is the error's own string code, else `fallback`. */
function findingOf(err, fallback = 'UNEXPECTED_ERROR') {
  const code = err && typeof err.code === 'string' && err.code ? err.code : fallback;
  return { code, message: safeMessage(err) };
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

module.exports = { GUID_RE, READ_ONLY_WRITE_REFUSED, readOnlyHttpClient, pathOnly, safeMessage, findingOf, checkClosedObject, isNonEmptyString };
