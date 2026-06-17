#!/usr/bin/env node

// Reads Power Pages project context files from the project root.
// Locates powerpages.config.json (code/SPA sites) OR .powerpages-site/website.yml
// (data-model config sites, standard and enhanced data model), plus
// .solution-manifest.json and .datamodel-manifest.json.
//
// Site identity resolution order (first match wins):
//   1. powerpages.config.json  -> siteType "code"  (SPA sites; has siteName,
//                                  websiteRecordId, environmentUrl)
//   2. .powerpages-site/website.yml -> siteType "data-model"  (enhanced/standard
//                                  data-model sites from `pac pages download`; the
//                                  YAML carries `id` and `name`, but no environment URL —
//                                  callers re-confirm the env via `pac env who`)
//
// Usage: node detect-project-context.js [--projectRoot <path>]
//
// Options:
//   --projectRoot <path>   Use this path as project root (default: auto-discover from cwd)
//
// Output (JSON to stdout):
//   {
//     "projectRoot": "...",
//     "siteType": "code" | "data-model",
//     "siteName": "...",
//     "websiteRecordId": "...",
//     "environmentUrl": "..." | null,
//     "solutionManifest": { ... } | null,
//     "datamodelManifest": { ... } | null
//   }
//
// Exit 0 on success, exit 1 if neither powerpages.config.json nor
// .powerpages-site/website.yml is found (not a Power Pages project).

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

// Minimal reader for the flat `.powerpages-site/website.yml` (a simple `key: value`
// per line — no nesting). Returns { id, name } or null. Zero-dependency by design
// (the plugin ships no YAML library); only the two identity keys are needed here.
function readWebsiteYml(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    // Strip surrounding quotes a YAML writer may add.
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key === 'id' || key === 'name') out[key] = value;
  }
  return (out.id || out.name) ? out : null;
}

function detectProjectContext(options = {}) {
  const startDir = options.projectRoot || process.cwd();
  const projectRoot = options.projectRoot
    ? path.resolve(options.projectRoot)
    : findProjectRoot(startDir);

  if (!projectRoot) {
    throw new Error(
      'No Power Pages project found. Run this command from a site project directory ' +
      '(one containing powerpages.config.json for a code site, or .powerpages-site/ ' +
      'for a data-model site).'
    );
  }

  const solutionManifest = readJsonFile(path.join(projectRoot, '.solution-manifest.json'));
  const datamodelManifest = readJsonFile(path.join(projectRoot, '.datamodel-manifest.json'));

  // 1. Code/SPA site — powerpages.config.json is the source of truth.
  const configPath = path.join(projectRoot, 'powerpages.config.json');
  if (fs.existsSync(configPath)) {
    const config = readJsonFile(configPath);
    if (!config) {
      throw new Error(`Failed to parse powerpages.config.json at: ${configPath}`);
    }
    return {
      projectRoot,
      siteType: 'code',
      siteName: config.siteName || null,
      websiteRecordId: config.websiteRecordId || null,
      environmentUrl: config.environmentUrl || null,
      solutionManifest,
      datamodelManifest,
    };
  }

  // 2. Data-model (standard/enhanced) site — identity comes from
  //    .powerpages-site/website.yml (`id` -> websiteRecordId, `name` -> siteName).
  //    There is no environment URL in the local files; callers re-confirm via `pac env who`.
  const websiteYmlPath = path.join(projectRoot, '.powerpages-site', 'website.yml');
  if (fs.existsSync(websiteYmlPath)) {
    const site = readWebsiteYml(websiteYmlPath);
    if (!site) {
      throw new Error(`Could not read site id/name from: ${websiteYmlPath}`);
    }
    return {
      projectRoot,
      siteType: 'data-model',
      siteName: site.name || null,
      websiteRecordId: site.id || null,
      environmentUrl: null,
      solutionManifest,
      datamodelManifest,
    };
  }

  throw new Error(
    `No site identity found at ${projectRoot}: neither powerpages.config.json nor ` +
    '.powerpages-site/website.yml is present.'
  );
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

module.exports = { detectProjectContext, readWebsiteYml };
