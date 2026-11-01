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
//   - A write whose answer is lost is proved by a fresh read of the row, never by sending it again. Only a definite
//     refusal (a 4xx to the first send of the request, or 412) is recorded `definite-no-start`, which is what lets the
//     next run send it once more.
//   - The state change is the measured state-only path: `updateRecord` -> one `PATCH workflows(<id>)` with exactly
//     { statecode, statuscode }. With a row version (the conditional-edit switch) it is sent through the plugin's HTTP
//     client instead, because `updateRecord` cannot carry an `If-Match` header.
//     See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/perform-conditional-operations-using-web-api

const { normalizeGuid } = require('./reconcile-common.js');
const { withWorkflowEffect } = require('./managed-feature-contract.js');
const { runWithWorkflowEffect } = require('./workflow-effect-context.js');
const { CODES } = require('./managed-bindings.js');
const { HTTP_SEND_HISTORY } = require('./sdk-http-client.js');

const ACTIVE = 'Active';
const DRAFT = 'Draft';
// The state-only body of each workflow state. The effect gate accepts exactly these pairs for a state effect.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/workflow#statecode-choicesoptions
const STATE_BODY = { Draft: { statecode: 0, statuscode: 1 }, Active: { statecode: 1, statuscode: 2 } };

function coded(code, message, extra = {}) {
  return Object.assign(new Error(message), extra, { code });
}

// The SDK throws a service answer as
//   Error 'HTTP 400 from <url>: …' { code: 'CONNECTION_ERROR', statusCode: 400, url, cause: <the response body> }
// and the plugin's client marks that body with HTTP_SEND_HISTORY ({ sends, earlierAmbiguous }), so the facts that
// decide whether a write started are spread over a short cause chain.
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

/**
 * A 4xx answer to the first send of this request (not a timeout, not throttling) that leaves nothing open: the
 * write did not start. Anything else may have started, and is proved by reading, never by sending again.
 */
function isDefiniteRefusal(err) {
  const chain = causeChain(err);
  if (leavesOutcomeOpen(chain)) return false;
  const answered = chain.find((e) => {
    const status = e.statusCode != null ? e.statusCode : e.status;
    return Number.isInteger(status) && status >= 400 && status < 500 && status !== 408 && status !== 429;
  });
  if (!answered) return false;
  if (answered.statusCode === 412 || answered.status === 412) return true;
  const history = answered.cause && typeof answered.cause === 'object' ? answered.cause[HTTP_SEND_HISTORY] : null;
  return Boolean(history) && history.earlierAmbiguous === false;
}

/**
 * The write driver of one declared workflow (`family`/`key` in the store).
 * @param {object} o
 *   store, sdk           the managed binding handle and the gated maker SDK
 *   httpClient, instanceUrl  the plugin's client, for a state change that carries If-Match (switch path only)
 *   family, key, label   the store group and the text errors name it by
 *   noun                 what the row is called in messages ('rule', 'process flow')
 *   driftCode            the family's drift code ('rule-drift', 'bpf-drift')
 */
function createWorkflowDriver({ store, sdk, httpClient = null, instanceUrl = null, family, key, label, noun, driftCode }) {
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
  // Send one write inside its effect context: a stored record (definitely-unsent) is sent under that record, else a
  // new record is persisted first. Answers the error the write ended with, or null; never throws a write failure.
  async function sendOnce(token, stored, effect, write) {
    try {
      const res = stored ? await runWithWorkflowEffect(stored, () => write()) : await withWorkflowEffect({ store, effect: { attemptToken: token, baseGeneration: attemptOf(token).attempt.baseGeneration, family, key, ...effect } }, () => write());
      if (res && res.saved === false) return res.error || coded(CODES.notSettled, 'the SDK reported the write as not saved');
      if (res && Number.isInteger(res.status) && (res.status < 200 || res.status >= 300)) return Object.assign(new Error(`HTTP ${res.status}`), { statusCode: res.status, cause: res.body });
      return null;
    } catch (err) {
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

  /**
   * Bring this attempt's row to `state` with one state effect, proved by reading. An effect already dispatched is
   * proved, never sent again; a definitely-unsent one is sent under its own record.
   */
  async function driveState(token, id, state, version, { conditional }) {
    let effect = effectOf(token, (e) => e.effect === 'state' && e.desiredState === state);
    let failure = null;
    if (!effect || effect.state === 'definitely-unsent') {
      if (conditional && !version) throw coded(driftCode, `${label}: no row version was read, so a conditional state change cannot be sent`);
      failure = await sendOnce(token, effect, {
        rowId: id, effect: 'state', request: { method: 'PATCH', shape: 'workflow-patch' }, desiredSha256: null, desiredState: state, expectedVersion: version || null,
      }, sendState(id, state, version));
      effect = effectOf(token, (e) => e.effect === 'state' && e.desiredState === state);
    }
    if (effect.state === 'confirmed') return;
    const row = await readVersion(id);
    if (row && row.state === state) { store.confirmEffect(effect.token, { observedState: state }); return; }
    if (effect.state === 'definitely-unsent') {
      throw coded(driftCode, `${label}: the ${noun} changed on the server after it was read, so setting it ${state} was refused; it is not retried`, { cause: failure });
    }
    if (failure && isDefiniteRefusal(failure)) {
      noteNoStart(effect);
      throw coded('workflow-state-path-unavailable', `${label}: setting the ${noun} ${state} was refused (${failure.message}); the row is kept as it is and nothing is deleted`, { cause: failure });
    }
    throw coded(CODES.pending, `${label}: setting the ${noun} ${state} is not proved yet; it is not sent again. Re-run the build to prove it`, { cause: failure });
  }

  return { readVersion, attemptOf, effectOf, sendOnce, noteNoStart, driveState };
}

module.exports = {
  createWorkflowDriver,
  isDefiniteRefusal,
  causeChain,
  leavesOutcomeOpen,
  coded,
  STATE_BODY,
  ACTIVE,
  DRAFT,
};
