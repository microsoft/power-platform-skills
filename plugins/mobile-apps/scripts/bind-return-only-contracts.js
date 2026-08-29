#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  contractRevision,
  validateContractShape,
} = require('./lib/product-experience-contracts');

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--project-root') args.projectRoot = argv[++index];
    else if (token === '--experience') args.experience = argv[++index];
    else if (token === '--scope') args.scope = argv[++index];
    else if (token === '--scope-input') args.scopeInput = argv[++index];
    else if (token === '--journey') args.journey = argv[++index];
    else if (token === '--journey-input') args.journeyInput = argv[++index];
    else if (token === '--build-pack') args.buildPack = argv[++index];
    else throw new Error(`unknown argument: ${token}`);
  }
  return args;
}

function projectFile(projectRoot, file, label) {
  if (!file) throw new Error(`${label} is required`);
  const root = path.resolve(projectRoot);
  const resolved = path.resolve(root, file);
  const relative = path.relative(root, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside project root`);
  }
  if (fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link`);
  }
  return resolved;
}

function readJson(file, fileSystem = fs) {
  return JSON.parse(fileSystem.readFileSync(file, 'utf8'));
}

function atomicWriteJson(file, value, fileSystem = fs) {
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fileSystem.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fileSystem.renameSync(temporary, file);
  } finally {
    if (fileSystem.existsSync(temporary)) fileSystem.rmSync(temporary, { force: true });
  }
}

function assertShape(contract, contractType) {
  const errors = validateContractShape(contract, contractType).filter(
    (finding) => !/\/(?:experienceRevision|scopeRevision|journeyRevision):/.test(finding.message),
  );
  if (errors.length > 0) {
    throw new Error(
      `${contractType} semantic shape is invalid before binding: ${errors.map(
        (finding) => finding.message,
      ).join('; ')}`,
    );
  }
}

function bindContracts({ experience, scope = null, journey = null, buildPack = null }) {
  assertShape(experience, 'product-experience');
  const result = { experience };
  if (scope) {
    const boundScope = {
      ...scope,
      experienceRevision: contractRevision(experience),
    };
    assertShape(boundScope, 'product-scope');
    result.scope = boundScope;
  }
  if (journey) {
    if (!result.scope) throw new Error('journey binding requires Product Scope');
    const boundJourney = {
      ...journey,
      experienceRevision: contractRevision(experience),
      scopeRevision: contractRevision(result.scope),
    };
    assertShape(boundJourney, 'workflow-journey');
    result.journey = boundJourney;
  }
  if (buildPack) {
    if (!result.scope || !result.journey) {
      throw new Error('screen build-pack binding requires Product Scope and Workflow Journey');
    }
    const boundBuildPack = {
      ...buildPack,
      experienceRevision: contractRevision(experience),
      scopeRevision: contractRevision(result.scope),
      journeyRevision: contractRevision(result.journey),
    };
    assertShape(boundBuildPack, 'screen-build-pack');
    result.buildPack = boundBuildPack;
  }
  return result;
}

function run(args, fileSystem = fs) {
  if (!args.projectRoot) throw new Error('--project-root is required');
  if (args.scope && args.scopeInput) throw new Error('use --scope or --scope-input, not both');
  if (args.journey && args.journeyInput) {
    throw new Error('use --journey or --journey-input, not both');
  }
  if (!args.scope && !args.journey && !args.buildPack) {
    throw new Error('provide a staged --scope, --journey, or --build-pack');
  }
  const experiencePath = projectFile(args.projectRoot, args.experience, '--experience');
  const scopePath = args.scope ? projectFile(args.projectRoot, args.scope, '--scope') : null;
  const scopeInputPath = args.scopeInput
    ? projectFile(args.projectRoot, args.scopeInput, '--scope-input')
    : null;
  const journeyPath = args.journey ? projectFile(args.projectRoot, args.journey, '--journey') : null;
  const journeyInputPath = args.journeyInput
    ? projectFile(args.projectRoot, args.journeyInput, '--journey-input')
    : null;
  const buildPackPath = args.buildPack
    ? projectFile(args.projectRoot, args.buildPack, '--build-pack')
    : null;
  const result = bindContracts({
    experience: readJson(experiencePath, fileSystem),
    scope: scopePath || scopeInputPath
      ? readJson(scopePath || scopeInputPath, fileSystem)
      : null,
    journey: journeyPath || journeyInputPath
      ? readJson(journeyPath || journeyInputPath, fileSystem)
      : null,
    buildPack: buildPackPath ? readJson(buildPackPath, fileSystem) : null,
  });
  if (scopePath) atomicWriteJson(scopePath, result.scope, fileSystem);
  if (journeyPath) atomicWriteJson(journeyPath, result.journey, fileSystem);
  if (buildPackPath) atomicWriteJson(buildPackPath, result.buildPack, fileSystem);
  return {
    status: 'DONE',
    experienceRevision: contractRevision(result.experience),
    scopeRevision: result.scope ? contractRevision(result.scope) : null,
    journeyRevision: result.journey ? contractRevision(result.journey) : null,
    buildPackRevision: result.buildPack ? contractRevision(result.buildPack) : null,
  };
}

function main(argv = process.argv) {
  try {
    const result = run(parseArgs(argv));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`bind-return-only-contracts: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { bindContracts, main, run };