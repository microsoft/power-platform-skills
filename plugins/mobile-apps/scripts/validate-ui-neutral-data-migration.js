#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { validateUiNeutralDataMigration } = require('./lib/workflow-regression');

function main(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--before') args.before = argv[++index];
    else if (argv[index] === '--after') args.after = argv[++index];
    else if (argv[index] === '--json') args.json = true;
  }
  if (!args.projectRoot || !args.before || !args.after) {
    process.stderr.write('Usage: node validate-ui-neutral-data-migration.js --project-root <dir> --before <pack.json> --after <pack.json> [--json]\n');
    return 2;
  }
  try {
    const root = path.resolve(args.projectRoot);
    const readPack = (value) => JSON.parse(fs.readFileSync(path.resolve(root, value), 'utf8'));
    const result = validateUiNeutralDataMigration(readPack(args.before), readPack(args.after));
    const output = { validator: 'validate-ui-neutral-data-migration', valid: result.issues.length === 0, ...result };
    if (args.json) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    else if (result.issues.length) result.issues.forEach((item) => process.stderr.write(`- [${item.rule}] ${item.message}\n`));
    else process.stdout.write(`UI-neutral migration ${result.applicable ? 'passed' : 'not applicable'}.\n`);
    return output.valid ? 0 : 2;
  } catch (error) {
    process.stderr.write(`validate-ui-neutral-data-migration: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main, validateUiNeutralDataMigration };