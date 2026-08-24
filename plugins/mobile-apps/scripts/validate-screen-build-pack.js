#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  compactExecutionContract,
  aggregateProjectFilesHash,
  domainLayerHash,
  domainDataSurface,
  revisionForPack,
  sha256,
  stableStringify,
} = require('./compile-screen-build-pack');
const { resolveDesignRecipe } = require('./resolve-design-recipe');
const { validateScreenComposition } = require('./validate-screen-composition');
const { normalizeScreenContract } = require('./lib/experience-screen-contract');

function currentSourceHash(projectRoot, relativePath, source) {
  if (source === 'domainLayer') {
    try { return domainLayerHash(projectRoot, relativePath); } catch { return null; }
  }
  if (source === 'foundationRuntime') {
    try { return aggregateProjectFilesHash(projectRoot, relativePath, 'Experience foundation runtime'); } catch { return null; }
  }
  if (source === 'designRecipe') {
    if (relativePath) {
      const recipePath = path.join(projectRoot, relativePath);
      return fs.existsSync(recipePath) ? sha256(fs.readFileSync(recipePath, 'utf8')) : null;
    }
    try {
      const contract = JSON.parse(fs.readFileSync(path.join(projectRoot, '.tmp', 'experience-contract.json'), 'utf8'));
      const screens = JSON.parse(fs.readFileSync(path.join(projectRoot, '.tmp', 'experience-screen-contract.json'), 'utf8'));
      const domainPath = path.join(projectRoot, '.tmp', 'prototype-domain-model.json');
      const schemaPath = path.join(projectRoot, '.tmp', 'dataverse-schema-contract.json');
      const executionPath = path.join(projectRoot, '.tmp', 'mobile-plan-execution-contract.json');
      const contextPath = path.join(projectRoot, '.tmp', 'context-enrichment-contract.json');
      const dataContract = fs.existsSync(domainPath)
        ? JSON.parse(fs.readFileSync(domainPath, 'utf8'))
        : fs.existsSync(schemaPath) ? JSON.parse(fs.readFileSync(schemaPath, 'utf8')) : null;
      const executionContract = fs.existsSync(executionPath) ? JSON.parse(fs.readFileSync(executionPath, 'utf8')) : null;
      const contextContract = fs.existsSync(contextPath) ? JSON.parse(fs.readFileSync(contextPath, 'utf8')) : null;
      return sha256(stableStringify(resolveDesignRecipe(contract, screens, null, { dataContract, executionContract, contextContract })));
    } catch { return null; }
  }
  const filePath = path.join(projectRoot, relativePath);
  return fs.existsSync(filePath) ? sha256(fs.readFileSync(filePath, 'utf8')) : null;
}

function validateScreenBuildPack(projectRoot, pack) {
  const issues = [];
  const staleTargets = new Set();
  if (!pack || pack.schemaVersion !== 2) {
    return { issues: [{ rule: 'invalid-schema-version', message: 'Screen build pack requires schemaVersion: 2.' }], staleTargets: [] };
  }
  if (!/^[a-f0-9]{64}$/i.test(String(pack.revision || '')) || pack.revision !== revisionForPack(pack)) {
    issues.push({ rule: 'revision-drift', message: 'Screen build pack revision does not match its deterministic content.' });
  }
  if (pack.screenContractVersion !== 3) {
    issues.push({ rule: 'legacy-screen-contract', message: 'Screen build pack requires a schema-version-3 Experience Screen Contract. Re-plan before building.' });
  }
  const sourceNames = ['confirmedBrief', 'packageManifest', 'experienceContract', 'screenContract', 'contextEnrichment', 'foundationContract', 'foundationRuntime', 'designRecipe', 'tokens', 'domainModel', 'domainLayer', 'executionContract'];
  for (const source of sourceNames) {
    if (!/^[a-f0-9]{64}$/i.test(String(pack.sources?.[source] || ''))) {
      issues.push({ rule: 'missing-source-hash', message: `Screen build pack is missing ${source} hash.` });
      continue;
    }
    const current = currentSourceHash(projectRoot, pack.sourcePaths?.[source], source);
    if (!current || current !== pack.sources[source]) {
      issues.push({ rule: 'source-hash-drift', message: `Screen build pack source drift: ${source}.`, source });
      for (const [screenId, dependencies] of Object.entries(pack.invalidation?.screenDependencies || {})) {
        if (Array.isArray(dependencies) && dependencies.includes(source)) staleTargets.add(`screen:${screenId}`);
      }
      for (const [fixtureId, dependencies] of Object.entries(pack.invalidation?.fixtureDependencies || {})) {
        if (Array.isArray(dependencies) && dependencies.includes(source)) staleTargets.add(`fixture:${fixtureId}`);
      }
      for (const [validatorId, dependencies] of Object.entries(pack.invalidation?.validatorDependencies || {})) {
        if (Array.isArray(dependencies) && dependencies.includes(source)) staleTargets.add(`validator:${validatorId}`);
      }
    }
  }
  const primary = (pack.screens || []).find((screen) => screen.role === 'primary');
  const keyFlow = (pack.screens || []).find((screen) => screen.role === 'key-flow');
  if (!primary || !keyFlow) issues.push({ rule: 'missing-primary-or-key-flow', message: 'Screen build pack requires primary and key-flow screens.' });
  if (!primary?.firstViewport?.regionIds?.length || !primary?.primaryAction || !Array.isArray(primary?.states) || !['loading', 'empty', 'error', 'offline'].every((state) => primary.states.includes(state)) || !primary?.dependencies || !Array.isArray(primary?.testIds)) {
    issues.push({ rule: 'incomplete-primary-screen', message: 'Primary build-pack screen requires viewport, action, states, dependencies, and test IDs.' });
  }
  if (pack.shell?.safeAreaOwner !== 'screen' || pack.shell?.rootSafeAreaProviderOnly !== true || !pack.shell?.headerModes || primary?.headerMode !== 'root' || keyFlow?.headerMode !== 'back') {
    issues.push({ rule: 'invalid-shell-contract', message: 'Screen build pack requires route-owned safe areas plus root/back header modes.' });
  }
  if (!pack.context || !Array.isArray(pack.context.forbiddenInferences)) issues.push({ rule: 'missing-context-contract', message: 'Screen build pack requires context mode and forbidden inferences.' });
  for (const screen of pack.screens || []) {
    if (!['root', 'back', 'close', 'none'].includes(screen.headerMode) || pack.shell?.headerModes?.[screen.route] !== screen.headerMode) {
      issues.push({ rule: 'header-mode-drift', message: `Screen build pack header mode drift for ${screen.route || screen.id}.` });
    }
    if (screen.data?.recordIdentity !== 'stable-primary-key' || screen.data?.sourceModule !== '@/data' || screen.data?.domainModel !== '.tmp/prototype-domain-model.json' || !Array.isArray(screen.data?.entities) || !Array.isArray(screen.data?.hooks)) {
      issues.push({ rule: 'screen-data-identity-missing', message: `Screen build pack requires stable neutral-domain data for ${screen.route || screen.id}.` });
    }
    if (!Array.isArray(screen.data?.operations)) {
      issues.push({ rule: 'missing-screen-operations', message: `Screen build pack lacks executable operations for ${screen.route || screen.id}.` });
    }
    if (!screen.context || !Array.isArray(screen.context.entries) || !Array.isArray(screen.context.assumptions) || !Array.isArray(screen.context.forbiddenInferences)) {
      issues.push({ rule: 'missing-screen-context', message: `Screen build pack lacks resolved context for ${screen.route || screen.id}.` });
    }
    for (const entry of screen.context?.entries || []) {
      if (entry.testId !== `experience-context-${entry.id}` || !screen.testIds?.includes(entry.testId)) {
        issues.push({ rule: 'missing-context-runtime-marker', message: `Screen ${screen.route || screen.id} lacks the literal runtime marker for context entry ${entry.id}.` });
      }
    }
    if (!screen.signatureComponent || typeof screen.signatureComponent.required !== 'boolean') issues.push({ rule: 'missing-signature-component', message: `Screen build pack lacks signature-component intent for ${screen.route || screen.id}.` });
    if (screen.data?.mediaPolicy !== pack.fixtures?.mediaPolicy || !Array.isArray(screen.data?.mediaFields) || screen.data.mediaFields.join('|') !== 'imageUrl|imageAltText|imageCacheKey|imageAssetKey') {
      issues.push({ rule: 'screen-media-intent-drift', message: `Screen build pack media intent drift for ${screen.route || screen.id}.` });
    }
    const bindings = screen.data?.runtimeBindings;
    if (bindings?.canonicalRecord?.mapper !== 'domain-record'
      || bindings?.canonicalRecord?.stableId !== 'id'
      || bindings?.availability?.stateProperty !== 'availabilityState'
      || bindings?.availability?.predicate !== 'isDomainRecordActionable'
      || !Array.isArray(bindings?.availability?.entities)
      || bindings?.relatedMedia?.resolver !== 'resolveDomainMedia'
      || bindings?.relatedMedia?.join !== 'repository-relationship'
      || !Array.isArray(bindings?.relatedMedia?.relationships)
      || bindings?.aggregateFreshness?.policy !== 'focus-revalidate-after-mutation'
      || bindings?.aggregateFreshness?.hook !== 'useFocusEffect'
      || !Array.isArray(bindings?.aggregateFreshness?.entities)) {
      issues.push({ rule: 'screen-runtime-bindings-missing', message: `Screen build pack lacks canonical availability, relationship, or focus-refresh bindings for ${screen.route || screen.id}.` });
    }
    if (bindings?.availability?.required === true
      && (!screen.primaryAction || bindings.availability.disabledActionId !== screen.primaryAction.id || !bindings.availability.entities.length)) {
      issues.push({ rule: 'availability-action-binding-drift', message: `Screen ${screen.route || screen.id} requires an unavailable-state action binding to its primary action.` });
    }
    if (bindings?.relatedMedia?.required === true && !bindings.relatedMedia.relationships.length) {
      issues.push({ rule: 'related-media-binding-drift', message: `Screen ${screen.route || screen.id} requires related media but declares no executable relationship.` });
    }
  }
  const executionPath = pack.sourcePaths?.executionContract
    ? path.join(projectRoot, pack.sourcePaths.executionContract)
    : null;
  if (executionPath && fs.existsSync(executionPath)) {
    try {
      const executionContract = JSON.parse(fs.readFileSync(executionPath, 'utf8'));
      if (stableStringify(pack.execution) !== stableStringify(compactExecutionContract(executionContract))) {
        issues.push({ rule: 'execution-contract-drift', message: 'Screen build pack execution facts do not match the approved execution contract.' });
      }
    } catch (error) {
      issues.push({ rule: 'invalid-execution-contract', message: `Cannot read the approved execution contract: ${error.message}` });
    }
  }
  const screenContractPath = pack.sourcePaths?.screenContract
    ? path.join(projectRoot, pack.sourcePaths.screenContract)
    : null;
  if (screenContractPath && fs.existsSync(screenContractPath)) {
    try {
      const screenContract = JSON.parse(fs.readFileSync(screenContractPath, 'utf8'));
      const planned = new Map(normalizeScreenContract(screenContract, null).map((screen) => [screen.id, screen]));
      for (const screen of pack.screens || []) {
        const approved = planned.get(screen.id);
        if (stableStringify(screen.data?.operations || []) !== stableStringify(approved?.data?.operations || [])) {
          issues.push({ rule: 'screen-operation-drift', message: `Screen build pack operations drift from the approved contract for ${screen.id}.` });
        }
        if (stableStringify(screen.routeParameters || []) !== stableStringify(approved?.routeParameters || [])) {
          issues.push({ rule: 'route-parameter-drift', message: `Screen build pack route parameters drift from the approved contract for ${screen.id}.` });
        }
        if (stableStringify(screen.navigation || {}) !== stableStringify(approved?.navigation || {})) {
          issues.push({ rule: 'screen-navigation-drift', message: `Screen build pack navigation ownership drifts from the approved contract for ${screen.id}.` });
        }
      }
    } catch (error) {
      issues.push({ rule: 'invalid-screen-contract', message: `Cannot read the approved screen contract: ${error.message}` });
    }
  }
  const dataSurface = domainDataSurface(projectRoot);
  for (const screen of pack.screens || []) {
    for (const operation of screen.data?.operations || []) {
      if (!dataSurface.hooks.has(operation.hook)) issues.push({ rule: 'unavailable-domain-hook', message: `Operation ${operation.id} requires missing domain hook ${operation.hook}.` });
      if (!dataSurface.repositories.has(operation.repository)) issues.push({ rule: 'unavailable-repository', message: `Operation ${operation.id} requires missing repository ${operation.repository}.` });
    }
  }
  const packagePath = path.join(projectRoot, 'package.json');
  if (fs.existsSync(packagePath)) {
    try {
      const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
      const installed = { ...(packageJson.dependencies || {}), ...(packageJson.devDependencies || {}) };
      for (const dependency of pack.execution?.javascriptDependencies || []) {
        if (installed[dependency.package] !== dependency.version) {
          issues.push({ rule: 'approved-dependency-missing', message: `Approved dependency ${dependency.package}@${dependency.version} is not installed exactly.` });
        }
      }
    } catch (error) {
      issues.push({ rule: 'invalid-package-manifest', message: `Cannot validate approved dependencies: ${error.message}` });
    }
  }
  if (!pack.design?.tokensPath || !pack.design?.recipe || !Array.isArray(pack.design?.primitives) || !pack.design.primitives.length) {
    issues.push({ rule: 'missing-design-primitives', message: 'Screen build pack requires design tokens and foundation primitives.' });
  }
  if (!pack.fixtures?.adapter || !Array.isArray(pack.fixtures?.entities) || !pack.fixtures.assetPolicy || !pack.fixtures.assetManifest || pack.fixtures?.domainModelPath !== '.tmp/prototype-domain-model.json' || pack.fixtures?.dataModule !== 'src/data/index.ts' || pack.fixtures?.mediaAdapter !== 'src/data/media.ts' || pack.fixtures?.recordIdentity !== 'stable-primary-key' || pack.fixtures?.mediaPolicy !== pack.fixtures?.assetPolicy || pack.fixtures?.mediaManifest !== pack.fixtures?.assetManifest || !Array.isArray(pack.fixtures?.mediaFields) || pack.fixtures.mediaFields.join('|') !== 'imageUrl|imageAltText|imageCacheKey|imageAssetKey') {
    issues.push({ rule: 'missing-fixture-intent', message: 'Screen build pack requires fixture adapter, entities, and asset policy.' });
  }
  issues.push(...validateScreenComposition(pack));
  return { issues, staleTargets: [...staleTargets].sort() };
}

function main(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--pack') args.pack = argv[++index];
    else if (argv[index] === '--json') args.json = true;
  }
  if (!args.projectRoot) {
    process.stderr.write('Usage: node validate-screen-build-pack.js --project-root <dir> [--pack <path>] [--json]\n');
    return 2;
  }
  const root = path.resolve(args.projectRoot);
  const packPath = path.resolve(root, args.pack || '.tmp/screen-build-pack.json');
  if (!fs.existsSync(packPath)) {
    process.stderr.write(`BLOCKED: screen build pack is missing: ${packPath}\n`);
    return 2;
  }
  let pack;
  try { pack = JSON.parse(fs.readFileSync(packPath, 'utf8')); } catch (error) {
    process.stderr.write(`BLOCKED: invalid screen build pack: ${error.message}\n`);
    return 2;
  }
  const result = validateScreenBuildPack(root, pack);
  if (args.json) process.stdout.write(`${JSON.stringify({ validator: 'validate-screen-build-pack', pack: packPath, ...result }, null, 2)}\n`);
  if (result.issues.length) {
    if (!args.json) result.issues.forEach((issue) => process.stderr.write(`- [${issue.rule}] ${issue.message}\n`));
    return 2;
  }
  if (!args.json) process.stdout.write(`Screen build pack passed: ${packPath}\n`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { validateScreenBuildPack };
