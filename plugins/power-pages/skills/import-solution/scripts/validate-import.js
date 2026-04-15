#!/usr/bin/env node

// Validates that import-solution completed: checks for .last-import.json marker in project root.
// Verifies the import completed without failures.
// Gracefully exits 0 when no import marker is found (not an import-solution session).

const fs = require('fs');
const path = require('path');
const {
  approve, block, runValidation, findProjectRoot,
} = require('../../../scripts/lib/validation-helpers');

runValidation(async (cwd) => {
  const projectRoot = findProjectRoot(cwd) || cwd;
  const markerPath = path.join(projectRoot, '.last-import.json');

  // No import marker — not an import-solution session
  if (!fs.existsSync(markerPath)) return approve();

  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch {
    return block('.last-import.json exists but could not be parsed. The import-solution skill may have failed to write the marker.');
  }

  // Check required fields
  if (!marker.solutionName) {
    return block('.last-import.json is missing solutionName. The import may not have completed.');
  }
  if (!marker.targetEnvironment) {
    return block('.last-import.json is missing targetEnvironment. The import may not have completed.');
  }
  if (!marker.importedAt) {
    return block('.last-import.json is missing importedAt timestamp. The import may not have completed.');
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
