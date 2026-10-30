'use strict';
// Declared reconciliation of a business process flow (businessProcessFlows[] with reconcile: "declared").
//
// lib/bpf-stages.js still decides which stage and step edits are safe (nothing is ever removed or moved, nothing goes to
// another table) and sdk-build's inspectBpfStages still reads the deployed flow for it. What a declared flow adds:
//   - a FULL ownable projection is the baseline: effective description ("" when the row has none), order (the SDK reads
//     100 when it was never set), status, and the ordered stages with their steps — ids, names, table, column and
//     required flag. Declared parts are laid over the live ones; a part the spec does not declare keeps its live value
//     (an omitted status is preserved), and drift is judged per written part (reconcile-common.js:partsDriftVerdict);
//   - a description the row does not have yet is ADDED at the artifact root (`addElement('bpf', id, '', {description})`,
//     proved against the vendored bundle) and an existing one updated at `/description`; order and status are element
//     updates; every one of them is a local edit of the workspace copy, and ONE guarded push carries them all together
//     with the stage edits — never a second write after the push;
//   - every new stage and step is given its id BEFORE anything is changed, from the creation port, and is added with that
//     id: the push writes the ids into the flow's XAML, and the platform materializes its processstage rows from it, so
//     a retry after a lost answer writes the same ids instead of a second copy (no child row is ever POSTed directly).
//     Later children are asked for in the flow's OWN creation family (kind 'business-process-flow', the flow's key)
//     with the flow's actual id as `identity.parentId`, so a recomputable-identity port derives a stage added later
//     under the same root as one created with the flow — and under the imported flow's id for a flow it did not create;
//   - nothing is bound from what was SENT: after the push the flow is read again by id (fetch with overwrite) and must
//     be the declared table's flow, hold every new child id, and project to exactly the intended parts — otherwise
//     the result is create-completion-required (a new child is missing) or unknown, with no binding;
//   - a flow an id names (a binding, a lookup row) is checked to be that id AND the declared table's flow before any
//     edit is planned, so a stale binding or a lookup that matched another table never edits a stranger;
//   - a supplied stage list the stage plan refuses (a removal, a move, another table) refuses the WHOLE request, the
//     metadata and status included; one that cannot be compared is an unknown outcome. Nothing is written for either.
// BPF activation is not PublishXml: this records no publication scope.
//
// buildDeclaredBpf is the whole declared path for one flow, which the build runs instead of its own find/create/edit
// code: resolve the row (binding first, then by name), create a new flow through the creation port (the port's root
// id becomes the workflow id and its child ids the stage and step ids; the bundled SDK keeps a caller-supplied root
// id, so there is no random-id fallback), or reconcile an existing one; then settle the result exactly once and give
// the build the flow id and backing table it records for later phases (security-role grants, the app's components).
//
// SDK facts this rests on (pinned in bpf-reconcile-real-bundle.test.js):
//   - fetchArtifact('bpf') answers { id, name, entityLogicalName, status: 'Active'|'Draft', order: 100, stages: [ { id,
//     name, entityLogicalName, steps: [ { id, name, fieldName, required? } ] } ], description? } — `description` only when
//     the row has a non-empty one;
//   - addElement('bpf', id, '/stages', { id, ... }) keeps a caller's stage and step ids, and the push writes them to XAML;
//   - updateElement('bpf', id, '/status', 'Draft') is a local edit the push turns into the state change.

const {
  emptyResult, refusal, isAuthorized, lookupBinding, bindingRecord, boundIdentity, partsDriftVerdict, projectionBaseline,
  pushChecked, canonicalJson, normalizeGuid, PRE_WRITE_CODES,
} = require('./reconcile-common.js');
const { runManagedCreate } = require('./managed-create.js');

const KIND = 'business-process-flow';
const ARTIFACT = 'bpf';
const MAX_DESCRIPTION = 2000;
const DEFAULT_ORDER = 100;
// The codes with which the SDK refuses a flow edit BEFORE it sends anything (sdk-build's BPF_EDIT_NOT_WRITTEN plus the
// push-time refusals). BPF_LEFT_DEACTIVATED is not one: a flow the SDK deactivated and could not reactivate was written.
const BPF_NOT_WRITTEN = new Set([...PRE_WRITE_CODES, 'NOT_IMPLEMENTED', 'PATH_NOT_FOUND']);

const lc = (v) => String(v == null ? '' : v).toLowerCase();
const isDeclaredBpf = (flow) => !!flow && flow.reconcile === 'declared';
const bpfKey = (flow) => `${lc(flow.entity)}/${String(flow.name)}`;
const stageKey = (stage) => `stage:${stage}`;
const stepKey = (stage, step) => `step:${stage}/${step}`;
// The SDK's error codes are UPPER_SNAKE; anything else (a message, a number) is not reported as a code.
const sdkCode = (v) => (typeof v === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(v) ? v : '');

/** Whether an SDK BpfArtifact is the flow `flowId` names, on the declared table. */
function isFlowOf(artifact, flow, flowId) {
  return !!artifact && !!normalizeGuid(flowId) && normalizeGuid(artifact.id) === normalizeGuid(flowId)
    && lc(artifact.entityLogicalName) === lc(flow.entity);
}

function validateDeclaredBpf(flow) {
  const errors = [];
  if (flow.description !== undefined && (typeof flow.description !== 'string' || flow.description.length > MAX_DESCRIPTION)) {
    errors.push(`description must be text of at most ${MAX_DESCRIPTION} characters`);
  }
  if (flow.order !== undefined && !(Number.isInteger(flow.order) && flow.order >= 0)) errors.push('order must be a whole number of 0 or more');
  if (flow.status !== undefined && flow.status !== 'Active' && flow.status !== 'Draft') errors.push('status must be Active or Draft');
  return errors;
}

/** The full ownable projection of an SDK BpfArtifact (or bpfDef's mapping of a spec flow). */
function projectBpfParts(artifact) {
  const a = artifact || {};
  return {
    description: typeof a.description === 'string' ? a.description : '',
    order: a.order === undefined || a.order === null ? DEFAULT_ORDER : Number(a.order),
    status: a.status === 'Draft' ? 'Draft' : 'Active',
    stages: (a.stages || []).map((st) => ({
      id: st.id ? lc(st.id) : null,
      name: String(st.name || ''),
      entity: lc(st.entityLogicalName),
      steps: (st.steps || []).map((p) => ({ id: p.id ? lc(p.id) : null, name: String(p.name || ''), field: lc(p.fieldName), required: p.required === true })),
    })),
  };
}

/** What --verify compares: the full projection without the platform ids. */
function projectBpfForVerify(artifact) {
  const p = projectBpfParts(artifact);
  return { ...p, stages: p.stages.map((s) => ({ name: s.name, entity: s.entity, steps: s.steps.map((t) => ({ name: t.name, field: t.field, required: t.required })) })) };
}

// bpfDef is required lazily: sdk-build is the module that will call this one.
const bpfDefOf = (flow) => require('./sdk-build.js').bpfDef(flow);

/**
 * The stages after the stage plan's edits, in projection form. A child the plan adds has no id yet (null) until the
 * creation port names it; its key is in `childKeys`.
 */
function desiredStages(liveParts, flow, stagePlan) {
  const wanted = bpfDefOf(flow).stages;
  const entity = lc(flow.entity);
  const childKeys = [];
  const stages = stagePlan.target.map((t, j) => {
    const liveStage = t.isNew ? null : liveParts.stages.find((s) => s.id === lc(t.stageId));
    if (t.isNew) childKeys.push(stageKey(t.name));
    const steps = (t.isNew || t.stepsChanged || !liveStage)
      ? wanted[j].steps.map((w, k) => {
        const step = t.steps[k] || {};
        if (!step.stepId) childKeys.push(stepKey(t.name, w.name));
        return { id: step.stepId ? lc(step.stepId) : null, name: String(w.name), field: lc(w.fieldName), required: w.required === true };
      })
      : liveStage.steps;
    return { id: t.isNew ? null : lc(t.stageId), name: String(t.name), entity, steps };
  });
  return { stages, childKeys };
}

function withChildIds(stages, childIds) {
  return stages.map((s) => ({
    ...s,
    id: s.id || lc(childIds[stageKey(s.name)]),
    steps: s.steps.map((t) => ({ ...t, id: t.id || lc(childIds[stepKey(s.name, t.name)]) })),
  }));
}

/**
 * Plan a declared flow the build found (`flowId`), or say it must be created.
 * @param {{ flow: object, flowId: string|null, sdk: object, stageCheck?: { kind: string, plan?: object } }} input
 *   stageCheck — inspectBpfStages' answer for the same flow, made just before (it fetched the deployed flow with
 *   overwrite, and this reads that same workspace copy). Required when the spec supplies stages.
 * plan: { key, flowId, action: null|'noChange'|'update', needsCreate?, liveParts, desiredParts, childKeys, stagePlan,
 *         refused, unknown, origin, bindUnchanged? }
 */
async function planBpfMetadata({ flow, flowId, sdk, stageCheck }, ctx = {}) {
  const key = bpfKey(flow);
  const plan = { key, flow, flowId, action: null, childKeys: [], stagePlan: null, refused: [], unknown: [], origin: 'adopted' };
  if (!isDeclaredBpf(flow)) return plan;
  const problems = validateDeclaredBpf(flow);
  if (problems.length) {
    plan.refused.push(refusal(key, 'bpf-spec-invalid', problems.join('; ')));
    return plan;
  }
  const binding = await lookupBinding(ctx, KIND, key);
  const bound = boundIdentity(binding, { resolvedId: flowId, code: 'bpf-binding-mismatch', key });
  if (bound.refusal) {
    plan.refused.push(bound.refusal);
    return plan;
  }
  if (binding && !flowId) {
    plan.refused.push(refusal(key, 'bpf-bound-row-missing', 'the business process flow this key is bound to was not found; repair the binding explicitly before it can be recreated'));
    return plan;
  }
  const suppliesStages = Array.isArray(flow.stages) && flow.stages.length > 0;
  if (!flowId) {
    // A new flow needs a complete stage list before anything is created (the build creates it through the port).
    if (!suppliesStages) plan.refused.push(refusal(key, 'bpf-spec-invalid', 'a new business process flow needs at least one stage with at least one step'));
    else plan.needsCreate = true;
    return plan;
  }
  const stageKind = stageCheck && stageCheck.kind;
  if (suppliesStages && stageKind !== 'same' && stageKind !== 'edit' && stageKind !== 'refused') {
    plan.unknown.push(refusal(key, 'bpf-unreadable', 'the flow\'s stages could not be compared with the spec, so nothing was written'));
    return plan;
  }
  let live;
  try {
    live = stageCheck ? await sdk.getArtifact(ARTIFACT, flowId) : await sdk.fetchArtifact(ARTIFACT, flowId, { overwrite: true });
  } catch (_) {
    live = null;
  }
  if (!live || !Array.isArray(live.stages)) {
    plan.unknown.push(refusal(key, 'bpf-unreadable', 'the business process flow could not be read'));
    return plan;
  }
  // The row an id resolved to must be that id and the declared table's flow — checked before the stage verdict, so a
  // binding or lookup that points at another table's flow is reported as what it is, and nothing is planned on it.
  if (!isFlowOf(live, flow, flowId)) {
    plan.refused.push(refusal(key, 'bpf-identity-mismatch', `the flow ${normalizeGuid(flowId) || 'found'} is not the declared ${lc(flow.entity)} flow; nothing was written`));
    return plan;
  }
  if (suppliesStages && stageKind === 'refused') {
    plan.refused.push({ ...refusal(key, 'bpf-stage-edit-refused', 'the flow\'s stages cannot be made to match the spec without removing or moving one; nothing was written, the description, order and status included'), refusals: (stageCheck.plan && stageCheck.plan.refusals) || [] });
    return plan;
  }
  if (suppliesStages && stageKind === 'edit') plan.stagePlan = stageCheck.plan;
  plan.liveDescriptionPresent = typeof live.description === 'string';
  const liveParts = projectBpfParts(live);
  const desiredParts = { ...liveParts };
  if (flow.description !== undefined) desiredParts.description = flow.description;
  if (flow.order !== undefined) desiredParts.order = flow.order;
  if (flow.status !== undefined) desiredParts.status = flow.status;
  if (plan.stagePlan) {
    const d = desiredStages(liveParts, flow, plan.stagePlan);
    desiredParts.stages = d.stages;
    plan.childKeys = d.childKeys;
    if (new Set(d.childKeys).size !== d.childKeys.length) {
      plan.refused.push(refusal(key, 'bpf-spec-invalid', 'two new stages, or two new steps of one stage, have the same name'));
      return plan;
    }
  }
  plan.liveParts = liveParts;
  plan.desiredParts = desiredParts;
  if (binding) plan.origin = binding.origin === 'created' ? 'created' : 'adopted';

  if (flow.description === '' && liveParts.description !== '' && !isAuthorized(ctx.authorizedDestructive, key)) {
    plan.refused.push(refusal(key, 'bpf-clear-not-authorized', 'the spec empties the flow\'s description; approve clearing it first'));
    return plan;
  }
  if (canonicalJson(liveParts) === canonicalJson(desiredParts)) {
    plan.action = 'noChange';
    plan.bindUnchanged = !!binding || isAuthorized(ctx.authorizedAdoption, key);
    return plan;
  }
  const verdict = partsDriftVerdict(binding, liveParts, desiredParts);
  if (verdict === 'drift' && !isAuthorized(ctx.authorizedOverwrite, key)) {
    plan.refused.push(refusal(key, 'bpf-drift', 'the business process flow was changed outside the spec since the last build; refresh the spec or approve the overwrite'));
    return plan;
  }
  if (verdict === 'unbound' && !isAuthorized(ctx.authorizedAdoption, key)) {
    plan.refused.push(refusal(key, 'bpf-adoption-not-authorized', 'this business process flow exists and the spec has not managed it before; approve adopting it first'));
    return plan;
  }
  plan.action = 'update';
  return plan;
}

/**
 * The stage plan's element edits on the workspace copy — no push. `idMap` (child key -> id) gives every stage and step
 * the plan adds its id; without it the SDK mints one (the undeclared path's behavior). Each element is found again by id
 * before it is changed, since an insert shifts every index after it; a stage only ever GAINS steps, so the flow stays
 * valid after every operation (the SDK validates after each). The same order sdk-build's applyBpfStages writes in.
 */
async function applyStageElementEdits(sdk, flow, flowId, stagePlan, idMap = null) {
  const wanted = bpfDefOf(flow).stages;
  const withId = (el, k) => (idMap && idMap[k] ? { ...el, id: idMap[k] } : el);
  const stageOf = async (stageId) => {
    const stages = ((await sdk.getArtifact(ARTIFACT, flowId)) || {}).stages || [];
    const index = stages.findIndex((s) => s && s.id === stageId);
    if (index < 0) throw Object.assign(new Error(`stage ${stageId} is not in the flow the SDK holds`), { code: 'PATH_NOT_FOUND' });
    return { index, stage: stages[index] };
  };
  for (let j = 0; j < stagePlan.target.length; j += 1) {
    const target = stagePlan.target[j];
    if (target.isNew) {
      const stage = withId({ ...wanted[j], steps: wanted[j].steps.map((s) => withId(s, stepKey(target.name, s.name))) }, stageKey(target.name));
      await sdk.addElement(ARTIFACT, flowId, '/stages', stage, { position: { index: j } });
      continue;
    }
    const { index } = await stageOf(target.stageId);
    if (target.renamedFrom) await sdk.updateElement(ARTIFACT, flowId, `/stages/${index}/name`, target.name);
    if (!target.stepsChanged) continue;
    const stepsPointer = `/stages/${index}/steps`;
    for (let k = 0; k < target.steps.length; k += 1) {
      const step = target.steps[k];
      if (!step.stepId) {
        await sdk.addElement(ARTIFACT, flowId, stepsPointer, withId(wanted[j].steps[k], stepKey(target.name, wanted[j].steps[k].name)), { position: { index: k } });
        continue;
      }
      const steps = (await stageOf(target.stageId)).stage.steps || [];
      const at = steps.findIndex((s) => s && s.id === step.stepId);
      if (at !== k) await sdk.moveElement(ARTIFACT, flowId, `${stepsPointer}/${at}`, stepsPointer, { index: k });
      const live = steps[at];
      const patch = {};
      if (live.name !== step.name) patch.name = step.name;
      if (String(live.fieldName || '').toLowerCase() !== step.field) patch.fieldName = step.field;
      if ((live.required === true) !== (step.required === true)) patch.required = step.required === true;
      if (Object.keys(patch).length) await sdk.updateElement(ARTIFACT, flowId, `${stepsPointer}/${k}`, patch);
    }
  }
}

async function metadataEdits(sdk, plan) {
  const { liveParts: live, desiredParts: want, flowId } = plan;
  if (want.description !== live.description) {
    if (!plan.liveDescriptionPresent) await sdk.addElement(ARTIFACT, flowId, '', { description: want.description });
    else await sdk.updateElement(ARTIFACT, flowId, '/description', want.description);
  }
  if (want.order !== live.order) await sdk.updateElement(ARTIFACT, flowId, '/order', want.order);
  if (want.status !== live.status) await sdk.updateElement(ARTIFACT, flowId, '/status', want.status);
}

function classifyPush(pushed) {
  if (pushed.outcome === 'saved') return pushed;
  if (pushed.outcome === 'refused' || BPF_NOT_WRITTEN.has(pushed.code)) return { ...pushed, outcome: 'refused' };
  return pushed;
}

function bpfBinding(ctx, key, id, parts, origin) {
  const base = projectionBaseline(parts);
  return bindingRecord(ctx, { kind: KIND, key, id, intentSha256: base.intentSha256, partsSha256: base.partsSha256, origin });
}

/**
 * Apply a plan: local stage edits (with port-given ids for new children), then the metadata and status edits, then ONE
 * push. When the plan adds children, all of it runs inside one creation-port operation, so the ids are reserved before
 * any mutation and a lost answer is recovered by the same ids. A refused or unknown plan writes nothing.
 */
async function applyBpfMetadata(plan, { sdk }, ctx = {}) {
  const result = emptyResult();
  result.refused.push(...plan.refused);
  result.unknown.push(...plan.unknown);
  if (plan.refused.length || plan.unknown.length || !plan.action) return result;
  if (plan.action === 'noChange') {
    result.unchanged.push({ key: plan.key, kind: KIND, id: plan.flowId, managed: plan.bindUnchanged === true });
    if (plan.bindUnchanged) result.managedBindings.push(bpfBinding(ctx, plan.key, plan.flowId, plan.liveParts, plan.origin));
    return result;
  }
  const edit = async (idMap) => {
    if (plan.stagePlan) await applyStageElementEdits(sdk, plan.flow, plan.flowId, plan.stagePlan, idMap);
    await metadataEdits(sdk, plan);
    return classifyPush(await pushChecked(sdk, ARTIFACT, plan.flowId));
  };
  let childIds = {};
  let pushed;
  if (plan.childKeys.length) {
    // The flow's own creation family and key, with the flow's actual id as the parent: the ids a port derives for these
    // keys are the ones it would have given them had the flow been created with them. The port's root id is not used —
    // the flow already has its id (a pass-through port answers a fresh one).
    const identity = { table: lc(plan.flow.entity), name: String(plan.flow.name), parentId: normalizeGuid(plan.flowId) };
    const out = await runManagedCreate(ctx, { kind: KIND, key: plan.key, identity, childKeys: plan.childKeys }, async (ids) => edit(ids.childIds));
    const complete = out.status === 'created' && plan.childKeys.every((k) => normalizeGuid((out.childIds || {})[k]));
    if (complete) {
      childIds = out.childIds;
      pushed = { outcome: 'saved' };
    } else if (out.status === 'refused') {
      // Refused before the push was sent: by the port, by a local element edit (createThroughPort's LOCAL_EDIT_FAILED)
      // or by the SDK's pre-send checks. A push whose answer was lost comes back unknown instead.
      pushed = { outcome: 'refused', code: out.code };
    } else {
      pushed = { outcome: 'unknown', code: out.code };
    }
  } else {
    try {
      pushed = await edit(null);
    } catch (err) {
      // A local element edit threw: the workspace copy is abandoned (the next run fetches with overwrite), nothing was sent.
      pushed = { outcome: 'refused', code: (err && err.code) || 'LOCAL_EDIT_FAILED' };
    }
  }
  if (pushed.outcome === 'refused') {
    result.refused.push(refusal(plan.key, 'bpf-rejected', `the flow was not saved (${pushed.code || 'refused'})`));
    return result;
  }
  if (pushed.outcome !== 'saved') {
    result.unknown.push(refusal(plan.key, 'bpf-write-unknown', 'the flow write did not report its outcome; check the flow'));
    return result;
  }
  const intended = { ...plan.desiredParts, stages: withChildIds(plan.desiredParts.stages, childIds) };
  const newIds = plan.childKeys.map((k) => normalizeGuid(childIds[k]));
  const proof = await proveStoredBpf(sdk, plan.flow, plan.flowId, intended, newIds);
  if (!proof.ok) {
    (proof.outcome === 'refused' ? result.refused : result.unknown).push(proof.reason);
    return result;
  }
  result.saved.push({ key: plan.key, kind: KIND, id: plan.flowId, ...(plan.childKeys.length ? { childIds } : {}) });
  result.managedBindings.push(bpfBinding(ctx, plan.key, plan.flowId, proof.parts, plan.origin));
  return result;
}

/**
 * Read a flow back after a push the SDK acknowledged, and say whether it is what was intended. A saved answer proves the
 * service took the request, not what it stored: a stage the service dropped, or a value it kept from elsewhere, must not
 * become the baseline the next build trusts. Returns { ok: true, parts, artifact } — the OBSERVED parts, which equal the
 * intended ones — or { ok: false, outcome, reason } with:
 *   unknown bpf-stored-unreadable       — the flow could not be read back;
 *   unknown bpf-identity-mismatch       — the id reads back as another flow, or on another table;
 *   refused create-completion-required  — a stage or step id this write was to create is not in the flow: nothing of it
 *                                         is bound, and the next build asks the port for the same ids again;
 *   unknown bpf-stored-mismatch         — the flow holds something other than what was sent.
 */
async function proveStoredBpf(sdk, flow, flowId, intended, newChildIds = []) {
  const key = bpfKey(flow);
  const fail = (outcome, code, message) => ({ ok: false, outcome, reason: refusal(key, code, message) });
  let fresh;
  try {
    fresh = await sdk.fetchArtifact(ARTIFACT, flowId, { overwrite: true });
  } catch (_) {
    fresh = null;
  }
  if (!fresh || !Array.isArray(fresh.stages)) return fail('unknown', 'bpf-stored-unreadable', 'the flow was saved but could not be read back to confirm what it holds; check the flow');
  if (!isFlowOf(fresh, flow, flowId)) return fail('unknown', 'bpf-identity-mismatch', 'the flow read back after the write is not the declared table\'s flow; check the flow');
  const parts = projectBpfParts(fresh);
  const held = new Set(parts.stages.flatMap((s) => [s.id, ...s.steps.map((t) => t.id)]).filter(Boolean));
  const missing = newChildIds.filter((id) => !id || !held.has(id));
  if (missing.length) {
    return fail('refused', 'create-completion-required', `the flow was saved without ${missing.length} of the stages or steps this write adds; run the build again to complete it with the same ids`);
  }
  if (canonicalJson(parts) !== canonicalJson(intended)) return fail('unknown', 'bpf-stored-mismatch', 'the flow read back after the write differs from what was sent; check the flow');
  return { ok: true, parts, artifact: fresh };
}

/**
 * Create a new declared flow through the creation port (kind 'business-process-flow', the flow's key, every stage and
 * step key as a child key). The port's root id becomes the workflow id and its child ids the stage and step ids, and the
 * push writes them all in one request; then the flow is proven by a fresh read before anything is bound.
 * A root or child id that is not a GUID is refused before anything is sent: the bundled SDK keeps a caller-supplied
 * root id, so a flow is never created under an id the port did not give (a retry would otherwise make a second one).
 */
async function applyBpfCreate(flow, { sdk }, ctx = {}) {
  const key = bpfKey(flow);
  const result = emptyResult();
  const def = bpfDefOf(flow);
  const childKeys = def.stages.flatMap((s) => [stageKey(s.name), ...s.steps.map((t) => stepKey(s.name, t.name))]);
  if (new Set(childKeys).size !== childKeys.length) {
    result.refused.push(refusal(key, 'bpf-spec-invalid', 'two stages, or two steps of one stage, have the same name'));
    return result;
  }
  let intended = null;
  let sentRoot = '';
  let sentIds = {};
  const out = await runManagedCreate(ctx, { kind: KIND, key, identity: { table: lc(flow.entity), name: String(flow.name) }, childKeys }, async (ids) => {
    const root = normalizeGuid(ids && ids.id);
    if (!root) return { outcome: 'refused', code: 'CREATE_ROOT_ID_MISSING' };
    const given = {};
    for (const k of childKeys) {
      given[k] = normalizeGuid(ids.childIds && ids.childIds[k]);
      if (!given[k]) return { outcome: 'refused', code: 'CREATE_CHILD_ID_MISSING' };
    }
    const withIds = {
      ...def,
      id: root,
      stages: def.stages.map((s) => ({ ...s, id: given[stageKey(s.name)], steps: s.steps.map((t) => ({ ...t, id: given[stepKey(s.name, t.name)] })) })),
    };
    // A throw here is a local workspace edit: createThroughPort answers it as refused (nothing was sent).
    const art = await sdk.createArtifact(ARTIFACT, withIds);
    if (normalizeGuid(art && art.id) !== root) return { outcome: 'refused', code: 'CREATE_ROOT_ID_REPLACED' };
    intended = projectBpfParts(withIds);
    sentRoot = root;
    sentIds = given;
    // Pushed directly rather than through pushChecked, which reports every unsaved answer as PUSH_NOT_SAVED: a create
    // the SDK refuses because the row already exists answers { saved: false, error: { code: 'ARTIFACT_ALREADY_EXISTS' } },
    // and that code is what tells the maker the flow is someone else's.
    try {
      const pushed = await sdk.pushArtifact(ARTIFACT, root);
      if (pushed && pushed.saved === true) return { outcome: 'saved', code: '' };
      return { outcome: 'refused', code: sdkCode(pushed && pushed.error && pushed.error.code) || 'PUSH_NOT_SAVED' };
    } catch (err) {
      const code = sdkCode(err && err.code);
      if (PRE_WRITE_CODES.has(code)) return { outcome: 'refused', code };
      return { outcome: 'unknown', code: code || 'WRITE_OUTCOME_UNKNOWN' };
    }
  });
  if (out.status === 'refused') {
    const code = out.code === 'ARTIFACT_ALREADY_EXISTS' ? 'bpf-create-collision' : 'bpf-rejected';
    result.refused.push(refusal(key, code, `the flow was not created (${out.code || 'refused'})`));
    return result;
  }
  if (out.status !== 'created' || !intended) {
    result.unknown.push(refusal(key, 'bpf-write-unknown', `the flow create did not report its outcome (${out.code || out.status}); check for a flow named ${String(flow.name)}`));
    return result;
  }
  // The port must settle on the root it gave execute; a created answer naming another id is not this flow's receipt.
  if (normalizeGuid(out.id) !== sentRoot) {
    result.unknown.push(refusal(key, 'creation-settlement-disagreed', 'the creation port answered another id than the flow was created with; check the flow'));
    return result;
  }
  const proof = await proveStoredBpf(sdk, flow, sentRoot, intended, childKeys.map((k) => sentIds[k]));
  if (!proof.ok) {
    (proof.outcome === 'refused' ? result.refused : result.unknown).push(proof.reason);
    return result;
  }
  const uniqueName = lc(proof.artifact.uniqueName) || null;
  result.saved.push({ key, kind: KIND, id: sentRoot, created: true, childIds: { ...sentIds }, uniqueName });
  result.managedBindings.push(bpfBinding(ctx, key, sentRoot, proof.parts, 'created'));
  return result;
}

/**
 * The binding for a declared flow created outside applyBpfCreate (a test's deployed flow): the full projection of the
 * flow as the SDK holds it — or null when the artifact is not `flowId`'s flow on the declared table.
 */
function createdBpfBinding(flow, flowId, artifact, ctx = {}) {
  if (!isFlowOf(artifact, flow, flowId)) return null;
  return bpfBinding(ctx, bpfKey(flow), normalizeGuid(flowId), projectBpfParts(artifact), 'created');
}

// A workflow row as the build's queryRecords answers it: { workflowid: '<guid>', uniquename: 'new_tickethandling', ... }.
const rowId = (row) => normalizeGuid(row && row.workflowid);

/**
 * Find, then create or reconcile, one declared flow. `input`:
 *   flow, sdk;
 *   findById(id)  -> rows   the workflow rows with that id (the build's queryRecords on workflowid), used when the
 *                           flow's key is bound: a bound flow is read by its id, never re-found by name;
 *   findByName()  -> rows   the flows of the spec's name on its table (the build's bpfFilter), used when it is not;
 *   beforeCreate()          awaited just before a create — the build's unique-name clash check; a throw propagates;
 *   inspectStages(sdk, flow, id)  the stage check (default sdk-build's inspectBpfStages), when the spec supplies stages.
 * Returns the FeatureResult with { flowId, uniqueName, action: 'created'|'existing'|null }. A lookup that throws or answers
 * something other than a list is unknown, and two flows of the name with no binding to choose are refused: nothing is
 * written for either.
 */
async function reconcileDeclaredBpf(input, ctx = {}) {
  const { flow, sdk } = input;
  const key = bpfKey(flow);
  const binding = await lookupBinding(ctx, KIND, key);
  const boundId = binding ? normalizeGuid(binding.id) : '';
  const done = (result, flowId = null, uniqueName = null, action = null) => ({ ...result, flowId, uniqueName, action });
  let rows;
  try {
    rows = boundId && typeof input.findById === 'function' ? await input.findById(boundId) : await input.findByName();
  } catch (_) {
    rows = null;
  }
  if (!Array.isArray(rows) || rows.some((r) => !rowId(r))) {
    const result = emptyResult();
    result.unknown.push(refusal(key, 'bpf-lookup-unreadable', 'the business process flows could not be listed, so nothing was written'));
    return done(result);
  }
  let row = null;
  if (boundId) row = rows.find((r) => rowId(r) === boundId) || (rows.length === 1 ? rows[0] : null);
  else if (rows.length > 1) {
    const result = emptyResult();
    result.refused.push(refusal(key, 'bpf-name-ambiguous', `${rows.length} flows named ${String(flow.name)} exist on ${lc(flow.entity)}; bind the spec to one of them by id`));
    return done(result);
  } else row = rows[0] || null;

  const flowId = row ? rowId(row) : null;
  if (!flowId) {
    const plan = await planBpfMetadata({ flow, flowId: null, sdk }, ctx);
    if (!plan.needsCreate) return done(await applyBpfMetadata(plan, { sdk }, ctx));
    if (typeof input.beforeCreate === 'function') await input.beforeCreate();
    const created = await applyBpfCreate(flow, { sdk }, ctx);
    const saved = created.saved[0];
    return done(created, saved ? saved.id : null, saved ? saved.uniqueName : null, saved ? 'created' : null);
  }
  const suppliesStages = Array.isArray(flow.stages) && flow.stages.length > 0;
  const inspect = typeof input.inspectStages === 'function' ? input.inspectStages : require('./sdk-build.js').inspectBpfStages;
  const stageCheck = suppliesStages ? await inspect(sdk, flow, flowId) : undefined;
  const plan = await planBpfMetadata({ flow, flowId, sdk, stageCheck }, ctx);
  const result = await applyBpfMetadata(plan, { sdk }, ctx);
  return done(result, flowId, lc(row.uniquename) || null, 'existing');
}

/**
 * The build's whole declared-flow step. `hooks`:
 *   onCreated(id)   add a flow this build created to the app's solution — before settlement; a throw is refused
 *                   'bpf-solution-membership-failed' while the binding is kept (the row is proven and this spec's, so
 *                   the next build finds it by its binding and adds it then);
 *   settleFeatureResult(phase, label, result) -> { ok }   the build's settlement (S2 createFeatureSettlement), called
 *                   exactly once with phase 'business-process-flows';
 *   onExisting(id)  an existing flow's solution membership, after a clean settlement;
 *   label           the label settlement reports under (default the flow's name).
 * Returns { flowId, backingTable } for the build's output maps, or null when the flow did not settle cleanly.
 */
async function buildDeclaredBpf(input, ctx = {}, hooks = {}) {
  const r = await reconcileDeclaredBpf(input, ctx);
  if (r.action === 'created' && typeof hooks.onCreated === 'function') {
    try {
      await hooks.onCreated(r.flowId);
    } catch (err) {
      r.refused.push(refusal(bpfKey(input.flow), 'bpf-solution-membership-failed', `the flow was created but could not be added to the solution${sdkCode(err && err.code) ? ` (${err.code})` : ''}; the next build adds it`));
    }
  }
  const { flowId, uniqueName, action, ...result } = r;
  const settled = hooks.settleFeatureResult('business-process-flows', hooks.label || String(input.flow.name), result);
  if (!settled || !settled.ok || !flowId) return null;
  if (action !== 'created' && typeof hooks.onExisting === 'function') await hooks.onExisting(flowId);
  return { flowId, backingTable: uniqueName || null };
}

module.exports = {
  KIND,
  isDeclaredBpf,
  bpfKey,
  stageKey,
  stepKey,
  validateDeclaredBpf,
  projectBpfParts,
  projectBpfForVerify,
  planBpfMetadata,
  applyStageElementEdits,
  applyBpfMetadata,
  applyBpfCreate,
  proveStoredBpf,
  reconcileDeclaredBpf,
  buildDeclaredBpf,
  createdBpfBinding,
  BPF_NOT_WRITTEN,
};
