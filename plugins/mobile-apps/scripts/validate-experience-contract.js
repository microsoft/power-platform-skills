#!/usr/bin/env node
'use strict';

/**
 * Validates the shared product-experience contract against the human plan,
 * structured primary-screen composition, and optionally built React Native TSX.
 *
 * Usage:
 *   node validate-experience-contract.js --project-root <dir> [--phase plan|build] [--json]
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  contractHash,
  foundationContract,
  primaryComposition,
  slug,
  validateExperienceContract,
} = require('./experience-patterns');
const { validateScreenBuildPack } = require('./validate-screen-build-pack');

function normalize(value) {
  return String(value || '').trim();
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseArgs(argv) {
  const args = { phase: 'build' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project-root') args.projectRoot = argv[++index];
    else if (arg === '--phase') args.phase = argv[++index];
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
  }
  return args;
}

function readJson(filePath, label, issues) {
  if (!fs.existsSync(filePath)) {
    issues.push({ rule: 'missing-artifact', message: `${label} is missing.`, file: filePath });
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    issues.push({ rule: 'invalid-json', message: `${label} is invalid JSON: ${error.message}`, file: filePath });
    return null;
  }
}

function section(markdown, heading) {
  const lines = String(markdown || '').split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (start < 0) return '';
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end).join('\n');
}

function hasContractSummary(designSection, contract) {
  return /###\s+Product Experience Contract/i.test(designSection)
    && designSection.includes(contract.primaryJob)
    && new RegExp(`(?:Entry mode|entryMode)\s*[:—-].*${contract.entryMode}`, 'i').test(designSection)
    && designSection.includes(contract.firstViewport.primaryAction)
    && designSection.includes(contract.primarySurface)
    && designSection.includes(contract.assetPolicy.connectivity)
    && designSection.includes(contract.assetPolicy.media)
    && /Prompt evidence/i.test(designSection);
}

function validateScreenContract(contract, screenContract, issues) {
  if (!screenContract) return;
  const expected = primaryComposition(contract);
  if (screenContract.schemaVersion !== 1) {
    issues.push({ rule: 'invalid-screen-contract-schema', message: 'Experience screen contract schemaVersion must be 1.' });
    return;
  }
  if (screenContract.experienceContractSha256 !== contractHash(contract)) {
    issues.push({ rule: 'experience-contract-hash-drift', message: 'Screen contract is bound to a stale experience contract.' });
  }
  const primary = screenContract.primaryScreen;
  if (!primary) {
    issues.push({ rule: 'missing-primary-screen-composition', message: 'Experience screen contract lacks primaryScreen composition.' });
    return;
  }
  const keyFlow = screenContract.keyFlow;
  if (!keyFlow || typeof keyFlow.route !== 'string' || !keyFlow.route.startsWith('/') || keyFlow.route === contract.primaryScreen.route || typeof keyFlow.file !== 'string' || !/^app\/.+\.tsx$/i.test(keyFlow.file) || typeof keyFlow.outcome !== 'string' || keyFlow.outcome.trim().length < 5) {
    issues.push({ rule: 'missing-key-flow-contract', message: 'Experience screen contract requires a non-primary keyFlow route, file, and outcome.' });
  }
  const fields = [
    ['route', contract.primaryScreen.route],
    ['file', contract.primaryScreen.file],
    ['compositionKind', expected.compositionKind],
    ['userOutcome', expected.userOutcome],
    ['focalPoint', expected.focalPoint],
    ['primaryAction', expected.primaryAction],
  ];
  for (const [field, expectedValue] of fields) {
    if (primary[field] !== expectedValue) {
      issues.push({ rule: 'primary-composition-drift', message: `Primary screen ${field} does not match the experience contract.`, field });
    }
  }
  const arrays = [
    ['regionOrder', expected.regionOrder],
    ['signatureMotifs', expected.signatureMotifs],
    ['forbiddenDefaults', expected.forbiddenDefaults],
    ['runtimeMarkers', expected.runtimeMarkers],
  ];
  for (const [field, expectedValues] of arrays) {
    const actual = Array.isArray(primary[field]) ? primary[field] : [];
    for (const expectedValue of expectedValues) {
      if (!actual.includes(expectedValue)) {
        issues.push({ rule: 'primary-composition-drift', message: `Primary screen ${field} is missing ${expectedValue}.`, field, expectedValue });
      }
    }
  }
  if (contract.entryMode !== 'overview' && /dashboard/i.test(String(primary.compositionKind || ''))) {
    issues.push({ rule: 'forbidden-dashboard-default', message: `Entry mode ${contract.entryMode} cannot fall back to a dashboard primary composition.` });
  }
  const forbidden = new Set(contract.forbiddenDefaults || []);
  if (forbidden.has('crud-triad') && Array.isArray(screenContract.requiredScreens)) {
    const archetypes = screenContract.requiredScreens.map((screen) => screen.archetype).filter(Boolean);
    if (['list', 'detail', 'form'].every((archetype) => archetypes.includes(archetype)) && screenContract.requiredScreens.length <= 4) {
      issues.push({ rule: 'forbidden-crud-triad', message: 'Primary experience falls back to mandatory CRUD List/Detail/Form generation.' });
    }
  }
}

function validateFoundationContract(projectRoot, contract, phase, issues) {
  const foundation = readJson(
    path.join(projectRoot, '.tmp', 'experience-foundation-contract.json'),
    'Experience foundation contract',
    issues,
  );
  if (!foundation) return null;
  const expected = foundationContract(contract);
  if (foundation.schemaVersion !== 1) {
    issues.push({ rule: 'invalid-foundation-contract-schema', message: 'Experience foundation contract schemaVersion must be 1.' });
    return foundation;
  }
  if (foundation.experienceContractSha256 !== expected.experienceContractSha256) {
    issues.push({ rule: 'experience-foundation-hash-drift', message: 'Foundation contract is bound to a stale experience contract.' });
  }
  const primitives = Array.isArray(foundation.primitives) ? foundation.primitives : [];
  for (const expectedPrimitive of expected.primitives) {
    const primitive = primitives.find((candidate) => candidate?.motif === expectedPrimitive.motif);
    if (!primitive || primitive.component !== expectedPrimitive.component || primitive.file !== expectedPrimitive.file || primitive.testID !== expectedPrimitive.testID) {
      issues.push({ rule: 'foundation-primitive-drift', message: `Foundation primitive for ${expectedPrimitive.motif} does not match the experience contract.` });
      continue;
    }
    if (phase === 'build') {
      const componentPath = path.join(projectRoot, primitive.file);
      if (!fs.existsSync(componentPath)) {
        issues.push({ rule: 'missing-foundation-primitive', message: `Foundation component is missing: ${primitive.file}.` });
      } else {
        const componentSource = fs.readFileSync(componentPath, 'utf8');
        if (!componentSource.includes(`testID="${primitive.testID}"`)) {
          issues.push({ rule: 'missing-foundation-marker', message: `Foundation component is missing ${primitive.testID}.` });
        }
        if (contract.assetPolicy?.media === 'local-first' && /https?:\/\//i.test(componentSource)) {
          issues.push({ rule: 'remote-media-for-local-first-contract', message: `Foundation component ${primitive.file} uses a remote URL despite local-first media policy.` });
        }
      }
    }
  }
  return foundation;
}

function validateBuiltPrimary(projectRoot, contract, screenContract, foundation, issues) {
  const primary = screenContract?.primaryScreen;
  if (!primary) return;
  const sourcePath = path.join(projectRoot, primary.file);
  if (!fs.existsSync(sourcePath)) {
    issues.push({ rule: 'missing-primary-screen-file', message: `Primary screen source is missing: ${primary.file}.` });
    return;
  }
  const source = fs.readFileSync(sourcePath, 'utf8');
  const foundationSources = (foundation?.primitives || [])
    .map((primitive) => path.join(projectRoot, primitive.file))
    .filter((filePath) => fs.existsSync(filePath))
    .map((filePath) => fs.readFileSync(filePath, 'utf8'));
  const markerSources = [source, ...foundationSources];
  for (const marker of primary.runtimeMarkers || []) {
    if (!markerSources.some((candidate) => candidate.includes(`testID="${marker}"`) || candidate.includes(`testID={'${marker}'}`))) {
      issues.push({ rule: 'missing-runtime-marker', message: `Primary screen is missing runtime marker ${marker}.`, marker });
    }
  }
  if ((foundation?.primitives || []).length && !source.includes('@/components/experience/')) {
    issues.push({ rule: 'missing-foundation-import', message: 'Primary screen must import the selected experience foundation primitives.' });
  }
  if (contract.assetPolicy?.media === 'local-first' && /https?:\/\//i.test(source)) {
    issues.push({ rule: 'remote-media-for-local-first-contract', message: 'Primary screen uses a remote URL despite local-first media policy.' });
  }
  if (source.includes('experience-default-dashboard') && contract.entryMode !== 'overview') {
    issues.push({ rule: 'forbidden-dashboard-default', message: 'Built primary screen explicitly opted into a dashboard outside overview mode.' });
  }
  for (const forbidden of contract.forbiddenDefaults || []) {
    if (source.includes(`experience-forbidden-${slug(forbidden)}`)) {
      issues.push({ rule: 'forbidden-default-materialized', message: `Built primary screen materializes forbidden default ${forbidden}.`, forbidden });
    }
  }
}

function validateBuildPackAgreement(projectRoot, contract, screenContract, issues) {
  const packPath = path.join(projectRoot, '.tmp', 'screen-build-pack.json');
  if (!fs.existsSync(packPath)) return;
  let pack;
  try {
    pack = JSON.parse(fs.readFileSync(packPath, 'utf8'));
  } catch (error) {
    issues.push({ rule: 'invalid-screen-build-pack', message: `Screen build pack is invalid JSON: ${error.message}` });
    return;
  }
  const validation = validateScreenBuildPack(projectRoot, pack);
  if (validation.issues.length) {
    issues.push({ rule: 'invalid-screen-build-pack', message: `Screen build pack validation failed: ${validation.issues.map((issue) => issue.rule).join(', ')}.` });
    return;
  }
  if (pack.experience?.entryMode !== contract.entryMode || pack.experience?.primarySurface !== contract.primarySurface || pack.navigation?.initialRoute !== contract.primaryScreen.route || pack.navigation?.keyFlowRoute !== screenContract?.keyFlow?.route) {
    issues.push({ rule: 'screen-build-pack-drift', message: 'Screen build pack does not match the experience contract or key flow.' });
  }
  const primary = (pack.screens || []).find((screen) => screen.role === 'primary');
  const expectedMarkers = primaryComposition(contract).runtimeMarkers;
  if (!primary || !expectedMarkers.every((marker) => (primary.testIds || []).includes(marker)) || !contract.forbiddenDefaults.every((value) => (pack.experience?.forbiddenDefaults || []).includes(value))) {
    issues.push({ rule: 'screen-build-pack-primary-drift', message: 'Screen build pack primary screen omits contract markers or forbidden defaults.' });
  }
}

function validate(projectRoot, phase) {
  const issues = [];
  const contract = readJson(path.join(projectRoot, '.tmp', 'experience-contract.json'), 'Experience contract', issues);
  if (!contract) return issues;
  for (const message of validateExperienceContract(contract)) {
    issues.push({ rule: 'invalid-experience-contract', message });
  }
  const planPath = path.join(projectRoot, 'native-app-plan.md');
  if (!fs.existsSync(planPath)) {
    issues.push({ rule: 'missing-plan', message: 'native-app-plan.md is missing.' });
    return issues;
  }
  const design = section(fs.readFileSync(planPath, 'utf8'), 'Design');
  if (!hasContractSummary(design, contract)) {
    issues.push({ rule: 'missing-plan-experience-summary', message: '## Design must include a matching ### Product Experience Contract summary.' });
  }
  const screenContract = readJson(path.join(projectRoot, '.tmp', 'experience-screen-contract.json'), 'Experience screen contract', issues);
  validateScreenContract(contract, screenContract, issues);
  const foundation = validateFoundationContract(projectRoot, contract, phase, issues);
  validateBuildPackAgreement(projectRoot, contract, screenContract, issues);
  if (phase === 'build') validateBuiltPrimary(projectRoot, contract, screenContract, foundation, issues);
  return issues;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help || !args.projectRoot || !['plan', 'build'].includes(args.phase)) {
    process.stdout.write('Usage: node validate-experience-contract.js --project-root <dir> [--phase plan|build] [--json]\n');
    return args.help ? 0 : 2;
  }
  const projectRoot = path.resolve(args.projectRoot);
  const issues = validate(projectRoot, args.phase);
  const result = { validator: 'validate-experience-contract', phase: args.phase, issues };
  if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (issues.length) {
    if (!args.json) {
      process.stderr.write(`BLOCKED: experience contract has ${issues.length} issue(s):\n`);
      for (const issue of issues) process.stderr.write(`- [${issue.rule}] ${issue.message}\n`);
    }
    return 2;
  }
  if (!args.json) process.stdout.write(`Experience contract passed (${args.phase}): ${projectRoot}\n`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { hasContractSummary, validate, validateBuildPackAgreement, validateFoundationContract };
