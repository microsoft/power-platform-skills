#!/usr/bin/env node

// Validates that import-solution completed: checks for docs/alm/last-import.json marker.
// Verifies the import completed without failures.
// Gracefully exits 0 when no import marker is found (not an import-solution session).

const fs = require('fs');
const { approve, block, runValidation, findProjectRoot, readDeferralMarker } = require('../../../scripts/lib/validation-helpers');
const { almPath } = require('../../../scripts/lib/alm-paths');

runValidation(async (cwd) => {
  if (readDeferralMarker(findProjectRoot(cwd) || cwd)) return approve();  // ALM deferred — silent-approve.
  const projectRoot = findProjectRoot(cwd) || cwd;
  const markerPath = almPath(projectRoot, 'lastImport');

  // No import marker — not an import-solution session
  if (!fs.existsSync(markerPath)) return approve();

  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch {
    return block('docs/alm/last-import.json exists but could not be parsed. The import-solution skill may have failed to write the marker.');
  }

  // Check required fields
  if (!marker.solutionName) {
    return block('docs/alm/last-import.json is missing solutionName. The import may not have completed.');
  }
  if (!marker.targetEnvironment) {
    return block('docs/alm/last-import.json is missing targetEnvironment. The import may not have completed.');
  }
  if (!marker.importedAt) {
    return block('docs/alm/last-import.json is missing importedAt timestamp. The import may not have completed.');
  }

  // Check for component failures
  if (marker.componentResults) {
    const { failure = 0, success = 0 } = marker.componentResults;
    if (failure > 0 && success === 0) {
      return block(`Solution import for '${marker.solutionName}' had ${failure} component failure(s) and 0 successes. The import did not complete successfully.`);
    }
    // Partial failures are warnings, not blocks — the import may still be usable
  }

  return approve();
});
