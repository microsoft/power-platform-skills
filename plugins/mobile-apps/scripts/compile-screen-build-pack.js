#!/usr/bin/env node
'use strict';

// Validates the screen build packs against the approved experience, scope, and journey, then
// compiles them into the deterministic artifact screen builders and the HTML experience
// preview consume.
//
// Compilation is pure: same inputs produce byte-identical output. There are no timestamps and
// no environment lookups, so the compiled revision is a usable cache key.
//
// Usage:
//   node compile-screen-build-pack.js [--project-root <dir>] [--build-pack <path>]
//                                     [--journey <path>] [--scope <path>] [--experience <path>]
//                                     [--output <path>] [--check]
//     build-pack defaults to <project-root>/.tmp/screen-build-pack.json
//     output defaults to     <project-root>/.tmp/compiled-screen-build-pack.json
//     --check validates and reports without writing the compiled artifact.
//
// All four upstream contracts are required: a build pack cannot be judged complete without the
// scope that says which screens must exist and the journey that says what they must accomplish.
//
// Exit codes: 0 = compiled (or valid under --check), 1 = rejected, 2 = usage or fatal I/O error.

const fs = require('node:fs');
const path = require('node:path');

const {
  CONTRACT_ARTIFACTS,
  canonicalJson,
  contractRevision,
  emitResult,
  fatal,
  finding,
  parseArgs,
  readJsonFile,
  resolveContractPath,
  validateContractShape,
} = require('./lib/product-experience-contracts');
const { compileBuildPacks, validateBuildPackSemantics } = require('./lib/product-composition-rules');

const TOOL = 'compile-screen-build-pack';
const USAGE = 'Usage: node compile-screen-build-pack.js [--project-root <dir>] [--build-pack <path>] [--journey <path>] [--scope <path>] [--experience <path>] [--output <path>] [--check]';

const ARG_SPEC = {
  '--project-root': 'projectRoot',
  '--build-pack': 'buildPack',
  '--journey': 'journey',
  '--scope': 'scope',
  '--experience': 'experience',
  '--output': 'output',
};

function compileScreenBuildPack(buildPack, { experience, scope, journey }) {
  const shapeErrors = validateContractShape(buildPack, 'screen-build-pack');
  const errors = [...shapeErrors];
  const warnings = [];
  let summary = {};

  if (shapeErrors.length === 0) {
    const semantic = validateBuildPackSemantics(buildPack, { experience, scope, journey });
    errors.push(...semantic.errors);
    warnings.push(...semantic.warnings);
    summary = semantic.summary;
  }

  const ok = errors.length === 0;
  return {
    ok,
    tool: TOOL,
    contractType: 'screen-build-pack',
    revision: ok ? contractRevision(buildPack) : null,
    summary,
    errors,
    warnings,
    compiled: ok ? compileBuildPacks(buildPack, { experience, scope, journey }) : null,
  };
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

  const buildPackPath = resolveContractPath(args.projectRoot, args.buildPack, CONTRACT_ARTIFACTS['screen-build-pack']);
  const journeyPath = resolveContractPath(args.projectRoot, args.journey, CONTRACT_ARTIFACTS['workflow-journey']);
  const scopePath = resolveContractPath(args.projectRoot, args.scope, CONTRACT_ARTIFACTS['product-scope']);
  const experiencePath = resolveContractPath(args.projectRoot, args.experience, CONTRACT_ARTIFACTS['product-experience']);

  let buildPack;
  let journey;
  let scope;
  let experience;
  try {
    for (const [label, filePath] of [
      ['screen build pack', buildPackPath],
      ['workflow journey contract', journeyPath],
      ['product scope contract', scopePath],
      ['product experience contract', experiencePath],
    ]) {
      if (!fs.existsSync(filePath)) return fatal(TOOL, `missing ${label}: ${filePath}`);
    }
    buildPack = readJsonFile(buildPackPath);
    journey = readJsonFile(journeyPath);
    scope = readJsonFile(scopePath);
    experience = readJsonFile(experiencePath);
  } catch (error) {
    return fatal(TOOL, error.message);
  }

  const result = compileScreenBuildPack(buildPack, { experience, scope, journey });
  result.contractPath = buildPackPath;

  const outputPath = resolveContractPath(args.projectRoot, args.output, CONTRACT_ARTIFACTS['compiled-screen-build-pack']);
  if (result.ok && checkOnly && fs.existsSync(outputPath)) {
    try {
      const persisted = readJsonFile(outputPath);
      if (canonicalJson(persisted) !== canonicalJson(result.compiled)) {
        result.ok = false;
        result.errors.push(finding(
          'stale-compiled-artifact',
          `compiled screen build pack is stale: ${outputPath}. Run compile-screen-build-pack.js without --check.`,
        ));
      }
    } catch (error) {
      return fatal(TOOL, error.message);
    }
  }

  if (result.ok && !checkOnly) {
    try {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, `${JSON.stringify(result.compiled, null, 2)}\n`);
    } catch (error) {
      return fatal(TOOL, `cannot write ${outputPath}: ${error.message}`);
    }
    result.outputPath = outputPath;
  }

  return emitResult(result);
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { compileScreenBuildPack };
