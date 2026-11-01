'use strict';

// managed-feature-contract.js — the one settlement path of a declared form, dashboard, business rule or process flow.
//
// A managed artifact is a group: a root row plus children (form controls, dashboard tiles, rule slots, process
// stages) whose ids the store binds together. The shipped single-record path (reconcile-common.js
// createFeatureSettlement) records bindings one at a time, so a crash between two records leaves the old root bound
// with only some of its new children — and a crash after the remote write but before any record leaves nothing that
// says what was sent. runManagedFeature closes both:
//   1. register the artifact's scopes and ids with the publication barrier (not a block);
//   2. resolve and plan; a proved no-op ensures membership and changes nothing else;
//   3. persist an attempt (prepareAttempt) and hold its scopes under the attempt's token, then persist the complete
//      expected proof (markSending) BEFORE the one push — a failed store write means the push is not sent;
//   4. apply the change once, prove it from a fresh read against the stored expected proof (never against today's
//      declaration), ensure solution membership, and commit the whole group in one atomic store write;
//   5. release only this attempt's hold.
// A pending attempt found on disk is recovered the same way, by its stored expected proof, without sending again.
// A required failure (resolve, plan, proof, membership, an unsettled dashboard creation record) quarantines the
// artifact's scopes for the rest of the invocation; any other failure keeps the hold. Either way the attempt stays on
// disk, the bindings do not advance, and the build stops with the halt the caller's factory makes.
//
// Nothing calls this module until a declared form, dashboard, rule or process flow is wired to it.

const { runWithWorkflowEffect } = require('./workflow-effect-context.js');
const { CODES, classifyPersisted } = require('./managed-bindings.js');

const PUBLICATION_UNVERIFIED = 'managed-publication-unverified';
const PUBLICATION_UNCONFIRMED = 'managed-publication-unconfirmed';
// A managed publish whose request named other publish targets than its one scope: refused unsent, debt still owed.
const PUBLICATION_REFUSED = 'managed-publication-refused';
const CREATION_RECORD_UNSETTLED = 'dashboard-creation-record-unsettled';

function codedError(code, message, extra) {
  return Object.assign(new Error(message), { code }, extra || {});
}

// A step whose failure means the artifact's saved state is not shown safe: its scopes stay withheld for the run.
const REQUIRED_STEPS = new Set(['resolve', 'plan', 'prove', 'membership']);

/**
 * Settle one managed artifact. Arguments:
 *   phase, family, key, label?  where the build is, and what the artifact is called in a halt;
 *   knownScopes, knownIds       the scopes ({ type: 'table', table } / { type: 'dashboard', id }) and row ids the
 *                               artifact may publish, registered before anything else. A dashboard's own ids are its
 *                               publish scopes, so for the dashboard family every known id (and the committed, pending
 *                               and planned root) is held and quarantined as a dashboard scope even when no scope was
 *                               given: a dashboard whose creation is not settled has a retained id and no scope yet;
 *   store                       the managed binding handle (lib/managed-bindings.js), opened with the barrier;
 *   barrier?                    the publication barrier; defaults to the store's forwarded barrier operations;
 *   halt(phase, label, code, { cause })  the build's halt FACTORY: it returns the error to throw (the build's
 *                               managedStop returns a never-retry halt and does not throw it);
 *   resolve({ committed, pending })      read and preflight; answers the resolution;
 *   plan({ resolution, committed })      answers { noop: true } or { root, expected, declarationSha256,
 *                                        publication? } (publication: the attempt's { scope, state: 'owed' } or null);
 *   apply({ token, plan, resolution })   send the approved change once; answers what it sent;
 *   prove({ token, expected, applied, recovering })  a fresh read against `expected`; answers { savedProof,
 *                               acknowledgedRoot, records, proof, consumerState, publication, proofSchema? };
 *   ensureMembership({ root, records, recovering })  solution membership, for a clean reused root too.
 * Answers { result, committedGroup }: result is { noop: true } or { committed: true, recovered }.
 */
async function runManagedFeature(args) {
  const { phase, family, key, knownScopes = [], knownIds = [], store, halt, resolve, plan, apply, prove, ensureMembership } = args || {};
  // The factory is checked before any side effect: a wrapper that could not stop the build must not start it.
  if (typeof halt !== 'function') throw codedError(CODES.notSettled, 'runManagedFeature needs the build\'s halt factory');
  for (const [name, fn] of Object.entries({ resolve, plan, apply, prove, ensureMembership })) {
    if (typeof fn !== 'function') throw codedError(CODES.notSettled, `runManagedFeature needs ${name}`);
  }
  if (!store || typeof store.readGroup !== 'function') throw codedError(CODES.notSettled, 'runManagedFeature needs the managed binding store');
  const barrier = args.barrier || store;
  const label = args.label || `managed ${family} "${key}"`;
  // The complete target set the artifact's holds and quarantine cover; it grows as the committed, pending and planned
  // roots become known. The caller's knownScopes are kept as given for the attempt record.
  const scopes = [...knownScopes];
  const ids = [];
  const scopeKeys = new Set(scopes.map((s) => (s && s.type === 'dashboard' ? `d:${String(s.id).toLowerCase()}` : '')));
  const addIds = (more) => {
    for (const raw of more) {
      if (!raw) continue;
      const id = String(raw);
      if (!ids.some((x) => x.toLowerCase() === id.toLowerCase())) ids.push(id);
      const k = `d:${id.toLowerCase()}`;
      if (family === 'dashboard' && !scopeKeys.has(k)) { scopeKeys.add(k); scopes.push({ type: 'dashboard', id }); }
    }
    barrier.registerKnown(scopes, ids);
  };
  let token = null;
  let step = 'read';

  const stop = (err) => {
    const code = (err && err.code) || CODES.notSettled;
    const required = REQUIRED_STEPS.has(step) || code === CREATION_RECORD_UNSETTLED;
    try {
      if (required) barrier.quarantine(scopes, ids, `${label} (${code})`);
    } catch (e) {
      // A barrier that cannot quarantine leaves the scope as it is; the halt below still stops the build.
      err = Object.assign(err instanceof Error ? err : new Error(String(err)), { quarantineError: e });
    }
    const e = halt(phase, label, code, { cause: err });
    if (!(e instanceof Error)) throw codedError(CODES.notSettled, `${label} did not settle, and the halt factory made no error to stop the build with`, { cause: err });
    throw e;
  };

  try {
    addIds(knownIds);
    const { committed, pending } = store.readGroup(family, key);
    addIds([committed && committed.root && committed.root.id, pending && pending.root && pending.root.id]);

    if (pending && pending.expected) {
      // Recovery: the change may already be on the server. Prove it by the expected proof it was sent with; never
      // send it again and never re-baseline from today's declaration.
      token = pending.token;
      barrier.hold(token, scopes, ids, `${label} (an earlier change is not yet proved)`);
      step = 'prove';
      const proved = await prove({ token, expected: pending.expected, applied: null, recovering: true });
      step = 'membership';
      await ensureMembership({ root: pending.root, records: proved.records, recovering: true });
      step = 'commit';
      const group = commit(store, token, pending.baseGeneration, proved);
      barrier.release(token);
      return { result: { committed: true, recovered: true }, committedGroup: group };
    }

    step = 'resolve';
    const resolution = await resolve({ committed, pending });
    step = 'plan';
    const planned = await plan({ resolution, committed });
    if (!planned || planned.noop === true) {
      if (pending) throw codedError(CODES.pending, `${label} has a prepared change that a no-op plan cannot retire`);
      step = 'membership';
      await ensureMembership({ root: committed ? committed.root : null, records: committed ? committed.records : [], recovering: false });
      return { result: { noop: true }, committedGroup: committed };
    }

    step = 'prepare';
    addIds([planned.root && planned.root.id]);
    const baseGeneration = pending ? pending.baseGeneration : committed ? committed.generation : null;
    if (pending) {
      // A prepared attempt that was never sent is intent only: it is resumed under its own token.
      token = pending.token;
    } else {
      token = store.prepareAttempt({
        family, key, baseGeneration, root: planned.root, expected: null, knownScopes, declarationSha256: planned.declarationSha256,
        publication: planned.publication || null,
      });
    }
    barrier.hold(token, scopes, ids, `${label} (a change is being saved and is not yet proved)`);
    step = 'send';
    store.markSending(token, planned.expected);
    const applied = await apply({ token, plan: planned, resolution });
    step = 'prove';
    const proved = await prove({ token, expected: planned.expected, applied, recovering: false });
    step = 'saved';
    store.noteSaved(token, { proof: proved.savedProof === undefined ? null : proved.savedProof, acknowledgedRoot: proved.acknowledgedRoot === true });
    step = 'membership';
    await ensureMembership({ root: planned.root, records: proved.records, recovering: false });
    step = 'commit';
    const group = commit(store, token, baseGeneration, proved);
    barrier.release(token);
    return { result: { committed: true, recovered: false }, committedGroup: group };
  } catch (err) {
    return stop(err);
  }
}

function commit(store, token, baseGeneration, proved) {
  return store.commitGroup({
    token, baseGeneration, records: proved.records, proof: proved.proof, consumerState: proved.consumerState,
    publication: proved.publication === undefined ? null : proved.publication, proofSchema: proved.proofSchema,
  });
}

/**
 * Persist `effect` (a workflowEffects record, without token and state) as definitely-unsent under its attempt, then
 * run `fn(record)` inside its transport context: the one workflow write that matches it is sent once, and any other
 * mutation inside `fn` is refused unsent (lib/workflow-effect-context.js). Reads inside `fn` pass as always.
 */
async function withWorkflowEffect({ store, effect }, fn) {
  if (!store || typeof store.recordWorkflowEffect !== 'function') throw codedError(CODES.notSettled, 'withWorkflowEffect needs the managed binding store');
  if (typeof fn !== 'function') throw codedError(CODES.notSettled, 'withWorkflowEffect needs the write to run');
  const record = store.recordWorkflowEffect(effect);
  return runWithWorkflowEffect(record, () => fn(record));
}

// A publication scope as one comparable key — `table:<logical name>` or `dashboard:<id>`, lowercased and without
// braces, as the barrier normalises the names it screens in a ParameterXml — or '' for anything else.
function scopeId(s) {
  if (!s || typeof s !== 'object') return '';
  if (s.type === 'dashboard') return typeof s.id === 'string' && s.id.trim() ? `dashboard:${s.id.trim().replace(/^\{|\}$/g, '').toLowerCase()}` : '';
  return s.type === 'table' && typeof s.table === 'string' && s.table.trim() ? `table:${s.table.trim().toLowerCase()}` : '';
}

/**
 * What a publish of `scope` puts live, as far as the store knows: a table publish ships the saved layer of EVERY form
 * of the table, and a dashboard publish the dashboard's, so the set is taken from the store, not from the caller —
 * a caller cannot leave a sibling out. Every unit whose scopes (classifyPersisted: the committed publication's scope,
 * a pending attempt's known scopes) include `scope`:
 *   groups     the committed groups published in `scope`, whose saved layers a send must show safe;
 *   corrupt    a group that failed validation; uncertain: a publish or workflow effect that may have been sent;
 *   pending    an attempt that is not yet proved and committed.
 */
function coverageOf(store, scope) {
  if (typeof store.snapshot !== 'function') throw codedError(CODES.notSettled, 'publishManagedScope needs the store\'s snapshot to see every group of the scope');
  const want = scopeId(scope);
  const out = { groups: [], corrupt: [], uncertain: [], pending: [] };
  for (const unit of store.snapshot().units()) {
    const c = classifyPersisted(unit);
    if (!c.targets.scopes.some((s) => scopeId(s) === want)) continue;
    const ref = { family: unit.family, key: unit.key };
    if (c.kind === 'corrupt') { out.corrupt.push(ref); continue; }
    if (c.kind === 'uncertain') out.uncertain.push(ref);
    if (c.kind === 'hold') out.pending.push(ref);
    if (unit.group && unit.group.publication && scopeId(unit.group.publication.scope) === want) out.groups.push({ ...ref, group: unit.group });
  }
  return out;
}

/**
 * Pay the owed publication of committed `groups` ([{ family, key }]) that share `scope`, at most once:
 *   - a group that owes nothing is skipped; an uncertain one (dispatching/unconfirmed) is never published again:
 *     `managed-publication-unconfirmed`; a pending attempt: `managed-settlement-pending`; a group published in another
 *     scope: `managed-not-settled`. `groups` is the debt this call dispatches and confirms, nothing more;
 *   - what the publish would put live is every committed group of `scope` in the store (coverageOf), passed or not.
 *     A corrupt or uncertain one blocks the scope for the run and stops (`managed-binding-group-invalid` /
 *     `managed-publication-unconfirmed`); a pending attempt on the scope withholds the publish, debt still owed;
 *   - `readLayers(group)` answers { savedSha256, publishedSha256 } from a fresh read of both layers of one covered
 *     group, each hashed the way its `publication.desiredSha256` was. A read that fails or lacks a hash, before
 *     anything is sent, is `managed-publication-unverified` and blocks the scope for the run: what is saved on it is
 *     not shown safe. Debt whose published layer already equals what is owed ends without a send;
 *   - a publish ships the SAVED layer of every covered group, so it is sent only while each of them is safe to put
 *     live: a group that owes a publish must have exactly its owed layer saved (debt that names no desired hash never
 *     is), and any other group a saved layer equal to its published one or to its desired hash. Otherwise
 *     `create-completion-required`, and the scope is blocked for the run, before anything is sent;
 *   - a scope the barrier withholds is not sent and its debt stays owed;
 *   - otherwise the scope is held under a fresh token, and `publish()` runs under the barrier's send permit for that
 *     token: the debt is marked dispatching at the moment the one publish request is sent, and a fresh read confirms
 *     it in one store write. A request the barrier withholds leaves the debt owed and consumes nothing; one whose
 *     publish targets are not exactly `scope` is refused unsent (`managed-publication-refused`), debt owed.
 *   - after a send, the scope stays blocked for the rest of the run unless its whole settlement is durably written:
 *     every covered group's debt confirmed, or the send recorded definitely not started. A send whose outcome is not
 *     proved is `managed-publication-unconfirmed`; a store write that fails after the send rethrows its own error.
 *     The block is set in memory, so it never depends on a store write succeeding, and a sibling's success never
 *     clears it.
 * `publish()` may throw an error with `definiteNoStart: true` only when the request is known not to have started.
 * Answers { sent, withheld, confirmed: [{ family, key }] }.
 */
async function publishManagedScope({ store, barrier, scope, groups, readLayers, publish, path = 'managed publication', newToken } = {}) {
  if (!store || typeof readLayers !== 'function' || typeof publish !== 'function') throw codedError(CODES.notSettled, 'publishManagedScope needs the store, a reader of the saved and published layers, and the publish');
  const gate = barrier || store;
  for (const op of ['allowScope', 'blockScope', 'hold', 'release', 'withSendPermit']) {
    if (typeof gate[op] !== 'function') throw codedError(CODES.notSettled, `publishManagedScope needs the publication barrier (${op})`);
  }
  const want = scopeId(scope);
  if (!want) throw codedError(CODES.notSettled, 'publishManagedScope needs the table or dashboard scope it publishes');
  const owed = [];
  for (const { family, key } of groups || []) {
    const { committed, pending } = store.readGroup(family, key);
    if (pending) throw codedError(CODES.pending, `the managed ${family} "${key}" has a pending attempt`);
    const pub = committed && committed.publication;
    if (!pub || pub.state === 'not-needed' || pub.state === 'confirmed') continue;
    if (pub.state !== 'owed' || pub.dispatchToken !== null) throw codedError(PUBLICATION_UNCONFIRMED, `the publish of managed ${family} "${key}" may have been sent and is not confirmed; it is not sent again`);
    if (scopeId(pub.scope) !== want) throw codedError(CODES.notSettled, `the managed ${family} "${key}" is published in another scope`);
    owed.push({ family, key });
  }
  if (!owed.length) return { sent: false, withheld: false, confirmed: [] };
  const names = (list) => list.map((g) => `managed ${g.family} "${g.key}"`).join(', ');
  const isDebt = (o) => owed.some((d) => d.family === o.family && d.key === o.key);

  const cover = coverageOf(store, scope);
  if (cover.corrupt.length) {
    gate.blockScope(scope, `${names(cover.corrupt)} (its stored group is not usable)`);
    throw codedError(CODES.groupInvalid, `${names(cover.corrupt)} shares the publish of this scope and its stored group is not usable; nothing was published`);
  }
  if (cover.uncertain.length) {
    gate.blockScope(scope, `${names(cover.uncertain)} (its publish or workflow effect may have been sent and is not confirmed)`);
    throw codedError(PUBLICATION_UNCONFIRMED, `${names(cover.uncertain)} shares the publish of this scope and may have been sent unconfirmed; nothing was published`);
  }
  // A change is being made on the scope (its attempt holds it on the barrier, or will when this run reaches it).
  if (cover.pending.length) return { sent: false, withheld: true, confirmed: [] };

  const readAll = async (list) => {
    const out = [];
    for (const o of list) {
      let read;
      try { read = await readLayers(o.group); } catch (e) {
        throw codedError(PUBLICATION_UNVERIFIED, `the saved and published layers of managed ${o.family} "${o.key}" could not be read`, { cause: e });
      }
      if (!read || typeof read.publishedSha256 !== 'string' || typeof read.savedSha256 !== 'string') throw codedError(PUBLICATION_UNVERIFIED, `the layers of managed ${o.family} "${o.key}" answered no proof`);
      const desired = o.group.publication.desiredSha256;
      const savedEqual = typeof desired === 'string' && read.savedSha256 === desired;
      // Owed debt ships only its own saved layer. Anything else may stay as it is live, or be what it last desired.
      const safe = o.group.publication.state === 'owed' ? savedEqual : savedEqual || read.savedSha256 === read.publishedSha256;
      out.push({ ...o, publishedSha256: read.publishedSha256, equal: read.publishedSha256 === desired, safe });
    }
    return out;
  };

  let before;
  try {
    before = await readAll(cover.groups);
  } catch (e) {
    // Nothing is sent, but what is saved on the scope is not shown safe: no sibling may publish it either.
    gate.blockScope(scope, `${names(cover.groups)} (its layers could not be read before the publish)`);
    throw e;
  }
  const debt = before.filter(isDebt);
  const already = debt.filter((o) => o.equal);
  if (already.length) store.confirmPublished({ groups: already.map((o) => ({ family: o.family, key: o.key, publishedSha256: o.publishedSha256 })), token: null });
  const confirmedSoFar = () => already.map(({ family, key }) => ({ family, key }));
  const due = debt.filter((o) => !o.equal);
  if (!due.length) return { sent: false, withheld: false, confirmed: confirmedSoFar() };
  const drifted = before.filter((o) => !o.safe);
  if (drifted.length) {
    // A saved layer on the scope is not one the store proved: publishing would put someone else's change live.
    // Nothing is sent, the debt stays owed, and the scope is withheld for the run.
    gate.blockScope(scope, `${names(drifted)} (its saved layer is not the one the store proved)`);
    throw codedError(CODES.completion, `${names(drifted)} has a saved layer that is not the one its managed group proved; the publish of its ${want.replace(':', ' ')} was not sent`);
  }
  if (!gate.allowScope(scope, path)) return { sent: false, withheld: true, confirmed: confirmedSoFar() };

  const token = typeof newToken === 'function' ? newToken() : require('node:crypto').randomUUID();
  const covered = due.map(({ family, key }) => ({ family, key }));
  const label = names(covered);
  let dispatched = false;
  let withheld = false;
  let refused = false;
  let failure = null;
  // True only once the send's whole settlement is durably written: every debt confirmed, or the send recorded as
  // definitely not started. Until then a dispatched send leaves the scope blocked (see `finally`).
  let settled = false;
  gate.hold(token, [scope], cover.groups.map((o) => o.group.root.id), `${label} (its publish is being sent)`);
  try {
    try {
      await gate.withSendPermit({
        token,
        scope,
        // Durable at the send, after the barrier's last check: a failure to record it means the publish is not sent.
        onDispatch: () => { store.markPublishDispatch({ groups: covered, scope, token }); dispatched = true; },
        onWithheld: () => { withheld = true; },
        onRefused: () => { refused = true; },
      }, publish);
    } catch (e) {
      failure = e;
    }
    if (!dispatched) {
      if (withheld) return { sent: false, withheld: true, confirmed: confirmedSoFar() };
      if (refused) throw codedError(PUBLICATION_REFUSED, `the publish of ${label} named other publish targets than its ${want.replace(':', ' ')}; it was not sent`, failure ? { cause: failure } : undefined);
      if (failure) throw failure;
      // `publish()` finished without its request passing the permit: it was sent some other way, or not at all, and
      // nothing can show which. Fail closed, as for a lost answer.
      gate.blockScope(scope, `${label} (its publish was not sent through the barrier)`);
      store.markPublishDispatch({ groups: covered, scope, token });
      store.notePublishOutcome({ token, outcome: 'unconfirmed' });
      throw codedError(PUBLICATION_UNCONFIRMED, `the publish of ${label} did not pass the publication barrier, so whether it was sent is unknown`);
    }
    if (failure) {
      if (failure.definiteNoStart === true) {
        store.notePublishOutcome({ token, outcome: 'definite-no-start' });
        settled = true;
        throw codedError(failure.code || CODES.notSettled, `the publish of ${label} did not start`, { cause: failure });
      }
      gate.blockScope(scope, `${label} (its publish may have been sent and is not confirmed)`);
      store.notePublishOutcome({ token, outcome: 'unconfirmed' });
      throw codedError(PUBLICATION_UNCONFIRMED, `the publish of ${label} failed`, { cause: failure });
    }
    // A success answer is not proof the content is live: read it back. A read that fails or still differs leaves the
    // debt unconfirmed and the scope blocked, and it is never sent again.
    let after;
    try {
      after = await readAll(due);
    } catch (e) {
      gate.blockScope(scope, `${label} (its publish was sent and could not be read back)`);
      store.notePublishOutcome({ token, outcome: 'unconfirmed' });
      throw codedError(PUBLICATION_UNCONFIRMED, 'the publish was sent and its published layer could not be read back', { cause: e });
    }
    if (after.some((o) => !o.equal)) {
      gate.blockScope(scope, `${label} (its publish was sent and the published layer does not show it)`);
      store.notePublishOutcome({ token, outcome: 'unconfirmed' });
      throw codedError(PUBLICATION_UNCONFIRMED, 'the publish was sent and the published layer does not show what was owed');
    }
    // One atomic write confirms every debt of the send, so no run can see some of them confirmed and not the rest.
    store.confirmPublished({ groups: after.map((o) => ({ family: o.family, key: o.key, publishedSha256: o.publishedSha256 })), token });
    settled = true;
    return { sent: true, withheld: false, confirmed: [...already, ...after].map(({ family, key }) => ({ family, key })) };
  } finally {
    // Fail closed after a send: whatever threw — a confirmation, an outcome write, a read — the scope stays blocked for
    // the run unless the settlement above was written whole. The block is in memory, so it cannot fail the way the
    // store write did. Then only this publication's own hold ends; every block stays for the run.
    if (dispatched && !settled) gate.blockScope(scope, `${label} (its publish was sent and its outcome is not recorded)`);
    gate.release(token);
  }
}
module.exports = {
  PUBLICATION_UNVERIFIED,
  PUBLICATION_UNCONFIRMED,
  PUBLICATION_REFUSED,
  CREATION_RECORD_UNSETTLED,
  runManagedFeature,
  withWorkflowEffect,
  publishManagedScope,
};
