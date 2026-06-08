#!/usr/bin/env node
/**
 * validate-branch-switch.js — PostToolUse hook validator.
 *
 * Checks that the `branch-switch` skill completed successfully by verifying
 * `docs/inner-loop/last-branch-switch.json` was written with required fields
 * AND that the `.git-integration-manifest.json` `branch` field matches the
 * marker's `newBranch` (cross-check that the manifest was updated alongside
 * the platform-side switch).
 *
 * Blocks when:
 *   - The marker exists but is not valid JSON
 *   - Required fields are missing
 *   - `status` is "failed"
 *   - `oldBranch === newBranch` (no-op)
 *   - The manifest's `branch` field does not match `newBranch`
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
  'skill', 'switchedAt', 'envUrl',
  'organization', 'project', 'repository',
  'oldBranch', 'newBranch', 'status',
];

function stripRefsPrefix(b) {
  if (typeof b !== 'string') return b;
  return b.replace(/^refs\/heads\//, '');
}

runValidation((cwd) => {
  const projectRoot = findProjectRoot(cwd);
  if (!projectRoot) return approve();

  const markerPath = path.join(projectRoot, 'docs', 'inner-loop', 'last-branch-switch.json');
  if (!fs.existsSync(markerPath)) return approve();

  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch (e) {
    return block(`validate-branch-switch: docs/inner-loop/last-branch-switch.json is not valid JSON: ${e.message}`);
  }

  const missing = REQUIRED_FIELDS.filter((k) => {
    const v = marker[k];
    return v === null || v === undefined || v === '';
  });
  if (missing.length > 0) {
    return block(
      `validate-branch-switch: docs/inner-loop/last-branch-switch.json is missing required fields: ${missing.join(', ')}`
    );
  }

  if (marker.status === 'failed') {
    return block(
      'validate-branch-switch: docs/inner-loop/last-branch-switch.json reports status=failed. ' +
      'Re-run /power-pages:branch-switch after resolving the issue.'
    );
  }

  if (stripRefsPrefix(marker.oldBranch) === stripRefsPrefix(marker.newBranch)) {
    return block(
      `validate-branch-switch: oldBranch ("${marker.oldBranch}") equals newBranch ("${marker.newBranch}") — no-op switch. ` +
      'Re-run /power-pages:branch-switch with a different target branch.'
    );
  }

  const manifestPath = path.join(projectRoot, '.git-integration-manifest.json');
  if (fs.existsSync(manifestPath)) {
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (e) {
      return block(`validate-branch-switch: .git-integration-manifest.json is not valid JSON: ${e.message}`);
    }
    const manifestBranch = stripRefsPrefix(manifest.branch);
    const markerNewBranch = stripRefsPrefix(marker.newBranch);
    if (manifestBranch && manifestBranch !== markerNewBranch) {
      return block(
        `validate-branch-switch: .git-integration-manifest.json branch ("${manifest.branch}") ` +
        `does not match last-branch-switch.json newBranch ("${marker.newBranch}"). ` +
        'The manifest was not updated alongside the platform switch — re-run /power-pages:branch-switch to reconcile.'
      );
    }
  }

  approve();
});
