#!/usr/bin/env node
// validate-env-variables.js
// Stop hook validator for the configure-env-variables skill.
// Checks that deployment-settings.json was written with at least one env var entry.

const { approve, block, runValidation } = require('../../../scripts/lib/validation-helpers.js');
const fs = require('fs');
const path = require('path');

runValidation('configure-env-variables', () => {
  // Find project root (look for deployment-settings.json or solution-manifest.json)
  let projectRoot = process.cwd();
  const markers = ['deployment-settings.json', '.solution-manifest.json', 'powerpages.config.json'];
  let found = false;
  for (let dir = projectRoot; dir !== path.dirname(dir); dir = path.dirname(dir)) {
    if (markers.some(m => fs.existsSync(path.join(dir, m)))) {
      projectRoot = dir;
      found = true;
      break;
    }
  }

  const settingsPath = path.join(projectRoot, 'deployment-settings.json');

  // Graceful exit if no deployment-settings.json found — not a configure-env-variables session
  if (!fs.existsSync(settingsPath)) {
    return approve('No deployment-settings.json found — skipping env var validation');
  }

  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (e) {
    return block(`deployment-settings.json is not valid JSON: ${e.message}`);
  }

  // Must have stages
  if (!settings.stages || typeof settings.stages !== 'object') {
    return block('deployment-settings.json is missing "stages" object');
  }

  const stageNames = Object.keys(settings.stages);
  if (stageNames.length === 0) {
    return block('deployment-settings.json has no stages defined');
  }

  // Each stage must have at least an EnvironmentVariables array (can be empty)
  for (const stageName of stageNames) {
    const stage = settings.stages[stageName];
    if (!Array.isArray(stage.EnvironmentVariables)) {
      return block(`Stage "${stageName}" in deployment-settings.json is missing "EnvironmentVariables" array`);
    }
  }

  // At least one stage must have at least one env var
  const totalEnvVars = stageNames.reduce((sum, n) => sum + (settings.stages[n].EnvironmentVariables?.length || 0), 0);
  if (totalEnvVars === 0) {
    return block('deployment-settings.json has no EnvironmentVariables configured in any stage');
  }

  return approve(`deployment-settings.json valid — ${stageNames.length} stage(s), ${totalEnvVars} env var(s) configured`);
});
