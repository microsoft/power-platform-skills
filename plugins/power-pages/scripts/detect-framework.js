#!/usr/bin/env node
'use strict';

const path = require('path');
const { detectFramework } = require('./lib/framework-detection');

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--projectRoot') {
      args.projectRoot = argv[index + 1];
      index += 1;
    }
  }
  return args;
}

function runCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.projectRoot) {
    throw new Error('Usage: detect-framework.js --projectRoot <path>');
  }
  const result = detectFramework(path.resolve(args.projectRoot));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (require.main === module) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  parseArgs,
  runCli,
};
