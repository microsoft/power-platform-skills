#!/usr/bin/env node

// Single source of truth for `git-configure` artifact paths.
//
// `git-configure` is the merged inner-loop skill that replaces
// `setup-git-integration` + `connect-solution-to-git` + `branch-switch`. It
// has its own state files because its lifecycle markers (setup / switch /
// rebind / disconnect) need to round-trip through one validator
// (`scripts/validate-git-configure.js`) regardless of which mode ran.
//
// We use a dedicated path registry — instead of bolting new keys onto
// `inner-loop-paths.js` — for two reasons:
//
//   1. **Lifecycle isolation.** When the legacy `last-setup.json` /
//      `last-branch-switch.json` markers are removed alongside the legacy
//      skills, this registry stays stable. No skill outside `git-configure`
//      should ever write these files; isolating the keys here makes that
//      contract explicit (callers that import this module ARE git-configure).
//
//   2. **Mode-aware dispatch.** `lastGitConfigure` is written by setup /
//      switch-branch / rebind / disconnect modes. Keeping the keys in one
//      frozen table makes the artifact set easy to reason about.
//
// Mirrors the structural pattern of `alm-paths.js` (which owns ALM artifacts
// under `docs/alm/`) and `inner-loop-paths.js` (which owns inner-loop
// artifacts under `docs/inner-loop/`). Like both of those, every `git-configure`
// artifact lives under `docs/inner-loop/` (git-configure IS an inner-loop
// skill — it just owns its own subset of files).
//
// All callers must require this module instead of inlining
// `path.join(root, 'docs/inner-loop/last-git-configure.json')`. The frozen
// FILE_NAMES table makes typos a hard error (gitConfigurePath('lstGitConfg')
// throws).

'use strict';

const fs = require('fs');
const path = require('path');
const { ensureInnerLoopGitignore } = require('./inner-loop-paths');

const GIT_CONFIGURE_DIR = 'docs/inner-loop';

const FILE_NAMES = Object.freeze({
  // Skill-run marker (written when git-configure mode setup / switch-branch /
  // rebind / disconnect completes successfully). Carries fields:
  //   { skill: 'git-configure', mode, ranAt, envUrl, organization, project,
  //     repository, oldBranch?, newBranch?, gitFolder, solutionUniqueName?,
  //     bindingType, status: 'ok' | 'failed', error? }
  // Consumed by `validate-git-configure.js` PostToolUse hook AND by
  // `git-sync` when it detects state on entry.
  lastGitConfigure:            'last-git-configure.json',

  // Snapshot of the chosen plan (ADO coords, mode, headless flag, picked
  // solution) just before the final-consent gate fires. Written ONLY when the
  // user accepts the plan-approval gate; consumed by the verification phase
  // to compare expected-vs-actual binding after the platform call returns.
  // Cleared after Phase 8 verifies the round-trip.
  gitConfigurePlanData:        'git-configure-plan-data.json',
});

/**
 * Returns the absolute directory path that holds the git-configure artifacts.
 *
 * @param {string} projectRoot
 * @returns {string}
 */
function gitConfigureDir(projectRoot) {
  if (!projectRoot) throw new Error('gitConfigureDir: projectRoot is required');
  return path.join(projectRoot, GIT_CONFIGURE_DIR);
}

/**
 * Returns the absolute path of a git-configure artifact for a given logical key.
 * Use the keys from FILE_NAMES (e.g. 'lastGitConfigure', 'gitConfigurePlanData').
 *
 * @param {string} projectRoot
 * @param {keyof typeof FILE_NAMES} key
 * @returns {string}
 */
function gitConfigurePath(projectRoot, key) {
  const fileName = FILE_NAMES[key];
  if (!fileName) throw new Error(`gitConfigurePath: unknown key '${key}'`);
  return path.join(gitConfigureDir(projectRoot), fileName);
}

/**
 * Creates `<projectRoot>/docs/inner-loop/` if it doesn't exist, and ensures the
 * fail-closed `.gitignore` is present (shared with inner-loop-paths.js so the
 * folder is self-protecting regardless of which skill creates it first).
 * Idempotent. Callers should invoke this once before any write to a
 * git-configure artifact.
 *
 * @param {string} projectRoot
 * @returns {string} The absolute git-configure dir path
 */
function ensureGitConfigureDir(projectRoot) {
  const dir = gitConfigureDir(projectRoot);
  fs.mkdirSync(dir, { recursive: true });
  ensureInnerLoopGitignore(projectRoot);
  return dir;
}

module.exports = {
  GIT_CONFIGURE_DIR,
  FILE_NAMES,
  gitConfigureDir,
  gitConfigurePath,
  ensureGitConfigureDir,
};
