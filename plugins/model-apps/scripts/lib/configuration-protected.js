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
const { hasUnsyncedEdits } = require('./unsynced-edits.js');

const IDENTITY = 'stable-v1';
const EDIT_CODE = 'configuration-edit-unsupported';
const UNVERIFIED_CODE = 'create-identity-unverified';
const CONFLICT_CODE = 'create-identity-conflict';
const COMPLETION_CODE = 'create-completion-required';
const OWNERSHIP_CODE = 'create-ownership-required';
const OPT_IN_CODE = 'create-identity-opt-in-required';
// A local workspace copy with edits the service has not seen: the code (and the steps) of the declared forms' same stop
// (form-layout-reconcile.js, category workspace-copy-unsent-edits).
const DRAFT_CODE = 'create-completion-required';
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
const draftMessage = (kind, key, id) => `the local copy of the ${kind} "${key}" (${id}) in the workspace differs from the server's (an edit an earlier run did not send, `
  + 'or one made by hand), or could not be compared; nothing was read over it or written, and the copy was kept. '
  + 'Put any change you want to keep into the App Spec, refresh the local copy from the server, then run again';

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
  if (group.pending && !group.committed) return { state: 'pending', planned: fresh, token: group.pending.token, edit: false, attempt: group.pending, declaredKey: key };
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
  // A pending EDIT is located like the bound item it edits — at the exact ids its binding holds — and is then decided
  // from the expectation the attempt itself persisted (recoverPending), never from this plan's.
  if (group.pending) return { state: 'pending', planned, token: group.pending.token, edit: true, attempt: group.pending, declaredKey: key };
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
 * answer: a complete edit is committed read-only; an unsent one whose rows match is accepted read-only when its target
 * is already there (every row an update), and otherwise left to update(), which resumes it; an unsent one whose rows
 * changed is retired while it is only prepared. Answers nothing; throws a typed halt.
 */
async function settlePendingEdit(env, ctx, item, rec) {
  const { planned } = item;
  const fail = (verdict) => { const h = haltOf(planned.kind, planned.key, verdict); throw stop(h.code, h.message, h); };
  if (rec.verdict.action === 'commit') {
    const [settled] = ctx.settle([{ token: item.token, observation: rec.observation, declarationSha256: rec.declarationSha256 }]);
    if (settled.verdict.action !== 'commit') fail(settled.verdict);
    return;
  }
  if (rec.verdict.action !== 'resume') fail(rec.verdict);
  if (!rec.sameRows) {
    if (item.attempt.phase !== 'prepared') fail(pendingEditChanged(planned));
    env.store.retireUnsentAttempt({ token: item.token, baseGeneration: item.attempt.baseGeneration });
    return;
  }
  if (!item.attempt.rowProtocol.rows.every((r) => r.mode === 'update') || !planned.plan.baseObservation) return;
  // Already at its target (made by hand, say): accepted with no send. The capture is taken before the fresh read.
  if (item.attempt.phase === 'prepared') ctx.resume([{ token: item.token, claim: 'first', baseObservation: planned.plan.baseObservation }]);
  const [capture] = ctx.captureReadOnly([item.token]);
  const observation = await B.observe(env.dataverse, planned);
  ctx.acceptReadOnly([{ token: item.token, observation, capture, declarationSha256: rec.declarationSha256 }]);
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
async function publishOnce(env, ctx, item) {
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
  return settled.verdict;
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
async function preflightProtectedConfiguration({ spec, store, ctx, dataverse, solution, bindings, sdk = null }) {
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
      // Every later step of a bound or pending item reads its row into the workspace over the local copy (locate's
      // overwrite fetch); a copy with edits the service has not seen stops it first, kept. The proofs above and below
      // read the service directly (B.readConfigurationRow / B.observe), never the workspace copy.
      if (item.state !== 'unbound' && sdk) {
        const id = item.planned.plan.rows[0].id;
        if (await hasUnsyncedEdits(sdk, kind, id)) { halts.push({ kind, key: item.planned.key, id, code: DRAFT_CODE, message: draftMessage(kind, item.planned.key, id) }); continue; }
      }
      if (item.state === 'pending') {
        const rec = await recoverPending(env, ctx, item);
        if (rec.verdict.action === 'halt') {
          // A saved rule create whose initial publication provably never left: resolve sends it once (unsentPublication).
          const owed = unsentPublication(ctx, item, rec);
          if (owed && owed.would.action === 'commit') continue;
          halts.push(haltOf(kind, item.planned.key, owed ? owed.would : rec.verdict));
          continue;
        }
        // A complete edit settles read-only (resolve): nothing more is written for it, so it is not judged as an edit.
        if (!item.edit || rec.verdict.action === 'commit') continue;
        if (!rec.sameRows && item.attempt.phase !== 'prepared') { halts.push(haltOf(kind, item.planned.key, pendingEditChanged(item.planned))); continue; }
        // An unsent edit is judged below like the bound item it edits: it is what this build would send.
      } else if (item.state !== 'bound') continue;
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
function protectedConfigurationPort({ spec, store, ctx, dataverse, solution, bindings, apiBase = null, sdk = null }) {
  let envPromise = null;
  const env = () => (envPromise = envPromise || environmentOf({ spec, store, dataverse, solution, bindings }));
  // A send this port ran that did not settle (a throw, a refused push, an answer that never came) can leave the build's OWN
  // change in the workspace copy, which the next build's preflight would refuse as an unsent edit, so the attempt could
  // never be continued. The copy held nothing else (the preflight, or locate, proved it clean just before), so it is put
  // back as the service holds it, as the declared forms do (form-layout-reconcile.js resetOwnCopy): re-read with overwrite
  // (a read, which the send window does not count), or, for a create the service does not hold, removed (a local delete,
  // no request). Best-effort: a reset that fails leaves the copy, and the next build refuses it rather than plan over it.
  const withOwnCopy = async (kind, id, body) => {
    try {
      return await body();
    } catch (error) {
      if (sdk) {
        try {
          if (await hasUnsyncedEdits(sdk, kind, id)) {
            try { await sdk.fetchArtifact(kind, id, { overwrite: true }); } catch { await sdk.deleteArtifact(kind, id); }
          }
        } catch { /* see above */ }
      }
      throw error;
    }
  };
  return {
    // The binding store is the authority on these kinds: locate asks this port before any other record (configuration-artifacts.js).
    exact: true,
    protects: (kind) => KINDS.has(kind),
    async resolve({ kind, key }) {
      const item = await locateItem(await env(), kind, key);
      const rootId = item.planned.plan.rows[0].id;
      if (item.state === 'bound') return { state: 'present', id: rootId };
      if (item.state === 'pending' && item.edit) {
        // The edit's bound row is there whatever the attempt's fate: settle (or retire) the attempt first, so the item is
        // planned from a settled binding, or left for update() to resume.
        await settlePendingEdit(await env(), ctx, item, await recoverPending(await env(), ctx, item));
        return { state: 'present', id: rootId };
      }
      if (item.state === 'pending') {
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
        // A saved rule create whose initial publication provably never left: sent once, fenced, then settled.
        const owed = unsentPublication(ctx, item, rec);
        if (owed) verdict = owed.would.action === 'commit' ? await publishOnce(await env(), ctx, item) : owed.would;
        if (verdict.action === 'commit') return { state: 'present', id: rootId };
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
      return withOwnCopy(kind, id, async () => {
        const pushed = await scope(() => fn({ id, childIds }), B.acceptResultFor(planned));
        if (pushed.error) throw pushed.error;
        if (pushed.localError) throw stop(pushed.localError.code || UNVERIFIED_CODE, String(pushed.localError.message || pushed.localError), { kind, key: planned.key, id });
        if (!pushed.checked) throw stop('create-outcome-unknown', `the ${kind} "${planned.key}" create was not acknowledged`, { kind, key: planned.key, id });
        const added = await addMissingMembers(dataverse, planned, scope);
        if (added.error || added.localError) throw stop('create-outcome-unknown', `the ${kind} "${planned.key}" solution membership was not acknowledged`, { kind, key: planned.key, id });
        const [settled] = ctx.settle([{ token: attempt.token, observation: await B.observe(dataverse, planned) }]);
        if (settled.verdict.action !== 'commit') throw stop(settled.verdict.code || UNVERIFIED_CODE, settled.verdict.message || `the ${kind} "${planned.key}" create was not proved`, { kind, key: planned.key, id });
        return { outcome: 'created', id, childIds, result: pushed.value };
      });
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
      return withOwnCopy(kind, rootId, async () => {
        const pushed = await scope(() => fn({ childIds }), B.acceptResultFor(planned));
        if (pushed.error) throw pushed.error;
        if (pushed.localError) throw stop(pushed.localError.code || UNVERIFIED_CODE, String(pushed.localError.message || pushed.localError), { kind, key: planned.key, id: rootId });
        if (!pushed.checked) throw stop('create-outcome-unknown', `the ${kind} "${planned.key}" edit was not acknowledged`, { kind, key: planned.key, id: rootId });
        const added = await addMissingMembers(dataverse, planned, scope);
        if (added.error || added.localError) throw stop('create-outcome-unknown', `the ${kind} "${planned.key}" solution membership was not acknowledged`, { kind, key: planned.key, id: rootId });
        const [settled] = ctx.settle([{ token: attempt.token, observation: await B.observe(dataverse, planned) }]);
        if (settled.verdict.action !== 'commit') throw stop(settled.verdict.code || UNVERIFIED_CODE, settled.verdict.message || `the ${kind} "${planned.key}" edit was not proved`, { kind, key: planned.key, id: rootId });
        return { outcome: 'updated', id: rootId, childIds, result: pushed.value };
      });
    },
  };
}

/**
 * The binding store's own debt, read before ANY service change of a build — whatever the App Spec declares today, with or
 * without the opt-in, whichever phases run: every unfinished attempt (or unusable group) of a protected configuration kind
 * whose item the App Spec no longer declares. Omitting a declaration never lets a build go on past what an earlier one left
 * pending: its rows may exist and its effects may be owed, and only its own declaration can settle it. Nothing is retired,
 * deleted or reset here, and a committed group the App Spec dropped is not debt (its rows simply stay). A declared item is
 * judged by the protected preflight (or, without the opt-in, by optInObligations), so it is not listed twice.
 * A local store read only: nothing is sent. Answers { halts: [{ kind, key, code, message }] }.
 */
function pendingSweep({ spec, store }) {
  if (!store || typeof store.snapshot !== 'function') return { halts: [] };
  if (typeof store.refresh === 'function') store.refresh();
  const declared = new Set(declaredItems(spec || {}).map(({ kind, key }) => `${kind}\u0000${A.portKeyOf(kind, key)}`));
  const halts = [];
  for (const unit of store.snapshot().units()) {
    if (!KINDS.has(unit.family) || !(unit.attempt || unit.invalid) || declared.has(`${unit.family}\u0000${unit.key}`)) continue;
    const what = unit.attempt ? 'an unfinished attempt' : 'a record it cannot use';
    halts.push({ kind: unit.family, key: unit.key, code: PENDING_CODE, message: `the binding store holds ${what} for ${unit.family} "${unit.key}", which this App Spec no longer declares. `
      + 'Restore its declaration, with configurationIdentity "stable-v1", so a build can settle it, then run again. No service changes were sent by this build.' });
  }
  return { halts };
}

/**
 * The build's configuration hookup: what the build calls with the binding store, the send-once gate bound to it and the
 * managed create context over both, once a protected feature is selected. Answers { preflight, port, obligations, sweep }:
 * preflight runs the read-only whole-plan pass, port is the create port the configuration runtime installs, obligations is
 * the local store read a build without the opt-in runs (optInObligations), and sweep is the store-driven debt read every
 * build runs before its first service change (pendingSweep). Nothing here creates a gate or a store: the build owns them.
 */
function createProtectedConfiguration({ store, gate, ctx, apiBase = null } = {}) {
  if (!store || typeof store.readGroup !== 'function') throw new TypeError('createProtectedConfiguration needs the managed binding store');
  if (!ctx || typeof ctx.begin !== 'function' || typeof ctx.run !== 'function' || typeof ctx.settle !== 'function') throw new TypeError('createProtectedConfiguration needs the managed create context');
  return {
    store,
    gate,
    ctx,
    preflight: ({ spec, dataverse, solution, bindings, sdk }) => preflightProtectedConfiguration({ spec, store, ctx, dataverse, solution, bindings, sdk }),
    port: ({ spec, dataverse, solution, bindings, sdk }) => protectedConfigurationPort({ spec, store, ctx, dataverse, solution, bindings, apiBase, sdk }),
    // A build without the opt-in: what the store still holds for its declared items (optInObligations), read locally.
    obligations: ({ spec }) => optInObligations({ spec, store }),
    // Every build, before its first service change: what the store still owes for items the App Spec no longer declares.
    sweep: ({ spec }) => pendingSweep({ spec, store }),
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
  pendingSweep,
  preflightProtectedConfiguration,
  protectedConfigurationPort,
  protectedVerifyPort,
  createProtectedConfiguration,
};
