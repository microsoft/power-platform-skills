#!/usr/bin/env node

// Validates Power Pages site activation output.
// Runs as a Stop hook to verify the website was provisioned in the environment.
// Calls the shared check-activation-status.js script to query the Power Platform API
// instead of relying on an intermediate file.

const path = require('path');
const { execSync } = require('child_process');
const { approve, block, runValidation, findPath } = require('../../../scripts/lib/validation-helpers');

runValidation(async (cwd) => {
  const configPath = findPath(cwd, 'powerpages.config.json');
  if (!configPath) approve(); // Not a Power Pages project, skip

  const projectRoot = path.dirname(configPath);
  const checkScript = path.resolve(__dirname, '../../../scripts/check-activation-status.js');

  let result;
  try {
    const output = execSync(`node "${checkScript}" --projectRoot "${projectRoot}"`, {
      encoding: 'utf8',
      timeout: 30000,
    });
    result = JSON.parse(output);
  } catch {
    approve(); // Auth/transient failure — don't block
  }

  if (result.activated === true) {
    approve();
  }

  if (result.activated === false) {
    block(
      `Power Pages activation validation failed:\n- Site '${result.siteName || 'unknown'}' is not activated. The site may not have been provisioned successfully.`
    );
  }

  // Error or unexpected shape — don't block
  approve();
});
