'use strict';

const fs = require('node:fs');
const path = require('node:path');

function runWorkflowRegressionCli(argv, validatorName, validator) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--pack') args.pack = argv[++index];
    else if (argv[index] === '--screen') (args.screenIds ||= []).push(argv[++index]);
    else if (argv[index] === '--json') args.json = true;
  }
  if (!args.projectRoot) {
    process.stderr.write(`Usage: node ${validatorName}.js --project-root <dir> [--pack .tmp/screen-build-pack.json] [--screen <id>] [--json]\n`);
    return 2;
  }
  try {
    const root = path.resolve(args.projectRoot);
    const packPath = path.resolve(root, args.pack || '.tmp/screen-build-pack.json');
    const pack = JSON.parse(fs.readFileSync(packPath, 'utf8'));
    const issues = validator(pack, { projectRoot: root, screenIds: args.screenIds });
    const result = { validator: validatorName, valid: issues.length === 0, issues };
    if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else if (issues.length) issues.forEach((item) => process.stderr.write(`- [${item.rule}] ${item.message}\n`));
    else process.stdout.write(`${validatorName} passed.\n`);
    return result.valid ? 0 : 2;
  } catch (error) {
    process.stderr.write(`${validatorName}: ${error.message}\n`);
    return 2;
  }
}

module.exports = { runWorkflowRegressionCli };