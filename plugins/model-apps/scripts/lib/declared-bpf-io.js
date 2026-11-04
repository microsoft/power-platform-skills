'use strict';
// The read-only side of declared business process flows (businessProcessFlows[].reconcile "declared"): what verify and the
// explicit managed download read about them. Nothing here writes, binds, activates or clears an effect.
//
// Both hold a stored flow to its group's last proof through the helper's ONE read-only projection (lib/bpf-settlement.js
// projectBpf), never a looser copy of it. The proof's `savedSha256` is the hash of that projection together with the flow's
// status (bpf-settlement.js savedShaOf, `intentSha256({ projection, status })`), and the projection holds the flow's name,
// table, description, order and every stage and step in order, by id, so equal hashes mean the whole body and the state are
// what the build proved. A Draft flow whose proof says Active, or the reverse, does not certify. projectBpf also checks the
// flow's retained XAML against the linear stage/step shape, so a flow that gained a branch, a stage action or a step the
// build does not model answers `bpf-shape-unsupported`, never a pass.
//
// bpf-settlement.js loads the creates catalog, which a default build must not reach (tests/creates-port.test.js), so it is
// required inside the functions below, only when a committed flow group is actually read.
//
// What a read can show: a flow is a workflow row, read here as the service answers it now, through an SDK whose workspace is
// the caller's own and throwaway (verify's isolated reader, the download's SDK), never the build's. It shows nothing about an
// edit that lands after it.
const { intentSha256 } = require('./reconcile-common.js');
const { readManagedFormFile } = require('./declared-form-io.js');

const settlement = () => require('./bpf-settlement.js');
// bpf-settlement.js ARTIFACT: the SDK's artifact kind of a business process flow.
const ARTIFACT = 'bpf';
const lc = (v) => String(v == null ? '' : v).toLowerCase();
const bareId = (id) => lc(id).replace(/^\{|\}$/g, '');
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/**
 * A fresh read of one flow by its exact id through `sdk` (overwrite: a local copy must never pass for the stored row). Answers
 * the flow as the SDK reads it, or null when the SDK gives none; a read that fails throws, so the caller reports it as unread,
 * never as a pass.
 */
async function readLiveBpf(sdk, id) {
  await sdk.fetchArtifact(ARTIFACT, id, { overwrite: true });
  const art = await sdk.getArtifact(ARTIFACT, id);
  return art && typeof art === 'object' ? art : null;
}

/**
 * Why `art` (the flow read by the group's bound id) is not what the committed flow `group` last proved, as [{ code, message }].
 * The read must be the bound row and a flow of the group's table, as the helper requires of its own reads (bpf-settlement.js
 * readBody): a reader that answers another row is not evidence about this one.
 */
function bpfProofIssues(group, art) {
  if (!art || typeof art !== 'object') return [{ code: 'bpf-changed', message: 'the flow was not found by its bound id' }];
  const view = settlement().projectBpf(art);
  if (view.unsupported) return [{ code: 'bpf-shape-unsupported', message: `the flow now has a shape the build does not manage (${view.unsupported})` }];
  const boundId = bareId(group && group.root && group.root.id);
  const settled = (group && group.declaration && group.declaration.flow) || {};
  if (bareId(art.id) !== boundId || view.projection.entity !== lc(settled.entity)) {
    return [{ code: 'bpf-changed', message: `the read answered another flow than the bound ${boundId} of ${lc(settled.entity)}` }];
  }
  const proof = (group && group.proof) || {};
  if (intentSha256({ projection: view.projection, status: view.status }) !== proof.savedSha256) {
    return [{ code: 'bpf-changed', message: `the flow (now ${view.status}) is not what its last build proved: its body or its state changed outside the spec` }];
  }
  return [];
}

/**
 * verify's check of one committed flow group the spec still declares: bpfProofIssues, plus whether the spec's declaration is one
 * the group has applied. That is the helper's own test: bpf-settlement.js structureErrors over the stages the group holds (a held
 * stage or step left out, or put in another order, is refused by a build) and editsOf over what the group applied (an omitted
 * description, order or status keeps its live value, so it is not a change here either, as it is not for the build); and the
 * flow's table and name, which a build never changes on a managed flow. `group.declaration` is the group's
 * consumerState.declaration as the manifest view carries it ({ flow, applied, backing }); a group without one is listed as
 * unverified by the caller, never passed or failed here. The stages the group holds are not in the manifest view, so the
 * structure is checked against the keys of what it applied, which are the same stages and steps in the same order.
 */
function verifyDeclaredBpf({ flow, group, art }) {
  const { editsOf, structureErrors, EDIT_REFUSED_REMEDY } = settlement();
  const issues = bpfProofIssues(group, art);
  const settled = group.declaration.flow || {};
  const applied = group.declaration.applied || { stages: [] };
  if (lc(settled.entity) !== lc(flow.entity) || String(settled.name) !== String(flow.name)) {
    issues.push({ code: 'bpf-declaration-changed', message: `the spec names this flow ${lc(flow.entity)}/${flow.name} and its last build settled ${lc(settled.entity)}/${settled.name}; a build does not rename or move a managed flow` });
  }
  const held = (applied.stages || []).map((s) => ({ key: s.key, steps: (s.steps || []).map((p) => ({ key: p.key })) }));
  const structure = structureErrors(held, flow);
  if (structure.length) {
    issues.push({ code: 'bpf-declaration-changed', message: `the spec's declaration ${structure.join(', ')}; stages and steps are never removed or moved, so a build refuses it` });
  }
  const edits = editsOf(applied, flow);
  if (edits.length) {
    issues.push({ code: 'bpf-declaration-changed', message: `the spec's declaration ${edits.join(', ')}, which is not on the flow yet. ${EDIT_REFUSED_REMEDY}` });
  }
  return issues;
}

/**
 * The explicit managed download's restore (--include-managed --managed-manifest <file>): for each committed flow group of the
 * store file (readManagedFormFile, family 'bpf'), the declaration it was built from (its originalDeclaration, stage and step keys
 * included), put in `spec.businessProcessFlows` (mutated) in key order. The plain download reconstructs no process flow, so a
 * restored declaration is appended, or REPLACES an entry for the same table and name if one is there. A group is restored only when
 *   - the store keeps its original declaration, and it is a declared flow,
 *   - a fresh read of its bound flow through `sdk` (the download's own throwaway SDK) answers,
 *   - that read certifies the group's last proof (bpfProofIssues answers none),
 *   - every persona its securityRoles name is declared in the downloaded spec, or is read from its role and proved to rebuild
 *     that role exactly with the flow's grants already on it (lib/persona-restore.js; then it is added to `spec.personas`), and
 *   - the downloaded spec still validates with it (`validate`, the download's own validator).
 * Every other group (unread, changed since, not valid here, or still pending or unusable in the store) is answered in `stale` with
 * its reason, never silently dropped. Answers { restored: [key], stale: [{ key, reason }], personas?: [{ name, flows: [key] }] },
 * `personas` only when one was written; a store file that cannot be used
 * throws `managed-manifest-unusable`. `fragments`, when given, is an array a stale flow is pushed onto (noteBpfFragment) when its
 * declaration is proved and left out only for the personas it names; the caller writes them to the fragments file
 * (lib/managed-fragments.js).
 */
async function restoreManagedBpfs({ sdk, spec, file, environment, appUniqueName, solutionUniqueName, validate, fragments }) {
  const { groups, pending, invalid } = readManagedFormFile({ file, environment, appUniqueName, solutionUniqueName }, 'bpf');
  const restored = [];
  const stale = [
    ...pending.map((p) => ({ key: p.key, reason: `its last attempt is not settled (${p.code}); build again to settle it` })),
    ...invalid.map((p) => ({ key: p.key, reason: `its stored record is not usable (${p.reason})` })),
  ];
  if (!groups.size) return { restored, stale: sortByKey(stale) };
  const base = validate(spec);
  // The personas this download writes, by lower-cased name -> { name, flows }, and the prover that reads them (made at first need).
  const written = new Map();
  let prover = null;
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key);
    const id = bareId(group.root && group.root.id);
    if (!base || !base.ok) { stale.push({ key, reason: 'the downloaded spec does not validate on its own, so no process flow is restored into it' }); continue; }
    const declaration = group.originalDeclaration && typeof group.originalDeclaration === 'object' ? clone(group.originalDeclaration) : null;
    if (!declaration || declaration.reconcile !== 'declared') { stale.push({ key, reason: 'the store keeps no original declaration for it; build again to record one' }); continue; }
    // The store file keeps the raw group: its settled declaration is the helper's consumerState.declaration, the shape verify's
    // manifest view names declaration (managed-bindings.js managedManifestView).
    const settled = group.consumerState && group.consumerState.declaration;
    if (!settled || !settled.flow) { stale.push({ key, reason: 'the store keeps no settled declaration for it; build again to record one' }); continue; }
    let art;
    try {
      art = await readLiveBpf(sdk, id);
    } catch (e) {
      stale.push({ key, reason: `process flow ${id} could not be read (${(e && e.message) || e})` });
      continue;
    }
    if (!art) { stale.push({ key, reason: `process flow ${id} was not found` }); continue; }
    const issues = bpfProofIssues({ ...group, declaration: settled }, art);
    if (issues.length) { stale.push({ key, reason: `process flow ${id} is not what its last build proved (${issues.map((i) => i.code).join(', ')}); build again to prove it` }); continue; }
    const flows = Array.isArray(spec.businessProcessFlows) ? spec.businessProcessFlows : [];
    const at = flows.findIndex((f) => f && lc(f.entity) === lc(declaration.entity) && lc(f.name) === lc(declaration.name));
    const next = at >= 0 ? flows.map((f, i) => (i === at ? declaration : f)) : [...flows, declaration];
    // A flow's securityRoles name personas of the spec it was built from, and a persona is not a reference: the build OWNS
    // its role and converges it onto exactly the privileges declared (ReplacePrivilegesRole). So a persona the downloaded
    // spec lacks is written only when it is read from its role and PROVED to rebuild that role exactly, and the flow's grants
    // are already on it (lib/persona-restore.js). A persona this download wrote for an earlier flow needs this flow's grants
    // proved too. The flow is not restored without its roles either (that would drop authored intent): when any persona is
    // not proved, it is left out with what to copy.
    const missing = personasNotIn(spec, declaration);
    const own = personasWrittenFor(declaration, written);
    const add = [];
    if (missing.length || own.length) {
      prover = prover || require('./persona-restore.js').createPersonaProver({ sdk, appUniqueName, solutionUniqueName });
      // The flow is proved above, so its projection is readable; a throw here still only leaves the grants unproved.
      let backing = '';
      try { backing = settlement().projectBpf(art).uniqueName; } catch { /* flowGrantsMissing refuses an unknown table */ }
      const failed = [];
      // A name listed twice (in any case) is proved and written once: two entries would be a duplicate persona.
      const seen = new Set();
      for (const name of [...missing, ...own]) {
        if (seen.has(lc(String(name).trim()))) continue;
        seen.add(lc(String(name).trim()));
        const proof = await prover.prove(name);
        const why = proof.ok ? await prover.flowGrantsMissing(proof, backing) : proof.why;
        if (why) failed.push(`persona '${name}', which the download could not prove from its role: ${why}`);
        else if (missing.includes(name) && !add.some((p) => lc(p.name) === lc(proof.name))) add.push(proof);
      }
      if (failed.length) {
        const reason = `its securityRoles name ${failed.join('; ')}; copy this flow and the personas it names from the spec it was built from`;
        stale.push({ key, reason });
        noteBpfFragment(fragments, { key, reason, spec, declaration, next, missing, validate });
        continue;
      }
    }
    const personas = add.length ? [...(Array.isArray(spec.personas) ? spec.personas : []), ...add.map((p) => p.persona)] : null;
    const check = validate({ ...spec, ...(personas ? { personas } : {}), businessProcessFlows: next });
    if (!check || !check.ok) {
      const errors = ((check && check.errors) || []).slice(0, 3).map((x) => (typeof x === 'string' ? x : (x && x.message) || JSON.stringify(x)));
      stale.push({ key, reason: `its declaration does not validate in the downloaded spec (${errors.join('; ') || 'invalid'})` });
      continue;
    }
    spec.businessProcessFlows = next;
    if (personas) spec.personas = personas;
    for (const p of add) written.set(lc(p.name), { name: p.name, flows: [key] });
    for (const name of new Set(own.map((n) => lc(String(n).trim())))) written.get(name).flows.push(key);
    restored.push(key);
  }
  const personas = [...written.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { restored, stale: sortByKey(stale), ...(personas.length ? { personas } : {}) };
}

// The personas a flow declaration's securityRoles name that this download wrote for an earlier flow (`written`, by lower-cased
// trimmed name), in declaration order.
function personasWrittenFor(declaration, written) {
  const named = declaration.securityRoles && Array.isArray(declaration.securityRoles.personas) ? declaration.securityRoles.personas : [];
  return named.filter((p) => written.has(lc(String(p).trim())));
}

function sortByKey(list) {
  return list.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

// A proved flow left out only for the personas its securityRoles name goes to the fragments file (lib/managed-fragments.js),
// ready to paste. "Only" is checked, not assumed: the spec must validate with the flow (`next`, the flows it would hold) and a
// stub for each missing persona. The stubs are never written. Without a collector nothing is noted.
function noteBpfFragment(fragments, { key, reason, spec, declaration, next, missing, validate }) {
  if (!Array.isArray(fragments)) return;
  const { stubPersona } = require('./managed-fragments.js');
  const personas = [...(Array.isArray(spec.personas) ? spec.personas : []), ...missing.map((p) => stubPersona(String(p).trim(), declaration.entity))];
  const check = validate({ ...spec, personas, businessProcessFlows: next });
  if (!check || !check.ok) return;
  fragments.push({ family: 'bpf', key, reason, needs: missing.map((p) => ({ persona: String(p).trim() })), paste: { businessProcessFlows: [declaration] } });
}

// The personas a flow declaration's securityRoles name that `spec.personas` does not declare, in declaration order,
// matched as the spec validator matches them (app-spec.js: the trimmed persona name, case-insensitively).
function personasNotIn(spec, declaration) {
  const named = declaration.securityRoles && Array.isArray(declaration.securityRoles.personas) ? declaration.securityRoles.personas : [];
  if (!named.length) return [];
  const { canonicalPersonaName } = require('./app-spec.js');
  const declared = new Set((Array.isArray(spec.personas) ? spec.personas : []).map((p) => String(canonicalPersonaName(p) || '').toLowerCase()));
  return named.filter((p) => !declared.has(String(p).trim().toLowerCase()));
}

// The declared flows the spec holds, by the key a committed flow group is stored under (bpf-settlement.js bpfKey:
// `<table>/<name>`, the table in lower case). Loads the helper, so the caller asks only when a committed flow group is there.
function declaredBpfsByKey(flows) {
  const { isDeclaredBpf, bpfKey } = settlement();
  const out = new Map();
  for (const f of (Array.isArray(flows) ? flows : [])) if (isDeclaredBpf(f)) out.set(bpfKey(f), f);
  return out;
}

module.exports = { readLiveBpf, bpfProofIssues, verifyDeclaredBpf, restoreManagedBpfs, declaredBpfsByKey };
