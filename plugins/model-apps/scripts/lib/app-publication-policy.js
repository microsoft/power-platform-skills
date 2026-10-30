'use strict';

// The build's ONE way to owe and to make an app publication — the port features use (`ctx.publication`).
//
// Features never publish the app themselves. They `queue` what they leave owed (a theme saved with publish:false, a page
// placed as a draft, a view's table). Every app publish of the build — its own existing ones and the final flush — goes
// through `publishApp`, which calls `appWrite.publish`: the build's own app writers (sdk-build.js appWriters), which
// publish through the SAME SDK instance as every other write of the app. So one publish pays everything queued for the
// app before it, and the flush publishes only what no publish has paid yet. Going through that instance is also what
// keeps an exact Main-form obligation binding: the SDK withholds (APP_MAIN_FORM_PUBLISH_WITHHELD) or refuses
// (APP_MAIN_FORM_PUBLISH_CONFLICT) any publish of an app whose exact membership it has not yet seen published, and only a
// publish through that instance is subject to it. A raw PublishXml (appWriters.publishPinned) or a second SDK client
// would not be, so once an app holds an exact obligation they are refused here.
//
// An exact obligation is settled by proof, never by a publish having happened: after EVERY app publish that did not
// fail, the port reads the app's PUBLISHED layer back (publishedMainFormsProof) and settles only on 'matches'. A proof
// holds for one publish only: a publish ships whatever the app's unpublished layer holds at that moment, and another
// writer can change the membership between two publishes of one build (the SDK releases its own exact guard once it has
// seen the list published, so its later publish is a plain PublishXml). So each later publish proves again, and an
// earlier match does not survive a later 'differs' or 'unreadable'. A publish whose answer was lost may have shipped
// anything, so it un-proves the app until a later publish proves it; a publish refused by value (kind 'failed')
// shipped nothing, so the published layer, and what was proven about it, stand.
//
// A queued non-app target (a table whose view or form changed) is handed to its scope, in `scopes[kind]`:
//   owe(target)     -> true when the build's own publication of that scope will publish it (phase 8, for a table). The
//                      debt stays HERE, marked deferred, until the build reports that publication's outcome
//                      (noteScopePublished); a deferred target the build never reported on is published by the flush.
//   publish(target) -> publishes it, at flush, and answers the SDK's PublishResult
//                      ({ type, id, shipped, publish: { kind, error? } }); a throw is a failure too.
// The answer is typed: a debt is paid only by publish.kind 'submitted' | 'verified' | 'unverifiable' (PublishXml was
// accepted; 'unverifiable' only means its read-back was not possible, as publishTargets in sdk-build.js reads it).
// 'failed' — which the SDK answers BY VALUE, never as a throw; a 403 PublishXml comes back as
//   { publish: { kind: 'failed', error: { code: 'CONNECTION_ERROR', statusCode: 403 } } }
// — and any other answer keep the target owed and report it in flush().failed, so a requested feature's publication
// never reads as done when it was not.
// A kind with no scope is never silently dropped: it stays owed and `unsettled` reports it (PUBLICATION_SCOPE_UNBRIDGED).

const { exactMembershipOutcome, publishedMainFormsProof } = require('./app-components.js');

const WITHHELD = new Set(['APP_MAIN_FORM_PUBLISH_WITHHELD', 'APP_MAIN_FORM_PUBLISH_CONFLICT']);
const PUBLISHED = new Set(['submitted', 'verified', 'unverifiable']);

// Why a scope's publish answer does not pay its debt; undefined when it does (the answer shape: see the file header).
function scopeFailure(answer) {
  const kind = answer && answer.publish && answer.publish.kind;
  if (PUBLISHED.has(kind)) return undefined;
  if (kind === 'failed') return { code: (answer.publish.error && answer.publish.error.code) || 'PUBLISH_FAILED' };
  return { code: 'PUBLICATION_UNCONFIRMED' };
}
const guidKey = (id) => String(id || '').replace(/^\{|\}$/g, '').toLowerCase();

function policyError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// client: the DataverseClient of the build's SDK (provision.dataverse), for the published-layer proof.
function createAppPublication({ appWrite, client, scopes = {} } = {}) {
  // Owed publications, in queue order, one per kind+id; each keeps every reason it was queued for.
  const owed = new Map();
  // Apps whose exact Main-form membership was requested this run: appId -> { done, reason, name, mainFormsByTable }.
  const exact = new Map();
  const scopeOf = (kind) => (scopes && typeof scopes[kind] === 'object' ? scopes[kind] : null);

  async function notePublished(appId) {
    const key = guidKey(appId);
    owed.delete(`app:${key}`);
    const entry = exact.get(key);
    if (!entry) return null;
    // This publish is proven on its own (see the file header): an earlier match does not carry over, and if the read
    // below cannot be made the app stays unproven.
    entry.done = false;
    entry.reason = `app '${entry.name}': exact Main forms were published, but the published layer was not read back`;
    if (!client || typeof client.get !== 'function' || !entry.mainFormsByTable) {
      entry.reason = `app '${entry.name}': exact Main forms were published, but this build cannot read the published layer back to prove them; re-run to verify`;
      return { done: false, reason: entry.reason };
    }
    const proof = await publishedMainFormsProof(client, appId, entry.mainFormsByTable);
    if (proof.published === 'matches') {
      entry.done = true;
      entry.reason = undefined;
      return { done: true };
    }
    entry.reason = `app '${entry.name}': exact Main forms were published but the published layer read back as ${proof.published}${proof.reason ? ` (${proof.reason})` : ''}; publish the app and re-run`;
    return { done: false, reason: entry.reason };
  }

  async function publishApp(appId) {
    if (!appWrite || typeof appWrite.publish !== 'function') {
      throw policyError('APP_PUBLICATION_UNAVAILABLE', `app '${appId}' cannot be published: the build has no app writer`);
    }
    // The SDK's PublishResult: { type, id, shipped, publish: { kind: 'submitted'|'verified'|'unverifiable'|'failed', error? } }.
    // It is handed back unchanged, so the caller's own reading of it (the build's partial-push report) still works. A
    // withheld exact publish comes back as kind 'failed' with the SdkError, not as a throw; a throw propagates.
    const entry = exact.get(guidKey(appId));
    let answer;
    try {
      answer = await appWrite.publish(appId);
    } catch (error) {
      // A lost answer may have published the app's whole unpublished layer: what was proven before no longer holds.
      if (entry) {
        entry.done = false;
        entry.reason = `app '${entry.name}': its publish was not answered (${(error && error.code) || 'APP_PUBLISH_FAILED'}), so its published Main forms are unproven; re-run`;
      }
      throw error;
    }
    if (!(answer && answer.publish && answer.publish.kind === 'failed')) await notePublished(appId);
    return answer;
  }

  const port = {
    appWrite,
    // target: { kind: 'app'|'table'|…, id, reason, artifact? }.
    queue(target) {
      if (!target || !target.kind || !target.id) throw policyError('PUBLICATION_TARGET_INVALID', 'a queued publication needs a kind and an id');
      const scope = target.kind === 'app' ? null : scopeOf(target.kind);
      const key = `${target.kind}:${guidKey(target.id)}`;
      const entry = owed.get(key) || { kind: target.kind, id: target.id, reasons: [] };
      if (target.reason && !entry.reasons.includes(target.reason)) entry.reasons.push(target.reason);
      if (target.artifact && !entry.artifact) entry.artifact = target.artifact;
      // Handed to the build's own publication of the scope, but still owed here until that publication's outcome is
      // reported: a deferral is a promise to publish, not a publish. Queued again after a refusal, it is attempted again.
      delete entry.failure;
      if (!entry.deferred && scope && typeof scope.owe === 'function' && scope.owe(target) === true) entry.deferred = true;
      owed.set(key, entry);
    },
    owed: () => [...owed.values()].map((entry) => ({ ...entry, reasons: [...entry.reasons] })),
    // The ids of `kind` deferred to the build's own publication (scope.owe answered true) and not yet reported on.
    deferred: (kind) => [...owed.values()].filter((entry) => entry.kind === kind && entry.deferred).map((entry) => entry.id),
    // The build's own publication of a deferred target ran: `error` is its refusal (sdk-build.js publishTargets'
    // failed[].error), absent when it was published. Published pays the debt; a refusal keeps it owed, and the flush
    // reports it as failed without publishing it again (the build's publication already made its attempt and retry).
    noteScopePublished(kind, id, { error } = {}) {
      const key = `${kind}:${guidKey(id)}`;
      const entry = owed.get(key);
      if (!entry || !entry.deferred) return;
      entry.deferred = false;
      if (error === undefined) owed.delete(key);
      else entry.failure = { code: (error && error.code) || 'PUBLISH_FAILED' };
    },
    // Record what an exact-mode push proved (PushResult.appMainForms). Called for EVERY push of an app that asked for
    // exact membership; the last answer stands. A push that published the proven layer settles the app's publication.
    // The third argument is the app's name, or { name, mainFormsByTable } — the list the published-layer proof compares
    // with after a later publish; without it a later publish cannot settle the obligation.
    recordExact(appId, pushed, nameOrOptions = appId) {
      const options = nameOrOptions && typeof nameOrOptions === 'object' ? nameOrOptions : { name: nameOrOptions };
      const name = options.name || appId;
      const outcome = exactMembershipOutcome(pushed, name);
      exact.set(guidKey(appId), { ...outcome, name, mainFormsByTable: options.mainFormsByTable });
      if (outcome.done) owed.delete(`app:${guidKey(appId)}`);
      return outcome;
    },
    // The raw PublishXml of an app (publishPinned) skips the SDK's exact-membership guard, so it is refused for an app
    // that holds an exact obligation; the caller publishes through publishApp instead.
    assertRawPublishAllowed(appId) {
      if (exact.has(guidKey(appId))) {
        throw policyError('APP_PUBLISH_BYPASS_REFUSED', `app '${appId}' holds an exact Main-form obligation, so it is published only through the build's SDK writer`);
      }
    },
    publishApp,
    // For an app publish the build made outside publishApp (its publish phase's own target list): clears what was owed
    // for the app and proves any exact obligation from the published layer.
    notePublished,
    // What makes the build nonzero: exact obligations not yet proven published, and owed targets nothing can publish.
    unsettled: () => [
      ...[...exact.entries()].filter(([, entry]) => !entry.done).map(([appId, entry]) => ({ appId, code: 'APP_MAIN_FORMS_NOT_EXACT', reason: entry.reason })),
      ...[...owed.values()].filter((entry) => entry.kind !== 'app' && !(scopeOf(entry.kind) && typeof scopeOf(entry.kind).publish === 'function'))
        .map((entry) => ({ kind: entry.kind, id: entry.id, code: 'PUBLICATION_SCOPE_UNBRIDGED', reason: `a ${entry.kind} publication of '${entry.id}' was queued, but this build has no way to publish it` })),
    ],
    // Publish every owed target once: apps through publishApp, bridged kinds through their scope. Answers
    // { published, withheld, failed }: a withheld app publish stays owed (the saved change is on the app's pending layer)
    // and is reported by code, never retried here. An unbridged kind is not attempted (see unsettled).
    async flush() {
      const out = { published: [], withheld: [], failed: [] };
      for (const [key, entry] of [...owed.entries()]) {
        let failure;
        if (entry.kind === 'app') {
          try {
            const answer = await publishApp(entry.id);
            if (answer && answer.publish && answer.publish.kind === 'failed') failure = answer.publish.error || { code: 'APP_PUBLISH_FAILED' };
          } catch (error) {
            failure = error || { code: 'APP_PUBLISH_FAILED' };
          }
          if (!failure) { out.published.push(entry.id); continue; }
          const code = failure.code || 'APP_PUBLISH_FAILED';
          (WITHHELD.has(code) ? out.withheld : out.failed).push({ id: entry.id, code });
          continue;
        }
        const scope = scopeOf(entry.kind);
        if (!scope || typeof scope.publish !== 'function') continue;
        const reasons = [...entry.reasons];
        if (entry.failure) { out.failed.push({ kind: entry.kind, id: entry.id, code: entry.failure.code, reasons }); continue; }
        // A deferred target reaches this point only when the build never reported its own publication of it.
        let failed;
        try {
          failed = scopeFailure(await scope.publish({ kind: entry.kind, id: entry.id, artifact: entry.artifact, reasons }));
        } catch (error) {
          failed = { code: (error && error.code) || 'PUBLISH_FAILED' };
        }
        entry.deferred = false;
        if (!failed) { owed.delete(key); out.published.push(entry.id); continue; }
        entry.failure = failed;
        out.failed.push({ kind: entry.kind, id: entry.id, code: failed.code, reasons });
      }
      return out;
    },
  };
  return port;
}

module.exports = { createAppPublication };
