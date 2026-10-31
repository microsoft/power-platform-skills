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
//     Children are asked for in the flow's OWN creation family (kind 'business-process-flow', the flow's key), one
//     nested request per parent: new stages with the flow's actual id as `identity.parentId`, and each stage's new
//     steps with THAT stage's id (its actual id, or the id just reserved for a new stage). So a recomputable-identity
//     port derives a stage added later under the same root as one created with the flow, a step under the stage it
//     belongs to, and both under the imported flow's (or stage's) actual id for a flow it did not create;
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
// code: resolve the row (its binding first; else the id the creation port derives for the flow's key, then the name),
// create a new flow through the creation port only when it protects this kind (the derived root id becomes the
// workflow id and the child ids the stage and step ids; the bundled SDK keeps a caller-supplied root id, so there is
// no random-id fallback), or reconcile an existing one; a create whose push may have been sent but did not answer
// saved is inspected ONCE at the id it was sent with and continued there when the row is present. Then the result is
// settled exactly once — the solution membership of the flow BEFORE anything is recorded — and the build gets the flow
// id and backing table it records for later phases (security-role grants, the app's components), or a never-retry
// halt when it did not settle cleanly.
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
 * The nested reservation levels for the children a write adds: one level per parent, in the order they must run.
 *   - the new stages, under the flow (`rootIdentity`: the flow's actual id as parentId, or none for a create's root);
 *   - then, per stage in order, its new steps under THAT stage: an existing stage's actual id, or the id the level
 *     before reserved for a new one (`ids[stageKey]`), so a step's identity follows the stage it is written into.
 * `stages` is in projection form: a stage or step with id null is new. Levels with nothing to reserve are left out,
 * except the root level of a create (`keepRoot`), which reserves the flow itself.
 */
function childLevels(flow, stages, rootIdentity, keepRoot = false) {
  const base = { table: lc(flow.entity), name: String(flow.name) };
  const levels = [];
  const stageKeys = stages.filter((s) => !s.id).map((s) => stageKey(s.name));
  if (stageKeys.length || keepRoot) levels.push({ identity: () => ({ ...base, ...rootIdentity }), childKeys: stageKeys });
  for (const s of stages) {
    const stepKeys = s.steps.filter((t) => !t.id).map((t) => stepKey(s.name, t.name));
    if (!stepKeys.length) continue;
    levels.push({ identity: (ids) => ({ ...base, parentId: s.id ? normalizeGuid(s.id) : ids[stageKey(s.name)], parentKey: stageKey(s.name) }), childKeys: stepKeys });
  }
  return levels;
}

/**
 * Run the reservation levels nested, each inside the execute of the one before, so every id is reserved before any
 * edit; the innermost execute (`finish(childIds, rootIds)`) makes the edits and the ONE push. The first level is a
 * runManagedCreate whose envelope the caller classifies; an inner level's verdict becomes the answer its parent's
 * execute gives that parent's port:
 *   - created, with the innermost push saved           -> the innermost answer (the SDK's result rides along);
 *   - nothing was sent (a port that threw or refused before the push, a child id that is not a GUID, a local edit
 *     that threw)                                      -> refused;
 *   - the push saved but the inner port did not answer created -> unknown 'creation-settlement-disagreed';
 *   - otherwise                                        -> the innermost answer (unknown).
 * `levels[0].accept(rootIds)` may refuse the first level's ids before anything else runs.
 * Returns { out, childIds, answer }: the first level's runManagedCreate output, every reserved child id, and the
 * innermost answer (null when the push was never attempted).
 */
async function reserveNested(ctx, key, levels, finish) {
  const state = { answer: null, childIds: {} };
  const level = (i) => runManagedCreate(ctx, { kind: KIND, key, identity: levels[i].identity(state.childIds), childKeys: levels[i].childKeys }, async (given) => {
    if (i === 0 && levels[0].accept) {
      const refusedRoot = levels[0].accept(given || {});
      if (refusedRoot) return refusedRoot;
    }
    for (const k of levels[i].childKeys) {
      const id = normalizeGuid(given && given.childIds && given.childIds[k]);
      if (!id) return { outcome: 'refused', code: 'CREATE_CHILD_ID_MISSING' };
      state.childIds[k] = id;
    }
    if (i === levels.length - 1) {
      state.answer = await finish({ ...state.childIds }, given);
      return state.answer;
    }
    const inner = await level(i + 1);
    const answer = state.answer;
    if (inner.status === 'created' && answer && answer.outcome === 'saved') return answer;
    if (!answer || answer.outcome === 'refused') return { outcome: 'refused', code: (answer && answer.code) || inner.code || 'PUSH_NOT_SAVED' };
    if (answer.outcome === 'saved') return { outcome: 'unknown', code: 'creation-settlement-disagreed' };
    return answer;
  });
  const out = await level(0);
  return { out, childIds: state.childIds, answer: state.answer };
}

/**
 * The root id the creation port derives for this flow's key — only when the port protects the kind (a
 * recomputable-identity port: `protects(kind)` and `identityFor(kind, key)` -> { id, childIds }). '' otherwise: a
 * pass-through port allocates a fresh id per call, so there is no id to look for before a create, and a create
 * whose answer is lost could never be found again.
 */
function derivedRoot(ctx, key) {
  const port = ctx && ctx.creates;
  if (!port || typeof port.protects !== 'function' || typeof port.identityFor !== 'function') return '';
  try {
    if (port.protects(KIND) !== true) return '';
    return normalizeGuid((port.identityFor(KIND, key) || {}).id) || '';
  } catch (_) {
    return '';
  }
}

// A workflow row as the build's queryRecords answers it: { workflowid: '<guid>', uniquename: 'new_tickethandling', ... }.
const rowId = (row) => normalizeGuid(row && row.workflowid);

/**
 * Whether the workflow row `id` exists, read through the build's findById (queryRecords on workflowid):
 * { state: 'present', row } | { state: 'absent' } | { state: 'unreadable' }. Strict: a lookup that throws, answers
 * something other than a list of rows with ids, or answers rows none of which is `id` is unreadable — never absence.
 */
async function readFlowRow(input, id) {
  if (typeof input.findById !== 'function') return { state: 'unreadable' };
  let rows;
  try {
    rows = await input.findById(id);
  } catch (_) {
    return { state: 'unreadable' };
  }
  if (!Array.isArray(rows) || rows.some((r) => !rowId(r))) return { state: 'unreadable' };
  if (!rows.length) return { state: 'absent' };
  const row = rows.find((r) => rowId(r) === normalizeGuid(id));
  return row ? { state: 'present', row } : { state: 'unreadable' };
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
    // The flow's own creation family and key, one nested request per parent (childLevels): new stages under the flow's
    // actual id, each stage's new steps under that stage's id. The ids a port derives for these keys are the ones it
    // would have given them had the flow been created with them. The port's root id is not used — the flow already
    // has its id (a pass-through port answers a fresh one).
    const levels = childLevels(plan.flow, plan.desiredParts.stages, { parentId: normalizeGuid(plan.flowId) });
    const { out, childIds: reserved } = await reserveNested(ctx, plan.key, levels, async (ids) => edit(ids));
    const complete = out.status === 'created' && plan.childKeys.every((k) => normalizeGuid(reserved[k]));
    if (complete) {
      childIds = Object.fromEntries(plan.childKeys.map((k) => [k, reserved[k]]));
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
 * Create a new declared flow through the creation port, kind 'business-process-flow' and the flow's key. Only a port
 * that PROTECTS the kind may create it (derivedRoot): the root id it derives for the key is the id the resolver read
 * first, and the id the flow is sent with — any other root is refused before anything is sent, as is a root or child
 * id that is not a GUID (the bundled SDK keeps a caller-supplied root id, so a flow is never created under an id the
 * port did not give, and a retry asks for and finds the same one). The ids are reserved in nested levels
 * (childLevels): the stages under the root, then each stage's steps under that stage's reserved id; the innermost
 * level creates the artifact locally and makes the ONE push. Then the flow is proven by a fresh read before anything
 * is bound.
 * A push that answered anything but saved (thrown or returned) is classified ONCE:
 *   - a code the SDK raises before it sends anything (BPF_NOT_WRITTEN)  -> refused 'bpf-rejected', nothing inspected;
 *   - anything else (a lost answer, CONNECTION_ERROR, ARTIFACT_ALREADY_EXISTS — the request may have been stored, or a
 *     row may already hold the id) -> ONE read of the row at the id it was sent with (`input.findById`):
 *       present    -> { continueAt: row }: the caller reconciles the existing row at that id like any other (its
 *                     identity and the adoption rules apply; nothing is created again);
 *       absent     -> unknown 'create-completion-required' (the next build asks for, and sends, the same ids);
 *       unreadable -> unknown 'create-identity-unverified'.
 * A port that fails after the push answered saved stays unknown 'bpf-write-unknown' with no binding.
 * On success the saved entry keeps the SDK's own push result (`sdkResult`), warnings included.
 * @returns the FeatureResult, plus `continueAt` (a workflow row) when an inspection found the flow.
 */
async function applyBpfCreate(flow, { sdk, findById }, ctx = {}) {
  const key = bpfKey(flow);
  const result = emptyResult();
  const def = bpfDefOf(flow);
  const childKeys = def.stages.flatMap((s) => [stageKey(s.name), ...s.steps.map((t) => stepKey(s.name, t.name))]);
  if (new Set(childKeys).size !== childKeys.length) {
    result.refused.push(refusal(key, 'bpf-spec-invalid', 'two stages, or two steps of one stage, have the same name'));
    return result;
  }
  const derived = derivedRoot(ctx, key);
  if (!derived) {
    result.refused.push(refusal(key, 'create-identity-unsupported', 'the creation port gives this business process flow no stable identity, so it is not created (a retry could not find it again); nothing was sent'));
    return result;
  }
  let intended = null;
  let sentIds = {};
  const projected = def.stages.map((s) => ({ id: null, name: String(s.name), steps: s.steps.map((t) => ({ id: null, name: String(t.name) })) }));
  const levels = childLevels(flow, projected, {}, true);
  levels[0].accept = (ids) => {
    const root = normalizeGuid(ids.id);
    if (!root) return { outcome: 'refused', code: 'CREATE_ROOT_ID_MISSING' };
    if (root !== derived) return { outcome: 'refused', code: 'CREATE_ROOT_ID_NOT_DERIVED' };
    return null;
  };
  const { out, answer } = await reserveNested(ctx, key, levels, async (given) => {
    const withIds = {
      ...def,
      id: derived,
      stages: def.stages.map((s) => ({ ...s, id: given[stageKey(s.name)], steps: s.steps.map((t) => ({ ...t, id: given[stepKey(s.name, t.name)] })) })),
    };
    // A throw here is a local workspace edit: createThroughPort answers it as refused (nothing was sent).
    const art = await sdk.createArtifact(ARTIFACT, withIds);
    if (normalizeGuid(art && art.id) !== derived) return { outcome: 'refused', code: 'CREATE_ROOT_ID_REPLACED' };
    intended = projectBpfParts(withIds);
    sentIds = given;
    // Pushed directly rather than through pushChecked, which reports every unsaved answer as PUSH_NOT_SAVED: the
    // SDK's own answer is kept (sdkResult) and its code decides refused-before-send versus inspect. The SDK answers a
    // failure either way — thrown, or returned as { saved: false, error: { code } } (a lost response is returned as
    // CONNECTION_ERROR, a row that already holds the id as ARTIFACT_ALREADY_EXISTS) — so both are classified alike.
    let pushed;
    try {
      pushed = await sdk.pushArtifact(ARTIFACT, derived);
    } catch (err) {
      const code = sdkCode(err && err.code);
      return BPF_NOT_WRITTEN.has(code) ? { outcome: 'refused', code } : { outcome: 'unknown', code: code || 'WRITE_OUTCOME_UNKNOWN', inspect: true };
    }
    if (pushed && pushed.saved === true) return { outcome: 'saved', code: '', sdkResult: pushed };
    const code = sdkCode(pushed && pushed.error && pushed.error.code);
    if (BPF_NOT_WRITTEN.has(code)) return { outcome: 'refused', code, sdkResult: pushed };
    return { outcome: 'unknown', code: code || 'PUSH_NOT_SAVED', sdkResult: pushed, inspect: true };
  });
  // The push may have reached the service: read the row at the id it was sent with, once — whatever the port made of
  // that answer, since only the row can say whether it was stored.
  if (answer && answer.inspect) {
    const at = await readFlowRow({ findById }, derived);
    if (at.state === 'present') return { ...result, continueAt: at.row };
    if (at.state === 'absent') {
      result.unknown.push(refusal(key, 'create-completion-required', `the flow create did not answer (${answer.code}) and no flow holds its id ${derived}; run the build again to send it with the same ids`));
    } else {
      result.unknown.push(refusal(key, 'create-identity-unverified', `the flow create did not answer (${answer.code}) and the flow at its id ${derived} could not be read; check the flow`));
    }
    return result;
  }
  if (out.status === 'refused') {
    result.refused.push(refusal(key, 'bpf-rejected', `the flow was not created (${out.code || 'refused'})`));
    return result;
  }
  if (out.status !== 'created' || !intended || !answer || answer.outcome !== 'saved') {
    result.unknown.push(refusal(key, 'bpf-write-unknown', `the flow create did not report its outcome (${out.code || out.status}); check the flow at ${derived}`));
    return result;
  }
  // The port must settle on the root it gave execute; a created answer naming another id is not this flow's receipt.
  if (normalizeGuid(out.id) !== derived) {
    result.unknown.push(refusal(key, 'creation-settlement-disagreed', 'the creation port answered another id than the flow was created with; check the flow'));
    return result;
  }
  const proof = await proveStoredBpf(sdk, flow, derived, intended, childKeys.map((k) => sentIds[k]));
  if (!proof.ok) {
    (proof.outcome === 'refused' ? result.refused : result.unknown).push(proof.reason);
    return result;
  }
  const uniqueName = lc(proof.artifact.uniqueName) || null;
  result.saved.push({ key, kind: KIND, id: derived, created: true, childIds: { ...sentIds }, uniqueName, sdkResult: answer.sdkResult });
  result.managedBindings.push(bpfBinding(ctx, key, derived, proof.parts, 'created'));
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

/**
 * Find, then create or reconcile, one declared flow. `input`:
 *   flow, sdk;
 *   findById(id)  -> rows   the workflow rows with that id (the build's queryRecords on workflowid): a bound flow is
 *                           read by its binding's id, never re-found by name; an unbound one is first read at the id
 *                           the creation port derives for its key (when the port protects the kind), and after a
 *                           create that may have been sent, once more at that id;
 *   findByName()  -> rows   the flows of the spec's name on its table (the build's bpfFilter), used when neither id
 *                           names a row;
 *   beforeCreate()          awaited just before a create — the build's unique-name clash check; a throw propagates;
 *   inspectStages(sdk, flow, id)  the stage check (default sdk-build's inspectBpfStages).
 * Returns the FeatureResult with { flowId, uniqueName, action: 'created'|'existing'|null }. A lookup that throws or answers
 * something other than a list is unknown, and two flows of the name with no binding to choose are refused: nothing is
 * written for either. A new flow is created only through a port that protects the kind; otherwise it is refused
 * 'create-identity-unsupported' with nothing sent (an existing flow still reconciles).
 */
async function reconcileDeclaredBpf(input, ctx = {}) {
  const { flow, sdk } = input;
  const key = bpfKey(flow);
  const binding = await lookupBinding(ctx, KIND, key);
  const boundId = binding ? normalizeGuid(binding.id) : '';
  const done = (result, flowId = null, uniqueName = null, action = null) => ({ ...result, flowId, uniqueName, action });
  const stop = (list, code, message) => {
    const result = emptyResult();
    result[list].push(refusal(key, code, message));
    return done(result);
  };
  const byName = async () => {
    let rows;
    try {
      rows = await input.findByName();
    } catch (_) {
      rows = null;
    }
    return Array.isArray(rows) && !rows.some((r) => !rowId(r)) ? rows : null;
  };
  let row = null;
  if (boundId && typeof input.findById === 'function') {
    let rows;
    try {
      rows = await input.findById(boundId);
    } catch (_) {
      rows = null;
    }
    if (!Array.isArray(rows) || rows.some((r) => !rowId(r))) return stop('unknown', 'bpf-lookup-unreadable', 'the business process flows could not be listed, so nothing was written');
    row = rows.find((r) => rowId(r) === boundId) || (rows.length === 1 ? rows[0] : null);
  } else {
    // Identity before name: the row at the derived id is this key's whatever its name now says, and a stale or
    // lagging name lookup must not send a second create for it.
    const derived = boundId ? '' : derivedRoot(ctx, key);
    if (derived) {
      const at = await readFlowRow(input, derived);
      if (at.state === 'unreadable') return stop('unknown', 'create-identity-unverified', `the flow at the id this spec's flow is created with (${derived}) could not be read, so nothing was written`);
      if (at.state === 'present') row = at.row;
    }
    if (!row) {
      const rows = await byName();
      if (!rows) return stop('unknown', 'bpf-lookup-unreadable', 'the business process flows could not be listed, so nothing was written');
      if (!boundId && rows.length > 1) return stop('refused', 'bpf-name-ambiguous', `${rows.length} flows named ${String(flow.name)} exist on ${lc(flow.entity)}; bind the spec to one of them by id`);
      row = boundId ? (rows.find((r) => rowId(r) === boundId) || (rows.length === 1 ? rows[0] : null)) : (rows[0] || null);
    }
  }

  if (!row) {
    const plan = await planBpfMetadata({ flow, flowId: null, sdk }, ctx);
    if (!plan.needsCreate) return done(await applyBpfMetadata(plan, { sdk }, ctx));
    if (!derivedRoot(ctx, key)) return stop('refused', 'create-identity-unsupported', 'the creation port gives this business process flow no stable identity, so it is not created (a retry could not find it again); nothing was sent');
    if (typeof input.beforeCreate === 'function') await input.beforeCreate();
    const created = await applyBpfCreate(flow, { sdk, findById: input.findById }, ctx);
    if (created.continueAt) {
      // The create's answer was lost but the row is at the id it was sent with: reconcile it as it now is.
      return reconcileExisting(input, ctx, created.continueAt);
    }
    const saved = created.saved[0];
    return done(created, saved ? saved.id : null, saved ? saved.uniqueName : null, saved ? 'created' : null);
  }
  return reconcileExisting(input, ctx, row);
}

// The existing-flow path at one workflow row: stage check, plan (identity, drift and adoption rules), apply.
async function reconcileExisting(input, ctx, row) {
  const { flow, sdk } = input;
  const flowId = rowId(row);
  const suppliesStages = Array.isArray(flow.stages) && flow.stages.length > 0;
  const inspect = typeof input.inspectStages === 'function' ? input.inspectStages : require('./sdk-build.js').inspectBpfStages;
  const stageCheck = suppliesStages ? await inspect(sdk, flow, flowId) : undefined;
  const plan = await planBpfMetadata({ flow, flowId, sdk, stageCheck }, ctx);
  const result = await applyBpfMetadata(plan, { sdk }, ctx);
  return { ...result, flowId, uniqueName: lc(row.uniquename) || null, action: 'existing' };
}

/**
 * The build's whole declared-flow step. `hooks`:
 *   settle(phase, label, result, { memberIds }) -> { ok }   the build's managed settlement, called exactly once with
 *                   phase 'business-process-flows', for a new flow and an existing one alike. `memberIds` is the flow's
 *                   id when the result is clean (none otherwise): the settlement adds it to the app's solution BEFORE
 *                   it records anything, so a flow outside the solution is never recorded as applied, and it halts
 *                   the build (a never-retry error) when the result is not clean or the add fails;
 *   label           the label settlement reports under (default the flow's name).
 * A settlement that answers anything but { ok: true } without halting, or a result that is not clean, is turned into
 * a never-retry halt here: nothing downstream (role grants, the app's components) may run on a flow that did not settle.
 * Returns { flowId, backingTable } for the build's output maps, or null when there is no declared flow to record.
 */
async function buildDeclaredBpf(input, ctx = {}, hooks = {}) {
  const label = hooks.label || String(input.flow.name);
  const r = await reconcileDeclaredBpf(input, ctx);
  const { flowId, uniqueName, action, ...result } = r;
  const clean = () => !result.refused.length && !result.unknown.length;
  const halt = (why) => {
    const findings = [...result.refused, ...result.unknown];
    const code = (findings[0] && findings[0].code) || 'bpf-not-settled';
    return Object.assign(new Error(`${label}: the business process flow ${why} (${code}); nothing that depends on it was run`), { code, findings, transient: false, recoverable: false });
  };
  if (typeof hooks.settle !== 'function') throw halt('has no settlement to record it');
  const settled = await hooks.settle('business-process-flows', label, result, { memberIds: clean() && flowId ? [flowId] : [] });
  if (!settled || settled.ok !== true || !clean()) throw halt('did not settle cleanly');
  if (!flowId) return null;
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
