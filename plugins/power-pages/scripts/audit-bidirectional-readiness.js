#!/usr/bin/env node
'use strict';

const path = require('path');
const { auditBidirectionalReadiness } = require('./lib/bidirectional-readiness');
const {
  parseOptionalProjectRootArgs,
} = require('./lib/cli-arguments');

const USAGE =
  'Usage: audit-bidirectional-readiness.js [--projectRoot <path>]';

const parseArgs = (argv) => parseOptionalProjectRootArgs(argv, USAGE);

function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectRoot = path.resolve(args.projectRoot || process.cwd());
  const result = auditBidirectionalReadiness(projectRoot);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.summary.error > 0) process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}

module.exports = { parseArgs };
