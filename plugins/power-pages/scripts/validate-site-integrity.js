#!/usr/bin/env node
'use strict';

const path = require('path');
const {
  findProjectRoot,
} = require('./lib/validation-helpers');
const {
  parseOptionalProjectRootArgs,
} = require('./lib/cli-arguments');
const {
  validateSiteIntegrity,
} = require('./lib/site-integrity');

const USAGE =
  'Usage: validate-site-integrity.js [--projectRoot <path>]';

const parseArgs = (argv) => parseOptionalProjectRootArgs(argv, USAGE);

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
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}

module.exports = {
  main,
  parseArgs,
};
