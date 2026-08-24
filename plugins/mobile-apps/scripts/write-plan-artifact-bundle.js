#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { validatePlanArtifactBundle } = require('./validate-plan-artifact-bundle');

const TARGETS = {
  nativeAppPlanMarkdown: 'native-app-plan.md',
  contextEnrichmentContract: '.tmp/context-enrichment-contract.json',
  prototypeDomainModel: '.tmp/prototype-domain-model.json',
  dataverseSchemaContract: '.tmp/dataverse-schema-contract.json',
  experienceScreenContract: '.tmp/experience-screen-contract.json',
  experienceFoundationContract: '.tmp/experience-foundation-contract.json',
  executionContract: '.tmp/mobile-plan-execution-contract.json',
};

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function assertNoSymlink(root, target) {
  const relative = path.relative(root, target);
  const parts = relative.split(path.sep).filter(Boolean);
  let cursor = root;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    if (!fs.existsSync(cursor)) continue;
    if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`symlink target is not allowed: ${cursor}`);
  }
}

function safeTarget(root, relativePath) {
  if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..')) {
    throw new Error(`invalid target path: ${relativePath}`);
  }
  const target = path.resolve(root, relativePath);
  if (!isInside(root, target)) throw new Error(`target escapes project root: ${relativePath}`);
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  assertNoSymlink(root, parent);
  if (fs.existsSync(target)) {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error(`target must not be a symlink: ${relativePath}`);
    if (!stat.isFile()) throw new Error(`target must be a regular file: ${relativePath}`);
  }
  return target;
}

function stageAtomic(target, content) {
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temp, content);
  return { target, temp, backup: null, written: false };
}

function contentFor(bundle, key) {
  const value = bundle.artifacts[key];
  if (key === 'nativeAppPlanMarkdown') return value;
  return `${JSON.stringify(value, null, 2)}\n`;
}

function activeTargets(bundle) {
  return Object.entries(TARGETS).filter(([key]) => bundle.artifacts[key] !== null);
}

function inactiveDataTargets(bundle) {
  return ['prototypeDomainModel', 'dataverseSchemaContract']
    .filter((key) => bundle.artifacts[key] === null)
    .map((key) => TARGETS[key]);
}

function backupPath(target) {
  return path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.backup`);
}

function cleanupStages(stages) {
  for (const stage of stages) {
    fs.rmSync(stage.temp, { force: true });
    if (stage.backup) fs.rmSync(stage.backup, { force: true });
  }
}

function restoreStages(stages) {
  for (const stage of [...stages].reverse()) {
    if (stage.written) fs.rmSync(stage.target, { force: true });
    if (stage.backup && fs.existsSync(stage.backup)) fs.renameSync(stage.backup, stage.target);
  }
}

function writePlanArtifactBundle(projectRoot, bundle) {
  const root = fs.realpathSync(path.resolve(projectRoot));
  const validation = validatePlanArtifactBundle(root, bundle);
  if (!validation.valid) throw new Error(`invalid plan artifact bundle: ${validation.errors.join('; ')}`);

  const stages = [];
  const removals = [];
  try {
    for (const [key, relativePath] of activeTargets(bundle)) {
      stages.push(stageAtomic(safeTarget(root, relativePath), contentFor(bundle, key)));
    }
    for (const relativePath of inactiveDataTargets(bundle)) {
      const target = path.resolve(root, relativePath);
      if (!fs.existsSync(target)) continue;
      assertNoSymlink(root, target);
      const backup = backupPath(target);
      fs.renameSync(target, backup);
      removals.push({ target, backup });
    }
    for (const stage of stages) {
      if (!fs.existsSync(stage.target)) continue;
      stage.backup = backupPath(stage.target);
      fs.renameSync(stage.target, stage.backup);
    }
    for (const stage of stages) {
      fs.renameSync(stage.temp, stage.target);
      stage.written = true;
    }
    cleanupStages(stages);
    for (const removal of removals) fs.rmSync(removal.backup, { force: true });
  } catch (error) {
    restoreStages(stages);
    for (const removal of [...removals].reverse()) {
      if (fs.existsSync(removal.backup)) fs.renameSync(removal.backup, removal.target);
    }
    cleanupStages(stages);
    throw error;
  }
  return {
    written: stages.map((stage) => path.relative(root, stage.target).replace(/\\/g, '/')),
    removed: removals.map((removal) => path.relative(root, removal.target).replace(/\\/g, '/')),
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--bundle') args.bundle = argv[++index];
    else if (argv[index] === '--json') args.json = true;
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  if (!args.projectRoot || !args.bundle) {
    process.stderr.write('Usage: node write-plan-artifact-bundle.js --project-root <dir> --bundle <bundle.json> [--json]\n');
    return 2;
  }
  try {
    const result = writePlanArtifactBundle(args.projectRoot, readJson(path.resolve(args.bundle)));
    process.stdout.write(`${JSON.stringify({ status: 'ok', ...result }, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`write-plan-artifact-bundle: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { writePlanArtifactBundle };