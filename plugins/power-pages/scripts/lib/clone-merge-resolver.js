#!/usr/bin/env node

// Orchestrator for the clone-based selective-merge conflict resolver — the only
// conflict-resolution path for git-sync. It choreographs the tested helpers and
// owns the consent gates, run-state journaling, dry-run, resume and the
// awaiting-PR pause. It performs NO real git/ADO/Dataverse work itself — every
// side-effect goes through an injected, already-unit-tested helper.
//
// Flow (phases mirror merge-run-state.PHASES):
//   resolve units (OURS + adoPath, text vs binary)        [local, no consent]
//   → clone/update the per-branch clone                    [local]
//   → stage a REAL git merge (Current=Dataverse/Incoming=ADO) [local]   phase: staged
//   → open VS Code native Source Control; user resolves    [local]
//   → done-gate: user confirms + we verify 0 markers       [consent: done]   phase: resolved
//   → push (FF) or branch+PR, never force                  [consent: push/pr] phase: pushed | status: awaiting-pr
//   → Dataverse reconcile: refresh→accept→pull→verify      [consent: pull]    phase: refreshed..verified
//
// apply=false (default) returns a PLAN only. resume=true continues a journaled run.

'use strict';

const path = require('path');
const fs = require('fs');

const gitExec = require('./git-exec');
const runStateMod = require('./merge-run-state');
const { isEligibleForSelectiveMerge, isWebFileType, isSourceFileType, labelForType } = require('./component-type-map');
const { extractYamlValue } = require('./flat-yml-merge');
const { matchShape } = require('./eol-bom');

const COMMIT_ENV = Object.freeze({
  GIT_AUTHOR_NAME: 'Power Pages', GIT_AUTHOR_EMAIL: 'powerpages@localhost',
  GIT_COMMITTER_NAME: 'Power Pages', GIT_COMMITTER_EMAIL: 'powerpages@localhost',
});

const defaultDeps = () => ({
  readComponentContent: require('./read-component-content').readComponentContent,
  buildAdoPath: require('./map-component-to-git-path').buildPathFromComponentPath,
  resolveWebFileLeaf: require('./map-component-to-git-path').resolveWebFileLeaf,
  cloneDirLayout: require('./resolve-clone-path').cloneDirLayout,
  cloneOrUpdateRepo: require('./clone-or-update-repo').cloneOrUpdateRepo,
  stageGitMerge: require('./stage-git-merge').stageGitMerge,
  detectMergeState: require('./detect-merge-state').detectMergeState,
  matchesRoster: require('./detect-merge-state').matchesRoster,
  openMergeFolder: require('./open-merge-folder').openMergeFolder,
  pushOrPr: require('./push-or-pr').pushOrPr,
  reconcileDataverse: require('./reconcile-dataverse').reconcileDataverse,
  recordMergeMetrics: safeRequire('./record-merge-metrics', 'recordMergeMetrics'),
  getPr: safeRequire('./ado-get-pr', 'getPullRequest'),
  readWebFileBytes: safeRequire('./read-web-file-bytes', 'readWebFileBytes'),
  readSourceFileContent: safeRequire('./read-source-file-content', 'readSourceFileContent'),
  sniffTextOrBinary: safeRequire('./detect-text-or-binary', 'sniffTextOrBinary'),
  git: gitExec,
  runState: runStateMod,
});

function safeRequire(mod, fn) {
  try { const m = require(mod); return typeof m[fn] === 'function' ? m[fn] : null; } catch { return null; }
}

// Always-true confirm gates by default would defeat consent; the caller (skill)
// supplies real AskUserQuestion-backed callbacks. Absent a callback we FAIL CLOSED
// for shared-state mutations (push/pr/pull) and proceed for local-only prompts.
const denyGate = async () => false;
const allowGate = async () => true;

function repoUrlFromBinding(b) {
  if (b.repoUrl) return b.repoUrl;
  return `https://dev.azure.com/${encodeURIComponent(b.organization)}/${encodeURIComponent(b.project)}/_git/${encodeURIComponent(b.repository)}`;
}

function relPath(adoPath) {
  return String(adoPath || '').replace(/^[/\\]+/, '').replace(/\\/g, '/');
}

/**
 * Resolve each conflict roster entry into OURS content + its ADO source-file path,
 * partitioning into text (3-way mergeable) vs binary/scalar (keep/accept) units.
 */
async function resolveUnits({ conflicts, binding, envUrl, dvToken, deps }) {
  const textUnits = [];
  const binaryUnits = [];
  const unresolved = [];
  // A1: track conflicts the TYPE says are selective-merge-eligible (text). If any
  // such conflict fails to produce a text unit, the caller must abort rather than
  // silently stage an empty merge (which drops the env's edits).
  const eligibleButNotText = [];
  let serial = 0;
  for (const c of conflicts) {
    serial += 1; // Task 2: stable GLOBAL serial = position in the conflict roster (the
                 // number the agent shows the user, e.g. 9–15 for the binary subset).
    const typeEligible = isEligibleForSelectiveMerge(c.type);
    // Web files (type 3) use sniff-based routing: bytes from Dataverse are sniffed
    // to decide text (3-way merge) vs binary (matrix). Routing web files to binary
    // is NEVER an error — so they must never appear in eligibleButNotText regardless
    // of whether the path builder succeeded or not.
    const isWebFile = isWebFileType(c.type);
    // Code-site source files (powerpagessourcefile): bytes from filecontent are
    // sniffed to decide text (3-way merge) vs binary (matrix) — routing to binary is
    // NEVER an error, so (like web files) they never count as eligibleButNotText.
    const isSourceFile = isSourceFileType(c.type);
    const pathRes = deps.buildAdoPath({
      componentPath: c.componentPath, type: c.type, field: c.field,
      rootFolder: binding.rootFolder, gitFolder: binding.gitFolder,
    });
    if (!pathRes || pathRes.supported === false || !pathRes.path) {
      if (typeEligible && !isWebFile && !isSourceFile) eligibleButNotText.push({ name: c.name, type: c.type, reason: (pathRes && pathRes.reason) || 'no source-file path' });
      binaryUnits.push({ ...c, serial, reason: (pathRes && pathRes.reason) || 'no source-file path', route: 'keep-accept' });
      continue;
    }

    // Web file with a valid path → sniff-based routing (type 3).
    // readWebFileBytes fetches the env's current bytes; sniffTextOrBinary classifies
    // them. TEXT → 3-way merge editor (webfile:true text unit).
    // BINARY or read-error → binary matrix (keep/accept), never eligibleButNotText.
    if (isWebFile) {
      if (typeof deps.readWebFileBytes !== 'function' || typeof deps.sniffTextOrBinary !== 'function') {
        // Deps not injected (e.g. partial dep set in older callers) — fail safely to binary.
        binaryUnits.push({ ...c, serial, adoPath: pathRes.path, route: 'keep-accept', reason: 'readWebFileBytes/sniffTextOrBinary not available' });
        continue;
      }
      let webFileRead;
      try {
        webFileRead = await deps.readWebFileBytes({ envUrl, componentId: c.componentId, token: dvToken });
      } catch (e) {
        binaryUnits.push({ ...c, serial, adoPath: pathRes.path, route: 'keep-accept', reason: `readWebFileBytes failed: ${e.message}` });
        continue;
      }
      if (!webFileRead || webFileRead.error) {
        binaryUnits.push({ ...c, serial, adoPath: pathRes.path, route: 'keep-accept', reason: (webFileRead && webFileRead.error) || 'readWebFileBytes failed' });
        continue;
      }
      const sniff = deps.sniffTextOrBinary(webFileRead.bytes);
      if (!sniff || !sniff.isText) {
        binaryUnits.push({ ...c, serial, adoPath: pathRes.path, route: 'keep-accept', reason: (sniff && sniff.reason) || 'binary content' });
        continue;
      }
      // TEXT web file: decode bytes and shape to repo EOL/BOM before staging as OURS.
      const rawText = webFileRead.bytes.toString(sniff.encoding || 'utf8');
      const oursContent = matchShape(rawText, { eol: webFileRead.eol || '\n', bom: !!webFileRead.bom });
      textUnits.push({
        webfile: true,
        adoPath: pathRes.path,
        oursContent,
        field: null,
        type: c.type,
        conflictId: c.conflictId,
        componentId: c.componentId,
        name: c.name,
        serial,
      });
      continue;
    }

    // Code-site source file (powerpagessourcefile): read the env bytes from
    // filecontent via the dedicated reader (componentId == powerpagessourcefileid),
    // sniff text/binary, and route TEXT to the 3-way merge editor (sourcefile:true).
    // BINARY or read-error → keep/accept matrix (fail closed), never eligibleButNotText.
    if (isSourceFile) {
      if (typeof deps.readSourceFileContent !== 'function' || typeof deps.sniffTextOrBinary !== 'function') {
        binaryUnits.push({ ...c, serial, adoPath: pathRes.path, route: 'keep-accept', reason: 'readSourceFileContent/sniffTextOrBinary not available' });
        continue;
      }
      let srcRead;
      try {
        srcRead = await deps.readSourceFileContent({ envUrl, componentId: c.componentId, token: dvToken });
      } catch (e) {
        binaryUnits.push({ ...c, serial, adoPath: pathRes.path, route: 'keep-accept', reason: `readSourceFileContent failed: ${e.message}` });
        continue;
      }
      if (!srcRead || srcRead.error) {
        binaryUnits.push({ ...c, serial, adoPath: pathRes.path, route: 'keep-accept', reason: (srcRead && srcRead.error) || 'readSourceFileContent failed' });
        continue;
      }
      if (!srcRead.isText) {
        binaryUnits.push({ ...c, serial, adoPath: pathRes.path, route: 'keep-accept', reason: 'binary content' });
        continue;
      }
      // Decode env bytes to text; stage-git-merge re-shapes EOL/BOM to the repo file,
      // so we pass the plain decoded text here (utf16le handled; everything else utf8).
      const oursContent = srcRead.bytes.toString(srcRead.encoding === 'utf16le' ? 'utf16le' : 'utf8');
      textUnits.push({
        sourcefile: true,
        adoPath: pathRes.path,
        oursContent,
        field: null,
        type: c.type,
        conflictId: c.conflictId,
        componentId: c.componentId,
        name: c.name,
        serial,
      });
      continue;
    }

    let content;
    try {
      content = await deps.readComponentContent({ envUrl, componentId: c.componentId, token: dvToken });
    } catch (e) {
      if (typeEligible) eligibleButNotText.push({ name: c.name, type: c.type, reason: `read OURS failed: ${e.message}` });
      unresolved.push({ ...c, reason: `read OURS failed: ${e.message}` });
      continue;
    }
    const field = pathRes.field;
    const mf = (content.mergeFields || []).find((f) => f.key === field) || (content.mergeFields || [])[0];
    const isText = mf && mf.isText && content.mergeStrategy === 'text';
    // Flat-YML site settings (type 9): the WHOLE .sitesetting.yml is the merge file —
    // only the `value:` line conflicts (metadata is identical across sides and auto-
    // merges). Route to the 3-way text editor regardless of the scalar field
    // classification, EXCEPT when the env value is multi-line (can't be safely
    // substituted into a single yml line) → keep/accept fallback.
    const flatYml = pathRes.format === 'flat-yml';
    const oursVal = mf ? mf.value : '';
    const unit = {
      conflictId: c.conflictId, componentId: c.componentId, name: c.name, type: c.type, serial,
      field, adoPath: pathRes.path, oursContent: oursVal,
      ...(flatYml ? { flatYml: true } : {}),
    };
    if (flatYml && /[\r\n]/.test(String(oursVal))) {
      binaryUnits.push({ ...unit, route: 'keep-accept', reason: 'multi-line site setting value' });
    } else if (isText || flatYml) {
      textUnits.push(unit);
    } else {
      if (typeEligible) eligibleButNotText.push({ name: c.name, type: c.type, reason: `field '${field}' not text (mergeStrategy=${content.mergeStrategy})` });
      binaryUnits.push({ ...unit, route: 'keep-accept', reason: content.mergeStrategy });
    }
  }
  return { textUnits, binaryUnits, unresolved, eligibleButNotText };
}

function readResolvedContent(repoDir, adoPath, fsImpl) {
  try { return fsImpl.readFileSync(path.join(repoDir, relPath(adoPath)), 'utf8'); } catch { return null; }
}

// Binary/scalar conflicts (web files, scalar site settings) CANNOT be shown in VS
// Code's 3-way editor — their bytes live outside the component envelope. Instead of
// one blanket keep/accept for ALL of them, the skill presents a NUMBERED MATRIX in
// chat and the user picks which files to ACCEPT INCOMING (take the ADO version); the
// rest default to KEEP CURRENT (keep the environment's version). This builds that
// matrix (stable 1-based serials in roster order).
function buildBinaryMatrix(conflictedBinaries) {
  return conflictedBinaries.map((u, i) => ({
    // Task 2: reuse the GLOBAL conflict-roster serial (e.g. 9–15) so it matches the
    // numbers the user already saw; fall back to a local 1-based index if absent.
    serial: u.serial != null ? u.serial : i + 1,
    name: u.name,
    type: u.type != null ? u.type : null,
    typeLabel: labelForType(u.type),
    mergeStrategy: u.reason || u.route || 'keep-accept',
  }));
}

// Map a user SELECTION onto per-file decisions. `selection` may be:
//   - an array of serials and/or names → those ACCEPT INCOMING, the rest KEEP CURRENT
//   - 'all-accept' / 'take-theirs' / 'all'            → every file accept-incoming
//   - null / [] / 'keep-mine' / 'keep-all' / 'none'   → every file keep-current (default)
// Returns a plain { name: 'accept-incoming' | 'keep-current' } object (JSON-safe for
// run-state). KEEP CURRENT is the default for anything not explicitly selected.
function resolveBinaryDecisions(matrix, selection) {
  let mode = 'keep-all';
  let acceptSet = null;
  if (selection === 'all' || selection === 'all-accept' || selection === 'accept-all' || selection === 'take-theirs') {
    mode = 'accept-all';
  } else if (Array.isArray(selection) && selection.length) {
    mode = 'select';
    acceptSet = new Set(selection.map((s) => String(s).trim()).filter(Boolean));
  }
  const out = {};
  for (const m of matrix) {
    let d = 'keep-current';
    if (mode === 'accept-all') d = 'accept-incoming';
    else if (mode === 'select' && (acceptSet.has(String(m.serial)) || acceptSet.has(m.name))) d = 'accept-incoming';
    out[m.name] = d;
  }
  return out;
}

// A7(b): auto-stage any conflicted file that the user resolved in VS Code but left
// unstaged (markers gone, but `git status` still shows it unmerged until `git add`).
// Without this, the done-gate's detectMergeState would falsely report a resolved
// file as still-unmerged. Files that STILL contain conflict markers are left alone.
function autoStageResolved({ repoDir, paths, git, fsImpl }) {
  const staged = [];
  for (const p of paths || []) {
    const rel = relPath(p);
    let content;
    try { content = fsImpl.readFileSync(path.join(repoDir, rel), 'utf8'); } catch { continue; }
    if (content.includes('<<<<<<<') || content.includes('>>>>>>>')) continue; // still conflicted
    const r = git.runGit({ cwd: repoDir, args: ['add', '--', rel] });
    if (r && r.ok) staged.push(rel);
  }
  return staged;
}

/**
 * @returns {Promise<object>} structured result with a `status`:
 *   'dry-run' | 'needs-resolution' | 'awaiting-pr' | 'success' | 'partial' |
 *   'manual-resolution-required' | 'cancelled' | 'failed'
 */
async function runCloneMerge(opts = {}) {
  const {
    cloneDir, envUrl, solutionUniqueName, solutionId = null,
    binding, conflicts, user = 'user', dvToken = null, adoToken = null,
    apply = false, resume = false, autoComplete = true,
    pauseForResolution = false,
    confirm = {}, deps = defaultDeps(), fsImpl = fs,
  } = opts;

  if (!binding || !binding.organization || !binding.branch) throw new Error('binding with organization+branch is required');
  if (!Array.isArray(conflicts) || conflicts.length === 0) throw new Error('conflicts must be a non-empty array');
  if (!cloneDir) throw new Error('cloneDir is required');

  const gate = (name, fallback) => (typeof confirm[name] === 'function' ? confirm[name] : fallback);
  const git = deps.git;
  const RS = deps.runState;

  // Phase 0 — resolve units (local; no consent).
  let { textUnits, binaryUnits, unresolved, eligibleButNotText } = await resolveUnits({ conflicts, binding, envUrl, dvToken, deps });

  const plan = {
    conflicts: conflicts.length,
    textUnits: textUnits.map((u) => u.adoPath),
    binaryUnits: binaryUnits.map((u) => u.name),
    unresolved,
    eligibleButNotText: eligibleButNotText || [],
    branch: binding.branch,
  };
  if (!apply) return { ok: true, status: 'dry-run', plan };

  // A1 fail-closed: if the TYPE said a conflict was selective-merge-eligible (text)
  // but it produced NO text unit, refuse to proceed — staging now would yield a
  // clean/empty merge, VS Code would never open, and the env's edits would be
  // dropped silently. Abort loudly so the caller can fix inputs (often a string vs
  // numeric type, or a path/read failure) instead of losing work.
  if (textUnits.length === 0 && (eligibleButNotText || []).length > 0) {
    return {
      ok: false,
      status: 'failed',
      error: `Expected ${eligibleButNotText.length} selective merge(s) but staged 0 — refusing to produce an empty merge that would drop environment edits. Affected: ${eligibleButNotText.map((e) => e.name).join(', ')}.`,
      plan,
      eligibleButNotText,
    };
  }

  if (textUnits.length === 0 && binaryUnits.length === 0) {
    return { ok: false, status: 'failed', error: 'No resolvable conflict units.', plan };
  }

  const repoUrl = repoUrlFromBinding(binding);

  // Phase 1 — locate the per-branch clone.
  //   FRESH run: clone/update (fetch + hard reset to origin/branch) so we stage from a
  //     pristine tree.
  //   RESUME: REUSE the existing clone AS-IS — do NOT clone/fetch/reset. The prior run
  //     left the staged (or already-committed) merge on the local `dataverse` branch,
  //     which is HEAD. cloneOrUpdateRepo's reuse path resets HEAD to origin/<branch>,
  //     which would move HEAD OFF the merge commit — then the push step (which pushes
  //     HEAD → <branch>) would push the unchanged origin tip and silently no-op. So on
  //     resume we only resolve the flat clone paths and leave the worktree untouched.
  let repoDir; let ppMergeDir; let branchTip; let cloneInfo = {};
  if (resume) {
    const layout = deps.cloneDirLayout({ cloneDir });
    repoDir = layout.repoDir; ppMergeDir = layout.ppMergeDir;
    const tip = git.revParse({ cwd: repoDir, rev: `origin/${binding.branch}` });
    branchTip = (tip && tip.ok && tip.stdout.trim()) || `origin/${binding.branch}`;
  } else {
    const clone = await deps.cloneOrUpdateRepo({ cloneDir, repoUrl, branch: binding.branch, token: adoToken });
    if (clone && clone.ok === false) return { ok: false, status: 'failed', error: clone.error, plan };
    repoDir = clone.repoDir; ppMergeDir = clone.ppMergeDir;
    branchTip = clone.branchTip || `origin/${binding.branch}`;  // in-progress-merge resume returns null branchTip
    cloneInfo = clone;
  }
  const prior = RS.readRunState(ppMergeDir);

  // Containerized web-file layout fix: `pac` git-integration exports each web file as a
  // FOLDER (web-files/theme.css/) holding the real bytes (theme.css) + a sidecar
  // (theme.css.webfile.yml). The mapper returns the FOLDER path; now that the clone
  // exists, resolve each web-file text unit to its inner leaf file so staging writes a
  // real file instead of throwing EISDIR on the directory. (Binary web files route to
  // the matrix and never touch the worktree, so only text units need this.)
  if (typeof deps.resolveWebFileLeaf === 'function') {
    for (const u of textUnits) {
      if (!u || !u.webfile) continue;
      try {
        const leaf = deps.resolveWebFileLeaf({ repoDir, webFilePath: u.adoPath, fsImpl });
        if (leaf && leaf !== u.adoPath) u.adoPath = leaf;
      } catch (_) { /* leave as-is; stage surfaces a clear containerized-webfile error */ }
    }
  }

  // Phase 2/3 — stage the real merge, honoring resume / in-progress (Q3).
  let mergeResult = null;
  let expectedPaths = textUnits.map((u) => relPath(u.adoPath));
  const theirsRef = branchTip || `origin/${binding.branch}`;
  // BASE candidates, preference order: explicit override → branchSyncedCommitId (the
  // env's last inbound-sync content = the true 3-way base) → upstreamBranchSyncedCommitId.
  // stage-git-merge picks the first that actually CONTAINS the conflicted files, so a
  // stale pointer can't produce an add/add merge the VS Code editor can't open.
  const baseCandidates = [binding.baseCommit, binding.branchSyncedCommitId, binding.upstreamBranchSyncedCommitId].filter(Boolean);
  if (!resume && cloneInfo.inProgressMerge) {
    const state = cloneInfo.mergeState || deps.detectMergeState({ repoDir });
    const match = deps.matchesRoster({ unmergedPaths: state.unmergedPaths || [], expectedPaths });
    if (!match.matches) {
      const decision = await gate('resumeOrRestart', allowGate)({ state, expectedPaths });
      if (decision === 'restart') {
        git.mergeAbort({ cwd: repoDir });
        mergeResult = deps.stageGitMerge({ repoDir, baseCommit: binding.baseCommit, baseCandidates, theirsRef, textUnits });
      } else if (decision === false || decision === 'cancel') {
        return { ok: false, status: 'cancelled', stage: 'resume-prompt', repoDir };
      } // 'resume' → keep the in-progress merge as-is
    }
    // matching in-progress merge → resume: keep markers, let the user continue
  } else if (resume && prior && RS.isAtOrBeyond(prior.phase, 'staged')) {
    // Resuming an already-staged merge — do NOT re-stage; the user resolved in place.
  } else if (resume && deps.detectMergeState({ repoDir }).inProgressMerge) {
    // Resume with missing/corrupt run-state but a LIVE in-progress merge in the
    // worktree → do NOT re-stage (re-staging would discard the user's resolution).
  } else {
    mergeResult = deps.stageGitMerge({ repoDir, baseCommit: binding.baseCommit, baseCandidates, theirsRef, textUnits });
    if (!mergeResult.ok) return { ok: false, status: 'failed', error: mergeResult.error, stage: 'stage', repoDir };
  }
  if (!resume) RS.writeRunState(ppMergeDir, { phase: 'staged', binding, envUrl, solutionUniqueName, solutionId, textUnits: expectedPaths, branchTip });

  // SAFETY DEMOTION (webfile text units only): after the merge is staged, re-sniff
  // the THEIRS (:3) index stage for each webfile text unit. If THEIRS is binary, the
  // file can't be text-merged (e.g. ADO has a PNG while the env has a CSS file with
  // the same name). Demote such units to binary/keep-accept and emit a warning.
  // This prevents force-text-merging a file whose ADO version is actually binary.
  const demotionWarnings = [];
  if (typeof deps.sniffTextOrBinary === 'function' && !resume) {
    const demotedUnits = [];
    const keptTextUnits = [];
    for (const u of textUnits) {
      if (!u.webfile) { keptTextUnits.push(u); continue; }
      let isTheirsBinary = false;
      try {
        const r = git.runGit({ cwd: repoDir, args: ['show', `:3:${relPath(u.adoPath)}`] });
        if (r && r.ok && r.stdout) {
          const theirsSniff = deps.sniffTextOrBinary(Buffer.from(r.stdout, 'binary'));
          if (theirsSniff && !theirsSniff.isText) isTheirsBinary = true;
        }
      } catch (_) { /* best-effort; skip demotion if we can't read THEIRS */ }
      if (isTheirsBinary) {
        demotedUnits.push(u);
        demotionWarnings.push(`${u.name}: env bytes are text but staged ADO version (THEIRS) is binary — demoted from text-merge to binary/keep-accept`);
      } else {
        keptTextUnits.push(u);
      }
    }
    if (demotedUnits.length > 0) {
      textUnits = keptTextUnits;
      binaryUnits = [...binaryUnits, ...demotedUnits.map((u) => ({ ...u, route: 'keep-accept', reason: 'theirs-binary-demotion' }))];
      // Recompute expectedPaths to exclude demoted files (they're no longer text-merge candidates).
      expectedPaths = textUnits.map((u) => relPath(u.adoPath));
    }
  }

  // Binary/scalar matrix (numbered) — surfaced so the agent can present it in chat
  // for per-file accept-incoming/keep-current selection (they can't open in VS Code).
  const conflictedBinaries = binaryUnits.filter((u) => u.conflictId);
  const binaryMatrix = buildBinaryMatrix(conflictedBinaries);

  // Phase 4/5 — open VS Code + done-gate (only when there is something to resolve).
  const resumingResolved = resume && prior && RS.isAtOrBeyond(prior.phase, 'resolved');
  const cleanMerge = !!(mergeResult && mergeResult.merge && mergeResult.merge.clean);
  const conflictedPaths = (mergeResult && mergeResult.merge && mergeResult.merge.conflictedPaths) || [];
  const addAddPaths = (mergeResult && mergeResult.merge && mergeResult.merge.addAddPaths) || [];
  if (!resumingResolved && !cleanMerge) {
    const resumingStaged = resume && prior && RS.isAtOrBeyond(prior.phase, 'staged');
    if (!resumingStaged) {
      // Open the clone folder + first conflicted file in VS Code's NATIVE 3-way merge
      // editor (openMergeFolder writes git.mergeEditor:true). Every conflict uses that
      // same native editor via the Source Control "Merge Changes" list — consistent
      // Incoming/Current labels, no per-file custom `code --merge` view.
      const openInfo = deps.openMergeFolder({ repoDir, conflictedPaths });
      if (pauseForResolution) {
        // CLI/skill model: open the native merge UI and PAUSE. The agent asks the
        // user "done?" then re-invokes with --resume to verify + finalize.
        RS.writeRunState(ppMergeDir, { phase: 'staged', status: 'awaiting-resolution', binding, envUrl, solutionUniqueName, solutionId, textUnits: expectedPaths, branchTip });
        return {
          ok: true, status: 'awaiting-resolution', repoDir, ppMergeDir, conflictedPaths,
          clonePath: cloneDir, reusedClone: !!cloneInfo.reused,
          // A2(c): if any path degraded to add/add (no base stage), the merge editor
          // shows whole-file conflicts. Surface it so the skill can warn the user.
          ...(addAddPaths.length ? { warning: `No common base for ${addAddPaths.length} file(s); the merge editor will show the whole file. Affected: ${addAddPaths.join(', ')}.`, addAddPaths } : {}),
          ...(openInfo && openInfo.panelLabels ? { panelLabels: openInfo.panelLabels } : {}),
          ...(openInfo && openInfo.scmPointer ? { scmPointer: openInfo.scmPointer } : {}),
          ...(openInfo && openInfo.opened ? { mergeEditorOpened: true } : {}),
          // Binary/scalar files can't open in VS Code → the agent presents this
          // numbered matrix and asks which to ACCEPT INCOMING (rest KEEP CURRENT).
          ...(binaryMatrix.length ? { binaryMatrix } : {}),
          // Webfile text units demoted to binary after THEIRS sniffed as binary.
          ...(demotionWarnings.length ? { demotionWarnings } : {}),
        };
      }
    }
    const proceed = await gate('done', allowGate)({ repoDir });
    if (!proceed) return { ok: false, status: 'cancelled', stage: 'done-gate', repoDir };
    // A7(b): auto-stage files the user resolved in VS Code but didn't stage, so the
    // verification below sees them as resolved (not falsely unmerged).
    autoStageResolved({ repoDir, paths: expectedPaths, git, fsImpl });
    const post = deps.detectMergeState({ repoDir, candidatePaths: expectedPaths });
    // "Resolved" = no unmerged paths AND no leftover <<<<<<< markers. The merge may
    // still be in progress / uncommitted (the user resolved in VS Code but didn't
    // click "Continue") — that's EXPECTED; we finalize the commit below. Do NOT gate
    // on detectMergeState.clean (which requires the merge to already be committed).
    const stillUnresolved = (post.unmergedPaths && post.unmergedPaths.length > 0) || (post.markerFiles && post.markerFiles.length > 0);
    if (stillUnresolved) {
      return { ok: false, status: 'needs-resolution', repoDir, remaining: { unmergedPaths: post.unmergedPaths, markerFiles: post.markerFiles } };
    }
    // Finalize the merge commit the user resolved (no-op if VS Code already committed it).
    git.addAll({ cwd: repoDir });
    git.runGit({ cwd: repoDir, args: ['commit', '--no-edit'], env: COMMIT_ENV });
  }
  const head = git.revParse({ cwd: repoDir, rev: 'HEAD' });
  const mergeCommit = (mergeResult && mergeResult.mergeCommit) || (head && head.ok ? head.stdout.trim() : null);
  // Do NOT (re)write the 'resolved' record while polling an awaiting-pr run — a full
  // overwrite would drop the persisted status/pushInfo/binaryDecision, so the next
  // poll would miss the awaiting-pr re-check and open a SECOND PR. We're already past
  // 'resolved' on that path, so skip it.
  if (!(resume && prior && prior.status === 'awaiting-pr')) {
    RS.writeRunState(ppMergeDir, { phase: 'resolved', binding, envUrl, solutionUniqueName, solutionId, mergeCommit, textUnits: expectedPaths });
  }

  // A8 — ATOMIC resolution: decide the per-file binary/scalar strategy BEFORE the
  // push so every resolution decision is settled up front; then push EXACTLY ONCE
  // (the single merge commit) and reconcile EXACTLY ONCE over the COMPLETE set
  // (text + binary). Text merges are folded into the one git commit; per-file
  // keep-current and accept-incoming binary/scalar are applied in the single
  // Dataverse reconcile (accept-incoming adds nothing to git since ADO already holds
  // the winning bytes; keep-current is applied via the keep-current useraction in
  // that same reconcile). No intermediate commit holds a subset; an interruption
  // before the push leaves a resumable run (the merge commit is local-only).
  //
  // PER-FILE matrix (not a blanket strategy): the gate returns the user's selection
  // (serials/names to ACCEPT INCOMING); the rest KEEP CURRENT. Default = keep-current.
  let binaryDecisions = (prior && prior.binaryDecisions) || null;
  if (conflictedBinaries.length && !(resume && prior && RS.isAtOrBeyond(prior.phase, 'pushed')) && !(resume && prior && prior.status === 'awaiting-pr')) {
    const selection = await gate('binaryResolution', async () => 'keep-mine')({ binaryUnits: binaryMatrix });
    binaryDecisions = resolveBinaryDecisions(binaryMatrix, selection);
  }
  // Per-unit decision lookup with back-compat for a legacy blanket `binaryDecision`
  // string in an older run-state; default keep-current.
  const decisionForBinary = (u) =>
    (binaryDecisions && binaryDecisions[u.name]) ||
    (prior && prior.binaryDecision) ||
    'keep-current';

  // Phase 6 — push or PR (shared-state mutation → consent; fail-closed if no gate).
  let pushInfo = prior && prior.pushInfo;
  if (resume && prior && prior.status === 'awaiting-pr' && prior.pushInfo) {
    // Resuming a PR-gated run: re-check the EXISTING PR — never open a new one.
    const merged = await prMerged({ pushInfo: prior.pushInfo, binding, token: adoToken, deps });
    if (!merged) {
      // Re-persist the awaiting-pr record so the NEXT poll still re-checks this same
      // PR (never opens a duplicate).
      RS.writeRunState(ppMergeDir, { phase: 'resolved', status: 'awaiting-pr', prId: prior.pushInfo.prId, runBranch: prior.pushInfo.runBranch, binding, envUrl, solutionUniqueName, solutionId, mergeCommit, pushInfo: prior.pushInfo, binaryDecisions: prior.binaryDecisions || binaryDecisions });
      return { ok: true, status: 'awaiting-pr', prId: prior.pushInfo.prId, prUrl: prior.pushInfo.prUrl, runBranch: prior.pushInfo.runBranch, repoDir, mergeCommit };
    }
    pushInfo = prior.pushInfo; // PR merged → advance to the Dataverse reconcile
  } else if (!(resume && prior && RS.isAtOrBeyond(prior.phase, 'pushed'))) {
    const okPush = await gate('push', denyGate)({ repoDir, branch: binding.branch });
    if (!okPush) return { ok: false, status: 'cancelled', stage: 'push-consent', repoDir, mergeCommit };
    pushInfo = await deps.pushOrPr({
      repoDir, user, token: adoToken, autoComplete,
      binding: { organization: binding.organization, project: binding.project, repository: binding.repository, repositoryId: binding.repositoryId, branch: binding.branch },
      title: `Power Pages selective merge (${textUnits.length} component(s))`,
      description: 'Resolved Power Pages Dataverse↔ADO conflicts via clone-based selective merge.',
    });
    if (pushInfo && pushInfo.mode === 'pr') {
      // Q13: proceed only once the PR has merged; otherwise pause (resumable).
      const merged = await prMerged({ pushInfo, binding, token: adoToken, deps });
      if (!merged) {
        RS.writeRunState(ppMergeDir, { phase: 'resolved', status: 'awaiting-pr', prId: pushInfo.prId, runBranch: pushInfo.runBranch, binding, envUrl, solutionUniqueName, solutionId, mergeCommit, pushInfo, binaryDecisions });
        return { ok: true, status: 'awaiting-pr', prId: pushInfo.prId, prUrl: pushInfo.prUrl, runBranch: pushInfo.runBranch, repoDir, mergeCommit };
      }
    }
  }
  RS.writeRunState(ppMergeDir, { phase: 'pushed', binding, envUrl, solutionUniqueName, solutionId, mergeCommit, pushInfo, binaryDecisions });

  // Phase 7 — Dataverse reconcile (shared-state mutation → consent).
  const okPull = await gate('pull', denyGate)({ envUrl, branch: binding.branch });
  if (!okPull) return { ok: false, status: 'cancelled', stage: 'pull-consent', repoDir, mergeCommit, pushInfo };

  // Per-file binary/scalar decisions were settled BEFORE the push (A8). Build the
  // COMPLETE component set (text + binary) for the SINGLE reconcile pass, each binary
  // carrying its own accept-incoming/keep-current decision.
  const components = [
    ...textUnits.map((u) => {
      const merged = readResolvedContent(repoDir, u.adoPath, fsImpl) || '';
      // For a flat-yml site setting the resolved FILE is the whole yml; the reconcile
      // verifies the env's scalar `value` field, so compare against the merged value:
      // line, not the whole yml.
      const mergedContent = u.flatYml ? (extractYamlValue(merged) != null ? extractYamlValue(merged) : merged) : merged;
      return { ...u, decision: 'accept-incoming', mergedContent };
    }),
    ...conflictedBinaries.map((u) => ({ conflictId: u.conflictId, componentId: u.componentId, name: u.name, type: u.type, field: u.field, adoPath: u.adoPath, decision: decisionForBinary(u), mergedContent: readResolvedContent(repoDir, u.adoPath, fsImpl) || '' })),
  ];
  const recon = await deps.reconcileDataverse({
    components, envUrl, solutionUniqueName, solutionId, dvToken,
    // Issue-3 fix: reconcile keeps its OWN run-state file (a sub-namespace), so its
    // reduced phase vocabulary (started/accepted/pulled/verified) can never overwrite
    // the resolver's run-state.json and make a `--resume` think the merge is unstaged
    // (which would re-stage an already-pushed merge). The resolver's run-state stays
    // at 'pushed' through the reconcile; on resume it correctly re-enters reconcile.
    apply: true, runStateDir: path.join(ppMergeDir, 'reconcile'), runId: prior && prior.runId,
    // A5: let reconcile detect converged ("phantom") conflicts by comparing the env
    // value against the bound-branch file. After our push, HEAD in the clone is the
    // merged/pushed content = what's on the branch, so read it from there.
    deps: {
      readBranchContent: ({ adoPath }) => {
        try {
          const r = git.runGit({ cwd: repoDir, args: ['show', `HEAD:${relPath(adoPath)}`] });
          return r && r.ok ? r.stdout : null;
        } catch (_) { return null; }
      },
    },
  });
  RS.writeRunState(ppMergeDir, { phase: 'verified', status: recon.status, binding, envUrl, solutionUniqueName, solutionId, mergeCommit, pushInfo, reconcile: recon.status });

  // Phase 8 — metrics + return.
  if (deps.recordMergeMetrics) {
    try {
      deps.recordMergeMetrics({
        conflictCount: conflicts.length, textCount: textUnits.length, binaryCount: binaryUnits.length,
        acceptPath: pushInfo && pushInfo.mode, outcome: recon.status,
      });
    } catch (_) { /* metrics are best-effort */ }
  }

  return {
    ok: recon.ok !== false && recon.status !== 'failed',
    status: recon.status, repoDir, mergeCommit, pushInfo, reconcile: recon,
    binaryUnits: conflictedBinaries.map((u) => ({ name: u.name, route: u.route, decision: decisionForBinary(u) })),
    binaryDecisions, unresolved,
  };
}

// Best-effort "is the PR merged?" probe (Q13). Without a getPr dep we cannot know,
// so we conservatively report not-merged → the run pauses as resumable.
async function prMerged({ pushInfo, binding, token, deps }) {
  if (!deps.getPr || !pushInfo || !pushInfo.prId) return false;
  try {
    const pr = await deps.getPr({
      organization: binding.organization, project: binding.project, repository: binding.repository,
      pullRequestId: pushInfo.prId, token,
    });
    return !!pr && (pr.status === 'completed' || pr.merged === true);
  } catch { return false; }
}

function parseArgs(argv) {
  const a = argv.slice(2);
  const o = { input: null, apply: false, resume: false, allowPush: false, allowPull: false, allowRestart: false, pause: true, binaryKeepMine: false, binaryAcceptAll: false, binaryAccept: null };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--input' && a[i + 1]) o.input = a[++i];
    else if (a[i] === '--apply') o.apply = true;
    else if (a[i] === '--resume') o.resume = true;
    else if (a[i] === '--allow-push') o.allowPush = true;
    else if (a[i] === '--allow-pull') o.allowPull = true;
    else if (a[i] === '--allow-restart') o.allowRestart = true;
    else if (a[i] === '--binary-keep-mine') o.binaryKeepMine = true;
    else if (a[i] === '--binary-accept-all') o.binaryAcceptAll = true;
    else if (a[i] === '--binary-accept' && a[i + 1]) o.binaryAccept = a[++i]; // comma-separated serials/names → accept-incoming
    else if (a[i] === '--no-pause') o.pause = false;
  }
  return o;
}

// CLI: the skill drives the phased flow — dry-run (no --apply) → show plan →
// consent → --apply (stages + opens VS Code, returns 'awaiting-resolution') →
// "done?" → --resume (verify+finalize) → consent → --resume --allow-push →
// consent → --resume --allow-push --allow-pull. Tokens are minted in-process and
// NEVER read from the inputs file or echoed.
if (require.main === module) {
  (async () => {
    const args = parseArgs(process.argv);
    if (!args.input) { process.stderr.write('Specify --input <inputs.json> (binding, conflicts, cloneDir, envUrl, solutionUniqueName).\n'); process.exit(1); }
    let input;
    try { input = JSON.parse(fs.readFileSync(args.input, 'utf8')); } catch (e) { process.stderr.write('Failed to read --input: ' + e.message + '\n'); process.exit(1); }
    let dvToken = null; let adoToken = null;
    try { dvToken = require('./validation-helpers').getAuthToken(input.envUrl); } catch (_) { /* surfaced downstream */ }
    try { const r = require('./acquire-ado-token').acquireAdoToken(); adoToken = r && r.ok ? r.token : null; } catch (_) { /* surfaced downstream */ }
    const confirm = {
      done: async () => true, // the agent only re-invokes --resume after the user confirms
      push: async () => args.allowPush,
      pull: async () => args.allowPull,
      resumeOrRestart: async () => (args.allowRestart ? 'restart' : 'resume'),
      // Per-file binary matrix (Task 2): --binary-accept <serials/ranges> → those
      // ACCEPT INCOMING (parsed robustly: commas/spaces/ranges/`all`/`none`);
      // --binary-accept-all → all accept-incoming; --binary-keep-mine / default →
      // all keep-current (the user explicitly selects which files to accept incoming).
      binaryResolution: async ({ binaryUnits }) => {
        if (args.binaryAcceptAll) return 'all-accept';
        if (args.binaryAccept) {
          const { parseSerialSelection, describeInvalidSelection } = require('./parse-serial-selection');
          const validSerials = (binaryUnits || []).map((u) => u.serial);
          const parsed = parseSerialSelection(args.binaryAccept, validSerials);
          if (!parsed.ok) {
            throw new Error(`--binary-accept "${args.binaryAccept}" is invalid (${describeInvalidSelection(parsed)}). Valid serials: ${validSerials.join(', ')}.`);
          }
          return parsed.all ? 'all-accept' : parsed.accepted; // serial numbers → accept-incoming
        }
        return 'keep-mine';
      },
    };
    try {
      const res = await runCloneMerge({ ...input, dvToken, adoToken, apply: args.apply, resume: args.resume, pauseForResolution: args.pause, confirm });
      process.stdout.write(JSON.stringify(res, null, 2) + '\n');
      process.exit(res.status === 'failed' ? 1 : 0);
    } catch (e) {
      process.stderr.write('clone-merge-resolver: ' + e.message + '\n');
      process.exit(1);
    }
  })();
}

module.exports = { runCloneMerge, resolveUnits, repoUrlFromBinding, parseArgs, buildBinaryMatrix, resolveBinaryDecisions };
