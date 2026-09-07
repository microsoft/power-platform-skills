#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { inside, readJson } = require('./lib/prototype-files');
const { environmentId, validateConnectorSelection } = require('./lib/prototype-connections');
const { verifyNativeProject } = require('./verify-prototype-native');

function verifyConnectionProject(root, catalog, selection) {
  const selected = validateConnectorSelection(catalog, selection);
  if (fs.existsSync(inside(root, 'power.config.json'))) {
    const config = readJson(root, 'power.config.json');
    if (environmentId(config.environmentId) !== selected.environmentId) throw new Error('Selected connection environment differs from the initialized app');
    return { ok: true, initialized: true, selection: selected, mutated: false };
  }
  verifyNativeProject(root, { prototype: true });
  return { ok: true, initialized: false, requiresSeparateInitializationApproval: true, selection: selected, mutated: false };
}

function main(argv = process.argv.slice(2)) {
  try {
    const args = {};
    for (let index = 0; index < argv.length; index += 1) {
      const flag = argv[index];
      if (!['--project-root', '--catalog', '--selection'].includes(flag) || !argv[index + 1]) throw new Error(`Unknown or incomplete argument: ${flag}`);
      if (Object.hasOwn(args, flag.slice(2))) throw new Error(`Duplicate argument: ${flag}`);
      args[flag.slice(2)] = argv[++index];
    }
    if (!args['project-root'] || !args.catalog || !args.selection) throw new Error('--project-root, --catalog and --selection are required');
    const root = path.resolve(args['project-root']);
    console.log(JSON.stringify(verifyConnectionProject(root, readJson(root, args.catalog), readJson(root, args.selection)), null, 2));
    return 0;
  } catch (error) {
    console.error(`verify-prototype-connection: ${error.message}`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();
module.exports = { verifyConnectionProject, main };
