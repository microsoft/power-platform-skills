#!/usr/bin/env node

// Validates that new web role YAML files were created in .powerpages-site/web-roles/.
// Runs as a Stop hook to verify the skill produced output.

const fs = require('fs');
const path = require('path');
const { approve, block, runValidation, findPowerPagesSiteDir, UUID_REGEX } = require('../../../scripts/lib/validation-helpers');

runValidation((cwd) => {
  const webRolesDir = findPowerPagesSiteDir(cwd, 'web-roles');
  if (!webRolesDir) approve(); // No .powerpages-site found — not a web roles session

  const files = fs.readdirSync(webRolesDir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));
  if (files.length === 0) {
    block('Web roles validation failed:\n- No web role YAML files found in .powerpages-site/web-roles/');
  }

  const errors = [];

  for (const file of files) {
    const content = fs.readFileSync(path.join(webRolesDir, file), 'utf8');

    if (!content.includes('id:')) errors.push(`${file}: missing "id" field`);
    if (!content.includes('name:')) errors.push(`${file}: missing "name" field`);

    const idMatch = content.match(/^id:\s*(.+)$/m);
    if (idMatch) {
      const id = idMatch[1].trim();
      if (!UUID_REGEX.test(id)) {
        errors.push(`${file}: invalid UUID format in "id" field: ${id}`);
      }
    }
  }

  if (errors.length > 0) {
    block('Web roles validation failed:\n- ' + errors.join('\n- '));
  }

  approve();
});
