#!/usr/bin/env node
'use strict';

const path = require('path');
const { auditBidirectionalReadiness } = require('./lib/bidirectional-readiness');

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--projectRoot') args.projectRoot = argv[index + 1];
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectRoot = path.resolve(args.projectRoot || process.cwd());
  const result = auditBidirectionalReadiness(projectRoot);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.summary.error > 0) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { parseArgs };
