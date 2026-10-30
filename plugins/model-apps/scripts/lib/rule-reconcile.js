'use strict';
// Declared business rules (`businessRules[].reconcile: "declared"`): an existing rule is edited in place
// to what the spec declares, instead of being reused untouched.
//
// Without the opt-in the build creates a missing rule and reuses an existing one as it is (sdk-build's
// business-rules phase: "rule edits aren't applied on rebuild"). With it, the rule's condition clauses,
// its true-branch actions, its condition logic (AND / OR) and an explicit description are the spec's:
//   - every condition and action carries a stable `key`; a key keeps its node across edits, so the node
//     keeps its server id, step name, labels and bag (the SDK round-trips them);
//   - a key the spec adds is appended; a key it drops, or a node someone else added, is a REMOVAL and
//     needs the build's destructive approval;
//   - the rule is edited through the SDK's own fetch -> updateElement -> push, which runs the designer's
//     completeness validator before anything is sent, so an incomplete rule is refused, not written.
//     The same definition is updated; a new rule by the same name is never created to carry an edit.
//
// Shapes it owns beyond the four the build already authors: SetDefaultValue {field, value, dataType?},
// ShowErrorMessage {field, errorMessage} and Recommendation {field, recommendationTitle, messageText,
// acceptanceText?, applyActions: [{key, field, value, dataType?}]}. Values are literals (the SDK's
// `Value` mode) only: a live node in another value mode (Field, Expression, Lookup, Parameter) is not
// guessed at, it is refused.
//
// Identity, measured through the vendored bundle: a fetched rule's CLAUSE ids are minted afresh on every
// read (random GUIDs) and its ACTION ids are per-type ordinals (SetVisibilityStep1, SetMessageStep2), so
// neither is an identity a binding can hold. A node's identity is therefore its POSITION in its list at
// the last build, recorded per key; the whole owned tree is drift-checked as one, so a node moved,
// inserted or edited outside the spec shows up as drift before any position is trusted.
//
// Also measured: the SDK honours a literal's `valueWorkflowType` on CONDITIONS (a numeric clause reads
// back as type 5) but types every ACTION literal as String, so an action's workflow type is written but
// not compared — comparing it would report a change on every run.

const {
  emptyResult,
  operation,
  refusal,
  isAuthorized,
  lookupBinding,
  bindingRecord,
  partsDriftVerdict,
  projectionBaseline,
  boundIdentity,
  pushIfChanged,
  intentSha256,
  canonicalJson,
  rulesOf,
} = require('./reconcile-common.js');

const KIND = 'business-rule';
const NODE_KIND = 'business-rule-node';
const ARTIFACT = 'businessRule';
const ACTION_TYPES = ['SetVisibility', 'LockUnlock', 'SetBusinessRequired', 'SetFieldValue', 'SetDefaultValue', 'ShowErrorMessage', 'Recommendation'];
const VALUELESS = new Set(['ContainsData', 'DoesNotContainData']);

// The build's own literal mapping (sdk-build businessRuleDef), loaded at call time: sdk-build will load
// this module when it is wired in, and a top-level require back into it would see a half-built export.
function buildDef(rule) {
  return require('./sdk-build.js').businessRuleDef(rule);
}

function isDeclaredRule(rule) {
  return !!rule && rule.reconcile === 'declared';
}

function ruleKey(rule) {
  return rule && rule.key ? String(rule.key) : `${String((rule && rule.entity) || '').toLowerCase()}/${String((rule && rule.name) || '')}`;
}

const lc = (v) => String(v == null ? '' : v).toLowerCase();

/** Problems that keep a declared rule from being edited at all (spec-level; nothing is read). */
function validateDeclaredRule(rule) {
  const errors = [];
  if (rule.conditionLogic !== undefined && rule.conditionLogic !== 'AND' && rule.conditionLogic !== 'OR') errors.push('conditionLogic must be AND or OR');
  const keys = new Set();
  const keyed = (node, where) => {
    if (!node || typeof node.key !== 'string' || !node.key.trim()) errors.push(`${where} needs a key`);
    else if (keys.has(node.key)) errors.push(`key ${node.key} is used twice`);
    else keys.add(node.key);
  };
  (rule.conditions || []).forEach((c, i) => keyed(c, `conditions[${i}]`));
  (rule.actions || []).forEach((a, i) => {
    keyed(a, `actions[${i}]`);
    if (!ACTION_TYPES.includes(a && a.type)) errors.push(`actions[${i}] has an unsupported type`);
    if (a && a.type === 'ShowErrorMessage' && !String(a.errorMessage || '').trim()) errors.push(`actions[${i}] needs errorMessage`);
    if (a && a.type === 'Recommendation') {
      if (!String(a.recommendationTitle || '').trim() || !String(a.messageText || '').trim()) errors.push(`actions[${i}] needs recommendationTitle and messageText`);
      const applies = a.applyActions || [];
      if (!applies.length) errors.push(`actions[${i}] needs at least one applyAction`);
      const fields = new Set();
      applies.forEach((p, j) => {
        keyed(p, `actions[${i}].applyActions[${j}]`);
        if (fields.has(lc(p && p.field))) errors.push(`actions[${i}] sets ${lc(p.field)} twice`);
        fields.add(lc(p && p.field));
      });
    }
  });
  return errors;
}

// The workflow type the build gives a literal of `dataType` (WORKFLOW_ATTRIBUTE_TYPE in sdk-build).
function workflowTypeOf(dataType) {
  const def = buildDef({ name: 'x', entity: 'x', conditions: [], actions: [{ type: 'SetFieldValue', field: 'x', value: '', dataType }] });
  return def.rootCondition.trueBranch[0].valueWorkflowType;
}

/** One condition as the SDK takes it (no id). */
function sdkClause(c) {
  const clause = buildDef({ name: 'x', entity: 'x', conditions: [c], actions: [] }).rootCondition.clauses[0];
  delete clause.id;
  return clause;
}

/** One action as the SDK takes it (no id). The four the build already authors come from businessRuleDef. */
function sdkAction(a) {
  const field = lc(a.field);
  const displayName = a.label || `${a.type} ${field}`;
  switch (a.type) {
    case 'SetDefaultValue':
      return { type: a.type, displayName, field, valueType: 'Value', value: String(a.value), valueWorkflowType: workflowTypeOf(a.dataType) };
    case 'ShowErrorMessage':
      return { type: a.type, displayName, field, errorMessage: String(a.errorMessage) };
    case 'Recommendation':
      return {
        type: a.type, displayName, field,
        recommendationTitle: String(a.recommendationTitle),
        messageText: String(a.messageText),
        ...(a.acceptanceText !== undefined ? { acceptanceText: String(a.acceptanceText) } : {}),
        applyActions: (a.applyActions || []).map((p, i) => ({ id: `p${i + 1}`, field: lc(p.field), valueType: 'Value', value: String(p.value), valueWorkflowType: workflowTypeOf(p.dataType) })),
      };
    default: {
      const node = buildDef({ name: 'x', entity: 'x', conditions: [], actions: [a] }).rootCondition.trueBranch[0];
      delete node.id;
      return node;
    }
  }
}

/** The rule's whole condition tree as the SDK takes it, for a CREATE (conditionLogic and all seven action shapes). */
function ruleRootCondition(rule) {
  return {
    id: 'r1',
    displayName: rule.name,
    logic: rule.conditionLogic || 'AND',
    clauses: (rule.conditions || []).map((c, i) => ({ id: `c${i + 1}`, ...sdkClause(c) })),
    trueBranch: (rule.actions || []).map((a, i) => ({ id: `a${i + 1}`, ...sdkAction(a) })),
    falseBranch: [],
  };
}

// What the spec owns of one node, live or desired. A label is owned only where the spec states one
// (and never on a Recommendation, whose display name the SDK replaces with its title).
function clauseProjection(cl) {
  const out = { field: lc(cl.field), operator: cl.operator };
  if (!VALUELESS.has(cl.operator)) {
    out.valueType = cl.valueType || 'Value';
    out.value = cl.value == null ? '' : String(cl.value);
    out.valueWorkflowType = cl.valueWorkflowType || '';
  }
  return out;
}
function actionProjection(a, ownsLabel) {
  const out = { type: a.type, field: lc(a.field) };
  if (a.type === 'SetVisibility') out.visible = a.visible === true;
  else if (a.type === 'LockUnlock') out.lock = a.lock === true;
  else if (a.type === 'SetBusinessRequired') out.required = a.required === true;
  else if (a.type === 'SetFieldValue' || a.type === 'SetDefaultValue') { out.valueType = a.valueType || 'Value'; out.value = a.value == null ? '' : String(a.value); }
  else if (a.type === 'ShowErrorMessage') out.errorMessage = String(a.errorMessage || '');
  else if (a.type === 'Recommendation') {
    out.recommendationTitle = String(a.recommendationTitle || '');
    out.messageText = String(a.messageText || '');
    out.acceptanceText = String(a.acceptanceText || '');
    out.applyActions = (a.applyActions || []).map((p) => ({ field: lc(p.field), valueType: p.valueType || 'Value', value: p.value == null ? '' : String(p.value) }));
  }
  if (ownsLabel && a.type !== 'Recommendation') out.displayName = String(a.displayName || '');
  return out;
}

function treeProjection(root, description, labelsOwned) {
  const r = root || { logic: 'AND', clauses: [], trueBranch: [] };
  const out = {
    logic: r.logic || 'AND',
    clauses: (r.clauses || []).map(clauseProjection),
    actions: (r.trueBranch || []).map((a, i) => actionProjection(a, labelsOwned[i] === true)),
  };
  if (description !== undefined) out.description = String(description || '');
  return out;
}

// A node in a mode the spec cannot express: a literal-only spec must not overwrite a Field / Lookup /
// Expression / Parameter value it cannot represent.
const nonLiteral = (node) => node && node.valueType && node.valueType !== 'Value' && node.valueType !== 'Clear';
const isActionNode = (node) => node && typeof node.type === 'string' && !Array.isArray(node.clauses);

// The baseline is the FULL projection, whatever the spec declares today: the tree (logic, clauses and
// actions without their labels), the description and the label of every keyed action, each recorded
// as its own part. Starting or stopping to declare a description or any subset of labels then changes
// only what this run writes, never what "last applied" means, so it is an edit and not drift.
// Recommendation labels are not parts: the SDK replaces them with the title.
function ruleParts(root, description, labelsByKey) {
  const parts = { tree: treeProjection(root, undefined, []), description: String(description || '') };
  for (const [k, label] of Object.entries(labelsByKey)) parts[`label:${k}`] = label === null ? null : String(label || '');
  return parts;
}
const labelPartKeys = (rule) => (rule.actions || []).filter((a) => a.type !== 'Recommendation').map((a) => a.key);

// The tree carries the node positions the bindings hold, so it is drift-checked as a whole whenever
// anything is written: a node moved or edited outside the spec must be seen before a position is
// trusted. The label and description parts follow partsDriftVerdict (only a part this run writes
// can be in conflict).
function ruleDriftVerdict(binding, liveParts, desiredParts) {
  const verdict = partsDriftVerdict(binding, liveParts, desiredParts);
  if (verdict !== 'none' || binding.intentSha256 === projectionBaseline(liveParts).intentSha256) return verdict;
  const recorded = binding.partsSha256 || {};
  return recorded.tree === intentSha256(liveParts.tree) ? 'none' : 'drift';
}

/**
 * Plan the declared edit of an EXISTING rule (`ruleId`: the rule the build found by name, or null).
 * A binding for the key is authoritative: a different `ruleId` is rule-binding-mismatch and a null one
 * rule-bound-row-missing. With no binding and no rule, `needsCreate` tells the build to create it.
 *   plan: { key, ruleId, action: null|'noChange'|'update', needsCreate?, root, description?, nodeIndex: {nodeKey: 'clauses/i'|'trueBranch/i'},
 *           desiredSha, baseline: {intentSha256, partsSha256}, destructive, operations, refused, unknown, origin }
 */
async function planRuleReconcile({ rule, ruleId, sdk, created = false }, ctx = {}) {
  const key = ruleKey(rule);
  const plan = { key, ruleId, action: null, nodeIndex: {}, operations: [], refused: [], unknown: [], destructive: false, origin: created ? 'created' : 'adopted' };
  if (!isDeclaredRule(rule)) return plan;
  const problems = validateDeclaredRule(rule);
  if (problems.length) {
    plan.refused.push(refusal(key, 'rule-spec-invalid', problems.join('; ')));
    return plan;
  }
  // The bound rule is the authority: the rule the build found by name must be that rule, and a bound
  // rule the build no longer finds is never recreated under the bound key.
  const binding = await lookupBinding(ctx, KIND, key);
  const bound = boundIdentity(binding, { resolvedId: ruleId, code: 'rule-binding-mismatch', key });
  if (bound.refusal) {
    plan.refused.push(bound.refusal);
    return plan;
  }
  if (binding && !ruleId) {
    plan.refused.push(refusal(key, 'rule-bound-row-missing', 'the business rule this key is bound to was not found; repair the binding explicitly before it can be recreated'));
    return plan;
  }
  if (!ruleId) {
    // Nothing to edit: the build creates the rule (through the creation port) and records createdRuleBindings.
    plan.needsCreate = true;
    return plan;
  }
  let live;
  try {
    await sdk.fetchArtifact(ARTIFACT, ruleId);
    live = await sdk.getArtifact(ARTIFACT, ruleId);
  } catch (_) {
    plan.unknown.push(refusal(key, 'rule-unreadable', 'the business rule definition could not be read'));
    return plan;
  }
  const root = live.rootCondition || null;
  if (root && ((root.falseBranch || []).length || (root.trueBranch || []).some((n) => !isActionNode(n)))) {
    plan.refused.push(refusal(key, 'rule-shape-unsupported', 'the rule has an else branch or a nested condition, which declared rules do not edit'));
    return plan;
  }
  const liveClauses = (root && root.clauses) || [];
  const liveActions = (root && root.trueBranch) || [];
  // The SDK reads each later clause's AND / OR into its residual bag (`bag.connector`), and on write that
  // connector wins over `logic`. One spec-level conditionLogic cannot express a mix, so refuse it.
  if (liveClauses.slice(1).some((c) => c.bag && c.bag.connector !== undefined && c.bag.connector !== (root.logic || 'AND'))) {
    plan.refused.push(refusal(key, 'rule-shape-unsupported', 'the rule mixes AND and OR between its conditions, which one conditionLogic cannot express'));
    return plan;
  }

  // Match each declared key to a live node: the position recorded at the last build when the node there
  // is still the same kind of node, otherwise a unique node on the same field (and of the same type, for
  // an action) — what a first adoption or a re-positioned node needs.
  const bindings = {};
  for (const n of [...(rule.conditions || []), ...(rule.actions || [])]) bindings[n.key] = await lookupBinding(ctx, NODE_KIND, `${key}/${n.key}`);
  const used = { clauses: new Set(), trueBranch: new Set() };
  const match = (list, liveList, node, same) => {
    const b = bindings[node.key];
    const m = b && new RegExp(`^${list}/(\\d+)$`).exec(String(b.id));
    if (m && liveList[Number(m[1])] && !used[list].has(Number(m[1])) && same(liveList[Number(m[1])])) return Number(m[1]);
    const candidates = liveList.map((n, i) => i).filter((i) => !used[list].has(i) && same(liveList[i]));
    return candidates.length === 1 ? candidates[0] : -1;
  };
  const clauseAt = (rule.conditions || []).map((c) => {
    const i = match('clauses', liveClauses, c, (n) => lc(n.field) === lc(c.field));
    if (i >= 0) used.clauses.add(i);
    return i;
  });
  const actionAt = (rule.actions || []).map((a) => {
    const i = match('trueBranch', liveActions, a, (n) => n.type === a.type && lc(n.field) === lc(a.field));
    if (i >= 0) used.trueBranch.add(i);
    return i;
  });
  for (const [i, at] of clauseAt.entries()) if (at >= 0 && nonLiteral(liveClauses[at])) {
    plan.refused.push(refusal(key, 'rule-value-mode-unsupported', `condition ${rule.conditions[i].key} compares to a ${liveClauses[at].valueType} value, which the spec cannot express`));
  }
  for (const [i, at] of actionAt.entries()) {
    const n = at >= 0 ? liveActions[at] : null;
    if (n && (nonLiteral(n) || (n.applyActions || []).some(nonLiteral))) plan.refused.push(refusal(key, 'rule-value-mode-unsupported', `action ${rule.actions[i].key} sets a ${n.valueType || 'non-literal'} value, which the spec cannot express`));
  }
  if (plan.refused.length) return plan;

  // Live nodes no declared key claims: someone else's, or a key the spec dropped. Removing them is
  // destructive and needs the build's approval.
  const orphans = liveClauses.length - used.clauses.size + liveActions.length - used.trueBranch.size;
  plan.destructive = orphans > 0;

  // The edited tree: each declared node over its live counterpart (ids, step names, labels and bag kept).
  const clauses = (rule.conditions || []).map((c, i) => {
    const want = sdkClause(c);
    const base = clauseAt[i] >= 0 ? { ...liveClauses[clauseAt[i]] } : { id: `k_${c.key}` };
    if (VALUELESS.has(want.operator)) { delete base.value; delete base.valueWorkflowType; }
    // Keep a carried connector in step with the declared logic: left stale, it would pin the old AND / OR.
    if (base.bag && base.bag.connector !== undefined) {
      base.bag = { ...base.bag };
      if (i === 0) delete base.bag.connector;
      else base.bag.connector = rule.conditionLogic || 'AND';
    }
    return { ...base, ...want };
  });
  const trueBranch = (rule.actions || []).map((a, i) => {
    const want = sdkAction(a);
    const liveNode = actionAt[i] >= 0 ? liveActions[actionAt[i]] : null;
    if (!liveNode) return { id: `k_${a.key}`, ...want };
    const merged = { ...liveNode, ...want };
    if (!a.label) merged.displayName = liveNode.displayName;
    if (a.type === 'Recommendation') {
      merged.applyActions = want.applyActions.map((p) => {
        const old = (liveNode.applyActions || []).find((x) => lc(x.field) === p.field);
        return old ? { ...old, ...p, id: old.id } : p;
      });
    }
    return merged;
  });
  const newRoot = { ...(root || { id: 'r1', displayName: rule.name, falseBranch: [] }), logic: rule.conditionLogic || 'AND', clauses, trueBranch, falseBranch: [] };
  const labelsOwned = (rule.actions || []).map((a) => a.label !== undefined);
  // Each keyed action's label, live (null for a node not there yet) and desired (the spec's where it
  // states one, otherwise the live label kept, or the default a new node is written with).
  const liveLabelsByKey = {};
  const desiredLabelsByKey = {};
  for (const [i, a] of (rule.actions || []).entries()) {
    if (a.type === 'Recommendation') continue;
    const liveNode = actionAt[i] >= 0 ? liveActions[actionAt[i]] : null;
    liveLabelsByKey[a.key] = liveNode ? String(liveNode.displayName || '') : null;
    desiredLabelsByKey[a.key] = String(trueBranch[i].displayName || '');
  }
  const liveParts = ruleParts(root, live.description, liveLabelsByKey);
  const desiredParts = ruleParts(newRoot, rule.description !== undefined ? rule.description : live.description, desiredLabelsByKey);
  plan.baseline = projectionBaseline(desiredParts);
  plan.desiredSha = plan.baseline.intentSha256;

  if (binding) plan.origin = binding.origin === 'created' ? 'created' : 'adopted';
  const verdict = ruleDriftVerdict(binding, liveParts, desiredParts);
  const descriptionChange = rule.description !== undefined && String(live.description || '') !== String(rule.description) ? String(rule.description) : undefined;
  const sameTree = canonicalJson(treeProjection(root, undefined, labelsOwned.map(() => false))) === canonicalJson(treeProjection(newRoot, undefined, labelsOwned.map(() => false)))
    && labelPartKeys(rule).every((k) => liveLabelsByKey[k] === desiredLabelsByKey[k]) && !plan.destructive;
  const unapproved = verdict === 'unbound' && !created && !isAuthorized(ctx.authorizedAdoption, key);
  if (sameTree && descriptionChange === undefined) {
    // Nothing to write: not a refusal, but no binding either unless adoption was approved (bindsUnchanged).
    plan.action = 'noChange';
    plan.bindUnchanged = !unapproved;
    if (plan.bindUnchanged) {
      (rule.conditions || []).forEach((c, i) => { plan.nodeIndex[c.key] = `clauses/${i}`; });
      (rule.actions || []).forEach((a, i) => { plan.nodeIndex[a.key] = `trueBranch/${i}`; });
    }
    return plan;
  }
  if (unapproved) {
    plan.refused.push(refusal(key, 'rule-adoption-not-authorized', 'this rule exists and the spec has not managed it before; approve adopting it first'));
    return plan;
  }
  if (verdict === 'drift' && !isAuthorized(ctx.authorizedOverwrite, key)) {
    plan.refused.push(refusal(key, 'rule-drift', 'the rule was changed outside the spec since the last build; refresh the spec or approve the overwrite'));
    return plan;
  }
  if (plan.destructive && !isAuthorized(ctx.authorizedDestructive, key)) {
    plan.refused.push(refusal(key, 'rule-node-removal-not-authorized', `the rule holds ${orphans} condition(s) or action(s) the spec does not declare; approve removing them first`));
    return plan;
  }
  (rule.conditions || []).forEach((c, i) => { plan.nodeIndex[c.key] = `clauses/${i}`; });
  (rule.actions || []).forEach((a, i) => { plan.nodeIndex[a.key] = `trueBranch/${i}`; });
  plan.description = descriptionChange;
  plan.action = 'update';
  plan.root = sameTree ? null : newRoot;
  plan.operations.push(operation({ key, kind: KIND, target: ruleId, action: 'update', destructive: plan.destructive }));
  return plan;
}

async function applyRuleReconcile(plan, { sdk }, ctx = {}) {
  const result = emptyResult();
  result.refused.push(...plan.refused);
  result.unknown.push(...plan.unknown);
  if (plan.refused.length || plan.unknown.length || !plan.action) return result;
  const records = () => [
    bindingRecord(ctx, { kind: KIND, key: plan.key, id: plan.ruleId, intentSha256: plan.desiredSha, partsSha256: plan.baseline && plan.baseline.partsSha256, origin: plan.origin }),
    ...Object.entries(plan.nodeIndex).map(([nodeKey, at]) => bindingRecord(ctx, { kind: NODE_KIND, key: `${plan.key}/${nodeKey}`, id: at, parentKey: plan.key, intentSha256: plan.desiredSha, origin: plan.origin })),
  ];
  if (plan.action === 'noChange') {
    result.unchanged.push({ key: plan.key, kind: KIND, id: plan.ruleId });
    if (plan.bindUnchanged) result.managedBindings.push(...records());
    return result;
  }
  try {
    if (plan.root) await sdk.updateElement(ARTIFACT, plan.ruleId, '/rootCondition', plan.root);
    if (plan.description !== undefined) await sdk.updateElement(ARTIFACT, plan.ruleId, '/description', plan.description);
  } catch (err) {
    result.refused.push({ ...refusal(plan.key, 'rule-rejected', 'the SDK refused the rule before writing it'), rules: rulesOf(err) });
    return result;
  }
  // The SDK runs the designer's completeness validator inside the push: an incomplete rule is a
  // pre-write refusal (VALIDATION_ERROR), anything else that fails is an unknown outcome.
  const pushed = await pushIfChanged(sdk, ARTIFACT, plan.ruleId);
  if (pushed.outcome === 'refused') {
    result.refused.push({ ...refusal(plan.key, 'rule-rejected', 'the rule was not saved'), rules: pushed.rules || [] });
    return result;
  }
  if (pushed.outcome === 'unknown') {
    result.unknown.push(refusal(plan.key, 'rule-write-unknown', 'the rule write did not report its outcome; check the rule'));
    return result;
  }
  // A business rule needs no PublishXml: the update reactivates the definition it found active.
  result.saved.push({ key: plan.key, kind: KIND, id: plan.ruleId });
  result.managedBindings.push(...records());
  return result;
}

/**
 * The bindings for a rule this build has just created from ruleRootCondition (through the creation
 * port), so the next build edits it. The baseline is the full projection the create wrote.
 */
function createdRuleBindings(rule, ruleId, ctx = {}) {
  const key = ruleKey(rule);
  const root = ruleRootCondition(rule);
  const labels = {};
  for (const [i, a] of (rule.actions || []).entries()) if (a.type !== 'Recommendation') labels[a.key] = String(root.trueBranch[i].displayName || '');
  const baseline = projectionBaseline(ruleParts(root, rule.description, labels));
  const sha = baseline.intentSha256;
  return [
    bindingRecord(ctx, { kind: KIND, key, id: ruleId, intentSha256: sha, partsSha256: baseline.partsSha256, origin: 'created' }),
    ...(rule.conditions || []).map((c, i) => bindingRecord(ctx, { kind: NODE_KIND, key: `${key}/${c.key}`, id: `clauses/${i}`, parentKey: key, intentSha256: sha, origin: 'created' })),
    ...(rule.actions || []).map((a, i) => bindingRecord(ctx, { kind: NODE_KIND, key: `${key}/${a.key}`, id: `trueBranch/${i}`, parentKey: key, intentSha256: sha, origin: 'created' })),
  ];
}

module.exports = {
  isDeclaredRule,
  ruleKey,
  validateDeclaredRule,
  ruleRootCondition,
  compileRuleIntent: ruleRootCondition,
  planRuleReconcile,
  applyRuleReconcile,
  createdRuleBindings,
  ACTION_TYPES,
};
