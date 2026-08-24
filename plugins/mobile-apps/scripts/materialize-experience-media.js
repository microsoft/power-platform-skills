#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { materializeExperienceAssets } = require('./lib/experience-media');

function materializeExperienceMedia(projectRoot, manifestPath = 'assets/experience/manifest.json') {
  const root = path.resolve(projectRoot);
  const resolvedManifestPath = path.resolve(root, manifestPath);
  if (!resolvedManifestPath.startsWith(`${root}${path.sep}`)) throw new Error('media manifest must be inside the project');
  if (!fs.existsSync(resolvedManifestPath)) throw new Error(`media manifest is missing: ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(resolvedManifestPath, 'utf8'));
  const result = materializeExperienceAssets(root, manifest);
  fs.writeFileSync(resolvedManifestPath, `${JSON.stringify(result.manifest, null, 2)}\n`);
  return { manifestPath, files: result.files };
}

function main(argv) {
  const rootIndex = argv.indexOf('--project-root');
  const manifestIndex = argv.indexOf('--manifest');
  const projectRoot = rootIndex >= 0 ? argv[rootIndex + 1] : null;
  const manifestPath = manifestIndex >= 0 ? argv[manifestIndex + 1] : undefined;
  if (!projectRoot) {
    process.stderr.write('Usage: node materialize-experience-media.js --project-root <dir> [--manifest <path>]\n');
    return 2;
  }
  try {
    const result = materializeExperienceMedia(projectRoot, manifestPath);
    process.stdout.write(`Experience media materialized: ${result.files.length} bundled asset(s).\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`BLOCKED: experience media: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { materializeExperienceMedia };
