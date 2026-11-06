'use strict';
// The read-only side of declared business rules (businessRules[].reconcile "declared"): what verify and the explicit managed
// download read about them. Nothing here writes, binds, activates or clears an effect.
//
// Both hold a stored rule to its group's last proof through the helper's ONE read-only projection (lib/rule-settlement.js
// projectRule), never a looser copy of it. The proof's `savedSha256` is the hash of that projection together with the rule's
// status (rule-settlement.js savedShaOf, `intentSha256({ projection, status })`), and the projection holds every node of the rule
// in order, so equal hashes mean the whole body and the state are what the build proved: the conditions, actions and
// recommendation apply-actions the declaration owns, and every node it does not own (which the proof's preservation hash covers
// as a subset). A Draft rule whose proof says Active, or the reverse, does not certify.
//
// rule-settlement.js loads the creates catalog, which a default build must not reach (tests/creates-port.test.js), so it is
// required inside the functions below, only when a committed rule group is actually read.
//
// What a read can show: a rule is a workflow row, read here as the service answers it now, through an SDK whose workspace is the
// caller's own and throwaway (verify's isolated reader, the download's SDK), never the build's. It shows nothing about an edit that
// lands after it.
const { intentSha256 } = require('./reconcile-common.js');
const { readManagedFormFile } = require('./declared-form-io.js');

const settlement = () => require('./rule-settlement.js');
// rule-settlement.js ARTIFACT: the SDK's artifact kind of a business rule.
const ARTIFACT = 'businessRule';
const lc = (v) => String(v == null ? '' : v).toLowerCase();
const bareId = (id) => lc(id).replace(/^\{|\}$/g, '');
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/**
 * A fresh read of one rule by its exact id through `sdk` (overwrite: a local copy must never pass for the stored row). Answers the
 * rule as the SDK reads it, or null when the SDK gives none; a read that fails throws, so the caller reports it as unread, never
 * as a pass.
 */
async function readLiveRule(sdk, id) {
  await sdk.fetchArtifact(ARTIFACT, id, { overwrite: true });
  const art = await sdk.getArtifact(ARTIFACT, id);
  return art && typeof art === 'object' ? art : null;
}

/** Why `art` (the rule read by the group's bound id) is not what the committed rule `group` last proved, as [{ code, message }]. */
function ruleProofIssues(group, art) {
  const view = settlement().projectRule(art);
  if (view.unsupported) return [{ code: 'rule-shape-unsupported', message: `the rule now has a shape the build does not manage (${view.unsupported})` }];
  const proof = (group && group.proof) || {};
  if (intentSha256({ projection: view.projection, status: view.status }) !== proof.savedSha256) {
    return [{ code: 'rule-changed', message: `the rule (now ${view.status}) is not what its last build proved: its body or its state changed outside the spec` }];
  }
  return [];
}

/**
 * verify's check of one committed rule group the spec still declares: ruleProofIssues, plus whether the spec's declaration is one
 * the group has applied. That is the helper's own test (rule-settlement.js editsOf over the group's declaration state), so an
 * omitted node, description or condition logic is not a change here either, as it is not for the build; and the rule's table and
 * name, which a build never changes on a managed rule. `group.declaration` is the group's consumerState.declaration as the
 * manifest view carries it; a group without one is listed as unverified by the caller, never passed or failed here.
 */
function verifyDeclaredRule({ rule, group, art }) {
  const { editsOf, EDIT_REFUSED_REMEDY } = settlement();
  const issues = ruleProofIssues(group, art);
  const settled = group.declaration.rule || {};
  if (lc(settled.entity) !== lc(rule.entity) || String(settled.name) !== String(rule.name)) {
    issues.push({ code: 'rule-declaration-changed', message: `the spec names this rule ${lc(rule.entity)}/${rule.name} and its last build settled ${lc(settled.entity)}/${settled.name}; a build does not rename or move a managed rule` });
  }
  const edits = editsOf(group.declaration, rule);
  if (edits.length) {
    issues.push({ code: 'rule-declaration-changed', message: `the spec's declaration ${edits.join(', ')}, which is not on the rule yet. ${EDIT_REFUSED_REMEDY}` });
  }
  return issues;
}

/**
 * The explicit managed download's restore (--include-managed --managed-manifest <file>): for each committed rule group of the store
 * file (readManagedFormFile, family 'rule'), the declaration it was built from (its originalDeclaration), put in
 * `spec.businessRules` (mutated) in key order. The plain download reconstructs no business rule, so a restored declaration is
 * appended, or REPLACES an entry for the same table and name if one is there. A group is restored only when
 *   - the store keeps its original declaration, and it is a declared rule,
 *   - a fresh read of its bound rule through `sdk` (the download's own throwaway SDK) answers,
 *   - that read certifies the group's last proof (ruleProofIssues answers none), and
 *   - the downloaded spec still validates with it (`validate`, the download's own validator).
 * Every other group (unread, changed since, not valid here, or still pending or unusable in the store) is answered in `stale` with
 * its reason, never silently dropped. Answers { restored: [key], stale: [{ key, reason }] }; a store file that cannot be used
 * throws `managed-manifest-unusable`.
 */
async function restoreManagedRules({ sdk, spec, file, environment, appUniqueName, solutionUniqueName, validate }) {
  const { groups, pending, invalid } = readManagedFormFile({ file, environment, appUniqueName, solutionUniqueName }, 'rule');
  const restored = [];
  const stale = [
    ...pending.map((p) => ({ key: p.key, reason: `its last attempt is not settled (${p.code}); build again to settle it` })),
    ...invalid.map((p) => ({ key: p.key, reason: `its stored record is not usable (${p.reason})` })),
  ];
  if (!groups.size) return { restored, stale: sortByKey(stale) };
  const base = validate(spec);
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key);
    const id = bareId(group.root && group.root.id);
    if (!base || !base.ok) { stale.push({ key, reason: 'the downloaded spec does not validate on its own, so no rule is restored into it' }); continue; }
    const declaration = group.originalDeclaration && typeof group.originalDeclaration === 'object' ? clone(group.originalDeclaration) : null;
    if (!declaration || declaration.reconcile !== 'declared') { stale.push({ key, reason: 'the store keeps no original declaration for it; build again to record one' }); continue; }
    let art;
    try {
      art = await readLiveRule(sdk, id);
    } catch (e) {
      stale.push({ key, reason: `rule ${id} could not be read (${(e && e.message) || e})` });
      continue;
    }
    if (!art) { stale.push({ key, reason: `rule ${id} was not found` }); continue; }
    const issues = ruleProofIssues(group, art);
    if (issues.length) { stale.push({ key, reason: `rule ${id} is not what its last build proved (${issues.map((i) => i.code).join(', ')}); build again to prove it` }); continue; }
    const rules = Array.isArray(spec.businessRules) ? spec.businessRules : [];
    const at = rules.findIndex((r) => r && lc(r.entity) === lc(declaration.entity) && lc(r.name) === lc(declaration.name));
    const next = at >= 0 ? rules.map((r, i) => (i === at ? declaration : r)) : [...rules, declaration];
    const check = validate({ ...spec, businessRules: next });
    if (!check || !check.ok) {
      const errors = ((check && check.errors) || []).slice(0, 3).map((x) => (typeof x === 'string' ? x : (x && x.message) || JSON.stringify(x)));
      stale.push({ key, reason: `its declaration does not validate in the downloaded spec (${errors.join('; ') || 'invalid'})` });
      continue;
    }
    spec.businessRules = next;
    restored.push(key);
  }
  return { restored, stale: sortByKey(stale) };
}

function sortByKey(list) {
  return list.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

// The declared rules the spec holds, by the key a committed rule group is stored under (rule-settlement.js ruleKey: its `key`, else
// `<table>/<name>`). Loads the helper, so the caller asks only when a committed rule group is there to check.
function declaredRulesByKey(rules) {
  const { isDeclaredRule, ruleKey } = settlement();
  const out = new Map();
  for (const r of (Array.isArray(rules) ? rules : [])) if (isDeclaredRule(r)) out.set(ruleKey(r), r);
  return out;
}

module.exports = { readLiveRule, ruleProofIssues, verifyDeclaredRule, restoreManagedRules, declaredRulesByKey };
