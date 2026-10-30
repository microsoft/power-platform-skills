'use strict';

// The build's ONE way to owe and to make an app publication — the port features use (`ctx.publication`).
//
// Features never publish the app themselves. They `queue` what they leave owed (a theme saved with publish:false, a page
// placed as a draft, a view's table) and the build flushes it once, at the end, through `appWrite` — the build's own app
// writers (sdk-build.js appWriters), which publish through the SAME SDK instance as every other write of the app. That is
// what keeps an exact Main-form obligation binding: the SDK withholds (APP_MAIN_FORM_PUBLISH_WITHHELD) or refuses
// (APP_MAIN_FORM_PUBLISH_CONFLICT) any publish of an app whose exact membership it has not yet seen published, and only
// a publish that goes through that instance is subject to it. A raw PublishXml (appWriters.publishPinned) or a second
// SDK client would not be, so once an app holds an exact obligation they are refused here.

const { exactMembershipOutcome } = require('./app-components.js');

const WITHHELD = new Set(['APP_MAIN_FORM_PUBLISH_WITHHELD', 'APP_MAIN_FORM_PUBLISH_CONFLICT']);
const guidKey = (id) => String(id || '').replace(/^\{|\}$/g, '').toLowerCase();

function policyError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function createAppPublication({ appWrite } = {}) {
  // Owed publications, in queue order, one per kind+id; each keeps every reason it was queued for.
  const owed = new Map();
  // Apps whose exact Main-form membership was requested this run: appId -> { done, reason }.
  const exact = new Map();

  const port = {
    appWrite,
    // target: { kind: 'app'|'table'|'form'|…, id, reason }. Non-app kinds are recorded for the build's existing
    // publication of those artifacts; only 'app' is flushed here.
    queue(target) {
      if (!target || !target.kind || !target.id) throw policyError('PUBLICATION_TARGET_INVALID', 'a queued publication needs a kind and an id');
      const key = `${target.kind}:${guidKey(target.id)}`;
      const entry = owed.get(key) || { kind: target.kind, id: target.id, reasons: [] };
      if (target.reason && !entry.reasons.includes(target.reason)) entry.reasons.push(target.reason);
      owed.set(key, entry);
    },
    owed: () => [...owed.values()].map((entry) => ({ ...entry, reasons: [...entry.reasons] })),
    // Record what an exact-mode push proved (PushResult.appMainForms). Called for EVERY push of an app that asked for
    // exact membership; the last answer stands. A push that published the proven layer settles the app's publication.
    recordExact(appId, pushed, appName = appId) {
      const outcome = exactMembershipOutcome(pushed, appName);
      exact.set(guidKey(appId), outcome);
      if (outcome.done) owed.delete(`app:${guidKey(appId)}`);
      return outcome;
    },
    // The raw PublishXml of an app (publishPinned) skips the SDK's exact-membership guard, so it is refused for an app
    // that holds an exact obligation; the caller publishes through appWrite.publish instead.
    assertRawPublishAllowed(appId) {
      if (exact.has(guidKey(appId))) {
        throw policyError('APP_PUBLISH_BYPASS_REFUSED', `app '${appId}' holds an exact Main-form obligation, so it is published only through the build's SDK writer`);
      }
    },
    // Exact obligations not yet proven published: each makes the build nonzero.
    unsettled: () => [...exact.entries()].filter(([, outcome]) => !outcome.done).map(([appId, outcome]) => ({ appId, reason: outcome.reason })),
    // Publish every owed app once, through appWrite.publish. Answers { published, withheld, failed }: a withheld publish
    // stays owed (the saved change is on the app's pending layer) and is reported by code, never retried here.
    async flush() {
      const out = { published: [], withheld: [], failed: [] };
      for (const [key, entry] of [...owed.entries()].filter(([, e]) => e.kind === 'app')) {
        if (!appWrite || typeof appWrite.publish !== 'function') {
          out.failed.push({ id: entry.id, code: 'APP_PUBLICATION_UNAVAILABLE' });
          continue;
        }
        let failure;
        try {
          // The SDK's PublishResult: { type, id, shipped, publish: { kind: 'submitted'|'verified'|'unverifiable'|'failed', error? } }.
          // A withheld exact publish comes back as kind 'failed' with the SdkError, not as a throw — both are read.
          const answer = await appWrite.publish(entry.id);
          if (answer && answer.publish && answer.publish.kind === 'failed') failure = answer.publish.error || { code: 'APP_PUBLISH_FAILED' };
        } catch (error) {
          failure = error || { code: 'APP_PUBLISH_FAILED' };
        }
        if (!failure) {
          owed.delete(key);
          out.published.push(entry.id);
          continue;
        }
        const code = failure.code || 'APP_PUBLISH_FAILED';
        (WITHHELD.has(code) ? out.withheld : out.failed).push({ id: entry.id, code });
      }
      return out;
    },
  };
  return port;
}

module.exports = { createAppPublication };
