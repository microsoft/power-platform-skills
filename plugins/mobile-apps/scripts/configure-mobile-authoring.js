#!/usr/bin/env node
'use strict';

const { configureMobileAuthoring } = require('./lib/authoring-runtime');

function main(argv = process.argv.slice(2)) {
  let projectRoot;
  let check = false;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--project-root' && argv[index + 1]) projectRoot = argv[++index];
    else if (argv[index] === '--check') check = true;
    else if (argv[index] === '--help' || argv[index] === '-h') {
      process.stdout.write('Usage: node configure-mobile-authoring.js --project-root <app> [--check]\n');
      return 0;
    } else throw new Error('Unknown or incomplete configure-mobile-authoring option');
  }
  if (!projectRoot) throw new Error('--project-root is required');
  const result = configureMobileAuthoring(projectRoot, { check });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

module.exports = { main, configureMobileAuthoring };
if (require.main === module) {
  try { process.exitCode = main(); }
  catch (error) {
    const message = error && typeof error.code === 'string'
      ? 'A required local authoring input could not be read or written safely.'
      : error.message;
    process.stderr.write(`Authoring configuration failed: ${message}\n`);
    process.exitCode = 1;
  }
}
