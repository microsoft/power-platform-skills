#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { readNativeCatalog } = require('./lib/native-capability-catalog');

function main(argv) {
  let projectRoot = process.cwd();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== '--project-root' || !argv[index + 1]) {
      throw new Error('Usage: list-native-capabilities.js [--project-root <app>]');
    }
    const value = argv[++index];
    projectRoot = path.resolve(value);
  }
  return readNativeCatalog(projectRoot);
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main };
