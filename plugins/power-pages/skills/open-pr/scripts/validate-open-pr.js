#!/usr/bin/env node
/**
 * validate-open-pr.js — PostToolUse hook validator.
 *
 * Checks that the `open-pr` skill completed successfully by verifying
 * `docs/inner-loop/last-pr.json` was written with required fields.
 *
 * Blocks when:
 *   - The marker exists but is not valid JSON
 *   - Required fields are missing
 *   - `status` is "failed"
 *   - `pullRequestId` is not a positive integer
 *   - `url` does not look like an ADO PR URL (very loose sanity check)
 *   - `sourceBranch === targetBranch` (no-op PR)
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
  'skill', 'createdAt', 'organization', 'project', 'repository',
  'sourceBranch', 'targetBranch', 'pullRequestId', 'title', 'url', 'status',
];

function stripRefsPrefix(b) {
  if (typeof b !== 'string') return b;
  return b.replace(/^refs\/heads\//, '');
}

runValidation((cwd) => {
  const projectRoot = findProjectRoot(cwd);
  if (!projectRoot) return approve();

  const markerPath = path.join(projectRoot, 'docs', 'inner-loop', 'last-pr.json');
  if (!fs.existsSync(markerPath)) return approve();

  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch (e) {
    return block(`validate-open-pr: docs/inner-loop/last-pr.json is not valid JSON: ${e.message}`);
  }

  const missing = REQUIRED_FIELDS.filter((k) => {
    const v = marker[k];
    return v === null || v === undefined || v === '';
  });
  if (missing.length > 0) {
    return block(
      `validate-open-pr: docs/inner-loop/last-pr.json is missing required fields: ${missing.join(', ')}`
    );
  }

  if (marker.status === 'failed') {
    return block(
      'validate-open-pr: docs/inner-loop/last-pr.json reports status=failed. ' +
      'Re-run /power-pages:open-pr after resolving the issue.'
    );
  }

  if (!Number.isInteger(marker.pullRequestId) || marker.pullRequestId <= 0) {
    return block(
      `validate-open-pr: pullRequestId ("${marker.pullRequestId}") must be a positive integer.`
    );
  }

  if (typeof marker.url !== 'string' || !/^https?:\/\//i.test(marker.url)) {
    return block(
      `validate-open-pr: url ("${marker.url}") does not look like a valid HTTP(S) URL.`
    );
  }

  if (stripRefsPrefix(marker.sourceBranch) === stripRefsPrefix(marker.targetBranch)) {
    return block(
      `validate-open-pr: sourceBranch ("${marker.sourceBranch}") equals targetBranch ("${marker.targetBranch}") — no-op PR.`
    );
  }

  approve();
});
