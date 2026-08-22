#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const catalogue = require('./lib/design-direction-catalogue');

function read(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
}

function projectText(projectDir) {
  return [
    read(path.join(projectDir, 'brief.md')),
    read(path.join(projectDir, 'native-app-plan.md')),
    read(path.join(projectDir, '.tmp', 'seed-vocabulary.json')),
  ].filter(Boolean).join('\n');
}

function parseArgs(argv) {
  const projectIndex = argv.indexOf('--project');
  const directionIndex = argv.indexOf('--direction');
  if (projectIndex < 0 || !argv[projectIndex + 1]) throw new Error('usage: resolve-design-direction.js --project <dir> [--direction <slug>]');
  return {
    projectDir: path.resolve(argv[projectIndex + 1]),
    explicit: directionIndex >= 0 ? argv[directionIndex + 1] : null,
  };
}

function resolveProject(projectDir, explicit) {
  const selected = catalogue.route(projectText(projectDir), { explicit });
  return {
    direction: selected.slug,
    source: path.join(catalogue.DIRECTIONS_DIR, selected.source),
    reason: selected.reason,
  };
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    console.log(JSON.stringify(resolveProject(options.projectDir, options.explicit), null, 2));
  } catch (error) {
    console.error(`design-direction: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { parseArgs, projectText, resolveProject };
