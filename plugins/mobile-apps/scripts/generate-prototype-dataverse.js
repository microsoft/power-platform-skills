#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { generateDataverseRepositories, stageConnectedStartup } = require('./lib/dataverse-repository-generator');

function main(argv = process.argv.slice(2)) {
  try {
    let root;
    let startup = false;
    for (let index = 0; index < argv.length; index += 1) {
      if (argv[index] === '--project-root') root = argv[++index];
      else if (argv[index] === '--stage-startup') startup = true;
      else throw new Error(`Unknown argument: ${argv[index]}`);
    }
    if (!root) throw new Error('--project-root is required');
    const result = generateDataverseRepositories(path.resolve(root));
    if (startup) stageConnectedStartup(path.resolve(root));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`generate-prototype-dataverse: ${error.message}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();
module.exports = { main };
