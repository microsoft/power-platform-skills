'use strict';
// Declared reconciliation of a business process flow the build REUSES (businessProcessFlows[] with
// reconcile: "declared").
//
// The stage and step edits stay where they are: lib/bpf-stages.js decides which are safe (nothing is ever
// removed or moved) and sdk-build's applyBpfStages writes them in one push. What a declared flow adds:
//   - its explicit `description` and `order` converge (an undeclared one is left alone);
//   - the flow is BOUND: the build records what it last applied (stages, steps, their columns and
//     required flags, plus the declared metadata), so a flow changed outside the spec since then is drift
//     and is not overwritten without approval, and a flow the spec has never managed needs adoption
//     approval before the first edit — the same rules as every other declared artifact;
//   - a no-op writes nothing.
// Stage and step names stay strings: the SDK edits the label in its configured language and keeps the
// others, which is why a rename here never touches another language's label.
//
// SDK facts this rests on (measured against the vendored bundle, pinned in bpf-reconcile-real-bundle.test.js):
//   - `order` (workflow.processorder) always reads back (100 when never set), so `/order` can be updated;
//   - `description` reads back only when the row holds a non-empty one, and the SDK refuses to create a
//     path that is not there (updateElement and addElement both throw PATH_NOT_FOUND). A description the
//     flow does not have yet is therefore written to the row with updateRecord AFTER any push (a write in
//     between would move the row's version under the SDK's conditional push, a 412). It is the same
//     column the SDK's own header PATCH writes on an Active flow, so it needs no deactivation.

const { emptyResult, refusal, isAuthorized, lookupBinding, bindingRecord, driftVerdict, pushIfChanged, intentSha256, canonicalJson, PRE_WRITE_CODES } = require('./reconcile-common.js');

const KIND = 'business-process-flow';
const ARTIFACT = 'bpf';
const MAX_DESCRIPTION = 2000;
// The codes with which the SDK refuses a flow edit BEFORE it sends anything — the push-time refusals of
// reconcile-common plus the two the BPF adapter raises (NOT_IMPLEMENTED for a stage list it cannot author,
// PATH_NOT_FOUND for an element that is not there). Mirrors sdk-build's BPF_EDIT_NOT_WRITTEN.
const BPF_NOT_WRITTEN = new Set([...PRE_WRITE_CODES, 'NOT_IMPLEMENTED', 'PATH_NOT_FOUND']);

const lc = (v) => String(v == null ? '' : v).toLowerCase();
const isDeclaredBpf = (flow) => !!flow && flow.reconcile === 'declared';
const bpfKey = (flow) => `${lc(flow.entity)}/${String(flow.name)}`;

function validateDeclaredBpf(flow) {
  const errors = [];
  if (flow.description !== undefined && (typeof flow.description !== 'string' || flow.description.length > MAX_DESCRIPTION)) {
    errors.push(`description must be text of at most ${MAX_DESCRIPTION} characters`);
  }
  if (flow.order !== undefined && !(Number.isInteger(flow.order) && flow.order >= 0)) errors.push('order must be a whole number of 0 or more');
  return errors;
}

// What a declared flow owns, and what --verify compares: the ordered stages with their ordered steps
// (name, column, required), plus the description and order only when the spec declares them.
// `artifact` is the SDK's BpfArtifact (stages[].steps[].fieldName) or bpfDef's mapping of a spec flow.
function projectBpfForVerify(artifact, owned = {}) {
  const a = artifact || {};
  const out = {
    stages: (a.stages || []).map((st) => ({
      name: String(st.name || ''),
      steps: (st.steps || []).map((p) => ({ name: String(p.name || ''), field: lc(p.fieldName), required: p.required === true })),
    })),
  };
  if (owned.description) out.description = String(a.description || '');
  if (owned.order) out.order = a.order === undefined || a.order === null ? null : Number(a.order);
  return out;
}

const ownedOf = (flow) => ({ description: flow.description !== undefined, order: flow.order !== undefined });

// bpfDef is required lazily: sdk-build is the module that will call this one.
function desiredProjection(flow) {
  const { bpfDef } = require('./sdk-build.js');
  return projectBpfForVerify(bpfDef(flow), ownedOf(flow));
}

/**
 * Plan the declared metadata of an EXISTING flow. Call it after inspectBpfStages, which fetched the
 * deployed flow into the workspace (`fetched: true`); otherwise it fetches the deployed flow itself.
 *   plan: { key, flowId, action: null|'noChange'|'update', order?, description?, descriptionViaRecord,
 *           stagesDiffer, desiredSha, refused, unknown, origin }
 * A refused or unknown plan means the build must not apply the flow's stage edits either.
 */
async function planBpfMetadata({ flow, flowId, sdk, fetched = false, created = false }, ctx = {}) {
  const key = bpfKey(flow);
  const plan = { key, flowId, action: null, descriptionViaRecord: false, stagesDiffer: false, refused: [], unknown: [], origin: created ? 'created' : 'adopted' };
  if (!isDeclaredBpf(flow)) return plan;
  const problems = validateDeclaredBpf(flow);
  if (problems.length) {
    plan.refused.push(refusal(key, 'bpf-spec-invalid', problems.join('; ')));
    return plan;
  }
  let live;
  try {
    live = fetched ? await sdk.getArtifact(ARTIFACT, flowId) : await sdk.fetchArtifact(ARTIFACT, flowId, { overwrite: true });
  } catch (_) {
    live = null;
  }
  if (!live || !Array.isArray(live.stages)) {
    plan.unknown.push(refusal(key, 'bpf-unreadable', 'the business process flow could not be read'));
    return plan;
  }
  const owned = ownedOf(flow);
  const liveView = projectBpfForVerify(live, owned);
  const desired = desiredProjection(flow);
  plan.desiredSha = intentSha256(desired);

  const binding = await lookupBinding(ctx, KIND, key);
  if (binding) plan.origin = binding.origin === 'created' ? 'created' : 'adopted';
  // The binding was recorded under whatever the spec owned THEN: a spec that has since started (or
  // stopped) declaring its description or order must not read as drift, so the live flow is matched under
  // each ownership the binding may have been recorded with.
  const recordedUnder = binding && [false, true].flatMap((d) => [false, true].map((o) => intentSha256(projectBpfForVerify(live, { description: d, order: o }))))
    .find((sha) => sha === binding.intentSha256);
  const verdict = driftVerdict(binding, recordedUnder || intentSha256(liveView), plan.desiredSha);
  if (verdict === 'unbound' && !created && !isAuthorized(ctx.authorizedAdoption, key)) {
    plan.refused.push(refusal(key, 'bpf-adoption-not-authorized', 'this business process flow exists and the spec has not managed it before; approve adopting it first'));
    return plan;
  }
  if (verdict === 'drift' && !isAuthorized(ctx.authorizedOverwrite, key)) {
    plan.refused.push(refusal(key, 'bpf-drift', 'the business process flow was changed outside the spec since the last build; refresh the spec or approve the overwrite'));
    return plan;
  }
  if (owned.order && liveView.order !== desired.order) plan.order = desired.order;
  if (owned.description && liveView.description !== desired.description) {
    plan.description = desired.description;
    plan.descriptionViaRecord = live.description === undefined;
  }
  plan.stagesDiffer = canonicalJson(liveView.stages) !== canonicalJson(desired.stages);
  plan.action = plan.order === undefined && plan.description === undefined && !plan.stagesDiffer ? 'noChange' : 'update';
  return plan;
}

/**
 * Apply a planned metadata edit. `pushStages`, when the build has stage edits to apply, is the call
 * that applies them and pushes (applyBpfStages): the metadata edits are made on the same workspace copy
 * first, so ONE push carries both. Without it, a metadata edit is pushed here.
 */
async function applyBpfMetadata(plan, { sdk, pushStages } = {}, ctx = {}) {
  const result = emptyResult();
  result.refused.push(...plan.refused);
  result.unknown.push(...plan.unknown);
  if (plan.refused.length || plan.unknown.length || !plan.action) return result;
  const record = () => bindingRecord(ctx, { kind: KIND, key: plan.key, id: plan.flowId, intentSha256: plan.desiredSha, origin: plan.origin });
  if (plan.action === 'noChange') {
    result.unchanged.push({ key: plan.key, kind: KIND, id: plan.flowId });
    result.managedBindings.push(record());
    return result;
  }
  // Stages that differ with no stage edit to apply: the stage plan refused it (a removal or a move) or
  // could not compare. Recording the binding would claim stages the flow does not have, and a refusal
  // writes nothing, so the metadata waits too.
  if (plan.stagesDiffer && typeof pushStages !== 'function') {
    result.refused.push(refusal(plan.key, 'bpf-stage-edit-refused', 'the flow\'s stages differ from the spec and their edit was not applied; nothing was written'));
    return result;
  }
  try {
    if (plan.order !== undefined) await sdk.updateElement(ARTIFACT, plan.flowId, '/order', plan.order);
    if (plan.description !== undefined && !plan.descriptionViaRecord) await sdk.updateElement(ARTIFACT, plan.flowId, '/description', plan.description);
  } catch (err) {
    result.refused.push(refusal(plan.key, 'bpf-rejected', `the SDK refused the edit before writing it (${(err && err.code) || 'error'})`));
    return result;
  }
  if (typeof pushStages === 'function') {
    try {
      await pushStages();
    } catch (err) {
      if (BPF_NOT_WRITTEN.has(err && err.code)) result.refused.push(refusal(plan.key, 'bpf-rejected', `the flow was not saved (${err.code})`));
      else result.unknown.push(refusal(plan.key, 'bpf-write-unknown', 'the flow write did not report its outcome; check the flow'));
      return result;
    }
  } else {
    const pushed = await pushIfChanged(sdk, ARTIFACT, plan.flowId);
    if (pushed.outcome === 'refused') {
      result.refused.push(refusal(plan.key, 'bpf-rejected', `the flow was not saved (${pushed.code})`));
      return result;
    }
    if (pushed.outcome === 'unknown') {
      result.unknown.push(refusal(plan.key, 'bpf-write-unknown', 'the flow write did not report its outcome; check the flow'));
      return result;
    }
  }
  if (plan.description !== undefined && plan.descriptionViaRecord) {
    try {
      await sdk.updateRecord('workflow', plan.flowId, { description: plan.description });
    } catch (_) {
      // Anything the push above wrote stays written; the row's description is then not known.
      result.unknown.push(refusal(plan.key, 'bpf-write-unknown', 'the flow description write did not report its outcome; check the flow'));
      return result;
    }
  }
  result.saved.push({ key: plan.key, kind: KIND, id: plan.flowId });
  result.managedBindings.push(record());
  return result;
}

/** The binding for a declared flow this build has just created from bpfDef, so the next build edits it. */
function createdBpfBinding(flow, flowId, ctx = {}) {
  return bindingRecord(ctx, { kind: KIND, key: bpfKey(flow), id: flowId, intentSha256: intentSha256(desiredProjection(flow)), origin: 'created' });
}

module.exports = {
  isDeclaredBpf,
  bpfKey,
  validateDeclaredBpf,
  projectBpfForVerify,
  planBpfMetadata,
  applyBpfMetadata,
  createdBpfBinding,
  BPF_NOT_WRITTEN,
};
