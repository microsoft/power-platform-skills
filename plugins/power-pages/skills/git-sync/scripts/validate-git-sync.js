#!/usr/bin/env node
/**
 * validate-git-sync.js — PostToolUse hook validator for the merged `git-sync`
 * skill (replaces validate-commit-to-git.js + validate-sync-from-git.js +
 * validate-resolve-conflicts.js).
 *
 * `git-sync` can run any of four flows in a session, each writing its own
 * marker under docs/inner-loop/. This validator checks every marker that is
 * present and applies that flow's contract:
 *
 *   - Commit (real)     → last-commit.json   : skill/committedAt/envUrl/
 *                         commitMessage/status='succeeded' + commitId required.
 *   - Commit (dry-run)  → last-validation.json: status ∈ dry-run set.
 *                         (Checked only when last-commit.json is absent — a real
 *                          commit embeds validation into last-commit.json, D8.)
 *   - Pull              → last-sync.json      : skill/syncedAt/envUrl/status
 *                         ∈ {succeeded, already-up-to-date, failed}.
 *   - Conflict resolve  → last-conflict-resolution.json :
 *                         skill/resolvedAt/envUrl/conflictsFound/
 *                         conflictsResolved/status ∈ {succeeded, partial,
 *                         failed, manual-resolution-required}; partial +
 *                         remainingConflicts>0 blocks. The selective-merge
 *                         strategy writes the same marker (+ strategy/adoCommitId);
 *                         manual-resolution-required (IL-015 portal fallback) passes.
 *
 * Blocks on: corrupt JSON, missing required fields, status=failed, unknown
 * status, missing commitId (real commit), or unresolved partial conflicts.
 *
 * Gracefully approves when: no project root, or none of the four markers exist.
 *
 * Does NOT hard-require skill==='git-sync' so legacy markers from the merged-away
 * commit-to-git / sync-from-git / resolve-conflicts skills still validate.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const {
  runValidation, findProjectRoot, block, approve,
} = require('../../../scripts/lib/validation-helpers');

const REQUIRED_REAL_COMMIT_FIELDS = ['skill', 'committedAt', 'envUrl', 'commitMessage', 'status'];
const REAL_COMMIT_STATUSES = new Set(['succeeded']);
const DRY_RUN_STATUSES = new Set(['dry-run-passed', 'dry-run-warnings', 'dry-run-blocked', 'passed', 'clean']);

const REQUIRED_SYNC_FIELDS = ['skill', 'syncedAt', 'envUrl', 'status'];
const SYNC_STATUSES = new Set(['succeeded', 'already-up-to-date', 'failed']);

const REQUIRED_CONFLICT_FIELDS = ['skill', 'resolvedAt', 'envUrl', 'conflictsFound', 'conflictsResolved', 'status'];
const CONFLICT_STATUSES = new Set(['succeeded', 'partial', 'failed', 'manual-resolution-required']);

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function missingFields(marker, required) {
  return required.filter((k) => {
    const v = marker[k];
    return v === null || v === undefined || v === '';
  });
}

runValidation((cwd) => {
  const projectRoot = findProjectRoot(cwd);
  if (!projectRoot) return approve();

  const dir = path.join(projectRoot, 'docs', 'inner-loop');
  const commitPath = path.join(dir, 'last-commit.json');
  const dryPath = path.join(dir, 'last-validation.json');
  const syncPath = path.join(dir, 'last-sync.json');
  const conflictPath = path.join(dir, 'last-conflict-resolution.json');

  // --- Commit flow: real-commit takes precedence over dry-run (D8). ---
  if (fs.existsSync(commitPath)) {
    const r = validateRealCommit(commitPath);
    if (r) return r;
  } else if (fs.existsSync(dryPath)) {
    const r = validateDryRun(dryPath);
    if (r) return r;
  }

  // --- Pull flow. ---
  if (fs.existsSync(syncPath)) {
    const r = validateSync(syncPath);
    if (r) return r;
  }

  // --- Conflict flow. ---
  if (fs.existsSync(conflictPath)) {
    const r = validateConflict(conflictPath);
    if (r) return r;
  }

  return approve();
});

// Each validate* returns a block() result on failure, or null on pass.

function validateRealCommit(markerPath) {
  let marker;
  try { marker = readJson(markerPath); }
  catch (e) { return block(`validate-git-sync: docs/inner-loop/last-commit.json is not valid JSON: ${e.message}`); }

  const missing = missingFields(marker, REQUIRED_REAL_COMMIT_FIELDS);
  if (missing.length) return block(`validate-git-sync: last-commit.json is missing required fields: ${missing.join(', ')}`);
  if (marker.status === 'failed') return block('validate-git-sync: last-commit.json reports status=failed. Re-run /power-pages:git-sync after fixing the issue.');
  if (!REAL_COMMIT_STATUSES.has(marker.status)) return block(`validate-git-sync: last-commit.json has unrecognised status '${marker.status}'. Expected: ${[...REAL_COMMIT_STATUSES].join(', ')}.`);
  if (!marker.commitId || String(marker.commitId).trim() === '') return block('validate-git-sync: last-commit.json is missing a commitId. The commit may not have been verified in ADO.');
  return null;
}

function validateDryRun(markerPath) {
  let marker;
  try { marker = readJson(markerPath); }
  catch (e) { return block(`validate-git-sync: docs/inner-loop/last-validation.json is not valid JSON: ${e.message}`); }
  if (!marker.status) return block('validate-git-sync: last-validation.json is missing required field: status');
  if (!DRY_RUN_STATUSES.has(marker.status)) return block(`validate-git-sync: last-validation.json has unrecognised status '${marker.status}'. Expected: ${[...DRY_RUN_STATUSES].join(', ')}.`);
  return null;
}

function validateSync(markerPath) {
  let marker;
  try { marker = readJson(markerPath); }
  catch (e) { return block(`validate-git-sync: docs/inner-loop/last-sync.json is not valid JSON: ${e.message}`); }
  const missing = missingFields(marker, REQUIRED_SYNC_FIELDS);
  if (missing.length) return block(`validate-git-sync: last-sync.json is missing required fields: ${missing.join(', ')}`);
  if (!SYNC_STATUSES.has(marker.status)) return block(`validate-git-sync: last-sync.json has unknown status "${marker.status}". Expected: ${[...SYNC_STATUSES].join(', ')}.`);
  if (marker.status === 'failed') return block('validate-git-sync: last-sync.json reports status=failed. Re-run /power-pages:git-sync after resolving the issue.');
  return null;
}

function validateConflict(markerPath) {
  let marker;
  try { marker = readJson(markerPath); }
  catch (e) { return block(`validate-git-sync: docs/inner-loop/last-conflict-resolution.json is not valid JSON: ${e.message}`); }
  const missing = missingFields(marker, REQUIRED_CONFLICT_FIELDS);
  if (missing.length) return block(`validate-git-sync: last-conflict-resolution.json is missing required fields: ${missing.join(', ')}`);
  if (!CONFLICT_STATUSES.has(marker.status)) return block(`validate-git-sync: last-conflict-resolution.json has unknown status "${marker.status}". Expected: ${[...CONFLICT_STATUSES].join(', ')}.`);
  if (marker.status === 'failed') return block('validate-git-sync: all conflict resolutions failed. Re-run /power-pages:git-sync to retry.');
  const remaining = typeof marker.remainingConflicts === 'number' ? marker.remainingConflicts : 0;
  if (marker.status === 'partial' && remaining > 0) {
    return block(`validate-git-sync: ${remaining} conflict(s) remain unresolved (status=partial). Re-run /power-pages:git-sync to address them before syncing.`);
  }
  return null;
}
