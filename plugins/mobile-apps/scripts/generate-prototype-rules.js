#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { generatePrototypeRules } = require('./lib/prototype-rules');

function main(argv = process.argv.slice(2)) {
  try {
    let root;
    let check = false;
    for (let index = 0; index < argv.length; index += 1) {
      if (argv[index] === '--project-root') root = argv[++index];
      else if (argv[index] === '--check') check = true;
      else throw new Error(`Unknown argument: ${argv[index]}`);
    }
    if (!root) throw new Error('--project-root is required');
    console.log(JSON.stringify(generatePrototypeRules(path.resolve(root), { check }), null, 2));
    return 0;
  } catch (error) {
    console.error(`generate-prototype-rules: ${error.message}`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();
module.exports = { main };
