#!/usr/bin/env node

// Validates that deploy-pipeline completed: checks .last-deploy.json for required fields.
// Blocks if status is "Failed" — a failed deployment requires investigation before retrying.
// Gracefully exits 0 when no deploy marker is found (not a deploy-pipeline session).

const fs = require('fs');
const {
  approve, block, runValidation, findProjectRoot, findPath,
} = require('../../../scripts/lib/validation-helpers');

runValidation(async (cwd) => {
  const projectRoot = findProjectRoot(cwd) || cwd;

  const markerPath = findPath(projectRoot, '.last-deploy.json');

  // No deploy marker found — not a deploy-pipeline session
  if (!markerPath) return approve();

  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch {
    return block('.last-deploy.json exists but could not be parsed as JSON.');
  }

  if (!marker.pipelineId) {
    return block('.last-deploy.json is missing required field: pipelineId');
  }
  if (!marker.stageRunId) {
    return block('.last-deploy.json is missing required field: stageRunId');
  }
  if (!marker.solutionName) {
    return block('.last-deploy.json is missing required field: solutionName');
  }
  if (!marker.status) {
    return block('.last-deploy.json is missing required field: status');
  }
  if (!marker.deployedAt) {
    return block('.last-deploy.json is missing required field: deployedAt');
  }

  if (marker.status === 'Failed') {
    return block(
      `Last deployment to "${marker.stageName || 'unknown stage'}" failed (stageRunId: ${marker.stageRunId}). ` +
      'Investigate the failure in Power Platform (make.powerapps.com → Solutions → Pipelines) before retrying.'
    );
  }

  // Check that deploy history HTML was written
  if (marker.deployHistoryFile) {
    const historyPath = findPath(projectRoot, marker.deployHistoryFile)
      || require('path').join(projectRoot, marker.deployHistoryFile);
    if (!fs.existsSync(historyPath)) {
      return block(
        `Deploy history file not found: ${marker.deployHistoryFile}. ` +
        'Phase 7.4 must write the deploy history HTML before the skill completes.'
      );
    }
    const size = fs.statSync(historyPath).size;
    if (size < 500) {
      return block(`Deploy history file is too small (${size} bytes): ${marker.deployHistoryFile}`);
    }
  }

  return approve();
});
