'use strict';
// Apply-snapshot envelope lifecycle — the durable, fail-closed state machine that authorizes a
// `--changed-only` partial apply (changed-only design, deliverable #3, PURE core).
//
// WHY this exists: the /app-builder build engine is ADDITIVE, not convergent — existing chart/command/
// dashboard defs and web-resource CONTENT are SKIPPED on rebuild (sdk-build.js), and `result.created`
// (the artifact-id map every phase reads cross-phase) is per-invocation. So "just run the changed
// phases" would silently bless edits that never deployed. The partial apply is therefore gated on a
// persisted snapshot whose eligibility is a STATE MACHINE with these invariants (see design §"Eligibility
// state machine"):
//   1. eligible:true is reached ONLY after a verified apply with EMPTY debt.
//   2. Every state-changing op INVALIDATES (eligible:false) BEFORE it writes — a crash mid-apply must
//      never leave a stale snapshot that reads eligible.
//   3. debt accrues on any unsupported/removal edit; eligible:true requires empty debt; debt clears ONLY
//      by a verifier that matches the SPECIFIC debt reason (a plain full rebuild that re-skips a stale
//      artifact must NOT clear it — Sol build-time note).
//   4. Identity binding: orgId (live WhoAmI) + envUrl + appUniqueName must match the live target, else the
//      snapshot is for a DIFFERENT env/app and MUST be ignored (full build).
//   5. A teardown writes a TOMBSTONE (eligible:false + teardown-in-progress debt) BEFORE deleting anything.
//
// This module is PURE + I/O-free: it constructs, validates, and transitions the envelope OBJECT. The
// atomic persistence (temp→fsync→rename), the build-wide lease, and the read-modify-write-under-CAS live
// in the build/teardown wiring (deliverable #3 part 2), so this decision logic stays fully unit-testable.

const crypto = require('node:crypto');

// Bump this whenever the envelope SHAPE changes. parseEnvelope() rejects any other schema as UNUSABLE
// (→ caller does a full build): silently reading an old/newer shape could mis-bind ids or eligibility.
const SCHEMA = 3;

const TEARDOWN_DEBT_REASON = 'teardown-in-progress';

// Normalize a GUID / URL / id for identity comparison: strip braces, drop a trailing slash (env URLs are
// written both with and without one), lowercase, trim. Unique names are ALSO compared with this because
// Dataverse treats schema/unique names case-insensitively, so 'New_Order' and 'new_order' are the same app.
function normId(s) {
  return String(s == null ? '' : s).replace(/[{}]/g, '').replace(/\/+$/, '').trim().toLowerCase();
}

function newGeneration() {
  // A fresh opaque token per apply. The build-wide lease uses generation CAS (compare-and-swap) to detect
  // a concurrent build that re-persisted the snapshot between our read and our write.
  return crypto.randomUUID();
}

// Construct a fresh envelope for `identity` = { orgId, envUrl, appUniqueName, appId?, solutionUniqueName? }.
// eligible starts FALSE — a snapshot only becomes eligible after a verified apply with empty debt
// (markEligible). generation is minted here unless the caller supplies one (tests pin it for determinism).
function makeEnvelope(identity, opts = {}) {
  const id = identity || {};
  return {
    schema: SCHEMA,
    orgId: id.orgId != null ? String(id.orgId) : null,
    envUrl: id.envUrl != null ? String(id.envUrl) : null,
    appUniqueName: id.appUniqueName != null ? String(id.appUniqueName) : null,
    appId: id.appId != null ? String(id.appId) : null,
    solutionUniqueName: id.solutionUniqueName != null ? String(id.solutionUniqueName) : null,
    generation: opts.generation || newGeneration(),
    eligible: false,
    debt: [],
    priorSpec: opts.priorSpec != null ? opts.priorSpec : null,
    expectedSitemap: opts.expectedSitemap != null ? opts.expectedSitemap : null,
    artifacts: opts.artifacts || {},
  };
}

// Is `value` a structurally valid, current-schema envelope? Used by parseEnvelope and every gate; a
// malformed envelope is treated as NO usable snapshot (fail-closed → full build).
function isEnvelope(value) {
  return !!value && typeof value === 'object' && value.schema === SCHEMA && Array.isArray(value.debt);
}

// Parse a persisted envelope. Returns null on ANY problem (bad JSON, wrong/absent schema, wrong shape).
// Fail-closed: an unreadable or foreign-schema snapshot must degrade to "no snapshot" (full build), never
// throw out of the build and never be half-trusted.
function parseEnvelope(raw) {
  if (raw == null) return null;
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return null; }
  }
  return isEnvelope(obj) ? obj : null;
}

function serializeEnvelope(envelope) {
  return JSON.stringify(envelope);
}

// Identity match: does this envelope describe the SAME live target we're about to build against?
// live = { orgId, envUrl, appUniqueName, appId? }. orgId + envUrl + appUniqueName must ALL match. appId is a
// strong secondary signal: if BOTH sides carry one and they differ, that's a mismatch (the app was deleted
// and recreated with the same unique name → different GUID → stale ids). Returns { ok, reason }.
function identityMatches(envelope, live) {
  if (!isEnvelope(envelope)) return { ok: false, reason: 'no valid snapshot' };
  const l = live || {};
  if (!envelope.orgId || !l.orgId || normId(envelope.orgId) !== normId(l.orgId)) return { ok: false, reason: 'orgId mismatch (different Dataverse org)' };
  if (!envelope.envUrl || !l.envUrl || normId(envelope.envUrl) !== normId(l.envUrl)) return { ok: false, reason: 'envUrl mismatch (different environment)' };
  if (!envelope.appUniqueName || !l.appUniqueName || normId(envelope.appUniqueName) !== normId(l.appUniqueName)) return { ok: false, reason: 'appUniqueName mismatch (different app)' };
  if (envelope.appId && l.appId && normId(envelope.appId) !== normId(l.appId)) return { ok: false, reason: 'appId mismatch (app deleted+recreated under same unique name)' };
  return { ok: true, reason: 'identity matches' };
}

function hasDebt(envelope) {
  return isEnvelope(envelope) && envelope.debt.length > 0;
}

function listDebt(envelope) {
  return isEnvelope(envelope) ? envelope.debt.slice() : [];
}

// Record a debt: an artifact whose intended state could NOT be safely applied incrementally (an
// unsupported edit, a removal, a chart/command/dashboard/web-resource-content change). While ANY debt is
// present the snapshot can never become eligible. Deduped by (artifactType|identity|reason) so re-running
// a full build that re-incurs the same debt doesn't grow the list without bound. Mutates + returns env.
function addDebt(envelope, entry) {
  if (!isEnvelope(envelope) || !entry) return envelope;
  const norm = {
    artifactType: entry.artifactType != null ? String(entry.artifactType) : 'unknown',
    identity: entry.identity != null ? String(entry.identity) : '',
    reason: entry.reason != null ? String(entry.reason) : 'unspecified',
  };
  const key = (d) => `${d.artifactType}\u0000${d.identity}\u0000${d.reason}`;
  if (!envelope.debt.some((d) => key(d) === key(norm))) envelope.debt.push(norm);
  return envelope;
}

// Clear debt entries for which `predicate(entry)` is true. The caller MUST only clear debt with a verifier
// that matches the SPECIFIC reason — e.g. a placement re-verify may clear a placement debt but must NOT
// clear an event/quick-view debt (Sol build-time note). The pure module just applies the caller's
// predicate; it deliberately offers no "clear all" shortcut. Mutates + returns env.
function clearDebtMatching(envelope, predicate) {
  if (!isEnvelope(envelope) || typeof predicate !== 'function') return envelope;
  envelope.debt = envelope.debt.filter((d) => !safePredicate(predicate, d));
  return envelope;
}

// A throwing predicate must not wipe debt (fail-closed: on error, KEEP the debt). Returns false (=keep) if
// the predicate throws.
function safePredicate(predicate, entry) {
  try { return predicate(entry) === true; } catch { return false; }
}

// INVALIDATE: force eligible:false. Called BEFORE every state-changing write (full apply, fast apply,
// unsupported edit, teardown). Idempotent. Mutates + returns env.
function markIneligible(envelope) {
  if (isEnvelope(envelope)) envelope.eligible = false;
  return envelope;
}

// Promote to eligible:true — ONLY legal when debt is empty (invariant 1/3). Fail-closed: if debt remains,
// eligible stays false and { ok:false } is returned so the caller can NOT accidentally bless a snapshot
// that still carries unresolved debt. Mutates + returns { ok, envelope, reason }.
function markEligible(envelope) {
  if (!isEnvelope(envelope)) return { ok: false, envelope, reason: 'not a valid envelope' };
  if (envelope.debt.length > 0) {
    envelope.eligible = false;
    return { ok: false, envelope, reason: `cannot become eligible with ${envelope.debt.length} open debt entr${envelope.debt.length === 1 ? 'y' : 'ies'}` };
  }
  envelope.eligible = true;
  return { ok: true, envelope, reason: 'eligible' };
}

// TOMBSTONE: mark a teardown in progress. eligible:false + a teardown-in-progress debt, written BEFORE any
// live delete. If the teardown crashes partway, the tombstone survives so a surviving artifact can never be
// rebaselined as a clean fast-path source. Mutates + returns env.
function tombstone(envelope) {
  if (!isEnvelope(envelope)) return envelope;
  markIneligible(envelope);
  addDebt(envelope, { artifactType: 'app', identity: envelope.appUniqueName || '', reason: TEARDOWN_DEBT_REASON });
  return envelope;
}

function isTombstoned(envelope) {
  return isEnvelope(envelope) && envelope.debt.some((d) => d.reason === TEARDOWN_DEBT_REASON);
}

// Rotate to a new generation (call right before persisting a new snapshot under the lease). Mutates + returns.
function bumpGeneration(envelope, generation) {
  if (isEnvelope(envelope)) envelope.generation = generation || newGeneration();
  return envelope;
}

// Generation CAS check: is the on-disk envelope still the one we read (no concurrent build re-wrote it)?
// The caller reads the snapshot, records its generation, does work, then before writing re-reads and calls
// this. A mismatch means someone else won the race → the caller must abort/re-plan, never overwrite.
function generationMatches(diskEnvelope, expectedGeneration) {
  if (!isEnvelope(diskEnvelope)) return false;
  return !!expectedGeneration && diskEnvelope.generation === expectedGeneration;
}

// THE gate: may we take the `--changed-only` fast path against `live`? Fail-closed — returns
// { eligible:false, reason } unless EVERY condition holds: valid schema-3 envelope, identity matches live,
// not tombstoned, eligible flag true, empty debt, and a generation present (needed for the write-CAS).
function isFastPathEligible(envelope, live) {
  if (!isEnvelope(envelope)) return { eligible: false, reason: 'no valid snapshot (full build)' };
  const idm = identityMatches(envelope, live);
  if (!idm.ok) return { eligible: false, reason: idm.reason };
  if (isTombstoned(envelope)) return { eligible: false, reason: 'snapshot tombstoned by a teardown' };
  if (envelope.eligible !== true) return { eligible: false, reason: 'snapshot not eligible (last apply was full/unsupported or invalidated)' };
  if (envelope.debt.length > 0) return { eligible: false, reason: `snapshot carries ${envelope.debt.length} open debt entr${envelope.debt.length === 1 ? 'y' : 'ies'}` };
  if (!envelope.generation) return { eligible: false, reason: 'snapshot missing generation token (cannot CAS)' };
  return { eligible: true, reason: 'fast path eligible' };
}

module.exports = {
  SCHEMA,
  TEARDOWN_DEBT_REASON,
  normId,
  newGeneration,
  makeEnvelope,
  isEnvelope,
  parseEnvelope,
  serializeEnvelope,
  identityMatches,
  hasDebt,
  listDebt,
  addDebt,
  clearDebtMatching,
  markIneligible,
  markEligible,
  tombstone,
  isTombstoned,
  bumpGeneration,
  generationMatches,
  isFastPathEligible,
};
