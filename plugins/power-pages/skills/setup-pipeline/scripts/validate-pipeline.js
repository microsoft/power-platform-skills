#!/usr/bin/env node

// Validates that setup-pipeline completed: checks for .last-pipeline.json (Power Platform Pipelines)
// or pipeline YAML files (GitHub Actions / ADO — legacy / future).
// For PP Pipelines: validates pipelineId, hostEnvUrl, sourceDeploymentEnvironmentId, non-empty stages[].
// Gracefully exits 0 when no pipeline artifacts are found (not a setup-pipeline session).

const fs = require('fs');
const path = require('path');
const {
  approve, block, runValidation, findProjectRoot, findPath,
} = require('../../../scripts/lib/validation-helpers');

runValidation(async (cwd) => {
  const projectRoot = findProjectRoot(cwd) || cwd;

  // Check for Power Platform Pipelines marker (primary path)
  const ppMarkerPath = findPath(projectRoot, '.last-pipeline.json');

  // Check for GitHub Actions workflow or ADO pipeline (future/legacy paths)
  const ghWorkflowPath = findPath(projectRoot, path.join('.github', 'workflows', 'deploy.yml'));
  const adoPipelinePath = findPath(projectRoot, 'azure-pipelines.yml');

  // No pipeline artifacts found — not a setup-pipeline session
  if (!ppMarkerPath && !ghWorkflowPath && !adoPipelinePath) return approve();

  // --- Power Platform Pipelines path ---
  if (ppMarkerPath) {
    let marker;
    try {
      marker = JSON.parse(fs.readFileSync(ppMarkerPath, 'utf8'));
    } catch {
      return block('.last-pipeline.json exists but could not be parsed as JSON.');
    }

    if (!marker.pipelineId) {
      return block('.last-pipeline.json is missing required field: pipelineId');
    }
    if (!marker.hostEnvUrl) {
      return block('.last-pipeline.json is missing required field: hostEnvUrl');
    }
    if (!marker.sourceDeploymentEnvironmentId) {
      return block('.last-pipeline.json is missing required field: sourceDeploymentEnvironmentId');
    }
    if (!Array.isArray(marker.stages) || marker.stages.length === 0) {
      return block('.last-pipeline.json has empty or missing stages array. At least one deployment stage is required.');
    }

    // Verify each stage has required fields
    for (const stage of marker.stages) {
      if (!stage.stageId) {
        return block(`.last-pipeline.json stage "${stage.name || '?'}" is missing stageId.`);
      }
      if (!stage.targetDeploymentEnvironmentId) {
        return block(`.last-pipeline.json stage "${stage.name || '?'}" is missing targetDeploymentEnvironmentId.`);
      }
    }

    // Check docs/pipeline-setup.md was created
    const setupDocPath = findPath(projectRoot, path.join('docs', 'pipeline-setup.md'));
    if (!setupDocPath) {
      return block('docs/pipeline-setup.md was not created. The setup documentation is required.');
    }

    return approve();
  }

  // --- GitHub Actions / ADO path (future implementation) ---
  const pipelinePath = ghWorkflowPath || adoPipelinePath;
  const isGitHub = !!ghWorkflowPath;

  let pipelineContent;
  try {
    pipelineContent = fs.readFileSync(pipelinePath, 'utf8');
  } catch {
    return block(`Pipeline file '${pipelinePath}' could not be read. The file may be corrupt.`);
  }

  if (!pipelineContent.trim()) {
    return block(`Pipeline file '${pipelinePath}' is empty.`);
  }

  // Check for required YAML keys
  if (isGitHub) {
    if (!pipelineContent.includes('on:') && !pipelineContent.includes("'on':")) {
      return block("GitHub Actions workflow is missing the 'on:' trigger section.");
    }
    if (!pipelineContent.includes('jobs:')) {
      return block("GitHub Actions workflow is missing the 'jobs:' section.");
    }
  } else {
    if (!pipelineContent.includes('trigger:')) {
      return block("Azure DevOps pipeline is missing the 'trigger:' section.");
    }
    if (!pipelineContent.includes('stages:') && !pipelineContent.includes('jobs:')) {
      return block("Azure DevOps pipeline is missing both 'stages:' and 'jobs:' sections.");
    }
  }

  if (!pipelineContent.includes('pac pages upload-code-site')) {
    return block("Pipeline file does not contain a 'pac pages upload-code-site' step. The Power Pages deploy step is missing.");
  }

  // Check for unreplaced placeholder tokens
  const lines = pipelineContent.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) continue;
    if (/\{[A-Z][A-Z_]+\}/.test(trimmed) && !trimmed.includes('${{')) {
      return block(`Pipeline file contains an unreplaced placeholder token in line: "${trimmed.substring(0, 100)}". Fill in all required values.`);
    }
  }

  const setupGuidePath = findPath(projectRoot, path.join('docs', 'ci-cd-setup.md'));
  if (!setupGuidePath) {
    return block('docs/ci-cd-setup.md was not created. The setup guide is required to document manual steps.');
  }

  return approve();
});
