'use strict';
// Shared plumbing for the declared-reconciliation helpers: command-reconcile.js, quick-find.js,
// view-reconcile.js, chart-reconcile.js, dashboard-reconcile.js, web-resource-reconcile.js,
// form-layout-reconcile.js, rule-reconcile.js and bpf-reconcile.js.
//
// Every helper follows the same contract so the build can wire them the same way:
//   plan(...)  -> { operations, refused, unknown, ... }   (no writes)
//   apply(...) -> FeatureResult                            (writes only what the plan said)
// A FeatureResult is { saved, unchanged, pendingPublish, refused, unknown, managedBindings }.
//
// What a result may carry is deliberately narrow: keys, kinds, ids and fixed reason CODES. Never a
// record value, a caption, a token or a raw service error. A result is printed, journaled and
// sent to the build summary, and an error body from the service can echo the request (including
// field values a maker typed). The reason text below is therefore always written here, from the
// code, and never copied from an exception.

const { sha256 } = require('./hash.js');
const { hasUnsyncedEdits } = require('./unsynced-edits.js');

/**
 * JSON with object keys in sorted order and `undefined` members dropped, so two structurally equal
 * values hash the same whatever order their keys were built in. Arrays keep their order: in every
 * place this is used (columns, tiles, conditions) the order is part of the meaning.
 */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

/** The sha256 of a value's canonical JSON — the `intentSha256` of a managed binding. */
function intentSha256(value) {
  return sha256(canonicalJson(value));
}

function emptyResult() {
  return { saved: [], unchanged: [], pendingPublish: [], refused: [], unknown: [], managedBindings: [] };
}

/** Fold `b` into `a` (both FeatureResults) and return `a`. */
function mergeResults(a, b) {
  for (const k of Object.keys(emptyResult())) {
    for (const item of (b && b[k]) || []) a[k].push(item);
  }
  return a;
}

/**
 * One planned change. `destructive` is true only when the change removes or replaces something
 * that exists (an explicit shorter list, a replaced filter): the build's normal plan authorization
 * then applies. `publicationScopes` names what must be published afterwards ({type, id, table?}).
 */
function operation({ key, kind, target, action, destructive = false, publicationScopes = [], preconditions = [] }) {
  return { key, kind, target, action, destructive: destructive === true, publicationScopes, preconditions };
}

/** A not-applied outcome. `message` is fixed text written by the helper (see the header). */
function refusal(key, code, message) {
  return { key, code, message };
}

function isAuthorized(flag, key) {
  if (flag === true) return true;
  if (flag instanceof Set) return flag.has(key);
  if (Array.isArray(flag)) return flag.includes(key);
  return false;
}

/**
 * The managed binding for (kind, key), or null. `ctx.managed.lookup` is the coordinator's
 * managed-artifacts port; it may be sync or async. A missing port answers null — the caller then
 * decides whether managing the artifact is possible at all.
 */
async function lookupBinding(ctx, kind, key) {
  if (!ctx || !ctx.managed || typeof ctx.managed.lookup !== 'function') return null;
  const found = await ctx.managed.lookup(kind, key);
  return found && typeof found === 'object' ? found : null;
}

/** A managed binding record in the coordinator's format (formatVersion 1). */
function bindingRecord(ctx, { kind, key, id, parentKey, intentSha256: sha, origin }) {
  const rec = {
    formatVersion: 1,
    appUniqueName: (ctx && ctx.appUniqueName) || '',
    environmentFingerprint: (ctx && ctx.environmentFingerprint) || '',
    kind,
    key,
    id: String(id),
    intentSha256: sha,
    origin: origin === 'adopted' ? 'adopted' : 'created',
  };
  if (parentKey) rec.parentKey = parentKey;
  return rec;
}

/**
 * Drift between the last-applied state and what the server holds now, for the fields a helper owns.
 *   'unbound'   — no binding: first management (an adoption or a creation);
 *   'none'      — the server still holds what was last applied;
 *   'converged' — the server moved, but to exactly what is now desired (nothing to write, nothing lost);
 *   'drift'     — someone else changed an owned field to something not desired. Writing would
 *                 silently undo their edit, so the helper refuses until the maker refreshes the spec
 *                 or authorizes the overwrite.
 */
function driftVerdict(binding, liveSha, desiredSha) {
  if (!binding) return 'unbound';
  if (binding.intentSha256 === liveSha) return 'none';
  if (liveSha === desiredSha) return 'converged';
  return 'drift';
}

/**
 * Pre-write refusal codes the SDK raises BEFORE it sends anything — a thrown error with one of
 * these codes is a known not-applied outcome. Any other throw from a push is an UNKNOWN outcome: a
 * push that failed part-way may have written some rows, so it must never be reported as refused
 * (nothing happened) or saved.
 */
const PRE_WRITE_CODES = new Set([
  'COMMAND_IMMUTABLE_COLUMN_CHANGED',
  'COMMAND_CHILD_LOCATION_MISMATCH',
  'COMMAND_CONTEXT_ENTITY_UNRESOLVED',
  'VALIDATION_FAILED',
  'INVALID_ARGUMENT',
]);

function codeOf(err) {
  const code = err && typeof err.code === 'string' ? err.code : '';
  return /^[A-Z][A-Z0-9_]{2,63}$/.test(code) ? code : '';
}

/**
 * Push one artifact and classify the answer. Returns { outcome: 'saved'|'refused'|'unknown', code }.
 * A push the SDK answers without `saved: true` is refused (the SDK reports a refusal that way and
 * sends nothing for it); a throw is classified by {@link PRE_WRITE_CODES}.
 */
async function pushChecked(sdk, type, id) {
  try {
    const pushed = await sdk.pushArtifact(type, id);
    if (pushed && pushed.saved === true) return { outcome: 'saved', code: '' };
    return { outcome: 'refused', code: 'PUSH_NOT_SAVED' };
  } catch (err) {
    const code = codeOf(err);
    if (PRE_WRITE_CODES.has(code)) return { outcome: 'refused', code };
    return { outcome: 'unknown', code: code || 'WRITE_OUTCOME_UNKNOWN' };
  }
}

/**
 * Push only when the workspace copy holds an edit the server has not seen (unsynced-edits.js), so
 * a no-op reconciliation sends nothing. Returns the pushChecked answer, or { outcome: 'unchanged' }.
 */
async function pushIfChanged(sdk, type, id) {
  if (!(await hasUnsyncedEdits(sdk, type, id))) return { outcome: 'unchanged', code: '' };
  return pushChecked(sdk, type, id);
}

/** Queue a publication through the build's publication port, when there is one. */
function queuePublication(ctx, scope) {
  if (ctx && ctx.publication && typeof ctx.publication.queue === 'function') {
    ctx.publication.queue(scope);
    return true;
  }
  return false;
}

/** Lowercased, brace-less GUID text, or '' when the value is not a GUID. */
function normalizeGuid(value) {
  const s = String(value == null ? '' : value).trim().replace(/^\{|\}$/g, '').toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s) ? s : '';
}

module.exports = {
  canonicalJson,
  intentSha256,
  emptyResult,
  mergeResults,
  operation,
  refusal,
  isAuthorized,
  lookupBinding,
  bindingRecord,
  driftVerdict,
  pushChecked,
  pushIfChanged,
  queuePublication,
  normalizeGuid,
  PRE_WRITE_CODES,
};
