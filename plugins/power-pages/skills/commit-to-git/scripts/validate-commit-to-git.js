#!/usr/bin/env node
/**
 * validate-commit-to-git.js — PostToolUse hook validator.
 *
 * Validates that `/power-pages:commit-to-git` completed successfully, in
 * either of its two modes:
 *
 *   - Real-commit mode  → docs/inner-loop/last-commit.json present;
 *                         status ∈ {"succeeded"}; commitId required.
 *   - Dry-run mode      → docs/inner-loop/last-validation.json present
 *                         (and last-commit.json absent);
 *                         status ∈ {"dry-run-passed", "dry-run-warnings",
 *                         "dry-run-blocked", "passed", "clean"}.
 *
 * Per design decision D2, the previously separate
 * validate-validate-pending-changes.js hook is folded into this validator —
 * dry-run runs of commit-to-git emit the same markers VPC used to.
 *
 * Blocks when:
 *   - The marker JSON is corrupt.
 *   - Required fields are missing on the present marker.
 *   - status is "failed" (real-commit only).
 *   - status is an unrecognised value.
 *   - commitId is missing on a real-commit marker.
 *
 * Gracefully approves when:
 *   - No project root found (not a Power Pages project).
 *   - Neither marker exists (no commit-to-git invocation in this session).
 */

'use strict';

const path = require('path');
const fs = require('fs');
const {
  runValidation, findProjectRoot, block, approve,
} = require('../../../scripts/lib/validation-helpers');

const REQUIRED_REAL_COMMIT_FIELDS = [
  'skill', 'committedAt', 'envUrl', 'commitMessage', 'status',
];

// Statuses accepted on last-commit.json (real-commit mode).
const REAL_COMMIT_STATUSES = new Set(['succeeded']);

// Statuses accepted on last-validation.json (dry-run mode, plus the
// historical "passed"/"clean" outcomes the orchestrator still emits when
// invoked directly without a dry-run wrapper).
const DRY_RUN_STATUSES = new Set([
  'dry-run-passed', 'dry-run-warnings', 'dry-run-blocked',
  'passed', 'clean',
]);

runValidation((cwd) => {
  const projectRoot = findProjectRoot(cwd);
  if (!projectRoot) return approve();

  const innerLoop = path.join(projectRoot, 'docs', 'inner-loop');
  const realPath = path.join(innerLoop, 'last-commit.json');
  const dryPath = path.join(innerLoop, 'last-validation.json');

  // Prefer last-commit.json (real-commit) when both are present, since the
  // real-commit run is the most recent action that produced a SHA. The
  // skill's design (D5) is that real-commit embeds validation into
  // last-commit.json rather than writing a standalone last-validation.json,
  // so this precedence only matters for legacy projects that still have
  // both files on disk.
  if (fs.existsSync(realPath)) {
    return validateRealCommit(realPath);
  }
  if (fs.existsSync(dryPath)) {
    return validateDryRun(dryPath);
  }
  return approve();
});

function validateRealCommit(markerPath) {
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch (e) {
    return block(`validate-commit-to-git: docs/inner-loop/last-commit.json is not valid JSON: ${e.message}`);
  }

  const missing = REQUIRED_REAL_COMMIT_FIELDS.filter((k) => {
    const v = marker[k];
    return v === null || v === undefined || v === '';
  });
  if (missing.length > 0) {
    return block(
      `validate-commit-to-git: docs/inner-loop/last-commit.json is missing required fields: ${missing.join(', ')}`
    );
  }

  if (marker.status === 'failed') {
    return block(
      'validate-commit-to-git: docs/inner-loop/last-commit.json reports status=failed. ' +
      'Re-run /power-pages:commit-to-git after fixing the underlying issue.'
    );
  }

  if (!REAL_COMMIT_STATUSES.has(marker.status)) {
    return block(
      `validate-commit-to-git: docs/inner-loop/last-commit.json has unrecognised status '${marker.status}'. ` +
      `Expected one of: ${[...REAL_COMMIT_STATUSES].join(', ')}.`
    );
  }

  if (!marker.commitId || String(marker.commitId).trim() === '') {
    return block(
      'validate-commit-to-git: docs/inner-loop/last-commit.json is missing a commitId. ' +
      'The commit may not have been verified in ADO — check the Connect-to-Git panel.'
    );
  }

  return approve();
}

function validateDryRun(markerPath) {
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch (e) {
    return block(`validate-commit-to-git: docs/inner-loop/last-validation.json is not valid JSON: ${e.message}`);
  }

  if (!marker.status) {
    return block(
      'validate-commit-to-git: docs/inner-loop/last-validation.json is missing required field: status'
    );
  }

  if (!DRY_RUN_STATUSES.has(marker.status)) {
    return block(
      `validate-commit-to-git: docs/inner-loop/last-validation.json has unrecognised status '${marker.status}'. ` +
      `Expected one of: ${[...DRY_RUN_STATUSES].join(', ')}.`
    );
  }

  return approve();
}
