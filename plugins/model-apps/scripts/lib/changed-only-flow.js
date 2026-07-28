'use strict';
// `--changed-only` orchestration flow (changed-only design, deliverable #5 flow — the capstone).
//
// Ties the offline pieces together into a SAFE partial apply. On `--apply --changed-only` the flow:
//   1. reads the persisted snapshot envelope + resolves LIVE identity (WhoAmI orgId + app discovery),
//   2. content-annotates the spec and CLASSIFIES the diff (classify-changes.js),
//   3. GATES the fast path on snapshot eligibility (identity match + eligible + empty debt + not
//      tombstoned — apply-snapshot.js), and
//   4. either runs a pages-only fast apply through the sdk-build seams, or falls back to a full build.
// It is FAIL-CLOSED end to end: anything not provably a wired convergent shape → full build (always safe,
// just not optimized), and every state-changing path INVALIDATES the snapshot before it writes.
//
// v1 wires exactly ONE convergent shape end-to-end: page-content re-upload (the `.tsx` byte edit). A
// view-append / sitemap / form edit is a valid fast SHAPE (classify recognizes it) but its phase submode
// is not wired yet, so v1 routes it to a full build — which converges it correctly (the additive engine
// unions view columns, rewrites the sitemap, and reconciles form fields on a full run). Charts/commands/
// dashboards/web-resource-content edits are additive-SKIPPED even by a full build, so they record sticky
// DEBT that keeps the snapshot ineligible until a teardown+rebuild recreates them fresh.
//
// The heavy lifting (state machine, store, classifier, index) is unit-tested in isolation; this module is
// the decision + sequencing seam, injectable (deps.buildModelApp / deps.sdk / deps.whoAmI) so the
// sequencing is testable offline without a live env.

const { annotateContentHashes } = require('./content-hash.js');
const { classifyChanges } = require('./classify-changes.js');
const snap = require('./apply-snapshot.js');
const store = require('./apply-snapshot-store.js');
const { indexArtifacts } = require('./apply-snapshot-index.js');
const { odataLit } = require('./odata.js');

// ---- PURE decision ------------------------------------------------------------------------------------

// Decide fast vs full vs noop from the annotated spec, the persisted snapshot, and the live identity.
// Returns { decision:'fast'|'full'|'noop', reason, classify, pageKeys?, gateReason }.
function decideChangedOnly({ annotatedSpec, snapshot, live }) {
  const prior = snapshot ? snapshot.priorSpec : null;
  const classify = classifyChanges(annotatedSpec, prior);
  const gate = snap.isFastPathEligible(snapshot, live);

  // No prior snapshot → this run establishes the changed-only baseline via a full build.
  if (!snapshot) {
    return { decision: 'full', reason: 'no snapshot — establishing the changed-only baseline via a full build', classify, gateReason: 'no snapshot' };
  }
  // Snapshot exists but is not fast-eligible (identity mismatch / tombstoned / invalidated / carries
  // debt) → full build (fail-closed). The full build then re-persists the snapshot (with sticky debt).
  if (!gate.eligible) {
    return { decision: 'full', reason: `full build — ${gate.reason}`, classify, gateReason: gate.reason };
  }
  // Eligible + nothing changed → already up to date.
  if (classify.verdict === 'noop') {
    return { decision: 'noop', reason: 'no changes since the last apply', classify, gateReason: gate.reason };
  }
  // Eligible + EVERY change is the wired page-content shape → pages-only fast apply.
  if (classify.verdict === 'fast' && classify.fastChanges.length > 0 && classify.fastChanges.every((c) => c.shape === 'page')) {
    const pageKeys = classify.fastChanges.map((c) => c.identity);
    return { decision: 'fast', reason: `pages-only fast apply (${pageKeys.length} changed page(s): ${pageKeys.join(', ')})`, classify, pageKeys, gateReason: gate.reason };
  }
  // Eligible, but the change needs a full build: an unsupported edit (classify.verdict==='full'), or a
  // fast shape not yet wired for a partial run (v1 wires pages only — view/sitemap/form fall here and a
  // full build converges them safely).
  const why = classify.verdict === 'full'
    ? classify.fullReasons.join('; ')
    : 'change includes a fast shape not yet wired for a partial run (v1 fast path = page content only)';
  return { decision: 'full', reason: `full build — ${why}`, classify, gateReason: gate.reason };
}

// ---- LIVE identity ------------------------------------------------------------------------------------

// Resolve the snapshot identity binding from the live env: orgId (WhoAmI) + appId (app discovery by unique
// name). Returns { orgId, envUrl, appUniqueName, appId } or null on failure (→ caller degrades to a normal
// full build without touching the snapshot — we must never gate a fast apply on an unverified identity).
// `whoAmI(envUrl)` and `sdk.queryRecords` are injected so this is testable offline.
async function resolveLiveIdentity({ sdk, envUrl, appUniqueName, whoAmI }) {
  let orgId = null;
  try {
    // WhoAmI is the standard Dataverse function; its response carries OrganizationId (PascalCase).
    // https://learn.microsoft.com/power-apps/developer/data-platform/webapi/reference/whoami
    const who = await whoAmI(envUrl);
    const data = who && (who.data || who); // dataverseRequest returns { status, data }; tolerate either
    orgId = (data && (data.OrganizationId || data.organizationId)) || null;
  } catch { return null; }
  if (!orgId) return null;
  let appId = null;
  try {
    // App discovery by unique name (same appmodule query fetchSitemap uses). appId is a SECONDARY identity
    // signal — a fresh baseline (app not yet created) legitimately resolves null, so a miss is tolerated;
    // identityMatches only compares appId when BOTH the snapshot and live carry one.
    const apps = await sdk.queryRecords('appmodule', { select: ['appmoduleid'], filter: `uniquename eq '${odataLit(appUniqueName)}'`, top: 1 });
    appId = (apps && apps[0] && apps[0].appmoduleid) || null;
  } catch { appId = null; }
  return { orgId, envUrl, appUniqueName, appId };
}

// ---- snapshot assembly (post-apply) -------------------------------------------------------------------

// Assemble the eligible/ineligible baseline snapshot to persist after a FULL apply. Sticky-debt rule (Sol
// build-time note): the new snapshot inherits the prior snapshot's debt UNION this build's classify debt,
// and is eligible ONLY when the union is empty. A plain full rebuild never clears debt (the additive engine
// re-skips a stale chart/command/dashboard/web-resource edit); debt clears only when the snapshot is
// DELETED by a clean teardown and re-created fresh (no prior → no sticky debt → eligible).
function assembleBaselineSnapshot({ annotatedSpec, created, live, prior }) {
  const classify = classifyChanges(annotatedSpec, prior ? prior.priorSpec : null);
  const appId = (created && created.app) || (live && live.appId) || null;
  const env = snap.makeEnvelope({
    orgId: live.orgId,
    envUrl: live.envUrl,
    appUniqueName: live.appUniqueName,
    appId,
    solutionUniqueName: annotatedSpec.solution && annotatedSpec.solution.uniqueName,
  });
  // priorSpec is the full annotated spec (INCLUDING sampleData) — the diff compares the same shape on both
  // sides, so stripping rows (the design's bloat note) would make sampleData read as perpetually changed.
  env.priorSpec = annotatedSpec;
  env.artifacts = indexArtifacts(annotatedSpec, created);
  for (const d of (prior && Array.isArray(prior.debt) ? prior.debt : [])) snap.addDebt(env, d);
  for (const d of classify.debt) snap.addDebt(env, d);
  snap.markEligible(env); // fail-closed: stays ineligible if the debt union is non-empty
  return env;
}

// Refresh the snapshot after a pages-only FAST apply: keep the eligible envelope, update priorSpec and the
// re-uploaded pages' hashes (source==deployed, they were just uploaded), refresh any returned pageId (an
// UPDATE returns the SAME id — I7). Stays eligible (we only reach a fast apply from an eligible snapshot
// with page-only changes, so there is no new debt). Bumps the generation for the CAS write.
function assembleFastSnapshot({ snapshot, annotatedSpec, created, generation }) {
  const env = snap.parseEnvelope(snap.serializeEnvelope(snapshot)); // deep clone
  env.priorSpec = annotatedSpec;
  if (!env.artifacts) env.artifacts = {};
  if (!env.artifacts.pages) env.artifacts.pages = {};
  for (const p of annotatedSpec.pages || []) {
    if (!p || typeof p !== 'object') continue;
    const key = p.key || p.name;
    const sha = p.__contentSha != null ? p.__contentSha : null;
    const pageId = (created && created.pages && created.pages[key]) || (env.artifacts.pages[key] && env.artifacts.pages[key].pageId) || null;
    if (pageId == null && sha == null) continue;
    env.artifacts.pages[key] = { pageId, sourceSha: sha, deployedSha: sha };
  }
  env.eligible = true;
  snap.bumpGeneration(env, generation);
  return env;
}

// ---- orchestration ------------------------------------------------------------------------------------

// Run the `--apply --changed-only` flow. `deps.buildModelApp` is injected (no require cycle) so this
// module orchestrates without importing the CLI wrapper; `deps.buildDeps` is the deps object passed
// through to buildModelApp (sdk/provisionSdk/journal/verify/log). Returns the buildModelApp result
// augmented with `.changedOnly` (the decision), or a noop/abort result.
async function runChangedOnlyApply({ spec, opts, deps }) {
  const log = deps.log || (() => {});
  const ws = opts.workspaceDir;
  const annotate = (s) => annotateContentHashes(s, deps.readContent);
  const annotatedSpec = annotate(spec);
  const snapshot = store.readSnapshot(ws);
  const live = await deps.resolveLiveIdentity();

  // No trustworthy live identity → we cannot safely gate a fast apply. Degrade to a normal full build and
  // do NOT touch the snapshot (writing one we can't identity-bind would be worse than none).
  if (!live) {
    log('▸ changed-only: could not resolve live identity (WhoAmI/app discovery) — running a normal full build');
    const r = await deps.buildModelApp(spec, fullApplyOpts(opts), deps.buildDeps);
    return { ...r, changedOnly: { decision: 'full', reason: 'no live identity' } };
  }

  const decision = decideChangedOnly({ annotatedSpec, snapshot, live });
  log(`▸ changed-only: ${decision.decision.toUpperCase()} — ${decision.reason}`);

  if (decision.decision === 'noop') {
    log('✓ nothing to apply — the deployed app already matches the spec (per the last verified apply)');
    return { ok: true, dryRun: false, noop: true, created: null, changedOnly: decision };
  }

  if (decision.decision === 'fast') {
    // INVALIDATE-before-write: force the snapshot ineligible BEFORE the fast apply writes anything, so a
    // crash mid-upload can never leave a stale "eligible" snapshot. A failed invalidate means lease
    // contention (another build) → ABORT rather than risk two concurrent builds of the same app.
    const inv = store.invalidateSnapshot(ws);
    if (!inv.ok) {
      const msg = `changed-only: could not invalidate the snapshot before the fast apply (${inv.reason}) — aborting to avoid an unsafe partial write`;
      log(`✗ ${msg}`);
      return { ok: false, errors: [msg], changedOnly: decision };
    }
    const fastOpts = { ...fullApplyOpts(opts), phases: ['pages'], changedOnly: { fastApply: true, resolvedAppId: live.appId, skipSitemapFinalize: true } };
    const r = await deps.buildModelApp(spec, fastOpts, deps.buildDeps);
    // Re-persist the eligible snapshot ONLY on a fully successful, verified apply. Under CAS (expected =
    // the generation we read, which invalidate preserved) so a concurrent writer is detected. A CAS miss
    // leaves the snapshot invalidated — safe (the next run just does a full build).
    if (r && r.ok && !r.dryRun && (!r.verify || r.verify.ok)) {
      const refreshed = assembleFastSnapshot({ snapshot, annotatedSpec, created: r.created, generation: snap.newGeneration() });
      const cas = store.casWriteSnapshot(ws, refreshed, snapshot.generation);
      if (!cas.ok) log(`▸ changed-only: fast apply succeeded but the snapshot was not re-blessed (${cas.reason}) — the next run will do a full build`);
      else log('✓ changed-only: fast apply verified; snapshot re-blessed eligible');
    }
    return { ...r, changedOnly: decision };
  }

  // FULL build (baseline, ineligible-snapshot fallback, or an unsupported/unwired change).
  if (snapshot) {
    const inv = store.invalidateSnapshot(ws);
    if (!inv.ok) {
      const msg = `changed-only: could not invalidate the snapshot before the full apply (${inv.reason}) — aborting to avoid a concurrent build`;
      log(`✗ ${msg}`);
      return { ok: false, errors: [msg], changedOnly: decision };
    }
  }
  const r = await deps.buildModelApp(spec, fullApplyOpts(opts), deps.buildDeps);
  if (r && r.ok && !r.dryRun && (!r.verify || r.verify.ok)) {
    // Re-resolve identity so a fresh baseline records the now-created appId (the app did not exist before
    // this build). created.app already carries it, so this is belt-and-suspenders.
    let liveForWrite = live;
    if (!live.appId) { const relive = await deps.resolveLiveIdentity(); if (relive) liveForWrite = relive; }
    const env = assembleBaselineSnapshot({ annotatedSpec, created: r.created, live: liveForWrite, prior: snapshot });
    const wrote = store.casWriteSnapshot(ws, env, snapshot ? snapshot.generation : null);
    if (!wrote.ok) log(`▸ changed-only: full apply succeeded but the snapshot was not persisted (${wrote.reason})`);
    else log(`✓ changed-only: baseline snapshot ${env.eligible ? 'ELIGIBLE' : 'recorded INELIGIBLE (open debt — a future edit needs a full build)'}`);
  }
  return { ...r, changedOnly: decision };
}

// Force a FULL-phase apply: changed-only decides its own phases, so it must ignore any --stage/--only/etc.
// selection carried on opts (main() also rejects combining them). phases:undefined → sdk-build uses PHASES.
function fullApplyOpts(opts) {
  const o = { ...opts };
  delete o.phases;
  delete o.changedOnly;
  return o;
}

module.exports = {
  decideChangedOnly,
  resolveLiveIdentity,
  assembleBaselineSnapshot,
  assembleFastSnapshot,
  runChangedOnlyApply,
  fullApplyOpts,
};
