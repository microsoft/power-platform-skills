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

const crypto = require('node:crypto');
const B = require('./configuration-create-bindings.js');
const A = require('./configuration-artifacts.js');
const { normalizeGuid, isAuthorized, approvalKey, canonicalJson } = require('./reconcile-common.js');
const { hasUnsyncedEdits } = require('./unsynced-edits.js');
const { defaultApprovalToken } = require('./managed-create-context.js');
const { attemptProvenUnsent } = require('./managed-bindings.js');
const { withConfigurationWrite } = require('./configuration-transport.js');

const IDENTITY = 'stable-v1';
const EDIT_CODE = 'configuration-edit-unsupported';
const UNVERIFIED_CODE = 'create-identity-unverified';
const CONFLICT_CODE = 'create-identity-conflict';
const COMPLETION_CODE = 'create-completion-required';
const OWNERSHIP_CODE = 'create-ownership-required';
const OPT_IN_CODE = 'create-identity-opt-in-required';
// A create or edit the service refused unstarted and the run released (#847, refusedStop): nothing pending is left.
const REFUSED_CODE = 'create-refused';
// A variable whose definition was sent and whose value request the service refused before it started (#847,
// valueRefusedStop): the attempt stays pending, and only its value may be sent later (completeValueOnce).
const VALUE_REFUSED_CODE = 'create-value-refused';
// A local workspace copy that differs from the server's: the declared views' and charts' stop (sdk-build.js
// refuseUnsentCopy), with the same way on — keep what you want in the App Spec, then approve replacing the copy.
const DRAFT_CODE = 'workspace-copy-unsent-edits';
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
// The one approval that replaces a protected item's local copy with the server's: `--authorize overwrite:<kind>:<key>`,
// the views' and charts' verb, typed by the configuration kind and keyed as the port keys it (portKeyOf: a name in lower
// case, a duplicate rule's key byte for byte). build-model-app.js reads it into opts.authorizedOverwrite without its verb
// (configuration-artifacts.js configurationAuthorizationKeys), so it approves only this item's copy.
const overwriteKey = (kind, key) => approvalKey(kind, A.portKeyOf(kind, key));
// Only the exact typed key approves a replacement. The shared isAuthorized also accepts a blanket `true` (an older
// programmatic form some view callers still pass); here that would discard a protected copy no maker named, so a
// boolean, or anything that is not a collection of keys, approves nothing.
const approvesOverwrite = (approved, key) => (approved instanceof Set || Array.isArray(approved)) && isAuthorized(approved, key);
const draftMessage = (kind, key, id) => `the local copy of the ${kind} "${key}" (${id}) in the workspace differs from the server's (an edit an earlier run did not send, `
  + 'or one made by hand), or could not be compared; nothing was read over it or written, and the copy was kept. '
  + 'Put any change you want to keep into the App Spec, then approve replacing the local copy with the server\'s: '
  + A.authorizeFlags([`overwrite:${overwriteKey(kind, key)}`]);

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

// #847: what the run's own answers say when the service refused its requests unstarted — the transport saw an answer
// that says a request was never carried out (managed-create-transport.js refusedUnstarted) and the store took its rows
// back to unsent (noteRowsNotStarted). Read BEFORE ctx.release, which drops the attempt's facts. Answers null, or
// { serviceCode } (the Dataverse error code the answer carried, or null). Only a stop when the release then succeeds:
// that is the store's own proof (attemptProvenUnsent) that nothing any request of the attempt carried can land.
function refusedUnsent(ctx, attempt, pushed) {
  if (pushed.checked || pushed.localError || typeof ctx.facts !== 'function') return null;
  const refused = ctx.facts(attempt.token).find((f) => f.type === 'row' && f.notStarted === true);
  return refused ? { serviceCode: typeof refused.serviceCode === 'string' ? refused.serviceCode : null } : null;
}

// The stop for a create or edit the service refused, released in the same run: nothing was created or changed and the
// store holds nothing pending for it, so the next build plans it afresh (a create again under the same derived ids).
// `nothingCreated` routes it as refused, not unknown (configuration-artifacts.js routeFailure), so later items still run.
function refusedStop(kind, key, id, { serviceCode }, what) {
  return stop(REFUSED_CODE, `the service refused the ${kind} "${key}" ${what}${serviceCode ? ` (${serviceCode})` : ''}; nothing was ${what === 'create' ? 'created' : 'changed'} and nothing is left pending`,
    { kind, key, id, nothingCreated: true, serviceCode });
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

// declaredItems with every data-source variable after the declared parent it names, the order the build itself makes
// them in (configuration-artifacts.js planEnvironmentVariables), so the preflight forecasts a parent's adoption
// (env.adopting) before it plans the child under it. A cycle or an undeclared parent keeps the declared order.
function parentsFirst(spec, items) {
  const parentOf = new Map();
  for (const e of Array.isArray(spec && spec.environmentVariables) ? spec.environmentVariables : []) {
    if (e && typeof e.schemaName === 'string' && e.type === 'dataSource' && typeof e.parentSchemaName === 'string') parentOf.set(A.portKeyOf('environmentVariable', e.schemaName), A.portKeyOf('environmentVariable', e.parentSchemaName));
  }
  const waiting = items.slice();
  const out = [];
  const pending = (pk) => waiting.some((x) => x.kind === 'environmentVariable' && A.portKeyOf(x.kind, x.key) === pk);
  while (waiting.length) {
    const i = waiting.findIndex((x) => x.kind !== 'environmentVariable' || !parentOf.has(A.portKeyOf(x.kind, x.key)) || !pending(parentOf.get(A.portKeyOf(x.kind, x.key))));
    out.push(...waiting.splice(i < 0 ? 0 : i, 1));
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
 * A plan's `boundIdOf` for the OTHER declared items it refers to: a data-source variable's declared parent, planned at
 * the row it really is — its committed binding's root id (its derived id when it was created; a maker's row when it was
 * adopted) or, while this build adopts it, the namesake its adoption names (env.adopting) — so a child is planned under
 * that row rather than at the parent's derived id, where an adopted parent is not. Undefined (the derived id, as before)
 * for anything else, for the item itself (locateItem plans its own binding) and for a parent nothing is bound or
 * adopted at. Reads the local store only.
 */
function parentIdOf(env, kind, portKey) {
  return (k, pk) => {
    if (k !== 'environmentVariable' || (k === kind && pk === portKey)) return undefined;
    let group = null;
    try { group = env.store.readGroup(k, pk); } catch { group = null; }
    const root = group && group.committed ? (group.committed.records || []).find((r) => r.kind === k && r.key === pk) : null;
    if (root) return normalizeGuid(root.id);
    return env.adopting instanceof Map ? env.adopting.get(pk) : undefined;
  };
}

/**
 * Locate one declared item by its binding and plan it, reading only:
 *   { state: 'unbound', planned }   no committed binding: a create at the derived ids;
 *   { state: 'pending', planned, token, edit }   an attempt is pending (recoverPending decides it from its own expectation);
 *                                   `adoption` marks an attempt over existing rows only with nothing committed: an
 *                                   adoption that never sends (adoptNamesake), planned here as the unbound item it was;
 *   { state: 'bound', planned }     the committed binding, every bound row read fresh at its exact id.
 * A bound row read absent is `configuration-row-not-found` (never replaced by a namesake), an unreadable one or a binding
 * whose ids the declaration no longer derives is `create-identity-unverified`; both throw, typed.
 */
async function locateItem(env, kind, key) {
  const { spec, store, dataverse, solution, bindings, componentTypes } = env;
  const portKey = A.portKeyOf(kind, key);
  const fresh = B.planOf(spec, { kind, key, bindings, solution, componentTypes, boundIdOf: parentIdOf(env, kind, portKey) });
  const group = store.readGroup(kind, fresh.key);
  if (group.pending && !group.committed) {
    // An attempt over existing rows only, with nothing committed for the item, can only be an adoption of a row made
    // before the opt-in (adoptNamesake): it never sends, so it is never recovered as a create (run refuses it).
    const rows = group.pending.rowProtocol && Array.isArray(group.pending.rowProtocol.rows) ? group.pending.rowProtocol.rows : [];
    const adoption = rows.length > 0 && rows.every((r) => r.mode === 'update');
    return { state: 'pending', planned: fresh, token: group.pending.token, edit: false, adoption, attempt: group.pending, declaredKey: key };
  }
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
  // A child adopted at the id a maker's row already had (adoptNamesake) stays at that id; a created child is at the id
  // the declaration derives, and the check below still holds it to that.
  const childIdOf = {};
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
    if (r.origin === 'adopted') childIdOf[slot] = normalizeGuid(r.id);
  }
  const planned = B.planOf(spec, {
    kind, key, bindings, solution, componentTypes, bases, boundSlots, keptChildren, childIdOf, baseGeneration: group.committed.generation,
    // Only this item is bound in its own plan: another item of the kind is planned (and judged) on its own; a declared
    // parent it refers to is planned at the row it is bound at (parentIdOf).
    boundIdOf: (k, pk) => (k === kind && pk === fresh.key ? rootId : parentIdOf(env, kind, fresh.key)(k, pk)),
  });
  for (const r of records) {
    const row = planned.rows.find((x) => x.kind === r.kind && x.key === r.key);
    if (row && row.id !== normalizeGuid(r.id)) throw stop(UNVERIFIED_CODE, `the binding of ${kind} "${fresh.key}" names another ${r.kind} than the declaration derives`, { kind, key: fresh.key });
  }
  // A pending EDIT is located like the bound item it edits — at the exact ids its binding holds — and is then decided
  // from the expectation the attempt itself persisted (recoverPending), never from this plan's.
  if (group.pending) return { state: 'pending', planned, token: group.pending.token, edit: true, attempt: group.pending, declaredKey: key };
  return { state: 'bound', planned };
}

/**
 * The read-only first step of the build's judgment of a bound item (the preflight, and verify for a rule): what its plan would
 * change (editShapeOf) as { shape }, or as { halt: { code, message, id? } } when nothing can be judged from it — a read that
 * did not complete (create-identity-unverified), or a bound row that is gone (configuration-row-not-found, never replaced by
 * a namesake). One function, so verify and the build cannot read the same state two ways. It sends nothing.
 */
async function judgeBoundShape(dataverse, kind, planned) {
  const shape = await B.editShapeOf(dataverse, planned);
  if (shape.state !== 'complete') return { halt: { code: UNVERIFIED_CODE, message: `the ${kind} "${planned.key}" could not be read completely` } };
  if (shape.missing.length) return { halt: { id: shape.missing[0].id, code: B.NOT_FOUND_CODE, message: `a bound row of ${kind} "${planned.key}" is gone; it is not replaced by a namesake` } };
  return { shape };
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
 * The verdict on a first create (an unbound item, or a create proved never applied that is sent again), or null when it
 * can be made. Read only, the same reads resolve/run make at dispatch, moved before the build's first write:
 *   the root's derived id (exactId): absent is free; a row there that no binding holds is create-identity-conflict (it is
 *     never adopted silently); an answer that is not exact is create-identity-unverified;
 *   the complete namesake query of every row the plan creates (readConfigurationConflicts, every page followed): a
 *     namesake at another id is create-identity-conflict, a query that does not complete is create-identity-unverified.
 */
async function firstCreateVerdict(dataverse, planned, { exactId }) {
  const rootId = planned.plan.rows[0].id;
  if (exactId) {
    const read = await B.readConfigurationRow(dataverse, planned.kind, rootId);
    if (read.state === 'present') return { id: rootId, code: CONFLICT_CODE, message: `the ${planned.kind} "${planned.key}" derived id ${rootId} is taken by a row no binding holds; it is not adopted, and no service changes were sent by this build. `
      + 'The id is derived from this item, so the row is most likely one an earlier build of it made (one whose unfinished attempt was retired with `--authorize retire:...`, say). '
      + 'If it is, and you do not need it, delete that row in the environment, then run again' };
    if (read.state !== 'absent') return { id: rootId, code: UNVERIFIED_CODE, message: `the ${planned.kind} "${planned.key}" derived id ${rootId} could not be read; no service changes were sent by this build` };
  }
  const conflicts = await B.readConfigurationConflicts(dataverse, planned);
  if (conflicts.state === 'clear') return null;
  const ids = conflicts.rows.flatMap((r) => r.ids || []);
  const verdict = {
    code: conflicts.code || UNVERIFIED_CODE,
    message: conflicts.state === 'conflict'
      ? `the ${planned.kind} "${planned.key}" has a namesake at another id (${ids.join(', ')}); a protected create never binds a namesake, and no service changes were sent by this build`
      : `the ${planned.kind} "${planned.key}" namesake query could not be completed; nothing is created on a read that may have missed a namesake, and no service changes were sent by this build`,
  };
  // Whether this is the one case adoptionOf can take up (exactly one namesake of the root, and nothing else in the way).
  // Kept off the halt itself (not enumerable, so `...verdict` never carries it into a stop): several namesakes skip the
  // adoption reads altogether and keep today's stop and today's requests.
  const own = conflicts.rows.find((r) => r.kind === planned.kind && r.key === planned.key);
  const single = conflicts.state === 'conflict' && !!own && own.state === 'conflict' && own.ids.length === 1 && conflicts.rows.every((r) => r === own || r.state === 'clear');
  Object.defineProperty(verdict, 'single', { value: single });
  return verdict;
}

// Fields the protected path never changes on a row that exists: what the platform fixes on create (a type, a binding, a
// connector) and the name the row is found by. A namesake whose App Spec differs in one of them is not
// the item the App Spec declares, so it is never adopted (a different case of the name included: an adopted row keeps
// the name it has, and the App Spec would then name it in another spelling).
const IMMUTABLE = Object.freeze({
  environmentVariable: ['schemaName', 'type', 'secretStore', 'parentDefinitionId'],
  environmentVariableValue: [],
  connectionReference: ['logicalName', 'connectorId', 'customConnectorId'],
  customApi: ['uniqueName', 'binding', 'boundEntityLogicalName', 'isFunction', 'allowedProcessingSteps', 'enabledForWorkflow'],
  customApiRequestParameter: ['uniqueName', 'type', 'entityLogicalName', 'isOptional'],
  customApiResponseProperty: ['uniqueName', 'type', 'entityLogicalName'],
});
// The kinds a namesake made before the opt-in may be adopted for. A duplicate rule is not one of them: the build plans a
// bound rule's later edit and publication outside the protected update path, where an adoption's printed field list could
// not hold it, so a rule's namesake keeps the stop it had before adoption existed (no adoption reads, no approvals).
const ADOPTABLE = new Set(['environmentVariable', 'connectionReference', 'customApi']);
// One JSON Pointer reference token (RFC 6901): '~' is written '~0' and '/' is written '~1'.
// See: https://www.rfc-editor.org/rfc/rfc6901#section-3
const pointerToken = (s) => String(s).replace(/~/g, '~0').replace(/\//g, '~1');
// The `+<16 hex>` an adoption's root approval carries when the build would then change the row: the first 16 hex of the
// SHA-256 of the sorted pointer list it printed, so an approval given for one list never covers another.
const pointerDigest = (pointers) => crypto.createHash('sha256').update(canonicalJson(pointers)).digest('hex').slice(0, 16);
const rowKeyOf = (r) => `${r.kind}\u0000${r.key}`;

/**
 * Whether an unbound item's one namesake — a row a maker made before the opt-in, at an id this plugin did not derive —
 * can be adopted at its own id, and on what terms. Reads only; sends nothing. Answers
 *   null                                   not that case (the derived id is not free, the namesake query is not exactly
 *                                          one root at another id and nothing else): the first-create verdict stands;
 *   { adoptable: false, id, reason }       it is that case, and it cannot be adopted (why, in words);
 *   { adoptable: true, id, overlay, asIs, observation, pointers, digest, tokens, printed, tokenOf }.
 * The namesake and every row under it are read exactly, at their ids (bases), and every row under it is paired with the
 * declaration: one value, an API child by its unique name. Two plans are made from those same reads:
 *   overlay   the item as the build would then make it (bound at the namesake; a declared child with no pair is a create
 *             at its derived id): judged exactly as a bound item's edit is (judgeBoundShape, editVerdict / childVerdict);
 *   asIs      the same existing rows, each expected as it reads now (planOf asIs), with their members planned: what a read-only acceptance of the adoption proves (observation).
 * `pointers` lists every field the overlay would change (`/<field>`, `/<slot>/<field>`, `/<slot>` for a new child; names
 * only, a private value never), and `printed` are the exact approvals the stop prints: the root's `@<id>` (with `+<digest>`
 * of the pointers when there are any) and each child's `@<id>`; `tokens` are the same approvals as the parser types them.
 * It refuses whatever the protected path would not then make on its own
 * terms: a row under the namesake that the App Spec does not declare (a removal), a first value or a value or connection
 * that differs from the deployment settings (a private value is never written after an adoption), a changed fixed field,
 * a row outside the solution, or any read that does not complete.
 */
async function adoptionOf(env, item, declaredKey) {
  const { spec, dataverse, solution, bindings, componentTypes } = env;
  const fresh = item.planned;
  const { kind } = fresh;
  if (!ADOPTABLE.has(kind)) return null;
  const derived = await B.readConfigurationRow(dataverse, kind, fresh.plan.rows[0].id);
  if (derived.state !== 'absent') return null;
  const conflicts = await B.readConfigurationConflicts(dataverse, fresh);
  if (conflicts.state !== 'conflict') return null;
  const own = conflicts.rows.find((r) => r.kind === kind && r.key === fresh.key);
  if (!own || own.state !== 'conflict' || own.ids.length !== 1 || conflicts.rows.some((r) => r !== own && r.state !== 'clear')) return null;
  const id = normalizeGuid(own.ids[0]);
  const refuse = (reason) => ({ adoptable: false, id, reason });
  const root = await B.readConfigurationRow(dataverse, kind, id);
  if (root.state !== 'present' || root.parentId !== null) return refuse('it could not be read exactly');
  if (root.decoded.unmodelled.length) return refuse(`it holds columns the plugin does not manage (${root.decoded.unmodelled.join(', ')})`);

  // Every row under it, listed completely and read exactly (the listing as observe's child graph reads it).
  const listed = [];
  for (const [childKind, k] of Object.entries(B.KINDS)) {
    if (!k.parentSet || k.parentSet !== B.KINDS[kind].set) continue;
    const page = await B.readAllPages(dataverse, `/${k.set}?$select=${k.pk},${k.parentColumn}&$filter=${k.parentColumn} eq ${id}`);
    if (!page.complete) return refuse('the rows under it could not be listed completely');
    for (const r of page.rows) {
      const childId = r && typeof r[k.pk] === 'string' ? normalizeGuid(r[k.pk]) : '';
      if (!childId || normalizeGuid(r[k.parentColumn]) !== id || listed.some((c) => c.id === childId)) return refuse('the rows under it could not be listed completely');
      const got = await B.readConfigurationRow(dataverse, childKind, childId);
      if (got.state !== 'present' || got.parentId !== id) return refuse(`the ${childKind} ${childId} under it could not be read exactly`);
      if (got.decoded.unmodelled.length) return refuse(`the ${childKind} ${childId} under it holds columns the plugin does not manage`);
      listed.push({ kind: childKind, id: childId, read: got });
    }
  }
  const lower = (s) => (typeof s === 'string' ? s.toLowerCase() : s);
  const bases = new Map([[id, root]]);
  const childIdOf = {};
  const boundSlots = [];
  const keptChildren = {};
  const taken = new Set();
  for (const row of fresh.rows) {
    if (row.slot === null) continue;
    const pairs = listed.filter((c) => c.kind === row.kind && (row.kind === 'environmentVariableValue' || lower(c.read.decoded.fields.uniqueName) === lower(row.expected.uniqueName)));
    if (pairs.length > 1 || pairs.some((c) => taken.has(c.id))) return refuse(`more than one row under it could be its ${row.slot}`);
    if (!pairs.length) continue;
    taken.add(pairs[0].id);
    childIdOf[row.slot] = pairs[0].id;
    boundSlots.push(row.slot);
    bases.set(pairs[0].id, pairs[0].read);
  }
  // A value the deployment settings do not name stays as it is (held, never sent), as a bound variable's does; settings
  // that clear it would delete it, a removal the protected path does not make.
  const values = listed.filter((c) => c.kind === 'environmentVariableValue' && !taken.has(c.id));
  if (values.length && clearsValue(bindings, fresh.key)) return refuse('its deployment settings clear the value it holds, which deletes a row');
  if (values.length === 1 && !fresh.rows.some((r) => r.slot === 'value')) {
    keptChildren.value = values[0].id;
    taken.add(values[0].id);
  }
  const extra = listed.filter((c) => !taken.has(c.id));
  if (extra.length) return refuse(`it has rows under it that the App Spec does not declare (${extra.map((c) => `${c.kind} ${c.id}`).join(', ')}); removals are not supported`);

  const options = {
    kind, key: declaredKey, bindings, solution, componentTypes, bases, boundSlots, keptChildren, childIdOf,
    boundIdOf: (k, pk) => (k === kind && pk === fresh.key ? id : parentIdOf(env, kind, fresh.key)(k, pk)),
  };
  let overlay;
  let asIs;
  try {
    overlay = B.planOf(spec, options);
    asIs = B.planOf(spec, { ...options, asIs: true });
  } catch (error) {
    return refuse(`it cannot be planned from its reads (${error.message})`);
  }
  const judged = await judgeBoundShape(dataverse, kind, overlay);
  if (judged.halt) return refuse(judged.halt.message);
  const { shape } = judged;
  if (shape.removals.length) return refuse(`it has rows under it that the App Spec does not declare (${shape.removals.join(', ')}); removals are not supported`);
  if (shape.creates.includes('environmentVariableValue')) return refuse('the build would then write a first value to it; set its value outside the plugin to the one in the deployment settings first');
  const verdict = kind === 'customApi' ? editVerdict(kind, shape) : await childVerdict(env, overlay, shape);
  if (verdict) return refuse(`the change the build would then make to it is not one the protected path makes (${verdict.code})`);
  if (shape.creates.length) {
    const news = await B.readConfigurationConflicts(dataverse, overlay);
    if (news.state !== 'clear') return refuse(`the namesake query of a row the build would then add under it answered ${news.state}`);
  }

  // What the build would then change, by name.
  const changed = changedPointers(overlay, asIs);
  if (changed.refusal) return refuse(changed.refusal);
  const { pointers } = changed;

  const observation = await B.observe(dataverse, asIs);
  const reason = asIsReason(asIs, observation);
  if (reason) return refuse(reason);
  const digest = pointers.length ? pointerDigest(pointers) : '';
  // Each row's approval in two spellings: the one the stop prints (adopt:...@<id>) and the typed one the parser makes of
  // it (adopt-row:..., configuration-artifacts.js configurationAuthorizationKeys), the only spelling given approvals are
  // matched in, so a plain `adopt:` approval is never consumed as an adoption. A printed spelling that the parser would
  // not read back as exactly that row's approval (it also names another declared item) is never printed: not adoptable.
  const rootToken = `adopt-row:${kind}:${fresh.key}@${id}${digest ? `+${digest}` : ''}`;
  const tokenOf = (family, rootKey, row) => (row.parentId === null ? rootToken : `adopt-row:${defaultApprovalToken(family, rootKey, row).slice('adopt:'.length)}@${normalizeGuid(row.id)}`);
  const tokens = asIs.plan.rows.map((r) => tokenOf(kind, fresh.key, r));
  const printed = tokens.map((t) => `adopt:${t.slice('adopt-row:'.length)}`);
  const readBack = A.configurationAuthorizationKeys(printed, spec);
  if (readBack.problems.length || readBack.rowApprovals.size !== tokens.length || !tokens.every((t) => readBack.rowApprovals.has(t))) {
    return refuse('an approval of it would also read as the approval of another declared item, so none is printed; rename the key of one of the two');
  }
  return { adoptable: true, id, overlay, asIs, observation, pointers, digest, tokens, printed, tokenOf };
}

// The field pointers a plan would change on the rows of an as-is plan, sorted (a row it adds is its slot's pointer), or
// { refusal } when one is a field the build never changes on a row that exists. Rows are matched by plan key; a row of
// the plan the as-is plan does not hold is a change of its whole slot. Both plans hold the same field set per row
// (planOf asIs). The adoption's stop prints this list, and the build's edit of the row in that invocation is held to it
// (update).
function changedPointers(plan, asIs) {
  const sameAsIs = new Map(asIs.rows.map((r) => [rowKeyOf(r), r]));
  const pointers = [];
  for (const r of plan.rows) {
    const at = r.slot === null ? '' : `/${pointerToken(r.slot)}`;
    const now = sameAsIs.get(rowKeyOf(r));
    if (r.mode === 'create' || !now) { pointers.push(at); continue; }
    if (r.kept) continue;
    for (const f of Object.keys(r.expected)) {
      if (canonicalJson(r.expected[f] === undefined ? null : r.expected[f]) === canonicalJson(now.expected[f] === undefined ? null : now.expected[f])) continue;
      if (IMMUTABLE[r.kind].includes(f)) return { refusal: `its ${r.slot === null ? '' : `${r.slot} `}${f} differs from the App Spec's, and the build never changes it on a row that exists` };
      pointers.push(`${at}/${pointerToken(f)}`);
    }
  }
  return { pointers: pointers.sort() };
}
// Why an as-is plan's fresh observation does not prove the rows as they were read (null when it does): every row
// present at its id and parent and exactly its expectation (which covers its fields, unmodelled and preserved columns
// and, on the root, any row under it the plan does not hold), every private input readable and matching the deployment
// settings, and every member in the solution.
function asIsReason(asIs, observation) {
  const seen = new Map(observation.rows.map((r) => [rowKeyOf(r), r]));
  for (const row of asIs.rows) {
    const s = seen.get(rowKeyOf(row));
    if (!s || s.state !== 'present') return `its ${row.slot === null ? 'row' : row.slot} could not be read again exactly`;
    if (normalizeGuid(s.id) !== row.id || (s.parentId ? normalizeGuid(s.parentId) : null) !== row.parentId || s.projectionSha256 !== row.expectedSha256) {
      return 'it changed while it was read';
    }
    if (row.sensitiveInput && s.privateState !== 'match') {
      return row.kind === 'connectionReference'
        ? 'the connection it holds is not the one its deployment settings name (or cannot be read); the build never writes a connection after adopting'
        : 'the value it holds is not the one its deployment settings name (or cannot be read); the build never writes a value after adopting';
    }
  }
  if (observation.members.some((m) => m.state === 'absent')) return `it (or a row under it) is not in the solution ${asIs.solution}; add it there first`;
  if (observation.members.some((m) => m.state !== 'present')) return 'its solution membership could not be read';
  return null;
}

// The preflight stop of a namesake (firstCreateVerdict) with what adoptionOf found: today's sentence first, unchanged,
// then how it can be adopted or why it cannot be. An adoptable one carries `adoption` — its id, the fields the build would
// then change and its exact printed approvals — which configuration-build.js renders for EVERY such item of the stop, so
// no approval is printed without the rows and the change it approves.
function adoptionHalt(verdict, adoption) {
  if (!adoption) return verdict;
  if (!adoption.adoptable) return { ...verdict, id: adoption.id, message: `${verdict.message}. It cannot be adopted at its id ${adoption.id}: ${adoption.reason}.` };
  const change = adoption.pointers.length ? `only these fields, ${adoption.pointers.join(', ')}` : 'nothing in it';
  return {
    ...verdict, id: adoption.id, adoption: { id: adoption.id, change, approvals: adoption.printed.slice() },
    message: `${verdict.message}. It can instead be adopted at its id ${adoption.id}, after checking that row is yours; the build would then change ${change}.`,
  };
}

// Whether the maker asked to adopt the item's namesake: an approval of its root in the typed `@<row id>` form.
const adoptionAsked = (ctx, kind, portKey) => !!ctx && typeof ctx.approvals === 'function'
  && ctx.approvals().some((t) => typeof t === 'string' && t.startsWith(`adopt-row:${kind}:${portKey}@`));

/**
 * Adopt an unbound item's namesake at its own id, sending nothing (resolve, under the exact approvals adoptionOf
 * printed). The as-is plan is begun as an attempt (prepared and marked sending, with its expected proof), the store is
 * captured, and adoptionOf runs again — every read, the verdicts over the same declaration, the membership, the private
 * inputs and the as-is observation — after the capture and immediately before the acceptance, which must find the same
 * rows, the same pointer list and the same approvals; the acceptance (acceptReadOnly with the adoption's own approval
 * spellings) then commits the group read-only, or nothing. Any refusal, unreadable read or throw releases the attempt
 * (epoch-checked, while it provably sent nothing) and throws, typed: nothing is written to the service or the store.
 * Answers { state: 'present', id, adoption }: the item is bound at the namesake (`adoption` is what the acceptance proved,
 * which the port holds this invocation's edit of it to: update), and the build sends the printed edit, if any,
 * through update() like any bound item's; or null when there is no single namesake to adopt any more (approvals given for
 * a row since deleted adopt nothing, and the item is created at its derived id as the preflight forecast).
 */
async function adoptNamesake(env, ctx, item, declaredKey) {
  const { kind, key } = item.planned;
  const given = new Set(ctx.approvals());
  const fail = (reason, code = CONFLICT_CODE) => stop(code, `the ${kind} "${key}" namesake was not adopted: ${reason}; nothing was written`, { kind, key });
  const first = await adoptionOf(env, item, declaredKey);
  // No single namesake at another id any more (the row was deleted, or another appeared): there is nothing to adopt, and
  // the item is planned exactly as the preflight forecast it (a create at its derived id, or today's stop).
  if (!first) return null;
  if (!first.adoptable) throw fail(first.reason);
  if (!first.tokens.every((t) => given.has(t))) throw fail(`it is adopted only under these exact approvals: ${first.printed.join(', ')}`);
  const [attempt] = ctx.begin([first.asIs.plan]);
  let committed = false;
  try {
    const [capture] = ctx.captureReadOnly([attempt.token]);
    const again = await adoptionOf(env, item, declaredKey);
    if (!again || !again.adoptable) throw fail(again ? again.reason : 'it changed while it was read');
    if (again.id !== first.id || again.digest !== first.digest || canonicalJson(again.pointers) !== canonicalJson(first.pointers)
      || !sameRows(again.asIs.plan.rows, first.asIs.plan.rows) || !again.tokens.every((t) => given.has(t))) {
      throw fail('it changed while it was read');
    }
    const [accepted] = ctx.acceptReadOnly([{ token: attempt.token, observation: again.observation, capture, declarationSha256: again.asIs.plan.declarationSha256, approvalTokenOf: again.tokenOf }]);
    if (!accepted || accepted.verdict.action !== 'commit' || !accepted.group) {
      const h = haltOf(kind, key, accepted ? accepted.verdict : { code: UNVERIFIED_CODE });
      throw stop(h.code, h.message, h);
    }
    committed = true;
    return { state: 'present', id: first.id, adoption: again };
  } finally {
    if (!committed) ctx.release(attempt);
  }
}

// An adoption attempt (locateItem `adoption`) that provably sent nothing — only prepared, or marked sending with nothing
// dispatched (managed-bindings.js attemptProvenUnsent) — can be retired and the adoption made again; anything else is
// state this build cannot explain, never recovered as a create.
const adoptionUnsent = (store, attempt) => attempt.phase === 'prepared' || (typeof store.snapshot === 'function' && attemptProvenUnsent(attempt, store.snapshot().envelope.workflowEffects));
const adoptionStuck = (kind, key) => stop(UNVERIFIED_CODE, `the ${kind} "${key}" has a pending adoption this build cannot retire; nothing is sent for it`, { kind, key });

// Retire an adoption attempt that provably sent nothing (resolve), under a fresh claim so the store's epoch check holds:
// resume answers its new epoch, and release retires it only while its record still proves nothing was sent.
function retireAdoption(env, ctx, item) {
  const { kind, key } = item.planned;
  if (!adoptionUnsent(env.store, item.attempt)) throw adoptionStuck(kind, key);
  let resumed;
  try {
    [resumed] = ctx.resume([{ token: item.token, claim: item.attempt.phase === 'prepared' ? 'first' : 'continue' }]);
  } catch {
    throw adoptionStuck(kind, key);
  }
  if (!resumed || !ctx.release(resumed)) throw adoptionStuck(kind, key);
}

/**
 * A pending attempt is decided from its OWN persisted expectation (managed-create-context.js classifyRecovery), read-only,
 * never re-planned from today's rows. For a create that is what keeps the original plan's completion owed: a duplicate
 * rule created without an explicit status owes its initial publication, and a rerun after a partial create proves the
 * rows and that state at the same ids — it commits only when the rule is published (by the original send, or by the
 * maker under the same id), and it never sends the publication again: an uncertain or failed publish is not replayed,
 * it stays a create-completion-required halt. The one exception is a publication the attempt's own record proves never
 * left (unsentPublication): that one is sent once, fenced (publishOnce). A declaration changed since the attempt is
 * managed-pending-intent-changed.
 *
 * A pending EDIT of a bound item is judged the same way, by the attempt's own persisted rows: its declaration digest is
 * recomputed from today's declaration over THOSE rows (B.declarationSha256Of), and each row is read at its bound id and
 * compared with the expectation the attempt persisted (observe projects only the field set of the expectation, so
 * today's values never replace it). A complete edit commits read-only — its PATCH is never repeated; an incomplete or
 * uncertain one keeps its typed halt. An edit proved unsent (prepared, or sending with nothing dispatched) is resumed
 * under its own token, ids, parents and generation (`sameRows`: the plan made from today's reads holds exactly the rows
 * it persisted, so the conditional base read now is the one the resumed send carries); one whose rows no longer match
 * is retired when only prepared, and otherwise halts until they are restored.
 * Answers { verdict, observation, declarationSha256?, sameRows? }.
 */
async function recoverPending(env, ctx, item) {
  const { planned } = item;
  if (!ctx) {
    return { verdict: { action: 'halt', code: UNVERIFIED_CODE, message: `the ${planned.kind} "${planned.key}" has a pending ${item.edit ? 'edit' : 'attempt'} that this build cannot recover; nothing is sent for it` } };
  }
  if (!item.edit) {
    const observation = await B.observe(env.dataverse, planned);
    return { observation, verdict: ctx.classify(item.token, observation, { declarationSha256: planned.plan.declarationSha256 }) };
  }
  const protocol = item.attempt && item.attempt.rowProtocol;
  if (!protocol) return { verdict: { action: 'halt', code: UNVERIFIED_CODE, message: `the ${planned.kind} "${planned.key}" pending edit keeps no row expectation; nothing is sent for it` } };
  const declarationSha256 = B.declarationSha256Of(env.spec, { kind: planned.kind, key: item.declaredKey, solution: planned.solution, rows: protocol.rows, ruleState: protocol.completion.ruleState });
  const observation = await B.observe(env.dataverse, planned);
  const verdict = ctx.classify(item.token, observation, { declarationSha256 });
  return { observation, verdict, declarationSha256, sameRows: sameRows(planned.plan.rows, protocol.rows) };
}

// A plan row as an attempt persists it (managed-create-context.js buildRowPlan); its row version is not part of it.
const rowSignature = (r) => JSON.stringify([r.kind, r.key, normalizeGuid(r.id), r.parentId ? normalizeGuid(r.parentId) : null, r.mode, r.expectedSha256, r.sensitiveInput === true]);
const sameRows = (a, b) => a.length === b.length && a.map(rowSignature).sort().join('\n') === b.map(rowSignature).sort().join('\n');

const pendingEditChanged = (planned) => ({
  action: 'halt', code: CONFLICT_CODE,
  message: `the ${planned.kind} "${planned.key}" has an unsent pending edit whose rows changed since it was prepared; nothing is sent for it. `
    + 'Restore the rows to what they were when the edit was prepared (or make the edit outside the plugin), then run again',
});

/**
 * Settle or resume a pending EDIT of a bound item before anything is written for it (resolve), from recoverPending's
 * answer. The answer is authoritative, never advice the caller may skip:
 *   'settled'      a complete edit committed read-only, or an unsent one whose target is already there (made by hand,
 *                  say) ACCEPTED read-only — its own acceptance verdict checked: a refusal throws its typed halt;
 *   'retired'      an unsent one whose rows changed, retired while only prepared;
 *   'needs-write'  an unsent one whose rows match and whose target is not there yet: its write is still owed, and only
 *                  update() may send it, resuming the same attempt. The item must never be reported unchanged meanwhile.
 * Anything else throws a typed halt.
 */
async function settlePendingEdit(env, ctx, item, rec) {
  const { planned } = item;
  const fail = (verdict) => { const h = haltOf(planned.kind, planned.key, verdict); throw stop(h.code, h.message, h); };
  if (rec.verdict.action === 'commit') {
    const [settled] = ctx.settle([{ token: item.token, observation: rec.observation, declarationSha256: rec.declarationSha256 }]);
    if (settled.verdict.action !== 'commit') fail(settled.verdict);
    return 'settled';
  }
  if (rec.verdict.action !== 'resume') fail(rec.verdict);
  if (!rec.sameRows) {
    if (item.attempt.phase !== 'prepared') fail(pendingEditChanged(planned));
    env.store.retireUnsentAttempt({ token: item.token, baseGeneration: item.attempt.baseGeneration });
    return 'retired';
  }
  if (!readOnlyCandidate(item) || targetMissing(item.attempt.rowProtocol.rows, rec.observation)) return 'needs-write';
  // Already at its target: accepted with no send. The capture is taken before the fresh read.
  if (item.attempt.phase === 'prepared') ctx.resume([{ token: item.token, claim: 'first', baseObservation: planned.plan.baseObservation }]);
  const [capture] = ctx.captureReadOnly([item.token]);
  const observation = await B.observe(env.dataverse, planned);
  const [accepted] = ctx.acceptReadOnly([{ token: item.token, observation, capture, declarationSha256: rec.declarationSha256 }]);
  if (!accepted || accepted.verdict.action !== 'commit') fail(accepted ? accepted.verdict : { code: UNVERIFIED_CODE });
  return 'settled';
}

// An edit only a read-only acceptance can settle without a send: every row an update, with the base it was planned over.
const readOnlyCandidate = (item) => item.attempt.rowProtocol.rows.every((r) => r.mode === 'update') && !!item.planned.plan.baseObservation;

/**
 * Whether an unsent edit still has its write to make: every row it planned read present, at its own id and parent, and
 * at least one not at its target yet (its projection differs, or its private input reads different or masked — a masked
 * value can be proved only by the edit's own send). Anything else is not a write to send: every row at its target is
 * the read-only acceptance's to judge (an approval it needs, a membership the maker removed), and a row gone, moved or
 * unreadable is that acceptance's typed halt too. observation: B.observe's { rows: [{ kind, key, state, id, parentId,
 * projectionSha256, privateState? }] }.
 */
function targetMissing(rows, observation) {
  const seen = new Map(((observation && observation.rows) || []).map((r) => [`${r.kind}\u0000${r.key}`, r]));
  const read = rows.map((row) => ({ row, at: seen.get(`${row.kind}\u0000${row.key}`) }));
  const placed = ({ row, at }) => at && at.state === 'present' && normalizeGuid(at.id) === row.id && (at.parentId ? normalizeGuid(at.parentId) : null) === row.parentId;
  if (!read.length || !read.every(placed)) return false;
  return read.some(({ row, at }) => at.projectionSha256 !== row.expectedSha256
    || (row.sensitiveInput === true && (at.privateState === 'mismatch' || at.privateState === 'masked')));
}

/**
 * The one completion a pending rule create may still send itself: its initial publication, when the attempt's OWN
 * record proves that publish never left — the root create acknowledged by its answer (the content was saved), the
 * plan's `rule-state` effect still `dispatched: false` (the transport seals it dispatched before the request leaves,
 * so an uncertain, failed or lost publish always reads dispatched), the rule read unpublished, and the attempt
 * otherwise exactly what it prepared: judged as if the publication had landed, it would commit. Read only. Answers
 * null when that is not the case (the halt stands), or { would }: the verdict that hypothetical judgement gave — a
 * commit (the publication is the only thing owed: resolve sends it once), or the halt that would still stand after it
 * (an ownership approval the maker must give first, named now rather than after the publish).
 * Never for an edit (a bound rule is never published again), a publish that was or may have been sent, or a rule
 * whose rows, members or declaration are not exactly the attempt's.
 */
function unsentPublication(ctx, item, rec) {
  const a = item.attempt;
  const p = a && a.rowProtocol;
  if (!ctx || item.edit || item.planned.kind !== 'duplicateRule' || !p) return null;
  const v = rec.verdict;
  if (v.action !== 'halt' || v.code !== COMPLETION_CODE || v.phase !== 'state-pending') return null;
  if (a.acknowledgedRoot !== true || p.completion.ruleState !== 'published' || !rec.observation || rec.observation.ruleState !== 'unpublished') return null;
  const effect = p.effects.find((e) => e.kind === 'rule-state');
  if (!effect || effect.dispatched) return null;
  const would = ctx.classify(item.token, { ...rec.observation, ruleState: p.completion.ruleState }, { declarationSha256: item.planned.plan.declarationSha256 });
  return would.action === 'commit' || would.code === OWNERSHIP_CODE ? { would } : null;
}

// The publish job is asynchronous: the rule reads Publishing (statecode 0, statuscode 1, neither state) until it ends.
// The rule's own state is what proves it, so it is read again a bounded number of times (reads only); a rule still not
// published then keeps its owed state, and a later build commits it once a read finds it published — never sending again.
const PUBLISH_READS = 10;
const PUBLISH_READ_INTERVAL_MS = 3000;

/**
 * Send the publication unsentPublication proved never dispatched, once, through the attempt's fenced create set:
 *   POST /duplicaterules(<id>)/Microsoft.Dynamics.CRM.PublishDuplicateRule  {}
 * claimed first under a new epoch (store.claimUnsentRowEffect), classified as the plan's own rule-state effect and sealed
 * dispatched before it leaves; then the attempt is observed and settled. Answers the settled verdict.
 * See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/publishduplicaterule
 */
async function publishOnce(env, ctx, item, scope = null) {
  const { planned } = item;
  const id = planned.plan.rows[0].id;
  const attempt = ctx.claimEffect(item.token, { kind: 'rule-state', id });
  const classify = B.createSetClassifier([{ token: attempt.token, planned }]);
  const sent = await ctx.run({ attempts: [attempt], classify, deleteCode: B.DELETE_CODE, label: `configuration publish duplicateRule ${planned.key}` },
    () => env.dataverse.post(`/duplicaterules(${id})/Microsoft.Dynamics.CRM.PublishDuplicateRule`, {}));
  let observation = await B.observe(env.dataverse, planned);
  // Only a publish the service accepted (a 2xx answer) is waited for; a refused or unanswered one is judged by this one
  // read (it may still have been applied: a read that finds the rule published proves it, and nothing is ever sent
  // again either way).
  const accepted = !sent.error && !sent.localError
    && ctx.facts(item.token).some((f) => f.type === 'effect' && f.kind === 'rule-state' && f.outcome === 'acknowledged');
  for (let i = 1; accepted && observation.ruleState !== 'published' && i < PUBLISH_READS; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, PUBLISH_READ_INTERVAL_MS));
    // eslint-disable-next-line no-await-in-loop
    observation = await B.observe(env.dataverse, planned);
  }
  const [settled] = ctx.settle([{ token: item.token, observation, declarationSha256: planned.plan.declarationSha256 }]);
  // The publish was sent now, so a stop that follows is a publication not confirmed: noted for its guidance (#808).
  noteStop(scope, item, observation, settled.verdict);
  return settled.verdict;
}

// #847: the value row of a protected variable create, sent after its definition. The real SDK sends a variable with a
// value as TWO requests — the definition's POST, then the value's own POST outside the solution — so the service can
// accept the first and refuse the second (a Key Vault reference this environment cannot read, say). The attempt then
// holds a definition that may have been made and a value that its own record proves never left (the transport reset it
// to `dispatched: false` from a definite unstarted refusal). That one value is the only thing such a build may still send.
const VALUE_ROW_KIND = 'environmentVariableValue';
const VALUE_MESSAGES = {
  input: (key) => `the pending create of environmentVariable "${key}" still owes its original value row. Supply its value in deployment settings, keep its App Spec definition unchanged, and build again. No value request was sent for this item`,
  ownership: (key, id) => `the saved definition of environmentVariable "${key}" at ${id} matches the pending create, but no recorded answer proves this attempt created it. `
    + 'Its original value is absent and was never dispatched. Check that the definition is yours before giving the printed approval; after approval and fresh checks, only that value can be sent. '
    + 'No value request was sent for this item',
  unverified: (key) => `the original definition and value rows for environmentVariable "${key}" could not be read completely; no value request was sent for this item`,
  conflict: (key) => `environmentVariable "${key}" has a row that differs from its pending create; no definition or value was replaced and no value request was sent for this item`,
  membership: (key) => `the pending create of environmentVariable "${key}" is missing required solution membership. Restore that membership under the original ids, then build again. No value request was sent for this item`,
  contradicted: (key, id) => `the definition of environmentVariable "${key}" at ${id} differs from the one this build's own request created: its id, parent, content or child rows were changed after it was made. `
    + 'Nothing was replaced and nothing more is sent for it; check who changed it before deciding how to recover',
};

// The definition and value rows of an attempt that is an original variable create of exactly those two rows, or null.
function variableRowsOf(attempt) {
  const p = attempt && attempt.rowProtocol;
  if (!p || !Array.isArray(p.rows) || p.rows.length !== 2) return null;
  const root = p.rows.find((r) => r.parentId === null);
  const value = p.rows.find((r) => r.parentId !== null);
  return root && value && value.kind === VALUE_ROW_KIND ? { root, value } : null;
}

// How a fresh read (B.observe) finds the prepared root `root` (#847): 'exact' (present at its id, no parent, its planned
// projection over a complete child graph), 'contradicted' (present, but at another id, under a parent, or with other
// public content or an unexpected child — observe folds the graph into the root's projection), 'absent', or 'unread'
// (missing from the read, unknown, or a graph observe could not read completely). Only 'contradicted' is a positive fact
// against the root; an unreadable or absent root is no proof either way.
function rootReadOf(root, observation) {
  const d = ((observation && observation.rows) || []).find((x) => x.kind === root.kind && x.key === root.key);
  if (!d || (d.state !== 'present' && d.state !== 'absent')) return 'unread';
  if (d.state === 'absent') return 'absent';
  return normalizeGuid(d.id) !== root.id || (d.parentId ? normalizeGuid(d.parentId) : null) !== null || d.projectionSha256 !== root.expectedSha256
    ? 'contradicted' : 'exact';
}

/**
 * Whether a pending variable create owes ONLY its value row, and may send it (#847). Read only and synchronous over what
 * the caller read: `item` (locateItem's pending item, its attempt as the store holds it now) and `observation` (B.observe
 * of today's plan, read after the attempt). Answers:
 *   null                       not this case: the generic recovery halt stands (another family, an edit, a value that was
 *                              or may have been sent, a changed declaration — managed-pending-intent-changed —, a
 *                              definition read absent, a value already there: its ordinary recovery judges it);
 *   { halt: verdict }          this case, but the value cannot be sent yet: its input is missing, a row or membership is
 *                              unreadable, differs or is missing, or the definition's ownership needs the maker's approval;
 *   { ready: { declarationSha256 } }   the value is owed and everything it needs was proved: resolve sends it once.
 * Every condition is one the store re-checks under its lease when the value is claimed (claimUnsentValueRow), except the
 * service reads, which completeValueOnce repeats after the claim.
 */
function valueOwed(env, ctx, item, observation) {
  const a = item.attempt;
  const { planned } = item;
  if (!ctx || item.edit || item.adoption || planned.kind !== 'environmentVariable' || !a || !a.rowProtocol) return null;
  if (a.phase !== 'sending' || a.baseGeneration !== null || !a.expected || a.expected.baseObservation !== null || a.savedObservation !== null) return null;
  const p = a.rowProtocol;
  const pair = variableRowsOf(a);
  if (!pair || p.preserved.length || p.completion.ruleState !== null || p.effects.some((e) => e.kind === 'rule-state')) return null;
  const { root, value } = pair;
  if (root.mode !== 'create' || root.dispatched !== true || root.id !== normalizeGuid(a.root.id)) return null;
  if (value.mode !== 'create' || value.sensitiveInput !== true || value.parentId !== root.id || value.dispatched
    || value.sentFields !== null || value.sentSha256 !== null || (a.acknowledgedChildCreates || []).some((c) => c.kind === value.kind && c.key === value.key)) return null;
  // The declaration is judged over the attempt's OWN rows (not today's plan, which drops a value the settings no longer
  // supply), so a missing value is not mistaken for a changed declaration and a changed one keeps its own halt.
  const declarationSha256 = B.declarationSha256Of(env.spec, { kind: planned.kind, key: item.declaredKey, solution: planned.solution, rows: p.rows, ruleState: p.completion.ruleState });
  if (declarationSha256 !== a.declarationSha256) return null;
  const { key } = planned;
  const halt = (code, message, extra = {}) => ({ halt: { action: 'halt', code, message, ...extra } });
  // Deployment settings name a value to send: neither "" (leave alone), null (clear) nor no entry at all.
  const input = env.bindings && env.bindings.environmentVariables instanceof Map ? env.bindings.environmentVariables.get(key) : undefined;
  if (!input || typeof input.value !== 'string' || input.value === '') return halt(COMPLETION_CODE, VALUE_MESSAGES.input(key));
  if (!sameRows(planned.plan.rows, p.rows)) return null;
  const seen = (r) => ((observation && observation.rows) || []).find((x) => x.kind === r.kind && x.key === r.key);
  const v = seen(value);
  const rootRead = rootReadOf(root, observation);
  if (!v || rootRead === 'unread' || v.state === 'unknown') return halt(UNVERIFIED_CODE, VALUE_MESSAGES.unverified(key));
  if (rootRead === 'absent') return null;
  if (rootRead === 'contradicted') return halt(CONFLICT_CODE, VALUE_MESSAGES.conflict(key), { rows: [{ id: root.id }] });
  if (v.state === 'present') return null;
  if (v.state !== 'absent') return halt(UNVERIFIED_CODE, VALUE_MESSAGES.unverified(key));
  const members = new Map(((observation && observation.members) || []).map((m) => [normalizeGuid(m.id), m.state]));
  const states = p.completion.members.map((m) => members.get(normalizeGuid(m.id)));
  if (states.some((s) => s !== 'present' && s !== 'absent')) return halt(UNVERIFIED_CODE, VALUE_MESSAGES.unverified(key));
  if (states.some((s) => s !== 'present')) return halt(COMPLETION_CODE, VALUE_MESSAGES.membership(key));
  // The definition is this attempt's own creation only by its own receipted answer; otherwise the maker approves it by
  // its ordinary root token (adopt:environmentVariable:<key>), never by the namesake adoption's @<id> form.
  const approval = defaultApprovalToken(planned.kind, a.root.key, root);
  if (a.acknowledgedRoot !== true && !ctx.approvals().includes(approval)) {
    return halt(OWNERSHIP_CODE, VALUE_MESSAGES.ownership(key, root.id), { rows: [{ id: root.id }], approvals: [approval] });
  }
  return { ready: { declarationSha256 } };
}

/**
 * Send the value valueOwed proved owed, once, and settle the attempt (#847):
 *   1. capture the attempt (captureReadOnly) BEFORE a fresh read, and judge that read (valueOwed) again;
 *   2. claim the value under a new epoch (ctx.claimValue → store.claimUnsentValueRow): the store re-checks the capture
 *      and the attempt under its lease, and the context refuses a second claim in this process;
 *   3. read again and judge again after the claim, so a row changed meanwhile stops the send;
 *   4. send the ONE value POST (B.postPlannedVariableValue) in the send-once scope and the attempt's fenced create set,
 *      classified so that only that value row's create passes; the transport seals it dispatched before it leaves;
 *   5. a definite unstarted refusal stops create-value-refused (the attempt stays pending; the next build may try again
 *      while its record still proves the value never left); any other unchecked answer is create-outcome-unknown and
 *      the value is never sent again;
 *   6. an acknowledged value is observed and settled; the item is present only when the attempt commits.
 * Answers { state: 'present', id } for resolve; anything else throws, typed.
 */
async function completeValueOnce(env, ctx, item) {
  const { planned } = item;
  const { kind, key } = planned;
  const rootId = planned.plan.rows[0].id;
  const fail = (verdict) => { const h = withWayOut(item, haltOf(kind, key, verdict)); throw stop(h.code, h.message, h); };
  const judge = async () => {
    const group = env.store.readGroup(kind, key);
    const attempt = group.pending && group.pending.token === item.token ? group.pending : null;
    if (!attempt) fail({ code: UNVERIFIED_CODE, message: VALUE_MESSAGES.unverified(key) });
    const observation = await B.observe(env.dataverse, planned);
    const owed = valueOwed(env, ctx, { ...item, attempt }, observation);
    if (owed && owed.ready) return { attempt, ready: owed.ready };
    return fail(owed ? owed.halt : ctx.classify(item.token, observation, { declarationSha256: planned.plan.declarationSha256 }));
  };
  const [capture] = ctx.captureReadOnly([item.token]);
  const first = await judge();
  const { value } = variableRowsOf(first.attempt);
  const claimed = ctx.claimValue(item.token, { id: value.id, parentId: value.parentId, capture, declarationSha256: first.ready.declarationSha256 });
  await judge();
  const base = B.createSetClassifier([{ token: claimed.token, planned }]);
  // Only the value row's own create: the definition, a PATCH, a $batch, a membership or any other row is refused unsent.
  const classify = (req) => {
    const d = base(req);
    return d && d.type === 'rows' && d.token === claimed.token && d.rows.length === 1 && d.rows[0].kind === VALUE_ROW_KIND
      && d.rows[0].key === value.key && normalizeGuid(d.rows[0].id) === value.id ? d : null;
  };
  // The service answers the created row (Prefer: return=representation); a body naming another row is not this create.
  const acceptResult = (res) => res === undefined || res === null || res === ''
    || (typeof res === 'object' && !Array.isArray(res) && !res.error && (res.environmentvariablevalueid === undefined || normalizeGuid(res.environmentvariablevalueid) === value.id));
  const pushed = await withConfigurationWrite(() => ctx.run({ attempts: [claimed], classify, deleteCode: B.DELETE_CODE, label: `configuration value ${kind} ${key}`, acceptResult },
    () => B.postPlannedVariableValue(env.dataverse, planned)));
  const mine = ctx.facts(item.token).filter((f) => f.type === 'row' && f.kind === VALUE_ROW_KIND && f.key === value.key);
  const refused = !pushed.checked && !pushed.localError ? mine.find((f) => f.notStarted === true) : null;
  if (refused) throw valueRefusedStop(kind, key, rootId, refused, item.token);
  if (pushed.localError) throw stop(pushed.localError.code || UNVERIFIED_CODE, String(pushed.localError.message || pushed.localError), { kind, key, id: rootId });
  if (!pushed.checked || mine.length !== 1 || mine[0].outcome !== 'acknowledged') {
    throw stop('create-outcome-unknown', `the value of ${kind} "${key}" was not acknowledged; it is not sent again`, { kind, key, id: rootId });
  }
  const [settled] = ctx.settle([{ token: item.token, observation: await B.observe(env.dataverse, planned), declarationSha256: first.ready.declarationSha256 }]);
  if (settled.verdict.action !== 'commit') fail(settled.verdict);
  return { state: 'present', id: rootId };
}

// The stop for a variable whose value request the service refused before it started, the definition sent before it
// (#847). Unlike refusedStop, the attempt is NOT released — its definition may be there — so it routes as unknown
// (configuration-artifacts.js UNKNOWN_PORT_CODES). It carries only the answer's validated Dataverse code and the attempt's
// own token (never service text), which the halt line spells into the retire approval (A.valueRefusedHint).
function valueRefusedStop(kind, key, id, fact, token) {
  const serviceCode = typeof fact.serviceCode === 'string' ? fact.serviceCode : null;
  return stop(VALUE_REFUSED_CODE, `the ${kind} "${key}": ${A.valueRefusedHint({ kind, key, serviceCode, pendingAttemptToken: token })}`,
    { kind, key, id, serviceCode, pendingAttemptToken: token });
}

// The way out of a pending create that only its own ids can complete (#847). A create the service refused under an earlier
// plugin version is pending in phase "sending" with no record that nothing started (2.26.0 kept none), so it reads as
// possibly sent and a build given corrected settings still stops here: nothing proves its rows were never made, and an
// absent read alone is not that proof. The maker can let it go instead, by the exact approval the debt sweep reads
// (pendingSweep: the store stops tracking the attempt, nothing is deleted or sent). That approval is read only for an
// item the App Spec no longer declares (build-model-app.js CONFIGURATION_RETIRE_DECLARED), so the stop names the whole
// procedure, with the attempt's own token: remove the item, run with the approval, restore it. A row the attempt made
// at its derived id then stops the restored create (firstCreateVerdict), which names that row. Never for an edit or an
// adoption, which hold no create of their own to let go.
function withWayOut(item, h) {
  if (item.edit || item.adoption || !item.token || h.code !== COMPLETION_CODE) return h;
  const flags = A.authorizeFlags([retireToken(h.kind, A.portKeyOf(h.kind, h.key), item.token)]);
  return {
    ...h,
    message: `${h.message}. If it cannot be completed that way (a create an earlier plugin version left pending after the service refused it, say), `
      + `stop tracking it instead: remove this item (and its deployment-settings entry) from the App Spec and run the build again with ${flags} `
      + '(nothing is deleted or sent), then restore them and run again. If the attempt made a row at its derived id, that build stops with '
      + 'create-identity-conflict naming the row',
  };
}

const haltOf = (kind, key, verdict) => ({
  kind, key, ...(verdict.rows && verdict.rows[0] ? { id: verdict.rows[0].id } : {}), code: verdict.code || UNVERIFIED_CODE, message: verdict.message || `the ${kind} "${key}" could not be recovered`,
  ...(Array.isArray(verdict.approvals) && verdict.approvals.length ? { approvals: verdict.approvals.slice() } : {}),
});

// ---------------------------------------------------------------------------------------------
// Guidance for a protected rule create whose first publication is not confirmed (#808).
//
// A rule create that saved its content but whose initial publication was not confirmed stops as
// create-completion-required (the rule read Unpublished) or create-identity-unverified (its status read neither
// Published nor Unpublished: a publish job in flight, statecode 0 / statuscode 1, or an unreadable status). The build
// never sends that publication again, so the maker has to finish it, and the bare code does not say how. The runtime
// that formats the stop (configuration-build.js) asks this module's hookup for one advisory sentence
// (createProtectedConfiguration publicationHint), built only from trusted state this module holds:
//   - a note this invocation recorded from an observation it made itself (recoverPending, publishOnce, run's
//     settlement), kept private in SCOPES against the exact port or preflight result that made it;
//   - the checked declaration (its name) and the binding store's current in-memory record (the original id, and that
//     the publication's request was dispatched).
// Nothing travels on an exception, a finding or a halt item: a resolver or error can carry any text, so none of it is
// ever a source of the sentence, and a failure that does not match a note and the record exactly gets today's text.
// Wording only: no request, read, persisted field, approval or code is added, and no recovery decision changes.

// Port or preflight result -> { spec, store, notes: Map(<kind>\0<key> -> note), resolve?, run? }. Module-private:
// neither the map nor a writer is exported, so a caller cannot seed a note.
const SCOPES = new WeakMap();
const noteKey = (kind, key) => `${kind}\u0000${key}`;
const scopeOf = (source, spec, store) => {
  const scope = { spec, store, notes: new Map() };
  SCOPES.set(source, scope);
  return scope;
};
// Pending phases a sent create can be in; `prepared` never sent anything (managed-bindings.js PHASES).
const SENT_PHASES = new Set(['sending', 'saved', 'state-pending', 'membership-pending']);

/**
 * Record (or clear) the note for one stopped pending rule create, from an observation this invocation already made and
 * the verdict judged from it. Eligible only when the rows and members read back exactly as planned (asIsReason, used only
 * as a yes/no predicate: a phase alone does not prove that only the publication is missing, since state-pending is also
 * chosen when a row is absent) and either the rule read Unpublished (create-completion-required, state-pending) or its
 * status read neither Published nor Unpublished (create-identity-unverified). Answers true when a note was recorded.
 */
function noteStop(scope, { planned, token, edit, adoption }, observation, verdict) {
  if (!scope || !planned) return false;
  scope.notes.delete(noteKey(planned.kind, planned.key));
  if (edit || adoption || planned.kind !== 'duplicateRule' || typeof token !== 'string' || !observation || !verdict || verdict.action !== 'halt') return false;
  const state = observation.ruleState;
  const unpublished = verdict.code === COMPLETION_CODE && verdict.phase === 'state-pending' && state === 'unpublished';
  const unknownState = verdict.code === UNVERIFIED_CODE && state !== 'published' && state !== 'unpublished';
  if (!unpublished && !unknownState) return false;
  try {
    if (asIsReason(planned, observation) !== null) return false;
  } catch {
    return false;
  }
  scope.notes.set(noteKey(planned.kind, planned.key), Object.freeze({
    kind: planned.kind, key: planned.key, token, rootId: normalizeGuid(planned.plan.rows[0].id), declarationSha256: planned.plan.declarationSha256,
    solution: planned.solution, code: verdict.code, phase: verdict.phase || null, ruleState: unpublished ? 'unpublished' : 'unknown',
  }));
  return true;
}

// A name or key shown inside the sentence, lossless and on one line: JSON string escaping (quotes, backslashes and
// control characters), plus DEL and the Unicode line and paragraph separators, which JSON.stringify leaves as they are.
const quoted = (s) => JSON.stringify(s).replace(/[\u007f\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
const publicationHintText = (name, key, id) => `The first publication of duplicate detection rule ${quoted(name)} (App Spec key ${quoted(key)}, original id ${id}) has not been confirmed. `
  + 'The build does not send this publication again. Check that exact rule: if it reads Publishing, wait and rebuild; otherwise check its definition '
  + 'and conditions and, if they are what you intend, publish it in the environment\'s duplicate detection rules settings, then rebuild. '
  + 'Setting "status": "published" in the App Spec does not bypass this pending attempt.';

/**
 * The hookup's read-only reader (createProtectedConfiguration publicationHint): the sentence for one stopped duplicate
 * rule, or null for today's text. `source` must be a port or preflight result this hookup issued, over this same spec
 * and store, with its original methods; `guardId` is the stopped item's own normalized id, compared only (the id shown
 * is the store's). Reads the in-memory store record only: no request, no disk refresh. Every failure answers null.
 */
function publicationHintOf({ store, owned }, { spec, source, kind, key, code, guardId } = {}) {
  try {
    if (!configurationIdentityOf(spec) || kind !== 'duplicateRule' || typeof key !== 'string' || !key) return null;
    if (code !== COMPLETION_CODE && code !== UNVERIFIED_CODE) return null;
    if (!source || typeof source !== 'object' || !owned.has(source)) return null;
    const scope = SCOPES.get(source);
    if (!scope || scope.spec !== spec || scope.store !== store || scope.replaced) return null;
    if ((scope.resolve || scope.run) && (source.resolve !== scope.resolve || source.run !== scope.run)) return null;
    const note = scope.notes.get(noteKey(kind, key));
    if (!note || note.kind !== kind || note.key !== key || note.code !== code) return null;
    const entry = A.configurationIntentOf(spec, kind, key);
    if (!entry || entry.key !== key || typeof entry.name !== 'string' || entry.name.trim() === '' || entry.name.length > 100) return null;
    const guard = typeof guardId === 'string' ? normalizeGuid(guardId) : '';
    if (!guard || guard !== guardId) return null;
    const group = store.readGroup(kind, key);
    const a = group && group.pending;
    if (!a || group.committed || a.family !== kind || a.key !== key || a.token !== note.token || !SENT_PHASES.has(a.phase)) return null;
    if (a.acknowledgedRoot !== true || !a.expected || a.expected.baseObservation !== null) return null;
    const p = a.rowProtocol;
    if (!p || !Array.isArray(p.rows) || !p.completion || p.completion.ruleState !== 'published' || !Array.isArray(p.effects)) return null;
    const roots = p.rows.filter((r) => r.parentId === null);
    if (roots.length !== 1 || roots[0].kind !== kind || roots[0].key !== key || roots[0].mode !== 'create') return null;
    const rootId = normalizeGuid(roots[0].id);
    if (!rootId || rootId !== normalizeGuid(a.root && a.root.id) || rootId !== note.rootId || rootId !== guard) return null;
    if (a.declarationSha256 !== note.declarationSha256) return null;
    // The declaration as it is now, over the rows the attempt persisted: a declaration changed since the stop was observed
    // is not the one this sentence would describe.
    if (B.declarationSha256Of(spec, { kind, key, solution: note.solution, rows: p.rows, ruleState: p.completion.ruleState }) !== a.declarationSha256) return null;
    // Only a publication whose request was dispatched is "not sent again". One still `dispatched: false` is sent once by
    // the next build (unsentPublication), and a record without the effect proves nothing either way: today's text.
    const effects = p.effects.filter((e) => e && e.kind === 'rule-state');
    if (effects.length !== 1 || normalizeGuid(effects[0].id) !== rootId || effects[0].dispatched !== true) return null;
    return publicationHintText(entry.name, key, rootId);
  } catch {
    return null;
  }
}

// What every protected read needs, read once per build: the solution's component types (membership is planned only
// outside the restricted solutions, but the read is cheap and fail-closed).
// A variable whose namesake can be adopted: its children are planned under that row (parentIdOf), as resolve binds it before
// them, so one stop can print the approvals of both. Without every approval of the parent the parent itself stops the build
// here, before anything is sent, so a child is never adopted under a parent this build does not adopt.
function adopting(env, kind, portKey, id) {
  if (kind === 'environmentVariable') env.adopting.set(portKey, normalizeGuid(id));
}

async function environmentOf({ spec, store, dataverse, solution, bindings }) {
  const types = await B.readComponentTypes(dataverse);
  if (!types || !types.complete) throw stop(UNVERIFIED_CODE, 'the solution component types could not be read');
  return { spec, store, dataverse, solution, bindings, componentTypes: types.types, adopting: new Map() };
}

/**
 * Replace a protected item's local copy with the server's, under the maker's overwrite approval only (the preflight checks
 * it). The server's row is read directly first: present → the SDK's overwrite fetch; absent (a create the service never
 * took) → the local copy is deleted, since there is no server copy to put in its place. Any other answer — a denied or
 * failed read, a read of another row — or a failed fetch/delete answers false and the caller keeps the copy and halts: a
 * fetch error cannot tell a missing row from a failed read (the SDK reports a remote 404 as a connection error).
 */
async function replaceLocalCopy(dataverse, sdk, kind, id) {
  try {
    const row = await B.readConfigurationRow(dataverse, kind, id);
    if (row.state === 'present') {
      await sdk.fetchArtifact(kind, id, { overwrite: true });
      return !(await hasUnsyncedEdits(sdk, kind, id));
    }
    if (row.state !== 'absent') return false;
    await sdk.deleteArtifact(kind, id);
    return true;
  } catch {
    return false;
  }
}

/**
 * The whole-plan, read-only preflight: every declared protected item located by its binding and its edit judged — a
 * bound Custom API or duplicate rule by its supported shapes (editVerdict), a bound environment variable or connection
 * reference by its complete root/child plan (childVerdict), a bound variable's value clear is a removal and refused, and a
 * first create (unbound, or proved never applied) by its derived id and its complete namesake query (firstCreateVerdict).
 * Sends nothing. Answers { halts: [{ kind, key, id?, code, message }] } — empty when
 * the build may continue. A read that cannot be completed is a halt (`create-identity-unverified`), never "no change".
 */
async function preflightProtectedConfiguration({ spec, store, ctx, dataverse, solution, bindings, sdk = null, authorizedOverwrite = null }) {
  if (!configurationIdentityOf(spec)) return { halts: [] };
  const halts = [];
  // The answer, registered with this preflight's own notes before any is recorded (publicationHintOf reads them).
  const result = { halts };
  const scope = scopeOf(result, spec, store);
  // The maker's approvals as given (exact spellings): an adoption is forecast as made only when every one it needs is here.
  const given = new Set(ctx && typeof ctx.approvals === 'function' ? ctx.approvals() : []);
  let env;
  try {
    env = await environmentOf({ spec, store, dataverse, solution, bindings });
  } catch (error) {
    return { halts: [{ kind: 'configuration', key: '*', code: error.code || UNVERIFIED_CODE, message: error.message }] };
  }
  for (const { kind, key } of parentsFirst(spec, declaredItems(spec))) {
    scope.notes.delete(noteKey(kind, A.portKeyOf(kind, key)));
    try {
      const item = await locateItem(env, kind, key);
      // Every later step of a bound or pending item reads its row into the workspace over the local copy (locate's
      // overwrite fetch); a copy with edits the service has not seen stops it first, kept. The proofs above and below
      // read the service directly (B.readConfigurationRow / B.observe), never the workspace copy.
      // The copy is replaced only under the maker's exact overwrite approval for this item, never by the build on its
      // own (a failed send included): a diff says that the copy differs, never whose the difference is.
      if (item.state !== 'unbound' && !item.adoption && sdk) {
        const id = item.planned.plan.rows[0].id;
        // A copy an earlier version left that the workspace overlay cannot prove clean is refused by the SDK itself
        // (WORKSPACE_LEGACY_CONFIGURATION_COPY, naming its two files): that refusal is rethrown so the item stops with its
        // own remedy (remove those files), not the overwrite approval below, which the same refusal would defeat. Required
        // here, as in configuration-artifacts.js, so the overlay module loads only where a protected build reaches this.
        const { isLegacyCopyRefusal } = require('./workspace-configuration-memory.js');
        if (await hasUnsyncedEdits(sdk, kind, id, { rethrow: isLegacyCopyRefusal })) {
          if (!approvesOverwrite(authorizedOverwrite, overwriteKey(kind, item.planned.key))) {
            halts.push({ kind, key: item.planned.key, id, code: DRAFT_CODE, message: draftMessage(kind, item.planned.key, id), overwrite: `overwrite:${overwriteKey(kind, item.planned.key)}` });
            continue;
          }
          if (!(await replaceLocalCopy(env.dataverse, sdk, kind, id))) {
            halts.push({ kind, key: item.planned.key, id, code: DRAFT_CODE, message: `the local copy of the ${kind} "${item.planned.key}" (${id}) could not be replaced with the server's as approved, because the server's row could not be read exactly; the local copy was kept and nothing was written. Run again` });
            continue;
          }
        }
      }
      if (item.state === 'pending' && item.adoption) {
        // An adoption that never sent is retired by resolve and made again: forecast it as the unbound item it was.
        if (!adoptionUnsent(store, item.attempt)) { const e = adoptionStuck(kind, item.planned.key); halts.push({ kind, key: item.planned.key, code: e.code, message: e.message }); continue; }
        const verdict = await firstCreateVerdict(env.dataverse, item.planned, { exactId: true });
        if (verdict) {
          const adoption = verdict.code === CONFLICT_CODE && verdict.id === undefined && verdict.single ? await adoptionOf(env, item, key) : null;
          if (adoption && adoption.adoptable) adopting(env, kind, item.planned.key, adoption.id);
          if (!adoption || !adoption.adoptable || !adoption.tokens.every((t) => given.has(t))) halts.push({ kind, key: item.planned.key, ...adoptionHalt(verdict, adoption) });
        }
        continue;
      }
      if (item.state === 'pending') {
        const rec = await recoverPending(env, ctx, item);
        if (rec.verdict.action === 'halt') {
          // A variable create whose value alone is owed and provably never left: resolve sends it once (valueOwed);
          // one that cannot be sent yet names exactly why, before anything is sent.
          const value = valueOwed(env, ctx, item, rec.observation);
          if (value && value.ready) continue;
          if (value) { halts.push(withWayOut(item, haltOf(kind, item.planned.key, value.halt))); continue; }
          // A saved rule create whose initial publication provably never left: resolve sends it once (unsentPublication).
          const owed = unsentPublication(ctx, item, rec);
          if (owed && owed.would.action === 'commit') continue;
          // Only the stop judged from this preflight's own read is explained (#808); a hypothetical one (owed.would) is not.
          const h = haltOf(kind, item.planned.key, owed ? owed.would : rec.verdict);
          const noted = !owed && noteStop(scope, item, rec.observation, rec.verdict);
          halts.push(withWayOut(item, noted && !h.id ? { ...h, id: scope.notes.get(noteKey(kind, item.planned.key)).rootId } : h));
          continue;
        }
        // A complete edit settles read-only (resolve): nothing more is written for it, so it is not judged as an edit.
        if (!item.edit) {
          // A create proved never applied is sent again at its own ids (run), after the same namesake query a first create runs.
          if (rec.verdict.action === 'resume') { const v = await firstCreateVerdict(env.dataverse, item.planned, { exactId: false }); if (v) halts.push({ kind, key: item.planned.key, ...v }); }
          continue;
        }
        if (rec.verdict.action === 'commit') continue;
        if (!rec.sameRows && item.attempt.phase !== 'prepared') { halts.push(haltOf(kind, item.planned.key, pendingEditChanged(item.planned))); continue; }
        // An unsent edit whose target is already there is not sent: resolve accepts it read-only. That acceptance is judged
        // now, so a refusal (an approval it needs, a membership removed by hand) stops the build before anything is sent.
        if (rec.sameRows && readOnlyCandidate(item) && !targetMissing(item.attempt.rowProtocol.rows, rec.observation)) {
          const [judged] = ctx.judgeReadOnly([{ token: item.token, observation: rec.observation, declarationSha256: rec.declarationSha256 }]);
          if (judged.verdict.action !== 'commit') halts.push(haltOf(kind, item.planned.key, judged.verdict));
          continue;
        }
        // An unsent edit is judged below like the bound item it edits: it is what this build would send.
      } else if (item.state === 'unbound') {
        // A first create: its reserved ids and its namesakes are judged here, before the build's first write (the solution
        // version PATCH included), so a create that cannot be made stops the build with nothing sent. resolve/run check
        // both again at dispatch, since a row can appear between this read and the create.
        const verdict = await firstCreateVerdict(env.dataverse, item.planned, { exactId: true });
        // A single namesake at another id (a row made before the opt-in) may be adopted at that id instead, under the
        // exact approvals adoptionOf prints; with all of them given, resolve adopts it and this is not a stop.
        if (verdict && verdict.code === CONFLICT_CODE && verdict.id === undefined && verdict.single) {
          const adoption = await adoptionOf(env, item, key);
          if (adoption && adoption.adoptable) adopting(env, kind, item.planned.key, adoption.id);
          if (adoption && adoption.adoptable && adoption.tokens.every((t) => given.has(t))) continue;
          halts.push({ kind, key: item.planned.key, ...adoptionHalt(verdict, adoption) });
          continue;
        }
        if (verdict) halts.push({ kind, key: item.planned.key, ...verdict });
        continue;
      } else if (item.state !== 'bound') continue;
      // Clearing a bound variable's value (a deployment-settings Value of null) is a DELETE of its value row, a physical
      // removal the protected path does not make, authorized or not. A settings entry that leaves the value alone ("" or
      // none) or replaces it is not a clear; those keep the ordinary path and its authorization.
      const clears = kind === 'environmentVariable' && clearsValue(bindings, item.planned.key);
      const judged = await judgeBoundShape(dataverse, kind, item.planned);
      if (judged.halt) { halts.push({ kind, key: item.planned.key, ...judged.halt }); continue; }
      const { shape } = judged;
      // A clear plans no value row, so a value row under the definition is the removal the clear would send.
      const verdict = clears ? (shape.removals.length ? { code: B.DELETE_CODE, message: VALUE_REMOVAL_MESSAGE } : null)
        : kind === 'customApi' || kind === 'duplicateRule' ? editVerdict(kind, shape)
          : await childVerdict(env, item.planned, shape);
      if (verdict) halts.push({ kind, key: item.planned.key, ...verdict });
    } catch (error) {
      scope.notes.delete(noteKey(kind, A.portKeyOf(kind, key)));
      halts.push({ kind, key, ...(error.id ? { id: error.id } : {}), code: error.code || UNVERIFIED_CODE, message: error.message });
    }
  }
  return result;
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
 *   resolve({ kind, key })              { state: 'present', id } for a bound item (read at its exact id) — with `owed`
 *                                       ({ code, message }) when an unsent pending edit of it still owes its write, which
 *                                       only update() sends — or
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
 *                                       makes the SDK's element updates and ONE push (one request, or one checked
 *                                       change set when apiBase is known, refused unsent otherwise), new children are
 *                                       added to the solution, and the attempt is observed and settled. Answers
 *                                       { outcome: 'updated', id, childIds, result }; anything else throws, typed.
 */
function protectedConfigurationPort({ spec, store, ctx, dataverse, solution, bindings, apiBase = null, sdk = null }) {
  let envPromise = null;
  const env = () => (envPromise = envPromise || environmentOf({ spec, store, dataverse, solution, bindings }));
  // The items this port adopted (resolve), by kind and port key: the as-is plan the acceptance proved and the field
  // pointers its stop printed. This invocation's edit of such an item is held to exactly them (update); a later build has a
  // new port, and the item is an ordinary bound one there.
  const adoptedHere = new Map();
  const adopted = (kind, answer) => {
    if (!answer) return null;
    adoptedHere.set(`${kind}\u0000${answer.adoption.asIs.key}`, { asIs: answer.adoption.asIs, pointers: answer.adoption.pointers });
    return { state: answer.state, id: answer.id };
  };
  // A send this port ran that did not settle (a throw, a refused push, an answer that never came) leaves the workspace copy
  // exactly as it is: the build's own change, and any edit a maker wrote meanwhile through the same workspace. The copy is
  // shared with the maker and the SDK has no operation that compares it and replaces it in one step, so no check made
  // before a reset can prove the reset discards only the build's own change; the build therefore never resets it. The
  // attempt is still recovered read-only from what it persisted (recoverPending), and the next build's preflight stops on
  // the copy (DRAFT_CODE) until the maker keeps what they want and approves replacing it with the server's
  // (--authorize overwrite:<kind>:<key>, overwriteKey).
  const port = {
    // The binding store is the authority on these kinds: locate asks this port before any other record (configuration-artifacts.js).
    exact: true,
    protects: (kind) => KINDS.has(kind),
    async resolve({ kind, key }) {
      hintScope.notes.delete(noteKey(kind, A.portKeyOf(kind, key)));
      const item = await locateItem(await env(), kind, key);
      const rootId = item.planned.plan.rows[0].id;
      if (item.state === 'bound') return { state: 'present', id: rootId };
      if (item.state === 'pending' && item.edit) {
        // The edit's bound row is there whatever the attempt's fate: settle (or retire) the attempt first, so the item is
        // planned from a settled binding. An edit whose write is still owed is left for update() to resume, and says so:
        // the plan may never count it unchanged (configuration-artifacts.js planOne) while its attempt is pending.
        const settled = await settlePendingEdit(await env(), ctx, item, await recoverPending(await env(), ctx, item));
        if (settled === 'needs-write') {
          return { state: 'present', id: rootId, owed: { code: COMPLETION_CODE, message: `the ${kind} "${item.planned.key}" has an unsent pending edit whose write is still owed; only that edit is sent for it` } };
        }
        return { state: 'present', id: rootId };
      }
      if (item.state === 'pending' && item.adoption) {
        // An adoption attempt sends nothing: one that provably sent nothing is retired, then the item is the unbound one
        // it was (adopted afresh under the approvals, or created); anything else stops, typed.
        retireAdoption(await env(), ctx, item);
        const answer = adoptionAsked(ctx, kind, item.planned.key) ? adopted(kind, await adoptNamesake(await env(), ctx, item, key)) : null;
        if (answer) return answer;
      } else if (item.state === 'pending') {
        const rec = await recoverPending(await env(), ctx, item);
        let { verdict } = rec;
        const { observation } = rec;
        if (verdict.action === 'commit') {
          // The earlier create is complete as it was planned: commit it, then it is this build's bound row.
          const [settled] = ctx.settle([{ token: item.token, observation, declarationSha256: item.planned.plan.declarationSha256 }]);
          if (settled.verdict.action === 'commit') return { state: 'present', id: rootId };
          const h = haltOf(kind, item.planned.key, settled.verdict);
          throw stop(h.code, h.message, h);
        }
        // Nothing the attempt sent can have been applied: it is created again, under the same ids (run resumes it).
        if (verdict.action === 'resume') return { state: 'absent', id: rootId };
        // A variable create whose value alone is owed and provably never left: sent once, fenced, then settled (#847).
        const value = verdict.action === 'halt' ? valueOwed(await env(), ctx, item, observation) : null;
        if (value && value.ready) return completeValueOnce(await env(), ctx, item);
        if (value) verdict = value.halt;
        // A saved rule create whose initial publication provably never left: sent once, fenced, then settled.
        const owed = unsentPublication(ctx, item, rec);
        if (owed) verdict = owed.would.action === 'commit' ? await publishOnce(await env(), ctx, item, hintScope) : owed.would;
        // A stop judged from this resolve's own read, with no publication owed, is explained too (#808): its note, and the
        // original id on the stop, which the haltOf of an empty verdict does not carry.
        else noteStop(hintScope, item, observation, verdict);
        if (verdict.action === 'commit') return { state: 'present', id: rootId };
        const halt = haltOf(kind, item.planned.key, verdict);
        const note = hintScope.notes.get(noteKey(kind, item.planned.key));
        const h = withWayOut(item, note && !halt.id ? { ...halt, id: note.rootId } : halt);
        throw stop(h.code, h.message, h);
      } else if (adoptionAsked(ctx, kind, item.planned.key)) {
        const answer = adopted(kind, await adoptNamesake(await env(), ctx, item, key));
        if (answer) return answer;
      }
      const read = await B.readConfigurationRow(dataverse, kind, rootId);
      if (read.state === 'absent') return { state: 'absent', id: rootId };
      // A row at the derived id that no binding holds is not adopted silently: adoption needs its own approval.
      throw stop(read.state === 'present' ? CONFLICT_CODE : UNVERIFIED_CODE, `the ${kind} "${item.planned.key}" derived id is ${read.state === 'present' ? 'taken by a row no binding holds' : 'unreadable'}`, { kind, key: item.planned.key, id: rootId });
    },
    async run({ kind, key }, fn) {
      hintScope.notes.delete(noteKey(kind, A.portKeyOf(kind, key)));
      const item = await locateItem(await env(), kind, key);
      let resumed = null;
      // An adoption attempt is never sent as a create: its rows are a maker's, at ids no create derives.
      if (item.state === 'pending' && item.adoption) throw stop(UNVERIFIED_CODE, `the ${kind} "${item.planned.key}" has a pending adoption, which is never sent as a create`, { kind, key: item.planned.key });
      if (item.state === 'pending' && !item.edit) {
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
      // An operation refused before its first request (nothing counted, nothing dispatched) leaves no attempt behind, and
      // so does one whose every request the service refused unstarted (#847, refusedUnsent); one that may have sent
      // anything keeps it for recovery (ctx.release refuses it). The stop below stands either way.
      const refused = refusedUnsent(ctx, attempt, pushed);
      const released = !pushed.checked && ctx.release(attempt);
      if (refused && released) throw refusedStop(kind, planned.key, id, refused, 'create');
      // #847: an original variable create whose run was not checked — its value request was refused unstarted, its answer
      // was lost, or anything after the definition's own acknowledged answer failed — is proved by a fresh exact read when
      // this process holds that genuine answer (ctx.hasPartialRoot: the context kept the candidate only for a current-scope
      // acknowledgement with no conflicting fact and no local failure). An exact root is receipted, so a later build needs
      // no ownership approval for the definition; the value's possibly-sent flag is never touched, so a value that may
      // have left is still never sent again. A root the read positively contradicts stops create-identity-conflict here,
      // before any hint that settings could correct it; an absent or unreadable one proves nothing either way.
      if (!pushed.checked && !released && !pushed.localError && kind === 'environmentVariable' && ctx.hasPartialRoot(attempt.token, attempt.epoch)) {
        const observation = await B.observe(dataverse, planned);
        const rootRead = rootReadOf(planned.plan.rows[0], observation);
        if (rootRead === 'contradicted') throw stop(CONFLICT_CODE, VALUE_MESSAGES.contradicted(planned.key, id), { kind, key: planned.key, id });
        if (rootRead === 'exact') ctx.receiptPartialVariableRoot({ token: attempt.token, epoch: attempt.epoch, observation, declarationSha256: planned.plan.declarationSha256 });
      }
      // A variable whose definition this run sent and whose value request the service refused unstarted (#847): the
      // attempt stays pending (the definition may be there, so it is never released) and the stop says so.
      if (refused && !released && !pushed.localError && kind === 'environmentVariable') {
        const mine = ctx.facts(attempt.token).filter((f) => f.type === 'row');
        const root = planned.plan.rows[0];
        // This run's own answer for the definition (kept `unchecked`, since the run as a whole was not), and the value's
        // durable unstarted reset; a conflict anywhere, or a definition answer that never came, is not this case.
        const rootAnswered = mine.some((f) => f.kind === root.kind && f.key === root.key && (f.outcome === 'unchecked' || f.outcome === 'acknowledged'));
        const valueFact = mine.find((f) => f.kind === VALUE_ROW_KIND && f.notStarted === true);
        if (rootAnswered && valueFact && !mine.some((f) => f.outcome === 'conflict')) throw valueRefusedStop(kind, planned.key, id, valueFact, attempt.token);
      }
      if (pushed.error) throw pushed.error;
      if (pushed.localError) throw stop(pushed.localError.code || UNVERIFIED_CODE, String(pushed.localError.message || pushed.localError), { kind, key: planned.key, id });
      if (!pushed.checked) throw stop('create-outcome-unknown', `the ${kind} "${planned.key}" create was not acknowledged`, { kind, key: planned.key, id });
      const added = await addMissingMembers(dataverse, planned, scope);
      if (added.error || added.localError) throw stop('create-outcome-unknown', `the ${kind} "${planned.key}" solution membership was not acknowledged`, { kind, key: planned.key, id });
      const observation = await B.observe(dataverse, planned);
      const [settled] = ctx.settle([{ token: attempt.token, observation }]);
      if (settled.verdict.action !== 'commit') {
        noteStop(hintScope, { planned, token: attempt.token }, observation, settled.verdict);
        throw stop(settled.verdict.code || UNVERIFIED_CODE, settled.verdict.message || `the ${kind} "${planned.key}" create was not proved`, { kind, key: planned.key, id });
      }
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
      const at = (item.state === 'bound' || (item.state === 'pending' && item.edit)) && planned.plan.rows[0].id === normalizeGuid(id);
      if (!at) throw stop(UNVERIFIED_CODE, `the ${kind} "${planned.key}" is not bound at ${normalizeGuid(id)}`, { kind, key: planned.key });
      let resumed = null;
      if (item.state === 'pending') {
        // Only an edit proved unsent whose rows are still the ones it persisted is sent again, under its own token.
        const rec = await recoverPending(await env(), ctx, item);
        if (rec.verdict.action !== 'resume') { const h = haltOf(kind, planned.key, rec.verdict); throw stop(h.code, h.message, h); }
        if (!rec.sameRows) { const h = haltOf(kind, planned.key, pendingEditChanged(planned)); throw stop(h.code, h.message, h); }
        resumed = { token: item.token, claim: rec.verdict.claim, baseObservation: planned.plan.baseObservation || null };
      }
      const frozen = adoptedHere.get(`${kind}\u0000${planned.key}`);
      if (frozen) {
        // An item adopted in this invocation is edited only as its stop said: its rows still exactly as the acceptance
        // proved them, and the fields this plan would change exactly the ones printed. A maker's edit made before this read
        // fails the first check; one made after it changes the row version this plan's PATCH of the root is conditioned on
        // (locateItem read it), so the service refuses that PATCH. Either way nothing else is sent.
        const reason = asIsReason(frozen.asIs, await B.observe(dataverse, frozen.asIs));
        const changed = reason ? null : changedPointers(planned, frozen.asIs);
        const why = reason || (changed.refusal ? changed.refusal : canonicalJson(changed.pointers) !== canonicalJson(frozen.pointers) ? `the fields it would now change (${changed.pointers.join(', ') || 'none'}) are not the ones its adoption approved (${frozen.pointers.join(', ') || 'none'})` : null);
        if (why) throw stop(CONFLICT_CODE, `the ${kind} "${planned.key}" adopted in this build was not edited: ${why}; nothing was sent for it. Run the build again to plan it from the row as it is now`, { kind, key: planned.key, id: planned.plan.rows[0].id });
      }
      if (planned.rows.some((r) => r.mode === 'create')) {
        const conflicts = await B.readConfigurationConflicts(dataverse, planned);
        if (conflicts.state !== 'clear') throw stop(conflicts.code || UNVERIFIED_CODE, `the ${kind} "${planned.key}" namesake query answered ${conflicts.state}`, { kind, key: planned.key });
      }
      const [attempt] = resumed ? ctx.resume([resumed]) : ctx.begin([planned.plan]);
      const classify = B.createSetClassifier([{ token: attempt.token, planned }]);
      const label = `configuration edit ${kind} ${planned.key}`;
      const batch = apiBase ? { batch: { apiBase, solution: planned.solution } } : {};
      const scope = (send, acceptResult) => ctx.run({ attempts: [attempt], classify, deleteCode: B.DELETE_CODE, label, acceptResult, ...batch }, send);
      const childIds = Object.fromEntries(planned.rows.filter((r) => r.slot !== null && r.mode === 'create').map((r) => [r.slot, r.id]));
      const rootId = planned.plan.rows[0].id;
      const pushed = await scope(() => fn({ childIds }), B.acceptResultFor(planned));
      // As in run(): an edit the SDK refused before its first request — a Custom API label edit on an environment with
      // more than one language (CUSTOM_API_LABELS_UNSUPPORTED) — is released, so the next build plans from the committed
      // group whatever it declares; kept, it held the group for a declaration that is never sent.
      // And as in run(): an edit whose every request created a new child (a variable's first value) and was refused
      // unstarted is released too (#847); a refused PATCH of a row that exists stays owed (managed-create-transport.js).
      const refused = refusedUnsent(ctx, attempt, pushed);
      const released = !pushed.checked && ctx.release(attempt);
      if (refused && released) throw refusedStop(kind, planned.key, rootId, refused, 'edit');
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
  // This port's own notes (#808), kept with its original methods: a port whose methods were replaced is not the one that
  // observed the stop, so publicationHintOf answers nothing for it.
  const hintScope = scopeOf(port, spec, store);
  hintScope.resolve = port.resolve;
  hintScope.run = port.run;
  // Provenance is fixed when a method is replaced, never inferred from the methods found afterwards: a wrapper that puts
  // the original back before it calls it and then throws a stop of its own would otherwise look like the original when
  // the stop is formatted. So each method is an accessor that reads and writes exactly as a plain property does (the
  // build calls whatever is there, so execution is unchanged), but whose first write of any other function marks this
  // port's notes unusable for good. Not configurable, so a saved descriptor cannot be put back round the marker.
  for (const name of Object.keys(port)) {
    if (typeof port[name] !== 'function') continue;
    const original = port[name];
    let current = original;
    Object.defineProperty(port, name, {
      enumerable: true,
      configurable: false,
      get: () => current,
      set: (value) => {
        if (value !== original) hintScope.replaced = true;
        current = value;
      },
    });
  }
  return port;
}

/**
 * The binding store's own debt, read before ANY service change of a build — whatever the App Spec declares today, with or
 * without the opt-in, whichever phases run: every unfinished attempt (or unusable group) of a protected configuration kind
 * whose item the App Spec no longer declares. Omitting a declaration never lets a build go on past what an earlier one left
 * pending when its rows may exist or its effects may be owed. Three such attempts are let go here instead (#847), each by
 * the store's own checked write under its lease, and none by deleting or sending anything:
 *   - one the store proves never sent: still `prepared` (retireUnsentAttempt), or `sending` with every request it counted
 *     answered as not started and nothing dispatched (attemptProvenUnsent, retireProvenUnsentAttempt) — a create the
 *     service refused under an earlier plugin that did not release it in the same run;
 *   - one that may have been sent, only under the maker's exact approval for that attempt,
 *     `--authorize retire:<kind>:<key>@<attempt token>` (`retirements`, configuration-artifacts.js
 *     configurationAuthorizationKeys): the store stops tracking it (abandonAttempt), and rows it may have created stay in
 *     the environment, unmanaged. A later declaration of the item is then an unbound create, whose reads stop on a row
 *     already at the derived id (create-identity-conflict), so nothing is created twice or bound unseen.
 * Anything else — an attempt that may have been sent with no approval, a store write that is refused, or a group the store
 * cannot use — still stops the build, and the stop for a possibly-sent attempt prints the exact approval. A committed group
 * the App Spec dropped is not debt (its rows simply stay). A declared item is judged by the protected preflight (or,
 * without the opt-in, by optInObligations), so it is not listed twice. Nothing is sent. Answers
 * { halts: [{ kind, key, code, message, authorize? }], retired: [{ kind, key, how }] }.
 */
function pendingSweep({ spec, store, retirements = [] }) {
  if (!store || typeof store.snapshot !== 'function') return { halts: [], retired: [] };
  if (typeof store.refresh === 'function') store.refresh();
  const declared = new Set(declaredItems(spec || {}).map(({ kind, key }) => `${kind}\u0000${A.portKeyOf(kind, key)}`));
  const approved = new Set(retirements);
  const halts = [];
  const retired = [];
  for (const unit of store.snapshot().units()) {
    if (!KINDS.has(unit.family) || !(unit.attempt || unit.invalid) || declared.has(`${unit.family}\u0000${unit.key}`)) continue;
    const name = `${unit.family} "${unit.key}"`;
    if (unit.invalid || !unit.attempt) {
      halts.push({ kind: unit.family, key: unit.key, code: PENDING_CODE, message: `the binding store holds a record it cannot use for ${name}, which this App Spec no longer declares. `
        + 'Restore its declaration, with configurationIdentity "stable-v1", so a build can settle it, then run again. No service changes were sent by this build.' });
      continue;
    }
    const a = unit.attempt;
    const how = a.phase === 'prepared' ? 'unsent' : attemptProvenUnsent(a, unit.effects) ? 'not-started' : approved.has(retireKey(unit.family, unit.key, a.token)) ? 'approved' : null;
    if (how && retireUndeclared(store, unit, a, how)) {
      retired.push({ kind: unit.family, key: unit.key, how });
      continue;
    }
    const token = retireToken(unit.family, unit.key, a.token);
    halts.push({ kind: unit.family, key: unit.key, code: PENDING_CODE, authorize: [token], message: `the binding store holds an unfinished attempt for ${name}, which this App Spec no longer declares. `
      + 'Restore its declaration, with configurationIdentity "stable-v1", so a build can settle it, then run again. '
      + `It may have been sent, so it is not dropped silently: to stop tracking it, run again with ${A.authorizeFlags([token])}. Rows it may have created at its derived ids then stay in the environment, unmanaged; nothing is deleted. `
      + 'No service changes were sent by this build.' });
  }
  return { halts, retired };
}

// The approval of one undeclared attempt: `retire:<kind>:<key>@<attempt token>`, the key as the store keys it (portKeyOf)
// and the attempt's own random token, so an approval never carries over to another attempt of the same item.
const retireToken = (kind, key, token) => `retire:${kind}:${key}@${token}`;
// The same approval as configuration-artifacts.js configurationAuthorizationKeys files it (`retire`): NUL-joined, so a
// duplicate-rule key that holds ':' or '@' cannot run into the token.
const retireKey = (kind, key, token) => `${kind}\u0000${key}\u0000${token}`;

// One undeclared attempt let go by the store's own checked write (pendingSweep). Answers true when it was retired, false
// when the store refused (another invocation changed it, or it is not what the snapshot showed): the stop then stands.
function retireUndeclared(store, unit, a, how) {
  try {
    if (how === 'unsent') store.retireUnsentAttempt({ token: a.token, baseGeneration: a.baseGeneration });
    else if (how === 'not-started') store.retireProvenUnsentAttempt({ token: a.token, epoch: a.sendWindow.epoch });
    else store.abandonAttempt({ token: a.token, family: unit.family, key: unit.key });
    return true;
  } catch {
    return false;
  }
}

/**
 * The build's configuration hookup: what the build calls with the binding store, the send-once gate bound to it and the
 * managed create context over both, once a protected feature is selected. Answers { preflight, port, obligations, sweep }:
 * preflight runs the read-only whole-plan pass, port is the create port the configuration runtime installs, obligations is
 * the local store read a build without the opt-in runs (optInObligations), and sweep is the store-driven debt read every
 * build runs before its first service change (pendingSweep). Nothing here creates a gate or a store: the build owns them.
 */
function createProtectedConfiguration({ store, gate, ctx, apiBase = null, retirements = [] } = {}) {
  if (!store || typeof store.readGroup !== 'function') throw new TypeError('createProtectedConfiguration needs the managed binding store');
  if (!ctx || typeof ctx.begin !== 'function' || typeof ctx.run !== 'function' || typeof ctx.settle !== 'function') throw new TypeError('createProtectedConfiguration needs the managed create context');
  // The ports and preflight results this hookup issued: publicationHint answers only for one of them (a source made by
  // another hookup, or by calling the module's functions directly, is not this hookup's to explain).
  const owned = new WeakSet();
  const own = (source) => {
    if (source && typeof source === 'object') owned.add(source);
    return source;
  };
  return {
    store,
    gate,
    ctx,
    preflight: async ({ spec, dataverse, solution, bindings, sdk, authorizedOverwrite }) => own(await preflightProtectedConfiguration({ spec, store, ctx, dataverse, solution, bindings, sdk, authorizedOverwrite })),
    port: ({ spec, dataverse, solution, bindings, sdk }) => own(protectedConfigurationPort({ spec, store, ctx, dataverse, solution, bindings, apiBase, sdk })),
    // A build without the opt-in: what the store still holds for its declared items (optInObligations), read locally.
    obligations: ({ spec }) => optInObligations({ spec, store }),
    // Every build, before its first service change: what the store still owes for items the App Spec no longer declares.
    sweep: ({ spec }) => pendingSweep({ spec, store, retirements }),
    // Read-only advice for one stopped duplicate rule whose first publication is not confirmed (#808), or null:
    // publicationHintOf. No request is made.
    publicationHint: (query) => publicationHintOf({ store, owned }, query),
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
 * or recovers anything. resolve({ kind, key }) answers { state: 'present', id, childIds } (the bound child rows, slot -> id) for a
 * committed binding whose rows all
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
      // The ids of the child rows the binding holds (slot -> id): verify pairs a rule's conditions at them, as the build's plan does
      // (configuration-artifacts.js locateExactly). A declared child the binding does not hold yet is planned as a create at
      // a derived id: that id is not bound to anything, so it is left out.
      // A bound rule is judged as the build's preflight judges it (judgeBoundShape + editVerdict over the same plan), read-only, so
      // verify refuses what a build would refuse: a condition the plan would create (a new or renamed key), a bound or extra row
      // the declaration does not name, a changed rule, an omitted `conditions` over bound ones. What the preflight cannot judge
      // (an incomplete read, a bound row gone) throws here with its own typed code. The refusal rides along as data: verify
      // still reports the content differences, and fails when either finds one.
      if (item.state === 'bound') {
        const childIds = Object.fromEntries(item.planned.rows.filter((r) => r.slot !== null && r.mode === 'update').map((r) => [r.slot, r.id]));
        const out = { state: 'present', id: item.planned.plan.rows[0].id, childIds };
        if (kind === 'duplicateRule') {
          const judged = await judgeBoundShape((await env()).dataverse, kind, item.planned);
          if (judged.halt) throw stop(judged.halt.code, judged.halt.message, { kind, key: item.planned.key, ...(judged.halt.id ? { id: judged.halt.id } : {}) });
          const verdict = editVerdict(kind, judged.shape);
          if (verdict) {
            out.buildRefusal = {
              code: verdict.code,
              created: item.planned.rows.filter((r) => r.kind === 'duplicateRuleCondition' && r.mode === 'create').map((r) => r.slot),
              removed: judged.shape.removals.length > 0,
            };
          }
        }
        return out;
      }
      if (item.state === 'pending') throw stop(PENDING_CODE, `the ${kind} "${item.planned.key}" has an attempt still pending; it is not verified until a build settles it`, { kind, key: item.planned.key });
      throw stop(UNVERIFIED_CODE, `the ${kind} "${item.planned.key}" has no committed binding in this workspace's binding store; it is never verified by name`, { kind, key: item.planned.key });
    },
    // configuration-artifacts.js takes a port by its `run`; verify never creates, so this one refuses unsent.
    async run({ kind, key }) {
      throw stop(UNVERIFIED_CODE, `verify sends nothing: the ${kind} "${key}" is not created here`, { kind, key });
    },
  };
}

/**
 * The explicit managed download's proof that ONE declaration it rebuilt from the service (lib/declared-configuration-io.js) is the
 * item its committed binding holds, unchanged, so a rebuild of the downloaded spec sends nothing for it. Read-only, over the same
 * exact location and judgment the build's preflight uses (locateItem, judgeBoundShape), with no deployment settings (the download
 * writes none, and a rebuild without them is the no-settings rebuild):
 *   - `spec` holds the candidate declaration and `manifest` is the store's groups in the shape manifestStore reads; the item must be
 *     bound there (committed, nothing pending) at exactly the ids the declaration derives;
 *   - the plan of the candidate must change nothing: no root or child edit, no create, no rule-state change, and no row under the root
 *     the binding does not hold — except, for an environment variable, one value set outside the plugin, which a rebuild without
 *     settings leaves alone (childVerdict) and which is counted, never read;
 *   - the solution must hold every member now (readMembers): a restore never repairs membership;
 *   - every bound row must read back as its committed projection (`consumerRows`, the build's consumer state), computed over the same
 *     fields: the plan of a bound row expects what the row has for every field the declaration omits, so without this a row changed
 *     outside the plugin would be downloaded as if the build had made it so (its drift "refreshed away"). A connection reference's
 *     connected flag is not part of its declaration (which connection is private, and is bound per environment), so either value
 *     proves it.
 * Answers { ok: true, values, valueFilled, defaultSet, defaultFilled, valueSchemaSet, connected[, binding] } or { ok: false, code } with a code of
 * lib/managed-restore-report.js. Every flag is read from the rows this proof proved, in this one pass, so what a download says of an
 * item's readiness is what it proved, never an earlier read a change in between could leave behind:
 *   - `values`: how many value rows a variable has (0 or 1); `valueFilled`: whether that row holds a value the build's readiness
 *     counts; `defaultSet` / `defaultFilled`: whether the variable's definition has a default, and one the readiness counts;
 *     `valueSchemaSet`: whether it has a value schema;
 *   - `connected`: whether a connection reference's row holds a connection id;
 *   - `binding` (only when `connections` is given, the connection inventory reader of configuration-artifacts.js connectionInventory):
 *     the verdict a rebuild's page gate gives the reference ('bound', 'unbound' or 'unknown', configuration-artifacts.js
 *     referenceBinding). A connection id in the row is not that proof: the connection must be in the environment's connections and be
 *     one of the connector the row and the declaration name. Read last, once everything else is proved, so a reference left out for
 *     another reason costs no inventory read.
 * Only these flags leave: the values themselves are compared in memory and dropped. It sends nothing and never throws for what it reads.
 */
async function restoreProofOf({ spec, manifest, dataverse, solution, kind, key, consumerRows, connections }) {
  const failed = (error) => ({ ok: false, code: error && error.code === B.NOT_FOUND_CODE ? 'missing' : error && error.code === UNVERIFIED_CODE ? 'unread' : 'not-equivalent' });
  let item;
  try {
    const env = await environmentOf({ spec, store: manifestStore(manifest), dataverse, solution, bindings: undefined });
    item = await locateItem(env, kind, key);
  } catch (error) {
    return failed(error);
  }
  if (item.state === 'pending') return { ok: false, code: 'pending' };
  if (item.state !== 'bound') return { ok: false, code: 'invalid' };
  const { planned } = item;
  let judged;
  try {
    judged = await judgeBoundShape(dataverse, kind, planned);
  } catch (error) {
    return failed(error);
  }
  if (judged.halt) return { ok: false, code: judged.halt.code === B.NOT_FOUND_CODE ? 'missing' : 'unread' };
  const { shape } = judged;
  if (shape.rootChanged || shape.ruleStateChanged || shape.creates.length || shape.labelEdits.length || shape.fixedEdits.length) return { ok: false, code: 'would-change' };
  const strayValues = kind === 'environmentVariable' ? shape.removals.filter((r) => r.startsWith('environmentVariableValue:')) : [];
  if (shape.removals.length > strayValues.length) return { ok: false, code: 'changed' };
  const values = planned.rows.filter((r) => r.kind === 'environmentVariableValue').length + strayValues.length;
  if (values > 1) return { ok: false, code: 'multiple-values' };
  let members;
  try {
    members = await B.readMembers(dataverse, planned);
  } catch {
    return { ok: false, code: 'membership-unknown' };
  }
  if (members.some((m) => m.state === 'unknown')) return { ok: false, code: 'membership-unknown' };
  if (members.some((m) => m.state !== 'present')) return { ok: false, code: 'not-in-solution' };
  const committed = Array.isArray(consumerRows) ? consumerRows : [];
  const sameRow = (c, r) => !!c && c.kind === r.kind && c.key === r.key && normalizeGuid(c.id) === r.id;
  // Whether a variable's value row holds a usable value, as the build's readiness reads it (configuration-artifacts.js observe:
  // a value that is neither null nor ''). Only this flag leaves here: the value itself is compared in memory and dropped.
  let valueFilled = false;
  const root = { defaultSet: false, defaultFilled: false, valueSchemaSet: false, connected: false };
  const filledValue = (read) => !!read.decoded.private && read.decoded.private.present && read.decoded.private.value != null && read.decoded.private.value !== '';
  // The connection reference's row as the binding verdict reads it, in memory only (its connection id never leaves this function).
  let referenceRow = null;
  for (const r of planned.rows) {
    const c = committed.find((x) => sameRow(x, r));
    if (!c) return { ok: false, code: 'changed' };
    const read = await B.readConfigurationRow(dataverse, r.kind, r.id);
    if (read.state === 'absent') return { ok: false, code: 'missing' };
    if (read.state !== 'present') return { ok: false, code: 'unread' };
    if (r.kind === 'environmentVariableValue' && filledValue(read)) valueFilled = true;
    if (r.kind === 'environmentVariable') {
      const { defaultValue, valueSchema } = read.decoded.fields;
      root.defaultSet = defaultValue != null;
      root.defaultFilled = defaultValue != null && defaultValue !== '';
      root.valueSchemaSet = valueSchema != null;
    }
    if (r.kind === 'connectionReference') {
      root.connected = filledValue(read);
      referenceRow = { connectionId: root.connected ? read.decoded.private.value : null, connectorId: read.decoded.fields.connectorId };
    }
    const semantic = B.semanticOf(r.kind, read.decoded);
    const variants = r.kind === 'connectionReference' ? [{ ...semantic, connected: false }, { ...semantic, connected: true }] : [semantic];
    const proved = variants.some((s) => B.projectionOf(r.kind, r.expected, s, read.decoded.unmodelled, [], read.decoded.preserved) === c.projectionSha256);
    if (!proved) return { ok: false, code: 'changed' };
  }
  // A committed row the plan does not hold is a child the declaration no longer derives: the graph changed. A variable's committed
  // value removed outside the plugin is the one exception — it held nothing a declaration says, and its absence is counted above.
  for (const c of committed) {
    if (c.kind === 'environmentVariableValue') continue;
    if (!planned.rows.some((r) => sameRow(c, r))) return { ok: false, code: 'changed' };
  }
  // A value set outside the plugin ('environmentVariableValue:<id>', one at most by now) counts as the build's readiness counts it.
  for (const stray of strayValues) {
    const read = await B.readConfigurationRow(dataverse, 'environmentVariableValue', stray.slice(stray.indexOf(':') + 1));
    if (read.state === 'absent') continue;
    if (read.state !== 'present') return { ok: false, code: 'unread' };
    if (filledValue(read)) valueFilled = true;
  }
  if (kind === 'connectionReference' && typeof connections === 'function' && referenceRow) {
    const entry = (Array.isArray(spec.connectionReferences) ? spec.connectionReferences : [])
      .find((e) => e && String(e.logicalName).toLowerCase() === String(key).toLowerCase());
    // An unbound row needs no inventory: the verdict is 'unbound' whatever the environment holds.
    root.binding = A.referenceBinding(referenceRow, entry, referenceRow.connectionId ? await connections() : null);
  }
  return { ok: true, values, valueFilled, ...root };
}

module.exports = {
  EDIT_CODE,
  OPT_IN_CODE,
  RULE_EDIT_MESSAGE,
  API_EDIT_MESSAGE,
  configurationIdentityOf,
  editVerdict,
  optInObligations,
  pendingSweep,
  preflightProtectedConfiguration,
  protectedConfigurationPort,
  protectedVerifyPort,
  restoreProofOf,
  slotOf,
  createProtectedConfiguration,
};
