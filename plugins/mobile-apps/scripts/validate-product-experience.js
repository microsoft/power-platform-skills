#!/usr/bin/env node
'use strict';

// Validates the product-experience (UX DNA) contract the planner authored and prints its
// stable revision, which every downstream contract must bind to.
//
// Usage:
//   node validate-product-experience.js --contract <path>
//   node validate-product-experience.js --project-root <dir>
//     (defaults to <project-root>/.tmp/product-experience-contract.json)
//
// Exit codes: 0 = valid, 1 = rejected, 2 = usage or fatal I/O error.
// Always prints one JSON document on stdout.

const {
  CONTRACT_ARTIFACTS,
  contractRevision,
  emitResult,
  experienceDirective,
  experienceSignature,
  fatal,
  parseArgs,
  readJsonFile,
  resolveContractPath,
  validateContractShape,
} = require('./lib/product-experience-contracts');
const { validateExperienceSemantics } = require('./lib/product-experience-rules');

const TOOL = 'validate-product-experience';
const USAGE = 'Usage: node validate-product-experience.js [--project-root <dir>] [--contract <path>]';

const ARG_SPEC = {
  '--project-root': 'projectRoot',
  '--contract': 'contract',
};

function validateExperienceContract(contract) {
  const errors = validateContractShape(contract, 'product-experience');
  const warnings = [];
  // Semantic rules read fields the schema may have just rejected, so only run them once the
  // shape holds; otherwise every message would be a duplicate of a schema error.
  if (errors.length === 0) {
    const semantic = validateExperienceSemantics(contract);
    errors.push(...semantic.errors);
    warnings.push(...semantic.warnings);
  }
  const ok = errors.length === 0;
  return {
    ok,
    tool: TOOL,
    contractType: 'product-experience',
    revision: ok ? contractRevision(contract) : null,
    // The signature covers semantic dimensions only. Two products in different domains that
    // describe the same experience share it; renaming the domain never changes it.
    experienceSignature: ok ? experienceSignature(contract) : null,
    experienceDirective: ok ? experienceDirective(contract) : null,
    errors,
    warnings,
  };
}

function main(argv) {
  const args = parseArgs(argv, ARG_SPEC);
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (args.unknown) return fatal(TOOL, `unknown argument(s): ${args.unknown.join(', ')}. ${USAGE}`);

  let contract;
  const contractPath = resolveContractPath(args.projectRoot, args.contract, CONTRACT_ARTIFACTS['product-experience']);
  try {
    contract = readJsonFile(contractPath);
  } catch (error) {
    return fatal(TOOL, error.message);
  }

  const result = validateExperienceContract(contract);
  result.contractPath = contractPath;
  return emitResult(result);
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { validateExperienceContract };
