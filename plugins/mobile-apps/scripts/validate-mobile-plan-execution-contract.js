#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { contractHash } = require('./experience-patterns');
const { validateMobilePlanExecutionContract } = require('./lib/mobile-plan-execution-contract');

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

function firstExisting(paths) {
  return paths.find((candidate) => fs.existsSync(candidate)) || null;
}

function validateProjectExecutionContract(projectRoot, contractPath = '.tmp/mobile-plan-execution-contract.json') {
  const root = path.resolve(projectRoot);
  const briefPath = firstExisting([
    path.join(root, '.tmp', 'experience-brief.md'),
    path.join(root, 'brief.md'),
  ]);
  if (!briefPath) return { valid: false, errors: ['confirmed brief is missing'] };
  const experiencePath = path.join(root, '.tmp', 'experience-contract.json');
  const screenPath = path.join(root, '.tmp', 'experience-screen-contract.json');
  const schemaPath = path.join(root, '.tmp', 'dataverse-schema-contract.json');
  const packagePath = path.join(root, 'package.json');
  const preflightPath = path.join(root, '.tmp', 'mobile-plan-execution-preflight.json');
  const resolvedContractPath = path.resolve(root, contractPath);
  for (const [filePath, label] of [
    [resolvedContractPath, 'mobile plan execution contract'],
    [experiencePath, 'Experience Contract'],
    [screenPath, 'Experience Screen Contract'],
    [schemaPath, 'data contract'],
    [packagePath, 'package.json'],
    [preflightPath, 'mobile plan execution preflight'],
  ]) {
    if (!fs.existsSync(filePath)) return { valid: false, errors: [`${label} is missing`] };
  }
  const experienceContract = readJson(experiencePath, 'Experience Contract');
  const screenContract = readJson(screenPath, 'Experience Screen Contract');
  if (screenContract.schemaVersion !== 3) {
    return { valid: false, errors: ['Experience Screen Contract must use schemaVersion 3; re-plan legacy v1/v2 screens'] };
  }
  return validateMobilePlanExecutionContract(readJson(resolvedContractPath, 'Mobile plan execution contract'), {
    briefText: fs.readFileSync(briefPath, 'utf8'),
    experienceContractSha256: contractHash(experienceContract),
    screenContract,
    dataContract: readJson(schemaPath, 'Data contract'),
    packageJson: readJson(packagePath, 'package.json'),
    preflight: readJson(preflightPath, 'Mobile plan execution preflight'),
  });
}

function main(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--contract') args.contract = argv[++index];
    else if (argv[index] === '--json') args.json = true;
  }
  if (!args.projectRoot) {
    process.stderr.write('Usage: node validate-mobile-plan-execution-contract.js --project-root <dir> [--contract <path>] [--json]\n');
    return 2;
  }
  try {
    const result = validateProjectExecutionContract(args.projectRoot, args.contract);
    if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.valid) {
      if (!args.json) result.errors.forEach((error) => process.stderr.write(`- ${error}\n`));
      return 2;
    }
    if (!args.json) process.stdout.write('Mobile plan execution contract valid.\n');
    return 0;
  } catch (error) {
    process.stderr.write(`validate-mobile-plan-execution-contract: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { validateProjectExecutionContract };