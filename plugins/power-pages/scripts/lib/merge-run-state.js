#!/usr/bin/env node

// Resumable run-state for the clone-based merge flow.
//
// WHY: a merge run is a multi-step, partly-async mutation — clone/stage → resolve
// in VS Code → push (or open a PR and WAIT for it to merge) → refresh → accept →
// pull → verify. If it stops partway (PR not yet merged, accept/pull fails), the
// run must RESUME from the last good phase or ROLL BACK (re-commit the OURS
// snapshot via the safe push→pull path — never a history rewrite). This module
// persists a tiny phase/status record after each step.
//
// The record lives in the clone's owner-only `.pp-merge/run-state.json` (off the
// repo's tracked tree). It holds only identifiers + phase/status — never component
// source.

'use strict';

const fs = require('fs');
const path = require('path');
const { stamp } = require('./artifact-timestamps');

// Ordered phases for the clone-based merge flow. Higher rank = further along.
// 'awaiting-pr' is a PAUSE *status* (state.status), NOT a linear phase, so a run
// blocked on a PR merge never outranks a direct push.
//   started   → run initialized (clone/stage beginning)
//   staged    → real git merge staged in the clone (conflicts present or clean)
//   resolved  → user finished; no markers; merge committed locally
//   pushed    → merge landed on the bound branch (FF push) OR the PR merged
//   refreshed → RefreshChangesFromGit done
//   accepted  → accept-incoming (useraction=2) done
//   pulled    → PullChangesFromGit done
//   verified  → conflicts=0 + content-verify done (TERMINAL)
const PHASES = Object.freeze(['started', 'staged', 'resolved', 'pushed', 'refreshed', 'accepted', 'pulled', 'verified']);
const TERMINAL = Object.freeze(['verified', 'rolledback']);

function phaseRank(phase) {
  const i = PHASES.indexOf(phase);
  return i < 0 ? -1 : i;
}

/** True when `current` is at or beyond `target` (so that phase can be skipped on resume). */
function isAtOrBeyond(current, target) {
  return phaseRank(current) >= phaseRank(target);
}

const STATE_FILE = 'run-state.json';

function runStateFilePath(dir) {
  return path.join(dir, STATE_FILE);
}

/**
 * Persist (overwrite) the run-state in the clone's owner-only `.pp-merge` dir.
 * Holds only identifiers + phase/status — never component source.
 * @param {string} dir   the clone's `.pp-merge` directory
 * @param {object} state { phase, status, prId, runBranch, mergeCommit, components, binding, envUrl, solutionUniqueName, solutionId, error }
 * @returns {string} absolute path written
 */
function writeRunState(dir, state) {
  if (!dir) throw new Error('run-state dir is required');
  fs.mkdirSync(dir, { recursive: true });
  const file = runStateFilePath(dir);
  // E1/E3: stamp createdAt (preserved across overwrites) + updatedAt (always fresh)
  // in ISO-8601 UTC so any later agent can reason about recency/staleness.
  const prior = readRunState(dir);
  const payload = stamp({ ...state, ...(prior && prior.createdAt ? { createdAt: prior.createdAt } : {}) });
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
  try { fs.chmodSync(file, 0o600); } catch (_) { /* best-effort (no-op on Windows) */ }
  return file;
}

/**
 * Read the run-state from a clone's `.pp-merge` dir, or null if there is none.
 * @param {string} dir
 * @returns {object|null}
 */
function readRunState(dir) {
  if (!dir) throw new Error('run-state dir is required');
  let raw;
  try { raw = fs.readFileSync(runStateFilePath(dir), 'utf8'); } catch { return null; }
  try { return JSON.parse(raw); } catch { return null; }
}

/** Best-effort removal of the run-state file (does not wipe the clone). */
function clearRunState(dir) {
  try { fs.unlinkSync(runStateFilePath(dir)); return true; } catch { return false; }
}

module.exports = {
  PHASES,
  TERMINAL,
  phaseRank,
  isAtOrBeyond,
  writeRunState,
  readRunState,
  clearRunState,
  runStateFilePath,
  STATE_FILE,
};
