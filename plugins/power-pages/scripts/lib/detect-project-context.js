#!/usr/bin/env node

// Reads Power Pages project context files from the project root.
// Locates powerpages.config.json, .solution-manifest.json, and .datamodel-manifest.json.
//
// Usage: node detect-project-context.js [--projectRoot <path>]
//
// Options:
//   --projectRoot <path>   Use this path as project root (default: auto-discover from cwd)
//
// Output (JSON to stdout):
//   {
//     "projectRoot": "...",
//     "siteName": "...",
//     "websiteRecordId": "...",
//     "environmentUrl": "...",
//     "solutionManifest": { ... } | null,
//     "datamodelManifest": { ... } | null
//   }
//
// Exit 0 on success, exit 1 if powerpages.config.json not found.

'use strict';

const fs = require('fs');
const path = require('path');
const { findProjectRoot } = require('./validation-helpers');

function parseArgs(argv) {
  const args = argv.slice(2);
  let projectRoot = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--projectRoot' && args[i + 1]) projectRoot = args[++i];
  }

  return { projectRoot };
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function detectProjectContext(options = {}) {
  const startDir = options.projectRoot || process.cwd();
  const projectRoot = options.projectRoot
    ? path.resolve(options.projectRoot)
    : findProjectRoot(startDir);

  if (!projectRoot) {
    throw new Error(
      'powerpages.config.json not found. Run this command from a Power Pages project directory.'
    );
  }

  const configPath = path.join(projectRoot, 'powerpages.config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(`powerpages.config.json not found at: ${configPath}`);
  }

  const config = readJsonFile(configPath);
  if (!config) {
    throw new Error(`Failed to parse powerpages.config.json at: ${configPath}`);
  }

  const solutionManifest = readJsonFile(path.join(projectRoot, '.solution-manifest.json'));
  const datamodelManifest = readJsonFile(path.join(projectRoot, '.datamodel-manifest.json'));

  return {
    projectRoot,
    siteName: config.siteName || null,
    websiteRecordId: config.websiteRecordId || null,
    environmentUrl: config.environmentUrl || null,
    solutionManifest,
    datamodelManifest,
  };
}

// CLI entry point
if (require.main === module) {
  const { projectRoot } = parseArgs(process.argv);

  try {
    const result = detectProjectContext({ projectRoot });
    console.log(JSON.stringify(result));
    process.exit(0);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}

module.exports = { detectProjectContext };
