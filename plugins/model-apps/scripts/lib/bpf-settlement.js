'use strict';
// Declared business process flows (`businessProcessFlows[].reconcile: "declared"`) on the managed settlement layer.
//
// OWNERSHIP. A flow is one `workflows` row (category 4, type 1) whose stages and steps live in its XAML. Unlike a
// business rule's nodes, a stage and a step keep the id they were written with, so the group binds the whole graph:
// the root (`bpf`, the workflow GUID), one `bpfStage` record per stage (`stage:<stage key>`) and one `bpfStep` record per
// step (`step:<stage key>/<step key>`, under its stage). Every id comes from the create catalog BEFORE any local SDK
// edit or request: the workflow id and stage ids under the flow's id, and a step id under ITS stage's id — the stage
// reserved in the same call (a new stage), or the stage GUID the group holds (a step added to a stage that exists).
// A retry in a fresh workspace therefore derives the same ids, and a write whose answer was lost is proved at them.
// The group's consumer state keeps the declaration, what it applied (by key) and the flow's stored backing table
// name; the key -> id map is in `stages`. Content is never evidence of ownership: a live flow that differs from the
// proof is `bpf-drift` before any request that could change it, and only a complete read-only re-adoption
// (`bpf:<table>/<name>`, with a declaration that names the whole current flow in order) records it again.
//
// STRUCTURE. A structural declaration names its stages and steps with explicit keys. A declaration that omits a held
// stage or step, or reorders them, refuses the WHOLE operation (`bpf-structure-refused`), the metadata included, before
// any request. Allowed: new stages and steps at any position, a key-preserving rename, a step's column and required
// flag, and the description and order. A metadata-only declaration of a managed flow may omit `stages`. Branching,
// stage actions and a stage on another table are not managed (`bpf-shape-unsupported`).
//
// CREATE AND EDIT (the existing-workflow edit gate, as for rules). A new flow is created Draft with ONE
// `POST workflows` whose XAML carries every reserved id, proved by a fresh read (the row, the declared table, every
// expected child id and exactly the projection that was sent) and then activated by its own state-only write. A
// substituted or missing child id is `create-completion-required` whether or not the POST was acknowledged, and
// nothing is bound. Any change to a flow that already exists refuses before any workflow request with
// `workflow-edit-refused` unless `opts.workflowConditionalEdits` is on. With the switch, an Active flow is edited as
// three effects — Draft, body, Active — each conditioned on the version its own proof read returned (an Active
// flow's SDK push is a `$batch` the effect gate cannot read whole, so it is never sent). A write whose answer was lost
// is proved by reading and never sent again; a re-run finishes an edit whose body is on the row but whose own
// activation was refused before it was sent.
//
// Nothing here publishes: activating a flow is a state change, not PublishXml.

const { intentSha256, normalizeGuid, isApproved } = require('./reconcile-common.js');
const { runManagedFeature } = require('./managed-feature-contract.js');
const { requestBodySha256 } = require('./workflow-effect-context.js');
const { identityFor, reserveChildren } = require('./creates-catalog.js');
const { CODES } = require('./managed-bindings.js');
const { createWorkflowDriver, isDefiniteRefusal, coded, ACTIVE, DRAFT } = require('./workflow-drive.js');

// sdk-build is required lazily: it is the module that will call this one, so a top-level require would be a cycle.
const sdkBuild = () => require('./sdk-build.js');

const FAMILY = 'bpf';
const ROOT_KIND = 'bpf';
const ARTIFACT = 'bpf';
const PROOF_SCHEMA = 'bpf/declared-1';
const DEFAULT_ORDER = 100;
const MAX_DESCRIPTION = 2000;
const KEY_RE = /^[A-Za-z0-9_.-]{1,64}$/;
// `securityRoles` is granted by the build from the stored backing table this module returns, never written here.
const FLOW_KEYS = ['name', 'entity', 'reconcile', 'description', 'status', 'order', 'stages', 'securityRoles'];
const STAGE_KEYS = ['key', 'name', 'entity', 'steps'];
const STEP_KEYS = ['key', 'name', 'field', 'required'];
// The PATCH body the SDK sends for a Draft flow's push is these fields of the prepared record, when defined (measured
// with the vendored bundle: GET workflows(<id>)?$select=…, then PATCH workflows(<id>) with exactly these keys).
const PATCH_FIELDS = ['xaml', 'name', 'description', 'processorder'];
const EDIT_REFUSED_REMEDY = 'A declared process flow can be created and adopted read-only; changing one that already exists stays off until '
  + 'conditional writes are enabled, because a local lock cannot stop another session changing the flow between the read and the write. '
  + 'Change the flow in the maker, then re-adopt it with a declaration that names its whole current body.';

const lc = (v) => String(v == null ? '' : v).toLowerCase();
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const isNotFound = (err) => !!err && (err.statusCode === 404 || err.status === 404 || (err.cause && (err.cause.statusCode === 404 || err.cause.status === 404)));
const isDeclaredBpf = (flow) => !!flow && flow.reconcile === 'declared';
const tableOf = (flow) => lc(flow && flow.entity);
const bpfKey = (flow) => `${tableOf(flow)}/${String((flow && flow.name) || '')}`;
const stageLocator = (k) => `stage:${k}`;
const stepLocator = (sk, k) => `step:${sk}/${k}`;
const nonempty = (s) => typeof s === 'string' && s.trim().length > 0;

// ---------------------------------------------------------------------------------------------------------------
// The declaration.

function validateDeclaredBpf(flow) {
  const errors = [];
  if (!flow || typeof flow !== 'object' || Array.isArray(flow)) return ['a declared process flow must be an object'];
  for (const k of Object.keys(flow)) if (!FLOW_KEYS.includes(k)) errors.push(`"${k}" is not managed on a declared process flow`);
  if (!nonempty(flow.name)) errors.push('name is required');
  if (!nonempty(flow.entity)) errors.push('entity is required');
  if (flow.description !== undefined && (typeof flow.description !== 'string' || flow.description.length > MAX_DESCRIPTION)) {
    errors.push(`description must be text of at most ${MAX_DESCRIPTION} characters`);
  }
  if (flow.order !== undefined && !(Number.isInteger(flow.order) && flow.order >= 0)) errors.push('order must be a whole number of 0 or more');
  if (flow.status !== undefined && flow.status !== ACTIVE && flow.status !== DRAFT) errors.push('status must be Active or Draft');
  if (flow.stages === undefined) return errors;
  if (!Array.isArray(flow.stages) || !flow.stages.length) return [...errors, 'stages, when given, must list at least one stage'];
  const stageKeys = new Set();
  flow.stages.forEach((st, i) => {
    const at = `stages[${i}]`;
    if (!st || typeof st !== 'object' || Array.isArray(st)) { errors.push(`${at} must be an object`); return; }
    for (const k of Object.keys(st)) {
      if (!STAGE_KEYS.includes(k)) errors.push(`${at}: "${k}" is not managed (branching, stage actions and other stage settings are refused)`);
    }
    if (typeof st.key !== 'string' || !KEY_RE.test(st.key)) errors.push(`${at}: a declared stage needs a key (letters, digits, "_", "-", "."; at most 64)`);
    else if (stageKeys.has(st.key)) errors.push(`${at}: the stage key "${st.key}" is used twice`);
    else stageKeys.add(st.key);
    if (!nonempty(st.name)) errors.push(`${at}: name is required`);
    if (st.entity !== undefined && lc(st.entity) !== tableOf(flow)) errors.push(`${at}: a stage on another table is not managed`);
    if (!Array.isArray(st.steps)) { errors.push(`${at}: steps must be a list`); return; }
    const stepKeys = new Set();
    st.steps.forEach((p, j) => {
      const sat = `${at}.steps[${j}]`;
      if (!p || typeof p !== 'object' || Array.isArray(p)) { errors.push(`${sat} must be an object`); return; }
      for (const k of Object.keys(p)) if (!STEP_KEYS.includes(k)) errors.push(`${sat}: "${k}" is not managed`);
      if (typeof p.key !== 'string' || !KEY_RE.test(p.key)) errors.push(`${sat}: a declared step needs a key`);
      else if (stepKeys.has(p.key)) errors.push(`${sat}: the step key "${p.key}" is used twice in its stage`);
      else stepKeys.add(p.key);
      if (!nonempty(p.name)) errors.push(`${sat}: name is required`);
      if (!nonempty(p.field)) errors.push(`${sat}: field is required`);
      if (p.required !== undefined && typeof p.required !== 'boolean') errors.push(`${sat}: required must be true or false`);
    });
  });
  return errors;
}

// ---------------------------------------------------------------------------------------------------------------
// The flow as this module compares it.

/**
 * The projection of an SDK BpfArtifact, e.g. (fetchArtifact('bpf', id) with the vendored bundle):
 *   { id, name, entityLogicalName, status: 'Active'|'Draft', order: 100, uniqueName: 'new_ticketflow', description?,
 *     stages: [ { id, name, entityLogicalName, category?, nextStageId?, steps: [ { id, name, fieldName?, required? } ] } ] }
 * `description` is present only when the row has a non-empty one, and `order` reads 100 when it was never set. A stage
 * with a `nextStageId` other than the following stage (a branch) or on another table is not a shape this module manages. The status is kept apart
 * (`savedShaOf`) because a state change is its own write; `uniqueName` (the backing table) is kept apart because the
 * SDK's parse of a request record does not carry it.
 */
function projectBpf(art) {
  const entity = lc(art && art.entityLogicalName);
  const stages = [];
  const raw = (art && art.stages) || [];
  for (const [i, st] of raw.entries()) {
    // The SDK reports each stage's next-stage pointer. In a linear flow it names the following stage and the last
    // stage has none; any other pointer is a branch.
    const following = raw[i + 1] ? lc(raw[i + 1].id) : null;
    if (st.nextStageId && lc(st.nextStageId) !== following) return { unsupported: 'the flow branches' };
    if (lc(st.entityLogicalName) !== entity) return { unsupported: 'a stage is on another table' };
    stages.push({
      id: lc(st.id),
      name: String(st.name == null ? '' : st.name),
      category: st.category === undefined ? null : st.category,
      steps: (st.steps || []).map((p) => ({ id: lc(p.id), name: String(p.name == null ? '' : p.name), field: lc(p.fieldName), required: p.required === true })),
    });
  }
  const projection = {
    name: String(art.name == null ? '' : art.name),
    entity,
    description: typeof art.description === 'string' ? art.description : '',
    order: art.order === undefined || art.order === null ? DEFAULT_ORDER : Number(art.order),
    stages,
  };
  return {
    projection,
    status: art.status === ACTIVE ? ACTIVE : DRAFT,
    hasDescription: typeof art.description === 'string' && art.description !== '',
    uniqueName: nonempty(art.uniqueName) ? String(art.uniqueName) : null,
  };
}

const savedShaOf = (projection, status) => intentSha256({ projection, status });
// What the row keeps that a declaration cannot state (each stage's category), in stage order.
const preservationOf = (projection) => intentSha256(projection.stages.map((s) => ({ id: s.id, category: s.category })));

/** The key -> id map of a declaration laid over a flow whose stages and steps are in declaration order. */
function positionalMap(flow, projection) {
  return flow.stages.map((st, i) => ({
    key: st.key,
    id: projection.stages[i].id,
    steps: st.steps.map((p, j) => ({ key: p.key, id: projection.stages[i].steps[j].id })),
  }));
}

/** Whether every id of `map` is where the map says in `projection` (the whole flow is managed, so every live part). */
function mapFits(map, projection) {
  if (map.length !== projection.stages.length) return false;
  return map.every((s, i) => s.id === projection.stages[i].id && s.steps.length === projection.stages[i].steps.length
    && s.steps.every((p, j) => p.id === projection.stages[i].steps[j].id));
}

/** What the group applied, by key: the declaration's effective flow as it was proved. */
function appliedOf(view, map) {
  const p = view.projection;
  return {
    description: p.description,
    order: p.order,
    status: view.status,
    stages: map.map((s) => {
      const live = p.stages.find((x) => x.id === s.id);
      return {
        key: s.key,
        name: live.name,
        steps: s.steps.map((t) => {
          const lt = live.steps.find((x) => x.id === t.id);
          return { key: t.key, name: lt.name, field: lt.field, required: lt.required };
        }),
      };
    }),
  };
}

/** Why the declaration changes the flow the group holds; [] when it does not. An omitted part keeps its live value. */
function editsOf(applied, flow) {
  const out = [];
  if (flow.description !== undefined && flow.description !== applied.description) out.push('changes the description');
  if (flow.order !== undefined && flow.order !== applied.order) out.push('changes the order');
  if (flow.status !== undefined && flow.status !== applied.status) out.push(`sets the flow ${flow.status}`);
  for (const st of flow.stages || []) {
    const held = applied.stages.find((s) => s.key === st.key);
    if (!held) { out.push(`adds the stage "${st.key}"`); continue; }
    if (held.name !== st.name) out.push(`renames the stage "${st.key}"`);
    for (const p of st.steps) {
      const h = held.steps.find((x) => x.key === p.key);
      if (!h) out.push(`adds the step "${st.key}/${p.key}"`);
      else if (h.name !== p.name || h.field !== lc(p.field) || h.required !== (p.required === true)) out.push(`changes the step "${st.key}/${p.key}"`);
    }
  }
  return out;
}

/**
 * The structural refusals of a declaration against the stages the group holds: a held stage or step the declaration
 * omits, or held ones it puts in another order. Nothing is ever removed or moved, so either refuses the whole operation.
 */
function structureErrors(map, flow) {
  if (flow.stages === undefined) return [];
  const errs = [];
  const declared = flow.stages.map((s) => s.key);
  for (const s of map) if (!declared.includes(s.key)) errs.push(`omits the stage "${s.key}"`);
  const kept = declared.filter((k) => map.some((s) => s.key === k));
  if (!errs.length && kept.join('\u0000') !== map.map((s) => s.key).join('\u0000')) errs.push('puts its stages in another order');
  for (const s of map) {
    const st = flow.stages.find((x) => x.key === s.key);
    if (!st) continue;
    const keys = st.steps.map((p) => p.key);
    const missing = s.steps.filter((p) => !keys.includes(p.key));
    for (const p of missing) errs.push(`omits the step "${s.key}/${p.key}"`);
    const keptSteps = keys.filter((k) => s.steps.some((p) => p.key === k));
    if (!missing.length && keptSteps.join('\u0000') !== s.steps.map((p) => p.key).join('\u0000')) errs.push(`puts the steps of "${s.key}" in another order`);
  }
  return errs;
}

/** Why a read-only adoption cannot record `view` for this declaration; [] when the declaration names it whole. */
function wholeBodyErrors(flow, view) {
  const p = view.projection;
  const errs = [];
  if (!Array.isArray(flow.stages)) return ['the declaration names no stages'];
  if (flow.description !== undefined && flow.description !== p.description) errs.push('its description differs');
  if (flow.order !== undefined && flow.order !== p.order) errs.push('its order differs');
  if (flow.status !== undefined && flow.status !== view.status) errs.push(`it is ${view.status}`);
  if (flow.stages.length !== p.stages.length) return [...errs, `it has ${p.stages.length} stages and the declaration names ${flow.stages.length}`];
  flow.stages.forEach((st, i) => {
    const live = p.stages[i];
    if (live.name !== st.name) errs.push(`stage ${i + 1} is "${live.name}"`);
    if (live.steps.length !== st.steps.length) { errs.push(`stage "${st.key}" has ${live.steps.length} steps`); return; }
    st.steps.forEach((s, j) => {
      const l = live.steps[j];
      if (l.name !== s.name || l.field !== lc(s.field) || l.required !== (s.required === true)) errs.push(`step "${st.key}/${s.key}" differs`);
    });
  });
  return errs;
}

// ---------------------------------------------------------------------------------------------------------------
// Settlement.

/**
 * Settle one declared business process flow through runManagedFeature.
 * @param {object} input
 *   flow              the App Spec flow (`reconcile: "declared"`, every stage and step keyed)
 *   sdk               the maker SDK over the plugin's HTTP client (with the workflow effect gate)
 *   store             the managed binding handle (opened with the publication barrier)
 *   catalog           the plan's create-intent catalog; the flow's entry is { catalogKind: 'bpf', key: '<table>/<name>' }
 *   approvals         the build's approval set; `bpf:<table>/<name>` (adopt) approves a complete read-only adoption
 *   opts              { workflowConditionalEdits?: true } turns on the edit path (off by default; the skill never writes it)
 *   halt              the build's halt factory (managedStop)
 *   ensureMembership  ({ root, records, recovering }) => solution membership of the workflow
 *   phase, label, barrier
 *   httpClient, instanceUrl  needed only by the edit path, for a state change that carries If-Match
 * @returns {{ committed?: true, recovered?: boolean, noop?: true, id: string, uniqueName: string|null }} where
 *   `uniqueName` is the backing table the platform STORED for the flow (read back, never recomputed from its name):
 *   what security-role grants and the app's components must use.
 */
async function settleDeclaredBpf(input) {
  const { flow, sdk, store, catalog, approvals = null, opts = {}, halt, phase = 'business-process-flows', barrier, httpClient = null, instanceUrl = null } = input || {};
  const ensureMembership = (input && input.ensureMembership) || (async () => {});
  if (!isDeclaredBpf(flow)) throw coded(CODES.notSettled, 'settleDeclaredBpf takes a flow with reconcile: "declared"');
  if (!store || typeof store.snapshot !== 'function') throw coded(CODES.notSettled, 'settleDeclaredBpf needs the managed binding store');
  const key = bpfKey(flow);
  const table = tableOf(flow);
  const label = (input && input.label) || `declared business process flow "${flow.name}" on ${table}`;
  const approved = isApproved(approvals, FAMILY, key);
  const switchOn = opts.workflowConditionalEdits === true;
  const declarationSha256 = intentSha256(flow);
  const head = store.snapshot().envelope;
  const record = (kind, k, id, origin, parentKey) => ({
    formatVersion: 1, appUniqueName: head.appUniqueName, environmentFingerprint: head.environmentFingerprint,
    kind, key: k, id, intentSha256: declarationSha256, origin, ...(parentKey ? { parentKey } : {}),
  });
  const run = { token: null, committed: null };
  const { readVersion, attemptOf, effectOf, sendOnce, noteNoStart, driveState } = createWorkflowDriver({
    store, sdk, httpClient, instanceUrl, family: FAMILY, key, label, noun: 'process flow', driftCode: 'bpf-drift',
  });

  // ----- reads.
  async function readBody(id) {
    try {
      await sdk.fetchArtifact(ARTIFACT, id, { overwrite: true });
      const art = await sdk.getArtifact(ARTIFACT, id);
      if (!art) return { missing: true };
      const view = projectBpf(art);
      if (view.unsupported) throw coded('bpf-shape-unsupported', `${label}: ${view.unsupported}; this shape is not managed (nothing is changed)`);
      // A flow an id names must be that id and the declared table's flow, or nothing of it is trusted.
      if (normalizeGuid(art.id) !== id || view.projection.entity !== table) return { missing: true, stranger: true };
      return view;
    } catch (err) {
      if (err && err.code === 'bpf-shape-unsupported') throw err;
      if (isNotFound(err)) return { missing: true };
      throw coded(CODES.notSettled, `${label}: the flow ${id} could not be read`, { cause: err });
    }
  }
  async function readLive(id) {
    const row = await readVersion(id);
    if (!row) return { missing: true };
    const view = await readBody(id);
    if (view.missing) return { missing: true, stranger: view.stranger === true };
    return { version: row.version, view };
  }

  // ----- the ids. Every child id is derived by the catalog before any local edit: under the flow's id for a stage,
  // under its stage's id for a step (the stage reserved in the same call, or the stage GUID the group holds).
  function createMap() {
    const children = [];
    for (const st of flow.stages) {
      children.push({ locator: stageLocator(st.key), childKind: 'bpfStage', keyParts: [st.key] });
      for (const p of st.steps) children.push({ locator: stepLocator(st.key, p.key), childKind: 'bpfStep', keyParts: [st.key, p.key], parentLocator: stageLocator(st.key) });
    }
    const { rootId, childIds } = reserveChildren('bpf', key, { catalog, children });
    return { id: rootId, map: flow.stages.map((st) => ({ key: st.key, id: childIds[stageLocator(st.key)], steps: st.steps.map((p) => ({ key: p.key, id: childIds[stepLocator(st.key, p.key)] })) })) };
  }
  /** The map after an edit: held ids kept, new children reserved under the flow's actual id. */
  function editedMap(id, held) {
    if (flow.stages === undefined) return held;
    const children = [];
    for (const st of flow.stages) {
      const hs = held.find((s) => s.key === st.key);
      if (!hs) children.push({ locator: stageLocator(st.key), childKind: 'bpfStage', keyParts: [st.key] });
      for (const p of st.steps) {
        if (hs && hs.steps.some((x) => x.key === p.key)) continue;
        children.push({ locator: stepLocator(st.key, p.key), childKind: 'bpfStep', keyParts: [st.key, p.key], ...(hs ? { actualParentId: hs.id } : { parentLocator: stageLocator(st.key) }) });
      }
    }
    const { childIds } = children.length ? reserveChildren('bpf', key, { catalog, actualRootId: id, children }) : { childIds: {} };
    return flow.stages.map((st) => {
      const hs = held.find((s) => s.key === st.key);
      return {
        key: st.key,
        id: hs ? hs.id : childIds[stageLocator(st.key)],
        steps: st.steps.map((p) => {
          const hp = hs && hs.steps.find((x) => x.key === p.key);
          return { key: p.key, id: hp ? hp.id : childIds[stepLocator(st.key, p.key)] };
        }),
      };
    });
  }

  // ----- local SDK staging (no request). The local copy is laid out from the declaration or the proved read.
  const stepEl = (t, p) => ({ id: t.id, name: p.name, fieldName: lc(p.field), ...(p.required === true ? { required: true } : {}) });
  async function stageCreate(id, map) {
    const def = sdkBuild().bpfDef(flow);
    const stages = def.stages.map((st, i) => ({ ...st, id: map[i].id, steps: st.steps.map((p, j) => ({ ...p, id: map[i].steps[j].id })) }));
    try { await sdk.deleteArtifact(ARTIFACT, id); } catch { /* no local copy */ }
    await sdk.createArtifact(ARTIFACT, { ...def, id, status: DRAFT, stages });
    return prepared(id, def.status, 'create');
  }
  // Edits on the copy the last read fetched (with overwrite): each held element is found again by id, since an insert
  // shifts every index after it, and a stage only ever gains steps, so the flow stays valid after every operation.
  // `baseStatus` is the state the flow had when the edit was planned: the drive takes an Active flow to Draft before it
  // stages again, and the edit must still end Active.
  async function stageEdit(id, view, map, baseStatus = view.status) {
    const stagesNow = async () => ((await sdk.getArtifact(ARTIFACT, id)) || {}).stages || [];
    if (flow.stages !== undefined) {
      for (let i = 0; i < flow.stages.length; i += 1) {
        const st = flow.stages[i];
        const m = map[i];
        const index = (await stagesNow()).findIndex((s) => lc(s.id) === m.id);
        if (index < 0) {
          await sdk.addElement(ARTIFACT, id, '/stages', { id: m.id, name: st.name, entityLogicalName: table, steps: st.steps.map((p, j) => stepEl(m.steps[j], p)) }, { position: { index: i } });
          continue;
        }
        const stage = (await stagesNow())[index];
        if (stage.name !== st.name) await sdk.updateElement(ARTIFACT, id, `/stages/${index}/name`, st.name);
        for (let j = 0; j < st.steps.length; j += 1) {
          const p = st.steps[j];
          const steps = (await stagesNow())[index].steps || [];
          const at = steps.findIndex((s) => lc(s.id) === m.steps[j].id);
          if (at < 0) {
            await sdk.addElement(ARTIFACT, id, `/stages/${index}/steps`, stepEl(m.steps[j], p), { position: { index: j } });
            continue;
          }
          const live = steps[at];
          const patch = {};
          if (live.name !== p.name) patch.name = p.name;
          if (lc(live.fieldName) !== lc(p.field)) patch.fieldName = lc(p.field);
          if ((live.required === true) !== (p.required === true)) patch.required = p.required === true;
          if (Object.keys(patch).length) await sdk.updateElement(ARTIFACT, id, `/stages/${index}/steps/${at}`, patch);
        }
      }
    }
    const live = view.projection;
    if (flow.description !== undefined && flow.description !== live.description) {
      // A description the row does not have yet is added at the artifact root; an existing one is updated in place.
      if (!view.hasDescription) await sdk.addElement(ARTIFACT, id, '', { description: flow.description });
      else await sdk.updateElement(ARTIFACT, id, '/description', flow.description);
    }
    if (flow.order !== undefined && flow.order !== live.order) await sdk.updateElement(ARTIFACT, id, '/order', flow.order);
    return prepared(id, flow.status || baseStatus, 'edit');
  }
  async function prepared(id, desiredStatus, mode) {
    const prep = await sdk.withArtifactLock(ARTIFACT, id, () => sdk.prepareArtifactUnlocked(ARTIFACT, id, undefined));
    const rec = prep.payload && prep.payload.record;
    if (!rec || typeof rec !== 'object') throw coded(CODES.notSettled, `${label}: the SDK prepared no workflow record`);
    // The SDK's own parser over the exact record it will send: the projection a fresh read must give back.
    const sent = projectBpf(prep.reg.adapter.fromApiResponse(clone({ ...rec, statecode: 0 })));
    if (sent.unsupported) throw coded('bpf-shape-unsupported', `${label}: ${sent.unsupported}`);
    const body = mode === 'create' ? rec : Object.fromEntries(PATCH_FIELDS.filter((k) => rec[k] !== undefined).map((k) => [k, rec[k]]));
    return { prep, desiredSha256: requestBodySha256(body), sent, desiredStatus, version: (prep.meta && prep.meta.etag) || null };
  }

  // A staged projection must be exactly the map laid out with the declaration: a local edit the SDK took differently
  // is caught here, before anything is sent.
  function checkStaged(sent, map) {
    if (flow.stages === undefined) return;
    if (!mapFits(map, sent.projection) || flow.stages.some((st, i) => sent.projection.stages[i].name !== st.name
      || st.steps.some((p, j) => { const s = sent.projection.stages[i].steps[j]; return s.name !== p.name || s.field !== lc(p.field) || s.required !== (p.required === true); }))) {
      throw coded(CODES.notSettled, `${label}: the SDK staged another flow than the declaration; nothing is sent`);
    }
  }

  function childrenOf(id, map, held) {
    const has = (kind, k) => !!held && held.some((r) => r.kind === kind && r.key === k);
    const out = [];
    for (const s of map) {
      const sk = stageLocator(s.key);
      if (!has('bpfStage', sk)) out.push({ kind: 'bpfStage', key: sk, namespaceParentId: id, id: s.id, associationSha256: intentSha256({ parent: key, key: sk }) });
      for (const p of s.steps) {
        const pk = stepLocator(s.key, p.key);
        if (!has('bpfStep', pk)) out.push({ kind: 'bpfStep', key: pk, namespaceParentId: s.id, id: p.id, associationSha256: intentSha256({ parent: sk, key: pk }) });
      }
    }
    return out;
  }
  function expectedOf({ id, sent, desiredStatus, map, live }) {
    return {
      proofVersion: 1,
      proofSchema: PROOF_SCHEMA,
      rootId: id,
      baseProofSha256: run.committed ? intentSha256(run.committed.proof) : null,
      sentProjectionSha256: savedShaOf(sent.projection, desiredStatus),
      preservationSha256: preservationOf(sent.projection),
      baseObservation: live ? { rowVersion: live.version || null, savedSha256: savedShaOf(live.view.projection, live.view.status) } : null,
      children: childrenOf(id, map, run.committed ? run.committed.records : null),
    };
  }
  // Every child id the attempt said it would bind, where a fresh read finds it; [] when all are there.
  function missingChildren(expected, projection) {
    const ids = new Set();
    for (const s of projection.stages) { ids.add(s.id); for (const p of s.steps) ids.add(p.id); }
    return expected.children.filter((c) => !ids.has(c.id)).map((c) => c.key);
  }
  // The status the expected proof was sent for, given a live projection: the one for which the hashes agree.
  function statusFor(expected, projection) {
    for (const s of [ACTIVE, DRAFT]) if (savedShaOf(projection, s) === expected.sentProjectionSha256) return s;
    return null;
  }
  function notTheSentFlow(expected, view) {
    const missing = missingChildren(expected, view.projection);
    if (missing.length) return `the flow read back lacks ${missing.join(', ')} under the ids this build reserved`;
    if (statusFor(expected, view.projection) === null) return 'the flow read back is not the flow this build sent';
    return null;
  }

  /** The Draft create of this attempt's own row, then its own activation. */
  async function driveCreate(token, id, staged, recovering) {
    let create = effectOf(token, (e) => e.effect === 'create');
    let acknowledged = false;
    let failure = null;
    if (!create || create.state === 'definitely-unsent') {
      if (recovering && await readVersion(id)) throw coded('create-identity-conflict', `${label}: a workflow already holds the id ${id}, and this build never sent its create`);
      const s = staged || await stageCreate(id, createMap().map);
      if (create && create.desiredSha256 !== s.desiredSha256) throw coded(CODES.pending, `${label}: the create waiting to be sent was made from another declaration; restore it to finish`);
      failure = await sendOnce(token, create, {
        rowId: id, effect: 'create', request: { method: 'POST', shape: 'bpf-create' }, desiredSha256: s.desiredSha256, desiredState: null, expectedVersion: null,
      }, () => sdk.withArtifactLock(ARTIFACT, id, () => sdk.executePrepared(s.prep)));
      create = effectOf(token, (e) => e.effect === 'create');
      acknowledged = !failure;
    }
    const expected = attemptOf(token).attempt.expected;
    if (create.state !== 'confirmed') {
      const live = await readLive(id);
      if (live.missing) {
        if (live.stranger) throw coded('create-completion-required', `${label}: the workflow ${id} is not this table's process flow; nothing is bound to it`);
        if (failure && isDefiniteRefusal(failure)) {
          noteNoStart(create);
          throw coded('create-completion-required', `${label}: the create was refused (${failure.message}); nothing was written`, { cause: failure });
        }
        throw coded(CODES.pending, `${label}: the create of ${id} has not appeared; it is not sent again. Re-run the build to prove it`, { cause: failure });
      }
      // Acknowledged or not, a row that is not exactly what was sent (a substituted stage or step id included) binds nothing.
      const why = notTheSentFlow(expected, live.view);
      if (why) throw coded('create-completion-required', `${label}: ${why}; nothing is bound to it`);
      store.confirmEffect(create.token, { observedSha256: create.desiredSha256 });
    }
    const live = await readLive(id);
    if (live.missing) throw coded(CODES.pending, `${label}: the workflow ${id} could not be read back`);
    const why = notTheSentFlow(expected, live.view);
    if (why) throw coded('create-completion-required', `${label}: ${why}`);
    // Completing this attempt's own Draft is allowed by default: the row is the one this exact attempt created.
    if (statusFor(expected, live.view.projection) === ACTIVE && live.view.status !== ACTIVE) await driveState(token, id, ACTIVE, null, { conditional: false });
    return { acknowledged };
  }

  /** The switch path: Draft (when Active), body, then Active, each conditioned on the version its proof read returned. */
  async function driveEdit(token, id, planned) {
    const base = planned.live;
    const baseSemantic = intentSha256(base.view.projection);
    if (base.view.status === ACTIVE) await driveState(token, id, DRAFT, base.version, { conditional: true });
    // Read again whatever the state: the copy staged while planning is replaced by the row as it is now, so no local
    // edit is ever applied twice, and the body write carries the version of THIS read.
    const live = await readLive(id);
    if (live.missing || intentSha256(live.view.projection) !== baseSemantic) throw coded('bpf-drift', `${label}: the flow changed on the server while it was being edited; nothing more is sent`);
    const staged = await stageEdit(id, live.view, planned.map, base.view.status);
    checkStaged(staged.sent, planned.map);
    if (savedShaOf(staged.sent.projection, staged.desiredStatus) !== planned.expected.sentProjectionSha256) {
      throw coded('bpf-drift', `${label}: the flow read back differently from the proof it was planned on; nothing more is sent`);
    }
    if (staged.version !== live.version) throw coded('bpf-drift', `${label}: the flow's version moved between two reads; nothing more is sent`);
    const failure = await sendOnce(token, null, {
      rowId: id, effect: 'body', request: { method: 'PATCH', shape: 'workflow-patch' }, desiredSha256: staged.desiredSha256, desiredState: null, expectedVersion: staged.version,
    }, () => sdk.withArtifactLock(ARTIFACT, id, () => sdk.executePrepared(staged.prep)));
    const body = effectOf(token, (e) => e.effect === 'body');
    if (body.state === 'definitely-unsent') throw coded('bpf-drift', `${label}: the flow changed on the server after it was read, so the edit was refused; it is not retried`, { cause: failure });
    const after = await readLive(id);
    if (after.missing || savedShaOf(after.view.projection, staged.desiredStatus) !== planned.expected.sentProjectionSha256) {
      if (failure && isDefiniteRefusal(failure)) {
        noteNoStart(body);
        throw coded('create-completion-required', `${label}: the edit was refused (${failure.message}); the flow is kept as it is`, { cause: failure });
      }
      throw coded(failure ? CODES.pending : 'create-completion-required', `${label}: the edit is not proved by a fresh read; it is not sent again`, { cause: failure });
    }
    store.confirmEffect(body.token, { observedSha256: body.desiredSha256 });
    if (staged.desiredStatus === ACTIVE && after.view.status !== ACTIVE) await driveState(token, id, ACTIVE, after.version, { conditional: true });
  }

  async function finalProof(id, expected, map, origin, acknowledged) {
    const live = await readLive(id);
    if (live.missing) throw coded(CODES.pending, `${label}: the workflow ${id} could not be read back`);
    const missing = missingChildren(expected, live.view.projection);
    if (missing.length) throw coded('create-completion-required', `${label}: a fresh read of ${id} lacks ${missing.join(', ')}; nothing is bound`);
    const saved = savedShaOf(live.view.projection, live.view.status);
    if (saved !== expected.sentProjectionSha256 || preservationOf(live.view.projection) !== expected.preservationSha256 || !mapFits(map, live.view.projection)) {
      throw coded(run.committed ? 'bpf-drift' : 'create-completion-required', `${label}: a fresh read of ${id} is not what was sent; nothing is bound`);
    }
    // A child is recorded `created` only on this attempt's acknowledged create (the store refuses it otherwise).
    const childOrigin = acknowledged === true ? 'created' : 'adopted';
    const records = [record(ROOT_KIND, key, id, origin)];
    for (const s of map) {
      records.push(record('bpfStage', stageLocator(s.key), s.id, childOrigin, key));
      for (const p of s.steps) records.push(record('bpfStep', stepLocator(s.key, p.key), p.id, childOrigin, stageLocator(s.key)));
    }
    const proof = {
      savedSha256: saved,
      semanticSha256: intentSha256(live.view.projection),
      preservationSha256: preservationOf(live.view.projection),
      expectedChildrenSha256: intentSha256(records.filter((r) => r.kind !== ROOT_KIND).map((r) => [r.kind, r.key, r.id])),
    };
    const backing = live.view.uniqueName;
    return {
      savedProof: proof, acknowledgedRoot: acknowledged === true, records, proof,
      consumerState: { declaration: { flow: clone(flow), applied: appliedOf(live.view, map), backing }, stages: map },
      publication: null, proofSchema: PROOF_SCHEMA,
    };
  }

  // ----- the four steps.
  async function resolve({ committed, pending }) {
    run.committed = committed;
    const errors = validateDeclaredBpf(flow);
    if (errors.length) throw coded('bpf-shape-unsupported', `${label}: ${errors.join('; ')}`);
    if (pending && pending.declarationSha256 !== declarationSha256) {
      throw coded(CODES.pending, `${label}: an earlier change was prepared from another declaration of this flow; restore that declaration to finish it`);
    }
    return committed ? resolveManaged(committed) : resolveNew();
  }

  async function resolveManaged(committed) {
    if (!committed.root || committed.root.kind !== ROOT_KIND) throw coded(CODES.groupInvalid, `${label}: the managed group is not a process flow`);
    const id = committed.root.id;
    const state = committed.consumerState || {};
    const held = state.stages || [];
    // Both refusals come before ANY request: a structural one refuses the whole operation, the metadata included.
    const structure = structureErrors(held, flow);
    if (structure.length) throw coded('bpf-structure-refused', `${label}: the declaration ${structure.join(', ')}; stages and steps are never removed or moved, so nothing is changed`);
    const edits = editsOf((state.declaration && state.declaration.applied) || { stages: [] }, flow);
    if (edits.length && !switchOn && !approved) throw coded('workflow-edit-refused', `${label}: the declaration ${edits.join(', ')}. ${EDIT_REFUSED_REMEDY}`);
    const live = await readLive(id);
    if (live.missing) throw coded('bpf-drift', `${label}: its workflow ${id} is gone or is not this table's flow; nothing re-creates or rebinds it`);
    if (savedShaOf(live.view.projection, live.view.status) !== committed.proof.savedSha256) {
      if (!approved) {
        throw coded('bpf-drift', `${label}: the flow changed outside the spec since it was last proved; nothing is sent. Re-adopt it (adopt:bpf:${key}) with a declaration that names its whole current body, in order`);
      }
      return adoption(id, live);
    }
    if (!edits.length) return { mode: 'noop' };
    if (!switchOn) throw coded('workflow-edit-refused', `${label}: the declaration ${edits.join(', ')}. ${EDIT_REFUSED_REMEDY}`);
    return { mode: 'edit', id, live, held };
  }

  async function resolveNew() {
    if (!Array.isArray(flow.stages)) throw coded('bpf-shape-unsupported', `${label}: creating or adopting a flow needs its stages, each with a key`);
    const { id } = identityFor('bpf', key, { catalog });
    let sameName;
    let atId;
    try {
      sameName = await sdk.queryRecords('workflow', { select: ['workflowid'], filter: sdkBuild().bpfFilter(flow.name, table), paginate: true });
      atId = await readVersion(id);
    } catch (err) {
      throw coded('create-identity-unverified', `${label}: whether the flow already exists could not be read, so it is neither created nor adopted`, { cause: err });
    }
    if (!Array.isArray(sameName)) throw coded('create-identity-unverified', `${label}: the read of its name answered no list`);
    const ids = sameName.map((r) => normalizeGuid(r.workflowid));
    if (atId && !ids.includes(id)) throw coded('create-identity-conflict', `${label}: its id ${id} is held by another workflow`);
    if (ids.length > 1) throw coded('create-identity-conflict', `${label}: ${ids.length} process flows on ${table} have this name; none is adopted`);
    if (ids.length === 1) {
      if (!approved) {
        throw coded('create-ownership-required', `${label}: a process flow of this name already exists (${ids[0]}); approve adopt:bpf:${key} with a declaration that names its whole body to manage it`);
      }
      const live = await readLive(ids[0]);
      if (live.missing) throw coded('create-identity-unverified', `${label}: the flow ${ids[0]} could not be read back`);
      return adoption(ids[0], live);
    }
    return { mode: 'create', id };
  }

  function adoption(id, live) {
    const errs = wholeBodyErrors(flow, live.view);
    if (errs.length) throw coded('bpf-whole-body-required', `${label}: adopting a flow needs a declaration that names its whole current body, in order: ${errs.join('; ')}`);
    return { mode: 'adopt', id, live };
  }

  async function plan({ resolution }) {
    const root = (id) => ({ kind: ROOT_KIND, key, id });
    if (resolution.mode === 'noop') return { noop: true };
    if (resolution.mode === 'adopt') {
      const { id, live } = resolution;
      const map = positionalMap(flow, live.view.projection);
      const expected = expectedOf({ id, sent: live.view, desiredStatus: live.view.status, map, live });
      return { root: root(id), expected, declarationSha256, publication: null, mode: 'adopt', map };
    }
    if (resolution.mode === 'create') {
      const { id, map } = createMap();
      if (id !== resolution.id) throw coded(CODES.notSettled, `${label}: the catalog answered two ids for one flow`);
      const staged = await stageCreate(id, map);
      checkStaged(staged.sent, map);
      const expected = expectedOf({ id, sent: staged.sent, desiredStatus: staged.desiredStatus, map, live: null });
      return { root: root(id), expected, declarationSha256, publication: null, mode: 'create', staged, map };
    }
    const { id, live, held } = resolution;
    const map = editedMap(id, held);
    const staged = await stageEdit(id, live.view, map);
    checkStaged(staged.sent, map);
    const expected = expectedOf({ id, sent: staged.sent, desiredStatus: staged.desiredStatus, map, live });
    return { root: root(id), expected, declarationSha256, publication: null, mode: 'edit', live, map };
  }

  async function apply({ token, plan: planned }) {
    run.token = token;
    if (planned.mode === 'adopt') return { mode: 'adopt', acknowledged: false, map: planned.map };
    if (planned.mode === 'create') return { mode: 'create', ...(await driveCreate(token, planned.root.id, planned.staged, false)), map: planned.map };
    await driveEdit(token, planned.root.id, { live: planned.live, map: planned.map, expected: planned.expected });
    return { mode: 'edit', acknowledged: false, map: planned.map };
  }

  async function prove({ token, expected, applied, recovering }) {
    run.token = token;
    const id = expected.rootId;
    if (!recovering) {
      const committedOrigin = run.committed ? (run.committed.records.find((r) => r.kind === ROOT_KIND) || {}).origin : null;
      const created = applied.mode === 'create' && applied.acknowledged;
      return finalProof(id, expected, applied.map, committedOrigin || (created ? 'created' : 'adopted'), created);
    }
    // Recovery: the change may already be on the server. Nothing is planned again; the attempt's own effects are
    // proved by reading at the ids the catalog derives again, and only what is definitely unsent may still be sent
    // (under its stored record). `expected`, persisted before the first send, names every child id to prove.
    const { committed } = store.readGroup(FAMILY, key);
    run.committed = committed;
    const { attempt, effects } = attemptOf(token);
    if (attempt.declarationSha256 !== declarationSha256) {
      throw coded(CODES.pending, `${label}: an earlier change of this flow is not proved, and the declaration it was sent from has changed; restore that declaration to finish it`);
    }
    if (!committed) {
      if (effects.some((e) => e.effect === 'create') || (await readLive(id)).missing) {
        if (createMap().id !== id) throw coded(CODES.pending, `${label}: the pending create is at another id than the catalog derives`);
        await driveCreate(token, id, null, true);
        return finalProof(id, expected, createMap().map, 'adopted', false);
      }
      const live = await readLive(id);
      return finalProof(id, expected, positionalMap(flow, live.view.projection), 'adopted', false);
    }
    const origin = (committed.records.find((r) => r.kind === ROOT_KIND) || {}).origin || 'adopted';
    const held = (committed.consumerState && committed.consumerState.stages) || [];
    const live = await readLive(id);
    // The status the change was meant to end in, when the row as it is now carries exactly what was sent. A row that
    // carries the sent body but is still Draft is an edit stopped between its body and its own activation.
    const target = live.missing ? null : statusFor(expected, live.view.projection);
    if (target === null || (target !== live.view.status && !(target === ACTIVE && effects.length))) {
      if (!effects.length) throw coded(CODES.pending, `${label}: an earlier change of this flow was prepared and not sent; re-run with the same declaration and the edit switch to finish it`);
      throw coded(CODES.pending, `${label}: an earlier edit of this flow is not proved by the row as it is now; it is not sent again`);
    }
    // An edit's map is derived again (held ids, catalog ids for the new children); a re-adoption's is positional.
    const edited = editedMap(id, held);
    const fits = mapFits(edited, live.view.projection);
    if (!fits && !Array.isArray(flow.stages)) throw coded(CODES.pending, `${label}: an earlier change of this flow cannot be matched to its stages; re-run with the declaration it was made from`);
    const map = fits ? edited : positionalMap(flow, live.view.projection);
    for (const e of effects) {
      if (e.state === 'confirmed') continue;
      // The edit's own activation is finished below (driveState sends it only when it is definitely unsent).
      if (e.effect === 'state' && e.desiredState === ACTIVE && live.view.status !== ACTIVE) continue;
      if (e.state === 'definitely-unsent') throw coded(CODES.pending, `${label}: an earlier edit of this flow has a write that was never sent`);
      if (e.effect === 'state') {
        if (e.desiredState === live.view.status) store.confirmEffect(e.token, { observedState: e.desiredState });
        else if (e.desiredState === DRAFT) throw coded(CODES.pending, `${label}: an earlier edit's state change is not proved`);
      } else {
        store.confirmEffect(e.token, { observedSha256: e.desiredSha256 });
      }
    }
    // The body is on the row and proved; only the edit's own activation is missing. It is sent (once, against the
    // version of this read) when it never left; one that may have left is proved by reading, never sent again.
    if (target === ACTIVE && live.view.status !== ACTIVE) await driveState(token, id, ACTIVE, live.version, { conditional: true });
    // A Draft state effect the row has since left (the edit's own Active) is proved by the later Active write.
    for (const e of attemptOf(token).effects) {
      if (e.state !== 'confirmed' && e.effect === 'state' && e.desiredState === DRAFT) {
        const active = attemptOf(token).effects.find((x) => x.effect === 'state' && x.desiredState === ACTIVE && x.state === 'confirmed');
        if (!active) throw coded(CODES.pending, `${label}: an earlier edit's state change is not proved`);
        store.confirmEffect(e.token, { observedState: DRAFT });
      }
    }
    return finalProof(id, expected, map, origin, false);
  }

  const out = await runManagedFeature({
    phase, family: FAMILY, key, label, knownScopes: [], knownIds: [], store, barrier, halt,
    resolve, plan, apply, prove, ensureMembership,
  });
  const group = out.committedGroup || null;
  const id = group && group.root ? group.root.id : null;
  const decl = group && group.consumerState ? group.consumerState.declaration : null;
  return { ...out.result, id, uniqueName: (decl && decl.backing) || null };
}

module.exports = {
  settleDeclaredBpf,
  validateDeclaredBpf,
  isDeclaredBpf,
  bpfKey,
  projectBpf,
  editsOf,
  structureErrors,
  wholeBodyErrors,
  EDIT_REFUSED_REMEDY,
  PROOF_SCHEMA,
};
