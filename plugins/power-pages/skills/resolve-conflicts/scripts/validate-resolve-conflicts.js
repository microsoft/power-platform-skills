#!/usr/bin/env node
/**
 * validate-resolve-conflicts.js — PostToolUse hook validator.
 *
 * Checks that the `resolve-conflicts` skill completed successfully by verifying
 * `docs/inner-loop/last-conflict-resolution.json` was written with required
 * fields.
 *
 * Blocks when:
 *   - The marker exists but is not valid JSON
 *   - Required fields are missing or empty
 *   - `status` is "failed" (all resolutions failed)
 *   - `remainingConflicts > 0` with status "partial" (blocks sync-from-git)
 *
 * Gracefully approves when:
 *   - No project root found (not a Power Pages project)
 *   - No marker file found (not a resolve-conflicts session)
 *   - `status` is "succeeded" with remainingConflicts = 0
 */

'use strict';

const path = require('path');
const fs = require('fs');
const {
  runValidation, findProjectRoot, block, approve,
} = require('../../../scripts/lib/validation-helpers');

const REQUIRED_FIELDS = [
  'skill', 'resolvedAt', 'envUrl', 'conflictsFound', 'conflictsResolved', 'status',
];

runValidation((cwd) => {
  const projectRoot = findProjectRoot(cwd);
  if (!projectRoot) return approve();

  const markerPath = path.join(
    projectRoot, 'docs', 'inner-loop', 'last-conflict-resolution.json'
  );
  if (!fs.existsSync(markerPath)) return approve();

  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch (e) {
    return block(
      `validate-resolve-conflicts: docs/inner-loop/last-conflict-resolution.json is not valid JSON: ${e.message}`
    );
  }

  const missing = REQUIRED_FIELDS.filter((k) => {
    const v = marker[k];
    return v === null || v === undefined || v === '';
  });
  if (missing.length > 0) {
    return block(
      `validate-resolve-conflicts: docs/inner-loop/last-conflict-resolution.json is missing required fields: ${missing.join(', ')}`
    );
  }

  const VALID_STATUSES = ['succeeded', 'partial', 'failed'];
  if (!VALID_STATUSES.includes(marker.status)) {
    return block(
      `validate-resolve-conflicts: docs/inner-loop/last-conflict-resolution.json has unknown status "${marker.status}". Expected one of: ${VALID_STATUSES.join(', ')}.`
    );
  }

  if (marker.status === 'failed') {
    return block(
      'validate-resolve-conflicts: All conflict resolutions failed. ' +
      'Re-run /power-pages:resolve-conflicts to retry.'
    );
  }

  const remaining = typeof marker.remainingConflicts === 'number' ? marker.remainingConflicts : 0;
  if (marker.status === 'partial' && remaining > 0) {
    return block(
      `validate-resolve-conflicts: ${remaining} conflict(s) remain unresolved (status=partial). ` +
      'Re-run /power-pages:resolve-conflicts to address the remaining items before syncing.'
    );
  }

  approve();
});
