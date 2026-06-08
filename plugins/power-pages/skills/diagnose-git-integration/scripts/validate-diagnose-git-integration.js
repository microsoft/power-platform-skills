#!/usr/bin/env node
/**
 * validate-diagnose-git-integration.js — PostToolUse hook validator.
 *
 * Checks that the `diagnose-git-integration` skill completed successfully by
 * verifying `docs/inner-loop/last-diagnosis.json` was written with required
 * fields.
 *
 * This is a read-only diagnostic skill — the validator is lenient:
 *   - Non-zero error counts are EXPECTED (the whole point of the skill is to
 *     surface them), so we do NOT block on errorCount > 0.
 *   - We DO block on schema problems and on `status: "failed"`.
 *
 * Blocks when:
 *   - The marker exists but is not valid JSON
 *   - Required fields are missing
 *   - `status` is "failed"
 *   - `mode` is not one of the three known modes
 *   - `findings` is not an array
 *
 * Gracefully approves when:
 *   - No project root found
 *   - No marker file found
 *   - `status` is "succeeded" or "partial" (partial = some detectors errored,
 *     which is expected when auth is partially gone)
 */

'use strict';

const path = require('path');
const fs = require('fs');
const {
  runValidation, findProjectRoot, block, approve,
} = require('../../../scripts/lib/validation-helpers');

const REQUIRED_FIELDS = [
  'skill', 'diagnosedAt', 'envUrl', 'mode', 'findings', 'status',
];

const VALID_MODES = ['paste-error', 'describe-symptoms', 'full-scan'];
const VALID_STATUSES = ['succeeded', 'partial', 'failed'];

runValidation((cwd) => {
  const projectRoot = findProjectRoot(cwd);
  if (!projectRoot) return approve();

  const markerPath = path.join(projectRoot, 'docs', 'inner-loop', 'last-diagnosis.json');
  if (!fs.existsSync(markerPath)) return approve();

  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch (e) {
    return block(`validate-diagnose-git-integration: docs/inner-loop/last-diagnosis.json is not valid JSON: ${e.message}`);
  }

  const missing = REQUIRED_FIELDS.filter((k) => {
    const v = marker[k];
    // findings can be an empty array, which is allowed; check for null/undefined only
    if (k === 'findings') return v === null || v === undefined;
    return v === null || v === undefined || v === '';
  });
  if (missing.length > 0) {
    return block(
      `validate-diagnose-git-integration: docs/inner-loop/last-diagnosis.json is missing required fields: ${missing.join(', ')}`
    );
  }

  if (!VALID_MODES.includes(marker.mode)) {
    return block(
      `validate-diagnose-git-integration: docs/inner-loop/last-diagnosis.json has unknown mode "${marker.mode}". Expected one of: ${VALID_MODES.join(', ')}.`
    );
  }

  if (!VALID_STATUSES.includes(marker.status)) {
    return block(
      `validate-diagnose-git-integration: docs/inner-loop/last-diagnosis.json has unknown status "${marker.status}". Expected one of: ${VALID_STATUSES.join(', ')}.`
    );
  }

  if (marker.status === 'failed') {
    return block(
      'validate-diagnose-git-integration: docs/inner-loop/last-diagnosis.json reports status=failed. ' +
      'The diagnostic itself failed (e.g. all detectors errored). Check the report and re-run /power-pages:diagnose-git-integration after restoring auth.'
    );
  }

  if (!Array.isArray(marker.findings)) {
    return block(
      `validate-diagnose-git-integration: findings must be an array, got ${typeof marker.findings}.`
    );
  }

  // Note: we intentionally do NOT block on errorCount > 0 — the whole point
  // of this skill is to surface errors. The validator only checks that the
  // skill itself ran cleanly and produced a well-formed report.

  approve();
});
