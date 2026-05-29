#!/usr/bin/env node

// Validates that new web role YAML files were created in .powerpages-site/web-roles/.
// Runs as a Stop hook to verify the skill produced output.

const path = require('path');
const { approve, block, runValidation, findPowerPagesSiteDir } = require('../../../scripts/lib/validation-helpers');
const { validateWebRoles } = require('../../../scripts/lib/web-roles-validator');

runValidation((cwd) => {
  const webRolesDir = findPowerPagesSiteDir(cwd, 'web-roles');
  if (!webRolesDir) approve(); // No .powerpages-site found — not a web roles session

  const validation = validateWebRoles(path.resolve(webRolesDir, '..', '..'));
  const webRoleFiles = validation.webRoles;
  if (webRoleFiles && webRoleFiles.length === 0) {
    block('Web roles validation failed:\n- No web role YAML files found in .powerpages-site/web-roles/');
  }
  const errors = validation.findings
    .filter(finding => finding.severity === 'error')
    .map(finding => finding.filePath ? `${finding.message} (${path.basename(finding.filePath)})` : finding.message);

  if (errors.length > 0) {
    block('Web roles validation failed:\n- ' + errors.join('\n- '));
  }

  approve();
});
