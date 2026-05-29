#!/usr/bin/env node

// Validates that Web API integration code was created for a Power Pages code site.
// Runs as a Stop hook to verify the skill produced output.

const fs = require('fs');
const path = require('path');
const { approve, block, runValidation, findProjectRoot } = require('../../../scripts/lib/validation-helpers');
const { validatePowerPagesSchema } = require('../../../scripts/lib/powerpages-schema-validator');

runValidation((cwd) => {
  const projectRoot = findProjectRoot(cwd);
  if (!projectRoot) approve(); // Not a Power Pages project, skip

  // Check if any Web API integration files exist — if none, this wasn't an integration session
  const apiClientExists = findApiClient(projectRoot);
  const serviceFiles = findServiceFiles(projectRoot);

  if (!apiClientExists && serviceFiles.length === 0) approve();

  const errors = [];

  if (!apiClientExists) {
    errors.push('Missing shared API client (src/shared/powerPagesApi.ts or equivalent)');
  }

  if (serviceFiles.length === 0) {
    errors.push('No service files found in src/shared/services/ or src/services/');
  }

  for (const serviceFile of serviceFiles) {
    const content = fs.readFileSync(serviceFile, 'utf8');
    if (!content.includes('/_api/')) {
      errors.push(`${path.basename(serviceFile)}: missing /_api/ endpoint references`);
    }
  }

  const typeFiles = findTypeFiles(projectRoot);
  if (typeFiles.length === 0 && serviceFiles.length > 0) {
    errors.push('No type definition files found in src/types/ — services should have corresponding type definitions');
  }

  const schemaValidation = validatePowerPagesSchema(projectRoot);
  const schemaErrors = schemaValidation.findings
    .filter(finding => finding.severity === 'error')
    .map(finding => finding.filePath ? `${finding.message} (${path.basename(finding.filePath)})` : finding.message);

  if (schemaErrors.length > 0) {
    errors.push('Invalid Power Pages permissions/site-settings schema:\n  - ' + schemaErrors.join('\n  - '));
  }

  if (errors.length > 0) {
    block('Web API integration validation failed:\n- ' + errors.join('\n- '));
  }

  approve();
});

function findApiClient(projectRoot) {
  const candidates = [
    path.join(projectRoot, 'src', 'shared', 'powerPagesApi.ts'),
    path.join(projectRoot, 'src', 'shared', 'powerPagesApi.js'),
    path.join(projectRoot, 'src', 'services', 'powerPagesApi.ts'),
    path.join(projectRoot, 'src', 'services', 'powerPagesApi.js'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return true;
  }

  // Fallback: search for any file containing powerPagesFetch export
  try {
    const sharedDir = path.join(projectRoot, 'src', 'shared');
    if (fs.existsSync(sharedDir)) {
      for (const file of fs.readdirSync(sharedDir)) {
        if (file.endsWith('.ts') || file.endsWith('.js')) {
          const content = fs.readFileSync(path.join(sharedDir, file), 'utf8');
          if (content.includes('powerPagesFetch') && content.includes('__RequestVerificationToken')) {
            return true;
          }
        }
      }
    }
  } catch {}

  return false;
}

function findServiceFiles(projectRoot) {
  const serviceDirs = [
    path.join(projectRoot, 'src', 'shared', 'services'),
    path.join(projectRoot, 'src', 'services'),
  ];

  const files = [];
  for (const dir of serviceDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      for (const file of fs.readdirSync(dir)) {
        if ((file.endsWith('Service.ts') || file.endsWith('Service.js')) && !file.startsWith('.')) {
          files.push(path.join(dir, file));
        }
      }
    } catch {}
  }

  return files;
}

function findTypeFiles(projectRoot) {
  const typesDir = path.join(projectRoot, 'src', 'types');
  if (!fs.existsSync(typesDir)) return [];

  const files = [];
  try {
    for (const file of fs.readdirSync(typesDir)) {
      if ((file.endsWith('.ts') || file.endsWith('.js')) && !file.startsWith('.') && file !== 'index.ts') {
        files.push(path.join(typesDir, file));
      }
    }
  } catch {}

  return files;
}
