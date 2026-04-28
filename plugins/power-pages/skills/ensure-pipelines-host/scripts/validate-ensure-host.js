#!/usr/bin/env node

// Stop-hook validator for the ensure-pipelines-host skill.
// Reads .last-host-check.json from the project root and verifies the skill ran
// to a documented terminal state. Gracefully exits 0 when no marker exists
// (not an ensure-host session).
//
// Pass conditions (exit 0):
//   - File missing.
//   - schemaVersion is 1 or 2.
//   - tenantId, sourceEnvUrl, resolutionStatus populated.
//   - Either ready === true (host is usable), OR
//     resolutionStatus is a documented terminal-error state where finalHostEnvUrl
//     is null and the user has been told what to do (CannotRedirect /
//     OrgSettingStale / PermissionDenied).
//
// Block conditions (exit 2):
//   - Schema invalid / required fields missing.
//   - ready === false AND resolutionStatus is not in the terminal-error allowlist.

const fs = require('fs');
const path = require('path');
const {
  approve,
  block,
  runValidation,
  findProjectRoot,
  findPath,
} = require('../../../scripts/lib/validation-helpers');

const TERMINAL_ERROR_STATES = new Set([
  'CannotRedirect',
  'OrgSettingStale',
  'PermissionDenied',
]);

const VALID_STATUSES = new Set([
  'AvailableUsingPlatformHost',
  'AvailableUsingCustomHost',
  'AvailableUsingCustomHostByAdminDefault',
  'AvailableUnboundCustomHost',
  'MultipleUnboundCustomHosts',
  'PlatformHostExistsUnbound',
  'CannotRedirect',
  'NoHost',
  'OrgSettingStale',
  'PermissionDenied',
  'HostWithoutPipelines',
]);

runValidation((cwd) => {
  const projectRoot = findProjectRoot(cwd) || cwd;
  const markerPath = findPath(projectRoot, '.last-host-check.json');

  if (!markerPath) return approve(); // Not an ensure-host session.

  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch {
    return block('.last-host-check.json exists but could not be parsed as JSON.');
  }

  if (marker.schemaVersion !== 1 && marker.schemaVersion !== 2) {
    return block(`.last-host-check.json has unsupported schemaVersion: ${marker.schemaVersion}. Expected 1 or 2.`);
  }
  if (!marker.tenantId) {
    return block('.last-host-check.json is missing required field: tenantId');
  }
  if (!marker.sourceEnvUrl) {
    return block('.last-host-check.json is missing required field: sourceEnvUrl');
  }
  if (!marker.resolutionStatus) {
    return block('.last-host-check.json is missing required field: resolutionStatus');
  }
  if (!VALID_STATUSES.has(marker.resolutionStatus)) {
    return block(`.last-host-check.json has unknown resolutionStatus: ${marker.resolutionStatus}`);
  }

  // Acceptable terminal-error: ready may be false but resolution itself was correct.
  if (TERMINAL_ERROR_STATES.has(marker.resolutionStatus)) {
    return approve();
  }

  // Otherwise the host must be usable.
  if (marker.ready !== true) {
    return block(`.last-host-check.json has ready=${marker.ready} but resolutionStatus "${marker.resolutionStatus}" requires a usable host. The skill did not complete successfully.`);
  }

  // Sanity: when ready=true, finalHostEnvUrl must be set.
  if (!marker.finalHostEnvUrl) {
    return block('.last-host-check.json has ready=true but finalHostEnvUrl is missing.');
  }

  return approve();
});
