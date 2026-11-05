'use strict';
// Protected configuration (`configurationIdentity: "stable-v1"`): the build side of exact ids and a binding store for the
// declared environment variables, connection references, Custom APIs and duplicate detection rules.
//
// This module is loaded only when the App Spec sets the opt-in, or when the build hands over its binding store without it
// (configuration-build.js), so a build with neither loads none of the protected modules. It answers four things, the first
// two through the configuration create driver
// (configuration-create-bindings.js) and the managed create lifecycle (managed-create-context.js):
//   preflight   a whole-plan, read-only pass run before the build changes ANYTHING (the solution, its version, a table):
//               every declared item is located by its binding, never by name, and an edit the protected path cannot
//               make is refused here, so an unsupported edit never leaves the build half applied;
//   port        the create port configuration-artifacts.js uses under the opt-in (configurationAcceptsPort): exact-id
//               resolution from the binding store, the mandatory complete namesake query, then one create set run
//               through the send-once gate, observed and settled into the store;
//   verify      the same exact location over the workspace's binding store as verify reads it, read-only;
//   opt-out     a build without the opt-in whose binding store still holds a declared item stops before any request.
//
// The supported shapes are deliberately narrow. A duplicate rule is created with its conditions, completes its initial
// publication or state, and is then only verified: any later field, condition or state change is refused. A Custom API
// edit is either one request on its own (the root's editable fields, one new child, or one child's labels) or one
// checked change set the SDK sends (the root PATCH with new children, or two or more new children); a removal, a change
// to a child's fixed fields or any other combination is refused.

const B = require('./configuration-create-bindings.js');
const A = require('./configuration-artifacts.js');
const { normalizeGuid } = require('./reconcile-common.js');

const IDENTITY = 'stable-v1';
const EDIT_CODE = 'configuration-edit-unsupported';
const UNVERIFIED_CODE = 'create-identity-unverified';
const CONFLICT_CODE = 'create-identity-conflict';
const OPT_IN_CODE = 'create-identity-opt-in-required';
// The store's own code for a group whose attempt is not settled yet.
const PENDING_CODE = require('./managed-bindings.js').CODES.pending;

const RULE_EDIT_MESSAGE = 'This protected duplicate rule can be created with its conditions and initial state, then verified. '
  + 'Later field, condition or state edits are not supported. No service changes were sent by this build. '
  + 'Make this edit outside the plugin, keeping the binding store and exact ids.';
const API_EDIT_MESSAGE = 'This protected Custom API change is not a supported single request or create-only changeset. '
  + 'No service changes were sent by this build. Separate supported non-removing single-request edits across builds, '
  + 'or make the change outside the plugin. Removals require maintenance outside the plugin.';
const REMOVAL_MESSAGE = 'Removing a child of a protected Custom API is not supported. No service changes were sent by this build. '
  + 'Removals require maintenance outside the plugin.';
const VALUE_REMOVAL_MESSAGE = 'Clearing the value of a protected environment variable deletes its value row, which is not supported. '
  + 'No service changes were sent by this build. Removals require maintenance outside the plugin.';

// The declared lists of the protected kinds, in the order configuration-artifacts.js applies them.
const LISTS = Object.freeze([
  ['environmentVariable', 'environmentVariables', 'schemaName'],
  ['connectionReference', 'connectionReferences', 'logicalName'],
  ['customApi', 'customApis', 'uniqueName'],
  ['duplicateRule', 'duplicateDetectionRules', 'key'],
]);
const KINDS = new Set(LISTS.map(([kind]) => kind));

const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
// The deployment-settings bindings (configuration-artifacts.js readDeploymentBindings) hold { value: null } for a clear,
// keyed by the lower-case schema name — the same key as the variable's plan.
const clearsValue = (bindings, key) => {
  const got = bindings && bindings.environmentVariables instanceof Map ? bindings.environmentVariables.get(key) : undefined;
  return !!got && got.value === null;
};
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
 *   { state: 'pending', planned, token, edit }   an attempt is pending (recoverPending decides it from its own expectation);
 *   { state: 'bound', planned }     the committed binding, every bound row read fresh at its exact id.
 * A bound row read absent is `configuration-row-not-found` (never replaced by a namesake), an unreadable one or a binding
 * whose ids the declaration no longer derives is `create-identity-unverified`; both throw, typed.
 */
async function locateItem(env, kind, key) {
  const { spec, store, dataverse, solution, bindings, componentTypes } = env;
  const fresh = B.planOf(spec, { kind, key, bindings, solution, componentTypes });
  const group = store.readGroup(kind, fresh.key);
  if (group.pending) return { state: 'pending', planned: fresh, token: group.pending.token, edit: !!group.committed };
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
  // left to the complete child graph (editShapeOf), where it is a removal — never deleted, never adopted. The one
  // exception is a variable's bound value its deployment settings do not name this run (and do not clear): it is still
  // the variable's own row, so the plan keeps it at its bound id, sends nothing for it, and an edit of the definition is
  // not judged a conflict over it. A kept value read absent is no longer there to keep (it was deleted outside the
  // plugin); nothing is planned for it, and settings that name a value again find its binding gone (not found).
  const declaredSlots = new Set(fresh.rows.filter((r) => r.slot !== null).map((r) => r.slot));
  const boundSlots = [];
  const keptChildren = {};
  for (const r of records) {
    if (r === root) continue;
    const slot = slotOf(r);
    if (slot === null) continue;
    if (!declaredSlots.has(slot)) {
      if (kind !== 'environmentVariable' || slot !== 'value' || clearsValue(bindings, fresh.key)) continue;
      const got = await B.readConfigurationRow(dataverse, r.kind, normalizeGuid(r.id));
      if (got.state === 'absent') continue;
      if (got.state !== 'present') throw stop(UNVERIFIED_CODE, `the bound ${r.kind} of ${kind} "${fresh.key}" could not be read`, { kind, key: fresh.key, id: normalizeGuid(r.id) });
      keptChildren[slot] = normalizeGuid(r.id);
      continue;
    }
    bases.set(normalizeGuid(r.id), await read(r));
    boundSlots.push(slot);
  }
  const planned = B.planOf(spec, {
    kind, key, bindings, solution, componentTypes, bases, boundSlots, keptChildren, baseGeneration: group.committed.generation,
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

/**
 * The verdict on a bound environment variable's or connection reference's update, or null when the protected path can
 * make it (protectedConfigurationPort update: one checked set over the item's complete root/child plan). Read only:
 *   a row under the root that its binding does not hold (a value made outside the plugin) is neither overwritten nor
 *     adopted when this run would write the item — whatever destructive authorization the maker gave, which approves
 *     replacing the item's OWN value, never taking over another row: create-identity-conflict;
 *   a child the update would create (a first value) runs its complete namesake query first: any value already under
 *     the definition is a conflict, and a query that does not complete is create-identity-unverified.
 * A run that writes nothing for the item (no definition change, no value or connection named) is not judged: a value a
 * maker set in the environment by hand does not stop a build that leaves the variable alone.
 */
async function childVerdict(env, planned, shape) {
  const { bindings, dataverse } = env;
  const named = planned.kind === 'environmentVariable'
    ? !!(bindings && bindings.environmentVariables instanceof Map && bindings.environmentVariables.get(planned.key))
    : !!(bindings && bindings.connectionReferences instanceof Map && bindings.connectionReferences.get(planned.key));
  if (!shape.rootChanged && !shape.creates.length && !shape.fixedEdits.length && !named) return null;
  if (shape.removals.length) {
    return { code: CONFLICT_CODE, message: `the ${planned.kind} "${planned.key}" has a row under it that its binding does not hold (${shape.removals.join(', ')}); it is neither overwritten nor adopted, and no service changes were sent by this build. Remove or reconcile that row outside the plugin, then run again` };
  }
  if (!shape.creates.length) return null;
  const conflicts = await B.readConfigurationConflicts(dataverse, planned);
  if (conflicts.state === 'clear') return null;
  return { code: conflicts.code || UNVERIFIED_CODE, message: `the ${planned.kind} "${planned.key}" namesake query for its new row answered ${conflicts.state}; no service changes were sent by this build` };
}

/**
 * A pending attempt is decided from its OWN persisted expectation (managed-create-context.js classifyRecovery), read-only,
 * never re-planned from today's rows. For a create that is what keeps the original plan's completion owed: a duplicate
 * rule created without an explicit status owes its initial publication, and a rerun after a partial create proves the
 * rows and that state at the same ids — it commits only when the rule is published (by the original send, or by the
 * maker under the same id), and it never sends the publication again: an uncertain or failed publish is not replayed,
 * it stays a create-completion-required halt. A declaration changed since the attempt is managed-pending-intent-changed.
 * A pending EDIT of a bound row is not recovered here (its plan depends on the base it read): it stays unverified.
 * Answers { verdict, observation }.
 */
async function recoverPending(env, ctx, item) {
  const { planned } = item;
  if (item.edit || !ctx) {
    return { verdict: { action: 'halt', code: UNVERIFIED_CODE, message: `the ${planned.kind} "${planned.key}" has a pending ${item.edit ? 'edit' : 'attempt'} that this build cannot recover; nothing is sent for it` } };
  }
  const observation = await B.observe(env.dataverse, planned);
  return { observation, verdict: ctx.classify(item.token, observation, { declarationSha256: planned.plan.declarationSha256 }) };
}

const haltOf = (kind, key, verdict) => ({
  kind, key, ...(verdict.rows && verdict.rows[0] ? { id: verdict.rows[0].id } : {}), code: verdict.code || UNVERIFIED_CODE, message: verdict.message || `the ${kind} "${key}" could not be recovered`,
  ...(Array.isArray(verdict.approvals) && verdict.approvals.length ? { approvals: verdict.approvals.slice() } : {}),
});

// What every protected read needs, read once per build: the solution's component types (membership is planned only
// outside the restricted solutions, but the read is cheap and fail-closed).
async function environmentOf({ spec, store, dataverse, solution, bindings }) {
  const types = await B.readComponentTypes(dataverse);
  if (!types || !types.complete) throw stop(UNVERIFIED_CODE, 'the solution component types could not be read');
  return { spec, store, dataverse, solution, bindings, componentTypes: types.types };
}

/**
 * The whole-plan, read-only preflight: every declared protected item located by its binding and its edit judged — a
 * bound Custom API or duplicate rule by its supported shapes (editVerdict), a bound environment variable or connection
 * reference by its complete root/child plan (childVerdict), and a bound variable's value clear is a removal and refused.
 * Sends nothing. Answers { halts: [{ kind, key, id?, code, message }] } — empty when
 * the build may continue. A read that cannot be completed is a halt (`create-identity-unverified`), never "no change".
 */
async function preflightProtectedConfiguration({ spec, store, ctx, dataverse, solution, bindings }) {
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
      if (item.state === 'pending') {
        const { verdict } = await recoverPending(env, ctx, item);
        if (verdict.action === 'halt') halts.push(haltOf(kind, item.planned.key, verdict));
        continue;
      }
      if (item.state !== 'bound') continue;
      // Clearing a bound variable's value (a deployment-settings Value of null) is a DELETE of its value row, a physical
      // removal the protected path does not make, authorized or not. A settings entry that leaves the value alone ("" or
      // none) or replaces it is not a clear; those keep the ordinary path and its authorization.
      const clears = kind === 'environmentVariable' && clearsValue(bindings, item.planned.key);
      const shape = await B.editShapeOf(dataverse, item.planned);
      if (shape.state !== 'complete') { halts.push({ kind, key: item.planned.key, code: UNVERIFIED_CODE, message: `the ${kind} "${item.planned.key}" could not be read completely` }); continue; }
      if (shape.missing.length) { halts.push({ kind, key: item.planned.key, id: shape.missing[0].id, code: B.NOT_FOUND_CODE, message: `a bound row of ${kind} "${item.planned.key}" is gone; it is not replaced by a namesake` }); continue; }
      // A clear plans no value row, so a value row under the definition is the removal the clear would send.
      const verdict = clears ? (shape.removals.length ? { code: B.DELETE_CODE, message: VALUE_REMOVAL_MESSAGE } : null)
        : kind === 'customApi' || kind === 'duplicateRule' ? editVerdict(kind, shape)
          : await childVerdict(env, item.planned, shape);
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
 *   updates(kind)                       true for a Custom API, an environment variable and a connection reference, whose
 *                                       supported edits go through update();
 *   update({ kind, key, id }, fn)       ONE checked set for a bound item's edit the preflight admitted: fn({ childIds })
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
      if (item.state === 'pending') {
        const { verdict, observation } = await recoverPending(await env(), ctx, item);
        if (verdict.action === 'commit') {
          // The earlier create is complete as it was planned: commit it, then it is this build's bound row.
          const [settled] = ctx.settle([{ token: item.token, observation, declarationSha256: item.planned.plan.declarationSha256 }]);
          if (settled.verdict.action === 'commit') return { state: 'present', id: rootId };
          const h = haltOf(kind, item.planned.key, settled.verdict);
          throw stop(h.code, h.message, h);
        }
        // Nothing the attempt sent can have been applied: it is created again, under the same ids (run resumes it).
        if (verdict.action === 'resume') return { state: 'absent', id: rootId };
        const h = haltOf(kind, item.planned.key, verdict);
        throw stop(h.code, h.message, h);
      }
      const read = await B.readConfigurationRow(dataverse, kind, rootId);
      if (read.state === 'absent') return { state: 'absent', id: rootId };
      // A row at the derived id that no binding holds is not adopted silently: adoption needs its own approval.
      throw stop(read.state === 'present' ? CONFLICT_CODE : UNVERIFIED_CODE, `the ${kind} "${item.planned.key}" derived id is ${read.state === 'present' ? 'taken by a row no binding holds' : 'unreadable'}`, { kind, key: item.planned.key, id: rootId });
    },
    async run({ kind, key }, fn) {
      const item = await locateItem(await env(), kind, key);
      let resumed = null;
      if (item.state === 'pending') {
        const { verdict } = await recoverPending(await env(), ctx, item);
        if (verdict.action !== 'resume') throw stop(UNVERIFIED_CODE, `the ${kind} "${item.planned.key}" pending attempt is not one to send again`, { kind, key: item.planned.key });
        resumed = { token: item.token, claim: verdict.claim };
      } else if (item.state !== 'unbound') {
        throw stop(UNVERIFIED_CODE, `the ${kind} "${item.planned.key}" is not a create`, { kind, key: item.planned.key });
      }
      const { planned } = item;
      const conflicts = await B.readConfigurationConflicts(dataverse, planned);
      if (conflicts.state !== 'clear') throw stop(conflicts.code || UNVERIFIED_CODE, `the ${kind} "${planned.key}" namesake query answered ${conflicts.state}`, { kind, key: planned.key });
      const [attempt] = resumed ? ctx.resume([resumed]) : ctx.begin([planned.plan]);
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
     * A bound item's edit (configuration-artifacts.js applyUpdate) — a Custom API, an environment variable (its definition,
     * a first value or a replacement of its own value) or a connection reference: the plan is made again from fresh reads
     * of the bound rows at their exact ids (never a name), and `fn({ childIds })` — the SDK's own element updates
     * and ONE push — runs inside that plan's create set: a single request on its own, or the one checked change set the
     * SDK sends for the root PATCH with new children or for new children only (`batch`). The new children take the plan's
     * derived ids (`childIds`); the set's classifier admits a write only to a row the plan holds, so a value the SDK found
     * under the definition at another id is never PATCHed. Answers { outcome: 'updated', id,
     * childIds, result } only for a committed edit; anything else throws, typed. The build's preflight has already refused
     * every shape the protected path cannot make, before anything was sent.
     */
    updates: (kind) => kind === 'customApi' || kind === 'environmentVariable' || kind === 'connectionReference',
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
 * managed create context over both, once a protected feature is selected. Answers { preflight, port, obligations }: preflight
 * runs the read-only whole-plan pass, port is the create port the configuration runtime installs, and obligations is the
 * local store read a build without the opt-in runs (optInObligations). Nothing here creates a gate or
 * a store: the build owns them.
 */
function createProtectedConfiguration({ store, gate, ctx, apiBase = null } = {}) {
  if (!store || typeof store.readGroup !== 'function') throw new TypeError('createProtectedConfiguration needs the managed binding store');
  if (!ctx || typeof ctx.begin !== 'function' || typeof ctx.run !== 'function' || typeof ctx.settle !== 'function') throw new TypeError('createProtectedConfiguration needs the managed create context');
  return {
    store,
    gate,
    ctx,
    preflight: ({ spec, dataverse, solution, bindings }) => preflightProtectedConfiguration({ spec, store, ctx, dataverse, solution, bindings }),
    port: ({ spec, dataverse, solution, bindings }) => protectedConfigurationPort({ spec, store, ctx, dataverse, solution, bindings, apiBase }),
    // A build without the opt-in: what the store still holds for its declared items (optInObligations), read locally.
    obligations: ({ spec }) => optInObligations({ spec, store }),
  };
}

/**
 * The obligations a build WITHOUT the opt-in still owes the binding store (`create-identity-opt-in-required`): every
 * declared item of the protected kinds whose group in the store is committed, pending or unusable. Removing
 * `configurationIdentity` does not move a protected item back to name lookup — a namesake could then stand in for its
 * bound row — so the build stops before any request and asks for the opt-in back. A local store read only: nothing is
 * sent. An item the store holds nothing for is not an obligation, so an App Spec that never opted in builds as before.
 * Answers { halts: [{ kind, key, code, message }] }.
 */
function optInObligations({ spec, store }) {
  if (configurationIdentityOf(spec) || !store || typeof store.readGroup !== 'function') return { halts: [] };
  const halts = [];
  for (const { kind, key } of declaredItems(spec)) {
    let held;
    try {
      const group = store.readGroup(kind, A.portKeyOf(kind, key));
      held = !!(group.committed || group.pending);
    } catch {
      // A group the store cannot use is state this build cannot rule out: still an obligation.
      held = true;
    }
    if (held) {
      halts.push({ kind, key, code: OPT_IN_CODE, message: `the binding store holds protected configuration for ${kind} "${key}", and configurationIdentity "stable-v1" was removed. `
        + 'Removing it does not move a protected item back to name lookup: restore configurationIdentity "stable-v1". No service changes were sent by this build.' });
    }
  }
  return { halts };
}

// Verify's read-only view of the binding store: the workspace's managedManifestView (declared-form-io.js readVerifyManifest),
// answered in the shape locateItem reads (readGroup). A pending attempt has no token here: verify never recovers one.
// No view at all, an unusable store or an unusable group proves nothing, so it is create-identity-unverified, never "unbound".
function manifestStore(manifest) {
  const view = manifest && Array.isArray(manifest.groups) ? manifest : null;
  return {
    readGroup(family, key) {
      if (!view) throw stop(UNVERIFIED_CODE, 'no binding store was read for this verify; a protected item is never verified by name', { kind: family, key });
      if ((view.invalid || []).some((u) => u && (u.family === 'store' || (u.family === family && u.key === key)))) {
        throw stop(UNVERIFIED_CODE, `the binding store's record of ${family} "${key}" is not usable`, { kind: family, key });
      }
      const pending = (view.pending || []).some((p) => p && p.family === family && p.key === key);
      const group = view.groups.find((g) => g && g.family === family && g.key === key);
      return { committed: group ? { records: group.records, generation: group.generation } : null, pending: pending ? { token: null } : null };
    },
  };
}

/**
 * Verify's port for the protected kinds (verify-model-app.js, under the opt-in): the same exact location the build uses
 * (locateItem), over the workspace's binding store as verify reads it (`manifest`), and READ-ONLY — it never sends, settles
 * or recovers anything. resolve({ kind, key }) answers { state: 'present', id } for a committed binding whose rows all
 * read present at their exact ids; anything else throws, typed, and verify reports that code for the item:
 *   configuration-row-not-found   a bound row is gone (a namesake elsewhere never stands in);
 *   managed-settlement-pending    an attempt is still pending: nothing is proved yet (verify-spec.js lists it unverified);
 *   create-identity-unverified    no committed binding, no usable store, or a read that did not complete.
 */
function protectedVerifyPort({ spec, manifest, dataverse, solution, bindings }) {
  const store = manifestStore(manifest);
  let envPromise = null;
  const env = () => (envPromise = envPromise || environmentOf({ spec, store, dataverse, solution, bindings }));
  return {
    exact: true,
    protects: (kind) => KINDS.has(kind),
    async resolve({ kind, key }) {
      const item = await locateItem(await env(), kind, key);
      if (item.state === 'bound') return { state: 'present', id: item.planned.plan.rows[0].id };
      if (item.state === 'pending') throw stop(PENDING_CODE, `the ${kind} "${item.planned.key}" has an attempt still pending; it is not verified until a build settles it`, { kind, key: item.planned.key });
      throw stop(UNVERIFIED_CODE, `the ${kind} "${item.planned.key}" has no committed binding in this workspace's binding store; it is never verified by name`, { kind, key: item.planned.key });
    },
    // configuration-artifacts.js takes a port by its `run`; verify never creates, so this one refuses unsent.
    async run({ kind, key }) {
      throw stop(UNVERIFIED_CODE, `verify sends nothing: the ${kind} "${key}" is not created here`, { kind, key });
    },
  };
}

module.exports = {
  EDIT_CODE,
  OPT_IN_CODE,
  RULE_EDIT_MESSAGE,
  API_EDIT_MESSAGE,
  configurationIdentityOf,
  editVerdict,
  optInObligations,
  preflightProtectedConfiguration,
  protectedConfigurationPort,
  protectedVerifyPort,
  createProtectedConfiguration,
};
