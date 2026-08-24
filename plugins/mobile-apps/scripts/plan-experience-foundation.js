#!/usr/bin/env node
'use strict';

/**
 * Materialize the small, contract-selected component ownership manifest before
 * screen builders fan out. The scaffold owner creates the TSX files later;
 * builders only consume the exact files named here.
 */

const fs = require('node:fs');
const path = require('node:path');
const { foundationContract, validateExperienceContract } = require('./experience-patterns');

function main(argv) {
  let projectRoot;
  let output;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') projectRoot = argv[++index];
    else if (argv[index] === '--output') output = argv[++index];
  }
  if (!projectRoot) {
    process.stderr.write('Usage: node plan-experience-foundation.js --project-root <dir> [--output <path>]\n');
    return 2;
  }
  const root = path.resolve(projectRoot);
  const contractPath = path.join(root, '.tmp', 'experience-contract.json');
  if (!fs.existsSync(contractPath)) {
    process.stderr.write(`BLOCKED: experience contract not found: ${contractPath}\n`);
    return 2;
  }
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  const issues = validateExperienceContract(contract);
  if (issues.length) {
    process.stderr.write(`BLOCKED: invalid experience contract: ${issues.join('; ')}\n`);
    return 2;
  }
  const destination = path.resolve(root, output || '.tmp/experience-foundation-contract.json');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, `${JSON.stringify(foundationContract(contract), null, 2)}\n`);
  process.stdout.write(`Experience foundation contract written: ${destination}\n`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main };