#!/usr/bin/env node

// Stage a REAL Git merge in a cloned worktree so VS Code's native Source Control
// + 3-way Merge Editor + CodeLens light up on the actual repo files — the core of
// the clone-based selective-merge flow (plan Q4/Q5/Q6/Q7).
//
// Construction (Current = Dataverse, Incoming = Azure DevOps):
//   1. checkout -B dataverse <BASE>     (BASE = upstreamBranchSyncedCommitId; empty/orphan when null = add/add)
//   2. write OURS (env content) for ONLY the conflicted text files, byte-shaped to
//      match the ADO file's EOL/BOM (so only real edits conflict, not EOL skew)
//   3. commit                            -> HEAD = Current = Dataverse
//   4. branch -f azure-devops <THEIRS>;  git merge azure-devops
//        -> Git writes <<<<<<< HEAD / ======= / >>>>>>> azure-devops markers and
//           marks the paths unmerged. The worktree is LEFT conflicted for the human
//           to resolve in VS Code; the merge is committed later by the orchestrator
//           after the done-gate. A clean (non-overlapping) merge auto-commits here.
//
// Binary/scalar units are NOT text-merged here (Q8) — the caller routes those to
// keep/accept. This module handles only the text 3-way merge.
//
// All git access goes through the injectable gitImpl (./git-exec) and fs through
// fsImpl, so the choreography is unit-testable with no real git.

'use strict';

const path = require('path');
const fs = require('fs');
const gitExec = require('./git-exec');
const { detectShape, matchShape } = require('./eol-bom');
const { substituteYamlValue } = require('./flat-yml-merge');

const DATAVERSE_BRANCH = 'dataverse';      // Current side (HEAD)
const THEIRS_BRANCH = 'azure-devops';      // Incoming side (marker label)
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; // git's well-known empty tree

// Identity for the synthetic Dataverse commit — passed per-invocation so we never
// depend on (or mutate) the user's global git config.
const COMMIT_ENV = Object.freeze({
  GIT_AUTHOR_NAME: 'Power Pages', GIT_AUTHOR_EMAIL: 'powerpages@localhost',
  GIT_COMMITTER_NAME: 'Power Pages', GIT_COMMITTER_EMAIL: 'powerpages@localhost',
});

function relPath(adoPath) {
  return String(adoPath || '').replace(/^[/\\]+/, '').replace(/\\/g, '/');
}

// Parse `git status --porcelain` for unmerged (conflicted) paths.
function parseUnmergedPaths(porcelain) {
  const out = [];
  for (const line of String(porcelain || '').split('\n')) {
    if (line.length < 4) continue;
    const xy = line.slice(0, 2);
    const file = line.slice(3).trim();
    // Unmerged states: DD, AU, UD, UA, DU, AA, UU.
    if (/[U]/.test(xy) || xy === 'DD' || xy === 'AA') out.push(file);
  }
  return out;
}

// Pick the merge BASE from ordered candidate commits: the FIRST that resolves AND
// contains every conflicted file wins, so the merge is a real 3-way (modify/modify)
// — which VS Code's merge editor needs. A base MISSING the files yields add/add with
// NO base stage, and the editor errors (EntryNotFound). When NO candidate contains
// all files and a `discoverRef` (the THEIRS branch/tip) is given, AUTO-DISCOVER the
// newest commit on that ref that contains every conflicted file (walking rev-list).
// Falls back to the candidate covering the MOST files, then null (empty/orphan add/add).
function commitContainsAll(commit, paths, git) {
  return paths.length > 0 && paths.every((p) => { const e = git(['cat-file', '-e', `${commit}:${p}`]); return !!(e && e.ok); });
}

function pickBaseCommit({ candidates, relPaths, git, discoverRef = null, maxWalk = 200 }) {
  const valid = [];
  for (const c of candidates || []) {
    if (!c) continue;
    const r = git(['rev-parse', '--verify', '--quiet', `${c}^{commit}`]);
    if (r && r.ok && String(r.stdout).trim()) valid.push(c);
  }
  const paths = relPaths || [];
  let best = null;
  let bestCount = -1;
  for (const c of valid) {
    const count = paths.filter((p) => { const e = git(['cat-file', '-e', `${c}:${p}`]); return !!(e && e.ok); }).length;
    if (paths.length && count === paths.length) return c; // contains all → ideal
    if (count > bestCount) { best = c; bestCount = count; }
  }

  // A2(b): no candidate contains ALL files — auto-discover from the THEIRS history.
  // The newest commit on `discoverRef` that contains every conflicted file is an
  // ancestor of THEIRS and holds the files → a real 3-way base (modify/modify).
  if (discoverRef && paths.length) {
    const discovered = discoverBaseCommit({ discoverRef, relPaths: paths, git, maxWalk });
    if (discovered) return discovered;
  }
  return best;
}

// Walk `git rev-list <discoverRef>` (newest first, capped) and return the first
// commit that contains every conflicted file. CRITICAL: never return the THEIRS tip
// itself — a base == THEIRS makes `git merge THEIRS` "already up to date" (THEIRS
// becomes an ancestor of the dataverse HEAD), producing a CLEAN merge that keeps
// OURS only and SILENTLY DROPS the incoming ADO edits. The base must be a proper
// ANCESTOR of THEIRS; if none contains the files, return null → orphan add/add,
// which at least surfaces the conflict instead of losing work.
function discoverBaseCommit({ discoverRef, relPaths, git, maxWalk = 200 }) {
  let tipSha = null;
  const tip = git(['rev-parse', '--verify', '--quiet', `${discoverRef}^{commit}`]);
  if (tip && tip.ok && String(tip.stdout).trim()) tipSha = String(tip.stdout).trim();
  const rev = git(['rev-list', `--max-count=${maxWalk}`, discoverRef]);
  if (!rev || !rev.ok) return null;
  const commits = String(rev.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
  for (const c of commits) {
    if (tipSha && c === tipSha) continue; // never use THEIRS itself as the base
    if (commitContainsAll(c, relPaths, git)) return c;
  }
  return null;
}

// A2(c): detect add/add degradation. After a conflicted merge, `git ls-files -u`
// lists unmerged index entries as `<mode> <sha> <stage>\t<path>` where stage 1 =
// base, 2 = ours, 3 = theirs. A conflicted path with stages 2/3 but NO stage 1 has
// NO common base → the merge editor shows the WHOLE file as conflict (no base).
// Returns the conflicted paths that are missing their base stage.
function detectAddAddPaths(git) {
  const res = git(['ls-files', '-u']);
  if (!res || !res.ok) return [];
  const stages = new Map(); // path -> Set(stage numbers)
  for (const line of String(res.stdout || '').split('\n')) {
    const m = line.match(/^\S+\s+\S+\s+([0-9])\t(.+)$/);
    if (!m) continue;
    const stage = Number(m[1]);
    const file = m[2].trim();
    if (!stages.has(file)) stages.set(file, new Set());
    stages.get(file).add(stage);
  }
  const addAdd = [];
  for (const [file, set] of stages) {
    if ((set.has(2) || set.has(3)) && !set.has(1)) addAdd.push(file);
  }
  return addAdd;
}

/**
 * @param {object} args
 * @param {string} args.repoDir        the clone working tree
 * @param {string|null} [args.baseCommit]  explicit BASE sha (back-compat); prefer baseCandidates
 * @param {string[]} [args.baseCandidates]  ordered BASE candidates (e.g. [branchSyncedCommitId, upstreamBranchSyncedCommitId]); the first containing all conflicted files is used
 * @param {string} args.theirsRef      ADO branch tip ref or sha (the Incoming side)
 * @param {Array}  args.textUnits      [{ adoPath, oursContent, name?, field? }] — text conflicts ONLY
 * @param {object} [args.gitImpl]      injectable git-exec (tests)
 * @param {object} [args.fsImpl]       injectable fs (tests)
 * @returns {{ ok, dataverseBranch, theirsBranch, baseUsed, baseCommit, wrote:string[], merge:{ clean, conflicted, conflictedPaths:string[] }, mergeCommit:string|null, error? }}
 */
function stageGitMerge({ repoDir, baseCommit, baseCandidates = null, theirsRef, textUnits, gitImpl = gitExec, fsImpl = fs } = {}) {
  if (!repoDir) throw new Error('stageGitMerge: repoDir is required');
  if (!theirsRef) throw new Error('stageGitMerge: theirsRef is required');
  if (!Array.isArray(textUnits)) throw new Error('stageGitMerge: textUnits must be an array');

  const git = (args, extra = {}) => gitImpl.runGit({ cwd: repoDir, args, ...extra });
  const ensureOk = (res, what) => { if (!res || !res.ok) throw new Error(`${what} failed: ${res ? res.stderr || res.code : 'no result'}`); return res; };

  // Bug 5/6: during staging we must (a) preserve bytes so a pure EOL/BOM skew can't
  // turn the whole file into one false conflict, and (b) emit STANDARD conflict
  // markers (<<<<<<< / ======= / >>>>>>>) so VS Code's 3-way merge editor opens its
  // one-click Accept controls instead of dropping into "Manual Resolution". We set
  // these on the clone's LOCAL config (scoped to staging) and restore the prior
  // values in `finally` so a reused clone is never left mutated:
  //   core.autocrlf=false   → git never re-normalizes line endings on add/checkout
  //                           (core.eol is only consulted for `text`-attr'd paths,
  //                            which we deliberately don't force; autocrlf=false is
  //                            the byte-preserving switch).
  //   merge.conflictStyle=merge → standard 3-part markers (no diff3 |||||| base
  //                               section that confuses the merge editor).
  const cfgGet = (k) => { const r = git(['config', '--local', '--get', k]); return r && r.ok ? String(r.stdout || '').trim() : null; };
  const cfgSet = (k, v) => git(['config', '--local', k, v]);
  const cfgUnset = (k) => git(['config', '--local', '--unset', k]);
  const cfgRestore = (k, prior) => { if (prior == null || prior === '') cfgUnset(k); else cfgSet(k, prior); };
  let priorCfg = null;

  try {
    priorCfg = { autocrlf: cfgGet('core.autocrlf'), conflictStyle: cfgGet('merge.conflictStyle') };
    cfgSet('core.autocrlf', 'false');
    cfgSet('merge.conflictStyle', 'merge');

    const relPaths = textUnits.map((u) => relPath(u.adoPath));
    const candidates = Array.isArray(baseCandidates) && baseCandidates.length ? baseCandidates : (baseCommit ? [baseCommit] : []);
    // A2: pass the THEIRS ref so pickBaseCommit can auto-discover a containing base
    // when the supplied candidates miss the conflicted files (prevents add/add).
    const effectiveBase = pickBaseCommit({ candidates, relPaths, git, discoverRef: theirsRef });
    const baseUsed = effectiveBase ? 'commit' : 'empty';

    // Bug 3: resolve the INCOMING tip from the fetched ref (origin/<branch>), never
    // the local checkout. The resolver passes theirsRef = the post-fetch origin tip;
    // we resolve it to a SHA so the merge is provably against the advanced ADO tip,
    // and surface base+incoming SHAs in the result (and a DEBUG log) for traceability.
    const incRes = git(['rev-parse', '--verify', '--quiet', `${theirsRef}^{commit}`]);
    const incomingSha = incRes && incRes.ok ? String(incRes.stdout || '').trim() : null;
    if (process.env.DEBUG) {
      const note = (effectiveBase && incomingSha && effectiveBase === incomingSha)
        ? ' WARNING: base == incoming tip (clone may be stale — incoming would be a no-op)'
        : '';
      process.stderr.write(`[stage-git-merge] base=${effectiveBase || 'empty'} incoming=${incomingSha || theirsRef} ref=${theirsRef}${note}\n`);
    }

    // 1) Create/reset the Dataverse branch at BASE (-B forces, so a prior run's
    //    branch is reset cleanly) or an orphan for empty BASE (add/add).
    if (effectiveBase) {
      ensureOk(git(['checkout', '-B', DATAVERSE_BRANCH, effectiveBase]), 'checkout -B dataverse <base>');
    } else {
      // Empty BASE → orphan branch cleared to empty, so OURS files are fresh adds
      // and overlap with THEIRS becomes an add/add conflict.
      git(['checkout', '--detach']);                 // best-effort: get off dataverse before deleting it
      git(['branch', '-D', DATAVERSE_BRANCH]);    // best-effort: drop a prior run's branch
      ensureOk(git(['checkout', '--orphan', DATAVERSE_BRANCH]), 'checkout --orphan dataverse');
      git(['rm', '-rf', '.']);                    // clear index + worktree (best-effort)
    }

    // Shape reference = the THEIRS version of each file (the repo style we merge into).
    const theirsShape = (rel) => {
      const r = git(['show', `${theirsRef}:${rel}`]);
      return r && r.ok ? detectShape(r.stdout) : { eol: '\n', bom: false };
    };

    // 2) Write OURS for each conflicted text file, byte-shaped to match THEIRS (Q7).
    const wrote = [];
    for (const u of textUnits) {
      const rel = relPath(u.adoPath);
      if (!rel) continue;
      const abs = path.join(repoDir, rel);
      fsImpl.mkdirSync(path.dirname(abs), { recursive: true });
      // Defense-in-depth: never write OURS into a directory. A web file in the
      // containerized layout (web-files/<name>/<name>) must already be resolved to its
      // inner leaf by the caller; if a folder path slips through, surface a clear
      // reason instead of a raw EISDIR that fails the whole batch.
      if (typeof fsImpl.statSync === 'function') {
        let targetStat = null;
        try { targetStat = fsImpl.statSync(abs); } catch (_) { targetStat = null; }
        if (targetStat && typeof targetStat.isDirectory === 'function' && targetStat.isDirectory()) {
          throw new Error(`containerized-webfile: '${rel}' is a directory, not a file — expected the inner web-file leaf (e.g. <name>/<name>). The web-file path was not resolved to its container leaf.`);
        }
      }
      let oursText;
      if (u.flatYml) {
        // Flat-YML site setting: OURS = the BASE yml (metadata) with the env's `value:`
        // substituted in, so OURS and THEIRS differ ONLY on the value line. The
        // checked-out file holds BASE; if absent (add/add) fall back to THEIRS' shape.
        let skeleton = '';
        try { skeleton = fsImpl.readFileSync(abs, 'utf8'); } catch { /* no base file */ }
        if (!skeleton) { const t = git(['show', `${theirsRef}:${rel}`]); skeleton = t && t.ok ? t.stdout : ''; }
        oursText = substituteYamlValue(skeleton, u.oursContent != null ? u.oursContent : '');
      } else {
        oursText = String(u.oursContent != null ? u.oursContent : '');
      }
      fsImpl.writeFileSync(abs, matchShape(oursText, theirsShape(rel)), 'utf8');
      wrote.push(rel);
    }

    // 3) Commit the Dataverse side (allow-empty so the branch exists even if OURS == BASE).
    ensureOk(gitImpl.addAll({ cwd: repoDir }), 'git add');
    ensureOk(git(['commit', '--allow-empty', '-m', 'Power Pages environment (Dataverse) state for merge'], { env: COMMIT_ENV }), 'git commit (dataverse)');

    // 4) Point a nicely-named ref at THEIRS and merge it → Incoming = "azure-devops".
    ensureOk(git(['branch', '-f', THEIRS_BRANCH, theirsRef]), 'git branch -f azure-devops <theirs>');
    const mergeArgs = ['merge', '--no-edit', THEIRS_BRANCH];
    if (!effectiveBase) mergeArgs.splice(1, 0, '--allow-unrelated-histories');
    const mergeRes = git(mergeArgs, { env: COMMIT_ENV });

    if (mergeRes && mergeRes.ok) {
      // Clean, non-overlapping merge — git auto-committed. Nothing to resolve.
      const head = gitImpl.revParse({ cwd: repoDir, rev: 'HEAD' });
      return {
        ok: true, dataverseBranch: DATAVERSE_BRANCH, theirsBranch: THEIRS_BRANCH, baseUsed,
        baseCommit: effectiveBase || null, incomingRef: theirsRef, incomingSha, wrote,
        merge: { clean: true, conflicted: false, conflictedPaths: [] },
        mergeCommit: head && head.ok ? head.stdout.trim() : null,
      };
    }

    // Non-zero exit: conflicts (expected) vs a real failure. Conflicts leave unmerged paths.
    const status = gitImpl.status({ cwd: repoDir });
    const conflictedPaths = parseUnmergedPaths(status && status.stdout);
    if (conflictedPaths.length === 0) {
      // Exit != 0 but no unmerged paths ⇒ a genuine merge failure (not a conflict).
      return { ok: false, error: `git merge failed: ${mergeRes ? mergeRes.stderr || mergeRes.code : 'unknown'}`, dataverseBranch: DATAVERSE_BRANCH, baseUsed, incomingRef: theirsRef, incomingSha, wrote, merge: { clean: false, conflicted: false, conflictedPaths: [] }, mergeCommit: null };
    }
    // A2(c): flag add/add degradation (conflicted paths with no base stage). With a
    // real base this should be empty; a non-empty list means the merge editor will
    // show whole-file conflicts (no base) — surfaced so the orchestrator can warn.
    const addAddPaths = detectAddAddPaths(git);
    return {
      ok: true, dataverseBranch: DATAVERSE_BRANCH, theirsBranch: THEIRS_BRANCH, baseUsed, baseCommit: effectiveBase || null, incomingRef: theirsRef, incomingSha, wrote,
      merge: { clean: false, conflicted: true, conflictedPaths, addAddPaths, hasBaseStage: addAddPaths.length === 0 },
      mergeCommit: null, // left unmerged for the human to resolve; orchestrator commits after the done-gate
    };
  } catch (e) {
    return { ok: false, error: e.message, dataverseBranch: DATAVERSE_BRANCH, merge: { clean: false, conflicted: false, conflictedPaths: [] }, mergeCommit: null };
  } finally {
    // Bug 5/6: restore the clone's prior EOL/conflict-style config so a reused clone
    // is never left mutated (best-effort; never throws).
    if (priorCfg) {
      try { cfgRestore('core.autocrlf', priorCfg.autocrlf); } catch (_) { /* best-effort */ }
      try { cfgRestore('merge.conflictStyle', priorCfg.conflictStyle); } catch (_) { /* best-effort */ }
    }
  }
}

module.exports = { stageGitMerge, pickBaseCommit, discoverBaseCommit, detectAddAddPaths, commitContainsAll, parseUnmergedPaths, DATAVERSE_BRANCH, THEIRS_BRANCH, EMPTY_TREE };
