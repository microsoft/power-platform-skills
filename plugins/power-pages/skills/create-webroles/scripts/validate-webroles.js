#!/usr/bin/env node

// Validates that new web role YAML files were created for an SPA or non-SPA site.
// Runs as a PostToolUse(Skill) hook to verify the skill produced output.

const fs = require('fs');
const path = require('path');
const {
  approve,
  block,
  runValidation,
  findProjectRoot,
  resolvePowerPagesSiteRoot,
} = require('../../../scripts/lib/validation-helpers');
const { validateWebRoles } = require('../../../scripts/lib/web-roles-validator');

runValidation((cwd) => {
  const projectRoot = findProjectRoot(cwd);
  if (!projectRoot) approve(); // Not a Power Pages project

  const siteRoot = resolvePowerPagesSiteRoot(projectRoot);
  const webRolesDir = siteRoot && path.join(siteRoot, 'web-roles');
  const aggregateWebRolesFile = siteRoot && path.join(siteRoot, 'webrole.yml');
  const hasPerRecordStorage = webRolesDir && fs.existsSync(webRolesDir);
  const hasAggregateStorage = aggregateWebRolesFile && fs.existsSync(aggregateWebRolesFile);
  if (!hasPerRecordStorage && !hasAggregateStorage) {
    approve(); // No downloaded/deployed web-role metadata — not a web roles session
  }

  const validation = validateWebRoles(projectRoot);
  const errors = validation.findings
    .filter(finding => finding.severity === 'error')
    .map(finding => finding.filePath ? `${finding.message} (${path.basename(finding.filePath)})` : finding.message);

  if (errors.length > 0) {
    block('Web roles validation failed:\n- ' + errors.join('\n- '));
  }

  // The hook runs when the skill is invoked, before it necessarily creates output.
  // Empty aggregate files or per-record directories therefore remain a safe no-op.
  approve();
});
