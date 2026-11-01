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
const { CODES } = require('./managed-bindings.js');

const PUBLICATION_UNVERIFIED = 'managed-publication-unverified';
const PUBLICATION_UNCONFIRMED = 'managed-publication-unconfirmed';
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
 *                               artifact may publish, registered before anything else;
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
  let token = null;
  let step = 'read';

  const stop = (err) => {
    const code = (err && err.code) || CODES.notSettled;
    const required = REQUIRED_STEPS.has(step) || code === CREATION_RECORD_UNSETTLED;
    try {
      if (required) barrier.quarantine(knownScopes, knownIds, `${label} (${code})`);
    } catch (e) {
      // A barrier that cannot quarantine leaves the scope as it is; the halt below still stops the build.
      err = Object.assign(err instanceof Error ? err : new Error(String(err)), { quarantineError: e });
    }
    const e = halt(phase, label, code, { cause: err });
    if (!(e instanceof Error)) throw codedError(CODES.notSettled, `${label} did not settle, and the halt factory made no error to stop the build with`, { cause: err });
    throw e;
  };

  try {
    barrier.registerKnown(knownScopes, knownIds);
    const { committed, pending } = store.readGroup(family, key);

    if (pending && pending.expected) {
      // Recovery: the change may already be on the server. Prove it by the expected proof it was sent with; never
      // send it again and never re-baseline from today's declaration.
      token = pending.token;
      barrier.hold(token, knownScopes, knownIds, `${label} (an earlier change is not yet proved)`);
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
    barrier.hold(token, knownScopes, knownIds, `${label} (a change is being saved and is not yet proved)`);
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

/**
 * Pay the owed publication of committed `groups` ([{ family, key }]) that share `scope`, at most once:
 *   - a group that owes nothing is skipped; an uncertain one (dispatching/unconfirmed) is never published again:
 *     `managed-publication-unconfirmed`; a pending attempt: `managed-settlement-pending`;
 *   - `readPublished(group)` answers { publishedSha256 } from a fresh read of the published layer; a failed read is
 *     `managed-publication-unverified`. Debt whose published layer already equals what is owed ends without a send;
 *   - a scope the barrier withholds is not sent and its debt stays owed;
 *   - otherwise every covered group is marked dispatching under one token, `publish()` sends the one request, and a
 *     fresh read confirms it. A send whose outcome is not proved stays unconfirmed: `managed-publication-unconfirmed`.
 * `publish()` may throw an error with `definiteNoStart: true` only when the request is known not to have started.
 * Answers { sent, withheld, confirmed: [{ family, key }] }.
 */
async function publishManagedScope({ store, barrier, scope, groups, readPublished, publish, path = 'managed publication', newToken } = {}) {
  if (!store || typeof readPublished !== 'function' || typeof publish !== 'function') throw codedError(CODES.notSettled, 'publishManagedScope needs the store, a published-layer reader and the publish');
  const gate = barrier || store;
  const owed = [];
  for (const { family, key } of groups || []) {
    const { committed, pending } = store.readGroup(family, key);
    if (pending) throw codedError(CODES.pending, `the managed ${family} "${key}" has a pending attempt`);
    const pub = committed && committed.publication;
    if (!pub || pub.state === 'not-needed' || pub.state === 'confirmed') continue;
    if (pub.state !== 'owed' || pub.dispatchToken !== null) throw codedError(PUBLICATION_UNCONFIRMED, `the publish of managed ${family} "${key}" may have been sent and is not confirmed; it is not sent again`);
    owed.push({ family, key, group: committed });
  }
  if (!owed.length) return { sent: false, withheld: false, confirmed: [] };

  const readAll = async () => {
    const out = [];
    for (const o of owed) {
      let read;
      try { read = await readPublished(o.group); } catch (e) {
        throw codedError(PUBLICATION_UNVERIFIED, `the published layer of managed ${o.family} "${o.key}" could not be read`, { cause: e });
      }
      if (!read || typeof read.publishedSha256 !== 'string') throw codedError(PUBLICATION_UNVERIFIED, `the published layer of managed ${o.family} "${o.key}" answered no proof`);
      out.push({ ...o, publishedSha256: read.publishedSha256, equal: read.publishedSha256 === o.group.publication.desiredSha256 });
    }
    return out;
  };

  const before = await readAll();
  const already = before.filter((o) => o.equal);
  for (const o of already) store.confirmPublished({ groups: [{ family: o.family, key: o.key }], token: null, proof: { publishedSha256: o.publishedSha256 } });
  const due = before.filter((o) => !o.equal);
  if (!due.length) return { sent: false, withheld: false, confirmed: already.map(({ family, key }) => ({ family, key })) };
  if (!gate.allowScope || !gate.allowScope(scope, path)) return { sent: false, withheld: true, confirmed: already.map(({ family, key }) => ({ family, key })) };

  const token = typeof newToken === 'function' ? newToken() : require('node:crypto').randomUUID();
  const covered = due.map(({ family, key }) => ({ family, key }));
  // Durable before the send: a failure to record the dispatch means the publish is not sent.
  store.markPublishDispatch({ groups: covered, scope, token });
  try {
    await publish();
  } catch (e) {
    store.notePublishOutcome({ token, outcome: e && e.definiteNoStart === true ? 'definite-no-start' : 'unconfirmed' });
    throw codedError(e && e.definiteNoStart === true ? (e.code || CODES.notSettled) : PUBLICATION_UNCONFIRMED, `the publish of ${covered.map((g) => `managed ${g.family} "${g.key}"`).join(', ')} failed`, { cause: e });
  }
  // A success answer is not proof the content is live: read it back. A read that fails or still differs leaves the
  // debt unconfirmed, and it is never sent again.
  let after;
  try {
    owed.splice(0, owed.length, ...due);
    after = await readAll();
  } catch (e) {
    store.notePublishOutcome({ token, outcome: 'unconfirmed' });
    throw codedError(PUBLICATION_UNCONFIRMED, 'the publish was sent and its published layer could not be read back', { cause: e });
  }
  if (after.some((o) => !o.equal)) {
    store.notePublishOutcome({ token, outcome: 'unconfirmed' });
    throw codedError(PUBLICATION_UNCONFIRMED, 'the publish was sent and the published layer does not show what was owed');
  }
  for (const o of after) store.confirmPublished({ groups: [{ family: o.family, key: o.key }], token, proof: { publishedSha256: o.publishedSha256 } });
  return { sent: true, withheld: false, confirmed: [...already, ...after].map(({ family, key }) => ({ family, key })) };
}

module.exports = {
  PUBLICATION_UNVERIFIED,
  PUBLICATION_UNCONFIRMED,
  CREATION_RECORD_UNSETTLED,
  runManagedFeature,
  withWorkflowEffect,
  publishManagedScope,
};
