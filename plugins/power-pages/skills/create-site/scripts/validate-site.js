#!/usr/bin/env node

// Validates either a generated code site or a downloaded declarative EDM site.
// The PostToolUse hook uses structural checks; the EDM workflow also passes the
// expected website record ID for an identity match before creating the Git baseline.

const fs = require('fs');
const path = require('path');
const {
  approve,
  block,
  runValidation,
  findProjectRoot,
  UUID_REGEX,
} = require('../../../scripts/lib/validation-helpers');

const PLACEHOLDER_RE = /__[A-Z][A-Z_]{2,}__/;

function findPlaceholdersInFile(filePath) {
  const results = [];
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      if (PLACEHOLDER_RE.test(lines[index])) {
        results.push(`${path.basename(filePath)}:${index + 1}: ${lines[index].trim()}`);
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

function validateCodeProject(projectRoot) {
  const errors = [];
  const configPath = path.join(projectRoot, 'powerpages.config.json');

  for (const file of ['package.json', '.gitignore', 'powerpages.config.json']) {
    if (!fs.existsSync(path.join(projectRoot, file))) {
      errors.push(`Missing required file: ${file}`);
    }
  }

  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!config.$schema) errors.push('powerpages.config.json: missing $schema');
    if (!config.compiledPath) errors.push('powerpages.config.json: missing compiledPath');
    if (!config.siteName) errors.push('powerpages.config.json: missing siteName');
    if (!config.defaultLandingPage) {
      errors.push('powerpages.config.json: missing defaultLandingPage');
    }
  } catch {
    errors.push('powerpages.config.json: invalid JSON');
  }

  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    if (!pkg.scripts || !pkg.scripts.build) errors.push('package.json: missing "build" script');
    if (!pkg.scripts || !pkg.scripts.dev) errors.push('package.json: missing "dev" script');
  } catch {}

  const placeholders = [];
  const sourceDir = path.join(projectRoot, 'src');
  if (fs.existsSync(sourceDir)) placeholders.push(...findPlaceholders(sourceDir));
  const indexPath = path.join(projectRoot, 'index.html');
  if (fs.existsSync(indexPath)) placeholders.push(...findPlaceholdersInFile(indexPath));
  if (placeholders.length > 0) {
    errors.push(`Unreplaced placeholders found:\n  ${placeholders.slice(0, 5).join('\n  ')}`);
    if (placeholders.length > 5) {
      errors.push(`  ...and ${placeholders.length - 5} more`);
    }
  }

  if (!fs.existsSync(path.join(projectRoot, '.git'))) {
    errors.push('Git repository not initialized');
  }
  if (!fs.existsSync(sourceDir)) errors.push('Missing src/ directory');

  return errors;
}

function readWebsiteIdentity(websitePath) {
  const raw = fs.readFileSync(websitePath, 'utf8');
  const match = raw.match(/^\s*id\s*:\s*(.+?)\s*$/im);
  if (!match) return { raw, id: null };
  let id = match[1].replace(/\s+#.*$/, '').trim();
  if (
    (id.startsWith('"') && id.endsWith('"')) ||
    (id.startsWith("'") && id.endsWith("'"))
  ) {
    id = id.slice(1, -1);
  }
  return { raw, id };
}

function listDeclarativeAssetFiles(siteDir) {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '.portalconfig') walk(fullPath);
      } else if (entry.isFile() && /\.(?:ya?ml|html?|css|js|liquid)$/i.test(entry.name)) {
        if (fullPath !== path.join(siteDir, 'website.yml')) files.push(fullPath);
      }
    }
  };
  walk(siteDir);
  return files;
}

function validateDeclarativeProject(
  projectRoot,
  { expectedWebsiteRecordId = null, skipGit = false } = {},
) {
  const errors = [];
  const siteDir = path.join(projectRoot, '.powerpages-site');
  const portalConfigDir = path.join(siteDir, '.portalconfig');
  const websitePath = path.join(siteDir, 'website.yml');

  if (!fs.existsSync(portalConfigDir) || !fs.statSync(portalConfigDir).isDirectory()) {
    errors.push('Missing declarative marker: .powerpages-site/.portalconfig/');
  }
  if (!fs.existsSync(websitePath) || fs.statSync(websitePath).size === 0) {
    errors.push('Missing or empty identity file: .powerpages-site/website.yml');
  } else {
    const identity = readWebsiteIdentity(websitePath);
    if (!identity.id || !UUID_REGEX.test(identity.id)) {
      errors.push('.powerpages-site/website.yml: missing or invalid id');
    } else if (
      expectedWebsiteRecordId &&
      identity.id.toLowerCase() !== expectedWebsiteRecordId.toLowerCase()
    ) {
      errors.push(
        `.powerpages-site/website.yml id ${identity.id} does not match created website ` +
          `${expectedWebsiteRecordId}`,
      );
    }
  }

  try {
    if (fs.existsSync(siteDir) && listDeclarativeAssetFiles(siteDir).length === 0) {
      errors.push('Downloaded declarative tree contains no site assets beyond identity metadata');
    }
  } catch (error) {
    errors.push(`Could not inspect declarative site assets: ${error.message}`);
  }

  if (!skipGit && !fs.existsSync(path.join(projectRoot, '.git'))) {
    errors.push('Git repository not initialized');
  }

  return errors;
}

function validateProject(projectRoot, options = {}) {
  if (!projectRoot) return { siteType: null, errors: [] };
  if (fs.existsSync(path.join(projectRoot, 'powerpages.config.json'))) {
    return { siteType: 'code', errors: validateCodeProject(projectRoot) };
  }
  if (fs.existsSync(path.join(projectRoot, '.powerpages-site'))) {
    return {
      siteType: 'declarative',
      errors: validateDeclarativeProject(projectRoot, options),
    };
  }
  return { siteType: null, errors: [] };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue;
    const key = argv[index].slice(2);
    const value = argv[index + 1];
    if (value && !value.startsWith('--')) {
      args[key] = value;
      index += 1;
    }
  }
  return args;
}

function validationMessage(result) {
  return `Power Pages ${result.siteType || 'site'} validation failed:\n- ${result.errors.join('\n- ')}`;
}

function runHook() {
  runValidation((cwd) => {
    const projectRoot = findProjectRoot(cwd);
    const result = validateProject(projectRoot);
    if (result.errors.length > 0) block(validationMessage(result));
    approve();
  });
}

function runDirect() {
  const args = parseArgs(process.argv.slice(2));
  const projectRoot = args.projectRoot
    ? path.resolve(args.projectRoot)
    : findProjectRoot(process.cwd());
  const result = validateProject(projectRoot, {
    expectedWebsiteRecordId: args.websiteRecordId || null,
    skipGit: args.skipGit === 'true',
  });
  if (!result.siteType) {
    process.stderr.write('No Power Pages project found.\n');
    process.exitCode = 2;
  } else if (result.errors.length > 0) {
    process.stderr.write(`${validationMessage(result)}\n`);
    process.exitCode = 2;
  } else {
    process.stdout.write(`Power Pages ${result.siteType} site validation passed.\n`);
  }
}

if (require.main === module) {
  if (process.argv.includes('--projectRoot')) runDirect();
  else runHook();
}

module.exports = {
  findPlaceholdersInFile,
  findPlaceholders,
  readWebsiteIdentity,
  listDeclarativeAssetFiles,
  validateCodeProject,
  validateDeclarativeProject,
  validateProject,
  parseArgs,
};
