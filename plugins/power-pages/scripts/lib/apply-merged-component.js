#!/usr/bin/env node

// Orchestrates the APPLY step of the selective-merge conflict flow — the
// product-lead "put the clean file in ADO, then accept the incoming changes to
// Dataverse" round-trip. Given the merged field content produced by the VS Code
// extension, it:
//
//   1. Snapshots OURS (current Dataverse content) for audit/reversibility.
//   2. Commits the merged file(s) to the bound ADO branch in ONE push (ado-commit-file).
//   3. RefreshChangesFromGit so Dataverse re-reads the now-merged branch tip.
//   4. Accept-incoming on each conflict (resolve-conflict-accept). If the
//      ResolveGitConflict action is absent (IL-015), reports portal fallback.
//   5. PullChangesFromGit so the merged content lands back in Dataverse.
//   6. Re-lists conflicts to verify Conflicts -> 0, writes last-conflict-resolution.json.
//
// Because the merged file already contains OURS's edits, accept-incoming loses
// nothing — every side is represented in the committed merge.
//
// SAFETY: this performs ADO + Dataverse MUTATIONS. It runs in DRY-RUN by default
// (returns the plan only); pass apply:true (CLI: --apply) to execute. The human
// consent gate lives in the skill/reference that calls this.
//
// Output (JSON to stdout): see buildResult below.
//
// Usage:
//   node apply-merged-component.js
//     --envUrl <url> --solutionUniqueName <name> --projectRoot <path>
//     --bindingFile <path> --resolvedFile <path>   // resolved = [{ conflictId, componentId, name, type, adoPath, oursContent?, mergedContent, changeType? }]
//     [--runId <id>] [--apply] [--token <dvToken>]

'use strict';

const fs = require('fs');
const path = require('path');
const mergeStore = require('./merge-artifact-store');
const { toLF, stripBom } = require('./propose-merge');
const runState = require('./merge-run-state');

const defaultDeps = {
  commitFiles: require('./ado-commit-file').commitFiles,
  refreshChangesFromGit: require('./refresh-changes-from-git').refreshChangesFromGit,
  resolveConflictAccept: require('./resolve-conflict-accept').resolveConflictAccept,
  resolveGitConflictUserAction: require('./resolve-git-conflict-useraction').resolveGitConflictUserAction,
  pullChangesFromGit: require('./pull-changes-from-git').pullChangesFromGit,
  listConflicts: require('./list-conflicts').listConflicts,
  readComponentContent: require('./read-component-content').readComponentContent,
  resolveSolutionId: require('./resolve-conflict-common').resolveSolutionIdByUniqueName,
  innerLoop: require('./inner-loop-paths'),
};

const ABSENT_ACTION_HINT = /Resource not found for the segment 'ResolveGitConflict'|ResolveGitConflict/i;

function isActionAbsent(res) {
  if (!res) return false;
  if (res.statusCode === 404 && ABSENT_ACTION_HINT.test(String(res.error || ''))) return true;
  return false;
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

/**
 * @param {object} args
 * @param {object} args.binding   { organization, project, repository, branch }
 * @param {Array}  args.components [{ conflictId, componentId, name, type, adoPath, mergedContent, changeType? }]
 * @param {string} args.envUrl
 * @param {string} args.solutionUniqueName
 * @param {string} [args.projectRoot]
 * @param {string} [args.runId]
 * @param {boolean} [args.apply]   false (default) = plan only; true = execute mutations.
 * @param {boolean} [args.secure]  true (default) = snapshot to the owner-only OS-temp store; false = legacy in-tree.
 * @param {string} [args.resumeFrom]  resume past a completed phase ('committed'|'accepted'|'pulled'); that phase is skipped.
 * @param {string} [args.priorCommitId]      reuse the ADO commit id from a prior run (resume).
 * @param {Array}  [args.priorAcceptResults] reuse accept results from a prior run (resume).
 * @param {boolean} [args.writeState]  true (default) = persist resumable run-state after each phase.
 * @param {string} [args.dvToken] [args.adoToken]
 * @param {object} [args.deps]
 */
async function applyMergedComponents({
  binding, components, envUrl, solutionUniqueName, solutionId = null,
  projectRoot = process.cwd(), runId = null, apply = false, secure = true,
  resumeFrom = null, priorCommitId = null, priorAcceptResults = null, writeState = true,
  dvToken = null, adoToken = null, deps = defaultDeps,
} = {}) {
  if (!binding || !binding.organization) throw new Error('binding.organization is required');
  if (!binding.branch) throw new Error('binding.branch is required');
  if (!Array.isArray(components) || components.length === 0) throw new Error('components must be a non-empty array');
  if (!envUrl) throw new Error('envUrl is required');
  if (!solutionUniqueName) throw new Error('solutionUniqueName is required');

  const id = runId || `merge-${Date.now()}`;
  const changes = components
    .filter((c) => c.adoPath && typeof c.mergedContent === 'string')
    .map((c) => ({ path: c.adoPath, content: c.mergedContent, changeType: c.changeType || 'edit' }));

  const plan = {
    runId: id,
    apply,
    wouldCommit: changes.map((c) => c.path),
    wouldAccept: components.map((c) => c.conflictId).filter(Boolean),
    wouldPull: true,
    fileCount: changes.length,
  };

  if (changes.length === 0) {
    return { ok: false, status: 'failed', error: 'No applicable merged files (each component needs adoPath + mergedContent).', plan };
  }

  if (!apply) {
    return { ok: true, status: 'dry-run', plan };
  }

  const steps = [];
  const record = (name, result) => { steps.push({ step: name, ...result }); return result; };

  const safeName = (c) => String(c.name || c.componentId || 'component').replace(/[^a-z0-9._-]+/gi, '_');
  // Identifier-only meta for the resumable run-state — never component source.
  const componentMeta = components.map((c) => ({
    name: c.name || null, componentId: c.componentId || null, conflictId: c.conflictId || null,
    field: c.field || null, type: c.type != null ? c.type : null, adoPath: c.adoPath || null, safe: safeName(c),
  }));
  let stateSnapshotDir = null;
  const persistState = (phase, extra = {}) => {
    if (!writeState) return;
    try {
      runState.writeRunState(id, {
        phase, binding, envUrl, solutionUniqueName, solutionId,
        snapshotDir: stateSnapshotDir, components: componentMeta, ...extra,
      });
    } catch (_) { /* best-effort; recovery is a convenience, never blocks apply */ }
  };
  const resuming = (target) => !!resumeFrom && runState.isAtOrBeyond(resumeFrom, target);

  // 1) Snapshot OURS for audit/reversibility. Secure-by-default: write to the
  //    owner-only OS-temp store (co-located with the merge run so wipeMergeRun
  //    cleans both), NOT durable plaintext under the project/session tree. On
  //    RESUME we reuse the existing snapshot — re-snapshotting would overwrite
  //    the pre-merge OURS with whatever the environment now holds.
  let snapshotDir = null;
  if (resumeFrom) {
    snapshotDir = secure
      ? path.join(mergeStore.runDir(id), 'snapshot')
      : path.join(deps.innerLoop.innerLoopDir(projectRoot), 'merge', id, 'snapshot');
  } else {
    try {
      if (secure) {
        const runStore = mergeStore.createRunStore(id);
        for (const c of components) {
          const safe = safeName(c);
          mergeStore.writeArtifact(runStore, `snapshot/${safe}.ours.txt`, c.oursContent != null ? String(c.oursContent) : '');
          mergeStore.writeArtifact(runStore, `snapshot/${safe}.merged.txt`, String(c.mergedContent));
        }
        snapshotDir = path.join(runStore.dir, 'snapshot');
      } else {
        const dir = deps.innerLoop.ensureInnerLoopDir(projectRoot);
        snapshotDir = path.join(dir, 'merge', id, 'snapshot');
        fs.mkdirSync(snapshotDir, { recursive: true });
        for (const c of components) {
          const safe = safeName(c);
          fs.writeFileSync(path.join(snapshotDir, `${safe}.ours.txt`), c.oursContent != null ? String(c.oursContent) : '', 'utf8');
          fs.writeFileSync(path.join(snapshotDir, `${safe}.merged.txt`), String(c.mergedContent), 'utf8');
        }
      }
      record('snapshot', { ok: true, snapshotDir });
    } catch (e) {
      record('snapshot', { ok: false, error: e.message });
      // Snapshot failure is non-fatal but recorded.
    }
  }
  stateSnapshotDir = snapshotDir;
  if (!resumeFrom) persistState('started');

  // 2) Commit merged file(s) to ADO (one push). Skipped on resume past 'committed'.
  let commit;
  if (resuming('committed')) {
    commit = record('commit-to-ado', { ok: true, commitId: priorCommitId, resumed: true });
  } else {
    const commitMessage = `Selective merge: ${components.map((c) => c.name).filter(Boolean).join(', ')}`.slice(0, 200);
    commit = record('commit-to-ado', await deps.commitFiles({
      organization: binding.organization, project: binding.project, repository: binding.repository,
      branch: binding.branch, comment: commitMessage, changes, token: adoToken,
    }));
    if (!commit.ok) {
      persistState('started', { status: 'failed', error: `ADO commit failed: ${commit.error}` });
      return buildResult({ status: 'failed', steps, plan, error: `ADO commit failed: ${commit.error}`, id, envUrl, binding, solutionUniqueName, components, deps, projectRoot, snapshotDir });
    }
    persistState('committed', { commitId: commit.commitId });
  }

  // 3) Refresh so Dataverse sees the merged branch tip. Skipped once accepted.
  if (!resuming('accepted')) {
    const refresh = record('refresh', await deps.refreshChangesFromGit({ envUrl, token: dvToken, solutionUniqueName }));
    if (refresh && refresh.error) {
      persistState('committed', { commitId: commit.commitId, status: 'partial', error: `RefreshChangesFromGit failed: ${refresh.error}` });
      return buildResult({ status: 'partial', steps, plan, error: `RefreshChangesFromGit failed: ${refresh.error}`, id, envUrl, binding, solutionUniqueName, components, commitId: commit.commitId, deps, projectRoot, snapshotDir });
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

  // 4) Accept-incoming per conflict. Skipped on resume past 'accepted'.
  let portalFallback = false;
  let acceptResults = [];
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
          envUrl, token: dvToken, solutionId: effectiveSolutionId, componentId: c.componentId, decision: 'accept-incoming',
        });
        if (ua && ua.ok) { acceptResults.push({ name: c.name, conflictId: c.conflictId, result: 'accepted', via: 'useraction' }); accepted = true; }
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

      // FALLBACK: the ResolveGitConflict OData action (older/other tenants).
      // eslint-disable-next-line no-await-in-loop
      const r = await deps.resolveConflictAccept({ envUrl, token: dvToken, conflictId: c.conflictId, solutionUniqueName });
      if (isActionAbsent(r)) { portalFallback = true; acceptResults.push({ name: c.name, conflictId: c.conflictId, result: 'action-absent' }); }
      else if (r && r.error) acceptResults.push({ name: c.name, conflictId: c.conflictId, result: 'failed', error: r.error });
      else acceptResults.push({ name: c.name, conflictId: c.conflictId, result: 'accepted', via: 'resolvegitconflict' });
    }
    record('accept-incoming', { ok: !portalFallback, results: acceptResults, portalFallback });

    if (portalFallback) {
      persistState('committed', { commitId: commit.commitId, status: 'manual-resolution-required', acceptResults });
      return buildResult({
        status: 'manual-resolution-required', steps, plan, id, envUrl, binding, solutionUniqueName, components,
        commitId: commit.commitId, resolvedVia: 'maker-portal', acceptResults,
        note: 'Programmatic accept unavailable on this tenant (no useraction row found and ResolveGitConflict absent — IL-015). Merged files are committed to ADO; accept the incoming changes in the Maker Portal Conflicts tab, then pull.',
        deps, projectRoot, snapshotDir,
      });
    }
    persistState('accepted', { commitId: commit.commitId, acceptResults });
  }

  // 5) Pull merged content into Dataverse. Skipped on resume past 'pulled'.
  if (!resuming('pulled')) {
    const pull = record('pull', await deps.pullChangesFromGit({ envUrl, token: dvToken, solutionUniqueName }));
    if (pull && pull.error) {
      persistState('accepted', { commitId: commit.commitId, acceptResults, status: 'partial', error: `PullChangesFromGit failed: ${pull.error}` });
      return buildResult({ status: 'partial', steps, plan, error: `PullChangesFromGit failed: ${pull.error}`, id, envUrl, binding, solutionUniqueName, components, commitId: commit.commitId, acceptResults, deps, projectRoot, snapshotDir });
    }
    persistState('pulled', { commitId: commit.commitId, acceptResults });
  }

  // 6) Verify Conflicts -> 0.
  const remaining = record('verify', await deps.listConflicts({ envUrl, token: dvToken, solutionUniqueName }));
  const remainingCount = remaining && typeof remaining.count === 'number' ? remaining.count : null;
  const anyAcceptFailed = acceptResults.some((a) => a.result === 'failed');

  // 6b) Content verification: re-read OURS after the pull and byte-compare
  //     (EOL-normalized) against what we merged. Conflicts->0 alone doesn't prove
  //     the environment actually holds our merged content; this catches silent
  //     divergence (a server transform, a partial pull, or a racing edit). Only
  //     positional metadata (lengths, line of first divergence) is surfaced —
  //     never raw content — so we don't leak component source/secrets into logs.
  const contentChecks = [];
  if (typeof deps.readComponentContent === 'function') {
    for (const c of components) {
      if (!c.componentId || !c.field || typeof c.mergedContent !== 'string') {
        contentChecks.push({ name: c.name, result: 'skipped', reason: 'missing componentId/field/mergedContent' });
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const re = await deps.readComponentContent({ envUrl, token: dvToken, componentId: c.componentId, componentType: c.type, name: c.name });
      if (!re || re.error) { contentChecks.push({ name: c.name, field: c.field, result: 'unverified', reason: (re && re.error) || 'read failed' }); continue; }
      const mf = (re.mergeFields || []).find((f) => f.key === c.field);
      if (!mf) { contentChecks.push({ name: c.name, field: c.field, result: 'unverified', reason: 'field absent after pull' }); continue; }
      const got = toLF(stripBom(String(mf.value)));
      const want = toLF(stripBom(String(c.mergedContent)));
      if (got === want) { contentChecks.push({ name: c.name, field: c.field, result: 'verified' }); continue; }
      const at = firstDivergence(want, got);
      contentChecks.push({ name: c.name, field: c.field, result: 'mismatch', expectedLength: want.length, actualLength: got.length, ...(at ? { divergedAtLine: at.line, divergedAtIndex: at.index } : {}) });
    }
    record('content-verify', { ok: !contentChecks.some((x) => x.result === 'mismatch'), checks: contentChecks });
  }
  const anyContentMismatch = contentChecks.some((x) => x.result === 'mismatch');

  // Only claim success when the post-pull conflict count is VERIFIED zero, no
  // accept failed, AND no content mismatch. A null count (auth/query error on
  // list-conflicts) or a content mismatch is unverified/divergent -> partial,
  // never a false 'succeeded'.
  const status = (remainingCount === 0 && !anyAcceptFailed && !anyContentMismatch) ? 'succeeded' : 'partial';
  persistState(status === 'succeeded' ? 'verified' : 'pulled', { commitId: commit.commitId, acceptResults, status, remainingCount });

  return buildResult({
    status, steps, plan, id, envUrl, binding, solutionUniqueName, components,
    commitId: commit.commitId, resolvedVia: 'api', acceptResults, remainingCount, contentChecks,
    deps, projectRoot, snapshotDir,
    ...(anyContentMismatch ? { note: 'Pulled content does not match the merged result for one or more components (see contentVerify). The environment may have transformed or only partially applied the merge — review before retrying.' } : {}),
  });
}

/**
 * Resume a partially-applied selective merge from its last good phase, using the
 * persisted run-state + the OURS/merged snapshot. Re-runs only the steps that did
 * not complete (e.g. accept → pull → verify after a commit that already landed).
 * The ADO commit is never repeated; the original OURS snapshot is preserved.
 */
async function resumeMergeApply({ runId, dvToken = null, adoToken = null, deps = defaultDeps, projectRoot = process.cwd(), secure = true } = {}) {
  if (!runId) throw new Error('runId is required');
  const state = runState.readRunState(runId);
  if (!state) return { ok: false, status: 'failed', error: `No resumable run-state for runId '${runId}'.` };
  if (state.phase === 'verified') return { ok: true, status: 'succeeded', note: 'Run already completed (verified).', resumedFrom: 'verified' };
  if (state.phase === 'rolledback') return { ok: false, status: 'failed', error: 'Run was rolled back; nothing to resume.' };
  if (!state.snapshotDir) return { ok: false, status: 'failed', error: 'Run-state has no snapshotDir; cannot rebuild merged content.' };

  // Rebuild components from the snapshot (merged content) + state meta (ids).
  const components = [];
  for (const m of state.components || []) {
    let mergedContent = null;
    try { mergedContent = fs.readFileSync(path.join(state.snapshotDir, `${m.safe}.merged.txt`), 'utf8'); } catch { /* missing */ }
    if (mergedContent == null) return { ok: false, status: 'failed', error: `Snapshot missing for '${m.name || m.componentId}'; cannot resume.` };
    let oursContent = null;
    try { oursContent = fs.readFileSync(path.join(state.snapshotDir, `${m.safe}.ours.txt`), 'utf8'); } catch { /* best-effort */ }
    components.push({ name: m.name, componentId: m.componentId, conflictId: m.conflictId, field: m.field, type: m.type, adoPath: m.adoPath, mergedContent, oursContent });
  }
  if (components.length === 0) return { ok: false, status: 'failed', error: 'Run-state has no components; nothing to resume.' };

  return applyMergedComponents({
    binding: state.binding, components, envUrl: state.envUrl, solutionUniqueName: state.solutionUniqueName,
    solutionId: state.solutionId, runId, apply: true, secure,
    resumeFrom: state.phase, priorCommitId: state.commitId, priorAcceptResults: state.acceptResults,
    dvToken, adoToken, deps, projectRoot,
  });
}

/**
 * Roll back a selective merge by restoring the pre-merge OURS via the SAME safe
 * path the feature uses everywhere — commit the OURS snapshot to ADO, then pull —
 * never a Git history rewrite and never a raw Dataverse write. Produces a new ADO
 * commit that supersedes the merge and pulls the original content back into the env.
 */
async function rollbackMergeApply({ runId, dvToken = null, adoToken = null, deps = defaultDeps, projectRoot = process.cwd(), secure = true } = {}) {
  if (!runId) throw new Error('runId is required');
  const state = runState.readRunState(runId);
  if (!state) return { ok: false, status: 'failed', error: `No run-state for runId '${runId}'.` };
  if (!state.snapshotDir) return { ok: false, status: 'failed', error: 'Run-state has no snapshotDir; cannot restore OURS.' };

  const components = [];
  for (const m of state.components || []) {
    let oursContent = null;
    try { oursContent = fs.readFileSync(path.join(state.snapshotDir, `${m.safe}.ours.txt`), 'utf8'); } catch { /* missing */ }
    if (oursContent == null) return { ok: false, status: 'failed', error: `OURS snapshot missing for '${m.name || m.componentId}'; cannot roll back.` };
    // Restore by committing OURS as the new content; omit conflictId so apply
    // treats it as a clean incoming update (commit → refresh → pull), not a
    // conflict to "accept".
    components.push({ name: m.name, componentId: m.componentId, field: m.field, type: m.type, adoPath: m.adoPath, mergedContent: oursContent, oursContent });
  }
  if (components.length === 0) return { ok: false, status: 'failed', error: 'Run-state has no components; nothing to roll back.' };

  const rollbackRunId = `${runId}-rollback`;
  const result = await applyMergedComponents({
    binding: state.binding, components, envUrl: state.envUrl, solutionUniqueName: state.solutionUniqueName,
    solutionId: state.solutionId, runId: rollbackRunId, apply: true, secure,
    dvToken, adoToken, deps, projectRoot,
  });
  // Mark the original run as rolled back (best-effort).
  try { runState.writeRunState(runId, { ...state, phase: 'rolledback', rollbackRunId, rolledBackAt: new Date().toISOString() }); } catch (_) { /* best-effort */ }
  return { ...result, rolledBackRunId: runId, rollbackRunId };
}

function buildResult({ status, steps, plan, error, id, envUrl, binding, solutionUniqueName, components, commitId = null, resolvedVia = 'api', acceptResults = [], remainingCount = null, contentChecks = [], note, deps, projectRoot, snapshotDir }) {
  const marker = {
    skill: 'git-sync',
    flow: 'conflict-resolution',
    strategy: 'selective-merge',
    resolvedAt: new Date().toISOString(),
    runId: id,
    envUrl,
    branch: binding.branch,
    organization: binding.organization,
    project: binding.project,
    repository: binding.repository,
    solutionUniqueName,
    adoCommitId: commitId,
    conflictsFound: components.length,
    conflictsResolved: acceptResults.filter((a) => a.result === 'accepted' || a.result === 'already-resolved').length,
    remainingConflicts: remainingCount != null ? remainingCount : (status === 'succeeded' ? 0 : components.length),
    resolvedVia,
    snapshotDir: snapshotDir || null,
    decisions: components.map((c) => ({
      conflictId: c.conflictId || null, componentName: c.name, componentType: c.type,
      strategy: 'selective-merge', adoPath: c.adoPath || null,
    })),
    status,
    ...(contentChecks && contentChecks.length ? { contentVerify: contentChecks } : {}),
    ...(note ? { note } : {}),
    ...(error ? { error } : {}),
  };

  let markerPath = null;
  try {
    if (deps && deps.innerLoop && projectRoot) {
      deps.innerLoop.ensureInnerLoopDir(projectRoot);
      markerPath = deps.innerLoop.innerLoopPath(projectRoot, 'lastConflictResolution');
      fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2), 'utf8');
    }
  } catch (_) { /* marker write best-effort */ }

  return { ok: status === 'succeeded' || status === 'manual-resolution-required', status, plan, steps, marker, markerPath, contentVerify: contentChecks, ...(error ? { error } : {}) };
}

function parseArgs(argv) {
  const a = argv.slice(2);
  const o = { mode: 'apply', envUrl: null, solutionUniqueName: null, projectRoot: null, bindingFile: null, resolvedFile: null, runId: null, apply: false, token: null };
  for (let i = 0; i < a.length; i++) {
    const n = a[i + 1];
    if (a[i] === '--envUrl' && n) o.envUrl = a[++i];
    else if (a[i] === '--solutionUniqueName' && n) o.solutionUniqueName = a[++i];
    else if (a[i] === '--projectRoot' && n) o.projectRoot = a[++i];
    else if (a[i] === '--bindingFile' && n) o.bindingFile = a[++i];
    else if (a[i] === '--resolvedFile' && n) o.resolvedFile = a[++i];
    else if (a[i] === '--runId' && n) o.runId = a[++i];
    else if (a[i] === '--apply') o.apply = true;
    else if (a[i] === '--resume') o.mode = 'resume';
    else if (a[i] === '--rollback') o.mode = 'rollback';
    else if (a[i] === '--token' && n) o.token = a[++i];
  }
  return o;
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  (async () => {
    let r;
    if (args.mode === 'resume') {
      r = await resumeMergeApply({ runId: args.runId, dvToken: args.token, projectRoot: args.projectRoot || process.cwd() });
    } else if (args.mode === 'rollback') {
      r = await rollbackMergeApply({ runId: args.runId, dvToken: args.token, projectRoot: args.projectRoot || process.cwd() });
    } else {
      const binding = JSON.parse(fs.readFileSync(args.bindingFile, 'utf8'));
      const components = JSON.parse(fs.readFileSync(args.resolvedFile, 'utf8'));
      r = await applyMergedComponents({
        binding, components, envUrl: args.envUrl, solutionUniqueName: args.solutionUniqueName,
        projectRoot: args.projectRoot || process.cwd(), runId: args.runId, apply: args.apply, dvToken: args.token,
      });
    }
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    if (!r.ok && r.status !== 'dry-run') process.exit(1);
  })().catch((e) => { process.stderr.write('apply-merged-component: ' + e.message + '\n'); process.exit(1); });
}

module.exports = { applyMergedComponents, resumeMergeApply, rollbackMergeApply, isActionAbsent };
