'use strict';
// The workflow writes of a declared workflow family on the managed settlement layer, shared by business rules
// (lib/rule-settlement.js) and business process flows (lib/bpf-settlement.js). Both own ONE `workflows` row per
// declaration and change it with the same three kinds of write — a create, a body write, a state change — so how a
// write is sent once, proved by reading and never sent again lives here, once.
//
//   - Every write runs inside `withWorkflowEffect` with its persisted effect record (lib/workflow-effect-context.js):
//     the record is durable BEFORE the send, the gate lets exactly the matching request through once, and any other
//     mutation inside the same call is refused unsent.
//   - A stored record that is still `definitely-unsent` is sent under that same record (`runWithWorkflowEffect`), so
//     a retry never mints a second record for one write.
//   - A write whose answer is lost or refused is proved by a fresh read of the row, never by sending it again. Only the
//     effect gate's own record says a write never started: a 412 to a request that carried If-Match (the precondition
//     was false, so the method was not applied). A generic 4xx is not that proof — the operation may have started
//     before the answer was made — so the effect stays `unconfirmed` and is never sent again.
//     See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/perform-conditional-operations-using-web-api
//   - The local SDK copy of the row is a maker's workspace too: an edit nobody sent is never overwritten, reseeded or
//     deleted (createCopyGuard).
//   - The state change is the measured state-only path: `updateRecord` -> one `PATCH workflows(<id>)` with exactly
//     { statecode, statuscode }. With a row version (the conditional-edit switch) it is sent through the plugin's HTTP
//     client instead, because `updateRecord` cannot carry an `If-Match` header.
//     See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/perform-conditional-operations-using-web-api

const { normalizeGuid } = require('./reconcile-common.js');
const contract = require('./managed-feature-contract.js');
const { editSwitchRequired, existingRowDispatches, WORKFLOW_EFFECT_FULFILLED } = contract;
const { runWithWorkflowEffect } = require('./workflow-effect-context.js');
const { CODES, COMPLETION_MAX_BYTES } = require('./managed-bindings.js');
const { hasUnsyncedEdits } = require('./unsynced-edits.js');

const ACTIVE = 'Active';
const DRAFT = 'Draft';
// The state-only body of each workflow state. The effect gate accepts exactly these pairs for a state effect.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/workflow#statecode-choicesoptions
const STATE_BODY = { Draft: { statecode: 0, statuscode: 1 }, Active: { statecode: 1, statuscode: 2 } };

function coded(code, message, extra = {}) {
  return Object.assign(new Error(message), extra, { code });
}

// The completion reservation of one attempt (runManagedFeature `plan` -> `completionBytes`, managed-bindings
// prepareAttempt). After the send, the attempt's own writes — its expected proof, its workflow effects, the saved
// observation, then the commit that adds the group's records, proof, consumer state and original declaration — may
// grow the store only by its reservation; past it, a completion can be refused AFTER its send
// (`managed-binding-store-full`). The store's default covers one copy of the declaration, but a group of these
// families keeps the declaration twice (its consumer state and its originalDeclaration) beside a projection of the
// proved row, so the plan asks for a bound of its own: every part it passes, counted as the store's file holds it —
// JSON indented two spaces a level, each line COMPLETION_DEPTH levels down (as deep as the store counts a consumer
// copy, deeper than these parts sit: env -> groups -> [i] -> consumerState -> declaration -> flow -> ...) — plus a
// fixed margin for the effect records and hashes the plan cannot list, and a tenth on top.
// The bound is never cut down to fit: a reservation smaller than the completion is the post-send refusal above. The
// size is not a function of the declaration's bytes alone (a rule of many small recommendation apply-actions keeps
// a slot, a node and an expected entry for each, about fourteen times its own size), and no count of conditions,
// actions or steps is enforced, so a declaration that needs more than the store reserves for one attempt
// (COMPLETION_MAX_BYTES) is refused by completionWithin in `plan`, before anything is recorded or sent.
const COMPLETION_DEPTH = 8;
const COMPLETION_MARGIN_BYTES = 64 * 1024;
function completionBytesFor(parts) {
  let bytes = COMPLETION_MARGIN_BYTES;
  for (const part of parts) {
    const text = JSON.stringify(part, null, 2);
    if (text === undefined) continue;
    bytes += Buffer.byteLength(text, 'utf8') + text.split('\n').length * 2 * COMPLETION_DEPTH;
  }
  return Math.ceil(bytes * 1.1);
}
// The plan's `completionBytes`, or the coded refusal of a declaration whose completion the store cannot reserve.
// `reduce` names what the maker can cut, e.g. 'conditions, actions or recommendation apply-actions'.
const COMPLETION_TOO_LARGE = 'workflow-declaration-too-large';
function completionWithin(bytes, label, noun, reduce) {
  if (bytes <= COMPLETION_MAX_BYTES) return bytes;
  const mib = (n) => `${(n / (1 << 20)).toFixed(1)} MiB`;
  throw coded(COMPLETION_TOO_LARGE, `${label}: keeping this ${noun} in the managed binding store needs about ${mib(bytes)}, more than the `
    + `${mib(COMPLETION_MAX_BYTES)} one ${noun} may reserve, so nothing is recorded or sent. Reduce the ${noun} (fewer ${reduce}) or split it `
    + `into several ${noun}s, then rerun`, { completionBytes: bytes, completionMaxBytes: COMPLETION_MAX_BYTES });
}
// Stand-ins of the right size for what the plan cannot know yet: a SHA-256 hex digest, and the backing table name the
// service gives a new process flow (a Dataverse logical name, far shorter than this).
const HASH_BOUND = 'f'.repeat(64);
const NAME_BOUND = 'n'.repeat(256);

// The SDK throws a service answer as
//   Error 'HTTP 400 from <url>: …' { code: 'CONNECTION_ERROR', statusCode: 400, url, cause: <the response body> }
// so the facts about how a write ended are spread over a short cause chain.
function causeChain(err) {
  const chain = [];
  for (let e = err; e && typeof e === 'object' && chain.length < 6 && !chain.includes(e); e = e.cause) chain.push(e);
  return chain;
}

// An answer that leaves the outcome open (no answer, a 5xx, a success the SDK could not use, an unknown outcome).
function leavesOutcomeOpen(chain) {
  return chain.some((e) => {
    const status = e.statusCode != null ? e.statusCode : e.status;
    return e.outcome === 'unknown' || /outcome[-_ ]?unknown/i.test(String(e.code || '')) || e.code === 'BUSINESS_RULE_LEFT_DEACTIVATED'
      || (Number.isInteger(status) && (status === 0 || status >= 500 || (status >= 200 && status < 300)));
  });
}

/** The 4xx the service answered the write with, or null (no answer, or an answer that leaves the outcome open). */
function answeredRefusal(err) {
  const chain = causeChain(err);
  if (leavesOutcomeOpen(chain)) return null;
  return chain.find((e) => {
    const status = e.statusCode != null ? e.statusCode : e.status;
    return Number.isInteger(status) && status >= 400 && status < 500;
  }) || null;
}

// The remedy for a local copy that holds an edit no build sent. Only this row's own copy is named: the workspace's
// general reset also removes the managed binding store, which this attempt still needs.
const COPY_REMEDY = 'Put any change you want to keep into the spec, then delete only this row\'s local copy (the files named '
  + '<id>.json and <id>.meta.json under the workspace\'s sdk folder; never a managed-bindings.*.json file) and re-run';

/**
 * The clean-continuation check of the local SDK copy (lib/unsynced-edits.js hasUnsyncedEdits: the SDK's own diff of
 * the copy against the snapshot of what the server last returned). Run before any fetch with overwrite, reseed,
 * delete or restage of a row's copy, on every path — a no-op and a recovery included: an edit an earlier run did not
 * send, or one made by hand, is not this build's to throw away, and an attempt that names the same id is no
 * permission to. A copy that differs, cannot be compared, or was created and never synced stops the build untouched
 * (`create-completion-required`, category `workspace-copy-unsent-edits`). A copy is checked once per process; after
 * that the process's own staging is what makes it differ, and `restoreStaged` drops that staging again when the
 * process ends with it unsent, so the next run finds a clean copy (or none) and not this run's leftovers.
 */
function createCopyGuard({ sdk, artifact, label, noun }) {
  const checked = new Set();
  const staged = new Set();
  async function assertClean(id) {
    const k = String(id || '').toLowerCase();
    if (!k || checked.has(k)) return;
    // hasUnsyncedEdits answers true for a copy it cannot compare (no method, a throw), which here is a refusal.
    if (await hasUnsyncedEdits(sdk, artifact, id)) {
      throw coded('create-completion-required', `${label}: the local copy of the ${noun} ${id} in the workspace differs from the server's `
        + `(an edit an earlier run did not send, or one made by hand), or could not be compared with it, so nothing was read over it `
        + `and nothing was written; the local copy was kept. ${COPY_REMEDY}`, { category: 'workspace-copy-unsent-edits' });
    }
    checked.add(k);
  }
  function noteStaged(id) {
    staged.add(String(id).toLowerCase());
  }
  // Best effort, local only (no request): a copy this process staged and did not get synced is removed, so a later
  // read fetches the server's. Never throws — the build is already ending with the error that left it unsent.
  async function restoreStaged() {
    for (const id of staged) {
      try {
        if (await hasUnsyncedEdits(sdk, artifact, id)) await sdk.deleteArtifact(artifact, id);
      } catch { /* the next run's check refuses whatever is left */ }
    }
    staged.clear();
  }
  return { assertClean, noteStaged, restoreStaged };
}

/**
 * The write driver of one declared workflow (`family`/`key` in the store).
 * @param {object} o
 *   store, sdk           the managed binding handle and the gated maker SDK
 *   httpClient, instanceUrl  the plugin's client, for every state change, which carries If-Match (the own activation too)
 *   family, key, label   the store group and the text errors name it by
 *   noun                 what the row is called in messages ('rule', 'process flow')
 *   driftCode            the family's drift code ('rule-drift', 'bpf-drift')
 *   conditionalEdits     the edit switch (opts.workflowConditionalEdits === true); off, the dispatch gate allows a row
 *                        no write but its create and the activation of this attempt's own Draft (needsSwitch)
 *   editRefusedRemedy    the family's remedy text for workflow-edit-refused
 */
function createWorkflowDriver({ store, sdk, httpClient = null, instanceUrl = null, family, key, label, noun, driftCode, conditionalEdits = false, editRefusedRemedy = '' }) {
  // The version is read BEFORE the body by every caller, so a write that lands between the two leaves the version
  // stale: the conditional write that carries it is refused rather than overwriting a body the run never proved.
  // The row's `@odata.etag` is its version, e.g. { "workflowid": "…", "statecode": 1, "@odata.etag": "W/\"1234\"" }.
  async function readVersion(id) {
    let rows;
    try {
      rows = await sdk.queryRecords('workflow', { select: ['workflowid', 'statecode', 'statuscode'], filter: `workflowid eq ${id}` });
    } catch (err) {
      throw coded(CODES.notSettled, `${label}: the workflow row ${id} could not be read`, { cause: err });
    }
    const row = (rows || []).find((r) => normalizeGuid(r.workflowid) === id);
    if (!row) return null;
    return { version: row['@odata.etag'] || null, state: Number(row.statecode) === 1 ? ACTIVE : DRAFT };
  }

  function attemptOf(token) {
    const { pending, effects } = store.readGroup(family, key);
    if (!pending || pending.token !== token) throw coded(CODES.notSettled, `${label}: its attempt is not pending`);
    return { attempt: pending, effects: effects.filter((e) => e.attemptToken === token) };
  }
  function effectOf(token, pick) {
    return attemptOf(token).effects.filter(pick).pop() || null;
  }
  /**
   * Does `proposed` (a workflow effect of the attempt `proposed.attemptToken`) need the conditional-edit switch? The
   * shared rule (managed-feature-contract.js editSwitchRequired: a create never; a body write always; a state write
   * needs it unless it is the attempt's own activation of a row it has positive evidence of having created — a
   * confirmed own create effect, or an answer that acknowledged the create — AND `observedState` is 'Draft' from a
   * read this run made after that create and before this dispatch). The narrowing below is the design's: these
   * families never send their own new row back to Draft, so any state write but an activation needs it.
   */
  function needsSwitch(group, proposed, observedState) {
    if (editSwitchRequired(group, proposed, { observedState })) return true;
    return proposed.effect === 'state' && proposed.desiredState !== ACTIVE;
  }

  function editRefused(effect, when) {
    const id = normalizeGuid(effect.rowId);
    return coded('workflow-edit-refused', `${label}: ${effect.effect === 'state' ? `setting the ${noun} ${effect.desiredState}` : `writing the ${noun}'s body`} `
      + `would change the workflow ${id}, which this attempt's own create is not proved to have made; ${when}. ${editRefusedRemedy}`);
  }

  /**
   * The existing-workflow edit gate at the point of dispatch, for every body and state write on every path (a first
   * send, a continued or resumed attempt, a recovery), before its effect is recorded or sent. A preflight sees only
   * effects that were already persisted, so a path that records a NEW effect late (inside recovery, after a read) is
   * stopped here. With the switch off, anything but a create or the activation of the attempt's own Draft, read Draft
   * (`observedState`) just before, is `workflow-edit-refused`, nothing recorded and nothing sent. A caller that made no
   * such read passes none, and the activation is refused (fail closed).
   */
  function assertDispatchAllowed(token, effect, observedState) {
    if (conditionalEdits) return;
    if (needsSwitch(store.readGroup(family, key), { attemptToken: token, ...effect }, observedState)) throw editRefused(effect, 'nothing was recorded or sent');
  }

  /**
   * The same rule as an early refusal, for the feature's `preflight` (runManagedFeature: before resolve, prove,
   * continue or resume, so before any read): an attempt on disk that still has to send a write the switch is needed for
   * (the shared existingRowDispatches, plus a state write other than an activation of the attempt's own Draft) stops
   * the run with no request at all. It is not a substitute for assertDispatchAllowed: an effect first proposed later is
   * not on disk yet. A write that may already have been dispatched is not listed: it is proved by reading, never sent.
   * The list is exactly the shared existingRowDispatches: every unsent body or state write of the attempt except an
   * own activation candidate. That already holds every state write this module's narrowing adds (one to anything but
   * Active is never an own activation candidate), and an own activation is left to the dispatch gate, which needs
   * the fresh Draft read that no preflight has.
   */
  function refuseRecordedEdits({ pending, effects }) {
    if (conditionalEdits || !pending) return;
    const listed = existingRowDispatches({ pending, effects: effects || [] });
    if (listed.length) throw editRefused(listed[0], 'nothing was read or sent, and the attempt is kept');
  }

  // Send one write inside its effect context: a stored record (definitely-unsent) is sent under that record, else a
  // new record is persisted first. Answers the error the write ended with, or null; never throws a write failure — but
  // the dispatch gate above throws BEFORE anything is recorded or sent.
  // The edit switch is passed to the shared `withWorkflowEffect` as a boolean on every new record, with the state the
  // caller's fresh read observed (`observedState`, for an activation), so its own check (editSwitchRequired,
  // `workflow-edit-refused` before recording) backs this module's stricter gate. A stored record is replayed with
  // `runWithWorkflowEffect`, which takes no switch: on that path assertDispatchAllowed is the check.
  // It is called through the module object so a test can observe what each call carries.
  async function sendOnce(token, stored, effect, write, { observedState } = {}) {
    assertDispatchAllowed(token, stored || effect, observedState);
    let started = false;
    const dispatch = () => { started = true; return write(); };
    try {
      const res = stored ? await runWithWorkflowEffect(stored, dispatch)
        : await contract.withWorkflowEffect({
          store, workflowConditionalEdits: conditionalEdits === true, observedState,
          effect: { attemptToken: token, baseGeneration: attemptOf(token).attempt.baseGeneration, family, key, ...effect },
        }, dispatch);
      if (res && res.saved === false) return res.error || coded(CODES.notSettled, 'the SDK reported the write as not saved');
      if (res && Number.isInteger(res.status) && (res.status < 200 || res.status >= 300)) return Object.assign(new Error(`HTTP ${res.status}`), { statusCode: res.status, cause: res.body });
      return null;
    } catch (err) {
      // The attempt already found this change made without sending it (a fulfilled record, made by another process
      // since this one read the effects): it is met, so nothing is sent and there is no failure to answer. The caller
      // reads the effect again and finds it fulfilled.
      if (!started && err && err.code === WORKFLOW_EFFECT_FULFILLED) return null;
      // A throw before the write ran is not an answer of the write: the shared gate refused it (workflow-edit-refused)
      // or the store refused to record it, so there is no effect to look up or prove. It is the run's refusal, thrown
      // as coded, and nothing after it handles an effect. Only a failure of the write itself is answered to the caller.
      if (!started || (err && err.code === 'workflow-edit-refused')) throw err;
      return err;
    }
  }
  // A write the server refused before it started: its effect may be sent again under its own record.
  function noteNoStart(effect) {
    if (effect.state === 'dispatching' || effect.state === 'unconfirmed') store.noteEffectOutcome(effect.token, 'definite-no-start');
  }
  const sendState = (id, state, version) => () => (version
    ? httpClient.patch(`${String(instanceUrl).replace(/\/+$/, '')}/api/data/v9.2/workflows(${id})`, STATE_BODY[state], { headers: { 'If-Match': version } })
    : sdk.updateRecord('workflow', id, STATE_BODY[state]));
  // The conditional state path needs both the client and an absolute environment URL to build the row address above.
  const stateTargetGiven = () => Boolean(httpClient) && typeof instanceUrl === 'string' && /^https?:\/\/[^/\s]+/i.test(instanceUrl);

  /**
   * Bring this attempt's row to `state` with one state effect, proved by reading. An effect already dispatched is
   * proved, never sent again; a definitely-unsent one is sent under its own record. `observed` is the state the
   * caller's read of the row answered, made in this run after the attempt's create and before this call; with the
   * switch off, only an activation of the attempt's own row observed 'Draft' there may be sent.
   */
  async function driveState(token, id, state, version, { conditional, observed, onConflict = null }) {
    let effect = effectOf(token, (e) => e.effect === 'state' && e.desiredState === state);
    let failure = null;
    if (!effect || effect.state === 'definitely-unsent') {
      if (conditional && !version) throw coded(driftCode, `${label}: no row version was read, so a conditional state change cannot be sent`);
      // Only the plugin's client carries If-Match (sendState), and it needs the environment URL to address the row:
      // without either a conditional write would go out unconditional or not at all. Checked before the effect is
      // recorded, so a missing input leaves no state record behind.
      if (version && !stateTargetGiven()) {
        throw coded('workflow-state-path-unavailable', `${label}: no client and environment URL that carry the row version were given, so setting the ${noun} ${state} is not sent`);
      }
      failure = await sendOnce(token, effect, {
        rowId: id, effect: 'state', request: { method: 'PATCH', shape: 'workflow-patch' }, desiredSha256: null, desiredState: state, expectedVersion: version || null,
      }, sendState(id, state, version), { observedState: observed });
      effect = effectOf(token, (e) => e.effect === 'state' && e.desiredState === state);
      // The service refused the precondition (412 to If-Match): the write was not applied, and the caller decides from
      // a fresh read what the row now is. Nothing is sent again here.
      if (effect.state === 'definitely-unsent' && onConflict) return onConflict(effect, failure);
    }
    // Confirmed (sent and proved), or fulfilled (found made without this attempt sending it): either way it is met and
    // is never sent again from this attempt; the final proof reads what the row is now.
    if (effect.state === 'confirmed' || effect.state === 'fulfilled') return;
    const row = await readVersion(id);
    if (row && row.state === state) { store.confirmEffect(effect.token, { observedState: state }); return; }
    if (effect.state === 'definitely-unsent') {
      throw coded(driftCode, `${label}: the ${noun} changed on the server after it was read, so setting it ${state} was refused; it is not retried`, { cause: failure });
    }
    // An answered 4xx says the service did not finish the change, not that it never started it, so the effect stays
    // unconfirmed: it is proved by reading on every later run and never sent again from this attempt.
    if (failure && answeredRefusal(failure)) {
      throw coded('workflow-state-path-unavailable', `${label}: setting the ${noun} ${state} was refused (${failure.message}). That answer does not prove `
        + `the change never started, so it is not sent again from this attempt; the row is kept as it is and nothing is deleted`, { cause: failure });
    }
    throw coded(CODES.pending, `${label}: setting the ${noun} ${state} is not proved yet and is not sent again; a later run reads the row again to prove it`, { cause: failure });
  }

  /**
   * The default activation of this attempt's own new Draft (finishCreate), held to the read that proved it. `live` is
   * that read (readLive: the version first, then the body, so a write between the two leaves the version stale), and
   * `provedActive(view)` answers null when a view carries exactly the body this attempt proved, sent to be Active, or
   * why not. `reread()` is the family's readLive of the row.
   *
   * The activation carries If-Match with the version of that read, so a maker's activation, deactivation or edit that
   * lands after it makes the service refuse the write (412) instead of activating a body nobody proved, or undoing the
   * maker's own change. After that refusal a fresh read decides, and nothing more is sent:
   *   Active, carrying exactly the proved body   the activation is met without this write: its record becomes the
   *                                              durable fact that it was fulfilled (store fulfillEffect), and the row
   *                                              settles as is;
   *   anything else (Draft at a newer version, a changed body, the maker's deactivation)
   *                                              `create-completion-required`, the attempt kept;
   *   Draft at the very version that was read     the activation was not applied (the service refused its precondition):
   *                                              its record waits for a later run; if it keeps being refused, the maker
   *                                              activates the verified row and reruns.
   * A row the caller's read already found Active settles the same way, with no write (with no record yet, the fact is
   * recorded fulfilled in one write: store recordFulfilledEffect). A recorded activation that was held to another
   * version than this read (or to none: an unconditional record) is never sent: the row changed since, or the record
   * cannot say what it was proved against.
   *
   * A fulfilled (or confirmed) activation is never proposed or sent again by this attempt, through any failure or
   * restart before its commit: if the row is no longer Active when a later run reads it (a maker deactivated it after it
   * was found or made Active), that is the maker's change, and it is never undone — the run stops
   * `create-completion-required`, nothing sent, the attempt kept. The maker's way out: activate the row again if it is
   * as declared, then rerun (the run proves it by reading and binds it without a write).
   * See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/perform-conditional-operations-using-web-api
   */
  async function activateOwnCreate(token, id, live, { reread, provedActive }) {
    const own = effectOf(token, (e) => e.effect === 'state' && e.desiredState === ACTIVE);
    if (own && (own.state === 'confirmed' || own.state === 'fulfilled')) {
      if (live.view.status === ACTIVE) return;
      throw coded('create-completion-required', `${label}: the ${noun} ${id} was already ${own.state === 'confirmed' ? 'activated by this build' : 'found Active'} `
        + `for this attempt and is ${live.view.status} now; a change made since (a maker's deactivation) is never undone, so nothing is sent and the `
        + `attempt is kept. Activate the ${noun} yourself if it is as declared, then rerun: the run proves it by reading and binds it without a write`);
    }
    if (live.view.status === ACTIVE) { settleReached(token, id, own, live); return; }
    if (!live.version) throw coded(driftCode, `${label}: no row version was read, so the activation of the ${noun} ${id} cannot be held to the body it proved; nothing is sent`);
    if (own && own.state === 'definitely-unsent' && own.expectedVersion !== live.version) {
      throw coded('create-completion-required', `${label}: the activation of the ${noun} ${id} waiting to be sent was recorded `
        + `${own.expectedVersion ? 'against an earlier version of the row, which has changed since' : 'without the row version it was proved against'}, `
        + `so it is not sent; the attempt is kept. Activate the ${noun} yourself if it is as declared (a later run proves it by reading and binds it)`);
    }
    await driveState(token, id, ACTIVE, live.version, {
      conditional: true,
      observed: live.view.status,
      onConflict: async (effect, failure) => {
        const now = await reread();
        if (!now.missing && now.version === live.version && now.view.status !== ACTIVE) {
          // The row is as the proof read it, so the activation was not applied: the service refused its precondition
          // (an answered 412 proves a refusal, not that nothing left this side; it can repeat if the service keeps
          // refusing the version token). Its record stays, unsent, and a later run sends it against this same
          // version. The maker's way out when it keeps being refused: activate the verified row, then rerun; the run
          // proves the Active row by reading and binds it without a write.
          throw coded(CODES.pending, `${label}: the activation of the ${noun} ${id} was not applied${failure ? ` (${failure.message})` : ''}; the row is `
            + `unchanged at the version it was proved against, and a later run sends it again against that version. If it keeps being refused, `
            + `activate the ${noun} yourself if it is as declared, then rerun: the run proves it by reading and binds it without a write`, { cause: failure });
        }
        const why = now.missing ? 'it could not be read back' : now.view.status !== ACTIVE ? `it is ${now.view.status} at another version` : provedActive(now.view);
        if (!why) { settleReached(token, id, effect, now); return; }
        throw coded('create-completion-required', `${label}: the ${noun} ${id} changed on the server after the read its activation was held to (${why}), `
          + `so it was not activated; nothing more is sent, and the attempt is kept. A maker's change is never undone, and a changed body is never activated`, { cause: failure });
      },
    });
  }
  /**
   * The row is Active and the caller proved its body (`live`, the read that found it so). An activation this attempt
   * may have sent (dispatching, unconfirmed) is proved by that read. One it never sent, or never proposed, was met
   * without this write: that is kept as a durable `fulfilled` fact with the state and row version the read answered,
   * never deleted, so no later run of the attempt proposes it again — whatever the row has become since. Recording
   * none (the effect deleted, or never written) would let a later run, after a failure before the commit and a maker's
   * deactivation, read a Draft with no activation on record and activate it again, undoing the maker's change.
   *
   * `own` is the record as the caller last read it, which another process sharing the store may have settled since
   * (it found the row Active first and recorded that, or sent and proved the activation). So the record is read again
   * here, and a fact that is already fulfilled or confirmed is met as it is: nothing is sent or recorded, and it is
   * never a run error. The unsent case goes through the store's recordFulfilledEffect, which decides under its lease
   * in one write: the same target already fulfilled or confirmed is answered as is, the unsent record is fulfilled in
   * place, and a record another process has started dispatching meanwhile is refused (pending, proved by a later read).
   */
  function settleReached(token, id, own, live) {
    const current = own ? effectOf(token, (e) => e.token === own.token) : null;
    if (current && (current.state === 'fulfilled' || current.state === 'confirmed')) return;
    if (current && current.state !== 'definitely-unsent') { store.confirmEffect(current.token, { observedState: ACTIVE }); return; }
    if (!live.version) {
      throw coded(CODES.pending, `${label}: the ${noun} ${id} was read Active without its row version, so that it is met cannot be recorded; nothing is `
        + 'sent, and a later run reads the row again');
    }
    store.recordFulfilledEffect({
      attemptToken: token, baseGeneration: attemptOf(token).attempt.baseGeneration, family, key, rowId: id, effect: 'state',
      request: { method: 'PATCH', shape: 'workflow-patch' }, desiredSha256: null, desiredState: ACTIVE, expectedVersion: live.version,
    }, { observedState: ACTIVE, observedVersion: live.version });
  }

  return { readVersion, attemptOf, effectOf, sendOnce, noteNoStart, driveState, activateOwnCreate, refuseRecordedEdits };
}

module.exports = {
  createWorkflowDriver,
  completionBytesFor,
  completionWithin,
  COMPLETION_TOO_LARGE,
  HASH_BOUND,
  NAME_BOUND,
  createCopyGuard,
  answeredRefusal,
  causeChain,
  leavesOutcomeOpen,
  coded,
  STATE_BODY,
  ACTIVE,
  DRAFT,
};
