#!/usr/bin/env node

// Validates that hotfix-solution completed: checks for .last-hotfix.json marker in project root.
// Verifies required fields are present and the hotfix had at least one component.
// Gracefully exits 0 when no hotfix marker is found (not a hotfix-solution session).

const fs = require('fs');
const path = require('path');
const {
  approve, block, runValidation, findProjectRoot,
} = require('../../../scripts/lib/validation-helpers');

runValidation(async (cwd) => {
  const projectRoot = findProjectRoot(cwd) || cwd;
  const markerPath = path.join(projectRoot, '.last-hotfix.json');

  // No hotfix marker — not a hotfix-solution session
  if (!fs.existsSync(markerPath)) return approve();

  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch {
    return block('.last-hotfix.json exists but could not be parsed. The hotfix-solution skill may have failed to write the marker.');
  }

  // Check required fields
  if (!marker.solutionName) {
    return block('.last-hotfix.json is missing solutionName. The hotfix may not have completed.');
  }
  if (!marker.targetEnvironment) {
    return block('.last-hotfix.json is missing targetEnvironment. The hotfix may not have completed.');
  }
  if (!marker.exportedAt) {
    return block('.last-hotfix.json is missing exportedAt timestamp. The export phase may not have completed.');
  }
  if (!marker.importedAt) {
    return block('.last-hotfix.json is missing importedAt timestamp. The import phase may not have completed.');
  }

  // Check component count
  if (!marker.componentCount || marker.componentCount === 0) {
    return block('.last-hotfix.json reports 0 components deployed. The hotfix did not include any components.');
  }

  // Check components array
  if (!Array.isArray(marker.components) || marker.components.length === 0) {
    return block('.last-hotfix.json is missing components array. The hotfix may not have completed.');
  }

  return approve();
});
