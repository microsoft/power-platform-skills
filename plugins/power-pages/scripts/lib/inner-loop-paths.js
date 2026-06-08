#!/usr/bin/env node

// Single source of truth for inner-loop (Dataverse Git integration) artifact paths.
//
// Every inner-loop state file lives under `<projectRoot>/docs/inner-loop/`
// rather than the project root. This mirrors the ALM separation in
// `alm-paths.js` (which puts ALM artifacts under `docs/alm/`) and keeps the
// project root from accumulating dot-files as developers iterate through
// commit / sync / resolve-conflicts cycles.
//
// The two loops are intentionally kept in sibling folders, not nested:
//   docs/
//     alm/            outer-loop (cross-environment promotion, pipelines)
//     inner-loop/     inner-loop (per-env Git binding, daily commits)
//
// One file lives at the project root (NOT under docs/inner-loop/), by design:
//   .git-integration-manifest.json     binding type / repo / branch / folder /
//                                      solution unique name / last commit SHA.
//                                      Sits at root because every inner-loop
//                                      skill reads it during Phase 1, the same
//                                      way every ALM skill reads
//                                      .solution-manifest.json.
//
// All callers must require this module instead of inlining
// `path.join(root, 'docs/inner-loop/last-*.json')`. The frozen FILE_NAMES
// table makes typos a hard error (almPath('lastCommt') throws).

'use strict';

const fs = require('fs');
const path = require('path');

const INNER_LOOP_DIR = 'docs/inner-loop';

const FILE_NAMES = Object.freeze({
  // Orchestrator state (written by plan-inner-loop)
  plan:                      'inner-loop-plan.json',
  planHtml:                  'inner-loop-plan.html',

  // Skill-run markers (written when a skill completes)
  lastSetup:                 'last-setup.json',
  lastCommit:                'last-commit.json',
  lastSync:                  'last-sync.json',
  lastValidation:            'last-validation.json',
  lastConflictResolution:    'last-conflict-resolution.json',
  lastBranchSwitch:          'last-branch-switch.json',
  lastRevert:                'last-revert.json',
  lastBranchRevert:          'last-branch-revert.json',
  lastPr:                    'last-pr.json',
  lastDiagnosis:             'last-diagnosis.json',

  // Human-readable HTML reports (written by their respective skills)
  preCommitReportHtml:       'pre-commit-report.html',
  conflictsHtml:             'conflicts.html',
  diagnosisHtml:             'diagnosis.html',
});

/**
 * Returns the absolute directory path that holds the inner-loop artifacts.
 *
 * @param {string} projectRoot
 * @returns {string}
 */
function innerLoopDir(projectRoot) {
  if (!projectRoot) throw new Error('innerLoopDir: projectRoot is required');
  return path.join(projectRoot, INNER_LOOP_DIR);
}

/**
 * Returns the absolute path of an inner-loop artifact for a given logical key.
 * Use the keys from FILE_NAMES (e.g. 'lastCommit', 'plan', 'conflictsHtml').
 *
 * @param {string} projectRoot
 * @param {keyof typeof FILE_NAMES} key
 * @returns {string}
 */
function innerLoopPath(projectRoot, key) {
  const fileName = FILE_NAMES[key];
  if (!fileName) throw new Error(`innerLoopPath: unknown key '${key}'`);
  return path.join(innerLoopDir(projectRoot), fileName);
}

/**
 * Creates `<projectRoot>/docs/inner-loop/` if it doesn't exist. Idempotent.
 * Callers should invoke this once before any write to an inner-loop artifact.
 *
 * @param {string} projectRoot
 * @returns {string} The absolute inner-loop dir path
 */
function ensureInnerLoopDir(projectRoot) {
  const dir = innerLoopDir(projectRoot);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Path to the Git-integration manifest at the project root.
 * NOT under docs/inner-loop/ — see file header comment for rationale.
 *
 * @param {string} projectRoot
 * @returns {string}
 */
function gitIntegrationManifestPath(projectRoot) {
  if (!projectRoot) throw new Error('gitIntegrationManifestPath: projectRoot is required');
  return path.join(projectRoot, '.git-integration-manifest.json');
}

module.exports = {
  INNER_LOOP_DIR,
  FILE_NAMES,
  innerLoopDir,
  innerLoopPath,
  ensureInnerLoopDir,
  gitIntegrationManifestPath,
};
