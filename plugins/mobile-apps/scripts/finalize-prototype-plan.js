#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { compilePrototypePlanDraft } = require('./compile-prototype-plan-bundle');
const { safeExistingProjectFile, safeProjectOutput } = require('./lib/project-path');
const { semanticPlanRevision } = require('./lib/prototype-semantic-plan');
const { renderNativePrototypePlan } = require('./render-native-prototype-plan');
const { resolveNavigationContract } = require('./resolve-navigation-contract');
const { validatePlanArtifactBundle } = require('./validate-plan-artifact-bundle');
const { validatePrototypeSemanticPreservation } = require('./validate-prototype-semantic-preservation');
const { writePlanArtifactBundle } = require('./write-plan-artifact-bundle');

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  fs.renameSync(temporaryPath, filePath);
}

function finalizePrototypePlan(projectRoot, semanticPlan) {
  const root = fs.realpathSync(path.resolve(projectRoot));
  const transport = readJson(safeExistingProjectFile(root, '.tmp/planner-transport.json', 'planner transport evidence'), 'planner transport evidence');
  if (transport.semanticPlanSha256 !== semanticPlanRevision(semanticPlan)) throw new Error('staged semantic plan does not match planner transport evidence');
  const experience = readJson(safeExistingProjectFile(root, '.tmp/experience-contract.json', 'Experience Contract'), 'Experience Contract');
  const briefPath = fs.existsSync(path.join(root, '.tmp', 'experience-brief.md')) ? '.tmp/experience-brief.md' : 'brief.md';
  const briefText = fs.readFileSync(safeExistingProjectFile(root, briefPath, 'confirmed brief'), 'utf8');

  // Mandatory PR1 order begins after semantic response staging/validation.
  const compiled = compilePrototypePlanDraft(root, semanticPlan);
  const draftPath = safeProjectOutput(root, '.tmp/plan-artifact-bundle.json', 'prototype plan draft');
  writeJsonAtomic(draftPath, compiled.bundle);

  const navigation = resolveNavigationContract(
    briefText,
    experience,
    compiled.bundle.artifacts.workflowJourneyContract,
    compiled.bundle.artifacts.experienceScreenContract,
    { navigationIntent: semanticPlan.navigationIntent, productStructure: semanticPlan.screens.productStructure },
  );
  compiled.bundle.artifacts.navigationContract = navigation.contract;
  compiled.bundle.artifacts.experienceScreenContract = navigation.screenContract;
  writeJsonAtomic(draftPath, compiled.bundle);

  const rendered = renderNativePrototypePlan(semanticPlan, compiled.bundle, experience);
  compiled.bundle.artifacts.nativeAppPlanMarkdown = rendered.markdown;
  compiled.bundle.sections = rendered.sections;
  writeJsonAtomic(draftPath, compiled.bundle);

  const preservation = validatePrototypeSemanticPreservation(semanticPlan, compiled.bundle, experience);
  if (!preservation.valid) {
    throw new Error(`semantic preservation failed: ${preservation.errors.map((error) => `${error.sourcePath} -> ${error.targetPath}: ${error.message}`).join('; ')}`);
  }

  const validation = validatePlanArtifactBundle(root, compiled.bundle);
  if (!validation.valid) throw new Error(`complete plan bundle is invalid: ${validation.errors.join('; ')}`);
  writeJsonAtomic(draftPath, compiled.bundle);
  const writeResult = writePlanArtifactBundle(root, compiled.bundle, {
    prototypeSemanticPlan: semanticPlan,
    prototypeSemanticMap: compiled.preservationMap,
    prototypeSemanticPreservation: preservation,
  });
  return { bundle: compiled.bundle, preservation, writeResult };
}

function main(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--semantic-plan') args.semanticPlan = argv[++index];
  }
  if (!args.projectRoot) {
    process.stderr.write('Usage: node finalize-prototype-plan.js --project-root <dir> [--semantic-plan .tmp/prototype-semantic-plan.json]\n');
    return 2;
  }
  try {
    const root = fs.realpathSync(path.resolve(args.projectRoot));
    const semanticPlan = readJson(safeExistingProjectFile(root, args.semanticPlan || '.tmp/prototype-semantic-plan.staged.json', 'staged prototype semantic plan'), 'prototype semantic plan');
    const result = finalizePrototypePlan(root, semanticPlan);
    process.stdout.write(`${JSON.stringify({ status: 'written', navigationModel: result.bundle.artifacts.navigationContract.model, ...result.writeResult })}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`finalize-prototype-plan: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { finalizePrototypePlan };
