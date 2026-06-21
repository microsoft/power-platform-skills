#!/usr/bin/env node

// Resumable run-state for the selective-merge APPLY phase.
//
// WHY: apply is a multi-step mutation — commit merged file to ADO → refresh →
// accept incoming → pull into Dataverse → verify. If it dies after the ADO commit
// (e.g. accept or pull fails), state is split: ADO holds the merged commit but the
// environment may not. Without a recovery record the operator is stuck guessing
// what completed. This module persists a tiny phase record after each step so the
// run can be RESUMED (continue from the last good phase) or ROLLED BACK (restore
// the pre-merge OURS via the same safe commit→pull path — never a history rewrite).
//
// The record lives in the secure artifact store (`<store>/<runId>/run-state.json`,
// owner-only, wiped by wipeMergeRun). It holds only identifiers + the absolute
// snapshot path — never component source (the merged/OURS bytes live in the
// already-secured snapshot files).

'use strict';

const fs = require('fs');
const path = require('path');
const store = require('./merge-artifact-store');

// Ordered apply phases. Higher rank = further along.
const PHASES = Object.freeze(['started', 'committed', 'accepted', 'pulled', 'verified']);
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

function runStateFilePath(runId) {
  return path.join(store.runDir(runId), STATE_FILE);
}

/**
 * Persist (overwrite) the run-state for a run. Owner-only, in the secure store.
 * @param {string} runId
 * @param {object} state  { phase, commitId, snapshotDir, acceptResults, components, binding, envUrl, solutionUniqueName, solutionId, status, error }
 * @returns {string} absolute path written
 */
function writeRunState(runId, state) {
  if (!runId) throw new Error('runId is required');
  const runStore = store.createRunStore(runId);
  const payload = { ...state, runId, updatedAt: new Date().toISOString() };
  return store.writeArtifact(runStore, STATE_FILE, JSON.stringify(payload, null, 2));
}

/**
 * Read the run-state, or null if there is none.
 * @param {string} runId
 * @returns {object|null}
 */
function readRunState(runId) {
  if (!runId) throw new Error('runId is required');
  const raw = store.readArtifact({ dir: store.runDir(runId), key: null }, STATE_FILE);
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/** Best-effort removal of the run-state file (does not wipe the whole run). */
function clearRunState(runId) {
  try { fs.unlinkSync(runStateFilePath(runId)); return true; } catch { return false; }
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
