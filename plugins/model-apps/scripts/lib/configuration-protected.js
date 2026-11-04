'use strict';
// Protected configuration (`configurationIdentity: "stable-v1"`): the build side of exact ids and a binding store for the
// declared environment variables, connection references, Custom APIs and duplicate detection rules.
//
// This module is loaded only when the App Spec sets the opt-in (configuration-build.js), so a build without it loads none
// of the protected modules. It answers two things, both through the configuration create driver
// (configuration-create-bindings.js) and the managed create lifecycle (managed-create-context.js):
//   preflight   a whole-plan, read-only pass run before the build changes ANYTHING (the solution, its version, a table):
//               every declared item is located by its binding, never by name, and an edit the protected path cannot
//               make is refused here, so an unsupported edit never leaves the build half applied;
//   port        the create port configuration-artifacts.js uses under the opt-in (configurationAcceptsPort): exact-id
//               resolution from the binding store, the mandatory complete namesake query, then one create set run
//               through the send-once gate, observed and settled into the store.
//
// The supported shapes are deliberately narrow. A duplicate rule is created with its conditions, completes its initial
// publication or state, and is then only verified: any later field, condition or state change is refused. A Custom API
// edit is either one request on its own (the root's editable fields, one new child, or one child's labels) or one
// checked change set the SDK sends (the root PATCH with new children, or two or more new children); a removal, a change
// to a child's fixed fields or any other combination is refused.

const B = require('./configuration-create-bindings.js');
const { normalizeGuid } = require('./reconcile-common.js');

const IDENTITY = 'stable-v1';
const EDIT_CODE = 'configuration-edit-unsupported';
const UNVERIFIED_CODE = 'create-identity-unverified';
const CONFLICT_CODE = 'create-identity-conflict';

const RULE_EDIT_MESSAGE = 'This protected duplicate rule can be created with its conditions and initial state, then verified. '
  + 'Later field, condition or state edits are not supported. No service changes were sent by this build. '
  + 'Make this edit outside the plugin, keeping the binding store and exact ids.';
const API_EDIT_MESSAGE = 'This protected Custom API change is not a supported single request or create-only changeset. '
  + 'No service changes were sent by this build. Separate supported non-removing single-request edits across builds, '
  + 'or make the change outside the plugin. Removals require maintenance outside the plugin.';
const REMOVAL_MESSAGE = 'Removing a child of a protected Custom API is not supported. No service changes were sent by this build. '
  + 'Removals require maintenance outside the plugin.';

// The declared lists of the protected kinds, in the order configuration-artifacts.js applies them.
const LISTS = Object.freeze([
  ['environmentVariable', 'environmentVariables', 'schemaName'],
  ['connectionReference', 'connectionReferences', 'logicalName'],
  ['customApi', 'customApis', 'uniqueName'],
  ['duplicateRule', 'duplicateDetectionRules', 'key'],
]);
const KINDS = new Set(LISTS.map(([kind]) => kind));

const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
/** The opt-in: exactly `configurationIdentity: "stable-v1"` (app-spec.js refuses any other value). */
const configurationIdentityOf = (spec) => has(spec, 'configurationIdentity') && spec.configurationIdentity === IDENTITY;

function stop(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function declaredItems(spec) {
  const out = [];
  for (const [kind, list, field] of LISTS) {
    for (const entry of Array.isArray(spec && spec[list]) ? spec[list] : []) {
      if (entry && typeof entry[field] === 'string') out.push({ kind, key: entry[field] });
    }
  }
  return out;
}

// A child record's slot: the driver keys a child row `JSON.stringify([<root key>, <slot>])` (planOf).
function slotOf(record) {
  try {
    const parsed = JSON.parse(record.key);
    return Array.isArray(parsed) && parsed.length === 2 && typeof parsed[1] === 'string' ? parsed[1] : null;
  } catch {
    return null;
  }
}

/**
 * Locate one declared item by its binding and plan it, reading only:
 *   { state: 'unbound', planned }   no committed binding: a create at the derived ids;
 *   { state: 'pending', planned }   an attempt is pending (the lifecycle recovers it from its own expectation);
 *   { state: 'bound', planned }     the committed binding, every bound row read fresh at its exact id.
 * A bound row read absent is `configuration-row-not-found` (never replaced by a namesake), an unreadable one or a binding
 * whose ids the declaration no longer derives is `create-identity-unverified`; both throw, typed.
 */
async function locateItem(env, kind, key) {
  const { spec, store, dataverse, solution, bindings, componentTypes } = env;
  const fresh = B.planOf(spec, { kind, key, bindings, solution, componentTypes });
  const group = store.readGroup(kind, fresh.key);
  if (group.pending) return { state: 'pending', planned: fresh };
  if (!group.committed) return { state: 'unbound', planned: fresh };
  const records = group.committed.records || [];
  const root = records.find((r) => r.kind === kind && r.key === fresh.key);
  if (!root) throw stop(UNVERIFIED_CODE, `the binding of ${kind} "${fresh.key}" holds no root row`, { kind, key: fresh.key });
  const rootId = normalizeGuid(root.id);
  const read = async (r) => {
    const got = await B.readConfigurationRow(dataverse, r.kind, normalizeGuid(r.id));
    if (got.state === 'absent') throw stop(B.NOT_FOUND_CODE, `the bound ${r.kind} of ${kind} "${fresh.key}" (${normalizeGuid(r.id)}) is gone; it is not replaced by a namesake`, { kind, key: fresh.key, id: normalizeGuid(r.id) });
    if (got.state !== 'present') throw stop(UNVERIFIED_CODE, `the bound ${r.kind} of ${kind} "${fresh.key}" could not be read`, { kind, key: fresh.key, id: normalizeGuid(r.id) });
    return got;
  };
  const bases = new Map([[rootId, await read(root)]]);
  // Only the children the declaration still names are bound children of the plan; a bound child it no longer names is
  // left to the complete child graph (editShapeOf), where it is a removal — never deleted, never adopted.
  const declaredSlots = new Set(fresh.rows.filter((r) => r.slot !== null).map((r) => r.slot));
  const boundSlots = [];
  for (const r of records) {
    if (r === root) continue;
    const slot = slotOf(r);
    if (slot === null || !declaredSlots.has(slot)) continue;
    bases.set(normalizeGuid(r.id), await read(r));
    boundSlots.push(slot);
  }
  const planned = B.planOf(spec, {
    kind, key, bindings, solution, componentTypes, bases, boundSlots, baseGeneration: group.committed.generation,
    // Only this item is bound in its own plan: another item of the kind is planned (and judged) on its own.
    boundIdOf: (k, pk) => (k === kind && pk === fresh.key ? rootId : undefined),
  });
  for (const r of records) {
    const row = planned.rows.find((x) => x.kind === r.kind && x.key === r.key);
    if (row && row.id !== normalizeGuid(r.id)) throw stop(UNVERIFIED_CODE, `the binding of ${kind} "${fresh.key}" names another ${r.kind} than the declaration derives`, { kind, key: fresh.key });
  }
  return { state: 'bound', planned };
}

/**
 * The verdict on a bound item's edit (editShapeOf), or null when the protected path can make it:
 *   a rule: any change at all is unsupported (created, published once, then only verified);
 *   a Custom API: one request on its own, the root PATCH with one or more new children, or two or more new children only.
 */
function editVerdict(kind, shape) {
  if (kind === 'duplicateRule') {
    const changed = shape.rootChanged || shape.ruleStateChanged || shape.creates.length || shape.labelEdits.length || shape.fixedEdits.length || shape.removals.length;
    return changed ? { code: EDIT_CODE, message: RULE_EDIT_MESSAGE } : null;
  }
  if (kind !== 'customApi') return null;
  const root = shape.rootChanged ? 1 : 0;
  const creates = shape.creates.length;
  const edits = shape.labelEdits.length;
  if (shape.removals.length) {
    return shape.removals.length === 1 && !root && !creates && !edits && !shape.fixedEdits.length
      ? { code: B.DELETE_CODE, message: REMOVAL_MESSAGE }
      : { code: EDIT_CODE, message: API_EDIT_MESSAGE };
  }
  if (shape.fixedEdits.length) return { code: EDIT_CODE, message: API_EDIT_MESSAGE };
  if (root + creates + edits <= 1) return null;
  if (!edits && (root ? creates >= 1 : creates >= 2)) return null;
  return { code: EDIT_CODE, message: API_EDIT_MESSAGE };
}

// What every protected read needs, read once per build: the solution's component types (membership is planned only
// outside the restricted solutions, but the read is cheap and fail-closed).
async function environmentOf({ spec, store, dataverse, solution, bindings }) {
  const types = await B.readComponentTypes(dataverse);
  if (!types || !types.complete) throw stop(UNVERIFIED_CODE, 'the solution component types could not be read');
  return { spec, store, dataverse, solution, bindings, componentTypes: types.types };
}

/**
 * The whole-plan, read-only preflight: every declared protected item located by its binding and, for a bound Custom API
 * or duplicate rule, its edit judged. Sends nothing. Answers { halts: [{ kind, key, id?, code, message }] } — empty when
 * the build may continue. A read that cannot be completed is a halt (`create-identity-unverified`), never "no change".
 */
async function preflightProtectedConfiguration({ spec, store, dataverse, solution, bindings }) {
  if (!configurationIdentityOf(spec)) return { halts: [] };
  const halts = [];
  let env;
  try {
    env = await environmentOf({ spec, store, dataverse, solution, bindings });
  } catch (error) {
    return { halts: [{ kind: 'configuration', key: '*', code: error.code || UNVERIFIED_CODE, message: error.message }] };
  }
  for (const { kind, key } of declaredItems(spec)) {
    try {
      const item = await locateItem(env, kind, key);
      if (item.state !== 'bound' || (kind !== 'customApi' && kind !== 'duplicateRule')) continue;
      const shape = await B.editShapeOf(dataverse, item.planned);
      if (shape.state !== 'complete') { halts.push({ kind, key: item.planned.key, code: UNVERIFIED_CODE, message: `the ${kind} "${item.planned.key}" could not be read completely` }); continue; }
      if (shape.missing.length) { halts.push({ kind, key: item.planned.key, id: shape.missing[0].id, code: B.NOT_FOUND_CODE, message: `a bound row of ${kind} "${item.planned.key}" is gone; it is not replaced by a namesake` }); continue; }
      const verdict = editVerdict(kind, shape);
      if (verdict) halts.push({ kind, key: item.planned.key, ...verdict });
    } catch (error) {
      halts.push({ kind, key, ...(error.id ? { id: error.id } : {}), code: error.code || UNVERIFIED_CODE, message: error.message });
    }
  }
  return { halts };
}

// The members a planned create still owes the solution, added in the create set's own scope (the classifier admits only
// the planned memberships): POST /AddSolutionComponent { ComponentId, ComponentType, SolutionUniqueName, AddRequiredComponents }.
async function addMissingMembers(dataverse, planned, scope) {
  const seen = await B.observe(dataverse, planned);
  const missing = seen.members.filter((m) => m.state === 'absent').map((m) => planned.plan.members.find((x) => x.id === m.id)).filter(Boolean);
  if (!missing.length) return { localError: null, error: null };
  return scope(async () => {
    for (const m of missing) {
      // eslint-disable-next-line no-await-in-loop
      await dataverse.post('/AddSolutionComponent', { ComponentId: m.id, ComponentType: m.componentType, SolutionUniqueName: planned.solution, AddRequiredComponents: false });
    }
  });
}

/**
 * The create port configuration-artifacts.js uses for the protected kinds (configurationAcceptsPort accepts it):
 *   protects(kind)                      the four configuration kinds;
 *   resolve({ kind, key })              { state: 'present', id } for a bound item (read at its exact id), or
 *                                       { state: 'absent', id } with the derived id when nothing is bound and that id is
 *                                       free; anything else throws, typed — never a name lookup;
 *   run({ kind, key }, fn)              the mandatory complete namesake query, then ONE create set: fn({ id, childIds })
 *                                       pushes the artifact through the gate, the members are added, and the attempt is
 *                                       observed and settled into the store. Answers { outcome: 'created', id, childIds,
 *                                       result } only for a committed create; anything else throws, typed;
 *   exact                               true: configuration-artifacts.js skips its name lookup for a protected kind;
 *   updates(kind)                       true for a Custom API, whose supported edits go through update();
 *   update({ kind, key, id }, fn)       ONE checked set for a bound Custom API edit the preflight admitted: fn({ id,
 *                                       childIds }) pushes the edit through the gate (a multi-request edit as one
 *                                       change set when apiBase is known, refused unsent otherwise), new children are
 *                                       added to the solution, and the attempt is observed and settled. Answers
 *                                       { outcome: 'updated', id, childIds, result }; anything else throws, typed.
 */
function protectedConfigurationPort({ spec, store, ctx, dataverse, solution, bindings, apiBase = null }) {
  let envPromise = null;
  const env = () => (envPromise = envPromise || environmentOf({ spec, store, dataverse, solution, bindings }));
  return {
    // The binding store is the authority on these kinds: locate asks this port before any other record (configuration-artifacts.js).
    exact: true,
    protects: (kind) => KINDS.has(kind),
    async resolve({ kind, key }) {
      const item = await locateItem(await env(), kind, key);
      const rootId = item.planned.plan.rows[0].id;
      if (item.state === 'bound') return { state: 'present', id: rootId };
      if (item.state === 'pending') throw stop(UNVERIFIED_CODE, `the ${kind} "${item.planned.key}" has a pending attempt that must be recovered first`, { kind, key: item.planned.key, id: rootId });
      const read = await B.readConfigurationRow(dataverse, kind, rootId);
      if (read.state === 'absent') return { state: 'absent', id: rootId };
      // A row at the derived id that no binding holds is not adopted silently: adoption needs its own approval.
      throw stop(read.state === 'present' ? CONFLICT_CODE : UNVERIFIED_CODE, `the ${kind} "${item.planned.key}" derived id is ${read.state === 'present' ? 'taken by a row no binding holds' : 'unreadable'}`, { kind, key: item.planned.key, id: rootId });
    },
    async run({ kind, key }, fn) {
      const item = await locateItem(await env(), kind, key);
      if (item.state !== 'unbound') throw stop(UNVERIFIED_CODE, `the ${kind} "${item.planned.key}" is not a create`, { kind, key: item.planned.key });
      const { planned } = item;
      const conflicts = await B.readConfigurationConflicts(dataverse, planned);
      if (conflicts.state !== 'clear') throw stop(conflicts.code || UNVERIFIED_CODE, `the ${kind} "${planned.key}" namesake query answered ${conflicts.state}`, { kind, key: planned.key });
      const [attempt] = ctx.begin([planned.plan]);
      const classify = B.createSetClassifier([{ token: attempt.token, planned }]);
      const label = `configuration create ${kind} ${planned.key}`;
      const scope = (send, acceptResult) => ctx.run({ attempts: [attempt], classify, deleteCode: B.DELETE_CODE, label, acceptResult }, send);
      const id = planned.plan.rows[0].id;
      const childIds = Object.fromEntries(planned.rows.filter((r) => r.slot !== null).map((r) => [r.slot, r.id]));
      const pushed = await scope(() => fn({ id, childIds }), B.acceptResultFor(planned));
      if (pushed.error) throw pushed.error;
      if (pushed.localError) throw stop(pushed.localError.code || UNVERIFIED_CODE, String(pushed.localError.message || pushed.localError), { kind, key: planned.key, id });
      if (!pushed.checked) throw stop('create-outcome-unknown', `the ${kind} "${planned.key}" create was not acknowledged`, { kind, key: planned.key, id });
      const added = await addMissingMembers(dataverse, planned, scope);
      if (added.error || added.localError) throw stop('create-outcome-unknown', `the ${kind} "${planned.key}" solution membership was not acknowledged`, { kind, key: planned.key, id });
      const [settled] = ctx.settle([{ token: attempt.token, observation: await B.observe(dataverse, planned) }]);
      if (settled.verdict.action !== 'commit') throw stop(settled.verdict.code || UNVERIFIED_CODE, settled.verdict.message || `the ${kind} "${planned.key}" create was not proved`, { kind, key: planned.key, id });
      return { outcome: 'created', id, childIds, result: pushed.value };
    },
    /**
     * A bound Custom API's edit (configuration-artifacts.js applyUpdate): the plan is made again from fresh reads of the
     * bound rows at their exact ids (never a name), and `fn({ childIds })` — the SDK's own element updates and ONE push —
     * runs inside that plan's create set: a single request on its own, or the one checked change set the SDK sends for
     * the root PATCH with new children or for new children only (`batch`). The new children take the plan's derived ids.
     * Answers { outcome: 'updated', id, childIds, result } only for a committed edit; anything else throws, typed. The
     * build's preflight has already refused every shape the protected path cannot make, before anything was sent.
     */
    updates: (kind) => kind === 'customApi',
    async update({ kind, key, id }, fn) {
      const item = await locateItem(await env(), kind, key);
      const { planned } = item;
      if (item.state !== 'bound' || planned.plan.rows[0].id !== normalizeGuid(id)) throw stop(UNVERIFIED_CODE, `the ${kind} "${planned.key}" is not bound at ${normalizeGuid(id)}`, { kind, key: planned.key });
      if (planned.rows.some((r) => r.mode === 'create')) {
        const conflicts = await B.readConfigurationConflicts(dataverse, planned);
        if (conflicts.state !== 'clear') throw stop(conflicts.code || UNVERIFIED_CODE, `the ${kind} "${planned.key}" namesake query answered ${conflicts.state}`, { kind, key: planned.key });
      }
      const [attempt] = ctx.begin([planned.plan]);
      const classify = B.createSetClassifier([{ token: attempt.token, planned }]);
      const label = `configuration edit ${kind} ${planned.key}`;
      const batch = apiBase ? { batch: { apiBase, solution: planned.solution } } : {};
      const scope = (send, acceptResult) => ctx.run({ attempts: [attempt], classify, deleteCode: B.DELETE_CODE, label, acceptResult, ...batch }, send);
      const childIds = Object.fromEntries(planned.rows.filter((r) => r.slot !== null && r.mode === 'create').map((r) => [r.slot, r.id]));
      const rootId = planned.plan.rows[0].id;
      const pushed = await scope(() => fn({ childIds }), B.acceptResultFor(planned));
      if (pushed.error) throw pushed.error;
      if (pushed.localError) throw stop(pushed.localError.code || UNVERIFIED_CODE, String(pushed.localError.message || pushed.localError), { kind, key: planned.key, id: rootId });
      if (!pushed.checked) throw stop('create-outcome-unknown', `the ${kind} "${planned.key}" edit was not acknowledged`, { kind, key: planned.key, id: rootId });
      const added = await addMissingMembers(dataverse, planned, scope);
      if (added.error || added.localError) throw stop('create-outcome-unknown', `the ${kind} "${planned.key}" solution membership was not acknowledged`, { kind, key: planned.key, id: rootId });
      const [settled] = ctx.settle([{ token: attempt.token, observation: await B.observe(dataverse, planned) }]);
      if (settled.verdict.action !== 'commit') throw stop(settled.verdict.code || UNVERIFIED_CODE, settled.verdict.message || `the ${kind} "${planned.key}" edit was not proved`, { kind, key: planned.key, id: rootId });
      return { outcome: 'updated', id: rootId, childIds, result: pushed.value };
    },
  };
}

/**
 * The build's configuration hookup: what the build calls with the binding store, the send-once gate bound to it and the
 * managed create context over both, once a protected feature is selected. Answers { preflight, port }: preflight runs the
 * read-only whole-plan pass, port is the create port the configuration runtime installs. Nothing here creates a gate or
 * a store: the build owns them.
 */
function createProtectedConfiguration({ store, gate, ctx, apiBase = null } = {}) {
  if (!store || typeof store.readGroup !== 'function') throw new TypeError('createProtectedConfiguration needs the managed binding store');
  if (!ctx || typeof ctx.begin !== 'function' || typeof ctx.run !== 'function' || typeof ctx.settle !== 'function') throw new TypeError('createProtectedConfiguration needs the managed create context');
  return {
    store,
    gate,
    ctx,
    preflight: ({ spec, dataverse, solution, bindings }) => preflightProtectedConfiguration({ spec, store, dataverse, solution, bindings }),
    port: ({ spec, dataverse, solution, bindings }) => protectedConfigurationPort({ spec, store, ctx, dataverse, solution, bindings, apiBase }),
  };
}

module.exports = {
  EDIT_CODE,
  RULE_EDIT_MESSAGE,
  API_EDIT_MESSAGE,
  configurationIdentityOf,
  editVerdict,
  preflightProtectedConfiguration,
  protectedConfigurationPort,
  createProtectedConfiguration,
};
