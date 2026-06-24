#!/usr/bin/env node

// Dataverse-only reconciliation for the clone-based selective-merge conflict
// resolver. The merged file has already been pushed to the bound ADO branch by
// the caller; this module only performs the platform round-trip:
// RefreshChangesFromGit → accept incoming → PullChangesFromGit → verify.

'use strict';

const { toLF, stripBom } = require('./eol-bom');
const { extractYamlValue, isFlatYmlUnit } = require('./flat-yml-merge');

const defaultDeps = {
  refreshChangesFromGit: require('./refresh-changes-from-git').refreshChangesFromGit,
  resolveGitConflictUserAction: require('./resolve-git-conflict-useraction').resolveGitConflictUserAction,
  resolveConflictAccept: require('./resolve-conflict-accept').resolveConflictAccept,
  pullChangesFromGit: require('./pull-changes-from-git').pullChangesFromGit,
  listConflicts: require('./list-conflicts').listConflicts,
  readComponentContent: require('./read-component-content').readComponentContent,
  resolveSolutionId: require('./resolve-conflict-common').resolveSolutionIdByUniqueName,
  runState: require('./merge-run-state'),
  readWebFileBytes: (() => { try { return require('./read-web-file-bytes').readWebFileBytes; } catch (_) { return null; } })(),
  patchWebFileBytes: (() => { try { return require('./read-web-file-bytes').patchWebFileBytes; } catch (_) { return null; } })(),
};

const ABSENT_ACTION_HINT = /Resource not found for the segment 'ResolveGitConflict'|ResolveGitConflict/i;
const PHASES = Object.freeze(['started', 'accepted', 'pulled', 'verified']);

function isActionAbsent(res) {
  if (!res) return false;
  if (res.statusCode === 404 && ABSENT_ACTION_HINT.test(String(res.error || ''))) return true;
  return false;
}

function phaseRank(phase) {
  return PHASES.indexOf(phase);
}

function isAtOrBeyond(runState, current, target) {
  if (!current) return false;
  if (runState && typeof runState.isAtOrBeyond === 'function') return runState.isAtOrBeyond(current, target);
  return phaseRank(current) >= phaseRank(target);
}

// Index + 1-based line of the first differing character between two strings.
// Returns null when they are identical. Only positional metadata is exposed —
// never the differing content — so verification never leaks component source.
function firstDivergence(want, got) {
  const n = Math.min(want.length, got.length);
  let i = 0;
  while (i < n && want[i] === got[i]) i++;
  if (i === n && want.length === got.length) return null;
  return { index: i, line: want.slice(0, i).split('\n').length };
}

async function reconcileDataverse({
  components, envUrl, solutionUniqueName, solutionId = null, dvToken = null,
  runId = null, apply = false, resumeFrom = null, priorAcceptResults = null,
  writeState = true, runStateDir = null, deps = null,
} = {}) {
  if (!Array.isArray(components) || components.length === 0) throw new Error('components must be a non-empty array');
  if (!envUrl) throw new Error('envUrl is required');
  if (!solutionUniqueName) throw new Error('solutionUniqueName is required');
  // Allow PARTIAL deps injection (e.g. just `readBranchContent` from the
  // clone-backed orchestrator) layered over the real defaults — callers no longer
  // need to rebuild the whole dep set to override one function.
  deps = { ...defaultDeps, ...(deps || {}) };

  const id = runId || `reconcile-${Date.now()}`;
  const plan = {
    runId: id,
    apply,
    wouldRefresh: true,
    wouldAccept: components.map((c) => c.conflictId).filter(Boolean),
    wouldPull: true,
    componentCount: components.length,
  };

  if (!apply) {
    return buildResult({ status: 'dry-run', plan, steps: [], id, accepted: [], conflictsRemaining: null, contentVerify: [] });
  }

  const steps = [];
  const record = (step, result) => { steps.push({ step, ...result }); return result; };
  const safeName = (c) => String(c.name || c.componentId || 'component').replace(/[^a-z0-9._-]+/gi, '_');
  const componentMeta = components.map((c) => ({
    name: c.name || null,
    componentId: c.componentId || null,
    conflictId: c.conflictId || null,
    field: c.field || null,
    type: c.type != null ? c.type : null,
    adoPath: c.adoPath || null,
    safe: safeName(c),
  }));
  const persistState = (phase, extra = {}) => {
    if (!writeState || !runStateDir) return;
    const state = { phase, envUrl, solutionUniqueName, solutionId, components: componentMeta, ...extra };
    try {
      if (deps.runState && typeof deps.runState.writeRunState === 'function') deps.runState.writeRunState(runStateDir, { ...state, runId: id });
    } catch (_) { /* best-effort; recovery is a convenience, never blocks reconcile */ }
  };
  const resuming = (target) => isAtOrBeyond(deps.runState, resumeFrom, target);

  if (!resumeFrom) persistState('started');

  if (!resuming('accepted')) {
    const refresh = record('refresh', await deps.refreshChangesFromGit({ envUrl, token: dvToken, solutionUniqueName }));
    if (refresh && refresh.error) {
      persistState('started', { status: 'partial', error: `RefreshChangesFromGit failed: ${refresh.error}` });
      return buildResult({ status: 'partial', plan, steps, id, accepted: [], conflictsRemaining: null, contentVerify: [], error: `RefreshChangesFromGit failed: ${refresh.error}` });
    }
  }

  // Resolve solutionId from solutionUniqueName when not supplied, so the
  // useraction accept path (which needs the solution partition) is never silently
  // skipped. A caller passing only solutionUniqueName would otherwise fall back to
  // the often-absent ResolveGitConflict (IL-015) and hit manual-resolution-required
  // even though useraction would have worked. (Live-found on sri-alm-dev-1, 2026-06-19.)
  let effectiveSolutionId = solutionId;
  if (!effectiveSolutionId && solutionUniqueName && envUrl && typeof deps.resolveSolutionId === 'function' && !resuming('accepted')) {
    try {
      effectiveSolutionId = await deps.resolveSolutionId({ base: String(envUrl).replace(/\/+$/, ''), token: dvToken, solutionUniqueName });
    } catch (_) { effectiveSolutionId = null; }
    record('resolve-solution-id', { ok: !!effectiveSolutionId, solutionId: effectiveSolutionId || null, from: solutionUniqueName });
  }

  let portalFallback = false;
  let acceptResults = [];

  // A5: detect CONVERGED ("phantom") conflicts up front — components whose env
  // value already equals the bound-branch file (byte-identical after LF/BOM strip).
  // For these, accept-incoming (useraction=2) does NOT clear the action=3 row (it
  // loops forever); keep-current (useraction=1) does. We flip their decision to
  // keep-current. Requires the injected clone-backed `readBranchContent`; when it's
  // absent (older callers / unit tests) detection is skipped and behavior is
  // unchanged. (Live-found on sri-alm-dev-1: two site settings looped indefinitely.)
  const norm = (s) => toLF(stripBom(String(s == null ? '' : s)));
  const decisionByComponent = new Map(); // componentId → overridden decision
  const convergedNames = [];
  if (typeof deps.readBranchContent === 'function' && typeof deps.readComponentContent === 'function' && !resuming('accepted')) {
    for (const c of components) {
      if (!c.componentId || !c.adoPath) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        const envRead = await deps.readComponentContent({ envUrl, token: dvToken, componentId: c.componentId, componentType: c.type, name: c.name });
        // eslint-disable-next-line no-await-in-loop
        const branch = await deps.readBranchContent({ adoPath: c.adoPath });
        if (!envRead || envRead.error || branch == null) continue;
        const field = c.field || (envRead.mergeFields && envRead.mergeFields[0] && envRead.mergeFields[0].key);
        const mf = (envRead.mergeFields || []).find((f) => f.key === field) || (envRead.mergeFields || [])[0];
        const envVal = mf ? mf.value : null;
        // Flat-YML site setting: the branch file is the whole .sitesetting.yml, but the
        // env value is the scalar — compare against the branch's `value:` line.
        const branchCmp = isFlatYmlUnit(c) ? extractYamlValue(branch) : branch;
        if (envVal != null && branchCmp != null && norm(envVal) === norm(branchCmp)) {
          decisionByComponent.set(c.componentId, 'keep-current');
          convergedNames.push(c.name);
        }
      } catch (_) { /* detection is best-effort; never blocks reconcile */ }
    }
    if (convergedNames.length) record('detect-converged', { ok: true, converged: convergedNames });
  }
  const decisionFor = (c) => decisionByComponent.get(c.componentId) || c.decision || 'accept-incoming';

  if (resuming('accepted')) {
    acceptResults = Array.isArray(priorAcceptResults) ? priorAcceptResults : [];
    record('accept-incoming', { ok: true, results: acceptResults, resumed: true });
  } else {
    for (const c of components) {
      if (!c.conflictId) { acceptResults.push({ name: c.name, skipped: 'no-conflictId' }); continue; }

      // PRIMARY: PATCH useraction=2 on the sourcecontrolcomponent row (the Maker
      // Portal mechanism — HAR-confirmed). Works even when ResolveGitConflict is
      // absent (IL-015). Needs the solutionId (partition) + the component id.
      let accepted = false;
      if (effectiveSolutionId && c.componentId) {
        // eslint-disable-next-line no-await-in-loop
        const ua = await deps.resolveGitConflictUserAction({
          envUrl, token: dvToken, solutionId: effectiveSolutionId, componentId: c.componentId, decision: decisionFor(c),
        });
        if (ua && ua.ok) { acceptResults.push({ name: c.name, conflictId: c.conflictId, result: 'accepted', via: 'useraction', decision: decisionFor(c) }); accepted = true; }
        else if (ua && ua.notFound) {
          // No action=3 conflict row exists for this component. This is NOT a
          // failure and NOT a reason to invoke the often-absent ResolveGitConflict
          // (doing so falsely escalates the WHOLE run to 'manual-resolution-required'
          // on IL-015 tenants). After the merged commit + RefreshChangesFromGit the
          // component is either already converged or now a plain incoming Update that
          // the subsequent PullChangesFromGit applies — the post-pull content-verify
          // is the source of truth either way. Record it as resolved and skip the
          // fallback. (Live-found 2026-06-21, sri-alm-dev-1: a web template returned
          // notFound and was wrongly reported as needing a Maker Portal walkthrough
          // while the portal showed Conflicts:0 / the component already in Updates.)
          acceptResults.push({ name: c.name, conflictId: c.conflictId, result: 'already-resolved', via: 'no-conflict-row' });
          accepted = true;
        }
      }
      if (accepted) continue;

      // keep-current ('keep mine') is applied ONLY via the useraction PATCH; the
      // ResolveGitConflict fallback only ACCEPTS incoming, so never use it to
      // wrongly take theirs for a keep-mine component.
      if (decisionFor(c) === 'keep-current') {
        acceptResults.push({ name: c.name, conflictId: c.conflictId, result: 'keep-current-unconfirmed' });
        continue;
      }

      // FALLBACK: the ResolveGitConflict OData action (older/other tenants).
      // eslint-disable-next-line no-await-in-loop
      const r = await deps.resolveConflictAccept({ envUrl, token: dvToken, conflictId: c.conflictId, solutionUniqueName });
      if (isActionAbsent(r)) { portalFallback = true; acceptResults.push({ name: c.name, conflictId: c.conflictId, result: 'action-absent' }); }
      else if (r && r.error) acceptResults.push({ name: c.name, conflictId: c.conflictId, result: 'failed', error: r.error });
      else acceptResults.push({ name: c.name, conflictId: c.conflictId, result: 'accepted', via: 'resolvegitconflict' });
    }
    record('accept-incoming', { ok: !portalFallback, results: acceptResults, portalFallback });

    if (portalFallback) {
      persistState('started', { status: 'manual-resolution-required', acceptResults });
      return buildResult({
        status: 'manual-resolution-required',
        plan,
        steps,
        id,
        accepted: acceptResults,
        conflictsRemaining: null,
        contentVerify: [],
        resolvedVia: 'maker-portal',
        note: 'Programmatic accept unavailable on this tenant (no useraction row found and ResolveGitConflict absent — IL-015). The merged files are already on the bound ADO branch; accept the incoming changes in the Maker Portal Conflicts tab, then pull.',
      });
    }
    persistState('accepted', { acceptResults });
  }

  if (!resuming('pulled')) {
    const pull = record('pull', await deps.pullChangesFromGit({ envUrl, token: dvToken, solutionUniqueName }));
    if (pull && pull.error) {
      persistState('accepted', { acceptResults, status: 'partial', error: `PullChangesFromGit failed: ${pull.error}` });
      return buildResult({ status: 'partial', plan, steps, id, accepted: acceptResults, conflictsRemaining: null, contentVerify: [], error: `PullChangesFromGit failed: ${pull.error}` });
    }
    persistState('pulled', { acceptResults });
  }

  let remaining = record('verify', await deps.listConflicts({ envUrl, token: dvToken, solutionUniqueName }));
  let conflictsRemaining = remaining && typeof remaining.count === 'number' ? remaining.count : null;

  // A5: bounded retry — if conflicts persist after accept→pull (the classic phantom
  // loop where accept-incoming on a converged component never clears action=3), flip
  // the strategy to keep-current for the STILL-conflicting components ONCE, then
  // pull + re-verify. Bounded to a single extra pass so we can never loop forever.
  if (conflictsRemaining > 0 && !resuming('pulled') && effectiveSolutionId && typeof deps.resolveGitConflictUserAction === 'function') {
    const stillRows = (remaining && remaining.items) || [];
    const byId = new Map(components.filter((c) => c.componentId).map((c) => [c.componentId, c]));
    const flipped = [];
    for (const row of stillRows) {
      const c = byId.get(row.componentId);
      if (!c) continue;
      // eslint-disable-next-line no-await-in-loop
      const ua = await deps.resolveGitConflictUserAction({
        envUrl, token: dvToken, solutionId: effectiveSolutionId, componentId: c.componentId, decision: 'keep-current',
      });
      flipped.push({ name: c.name, componentId: c.componentId, ok: !!(ua && ua.ok) });
      decisionByComponent.set(c.componentId, 'keep-current'); // reflect in content-verify skip
    }
    if (flipped.length) {
      record('retry-flip-strategy', { ok: flipped.every((f) => f.ok), flipped });
      const pull2 = record('pull-retry', await deps.pullChangesFromGit({ envUrl, token: dvToken, solutionUniqueName }));
      if (!pull2 || !pull2.error) {
        remaining = record('verify-retry', await deps.listConflicts({ envUrl, token: dvToken, solutionUniqueName }));
        conflictsRemaining = remaining && typeof remaining.count === 'number' ? remaining.count : conflictsRemaining;
      }
    }
  }

  const contentVerify = [];
  const canVerify = typeof deps.readComponentContent === 'function' || typeof deps.readWebFileBytes === 'function';
  if (canVerify) {
    for (const c of components) {
      if (decisionFor(c) === 'keep-current') {
        // keep-mine: the env value is intentionally retained, so there is nothing
        // to verify against the merged/incoming content.
        contentVerify.push({ name: c.name, result: 'skipped', reason: 'keep-current (env value retained)' });
        continue;
      }

      // Webfile text unit: bytes in Dataverse are verified by re-reading via
      // readWebFileBytes (not readComponentContent, which has no web-file bytes).
      if (c.webfile === true) {
        if (!c.componentId || typeof c.mergedContent !== 'string') {
          contentVerify.push({ name: c.name, result: 'skipped', reason: 'missing componentId/mergedContent' });
          continue;
        }
        if (typeof deps.readWebFileBytes !== 'function') {
          contentVerify.push({ name: c.name, result: 'skipped', reason: 'readWebFileBytes not available' });
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        const re = await deps.readWebFileBytes({ envUrl, componentId: c.componentId, token: dvToken });
        if (!re || re.error) {
          contentVerify.push({ name: c.name, result: 'unverified', reason: (re && re.error) || 'read failed' });
          continue;
        }
        const gotText = toLF(stripBom(re.bytes.toString('utf8')));
        const wantText = toLF(stripBom(c.mergedContent));
        if (gotText === wantText) {
          contentVerify.push({ name: c.name, result: 'verified' });
          continue;
        }
        // Mismatch: the PullChangesFromGit did not apply the merged bytes to the
        // web-file record. Attempt a PATCH of documentbody (base64) as a fallback
        // so the merge isn't silently lost. Only runs when patchWebFileBytes is
        // injected (B2's discovered column; null by default until that lands).
        if (typeof deps.patchWebFileBytes === 'function') {
          const merged64 = Buffer.from(c.mergedContent, 'utf8').toString('base64');
          // eslint-disable-next-line no-await-in-loop
          const patchRes = await deps.patchWebFileBytes({ envUrl, componentId: c.componentId, token: dvToken, base64: merged64 });
          if (patchRes && patchRes.ok) {
            contentVerify.push({ name: c.name, result: 'patched-fallback', note: 'pull did not update bytes; patched via documentbody PATCH' });
            continue;
          }
        }
        const at = firstDivergence(wantText, gotText);
        contentVerify.push({ name: c.name, result: 'mismatch', ...(at ? { divergedAtLine: at.line, divergedAtIndex: at.index } : {}) });
        continue;
      }

      if (!c.componentId || !c.field || typeof c.mergedContent !== 'string') {
        contentVerify.push({ name: c.name, result: 'skipped', reason: 'missing componentId/field/mergedContent' });
        continue;
      }
      if (typeof deps.readComponentContent !== 'function') {
        contentVerify.push({ name: c.name, result: 'skipped', reason: 'readComponentContent not available' });
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const re = await deps.readComponentContent({ envUrl, token: dvToken, componentId: c.componentId, componentType: c.type, name: c.name });
      if (!re || re.error) { contentVerify.push({ name: c.name, field: c.field, result: 'unverified', reason: (re && re.error) || 'read failed' }); continue; }
      const mf = (re.mergeFields || []).find((f) => f.key === c.field);
      if (!mf) { contentVerify.push({ name: c.name, field: c.field, result: 'unverified', reason: 'field absent after pull' }); continue; }
      const got = toLF(stripBom(String(mf.value)));
      const want = toLF(stripBom(String(c.mergedContent)));
      if (got === want) { contentVerify.push({ name: c.name, field: c.field, result: 'verified' }); continue; }
      const at = firstDivergence(want, got);
      contentVerify.push({ name: c.name, field: c.field, result: 'mismatch', ...(at ? { divergedAtLine: at.line, divergedAtIndex: at.index } : {}) });
    }
    record('content-verify', { ok: !contentVerify.some((x) => x.result === 'mismatch'), checks: contentVerify });
  }

  const anyAcceptFailed = acceptResults.some((a) => a.result === 'failed');
  const anyContentMismatch = contentVerify.some((x) => x.result === 'mismatch');
  const status = (conflictsRemaining === 0 && !anyAcceptFailed && !anyContentMismatch) ? 'success' : 'partial';
  persistState(status === 'success' ? 'verified' : 'pulled', { acceptResults, status, conflictsRemaining });

  return buildResult({
    status,
    plan,
    steps,
    id,
    accepted: acceptResults,
    conflictsRemaining,
    contentVerify,
    resolvedVia: 'api',
    ...(anyContentMismatch ? { note: 'Pulled content does not match the merged result for one or more components (see contentVerify). The environment may have transformed or only partially applied the merge — review before retrying.' } : {}),
  });
}

function buildResult({ status, plan, steps, id, accepted, conflictsRemaining, contentVerify, error, resolvedVia = 'api', note }) {
  return {
    ok: status === 'dry-run' || status === 'success' || status === 'manual-resolution-required',
    status,
    runId: id,
    plan,
    steps,
    accepted,
    conflictsRemaining,
    contentVerify,
    resolvedVia,
    ...(note ? { note } : {}),
    ...(error ? { error } : {}),
  };
}

module.exports = { reconcileDataverse, isActionAbsent };
