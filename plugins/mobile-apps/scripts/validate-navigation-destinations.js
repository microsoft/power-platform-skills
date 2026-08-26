#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { validateNavigationContract } = require('./validate-navigation-contract');

function main(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--json') args.json = true;
  }
  if (!args.projectRoot) {
    process.stderr.write('Usage: node validate-navigation-destinations.js --project-root <dir> [--json]\n');
    return 2;
  }
  try {
    const root = path.resolve(args.projectRoot);
    const read = (relativePath) => JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
    const result = validateNavigationContract(read('.tmp/navigation-contract.json'), {
      experienceContract: read('.tmp/experience-contract.json'),
      workflowJourney: read('.tmp/workflow-journey-contract.json'),
      screenContract: read('.tmp/experience-screen-contract.json'),
    });
    const output = { validator: 'validate-navigation-destinations', ...result };
    if (args.json) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    else if (result.valid) process.stdout.write('Navigation destinations valid.\n');
    else result.errors.forEach((error) => process.stderr.write(`- ${error}\n`));
    return result.valid ? 0 : 2;
  } catch (error) {
    process.stderr.write(`validate-navigation-destinations: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main };