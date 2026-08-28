#!/usr/bin/env node
'use strict';

// Validates the product-scope contract: which jobs ship, which surfaces exist, how many new
// tables are proposed, and whether all of that follows from user jobs rather than from the
// number of nouns in the brief.
//
// Usage:
//   node validate-product-scope.js [--project-root <dir>] [--scope <path>] [--experience <path>]
//     scope defaults to      <project-root>/.tmp/product-scope-contract.json
//     experience defaults to <project-root>/.tmp/product-experience-contract.json
//
// When the experience contract is present its revision is recomputed and compared against
// scope.experienceRevision, so scope cannot silently outlive the UX DNA it was derived from.
//
// Exit codes: 0 = valid, 1 = rejected, 2 = usage or fatal I/O error.

const fs = require('node:fs');

const {
  CONTRACT_ARTIFACTS,
  contractRevision,
  emitResult,
  fatal,
  finding,
  parseArgs,
  readJsonFile,
  resolveContractPath,
  validateContractShape,
} = require('./lib/product-experience-contracts');
const { validateScopeSemantics } = require('./lib/product-scope-rules');

const TOOL = 'validate-product-scope';
const USAGE = 'Usage: node validate-product-scope.js [--project-root <dir>] [--scope <path>] [--experience <path>]';

const ARG_SPEC = {
  '--project-root': 'projectRoot',
  '--scope': 'scope',
  '--experience': 'experience',
};

function validateScopeContract(contract, experienceContract) {
  const shapeErrors = validateContractShape(contract, 'product-scope');
  const errors = [...shapeErrors];
  const warnings = [];
  let summary = {};

  if (experienceContract) {
    const expected = contractRevision(experienceContract);
    if (contract.experienceRevision !== expected) {
      errors.push(finding(
        'stale-contract-binding',
        `experienceRevision ${contract.experienceRevision || '(missing)'} does not match the supplied product-experience revision ${expected}`,
      ));
    }
  }

  // Semantic rules read fields the schema may have just rejected, so only run them once the
  // shape holds; otherwise every message would be a duplicate of a schema error.
  if (shapeErrors.length === 0) {
    const semantic = validateScopeSemantics(contract);
    errors.push(...semantic.errors);
    warnings.push(...semantic.warnings);
    summary = semantic.summary;
  }

  const ok = errors.length === 0;
  return {
    ok,
    tool: TOOL,
    contractType: 'product-scope',
    revision: ok ? contractRevision(contract) : null,
    productComplexity: contract.productComplexity,
    summary,
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

  const scopePath = resolveContractPath(args.projectRoot, args.scope, CONTRACT_ARTIFACTS['product-scope']);
  const experiencePath = resolveContractPath(args.projectRoot, args.experience, CONTRACT_ARTIFACTS['product-experience']);

  let scope;
  let experience = null;
  try {
    scope = readJsonFile(scopePath);
    // The experience contract is optional so scope can be checked in isolation, but when the
    // file exists the binding is always verified rather than trusted.
    if (fs.existsSync(experiencePath)) experience = readJsonFile(experiencePath);
  } catch (error) {
    return fatal(TOOL, error.message);
  }

  const result = validateScopeContract(scope, experience);
  result.contractPath = scopePath;
  result.experiencePath = experience ? experiencePath : null;
  return emitResult(result);
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { validateScopeContract };
