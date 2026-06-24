#!/usr/bin/env node

// Ensures the off-tree, per-branch full clone for clone-based conflict
// resolution exists, points at the expected remote, and is pristine.
//
// Error contract: in-progress merges and lock contention are returned as
// structured results; hard git/cache failures throw Error objects with any
// supplied token scrubbed from the message.

'use strict';

const fs = require('fs');
const path = require('path');
const { cloneDirLayout } = require('./resolve-clone-path');
const cloneCache = require('./clone-cache-store');
const defaultGit = require('./git-exec');
const mergeState = require('./detect-merge-state');

const LOCK_FILE = 'run.lock';
const FRESH_LOCK_MS = 15 * 60 * 1000;

function trimOutput(result) {
  return String((result && result.stdout) || '').trim();
}

function resultText(result) {
  return [result && result.stderr, result && result.stdout].filter(Boolean).join('\n').trim();
}

function scrub(text, token, git) {
  if (git && typeof git.scrubToken === 'function') return git.scrubToken(text, token);
  if (!token) return String(text || '');
  return String(text || '').split(String(token)).join('***');
}

function throwGitError(action, result, token, git) {
  const detail = resultText(result);
  const suffix = detail ? `: ${scrub(detail, token, git)}` : '';
  throw new Error(`${action} failed${suffix}`);
}

function ensureOk(action, result, token, git) {
  if (!result || !result.ok) throwGitError(action, result, token, git);
  return result;
}

function normalizeRepoUrl(value) {
  let normalized = String(value || '').trim().toLowerCase();
  let changed = true;
  while (changed) {
    const before = normalized;
    normalized = normalized.replace(/[\\/]+$/g, '').replace(/\.git$/i, '');
    changed = normalized !== before;
  }
  return normalized;
}

function statMtimeMs(file, fsImpl) {
  try {
    const stat = fsImpl.statSync(file);
    return stat && Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : 0;
  } catch (_) {
    return 0;
  }
}

function acquireLock(ppMergeDir, fsImpl) {
  const lockPath = path.join(ppMergeDir, LOCK_FILE);
  const now = Date.now();
  const payload = JSON.stringify({ pid: process.pid, createdAt: new Date(now).toISOString() });
  const isEexist = (error) => error && error.code === 'EEXIST';
  try {
    fsImpl.writeFileSync(lockPath, payload, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    return { locked: false, lockPath };
  } catch (e) {
    if (!isEexist(e)) return { locked: false, lockPath: null };
    if ((now - statMtimeMs(lockPath, fsImpl)) < FRESH_LOCK_MS) {
      return { locked: true, lockPath };
    }
    try {
      fsImpl.unlinkSync(lockPath);
      fsImpl.writeFileSync(lockPath, payload, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      return { locked: false, lockPath };
    } catch (retryError) {
      if (isEexist(retryError)) return { locked: true, lockPath };
      return { locked: false, lockPath: null };
    }
  }
}

function releaseLock(lockPath, fsImpl) {
  if (!lockPath) return;
  try {
    fsImpl.unlinkSync(lockPath);
  } catch (_) {
    // Best-effort only.
  }
}

async function isGitRepo({ repoDir, git, token, fsImpl }) {
  if (!fsImpl.existsSync(path.join(repoDir, '.git'))) return false;
  const result = await git.runGit({ cwd: repoDir, args: ['rev-parse', '--git-dir'], token });
  return Boolean(result && result.ok);
}

async function branchResolvable({ repoDir, branch, git, token }) {
  const remote = await git.runGit({ cwd: repoDir, args: ['rev-parse', '--verify', `origin/${branch}`], token });
  if (remote && remote.ok) return true;
  const local = await git.runGit({ cwd: repoDir, args: ['rev-parse', '--verify', branch], token });
  return Boolean(local && local.ok);
}

async function cloneFresh({ repoUrl, repoDir, branch, token, git }) {
  const result = await git.clone({ repoUrl, dir: repoDir, branch, token });
  ensureOk('git clone', result, token, git);
}

async function wipeAndClone({ cloneDir, repoUrl, repoDir, ppMergeDir, branch, token, deps, fsImpl, git }) {
  await deps.wipeClone({ cloneDir }, fsImpl);
  await deps.prepareCacheDirs({ cloneDir, repoDir, ppMergeDir }, fsImpl);
  await cloneFresh({ repoUrl, repoDir, branch, token, git });
}

async function resolveBranchTip({ repoDir, branch, token, git }) {
  const remote = await git.runGit({ cwd: repoDir, args: ['rev-parse', `origin/${branch}`], token });
  if (remote && remote.ok) return trimOutput(remote);
  const head = await git.runGit({ cwd: repoDir, args: ['rev-parse', 'HEAD'], token });
  ensureOk('git rev-parse HEAD', head, token, git);
  return trimOutput(head);
}

/**
 * Ensures the full git clone at <cloneDir>/repo is present, points at the
 * expected remote, and is reset to the tip of `branch`.
 *
 * @param {object} opts
 * @param {string} opts.cloneDir  Absolute path to the flat, user-chosen clone root.
 * @param {string} opts.repoUrl   Remote repository URL.
 * @param {string} opts.branch    Branch to track.
 * @param {string} [opts.token]   ADO PAT / auth token (scrubbed from error messages).
 * @param {object} [opts.deps]    Dependency overrides for testing.
 * @param {object} [opts.fsImpl]  Filesystem implementation override for testing.
 * @returns {Promise<{cloneDir, repoDir, ppMergeDir, branchTip, cloned, reused, reCloned, inProgressMerge, locked}>}
 */
async function cloneOrUpdateRepo({
  cloneDir,
  repoUrl,
  branch,
  token,
  deps = {},
  fsImpl = deps.fsImpl || fs,
} = {}) {
  const resolvedDeps = {
    cloneDirLayout: deps.cloneDirLayout || cloneDirLayout,
    prepareCacheDirs: deps.prepareCacheDirs || cloneCache.prepareCacheDirs,
    wipeClone: deps.wipeClone || cloneCache.wipeClone,
    detectMergeState: deps.detectMergeState || mergeState.detectMergeState,
  };
  const git = deps.git || defaultGit;

  const layout = resolvedDeps.cloneDirLayout(cloneDir);
  const { repoDir, ppMergeDir } = layout;
  const repoDirExisted = fsImpl.existsSync(repoDir);

  await resolvedDeps.prepareCacheDirs({ cloneDir, repoDir, ppMergeDir }, fsImpl);
  const lock = acquireLock(ppMergeDir, fsImpl);
  if (lock.locked) {
    return {
      cloneDir,
      repoDir,
      ppMergeDir,
      branchTip: null,
      cloned: false,
      reused: false,
      reCloned: false,
      inProgressMerge: false,
      locked: true,
    };
  }

  try {
    let cloned = false;
    let reused = false;
    let reCloned = false;
    let mergeStateResult = null;

    const validGitRepo = await isGitRepo({ repoDir, git, token, fsImpl });
    if (!validGitRepo) {
      if (repoDirExisted) {
        await wipeAndClone({ cloneDir, repoUrl, repoDir, ppMergeDir, branch, token, deps: resolvedDeps, fsImpl, git });
        reCloned = true;
      } else {
        await cloneFresh({ repoUrl, repoDir, branch, token, git });
        cloned = true;
      }
    } else {
      const remoteResult = await git.runGit({ cwd: repoDir, args: ['remote', 'get-url', 'origin'], token });
      if (!remoteResult || !remoteResult.ok || normalizeRepoUrl(trimOutput(remoteResult)) !== normalizeRepoUrl(repoUrl)) {
        await wipeAndClone({ cloneDir, repoUrl, repoDir, ppMergeDir, branch, token, deps: resolvedDeps, fsImpl, git });
        reCloned = true;
      } else if (!(await branchResolvable({ repoDir, branch, git, token }))) {
        await wipeAndClone({ cloneDir, repoUrl, repoDir, ppMergeDir, branch, token, deps: resolvedDeps, fsImpl, git });
        reCloned = true;
      } else {
        mergeStateResult = await resolvedDeps.detectMergeState({ repoDir, gitImpl: git, fsImpl });
        if (mergeStateResult && mergeStateResult.inProgressMerge) {
          return {
            cloneDir,
            repoDir,
            ppMergeDir,
            cloned: false,
            reused: true,
            reCloned: false,
            inProgressMerge: true,
            branchTip: null,
            locked: false,
            mergeState: mergeStateResult,
          };
        }

        ensureOk('git fetch origin', await git.fetch({ cwd: repoDir, remote: 'origin', token }), token, git);
        ensureOk('git checkout branch', await git.runGit({ cwd: repoDir, args: ['checkout', '-B', branch, `origin/${branch}`], token }), token, git);
        ensureOk('git reset --hard', await git.runGit({ cwd: repoDir, args: ['reset', '--hard', `origin/${branch}`], token }), token, git);
        ensureOk('git clean -fd', await git.runGit({ cwd: repoDir, args: ['clean', '-fd'], token }), token, git);
        reused = true;
      }
    }

    // Persist long-path support in the clone so VS Code's Git extension and manual
    // git commands can read deep Power Pages export paths (Windows MAX_PATH 260) —
    // our per-invocation `-c core.longpaths=true` only covers OUR git calls, not
    // VS Code's git extension (which is what opens the native merge editor).
    try { await git.runGit({ cwd: repoDir, args: ['config', 'core.longpaths', 'true'] }); } catch (_) { /* best-effort */ }

    const branchTip = await resolveBranchTip({ repoDir, branch, token, git });

    return {
      cloneDir,
      repoDir,
      ppMergeDir,
      cloned,
      reused,
      reCloned,
      inProgressMerge: false,
      branchTip,
      locked: false,
      ...(mergeStateResult ? { mergeState: mergeStateResult } : {}),
    };
  } catch (e) {
    const message = e && e.message ? e.message : String(e);
    throw new Error(scrub(message, token, git));
  } finally {
    releaseLock(lock.lockPath, fsImpl);
  }
}

module.exports = {
  cloneOrUpdateRepo,
  normalizeRepoUrl,
};
