#!/usr/bin/env node
'use strict';

// Validates the workflow-journey contract: the ordered, user-visible steps that complete each
// core job, and the surfaces that host them. A step's surface may be a screen, a section, a
// sheet, a modal, a flow step, or a contextual action — coverage never forces a new route.
//
// Usage:
//   node validate-workflow-journey.js [--project-root <dir>] [--journey <path>]
//                                     [--scope <path>] [--experience <path>]
//     journey defaults to    <project-root>/.tmp/workflow-journey-contract.json
//     scope defaults to      <project-root>/.tmp/product-scope-contract.json
//     experience defaults to <project-root>/.tmp/product-experience-contract.json
//
// Exit codes: 0 = valid, 1 = rejected, 2 = usage or fatal I/O error.

const fs = require('node:fs');

const {
  CONTRACT_ARTIFACTS,
  contractRevision,
  emitResult,
  fatal,
  parseArgs,
  readJsonFile,
  resolveContractPath,
  validateContractShape,
} = require('./lib/product-experience-contracts');
const { validateJourneySemantics } = require('./lib/product-composition-rules');

const TOOL = 'validate-workflow-journey';
const USAGE = 'Usage: node validate-workflow-journey.js [--project-root <dir>] [--journey <path>] [--scope <path>] [--experience <path>]';

const ARG_SPEC = {
  '--project-root': 'projectRoot',
  '--journey': 'journey',
  '--scope': 'scope',
  '--experience': 'experience',
};

function validateJourneyContract(contract, { experience = null, scope = null } = {}) {
  const shapeErrors = validateContractShape(contract, 'workflow-journey');
  const errors = [...shapeErrors];
  const warnings = [];
  let summary = {};

  if (shapeErrors.length === 0) {
    const semantic = validateJourneySemantics(contract, { experience, scope });
    errors.push(...semantic.errors);
    warnings.push(...semantic.warnings);
    summary = semantic.summary;
  }

  const ok = errors.length === 0;
  return {
    ok,
    tool: TOOL,
    contractType: 'workflow-journey',
    revision: ok ? contractRevision(contract) : null,
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

  const journeyPath = resolveContractPath(args.projectRoot, args.journey, CONTRACT_ARTIFACTS['workflow-journey']);
  const scopePath = resolveContractPath(args.projectRoot, args.scope, CONTRACT_ARTIFACTS['product-scope']);
  const experiencePath = resolveContractPath(args.projectRoot, args.experience, CONTRACT_ARTIFACTS['product-experience']);

  let journey;
  let scope = null;
  let experience = null;
  try {
    journey = readJsonFile(journeyPath);
    if (fs.existsSync(scopePath)) scope = readJsonFile(scopePath);
    if (fs.existsSync(experiencePath)) experience = readJsonFile(experiencePath);
  } catch (error) {
    return fatal(TOOL, error.message);
  }

  const result = validateJourneyContract(journey, { experience, scope });
  result.contractPath = journeyPath;
  return emitResult(result);
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { validateJourneyContract };
