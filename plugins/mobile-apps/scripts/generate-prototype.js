#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { generatePrototype } = require('./lib/prototype-generator');

function main(argv = process.argv.slice(2)) {
  try {
    let root;
    let check = false;
    let validateOnly = false;
    for (let index = 0; index < argv.length; index += 1) {
      if (argv[index] === '--project-root') root = argv[++index];
      else if (argv[index] === '--check') check = true;
      else if (argv[index] === '--validate-contracts') validateOnly = true;
      else throw new Error(`Unknown argument: ${argv[index]}`);
    }
    if (!root) throw new Error('--project-root is required');
    process.stdout.write(`${JSON.stringify(generatePrototype(path.resolve(root), { check, validateOnly }))}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`generate-prototype: ${error.message}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();
module.exports = { main };
