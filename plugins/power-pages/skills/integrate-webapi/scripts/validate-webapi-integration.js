#!/usr/bin/env node

// Validates that Web API integration code was created for a Power Pages code site.
// Runs as a Stop hook to verify the skill produced output.

const fs = require('fs');
const path = require('path');

// Exit 0 = success (allow). Exit 2 = blocking error (stderr is fed back to Claude).
const approve = () => { process.exit(0); };
const block = (reason) => {
  process.stderr.write(reason);
  process.exit(2);
};

let inputData = '';
process.stdin.on('data', chunk => (inputData += chunk));
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(inputData);
    const cwd = input.cwd;

    if (!cwd) approve();

    const projectRoot = findProjectRoot(cwd);
    if (!projectRoot) approve(); // Not a Power Pages project, skip

    // Check if any Web API integration files exist — if none, this wasn't an integration session
    const apiClientExists = findApiClient(projectRoot);
    const serviceFiles = findServiceFiles(projectRoot);

    if (!apiClientExists && serviceFiles.length === 0) approve();

    const errors = [];

    // 1. Core API client must exist
    if (!apiClientExists) {
      errors.push('Missing shared API client (src/shared/powerPagesApi.ts or equivalent)');
    }

    // 2. At least one service file must exist
    if (serviceFiles.length === 0) {
      errors.push('No service files found in src/shared/services/ or src/services/');
    }

    // 3. Validate each service file has expected exports
    for (const serviceFile of serviceFiles) {
      const content = fs.readFileSync(serviceFile, 'utf8');
      if (!content.includes('/_api/')) {
        errors.push(`${path.basename(serviceFile)}: missing /_api/ endpoint references`);
      }
    }

    // 4. Check for type files
    const typeFiles = findTypeFiles(projectRoot);
    if (typeFiles.length === 0 && serviceFiles.length > 0) {
      errors.push('No type definition files found in src/types/ — services should have corresponding type definitions');
    }

    if (errors.length > 0) {
      block('Web API integration validation failed:\n- ' + errors.join('\n- '));
    }

    approve();
  } catch {
    // Don't block on script errors
    approve();
  }
});

function findProjectRoot(dir) {
  const direct = path.join(dir, 'powerpages.config.json');
  if (fs.existsSync(direct)) return dir;

  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
        const sub = path.join(dir, entry.name, 'powerpages.config.json');
        if (fs.existsSync(sub)) return path.join(dir, entry.name);
      }
    }
  } catch {}

  return null;
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
