#!/usr/bin/env node

// Validates Power Pages code site generation output.
// Runs as a Stop hook to verify the site was properly created.

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

    const configPath = findConfig(cwd);
    if (!configPath) approve(); // Not a Power Pages project, skip

    const projectRoot = path.dirname(configPath);
    const errors = [];

    // 1. Required files
    for (const file of ['package.json', '.gitignore', 'powerpages.config.json']) {
      if (!fs.existsSync(path.join(projectRoot, file))) {
        errors.push(`Missing required file: ${file}`);
      }
    }

    // 2. powerpages.config.json fields
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (!config.$schema) errors.push('powerpages.config.json: missing $schema');
      if (!config.compiledPath) errors.push('powerpages.config.json: missing compiledPath');
      if (!config.siteName) errors.push('powerpages.config.json: missing siteName');
      if (!config.defaultLandingPage) errors.push('powerpages.config.json: missing defaultLandingPage');
    } catch {
      errors.push('powerpages.config.json: invalid JSON');
    }

    // 3. package.json has build script
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
      if (!pkg.scripts || !pkg.scripts.build) errors.push('package.json: missing "build" script');
      if (!pkg.scripts || !pkg.scripts.dev) errors.push('package.json: missing "dev" script');
    } catch {
      // Already caught by required files check
    }

    // 4. Unreplaced placeholders in source files
    const dirsToCheck = [
      path.join(projectRoot, 'src'),
    ];
    const rootFiles = ['index.html'].map(f => path.join(projectRoot, f));

    const placeholders = [];
    for (const dir of dirsToCheck) {
      if (fs.existsSync(dir)) placeholders.push(...findPlaceholders(dir));
    }
    for (const file of rootFiles) {
      if (fs.existsSync(file)) placeholders.push(...findPlaceholdersInFile(file));
    }
    if (placeholders.length > 0) {
      errors.push('Unreplaced placeholders found:\n  ' + placeholders.slice(0, 5).join('\n  '));
      if (placeholders.length > 5) {
        errors.push(`  ...and ${placeholders.length - 5} more`);
      }
    }

    // 5. Git repository initialized
    if (!fs.existsSync(path.join(projectRoot, '.git'))) {
      errors.push('Git repository not initialized');
    }

    // 6. Source directory exists with content
    const srcDir = path.join(projectRoot, 'src');
    if (!fs.existsSync(srcDir)) {
      errors.push('Missing src/ directory');
    }

    if (errors.length > 0) {
      block('Power Pages site validation failed:\n- ' + errors.join('\n- '));
    }

    approve();
  } catch {
    // Don't block on script errors
    approve();
  }
});

function findConfig(dir) {
  const direct = path.join(dir, 'powerpages.config.json');
  if (fs.existsSync(direct)) return direct;

  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
        const sub = path.join(dir, entry.name, 'powerpages.config.json');
        if (fs.existsSync(sub)) return sub;
      }
    }
  } catch {}

  return null;
}

const PLACEHOLDER_RE = /__[A-Z][A-Z_]{2,}__/;

function findPlaceholdersInFile(filePath) {
  const results = [];
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (PLACEHOLDER_RE.test(lines[i])) {
        results.push(`${path.basename(filePath)}:${i + 1}: ${lines[i].trim()}`);
      }
    }
  } catch {}
  return results;
}

function findPlaceholders(dir) {
  const results = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== 'node_modules') {
        results.push(...findPlaceholders(fullPath));
      } else if (entry.isFile()) {
        results.push(...findPlaceholdersInFile(fullPath));
      }
    }
  } catch {}
  return results;
}
