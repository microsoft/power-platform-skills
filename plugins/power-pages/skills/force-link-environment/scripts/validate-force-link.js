#!/usr/bin/env node

// Stop-hook validator for the force-link-environment skill.
// Reads docs/alm/last-force-link.json from the project and verifies the marker
// reflects a completed Force Link. Gracefully exits 0 when no marker exists
// (not a force-link session).
//
// Pass conditions (exit 0):
//   - File missing.
//   - schemaVersion is 1.
//   - hostEnvUrl, deploymentEnvironmentId, validationStatus, forcedAt populated.
//   - validationStatus === 200000001 (Succeeded).
//
// Block conditions (exit 2):
//   - File present but missing required fields or unsupported schemaVersion.
//   - validationStatus === 200000002 (Failed) — Force Link's post-link
//     validation didn't succeed; surface to investigation rather than silently
//     pass.

'use strict';

const fs = require('fs');
const {
  approve,
  block,
  runValidation,
  findProjectRoot,
  readDeferralMarker,
} = require('../../../scripts/lib/validation-helpers');
const { almPath } = require('../../../scripts/lib/alm-paths');

const VALIDATION_STATUS_SUCCEEDED = 200000001;
const VALIDATION_STATUS_FAILED = 200000002;

runValidation((cwd) => {
  const projectRoot = findProjectRoot(cwd) || cwd;
  if (readDeferralMarker(projectRoot)) return approve();

  const markerPath = almPath(projectRoot, 'lastForceLink');
  if (!fs.existsSync(markerPath)) return approve(); // Not a force-link session.

  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch {
    return block('docs/alm/last-force-link.json exists but could not be parsed as JSON.');
  }

  if (marker.schemaVersion !== 1) {
    return block(`docs/alm/last-force-link.json has unsupported schemaVersion: ${marker.schemaVersion}. Expected 1.`);
  }
  if (!marker.hostEnvUrl) {
    return block('docs/alm/last-force-link.json is missing required field: hostEnvUrl');
  }
  if (!marker.deploymentEnvironmentId) {
    return block('docs/alm/last-force-link.json is missing required field: deploymentEnvironmentId');
  }
  if (!marker.forcedAt) {
    return block('docs/alm/last-force-link.json is missing required field: forcedAt');
  }
  if (typeof marker.validationStatus !== 'number') {
    return block('docs/alm/last-force-link.json is missing required field: validationStatus (number)');
  }

  if (marker.validationStatus === VALIDATION_STATUS_FAILED) {
    return block(
      `docs/alm/last-force-link.json reports validationStatus=Failed (${VALIDATION_STATUS_FAILED}). Re-run force-link-environment or investigate the host's environment record.`,
    );
  }

  if (marker.validationStatus !== VALIDATION_STATUS_SUCCEEDED) {
    return block(
      `docs/alm/last-force-link.json has non-terminal validationStatus=${marker.validationStatus}. Expected Succeeded (${VALIDATION_STATUS_SUCCEEDED}).`,
    );
  }

  return approve();
});
