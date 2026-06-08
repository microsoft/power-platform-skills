#!/usr/bin/env node
/**
 * validate-validate-pending-changes.js — PostToolUse hook validator.
 *
 * Checks that the `validate-pending-changes` skill completed successfully by
 * verifying `docs/inner-loop/last-validation.json` was written with the
 * required fields.
 *
 * Blocks when:
 *   - The marker exists but is not valid JSON
 *   - Required fields are missing or empty
 *   - `status` is "blocked" (the skill surfaced blockers — commit would fail)
 *
 * Gracefully approves when:
 *   - No project root is found (not a Power Pages project)
 *   - No marker file found (not a validate-pending-changes session)
 */

'use strict';

const path = require('path');
const fs = require('fs');
const {
  runValidation, findProjectRoot, block, approve,
} = require('../../../scripts/lib/validation-helpers');

const REQUIRED_FIELDS = [
  'skill', 'validatedAt', 'envUrl', 'status',
];

runValidation((cwd) => {
  const projectRoot = findProjectRoot(cwd);
  if (!projectRoot) return approve();

  const markerPath = path.join(projectRoot, 'docs', 'inner-loop', 'last-validation.json');
  if (!fs.existsSync(markerPath)) return approve();

  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch (e) {
    return block(`validate-validate-pending-changes: docs/inner-loop/last-validation.json is not valid JSON: ${e.message}`);
  }

  const missing = REQUIRED_FIELDS.filter((k) => {
    const v = marker[k];
    return v === null || v === undefined || v === '';
  });
  if (missing.length > 0) {
    return block(
      `validate-validate-pending-changes: docs/inner-loop/last-validation.json is missing required fields: ${missing.join(', ')}`
    );
  }

  const VALID_STATUSES = ['passed', 'warnings', 'blocked', 'clean'];
  if (!VALID_STATUSES.includes(marker.status)) {
    return block(
      `validate-validate-pending-changes: docs/inner-loop/last-validation.json has unknown status "${marker.status}". Expected one of: ${VALID_STATUSES.join(', ')}.`
    );
  }

  if (marker.status === 'blocked') {
    const count = Array.isArray(marker.blockers) ? marker.blockers.length : '?';
    return block(
      `validate-validate-pending-changes: Pre-flight validation found ${count} blocker(s). Fix them before committing ` +
      '(see docs/inner-loop/pre-commit-report.html).'
    );
  }

  approve();
});
