'use strict';
/**
 * Read-only recovery of interrupted configuration create units (#807), and the local guards a build runs before any configuration write.
 *
 * WHY. The receipt (lib/configuration-create-state.js) says which rows a build meant to create at which ids, and how far each got. After
 * an interruption nothing in this plugin may send a row again on its own: an answer that was lost does not say whether the service
 * committed the row, and a second send at a fresh id would duplicate it. Recovery therefore only READS the service, compares what it
 * sees with the recorded public projections, and changes nothing but the local receipt, and only after an explicit, one-use approval.
 *
 * READ-ONLY BY CONSTRUCTION. Every service read goes through a context made by `createReadOnlyRecoveryContext(ports)`, which accepts
 * EXACTLY four read ports and refuses an object that carries anything else (a post, patch, delete or generic request function). The
 * functions below accept only a context made here (a private brand), so no caller can hand recovery a write capability by accident.
 *
 * PORTS (supplied by the recovery CLI; each may answer a value or a Promise of one; a throw is the same as an unreadable answer):
 *   readRow(kind, id)            -> { ok: true, row } | { ok: false, missing: true } | anything else = unreadable
 *                                   one GET of the recorded row at its recorded id (missing only on a definite not-found)
 *   readChildren(rootKind, rootId) -> { ok: true, children: [{ kind, row }] } | anything else = unreadable
 *                                   every child row of the root, all pages read
 *   readMembership(kind, id)     -> { ok: true, member: boolean } | { ok: true, required: false } | anything else = unreadable
 *   projectObserved(kind, row)   -> { id, parentId, public, lifecycle? }
 *                                   the closed public projection of a read row, in the same field map the receipt uses; `lifecycle`
 *                                   ('unpublished'|'publishing'|'published') only for a duplicate-rule, else taken from row.statuscode
 *
 * EXPORTS:
 *   createReadOnlyRecoveryContext(ports) -> context
 *   isReadOnlyRecoveryContext(value) -> boolean
 *   observeRecordedUnit(context, unit, { kindTable }) -> Promise<observation>
 *   inspectCreateUnit(context, unit, { kindTable }) -> Promise<inspection>
 *   prepareConfigurationResolution(context, options) -> Promise<{ token, revision, privateAcknowledgmentRequired, observation }>
 *   resolveConfigurationResolution(context, options) -> Promise<{ halt, state, removed, deferred }>
 *   assertDeferredUnitsExcluded(state, declarations)
 *   preflightConfigurationCreates(options) -> { quarantineIds, acknowledged, deferredUnits }
 *   validateQuarantineAcknowledgment(workspaceDir, quarantineIds) -> acknowledgment
 *   isQuarantineAcknowledgment(value) -> boolean
 *
 * Nothing here echoes an observed value: an observation names each row's status, never the value that differs, so a private value a
 * port returned by mistake cannot reach a message, a log or the receipt.
 */
const path = require('node:path');
const { sha256 } = require('./hash.js');
const { invalidateSnapshot } = require('./apply-snapshot-store.js');
const state = require('./configuration-create-state.js');

const { configurationCreateHalt: halt, copyPublicProjection, isCanonicalGuid, validateKindTable } = state;

const PORT_KEYS = Object.freeze(['readRow', 'readChildren', 'readMembership', 'projectObserved']);
const LIFECYCLES = Object.freeze(['unpublished', 'publishing', 'published']);
// Dataverse duplicaterule.statuscode: 0 Unpublished, 1 Publishing, 2 Published.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/duplicaterule#statuscode-choicesoptions
const RULE_STATUS = Object.freeze({ 0: 'unpublished', 1: 'publishing', 2: 'published' });

// The outcome of an observation, worst first: the first one found wins. Anything unreadable outranks a conflict, because a conflict
// read from an incomplete graph may be wrong; a conflict outranks a missing row, which outranks the membership and publication steps.
const PRECEDENCE = Object.freeze([
  'configuration-create-graph-unreadable',
  'configuration-create-identity-conflict',
  'configuration-create-content-conflict',
  'configuration-create-row-missing',
  'configuration-create-membership-incomplete',
  'configuration-create-publication-pending',
]);

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const unitIds = (u) => ({ unitId: u.unitId, rootId: u.root.id, rootKind: u.root.kind });

// ── The read-only context ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const contexts = new WeakSet();

function createReadOnlyRecoveryContext(ports) {
  const refuse = (reason) => halt('configuration-create-shape-refused', { reason });
  if (!isPlainObject(ports)) throw refuse('recovery needs its read ports');
  const keys = Object.keys(ports);
  // Exactly the four reads: an extra member (post, patch, delete, request, a client) is refused rather than ignored, so a write
  // capability can never ride along into recovery.
  if (keys.length !== PORT_KEYS.length || !PORT_KEYS.every((k) => has(ports, k) && typeof ports[k] === 'function')) {
    throw refuse('recovery accepts exactly the four read ports and nothing that can write');
  }
  const { readRow, readChildren, readMembership, projectObserved } = ports;
  const context = Object.freeze({
    readRow: (kind, id) => readRow(kind, id),
    readChildren: (kind, id) => readChildren(kind, id),
    readMembership: (kind, id) => readMembership(kind, id),
    projectObserved: (kind, row) => projectObserved(kind, row),
  });
  contexts.add(context);
  return context;
}
const isReadOnlyRecoveryContext = (v) => !!v && typeof v === 'object' && contexts.has(v);
function assertContext(context) {
  if (!isReadOnlyRecoveryContext(context)) throw halt('configuration-create-shape-refused', { reason: 'recovery reads only through a read-only recovery context' });
}

async function settle(fn) {
  try { return await fn(); } catch { return undefined; }
}

// The closed projection of one read row, or null when it does not fit the receipt's field map (an unknown field, a private field, a
// wrong type): such a row cannot be compared, so it is unreadable, never "different".
async function project(context, kind, row, kindTable) {
  const p = await settle(() => context.projectObserved(kind, row));
  if (!isPlainObject(p) || !isCanonicalGuid(p.id) || !(p.parentId === null || isCanonicalGuid(p.parentId))) return null;
  let pub;
  try { pub = copyPublicProjection(kind, p.public, kindTable, () => new Error('closed')); } catch { return null; }
  let lifecycle = null;
  if (kind === 'duplicate-rule') {
    if (has(p, 'lifecycle') && p.lifecycle !== undefined) lifecycle = LIFECYCLES.includes(p.lifecycle) ? p.lifecycle : null;
    else lifecycle = isPlainObject(row) && has(RULE_STATUS, row.statuscode) ? RULE_STATUS[row.statuscode] : null;
  }
  return { id: p.id, parentId: p.parentId, public: pub, lifecycle };
}

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Observes a recorded unit with GETs only. Answers a frozen
 *   { unitId, outcome: 'match' | <one of PRECEDENCE>, observedPublicSha256,
 *     rows: [{ id, kind, key, role, dispatch, status: 'match'|'missing'|'identity-conflict'|'content-conflict'|'unreadable' }],
 *     children: { status: 'complete'|'unreadable'|'inconsistent', unexpected: number },
 *     membership: [{ id, kind, status: 'member'|'not-required'|'absent'|'unreadable' }],
 *     lifecycle: null | { expected: 'published'|'unpublished', observed: <lifecycle>|'unreadable' } }
 */
async function observeRecordedUnit(context, unit, { kindTable } = {}) {
  assertContext(context);
  validateKindTable(kindTable);
  const rootRow = unit.rows.find((r) => r.id === unit.root.id);
  const rows = [];
  const observed = [];
  let rootLifecycle = null;
  for (const r of unit.rows) {
    const res = await settle(() => context.readRow(r.kind, r.id));
    let status;
    if (isPlainObject(res) && res.ok === false && res.missing === true) status = 'missing';
    else if (isPlainObject(res) && res.ok === true && has(res, 'row')) {
      const p = await project(context, r.kind, res.row, kindTable);
      if (!p) status = 'unreadable';
      else if (p.id !== r.id || p.parentId !== r.parentId) status = 'identity-conflict';
      else if (!sameJson(p.public, r.public)) status = 'content-conflict';
      else status = 'match';
      if (p) {
        observed.push({ kind: r.kind, id: p.id, parentId: p.parentId, public: p.public });
        if (r === rootRow) rootLifecycle = p.lifecycle;
      }
    } else status = 'unreadable';
    if (status === 'missing') observed.push({ kind: r.kind, id: r.id, missing: true });
    rows.push({ id: r.id, kind: r.kind, key: r.key, role: r.role, dispatch: r.dispatch, status });
  }

  // The whole child list of the root, so a child somebody else added (or a page this read missed) is seen, not assumed absent.
  const children = { status: 'complete', unexpected: 0 };
  const listedRows = [];
  const rootStatus = rows.find((x) => x.id === unit.root.id).status;
  if (rootStatus !== 'missing') {
    const res = await settle(() => context.readChildren(unit.root.kind, unit.root.id));
    if (!isPlainObject(res) || res.ok !== true || !Array.isArray(res.children)) children.status = 'unreadable';
    else {
      const recorded = new Map(unit.rows.filter((r) => r.id !== unit.root.id).map((r) => [r.id, r]));
      const exact = new Map(observed.filter((o) => !o.missing).map((o) => [o.id, o]));
      const listed = new Set();
      for (const c of res.children) {
        const p = isPlainObject(c) && typeof c.kind === 'string' && has(kindTable, c.kind) ? await project(context, c.kind, c.row, kindTable) : null;
        if (!p || listed.has(p.id) || p.parentId !== unit.root.id) { children.status = 'unreadable'; continue; }
        listed.add(p.id);
        listedRows.push({ kind: c.kind, id: p.id, parentId: p.parentId, public: p.public });
        const rec = recorded.get(p.id);
        if (!rec) { children.unexpected += 1; observed.push({ kind: c.kind, id: p.id, parentId: p.parentId, public: p.public, unexpected: true }); continue; }
        if (rec.kind !== c.kind) { children.status = 'unreadable'; continue; }
        // A recorded child must look the same in the collection as at its exact read (and, when that read matched, as recorded): a
        // collection-only edit, or a stale page, is a graph this read cannot trust, never a match.
        const st = rows.find((x) => x.id === p.id).status;
        const at = exact.get(p.id);
        if (st === 'unreadable' || !at) continue;
        if (at.parentId !== p.parentId || !sameJson(at.public, p.public)) children.status = 'inconsistent';
        else if (st === 'match' && (rec.parentId !== p.parentId || !sameJson(rec.public, p.public))) children.status = 'inconsistent';
      }
      // The list and the exact reads must agree both ways; a disagreement means one of them is incomplete.
      if (children.status === 'complete') {
        for (const [id] of recorded) {
          const st = rows.find((x) => x.id === id).status;
          // An unreadable row is already unreadable; a row read at its id under another parent need not be listed under this root.
          if (st === 'unreadable' || st === 'identity-conflict') continue;
          if (listed.has(id) !== (st !== 'missing')) children.status = 'inconsistent';
        }
      }
    }
  }

  const membership = [];
  for (const r of unit.rows) {
    const st = rows.find((x) => x.id === r.id).status;
    if (st === 'missing') continue;
    const res = await settle(() => context.readMembership(r.kind, r.id));
    let status;
    if (isPlainObject(res) && res.ok === true && res.required === false && !has(res, 'member')) status = 'not-required';
    else if (isPlainObject(res) && res.ok === true && typeof res.member === 'boolean') status = res.member ? 'member' : 'absent';
    else status = 'unreadable';
    membership.push({ id: r.id, kind: r.kind, status });
  }

  let lifecycle = null;
  if (unit.root.kind === 'duplicate-rule' && rootStatus !== 'missing') {
    lifecycle = { expected: unit.publication ? 'published' : 'unpublished', observed: rootLifecycle || 'unreadable' };
  }

  const codes = new Set();
  if (rows.some((x) => x.status === 'unreadable') || children.status !== 'complete' || (lifecycle && lifecycle.observed === 'unreadable')) codes.add(PRECEDENCE[0]);
  if (rows.some((x) => x.status === 'identity-conflict')) codes.add(PRECEDENCE[1]);
  if (rows.some((x) => x.status === 'content-conflict') || children.unexpected > 0) codes.add(PRECEDENCE[2]);
  if (lifecycle && lifecycle.expected === 'unpublished' && (lifecycle.observed === 'published' || lifecycle.observed === 'publishing')) codes.add(PRECEDENCE[2]);
  if (rows.some((x) => x.status === 'missing')) codes.add(PRECEDENCE[3]);
  if (membership.some((m) => m.status === 'absent' || m.status === 'unreadable')) codes.add(PRECEDENCE[4]);
  if (lifecycle && lifecycle.expected === 'published' && (lifecycle.observed === 'unpublished' || lifecycle.observed === 'publishing')) codes.add(PRECEDENCE[5]);
  const outcome = PRECEDENCE.find((c) => codes.has(c)) || 'match';

  // The hash binds an approval to exactly this observation: rows, the child list as listed, membership and lifecycle, in a fixed order.
  observed.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  listedRows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const canonical = { unitId: unit.unitId, attemptId: unit.attemptId, rows: observed, listed: listedRows, membership, lifecycle, children };
  const observation = {
    unitId: unit.unitId,
    outcome,
    observedPublicSha256: sha256(JSON.stringify(canonical)),
    rows,
    children,
    membership,
    lifecycle,
  };
  return deepFreeze(observation);
}

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

const wholePrepared = (unit) => unit.rows.every((r) => r.role !== 'create' || r.dispatch === 'prepared')
  && (!unit.publication || unit.publication.dispatch === 'prepared');

/**
 * Inspect: the observation, the dispatch classification, the halt for its outcome (null on a match), and a NON-executing manual
 * completion description of every missing row this plugin was creating: its kind, recorded id, parent, key, recorded public fields and
 * the NAMES of the private inputs the operator must supply out of band. A missing preserved row gets no recipe: it is a conflict.
 */
async function inspectCreateUnit(context, unit, { kindTable } = {}) {
  const observation = await observeRecordedUnit(context, unit, { kindTable });
  const missing = new Set(observation.rows.filter((r) => r.status === 'missing' && r.role === 'create').map((r) => r.id));
  const manualCompletion = unit.rows.filter((r) => missing.has(r.id)).map((r) => ({
    kind: r.kind, id: r.id, parentId: r.parentId, key: r.key, public: { ...r.public }, privateFields: r.privateFields.slice(),
  }));
  const missingPreserved = observation.rows.some((r) => r.status === 'missing' && r.role === 'preserved');
  let haltError = null;
  if (observation.outcome !== 'match') {
    haltError = halt(observation.outcome, {
      ...unitIds(unit),
      reason: missingPreserved && observation.outcome === 'configuration-create-row-missing' ? 'a row that existed before this unit is absent; it is a conflict and is never recreated' : undefined,
    });
  }
  return deepFreeze({
    unitId: unit.unitId,
    state: unit.state,
    root: { ...unit.root },
    dispatch: wholePrepared(unit) ? 'not-dispatched' : 'possibly-dispatched',
    publication: unit.publication ? unit.publication.dispatch : null,
    observation,
    halt: haltError,
    nextStep: haltError ? haltError.nextStep : 'Prepare an accept-current resolution for this unit, then resolve it with the approval token.',
    manualCompletion,
  });
}

// ── Declarations and deferral ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// A declaration names one configuration root the current build would touch: { kind, key?, id?, names?: [string], dependsOn?: [ref] }
// where a ref is { kind, key?, id?, name? }. A deferred unit's root may not come back by its stable key, its recorded id (root or row),
// or a logical name that matches its key or a string field of its recorded root projection (case-insensitive, as Dataverse compares
// names), and nothing may depend on it.
function refMatches(ref, unit) {
  if (!isPlainObject(ref)) return false;
  if (typeof ref.id === 'string' && unit.rows.some((r) => r.id === ref.id.toLowerCase())) return true;
  if (ref.kind !== undefined && ref.kind !== unit.root.kind) return false;
  if (typeof ref.key === 'string' && ref.key === unit.root.key) return true;
  const rootRow = unit.rows.find((r) => r.id === unit.root.id);
  const aliases = [unit.root.key, ...Object.values(rootRow ? rootRow.public : {}).filter((v) => typeof v === 'string')].map((s) => s.toLowerCase());
  const names = [...(Array.isArray(ref.names) ? ref.names : []), ref.name, ref.key].filter((s) => typeof s === 'string' && s);
  return names.some((n) => aliases.includes(n.toLowerCase()));
}
function declarationMatches(declaration, unit) {
  if (!isPlainObject(declaration)) return false;
  if (refMatches(declaration, unit)) return true;
  return Array.isArray(declaration.dependsOn) && declaration.dependsOn.some((d) => refMatches(d, unit));
}
function assertUnitsExcluded(units, declarations) {
  const list = Array.isArray(declarations) ? declarations : [];
  for (const u of units) {
    if (list.some((d) => declarationMatches(d, u))) {
      throw halt('configuration-create-pending', {
        ...unitIds(u),
        reason: u.state === 'deferred' ? 'the build declares or depends on the root of a deferred unit' : 'the build still declares or depends on the root of the unit to defer',
        nextStep: 'Remove the root, its aliases and everything that depends on it from the declaration, or resolve the unit first.',
      });
    }
  }
}
/** Throws `configuration-create-pending` when any declaration reintroduces, renames into, or depends on a deferred unit's root. */
function assertDeferredUnitsExcluded(savedState, declarations) {
  if (!savedState) return;
  assertUnitsExcluded(savedState.units.filter((u) => u.state === 'deferred'), declarations);
}

// ── Quarantine acknowledgment ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const acknowledgments = new WeakSet();

/**
 * Validates a build's explicit acknowledgment of the workspace's quarantines (the ids from --acknowledge-quarantined-configuration).
 * It must name exactly every deferred quarantine: one left out is `configuration-create-quarantined`, one that does not exist is
 * `configuration-create-approval-stale`, and an archiving, invalid or archive-less quarantine or an orphan archive is
 * `configuration-create-state-invalid`. Answers a frozen acknowledgment for this invocation only (never saved).
 */
function validateQuarantineAcknowledgment(workspaceDir, quarantineIds) {
  const found = state.discoverConfigurationQuarantines(workspaceDir);
  if (found.orphanArchives.length > 0 || found.quarantines.some((q) => q.status !== 'valid' || q.state !== 'deferred' || !q.archive)) {
    throw halt('configuration-create-state-invalid', { reason: 'a quarantine is incomplete or invalid', nextStep: 'Finish or inspect the quarantine with configuration-recovery.js resolve --resolution quarantine-unreadable --quarantine-id <id>.' });
  }
  const current = new Set(found.quarantines.map((q) => q.quarantineId));
  const given = new Set((Array.isArray(quarantineIds) ? quarantineIds : []).map((s) => String(s).toLowerCase()));
  for (const id of given) {
    if (!current.has(id)) throw halt('configuration-create-approval-stale', { reason: 'the acknowledgment names a quarantine this workspace does not hold' });
  }
  for (const id of current) {
    if (!given.has(id)) throw halt('configuration-create-quarantined', { reason: `quarantine ${id} is not acknowledged` });
  }
  const ack = Object.freeze({ quarantineIds: Object.freeze([...current].sort()) });
  acknowledgments.add(ack);
  return ack;
}
const isQuarantineAcknowledgment = (v) => !!v && typeof v === 'object' && acknowledgments.has(v);

// ── The build guard ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * The local guard a build runs before it interprets or writes any configuration (no service call). Throws:
 *   state-invalid       for any blocking evidence (an invalid receipt or marker, an archiving quarantine, an orphan archive, an unknown entry)
 *   context-mismatch    for saved units of another environment, solution, app or language
 *   pending / publication-pending   for an open unit
 *   pending             for a declaration that reintroduces or depends on a deferred unit's root
 *   quarantined         for configuration work while a quarantine is not acknowledged (unrelated work may proceed)
 * `quarantineAcknowledgment` is an acknowledgment from validateQuarantineAcknowledgment, or the raw list of ids to validate.
 * Answers a frozen { quarantineIds, acknowledged, deferredUnits }.
 */
function preflightConfigurationCreates({ workspaceDir, context, kindTable, declarations, configurationWork = false, quarantineAcknowledgment } = {}) {
  const found = state.discoverConfigurationCreateState(workspaceDir, { kindTable });
  if (found.blocking) {
    let reason = 'the workspace holds configuration create evidence that is not valid or not complete';
    if (found.sidecar.status === 'invalid') reason = found.sidecar.reason;
    throw halt('configuration-create-state-invalid', { reason });
  }
  const saved = found.sidecar.status === 'valid' ? found.sidecar.state : null;
  const units = saved ? saved.units : [];
  // An empty receipt carries no unit to protect, so its context does not stop a build of another app or environment.
  if (units.length > 0 && !state.sameCreateStateContext(saved, context)) throw halt('configuration-create-context-mismatch', unitIds(units[0]));
  const open = units.find((u) => u.state === 'open');
  if (open) {
    const allVerified = open.rows.every((r) => r.role !== 'create' || r.dispatch === 'verified');
    throw halt(open.publication && allVerified ? 'configuration-create-publication-pending' : 'configuration-create-pending', unitIds(open));
  }
  assertDeferredUnitsExcluded(saved, declarations);
  const quarantineIds = found.quarantines.map((q) => q.quarantineId);
  let acknowledged = false;
  if (quarantineIds.length > 0 && configurationWork) {
    if (quarantineAcknowledgment === undefined || quarantineAcknowledgment === null) {
      throw halt('configuration-create-quarantined', { reason: `${quarantineIds.length} quarantine(s) are not acknowledged` });
    }
    const ack = isQuarantineAcknowledgment(quarantineAcknowledgment)
      ? quarantineAcknowledgment
      : validateQuarantineAcknowledgment(workspaceDir, quarantineAcknowledgment);
    if (!sameJson([...ack.quarantineIds], [...quarantineIds].sort())) throw halt('configuration-create-approval-stale', { reason: 'the quarantines changed after they were acknowledged' });
    acknowledged = true;
  }
  return Object.freeze({ quarantineIds: Object.freeze(quarantineIds), acknowledged, deferredUnits: units.filter((u) => u.state === 'deferred').length });
}

// ── Prepare and resolve ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The saved unit and the revision, with the context checked BEFORE anything is read from a service (a receipt of another environment
// must never send reads to the environment named now).
function loadUnit(workspaceDir, { kindTable, context, unitId }) {
  const saved = state.readConfigurationCreateState(workspaceDir, { kindTable });
  const unit = saved && saved.units.find((u) => u.unitId === (typeof unitId === 'string' ? unitId.toLowerCase() : unitId));
  if (!unit) throw halt('configuration-create-approval-stale', { reason: 'no saved unit has that id' });
  if (!state.sameCreateStateContext(saved, context)) throw halt('configuration-create-context-mismatch', unitIds(unit));
  return { saved, unit };
}

function checkMode(mode) {
  if (!['accept-current', 'defer', 'cancel-unsent'].includes(mode)) throw halt('configuration-create-shape-refused', { reason: 'the resolution is not accept-current, defer or cancel-unsent' });
}

// The local checks both prepare and resolve repeat. accept-current needs a fresh complete match; defer needs the declaration to leave
// the unit out (and no service read at all, so an unreachable environment can still be deferred); cancel needs no quarantine.
async function checkResolution(context, { workspaceDir, kindTable, unit, mode, currentPublicIntentSha256, declarations, checkLocalDrafts }) {
  if (typeof checkLocalDrafts === 'function') await checkLocalDrafts();
  if (mode === 'accept-current') {
    if (currentPublicIntentSha256 !== unit.publicIntentSha256) throw halt('configuration-create-intent-changed', unitIds(unit));
    const observation = await observeRecordedUnit(context, unit, { kindTable });
    if (observation.outcome !== 'match') throw halt(observation.outcome, unitIds(unit));
    return observation;
  }
  if (mode === 'defer') {
    assertUnitsExcluded([unit], declarations);
    return null;
  }
  if (state.discoverConfigurationQuarantines(workspaceDir).quarantines.length > 0) {
    throw halt('configuration-create-quarantined', { ...unitIds(unit), reason: 'a unit cannot be cancelled while the workspace holds a quarantine' });
  }
  return null;
}

/**
 * Prepare: { workspaceDir, kindTable, context (from createStateContext), unitId, mode, currentPublicIntentSha256 (accept-current),
 * declarations (defer), checkLocalDrafts?, leaseDeps? }. Answers the one-use token and the observation it binds.
 */
async function prepareConfigurationResolution(recoveryContext, options = {}) {
  const { workspaceDir, kindTable, context, unitId, mode, leaseDeps } = options;
  checkMode(mode);
  if (mode === 'accept-current') assertContext(recoveryContext);
  const { saved, unit } = loadUnit(workspaceDir, { kindTable, context, unitId });
  const observation = await checkResolution(recoveryContext, { ...options, unit });
  const offer = state.prepareResolutionOffer(workspaceDir, {
    kindTable, context, unitId: unit.unitId, mode, leaseDeps,
    observedPublicSha256: observation ? observation.observedPublicSha256 : null,
    expectedRevision: saved.revision,
  });
  return { ...offer, observation };
}

/**
 * Resolve: the prepare options plus { token, acceptCurrentPrivateState?, invalidate? }. Re-checks everything prepare checked, with a
 * fresh observation, then invalidates the apply snapshot (fail-closed: the next build must not skip normal reconciliation) and uses
 * the offer. Answers { halt: <configuration-create-reconciled, returned not thrown>, state, removed, deferred }.
 */
async function resolveConfigurationResolution(recoveryContext, options = {}) {
  const { workspaceDir, kindTable, context, unitId, mode, token, acceptCurrentPrivateState = false, invalidate, leaseDeps } = options;
  checkMode(mode);
  if (mode === 'accept-current') assertContext(recoveryContext);
  const { saved, unit } = loadUnit(workspaceDir, { kindTable, context, unitId });
  // The full check of the token before any read or invalidation; it is repeated under the lease when the offer is used.
  if (!unit.offer || unit.offer.mode !== mode || !state.offerTokenMatches(unit.offer, saved.revision, token)) {
    throw halt('configuration-create-approval-stale', { ...unitIds(unit), reason: 'the approval token does not belong to the saved state' });
  }
  if (mode === 'accept-current' && unit.offer.privateAcknowledgmentRequired && acceptCurrentPrivateState !== true) {
    throw halt('configuration-create-private-review-required', unitIds(unit));
  }
  const observation = await checkResolution(recoveryContext, { ...options, unit });
  const root = path.resolve(workspaceDir);
  const invalidateFn = typeof invalidate === 'function' ? invalidate : (dir) => invalidateSnapshot(dir);
  let inv;
  try { inv = invalidateFn(root); } catch { inv = null; }
  if (!inv || inv.ok !== true) throw halt('configuration-create-persistence-uncertain', { ...unitIds(unit), transition: 'resolve', reason: 'the apply snapshot could not be invalidated' });
  const res = state.resolveResolutionOffer(workspaceDir, {
    kindTable, context, unitId: unit.unitId, mode, token, leaseDeps, acceptCurrentPrivateState,
    observedPublicSha256: observation ? observation.observedPublicSha256 : null,
  });
  let what = 'deferred';
  if (mode === 'accept-current') what = 'accepted as it is now';
  else if (mode === 'cancel-unsent') what = 'cancelled before anything was sent';
  return { halt: halt('configuration-create-reconciled', { ...unitIds(unit), transition: 'resolve', reason: `the unit was ${what}` }), state: res.state, removed: res.removed, deferred: res.deferred };
}

module.exports = {
  createReadOnlyRecoveryContext,
  isReadOnlyRecoveryContext,
  observeRecordedUnit,
  inspectCreateUnit,
  prepareConfigurationResolution,
  resolveConfigurationResolution,
  assertDeferredUnitsExcluded,
  preflightConfigurationCreates,
  validateQuarantineAcknowledgment,
  isQuarantineAcknowledgment,
};
