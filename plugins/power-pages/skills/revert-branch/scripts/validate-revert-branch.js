#!/usr/bin/env node
/**
 * validate-revert-branch.js — PostToolUse hook validator.
 *
 * Checks that the `revert-branch` skill completed successfully by verifying
 * `docs/inner-loop/last-branch-revert.json` was written with required fields.
 *
 * Blocks when:
 *   - The marker exists but is not valid JSON
 *   - Required fields are missing
 *   - `status` is "failed"
 *   - `previousHeadSha === targetSha` (no-op revert)
 *   - SHAs are not plausibly 40-char hex (catches obviously-bad markers)
 *
 * Gracefully approves when:
 *   - No project root found
 *   - No marker file found
 */

'use strict';

const path = require('path');
const fs = require('fs');
const {
  runValidation, findProjectRoot, block, approve,
} = require('../../../scripts/lib/validation-helpers');

const REQUIRED_FIELDS = [
  'skill', 'revertedAt', 'envUrl',
  'organization', 'project', 'repository', 'branch',
  'previousHeadSha', 'targetSha', 'status',
];

const SHA40_RE = /^[0-9a-f]{40}$/i;

runValidation((cwd) => {
  const projectRoot = findProjectRoot(cwd);
  if (!projectRoot) return approve();

  const markerPath = path.join(projectRoot, 'docs', 'inner-loop', 'last-branch-revert.json');
  if (!fs.existsSync(markerPath)) return approve();

  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch (e) {
    return block(`validate-revert-branch: docs/inner-loop/last-branch-revert.json is not valid JSON: ${e.message}`);
  }

  const missing = REQUIRED_FIELDS.filter((k) => {
    const v = marker[k];
    return v === null || v === undefined || v === '';
  });
  if (missing.length > 0) {
    return block(
      `validate-revert-branch: docs/inner-loop/last-branch-revert.json is missing required fields: ${missing.join(', ')}`
    );
  }

  if (marker.status === 'failed') {
    return block(
      'validate-revert-branch: docs/inner-loop/last-branch-revert.json reports status=failed. ' +
      'Re-run /power-pages:revert-branch after resolving the underlying issue.'
    );
  }

  if (!SHA40_RE.test(marker.previousHeadSha)) {
    return block(
      `validate-revert-branch: previousHeadSha ("${marker.previousHeadSha}") is not a 40-char hex SHA.`
    );
  }
  if (!SHA40_RE.test(marker.targetSha)) {
    return block(
      `validate-revert-branch: targetSha ("${marker.targetSha}") is not a 40-char hex SHA.`
    );
  }

  if (marker.previousHeadSha === marker.targetSha) {
    return block(
      'validate-revert-branch: previousHeadSha equals targetSha — the revert was a no-op. ' +
      'Re-run /power-pages:revert-branch with a different target SHA.'
    );
  }

  approve();
});
