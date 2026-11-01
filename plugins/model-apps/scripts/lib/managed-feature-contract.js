'use strict';

// managed-feature-contract.js — the one settlement path of a declared form, dashboard, business rule or process flow.
//
// A managed artifact is a group: a root row plus children (form controls, dashboard tiles, rule slots, process
// stages) whose ids the store binds together. The shipped single-record path (reconcile-common.js
// createFeatureSettlement) records bindings one at a time, so a crash between two records leaves the old root bound
// with only some of its new children — and a crash after the remote write but before any record leaves nothing that
// says what was sent. runManagedFeature closes both:
//   1. register the artifact's scopes and ids with the publication barrier (not a block), and run the feature's
//      preflight — on every path, recovery included;
//   2. resolve and plan; a proved no-op ensures membership and changes nothing else;
//   3. persist an attempt (prepareAttempt, with the original declaration it commits beside the feature's state) and
//      hold its scopes under the attempt's token, then persist the complete expected proof (markSending) BEFORE the
//      one push — a failed store write means the push is not sent; neither write is made over a publish of the group
//      that may have been sent;
//   4. apply the change once, prove it from a fresh read against the stored expected proof (never against today's
//      declaration), require adoption approval for a root whose create was never acknowledged, ensure solution
//      membership, and commit the whole group in one atomic store write;
//   5. release only this attempt's hold.
// A pending attempt found on disk is recovered (recoverManagedAttempt) by its stored expected proof, without sending
// again — except an attempt whose durable send window proves none of its mutations was carried out (sent through a
// send observer, createAttemptSendObserver), which continues under its own token, and a create the feature shows was
// never made (`resumeCreate`), which is sent again under its own token and ids.
// A prepared attempt that never reached markSending, met by a no-op plan, is retired (retireUnsentAttempt).
// A required failure (preflight, resolve, plan, proof, adoption consent, membership, an unsettled dashboard creation
// record) quarantines the artifact's scopes for the rest of the invocation; any other failure keeps the hold. Either
// way the attempt stays on disk, the bindings do not advance, and the build stops with the halt the caller's factory
// makes.
//
// Nothing calls this module until a declared form, dashboard, rule or process flow is wired to it.

const { runWithWorkflowEffect } = require('./workflow-effect-context.js');
const { CODES, classifyPersisted, attemptProvenUnsent, resumableCreate, checkDeclaration, rootCreateAcknowledged } = require('./managed-bindings.js');
const { canonicalJson } = require('./reconcile-common.js');
const { LAYER_READERS } = require('./managed-layer-readers.js');

const PUBLICATION_UNVERIFIED = 'managed-publication-unverified';
const PUBLICATION_UNCONFIRMED = 'managed-publication-unconfirmed';
// A managed publish whose request named other publish targets than its one scope: refused unsent, debt still owed.
const PUBLICATION_REFUSED = 'managed-publication-refused';
// A group published in the scope whose family has no layer reader (lib/managed-layer-readers.js): the scope is fenced.
const LAYER_READER_MISSING = 'managed-publication-reader-missing';
const CREATION_RECORD_UNSETTLED = 'dashboard-creation-record-unsettled';
// The workflow features' refusal of an edit of an existing workflow while their edit switch is off.
const WORKFLOW_EDIT_REFUSED = 'workflow-edit-refused';
// A publication that may have been sent and is not yet proved live (lib/managed-bindings.js UNCERTAIN).
const UNCERTAIN_PUBLICATION = new Set(['dispatching', 'unconfirmed']);

function codedError(code, message, extra) {
  return Object.assign(new Error(message), { code }, extra || {});
}

// A step whose failure means the artifact's saved state is not shown safe: its scopes stay withheld for the run.
const REQUIRED_STEPS = new Set(['preflight', 'resolve', 'plan', 'prove', 'membership', 'resume', 'adopt', 'publication']);

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
 *   preflight({ committed, pending, recovering, effects })  required: the feature's own safety checks, run on EVERY
 *                               path — an ordinary run, a prepared attempt, and every recovery (prove, continue,
 *                               resume) — before resolve, prove or any continuation, and before anything is prepared or
 *                               sent. `committed` is the group as this run first read it, BEFORE any earlier
 *                               uncertain publish is confirmed (resolve and plan see that same read); a recovery is
 *                               then given the group as it stands after that confirmation. `recovering` is true when
 *                               `pending` was marked sending (its scopes are already held); `pending.declaration` is
 *                               the declaration it recorded, if any; `effects` are the workflow effects the store holds
 *                               for the group (the pending attempt's among them: existingRowDispatches reads them —
 *                               an early refusal only; every newly proposed workflow write is checked again by
 *                               editSwitchRequired).
 *                               It must not fetch into, overwrite or delete the local copy. It refuses by throwing
 *                               (its own code, e.g. `create-completion-required` with category
 *                               `workspace-copy-unsent-edits`): quarantined, the attempt and its token kept, nothing
 *                               written. A feature without one is refused (`managed-not-settled`) before anything;
 *   client?, readers?           a Dataverse client and the layer readers (default: the shared LAYER_READERS). A committed
 *                               group whose publication may have been sent and is not proved live is never committed
 *                               again over it: with `client`, that dispatch is first confirmed read-only
 *                               (confirmUncertainPublication), before anything is prepared or sent; without it, or when
 *                               the read does not prove it, `managed-publication-unconfirmed`, quarantined, nothing
 *                               prepared or sent and any attempt kept. A publish dispatched AFTER this run read the
 *                               group (by another process, while preflight, resolve or plan was awaited) is met by the
 *                               store under its lease at prepareAttempt or at the send claim (markSending) with the
 *                               same code and the same stop. A confirmation never lifts a quarantine this run already
 *                               set (it lasts for the invocation), and debt the confirmation leaves owed may need the
 *                               next invocation to publish;
 *   adoptionApproved?           boolean, `true` only when the feature's own typed adoption approval
 *                               (`<family>:<key>`) covers this artifact; never inferred here. A group not yet committed
 *                               whose root create this attempt never had acknowledged is bound only with it; otherwise
 *                               `managed-adoption-required` before membership, quarantined, the attempt kept, no
 *                               binding. An acknowledged create needs none and commits as created;
 *   resolve({ committed, pending, resuming?, continuing? })   read and preflight; answers the resolution;
 *   plan({ resolution, committed, resuming?, continuing? })   answers { noop: true } or { root, expected,
 *                                        declarationSha256, declaration?, publication? } (publication: the attempt's
 *                                        { scope, state: 'owed' } or null; declaration: the ORIGINAL authored input as
 *                                        a plain JSON object, for form, dashboard, rule and bpf — checked first
 *                                        (checkDeclaration; an unsafe one is `managed-declaration-refused`, nothing
 *                                        written, retired or sent, any prepared attempt and its hold kept), persisted
 *                                        with the attempt before anything is sent, and committed as the group's
 *                                        `originalDeclaration`, beside the feature's `consumerState`, which is kept
 *                                        exactly as prove answers it (a flow's applied state and backing, a rule's
 *                                        node history stay the feature's own). A prepared attempt whose recorded
 *                                        root, declaration hash, declaration or publication differ from the plan is
 *                                        replaced in one store write (prepareAttempt `replaces`); a continued or
 *                                        resumed attempt that recorded a declaration is sent only for that one);
 *   apply({ token, plan, resolution, resuming?, continuing? })  send the approved change once; answers what it sent.
 *                               With a sendObserver, every mutation it makes must go through the observed transport;
 *   prove({ token, expected, applied, recovering, declaration })  a fresh read against `expected`; answers { savedProof,
 *                               acknowledgedRoot, acknowledgedChildCreates?, records, proof, consumerState,
 *                               publication, proofSchema? }. `acknowledgedRoot` is true only when this send's answer
 *                               acknowledged the CREATE of this attempt's root, never for an answer to an edit of an
 *                               existing row (the store refuses it when the expected proof records a base
 *                               observation). `acknowledgedChildCreates` ([{ kind, key, id }]) is the child-create
 *                               receipt: the children this attempt reserved as new, sent, and proved after this
 *                               acknowledged write — each named under that id by the expected proof, never the root,
 *                               never a child observed already there. Both are recorded on the attempt (noteSaved)
 *                               before the commit; a recovery uses only what the original attempt recorded, never
 *                               what a later prove answers. Records may say `origin: 'created'` only for the
 *                               acknowledged root create or a receipted child; a receipt never stands in for the
 *                               root's adoption approval and grants no deletion.
 *                               `declaration` is the one the attempt recorded (on recovery always the attempt's, never
 *                               today's spec; undefined when it recorded none — then, on a send, the plan's). It is
 *                               the authored input to compare against; the answered consumerState is the feature's
 *                               own derived state and is committed as answered;
 *   ensureMembership({ root, records, recovering })  solution membership, for a clean reused root too;
 *   sendObserver?               the build's createAttemptSendObserver, already wrapped around its transport (refused
 *                               otherwise). markSending then arms the attempt's send window and `apply` runs inside it,
 *                               so an attempt whose window shows nothing carried out (a local failure before any
 *                               request, or only not-started rejections answered while the window was open) is
 *                               continued by the next run under the same token: resolve and plan with
 *                               `continuing: true`, the same plan required, then a claim on the attempt's sends against
 *                               the record reread under the store's lease (markSending `claim`, a new epoch that fences
 *                               any older run at its next send), then `apply` with `continuing: true`. The window
 *                               closes when `apply` settles and keeps counting (trailing) until the attempt is
 *                               committed. Without it, recovery is as before;
 *   resumeCreate?({ token, pending, expected })  optional, for a family whose create names its root id: read the
 *                               pending root by that stable id in BOTH layers and answer { root: 'absent' } only when
 *                               each layer says the row does not exist, { root: 'present' } when either has it, and
 *                               throw for any other answer. Asked only for a pending create that no answer
 *                               acknowledged (resumableCreate). Present: recovered by `prove` as any pending attempt.
 *                               Absent: resolve and plan run again with `resuming: true`, the plan must equal what
 *                               the attempt recorded (root, expected proof, declaration hash, publication; otherwise
 *                               `create-completion-required`), and `apply` sends the same create under the same token.
 *                               Its failure, or any other answer, quarantines like a failed proof.
 * A pending attempt still `prepared` (never marked sending) met by a no-op plan is retired with
 * store.retireUnsentAttempt and its hold ends; a store that refuses it stops the build with the hold kept.
 * Answers { result, committedGroup }: result is { noop: true } or { committed: true, recovered, resumed?, continued? }.
 */
async function runManagedFeature(args) {
  const { phase, family, key, knownScopes = [], knownIds = [], store, halt, preflight, resolve, plan, apply, prove, ensureMembership } = args || {};
  // The factory is checked before any side effect: a wrapper that could not stop the build must not start it.
  if (typeof halt !== 'function') throw codedError(CODES.notSettled, 'runManagedFeature needs the build\'s halt factory');
  // preflight is required for the same reason: a feature whose own safety checks (a dirty local copy, a retained
  // creation id, an edit switch) did not run on a recovery would let a pending token stand in for them.
  for (const [name, fn] of Object.entries({ preflight, resolve, plan, apply, prove, ensureMembership })) {
    if (typeof fn !== 'function') throw codedError(CODES.notSettled, `runManagedFeature needs ${name}`);
  }
  if ('adoptionApproved' in args && typeof args.adoptionApproved !== 'boolean') throw codedError(CODES.notSettled, 'runManagedFeature takes adoptionApproved only as a boolean the feature derives from its own adoption approval');
  const adoptionApproved = args.adoptionApproved === true;
  if (!store || typeof store.readGroup !== 'function') throw codedError(CODES.notSettled, 'runManagedFeature needs the managed binding store');
  // A send observer that is not on the transport would arm windows nothing counts in, and an unsent-looking window is
  // what lets a later run send again: refuse it before anything is read or written.
  const observer = args.sendObserver || null;
  if (observer && (typeof observer.open !== 'function' || observer.installed !== true || typeof store.noteAttemptDispatch !== 'function')) {
    throw codedError(CODES.notSettled, 'runManagedFeature was given a send observer that is not installed on the build\'s transport');
  }
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
    // A publish that may have been sent, met by the store under its lease at prepare or at the send claim, is the same
    // stop as one met before (settleEarlierPublication): the artifact's saved state is not shown safe to publish.
    const required = REQUIRED_STEPS.has(step) || code === CREATION_RECORD_UNSETTLED || code === PUBLICATION_UNCONFIRMED;
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
    const { committed, pending, effects } = store.readGroup(family, key);
    addIds([committed && committed.root && committed.root.id, pending && pending.root && pending.root.id]);
    const recovering = !!(pending && pending.expected);
    if (recovering) {
      token = pending.token;
      barrier.hold(token, scopes, ids, `${label} (an earlier change is not yet proved)`);
    }
    // The feature's own checks, on every path and before anything it reads into its workspace or sends: a refusal is a
    // required failure (quarantined) that keeps any attempt and its token, and nothing has been written yet.
    step = 'preflight';
    await preflight({ committed, pending, recovering, effects });
    if (recovering) return await recoverManagedAttempt(await settleEarlierPublication(committed), pending, effects);

    step = 'resolve';
    const resolution = await resolve({ committed, pending });
    step = 'plan';
    const planned = await plan({ resolution, committed });
    if (!planned || planned.noop === true) {
      if (pending) {
        // A prepared attempt that never reached markSending sent nothing, and the plan says nothing is to be sent:
        // retire it (the store refuses anything that may have started) and end its hold, then settle as a no-op.
        step = 'retire';
        store.retireUnsentAttempt({ token: pending.token, baseGeneration: pending.baseGeneration });
        barrier.release(pending.token);
      }
      step = 'membership';
      await ensureMembership({ root: committed ? committed.root : null, records: committed ? committed.records : [], recovering: false });
      return { result: { noop: true }, committedGroup: committed };
    }

    await settleEarlierPublication(committed);
    step = 'prepare';
    addIds([planned.root && planned.root.id]);
    // The declaration is checked before anything changes — before a prepared attempt is replaced or its hold ends — and
    // only its plain-data snapshot is compared and stored from here on, so a refusal keeps the old bytes, token and hold.
    const intent = planned.declaration !== undefined ? { ...planned, declaration: checkDeclaration(family, key, planned.declaration) } : planned;
    let baseGeneration = pending ? pending.baseGeneration : committed ? committed.generation : null;
    if (pending && samePreparedIntent(intent, pending)) {
      // A prepared attempt that was never sent is intent only: it is resumed under its own token.
      token = pending.token;
    } else {
      // A prepared attempt records the intent it was planned with (root, declaration and its hash, publication) and
      // sent nothing. A plan that now says something else is a new change: the old intent is retired, never sent
      // under — its recorded declaration would otherwise be what the new change commits — in the same store write
      // that prepares the fresh one (`replaces`), so a refusal of either leaves the old attempt, its token and its
      // hold as they were. Store-side, under the lease: refused (`managed-publication-unconfirmed`) over a publish
      // dispatched since the group was read — nothing written.
      if (pending) baseGeneration = committed ? committed.generation : null;
      token = store.prepareAttempt({
        family, key, baseGeneration, root: intent.root, expected: null, knownScopes, declarationSha256: intent.declarationSha256,
        ...(intent.declaration !== undefined ? { declaration: intent.declaration } : {}),
        publication: intent.publication || null,
        ...(pending ? { replaces: { token: pending.token, baseGeneration: pending.baseGeneration } } : {}),
      });
      // The store ended the old hold after its write when it has the barrier; a barrier passed apart is released here.
      if (pending) barrier.release(pending.token);
    }
    barrier.hold(token, scopes, ids, `${label} (a change is being saved and is not yet proved)`);
    const group = await send(intent, resolution, baseGeneration);
    return { result: { committed: true, recovered: false }, committedGroup: group };
  } catch (err) {
    return stop(err);
  }

  // recoverManagedAttempt (the recovery step): an attempt on disk that was marked sending, met before any
  // ordinary planning. The same-token continuation contract, in this order:
  //   1. its send window proves no mutation of it was carried out (attemptProvenUnsent: observed from markSending on,
  //      every counted mutation answered by a not-started rejection, every owned workflow effect unsent) and this run
  //      observes its sends too: resolve and plan again with `continuing: true` — the feature's preflight, the dirty-copy
  //      refusal included, runs as on any run — and the plan must be exactly what the attempt recorded (same root and ids,
  //      the same expected proof, so the same recorded base; the same declaration hash and publication). Then send it
  //      under the same token, through a new observed window, once the store has checked the zero again under its
  //      lease and moved the window to a new epoch (markSending claim 'continue'): a run whose zero went stale is
  //      refused there, and an older claimant at its next send;
  //   2. a create no answer acknowledged, whose root the feature reads absent in both layers by its stable id
  //      (resumeCreate): resolve, plan and check the same way with `resuming: true`, and send the same create again
  //      under the same token and ids — a delayed first create can then only fail on the primary key;
  //   3. anything else may have been carried out: prove it by the expected proof it was sent with, from a fresh read,
  //      and commit only what that proves. Never sent again, never re-baselined from today's declaration.
  // A plan that differs stops the build before anything is sent (`create-completion-required`, quarantined): a new
  // change is never made under an old token, no root is minted, and the attempt is kept as it was.
  async function recoverManagedAttempt(committed, pending, effects) {
    if (observer && attemptProvenUnsent(pending, effects)) {
      const out = await sendAgain(committed, pending, 'continuing', 'was declared differently since its change was prepared; it is not sent');
      return { result: { committed: true, recovered: true, continued: true }, committedGroup: out };
    }
    if (typeof args.resumeCreate === 'function' && resumableCreate(committed, pending, effects)) {
      step = 'resume';
      const seen = await args.resumeCreate({ token, pending, expected: pending.expected });
      const root = seen && seen.root;
      if (root !== 'absent' && root !== 'present') throw codedError(CODES.notSettled, `${label}: resumeCreate answered neither "absent" nor "present" for its root`);
      if (root === 'absent') {
        const out = await sendAgain(committed, pending, 'resuming', 'was declared differently since its create was sent; it is not resent');
        return { result: { committed: true, recovered: true, resumed: true }, committedGroup: out };
      }
      // Present: prove or adopt it, exactly as any recovery.
    }
    step = 'prove';
    const proved = await prove({ token, expected: pending.expected, applied: null, recovering: true, declaration: pending.declaration });
    requireAdoptionConsent(!!committed);
    step = 'membership';
    await ensureMembership({ root: pending.root, records: proved.records, recovering: true });
    step = 'commit';
    const group = commit(store, token, pending.baseGeneration, proved, adoptionApproved);
    barrier.release(token);
    return { result: { committed: true, recovered: true }, committedGroup: group };
  }

  // Resolve and plan again under `flag` ('continuing' / 'resuming'), require the plan the attempt recorded, send it.
  async function sendAgain(committed, pending, flag, differs) {
    // The attempt was planned against the committed generation it recorded; anything else committed since is a
    // different base, and the change is not sent over it.
    step = 'resolve';
    if ((committed ? committed.generation : null) !== pending.baseGeneration) throw codedError(CODES.completion, `${label} was committed again since its change was prepared; it is not sent`);
    const resolution = await resolve({ committed, pending, [flag]: true });
    step = 'plan';
    const planned = await plan({ resolution, committed, [flag]: true });
    if (!samePlan(planned, pending)) throw codedError(CODES.completion, `${label} ${differs}`);
    return send(planned, resolution, pending.baseGeneration, flag);
  }

  // Persist the expected proof, send once, prove from a fresh read, ensure membership, commit, end the hold. With a send
  // observer, markSending arms the attempt's send window and `apply` runs inside it: every mutation that reaches the
  // transport is counted on the attempt before it leaves, so a later run can tell a send that never left from one that
  // may have landed (recoverManagedAttempt).
  async function send(planned, resolution, baseGeneration, flag = null) {
    step = 'send';
    // The claim on the attempt's sends, made against the record the store rereads under its lease: a second run on the
    // same attempt, or one whose zero went stale while it resolved and planned, is refused here, before anything leaves.
    const claim = flag === 'continuing' ? 'continue' : flag === 'resuming' ? 'resume' : 'first';
    const marked = store.markSending(token, planned.expected, { observed: !!observer, claim });
    // The declaration the attempt recorded before this send (prepareAttempt), as the store now holds it: the one prove
    // is given (the store commits it as the group's originalDeclaration). An attempt an earlier build prepared recorded
    // none; prove is then given the plan's.
    const held = store.readGroup(family, key).pending;
    const recorded = held && held.token === token ? held.declaration : undefined;
    const window = observer ? observer.open(store, token, marked && marked.epoch !== undefined ? marked.epoch : null) : null;
    let applied;
    try {
      applied = await apply({ token, plan: planned, resolution, ...(flag ? { [flag]: true } : {}) });
    } finally {
      // Trailing, not ended: a request `apply` left in flight, or a re-send of one, is still counted on the attempt.
      if (window) window.close();
    }
    step = 'prove';
    const proved = await prove({ token, expected: planned.expected, applied, recovering: false, declaration: recorded !== undefined ? recorded : planned.declaration });
    step = 'saved';
    store.noteSaved(token, {
      proof: proved.savedProof === undefined ? null : proved.savedProof,
      acknowledgedRoot: proved.acknowledgedRoot === true,
      acknowledgedChildCreates: proved.acknowledgedChildCreates === undefined ? [] : proved.acknowledgedChildCreates,
    });
    requireAdoptionConsent(baseGeneration !== null);
    step = 'membership';
    await ensureMembership({ root: planned.root, records: proved.records, recovering: false });
    step = 'commit';
    const group = commit(store, token, baseGeneration, proved, adoptionApproved);
    // The attempt is gone from the store: nothing of it is left to count.
    if (window) window.end();
    barrier.release(token);
    return group;
  }

  // A committed group whose publish may have been sent and is not proved live is never committed again over it (the
  // store refuses that too: commitGroup): a later read of the old dispatch's layer would otherwise settle the new
  // generation's debt. With a client, the dispatch is confirmed read-only first; anything else stops before anything
  // is prepared or sent. Answers the group as it now stands.
  async function settleEarlierPublication(committed) {
    const pub = committed && committed.publication;
    if (!pub || !UNCERTAIN_PUBLICATION.has(pub.state)) return committed;
    step = 'publication';
    // A dispatch made only of CARRIED groups (publishManagedScope: each owed nothing and was already live at its desired
    // hash when the scope's publish was sent) cannot be shown ended by a read: the read was true before the send too.
    // It is still confirmed read-only here, but no change is made over it in the run that confirms it, so a request
    // whose answer was lost is not raced by an edit of the layer it would put live. A dispatch that paid any debt is
    // shown applied by the read of that debt, which was not live before it.
    const onlyCarried = pub.carriedFrom !== undefined && store.snapshot().units().every((u) => {
      const p = !u.invalid && u.group && u.group.publication;
      return !p || p.dispatchToken !== pub.dispatchToken || !UNCERTAIN_PUBLICATION.has(p.state) || p.carriedFrom !== undefined;
    });
    if (args.client) {
      await confirmUncertainPublication({ store, barrier, scope: pub.scope, client: args.client, readers: args.readers || LAYER_READERS });
      const now = store.readGroup(family, key).committed;
      if (!now || now.generation !== committed.generation) throw codedError(CODES.conflict, `${label} was committed again while its earlier publish was being confirmed`);
      if (!(now.publication && UNCERTAIN_PUBLICATION.has(now.publication.state))) {
        if (onlyCarried) throw codedError(PUBLICATION_UNCONFIRMED, `${label} was carried by a publish of its scope whose answer was lost; a fresh read confirmed it, but its layer was live before that publish too, so no change is made over it until the next run`);
        return now;
      }
    }
    throw codedError(PUBLICATION_UNCONFIRMED, `${label} has a publish that may have been sent and is not proved live; no change is made over it until a fresh read confirms it`);
  }

  // Adoption consent, before membership exposes the root and before the commit binds it: a group not yet committed
  // whose root create this attempt never had acknowledged (durably: noteSaved, or the attempt record) is bound only
  // with the feature's own typed adoption approval. A proof shows what the row is, not that the maker agreed to manage
  // it. The store refuses the same commit without the flag (commitGroup), so this is the early, write-free stop.
  function requireAdoptionConsent(alreadyCommitted) {
    step = 'adopt';
    if (alreadyCommitted || adoptionApproved) return;
    const { pending: a } = store.readGroup(family, key);
    if (!a || a.token !== token) throw codedError(CODES.notSettled, `${label}: its attempt is no longer on disk`);
    // A child-create receipt is not this: it never acknowledges the root.
    if (rootCreateAcknowledged(a)) return;
    throw codedError(CODES.adoptionRequired, `${label} was proved on the service, but its create was never acknowledged; binding it needs its adoption approval (${family}:${key})`);
  }
}

/**
 * The rows the pending attempt has positive evidence that it created itself: a create effect it owns that a fresh read
 * confirmed, or its own root when an answer acknowledged that create (the attempt's `acknowledgedRoot`, or its saved
 * observation's). Nothing else is that evidence: no committed group, a null base generation, an expected proof with no
 * base, or a create effect that is unsent, dispatching or unconfirmed say only that no binding exists yet — the row may
 * be an existing one the attempt adopted. Answers lowercased row ids.
 */
function rowsCreatedByAttempt({ pending, effects } = {}) {
  const out = new Set();
  if (!pending) return out;
  for (const e of effects || []) {
    if (e.attemptToken === pending.token && e.effect === 'create' && e.state === 'confirmed') out.add(String(e.rowId).toLowerCase());
  }
  if (pending.root && rootCreateAcknowledged(pending)) out.add(String(pending.root.id).toLowerCase());
  return out;
}

/**
 * Whether `proposed` is the attempt's own Draft → Active completion as far as the store can tell, before any fresh
 * read: a state effect to 'Active' of the pending attempt (its token) on a row the attempt has positive evidence of
 * having created (rowsCreatedByAttempt).
 */
function ownActivationCandidate({ pending, effects } = {}, proposed) {
  return proposed.effect === 'state' && proposed.desiredState === 'Active'
    && !!pending && proposed.attemptToken === pending.token
    && rowsCreatedByAttempt({ pending, effects }).has(String(proposed.rowId).toLowerCase());
}

/**
 * Whether sending `proposed` — a workflow effect this run is about to record and send ({ attemptToken, rowId, effect:
 * 'create' | 'body' | 'state', desiredState?, ... }) — needs the workflow edit switch (`workflowConditionalEdits`):
 *   create  false: a new row is not an edit;
 *   body    true, always: a body write changes a row's logic, even of a Draft this attempt created;
 *   state   false only for the attempt's own Draft → Active completion: `proposed` is the pending attempt's (its token),
 *           sets 'Active', its row is one the attempt has positive evidence of having created (rowsCreatedByAttempt),
 *           AND `observedState` — the row's state from the feature's own fresh read, made after this attempt's create
 *           and before this dispatch — is 'Draft'. True for every other transition: a deactivation (to 'Draft') or any
 *           other state, an activation of a row already Active or in any other state, one without a fresh read
 *           (`observedState` omitted), with no pending attempt, and another attempt's effect;
 *   anything else  true.
 * `group` is the store's readGroup(family, key) ({ pending, effects }). A workflow feature whose switch is off checks
 * this before EVERY body or state dispatch it newly proposes — on an ordinary run, a continued or resumed attempt and a
 * recovery alike — and refuses (`workflow-edit-refused`) before it records or sends anything; withWorkflowEffect makes
 * the same check when given `workflowConditionalEdits: false` and passes it `observedState`. The preflight's
 * existingRowDispatches is an early refusal on top of it, not a substitute: an effect first proposed inside recovery is
 * not on disk when preflight runs.
 */
function editSwitchRequired(group, proposed, { observedState } = {}) {
  if (!proposed || typeof proposed !== 'object') throw codedError(CODES.notSettled, 'editSwitchRequired needs the proposed workflow effect');
  if (proposed.effect === 'create') return false;
  return !(ownActivationCandidate(group || {}, proposed) && observedState === 'Draft');
}

/**
 * The body and state effects the pending attempt has recorded and still has to send (definitely-unsent, no dispatch
 * token) that need the edit switch whatever a fresh read shows: every body write, and every state write that is not
 * the attempt's own activation of a row it created (ownActivationCandidate). A workflow feature (rules, process flows)
 * whose edit switch is off refuses in its preflight when this is not empty — an early refusal of what is already on
 * disk. An own activation it does not list still needs the fresh `observedState: 'Draft'` at its dispatch
 * (editSwitchRequired), and this list does not show that the run stays read-only: an effect first proposed later
 * (inside recovery, say) is checked by editSwitchRequired before it is recorded. An effect that may already have been
 * dispatched is not listed — it is proved, never sent again.
 */
function existingRowDispatches({ pending, effects } = {}) {
  if (!pending) return [];
  return (effects || []).filter((e) => e.attemptToken === pending.token && (e.effect === 'body' || e.effect === 'state')
    && e.state === 'definitely-unsent' && e.dispatchToken === null && !ownActivationCandidate({ pending, effects }, e));
}

// The answers that say the service did not carry the request out, so a mutation answered with one is not counted as
// possibly applied (createAttemptSendObserver). Narrow on purpose: everything else — a success, a 5xx or 429 (a gateway
// or a lock may answer in front of a write that ran; the client's publish rule measured exactly that), a 408, a lost or
// cut-off answer, any answer to a `$batch` — leaves the mutation possibly applied. So does an answer the client itself
// answers by sending again (lib/sdk-http-client.js: a 401 is re-sent with a fresh token, 429/500/502/503/504 on its
// transient schedule): that answer ends nothing, because the logical operation it belongs to is still dispatching.
//   412 to an `If-Match` request  the precondition was false, so the method was not applied (RFC 9110 §13.1.1, §15.5.13;
//                                https://learn.microsoft.com/power-apps/developer/data-platform/webapi/perform-conditional-operations-using-web-api);
//   400, 403, 404, 412           only with a Dataverse error in the body, `{ "error": { "code": "0x80040203", … } }`, so
//                                the platform itself refused the one operation (an intermediary answers no Dataverse
//                                code), and a single Dataverse operation that fails is rolled back whole
//                                (https://learn.microsoft.com/power-apps/developer/data-platform/event-framework).
// None of these is re-sent by the client or by the retry policy (lib/retry-policy.js: a 400, 403, 404 or 412 is a
// verdict); a layer that sends again anyway is counted again (createAttemptSendObserver).
const NOT_STARTED_WITH_CODE = new Set([400, 403, 404, 412]);
const DATAVERSE_ERROR_CODE = /^0x[0-9a-f]{8}$/i;

function headerOf(headers, name) {
  for (const [k, v] of Object.entries(headers || {})) if (k.toLowerCase() === name) return v;
  return undefined;
}

function dataverseErrorCode(body) {
  let parsed = body;
  try {
    if (Buffer.isBuffer(body)) parsed = JSON.parse(body.toString('utf8'));
    else if (typeof body === 'string') parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const code = parsed && typeof parsed === 'object' && parsed.error && typeof parsed.error === 'object' ? parsed.error.code : null;
  return typeof code === 'string' && DATAVERSE_ERROR_CODE.test(code) ? code : null;
}

// The operation path a request names, as the service resolves it: the URL's path percent-decoded once. `/%24batch` is
// `/$batch` there (a URL parser or proxy in front of the service may decode it), so the spelling of the URL must not decide
// whether an answer is one operation's. Answers null — so no answer of it ends anything — for a URL that does not parse,
// a malformed escape (`%zz`, a lone `%`), or a `%` still left after the decoding (`%2524batch`: whether another layer
// decodes it again is not known here).
function canonicalOperationPath(url) {
  let raw;
  try { raw = new URL(url).pathname; } catch { return null; }
  let decoded;
  try { decoded = decodeURIComponent(raw); } catch { return null; }
  return decoded.includes('%') ? null : decoded;
}

function notStartedAnswer(req, res) {
  if (!res || res.error || res.incompleteResponse || !Number.isInteger(res.statusCode)) return false;
  const path = canonicalOperationPath(req && req.url);
  // A `$batch` anywhere in the path: its answer is not one rolled-back operation's.
  if (path === null || /\$batch/i.test(path)) return false;
  if (res.statusCode === 412 && headerOf(req.headers, 'if-match') !== undefined) return true;
  return NOT_STARTED_WITH_CODE.has(res.statusCode) && dataverseErrorCode(res.body) !== null;
}

/**
 * The send observer of managed attempts: the build's transport, wrapped so that a mutation sent while an attempt's
 * window is open is recorded on that attempt before it leaves (recoverManagedAttempt reads the record). Install it
 * INSIDE the publication barrier's gate, so a request the barrier answers itself is never counted:
 *   createAzHttpClient(env, { request: barrier.gateRequest(observer.wrap()) })     (wrap() defaults to makeRequest)
 * and give the same observer to runManagedFeature (`sendObserver`). With no window, every request passes untouched.
 * A read (GET, HEAD) always passes; any other request — a `$batch` of reads included — is counted on EVERY window
 * (store.noteAttemptDispatch, synchronous and durable, under the window's epoch; a throw leaves it unsent) and sent once
 * by this layer. The window covers the whole logical operation, not just the `apply` call:
 *   open      (open(store, token, epoch)) counts, and an answer that says the service did not carry the request out
 *             (notStartedAnswer) — received while the window is still open — is recorded too
 *             (store.noteAttemptNotStarted) before the answer is handed back, so before any error the feature makes of it;
 *   trailing  (close()) still counts every mutation — a request `apply` left in flight, a client's re-send of it (a 401
 *             refreshed, a transient answer), a layer's resend — and records no not-started answer: a request in flight
 *             when the window closed, or sent after, stays possibly applied, because nothing here can see whether its
 *             caller sends it again. A store that refuses the count (the attempt claimed by another run, so another
 *             epoch; the attempt gone) leaves the request unsent;
 *   ended     (end()) counts nothing: runManagedFeature ends the window only once the attempt is committed or retired.
 * A window that is never ended (the run stopped) trails for the rest of the process. A mutation of a sibling sent while
 * a window is open or trailing is counted against it as well: the record may overstate what was sent, never understate it.
 */
function createAttemptSendObserver() {
  const windows = new Set();
  let installed = false;
  return {
    get installed() { return installed; },
    wrap(transport = require('./dataverse-auth.js').makeRequest) {
      if (typeof transport !== 'function') throw new TypeError('createAttemptSendObserver: the transport to wrap must be a function');
      installed = true;
      return async function observedRequest(req) {
        const method = String((req && req.method) || 'GET').toUpperCase();
        if (!windows.size || method === 'GET' || method === 'HEAD') return transport(req);
        const counted = [...windows];
        for (const w of counted) w.store.noteAttemptDispatch(w.token, w.epoch);
        // Which windows were open when the request left: only those may record its not-started answer, and only if they
        // are still open when the answer arrives (checked below).
        const openAtSend = counted.filter((w) => w.state === 'open');
        const res = await transport(req);
        if (notStartedAnswer(req, res)) {
          for (const w of openAtSend) {
            if (w.state !== 'open') continue;
            // A failed write leaves this mutation counted as possibly applied: the record may overstate, never understate.
            try { w.store.noteAttemptNotStarted(w.token, w.epoch); } catch { /* stays possibly applied */ }
          }
        }
        return res;
      };
    },
    /**
     * Open the send window of the attempt `token` in `store`, under the `epoch` its markSending answered (fenced: a
     * count under an epoch the store has moved past is refused unsent). close() stops it recording not-started answers
     * and leaves it counting (trailing); end() stops it counting.
     */
    open(store, token, epoch) {
      if (!store || typeof store.noteAttemptDispatch !== 'function' || typeof token !== 'string' || !token) throw new TypeError('createAttemptSendObserver: a window needs the store and the attempt token');
      if (epoch !== undefined && epoch !== null && !(Number.isSafeInteger(epoch) && epoch >= 1)) throw new TypeError('createAttemptSendObserver: a window\'s epoch is the one markSending answered');
      const w = { store, token, epoch: epoch === null ? undefined : epoch, state: 'open' };
      windows.add(w);
      return {
        close() { if (w.state === 'open') w.state = 'trailing'; },
        end() { w.state = 'ended'; windows.delete(w); },
      };
    },
  };
}

// A resumed create sends only what the attempt recorded: the same root (kind, key, id), the same expected proof, the
// same declaration hash and the same publication. Anything else is a new change, which this seam never makes.
function samePlan(planned, pending) {
  return sameIntent(planned, pending) && canonicalJson(planned.expected) === canonicalJson(pending.expected)
    // An attempt that recorded its declaration is sent again only for that one: commit binds it. One prepared by an
    // earlier build recorded none, and is compared by its declaration hash alone, as before.
    && (pending.declaration === undefined || sameDeclaration(planned, pending));
}

// The intent a prepared attempt records before anything is sent: its root, declaration hash, original declaration and
// publication. Retiring a prepared attempt is always safe (nothing was sent), so here a declaration the attempt did not
// record, or a different one, is a different intent: the change is prepared again with the declaration it commits.
function samePreparedIntent(planned, pending) {
  return sameIntent(planned, pending) && sameDeclaration(planned, pending);
}

function sameIntent(planned, pending) {
  if (!planned || planned.noop === true || !planned.root || !pending.root) return false;
  const r = planned.root;
  return r.kind === pending.root.kind && r.key === pending.root.key && String(r.id).toLowerCase() === String(pending.root.id).toLowerCase()
    && planned.declarationSha256 === pending.declarationSha256
    && canonicalJson(planned.publication || null) === canonicalJson(pending.publication || null);
}

function sameDeclaration(planned, pending) {
  if (pending.declaration === undefined || planned.declaration === undefined) return pending.declaration === planned.declaration;
  return canonicalJson(planned.declaration) === canonicalJson(pending.declaration);
}

// The feature's consumer state is committed exactly as prove answered it; the attempt's original declaration is the
// store's to commit, beside it (commitGroup `originalDeclaration`), and nothing passed here can replace it.
function commit(store, token, baseGeneration, proved, adoptionApproved) {
  return store.commitGroup({
    token, baseGeneration, records: proved.records, proof: proved.proof, consumerState: proved.consumerState,
    publication: proved.publication === undefined ? null : proved.publication, proofSchema: proved.proofSchema, adoptionApproved,
  });
}

/**
 * Persist `effect` (a workflowEffects record, without token and state) as definitely-unsent under its attempt, then
 * run `fn(record)` inside its transport context: the one workflow write that matches it is sent once, and any other
 * mutation inside `fn` is refused unsent (lib/workflow-effect-context.js). Reads inside `fn` pass as always.
 * `workflowConditionalEdits`: the feature's edit switch. `false` checks the effect first (editSwitchRequired, given
 * `observedState`) and refuses one that needs the switch with `workflow-edit-refused`, nothing recorded or sent;
 * `true` records it as before. A workflow feature passes it on EVERY call — its direct replay path through
 * runWithWorkflowEffect included, which makes no check of its own — so omitted leaves the check to the caller.
 * `observedState`: for a state effect, the row's state from the feature's own fresh read before this dispatch; only
 * 'Draft' lets the attempt's own activation pass with the switch off.
 */
async function withWorkflowEffect({ store, effect, workflowConditionalEdits, observedState }, fn) {
  if (!store || typeof store.recordWorkflowEffect !== 'function') throw codedError(CODES.notSettled, 'withWorkflowEffect needs the managed binding store');
  if (typeof fn !== 'function') throw codedError(CODES.notSettled, 'withWorkflowEffect needs the write to run');
  if (workflowConditionalEdits !== undefined && typeof workflowConditionalEdits !== 'boolean') throw codedError(CODES.notSettled, 'withWorkflowEffect takes workflowConditionalEdits only as a boolean');
  if (workflowConditionalEdits === false && editSwitchRequired(store.readGroup(effect.family, effect.key), effect, { observedState })) {
    throw codedError(WORKFLOW_EDIT_REFUSED, `the managed ${effect.family} "${effect.key}" would ${effect.effect === 'body' ? 'change the logic of' : 'change the state of'} workflow ${effect.rowId}, which is not this attempt's own activation of a Draft it created; edits of existing workflows are switched off`);
  }
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
 * Read-only confirmation of an uncertain publication on `scope`: a publish whose request may have been sent
 * (`dispatching`) or whose answer was lost (`unconfirmed`). Nothing is sent, replayed or deleted. For each dispatch
 * token of the scope, every group that carries it is read afresh with its family's layer reader (`readers`, by default
 * the shared LAYER_READERS); only when EVERY one of them has a published layer equal to its desired hash is that
 * dispatch confirmed, in one store write, with its original token and the generation each read was judged against
 * (store.confirmPublished). Any other outcome — a layer that differs, a read that fails or answers no hash, a family with
 * no reader, debt that names no desired hash, a stored group on the scope that is not usable, a write that fails —
 * leaves the dispatch as it is and blocks the scope for the rest of the run (barrier.blockScope).
 * A block already set (openManagedContext quarantines a scope that holds an uncertain publication) is never cleared:
 * the rest of the scope's debt waits for the next run, which finds the dispatch confirmed and installs no block.
 * Answers { confirmed: [{ family, key }], unconfirmed: [{ family, key, code }] }. publishManagedScope calls it first
 * whenever the scope holds an uncertain publication; a feature may also call it directly.
 */
async function confirmUncertainPublication({ store, barrier, scope, client, readers = LAYER_READERS } = {}) {
  if (!store || typeof store.snapshot !== 'function' || typeof store.confirmPublished !== 'function' || !client || typeof client.get !== 'function' || !readers || typeof readers !== 'object') {
    throw codedError(CODES.notSettled, 'confirmUncertainPublication needs the store, a Dataverse client to read the published layers with, and the layer readers');
  }
  const gate = barrier || store;
  if (typeof gate.blockScope !== 'function') throw codedError(CODES.notSettled, 'confirmUncertainPublication needs the publication barrier (blockScope)');
  const want = scopeId(scope);
  if (!want) throw codedError(CODES.notSettled, 'confirmUncertainPublication needs the table or dashboard scope it confirms');
  const units = store.snapshot().units();
  const dispatches = new Map();
  for (const unit of units) {
    const pub = !unit.invalid && unit.group && unit.group.publication;
    if (!pub || !UNCERTAIN_PUBLICATION.has(pub.state) || scopeId(pub.scope) !== want) continue;
    dispatches.set(pub.dispatchToken, []);
  }
  if (!dispatches.size) return { confirmed: [], unconfirmed: [] };
  // Every group a dispatch covered, wherever the store files it: a send is confirmed whole or not at all.
  for (const unit of units) {
    const pub = !unit.invalid && unit.group && unit.group.publication;
    if (pub && UNCERTAIN_PUBLICATION.has(pub.state) && dispatches.has(pub.dispatchToken)) dispatches.get(pub.dispatchToken).push({ family: unit.family, key: unit.key, group: unit.group });
  }
  const corrupt = coverageOf(store, scope).corrupt;
  const confirmed = [];
  const unconfirmed = [];
  for (const [token, list] of dispatches) {
    let code = null;
    const proofs = [];
    if (corrupt.length) code = CODES.groupInvalid;
    else if (typeof token !== 'string' || !token) code = PUBLICATION_UNCONFIRMED;
    for (const o of code ? [] : list) {
      const desired = o.group.publication.desiredSha256;
      const reader = Object.prototype.hasOwnProperty.call(readers, o.family) ? readers[o.family] : null;
      if (scopeId(o.group.publication.scope) !== want) { code = CODES.notSettled; break; }
      if (typeof reader !== 'function') { code = LAYER_READER_MISSING; break; }
      if (typeof desired !== 'string') { code = PUBLICATION_UNCONFIRMED; break; }
      let read;
      try { read = await reader(client, o.group); } catch { code = PUBLICATION_UNVERIFIED; break; }
      if (!read || typeof read.publishedSha256 !== 'string') { code = PUBLICATION_UNVERIFIED; break; }
      if (read.publishedSha256 !== desired) { code = PUBLICATION_UNCONFIRMED; break; }
      proofs.push({ family: o.family, key: o.key, publishedSha256: read.publishedSha256, generation: o.group.generation });
    }
    if (!code) {
      try {
        store.confirmPublished({ groups: proofs, token });
        confirmed.push(...list.map(({ family, key }) => ({ family, key })));
        continue;
      } catch (e) {
        code = (e && e.code) || CODES.notSettled;
      }
    }
    unconfirmed.push(...list.map(({ family, key }) => ({ family, key, code })));
    gate.blockScope(scope, `${list.map((g) => `managed ${g.family} "${g.key}"`).join(', ')} (its publish may have been sent and a fresh read did not prove it live)`);
  }
  return { confirmed, unconfirmed };
}

/**
 * Pay the owed publication of committed `groups` ([{ family, key }]) that share `scope`, at most once:
 *   - first, an uncertain publication on the scope (a publish that may have been sent) is confirmed read-only when a
 *     fresh read proves it live (confirmUncertainPublication); one that is not proved keeps the scope blocked;
 *   - a group that owes nothing is skipped; an uncertain one (dispatching/unconfirmed) is never published again:
 *     `managed-publication-unconfirmed`; a pending attempt: `managed-settlement-pending`; a group published in another
 *     scope: `managed-not-settled`. `groups` is the debt this call dispatches and confirms, nothing more;
 *   - what the publish would put live is every committed group of `scope` in the store (coverageOf), passed or not.
 *     A corrupt or uncertain one blocks the scope for the run and stops (`managed-binding-group-invalid` /
 *     `managed-publication-unconfirmed`); a pending attempt on the scope withholds the publish, debt still owed;
 *   - `client` reads both layers of every covered group, each with its family's reader (`readers`, by default the
 *     shared LAYER_READERS of lib/managed-layer-readers.js), as { savedSha256, publishedSha256 } hashed the way the
 *     group's `publication.desiredSha256` was. A covered group whose family has no reader is never skipped: the scope is
 *     blocked for the run before anything is read or sent (`managed-publication-reader-missing`). A read that fails or
 *     lacks a hash, before anything is sent, is `managed-publication-unverified` and blocks the scope for the run: what
 *     is saved on it is not shown safe. Debt whose published layer already equals what is owed ends without a send;
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
 * `readers` replaces the shared map whole (a test's fault injection); a caller's own `readLayers` is not accepted.
 * Answers { sent, withheld, confirmed: [{ family, key }] }: confirmed lists every group this call confirmed, a read-only
 * confirmation of an uncertain publication included.
 *
 * Every send also journals the CARRIED groups of the scope: a covered group that owes nothing, has a settled publication
 * (confirmed or not-needed) with a desired hash, and has exactly that hash saved, so the same publish puts it live
 * again. They are marked dispatching under the send's token in the same write as the debt (store.markPublishDispatch
 * `carried`), and the read-back confirms them with the debt. A send that definitely did not start returns each to the
 * settled state it had; one whose outcome is not proved leaves them unconfirmed, which fences the scope across runs
 * like any uncertain publication until a read-only confirmation proves every group of the dispatch live.
 *
 * `carry: true` is a PLAIN publish of the scope that the barrier routed here (lib/managed-scope-publisher.js): the build
 * saved something on a table a managed group publishes in and wants that table published. It is sent even when no debt
 * is owed or due, under every check above — the coverage, the reads, the drift refusal, the pending and withhold rules —
 * so a plain publish can never put a covered group's unproved saved layer live. With no debt in it, the send journals
 * only its carried groups; when the scope has none, it writes nothing to the store, and a send whose outcome is not
 * proved still blocks the scope for the run.
 */
async function publishManagedScope({ store, barrier, scope, groups, client, readers = LAYER_READERS, publish, path = 'managed publication', newToken, carry = false, ...rest } = {}) {
  if ('readLayers' in rest) throw codedError(CODES.notSettled, 'publishManagedScope reads every covered group with its family\'s shared reader (client, lib/managed-layer-readers.js); a caller\'s readLayers is not accepted');
  if (!store || !client || typeof client.get !== 'function' || !readers || typeof readers !== 'object' || typeof publish !== 'function') throw codedError(CODES.notSettled, 'publishManagedScope needs the store, a Dataverse client to read the saved and published layers with, and the publish');
  const gate = barrier || store;
  for (const op of ['allowScope', 'blockScope', 'hold', 'release', 'withSendPermit']) {
    if (typeof gate[op] !== 'function') throw codedError(CODES.notSettled, `publishManagedScope needs the publication barrier (${op})`);
  }
  const want = scopeId(scope);
  if (!want) throw codedError(CODES.notSettled, 'publishManagedScope needs the table or dashboard scope it publishes');
  if (typeof store.snapshot !== 'function') throw codedError(CODES.notSettled, 'publishManagedScope needs the store\'s snapshot to see every group of the scope');
  // A publish of this scope that may have been sent is confirmed read-only first, when a fresh read proves it live; what
  // it confirms is answered with this call's own confirmations. One it cannot prove leaves the scope blocked, and the
  // checks below still refuse to send over it.
  const uncertainHere = store.snapshot().units().some((u) => !u.invalid && u.group && u.group.publication && UNCERTAIN_PUBLICATION.has(u.group.publication.state) && scopeId(u.group.publication.scope) === want);
  const readConfirmed = uncertainHere ? (await confirmUncertainPublication({ store, barrier: gate, scope, client, readers })).confirmed : [];
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
  if (!owed.length && carry !== true) return { sent: false, withheld: false, confirmed: readConfirmed };
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
  if (cover.pending.length) return { sent: false, withheld: true, confirmed: readConfirmed };
  const unread = cover.groups.filter((o) => !Object.prototype.hasOwnProperty.call(readers, o.family) || typeof readers[o.family] !== 'function');
  if (unread.length) {
    gate.blockScope(scope, `${names(unread)} (no reader of its layers)`);
    throw codedError(LAYER_READER_MISSING, `${names(unread)} shares the publish of this scope and its family has no layer reader, so its saved layer cannot be shown safe; nothing was published`);
  }

  const readAll = async (list) => {
    const out = [];
    for (const o of list) {
      let read;
      try { read = await readers[o.family](client, o.group); } catch (e) {
        throw codedError(PUBLICATION_UNVERIFIED, `the saved and published layers of managed ${o.family} "${o.key}" could not be read`, { cause: e });
      }
      if (!read || typeof read.publishedSha256 !== 'string' || typeof read.savedSha256 !== 'string') throw codedError(PUBLICATION_UNVERIFIED, `the layers of managed ${o.family} "${o.key}" answered no proof`);
      const desired = o.group.publication.desiredSha256;
      const savedEqual = typeof desired === 'string' && read.savedSha256 === desired;
      // Owed debt ships only its own saved layer. Anything else may stay as it is live, or be what it last desired.
      const safe = o.group.publication.state === 'owed' ? savedEqual : savedEqual || read.savedSha256 === read.publishedSha256;
      out.push({ ...o, savedSha256: read.savedSha256, publishedSha256: read.publishedSha256, equal: read.publishedSha256 === desired, safe });
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
  const confirmedSoFar = () => [...readConfirmed, ...already.map(({ family, key }) => ({ family, key }))];
  const due = debt.filter((o) => !o.equal);
  if (!due.length && carry !== true) return { sent: false, withheld: false, confirmed: confirmedSoFar() };
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
  // A publish ships the saved layer of EVERY covered group, not only the debt it pays. A covered group that owes nothing
  // but whose saved layer is its desired hash is put live again by the same request, so it is carried: journaled with
  // the debt under the same token before the send, and confirmed by the same read-back. Its publication cannot be
  // proved otherwise, so a send whose answer is lost fences the scope across runs exactly as debt does (an uncertain
  // publication: quarantined, never prepared or claimed over, never sent again) until a read-only confirmation shows
  // every group of the dispatch live at its desired hash. A group whose saved layer equals its published one but not
  // its desired hash is not carried: the publish leaves it as it is, and a read could never confirm it.
  const justConfirmed = (o) => already.some((a) => a.family === o.family && a.key === o.key);
  const carriedReads = before.filter((o) => !due.includes(o) && typeof o.group.publication.desiredSha256 === 'string' && o.savedSha256 === o.group.publication.desiredSha256
    && (justConfirmed(o) || o.group.publication.state === 'confirmed' || o.group.publication.state === 'not-needed'));
  const carried = carriedReads.map(({ family, key, group }) => ({ family, key, generation: group.generation }));
  const records = covered.length > 0 || carried.length > 0;
  const label = covered.length ? names(covered) : `the saved changes on ${want.replace(':', ' ')}`;
  const journal = () => { if (records) store.markPublishDispatch({ groups: covered, carried, scope, token }); };
  const note = (outcome) => { if (records) store.notePublishOutcome({ token, outcome }); };
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
        onDispatch: () => { journal(); dispatched = true; },
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
      journal();
      note('unconfirmed');
      throw codedError(PUBLICATION_UNCONFIRMED, `the publish of ${label} did not pass the publication barrier, so whether it was sent is unknown`);
    }
    if (failure) {
      if (failure.definiteNoStart === true) {
        note('definite-no-start');
        settled = true;
        throw codedError(failure.code || CODES.notSettled, `the publish of ${label} did not start`, { cause: failure });
      }
      gate.blockScope(scope, `${label} (its publish may have been sent and is not confirmed)`);
      note('unconfirmed');
      throw codedError(PUBLICATION_UNCONFIRMED, `the publish of ${label} failed`, { cause: failure });
    }
    // A success answer is not proof the content is live: read it back. A read that fails or still differs leaves the
    // debt unconfirmed and the scope blocked, and it is never sent again.
    let after;
    try {
      after = await readAll([...due, ...carriedReads]);
    } catch (e) {
      gate.blockScope(scope, `${label} (its publish was sent and could not be read back)`);
      note('unconfirmed');
      throw codedError(PUBLICATION_UNCONFIRMED, 'the publish was sent and its published layer could not be read back', { cause: e });
    }
    if (after.some((o) => !o.equal)) {
      gate.blockScope(scope, `${label} (its publish was sent and the published layer does not show it)`);
      note('unconfirmed');
      throw codedError(PUBLICATION_UNCONFIRMED, 'the publish was sent and the published layer does not show what was owed');
    }
    // One atomic write confirms every debt of the send, so no run can see some of them confirmed and not the rest.
    if (records) store.confirmPublished({ groups: after.map((o) => ({ family: o.family, key: o.key, publishedSha256: o.publishedSha256 })), token });
    settled = true;
    // A carried group was confirmed before this call and stays so: `confirmed` keeps listing the debt this call settled.
    return { sent: true, withheld: false, confirmed: [...readConfirmed, ...[...already, ...due].map(({ family, key }) => ({ family, key }))] };
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
  LAYER_READER_MISSING,
  CREATION_RECORD_UNSETTLED,
  runManagedFeature,
  createAttemptSendObserver,
  attemptProvenUnsent,
  notStartedAnswer,
  rowsCreatedByAttempt,
  existingRowDispatches,
  editSwitchRequired,
  WORKFLOW_EDIT_REFUSED,
  withWorkflowEffect,
  publishManagedScope,
  confirmUncertainPublication,
};
