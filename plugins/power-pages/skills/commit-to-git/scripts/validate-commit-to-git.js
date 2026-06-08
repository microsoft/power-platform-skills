#!/usr/bin/env node
/**
 * validate-commit-to-git.js — PostToolUse hook validator.
 *
 * Checks that the `commit-to-git` skill completed successfully by verifying
 * `docs/inner-loop/last-commit.json` was written with required fields.
 *
 * Blocks when:
 *   - The marker exists but is not valid JSON
 *   - Required fields are missing or empty
 *   - `status` is "failed"
 *   - `commitId` is missing (commit did not produce a verifiable SHA)
 *
 * Gracefully approves when:
 *   - No project root found (not a Power Pages project)
 *   - No marker file found (not a commit-to-git session)
 */

'use strict';

const path = require('path');
const fs = require('fs');
const {
  runValidation, findProjectRoot, block, approve,
} = require('../../../scripts/lib/validation-helpers');

const REQUIRED_FIELDS = [
  'skill', 'committedAt', 'envUrl', 'commitMessage', 'status',
];

runValidation((cwd) => {
  const projectRoot = findProjectRoot(cwd);
  if (!projectRoot) return approve();

  const markerPath = path.join(projectRoot, 'docs', 'inner-loop', 'last-commit.json');
  if (!fs.existsSync(markerPath)) return approve();

  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch (e) {
    return block(`validate-commit-to-git: docs/inner-loop/last-commit.json is not valid JSON: ${e.message}`);
  }

  const missing = REQUIRED_FIELDS.filter((k) => {
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

  if (!marker.commitId || marker.commitId.trim() === '') {
    return block(
      'validate-commit-to-git: docs/inner-loop/last-commit.json is missing a commitId. ' +
      'The commit may not have been verified in ADO — check the Connect-to-Git panel.'
    );
  }

  approve();
});
