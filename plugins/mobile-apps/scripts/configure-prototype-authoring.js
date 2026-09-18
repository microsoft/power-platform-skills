#!/usr/bin/env node
'use strict';

const { configurePrototypeAuthoring } = require('./lib/prototype-authoring');

function main(argv = process.argv.slice(2)) {
  try {
    let root;
    const options = { readyScreenIds: [] };
    for (let index = 0; index < argv.length; index += 1) {
      if (argv[index] === '--project-root') root = argv[++index];
      else if (argv[index] === '--ready-screen') options.readyScreenIds.push(argv[++index]);
      else if (argv[index] === '--wire-screen') {
        options.wireScreenIds ??= [];
        options.wireScreenIds.push(argv[++index]);
      }
      else if (argv[index] === '--screen-source') {
        const value = argv[++index];
        const separator = typeof value === 'string' ? value.indexOf('=') : -1;
        if (separator < 1 || separator === value.length - 1) throw new Error('--screen-source requires screenId=app/path.tsx');
        options.screenSources ??= [];
        options.screenSources.push({ screenId: value.slice(0, separator), sourceFile: value.slice(separator + 1) });
      }
      else if (argv[index] === '--check') options.check = true;
      else throw new Error(`Unknown argument: ${argv[index]}`);
    }
    if (!root) throw new Error('--project-root is required');
    process.stdout.write(`${JSON.stringify(configurePrototypeAuthoring(root, options))}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`configure-prototype-authoring: ${error.message}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();
module.exports = { main };
