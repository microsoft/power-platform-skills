'use strict';
// Shared plumbing for the declared-reconciliation helpers: command-reconcile.js, quick-find.js,
// view-reconcile.js and chart-reconcile.js.
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

/**
 * A managed binding record in the coordinator's format (formatVersion 1). `partsSha256` is optional:
 * a { part: sha256 } map of the same projection `intentSha256` covers, which lets a later run tell
 * WHICH owned part moved (see partsDriftVerdict). A store that drops it loses nothing but precision:
 * the verdict then falls back to the whole-projection comparison.
 */
function bindingRecord(ctx, { kind, key, id, parentKey, intentSha256: sha, origin, partsSha256 }) {
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
  if (partsSha256 && typeof partsSha256 === 'object') rec.partsSha256 = { ...partsSha256 };
  return rec;
}

/**
 * The baseline of a FULL ownable projection — `{ part: value }` over every part this helper can ever
 * own on the artifact, whatever the spec declares today. Recording the whole projection (and not only
 * the parts the spec declares) keeps the baseline stable when the spec starts or stops declaring a
 * part: ownership changes the WRITE set, never what "last applied" means.
 * @returns {{ intentSha256: string, partsSha256: Object<string,string> }}
 */
function projectionBaseline(parts) {
  const partsSha256 = {};
  for (const k of Object.keys(parts).sort()) partsSha256[k] = intentSha256(parts[k] === undefined ? null : parts[k]);
  return { intentSha256: intentSha256(normalizedParts(parts)), partsSha256 };
}

function normalizedParts(parts) {
  const out = {};
  for (const k of Object.keys(parts)) out[k] = parts[k] === undefined ? null : parts[k];
  return out;
}

/**
 * Drift over a full projection (see projectionBaseline), judged only on the parts this run WRITES:
 *   'unbound'   — no binding;
 *   'none'      — the live projection is what was last applied, or every part about to be written still
 *                 holds its recorded value (a part someone else changed but this run leaves alone is
 *                 theirs to keep and is not overwritten, so it is not a conflict);
 *   'converged' — nothing is to be written (the live parts already equal the desired ones);
 *   'drift'     — a part about to be written was changed outside the spec since it was last applied,
 *                 or the binding cannot say which parts moved (no partsSha256) and live ≠ desired.
 * @param {object|null} binding
 * @param {object} liveParts     the full live projection
 * @param {object} desiredParts  the full projection after this run (live parts with the declared ones laid over)
 */
function partsDriftVerdict(binding, liveParts, desiredParts) {
  if (!binding) return 'unbound';
  const live = projectionBaseline(liveParts);
  if (binding.intentSha256 === live.intentSha256) return 'none';
  const desired = projectionBaseline(desiredParts);
  const changed = Object.keys(desired.partsSha256).filter((k) => desired.partsSha256[k] !== live.partsSha256[k]);
  if (!changed.length) return 'converged';
  const recorded = binding.partsSha256 && typeof binding.partsSha256 === 'object' ? binding.partsSha256 : null;
  if (!recorded) return 'drift';
  for (const k of changed) {
    // A part with no recorded value was never applied by this spec: writing it over a value someone
    // else put there would lose their edit, so only an absent (null) live value is safe to fill.
    if (recorded[k] === undefined) {
      if (liveParts[k] !== undefined && liveParts[k] !== null) return 'drift';
      continue;
    }
    if (recorded[k] !== live.partsSha256[k]) return 'drift';
  }
  return 'none';
}

/**
 * The id a managed artifact must be edited by. An existing binding is the authority: once (kind, key)
 * is bound, its id — and only its id — names the artifact. A pin or a caller's name resolution that
 * points elsewhere is a conflict the maker must repair (rebinding silently would edit an artifact the
 * spec never managed and orphan the bound one), so it refuses instead of choosing.
 * @param {object|null} binding
 * @param {{ pinnedId?: string, resolvedId?: string, code: string, key: string }} opts
 * @returns {{ id: string|null, refusal: object|null }}
 */
function boundIdentity(binding, { pinnedId, resolvedId, code, key }) {
  const norm = (v) => normalizeGuid(v) || String(v == null ? '' : v).trim().toLowerCase();
  if (binding) {
    const bound = norm(binding.id);
    for (const other of [pinnedId, resolvedId]) {
      if (other !== undefined && other !== null && other !== '' && norm(other) !== bound) {
        return { id: null, refusal: refusal(key, code, 'the spec names a different artifact than the one this key is bound to; repair the binding explicitly before it can be managed') };
      }
    }
    return { id: String(binding.id), refusal: null };
  }
  const id = pinnedId || resolvedId || null;
  return { id: id ? String(id) : null, refusal: null };
}

/**
 * Run one create through the creation port (`ctx.creates.run`) and classify the outcome. Every new
 * root AND child goes through here. In this release the port is a plain pass-through: it allocates
 * the ids the request asks for and calls execute once; it keeps no record of them. After an
 * interrupted run or an unknown outcome a later run can create a duplicate. The 'adopted' and
 * pending-unknown answers below exist for a durable port that may later plug in behind the same call.
 *
 * `execute({id, childIds})` must perform the local edits and the push, and answer with the
 * pushChecked shape ({ outcome: 'saved'|'refused'|'unknown', code }). A throw from a LOCAL edit
 * (before the push) is caught here and answered as refused: nothing was sent.
 *
 * @returns {Promise<{ status: 'created'|'adopted'|'refused'|'unknown', id?: string, childIds?: object, code: string, rules?: string[] }>}
 *   'adopted' means the maker resolved an earlier unknown create by naming the rows it made: execute
 *   was NOT called and the caller must re-read before it records anything.
 */
async function createThroughPort(ctx, request, execute) {
  if (!ctx || !ctx.creates || typeof ctx.creates.run !== 'function') return { status: 'refused', code: 'creation-port-unavailable' };
  let pushed = null;
  let out;
  try {
    out = await ctx.creates.run(request, async (ids) => {
      try {
        pushed = await execute(ids);
      } catch (err) {
        // A local workspace edit threw before any push: nothing reached the service.
        pushed = { outcome: 'refused', code: codeOf(err) || 'LOCAL_EDIT_FAILED' };
      }
      return pushed;
    });
  } catch (err) {
    const raw = err && typeof err.code === 'string' ? err.code : '';
    if (raw === 'CREATION_PENDING_UNKNOWN') return { status: 'refused', code: 'creation-pending-unknown' };
    if (raw === 'create-recovery-needed') return { status: 'refused', code: 'creation-recovery-needed' };
    if (raw === 'CREATE_PORT_INVALID') return { status: 'refused', code: 'creation-request-invalid' };
    // An earlier create in this run lost its answer: the port sends nothing more until it is resolved.
    if (raw === 'create-outcome-unknown' && err.outcome === 'not-sent') return { status: 'refused', code: 'creation-blocked-by-unknown' };
    return { status: 'unknown', code: codeOf(err) || 'WRITE_OUTCOME_UNKNOWN' };
  }
  const base = { id: out && out.id, childIds: (out && out.childIds) || {} };
  if (out && out.outcome === 'adopted') return { status: 'adopted', ...base, code: 'creation-adopted' };
  if (out && out.outcome === 'created') return { status: 'created', ...base, code: '' };
  if (out && out.outcome === 'refused') return { status: 'refused', ...base, code: (pushed && pushed.code) || 'PUSH_NOT_SAVED', rules: pushed && pushed.rules };
  return { status: 'unknown', ...base, code: (pushed && pushed.code) || 'WRITE_OUTCOME_UNKNOWN' };
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
 * Whether a no-op may record a binding. An artifact that already matches the spec is not thereby
 * approved for management: binding it silently would let the next, real edit skip the adoption
 * question. So an unbound artifact is bound only when the maker approved adopting it or pinned it by id.
 */
function bindsUnchanged(binding, ctx, key, pinned = false) {
  return !!binding || pinned === true || isAuthorized(ctx && ctx.authorizedAdoption, key);
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
  // The SDK's ValidationError (errors/index.ts): its issues are checked before any request is built.
  'VALIDATION_ERROR',
  'INVALID_ARGUMENT',
]);

function codeOf(err) {
  const code = err && typeof err.code === 'string' ? err.code : '';
  return /^[A-Z][A-Z0-9_]{2,63}$/.test(code) ? code : '';
}

/**
 * The rule ids of an SDK ValidationError — rr.issues[].rule, e.g. 'view-find-column-duplicate'.
 * Only the kebab-case rule ids are kept; an issue's message can quote the value it refused.
 */
function rulesOf(err) {
  const issues = err && Array.isArray(err.issues) ? err.issues : [];
  const out = [];
  for (const i of issues) {
    const rule = i && typeof i.rule === 'string' ? i.rule : '';
    if (/^[a-z][a-z0-9-]{1,63}$/.test(rule) && !out.includes(rule)) out.push(rule);
  }
  return out;
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
    if (PRE_WRITE_CODES.has(code)) return { outcome: 'refused', code, rules: rulesOf(err) };
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

/**
 * The publication scopes a FeatureResult may schedule: its `pendingPublish` scopes when the result
 * carries no refusal and no unknown, otherwise none. A publish of a table ships every saved change in
 * it, so a create or edit whose outcome is refused or unknown must not be put live by one — even when
 * its row was created (that row is still reported in `saved`, for solution and undo bookkeeping, which
 * is not an authorization to publish).
 */
function settledPublications(result) {
  if (!result || (result.refused || []).length || (result.unknown || []).length) return [];
  return (result.pendingPublish || []).map((p) => p.scope);
}

/**
 * Settle one helper's publications: the helpers only record what an apply would publish in
 * `pendingPublish`; this queues those scopes through `ctx.publication` once the whole apply has
 * finished, and only when it settled cleanly (see settledPublications). Otherwise each entry stays as
 * evidence, marked `withheld: true`, and nothing is queued. Returns the result.
 */
function commitPublication(ctx, result) {
  const scopes = settledPublications(result);
  if (scopes.length) for (const scope of scopes) queuePublication(ctx, scope);
  else for (const p of result.pendingPublish || []) p.withheld = true;
  return result;
}

/**
 * What a maker does about one refusal or unknown, by its code: the approval that unlocks it, or a repair.
 *   *-adoption-not-authorized                       an existing row of the same name: the adoption approval
 *   *-drift                                         the row was changed on the server: the overwrite approval
 *   *-removal-not-authorized, *-empty-not-authorized, *-clear-not-authorized
 *                                                   the change removes something: the destructive approval
 *   anything else (an unknown outcome, an unreadable row, a refused write)            repair and rerun
 */
function remedyFor(code) {
  const c = String(code || '');
  if (/-adoption-not-authorized$/.test(c)) return 'approve adopting the existing artifact (adoption approval) and rerun';
  if (/-drift$/.test(c)) return 'approve overwriting the changes made on the server (overwrite approval) and rerun';
  if (/-(?:removal|empty|clear)-not-authorized$/.test(c)) return 'approve the destructive change (destructive approval) and rerun';
  return 'repair and rerun';
}

/**
 * The settlement every declared artifact's apply goes through: returns settleFeatureResult(phase, label,
 * result) -> { ok }, and the caller stops that artifact when !ok. In this order, so that nothing which can
 * fail after it — reporting, or recording a binding — can leave a saved-but-failed row publishable:
 *   1. a result with a refusal or an unknown blocks the tables of its saved or possibly-saved scopes on
 *      the run's publication barrier (`barrier.noteResult`, lib/publication-barrier.js);
 *   2. each refusal and unknown is reported as required work not done (`markIncomplete(phase, line,
 *      detail)`), with its code and remedy — a later artifact still runs, but the run ends incomplete;
 *   3. the result's managed bindings are recorded (`recordBinding`; skipped when the build has no store),
 *      even when reporting threw. A binding the store cannot record (a local write error) leaves a saved row
 *      whose settlement did not finish, so before that error escapes, the table of every scope the result
 *      still carries is blocked on the barrier — an obligation an earlier, clean artifact left on the same
 *      table must not publish the row either — and those scopes are marked `withheld`. The error is kept
 *      and rethrown: the binding is never treated as recorded, and nothing is scheduled;
 *   4. a clean result's publication scopes are scheduled on `settled` ([{ scope, label }]) for the phase
 *      to commit onto the build's own queues; a result that is not clean schedules none.
 */
function createFeatureSettlement({ barrier, markIncomplete, settled, recordBinding } = {}) {
  if (typeof markIncomplete !== 'function') throw new TypeError('createFeatureSettlement: markIncomplete must be a function');
  if (!Array.isArray(settled)) throw new TypeError('createFeatureSettlement: settled must be an array');
  const recordBindings = (artifactLabel, r) => {
    if (typeof recordBinding !== 'function') return;
    try {
      for (const b of (r && r.managedBindings) || []) recordBinding(b);
    } catch (err) {
      // The barrier's own tableKey ignores a scope without a table (nothing of a table to withhold).
      for (const p of (r && r.pendingPublish) || []) {
        if (barrier && p && p.scope) barrier.block(p.scope.table, `${artifactLabel} (its managed binding was not recorded)`);
        if (p) p.withheld = true;
      }
      throw err;
    }
  };
  return function settleFeatureResult(phase, artifactLabel, r) {
    const refused = (r && r.refused) || [];
    const unknown = (r && r.unknown) || [];
    const ok = refused.length === 0 && unknown.length === 0;
    if (!ok && barrier) barrier.noteResult(r, artifactLabel);
    try {
      for (const x of refused) markIncomplete(phase, `${artifactLabel}: ${x.code} — ${x.message}`, { code: x.code, remedy: remedyFor(x.code) });
      for (const x of unknown) markIncomplete(phase, `${artifactLabel}: ${x.code} — ${x.message}`, { code: x.code, unknownOutcome: true, remedy: remedyFor(x.code) });
    } finally {
      recordBindings(artifactLabel, r);
    }
    if (ok) for (const scope of settledPublications(r)) settled.push({ scope, label: artifactLabel });
    return { ok };
  };
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
  projectionBaseline,
  partsDriftVerdict,
  boundIdentity,
  createThroughPort,
  driftVerdict,
  bindsUnchanged,
  pushChecked,
  pushIfChanged,
  queuePublication,
  settledPublications,
  commitPublication,
  remedyFor,
  createFeatureSettlement,
  normalizeGuid,
  rulesOf,
  PRE_WRITE_CODES,
};
