#!/usr/bin/env node

// Validates Power Pages site activation output.
// Runs as a Stop hook to verify the website was provisioned in the environment.
// Reads the activation result written by activate-site.js (via Operation-Location polling)
// instead of making a separate GET /websites call to list all websites.

const fs = require('fs');
const path = require('path');
const { approve, block, runValidation, findPath } = require('../../../scripts/lib/validation-helpers');

runValidation(async (cwd) => {
  const configPath = findPath(cwd, 'powerpages.config.json');
  if (!configPath) approve(); // Not a Power Pages project, skip

  const projectRoot = path.dirname(configPath);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const siteName = config.siteName;
  if (!siteName) approve();

  // Read activation result written by activate-site.js to the project root.
  // This avoids a separate GET /websites call — the result was already
  // determined by polling the Operation-Location header from the POST.
  const resultPath = path.join(projectRoot, '.activation-result.json');
  let result;
  try {
    result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  } catch {
    approve(); // No result file — activation script didn't run in this session, don't block
  }

  if (result.status === 'Succeeded') {
    approve();
  }

  if (result.status === 'Failed') {
    block(
      `Power Pages activation validation failed:\n- ${result.error || 'Provisioning failed'}. The site may not have been provisioned successfully.`
    );
  }

  // Running / other — don't block, provisioning may still be in progress
  approve();
});
