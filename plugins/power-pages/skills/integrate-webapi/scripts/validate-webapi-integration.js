#!/usr/bin/env node

// Validates Web API integration for Power Pages SPA and non-SPA sites.
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
const { validatePowerPagesSchema } = require('../../../scripts/lib/powerpages-schema-validator');

runValidation((cwd) => {
  const projectRoot = findProjectRoot(cwd);
  if (!projectRoot) approve(); // Not a Power Pages project, skip

  if (!fs.existsSync(path.join(projectRoot, 'powerpages.config.json'))) {
    validateNonSpaIntegration(projectRoot);
    approve();
  }

  validateSpaIntegration(projectRoot);
  approve();
});

function validateSpaIntegration(projectRoot) {
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

  addSchemaErrors(projectRoot, errors);

  if (errors.length > 0) {
    block('Web API integration validation failed:\n- ' + errors.join('\n- '));
  }
}

function validateNonSpaIntegration(projectRoot) {
  const siteRoot = resolvePowerPagesSiteRoot(projectRoot);
  if (!siteRoot) return;

  const apiFiles = findNonSpaApiFiles(siteRoot);
  if (apiFiles.length === 0) return;

  const errors = [];
  // Token handling can live in a shared Web File loaded separately from the caller.
  // A file-local substring check cannot distinguish that valid arrangement from an
  // unprotected request, so the workflow owns token review instead of this validator.
  addSchemaErrors(projectRoot, errors);
  if (errors.length > 0) {
    block('Non-SPA Web API integration validation failed:\n- ' + errors.join('\n- '));
  }
}

function addSchemaErrors(projectRoot, errors) {
  const schemaValidation = validatePowerPagesSchema(projectRoot);
  const schemaErrors = schemaValidation.findings
    .filter(finding => finding.severity === 'error')
    .map(finding => finding.filePath ? `${finding.message} (${path.basename(finding.filePath)})` : finding.message);

  if (schemaErrors.length > 0) {
    errors.push('Invalid Power Pages permissions/site-settings schema:\n  - ' + schemaErrors.join('\n  - '));
  }
}

function findNonSpaApiFiles(siteRoot) {
  const roots = ['web-files', 'web-pages', 'web-templates']
    .map(relativePath => path.join(siteRoot, relativePath))
    .filter(candidate => fs.existsSync(candidate));
  const files = [];

  for (const root of roots) {
    walkTextFiles(root, files);
  }

  return files.filter(filePath => fs.readFileSync(filePath, 'utf8').includes('/_api/'));
}

function walkTextFiles(dirPath, files) {
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      walkTextFiles(entryPath, files);
      continue;
    }
    if (entry.isFile() && /\.(?:js|html?)$/i.test(entry.name)) {
      files.push(entryPath);
    }
  }
}

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
