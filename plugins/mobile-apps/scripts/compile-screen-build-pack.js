#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { compilePhoneScreens } = require('./lib/phone-app-plan');

// Keep the bridge's fixed readiness command; this branch derives its screen
// projection from the main-based phone plan, not the older planning pipeline.
function main(argv = process.argv.slice(2)) {
  try {
    let root, check = false;
    for (let index = 0; index < argv.length; index += 1) {
      if (argv[index] === '--project-root') root = argv[++index];
      else if (argv[index] === '--check') check = true;
      else throw new Error(`Unknown argument: ${argv[index]}`);
    }
    if (!root) throw new Error('--project-root is required');
    console.log(JSON.stringify(compilePhoneScreens(path.resolve(root), { check })));
    return 0;
  } catch (error) {
    console.error(`compile-screen-build-pack: ${error.message}`);
    return 1;
  }
}
if (require.main === module) process.exitCode = main();
module.exports = { main };
