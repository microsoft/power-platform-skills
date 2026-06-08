#!/usr/bin/env node
/**
 * validate-sync-from-git.js — PostToolUse hook validator.
 *
 * Checks that the `sync-from-git` skill completed successfully by verifying
 * `docs/inner-loop/last-sync.json` was written with required fields.
 *
 * Blocks when:
 *   - The marker exists but is not valid JSON
 *   - Required fields are missing or empty
 *   - `status` is "failed"
 *
 * Gracefully approves when:
 *   - No project root found (not a Power Pages project)
 *   - No marker file found (not a sync-from-git session)
 *   - `status` is "already-up-to-date" (no updates to apply — still success)
 */

'use strict';

const path = require('path');
const fs = require('fs');
const {
  runValidation, findProjectRoot, block, approve,
} = require('../../../scripts/lib/validation-helpers');

const REQUIRED_FIELDS = [
  'skill', 'syncedAt', 'envUrl', 'status',
];

runValidation((cwd) => {
  const projectRoot = findProjectRoot(cwd);
  if (!projectRoot) return approve();

  const markerPath = path.join(projectRoot, 'docs', 'inner-loop', 'last-sync.json');
  if (!fs.existsSync(markerPath)) return approve();

  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch (e) {
    return block(`validate-sync-from-git: docs/inner-loop/last-sync.json is not valid JSON: ${e.message}`);
  }

  const missing = REQUIRED_FIELDS.filter((k) => {
    const v = marker[k];
    return v === null || v === undefined || v === '';
  });
  if (missing.length > 0) {
    return block(
      `validate-sync-from-git: docs/inner-loop/last-sync.json is missing required fields: ${missing.join(', ')}`
    );
  }

  const VALID_STATUSES = ['succeeded', 'already-up-to-date', 'failed'];
  if (!VALID_STATUSES.includes(marker.status)) {
    return block(
      `validate-sync-from-git: docs/inner-loop/last-sync.json has unknown status "${marker.status}". Expected one of: ${VALID_STATUSES.join(', ')}.`
    );
  }

  if (marker.status === 'failed') {
    return block(
      'validate-sync-from-git: docs/inner-loop/last-sync.json reports status=failed. ' +
      'Re-run /power-pages:sync-from-git after resolving the issue.'
    );
  }

  approve();
});
