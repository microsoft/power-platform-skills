#!/usr/bin/env node
'use strict';

const path = require('path');
const {
  findProjectRoot,
} = require('./lib/validation-helpers');
const {
  validateSiteIntegrity,
} = require('./lib/site-integrity');

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--projectRoot') args.projectRoot = argv[index + 1];
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const requestedRoot = path.resolve(args.projectRoot || process.cwd());
  const projectRoot = findProjectRoot(requestedRoot);
  if (!projectRoot) {
    process.stdout.write('[power-pages] Site integrity skipped: no Power Pages project found.\n');
    return 0;
  }

  const result = validateSiteIntegrity(projectRoot);
  if (result.skipped) {
    process.stdout.write(`[power-pages] Site integrity skipped: ${result.reason}\n`);
    return 0;
  }

  for (const finding of result.reviewFindings) {
    process.stdout.write(
      `[power-pages] Site integrity review ${finding.file}:${finding.line} ` +
      `[${finding.rule}]: ${finding.message}\n`
    );
  }
  if (result.errors.length > 0) {
    process.stderr.write(
      `[power-pages] Site integrity validation failed:\n- ${result.errors.join('\n- ')}\n`
    );
    return 2;
  }
  process.stdout.write('[power-pages] Site integrity validation passed.\n');
  return 0;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  main,
  parseArgs,
};
