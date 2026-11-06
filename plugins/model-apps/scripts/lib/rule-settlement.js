'use strict';
// Declared business rules (`businessRules[].reconcile: "declared"`) on the managed settlement layer: one workflow row is
// the unit this plugin owns, never a node inside it.
//
// OWNERSHIP. A rule is one `workflows` row whose condition tree is a WFOM document. Nothing inside it is a row, and a
// fresh read gives every clause a new random id, so no node can be told apart by anything the server keeps for it. A
// rule is therefore managed WHOLE: one binding, kind `business-rule`, whose id is the workflow GUID the SDK keeps
// (CreateProcessWithWfomJson carries it as Entity.workflowid). The group's consumer state records the declaration and
// a slot map (node key -> position, `clauses/<i>`, `trueBranch/<i>`, `trueBranch/<i>/applyActions/<j>`); a slot is
// trusted only while the live rule still equals the committed baseline, which the proof records as the hash of the
// whole projection. Content is never evidence of ownership: a live rule that differs from the baseline is `rule-drift`
// before any request that could change it, whatever the declaration says, and only a complete read-only re-adoption
// (`adopt:rule:<table>/<name>`, whose declaration names the whole current body in order) records it again.
//
// CREATE AND EDIT (the existing-workflow edit gate). By default a new declared rule is created Draft (one
// CreateProcessWithWfomJson, no state change, so the SDK has nothing to roll back and never sends a DELETE), proved
// by a fresh read, and then activated with the state-only path (`updateRecord` -> one PATCH workflows(<id>)) when the
// declaration asks for Active. Every such write runs inside `withWorkflowEffect` with its persisted effect record, so a
// write whose answer is lost is proved by reading the row and is never sent again. An edit of the body or the state
// of a rule that already exists (its scope included) refuses before any workflow request with `workflow-edit-refused`
// unless `opts.workflowConditionalEdits` is on: a local lock cannot stop another session changing the row between the
// read and the write. The same gate holds on every recovery path: a re-run may prove by reading that an earlier write
// landed, but it sends nothing to an existing row with the switch off. With the switch on, every write carries the row
// version of the read that proved it (If-Match), a stale-version refusal is reported as `rule-drift` and is not
// retried, an Active rule's body is edited as three separate effects (Draft, body, Active), each conditioned on the
// version its own proof read returned, and a state-only change is ONE conditional state write with no body.
//
// WHAT A RE-RUN MAY DO. Only the exact unresolved create of an attempt (its effect `create`, the group uncommitted,
// no row bound) continues as a create; an absent row is never permission to create again, and a missing adopted rule
// stops. A write whose answer was lost, or that was answered with a generic 4xx/5xx, is `unconfirmed`: an answer is not
// proof that nothing started, so it is proved by reading and never sent again. A create that no 2xx acknowledged is not
// known to be this build's: it is activated and bound only with the rule's typed adoption approval
// (`managed-adoption-required`, the attempt kept). The SDK's local copy of the rule is checked first on every path: a
// copy with edits that never reached the server stops everything (`create-completion-required`, category
// `workspace-copy-unsent-edits`) before any fetch could overwrite it.
//
// AVAILABILITY. An environment that cannot host business rules answers the first create with the documented refusal
// (the member is missing, or HTTP 400 0x80040216 to a first send). Only that answer to a CREATE, confirmed by a fresh
// read that finds no row, skips the rule: `{ skipped: 'unavailable' }`, nothing bound. The caller decides that this
// is the first rule of its build. An update, an unknown create, or a failed activation is never a skip.
//
// Nothing here publishes: a business rule has no PublishXml scope (its activation is the state change above).

const { canonicalJson, intentSha256, normalizeGuid, isApproved } = require('./reconcile-common.js');
const { runManagedFeature } = require('./managed-feature-contract.js');
const { requestBodySha256 } = require('./workflow-effect-context.js');
const { identityFor } = require('./creates-catalog.js');
const { CODES, rootCreateAcknowledged } = require('./managed-bindings.js');
const { HTTP_SEND_HISTORY } = require('./sdk-http-client.js');
const { createWorkflowDriver, createCopyGuard, answeredRefusal, causeChain, leavesOutcomeOpen, coded, completionBytesFor, completionWithin, HASH_BOUND, ACTIVE, DRAFT } = require('./workflow-drive.js');

// sdk-build is required lazily: it is the module that will call this one, so a top-level require would be a cycle.
const { markFreshTable, isFreshTableReadLag } = require('./retry-policy.js');
const sdkBuild = () => require('./sdk-build.js');

// ---------------------------------------------------------------------------------------------------------------
// The declaration: its shape, its compiler (compileRuleIntent; sdk-build's businessRuleDef, kept for undeclared rules, compiles a
// legacy rule the same way) and the node projection.

const KEY_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const LOGICS = ['AND', 'OR'];
// The payload field of each legacy action, and the closed key set of every action shape.
const ACTION_KEYS = {
  SetVisibility: ['visible'],
  LockUnlock: ['lock'],
  SetBusinessRequired: ['required'],
  SetFieldValue: ['value', 'dataType'],
  SetDefaultValue: ['value', 'dataType'],
  ShowErrorMessage: ['errorMessage'],
  Recommendation: ['recommendationTitle', 'messageText', 'acceptanceText', 'applyActions'],
};
const ACTION_TYPES = Object.keys(ACTION_KEYS);
const NEW_ACTION_TYPES = ['SetDefaultValue', 'ShowErrorMessage', 'Recommendation'];
const CONDITION_KEYS = ['key', 'field', 'operator', 'value', 'dataType'];
const APPLY_ACTION_KEYS = ['key', 'field', 'value', 'dataType'];

// `valueWorkflowType` in SDK terms: the platform's WorkflowAttributeType as a numeric string. Moved here from
// sdk-build so the one compiler owns it. A condition literal keeps the type it is sent with (measured: an
// Integer comparison reads back '5'); an action literal reads back String ('14') whatever is sent, so it is sent
// for symmetry and never compared.
const WORKFLOW_ATTRIBUTE_TYPE = {
  boolean: '0', customer: '1', datetime: '2', decimal: '3', float: '4', double: '4', integer: '5',
  lookup: '6', money: '7', owner: '8', partylist: '9', picklist: '10', key: '11', state: '12',
  status: '13', string: '14', memo: '14', uniqueidentifier: '15', entitynamereference: '16',
  entity: '17', entitycollection: '18', multiselectpicklist: '23',
};
// Unknown tokens fall back to String rather than being forwarded. The spec gate already restricts `dataType` to
// BUSINESS_RULE_DATA_TYPES, so this is unreachable from a valid spec; forwarding an unmapped token would reopen
// exactly the out-of-domain write this mapping exists to close.
function workflowAttributeType(dataType) {
  return WORKFLOW_ATTRIBUTE_TYPE[String(dataType || 'String').toLowerCase()] || '14';
}

// app-spec.js is required lazily: sdk-build requires this module, and app-spec may come to require it for the
// shape checks, so a top-level require would be a cycle.
const appSpec = () => require('./app-spec.js');
const isValueless = (op) => appSpec().BUSINESS_RULE_VALUELESS_OPERATORS.has(op);
const lc = (v) => String(v == null ? '' : v).toLowerCase();
const isNotFound = (err) => !!err && (err.statusCode === 404 || err.status === 404 || (err.cause && (err.cause.statusCode === 404 || err.cause.status === 404)));
// A literal the platform can hold as a `Value` operand. An object, array or null is refused rather than coerced
// (String({}) is "[object Object]").
const isLiteral = (v) => typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));

function isDeclaredRule(rule) {
  return !!rule && rule.reconcile === 'declared';
}

function ruleKey(rule) {
  return rule && rule.key ? String(rule.key) : `${lc(rule && rule.entity)}/${String((rule && rule.name) || '')}`;
}

/** One compiled action node. Legacy shapes compile byte-identically to the earlier businessRuleDef. */
function compileAction(a, id) {
  const node = { id, type: a.type, displayName: a.label || `${a.type} ${a.field}`, field: lc(a.field) };
  if (a.type === 'SetVisibility') node.visible = a.visible;
  else if (a.type === 'LockUnlock') node.lock = a.lock;
  else if (a.type === 'SetBusinessRequired') node.required = a.required;
  else if (a.type === 'SetFieldValue' || a.type === 'SetDefaultValue') { node.value = String(a.value); node.valueType = 'Value'; node.valueWorkflowType = workflowAttributeType(a.dataType); }
  else if (a.type === 'ShowErrorMessage') node.errorMessage = a.errorMessage;
  else if (a.type === 'Recommendation') {
    // The SDK replaces a recommendation's displayName with its title, so the title is what is sent (validation
    // refuses a label that differs from it rather than promising a label that would not persist).
    node.displayName = a.recommendationTitle;
    node.recommendationTitle = a.recommendationTitle;
    node.messageText = a.messageText;
    if (a.acceptanceText !== undefined) node.acceptanceText = a.acceptanceText;
    node.applyActions = (a.applyActions || []).map((p, j) => compileApplyAction(p, `p${j + 1}`));
  }
  return node;
}

function compileApplyAction(p, id) {
  return { id, field: lc(p.field), valueType: 'Value', value: String(p.value), valueWorkflowType: workflowAttributeType(p.dataType) };
}

function compileClause(c, id) {
  return {
    id,
    field: lc(c.field),
    operator: c.operator,
    valueType: 'Value',
    ...(isValueless(c.operator) ? {} : { value: String(c.value), valueWorkflowType: workflowAttributeType(c.dataType) }),
  };
}

/**
 * The SDK business-rule definition of ONE App Spec rule, as a declared rule is created and proved. sdk-build keeps
 * its own businessRuleDef for undeclared rules (it does not load this module, so a legacy build never loads the
 * creation catalog); the two compile a legacy rule to the same definition. Takes the rule alone - never (spec, rule).
 */
function compileRuleIntent(rule) {
  const ids = (prefix) => { let n = 0; return () => `${prefix}${++n}`; };
  const clauseId = ids('c');
  const actionId = ids('a');
  return {
    name: rule.name,
    entityLogicalName: lc(rule.entity),
    scope: rule.scope || 'Entity',
    // Omitted when the spec has none, so a rebuild never blanks one added in the maker.
    ...(rule.description ? { description: rule.description } : {}),
    // Active unless the author asks for Draft. A rule is inert until activated, so defaulting to Active is what
    // makes `businessRules[]` do something on the first build.
    status: rule.status || 'Active',
    rootCondition: {
      id: 'r1',
      displayName: rule.name,
      logic: rule.conditionLogic || 'AND',
      clauses: (rule.conditions || []).map((c) => compileClause(c, clauseId())),
      trueBranch: (rule.actions || []).map((a) => compileAction(a, actionId())),
      falseBranch: [],
    },
  };
}

/**
 * Shape errors of one rule that the general spec gate does not cover: the declared opt-in, conditionLogic, node
 * keys, the closed key sets and payloads of every action shape (the three newer shapes always, the legacy ones
 * in declared mode), literal-only values and recommendation apply-actions. `checkField(field, what)`, when given,
 * is called for every nested apply-action field (the caller already checks top-level fields).
 * @returns {string[]}
 */
function ruleShapeErrors(rule, { checkField } = {}) {
  const errors = [];
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return errors;
  const label = `business rule '${rule.name || '(unnamed)'}'`;
  const declared = rule.reconcile === 'declared';
  if (rule.reconcile !== undefined && rule.reconcile !== 'declared') errors.push(`${label}: reconcile must be "declared" when present`);
  if (rule.conditionLogic !== undefined && !LOGICS.includes(rule.conditionLogic)) errors.push(`${label}: conditionLogic must be AND|OR`);
  if (rule.key !== undefined && (typeof rule.key !== 'string' || !KEY_RE.test(rule.key))) errors.push(`${label}: key must match ${KEY_RE}`);
  const seen = new Set();
  const checkKey = (node, what) => {
    if (node.key === undefined) {
      if (declared) errors.push(`${label}: ${what} needs a key (reconcile: "declared")`);
      return;
    }
    if (typeof node.key !== 'string' || !KEY_RE.test(node.key)) { errors.push(`${label}: ${what} key must match ${KEY_RE}`); return; }
    if (seen.has(node.key)) errors.push(`${label}: key '${node.key}' is used twice (keys are unique across conditions, actions and apply-actions)`);
    seen.add(node.key);
  };
  const closed = (node, allowed, what) => {
    for (const k of Object.keys(node)) if (!allowed.includes(k)) errors.push(`${label}: ${what} does not take '${k}'`);
  };
  const dataTypeOk = (node, what) => {
    if (node.dataType !== undefined && !appSpec().BUSINESS_RULE_DATA_TYPES.includes(node.dataType)) errors.push(`${label}: ${what} dataType must be one of ${appSpec().BUSINESS_RULE_DATA_TYPES.join('|')}`);
  };
  const literal = (v, what) => { if (!isLiteral(v)) errors.push(`${label}: ${what} must be a literal string, number or boolean`); };
  const nonEmptyText = (v, what) => { if (typeof v !== 'string' || !v.trim()) errors.push(`${label}: ${what} must be a non-empty string`); };

  (Array.isArray(rule.conditions) ? rule.conditions : []).forEach((c, i) => {
    if (!c || typeof c !== 'object' || Array.isArray(c)) return;
    const what = `condition ${i + 1}`;
    checkKey(c, what);
    if (declared) closed(c, CONDITION_KEYS, what);
    if (c.value !== undefined && c.value !== null && c.value !== '') literal(c.value, `${what} value`);
  });
  (Array.isArray(rule.actions) ? rule.actions : []).forEach((a, i) => {
    if (!a || typeof a !== 'object' || Array.isArray(a)) return;
    const what = `action ${i + 1} (${a.type})`;
    if (!ACTION_TYPES.includes(a.type)) { errors.push(`${label}: action type must be one of ${ACTION_TYPES.join('|')}`); return; }
    checkKey(a, what);
    if (declared || NEW_ACTION_TYPES.includes(a.type)) closed(a, ['key', 'type', 'field', 'label', ...ACTION_KEYS[a.type]], what);
    if (a.type === 'SetFieldValue' && a.value !== undefined) literal(a.value, `${what} value`);
    if (a.type === 'SetDefaultValue') {
      if (a.value === undefined) errors.push(`${label}: ${what} needs 'value'`);
      else literal(a.value, `${what} value`);
      dataTypeOk(a, what);
    }
    if (a.type === 'ShowErrorMessage') nonEmptyText(a.errorMessage, `${what} errorMessage`);
    if (a.type === 'Recommendation') {
      nonEmptyText(a.recommendationTitle, `${what} recommendationTitle`);
      nonEmptyText(a.messageText, `${what} messageText`);
      if (a.acceptanceText !== undefined && typeof a.acceptanceText !== 'string') errors.push(`${label}: ${what} acceptanceText must be a string`);
      // Measured: the SDK stores a recommendation's title as its display name, so a different label could not persist.
      if (a.label !== undefined && a.label !== a.recommendationTitle) errors.push(`${label}: ${what} label must equal recommendationTitle (the platform shows the title as the action's name)`);
      if (!Array.isArray(a.applyActions) || !a.applyActions.length) {
        errors.push(`${label}: ${what} needs a non-empty applyActions[]`);
      } else {
        a.applyActions.forEach((p, j) => {
          const pw = `${what} applyActions ${j + 1}`;
          if (!p || typeof p !== 'object' || Array.isArray(p)) { errors.push(`${label}: ${pw} must be an object`); return; }
          checkKey(p, pw);
          closed(p, APPLY_ACTION_KEYS, pw);
          if (typeof p.field !== 'string' || !p.field) errors.push(`${label}: ${pw} needs a field`);
          else if (typeof checkField === 'function') checkField(p.field, pw);
          if (p.value === undefined) errors.push(`${label}: ${pw} needs 'value'`);
          else literal(p.value, `${pw} value`);
          dataTypeOk(p, pw);
        });
      }
    }
  });
  return errors;
}

// Never compared: per-read random ids, parser bags, display metadata the platform derives from the column, label
// containers whose ids are random, the random recommendation step metadata, the nested apply-actions (each is a node
// of its own), and step names.
//
// A step name is the WFOM step's `name`, which the platform renames on save. The SDK numbers the steps it sends from
// one counter across the whole tree; the platform stores each step as `Step_<its 1-based position among its
// siblings>`. Measured on a rule with one condition and one action (WfomJson, sent -> read back):
//   WorkflowStep "Step_0" > ConditionStep "Step_1" > ConditionBranchStep "Step_2" > SetVisibilityStep "Step_3"
//   WorkflowStep "Step_0" > ConditionStep "Step_1" > ConditionBranchStep "Step_1" > SetVisibilityStep "Step_1"
// so the action reads back `stepName: 'Step_1'` where the build sent 'Step_3', and a compared name would make every
// created rule fail its own proof. Nothing is lost by dropping it: no declaration states a step name, the platform
// derives it from the node's position, and the position of every node is already compared (the projection's lists
// keep their order).
const VOLATILE = new Set(['id', 'kind', 'bag', 'fieldDisplayName', 'stepLabels', 'stepName', 'recommendationActionStepMeta', 'applyActions']);

function semOf(list, node) {
  const out = {};
  for (const k of Object.keys(node || {}).sort()) {
    if (VOLATILE.has(k)) continue;
    // An action literal reads back as String whatever type was sent; comparing it would be a permanent edit.
    if (list !== 'clauses' && k === 'valueWorkflowType') continue;
    out[k] = node[k];
  }
  if ('field' in out) out.field = lc(out.field);
  if (list === 'clauses' && isValueless(out.operator)) { delete out.value; delete out.valueWorkflowType; }
  return out;
}

/** Parse a locator into its steps; null when it is not one this module writes. */
function parseLocator(locator) {
  const m = /^(clauses|trueBranch)\/(\d+)(?:\/applyActions\/(\d+))?$/.exec(String(locator || ''));
  if (!m || (m[1] === 'clauses' && m[3] !== undefined)) return null;
  return { list: m[3] !== undefined ? 'applyActions' : m[1], index: Number(m[2]), nested: m[3] !== undefined ? Number(m[3]) : null };
}

function nodeAt(root, locator) {
  const p = parseLocator(locator);
  if (!p) return null;
  const top = (root[p.list === 'applyActions' ? 'trueBranch' : p.list] || [])[p.index];
  if (p.nested === null) return top || null;
  return (top && Array.isArray(top.applyActions) && top.applyActions[p.nested]) || null;
}

/** The rule as this module can manage it, or `{ unsupported }` naming the shape it cannot express. */
function observeRule(art) {
  const root = art && art.rootCondition;
  if (!root || !Array.isArray(root.clauses) || !Array.isArray(root.trueBranch)) return { unsupported: 'the rule has no readable condition tree' };
  if (Array.isArray(root.falseBranch) && root.falseBranch.length) return { unsupported: 'the rule has an else branch' };
  const nested = (n) => !n || typeof n !== 'object' || (n.kind && n.kind !== 'action' && n.kind !== 'clause') || Array.isArray(n.clauses) || Array.isArray(n.trueBranch);
  if (root.clauses.some(nested) || root.trueBranch.some(nested)) return { unsupported: 'the rule has a nested condition' };
  const logic = LOGICS.includes(root.logic) ? root.logic : 'AND';
  // Read-back shape: every clause after the first carries `bag.connector` ('AND'|'OR'). One that differs from the
  // others is a mixed expression a single conditionLogic cannot state.
  const connectors = root.clauses.slice(1).map((c) => c && c.bag && c.bag.connector).filter(Boolean);
  if (connectors.some((c) => c !== logic)) return { unsupported: 'the rule mixes AND and OR between its conditions' };
  return { root, logic, description: art.description == null ? '' : String(art.description), status: art.status || null, entity: lc(art.entityLogicalName) };
}
/** Every semantic property the spec declares for a node, in the projection semOf compares. */
function declaredProps(list, d) {
  if (list === 'clauses') {
    const c = compileClause(d, null);
    delete c.id;
    return c;
  }
  if (list === 'applyActions') return { field: lc(d.field), valueType: 'Value', value: String(d.value) };
  const node = compileAction(d, null);
  delete node.id;
  delete node.applyActions;
  delete node.valueWorkflowType;
  // An omitted label keeps the live display name (only a recommendation's is its title).
  if (d.label === undefined && d.type !== 'Recommendation') delete node.displayName;
  return node;
}

function matchesDeclared(list, live, d) {
  const sem = semOf(list, live);
  const props = declaredProps(list, d);
  return Object.keys(props).every((k) => canonicalJson(sem[k] === undefined ? null : sem[k]) === canonicalJson(props[k]));
}

/** The live node with the declared properties laid over it; everything else the node carries is kept. */
function overlay(list, live, d) {
  const out = { ...JSON.parse(JSON.stringify(live)), ...declaredProps(list, d) };
  if (list === 'clauses' && isValueless(d.operator)) delete out.value;
  if (list === 'applyActions' || d.type === 'SetFieldValue' || d.type === 'SetDefaultValue') out.valueWorkflowType = workflowAttributeType(d.dataType);
  return out;
}

function declaredNodes(rule) {
  const out = [];
  (rule.conditions || []).forEach((c) => out.push({ nodeKey: c.key, list: 'clauses', decl: c, parent: null }));
  (rule.actions || []).forEach((a) => {
    const entry = { nodeKey: a.key, list: 'trueBranch', decl: a, parent: null };
    out.push(entry);
    if (a.type === 'Recommendation') (a.applyActions || []).forEach((p, j) => out.push({ nodeKey: p.key, list: 'applyActions', decl: p, parent: entry, position: j }));
  });
  return out;
}

/** Every reason this declared rule cannot be settled, before any request: its shape. [] when it can. */
const RULE_SCOPES = ['Entity', 'AllForms'];
function validateDeclaredRule(rule, opts) {
  if (!isDeclaredRule(rule)) return ['the rule is not declared (reconcile: "declared")'];
  const errors = ruleShapeErrors(rule, opts);
  // The scopes this helper stages and proves: the table (Entity) and all forms (AllForms). A single-form scope needs a
  // form id this declaration cannot name, so it is refused rather than half-written.
  if (rule.scope !== undefined && !RULE_SCOPES.includes(rule.scope)) errors.push(`business rule '${rule.name || '(unnamed)'}': scope must be one of ${RULE_SCOPES.join('|')}`);
  return errors;
}

// ---------------------------------------------------------------------------------------------------------------
// The managed rule: its projection, its slot map and its proof.

const FAMILY = 'rule';
const ROOT_KIND = 'business-rule';
const ARTIFACT = 'businessRule';
const PROOF_SCHEMA = 'business-rule/declared-1';
const EDIT_REFUSED_REMEDY = 'A declared rule can be created and adopted read-only; editing one that already exists stays off until '
  + 'conditional writes are enabled, because a local lock cannot stop another session changing the rule between the read and the write. '
  + 'Change the rule in the maker, then re-adopt it with a declaration that names its whole body.';
const SKIP = Symbol('rule-settlement.skip');
const BUSINESS_RULE_MEMBER = 'Microsoft.Dynamics.CRM.CreateProcessWithWfomJson';
const SWITCHED_OFF_CODE = '0x80040216';

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const tableOf = (rule) => lc(rule && rule.entity);
const approvalIdOf = (rule) => `${tableOf(rule)}/${String((rule && rule.name) || '')}`;

/**
 * The rule as this module compares it: everything the platform keeps that the spec can state, without the per-read
 * ids, bags and labels semOf drops. The status is kept apart (`savedShaOf`) because a state change is its own write.
 */
function projectRule(art) {
  const obs = observeRule(art);
  if (obs.unsupported) return { unsupported: obs.unsupported };
  const projection = {
    name: String(art.name == null ? '' : art.name),
    entity: obs.entity,
    scope: art.scope || 'Entity',
    description: obs.description,
    logic: obs.logic,
    clauses: obs.root.clauses.map((c) => semOf('clauses', c)),
    trueBranch: obs.root.trueBranch.map((a) => {
      const out = semOf('trueBranch', a);
      if (Array.isArray(a.applyActions)) out.applyActions = a.applyActions.map((p) => semOf('applyActions', p));
      return out;
    }),
  };
  return { root: obs.root, projection, status: obs.status === ACTIVE ? ACTIVE : DRAFT };
}

const savedShaOf = (projection, status) => intentSha256({ projection, status });

/** The slots of a declaration laid out in its own order: a create, or a complete adoption. */
function positionalSlots(rule) {
  const slots = {};
  (rule.conditions || []).forEach((c, i) => { slots[c.key] = `clauses/${i}`; });
  (rule.actions || []).forEach((a, i) => {
    slots[a.key] = `trueBranch/${i}`;
    if (a.type === 'Recommendation') (a.applyActions || []).forEach((p, j) => { slots[p.key] = `trueBranch/${i}/applyActions/${j}`; });
  });
  return slots;
}

/** The hash of every live node no slot claims, with where it is: what an edit must leave as it found it. */
function preservationOf(root, slots) {
  const claimed = new Set(Object.values(slots));
  const kept = [];
  root.clauses.forEach((c, i) => { if (!claimed.has(`clauses/${i}`)) kept.push({ at: `clauses/${i}`, node: semOf('clauses', c) }); });
  root.trueBranch.forEach((a, i) => {
    if (!claimed.has(`trueBranch/${i}`)) kept.push({ at: `trueBranch/${i}`, node: semOf('trueBranch', a) });
    (Array.isArray(a.applyActions) ? a.applyActions : []).forEach((p, j) => {
      const at = `trueBranch/${i}/applyActions/${j}`;
      if (!claimed.has(at)) kept.push({ at, node: semOf('applyActions', p) });
    });
  });
  return intentSha256(kept);
}

/**
 * What the group remembers of the declarations it has applied: the latest rule, and every node key it has ever
 * declared with that node's declaration. A key the spec stops declaring keeps its entry (omission is not deletion),
 * so declaring it again unchanged is not an edit.
 */
function declarationState(prev, rule) {
  const nodes = { ...((prev && prev.nodes) || {}) };
  for (const n of declaredNodes(rule)) nodes[n.nodeKey] = nodeDeclaration(n);
  return { rule: clone(rule), nodes };
}

function nodeDeclaration(n) {
  const { applyActions, ...decl } = n.decl;
  return { list: n.list, parent: n.parent ? n.parent.nodeKey : null, decl };
}

/**
 * Why the declaration changes the body or state of the rule the group holds; [] when it does not. A new key, a
 * changed node, a moved node, and a changed description, logic, scope or status are edits; an omitted key, an
 * omitted description and an omitted conditionLogic are not.
 */
function editsOf(prev, rule) {
  if (!prev || !prev.rule || !prev.nodes) return ['the group records no declaration'];
  const out = [];
  for (const n of declaredNodes(rule)) {
    const before = prev.nodes[n.nodeKey];
    if (!before) out.push(`adds '${n.nodeKey}'`);
    else if (canonicalJson(before) !== canonicalJson(nodeDeclaration(n))) out.push(`changes '${n.nodeKey}'`);
  }
  const p = prev.rule;
  if (rule.description !== undefined && rule.description !== p.description) out.push('changes the description');
  if (rule.conditionLogic !== undefined && rule.conditionLogic !== p.conditionLogic) out.push('changes the condition logic');
  if ((rule.scope || 'Entity') !== (p.scope || 'Entity')) out.push('changes the scope');
  if ((rule.status || ACTIVE) !== (p.status || ACTIVE)) out.push('changes the status');
  return out;
}

/** Why the declaration does not name the whole live rule, in order; [] when it does (a complete adoption). */
function wholeBodyErrors(rule, view) {
  const { root } = view;
  const errs = [];
  const conds = rule.conditions || [];
  const acts = rule.actions || [];
  if (conds.length !== root.clauses.length) errs.push(`it declares ${conds.length} condition(s) and the rule has ${root.clauses.length}`);
  else conds.forEach((c, i) => { if (!matchesDeclared('clauses', root.clauses[i], c)) errs.push(`condition '${c.key}' is not the rule's condition ${i + 1}`); });
  if (acts.length !== root.trueBranch.length) errs.push(`it declares ${acts.length} action(s) and the rule has ${root.trueBranch.length}`);
  else {
    acts.forEach((a, i) => {
      const live = root.trueBranch[i];
      if (live.type !== a.type || !matchesDeclared('trueBranch', live, a)) { errs.push(`action '${a.key}' is not the rule's action ${i + 1}`); return; }
      const lp = Array.isArray(live.applyActions) ? live.applyActions : [];
      const dp = a.type === 'Recommendation' ? a.applyActions || [] : [];
      if (lp.length !== dp.length) errs.push(`action '${a.key}' declares ${dp.length} apply-action(s) and the rule's has ${lp.length}`);
      else dp.forEach((p, j) => { if (!matchesDeclared('applyActions', lp[j], p)) errs.push(`apply-action '${p.key}' is not apply-action ${j + 1} of '${a.key}'`); });
    });
  }
  if (rule.conditionLogic !== undefined && rule.conditionLogic !== view.projection.logic) errs.push(`it declares ${rule.conditionLogic} and the rule joins its conditions with ${view.projection.logic}`);
  if (rule.description !== undefined && String(rule.description) !== view.projection.description) errs.push('its description is not the rule\'s');
  if ((rule.scope || 'Entity') !== view.projection.scope) errs.push(`it declares scope ${rule.scope || 'Entity (the default)'} and the rule's is ${view.projection.scope}`);
  if ((rule.status || ACTIVE) !== view.status) errs.push(`it declares status ${rule.status || `${ACTIVE} (the default)`} and the rule is ${view.status}`);
  return errs;
}

/** Replace the node at `locator` (a parsed, existing position) with `node`. */
function replaceAt(root, locator, node) {
  const p = parseLocator(locator);
  const list = root[p.list === 'applyActions' ? 'trueBranch' : p.list];
  if (p.nested === null) list[p.index] = node;
  else list[p.index].applyActions[p.nested] = node;
}

/**
 * The edited tree: a clone of the live tree with each declared node laid over the node its slot names, and each new
 * key appended to the end of its list (a new apply-action under its parent's slot). `base` gives the length of each
 * list BEFORE the edit; the new slots follow from it, so a recovery can lay the same slots out from the edited tree.
 * A slot that names no node, a node of another list or another action type, or an apply-action under another parent
 * is `rule-key-map-stale`.
 */
function layoutEdit(liveRoot, slotsBefore, rule, base) {
  const root = clone(liveRoot);
  const slots = { ...slotsBefore };
  const lengths = { clauses: base.clauses, trueBranch: base.trueBranch, apply: { ...base.apply } };
  const fresh = new Set();
  for (const n of declaredNodes(rule)) {
    if (fresh.has(n.nodeKey)) continue;
    const at = slots[n.nodeKey];
    if (at) {
      const p = parseLocator(at);
      const node = p && nodeAt(root, at);
      const parentAt = n.parent ? slots[n.parent.nodeKey] : null;
      if (!node || p.list !== n.list || (n.list === 'trueBranch' && node.type !== n.decl.type)
        || (n.list === 'applyActions' && at.replace(/\/applyActions\/\d+$/, '') !== parentAt)) {
        throw coded('rule-key-map-stale', `the slot of '${n.nodeKey}' (${at}) no longer names that ${n.list === 'clauses' ? 'condition' : 'action'}; re-adopt the rule with a declaration that names its whole body`);
      }
      replaceAt(root, at, overlay(n.list, node, n.decl));
      continue;
    }
    if (n.list === 'clauses') {
      root.clauses.push(compileClause(n.decl, `c${lengths.clauses + 1}`));
      slots[n.nodeKey] = `clauses/${lengths.clauses}`;
      lengths.clauses += 1;
    } else if (n.list === 'trueBranch') {
      const node = compileAction(n.decl, `a${lengths.trueBranch + 1}`);
      root.trueBranch.push(node);
      const at2 = `trueBranch/${lengths.trueBranch}`;
      slots[n.nodeKey] = at2;
      // A new recommendation brings its apply-actions with it, in declaration order.
      if (n.decl.type === 'Recommendation') (n.decl.applyActions || []).forEach((p, j) => { slots[p.key] = `${at2}/applyActions/${j}`; fresh.add(p.key); });
      lengths.trueBranch += 1;
    } else {
      const parentAt = slots[n.parent.nodeKey];
      const parent = parentAt && nodeAt(root, parentAt);
      if (!parent || !Array.isArray(parent.applyActions)) throw coded('rule-key-map-stale', `the recommendation '${n.parent.nodeKey}' of '${n.nodeKey}' is not where its slot says`);
      const count = lengths.apply[parentAt] !== undefined ? lengths.apply[parentAt] : parent.applyActions.length;
      parent.applyActions.push(compileApplyAction(n.decl, `p${count + 1}`));
      slots[n.nodeKey] = `${parentAt}/applyActions/${count}`;
      lengths.apply[parentAt] = count + 1;
    }
  }
  if (rule.conditionLogic !== undefined) root.logic = rule.conditionLogic;
  return { root, slots };
}

/** The list lengths of a tree, before any edit (what layoutEdit appends after). */
function lengthsOf(root) {
  const apply = {};
  root.trueBranch.forEach((a, i) => { if (Array.isArray(a.applyActions)) apply[`trueBranch/${i}`] = a.applyActions.length; });
  return { clauses: root.clauses.length, trueBranch: root.trueBranch.length, apply };
}

/** The lengths an edited tree had before the edit: what is appended for keys the old slot map lacks is taken off. */
function lengthsBefore(editedRoot, slotsBefore, rule) {
  const len = lengthsOf(editedRoot);
  const newParents = new Set();
  for (const n of declaredNodes(rule)) {
    if (slotsBefore[n.nodeKey]) continue;
    if (n.list === 'clauses') len.clauses -= 1;
    else if (n.list === 'trueBranch') { len.trueBranch -= 1; newParents.add(n.nodeKey); }
    else if (!newParents.has(n.parent.nodeKey)) {
      const at = slotsBefore[n.parent.nodeKey];
      if (at && len.apply[at] !== undefined) len.apply[at] -= 1;
    }
  }
  return len;
}

// ---------------------------------------------------------------------------------------------------------------
// The availability answers. Ported from sdk-build (isConfirmedBusinessRuleRefusal, isBusinessRuleMemberUrl), which
// does not export them; the comments there explain each condition. The SDK throws the answer as
//   Error 'HTTP 400 from <url>: …' { code: 'CONNECTION_ERROR', statusCode: 400, url, cause: <the response body> }
// and the plugin's client marks that body with HTTP_SEND_HISTORY ({ sends, earlierAmbiguous }).

function isBusinessRuleMemberUrl(url) {
  let pathname;
  try { pathname = new URL(String(url), 'https://placeholder.invalid').pathname; } catch { return false; }
  return pathname.endsWith(`/${BUSINESS_RULE_MEMBER}`);
}

function isConfirmedBusinessRuleRefusal(err) {
  const chain = causeChain(err);
  if (leavesOutcomeOpen(chain)) return false;
  const answered = chain.find((e) => (e.statusCode != null ? e.statusCode : e.status) === 400 && isBusinessRuleMemberUrl(e.url));
  const body = answered && answered.cause;
  if (!body || typeof body !== 'object') return false;
  const code = body.error && body.error.code;
  if (typeof code !== 'string' || code.toLowerCase() !== SWITCHED_OFF_CODE) return false;
  const history = body[HTTP_SEND_HISTORY];
  return Boolean(history) && history.earlierAmbiguous === false;
}

/** The missing-member answer (BUSINESS_RULE_API_UNAVAILABLE), or the confirmed switched-off 400. */
function isAvailabilityRefusal(err) {
  const chain = causeChain(err);
  if (chain.some((e) => e.code === 'BUSINESS_RULE_LEFT_DEACTIVATED')) return false;
  return chain.some((e) => e.code === 'BUSINESS_RULE_API_UNAVAILABLE') || isConfirmedBusinessRuleRefusal(err);
}

// ---------------------------------------------------------------------------------------------------------------
// Settlement.

/**
 * Settle one declared business rule through runManagedFeature.
 * @param {object} input
 *   rule              the App Spec rule (`reconcile: "declared"`, every node keyed)
 *   sdk               the maker SDK over the plugin's HTTP client (with the workflow effect gate)
 *   store             the managed binding handle (opened with the publication barrier)
 *   catalog           the plan's create-intent catalog; the rule's entry is { catalogKind: 'businessRule', key: ruleKey(rule) }
 *   approvals         the build's approval set; `rule:<table>/<name>` (adopt) approves a complete read-only adoption
 *   opts              { workflowConditionalEdits?: true } turns on the edit path (off by default; the skill never writes it)
 *   halt              the build's halt factory (managedStop)
 *   ensureMembership  ({ root, records, recovering }) => solution membership of the workflow
 *   phase, label, barrier
 *   httpClient, instanceUrl  needed for every state change, which carries If-Match: the default activation of the
 *                     attempt's own create as well as the edit path. Without them no activation is sent
 *   sendObserver      the build's createAttemptSendObserver, installed on the transport sdk and httpClient send through
 *                     (runManagedFeature): an attempt whose window shows nothing sent is continued under its own token
 * @returns {{ committed?: true, recovered?: boolean, noop?: true, skipped?: 'unavailable', id?: string, cause?: Error }}
 */
async function settleDeclaredRule(input) {
  const { rule, sdk, store, catalog, approvals = null, opts = {}, halt, phase = 'business-rules', barrier, httpClient = null, instanceUrl = null, sendObserver = null, freshTable = null, retryFreshRead = null } = input || {};
  const ensureMembership = (input && input.ensureMembership) || (async () => {});
  if (!isDeclaredRule(rule)) throw coded(CODES.notSettled, 'settleDeclaredRule takes a rule with reconcile: "declared"');
  if (!store || typeof store.snapshot !== 'function') throw coded(CODES.notSettled, 'settleDeclaredRule needs the managed binding store');
  const key = ruleKey(rule);
  const table = tableOf(rule);
  const label = (input && input.label) || `declared business rule "${rule.name}" on ${table}`;
  const approved = isApproved(approvals, FAMILY, approvalIdOf(rule));
  const switchOn = opts.workflowConditionalEdits === true;
  const declarationSha256 = intentSha256(rule);
  const head = store.snapshot().envelope;
  const recordOf = (id, origin) => ({
    formatVersion: 1, appUniqueName: head.appUniqueName, environmentFingerprint: head.environmentFingerprint,
    kind: ROOT_KIND, key, id, intentSha256: declarationSha256, origin,
  });
  const run = { token: null, committed: null };

  // ----- reads and writes (lib/workflow-drive.js): the version is read before the body, every write is sent once inside
  // its persisted effect, and an unproved write is proved by reading, never sent again.
  const { readVersion, attemptOf, effectOf, sendOnce, noteNoStart, driveState, activateOwnCreate, refuseRecordedEdits } = createWorkflowDriver({
    store, sdk, httpClient, instanceUrl, family: FAMILY, key, label, noun: 'rule', driftCode: 'rule-drift',
    conditionalEdits: switchOn, editRefusedRemedy: EDIT_REFUSED_REMEDY,
  });
  // The local SDK copy is checked before anything reads over it, reseeds or deletes it (an unsent edit stops the build).
  const guard = createCopyGuard({ sdk, artifact: ARTIFACT, label, noun: 'rule' });
  async function readBody(id) {
    await guard.assertClean(id);
    try {
      await sdk.fetchArtifact(ARTIFACT, id, { overwrite: true });
      const art = await sdk.getArtifact(ARTIFACT, id);
      if (!art) return { missing: true };
      const view = projectRule(art);
      if (view.unsupported) throw coded('rule-shape-unsupported', `${label}: ${view.unsupported}; this shape is not managed (nothing is changed)`);
      return view;
    } catch (err) {
      if (err && err.code === 'rule-shape-unsupported') throw err;
      if (isNotFound(err)) return { missing: true };
      throw coded(CODES.notSettled, `${label}: the rule ${id} could not be read`, { cause: err });
    }
  }
  async function readLive(id) {
    const row = await readVersion(id);
    if (!row) return { missing: true };
    const view = await readBody(id);
    if (view.missing) return { missing: true };
    return { version: row.version, view };
  }

  // ----- local SDK staging (no request). The local copy is laid out from the declaration or the proved read, so a
  // dirty earlier copy is never pushed (and never thrown away: it was refused before this, by the copy guard).
  async function stageCreate(id) {
    await guard.assertClean(id);
    guard.noteStaged(id);
    const def = compileRuleIntent(rule);
    try { await sdk.deleteArtifact(ARTIFACT, id); } catch { /* no local copy */ }
    await sdk.createArtifact(ARTIFACT, { ...def, id, status: DRAFT });
    await sdk.updateElement(ARTIFACT, id, '/rootCondition', def.rootCondition);
    return prepared(id, def.status);
  }
  async function stageEdit(id, root, liveScope) {
    guard.noteStaged(id);
    await sdk.updateElement(ARTIFACT, id, '/rootCondition', root);
    if (rule.description !== undefined) await sdk.updateElement(ARTIFACT, id, '/description', String(rule.description));
    // The SDK sends the scope as Entity.processtriggerscope (Entity -> 2, AllForms -> 1 with no form id).
    if ((rule.scope || 'Entity') !== liveScope) await sdk.updateElement(ARTIFACT, id, '/scope', rule.scope || 'Entity');
    return prepared(id, rule.status || ACTIVE);
  }
  async function prepared(id, desiredStatus) {
    const prep = await sdk.withArtifactLock(ARTIFACT, id, () => sdk.prepareArtifactUnlocked(ARTIFACT, id, undefined));
    const body = { Entity: prep.payload.Entity, WfomJson: prep.payload.WfomJson };
    // The SDK's own parser over the exact body it will send: the projection a fresh read must give back.
    const sent = projectRule(prep.reg.adapter.fromApiResponse(clone(body)));
    if (sent.unsupported) throw coded('rule-shape-unsupported', `${label}: ${sent.unsupported}`);
    return { prep, desiredSha256: requestBodySha256(body), sent, desiredStatus, version: (prep.meta && prep.meta.etag) || null };
  }

  function expectedOf({ id, sent, desiredStatus, slots, live }) {
    return {
      proofVersion: 1,
      proofSchema: PROOF_SCHEMA,
      rootId: id,
      baseProofSha256: run.committed ? intentSha256(run.committed.proof) : null,
      sentProjectionSha256: savedShaOf(sent.projection, desiredStatus),
      preservationSha256: preservationOf(sent.root, slots),
      baseObservation: live ? { rowVersion: live.version || null, savedSha256: savedShaOf(live.view.projection, live.view.status) } : null,
      children: [],
    };
  }

  /**
   * Send the Draft create of this attempt's own row (from `apply` only: a first send, or the same create under the same
   * token after resumeCreate read its id absent), then finish it (finishCreate). An answered create is durable at once
   * (noteSaved, acknowledgedRoot): that answer is what lets this attempt call the row its own creation.
   */
  async function driveCreate(token, id, staged) {
    let create = effectOf(token, (e) => e.effect === 'create');
    let failure = null;
    if (!create || create.state === 'definitely-unsent') {
      const s = staged || await stageCreate(id);
      if (create && create.desiredSha256 !== s.desiredSha256) throw coded(CODES.pending, `${label}: the create waiting to be sent was made from another declaration; restore it to finish`);
      failure = await sendOnce(token, create, {
        rowId: id, effect: 'create', request: { method: 'POST', shape: 'rule-create' }, desiredSha256: s.desiredSha256, desiredState: null, expectedVersion: null,
      }, () => sdk.withArtifactLock(ARTIFACT, id, () => sdk.executePrepared(s.prep)));
      create = effectOf(token, (e) => e.effect === 'create');
      if (!failure) store.noteSaved(token, { proof: null, acknowledgedRoot: true, phase: 'state-pending' });
      // The documented availability answer to a create (see isAvailabilityRefusal), with a fresh read that finds no
      // row and no rule of the name, is the one refusal recorded as never started: it is what lets the next run resume
      // the same create (resumeCreate) once the environment can host business rules.
      if (failure && isAvailabilityRefusal(failure) && await nothingCreated(id)) {
        noteNoStart(create);
        throw Object.assign(new Error(`${label}: this environment cannot host business rules`), { [SKIP]: true, cause: failure });
      }
    }
    return finishCreate(token, id, failure);
  }

  /**
   * Prove this attempt's own create by reading (never by sending it again), then complete its own activation. The
   * activation needs no edit switch — the row is the one this exact attempt created — and is held to the version of the
   * read that proved it (activateOwnCreate: If-Match; a maker's change in between is never undone or activated). A
   * create no answer acknowledged is not known to be this build's: it is neither activated nor bound without the rule's
   * typed adoption approval (`managed-adoption-required`, the attempt kept).
   */
  async function finishCreate(token, id, failure) {
    const create = effectOf(token, (e) => e.effect === 'create');
    if (create.state !== 'confirmed') {
      const live = await readLive(id);
      if (live.missing) {
        if (failure && answeredRefusal(failure)) {
          throw coded('create-completion-required', `${label}: the create was refused (${failure.message}) and no row is there now. That answer does not prove the `
            + `create never started, so it is not sent again from this attempt; a later run reads ${id} again`, { cause: failure });
        }
        throw coded(CODES.pending, `${label}: the create of ${id} has not appeared; it is not sent again, and a later run reads the row again`, { cause: failure });
      }
      const expected = attemptOf(token).attempt.expected;
      if (statusFor(expected, live.view.projection) === null) {
        throw coded('create-completion-required', `${label}: the workflow ${id} is not the rule this build sent; nothing is bound to it`);
      }
      store.confirmEffect(create.token, { observedSha256: create.desiredSha256 });
    }
    const { attempt } = attemptOf(token);
    // The store's one reading of the acknowledgement: honoured only for an attempt whose expected proof records no base
    // observation, so an answer to an edit of an existing row never makes it this attempt's creation.
    const acknowledged = rootCreateAcknowledged(attempt);
    const live = await readLive(id);
    if (live.missing) throw coded(CODES.pending, `${label}: the workflow ${id} could not be read back`);
    const desired = statusFor(attempt.expected, live.view.projection);
    if (desired === null) throw coded('create-completion-required', `${label}: the workflow ${id} is not the rule this build sent`);
    if (desired === ACTIVE) {
      if (live.view.status !== ACTIVE && !acknowledged && !approved) {
        throw coded(CODES.adoptionRequired, `${label}: the workflow ${id} carries what this build sent, but no answer acknowledged its create, so it is not known `
          + `to be this build's; it is neither activated nor bound without the adoption approval adopt:rule:${approvalIdOf(rule)}. The attempt is kept`);
      }
      await activateOwnCreate(token, id, live, {
        reread: () => readLive(id),
        provedActive: (view) => (statusFor(attempt.expected, view.projection) === ACTIVE ? null : 'the rule read back is not the rule this build sent'),
      });
    }
    return { acknowledged };
  }

  /** The switch path: Draft (when Active), body, then Active, each conditioned on the version its proof read returned. */
  async function driveEdit(token, id, planned) {
    const base = planned.live;
    const baseSemantic = intentSha256(base.view.projection);
    let live = base;
    if (live.view.status === ACTIVE) {
      await driveState(token, id, DRAFT, live.version, { conditional: true, observed: live.view.status });
      live = await readLive(id);
      if (live.missing || intentSha256(live.view.projection) !== baseSemantic) throw coded('rule-drift', `${label}: the rule changed on the server while it was being edited; nothing more is sent`);
    }
    const staged = await stageEdit(id, planned.root, base.view.projection.scope);
    if (savedShaOf(staged.sent.projection, staged.desiredStatus) !== planned.expected.sentProjectionSha256) {
      throw coded('rule-drift', `${label}: the rule read back differently from the proof it was planned on; nothing more is sent`);
    }
    if (staged.version !== live.version) throw coded('rule-drift', `${label}: the rule's version moved between two reads; nothing more is sent`);
    const failure = await sendOnce(token, null, {
      rowId: id, effect: 'body', request: { method: 'POST', shape: 'rule-update' }, desiredSha256: staged.desiredSha256, desiredState: null, expectedVersion: staged.version,
    }, () => sdk.withArtifactLock(ARTIFACT, id, () => sdk.executePrepared(staged.prep)));
    const body = effectOf(token, (e) => e.effect === 'body');
    if (body.state === 'definitely-unsent') throw coded('rule-drift', `${label}: the rule changed on the server after it was read, so the edit was refused; it is not retried`, { cause: failure });
    live = await readLive(id);
    if (live.missing || savedShaOf(live.view.projection, staged.desiredStatus) !== planned.expected.sentProjectionSha256) {
      throw coded(failure ? CODES.pending : 'rule-drift', `${label}: the edit is not proved by a fresh read; it is not sent again`, { cause: failure });
    }
    store.confirmEffect(body.token, { observedSha256: body.desiredSha256 });
    if (staged.desiredStatus === ACTIVE && live.view.status !== ACTIVE) await driveState(token, id, ACTIVE, live.version, { conditional: true, observed: live.view.status });
  }

  // A refused create wrote nothing only when a fresh, complete read finds neither its row nor any rule of its name
  // (the same 400 also answers a create the platform saved and then failed to finish).
  async function nothingCreated(id) {
    try {
      if (await readVersion(id)) return false;
      const rows = await sdk.queryRecords('workflow', { select: ['workflowid'], filter: sdkBuild().businessRuleFilter(rule.name, table), paginate: true });
      return Array.isArray(rows) && rows.length === 0;
    } catch {
      return false;
    }
  }

  // The status the expected proof was sent for, given a live projection: the one for which the hashes agree.
  function statusFor(expected, projection) {
    for (const s of [ACTIVE, DRAFT]) if (savedShaOf(projection, s) === expected.sentProjectionSha256) return s;
    return null;
  }

  async function finalProof(id, expected, slots, origin, acknowledged) {
    const live = await readLive(id);
    if (live.missing) throw coded(CODES.pending, `${label}: the workflow ${id} could not be read back`);
    const saved = savedShaOf(live.view.projection, live.view.status);
    const preservation = preservationOf(live.view.root, slots);
    if (saved !== expected.sentProjectionSha256 || preservation !== expected.preservationSha256) {
      throw coded(run.committed ? 'rule-drift' : 'create-completion-required', `${label}: a fresh read of ${id} is not what was sent; nothing is bound`);
    }
    const proof = { savedSha256: saved, semanticSha256: intentSha256(live.view.projection), preservationSha256: preservation, expectedChildrenSha256: null };
    const prev = run.committed && run.committed.consumerState ? run.committed.consumerState.declaration : null;
    return {
      savedProof: proof, acknowledgedRoot: acknowledged === true, records: [recordOf(id, origin)], proof,
      consumerState: { declaration: declarationState(prev, rule), slots }, publication: null, proofSchema: PROOF_SCHEMA,
    };
  }

  // ----- the four steps.
  async function resolve({ committed, pending }) {
    run.committed = committed;
    run.pending = pending || null;
    const errors = validateDeclaredRule(rule);
    if (errors.length) throw coded('rule-shape-unsupported', errors.join('; '));
    if (pending && pending.declarationSha256 !== declarationSha256) {
      throw coded(CODES.pending, `${label}: an earlier change was prepared from another declaration of this rule; restore that declaration to finish it`);
    }
    return committed ? resolveManaged(committed) : resolveNew();
  }

  async function resolveManaged(committed) {
    if (!committed.root || committed.root.kind !== ROOT_KIND) throw coded(CODES.groupInvalid, `${label}: the managed group is not a business rule`);
    const id = committed.root.id;
    const prev = committed.consumerState ? committed.consumerState.declaration : null;
    const edits = editsOf(prev, rule);
    // The default refuses an edit before ANY workflow request. With an adoption approval the rule is read first, as
    // a re-adoption may be what the declaration asks for; an edit is still refused after that read, unsent.
    if (edits.length && !switchOn && !approved) throw coded('workflow-edit-refused', `${label}: the declaration ${edits.join(', ')}. ${EDIT_REFUSED_REMEDY}`);
    const live = await readLive(id);
    if (live.missing) throw coded('rule-drift', `${label}: its workflow ${id} is gone; nothing re-creates or rebinds it`);
    if (savedShaOf(live.view.projection, live.view.status) !== committed.proof.savedSha256) {
      if (!approved) {
        throw coded('rule-drift', `${label}: the rule changed outside the spec since it was last proved; nothing is sent. Re-adopt it (adopt:rule:${approvalIdOf(rule)}) with a declaration that names its whole current body, in order`);
      }
      return adoption(id, live);
    }
    if (!edits.length) return { mode: 'noop' };
    if (!switchOn) throw coded('workflow-edit-refused', `${label}: the declaration ${edits.join(', ')}. ${EDIT_REFUSED_REMEDY}`);
    // A declaration that changes only the status is a pure state change: one conditional state write, no body push
    // (the body is already proved, and regenerating it would rewrite what the server holds for nothing).
    const bodyEdits = editsOf(prev, { ...rule, status: prev.rule.status });
    if (!bodyEdits.length) return { mode: 'state', id, live, target: rule.status || ACTIVE };
    return { mode: 'edit', id, live };
  }

  async function resolveNew() {
    const { id } = identityFor('businessRule', key, { catalog });
    let sameName;
    let atId;
    for (;;) {
      try {
        sameName = await sdk.queryRecords('workflow', { select: ['workflowid'], filter: sdkBuild().businessRuleFilter(rule.name, table), paginate: true });
        atId = await readVersion(id);
        break;
      } catch (err) {
        // As for a process flow (bpf-settlement.js resolveNew): the metadata-cache lag of a table this invocation created is
        // read again here while the build's one retry allowance lasts; nothing was sent, and any other failure stays final.
        if (freshTable) markFreshTable(err, freshTable);
        if (freshTable && typeof retryFreshRead === 'function' && isFreshTableReadLag(err) && (await retryFreshRead(err, freshTable)) === true) continue;
        throw coded('create-identity-unverified', `${label}: whether the rule already exists could not be read, so it is neither created nor adopted`, { cause: err });
      }
    }
    if (!Array.isArray(sameName)) throw coded('create-identity-unverified', `${label}: the read of its name answered no list`);
    const ids = sameName.map((r) => normalizeGuid(r.workflowid));
    if (atId && !ids.includes(id)) throw coded('create-identity-conflict', `${label}: its id ${id} is held by another workflow`);
    if (ids.length > 1) throw coded('create-identity-conflict', `${label}: ${ids.length} business rules on ${table} have this name; none is adopted`);
    if (ids.length === 1) {
      if (!approved) {
        throw coded('create-ownership-required', `${label}: a business rule of this name already exists (${ids[0]}); approve adopt:rule:${approvalIdOf(rule)} with a declaration that names its whole body to manage it`);
      }
      const live = await readLive(ids[0]);
      if (live.missing) throw coded('create-identity-unverified', `${label}: the rule ${ids[0]} could not be read back`);
      return adoption(ids[0], live);
    }
    return { mode: 'create', id };
  }

  function adoption(id, live) {
    const errs = wholeBodyErrors(rule, live.view);
    if (errs.length) throw coded('rule-whole-body-required', `${label}: adopting a rule needs a declaration that names its whole current body, in order: ${errs.join('; ')}`);
    return { mode: 'adopt', id, live };
  }

  // runManagedFeature `plan`: the change (planChange) plus the ORIGINAL authored rule as `declaration`, a plain-JSON
  // copy the shared seam checks (checkDeclaration) and records with the attempt before anything is sent, then commits as
  // the group's originalDeclaration. It is kept apart from consumerState, which stays this module's derived state as
  // prove answers it. A continued or resumed attempt is sent only for the declaration it recorded, so that replan
  // answers the recorded one (resolve has already refused one prepared from another declaration hash).
  async function plan(input) {
    const planned = await planChange(input);
    if (!planned || planned.noop === true) return planned;
    const recorded = (input.continuing || input.resuming) && run.pending ? run.pending.declaration : undefined;
    const declaration = recorded !== undefined ? recorded : clone(rule);
    return { ...planned, declaration, completionBytes: completionWithin(completionBytesOf(planned, declaration), label, 'business rule', 'conditions, actions or recommendation apply-actions') };
  }

  // The bytes this attempt's completion may add to the store (runManagedFeature `completionBytes`; see
  // workflow-drive completionBytesFor): the parts its commit adds as finalProof builds them — the root record, the
  // proof (twice: the saved proof is noted on the attempt as well), the consumer state (the rule and its node
  // declarations, with the slots this plan laid out) — plus the original declaration and the expected proof.
  function completionBytesOf(planned, declaration) {
    const prev = run.committed && run.committed.consumerState ? run.committed.consumerState.declaration : null;
    const proof = { savedSha256: HASH_BOUND, semanticSha256: HASH_BOUND, preservationSha256: HASH_BOUND, expectedChildrenSha256: HASH_BOUND };
    const consumerState = { declaration: declarationState(prev, rule), slots: planned.slots };
    return completionBytesFor([[recordOf(planned.root.id, 'adopted')], proof, proof, consumerState, declaration, planned.expected]);
  }

  async function planChange({ resolution }) {
    const root = (id) => ({ kind: ROOT_KIND, key, id });
    if (resolution.mode === 'noop') return { noop: true };
    if (resolution.mode === 'adopt') {
      const { id, live } = resolution;
      const slots = positionalSlots(rule);
      const expected = expectedOf({ id, sent: live.view, desiredStatus: live.view.status, slots, live });
      return { root: root(id), expected, declarationSha256, publication: null, mode: 'adopt', slots };
    }
    if (resolution.mode === 'create') {
      const { id } = resolution;
      const staged = await stageCreate(id);
      const slots = positionalSlots(rule);
      const expected = expectedOf({ id, sent: staged.sent, desiredStatus: staged.desiredStatus, slots, live: null });
      return { root: root(id), expected, declarationSha256, publication: null, mode: 'create', staged, slots };
    }
    if (resolution.mode === 'state') {
      // The live body is what stays; only the status moves. The committed slots still name the live nodes (the row
      // equals the committed proof, checked in resolveManaged).
      const { id, live, target } = resolution;
      const slots = run.committed.consumerState.slots || {};
      const expected = expectedOf({ id, sent: live.view, desiredStatus: target, slots, live });
      return { root: root(id), expected, declarationSha256, publication: null, mode: 'state', live, target, slots };
    }
    const { id, live } = resolution;
    const { root: edited, slots } = layoutEdit(live.view.root, run.committed.consumerState.slots || {}, rule, lengthsOf(live.view.root));
    const staged = await stageEdit(id, edited, live.view.projection.scope);
    const expected = expectedOf({ id, sent: staged.sent, desiredStatus: staged.desiredStatus, slots, live });
    return { root: root(id), expected, declarationSha256, publication: null, mode: 'edit', live, root2: edited, slots, staged };
  }

  async function apply({ token, plan: planned }) {
    run.token = token;
    if (planned.mode === 'adopt') return { mode: 'adopt', acknowledged: false };
    if (planned.mode === 'create') return { mode: 'create', ...(await driveCreate(token, planned.root.id, planned.staged)), slots: planned.slots };
    if (planned.mode === 'state') {
      await driveState(token, planned.root.id, planned.target, planned.live.version, { conditional: true, observed: planned.live.view.status });
      return { mode: 'state', acknowledged: false, slots: planned.slots };
    }
    await driveEdit(token, planned.root.id, { live: planned.live, root: planned.root2, expected: planned.expected });
    return { mode: 'edit', acknowledged: false, slots: planned.slots };
  }

  async function prove({ token, expected, applied, recovering }) {
    run.token = token;
    const id = expected.rootId;
    if (!recovering) {
      const committedOrigin = run.committed ? (run.committed.records.find((r) => r.kind === ROOT_KIND) || {}).origin : null;
      const origin = committedOrigin || (applied.mode === 'create' && applied.acknowledged ? 'created' : 'adopted');
      return finalProof(id, expected, applied.slots || positionalSlots(rule), origin, applied.acknowledged);
    }
    // Recovery: the change may already be on the server. Nothing is planned again; the attempt's own effects are
    // proved by reading. A write is sent from here only when its record says it never started AND it is this attempt's
    // own create's activation, or the edit switch is on (an existing workflow is never changed by default).
    const { committed } = store.readGroup(FAMILY, key);
    run.committed = committed;
    const { attempt, effects } = attemptOf(token);
    if (attempt.declarationSha256 !== declarationSha256) {
      throw coded(CODES.pending, `${label}: an earlier change of this rule is not proved, and the declaration it was sent from has changed; restore that declaration to finish it`);
    }
    if (!committed) return proveUncommitted(token, id, expected, attempt, effects);
    const origin = (committed.records.find((r) => r.kind === ROOT_KIND) || {}).origin || 'adopted';
    if (!effects.length) {
      // A re-adoption (no write), or an edit whose first write was never recorded: the read decides.
      const live = await readLive(id);
      if (!live.missing && savedShaOf(live.view.projection, live.view.status) === expected.sentProjectionSha256) {
        const rebased = !(expected.baseObservation && expected.baseObservation.savedSha256 === committed.proof.savedSha256);
        // Binding the rule's current body again (a re-adoption) is the maker's decision, on this run as on the first.
        if (rebased && !approved) {
          throw coded(CODES.adoptionRequired, `${label}: an earlier re-adoption of this rule is proved by reading, but binding its current body again needs the adoption approval adopt:rule:${approvalIdOf(rule)}; the attempt is kept`);
        }
        return finalProof(id, expected, rebased ? positionalSlots(rule) : editedSlots(committed, live), origin, false);
      }
      throw coded(CODES.pending, `${label}: an earlier change of this rule was prepared and is not on the row; nothing of it is sent from this attempt, which stays pending`);
    }
    // An edit: every write it dispatched is proved by the row as it is now, or the attempt stays pending.
    const live = await readLive(id);
    // The status the edit was meant to end in, when the row as it is now carries exactly what was sent. A row that
    // carries the sent body in the other status is an edit stopped between its body and its own state change.
    const target = live.missing ? null : statusFor(expected, live.view.projection);
    if (target === null) {
      throw coded(CODES.pending, `${label}: an earlier edit of this rule is not proved by the row as it is now; it is not sent again`);
    }
    for (const e of effects) {
      if (e.state === 'confirmed') continue;
      // The edit's own final state change is settled below.
      if (e.effect === 'state' && e.desiredState === target && live.view.status !== target) continue;
      if (e.state === 'definitely-unsent') throw coded(CODES.pending, `${label}: an earlier edit of this rule has a write that was never sent`);
      if (e.effect === 'state') {
        if (e.desiredState === live.view.status) store.confirmEffect(e.token, { observedState: e.desiredState });
        else if (e.desiredState === DRAFT) throw coded(CODES.pending, `${label}: an earlier edit's state change is not proved`);
      } else {
        store.confirmEffect(e.token, { observedSha256: e.desiredSha256 });
      }
    }
    if (target !== live.view.status) {
      // The body is on the row and proved; only the edit's own state change is missing. That is a write to a workflow
      // that already exists, so by default it is refused before anything is sent, whatever its record says.
      if (!switchOn) {
        throw coded('workflow-edit-refused', `${label}: an earlier edit is on the row but the rule is not ${target}; setting it ${target} is a state change of a `
          + `workflow that already exists, so nothing is sent and the attempt stays pending. ${EDIT_REFUSED_REMEDY}`);
      }
      // Sent (once, against the version of this read) only when its record says it never left; one that may have left
      // is proved by reading, never sent again.
      await driveState(token, id, target, live.version, { conditional: true, observed: live.view.status });
    }
    // A Draft state effect the row has since left (the edit's own Active) is proved by the later Active write.
    for (const e of attemptOf(token).effects) {
      if (e.state !== 'confirmed' && e.effect === 'state' && e.desiredState === DRAFT) {
        const active = attemptOf(token).effects.find((x) => x.effect === 'state' && x.desiredState === ACTIVE && x.state === 'confirmed');
        if (!active) throw coded(CODES.pending, `${label}: an earlier edit's state change is not proved`);
        store.confirmEffect(e.token, { observedState: DRAFT });
      }
    }
    return finalProof(id, expected, editedSlots(committed, live), origin, false);
  }

  /**
   * Recovery of an attempt with no committed group: a create, or a read-only adoption. Only the attempt's own CREATE
   * may continue as a create, and only by proving it (resumeCreate is what sends a create again, when the row is
   * proved absent). The discriminator is positive: no base generation, no base observation, no base proof — what
   * expectedOf records for a create and never for an adoption. Neither "not committed" nor "the row is absent" is
   * creation authority: an adoption whose row is gone stops, nothing created.
   */
  async function proveUncommitted(token, id, expected, attempt, effects) {
    const isCreate = attempt.baseGeneration === null && expected.baseObservation === null && expected.baseProofSha256 === null;
    if (isCreate) {
      const create = effects.find((e) => e.effect === 'create') || null;
      if (!create || create.state === 'definitely-unsent') {
        if (await readVersion(id)) throw coded('create-identity-conflict', `${label}: a workflow already holds the id ${id}, and no create of this build reached the server; nothing is bound to it`);
        throw coded(CODES.pending, `${label}: its create never left and the row is absent; it is not sent from here`);
      }
      const { acknowledged } = await finishCreate(token, id, null);
      return finalProof(id, expected, positionalSlots(rule), acknowledged ? 'created' : 'adopted', acknowledged);
    }
    if (effects.length) throw coded('create-completion-required', `${label}: an earlier adoption of ${id} recorded a write, which an adoption never makes; nothing is sent or bound`);
    const live = await readLive(id);
    if (live.missing) {
      throw coded('create-completion-required', `${label}: the rule ${id} an earlier run was adopting is gone; an adoption never becomes a create, so nothing is created or bound`);
    }
    return finalProof(id, expected, positionalSlots(rule), 'adopted', false);
  }

  // The slots an edit laid out, recomputed from the edited tree (see layoutEdit / lengthsBefore).
  function editedSlots(committed, live) {
    const before = (committed.consumerState && committed.consumerState.slots) || {};
    return layoutEdit(live.view.root, before, rule, lengthsBefore(live.view.root, before, rule)).slots;
  }

  // A confirmed availability refusal leaves the attempt with only a definitely-unsent effect: it is not a failure of
  // the build, so the hold is released and the caller gets the skip instead of a halt.
  const haltOrSkip = (ph, lbl, code, extra) => {
    const cause = extra && extra.cause;
    if (cause && cause[SKIP]) {
      try { (barrier || store).release(run.token); } catch { /* nothing held */ }
      return Object.assign(new Error(cause.message), { [SKIP]: true, cause: cause.cause });
    }
    return halt(ph, lbl, code, extra);
  };

  // The feature's own checks on every path (runManagedFeature `preflight`), before anything is read into the
  // workspace or sent: the local copy of every row this attempt may touch holds no unsent edit. No request is made.
  async function preflight({ committed, pending, effects }) {
    // With the edit switch off, an attempt that still has to send a write to an existing row stops here, before any read.
    refuseRecordedEdits({ pending, effects });
    const ids = [committed && committed.root && committed.root.id, pending && pending.root && pending.root.id, pending && pending.expected && pending.expected.rootId];
    if (!committed) {
      try { ids.push(identityFor('businessRule', key, { catalog }).id); } catch { /* resolve reports a catalog without this rule */ }
    }
    for (const id of ids) if (id) await guard.assertClean(id);
  }

  // A create no answer acknowledged (runManagedFeature `resumeCreate`): is its row there, by the id the create names?
  // A workflow row has one layer (no unpublished/published split), so one read answers for both; a failed read throws.
  async function resumeCreate({ pending }) {
    return { root: (await readVersion(pending.root.id)) ? 'present' : 'absent' };
  }

  try {
    const out = await runManagedFeature({
      phase, family: FAMILY, key, label, knownScopes: [], knownIds: [], store, barrier, halt: haltOrSkip,
      preflight, resolve, plan, apply, prove, ensureMembership, resumeCreate, adoptionApproved: approved,
      ...(sendObserver ? { sendObserver } : {}),
      // The catalog's incarnation token of this key: a plan made before its root was retired again is refused by the store
      // under the lease (prepareAttempt `incarnation`), never prepared under a retired root.
      incarnation: catalog && typeof catalog.incarnationOf === 'function' ? catalog.incarnationOf('businessRule', key) : undefined,
    });
    const id = out.committedGroup && out.committedGroup.root ? out.committedGroup.root.id : null;
    return { ...out.result, id };
  } catch (err) {
    if (err && err[SKIP]) return { skipped: 'unavailable', cause: err.cause };
    throw err;
  } finally {
    await guard.restoreStaged();
  }
}

module.exports = {
  settleDeclaredRule,
  compileRuleIntent,
  ruleShapeErrors,
  validateDeclaredRule,
  isDeclaredRule,
  ruleKey,
  projectRule,
  editsOf,
  wholeBodyErrors,
  isAvailabilityRefusal,
  EDIT_REFUSED_REMEDY,
  PROOF_SCHEMA,
};
