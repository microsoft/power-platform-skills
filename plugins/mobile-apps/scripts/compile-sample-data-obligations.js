#!/usr/bin/env node
'use strict';

// Compiles the approved Product Experience, Product Scope, Workflow Journey, and screen
// build packs into one deterministic sample-data obligation artifact. Dataverse metadata
// constrains how these obligations are materialized; it never invents product scenarios.

const fs = require('node:fs');
const path = require('node:path');

const { compileScreenBuildPack } = require('./compile-screen-build-pack');
const {
  CONTRACT_ARTIFACTS,
  canonicalJson,
  emitResult,
  fatal,
  finding,
  parseArgs,
  readJsonFile,
  resolveContractPath,
} = require('./lib/product-experience-contracts');
const { compileSampleDataObligations } = require('./lib/sample-data-obligations');
const { validateExperienceContract } = require('./validate-product-experience');
const { validateJourneyContract } = require('./validate-workflow-journey');
const { validateScopeContract } = require('./validate-product-scope');

const TOOL = 'compile-sample-data-obligations';
const DEFAULT_OUTPUT = '.tmp/sample-data-obligations.json';
const USAGE = 'Usage: node compile-sample-data-obligations.js [--project-root <dir>] [--experience <path>] [--scope <path>] [--journey <path>] [--build-pack <path>] [--scenario <path>] [--persistence <path>] [--navigation <path>] [--output <path>] [--check]';
const ARG_SPEC = {
  '--project-root': 'projectRoot',
  '--experience': 'experience',
  '--scope': 'scope',
  '--journey': 'journey',
  '--build-pack': 'buildPack',
  '--scenario': 'scenario',
  '--persistence': 'persistence',
  '--navigation': 'navigation',
  '--output': 'output',
};

function compileObligations({
  experience,
  scope,
  journey,
  buildPack,
  scenario,
  persistence = null,
  navigation = null,
}) {
  const validations = [
    validateExperienceContract(experience),
    validateScopeContract(scope, experience),
    validateJourneyContract(journey, { experience, scope }),
  ];
  const errors = validations.flatMap((result) => result.errors || []);
  const warnings = validations.flatMap((result) => result.warnings || []);
  const buildResult = compileScreenBuildPack(buildPack, { experience, scope, journey });
  errors.push(...buildResult.errors);
  warnings.push(...buildResult.warnings);
  if (errors.length) return { ok: false, errors, warnings, obligations: null };

  try {
    return {
      ok: true,
      errors,
      warnings,
      obligations: compileSampleDataObligations({
        experience,
        scope,
        journey,
        compiled: buildResult.compiled,
        scenario,
        persistence,
        navigation,
      }),
    };
  } catch (error) {
    return { ok: false, errors: [finding('invalid-compiled-binding', error.message)], warnings, obligations: null };
  }
}

function main(argv) {
  const args = parseArgs(argv, ARG_SPEC);
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const checkOnly = (args.unknown || []).includes('--check');
  const unknown = (args.unknown || []).filter((token) => token !== '--check');
  if (unknown.length) return fatal(TOOL, `unknown argument(s): ${unknown.join(', ')}. ${USAGE}`);

  const paths = {
    experience: resolveContractPath(args.projectRoot, args.experience, CONTRACT_ARTIFACTS['product-experience']),
    scope: resolveContractPath(args.projectRoot, args.scope, CONTRACT_ARTIFACTS['product-scope']),
    journey: resolveContractPath(args.projectRoot, args.journey, CONTRACT_ARTIFACTS['workflow-journey']),
    buildPack: resolveContractPath(args.projectRoot, args.buildPack, CONTRACT_ARTIFACTS['screen-build-pack']),
    scenario: resolveContractPath(args.projectRoot, args.scenario, '.tmp/scenario-facts.json'),
  };
  let contracts;
  try {
    contracts = Object.fromEntries(Object.entries(paths).map(([key, filePath]) => [key, readJsonFile(filePath)]));
    const projectRoot = args.projectRoot ? path.resolve(args.projectRoot) : process.cwd();
    const persistencePath = resolveContractPath(projectRoot, args.persistence, '.tmp/persistence-contract.json');
    const navigationPath = resolveContractPath(projectRoot, args.navigation, '.tmp/navigation-manifest.json');
    contracts.persistence = fs.existsSync(persistencePath) ? readJsonFile(persistencePath) : null;
    contracts.navigation = fs.existsSync(navigationPath) ? readJsonFile(navigationPath) : null;
  } catch (error) {
    return fatal(TOOL, error.message);
  }

  const result = { tool: TOOL, ...compileObligations(contracts), contractPaths: paths };
  const outputPath = resolveContractPath(args.projectRoot, args.output, DEFAULT_OUTPUT);
  if (result.ok && checkOnly && fs.existsSync(outputPath)) {
    try {
      if (canonicalJson(readJsonFile(outputPath)) !== canonicalJson(result.obligations)) {
        result.ok = false;
        result.errors.push(finding(
          'stale-sample-data-obligations',
          `sample-data obligations are stale: ${outputPath}. Run this command without --check.`,
        ));
      }
    } catch (error) {
      return fatal(TOOL, error.message);
    }
  }
  if (result.ok && !checkOnly) {
    try {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, `${JSON.stringify(result.obligations, null, 2)}\n`);
      result.outputPath = outputPath;
    } catch (error) {
      return fatal(TOOL, `cannot write ${outputPath}: ${error.message}`);
    }
  }
  return emitResult(result);
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { DEFAULT_OUTPUT, compileObligations };